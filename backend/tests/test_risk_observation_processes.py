"""05：真实进程装配下的人工探测登记、采集领取、重启与 10 分钟稳定清零。

生产 API／采集入口、真实临时 SQLite、共享文件时钟与传输账本；只替换外部来源与
等待时长。人工态登记走真实 HTTP，探测与观察心跳由真实采集进程执行。
"""

import time

import pytest

from backend.bili_monitor.comment_status import epoch_from_iso
from backend.bili_monitor.storage import Store
from backend.tests.test_risk_probe_processes import UID, Deployment


PROBE = "/api/manage/risk/probe"
RISK = "/api/manage/risk"
# 观察期用一个节拍代表 300 秒活跃采集，两拍满 10 分钟；真实等待压缩到 20ms。
CADENCE = 300.0


class ObservationDeployment(Deployment):
    def __init__(self, directory):
        super().__init__(directory)
        self.environment.update({
            "BILI_COLLECTOR_CADENCE_SECONDS": str(int(CADENCE)),
            "BILI_COLLECTOR_PAGE_CHECK_SECONDS": "0",
            "RISK_PROBE_CLOCK_SLEEP": "0.02",
        })

    def clock(self):
        return int((self.control / "clock.txt").read_text())

    def drive_to_manual(self, kind="comment_count"):
        """六档全部失败进入人工态：全部由一次性真实进程完成。"""
        entry = self.run_task("--task", "trigger", "--path", "/x/v2/reply/count")
        assert entry["state"] == "cooldown" and entry["backoff_step"] == 1
        clock = epoch_from_iso(entry["next_probe_at"])
        for _ in range(6):
            self.set_clock(clock)
            claim = self.run_task("--task", "claim", "--types", kind)
            assert claim is not None, self.log_text()
            finished = self.run_task(
                "--task", "finish", "--round", claim["round"], "--owner", claim["owner"],
                "--passed", "false")
            if finished["state"] == "manual":
                break
            clock = epoch_from_iso(finished["next_probe_at"])
        status = self.status()
        assert status["state"] == "manual" and status["backoff_step"] == 6
        return status


@pytest.fixture
def deployment(tmp_path):
    instance = ObservationDeployment(tmp_path / "risk-observation-process")
    try:
        yield instance
    finally:
        instance.close()


def test_registered_manual_probe_runs_in_the_collector_and_clears_only_after_ten_minutes(deployment):
    deployment.start_api()
    deployment.configure()
    # 先做一次真实初始化归档：探测只用本地已知有效样本（04 的 fail-closed 取舍）。
    assert deployment.client.post("/api/sync/initial", json={"uid": UID}).status_code == 200
    manual = deployment.drive_to_manual()
    assert manual["manual"]["probe_registered"] is False

    # 管理入口只登记：真实 HTTP 202，API 不自己发探测请求。
    sent = len(deployment.ledger())
    registered = deployment.client.post(PROBE)
    assert registered.status_code == 202
    body = registered.json()
    assert body["state"] == "manual"
    assert body["backoff_step"] == 6
    assert body["manual"]["probe_registered"] is True
    # 重复登记幂等，采集进程未运行时保持已登记、不排多轮。
    assert deployment.client.post(PROBE).status_code == 202
    assert deployment.client.post(PROBE).json() == body
    time.sleep(0.2)
    assert deployment.status()["manual"]["probe_registered"] is True
    assert len(deployment.ledger()) == sent

    # 正式采集进程领取并执行这一轮：全部必需类型通过后进入观察期并恢复断点。
    collector = deployment.start_collector()
    deployment.wait(lambda: deployment.status()["state"] == "observing", process=collector)
    status = deployment.status()
    assert status["backoff_step"] == 6
    assert status["manual"]["probe_registered"] is False
    assert [item["status"] for item in status["probe"]["results"]] == [
        "passed" for _ in status["probe"]["results"]]
    deployment.wait(lambda: deployment.checks()[0]["work"] == "complete", process=collector)

    # 观察期确实在累计：推进一个节拍才计入，空闲流逝不会自己清零。
    deployment.set_clock(deployment.clock() + 300)
    deployment.wait(lambda: deployment.status()["observation"]["active_ms"] >= int(CADENCE * 1000),
                    process=collector)
    accrued = deployment.status()["observation"]["active_ms"]
    assert 0 < accrued < 600_000

    # 重启：观察时间重新累计（停机不抵扣），档位仍然保留在第六档。
    deployment.stop(collector)
    deployment.wait(lambda: collector.poll() is not None)
    restart_ticks = deployment.log_text().count("collector_tick")
    restarted = deployment.start_collector()
    # 等重启后的第一个节拍建立观察基线，避免进程尚未循环就推进受控时钟。
    deployment.wait(lambda: deployment.log_text().count("collector_tick") > restart_ticks,
                    process=restarted)
    deployment.wait(lambda: deployment.status()["observation"]["active_ms"] == 0,
                    process=restarted)
    status = deployment.status()
    assert status["state"] == "observing"
    assert status["backoff_step"] == 6

    # 满 10 分钟活跃采集才回到 normal 并清零档位；9 分 59 秒仍保持观察。
    base = deployment.clock()
    deployment.set_clock(base + 300)
    deployment.wait(lambda: deployment.status()["observation"]["active_ms"] == int(CADENCE * 1000),
                    process=restarted)
    deployment.set_clock(base + 599)
    deployment.wait(lambda: deployment.status()["observation"]["active_ms"] == 599_000,
                    process=restarted)
    assert deployment.status()["state"] == "observing"
    assert deployment.status()["backoff_step"] == 6

    deployment.set_clock(base + 600)
    deployment.wait(lambda: deployment.status()["state"] == "normal", process=restarted)
    status = deployment.status()
    assert status["backoff_step"] == 0
    assert status["observation"]["active_ms"] == 0
    assert "source_risk_observation_cleared" in deployment.log_text()
    # 采集进程仍在运行并继续正常采集。
    assert restarted.poll() is None
