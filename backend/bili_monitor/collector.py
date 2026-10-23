"""独立采集入口：检查只登记信号，归档执行另行领取持久工作。"""

import argparse
import asyncio
import os
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


CADENCE_SECONDS = 15


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


class Collector:
    def __init__(self, store, client, downloader=None, uploader=None, *, clock=None,
                 max_checks=4, max_syncs=4, max_discoveries=2, comment_client_factory=None):
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

    async def check_once(self, uid, id, *, selection=None):
        current = await to_thread.run_sync(self.store.check_selection, uid, id)
        if not selection_matches(current, selection):
            return False
        selection = current
        collector_event("check_started")

        async def still_selected():
            return await to_thread.run_sync(self.store.check_selection, uid, id) == selection

        metadata, error = None, None
        try:
            metadata = page_metadata(await fetch_page(self.client, id), uid)
            if metadata.get("edit_status") == "error":
                error = "SIGNAL_INVALID"
        except Exception as exception:
            collector_failure("check_source_failed", exception, stage="page")
            error = "SOURCE_UNAVAILABLE"
        if not await still_selected():
            return False
        # 新定位策略上线时重新核对旧 locator，不能仅凭格式正确就永久复用。
        checks = await to_thread.run_sync(self.store.read_checks, uid)
        observed = next((item["observed"] for item in checks if item["id"] == id), {})
        locator = observed.get("comment_locator")
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
                    error = None
                collector_event("comment_locator_refreshed", source=locator.get("source") if locator else None)
            except Exception as exception:
                collector_failure("check_source_failed", exception, stage="detail")
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
        accepted = await to_thread.run_sync(lambda: self.store.record_check(
            uid, id, metadata, self.clock.now(), error, comment_observation=comments, selection=selection,
            media_upload=self.uploader is not None))
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
            collector_event("collector_started", cadence_seconds=CADENCE_SECONDS,
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
                    deadline += CADENCE_SECONDS
                    # 进程/事件循环停顿越过节拍时跳过错过的槽，绝不补发积压。
                    now = self.clock.monotonic()
                    if deadline < now:
                        skipped = int((now - deadline) // CADENCE_SECONDS) + 1
                        deadline += skipped * CADENCE_SECONDS
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
