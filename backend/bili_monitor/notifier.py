"""独立通知进程：单实例领取发件箱并按索引投递，默认每秒一轮。

    export BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite
    export BILI_NOTIFICATION_CONFIG=/srv/bili-monitor/notifications.json
    exec .venv/bin/python -m backend.bili_monitor.notifier

API 与 collector 不内嵌通知定时器；飞书请求不进入数据库事务。
"""

import argparse
import asyncio
import fcntl
import os
import signal
from contextlib import contextmanager
from pathlib import Path

from .notifications import Dispatcher, NotificationConfig, NotificationConfigError
from .notifications.config import ENVIRONMENT_PATH
from .notifications.log import notifier_event
from .safety import configure_safe_logging
from .storage import Store


@contextmanager
def notifier_lock(path):
    """同一数据库只运行一个投递进程；退出/崩溃由内核释放，不靠过期租约。"""
    lock_path = str(Path(path).resolve()) + ".notifier.lock"
    Path(lock_path).parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Notifier already running") from None
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


async def serve(database, config, *, transport=None, poll_seconds=None, once=False):
    store = Store(database)
    configure_safe_logging()
    with notifier_lock(store.path):
        store.migrate()
        options = {} if poll_seconds is None else {"poll_seconds": poll_seconds}
        dispatcher = Dispatcher(store, config, transport=transport, **options)
        notifier_event("notifier_started", destinations=len(config.destinations))
        try:
            if once:
                await dispatcher.run_once()
            else:
                await dispatcher.run()
        finally:
            await dispatcher.aclose()


def main():
    parser = argparse.ArgumentParser(description="Independent Feishu notification process")
    parser.add_argument("--database", default=os.environ.get("BILI_DATABASE_PATH"))
    parser.add_argument("--config", default=os.environ.get(ENVIRONMENT_PATH))
    parser.add_argument("--once", action="store_true", help="dispatch one due batch and exit")
    arguments = parser.parse_args()
    if not arguments.database:
        raise SystemExit("BILI_DATABASE_PATH is required")
    if not arguments.config:
        raise SystemExit("BILI_NOTIFICATION_CONFIG is required")
    try:
        config = NotificationConfig.load(arguments.config)
    except NotificationConfigError as error:
        raise SystemExit(str(error)) from None

    async def run():
        task = asyncio.create_task(serve(arguments.database, config, once=arguments.once))
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

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    except RuntimeError as error:
        raise SystemExit(str(error)) from None


if __name__ == "__main__":
    main()
