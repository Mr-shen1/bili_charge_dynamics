"""真实通知进程的跨进程装配：本机受控 HTTP 接收端 + 真实子进程 + 临时 SQLite。

进程内的 `httpx.MockTransport` 不能冒充可跨进程的外部服务：这里用
`ThreadingHTTPServer` 监听环回端口，由真实通知子进程发起 HTTP，测试只控制
「阻塞/放行/响应内容」与进程生命周期（启动、正常停止、真实 kill）。
凭据与身份全部是虚构值，不读取真实配置，也不访问真实飞书。
"""

import asyncio
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from backend.tests.collector_support import configured
from backend.tests.management_support import UID
from backend.tests.notification_support import DYNAMIC, Source, deliveries, events

ROOT = Path(__file__).resolve().parents[2]
HOOK = "/open-apis/bot/v2/hook/"


class FeishuStub:
    """本机 HTTP 接收端：记录真实收到的请求，按路径阻塞或返回业务响应。

    - 默认立即返回官方业务成功 `{"code": 0, "msg": "success"}`。
    - `block(path)` 后该路径的响应挂起，直到 `release(path)`；用来观察“外部请求
      进行中”时的数据库行为，以及在这段时间内 kill 掉通知进程。
    - `respond(path, ...)` 可改成 429/业务失败等固定响应。
    """

    def __init__(self):
        self.requests = []
        self._lock = threading.Lock()
        self._entered = {}
        self._released = {}
        self._responses = {}
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("content-length", 0))
                raw = self.rfile.read(length)
                path = self.path
                with stub._lock:
                    stub.requests.append({"path": path, "payload": json.loads(raw)})
                    entered = stub._entered.setdefault(path, threading.Event())
                    released = stub._released.get(path)
                    if released is None:
                        released = stub._released[path] = threading.Event()
                        released.set()
                    status, body = stub._responses.get(path, (200, {"code": 0, "msg": "success"}))
                entered.set()
                released.wait(timeout=30)
                data = json.dumps(body).encode()
                try:
                    self.send_response(status)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # 通知进程被杀掉时接收端仍在；写入失败不影响断言。

            def log_message(self, *arguments):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self):
        return self.url_for("fake-process")

    def url_for(self, token):
        return f"http://127.0.0.1:{self.server.server_address[1]}{HOOK}{token}"

    def path_for(self, token):
        return HOOK + token

    def count(self, token):
        with self._lock:
            return sum(1 for request in self.requests if request["path"] == self.path_for(token))

    def payloads(self, token):
        with self._lock:
            return [request["payload"] for request in self.requests if request["path"] == self.path_for(token)]

    def entered(self, token):
        with self._lock:
            return self._entered.setdefault(self.path_for(token), threading.Event())

    def block(self, token):
        with self._lock:
            event = threading.Event()
            self._released[self.path_for(token)] = event
        return event

    def release(self, token):
        with self._lock:
            self._released.setdefault(self.path_for(token), threading.Event()).set()

    def respond(self, token, status=200, body=None):
        with self._lock:
            self._responses[self.path_for(token)] = (
                status, {"code": 0, "msg": "success"} if body is None else body)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *error):
        self.release_all()
        self.server.shutdown()
        self.server.server_close()

    def release_all(self):
        with self._lock:
            for event in self._released.values():
                event.set()


class NotifierProcess:
    """真实通知进程：生产入口 `python -m backend.bili_monitor.notifier`。"""

    def __init__(self, directory, database, config, **environment):
        self.log = directory / f"notifier-{len(list(directory.glob('notifier-*.log')))}.log"
        values = {name: value for name, value in os.environ.items() if not name.startswith("BILI_")}
        values.update({
            "BILI_DATABASE_PATH": str(database),
            "BILI_NOTIFICATION_CONFIG": str(config),
            "PYTHONUNBUFFERED": "1",
            **{name: str(value) for name, value in environment.items()},
        })
        with self.log.open("wb") as output:
            self.handle = subprocess.Popen(
                [sys.executable, "-m", "backend.bili_monitor.notifier"], cwd=ROOT, env=values,
                stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)

    @property
    def text(self):
        return self.log.read_text()

    @property
    def running(self):
        return self.handle.poll() is None

    def stop(self):
        if self.running:
            self.handle.terminate()
            try:
                self.handle.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.handle.kill()
                self.handle.wait(timeout=5)

    def kill(self):
        """真实强杀（SIGKILL）：不执行任何回写，模拟进程中断。"""
        if self.running:
            self.handle.kill()
            self.handle.wait(timeout=10)

    def __enter__(self):
        return self

    def __exit__(self, *error):
        self.stop()


def wait_for(predicate, process=None, *, timeout=20, description=""):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process is not None and not process.running:
            pytest.fail(f"通知进程提前退出：{process.text}")
        if predicate():
            return
        time.sleep(0.05)
    pytest.fail(f"等待超时：{description}\n{process.text if process is not None else ''}")


BUSINESS_KINDS = ("dynamic_changed", "root_comment", "reply_comment")


def business_deliveries(path):
    """只取业务事件（动态变化/一级评论/回复）的投递记录。

    真通知进程在北京时间第 40 分钟会生成一条**合法心跳**（系统群，缺系统路由时为
    `waiting_config`）。进程级用例观测的是业务结果，不能只在“这一分钟不是 :40”时才
    通过；生产时钟不因此增加测试开关，只把观测按业务身份收窄。
    """
    return [row for row in deliveries(path) if row["kind"] in BUSINESS_KINDS]


def business_events(path):
    """只取业务事件；心跳与系统告警是独立的系统事件，另有用例专门断言。"""
    return [row for row in events(path) if row["kind"] in BUSINESS_KINDS]


def archive_change(path):
    """基线 v1 静默，v2 的正文成功归档后留下待投递事件。"""
    configured(path)
    source = Source("v1")

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            source.page = "v2"
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()

    asyncio.run(run())
    assert [row["state"] for row in deliveries(path)] == ["pending"]


def run_python(arguments, **environment):
    """在独立子进程里执行一段真实 Python（用于“另一路数据库提交”）。"""
    values = {name: value for name, value in os.environ.items() if not name.startswith("BILI_")}
    values.update({name: str(value) for name, value in environment.items()})
    return subprocess.run([sys.executable, *arguments], cwd=ROOT, env=values,
                          capture_output=True, text=True, timeout=60)
