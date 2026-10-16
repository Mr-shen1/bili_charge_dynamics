"""#31：真实 HTTP、独立进程与临时 SQLite；只替换外部来源和上传。"""

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
CHECKS = BASE + "/checks"
ARCHIVE = "/api/archive/dynamics/91001"
CONFIG = {"mode": "specified", "recent_n": 10, "enabled": True}


class Deployment:
    def __init__(self, directory):
        self.directory = directory
        self.database = directory / "deployment.sqlite"
        self.control = directory / "control"
        self.control.mkdir()
        # 不加载 .env，不继承业务凭据或运行者的 uvicorn 多 worker 配置。
        self.environment = {
            name: value for name, value in os.environ.items()
            if not name.startswith(("BILI_", "DEPLOYMENT_FIXTURE_", "UVICORN_"))
            and name != "WEB_CONCURRENCY"
        }
        self.environment.update({
            "BILI_DATABASE_PATH": str(self.database),
            "DEPLOYMENT_FIXTURE_CONTROL_DIR": str(self.control),
            "DEPLOYMENT_FIXTURE_MEDIA_URL": "https://media.example.invalid/deployment.png",
            "PYTHONUNBUFFERED": "1",
            "BILI_DEPLOYMENT_SECRET": "FAKE_DEPLOYMENT_SECRET_31_NEVER_REAL",
        })
        self.processes = []
        self.logs = []
        self.api = None
        self.client = None

    def spawn(self, *arguments):
        log = self.directory / f"process-{len(self.processes)}.log"
        with log.open("wb") as output:
            process = subprocess.Popen(
                [sys.executable, *arguments], cwd=ROOT, env=self.environment,
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
            "-m", "uvicorn", "backend.tests.deployment_fixture:create_app", "--factory",
            "--host", "127.0.0.1", "--port", str(port),
        )
        self.client = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=2, trust_env=False)
        self.wait(lambda: self.client.get("/api/manage/ups").status_code == 200,
                  process=self.api, timeout=10)

    def start_collector(self):
        return self.spawn("-m", "backend.tests.deployment_fixture", "--database", str(self.database))

    def wait(self, predicate, *, process=None, timeout=25):
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

    def configure(self):
        assert self.client.post("/api/manage/ups", json={"uid": "202"}).status_code == 201
        assert self.client.patch(BASE + "/monitor", json=CONFIG).status_code == 200
        assert self.client.post(BASE + "/targets", json={"id": "91001"}).status_code == 201

    def check(self):
        response = self.client.get(CHECKS)
        assert response.status_code == 200
        return response.json()["checks"][0]

    def stop(self, process, *, kill=False):
        if process.poll() is None:
            process.kill() if kill else process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    def stop_api(self):
        self.client.close()
        self.stop(self.api)

    def close(self):
        if self.client is not None:
            self.client.close()
        for process in reversed(self.processes):
            self.stop(process)


@pytest.fixture
def deployment(tmp_path):
    instance = Deployment(tmp_path)
    try:
        yield instance
    finally:
        instance.close()


def test_http_configuration_persists_across_api_restart_without_collector(deployment):
    deployment.start_api()
    deployment.configure()
    assert deployment.check()["check_status"] == "unchecked"
    deployment.stop_api()
    deployment.start_api()
    saved = deployment.client.get(BASE).json()
    assert saved["uid"] == "202"
    assert {key: saved["monitor"][key] for key in CONFIG} == CONFIG
    assert deployment.client.get(BASE + "/targets").json() == {"targets": [{"id": "91001"}]}
    assert deployment.check()["last_checked_at"] is None
    assert deployment.client.get("/api/archive/dynamics").json()["items"] == []
    assert deployment.database.is_file()


def test_independent_collector_checks_and_archives_over_normal_schedule(deployment):
    deployment.start_api()
    deployment.configure()
    collector = deployment.start_collector()
    deployment.wait(lambda: deployment.check()["work"] == "complete", process=collector)
    checked = deployment.check()
    assert checked["last_checked_at"] is not None
    assert checked["last_succeeded_at"] is not None
    assert checked["observed"]["source_comment_count"] == 0
    assert set(checked["parts"].values()) == {"success"}
    saved = deployment.client.get(ARCHIVE).json()
    assert "部署隔离正文" in saved["text"]
    assert saved["author"]["id"] == "202"
    assert saved["media"][0]["status"] == "success"
    assert saved["media"][0]["public_url"] == "https://media.example.invalid/deployment.png"
    deployment.stop(collector)
    deployment.stop_api()
    deployment.start_api()
    assert deployment.client.get(ARCHIVE).json() == saved
    assert deployment.check() == checked


def test_blocked_external_source_keeps_api_reads_and_configuration_bounded(deployment):
    deployment.start_api()
    deployment.configure()
    (deployment.control / "source.entered").unlink(missing_ok=True)
    (deployment.control / "source.block").touch()
    collector = deployment.start_collector()
    deployment.wait(lambda: (deployment.control / "source.entered").exists(), process=collector, timeout=5)
    assert deployment.client.get(BASE).status_code == 200
    assert deployment.client.get(CHECKS).status_code == 200
    assert deployment.client.get("/api/archive/dynamics").json()["items"] == []
    updated = dict(CONFIG, recent_n=11)
    assert deployment.client.patch(BASE + "/monitor", json=updated).status_code == 200
    assert deployment.client.get(BASE).json()["monitor"]["recent_n"] == 11
    assert (deployment.control / "source.block").exists()
    assert deployment.check()["last_checked_at"] is None
    (deployment.control / "source.block").unlink()
    deployment.wait(lambda: deployment.check()["last_checked_at"] is not None, process=collector, timeout=5)


def test_killed_upload_is_recovered_by_one_collector_not_api_restart(deployment):
    deployment.start_api()
    deployment.configure()
    (deployment.control / "upload.block").touch()
    collector = deployment.start_collector()
    deployment.wait(lambda: (deployment.control / "upload.entered").exists(), process=collector, timeout=20)
    running = deployment.check()
    assert running["work"] == "running"
    saved = deployment.client.get(ARCHIVE).json()
    assert "部署隔离正文" in saved["text"]
    assert saved["work"]["media"] == "pending"
    assert deployment.client.get(BASE).status_code == 200
    assert deployment.client.patch(BASE + "/monitor", json=CONFIG).status_code == 200
    assert (deployment.control / "upload.block").exists()

    # 同库的第二个真实进程必须被生产 flock 拒绝，不抢占原工作。
    competitor = deployment.start_collector()
    assert competitor.wait(timeout=5) != 0
    assert collector.poll() is None
    assert deployment.check()["work"] == "running"

    deployment.stop_api()
    deployment.start_api()
    assert deployment.check()["work"] == "running"  # API 不恢复/领取工作。
    assert deployment.client.get(ARCHIVE).json()["text"] == saved["text"]
    deployment.stop(collector, kill=True)
    assert collector.returncode < 0
    assert deployment.check()["work"] == "running"

    # 阻断新检查，只有重启时恢复的持久工作能令本轮 complete。
    (deployment.control / "source.entered").unlink(missing_ok=True)
    (deployment.control / "source.block").touch()
    (deployment.control / "upload.entered").unlink()
    recovered = deployment.start_collector()
    deployment.wait(lambda: (deployment.control / "source.entered").exists()
                    and (deployment.control / "upload.entered").exists(), process=recovered, timeout=5)
    assert deployment.check()["work"] == "running"
    (deployment.control / "upload.block").unlink()
    deployment.wait(lambda: deployment.check()["work"] == "complete", process=recovered, timeout=5)
    complete = deployment.check()
    assert complete["revision"] == running["revision"]
    assert complete["last_checked_at"] == running["last_checked_at"]
    assert complete["last_succeeded_at"] is not None
    assert set(complete["parts"].values()) == {"success"}
    assert deployment.client.get(ARCHIVE).json()["media"][0]["public_url"] == "https://media.example.invalid/deployment.png"
    assert [item["id"] for item in deployment.client.get("/api/archive/dynamics").json()["items"]] == ["91001"]


def test_external_source_failure_is_redacted_in_real_http_and_child_logs(deployment):
    deployment.start_api()
    deployment.configure()
    secret = deployment.environment["BILI_DEPLOYMENT_SECRET"]
    response = deployment.client.post("/api/manage/ups", json={"uid": "303"})
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "PROFILE_UNAVAILABLE"
    assert secret not in response.text
    (deployment.control / "source.fail").touch()
    collector = deployment.start_collector()
    deployment.wait(lambda: deployment.check()["check_status"] == "failed", process=collector, timeout=5)
    state = deployment.check()
    assert state["check_error"] == "SOURCE_UNAVAILABLE"
    assert state["last_succeeded_at"] is None
    assert secret not in deployment.client.get(CHECKS).text
    assert secret not in deployment.client.get(BASE).text
    deployment.stop(collector)
    deployment.stop_api()
    assert secret not in deployment.log_text()


def test_failed_upload_stays_pending_and_retries_after_restart_without_new_check(deployment):
    deployment.environment["DEPLOYMENT_FIXTURE_MEDIA_URL"] = "https://media.example.invalid/custom-deployment.png"
    deployment.start_api()
    deployment.configure()
    (deployment.control / "upload.fail").touch()
    collector = deployment.start_collector()
    deployment.wait(lambda: deployment.check()["sync_error"] == "SYNC_INCOMPLETE", process=collector)
    failed = deployment.check()
    assert failed["work"] == "pending"
    assert failed["parts"]["text"] == "success"
    assert failed["parts"]["media"] == "pending"
    assert failed["media_errors"] == ["MEDIA_UPLOAD_FAILED"]
    saved = deployment.client.get(ARCHIVE).json()
    assert "部署隔离正文" in saved["text"]
    assert saved["media"][0]["status"] == "failed"
    assert saved["media"][0]["public_url"] is None
    assert deployment.environment["BILI_DEPLOYMENT_SECRET"] not in deployment.client.get(ARCHIVE).text
    assert deployment.environment["BILI_DEPLOYMENT_SECRET"] not in deployment.client.get(CHECKS).text
    deployment.stop(collector)

    (deployment.control / "upload.fail").unlink()
    (deployment.control / "source.entered").unlink(missing_ok=True)
    (deployment.control / "source.block").touch()
    restarted = deployment.start_collector()
    deployment.wait(lambda: (deployment.control / "source.entered").exists()
                    and deployment.check()["work"] == "complete", process=restarted, timeout=5)
    complete = deployment.check()
    assert complete["revision"] == failed["revision"]
    assert complete["last_checked_at"] == failed["last_checked_at"]
    assert complete["sync_error"] is None
    assert complete["media_errors"] == []
    assert set(complete["parts"].values()) == {"success"}
    archived = deployment.client.get(ARCHIVE).json()
    assert archived["media"][0]["public_url"] == "https://media.example.invalid/custom-deployment.png"
    deployment.stop(restarted)

    # 没有 collector 时反复阅读不会进入外部来源/上传，也不会推进持久检查。
    (deployment.control / "source.entered").unlink()
    (deployment.control / "upload.entered").unlink()
    for _ in range(3):
        assert deployment.client.get(ARCHIVE).json() == archived
        assert deployment.check() == complete
        assert deployment.client.get("/api/archive/ups").status_code == 200
        assert deployment.client.get("/api/archive/dynamics").status_code == 200
        assert deployment.client.get(ARCHIVE + "/comments").status_code == 200
    assert not (deployment.control / "source.entered").exists()
    assert not (deployment.control / "upload.entered").exists()
    deployment.stop_api()
    assert deployment.environment["BILI_DEPLOYMENT_SECRET"] not in deployment.log_text()
