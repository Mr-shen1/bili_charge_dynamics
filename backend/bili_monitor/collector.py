"""独立采集入口：检查只登记信号，归档执行另行领取持久工作。"""

import argparse
import asyncio
import os
import random
import signal

import httpx
import fcntl
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from anyio import to_thread

from .source import fetch_page, page_metadata, fetch_detail, COMMENT_LOCATOR_VERSION
from .source_transport import PacedSourceTransport, SourcePacer
from .source_client import SOURCE_HEADERS, source_client_event_hooks
from .source_cookies import load_source_cookie_pairs
from .comment_client import RequestsCommentClientFactory, open_comment_client
from .root_comments import fetch_comment_count, valid_locator
from .sync import sync_target
from .media import ImageDownloader
from .oss import OSSUploader
from .safety import configure_safe_logging
from .collector_logging import collector_attempt, collector_event, collector_failure
from .storage import Store
from .selection import selection_matches


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
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

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


def _timestamp(value):
    """当前时钟产生的 ISO 字符串；容错处理带/不带时区与 'Z'。"""
    text = value.replace("Z", "+00:00") if isinstance(value, str) else value
    return datetime.fromisoformat(text).timestamp()


class Collector:
    def __init__(self, store, client, downloader=None, uploader=None, *, clock=None,
                 max_checks=4, max_syncs=4, max_discoveries=2, comment_client_factory=None,
                 cadence=None, page_check_seconds=None):
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
        self.cadence = cadence if cadence is not None else cadence_provider()
        # 默认每轮采样带抖动；显式传值时用于测试/运维固定间隔。
        self.page_interval = ((lambda: float(page_check_seconds)) if page_check_seconds is not None
                              else page_interval_sample)

    async def discover_once(self, uid):
        """一次按 UP 发现并发布可信窗口；首次工作仍经固定检查与独立归档阶段。"""
        from .discovery import discover_recent, DiscoveryError, DiscoveryStopped

        claim = await to_thread.run_sync(self.store.claim_discovery, uid, self.clock.now())
        if claim is None:
            return False
        token = claim["token"]
        collector_event("discovery_started")

        async def should_continue():
            return await to_thread.run_sync(self.store.discovery_claim_active, uid, token)

        async def on_progress(ids):
            await to_thread.run_sync(self.store.record_discovery_progress, uid, token, ids)

        try:
            result = await discover_recent(
                self.client, uid, claim["recent_n"], should_continue=should_continue, on_progress=on_progress)
        except DiscoveryStopped:
            collector_event("discovery_stopped", reason="selection_changed")
            return False
        except Exception as error:
            collector_failure("discovery_failed", error)
            code = error.code if isinstance(error, DiscoveryError) else "SOURCE_UNAVAILABLE"
            await to_thread.run_sync(self.store.finish_discovery, uid, token, None, self.clock.now(), code)
            return False
        accepted = await to_thread.run_sync(self.store.finish_discovery, uid, token, result, self.clock.now())
        collector_event("discovery_finished", accepted=accepted)
        return accepted

    def _page_due(self, last_checked_at, now):
        """页面信号是否到期：无记录或超过采样间隔。时间字符串无法解析时按到期处理。"""
        if not last_checked_at:
            return True
        try:
            return (_timestamp(now) - _timestamp(last_checked_at)) >= self.page_interval()
        except ValueError:
            return True

    async def check_once(self, uid, id, *, selection=None):
        current = await to_thread.run_sync(self.store.check_selection, uid, id)
        if not selection_matches(current, selection):
            return False
        selection = current
        collector_event("check_started")

        async def still_selected():
            return await to_thread.run_sync(self.store.check_selection, uid, id) == selection

        checks = await to_thread.run_sync(self.store.read_checks, uid)
        observed = next((item["observed"] for item in checks if item["id"] == id), {})
        locator = observed.get("comment_locator")
        now = self.clock.now()
        page_signal = self._page_due(await to_thread.run_sync(self.store.page_checked_at, uid, id), now)
        metadata, page_error = None, None
        if page_signal:
            try:
                metadata = page_metadata(await fetch_page(self.client, id), uid)
                if metadata.get("edit_status") == "error":
                    page_error = "SIGNAL_INVALID"
            except Exception as exception:
                collector_failure("check_source_failed", exception, stage="page")
                page_error = "SOURCE_UNAVAILABLE"
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
                except Exception as exception:
                    collector_failure("check_source_failed", exception, stage="detail")
        elif not valid_locator(locator) or locator.get("policy_version") != COMMENT_LOCATOR_VERSION:
            # 页面信号未到期且没有可用定位：本轮无事可做，不重复打上游，也不落一条失败记录。
            collector_event("check_skipped", reason="page_interval")
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
        except Exception as exception:
            collector_failure("check_source_failed", exception, stage="comment_count")
        # 网页计数不回退冒充独立计数读取成功；两项信号可各自失败。
        if metadata is not None:
            metadata.pop("source_comment_count", None)
        # 记录时间取提交时刻：慢检查不能让 last_checked_at 回退到开始时间。
        accepted = await to_thread.run_sync(lambda: self.store.record_check(
            uid, id, metadata, self.clock.now(), page_error, comment_observation=comments,
            selection=selection, media_upload=self.uploader is not None, page_signal=page_signal))
        collector_event("check_finished", recorded=accepted,
                        edit_status=metadata.get("edit_status") if metadata else None,
                        comment_count_status=comments["comment_count_status"])
        return accepted

    async def execute_pending(self):
        """一次领取遍历；失败留待下一节拍，不在本轮无限重试。"""
        targets = await to_thread.run_sync(lambda: self.store.pending_checks(with_selection=True))
        pending = iter(targets)

        async def worker():
            for target in pending:
                await self._execute_target(target)

        await asyncio.gather(*(worker() for _ in range(min(self.max_syncs, len(targets)))))

    async def _execute_target(self, target):
        with collector_attempt():
            started = self.clock.monotonic()
            try:
                uid, id = target["uid"], target["id"]
                claim = await to_thread.run_sync(lambda: self.store.claim_check_work(
                    uid, id, selection=target["selection"]))
                if claim is None:
                    collector_event("sync_skipped", reason="not_claimed")
                    return
                collector_event("sync_started", revision=claim["revision"])
                succeeded, archive = False, None
                try:
                    generation = await to_thread.run_sync(lambda: self.store.claim_archive(
                        uid, id, selection=claim["selection"]))
                    if generation is not None:
                        text_succeeded = await sync_target(
                            self.store, self.client, uid, id, generation, self.downloader, self.uploader,
                            pending_comments_only=True, comment_observation=claim["observed"], now=self.clock.now,
                            comment_client_factory=self.comment_client_factory)
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
                except Exception as error:
                    # 仅固定分类；取消仍保留 running 供持锁重启恢复。
                    collector_failure("sync_execution_failed", error)
                complete = await to_thread.run_sync(
                    lambda: self.store.finish_check_work(uid, id, claim["revision"], succeeded, self.clock.now(),
                                                       None if succeeded else "SYNC_INCOMPLETE", token=claim["token"],
                                                       selection=claim["selection"], record_success=(
                                                           archive is not None
                                                           and archive["work"]["text"] in ("success", "restricted"))))
                parts = archive["work"] if archive else {}
                collector_event("sync_finished", warning=not complete, succeeded=succeeded, complete=complete,
                                elapsed_ms=max(0, int((self.clock.monotonic() - started) * 1000)),
                                text=parts.get("text"), comments=parts.get("comments"),
                                replies=parts.get("replies"), media=parts.get("media"))
            except Exception as error:
                # 领取或完成写入失败不会静默消失，随后由调度循环明确报错退出。
                collector_failure("sync_task_failed", error)
                raise

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
                            task.result()
                            del checks[key]
                    for key, task in list(executions.items()):
                        if task.done():
                            task.result()
                            del executions[key]
                    for uid, task in list(discoveries.items()):
                        if task.done():
                            task.result()
                            del discoveries[uid]
                    discoveries_started = checks_started = syncs_started = 0
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
                collector_failure("collector_loop_failed", error)
                raise
            finally:
                tasks = list(checks.values()) + list(executions.values()) + list(discoveries.values())
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                collector_event("collector_stopped")


async def serve(database, *, once=False):
    configure_safe_logging()
    collector_event("collector_initializing")
    uploader = None
    comment_factory = None
    try:
        cookie_pairs = load_source_cookie_pairs()
        source_hooks = source_client_event_hooks(cookie_pairs=cookie_pairs)
        pacer = SourcePacer()
        comment_factory = RequestsCommentClientFactory(cookie_pairs=cookie_pairs, pacer=pacer)
        uploader = OSSUploader.from_environment()
        collector_event("collector_configuration", mode="once" if once else "continuous",
                        comment_engine="requests", proxy_policy="environment",
                        media_upload="enabled" if uploader is not None else "disabled")
        async with httpx.AsyncClient(
            transport=PacedSourceTransport(pacer=pacer), timeout=10, trust_env=False,
            follow_redirects=False, headers=SOURCE_HEADERS, event_hooks=source_hooks,
        ) as source_client, httpx.AsyncClient(
            timeout=30, trust_env=False
        ) as media_client:
            collector = Collector(Store(database), source_client, ImageDownloader(media_client), uploader,
                                  comment_client_factory=comment_factory)
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
    finally:
        if comment_factory is not None:
            await comment_factory.aclose()
        if uploader is not None:
            await to_thread.run_sync(uploader.close)


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
