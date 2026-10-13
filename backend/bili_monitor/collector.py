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

from .source import fetch_page, page_metadata
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
    def __init__(self, store, client, downloader=None, uploader=None, *, clock=None, max_checks=4):
        if max_checks < 1:
            raise ValueError("Invalid check concurrency")
        self.store = store
        self.client = client
        self.downloader = downloader
        self.uploader = uploader
        self.clock = clock or SystemClock()
        self.max_checks = max_checks

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
        return await to_thread.run_sync(self.store.record_check, uid, id, metadata, self.clock.now(), error)

    async def execute_pending(self):
        """一次领取遍历；失败留待下一节拍，不在本轮无限重试。"""
        targets = await to_thread.run_sync(self.store.pending_checks)
        for target in targets:
            uid, id = target["uid"], target["id"]
            claim = await to_thread.run_sync(self.store.claim_check_work, uid, id)
            if claim is None:
                continue
            succeeded = False
            try:
                generation = await to_thread.run_sync(self.store.claim_archive, uid, id)
                if generation is not None:
                    text_succeeded = await sync_target(
                        self.store, self.client, uid, id, generation, self.downloader, self.uploader)
                    archive = await to_thread.run_sync(self.store.read_archive, id)
                    succeeded = (text_succeeded and all(value == "success" for value in archive["work"].values())
                                 and archive["synced_version"] == claim["observed"].get("observed_version"))
                    for root_id in await to_thread.run_sync(self.store.media_root_ids, id):
                        root = await to_thread.run_sync(self.store.read_media_owner, id, root_id)
                        succeeded = succeeded and root["work"]["media"] == "success"
            except Exception:
                # 不记录上游原文、路径或 SDK 异常；取消保留 running 供重启恢复。
                pass
            await to_thread.run_sync(self.store.finish_check_work, uid, id, claim["revision"],
                                     succeeded, self.clock.now(), None if succeeded else "SYNC_INCOMPLETE")

    async def run(self):
        """从启动时刻起固定节拍；有限并发、忙即跳过，没有检查队列。"""
        configure_safe_logging()
        with collector_lock(self.store.path):
            await to_thread.run_sync(self.store.migrate)
            await to_thread.run_sync(self.store.recover_check_work)
            checks, execution = {}, None
            offset = 0
            deadline = self.clock.monotonic()
            try:
                while True:
                    for key, task in list(checks.items()):
                        if task.done():
                            task.result()
                            del checks[key]
                    if execution is not None and execution.done():
                        execution.result()
                        execution = None
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
                    if execution is None:
                        execution = asyncio.create_task(self.execute_pending())
                    deadline += CADENCE_SECONDS
                    # 进程/事件循环停顿越过节拍时跳过错过的槽，绝不补发积压。
                    now = self.clock.monotonic()
                    if deadline < now:
                        deadline += (int((now - deadline) // CADENCE_SECONDS) + 1) * CADENCE_SECONDS
                    await self.clock.sleep(max(0, deadline - now))
            finally:
                tasks = list(checks.values()) + ([execution] if execution is not None else [])
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
    parser.add_argument("--once", action="store_true", help="Record one check pass without executing sync")
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
