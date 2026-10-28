"""08：真实独立 API 与 collector 共用临时 SQLite 的串行发送与页后等待账本。"""

import asyncio
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from backend.tests.fair_serial_fixture import FixtureSource, REPLY_PAGES, UIDS


ROOT = Path(__file__).resolve().parents[2]
CHECKS = "/api/manage/ups/{uid}/checks"


class Processes:
    def __init__(self, directory):
        self.directory = directory
        self.database = directory / "fair.sqlite"
        self.control = directory / "control"
        self.control.mkdir()
        self.environment = {
            name: value for name, value in os.environ.items()
            if not name.startswith(("BILI_", "FAIR_SERIAL_", "UVICORN_"))
        }
        self.environment.update({
            "BILI_DATABASE_PATH": str(self.database),
            "FAIR_SERIAL_DIR": str(self.control),
            "PYTHONUNBUFFERED": "1",
        })
        self.processes, self.logs = [], []

    def spawn(self, *arguments):
        log = self.directory / f"process-{len(self.processes)}.log"
        with log.open("wb") as output:
            process = subprocess.Popen(
                [sys.executable, *arguments], cwd=ROOT, env=self.environment,
                stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)
        self.processes.append(process)
        self.logs.append(log)
        return process

    def start_api(self):
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        process = self.spawn("-m", "uvicorn", "backend.tests.fair_serial_fixture:create_app",
                             "--factory", "--host", "127.0.0.1", "--port", str(port))
        client = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=60, trust_env=False)
        self.wait(lambda: client.get("/api/manage/ups").status_code == 200, process=process)
        return client, process

    def start_collector(self):
        return self.spawn("-m", "backend.tests.fair_serial_fixture", "--database",
                          str(self.database), "--role", "collector")

    def wait(self, predicate, *, process=None, timeout=40):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if process is not None and process.poll() is not None:
                pytest.fail(f"Child exited with {process.returncode}: {self.log()}")
            try:
                if predicate():
                    return
            except (httpx.TransportError, OSError):
                pass
            time.sleep(0.02)
        pytest.fail(f"Timed out waiting for fair serial processes: {self.log()}")

    def log(self):
        return "\n".join(path.read_text() for path in self.logs)

    def stop(self, process):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    def close(self):
        for process in reversed(self.processes):
            self.stop(process)


def prepare(path):
    store = Store(path)
    store.migrate()
    source = FixtureSource(wait_gate=False)

    async def checks():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(store, client)
            for uid, dynamic in UIDS.items():
                collector.store.add(uid, f"虚构公平作者{uid}", "https://example.invalid/a.png")
                collector.store.update(uid, "specified", 10, True)
                collector.store.add_target(uid, dynamic)
                assert await collector.check_once(uid, dynamic)

    asyncio.run(checks())
    return store


def ledger(control):
    path = control / "ledger.txt"
    if not path.exists():
        return []
    return [line.split() for line in path.read_text().splitlines() if line.strip()]


@pytest.fixture
def processes(tmp_path):
    instance = Processes(tmp_path)
    prepare(instance.database)
    try:
        yield instance
    finally:
        instance.close()


def test_api_and_collector_share_one_source_permit_and_page_wait_across_processes(processes):
    client, api_process = processes.start_api()
    collector = processes.start_collector()
    response = {}

    def sync():
        try:
            response["result"] = client.post("/api/sync/initial", json={"uid": "301"})
        finally:
            response["done"] = True

    worker = threading.Thread(target=sync)
    worker.start()
    try:
        processes.wait(lambda: (processes.control / "waiting").exists(), process=api_process)
        (processes.control / "start.gate").touch()
        worker.join(timeout=45)
        assert not worker.is_alive(), processes.log()
        assert "result" in response, processes.log()
        assert response["result"].status_code == 200
        assert response["result"].json()["processed"] == 1
        deadline = time.monotonic() + 45
        while collector.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        assert collector.poll() is not None, processes.log()
    finally:
        worker.join(timeout=1)
        client.close()
        processes.stop(api_process)

    rows = ledger(processes.control)
    assert {row[0] for row in rows} >= {"api", "collector"}
    assert any(row[0] == "api" and row[1] == "replies" for row in rows)
    assert any(row[0] == "collector" and row[1] == "replies" for row in rows)
    # 目标互斥：API 的显式初始化只处理 UP 301；collector 不重复执行同一目标。
    assert not any(row[0] == "collector" and row[5] == "92001" for row in rows)
    assert not any(row[0] == "api" and row[5] == "92002" for row in rows)

    # 跨进程没有并发发送：同一时刻只允许一个 send 未完成。
    outstanding = None
    last_done_reply = None
    for row in rows:
        role, kind, page, phase, stamp, oid = row[0], row[1], row[2], row[3], float(row[4]), row[5]
        if phase == "send":
            assert outstanding is None, f"concurrent source send: {rows}"
            outstanding = (role, kind, page, stamp)
            if last_done_reply is not None:
                assert stamp >= last_done_reply + 0.095, (last_done_reply, stamp)
        else:
            assert outstanding is not None
            assert (outstanding[0], outstanding[1], outstanding[2]) == (role, kind, page)
            outstanding = None
            if kind == "replies":
                last_done_reply = stamp
    assert outstanding is None

    store = Store(processes.database)
    for uid, dynamic in UIDS.items():
        archive = store.read_archive(dynamic)
        assert archive["author"]["id"] == uid
        actual = (archive["synced_comment_count"], archive["synced_reply_comment_count"],
                  archive["local_reply_count"], archive["source_comment_count"],
                  archive["synced_root_comment_count"], archive["work"])
        assert actual == (600, 600, 600, 600, 600, {
            "text": "success", "media": "success", "comments": "success", "replies": "success"}), actual
        assert archive["work"]["comments"] == archive["work"]["replies"] == "success"
