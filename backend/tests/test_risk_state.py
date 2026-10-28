"""03：跨进程风控状态的持久语义（真实临时 SQLite，不访问真实上游）。"""

import asyncio
import sqlite3

import pytest

from backend.bili_monitor.comment_status import epoch_from_iso
from backend.bili_monitor.risk import COOLDOWN_STEPS, RiskGate, SourceRiskPaused
from backend.bili_monitor.source_gate import SourceReport, source_request
from backend.bili_monitor.storage import Store


def request_for(path="/x/v2/reply", host="api.bilibili.com"):
    classified = source_request("GET", f"https://{host}{path}")
    assert classified is not None
    return classified


def open_gate(path):
    store = Store(path)
    store.migrate()
    return store, RiskGate(store)


def status(path):
    store, gate = open_gate(path)
    return gate.status()


def report(gate, status_code, path="/x/v2/reply"):
    """报告一次发送结果；风控结果会同时中断这次调用链，返回是否被拒绝。"""
    try:
        asyncio.run(gate.report(request_for(path), SourceReport(status_code)))
    except SourceRiskPaused:
        return True
    return False


def test_first_http_412_pauses_with_one_minute_deadline_and_trigger_facts(tmp_path):
    path = tmp_path / "risk.sqlite"
    _, gate = open_gate(path)
    assert status(path)["state"] == "normal"

    # 报告风控响应的同时拒绝这次发送：调用方不会拿到响应再继续翻页。
    assert report(gate, 412, "/x/v2/reply/reply") is True

    current = status(path)
    assert current["state"] == "cooldown"
    assert current["backoff_step"] == 1
    assert current["generation"] == 1
    assert current["last_trigger"] == {
        "endpoint_type": "replies", "http_status": 412, "at": current["last_trigger"]["at"],
    }
    remaining = epoch_from_iso(current["next_probe_at"]) - epoch_from_iso(current["since"])
    assert remaining == COOLDOWN_STEPS[0] == 60


def test_late_risk_responses_merge_without_advancing_the_backoff_step(tmp_path):
    path = tmp_path / "risk.sqlite"
    _, gate = open_gate(path)
    assert report(gate, 412) is True
    first = status(path)

    # 已在保护中的迟到响应同样被拒绝，但只合并到同一代次，不推进档位。
    for _ in range(3):
        assert report(gate, 429, "/x/v2/reply/count") is True

    current = status(path)
    assert current["backoff_step"] == 1
    assert current["generation"] == first["generation"] == 1
    assert current["next_probe_at"] == first["next_probe_at"]
    assert current["last_trigger"] == first["last_trigger"]


def test_only_http_412_and_429_trigger_the_pause(tmp_path):
    path = tmp_path / "risk.sqlite"
    _, gate = open_gate(path)
    for status_code in (403, 500, 502, 503, 200, None):
        assert report(gate, status_code) is False
        assert status(path)["state"] == "normal"

    # 业务码走解析层，不是 HTTP 状态；网络失败同样不触发。
    asyncio.run(gate.report(request_for(), SourceReport(error=RuntimeError("FICTIONAL_SECRET"))))
    assert status(path)["state"] == "normal"

    assert report(gate, 429) is True
    assert status(path)["state"] == "cooldown"


def test_permit_refuses_new_requests_only_while_paused(tmp_path):
    path = tmp_path / "risk.sqlite"
    _, gate = open_gate(path)
    asyncio.run(gate.permit(request_for()))  # 正常态放行
    assert report(gate, 412) is True

    with pytest.raises(SourceRiskPaused) as paused:
        asyncio.run(gate.permit(request_for()))
    # 拒绝时带出可公开的状态事实，供 503 与 Retry-After 使用。
    assert paused.value.status["state"] == "cooldown"
    assert paused.value.status["next_probe_at"] == status(path)["next_probe_at"]


def test_pause_survives_reopen_and_is_shared_by_independent_store_instances(tmp_path):
    path = tmp_path / "risk.sqlite"
    store, gate = open_gate(path)
    assert report(gate, 412) is True
    triggered = gate.status()

    # 另一个进程视角：同文件、另一组连接，读到同一份状态与剩余期限。
    other_store, other_gate = open_gate(path)
    assert other_gate.status()["next_probe_at"] == triggered["next_probe_at"]
    with pytest.raises(SourceRiskPaused):
        asyncio.run(other_gate.permit(request_for()))


def test_unreadable_state_forbids_new_requests_instead_of_failing_open(tmp_path):
    path = tmp_path / "risk.sqlite"
    store, gate = open_gate(path)
    with store.connection() as connection:
        connection.execute("DROP TABLE source_risk")
        connection.commit()

    with pytest.raises(sqlite3.Error):
        asyncio.run(gate.permit(request_for()))


def test_migration_adds_a_single_normal_row_and_preserves_existing_state(tmp_path):
    path = tmp_path / "risk.sqlite"
    store, gate = open_gate(path)
    assert report(gate, 412) is True
    triggered = gate.status()

    store.migrate()  # 可重入：重放不重置已登记的保护状态。
    assert gate.status() == triggered
    with store.connection() as connection:
        rows = connection.execute("SELECT singleton, state, generation FROM source_risk").fetchall()
        version = connection.execute("PRAGMA user_version").fetchone()[0]
    assert [tuple(row) for row in rows] == [(1, "cooldown", 1)]
    assert version == 27
