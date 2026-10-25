"""01：真实通知进程 + 本机受控飞书接收端 + 临时 SQLite。

进程使用生产入口 `python -m backend.bili_monitor.notifier`，事件由真实采集/归档
写入；只把飞书地址替换成本机替身，凭据全部是虚构值。
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
from backend.tests.notification_support import (
    BASE_URL, DYNAMIC, Source, deliveries, events, message_text, write_config,
)

ROOT = Path(__file__).resolve().parents[2]


class FeishuStub:
    """本机 HTTP 接收端：记录真实收到的请求，按脚本返回业务响应。"""

    def __init__(self):
        self.requests = []
        self.lock = threading.Lock()
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("content-length", 0))
                raw = self.rfile.read(length)
                with stub.lock:
                    stub.requests.append({"path": self.path, "payload": json.loads(raw)})
                    payload = {"code": 0, "msg": "success"}
                body = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *arguments):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/open-apis/bot/v2/hook/fake-process"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *error):
        self.server.shutdown()
        self.server.server_close()


class Notifier:
    def __init__(self, directory, database, config):
        self.log = directory / f"notifier-{len(list(directory.glob('notifier-*.log')))}.log"
        environment = {name: value for name, value in os.environ.items() if not name.startswith("BILI_")}
        environment.update({
            "BILI_DATABASE_PATH": str(database),
            "BILI_NOTIFICATION_CONFIG": str(config),
            "PYTHONUNBUFFERED": "1",
        })
        with self.log.open("wb") as output:
            self.handle = subprocess.Popen(
                [sys.executable, "-m", "backend.bili_monitor.notifier"], cwd=ROOT, env=environment,
                stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)

    @property
    def text(self):
        return self.log.read_text()

    def stop(self):
        if self.handle.poll() is None:
            self.handle.terminate()
            try:
                self.handle.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.handle.kill()
                self.handle.wait(timeout=5)

    def __enter__(self):
        return self

    def __exit__(self, *error):
        self.stop()


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
    assert deliveries(path)[0]["state"] == "pending"


def wait(predicate, notifier, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if notifier.handle.poll() is not None:
            pytest.fail(f"通知进程提前退出：{notifier.text}")
        if predicate():
            return
        time.sleep(0.05)
    pytest.fail(f"等待超时：{notifier.text}")


def test_notification_process_delivers_once_and_survives_restart(tmp_path):
    path = tmp_path / "monitor.sqlite"
    archive_change(path)
    config_path = write_config(tmp_path / "notifications.json")
    with FeishuStub() as stub:
        write_config(tmp_path / "notifications.json", up=stub.url)
        with Notifier(tmp_path, path, config_path) as notifier:
            wait(lambda: len(stub.requests) == 1, notifier)
            wait(lambda: deliveries(path)[0]["state"] == "sent", notifier)
            request = stub.requests[0]
            assert request["path"] == "/open-apis/bot/v2/hook/fake-process"
            assert message_text(request["payload"]).splitlines() == [
                "动态【123】发生变化", f"链接：查看动态"]
            link = request["payload"]["content"]["post"]["zh_cn"]["content"][1][1]
            assert link["href"] == f"{BASE_URL}/dynamics/{DYNAMIC}"
            # 只允许一个投递实例：第二个进程必须退出。
            duplicate = Notifier(tmp_path, path, config_path)
            duplicate.handle.wait(timeout=20)
            assert duplicate.handle.returncode != 0
            assert "Notifier already running" in duplicate.text
            first_log = notifier.text
        # 进程重启不重复投递，也不改写成功状态。
        with Notifier(tmp_path, path, config_path) as restarted:
            time.sleep(2.5)
            assert len(stub.requests) == 1
            assert deliveries(path)[0]["state"] == "sent"
            assert "delivery_sent" not in restarted.text
        assert notifier_log_redacted(first_log, stub.url)
        # 真实进程也按墙钟登记小时心跳（本文件没有系统群路由，故只留待配置记录）；
        # 事件数只对业务类型断言，避免结果依赖测试运行时刻。
        assert len([event for event in events(path) if event["kind"] == "dynamic_changed"]) == 1
        saved = json.dumps(deliveries(path), ensure_ascii=False)
        assert "fake-process" not in saved


def notifier_log_redacted(text, webhook):
    token = webhook.rsplit("/", 1)[-1]
    assert "delivery_sent" in text
    return token not in text and "open-apis" not in text


def test_process_keeps_message_waiting_for_missing_route_then_delivers(tmp_path):
    path = tmp_path / "monitor.sqlite"
    archive_change(path)
    config_path = write_config(tmp_path / "notifications.json", up=None)
    with FeishuStub() as stub:
        with Notifier(tmp_path, path, config_path) as notifier:
            wait(lambda: deliveries(path)[0]["state"] == "waiting_config", notifier)
            assert stub.requests == []
        assert deliveries(path)[0]["attempts"] == 1
        # 修复服务端配置后重启通知进程：保留原记录并补发，不重设阶段。
        write_config(tmp_path / "notifications.json", up=stub.url)
        with Notifier(tmp_path, path, config_path) as repaired:
            wait(lambda: len(stub.requests) == 1, repaired)
            wait(lambda: deliveries(path)[0]["state"] == "sent", repaired)
        assert len([event for event in events(path) if event["kind"] == "dynamic_changed"]) == 1
