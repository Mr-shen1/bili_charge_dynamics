"""04：按接口探测与六档恢复走真实 Collector 运行、真实临时 SQLite 与传输账本。"""

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.comment_client import RequestsCommentClient
from backend.bili_monitor.reply_pacing import ReplyPagePacer
from backend.bili_monitor.source_endpoints import REPLIES_URL, ROOT_COMMENTS_URL
from backend.bili_monitor.source_transport import SourcePacer
from backend.bili_monitor.risk import RiskGate, SourceRiskPaused
from backend.bili_monitor.risk_probe import RiskProber, required_types
from backend.bili_monitor.source_gate import GatedAsyncTransport, SourceReport, source_request
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client
from backend.tests.collector_clock import ControlledClock, eventually
from backend.tests.collector_support import configured, empty_upstream
from backend.tests.management_support import UID
from backend.tests.test_replies import reply_source
from backend.tests.root_support import prepare

FIXTURES = Path(__file__).parent / "fixtures"

REPLIES_ROOT = "900719925474099312346"


def kind_of(request):
    classified = source_request(request.method, request.url)
    return classified.endpoint_type if classified is not None else None


def request_for(path):
    classified = source_request("GET", f"https://api.bilibili.com{path}")
    assert classified is not None
    return classified


def state_of(path, clock):
    store = Store(path)
    store.migrate()
    return RiskGate(store, clock=clock).status()


def deadline_on_clock(status):
    from backend.bili_monitor.comment_status import epoch_from_iso
    return epoch_from_iso(status["next_probe_at"]) - epoch_from_iso(ControlledClock().now())


def snapshot(store):
    return {
        "archive": store.read_archive("123"),
        "checks": store.read_checks(UID),
        "notifications": store.read_notification_switch(),
        "media": store.read_media_owner("123"),
    }


def probe_harness(path, clock, business_handler, probe_handler=None, pacer=None):
    store = Store(path)
    store.migrate()
    gate = RiskGate(store, clock=clock)
    business = httpx.AsyncClient(
        transport=GatedAsyncTransport(httpx.MockTransport(business_handler), gate=gate))
    probe_client = httpx.AsyncClient(transport=httpx.MockTransport(probe_handler or business_handler))
    prober = RiskProber(store, gate, probe_client, reply_page_pacer=pacer)
    return store, gate, business, probe_client, prober


def count_handler(state, roots):
    def handler(request):
        state.setdefault("ledger", []).append(kind_of(request))
        if request.url.path == "/x/v2/reply/count":
            return httpx.Response(200, json={"code": 0, "data": {"count": state.get("count", 7)}})
        return roots(request)
    return handler


def archive_with_pending_work(path, state):
    """真实初始化把根／楼中楼完整归档；计数变化留给调用方用真实检查链置为待同步。"""
    roots = reply_source(state)
    with archive_client(path, count_handler(state, roots)) as client:
        prepare(client)
        assert client.post("/api/sync/initial", json={"uid": UID}).status_code == 200
        assert client.get(f"/api/archive/dynamics/123/comments/{REPLIES_ROOT}/replies").status_code == 200
        # 只读归档不会自己改工作状态；同一来源的计数变化由调用方的真实检查链制造工作。
        state["count"] = 8
        return roots


def facts_of(path, clock):
    store = Store(path)
    store.migrate()
    return store.risk_probe_facts()


def test_probe_round_covers_every_needed_type_with_minimal_gets(tmp_path):
    path = tmp_path / "probe.sqlite"
    state = {}
    roots = archive_with_pending_work(path, state)
    clock = ControlledClock()
    # 计数变化：把工作重新置为 pending（真实检查链，不手写内部表）。
    waits = recording_waits()
    store, gate, business, probe_client, prober = probe_harness(
        path, clock, count_handler(state, roots), pacer=ReplyPagePacer(sleep=waits))

    async def scenario():
        async with business, probe_client:
            collector = Collector(store, business, clock=clock, risk=gate, probe=prober)
            await collector.check_once(UID, "123")
            assert store.read_checks(UID)[0]["work"] == "pending"
            state["ledger"].clear()
            facts = await asyncio.to_thread(store.risk_probe_facts)
            required = required_types(facts)
            assert required == {"opus_page", "comment_count", "detail",
                                "root_comments", "replies"}
            with pytest.raises(SourceRiskPaused):
                await gate.report(request_for("/x/v2/reply/count"),
                                  SourceReport(status_code=412))
            before = snapshot(store)
            clock.advance(deadline_on_clock(gate.status()))
            finished = await prober.probe_if_due()
            assert finished["state"] == "observing"
            assert snapshot(store) == before

    asyncio.run(scenario())
    # 触发类型先探测，其余按固定顺序；同类多 ID／页码不产生额外类型。
    assert state["ledger"] == ["comment_count", "root_comments", "replies", "detail", "opus_page"]
    status = state_of(path, clock)
    assert [item["status"] for item in status["probe"]["results"]] == ["passed"] * 5
    assert all(item["endpoint_type"] in
               {"comment_count", "root_comments", "replies", "detail", "opus_page"}
               for item in status["probe"]["results"])
    assert all(item["http_status"] == 200 for item in status["probe"]["results"])
    # 楼中楼探测同样缴纳页后等待（100ms），其余类型不额外等待。
    replies = next(item for item in status["probe"]["results"]
                   if item["endpoint_type"] == "replies")
    assert replies["wait_ms"] == 100
    assert waits.waits == [0.1]
    # 没有暗补预热：探测集合之外的类型一个请求都没有。
    assert "homepage_warmup" not in state["ledger"] and "space_warmup" not in state["ledger"]


class recording_waits:
    """记录楼中楼页后等待，不真正睡 100ms；与既有 0.3—0.4s 楼级等待替身分开。"""

    def __init__(self):
        self.waits = []

    async def __call__(self, seconds):
        self.waits.append(seconds)
        await asyncio.sleep(0)


def test_invalid_200_or_risk_response_short_circuits_and_advances_exactly_one_step(tmp_path):
    for label, failing in (("risk", "risk"), ("business", "business")):
        path = tmp_path / f"probe-{label}.sqlite"
        state = {}
        roots = archive_with_pending_work(path, state)
        clock = ControlledClock()

        def probe(request):
            kind = kind_of(request)
            state.setdefault("probe_ledger", []).append(kind)
            if kind == "replies":
                if failing == "risk":
                    return httpx.Response(429, text="", headers={"retry-after": "0"})
                payload = json.loads(json.dumps({"code": -412, "message": "FICTIONAL"}))
                return httpx.Response(200, json=payload)
            return count_handler(state, roots)(request)

        store, gate, business, probe_client, prober = probe_harness(
            path, clock, count_handler(state, roots), probe)

        async def scenario():
            async with business, probe_client:
                collector = Collector(store, business, clock=clock, risk=gate, probe=prober)
                await collector.check_once(UID, "123")
                with pytest.raises(SourceRiskPaused):
                    await gate.report(request_for("/x/v2/reply/count"), SourceReport(status_code=412))
                before = snapshot(store)
                clock.advance(deadline_on_clock(gate.status()))
                finished = await prober.probe_if_due()
                assert finished["state"] == "cooldown"
                assert finished["backoff_step"] == 2
                assert snapshot(store) == before

        asyncio.run(scenario())
        # 失败后其余类型不再请求：detail / opus_page 没有发出。
        assert state["probe_ledger"] == ["comment_count", "root_comments", "replies"]
        status = state_of(path, clock)
        results = {item["endpoint_type"]: item for item in status["probe"]["results"]}
        assert [results[kind]["status"] for kind in
                ("comment_count", "root_comments", "replies", "detail", "opus_page")] == [
            "passed", "passed", "failed", "pending", "pending"]
        assert results["comment_count"]["http_status"] == 200
        assert results["replies"]["http_status"] == (429 if failing == "risk" else None)
        assert results["replies"]["reason"] == (
            "source_risk" if failing == "risk" else "source_rejected")
        # 下一档时间是标准第二档（服务端 Retry-After=0 不比本地期限长）。
        assert (deadline_on_clock(status)) == clock.value + 120


def test_missing_local_sample_is_unconfirmed_not_a_fake_pass(tmp_path):
    path = tmp_path / "probe-missing.sqlite"
    state = {}
    roots = archive_with_pending_work(path, state)
    clock = ControlledClock()
    store, gate, business, probe_client, prober = probe_harness(
        path, clock, count_handler(state, roots))
    state["ledger"].clear()

    async def scenario():
        async with business, probe_client:
            # 触发类型是动态发现，但当前没有启用 recent 监控：本地没有可验证样本。
            with pytest.raises(SourceRiskPaused):
                await gate.report(request_for("/x/polymer/web-dynamic/v1/feed/space"),
                                  SourceReport(status_code=412))
            clock.advance(deadline_on_clock(gate.status()))
            finished = await prober.probe_if_due()
            assert finished["state"] == "cooldown"
            assert finished["backoff_step"] == 2

    asyncio.run(scenario())
    status = state_of(path, clock)
    results = status["probe"]["results"]
    assert results[0] == {
        "endpoint_type": "feed", "status": "failed", "http_status": None,
        "reason": "sample_missing", "elapsed_ms": results[0]["elapsed_ms"],
        "wait_ms": None, "uid": None, "dynamic_id": None, "root_id": None,
    }
    assert results[1]["endpoint_type"] == "comment_count"
    assert results[2]["endpoint_type"] == "opus_page"
    assert [item["status"] for item in results[1:]] == ["pending", "pending"]
    # 没有样本就不发请求：不把 404 或不存在的页面当成接口恢复。
    assert state["ledger"] == []


def test_collector_run_probes_at_each_deadline_and_resumes_abandoned_work(tmp_path):
    path = tmp_path / "collector-probe.sqlite"
    configured(path)
    store = Store(path)
    clock = ControlledClock()
    state = {"arm": True}
    ledger = []

    def upstream(request):
        ledger.append(kind_of(request))
        if state["arm"] and request.url.path == "/x/v2/reply":
            return httpx.Response(412, text="")
        return empty_upstream(request)

    async def tick():
        before = len(clock.deadlines)
        clock.advance(clock.value + 15)
        await eventually(lambda: len(clock.deadlines) > before)

    async def settled_ledger():
        previous = len(ledger)
        for _ in range(40):
            await asyncio.sleep(0.02)
            if len(ledger) == previous:
                return previous
            previous = len(ledger)
        return previous

    async def wait_ticks(predicate, tries=20):
        for _ in range(tries):
            if predicate():
                return True
            await tick()
            await asyncio.sleep(0.01)
        return predicate()

    async def scenario():
        gate = RiskGate(store, clock=clock)
        business = httpx.AsyncClient(
            transport=GatedAsyncTransport(httpx.MockTransport(upstream), gate=gate))
        probe_client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        prober = RiskProber(store, gate, probe_client,
                            reply_page_pacer=ReplyPagePacer(sleep=recording_waits()))
        async with business, probe_client:
            collector = Collector(store, business, clock=clock, risk=gate, probe=prober)
            running = asyncio.create_task(collector.run())
            try:
                await eventually(lambda: 15 in clock.deadlines)
                # 第一拍启动的检查需要真实 I/O 完成：受控时钟不能抢在它前面推进。
                assert await wait_ticks(lambda: bool(store.read_checks(UID)) and
                                        store.read_checks(UID)[0]["work"] == "pending")
                assert await wait_ticks(lambda: gate.status()["state"] == "cooldown")
                # 被暂停打断的领取保持 running：既没有失败事实，也没有伪成功时间。
                check = store.read_checks(UID)[0]
                assert check["work"] == "running"
                assert check["sync_error"] is None and check["last_succeeded_at"] is None
                # 暂停后不再有业务发送：等在途检查结算完再记探测起点。
                triggered = await settled_ledger()
                assert ledger[-1] == "root_comments"

                # 一档到期：采集主循环自己执行探测，不需要重启进程。
                state["arm"] = False
                clock.advance(deadline_on_clock(gate.status()))
                await eventually(lambda: gate.status()["state"] == "observing")
                assert ledger[triggered:triggered + 4] == [
                    "root_comments", "comment_count", "detail", "opus_page"]

                # 观察态恢复派发：先归还在途中止的领取，再从原断点继续。
                assert await wait_ticks(
                    lambda: store.read_checks(UID)[0]["work"] == "complete")
            finally:
                running.cancel()
                try:
                    await running
                except asyncio.CancelledError:
                    pass

    asyncio.run(scenario())
    archive = store.read_archive("123")
    assert archive["work"]["comments"] == archive["work"]["replies"] == "success"
    assert archive["synced_comment_count"] == 0
    # 探测只验证可用性：没有写成失败，也没有伪造成功时间。
    check = store.read_checks(UID)[0]
    assert check["sync_error"] is None


def test_required_types_only_covers_work_that_is_actually_pending(tmp_path):
    path = tmp_path / "facts.sqlite"
    state = {}
    roots = archive_with_pending_work(path, state)
    clock = ControlledClock()
    store, gate, business, probe_client, prober = probe_harness(
        path, clock, count_handler(state, roots))

    async def scenario():
        async with business, probe_client:
            await Collector(store, business, clock=clock, risk=gate).check_once(UID, "123")

    asyncio.run(scenario())
    facts = facts_of(path, clock)
    # 归档已完成，只有一次计数变化带来的评论同步工作。
    assert facts["pending_work"] is True
    assert facts["comment"]["dynamic_id"] == "123"
    assert facts["replies"]["root_id"] == REPLIES_ROOT
    assert facts["recent"] == []
    assert required_types(facts) == {
        "opus_page", "comment_count", "detail", "root_comments", "replies"}
    # 没有待执行工作时，不再为“顺手验证”加接口。
    assert required_types({**facts, "pending_work": False, "selected": []}) == set()


class _FakeRequestsResponse:
    def __init__(self, payload, url):
        self.status_code = 200
        self.content = json.dumps(payload).encode()
        self.headers = {"Content-Type": "application/json"}
        self.url = url

    def close(self):
        return None


class _FakeRequestsSession:
    """生产 Requests 会话的最薄替身：只替换线程内 I/O，保留 get() 的许可与页后等待。"""

    def __init__(self, payloads):
        self.payloads = payloads
        self.requests = []

    def get(self, url, params=None, headers=None, timeout=None):
        self.requests.append((url, params))
        return _FakeRequestsResponse(self.payloads[url], url)


class _Comments:
    def __init__(self, client):
        self._client = client

    async def client(self, uid):
        return self._client


async def _no_wait(seconds):
    return None


def test_reply_probe_goes_through_the_production_comment_session_for_one_hundred_ms(tmp_path):
    path = tmp_path / "probe-session.sqlite"
    state = {}
    roots = archive_with_pending_work(path, state)
    clock = ControlledClock()
    store = Store(path)
    store.migrate()
    gate = RiskGate(store, clock=clock)
    waits = recording_waits()
    session = _FakeRequestsSession({
        "https://api.bilibili.com/x/v2/reply/count": {"code": 0, "data": {"count": 8}},
        ROOT_COMMENTS_URL: json.loads((FIXTURES / "root-comments.json").read_text()),
        REPLIES_URL: json.loads((FIXTURES / "replies.json").read_text()),
    })
    comments_client = RequestsCommentClient(
        UID, (), SourcePacer(sleep=_no_wait),
        reply_page_pacer=ReplyPagePacer(sleep=waits))
    comments_client.session = session
    business = httpx.AsyncClient(
        transport=GatedAsyncTransport(httpx.MockTransport(count_handler(state, roots)), gate=gate))
    probe_client = httpx.AsyncClient(transport=httpx.MockTransport(count_handler(state, roots)))
    prober = RiskProber(store, gate, probe_client, comments=_Comments(comments_client))
    state["ledger"].clear()

    async def scenario():
        async with business, probe_client:
            await Collector(store, business, clock=clock, risk=gate).check_once(UID, "123")
            with pytest.raises(SourceRiskPaused):
                await gate.report(request_for("/x/v2/reply/reply"), SourceReport(status_code=412))
            state["ledger"].clear()
            clock.advance(deadline_on_clock(gate.status()))
            finished = await prober.probe_if_due()
            assert finished["state"] == "observing"

    asyncio.run(scenario())
    # 评论类型的探测走生产会话：计数、根页、楼中楼各一次，没有第二个等待层。
    assert [url for url, _ in session.requests] == [
        REPLIES_URL, "https://api.bilibili.com/x/v2/reply/count", ROOT_COMMENTS_URL]
    assert waits.waits == [0.1]
    assert comments_client.last_reply_page.wait_ms == 100
    status = state_of(path, clock)
    results = {item["endpoint_type"]: item for item in status["probe"]["results"]}
    assert results["replies"]["wait_ms"] == 100
    assert all(item["status"] == "passed" for item in status["probe"]["results"])
    # 探测没有暗补预热：会话上只有这三类评论请求。
    assert all("homepage" not in url and "space.bilibili.com" not in url
               for url, _ in session.requests)
