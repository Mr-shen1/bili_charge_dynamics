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

from .source import fetch_page, page_metadata, fetch_detail
from .root_comments import fetch_comment_count, valid_locator
from .sync import sync_target
from .media import ImageDownloader
from .oss import OSSUploader
from .safety import configure_safe_logging
from .storage import Store


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
                 max_checks=4, max_syncs=4, max_discoveries=2):
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

    async def discover_once(self, uid):
        """一次按 UP 发现；发布结果不等于内容归档或窗口初始化。"""
        from .discovery import discover_recent, DiscoveryError, DiscoveryStopped

        claim = await to_thread.run_sync(self.store.claim_discovery, uid, self.clock.now())
        if claim is None:
            return False
        token = claim["token"]

        async def should_continue():
            return await to_thread.run_sync(self.store.discovery_claim_active, uid, token)

        async def on_progress(ids):
            await to_thread.run_sync(self.store.record_discovery_progress, uid, token, ids)

        try:
            result = await discover_recent(
                self.client, uid, claim["recent_n"], should_continue=should_continue, on_progress=on_progress)
        except DiscoveryStopped:
            return False
        except Exception as error:
            code = error.code if isinstance(error, DiscoveryError) else "SOURCE_UNAVAILABLE"
            await to_thread.run_sync(self.store.finish_discovery, uid, token, None, self.clock.now(), code)
            return False
        return await to_thread.run_sync(self.store.finish_discovery, uid, token, result, self.clock.now())

    async def check_once(self, uid, id):
        selected = await to_thread.run_sync(self.store.enabled_targets)
        if {"uid": uid, "id": id} not in selected:
            return False
        metadata, error = None, None
        try:
            metadata = page_metadata(await fetch_page(self.client, id), uid)
            if metadata.get("edit_status") == "error":
                error = "SIGNAL_INVALID"
        except Exception:
            error = "SOURCE_UNAVAILABLE"
        # 定位可复用旧可信值；缺失时通过已校验归属的 detail 获取，不猜 oid。
        checks = await to_thread.run_sync(self.store.read_checks, uid)
        observed = next((item["observed"] for item in checks if item["id"] == id), {})
        locator = observed.get("comment_locator")
        if not valid_locator(locator):
            try:
                detail, _ = await fetch_detail(self.client, id, uid)
                locator = detail.get("comment_locator")
            except Exception:
                pass
        comments = {"comment_locator": locator, "comment_count_status": "failed"}
        try:
            comments["source_comment_count"] = await fetch_comment_count(self.client, locator)
            comments["comment_count_status"] = "observed"
        except Exception:
            pass
        # 网页计数不回退冒充独立计数读取成功；两项信号可各自失败。
        if metadata is not None:
            metadata.pop("source_comment_count", None)
        return await to_thread.run_sync(lambda: self.store.record_check(
            uid, id, metadata, self.clock.now(), error, comment_observation=comments))

    async def execute_pending(self):
        """一次领取遍历；失败留待下一节拍，不在本轮无限重试。"""
        targets = await to_thread.run_sync(self.store.pending_checks)
        pending = iter(targets)

        async def worker():
            for target in pending:
                await self._execute_target(target)

        await asyncio.gather(*(worker() for _ in range(min(self.max_syncs, len(targets)))))

    async def _execute_target(self, target):
        uid, id = target["uid"], target["id"]
        claim = await to_thread.run_sync(self.store.claim_check_work, uid, id)
        if claim is None:
            return
        succeeded = False
        try:
            generation = await to_thread.run_sync(self.store.claim_archive, uid, id)
            if generation is not None:
                text_succeeded = await sync_target(
                    self.store, self.client, uid, id, generation, self.downloader, self.uploader,
                    pending_comments_only=True, comment_observation=claim["observed"], now=self.clock.now)
                archive = await to_thread.run_sync(self.store.read_archive, id)
                succeeded = (text_succeeded and all(value == "success" for value in archive["work"].values())
                             and archive["synced_version"] == claim["observed"].get("observed_version")
                             and archive["synced_comment_count"] == claim["observed"].get("source_comment_count"))
                for root_id in await to_thread.run_sync(self.store.media_root_ids, id):
                    root = await to_thread.run_sync(self.store.read_media_owner, id, root_id)
                    succeeded = succeeded and root["work"]["media"] == "success"
        except Exception:
            # 不记录上游原文、路径或 SDK 异常；取消保留 running 供重启恢复。
            pass
        await to_thread.run_sync(
            lambda: self.store.finish_check_work(uid, id, claim["revision"], succeeded, self.clock.now(),
                                               None if succeeded else "SYNC_INCOMPLETE", token=claim["token"]))

    async def run(self):
        """从启动时刻起固定节拍；有限并发、忙即跳过，没有检查队列。"""
        configure_safe_logging()
        with collector_lock(self.store.path):
            await to_thread.run_sync(self.store.migrate)
            await to_thread.run_sync(self.store.recover_check_work)
            await to_thread.run_sync(self.store.recover_discoveries, self.clock.now())
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
                    targets = await to_thread.run_sync(self.store.enabled_targets)
                    if targets:
                        offset %= len(targets)
                        ordered = targets[offset:] + targets[:offset]
                        launched = 0
                        for target in ordered:
                            key = (target["uid"], target["id"])
                            if key not in checks and len(checks) < self.max_checks:
                                checks[key] = asyncio.create_task(self.check_once(*key))
                                launched += 1
                        offset = (offset + max(1, launched)) % len(targets)
                    pending = await to_thread.run_sync(self.store.pending_checks)
                    if pending:
                        sync_offset %= len(pending)
                        launched = 0
                        for target in pending[sync_offset:] + pending[:sync_offset]:
                            key = (target["uid"], target["id"])
                            if key not in executions and len(executions) < self.max_syncs:
                                executions[key] = asyncio.create_task(self._execute_target(target))
                                launched += 1
                        sync_offset = (sync_offset + max(1, launched)) % len(pending)
                    deadline += CADENCE_SECONDS
                    # 进程/事件循环停顿越过节拍时跳过错过的槽，绝不补发积压。
                    now = self.clock.monotonic()
                    if deadline < now:
                        deadline += (int((now - deadline) // CADENCE_SECONDS) + 1) * CADENCE_SECONDS
                    await self.clock.sleep(max(0, deadline - now))
            finally:
                tasks = list(checks.values()) + list(executions.values()) + list(discoveries.values())
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)


async def serve(database, *, once=False):
    configure_safe_logging()
    uploader = OSSUploader.from_environment()
    try:
        async with httpx.AsyncClient(timeout=10, trust_env=False) as source_client, httpx.AsyncClient(
            timeout=30, trust_env=False
        ) as media_client:
            collector = Collector(Store(database), source_client, ImageDownloader(media_client), uploader)
            if once:
                with collector_lock(database):
                    await to_thread.run_sync(collector.store.migrate)
                    for target in await to_thread.run_sync(collector.store.enabled_targets):
                        await collector.check_once(target["uid"], target["id"])
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
