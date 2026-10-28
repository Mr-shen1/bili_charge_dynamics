"""04：真实多进程下的探测唯一 owner、租约接管与采集进程自动恢复。"""

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import httpx
import pytest

from backend.bili_monitor.risk import RiskGate
from backend.bili_monitor.storage import Store
from backend.tests.risk_probe_fixture import FileClock


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = "backend.tests.risk_probe_fixture"
UID = "202"
DYNAMIC = "91001"
BASE = f"/api/manage/ups/{UID}"
CLOCK_BASE = 1_800_000_000


class Deployment:
    """生产 API／采集入口、真实临时 SQLite 与共享文件时钟；只替换外部来源。"""

    def __init__(self, directory):
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)
        self.database = directory / "risk.sqlite"
        self.control = directory / "control"
        self.control.mkdir()
        (self.control / "clock.txt").write_text(str(CLOCK_BASE))
        self.environment = {
            name: value for name, value in os.environ.items()
            if not name.startswith(("BILI_", "RISK_FIXTURE_", "RISK_PROBE_", "UVICORN_"))
            and name != "WEB_CONCURRENCY"
        }
        self.environment.update({
            "BILI_DATABASE_PATH": str(self.database),
            "RISK_PROBE_FIXTURE_DIR": str(self.control),
            "PYTHONUNBUFFERED": "1",
            "BILI_COLLECTOR_CADENCE_SECONDS": "1",
            "BILI_COLLECTOR_PAGE_CHECK_SECONDS": "0",
        })
        self.processes, self.logs, self.client, self.api = [], [], None, None

    # ---- 子进程 ----

    def spawn(self, role, *arguments):
        log = self.directory / f"{role}-{len(self.processes)}.log"
        with log.open("wb") as output:
            process = subprocess.Popen(
                [sys.executable, *arguments], cwd=ROOT,
                env={**self.environment, "RISK_PROBE_ROLE": role},
                stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
            )
        self.processes.append(process)
        self.logs.append(log)
        return process

    def run_task(self, *arguments):
        """一次性真实进程：触发、领取或提交探测结果，输出一行 JSON。"""
        result = subprocess.run(
            [sys.executable, "-m", FIXTURE, "--database", str(self.database), *arguments],
            cwd=ROOT, env={**self.environment, "RISK_PROBE_ROLE": "task"},
            capture_output=True, text=True, timeout=120,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        return json.loads(result.stdout.strip().splitlines()[-1])

    def start_api(self):
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        self.api = self.spawn(
            "api", "-m", "uvicorn", "backend.tests.risk_probe_fixture:create_app", "--factory",
            "--host", "127.0.0.1", "--port", str(port),
        )
        self.client = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=5, trust_env=False)
        self.wait(lambda: self.client.get("/api/manage/ups").status_code == 200)
        return self.api

    def start_collector(self):
        return self.spawn("collector", "-m", FIXTURE, "--database", str(self.database))

    def configure(self):
        assert self.client.post("/api/manage/ups", json={"uid": UID}).status_code == 201
        assert self.client.patch(BASE + "/monitor", json={
            "mode": "specified", "recent_n": 10, "enabled": True}).status_code == 200
        assert self.client.post(BASE + "/targets", json={"id": DYNAMIC}).status_code == 201

    # ---- 控制与观察 ----

    def set_clock(self, epoch):
        (self.control / "clock.txt").write_text(str(int(epoch)))

    def control_file(self, name, value=None):
        path = self.control / name
        if value is None:
            if path.exists():
                path.unlink()
        else:
            path.write_text(value)

    def ledger(self, role=None):
        path = self.control / "ledger.txt"
        if not path.exists():
            return []
        lines = [line.split() for line in path.read_text().splitlines() if line.strip()]
        return [tuple(line) for line in lines if role is None or line[0] == role]

    def status(self):
        store = Store(self.database)
        return RiskGate(store, clock=FileClock(self.control)).status()

    def checks(self):
        return Store(self.database).read_checks(UID)

    def wait(self, predicate, *, process=None, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if process is not None and process.poll() is not None:
                pytest.fail(f"Child exited with {process.returncode}: {self.log_text()}")
            try:
                result = predicate()
                if result:
                    return result
            except (httpx.TransportError, IndexError):
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

    def close(self):
        if self.client is not None:
            self.client.close()
        for process in reversed(self.processes):
            self.stop(process)


@pytest.fixture
def deployment(tmp_path):
    instance = Deployment(tmp_path / "risk-probe-process")
    try:
        yield instance
    finally:
        instance.close()


def test_probe_owner_is_unique_across_processes_and_takeover_fences_the_old_owner(deployment):
    triggered = deployment.run_task("--task", "trigger", "--path", "/x/v2/reply/reply")
    assert triggered["state"] == "cooldown" and triggered["backoff_step"] == 1
    deadline = triggered["next_probe_at"]
    assert deadline is not None

    # 恰到期才领取；另一个真实进程不能同时领取同一轮。
    deployment.set_clock(CLOCK_BASE + 60)
    first = deployment.run_task("--task", "claim", "--types", "replies")
    assert first is not None and first["types"] == ["replies"]
    assert deployment.run_task("--task", "claim", "--types", "replies") is None

    # 崩溃后租约到期才可接管；接管重新确认本轮类型。
    deployment.set_clock(CLOCK_BASE + 60 + 301)
    second = deployment.run_task("--task", "claim", "--types", "comment_count")
    assert second is not None
    assert second["owner"] != first["owner"] and second["round"] != first["round"]
    assert second["types"] == ["comment_count"]

    # 旧 owner 不能提交结果、也不能结束新一轮。
    fenced = deployment.run_task(
        "--task", "finish", "--round", first["round"], "--owner", first["owner"], "--passed", "true")
    assert fenced is None
    current = deployment.status()
    assert current["state"] == "probing"
    assert current["probe"]["round"] == second["round"]
    assert [item["status"] for item in current["probe"]["results"]] == ["pending"]

    recovered = deployment.run_task(
        "--task", "finish", "--round", second["round"], "--owner", second["owner"], "--passed", "true")
    assert recovered["state"] == "observing"
    assert recovered["backoff_step"] == 1


def test_collector_process_probes_after_the_deadline_and_resumes_abandoned_work(deployment):
    deployment.start_api()
    deployment.configure()
    deployment.control_file("risk.arm", "root_comments")
    collector = deployment.start_collector()

    # 采集进程真实发送：检查链（页面／详情／计数），随后归档执行被根页 412 打断。
    deployment.wait(lambda: deployment.status()["state"] == "cooldown", process=collector)
    deployment.wait(lambda: deployment.checks()[0]["work"] == "running", process=collector)
    check = deployment.checks()[0]
    assert check["sync_error"] is None and check["last_succeeded_at"] is None

    # 冷却期间零发送：来源恢复为 200 也不会增长账本。
    settled = len(deployment.ledger())
    deployment.control_file("risk.arm")
    time.sleep(2)
    assert len(deployment.ledger()) == settled
    deadline = deployment.status()["next_probe_at"]
    assert deadline is not None

    # 恰到期由采集进程自己探测：触发类型 ∪ 当前待执行工作所需类型，全部用 GET。
    deployment.set_clock(CLOCK_BASE + 61)
    deployment.wait(lambda: deployment.status()["state"] == "observing", process=collector)
    probed = deployment.ledger()[settled:settled + 5]
    assert [kind for _, _, kind in probed] == [
        "root_comments", "comment_count", "detail", "opus_page", "image_hdslb"]
    assert {method for _, method, _ in probed} == {"GET"}
    results = deployment.status()["probe"]["results"]
    assert [item["endpoint_type"] for item in results] == [
        "root_comments", "comment_count", "detail", "opus_page", "image_hdslb"]
    assert all(item["status"] == "passed" for item in results)

    # 观察态恢复：在途 running 领取被归还并继续到完成，不需要重启进程。
    deployment.wait(lambda: deployment.checks()[0]["work"] == "complete", process=collector)
    assert collector.poll() is None
    archive = Store(deployment.database).read_archive(DYNAMIC)
    assert archive["work"]["comments"] == archive["work"]["replies"] == "success"
    assert deployment.checks()[0]["sync_error"] is None
    assert "collector_paused" in deployment.log_text()
    assert "risk_probe_finished" in deployment.log_text()
