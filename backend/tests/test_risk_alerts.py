"""09：风控生命周期系统告警 —— 真实状态转换登记、系统群投递、开关与去重。

真实 SQLite、真实 `RiskGate` 状态机、真实 `Collector` 检查入口与真实 `Dispatcher`
领取／回写；只替换 B 站与飞书 HTTP 传输和时间来源。告警只发系统群，逐页／逐接口
细节留在结构化日志，不产生业务通知。
"""

import asyncio
import sqlite3

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app
from backend.bili_monitor.collector import Collector
from backend.bili_monitor.comment_status import epoch_from_iso
from backend.bili_monitor.notifications import Dispatcher
from backend.bili_monitor.notifications.outbox import ALERT_COOLDOWN_SECONDS
from backend.bili_monitor.risk import (
    COOLDOWN_STEPS, OBSERVATION_SECONDS, PROBE_LEASE_SECONDS, RiskGate, SourceRiskPaused,
)
from backend.bili_monitor.source_gate import GatedAsyncTransport, SourceReport, source_request
from backend.bili_monitor.storage import Store
from backend.tests.collector_support import configured, empty_upstream
from backend.tests.management_support import BASE, UID, profile_response
from backend.tests.notification_support import (
    ALL_WEBHOOK, WEBHOOK, BeijingClock, Receiver, config, events, message_text, query,
)
from backend.tests.test_notification_alerts import CollectorLog
from backend.tests.test_notification_delivery import archived_changes
from backend.tests.test_notification_gate import more_changes
from backend.tests.root_support import TARGETS


SYSTEM_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/fake-system-alert-token"
DYNAMIC = "123"


def switch(path, state):
    store = Store(path)
    store.migrate()
    store.update_notification_switch(state)


def gate_for(path, clock):
    """生产 `RiskGate` 只替换“现在”；状态仍全部来自同一个临时 SQLite。"""
    store = Store(path)
    store.migrate()
    return store, RiskGate(store, clock=clock.collector)


def request_for(path="/x/v2/reply/reply"):
    classified = source_request("GET", f"https://api.bilibili.com{path}")
    assert classified is not None
    return classified


def trigger(gate, status_code=412):
    """一次真实风控响应：经唯一报告入口落库，并中止当前调用链。"""
    try:
        asyncio.run(gate.report(request_for(), SourceReport(status_code=status_code)))
    except SourceRiskPaused:
        return True
    return False


def business(gate):
    """一次真实成功业务请求：观察期只认这类请求，预热与普通错误不算。"""
    asyncio.run(gate.report(request_for("/x/v2/reply"), SourceReport(status_code=200)))


def due(gate, clock):
    """受控时钟推进到本轮探测期限：只推进时间，不手写状态。"""
    clock.advance(epoch_from_iso(gate.status()["next_probe_at"]) - clock.now())


def probe(gate, clock, *, passed, types=("replies",)):
    due(gate, clock)
    claim = asyncio.run(gate.claim_probe(list(types)))
    assert claim is not None
    for kind in types:
        assert asyncio.run(gate.record_probe(
            claim, {"endpoint_type": kind, "status": "passed" if passed else "failed"}))
    return asyncio.run(gate.finish_probe(claim, passed))


def observing(gate, clock):
    """用真实转移进观察态：第一档到期限探测通过。"""
    assert trigger(gate) is True
    status = probe(gate, clock, passed=True)
    assert status["state"] == "observing"
    return status


def tick(gate, clock, seconds):
    """采集节拍：时钟前进与心跳同一区间，和真实采集进程一样两者不分离。"""
    clock.advance(seconds)
    return asyncio.run(gate.observing_tick(seconds))


def manual_probe(gate, *, passed, types=("replies",)):
    """人工态：登记一轮 → 唯一 owner 领取 → 提交结果；失败仍停在人工态。"""
    assert asyncio.run(gate.request_probe()) is not None
    claim = asyncio.run(gate.claim_probe(list(types)))
    assert claim is not None
    for kind in types:
        assert asyncio.run(gate.record_probe(
            claim, {"endpoint_type": kind, "status": "passed" if passed else "failed"}))
    return asyncio.run(gate.finish_probe(claim, passed))


def labels(receiver):
    return [message_text(payload).splitlines()[0] for payload in receiver.payloads]


def deliver(path, receiver, clock, **sections):
    """真实通知领取／回写路径，飞书传输是进程内替身；跑到队列空为止。

    不推进受控时钟：告警不多于一个批量，不需要为限速顺延；这样消息里的发生时间
    只由风控状态转移决定，不被投递轮询污染。
    """
    sections.setdefault("system", SYSTEM_WEBHOOK)

    async def run():
        notifier = Dispatcher(Store(path), config(**sections),
                              transport=httpx.MockTransport(receiver), clock=clock)
        try:
            for _ in range(20):
                if not await notifier.tick():
                    return
        finally:
            await notifier.aclose()

    asyncio.run(run())


def test_first_trigger_registers_one_alert_for_the_system_group(tmp_path):
    path = tmp_path / "risk-alerts.sqlite"
    clock = BeijingClock.start(13, 0, 0)
    switch(path, "system_only")
    _, gate = gate_for(path, clock)
    receiver = Receiver()

    assert trigger(gate) is True
    deliver(path, receiver, clock)

    # 只发系统群；一次触发只有一条消息，逐页／逐接口细节不进群。
    assert [request["url"] for request in receiver.requests] == [SYSTEM_WEBHOOK]
    assert message_text(receiver.payloads[0]).splitlines() == [
        "告警【来源风控触发】",
        "对象：source_risk",
        "发生时间：2026-10-09 13:00:00",
        "原因：来源触发风控保护，已在冷却中",
        "同类同对象 30 分钟内最多提醒一次",
    ]


def test_recovery_alert_only_after_ten_stable_minutes_of_real_collection(tmp_path):
    path = tmp_path / "recovery.sqlite"
    clock = BeijingClock.start(13, 0, 0)
    switch(path, "system_only")
    _, gate = gate_for(path, clock)
    receiver = Receiver()

    observing(gate, clock)
    deliver(path, receiver, clock)
    # 探测刚通过只是进入观察期，还没有稳定恢复。
    assert [message_text(payload).splitlines()[0] for payload in receiver.payloads] == [
        "告警【来源风控触发】"]

    business(gate)
    assert tick(gate, clock, 599)["state"] == "observing"
    deliver(path, receiver, clock)
    assert len(receiver.payloads) == 1

    business(gate)
    assert tick(gate, clock, 1)["state"] == "normal"
    deliver(path, receiver, clock)
    # 稳定恢复是独立事实：未被 13:00 的触发告警节流吸收。
    assert [message_text(payload).splitlines()[:4] for payload in receiver.payloads[1:]] == [[
        "告警【来源风控已恢复】",
        "对象：source_risk",
        "发生时间：2026-10-09 13:11:00",
        "原因：连续正常采集后已稳定恢复",
    ]]


def test_exhausted_automatic_recovery_registers_one_manual_alert(tmp_path):
    path = tmp_path / "manual.sqlite"
    clock = BeijingClock.start(13, 0, 0)
    switch(path, "system_only")
    _, gate = gate_for(path, clock)
    receiver = Receiver()

    assert trigger(gate) is True
    for _ in range(len(COOLDOWN_STEPS)):
        status = probe(gate, clock, passed=False)
    assert status["state"] == "manual"

    deliver(path, receiver, clock)
    # 六档等待与六轮失败只进日志：系统群只收“触发”与“转人工”两条。
    assert labels(receiver) == ["告警【来源风控触发】", "告警【来源风控转人工】"]
    assert message_text(receiver.payloads[1]).splitlines()[1:4] == [
        "对象：source_risk",
        "发生时间：2026-10-09 14:00:00",
        "原因：自动恢复耗尽，等待人工探测",
    ]

    # 人工轮失败仍停在人工态：不是新的生命周期事实，不重复告警。
    assert manual_probe(gate, passed=False)["state"] == "manual"
    deliver(path, receiver, clock)
    assert len(receiver.payloads) == 2

    # 重复登记同一人工态代次：幂等，也不产生告警。
    assert asyncio.run(gate.request_probe()) is not None
    assert asyncio.run(gate.request_probe()) is not None
    deliver(path, receiver, clock)
    assert len(receiver.payloads) == 2


def test_observing_trigger_after_the_last_step_registers_only_the_manual_alert(tmp_path):
    path = tmp_path / "sixth.sqlite"
    clock = BeijingClock.start(13, 0, 0)
    switch(path, "system_only")
    _, gate = gate_for(path, clock)
    receiver = Receiver()

    assert trigger(gate) is True
    for _ in range(len(COOLDOWN_STEPS) - 1):
        assert probe(gate, clock, passed=False)["state"] == "cooldown"
    assert probe(gate, clock, passed=True)["state"] == "observing"

    # 第 6 档后观察期再次触发：直接转人工，这次转移只登记“转人工”一个事实。
    assert trigger(gate, status_code=429) is True
    deliver(path, receiver, clock)
    assert labels(receiver) == ["告警【来源风控触发】", "告警【来源风控转人工】"]
    assert "原因：自动恢复耗尽，等待人工探测" in message_text(receiver.payloads[1])


def test_late_responses_restarts_and_repeated_triggers_merge_into_one_alert(tmp_path):
    path = tmp_path / "merge.sqlite"
    clock = BeijingClock.start(13, 0, 0)
    switch(path, "system_only")
    _, gate = gate_for(path, clock)
    receiver = Receiver()

    assert trigger(gate) is True
    # 同一代次的迟到风控响应只合并到当前状态，不推进档位也不登记新告警。
    assert trigger(gate, status_code=429) is True
    # 采集进程重启（同一临时库的新 gate）不重新产生同一事实。
    _, restarted = gate_for(path, clock)
    assert trigger(restarted) is True
    # 探测通过后观察期再被拦截：仍是“来源还在被风控”，30 分钟内合并。
    assert probe(restarted, clock, passed=True)["state"] == "observing"
    assert trigger(restarted) is True
    deliver(path, receiver, clock)
    assert labels(receiver) == ["告警【来源风控触发】"]

    # 超过节流窗口后的新触发才是新的一次提醒。
    assert probe(restarted, clock, passed=True)["state"] == "observing"
    clock.advance(ALERT_COOLDOWN_SECONDS + 1)
    assert trigger(restarted) is True
    deliver(path, receiver, clock)
    assert labels(receiver) == ["告警【来源风控触发】", "告警【来源风控触发】"]


def test_owner_takeover_and_old_owner_results_register_no_extra_alert(tmp_path):
    path = tmp_path / "takeover.sqlite"
    clock = BeijingClock.start(13, 0, 0)
    switch(path, "system_only")
    _, gate = gate_for(path, clock)
    receiver = Receiver()

    assert trigger(gate) is True
    due(gate, clock)
    stale = asyncio.run(gate.claim_probe(["replies"]))
    assert stale is not None
    # 租约内不能同时探测；租约到期后接管，旧 owner 的迟到结果与结束被拒。
    assert asyncio.run(gate.claim_probe(["replies"])) is None
    clock.advance(PROBE_LEASE_SECONDS + 1)
    fresh = asyncio.run(gate.claim_probe(["replies"]))
    assert fresh is not None
    assert asyncio.run(gate.record_probe(stale, {"endpoint_type": "replies", "status": "passed"})) is False
    assert asyncio.run(gate.finish_probe(stale, True)) is None
    assert asyncio.run(gate.record_probe(
        fresh, {"endpoint_type": "replies", "status": "failed"})) is True
    assert asyncio.run(gate.finish_probe(fresh, False))["state"] == "cooldown"

    deliver(path, receiver, clock)
    # 接管与旧 owner 迟到只影响状态机，不是新的生命周期事实。
    assert labels(receiver) == ["告警【来源风控触发】"]


class InterceptedCount:
    """计数接口返回受控风控响应；其余端点仍是既有虚构上游。"""

    def __init__(self, status_code=412):
        self.status_code = status_code
        self.sent = []

    def __call__(self, request):
        self.sent.append(source_request(request.method, request.url).endpoint_type)
        if request.url.path == "/x/v2/reply/count":
            return httpx.Response(self.status_code, text="", headers={"retry-after": "30"})
        return empty_upstream(request)


def test_a_real_check_that_meets_412_registers_the_trigger_alert(tmp_path):
    path = tmp_path / "check.sqlite"
    clock = BeijingClock.start(13, 0, 0)
    configured(path)  # 真实管理与归档装配，通知为 all
    store = Store(path)
    gate = RiskGate(store, clock=clock.collector)
    source = InterceptedCount()
    receiver = Receiver()

    async def scenario():
        async with httpx.AsyncClient(transport=GatedAsyncTransport(
                httpx.MockTransport(source), gate=gate)) as client:
            collector = Collector(store, client, clock=clock.collector, risk=gate)
            with pytest.raises(SourceRiskPaused):
                await collector.check_once(UID, DYNAMIC)

    asyncio.run(scenario())
    # 状态事实来自真实检查链遇到 HTTP 412，不依赖日志或全表扫描。
    assert gate.status()["state"] == "cooldown"
    assert source.sent[-1] == "comment_count"
    deliver(path, receiver, clock, up=WEBHOOK, full=ALL_WEBHOOK)
    assert [request["url"] for request in receiver.requests] == [SYSTEM_WEBHOOK]
    assert labels(receiver) == ["告警【来源风控触发】"]


def test_notification_off_registers_nothing_and_reopening_never_backfills(tmp_path):
    path = tmp_path / "off.sqlite"
    clock = BeijingClock.start(13, 0, 0)
    _, gate = gate_for(path, clock)  # 新库默认 off
    receiver = Receiver()

    assert trigger(gate) is True
    deliver(path, receiver, clock)
    assert receiver.requests == []
    # 风控不暗中改动通知开关。
    assert Store(path).read_notification_switch()["state"] == "off"

    # 冷却继续推进也不排队：关闭期间的生命周期事实一次都不登记。
    assert probe(gate, clock, passed=False)["state"] == "cooldown"
    deliver(path, receiver, clock)
    assert receiver.requests == []

    # 切回系统消息只收之后的新事实，不补发关闭期间错过的“触发／升级”。
    switch(path, "system_only")
    deliver(path, receiver, clock)
    assert receiver.requests == []
    assert probe(gate, clock, passed=True)["state"] == "observing"
    deliver(path, receiver, clock)
    assert receiver.requests == []  # 探测通过还不是稳定恢复
    business(gate)
    assert tick(gate, clock, OBSERVATION_SECONDS)["state"] == "normal"
    deliver(path, receiver, clock)
    assert labels(receiver) == ["告警【来源风控已恢复】"]


def test_alerts_go_only_to_the_system_group_and_leave_business_notifications_intact(tmp_path):
    path = tmp_path / "all.sqlite"
    clock = BeijingClock.start(13, 0, 0)
    archived_changes(path, ["13:02"])  # 真实归档链产生一条正文变化
    receiver = Receiver()
    rooms = {"up": WEBHOOK, "full": ALL_WEBHOOK}

    deliver(path, receiver, clock, **rooms)
    # 正文变化的业务通知照旧（UP 群）；系统群不为业务消息所用。
    assert [(request["url"]) for request in receiver.requests] == [WEBHOOK]

    _, gate = gate_for(path, clock)
    assert trigger(gate) is True
    assert probe(gate, clock, passed=True)["state"] == "observing"
    deliver(path, receiver, clock, **rooms)
    # 风控生命周期告警只进系统群；探测与观察不产生动态变化／新增评论通知。
    assert [request["url"] for request in receiver.requests[1:]] == [SYSTEM_WEBHOOK]
    assert [row["kind"] for row in events(path)] == ["dynamic_changed"]

    # 正常归档通知去重不退化：同一版本重复检查不新增消息。
    more_changes(path, ["13:02"])
    deliver(path, receiver, clock, **rooms)
    assert len(receiver.payloads) == 2


def test_failed_alert_delivery_survives_a_restart_without_reregistering(tmp_path):
    path = tmp_path / "retry.sqlite"
    clock = BeijingClock.start(13, 0, 0)
    switch(path, "system_only")
    _, gate = gate_for(path, clock)
    rejected = Receiver(responder=lambda request: httpx.Response(
        500, json={"code": 500, "msg": "FICTIONAL_SECRET_RESPONSE"}))

    assert trigger(gate) is True
    deliver(path, rejected, clock)
    # 系统群暂时不可达：告警留在发件箱，状态记固定失败分类。
    assert rejected.payloads and all(
        row["state"] == "pending" for row in query(
            path, "SELECT state FROM notification_deliveries WHERE role = 'system'"))
    assert query(path, "SELECT error FROM notification_deliveries WHERE role = 'system'")[0]["error"] == "http_error"

    # 投递进程重启后重试同一条告警：退避到期才重发，且不重复登记新的生命周期事实。
    clock.advance(5)
    receiver = Receiver()
    deliver(path, receiver, clock)
    assert labels(receiver) == ["告警【来源风控触发】"]
    assert query(path, "SELECT COUNT(*) AS total FROM notification_events WHERE kind = 'alert'"
                )[0]["total"] == 1


def test_alert_registration_failure_never_becomes_a_risk_bypass(tmp_path):
    path = tmp_path / "broken.sqlite"
    clock = BeijingClock.start(13, 0, 0)
    switch(path, "system_only")
    _, gate = gate_for(path, clock)
    with sqlite3.connect(path) as connection:
        connection.execute("DROP TABLE notification_alerts")  # 受控注入：告警事实无处可写

    captured = CollectorLog()
    try:
        assert trigger(gate) is True
    finally:
        captured.close()

    # 登记失败只丢该条告警：风控状态照常转移并保持保护，不降级放行。
    status = gate.status()
    assert (status["state"], status["backoff_step"]) == ("cooldown", 1)
    assert any(message.startswith("alert_registration_failed reason=storage_error")
               for message in captured.messages)


class ApiPageSource:
    """API 侧受控上游：资料正常，动态网页返回 HTTP 412 触发保护。"""

    def __init__(self):
        self.sent = []

    def __call__(self, request):
        self.sent.append(request.url.path)
        if request.url.path.startswith("/opus/"):
            return httpx.Response(412, text="")
        return profile_response(request)


def test_a_real_api_operation_that_meets_412_registers_the_alert_for_the_notifier(tmp_path):
    path = tmp_path / "api.sqlite"
    clock = BeijingClock.start(13, 0, 0)
    switch(path, "system_only")
    source = ApiPageSource()
    receiver = Receiver()

    with TestClient(create_app(path, profile_transport=httpx.MockTransport(source),
                              risk_clock=clock.collector)) as client:
        assert client.post(BASE, json={"uid": UID}).status_code == 201
        # API 进程里的一次真实操作遇到 412：它自己不投递，只把事实写进共享发件箱。
        triggered = client.post(TARGETS, json={"id": DYNAMIC})
        assert (triggered.status_code, triggered.json()["error"]["code"]) == (503, "SOURCE_RISK_PAUSED")

    deliver(path, receiver, clock)
    assert labels(receiver) == ["告警【来源风控触发】"]
    assert message_text(receiver.payloads[0]).splitlines()[2] == "发生时间：2026-10-09 13:00:00"
