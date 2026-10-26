"""统一托管单 API、独立 collector 与独立通知进程，共享配置并按顺序启停。"""

import argparse
import asyncio
import multiprocessing
import os
from pathlib import Path
import signal
import threading
import time


STARTUP_TIMEOUT_SECONDS = 30


def run_api(database, host, port, ready):
    try:
        import uvicorn
        from .app import create_app

        async def serve():
            server = uvicorn.Server(uvicorn.Config(
                create_app(database), host=host, port=port, workers=1, access_log=False,
            ))
            task = asyncio.create_task(server.serve())
            try:
                # Uvicorn 完成 lifespan 迁移并成功监听后才启动采集进程。
                while not task.done() and not server.started:
                    await asyncio.sleep(0.05)
                if server.started:
                    ready.set()
                await task
            finally:
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)

        asyncio.run(serve())
    except KeyboardInterrupt:
        pass
    except Exception:
        raise SystemExit("API failed") from None


def run_collector(database):
    try:
        from .collector import serve
        asyncio.run(serve(database))
    except KeyboardInterrupt:
        pass
    except Exception:
        raise SystemExit("Collector failed") from None


def run_notifier(database, config):
    """第三个子进程：仍是生产 `backend.bili_monitor.notifier` 入口，不把定时器放进 API。

    通知进程自己持有 `.notifier.lock` 并在启动时执行可重入迁移，因此重复实例直接
    以固定错误退出，不靠托管层去重。
    """
    try:
        from .notifications.config import NotificationConfig
        from .notifier import limiter_from_environment, serve as notifier_serve
        asyncio.run(notifier_serve(database, NotificationConfig.load(config),
                                  limiter=limiter_from_environment()))
    except KeyboardInterrupt:
        pass
    except Exception:
        raise SystemExit("Notifier failed") from None


def stop_process(process):
    if process is not None and process.pid is not None:
        if process.is_alive():
            process.terminate()
        # 等待子进程清理在途工作后再退出；不强杀或删锁文件。
        process.join()
        process.close()


def serve(database, host, port, *, context=None, startup_timeout=STARTUP_TIMEOUT_SECONDS):
    database = str(Path(database).expanduser().resolve())
    # spawn 子进程继承同一绝对数据库路径、Cookie 文件路径及 OSS 环境。
    os.environ["BILI_DATABASE_PATH"] = database
    os.environ.pop("WEB_CONCURRENCY", None)
    context = context or multiprocessing.get_context("spawn")
    ready = context.Event()
    stopped = threading.Event()
    previous_handlers = {}
    api = collector = notifier = None
    children = []

    def stop(signum, frame):
        stopped.set()

    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[signum] = signal.signal(signum, stop)
        api = context.Process(target=run_api, args=(database, host, port, ready), name="bili-api")
        api.start()
        children.append(api)
        deadline = time.monotonic() + startup_timeout
        while not stopped.is_set():
            if not api.is_alive():
                raise RuntimeError("API startup failed")
            if ready.is_set():
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("API startup timed out")
            stopped.wait(0.1)
        if stopped.is_set():
            return
        # 迁移由 API 的 lifespan 先完成；collector 与通知进程再启动，各自仍会执行可重入迁移。
        collector = context.Process(target=run_collector, args=(database,), name="bili-collector")
        collector.start()
        children.append(collector)
        notification_config = os.environ.get("BILI_NOTIFICATION_CONFIG")
        if notification_config:
            notifier = context.Process(target=run_notifier, args=(database, notification_config),
                                       name="bili-notifier")
            notifier.start()
            children.append(notifier)
        while not stopped.wait(0.2):
            # 任一子进程退出都停止其他进程，让外部托管明确感知故障。
            if not all(process.is_alive() for process in children):
                raise RuntimeError("Backend process exited")
    finally:
        # 先停通知进程（不再发起外部投递），再等 collector 清完在途工作，最后停 API。
        for process in reversed(children):
            try:
                stop_process(process)
            except Exception:
                pass
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


def main():
    parser = argparse.ArgumentParser(description="Single API and independent collector")
    parser.add_argument("--database", default=os.environ.get("BILI_DATABASE_PATH", "backend/data/monitor.sqlite"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    try:
        serve(args.database, args.host, args.port)
    except Exception:
        # 不输出路径、凭据、上游异常或原始 traceback。
        raise SystemExit("Backend service failed") from None


if __name__ == "__main__":
    main()
