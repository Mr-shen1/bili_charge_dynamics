"""05：真实采集循环里的观察期累积、空闲边界与重启重新累计。

走生产 `Collector.run` 固定节拍、真实临时 SQLite、真实检查链与传输账本，只替换外部
来源与时间：观察进度只能来自确有成功业务请求的活跃节拍。
"""

import asyncio

import httpx

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.risk import OBSERVATION_SECONDS, RiskGate, SourceRiskPaused
from backend.bili_monitor.source_gate import (
    GatedAsyncClient, GatedAsyncTransport, SourceReport, source_request,
)
from backend.bili_monitor.storage import Store
from backend.tests.collector_clock import ControlledClock, eventually
from backend.tests.collector_support import configured, empty_upstream
from backend.tests.management_support import UID
from backend.tests.test_notification_alerts import alerts


# 一个心跳代表的最大活跃时间：观察进度按采集节拍提交，不被长停顿放大。
CADENCE = 300.0


def kind_of(request):
    classified = source_request(request.method, request.url)
    return classified.endpoint_type if classified is not None else None


def request_for(path="/x/v2/reply/reply"):
    classified = source_request("GET", f"https://api.bilibili.com{path}")
    assert classified is not None
    return classified


def observing(path, clock, step=1):
    """真实状态转移把保护推进到第 `step` 档探测通过后的观察态。"""
    store = Store(path)
    store.migrate()
    gate = RiskGate(store, clock=clock)
    try:
        asyncio.run(gate.report(request_for(), SourceReport(status_code=412)))
    except SourceRiskPaused:
        pass
    while gate.status()["backoff_step"] != step:
        clock.advance(clock.value + 1_000_000)
        claim = asyncio.run(gate.claim_probe(["replies"]))
        assert claim is not None
        asyncio.run(gate.record_probe(claim, {"endpoint_type": "replies", "status": "failed"}))
        asyncio.run(gate.finish_probe(claim, False))
    clock.advance(clock.value + 1_000_000)
    claim = asyncio.run(gate.claim_probe(["replies"]))
    assert claim is not None
    assert asyncio.run(gate.record_probe(
        claim, {"endpoint_type": "replies", "status": "passed"})) is True
    status = asyncio.run(gate.finish_probe(claim, True))
    assert status["state"] == "observing"
    return store, gate


def harness(path, clock, upstream, cadence=CADENCE, page_check_seconds=0):
    store, gate = observing(path, clock)
    client = GatedAsyncClient(
        transport=GatedAsyncTransport(httpx.MockTransport(upstream), gate=gate), gate=gate)
    collector = Collector(store, client, clock=clock, risk=gate,
                          cadence=lambda: cadence, page_check_seconds=page_check_seconds)
    return store, gate, client, collector


async def tick(clock, seconds=CADENCE):
    before = len(clock.deadlines)
    clock.advance(clock.value + seconds)
    await eventually(lambda: len(clock.deadlines) > before)


async def first_tick(clock):
    """等采集循环进入第一次固定节拍等待（此时观察基线已建立）。"""
    before = len(clock.deadlines)
    await eventually(lambda: len(clock.deadlines) > before)


def test_collector_clears_observation_after_ten_active_minutes_of_real_collection(tmp_path):
    path = tmp_path / "observe-collector.sqlite"
    configured(path)
    clock = ControlledClock()
    sent = []

    def upstream(request):
        sent.append(request.url.path)
        return empty_upstream(request)

    # 逐秒推进：观察进度按真实节拍累计，边界可以精确落在 10 分钟。
    store, gate, client, collector = harness(path, clock, upstream, cadence=1.0)

    async def scenario():
        async with client:
            running = asyncio.create_task(collector.run())
            try:
                await first_tick(clock)
                await eventually(lambda: bool(store.read_checks(UID)[0]["last_checked_at"]))
                # 观察期照常派发：检查工作推进到完成，没有额外降速或暂停。
                for _ in range(120):
                    if store.read_checks(UID)[0]["work"] == "complete":
                        break
                    await tick(clock, 1.0)
                assert store.read_checks(UID)[0]["work"] == "complete"
                status = gate.status()
                assert status["state"] == "observing"
                assert status["backoff_step"] == 1

                # 连续成功采集：9 分 59 秒仍在观察，档位未清零。
                for _ in range(1500):
                    status = gate.status()
                    if (status["state"] == "observing"
                            and status["observation"]["active_ms"] >= 599_000):
                        break
                    await tick(clock, 1.0)
                else:
                    raise AssertionError("Observation window did not accrue")
                assert status["state"] == "observing"
                assert status["backoff_step"] == 1
                assert status["observation"]["successes"] > 1

                # 满 10 分钟才回到 normal 并清零档位。
                for _ in range(60):
                    if gate.status()["state"] == "normal":
                        break
                    await tick(clock, 1.0)
                status = gate.status()
                assert status["state"] == "normal"
                assert status["backoff_step"] == 0
                assert status["observation"]["active_ms"] == 0
                assert status["observation"]["required_ms"] == int(OBSERVATION_SECONDS * 1000)
                # 稳定后继续正常采集：仍在发送业务请求。
                settled = len(sent)
                for _ in range(10):
                    await tick(clock, 1.0)
                    await asyncio.sleep(0.01)
                    if len(sent) > settled:
                        break
                assert len(sent) > settled
            finally:
                running.cancel()
                try:
                    await running
                except asyncio.CancelledError:
                    pass

    asyncio.run(scenario())
    assert store.read_checks(UID)[0]["work"] == "complete"


def test_business_rejection_on_comment_endpoints_never_counts_as_recovery(tmp_path):
    """回归：HTTP 200 + `code=-352` 的评论拒绝不推进观察期，也不发“稳定恢复”告警。

    观察期只认业务解析／资源校验成功的事实：传输层 2xx、错误页或跳转都不算。这里让
    评论接口持续业务拒绝 12 分钟，观察进度必须停住；恢复真实成功后仍可正常清零。
    """
    path = tmp_path / "rejected-collector.sqlite"
    configured(path)
    clock = ControlledClock()
    state = {"reject": False}
    ledger = []

    def upstream(request):
        kind = kind_of(request)
        ledger.append(kind)
        if state["reject"] and kind in ("comment_count", "root_comments", "replies"):
            return httpx.Response(200, json={"code": -352, "message": "FICTIONAL"})
        return empty_upstream(request)

    # 页面信号不在观察窗口内到期：这段窗口只允许评论接口流量；一拍代表 30 秒活跃采集。
    store, gate, client, collector = harness(path, clock, upstream, cadence=30.0,
                                             page_check_seconds=3600)

    async def scenario():
        async with client:
            running = asyncio.create_task(collector.run())
            try:
                await first_tick(clock)
                await eventually(lambda: bool(store.read_checks(UID)[0]["last_checked_at"]))
                # 第一轮是真实成功采集：观察期凭已解析的业务请求推进。
                for _ in range(20):
                    if store.read_checks(UID)[0]["work"] == "complete":
                        break
                    await tick(clock, 30.0)
                assert store.read_checks(UID)[0]["work"] == "complete"
                baseline = gate.status()["observation"]["active_ms"]
                assert baseline > 0

                # 评论接口改成业务拒绝：12 分钟都不推进，也不清零、不告警。
                state["reject"] = True
                # 在途的真实成功检查先结算完，再取观察进度基线：这之后的 12 分钟只有业务拒绝。
                await tick(clock, 30.0)
                await tick(clock, 30.0)
                baseline = gate.status()["observation"]["active_ms"]
                ledger.clear()
                for _ in range(24):
                    await tick(clock, 30.0)
                status = gate.status()
                assert status["state"] == "observing"
                assert status["backoff_step"] == 1
                assert status["observation"]["active_ms"] == baseline
                assert "comment_count" in ledger
                reasons = [row["snapshot"]["reason"] for row in alerts(path)]
                assert "risk_stable" not in reasons

                # 真实业务成功仍在同一观察期清零档位。
                state["reject"] = False
                for _ in range(80):
                    if gate.status()["state"] == "normal":
                        break
                    await tick(clock, 30.0)
                status = gate.status()
                assert status["state"] == "normal" and status["backoff_step"] == 0
            finally:
                running.cancel()
                try:
                    await running
                except asyncio.CancelledError:
                    pass

    asyncio.run(scenario())
    reasons = [row["snapshot"]["reason"] for row in alerts(path)]
    assert "risk_stable" in reasons


def test_collector_does_not_discount_idle_observation_time(tmp_path):
    path = tmp_path / "idle-collector.sqlite"
    Store(path).migrate()  # 没有任何监控目标：采集进程只会空转，不发来源请求。
    clock = ControlledClock()
    sent = []

    def upstream(request):
        sent.append(request.url.path)
        return empty_upstream(request)

    store, gate, client, collector = harness(path, clock, upstream)

    async def scenario():
        async with client:
            running = asyncio.create_task(collector.run())
            try:
                await first_tick(clock)
                for _ in range(4):
                    await tick(clock)
                status = gate.status()
                # 十分钟空闲时间不抵扣观察期：没有任何成功业务请求。
                assert status["state"] == "observing"
                assert status["observation"]["active_ms"] == 0
                assert status["observation"]["successes"] == 0
                assert sent == []
            finally:
                running.cancel()
                try:
                    await running
                except asyncio.CancelledError:
                    pass

    asyncio.run(scenario())


def test_collector_restart_restarts_observation_accumulation_but_keeps_the_step(tmp_path):
    path = tmp_path / "restart-collector.sqlite"
    configured(path)
    clock = ControlledClock()

    def upstream(request):
        return empty_upstream(request)

    store, gate, client, collector = harness(path, clock, upstream)

    async def first_run():
        async with client:
            running = asyncio.create_task(collector.run())
            try:
                await first_tick(clock)
                # 第一拍的真实检查先落库，再推进时钟，避免把已完成请求算到下一拍。
                await eventually(lambda: bool(store.read_checks(UID)[0]["last_checked_at"]))
                await tick(clock)
                await eventually(
                    lambda: gate.status()["observation"]["active_ms"] == int(CADENCE * 1000))
            finally:
                running.cancel()
                try:
                    await running
                except asyncio.CancelledError:
                    pass

    asyncio.run(first_run())
    assert gate.status()["observation"]["active_ms"] == int(CADENCE * 1000)

    async def second_run():
        # 新进程：同一 SQLite、新的 gate 与采集循环。
        restarted = RiskGate(store, clock=clock)
        client = httpx.AsyncClient(
            transport=GatedAsyncTransport(httpx.MockTransport(upstream), gate=restarted))
        collector = Collector(store, client, clock=clock, risk=restarted,
                              cadence=lambda: CADENCE, page_check_seconds=0)
        async with client:
            running = asyncio.create_task(collector.run())
            try:
                await first_tick(clock)
                status = restarted.status()
                assert status["state"] == "observing"
                assert status["backoff_step"] == 1
                # 停机与重启的时间不抵扣：观察期从零重新累计。
                assert status["observation"]["active_ms"] == 0
                assert status["observation"]["successes"] == 0
            finally:
                running.cancel()
                try:
                    await running
                except asyncio.CancelledError:
                    pass

    asyncio.run(second_run())
