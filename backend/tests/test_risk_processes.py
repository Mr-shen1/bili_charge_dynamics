"""03：真实双进程、同一临时 SQLite 与上游账本证明跨进程暂停。"""

import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import httpx
import pytest


ROOT = Path(__file__).resolve().parents[2]
BASE = "/api/manage/ups/202"
TARGETS = BASE + "/targets"
RISK = "/api/manage/risk"
DYNAMIC = "91001"


class Deployment:
    """生产 API＋采集入口、真实临时 SQLite；只把外部来源换成本地虚构实现。"""

    def __init__(self, directory):
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)
        self.database = directory / "risk.sqlite"
        self.control = directory / "control"
        self.control.mkdir()
        self.environment = {
            name: value for name, value in os.environ.items()
            if not name.startswith(("BILI_", "RISK_FIXTURE_", "UVICORN_"))
            and name != "WEB_CONCURRENCY"
        }
        self.environment.update({
            "BILI_DATABASE_PATH": str(self.database),
            "RISK_FIXTURE_DIR": str(self.control),
            "PYTHONUNBUFFERED": "1",
            "BILI_COLLECTOR_CADENCE_SECONDS": "1",
            "BILI_COLLECTOR_PAGE_CHECK_SECONDS": "0",
        })
        self.processes, self.logs, self.client, self.api = [], [], None, None

    def spawn(self, role, *arguments):
        log = self.directory / f"{role}-{len(self.processes)}.log"
        environment = {**self.environment, "RISK_FIXTURE_ROLE": role}
        with log.open("wb") as output:
            process = subprocess.Popen(
                [sys.executable, *arguments], cwd=ROOT, env=environment,
                stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
            )
        self.processes.append(process)
        self.logs.append(log)
        return process

    def start_api(self):
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        self.api = self.spawn(
            "api", "-m", "uvicorn", "backend.tests.risk_fixture:create_app", "--factory",
            "--host", "127.0.0.1", "--port", str(port),
        )
        self.client = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=5, trust_env=False)
        self.wait(lambda: self.client.get("/api/manage/ups").status_code == 200)
        return self.api

    def start_collector(self):
        return self.spawn("collector", "-m", "backend.tests.risk_fixture", "--database", str(self.database))

    def configure(self):
        assert self.client.post("/api/manage/ups", json={"uid": "202"}).status_code == 201
        assert self.client.patch(BASE + "/monitor", json={
            "mode": "specified", "recent_n": 10, "enabled": True}).status_code == 200
        assert self.client.post(TARGETS, json={"id": DYNAMIC}).status_code == 201

    def ledger(self, role=None):
        path = self.control / "ledger.txt"
        if not path.exists():
            return []
        lines = [line.split() for line in path.read_text().splitlines() if line.strip()]
        return [tuple(line) for line in lines if role is None or line[0] == role]

    def arm(self, value=True):
        target = self.control / "risk.arm"
        if value:
            target.touch()
        elif target.exists():
            target.unlink()

    def wait(self, predicate, *, process=None, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if process is not None and process.poll() is not None:
                pytest.fail(f"Child exited with {process.returncode}: {self.log_text()}")
            try:
                result = predicate()
                if result:
                    return result
            except httpx.TransportError:
                pass
            time.sleep(0.05)
        pytest.fail(f"Timed out waiting for deployment: {self.log_text()}")

    def log_text(self):
        return "\n".join(path.read_text() for path in self.logs)

    def stop(self, process):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    def stop_api(self):
        self.client.close()
        self.client = None
        self.stop(self.api)

    def close(self):
        if self.client is not None:
            self.client.close()
        for process in reversed(self.processes):
            self.stop(process)


@pytest.fixture
def deployment(tmp_path):
    instance = Deployment(tmp_path / "risk-process")
    try:
        yield instance
    finally:
        instance.close()


def test_one_process_trigger_stops_the_other_process_and_survives_reopen(deployment):
    deployment.start_api()
    deployment.configure()
    collector = deployment.start_collector()

    # 采集进程确实在持续发送（检查＋归档链），否则「停止发送」没有意义。
    deployment.wait(lambda: len(deployment.ledger("collector")) >= 3, process=collector)
    assert {kind for _, kind in deployment.ledger("collector")} & {"opus_page", "detail", "root_comments"}
    # 对照：暂停前的同一个采集进程在持续发送，因此「停止发送」不是无工作可做。
    running = len(deployment.ledger("collector"))
    time.sleep(2)
    assert len(deployment.ledger("collector")) > running

    # API 进程触发 412：来源只对 API 角色返回 412，采集侧仍可用。
    deployment.arm()
    triggered = deployment.client.post(TARGETS, json={"id": DYNAMIC})
    assert (triggered.status_code, triggered.json()["error"]["code"]) == (503, "SOURCE_RISK_PAUSED")
    status = deployment.client.get(RISK).json()
    assert status["state"] == "cooldown" and status["backoff_step"] == 1
    assert status["last_trigger"]["endpoint_type"] == "opus_page"
    assert status["last_trigger"]["http_status"] == 412

    # 来源恢复为「任何角色都 200」：若采集进程还在发，账本就会增长。
    deployment.arm(False)
    settled = len(deployment.ledger("collector"))
    time.sleep(3)  # 至少三个 1 秒节拍
    assert len(deployment.ledger("collector")) == settled
    api_sends = len(deployment.ledger("api"))
    assert deployment.client.post(TARGETS, json={"id": DYNAMIC}).status_code == 503
    assert len(deployment.ledger("api")) == api_sends

    # 被保护暂停不是失败：另一进程没有新增来源失败或伪造成功时间。
    checks = deployment.client.get(BASE + "/checks").json()["checks"]
    assert all(item["check_error"] is None and item["sync_error"] is None for item in checks)
    log = deployment.log_text()
    assert log.count("collector_paused") == 1
    assert "source_risk_triggered" in log

    # 重开：同库重启 API，剩余期限与档位不清零；新采集进程同样不再发送。
    next_probe_at = status["next_probe_at"]
    deployment.stop_api()
    deployment.stop(collector)
    deployment.start_api()
    reopened = deployment.client.get(RISK).json()
    assert reopened["state"] == "cooldown"
    assert reopened["next_probe_at"] == next_probe_at
    blocked = deployment.client.post("/api/sync/initial", json={"uid": "202"})
    assert blocked.status_code == 503
    assert 1 <= int(blocked.headers["Retry-After"]) <= 60
    assert blocked.json()["error"]["next_probe_at"] == next_probe_at

    restarted = deployment.start_collector()
    time.sleep(3)
    assert len(deployment.ledger("collector")) == settled
    assert restarted.poll() is None
    # 新进程从同一份持久状态读到暂停，自己也不发送。
    assert "collector_paused" in deployment.logs[-1].read_text()
