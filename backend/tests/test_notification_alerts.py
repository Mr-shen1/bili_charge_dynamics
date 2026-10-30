"""08：系统告警闭环 —— 五类真实故障 → 持久系统群，节流、合并与不递归。

真实 SQLite、真实采集/归档/通知模块；只替换 B 站与飞书 HTTP 传输和时间来源。
凭据、身份、动态与正文全部是虚构值。
"""

import asyncio
import json
import logging
import sqlite3

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.notifications import Dispatcher
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client
from backend.tests.collector_support import configured, open_notifications
from backend.tests.management_support import BASE, UID, enable
from backend.tests.notification_support import (
    ALL_WEBHOOK, WEBHOOK, BeijingClock, Receiver, assert_no_credentials, config, message_text, query,
)
from backend.tests.root_notification_support import (
    Source as CommentSource, configure as configure_source, reply_item, root_comment,
)

DYNAMIC = "123"
SYSTEM_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/fake-system-alert-token"
# 与 09 心跳共用同一个受控时钟与采集侧适配器（原先两处各写一份相同的实现）。
Clock = BeijingClock


def alerts(path):
    rows = query(path, """SELECT a.category AS category, a.object AS object, a.last_alert_at,
        a.event_id, d.role, d.state, d.error, d.attempts, d.failures, d.expires_at,
        e.kind, e.uid, e.dynamic_id, e.version, e.snapshot
        FROM notification_alerts a JOIN notification_events e ON e.id = a.event_id
        LEFT JOIN notification_deliveries d ON d.event_id = e.id ORDER BY e.id""")
    for row in rows:
        row["snapshot"] = json.loads(row["snapshot"])
    return rows


def alert_events(path):
    return query(path, "SELECT * FROM notification_events WHERE kind = 'alert' ORDER BY id")


def dispatcher(path, receiver, clock, **sections):
    sections.setdefault("system", SYSTEM_WEBHOOK)
    return Dispatcher(Store(path), config(**sections), transport=httpx.MockTransport(receiver), clock=clock)


class RejectingCountSource(CommentSource):
    """评论区计数接口返回受控业务码；其他端点仍是真实受控来源。"""

    def __init__(self, code, *, count=0):
        super().__init__()
        self.code = code
        self.add(DYNAMIC, [], count=count)

    def __call__(self, request):
        if request.url.path == "/x/v2/reply/count":
            return httpx.Response(200, json={"code": self.code})
        return super().__call__(request)


async def check_async(path, source, clock, *, credentials_configured, sync=False, dynamic=DYNAMIC):
    async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
        collector = Collector(Store(path), client, clock=clock.collector,
                              credentials_configured=credentials_configured)
        await collector.check_once(UID, dynamic)
        if sync:
            await collector.execute_pending()


def run_check(path, source, clock, *, credentials_configured, sync=False, dynamic=DYNAMIC):
    asyncio.run(check_async(path, source, clock, credentials_configured=credentials_configured,
                            sync=sync, dynamic=dynamic))


def test_rejected_credentials_alert_only_when_credentials_were_configured(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)
    clock = Clock.start(13, 40, 7)
    receiver = Receiver()

    run_check(path, RejectingCountSource(-101), clock, credentials_configured=True)

    saved = alerts(path)
    assert [(row["category"], row["object"], row["role"], row["state"]) for row in saved] == [
        ("credential", "source_credential", "system", "pending")]
    assert saved[0]["snapshot"]["reason"] == "credential_rejected"
    assert saved[0]["expires_at"] is None  # 告警不套用心跳有效期

    async def deliver():
        notifier = dispatcher(path, receiver, clock)
        try:
            await notifier.tick()
        finally:
            await notifier.aclose()

    asyncio.run(deliver())
    # 只发系统群：业务群收不到运维告警。
    assert {request["url"] for request in receiver.requests} == {SYSTEM_WEBHOOK}
    assert message_text(receiver.payloads[0]).splitlines() == [
        "告警【来源凭据失效】",
        "对象：source_credential",
        "发生时间：2026-10-09 13:40:07",
        "原因：来源凭据被拒绝",
        "同类同对象 30 分钟内最多提醒一次",
    ]
    assert_no_credentials(path, SYSTEM_WEBHOOK)


class RejectingPageSource(CommentSource):
    """根评论页返回受控业务码；计数接口正常。"""

    def __init__(self, code):
        super().__init__()
        self.code = code
        self.add(DYNAMIC, [], count=1)

    def __call__(self, request):
        if request.url.path == "/x/v2/reply":
            return httpx.Response(200, json={"code": self.code, "message": "FICTIONAL_UPSTREAM_BODY"})
        if request.url.path == "/x/v2/reply/count":
            return httpx.Response(200, json={"code": 0, "data": {"count": 1}})
        return super().__call__(request)


class RejectingStatusSource(CommentSource):
    """计数接口直接返回 HTTP 状态错误（401/403 等）。"""

    def __init__(self, status):
        super().__init__()
        self.status = status
        self.add(DYNAMIC, [], count=0)

    def __call__(self, request):
        if request.url.path == "/x/v2/reply/count":
            return httpx.Response(self.status, json={"code": -101, "message": "FICTIONAL_UPSTREAM_BODY"})
        return super().__call__(request)


def test_anonymous_not_logged_in_is_a_collection_alert_not_credential_failure(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)

    run_check(path, RejectingCountSource(-101), Clock.start(13, 40), credentials_configured=False)

    saved = alerts(path)
    assert [(row["category"], row["object"], row["snapshot"]["reason"]) for row in saved] == [
        ("collection", f"{UID}:{DYNAMIC}", "login_required")]


@pytest.mark.parametrize("code", [-111, -352, -401, -403, -412, -799, 12002])
def test_other_business_codes_never_impersonate_credential_failure(tmp_path, code):
    """评论分页返回风控/权限码：仍是采集异常，响应正文不进告警。"""
    path = tmp_path / "archive.sqlite"
    configured(path)

    run_check(path, RejectingPageSource(code), Clock.start(13, 40),
              credentials_configured=True, sync=True)

    saved = alerts(path)
    assert [(row["category"], row["object"], row["snapshot"]["reason"]) for row in saved] == [
        ("collection", f"{UID}:{DYNAMIC}", "source_rejected")]
    assert "FICTIONAL_UPSTREAM_BODY" not in json.dumps(saved, ensure_ascii=False)


def test_comment_page_rejection_is_credential_failure_through_the_sync_path(tmp_path):
    """评论分页（真实的登录态敏感端点）返回 -101 时同样只由可信信号升级。"""
    path = tmp_path / "archive.sqlite"
    configured(path)

    run_check(path, RejectingPageSource(-101), Clock.start(13, 40),
              credentials_configured=True, sync=True)

    assert [(row["category"], row["object"], row["snapshot"]["reason"]) for row in alerts(path)] == [
        ("credential", "source_credential", "credential_rejected")]


@pytest.mark.parametrize("status", [401, 403])
def test_http_unauthorized_or_forbidden_is_only_a_collection_alert(tmp_path, status):
    path = tmp_path / "archive.sqlite"
    configured(path)

    run_check(path, RejectingStatusSource(status), Clock.start(13, 40), credentials_configured=True)

    assert [(row["category"], row["object"], row["snapshot"]["reason"]) for row in alerts(path)] == [
        ("collection", f"{UID}:{DYNAMIC}", "http_status")]


class CountingSource(CommentSource):
    """计数接口可控失败；根页给出真实可归档的一级评论。"""

    def __init__(self, *, roots=(), count=0, count_error=None):
        super().__init__()
        self.add(DYNAMIC, list(roots), count=count)
        self.count_error = count_error

    def __call__(self, request):
        if request.url.path == "/x/v2/reply/count" and self.count_error is not None:
            raise self.count_error
        return super().__call__(request)


def test_check_failure_alerts_collection_while_normal_growth_alerts_nothing(tmp_path):
    """计数读取超时是采集异常；正常计数增长与新评论归档不是故障。"""
    failing = tmp_path / "failing.sqlite"
    configured(failing)
    count_error = httpx.ReadTimeout("fictional timeout", request=httpx.Request("GET", "https://api.example.invalid"))
    run_check(failing, CountingSource(count=1, count_error=count_error), Clock.start(13, 40),
              credentials_configured=False)
    assert [(row["category"], row["object"], row["snapshot"]["reason"]) for row in alerts(failing)] == [
        ("collection", f"{UID}:{DYNAMIC}", "timeout")]

    healthy = tmp_path / "healthy.sqlite"
    configured(healthy)
    run_check(healthy, CountingSource(roots=[root_comment(7001)], count=1), Clock.start(13, 40),
              credentials_configured=False, sync=True)
    assert alerts(healthy) == []
    # 同一轮确实产生了业务评论事件，说明“没有告警”不是因为什么都没发生。
    assert [row["kind"] for row in query(
        healthy, "SELECT kind FROM notification_events ORDER BY id")] == ["root_comment"]


class ShrinkingPageSource(CommentSource):
    """根页第 2 次请求起总数比首页少 1：模拟扫描期间有人删除评论。"""

    def __init__(self, roots):
        super().__init__()
        self.add(DYNAMIC, list(roots), count=len(roots))
        self.root_page_calls = 0

    def __call__(self, request):
        response = super().__call__(request)
        if request.url.path != "/x/v2/reply":
            return response
        self.root_page_calls += 1
        if self.root_page_calls <= 1:
            return response
        payload = response.json()
        payload["data"]["page"]["count"] -= 1
        payload["data"]["page"]["acount"] -= 1
        return httpx.Response(200, json=payload)


def test_self_healing_pagination_failure_keeps_warning_without_alert(tmp_path):
    """页内计数减少是可自愈的分页校验：错误事实照常落库（可续采），但不登记告警。

    正常的删除行为每 30 分钟提醒一次也没用——而“未登记校验失败”类的 value_invalid
    仍要提醒，所以降级名单只含分页一致性分类，不包含兜底集。
    """
    path = tmp_path / "archive.sqlite"
    configured(path)
    source = ShrinkingPageSource([root_comment(7101), root_comment(7102)])

    run_check(path, source, Clock.start(13, 40), credentials_configured=False, sync=True)

    archive = Store(path).read_archive(DYNAMIC)
    assert archive["comments_error"] == "ROOT_COMMENTS_FAILED"
    assert archive["work"]["comments"] == "pending"
    assert alert_events(path) == []
    assert query(path, "SELECT * FROM notification_alerts") == []


def test_captured_loop_failure_is_persisted_before_the_process_exits(tmp_path, monkeypatch):
    """主循环捕获异常：先登记持久告警，再把异常抛给入口。"""
    path = tmp_path / "archive.sqlite"
    configured(path)
    store = Store(path)
    store.migrate()

    def broken():
        raise RuntimeError("FICTIONAL_SECRET_LOOP")

    monkeypatch.setattr(type(store), "enabled_recent", lambda self: broken())

    async def scenario():
        collector = Collector(store, None, clock=Clock.start(13, 40).collector)
        with pytest.raises(RuntimeError):
            await collector.run()

    asyncio.run(scenario())
    saved = alerts(path)
    assert [(row["category"], row["object"], row["snapshot"]["reason"]) for row in saved] == [
        ("loop", "collector_loop", "internal_error")]
    assert "FICTIONAL_SECRET_LOOP" not in json.dumps(saved, ensure_ascii=False)


class CollectorLog:
    """抓采集日志的实际记录：logger 自带 handler 且 propagate=False，因此直接挂一个。"""

    def __init__(self):
        self.messages = []
        self.records = []
        outer = self

        class Handler(logging.Handler):
            def emit(self, record):
                outer.records.append(record)
                outer.messages.append(record.getMessage())

        self.handler = Handler()
        self.logger = logging.getLogger("bili_monitor.collector")
        self.logger.addHandler(self.handler)

    def close(self):
        self.logger.removeHandler(self.handler)


def test_alert_registration_failure_leaves_only_a_sanitized_log(tmp_path, monkeypatch):
    """数据库无法登记告警时只留固定分类日志，不冒充已外发，也不吞掉原异常。"""
    path = tmp_path / "archive.sqlite"
    configured(path)
    store = Store(path)
    store.migrate()
    with sqlite3.connect(path) as connection:
        connection.execute("DROP TABLE notification_alerts")  # 受控注入：告警事实无处可写

    def broken():
        raise RuntimeError("FICTIONAL_SECRET_LOOP")

    monkeypatch.setattr(type(store), "enabled_recent", lambda self: broken())

    async def scenario():
        collector = Collector(store, None, clock=Clock.start(13, 40).collector)
        with pytest.raises(RuntimeError):
            await collector.run()

    captured = CollectorLog()
    try:
        asyncio.run(scenario())
    finally:
        captured.close()
    events = [message for message in captured.messages if message.startswith("alert_registration_failed")]
    assert events and events[0].startswith("alert_registration_failed reason=storage_error")
    assert all(record.exc_info is None for record in captured.records)
    assert "FICTIONAL_SECRET_LOOP" not in "\n".join(captured.messages)
    # 告警没有登记成功：不能靠“推送了”掩盖，表本身不存在。
    assert query(path, "SELECT name FROM sqlite_master WHERE name = 'notification_alerts'") == []


def business_event(path):
    """用真实归档链产生一条一级评论事件（本人评论 → up + all 两个业务目标）。"""
    configured(path)
    run_check(path, CountingSource(roots=[root_comment(7001)], count=1), Clock.start(13, 40),
              credentials_configured=False, sync=True)
    return query(path, "SELECT id, role, state FROM notification_deliveries ORDER BY id")


def deliveries(path):
    return query(path, """SELECT d.id, d.role, d.state, d.error, d.failures, d.attempts,
        d.expires_at, e.kind FROM notification_deliveries d
        JOIN notification_events e ON e.id = d.event_id ORDER BY d.id""")


def failing_responder(state, only=SYSTEM_WEBHOOK):
    """只让指定接收端失败：业务群正常，故障只发生在系统群自身。"""
    def responder(request):
        if state["fail"] and str(request.url) == only:
            return httpx.Response(500, json={"code": 500, "msg": "FICTIONAL_SECRET_RESPONSE"})
        return httpx.Response(200, json={"code": 0, "msg": "success"})

    return responder


def test_missing_business_route_alerts_the_affected_role_and_keeps_the_message(tmp_path):
    path = tmp_path / "archive.sqlite"
    clock = Clock.start(13, 40)
    receiver = Receiver()
    assert [row["role"] for row in business_event(path)] == ["up", "all"]

    async def scenario():
        notifier = dispatcher(path, receiver, clock, full=None)
        try:
            await notifier.tick()   # up 正常送达，all 缺路由并登记告警
            await notifier.tick()   # 告警本身在下一轮投递
        finally:
            await notifier.aclose()

    asyncio.run(scenario())
    saved = alerts(path)
    assert [(row["category"], row["object"], row["snapshot"]["reason"], row["state"]) for row in saved] == [
        ("route", f"all:{UID}:{DYNAMIC}", "route_missing", "sent")]
    # 业务消息没有被丢掉：只暂停受影响目标，等修复后补发。
    status = {row["role"]: (row["state"], row["error"]) for row in deliveries(path) if row["kind"] == "root_comment"}
    assert status == {"up": ("sent", None), "all": ("waiting_config", "route_missing")}
    assert message_text(receiver.payloads[-1]).splitlines()[:2] == [
        "告警【路由缺失或错误】", f"对象：all:{UID}:{DYNAMIC}"]


def test_missing_system_route_never_recurses_into_more_alerts(tmp_path):
    """系统群未配置时只留本地诊断：不为系统目标再生成一条告警，也不转投业务群。"""
    path = tmp_path / "archive.sqlite"
    clock = Clock.start(13, 40)
    receiver = Receiver()
    assert len(business_event(path)) == 2

    async def scenario():
        blocked = dispatcher(path, receiver, clock, full=None, system=None)
        try:
            for _ in range(3):
                clock.advance(60)
                await blocked.tick()
        finally:
            await blocked.aclose()

    asyncio.run(scenario())
    saved = alerts(path)
    # 只有业务路由缺失那一条；系统群自身缺配置不会再生一条 route 告警。
    assert [(row["category"], row["object"], row["state"]) for row in saved] == [
        ("route", f"all:{UID}:{DYNAMIC}", "waiting_config")]
    system = [row for row in deliveries(path) if row["kind"] == "alert"]
    assert [(row["role"], row["state"], row["error"]) for row in system] == [
        ("system", "waiting_config", "route_missing")]
    assert {request["url"] for request in receiver.requests} == {WEBHOOK}


def test_failing_system_group_never_generates_a_second_alert(tmp_path):
    """系统群发送持续失败：告警记录自身按退避重试，但不递归生成“发送失败”告警。"""
    path = tmp_path / "archive.sqlite"
    clock = Clock.start(13, 40)
    state = {"fail": True}
    receiver = Receiver(failing_responder(state))
    assert len(business_event(path)) == 2

    async def scenario():
        notifier = dispatcher(path, receiver, clock, full=None)
        try:
            for delay in (0, 2, 4, 8, 16, 32, 64):
                clock.advance(delay)
                await notifier.tick()
        finally:
            await notifier.aclose()

    asyncio.run(scenario())
    saved = alerts(path)
    assert [(row["category"], row["object"]) for row in saved] == [("route", f"all:{UID}:{DYNAMIC}")]
    alert_delivery = [row for row in deliveries(path) if row["kind"] == "alert"][0]
    assert alert_delivery["role"] == "system" and alert_delivery["failures"] >= 3
    assert alert_delivery["expires_at"] is None  # 告警不套用心跳有效期
    # 心跳失败次数同样不生成“投递持续失败”告警：只有系统目标自己的失败事实与日志。
    heartbeat = [row for row in deliveries(path) if row["kind"] == "heartbeat"]
    assert heartbeat and heartbeat[0]["failures"] >= 1
    # 失败事实仍然只保留在系统目标自己的记录里，没有第二条告警事件。
    assert len(alert_events(path)) == 1


def timeout_error():
    return httpx.ReadTimeout("fictional timeout", request=httpx.Request("GET", "https://api.example.invalid"))


def categories(path):
    return [(row["category"], row["object"]) for row in alerts(path)]


def test_delivery_failure_threshold_alerts_only_persistent_business_failures(tmp_path):
    """只有持续（≥3 次真实失败、仍在待投递）才告警；恢复后不再判成持续失败。"""
    path = tmp_path / "archive.sqlite"
    clock = Clock.start(13, 40)
    state = {"fail": True}
    receiver = Receiver(failing_responder(state, only=WEBHOOK))
    assert [row["role"] for row in business_event(path)] == ["up", "all"]

    async def scenario():
        notifier = dispatcher(path, receiver, clock, full=ALL_WEBHOOK)
        try:
            await notifier.tick()
            assert deliveries(path)[0]["failures"] == 1
            assert alerts(path) == []  # 一次失败还不够“持续”
            clock.advance(2)
            await notifier.tick()
            assert deliveries(path)[0]["failures"] == 2
            assert alerts(path) == []
            clock.advance(4)
            await notifier.tick()   # 第三次真实失败 → 登记告警
            await notifier.tick()   # 下一轮把告警本身发到系统群
            state["fail"] = False
            clock.advance(600)
            await notifier.tick()   # 业务目标恢复成功
            await notifier.tick()
        finally:
            await notifier.aclose()

    asyncio.run(scenario())
    assert categories(path) == [("delivery", "up:root_comment")]
    up = deliveries(path)[0]
    assert (up["role"], up["state"], up["failures"]) == ("up", "sent", 3)
    # 已恢复的目标不会被再判成“持续失败”，告警事件仍只有一条。
    assert len(alert_events(path)) == 1
    alert_messages = [message_text(payload) for payload in receiver.payloads
                      if "告警【" in message_text(payload)]
    assert [message.splitlines()[:2] for message in alert_messages] == [
        ["告警【飞书投递持续失败】", "对象：up:root_comment"]]


def test_business_target_recovered_below_threshold_never_alerts(tmp_path):
    path = tmp_path / "archive.sqlite"
    clock = Clock.start(13, 40)
    state = {"fail": True}
    receiver = Receiver(failing_responder(state, only=WEBHOOK))
    business_event(path)

    async def scenario():
        notifier = dispatcher(path, receiver, clock, full=ALL_WEBHOOK)
        try:
            await notifier.tick()
            clock.advance(2)
            await notifier.tick()
            state["fail"] = False
            clock.advance(600)
            await notifier.tick()
            await notifier.tick()
        finally:
            await notifier.aclose()

    asyncio.run(scenario())
    assert alerts(path) == []
    assert deliveries(path)[0]["state"] == "sent"


def test_alert_throttle_is_per_object_and_survives_restart(tmp_path):
    """同对象同类故障首次提醒，此后每 30 分钟最多一次；不同对象分别判断，跨重启保留。"""
    path = tmp_path / "archive.sqlite"
    configured(path, ids=(DYNAMIC, "456"))
    clock = Clock.start(13, 40)
    receiver = Receiver()
    source = CountingSource(count=1, count_error=timeout_error())
    source.add("456", [], count=1)

    def failing_check(dynamic=DYNAMIC):
        run_check(path, source, clock, credentials_configured=False, dynamic=dynamic)

    async def deliver():
        notifier = dispatcher(path, receiver, clock)
        try:
            await notifier.tick()
        finally:
            await notifier.aclose()

    failing_check()
    asyncio.run(deliver())
    assert categories(path) == [("collection", f"{UID}:{DYNAMIC}")]

    clock.advance(1799)   # 窗口内：同类同对象合并
    failing_check()
    asyncio.run(deliver())
    assert categories(path) == [("collection", f"{UID}:{DYNAMIC}")]

    clock.advance(1)      # 恰好 30 分钟：允许下一次提醒
    failing_check()
    asyncio.run(deliver())
    assert len(alert_events(path)) == 2

    # 另一对象独立判断：不受同类别上一个对象的时间影响。
    clock.advance(60)
    failing_check("456")
    asyncio.run(deliver())
    assert categories(path) == [("collection", f"{UID}:{DYNAMIC}"), ("collection", f"{UID}:456")]

    # 重启后仍按持久节流状态判断：同一对象在窗口内不再提醒（2 次 + 另一对象 1 次）。
    clock.advance(60)
    failing_check()
    asyncio.run(deliver())
    assert len(alert_events(path)) == 3


def test_undelivered_alert_merges_repeats_instead_of_stacking(tmp_path):
    """系统群一直失败时，同类提醒合并到同一未投递事件，不按故障次数堆积。"""
    path = tmp_path / "archive.sqlite"
    configured(path)
    clock = Clock.start(13, 40)
    state = {"fail": True}
    receiver = Receiver(failing_responder(state))  # 系统群本身也在失败
    source = CountingSource(count=1, count_error=timeout_error())

    async def scenario():
        notifier = dispatcher(path, receiver, clock)
        try:
            for _ in range(12):  # 一小时里每 5 分钟再失败一次，跨过两个 30 分钟窗口
                await check_async(path, source, clock, credentials_configured=False)
                await notifier.tick()
                clock.advance(300)
            assert len(alert_events(path)) == 1
            state["fail"] = False  # 修复系统群后只补发这一条合并后的提醒
            clock.advance(600)
            await notifier.tick()
        finally:
            await notifier.aclose()

    asyncio.run(scenario())
    assert len(alert_events(path)) == 1
    assert [row["state"] for row in deliveries(path) if row["kind"] == "alert"] == ["sent"]
    # 失败期间的重试是同一条提醒（外部重复由 06 的退避语义决定），没有第二条内容。
    attempted = {message_text(payload) for payload in receiver.payloads if "告警【" in message_text(payload)}
    assert len(attempted) == 1 and "采集异常" in attempted.pop()


class FailingFeedSource(CountingSource):
    """近期发现 feed 接口可控失败；其余端点沿用受控来源。"""

    def __call__(self, request):
        if request.url.path.startswith("/x/polymer/web-dynamic/v1/feed/space"):
            raise httpx.ConnectError("fictional feed failure", request=request)
        return super().__call__(request)


def test_discovery_failure_alerts_the_up_and_keeps_the_old_window(tmp_path):
    """近期模式发现失败是采集异常：对象是该 UP，旧窗口不被伪造更新。"""
    path = tmp_path / "archive.sqlite"
    with archive_client(path, FailingFeedSource(count=0)) as api:
        assert api.post(BASE, json={"uid": UID}).status_code == 201
        assert enable(api).status_code == 200  # 近期模式：发现阶段由 feed 失败触发
    open_notifications(path)

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(FailingFeedSource(count=0))) as client:
            collector = Collector(Store(path), client, clock=Clock.start(13, 40).collector)
            assert not await collector.discover_once(UID)

    asyncio.run(scenario())
    assert [(row["category"], row["object"], row["snapshot"]["reason"]) for row in alerts(path)] == [
        ("collection", UID, "source_unavailable")]
    # 失败不伪造可信窗口：发现的旧结果仍是空的。
    assert query(path, "SELECT trusted_result FROM recent_discoveries") == [{"trusted_result": None}]


def test_alert_throttle_and_heartbeat_use_separate_state(tmp_path):
    """告警节流不抑制心跳：同一小时既收到告警也收到心跳，告警记录不套用心跳有效期。"""
    path = tmp_path / "archive.sqlite"
    configured(path)
    clock = Clock.start(13, 40)
    receiver = Receiver()
    run_check(path, CountingSource(count=1, count_error=timeout_error()), clock, credentials_configured=False)

    async def scenario():
        notifier = dispatcher(path, receiver, clock)
        try:
            await notifier.tick()
            await notifier.tick()
        finally:
            await notifier.aclose()

    asyncio.run(scenario())
    texts = [message_text(payload).splitlines()[0] for payload in receiver.payloads]
    assert texts == ["告警【采集异常】", "心跳【2026-10-09 13:40】通知进程存活"]
    assert [row["expires_at"] for row in deliveries(path) if row["kind"] == "alert"] == [None]
    heartbeats = query(path, """SELECT h.slot, d.state FROM notification_heartbeats h
        JOIN notification_deliveries d ON d.event_id = h.event_id""")
    assert [(row["slot"], row["state"]) for row in heartbeats] == [("2026-10-09T13", "sent")]


def test_alert_message_and_queue_carry_only_fixed_sanitized_fields(tmp_path):
    """告警消息与持久记录都不含 webhook、签名密钥、响应正文、异常原文或业务正文。"""
    secret = "FICTIONAL_SECRET_SIGNING_08"
    path = tmp_path / "archive.sqlite"
    configured(path)
    clock = Clock.start(13, 40)
    receiver = Receiver()
    run_check(path, RejectingPageSource(-412), clock, credentials_configured=True, sync=True)

    async def scenario():
        notifier = dispatcher(path, receiver, clock, full=ALL_WEBHOOK, system=SYSTEM_WEBHOOK)
        try:
            await notifier.tick()
            await notifier.tick()
        finally:
            await notifier.aclose()

    asyncio.run(scenario())
    alert_texts = [message_text(payload) for payload in receiver.payloads if "告警【" in message_text(payload)]
    assert len(alert_texts) == 1
    observed = "\n".join(alert_texts)
    for forbidden in (WEBHOOK, ALL_WEBHOOK, SYSTEM_WEBHOOK, "open-apis", secret,
                      "FICTIONAL_UPSTREAM_BODY", "FICTIONAL_SECRET"):
        assert forbidden not in observed
    assert "原因：来源拒绝请求" in observed
    # 快照只允许固定字段：类别、对象、发生时间、原因。
    assert set(alert_events(path)[0].keys()) >= {"kind", "dynamic_id", "snapshot"}
    assert set(json.loads(alert_events(path)[0]["snapshot"])) == {
        "category", "object", "occurred_at", "reason"}
    assert_no_credentials(path, WEBHOOK, ALL_WEBHOOK, SYSTEM_WEBHOOK, secret)
    dumped = json.dumps(query(path, "SELECT * FROM notification_events"), ensure_ascii=False)
    assert "FICTIONAL_UPSTREAM_BODY" not in dumped


def test_invalid_destination_alert_is_a_route_fact_and_repair_only_resends_that_target(tmp_path):
    """单条目写错由 06 容错：只为该目标告警，修复后只补发失败目标、不重发已成功目标。"""
    path = tmp_path / "archive.sqlite"
    clock = Clock.start(13, 40)
    receiver = Receiver()
    business_event(path)

    async def scenario():
        broken = dispatcher(path, receiver, clock, full="not-a-webhook")
        try:
            await broken.tick()
            await broken.tick()
        finally:
            await broken.aclose()
        status = {row["role"]: (row["state"], row["error"]) for row in deliveries(path)
                  if row["kind"] == "root_comment"}
        assert status == {"up": ("sent", None), "all": ("waiting_config", "route_invalid")}
        assert [(row["category"], row["object"], row["snapshot"]["reason"]) for row in alerts(path)] == [
            ("route", f"all:{UID}:{DYNAMIC}", "route_invalid")]

        clock.advance(60)
        repaired = dispatcher(path, receiver, clock, full=ALL_WEBHOOK)
        try:
            await repaired.tick()
        finally:
            await repaired.aclose()

    asyncio.run(scenario())
    status = {row["role"]: (row["state"], row["error"]) for row in deliveries(path)
              if row["kind"] == "root_comment"}
    assert status == {"up": ("sent", None), "all": ("sent", None)}
    # 已成功目标不被重发：UP 群只收到最初的业务消息，修复只补全员群。
    assert [request["url"] for request in receiver.requests].count(WEBHOOK) == 1
    assert [request["url"] for request in receiver.requests].count(ALL_WEBHOOK) == 1
    assert len(alert_events(path)) == 1


def test_persistent_failure_of_a_reply_delivery_also_alerts(tmp_path):
    """回复（05 的业务类型）持续投递失败同样告警：只按业务类型统计，不硬编码单一类型。"""
    path = tmp_path / "archive.sqlite"
    clock = Clock.start(13, 40)
    state = {"fail": True}
    receiver = Receiver(failing_responder(state, only=ALL_WEBHOOK))
    source = CommentSource().add(DYNAMIC, [root_comment("870001", text="虚构评论")])
    source.replies(DYNAMIC, "870001", [reply_item("970001", root="870001", text="虚构回复")])
    with archive_client(path, source):
        pass
    configure_source(path, source)

    run_check(path, source, clock, credentials_configured=False, sync=True)
    assert {row["kind"] for row in query(path, "SELECT kind FROM notification_events")} == {
        "root_comment", "reply_comment"}

    async def scenario():
        notifier = dispatcher(path, receiver, clock, full=ALL_WEBHOOK)
        try:
            # 只让全员群失败：UP 群的一级评论成功，回复目标持续失败。
            for delay in (0, 2, 4, 8):
                clock.advance(delay)
                await notifier.tick()
        finally:
            await notifier.aclose()

    asyncio.run(scenario())
    # 全员群的一级评论与回复两条投递都在持续失败：各按 (角色, 类型) 独立提醒。
    assert categories(path) == [("delivery", "all:root_comment"), ("delivery", "all:reply_comment")]
