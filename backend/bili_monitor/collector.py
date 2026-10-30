"""独立采集入口：检查只登记信号，归档执行另行领取持久工作。"""

import argparse
import asyncio
import math
import os
import random
import signal
from contextlib import asynccontextmanager, contextmanager, nullcontext
from datetime import datetime, timezone

import httpx
import fcntl
import time
from pathlib import Path

from anyio import to_thread

from .source import BEIJING, fetch_page, page_metadata, fetch_detail, COMMENT_LOCATOR_VERSION
from .source_transport import PacedSourceTransport, SourcePacer
from .source_gate import GatedAsyncClient, GatedAsyncTransport, SourceGate
from .source_client import SOURCE_HEADERS, source_client_event_hooks
from .source_cookies import load_source_cookie_pairs
from .comment_client import RequestsCommentClientFactory, open_comment_client
from .comment_status import epoch_from_iso, utc_now
from .notifications import outbox
from .risk import BLOCKED_STATES, RiskGate, SourceRiskPaused
from .risk_probe import RiskProber
from .reply_pacing import ReplyPagePacer
from .root_comments import fetch_comment_count, valid_locator
from .dispatch import DispatchLeases, TargetSession
from .media import ImageDownloader
from .oss import OSSUploader
from .safety import configure_safe_logging
from .collector_logging import (
    SELF_HEALING_REASONS, collector_attempt, collector_event, collector_failure,
    credential_signal, failure_fields, source_ids, source_refs,
)
from .storage import Store
from .selection import selection_matches
from .transaction import write


# 检查节拍：生产默认 2.7 秒 ±10% 抖动，与参考脚本 3 目标 2.4–3.0 秒一轮相当。
# BILI_COLLECTOR_CADENCE_SECONDS 可覆盖为固定值（测试与临时运维）；无抖动便于复现。
CADENCE_SECONDS = 2.7
CADENCE_JITTER = 0.10
# 页面信号（编辑时间、正文/图片版本、受限状态）按独立低频节拍采样；
# 计数检查走主节拍，所以默认 2.7 秒只带来一次评论计数请求。
PAGE_CHECK_SECONDS = 60.0
PAGE_CHECK_JITTER_SECONDS = 2.0
# 评论点赞每日刷新：只在凌晨窗口内把「距上次成功刷新满间隔」的目标重扫根页。
# 间隔 0 关闭该通道；窗口是北京时间整分钟时段，与心跳时段同形态（起点含、终点不含）。
LIKE_REFRESH_SECONDS = 24 * 60 * 60
LIKE_REFRESH_WINDOW = ("02:00", "05:00")
# 登记扫描的内部限频：主节拍每 2.7 秒一拍，不必每拍扫一遍已完成目标。
LIKE_REFRESH_SCAN_SECONDS = 60.0
LIKE_REFRESH_SECONDS_ENV = "BILI_COLLECTOR_LIKE_REFRESH_SECONDS"
LIKE_REFRESH_WINDOW_ENV = "BILI_COLLECTOR_LIKE_REFRESH_WINDOW"


def beijing_minute(now_iso):
    """ISO 时刻 → 北京时间当日第几分钟；解析不了返回 None。

    采集写入的时间都是 UTC ISO 字符串，窗口按北京时间判定，不依赖进程本地时区。
    """
    try:
        moment = datetime.fromisoformat(str(now_iso).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    beijing = moment.astimezone(BEIJING)
    return beijing.hour * 60 + beijing.minute


def window_minute(text):
    """`HH:MM` → 当日分钟序号；格式或取值非法返回 None。"""
    if not isinstance(text, str):
        return None
    parts = text.strip().split(":")
    if len(parts) != 2:
        return None
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return hour * 60 + minute


def like_refresh_window_open(now_iso, window=LIKE_REFRESH_WINDOW):
    """当前时刻是否在凌晨窗口内（北京时间整分钟窗口：起点含、终点不含）。"""
    start, end = window_minute(window[0]), window_minute(window[1])
    minute = beijing_minute(now_iso)
    if start is None or end is None or minute is None or start >= end:
        return False
    return start <= minute < end


def like_refresh_due(anchor_iso, now_iso, interval=LIKE_REFRESH_SECONDS):
    """锚点为空或距上次成功刷新达到间隔即到期；间隔 0 关闭该通道。"""
    if interval <= 0:
        return False
    if not anchor_iso:
        return True
    try:
        age = epoch_from_iso(now_iso) - epoch_from_iso(anchor_iso)
    except (TypeError, ValueError):
        # 锚点不可解析按到期处理：宁可多刷一轮，也不把未知当成「刚刷过」。
        return True
    return age >= interval


def like_refresh_configuration():
    """点赞刷新配置（间隔秒数＋北京时间窗口）；非法值退回默认并标明来源。

    `interval_source`／`window_source` 取 `default`／`environment`／`invalid`，
    启动日志据此把「配置写错了、正在用默认值」变成可观察事实。
    """
    interval_text = os.environ.get(LIKE_REFRESH_SECONDS_ENV)
    interval, interval_source = LIKE_REFRESH_SECONDS, "default"
    if interval_text:
        try:
            value = float(interval_text)
        except ValueError:
            value = None
        if value is not None and value >= 0 and math.isfinite(value):
            interval, interval_source = int(value), "environment"
        else:
            interval_source = "invalid"
    window, window_source = LIKE_REFRESH_WINDOW, "default"
    window_text = os.environ.get(LIKE_REFRESH_WINDOW_ENV)
    if window_text:
        candidate = tuple(part.strip() for part in window_text.split("-", 1))
        start, end = (window_minute(candidate[0]), window_minute(candidate[1])) \
            if len(candidate) == 2 else (None, None)
        if start is not None and end is not None and start < end:
            window, window_source = candidate, "environment"
        else:
            window_source = "invalid"
    return {"interval": interval, "window": window,
            "interval_source": interval_source, "window_source": window_source}


def page_interval_sample():
    """本轮页面信号间隔：默认 60 秒 ±2 秒抖动；BILI_COLLECTOR_PAGE_CHECK_SECONDS 可覆盖为固定值。"""
    override = os.environ.get("BILI_COLLECTOR_PAGE_CHECK_SECONDS")
    if override is not None and override != "":
        try:
            value = float(override)
        except ValueError:
            value = -1.0
        if value >= 0:
            return value
    return PAGE_CHECK_SECONDS + random.uniform(-PAGE_CHECK_JITTER_SECONDS, PAGE_CHECK_JITTER_SECONDS)


def cadence_provider():
    """返回本轮节拍提供者：环境变量固定值优先，否则基数 ±抖动。"""
    override = os.environ.get("BILI_COLLECTOR_CADENCE_SECONDS")
    if override:
        try:
            fixed = float(override)
        except ValueError:
            fixed = 0.0
        if fixed > 0:
            return lambda: fixed
    return lambda: CADENCE_SECONDS * random.uniform(1 - CADENCE_JITTER, 1 + CADENCE_JITTER)


class SystemClock:
    def monotonic(self):
        return time.monotonic()

    def now(self):
        return utc_now()

    async def sleep(self, seconds):
        await asyncio.sleep(seconds)


@contextmanager
def collector_lock(path):
    """同一数据库只运行一个采集进程；退出/崩溃时内核释放，不靠过期租约。"""
    lock_path = str(Path(path).resolve()) + ".collector.lock"
    Path(lock_path).parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Collector already running") from None
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


class Collector:
    def __init__(self, store, client, downloader=None, uploader=None, *, clock=None,
                 max_checks=4, max_syncs=4, max_discoveries=2, comment_client_factory=None,
                 cadence=None, page_check_seconds=None, credentials_configured=False, risk=None,
                 probe=None, scheduler=None):
        if max_checks < 1 or max_syncs < 1 or max_discoveries < 1:
            raise ValueError("Invalid collector concurrency")
        self.store = store
        self.client = client
        self.downloader = downloader
        self.uploader = uploader
        self.clock = clock or SystemClock()
        self.max_checks = max_checks
        self.max_syncs = max_syncs
        self.max_discoveries = max_discoveries
        self.comment_client_factory = comment_client_factory
        # 只读保护快照：调度层据此跳过派发；许可本身仍由同一 gate 在发送前核验。
        self.risk = risk
        # 到期探测的 owner：只有采集进程持有它，API 不能绕过领取直接发送。
        self.probe = probe
        # 08：跨进程发送许可、单路重型与目标互斥；直接构造的隔离测试可省略。
        self.scheduler = scheduler
        self._paused_generation = None
        # 进入 observing 后只归还一次在途中止的工作，不重复重置。
        self._resumed_generation = None
        # 观察期心跳的上一个节拍时间（单调时钟）；不在观察态时保持 None。
        self._observation_mark = None
        # 启动时一次性读取的来源凭据是否存在；判定处不再读文件，也不为了告警额外访问来源。
        self.credentials_configured = bool(credentials_configured)
        # 点赞刷新配置（间隔＋凌晨窗口）与登记扫描的上一拍；间隔 0 关闭该通道。
        self.like_refresh_config = like_refresh_configuration()
        self._like_refresh_mark = None
        self.cadence = cadence if cadence is not None else cadence_provider()
        # 默认每轮采样带抖动；显式传值时用于测试/运维固定间隔。
        self.page_interval = ((lambda: float(page_check_seconds)) if page_check_seconds is not None
                              else page_interval_sample)

    async def _risk_status(self):
        """完整只读状态：判定是否到期探测、是否恢复在途工作。未接入时返回 None。"""
        if self.risk is None:
            return None
        return await self.risk.snapshot()

    async def _observation_tick(self, status, cap):
        """观察期心跳：只有确有成功业务请求的节拍才累计活跃采集时间。

        采集进程是观察进度的唯一提交者：API 进程的成功响应不抵扣观察期；空闲与普通
        失败不累计，每拍最多计入一个节拍（停顿不被放大成十分钟），重启由
        `restart_observation` 重新累计。满 10 分钟回到 normal 并清零档位。
        """
        if self.risk is None or status is None or status["state"] != "observing":
            self._observation_mark = None
            return status
        mark = self.clock.monotonic()
        previous, self._observation_mark = self._observation_mark, mark
        if previous is None:
            # 刚进入观察态：先建立基线，不把进入前的空档算作观察时间。
            return status
        updated = await self.risk.observing_tick(min(max(0.0, mark - previous), cap))
        return updated if updated is not None else status

    async def _resume_abandoned(self, status, inflight):
        """进入 observing 后把上次被暂停打断的领取归还为 pending，不需要重启进程。

        只在没有在途任务时归还：同一进程里正在跑的工作不是“被中止的工作”，不能被重置。
        """
        if status is None or status["state"] != "observing":
            return
        if status["generation"] == self._resumed_generation or inflight:
            return
        self._resumed_generation = status["generation"]
        await to_thread.run_sync(self.store.recover_check_work)
        await to_thread.run_sync(self.store.recover_discoveries, self.clock.now())
        collector_event("risk_work_resumed", backoff_step=status["backoff_step"])

    @staticmethod
    def _log_paused(paused):
        """被保护暂停不是失败：只留一条固定日志，不写检查结果、失败事实或成功时间。"""
        collector_event("source_risk_paused_work_aborted", risk_state=paused.status["state"],
                        backoff_step=paused.status["backoff_step"])

    def _settle(self, task):
        """任务结算：被保护暂停不是失败，不写检查结果／成功时间，只留一次固定日志。"""
        try:
            task.result()
        except SourceRiskPaused as paused:
            self._log_paused(paused)

    def _failure_alerts(self, error, object_key, category="collection"):
        """一次真实失败 → 告警登记项（不读日志、不扫描、不访问上游）。

        可信凭据失效只认「来源业务码 -101 + 本次确实配置了凭据」，对象键是全局来源
        凭据；其余仍按原分类归入本阶段类别（采集异常／主循环异常），不让普通网络/
        风控/HTTP 错误冒充登录失效。可重试收敛的分页一致性校验返回空：它已有 WARNING
        与持久错误事实，不属于「需要人看一眼」的故障。
        """
        signal = credential_signal(error, credentials_configured=self.credentials_configured)
        if signal == "credential_rejected":
            return [outbox.Alert("credential", "source_credential", signal)]
        reason = signal or failure_fields(error)["reason"]
        if signal is None and reason in SELF_HEALING_REASONS:
            # 页内计数漂移由下一次尝试重新定位锚点、刷新基准后收敛；只留 `collector_failure`
            # 的 WARNING，不登记告警，避免正常的删除／新增被当成采集故障。
            return []
        return [outbox.Alert(category, object_key, reason)]

    async def discover_once(self, uid):
        """一次按 UP 发现并发布可信窗口；首次工作仍经固定检查与独立归档阶段。"""
        from .discovery import discover_recent, DiscoveryError, DiscoveryStopped

        claim = await to_thread.run_sync(self.store.claim_discovery, uid, self.clock.now())
        if claim is None:
            return False
        token = claim["token"]
        collector_event("discovery_started", **source_refs(uid=uid))

        async def should_continue():
            return await to_thread.run_sync(self.store.discovery_claim_active, uid, token)

        async def on_progress(ids):
            await to_thread.run_sync(self.store.record_discovery_progress, uid, token, ids)

        try:
            result = await discover_recent(
                self.client, uid, claim["recent_n"], should_continue=should_continue, on_progress=on_progress)
        except DiscoveryStopped:
            collector_event("discovery_stopped", reason="selection_changed", **source_refs(uid=uid))
            return False
        except SourceRiskPaused:
            # 不写失败尝试：保留领取，由重启恢复与后续恢复动作归还在途工作。
            return False
        except Exception as error:
            collector_failure("discovery_failed", error, credentials_configured=self.credentials_configured,
                              **source_refs(uid=uid))
            code = error.code if isinstance(error, DiscoveryError) else "SOURCE_UNAVAILABLE"
            await to_thread.run_sync(
                lambda: self.store.finish_discovery(
                    uid, token, None, self.clock.now(), code,
                    alerts=(outbox.Alert("collection", uid, code.lower()),)))
            return False
        accepted = await to_thread.run_sync(self.store.finish_discovery, uid, token, result, self.clock.now())
        collector_event("discovery_finished", accepted=accepted,
                        dynamic_ids=source_ids(result.get("ids") or []), **source_refs(uid=uid))
        return accepted

    def _page_due(self, last_checked_at, now):
        """页面信号是否到期：无记录或超过采样间隔。时间字符串无法解析时按到期处理。"""
        if not last_checked_at:
            return True
        try:
            return (epoch_from_iso(now) - epoch_from_iso(last_checked_at)) >= self.page_interval()
        except ValueError:
            return True

    async def check_once(self, uid, id, *, selection=None):
        current = await to_thread.run_sync(self.store.check_selection, uid, id)
        if not selection_matches(current, selection):
            return False
        selection = current
        target_refs = source_refs(uid=uid, dynamic_id=id)
        collector_event("check_started", **target_refs)

        async def still_selected():
            return await to_thread.run_sync(self.store.check_selection, uid, id) == selection

        checks = await to_thread.run_sync(self.store.read_checks, uid)
        observed = next((item["observed"] for item in checks if item["id"] == id), {})
        locator = observed.get("comment_locator")
        now = self.clock.now()
        page_signal = self._page_due(await to_thread.run_sync(self.store.page_checked_at, uid, id), now)
        metadata, page_error = None, None
        alerts = []
        target_object = f"{uid}:{id}"
        if page_signal:
            try:
                metadata = page_metadata(await fetch_page(self.client, id), uid)
                if metadata.get("edit_status") == "error":
                    page_error = "SIGNAL_INVALID"
                    alerts.append(outbox.Alert("collection", target_object, "signal_invalid"))
            except SourceRiskPaused:
                raise
            except Exception as exception:
                collector_failure("check_source_failed", exception, stage="page",
                                  credentials_configured=self.credentials_configured, **target_refs)
                page_error = "SOURCE_UNAVAILABLE"
                alerts.extend(self._failure_alerts(exception, target_object))
            if not await still_selected():
                return False
            # 新定位策略上线时重新核对旧 locator，不能仅凭格式正确就永久复用。
            if (metadata is None or not valid_locator(locator)
                    or locator.get("policy_version") != COMMENT_LOCATOR_VERSION):
                if not await still_selected():
                    return False
                try:
                    detail, detail_status = await fetch_detail(self.client, id, uid)
                    locator = detail.get("comment_locator")
                    if metadata is None and detail_status == "restricted":
                        # 已确认作者和目标的受限响应是有效元数据，不当成来源故障。
                        # 没有 HTML 编辑信号仍是 unknown，不能伪造版本或正文成功。
                        metadata = {**detail, "edit_status": "unknown", "content_visible": False}
                        page_error = None
                    collector_event("comment_locator_refreshed", source=locator.get("source") if locator else None)
                except SourceRiskPaused:
                    raise
                except Exception as exception:
                    collector_failure("check_source_failed", exception, stage="detail",
                                      credentials_configured=self.credentials_configured, **target_refs)
                    alerts.extend(self._failure_alerts(exception, target_object))
        elif not valid_locator(locator) or locator.get("policy_version") != COMMENT_LOCATOR_VERSION:
            # 页面信号未到期且没有可用定位：本轮无事可做，不重复打上游，也不落一条失败记录。
            collector_event("check_skipped", reason="page_interval", **target_refs)
            return True
        if not await still_selected():
            return False
        comments = {"comment_locator": locator, "comment_count_status": "failed"}
        try:
            if not valid_locator(locator):
                raise ValueError("Unknown comment resource")
            async with open_comment_client(self.client, uid, self.comment_client_factory) as comments_client:
                if not await still_selected():
                    return False
                comments["source_comment_count"] = await fetch_comment_count(comments_client, locator, uid=uid)
            comments["comment_count_status"] = "observed"
        except SourceRiskPaused:
            raise
        except Exception as exception:
            collector_failure("check_source_failed", exception, stage="comment_count",
                              credentials_configured=self.credentials_configured, **target_refs)
            alerts.extend(self._failure_alerts(exception, target_object))
        # 网页计数不回退冒充独立计数读取成功；两项信号可各自失败。
        if metadata is not None:
            metadata.pop("source_comment_count", None)
        # 记录时间取提交时刻：慢检查不能让 last_checked_at 回退到开始时间。
        accepted = await to_thread.run_sync(lambda: self.store.record_check(
            uid, id, metadata, self.clock.now(), page_error, comment_observation=comments,
            selection=selection, media_upload=self.uploader is not None, page_signal=page_signal,
            alerts=alerts))
        collector_event("check_finished", recorded=accepted,
                        edit_status=metadata.get("edit_status") if metadata else None,
                        comment_count_status=comments["comment_count_status"], **target_refs)
        return accepted

    async def execute_pending(self):
        """按目标轮转推进重型步骤，直到本轮待处理目标都至少尝试一次。

        每个目标只持有自己的互斥租约；每次 `advance()` 只提交一个根页／楼中楼页／单图
        步骤，随后释放全局重型回合，让其他目标或 API 进程获得下一次机会。失败留待下一
        节拍，不在本轮无限重试；风控暂停原样抛出，保留 running 领取与已提交分片。
        """
        sessions = {}
        attempted = set()
        try:
            while True:
                targets = await to_thread.run_sync(
                    lambda: self.store.pending_checks(with_selection=True))
                for target in targets:
                    key = (target["uid"], target["id"])
                    if key in attempted or key in sessions:
                        continue
                    session = await self._open_session(target)
                    if session is None:
                        attempted.add(key)
                    else:
                        sessions[key] = session
                active = [key for key in sessions if key not in attempted]
                if not active:
                    return
                progressed = False
                for key in active:
                    if key in attempted:
                        continue
                    session = sessions[key]
                    if session.generation is None:
                        # 尚未发出首个请求：重新核验资格后才领取归档。已开始的领取继续
                        # 完成自身 generation，最终由 finish_check_work 保留 pending。
                        selection = await to_thread.run_sync(
                            lambda: self.store.check_selection(session.uid, session.id))
                        if not selection_matches(selection, session.claim["selection"]):
                            collector_event("sync_skipped", reason="selection_changed",
                                            stage=session.stage,
                                            **source_refs(uid=session.uid, dynamic_id=session.id))
                            await self._drop_session(sessions, attempted, key, session,
                                                     settled="failed")
                            continue
                        try:
                            generation = await to_thread.run_sync(lambda: self.store.claim_archive(
                                session.uid, session.id, selection=session.claim["selection"]))
                        except Exception as error:
                            collector_failure("sync_execution_failed", error,
                                              credentials_configured=self.credentials_configured)
                            await self._drop_session(sessions, attempted, key, session,
                                                     settled="failed")
                            continue
                        if generation is None:
                            await self._drop_session(sessions, attempted, key, session,
                                                     settled="failed")
                            continue
                        session.generation = generation
                    if self.scheduler is not None and not await session.target_lease.renew():
                        collector_event("sync_skipped", reason="target_lease_lost",
                                        **source_refs(uid=session.uid, dynamic_id=session.id))
                        # 租约已失去：不再结算它的结果，只补释放并记本拍已尝试。
                        await self._drop_session(sessions, attempted, key, session, settled=None)
                        continue
                    heavy = (self.scheduler.heavy_slot(f"{session.uid}:{session.id}", session.stage)
                             if self.scheduler is not None else nullcontext())
                    try:
                        with collector_attempt():
                            async with heavy:
                                outcome = await session.advance()
                    except SourceRiskPaused:
                        raise
                    except Exception as error:
                        collector_failure("sync_execution_failed", error,
                                          credentials_configured=self.credentials_configured)
                        session.alerts.extend(
                            self._failure_alerts(error, f"{session.uid}:{session.id}"))
                        await self._drop_session(sessions, attempted, key, session,
                                                 settled="failed")
                        continue
                    progressed = True
                    collector_event("dispatch_turn", stage=outcome.stage, result=outcome.status,
                                    page=outcome.page, done=outcome.done,
                                    heavy_held=self.scheduler is not None,
                                    **source_refs(uid=session.uid, dynamic_id=session.id))
                    if session.done:
                        await self._drop_session(sessions, attempted, key, session)
                if not progressed:
                    return
        except SourceRiskPaused as paused:
            # 暂停不是失败：停止本轮派发，保留 running 领取与已提交分片。
            self._log_paused(paused)
        finally:
            # 风控、取消或异常退出时只释放本进程持有权；running 领取留给既有恢复路径。
            for session in sessions.values():
                if self.scheduler is not None:
                    await session.target_lease.release()

    def _refresh_window_open(self, now):
        """刷新通道是否在窗口内：间隔 0 关闭，窗口是北京时间整分钟时段。"""
        return (self.like_refresh_config["interval"] > 0
                and like_refresh_window_open(now, self.like_refresh_config["window"]))

    def _like_refresh_round(self, anchor_iso, now):
        """「窗口内 + 锚点到期」的唯一判定点：本次领取是不是一次点赞刷新。

        登记扫描与领取重判共用这一个谓词，两处不会各自拼一遍窗口与到期条件。
        窗口外或未到期就完全沿用现有参数，不因持久进度里的全量标记另起全量轮次。
        """
        return (self._refresh_window_open(now)
                and like_refresh_due(anchor_iso, now, self.like_refresh_config["interval"]))

    async def _register_like_refresh(self):
        """凌晨窗口内把「已完成且到期」的目标置回待办；写点仍只在检查状态模块内。

        只有持进程锁的采集进程调它；API 不登记、不领取。窗口、到期与间隔都是纯函数
        判定，间隔 0 直接关闭该通道。
        """
        now = self.clock.now()
        if not self._refresh_window_open(now):
            return 0
        targets = await to_thread.run_sync(self.store.like_refresh_targets)
        reopened = 0
        for target in targets:
            if not self._like_refresh_round(target["like_refresh_succeeded_at"], now):
                continue
            reopened += int(await to_thread.run_sync(
                lambda target=target: self.store.reopen_check_work(target["uid"], target["id"])))
        if reopened:
            collector_event("like_refresh_registered", targets=reopened)
        return reopened

    async def _drop_session(self, sessions, attempted, key, session, *, settled="result"):
        """退出一个目标会话的唯一入口。

        `settled="result"` 按会话结果结算，`"failed"` 记一次失败，`None` 表示不结算
        （尚未领取或目标租约已失去）。结算本身会释放目标租约，不结算的退出在这里补
        释放；无论如何都把目标记入本拍已尝试，否则同一轮会重复派发同一个目标。
        """
        if settled == "result":
            await self._finish_session(session)
        elif settled == "failed":
            await self._finish_session(session, succeeded=False, archive=None)
        elif session.target_lease is not None:
            await session.target_lease.release()
        sessions.pop(key, None)
        attempted.add(key)

    async def _open_session(self, target):
        uid, id = target["uid"], target["id"]
        target_refs = source_refs(uid=uid, dynamic_id=id)
        lease = None
        if self.scheduler is not None:
            lease = await self.scheduler.acquire_target(uid, id, wait=False)
            if lease is None:
                collector_event("sync_skipped", reason="target_busy",
                                stage="claim", **target_refs)
                return None
        try:
            claim = await to_thread.run_sync(lambda: self.store.claim_check_work(
                uid, id, selection=target["selection"]))
            if claim is None:
                collector_event("sync_skipped", reason="not_claimed", **target_refs)
                if lease is not None:
                    await lease.release()
                return None
            # 领取时就地重判：全量不是跨轮粘性状态，窗口外或锚点未到期就完全沿用现有参数。
            now = self.clock.now()
            like_refresh = self._like_refresh_round(claim.get("like_refresh_succeeded_at"), now)
            collector_event("sync_started", revision=claim["revision"], like_refresh=like_refresh,
                            **target_refs)
            session = TargetSession(
                self.store, self.client, uid, id, None, claim["observed"],
                downloader=self.downloader, uploader=self.uploader,
                comment_client_factory=self.comment_client_factory,
                now=self.clock.now, pending_comments_only=True, full_replies=False,
                like_refresh=like_refresh, refresh_window=self._refresh_window_open(now))
            session.claim = claim
            session.alerts = []
            session.on_failure = lambda error: self._note_failure(session, error)
            session.target_lease = lease
            return session
        except BaseException:
            if lease is not None:
                await lease.release()
            raise

    def _note_failure(self, session, error):
        """会话内失败：登记告警；可自愈的分页校验只留 WARNING，并标记本次不兜底告警。"""
        alerts = self._failure_alerts(error, f"{session.uid}:{session.id}")
        if alerts:
            session.alerts.extend(alerts)
        else:
            session.suppressed = True

    async def _finish_session(self, session, *, succeeded=None, archive=None):
        if archive is None:
            if succeeded is None:
                succeeded, archive, _ = await session.result()
        if succeeded is None:
            succeeded = False
        # 同步阶段的显式失败事实（正文读取失败、根／回复分页失败）也登记告警；
        # 普通的“待同步／媒体待完成”不是故障，可自愈分页校验（`suppressed`）也不借此兜底。
        if archive is not None and not session.alerts and not session.suppressed:
            if archive["work"].get("text") == "failed":
                session.alerts.append(outbox.Alert("collection", f"{session.uid}:{session.id}",
                                                   "body_failed"))
            elif archive.get("comments_error"):
                session.alerts.append(outbox.Alert("collection", f"{session.uid}:{session.id}",
                                                   "comments_failed"))
        claim = session.claim
        record_success = (archive is not None
                          and archive["work"]["text"] in ("success", "restricted"))
        complete = await to_thread.run_sync(lambda: self.store.finish_check_work(
            session.uid, session.id, claim["revision"], succeeded, self.clock.now(),
            None if succeeded else "SYNC_INCOMPLETE", token=claim["token"],
            selection=claim["selection"], record_success=record_success,
            alerts=session.alerts))
        parts = archive["work"] if archive else {}
        collector_event("sync_finished", warning=not complete, succeeded=succeeded,
                        complete=complete, **source_refs(uid=session.uid, dynamic_id=session.id),
                        text=parts.get("text"), comments=parts.get("comments"),
                        replies=parts.get("replies"), media=parts.get("media"))
        if session.target_lease is not None:
            await session.target_lease.release()

    def _record_loop_alert(self, error):
        """独立连接短事务登记主循环故障；写失败只留固定分类日志，不掩盖原异常。"""
        try:
            now = epoch_from_iso(self.clock.now())
            with write(self.store) as connection:
                for alert in self._failure_alerts(
                        error, "collector_loop", category="loop"):
                    outbox.record_alert(connection, alert, now)
        except Exception as failure:
            collector_failure("alert_registration_failed", failure,
                              credentials_configured=self.credentials_configured)

    async def run(self):
        """从启动时刻起固定节拍；有限并发、忙即跳过，没有检查队列。"""
        configure_safe_logging()
        with collector_lock(self.store.path):
            await to_thread.run_sync(self.store.migrate)
            await to_thread.run_sync(self.store.recover_check_work)
            await to_thread.run_sync(self.store.recover_discoveries, self.clock.now())
            # 重启不抵扣观察期：停机时间不算正常运行，观察时间重新累计但档位保留。
            if self.risk is not None:
                await self.risk.restart_observation()
                self._observation_mark = None
            collector_event("collector_started", cadence_ms=int(CADENCE_SECONDS * 1000),
                            cadence_jitter_pct=int(round(CADENCE_JITTER * 100)),
                            page_check_ms=int(PAGE_CHECK_SECONDS * 1000),
                            page_check_jitter_ms=int(PAGE_CHECK_JITTER_SECONDS * 1000),
                            max_checks=self.max_checks, max_syncs=self.max_syncs,
                            max_discoveries=self.max_discoveries, recovery="complete")
            collector_event("like_refresh_configuration",
                            interval_seconds=self.like_refresh_config["interval"],
                            window_start_minute=window_minute(self.like_refresh_config["window"][0]),
                            window_end_minute=window_minute(self.like_refresh_config["window"][1]),
                            interval_source=self.like_refresh_config["interval_source"],
                            window_source=self.like_refresh_config["window_source"],
                            warning="invalid" in (self.like_refresh_config["interval_source"],
                                                   self.like_refresh_config["window_source"]))
            checks, discoveries = {}, {}
            drain = None
            offset = discovery_offset = 0
            deadline = self.clock.monotonic()
            observation_cap = self.cadence()
            try:
                while True:
                    for key, task in list(checks.items()):
                        if task.done():
                            self._settle(task)
                            del checks[key]
                    if drain is not None and drain.done():
                        self._settle(drain)
                        drain = None
                    for uid, task in list(discoveries.items()):
                        if task.done():
                            self._settle(task)
                            del discoveries[uid]
                    discoveries_started = checks_started = syncs_started = 0
                    status = await self._risk_status()
                    registered_manual_probe = (status is not None
                                               and status["manual"]["probe_registered"])
                    if (status is not None and self.probe is not None
                            and (status["state"] in ("cooldown", "probing")
                                 or registered_manual_probe)):
                        # 到期（或租约过期可接管）就实际执行一轮按接口探测；人工态只执行
                        # 已登记的那一轮。网络与解析在写事务外，同一节拍不重试。
                        finished = await self.probe.probe_if_due()
                        if finished is not None:
                            status = finished
                    # 观察期心跳：只有确有成功业务请求的节拍才累计活跃采集时间。
                    status = await self._observation_tick(status, observation_cap)
                    pause = status if (status is not None
                                       and status["state"] in BLOCKED_STATES) else None
                    if pause is not None:
                        # 被保护暂停：不领取、不发送、不新增失败；保留 pending 与断点。
                        cadence = self.cadence()
                        deadline += cadence
                        now = self.clock.monotonic()
                        if deadline < now:
                            skipped = int((now - deadline) // cadence) + 1
                            deadline += skipped * cadence
                        if pause["generation"] != self._paused_generation:
                            # 同一状态代次只留一条：暂停期间不每 2.7 秒重复同一警告。
                            self._paused_generation = pause["generation"]
                            collector_event("collector_paused", risk_state=pause["state"],
                                            backoff_step=pause["backoff_step"],
                                            checks_in_flight=len(checks),
                                            syncs_in_flight=int(drain is not None))
                        # 仍保留节拍心跳：暂停不是进程退出，只是不派发工作。
                        collector_event("collector_tick", paused=True,
                                        checks_in_flight=len(checks),
                                        syncs_in_flight=int(drain is not None),
                                        discoveries_in_flight=len(discoveries), checks_started=0,
                                        syncs_started=0, discoveries_started=0)
                        await self.clock.sleep(max(0, deadline - now))
                        continue
                    # 探测全部通过后的观察态：归还上次被暂停打断的领取，继续原断点。
                    await self._resume_abandoned(status, bool(checks or drain is not None or discoveries))
                    recent_ups = await to_thread.run_sync(self.store.enabled_recent)
                    if recent_ups:
                        discovery_offset %= len(recent_ups)
                        launched = 0
                        for up in recent_ups[discovery_offset:] + recent_ups[:discovery_offset]:
                            uid = up["uid"]
                            if uid not in discoveries and len(discoveries) < self.max_discoveries:
                                discoveries[uid] = asyncio.create_task(self.discover_once(uid))
                                launched += 1
                        discovery_offset = (discovery_offset + max(1, launched)) % len(recent_ups)
                        discoveries_started = launched
                    targets = await to_thread.run_sync(lambda: self.store.enabled_targets(with_selection=True))
                    if targets:
                        offset %= len(targets)
                        ordered = targets[offset:] + targets[:offset]
                        launched = 0
                        for target in ordered:
                            key = (target["uid"], target["id"])
                            if key not in checks and len(checks) < self.max_checks:
                                checks[key] = asyncio.create_task(self.check_once(*key, selection=target["selection"]))
                                launched += 1
                        offset = (offset + max(1, launched)) % len(targets)
                        checks_started = launched
                    # 每日点赞刷新的登记：窗口内把到期的已完成目标置回待办。扫描内部
                    # 限频（每 LIKE_REFRESH_SCAN_SECONDS 一次），不必每拍扫一遍表。
                    like_refresh_reopened = 0
                    mark = self.clock.monotonic()
                    if (self._like_refresh_mark is None
                            or mark - self._like_refresh_mark >= LIKE_REFRESH_SCAN_SECONDS):
                        self._like_refresh_mark = mark
                        like_refresh_reopened = await self._register_like_refresh()
                    pending = await to_thread.run_sync(lambda: self.store.pending_checks(with_selection=True))
                    if pending and drain is None:
                        # 单路重型：一个 drain 内按目标轮转步骤，完成一个分页就释放回合。
                        drain = asyncio.create_task(self.execute_pending())
                        syncs_started = 1
                    cadence = self.cadence()
                    observation_cap = cadence
                    deadline += cadence
                    # 进程/事件循环停顿越过节拍时跳过错过的槽，绝不补发积压。
                    now = self.clock.monotonic()
                    if deadline < now:
                        skipped = int((now - deadline) // cadence) + 1
                        deadline += skipped * cadence
                        collector_event("collector_ticks_skipped", skipped=skipped)
                    collector_event("collector_tick", targets=len(targets), recent_ups=len(recent_ups),
                                    pending=len(pending), checks_in_flight=len(checks),
                                    syncs_in_flight=int(drain is not None),
                                    discoveries_in_flight=len(discoveries),
                                    checks_started=checks_started, syncs_started=syncs_started,
                                    discoveries_started=discoveries_started,
                                    like_refresh_reopened=like_refresh_reopened)
                    await self.clock.sleep(max(0, deadline - now))
            except asyncio.CancelledError:
                collector_event("collector_stopping", reason="cancelled")
                raise
            except Exception as error:
                collector_failure("collector_loop_failed", error,
                                  credentials_configured=self.credentials_configured)
                # 主循环可捕获异常：先在独立短事务里登记告警，再退出；数据库本身不可写时
                # 只能留脱敏日志，不承诺即时外发（强杀/整机离线同样无法登记）。
                self._record_loop_alert(error)
                raise
            finally:
                tasks = list(checks.values()) + list(discoveries.values())
                if drain is not None:
                    tasks.append(drain)
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                collector_event("collector_stopped")


@asynccontextmanager
async def open_collector(database, *, source_gate: SourceGate | None = None, source_transport=None,
                         media_transport=None, media_uploader=None, comment_client_factory=None,
                         clock=None, reply_page_pacer=None, risk_clock=None, probe=None,
                         scheduler=None):
    """生产装配：来源 client、评论会话、媒体下载与 Collector；只替换外部传输和时钟。

    `source_gate` 与 API 进程接的是同一 Interface：检查、发现、归档、预热和图片下载
    不经另一套通道；OSS 上传与通知投递不在其中。`reply_page_pacer` 是楼中楼页后
    等待的协调器，默认进程内一个，可从外部注入受控时间或与 API 进程共用。
    `probe` 是到期探测执行器；默认用同一份凭据／代理／等待规则构造独立装配
    （探测期间发送许可本来就拒绝普通请求，唯一性由持久 owner 租约保证）。
    """
    store = Store(database)
    # 与 API 进程读同一 SQLite 文件：进程内对象不冒充跨进程保护。
    risk = RiskGate(store, clock=risk_clock)
    gate = source_gate if source_gate is not None else risk
    cookie_pairs = load_source_cookie_pairs()
    source_hooks = source_client_event_hooks(cookie_pairs=cookie_pairs)
    pacer = SourcePacer()
    page_pacer = reply_page_pacer if reply_page_pacer is not None else ReplyPagePacer()
    leases = scheduler if scheduler is not None else DispatchLeases(store, clock=risk_clock or clock)
    owns_comments = comment_client_factory is None
    comments = (RequestsCommentClientFactory(cookie_pairs=cookie_pairs, pacer=pacer, gate=gate,
                                            reply_page_pacer=page_pacer, source_lease=leases)
                if owns_comments else comment_client_factory)
    owns_uploader = media_uploader is None
    uploader = None
    try:
        uploader = OSSUploader.from_environment() if owns_uploader else media_uploader
        async with GatedAsyncClient(
            transport=PacedSourceTransport(
                GatedAsyncTransport(source_transport, gate=gate, source_lease=leases), pacer=pacer),
            timeout=10, trust_env=False, follow_redirects=False,
            headers=SOURCE_HEADERS, event_hooks=source_hooks, gate=gate,
        ) as source_client, GatedAsyncClient(
            transport=GatedAsyncTransport(media_transport, gate=gate, source_lease=leases),
            timeout=30, trust_env=False, gate=gate,
        ) as media_client:
            if probe is not None:
                yield Collector(store, source_client, ImageDownloader(media_client), uploader,
                                comment_client_factory=comments, clock=clock,
                                credentials_configured=bool(cookie_pairs), risk=risk, probe=probe,
                                scheduler=leases)
                return
            # 探测装配：同一凭据、代理、pacer 与解析，只是不再取“普通请求”的发送许可。
            probe_comments = RequestsCommentClientFactory(
                cookie_pairs=cookie_pairs, pacer=pacer, reply_page_pacer=page_pacer)
            try:
                async with httpx.AsyncClient(
                        transport=PacedSourceTransport(source_transport, pacer=pacer), timeout=10,
                        trust_env=False, follow_redirects=False, headers=SOURCE_HEADERS,
                        event_hooks=source_hooks) as probe_client, httpx.AsyncClient(
                        transport=media_transport, timeout=30, trust_env=False) as probe_media:
                    # 探测集合只并入“恢复后真会发出”的预热：判定来自生产会话工厂的
                    # WarmupCache（TTL 内命中或仍在重试冷却期都不强加无关请求）。
                    prober = RiskProber(store, risk, probe_client, comments=probe_comments,
                                        downloader=ImageDownloader(probe_media),
                                        clock=(clock.monotonic if clock is not None else None),
                                        warmup_due=getattr(comments, "warmup_due", None))
                    yield Collector(store, source_client, ImageDownloader(media_client), uploader,
                                    comment_client_factory=comments, clock=clock,
                                    credentials_configured=bool(cookie_pairs), risk=risk,
                                    probe=prober, scheduler=leases)
            finally:
                await probe_comments.aclose()
    finally:
        if owns_comments:
            await comments.aclose()
        if owns_uploader and uploader is not None:
            await to_thread.run_sync(uploader.close)


async def serve(database, *, once=False, source_gate: SourceGate | None = None):
    configure_safe_logging()
    collector_event("collector_initializing")
    try:
        async with open_collector(database, source_gate=source_gate) as collector:
            collector_event("collector_configuration", mode="once" if once else "continuous",
                            comment_engine="requests", proxy_policy="environment",
                            media_upload="enabled" if collector.uploader is not None else "disabled")
            if once:
                with collector_lock(database):
                    await to_thread.run_sync(collector.store.migrate)
                    for target in await to_thread.run_sync(lambda: collector.store.enabled_targets(with_selection=True)):
                        await collector.check_once(target["uid"], target["id"], selection=target["selection"])
                    for up in await to_thread.run_sync(collector.store.enabled_recent):
                        await collector.discover_once(up["uid"])
                return
            task = asyncio.create_task(collector.run())
            loop = asyncio.get_running_loop()
            for signum in (signal.SIGTERM, signal.SIGINT):
                loop.add_signal_handler(signum, task.cancel)
            try:
                await task
            except asyncio.CancelledError:
                pass
            finally:
                for signum in (signal.SIGTERM, signal.SIGINT):
                    loop.remove_signal_handler(signum)
    except Exception as error:
        collector_failure("collector_failed", error)
        raise


def main():
    parser = argparse.ArgumentParser(description="Fixed-cadence collector")
    parser.add_argument("--database", default=os.environ.get("BILI_DATABASE_PATH", "backend/data/monitor.sqlite"))
    parser.add_argument("--once", action="store_true", help="Record one check/discovery pass without executing sync")
    args = parser.parse_args()
    try:
        asyncio.run(serve(args.database, once=args.once))
    except KeyboardInterrupt:
        pass
    except Exception:
        # 入口也不输出原始异常 traceback、数据库路径或环境凭据。
        raise SystemExit("Collector failed") from None


if __name__ == "__main__":
    main()
