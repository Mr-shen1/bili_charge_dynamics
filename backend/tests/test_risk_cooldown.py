"""04：六档冷却、唯一 owner 探测与恢复的持久状态机（真实临时 SQLite、受控时钟）。"""

import asyncio

from backend.bili_monitor.comment_status import epoch_from_iso
from backend.bili_monitor.risk import (
    COOLDOWN_STEPS, PROBE_LEASE_SECONDS, RiskGate, SourceRiskPaused, format_epoch,
)
from backend.bili_monitor.source_gate import SourceReport, source_request
from backend.bili_monitor.storage import Store
from backend.tests.collector_clock import ControlledClock

import pytest


# 受控时钟从 2030-01-01T00:00:00Z 起算；把它换回相对秒数才能精确落在期限上。
BASE = epoch_from_iso(ControlledClock().now())


def open_gate(path, clock):
    store = Store(path)
    store.migrate()
    return store, RiskGate(store, clock=clock)


def request_for(path="/x/v2/reply", host="api.bilibili.com"):
    classified = source_request("GET", f"https://{host}{path}")
    assert classified is not None
    return classified


def trigger(gate, status_code=412, *, retry_after=None, path="/x/v2/reply/reply"):
    report = SourceReport(status_code=status_code, retry_after=retry_after)
    try:
        asyncio.run(gate.report(request_for(path), report))
    except SourceRiskPaused:
        return True
    return False


def claim(gate, types=("replies",)):
    return asyncio.run(gate.claim_probe(list(types)))


def record(gate, current, kind, status="failed"):
    return asyncio.run(gate.record_probe(current, {"endpoint_type": kind, "status": status}))


def finish(gate, current, passed, retry_after=None):
    return asyncio.run(gate.finish_probe(current, passed, retry_after))


def remaining(status):
    return epoch_from_iso(status["next_probe_at"]) - epoch_from_iso(status["since"])


def deadline_on_clock(status):
    """持久期限换算成受控时钟的相对秒数。"""
    return epoch_from_iso(status["next_probe_at"]) - BASE


def advance_by(clock, seconds):
    clock.advance(clock.value + seconds)


def test_every_step_waits_its_full_duration_then_probes_once(tmp_path):
    path = tmp_path / "risk.sqlite"
    clock = ControlledClock()
    _, gate = open_gate(path, clock)
    assert trigger(gate) is True

    for index, seconds in enumerate(COOLDOWN_STEPS):
        status = gate.status()
        assert status["state"] == "cooldown"
        assert status["backoff_step"] == index + 1
        assert remaining(status) == seconds
        # 恰到期前不能提前探测；恰到期才领取本轮。
        clock.advance(deadline_on_clock(status) - 1)
        assert claim(gate) is None
        clock.advance(deadline_on_clock(status))
        current = claim(gate)
        assert current is not None and current["types"] == ["replies"]
        assert gate.status()["state"] == "probing"
        # 本轮待探测：状态查询能区分 pending / failed。
        assert gate.status()["probe"]["results"] == [
            {"endpoint_type": "replies", "status": "pending"}]
        assert record(gate, current, "replies") is True
        assert gate.status()["probe"]["results"][0]["status"] == "failed"
        # 任一轮失败只推进一档，且仍保持暂停。
        status = finish(gate, current, False)
        if index + 1 < len(COOLDOWN_STEPS):
            assert status["state"] == "cooldown"
            assert status["backoff_step"] == index + 2
        else:
            assert status["state"] == "manual"

    assert gate.status()["state"] == "manual"
    assert gate.status()["backoff_step"] == len(COOLDOWN_STEPS)
    assert gate.status()["next_probe_at"] is None
    # 人工态不自动探测，也不能靠时间流逝放行。
    advance_by(clock, 10**6)
    assert claim(gate) is None
    assert trigger(gate) is True  # 迟到的风控响应只合并，不改变人工态
    assert gate.status()["state"] == "manual"


def test_round_with_every_type_passed_enters_observing_and_keeps_the_step(tmp_path):
    path = tmp_path / "risk.sqlite"
    clock = ControlledClock()
    _, gate = open_gate(path, clock)
    trigger(gate)
    clock.advance(deadline_on_clock(gate.status()))
    current = claim(gate, ("replies", "comment_count", "image_hdslb"))
    assert current["types"] == ["replies", "comment_count", "image_hdslb"]
    for index, kind in enumerate(current["types"]):
        assert record(gate, current, kind, "passed") is True
        assert gate.status()["probe"]["results"][index]["status"] == "passed"
    status = finish(gate, current, True)
    assert status["state"] == "observing"
    assert status["backoff_step"] == 1  # 探测成功不提前清零档位（05 负责稳定清零）
    assert status["observing_since"] == status["since"]
    assert status["next_probe_at"] is None
    # 观察态恢复正常调度：发送许可不再拒绝。
    asyncio.run(gate.permit(request_for()))
    assert asyncio.run(gate.pause()) is None


def test_trigger_during_observation_advances_one_step_and_sixth_goes_manual(tmp_path):
    path = tmp_path / "risk.sqlite"
    clock = ControlledClock()
    _, gate = open_gate(path, clock)
    trigger(gate)
    for expected_step in range(1, len(COOLDOWN_STEPS) + 1):
        clock.advance(deadline_on_clock(gate.status()))
        current = claim(gate)
        assert current is not None
        finish(gate, current, True)
        assert gate.status()["state"] == "observing"
        assert gate.status()["backoff_step"] == expected_step
        # 观察期再次被拦截：沿用当前档的下一档，而不是回到 1 分钟。
        assert trigger(gate, 429) is True
        if expected_step < len(COOLDOWN_STEPS):
            assert gate.status()["state"] == "cooldown"
            assert gate.status()["backoff_step"] == expected_step + 1
        else:
            assert gate.status()["state"] == "manual"


def test_legal_retry_after_is_never_shortened_by_the_local_step(tmp_path):
    path = tmp_path / "risk.sqlite"
    clock = ControlledClock()
    _, gate = open_gate(path, clock)
    assert trigger(gate, 429, retry_after="600") is True
    assert remaining(gate.status()) == 600

    # 探测失败时的 429 同样把下一档期限推到服务端要求之后。
    clock.advance(deadline_on_clock(gate.status()))
    current = claim(gate)
    assert finish(gate, current, False, "3600") is not None
    assert gate.status()["state"] == "cooldown"
    assert remaining(gate.status()) == 3600

    # 非法值不能当成“要求 0 秒”，仍按本地档位等待。
    clock.advance(deadline_on_clock(gate.status()))
    current = claim(gate)
    finish(gate, current, False, "not-a-number")
    assert remaining(gate.status()) == COOLDOWN_STEPS[2]


def test_invalid_retry_after_values_are_ignored(tmp_path):
    for index, value in enumerate(("-5", "", "tomorrow", True, None)):
        clock = ControlledClock()
        _, gate = open_gate(tmp_path / f"invalid-{index}.sqlite", clock)
        assert trigger(gate, 429, retry_after=value) is True
        assert remaining(gate.status()) == COOLDOWN_STEPS[0]


def test_remaining_deadline_survives_reopen_without_probing_on_startup(tmp_path):
    path = tmp_path / "risk.sqlite"
    clock = ControlledClock()
    _, gate = open_gate(path, clock)
    trigger(gate)
    deadline = gate.status()["next_probe_at"]

    reopened_store, reopened = open_gate(path, clock)
    assert reopened.status()["state"] == "cooldown"
    assert reopened.status()["next_probe_at"] == deadline
    # 启动本身不是恢复依据：未到期仍不领取、仍拒绝发送。
    assert claim(reopened) is None
    with pytest.raises(SourceRiskPaused):
        asyncio.run(reopened.permit(request_for()))


def test_abnormal_clock_and_missing_lease_never_bypass_the_pause(tmp_path):
    path = tmp_path / "risk.sqlite"
    clock = ControlledClock()
    store, gate = open_gate(path, clock)
    trigger(gate)

    # 持久期限不可解析：不提前探测，也不自动放行。
    with store.connection() as connection:
        connection.execute("UPDATE source_risk SET next_probe_at = 'not-a-time'")
        connection.commit()
    advance_by(clock, 10**6)
    assert claim(gate) is None
    assert gate.status()["state"] == "cooldown"
    with pytest.raises(SourceRiskPaused):
        asyncio.run(gate.permit(request_for()))

    # 系统时钟回拨：期限仍在未来，同样不领取。
    future = format_epoch(BASE + clock.value + 3600)
    with store.connection() as connection:
        connection.execute("UPDATE source_risk SET next_probe_at = ?", (future,))
        connection.commit()
    assert claim(gate) is None


def test_probe_owner_lease_fences_the_old_owner_and_allows_takeover(tmp_path):
    path = tmp_path / "risk.sqlite"
    clock = ControlledClock()
    _, gate = open_gate(path, clock)
    trigger(gate)
    clock.advance(deadline_on_clock(gate.status()))
    first = claim(gate, ("replies", "comment_count"))
    assert first is not None

    # 租约内另一个 owner 不能领取：不会出现两路探测。
    assert claim(gate, ("replies",)) is None
    # 进程崩溃后租约到期才可接管，且接管重新确认本轮类型。
    advance_by(clock, PROBE_LEASE_SECONDS + 1)
    second = claim(gate, ("comment_count",))
    assert second is not None
    assert second["owner"] != first["owner"] and second["round"] != first["round"]
    assert gate.status()["probe"]["results"] == [
        {"endpoint_type": "comment_count", "status": "pending"}]

    # 旧 owner 不能提交结果、也不能结束新一轮。
    assert record(gate, first, "replies") is False
    assert finish(gate, first, True) is None
    assert gate.status()["state"] == "probing"
    assert gate.status()["probe"]["results"][0]["status"] == "pending"

    assert record(gate, second, "comment_count", "passed") is True
    assert finish(gate, second, True)["state"] == "observing"


def test_probe_round_requires_something_to_verify(tmp_path):
    path = tmp_path / "risk.sqlite"
    clock = ControlledClock()
    _, gate = open_gate(path, clock)
    trigger(gate)
    clock.advance(deadline_on_clock(gate.status()))
    # 没有可验证类型就不可能确认恢复：不领取、也不伪造“全部通过”。
    assert claim(gate, ()) is None
    assert gate.status()["state"] == "cooldown"


def test_public_status_is_distinguishable_and_never_leaks_owner_or_lease(tmp_path):
    path = tmp_path / "risk.sqlite"
    clock = ControlledClock()
    store, gate = open_gate(path, clock)
    trigger(gate)
    clock.advance(deadline_on_clock(gate.status()))
    current = claim(gate, ("replies", "comment_count"))
    record(gate, current, "replies", "failed")

    status = gate.status()
    assert status["state"] == "probing"
    assert status["probe"]["round"] == current["round"]
    assert [(item["endpoint_type"], item["status"]) for item in status["probe"]["results"]] == [
        ("replies", "failed"), ("comment_count", "pending")]
    rendered = repr(status)
    assert current["owner"] not in rendered
    assert "lease" not in rendered and "token" not in rendered
    assert "http://" not in rendered and "https://" not in rendered
    with store.connection() as connection:
        row = connection.execute(
            "SELECT state, probe_owner, probe_lease_until FROM source_risk").fetchone()
    assert row["state"] == "probing"
    assert row["probe_owner"] == current["owner"]
    assert row["probe_lease_until"] == "2030-01-01T00:06:00+00:00"


def test_retry_after_header_from_the_transport_extends_the_deadline(tmp_path):
    """真实传输层把原始 Retry-After 头交给状态层；本地档位不能覆盖服务端要求。"""
    import httpx

    from backend.bili_monitor.source_gate import GatedAsyncTransport

    clock = ControlledClock()
    store = Store(tmp_path / "retry.sqlite")
    store.migrate()
    gate = RiskGate(store, clock=clock)
    transport = httpx.MockTransport(
        lambda request: httpx.Response(429, headers={"retry-after": "600"}, text=""))
    client = httpx.AsyncClient(transport=GatedAsyncTransport(transport, gate=gate))

    async def scenario():
        async with client:
            with pytest.raises(SourceRiskPaused):
                await client.get("https://api.bilibili.com/x/v2/reply")

    asyncio.run(scenario())
    assert gate.status()["last_trigger"]["http_status"] == 429
    assert remaining(gate.status()) == 600


def test_comment_request_session_forwards_retry_after_before_rejecting(tmp_path, monkeypatch):
    """Requests 逐跳路径同样转发原始头，而不是只报告状态码。"""
    import requests

    from backend.bili_monitor.comment_client import _SourceSession

    clock = ControlledClock()
    store = Store(tmp_path / "retry-requests.sqlite")
    store.migrate()
    gate = RiskGate(store, clock=clock)

    reports = []

    class Hop:
        def permit(self, source):
            return None

        def report(self, source, report):
            reports.append(report)
            asyncio.run(gate.report(source, report))

    def fake_send(self, request, **kwargs):
        response = requests.Response()
        response.status_code = 429
        response.headers["retry-after"] = "900"
        response.url = request.url
        response._content = b""
        response._content_consumed = True
        response.history = []
        return response

    monkeypatch.setattr(requests.Session, "send", fake_send)
    session = _SourceSession()
    session.hop = Hop()
    with pytest.raises(SourceRiskPaused):
        session.send(requests.Request("GET", "https://api.bilibili.com/x/v2/reply"))
    assert reports and reports[0].retry_after == "900"
    assert remaining(gate.status()) == 900


def test_status_endpoint_reveals_probe_round_without_triggering_any_probe(tmp_path):
    """只读状态查询能区分本轮待探测／通过／失败与下一档时间，且不触发探测。"""
    import httpx
    from fastapi.testclient import TestClient

    from backend.bili_monitor.app import create_app

    path = tmp_path / "status.sqlite"
    clock = ControlledClock()
    _, gate = open_gate(path, clock)
    trigger(gate)
    clock.advance(deadline_on_clock(gate.status()))
    current = claim(gate, ("replies", "comment_count"))
    record(gate, current, "replies", "failed")

    def never(request):
        raise AssertionError("Status reading must not touch the source")

    app = create_app(path, profile_transport=httpx.MockTransport(never), risk_clock=clock)
    with TestClient(app, raise_server_exceptions=False) as client:
        status = client.get("/api/manage/risk").json()
        assert status["state"] == "probing"
        assert status["backoff_step"] == 1
        assert status["next_probe_at"] is None
        assert status["probe"]["round"] == current["round"]
        assert [(item["endpoint_type"], item["status"]) for item in status["probe"]["results"]] == [
            ("replies", "failed"), ("comment_count", "pending")]
        # 不接受 query，也不暴露 owner／租约令牌。
        assert client.get("/api/manage/risk?probe=1").status_code == 422
        rendered = client.get("/api/manage/risk").text
        assert current["owner"] not in rendered and "lease" not in rendered
