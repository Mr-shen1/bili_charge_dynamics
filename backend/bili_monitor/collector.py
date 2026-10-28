"""独立采集入口：检查只登记信号，归档执行另行领取持久工作。"""

import argparse
import asyncio
import os
import random
import signal
from contextlib import asynccontextmanager, contextmanager

import httpx
import fcntl
import time
from pathlib import Path

from anyio import to_thread

from .source import fetch_page, page_metadata, fetch_detail, COMMENT_LOCATOR_VERSION
from .source_transport import PacedSourceTransport, SourcePacer
from .source_gate import GatedAsyncTransport, SourceGate
from .source_client import SOURCE_HEADERS, source_client_event_hooks
from .source_cookies import load_source_cookie_pairs
from .comment_client import RequestsCommentClientFactory, open_comment_client
from .comment_status import epoch_from_iso, utc_now
from .notifications import outbox
from .risk import BLOCKED_STATES, RiskGate, SourceRiskPaused
from .risk_probe import RiskProber
from .reply_pacing import ReplyPagePacer
from .root_comments import fetch_comment_count, valid_locator
from .sync import sync_target
from .media import ImageDownloader
from .oss import OSSUploader
from .safety import configure_safe_logging
from .collector_logging import (
    collector_attempt, collector_event, collector_failure, credential_signal, failure_fields,
    source_ids, source_refs,
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
                 probe=None):
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
        self._paused_generation = None
        # 进入 observing 后只归还一次在途中止的工作，不重复重置。
        self._resumed_generation = None
        # 启动时一次性读取的来源凭据是否存在；判定处不再读文件，也不为了告警额外访问来源。
        self.credentials_configured = bool(credentials_configured)
        self.cadence = cadence if cadence is not None else cadence_provider()
        # 默认每轮采样带抖动；显式传值时用于测试/运维固定间隔。
        self.page_interval = ((lambda: float(page_check_seconds)) if page_check_seconds is not None
                              else page_interval_sample)

    async def _risk_status(self):
        """完整只读状态：判定是否到期探测、是否恢复在途工作。未接入时返回 None。"""
        if self.risk is None:
            return None
        return await self.risk.snapshot()

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

    def _settle(self, task):
        """任务结算：被保护暂停不是失败，不写检查结果／成功时间，只留一次固定日志。"""
        try:
            task.result()
        except SourceRiskPaused as paused:
            collector_event("source_risk_paused_work_aborted", risk_state=paused.status["state"],
                            backoff_step=paused.status["backoff_step"])

    def _failure_alerts(self, error, object_key, category="collection"):
        """一次真实失败 → 告警登记项（不读日志、不扫描、不访问上游）。

        可信凭据失效只认「来源业务码 -101 + 本次确实配置了凭据」，对象键是全局来源
        凭据；其余仍按原分类归入本阶段类别（采集异常／主循环异常），不让普通网络/
        风控/HTTP 错误冒充登录失效。
        """
        signal = credential_signal(error, credentials_configured=self.credentials_configured)
        if signal == "credential_rejected":
            return [outbox.Alert("credential", "source_credential", signal)]
        reason = signal or failure_fields(error)["reason"]
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
        """一次领取遍历；失败留待下一节拍，不在本轮无限重试。"""
        targets = await to_thread.run_sync(lambda: self.store.pending_checks(with_selection=True))
        pending = iter(targets)

        async def worker():
            for target in pending:
                try:
                    await self._execute_target(target)
                except SourceRiskPaused:
                    # 被保护暂停：停止本 worker 领取后续工作，不写失败事实。
                    collector_event("source_risk_paused_work_aborted")
                    return

        await asyncio.gather(*(worker() for _ in range(min(self.max_syncs, len(targets)))))

    async def _execute_target(self, target):
        with collector_attempt():
            started = self.clock.monotonic()
            try:
                uid, id = target["uid"], target["id"]
                target_refs = source_refs(uid=uid, dynamic_id=id)
                claim = await to_thread.run_sync(lambda: self.store.claim_check_work(
                    uid, id, selection=target["selection"]))
                if claim is None:
                    collector_event("sync_skipped", reason="not_claimed", **target_refs)
                    return
                collector_event("sync_started", revision=claim["revision"], **target_refs)
                succeeded, archive = False, None
                alerts = []
                try:
                    generation = await to_thread.run_sync(lambda: self.store.claim_archive(
                        uid, id, selection=claim["selection"]))
                    if generation is not None:
                        text_succeeded = await sync_target(
                            self.store, self.client, uid, id, generation, self.downloader, self.uploader,
                            pending_comments_only=True, comment_observation=claim["observed"], now=self.clock.now,
                            comment_client_factory=self.comment_client_factory,
                            on_failure=lambda error: alerts.extend(
                                self._failure_alerts(error, f"{uid}:{id}")))
                        archive = await to_thread.run_sync(self.store.read_archive, id)
                        version = claim["observed"].get("observed_version")
                        restricted_current = (archive["work"]["text"] == "restricted"
                                              and archive.get("restricted_version") == version
                                              and claim["observed"].get("content_visible") is not True)
                        # 未配置媒体上传时 media.py 直接返回、从不推进媒体状态，有图的
                        # 归档永远无法完成；此时不把媒体当完成条件，否则目标永久未完成
                        # 并每 tick 重领工作。媒体分项仍如实保持 pending。
                        media_upload = self.uploader is not None
                        succeeded = ((text_succeeded or restricted_current)
                                     and all(value in ("success", "restricted")
                                             for part, value in archive["work"].items()
                                             if media_upload or part != "media")
                                     and archive["work"]["comments"] == archive["work"]["replies"] == "success"
                                     and (not media_upload or archive["work"]["media"] != "restricted"
                                          or restricted_current)
                                     and (archive["synced_version"] == version or restricted_current)
                                     and archive["synced_comment_count"] == claim["observed"].get("source_comment_count"))
                        if media_upload:
                            for root_id in await to_thread.run_sync(self.store.media_root_ids, id):
                                root = await to_thread.run_sync(self.store.read_media_owner, id, root_id)
                                succeeded = succeeded and root["work"]["media"] == "success"
                except SourceRiskPaused:
                    # 保留 running 领取与已提交分片；不写失败事实、不伪造完成时间。
                    raise
                except Exception as error:
                    # 仅固定分类；取消仍保留 running 供持锁重启恢复。
                    collector_failure("sync_execution_failed", error,
                                      credentials_configured=self.credentials_configured)
                    alerts.extend(self._failure_alerts(error, f"{uid}:{id}"))
                # 同步阶段的显式失败事实（正文读取失败、根／回复分页失败）也登记告警；
                # 普通的“待同步／媒体待完成”不是故障，不据此告警。
                if archive is not None and not alerts:
                    if archive["work"].get("text") == "failed":
                        alerts.append(outbox.Alert("collection", f"{uid}:{id}", "body_failed"))
                    elif archive.get("comments_error"):
                        alerts.append(outbox.Alert("collection", f"{uid}:{id}", "comments_failed"))
                complete = await to_thread.run_sync(
                    lambda: self.store.finish_check_work(uid, id, claim["revision"], succeeded, self.clock.now(),
                                                       None if succeeded else "SYNC_INCOMPLETE", token=claim["token"],
                                                       selection=claim["selection"], record_success=(
                                                           archive is not None
                                                           and archive["work"]["text"] in ("success", "restricted")),
                                                       alerts=alerts))
                parts = archive["work"] if archive else {}
                collector_event("sync_finished", warning=not complete, succeeded=succeeded, complete=complete,
                                **target_refs,
                                elapsed_ms=max(0, int((self.clock.monotonic() - started) * 1000)),
                                text=parts.get("text"), comments=parts.get("comments"),
                                replies=parts.get("replies"), media=parts.get("media"))
            except SourceRiskPaused:
                raise
            except Exception as error:
                # 领取或完成写入失败不会静默消失，随后由调度循环明确报错退出。
                collector_failure("sync_task_failed", error)
                raise

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
            collector_event("collector_started", cadence_ms=int(CADENCE_SECONDS * 1000),
                            cadence_jitter_pct=int(round(CADENCE_JITTER * 100)),
                            page_check_ms=int(PAGE_CHECK_SECONDS * 1000),
                            page_check_jitter_ms=int(PAGE_CHECK_JITTER_SECONDS * 1000),
                            max_checks=self.max_checks, max_syncs=self.max_syncs,
                            max_discoveries=self.max_discoveries, recovery="complete")
            checks, executions, discoveries = {}, {}, {}
            offset = sync_offset = discovery_offset = 0
            deadline = self.clock.monotonic()
            try:
                while True:
                    for key, task in list(checks.items()):
                        if task.done():
                            self._settle(task)
                            del checks[key]
                    for key, task in list(executions.items()):
                        if task.done():
                            self._settle(task)
                            del executions[key]
                    for uid, task in list(discoveries.items()):
                        if task.done():
                            self._settle(task)
                            del discoveries[uid]
                    discoveries_started = checks_started = syncs_started = 0
                    status = await self._risk_status()
                    if (status is not None and self.probe is not None
                            and status["state"] in ("cooldown", "probing")):
                        # 到期（或租约过期可接管）就实际执行一轮按接口探测；网络与解析在
                        # 写事务外，失败按阶梯推进，同一节拍不重试。
                        finished = await self.probe.probe_if_due()
                        if finished is not None:
                            status = finished
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
                                            checks_in_flight=len(checks), syncs_in_flight=len(executions))
                        # 仍保留节拍心跳：暂停不是进程退出，只是不派发工作。
                        collector_event("collector_tick", paused=True,
                                        checks_in_flight=len(checks), syncs_in_flight=len(executions),
                                        discoveries_in_flight=len(discoveries), checks_started=0,
                                        syncs_started=0, discoveries_started=0)
                        await self.clock.sleep(max(0, deadline - now))
                        continue
                    # 探测全部通过后的观察态：归还上次被暂停打断的领取，继续原断点。
                    await self._resume_abandoned(status, bool(checks or executions or discoveries))
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
                    pending = await to_thread.run_sync(lambda: self.store.pending_checks(with_selection=True))
                    if pending:
                        sync_offset %= len(pending)
                        launched = 0
                        for target in pending[sync_offset:] + pending[:sync_offset]:
                            key = (target["uid"], target["id"])
                            if key not in executions and len(executions) < self.max_syncs:
                                executions[key] = asyncio.create_task(self._execute_target(target))
                                launched += 1
                        sync_offset = (sync_offset + max(1, launched)) % len(pending)
                        syncs_started = launched
                    cadence = self.cadence()
                    deadline += cadence
                    # 进程/事件循环停顿越过节拍时跳过错过的槽，绝不补发积压。
                    now = self.clock.monotonic()
                    if deadline < now:
                        skipped = int((now - deadline) // cadence) + 1
                        deadline += skipped * cadence
                        collector_event("collector_ticks_skipped", skipped=skipped)
                    collector_event("collector_tick", targets=len(targets), recent_ups=len(recent_ups),
                                    pending=len(pending), checks_in_flight=len(checks),
                                    syncs_in_flight=len(executions), discoveries_in_flight=len(discoveries),
                                    checks_started=checks_started, syncs_started=syncs_started,
                                    discoveries_started=discoveries_started)
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
                tasks = list(checks.values()) + list(executions.values()) + list(discoveries.values())
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                collector_event("collector_stopped")


@asynccontextmanager
async def open_collector(database, *, source_gate: SourceGate | None = None, source_transport=None,
                         media_transport=None, media_uploader=None, comment_client_factory=None,
                         clock=None, reply_page_pacer=None, risk_clock=None, probe=None):
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
    owns_comments = comment_client_factory is None
    comments = (RequestsCommentClientFactory(cookie_pairs=cookie_pairs, pacer=pacer, gate=gate,
                                            reply_page_pacer=page_pacer)
                if owns_comments else comment_client_factory)
    owns_uploader = media_uploader is None
    uploader = None
    try:
        uploader = OSSUploader.from_environment() if owns_uploader else media_uploader
        async with httpx.AsyncClient(
            transport=PacedSourceTransport(GatedAsyncTransport(source_transport, gate=gate), pacer=pacer),
            timeout=10, trust_env=False, follow_redirects=False,
            headers=SOURCE_HEADERS, event_hooks=source_hooks,
        ) as source_client, httpx.AsyncClient(
            transport=GatedAsyncTransport(media_transport, gate=gate), timeout=30, trust_env=False
        ) as media_client:
            if probe is not None:
                yield Collector(store, source_client, ImageDownloader(media_client), uploader,
                                comment_client_factory=comments, clock=clock,
                                credentials_configured=bool(cookie_pairs), risk=risk, probe=probe)
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
                    prober = RiskProber(store, risk, probe_client, comments=probe_comments,
                                        downloader=ImageDownloader(probe_media), clock=clock)
                    yield Collector(store, source_client, ImageDownloader(media_client), uploader,
                                    comment_client_factory=comments, clock=clock,
                                    credentials_configured=bool(cookie_pairs), risk=risk,
                                    probe=prober)
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
