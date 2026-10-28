"""05：人工态登记一轮受控探测（管理入口）、采集进程领取执行与结果 fencing。

管理入口只在 `manual` 登记，`202` 只表示已登记；探测仍由正式采集进程领取执行，
通过进入同一观察期，失败保持人工态。重复登记幂等、不排多轮，也不提供任何直接
清零档位或提前解除冷却的字段。
"""

import asyncio
import json
import logging
import re
from contextlib import contextmanager

import httpx
from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app
from backend.bili_monitor.collector import Collector
from backend.bili_monitor.reply_pacing import ReplyPagePacer
from backend.bili_monitor.risk import (
    PROBE_LEASE_SECONDS, RiskGate, SourceRiskPaused,
)
from backend.bili_monitor.risk_probe import RiskProber, ordered_types, required_types
from backend.bili_monitor.source_gate import GatedAsyncTransport, SourceReport, source_request
from backend.bili_monitor.storage import Store
from backend.tests.collector_clock import ControlledClock, eventually
from backend.tests.collector_support import configured, empty_upstream
from backend.tests.management_support import UID

RISK = "/api/manage/risk"
PROBE = "/api/manage/risk/probe"
CADENCE = 300.0
BLOCKED = "RISK_PROBE_NOT_ALLOWED"
PROBE_MESSAGE = "当前保护状态不允许登记人工探测"


def request_for(path="/x/v2/reply", host="api.bilibili.com"):
    classified = source_request("GET", f"https://{host}{path}")
    assert classified is not None
    return classified


def report(gate, status_code=412, path="/opus/123", host="www.bilibili.com"):
    """真实报告入口：观测期触发类型用触发接口本身，便于核对探测顺序。"""
    try:
        asyncio.run(gate.report(request_for(path, host), SourceReport(status_code=status_code)))
    except SourceRiskPaused:
        return True
    return False


def gate_for(path, clock):
    store = Store(path)
    store.migrate()
    return store, RiskGate(store, clock=clock)


def to_cooldown(gate):
    assert report(gate) is True
    assert gate.status()["state"] == "cooldown"


def to_manual(gate, clock):
    """六档全部探测失败 → 人工态；只走真实状态转移，不手写内部表。"""
    to_cooldown(gate)
    for _ in range(6):
        clock.advance(clock.value + 10**6)
        claim = asyncio.run(gate.claim_probe(["replies"]))
        assert claim is not None
        asyncio.run(gate.record_probe(claim, {"endpoint_type": "replies", "status": "failed"}))
        asyncio.run(gate.finish_probe(claim, False))
    status = gate.status()
    assert status["state"] == "manual"
    assert status["backoff_step"] == 6
    assert status["next_probe_at"] is None
    return status


@contextmanager
def captured_events():
    logger = logging.getLogger("bili_monitor.collector")
    records = []

    class Capture(logging.Handler):
        def emit(self, record):
            records.append(record.getMessage())

    handler = Capture()
    logger.addHandler(handler)
    try:
        yield records
    finally:
        logger.removeHandler(handler)


def events(records, name):
    return [line for line in records if line.startswith(name)]


class Source:
    """受控上游：记录每次真实发送；可指定某接口类型返回风控状态。"""

    def __init__(self):
        self.sent = []
        self.risky = set()

    def __call__(self, request):
        classified = source_request(request.method, request.url)
        kind = classified.endpoint_type if classified is not None else None
        self.sent.append(kind)
        if kind in self.risky:
            return httpx.Response(412, text="")
        return empty_upstream(request)


def test_probe_endpoint_only_registers_one_round_in_the_manual_state(tmp_path):
    path = tmp_path / "manual-api.sqlite"
    clock = ControlledClock()
    source = Source()
    app = create_app(path, profile_transport=httpx.MockTransport(source),
                     risk_clock=clock)

    with TestClient(app, raise_server_exceptions=False) as client:
        _, gate = gate_for(path, clock)
        # 普通态：入口不适用，也不发出任何来源请求或登记。
        normal = client.post(PROBE)
        assert (normal.status_code, normal.json()["error"]["code"]) == (409, BLOCKED)
        assert normal.json()["error"]["message"] == PROBE_MESSAGE
        assert gate.status()["state"] == "normal"
        assert gate.status()["manual"]["probe_registered"] is False
        assert source.sent == []

        # 冷却未到期：不能借这个入口提前探测或解除保护。
        to_cooldown(gate)
        paused = gate.status()
        blocked = client.post(PROBE)
        assert (blocked.status_code, blocked.json()["error"]["code"]) == (409, BLOCKED)
        assert gate.status()["state"] == "cooldown"
        assert gate.status()["next_probe_at"] == paused["next_probe_at"]
        assert source.sent == []

        # 人工态：登记成功；采集进程没运行时保持“已登记”，API 自己不发请求。
        to_manual(gate, clock)
        registered = client.post(PROBE)
        assert registered.status_code == 202
        body = registered.json()
        assert body["state"] == "manual"
        assert body["backoff_step"] == 6
        assert body["manual"]["probe_registered"] is True
        # 同一人工态代次重复登记幂等：不排多轮、不改档位与截止时间。
        for _ in range(2):
            repeated = client.post(PROBE)
            assert repeated.status_code == 202
            assert repeated.json() == body
        status = client.get(RISK).json()
        assert status["manual"]["probe_registered"] is True
        assert status["state"] == "manual"
        assert status["next_probe_at"] is None
        assert source.sent == []
        # 另一个进程的只读视图看到同一份登记事实。
        assert RiskGate(Store(path), clock=clock).status()["manual"]["probe_registered"] is True

        # 不接受 query，也不接受可写状态字段：既不能清零档位，也不能改截止时间。
        assert client.post(PROBE + "?state=normal").status_code == 422
        for payload in ({"state": "normal"}, {"backoff_step": 0}, {"next_probe_at": None}):
            rejected = client.post(PROBE, json=payload)
            assert rejected.status_code == 422
            assert rejected.json()["error"]["code"] == "INVALID_INPUT"
        unchanged = gate.status()
        assert unchanged["state"] == "manual"
        assert unchanged["backoff_step"] == 6
        assert unchanged["next_probe_at"] is None
        assert unchanged["manual"]["probe_registered"] is True
        serialized = json.dumps(body)
        for forbidden in ("owner", "lease", "claim", "token", "http://", "https://"):
            assert forbidden not in serialized

        # 正在探测：登记不再叠加一轮；观察态也不把这个入口当采集触发器。
        claim = asyncio.run(gate.claim_probe(["opus_page"]))
        assert claim["origin"] == "manual"
        probing = client.post(PROBE)
        assert (probing.status_code, probing.json()["error"]["code"]) == (409, BLOCKED)
        assert asyncio.run(gate.record_probe(
            claim, {"endpoint_type": "opus_page", "status": "passed"})) is True
        assert asyncio.run(gate.finish_probe(claim, True))["state"] == "observing"
        observing_response = client.post(PROBE)
        assert (observing_response.status_code, observing_response.json()["error"]["code"]) == (
            409, BLOCKED)
        assert gate.status()["state"] == "observing"
        assert source.sent == []


def manual_collector_harness(path, clock, upstream, prober_upstream=None):
    store, gate = gate_for(path, clock)
    to_manual(gate, clock)
    client = httpx.AsyncClient(
        transport=GatedAsyncTransport(httpx.MockTransport(upstream), gate=gate))
    probe_client = httpx.AsyncClient(transport=httpx.MockTransport(prober_upstream or upstream))
    prober = RiskProber(store, gate, probe_client, reply_page_pacer=ReplyPagePacer(sleep=no_wait))
    collector = Collector(store, client, clock=clock, risk=gate, probe=prober,
                          cadence=lambda: CADENCE, page_check_seconds=0)
    return store, gate, client, probe_client, collector


async def no_wait(seconds):
    return None


async def tick(clock, seconds=CADENCE):
    before = len(clock.deadlines)
    clock.advance(clock.value + seconds)
    await eventually(lambda: len(clock.deadlines) > before)


async def first_tick(clock):
    before = len(clock.deadlines)
    await eventually(lambda: len(clock.deadlines) > before)


def facts_of(path):
    store = Store(path)
    store.migrate()
    return store.risk_probe_facts()


def expected_round(path, trigger="opus_page"):
    return ordered_types(required_types(facts_of(path)), trigger)


def test_registered_manual_probe_runs_once_under_the_collector_and_stays_manual_on_failure(tmp_path):
    path = tmp_path / "manual-failure.sqlite"
    configured(path)
    clock = ControlledClock()
    source = Source()
    source.risky = {"opus_page"}
    store, gate, client, probe_client, collector = manual_collector_harness(
        path, clock, source)
    expected = expected_round(path)
    assert expected[0] == "opus_page"
    before = {
        "checks": store.read_checks(UID),
        "archive": store.read_archive("123"),
        "notifications": store.read_notification_switch(),
    }
    # API 登记（管理入口）之后采集进程才领取；登记本身不发请求。
    assert asyncio.run(gate.request_probe())["manual"]["probe_registered"] is True
    assert source.sent == []

    async def scenario():
        async with client, probe_client:
            running = asyncio.create_task(collector.run())
            try:
                await first_tick(clock)
                await eventually(lambda: gate.status()["state"] == "manual"
                                 and not gate.status()["manual"]["probe_registered"])
                await asyncio.sleep(0.05)
                # 人工轮只执行一轮：失败后保持人工态与第六档，不再自动叠加。
                status = gate.status()
                assert status["state"] == "manual"
                assert status["backoff_step"] == 6
                assert status["next_probe_at"] is None
                assert status["manual"]["probe_registered"] is False
                # 全部必需类型仍被冻结验证，首类失败后短路。
                results = status["probe"]["results"]
                assert [item["endpoint_type"] for item in results] == expected
                assert results[0]["status"] == "failed"
                assert results[0]["reason"] == "source_risk"
                assert all(item["status"] == "pending" for item in results[1:])
                sent = list(source.sent)
                assert sent.count("opus_page") == 1
                assert source.sent.count(expected[1]) == 0
                # 被保护的人工态继续暂停：再等几拍也不会自动发第二轮。
                for _ in range(3):
                    await tick(clock)
                assert source.sent == sent
                status = gate.status()
                assert status["state"] == "manual"
                assert status["manual"]["probe_registered"] is False
            finally:
                running.cancel()
                try:
                    await running
                except asyncio.CancelledError:
                    pass

    with captured_events() as records:
        asyncio.run(scenario())
    # 探测没有推进归档、检查成功时间或通知基线，也不产生业务通知。
    assert store.read_checks(UID) == before["checks"]
    assert store.read_archive("123") == before["archive"]
    assert store.read_notification_switch() == before["notifications"]
    # 日志关联到原风控代次、探测轮次与档位，不泄漏内部领取令牌。
    claimed = events(records, "risk_probe_claimed")
    finished = events(records, "risk_probe_round_finished")
    assert len(claimed) == 1 and "probe_origin=manual" in claimed[0]
    assert len(finished) == 1
    assert "passed=false" in finished[0] and "risk_state=manual" in finished[0]
    assert "backoff_step=6" in finished[0]
    assert "probe_round_id=" in finished[0] and "probe_round_id=none" not in finished[0]
    joined = "\n".join(records)
    assert "owner" not in joined and "lease" not in joined
    assert not re.search(r"\b[0-9a-f]{32}\b", joined)


def test_manual_probe_success_enters_observation_and_old_owner_cannot_revert_it(tmp_path):
    path = tmp_path / "manual-fencing.sqlite"
    clock = ControlledClock()
    _, gate = gate_for(path, clock)
    to_manual(gate, clock)
    assert asyncio.run(gate.request_probe())["manual"]["probe_registered"] is True

    claim = asyncio.run(gate.claim_probe(["opus_page", "replies"]))
    assert claim["origin"] == "manual"
    # 登记已被本轮消费：租约内不能再领取出第二轮。
    assert gate.status()["manual"]["probe_registered"] is False
    assert asyncio.run(gate.claim_probe(["opus_page"])) is None

    # 崩溃后租约到期才可接管；接管重新确认类型且保留人工来源。
    clock.advance(clock.value + PROBE_LEASE_SECONDS + 1)
    takeover = asyncio.run(gate.claim_probe(["opus_page"]))
    assert takeover is not None and takeover["round"] != claim["round"]
    assert takeover["origin"] == "manual"
    assert takeover["types"] == ["opus_page"]

    # 旧 owner 的结果与结束被 owner＋轮次 fencing 拒绝，不能回退新轮次。
    assert asyncio.run(gate.record_probe(
        claim, {"endpoint_type": "opus_page", "status": "passed"})) is False
    assert asyncio.run(gate.finish_probe(claim, True)) is None
    assert asyncio.run(gate.finish_probe(claim, False)) is None
    status = gate.status()
    assert status["state"] == "probing"
    assert status["probe"]["round"] == takeover["round"]
    assert status["probe"]["results"] == [{"endpoint_type": "opus_page", "status": "pending"}]

    # 新 owner 全部通过：进入同一观察期并保留档位（人工态也保留到稳定恢复）。
    assert asyncio.run(gate.record_probe(
        takeover, {"endpoint_type": "opus_page", "status": "passed", "http_status": 200})) is True
    status = asyncio.run(gate.finish_probe(takeover, True))
    assert status["state"] == "observing"
    assert status["backoff_step"] == 6
    assert status["manual"]["probe_registered"] is False
    assert status["observation"]["active_ms"] == 0

    # 迟到的旧 owner 失败结果不能把观察态拉回人工态。
    assert asyncio.run(gate.finish_probe(claim, False)) is None
    assert gate.status()["state"] == "observing"
