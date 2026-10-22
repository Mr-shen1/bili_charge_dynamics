"""统一托管单 API 与独立 collector，共享配置并按顺序启停。"""

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


def stop_process(process):
    if process is not None and process.pid is not None:
        if process.is_alive():
            process.terminate()
        # 等待 collector 清理在途工作后，再停 API；不强杀或删锁文件。
        process.join()
        process.close()


def serve(database, host, port):
    database = str(Path(database).expanduser().resolve())
    # spawn 子进程继承同一绝对数据库路径、Cookie 文件路径及 OSS 环境。
    os.environ["BILI_DATABASE_PATH"] = database
    os.environ.pop("WEB_CONCURRENCY", None)
    context = multiprocessing.get_context("spawn")
    ready = context.Event()
    stopped = threading.Event()
    previous_handlers = {}
    api = collector = None

    def stop(signum, frame):
        stopped.set()

    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[signum] = signal.signal(signum, stop)
        api = context.Process(target=run_api, args=(database, host, port, ready), name="bili-api")
        api.start()
        deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
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
        collector = context.Process(target=run_collector, args=(database,), name="bili-collector")
        collector.start()
        while not stopped.wait(0.2):
            # 任一子进程退出都停止另一进程，让外部托管明确感知故障。
            if not api.is_alive() or not collector.is_alive():
                raise RuntimeError("Backend process exited")
    finally:
        try:
            stop_process(collector)
        finally:
            try:
                stop_process(api)
            finally:
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
