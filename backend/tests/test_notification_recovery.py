"""06：路由覆盖、故障隔离、失败事实与恢复语义。

真实归档/采集入口 → 临时 SQLite → 受控飞书接收端；只替换 B 站/飞书 HTTP 传输与
时间来源。身份、动态、评论与凭据均为虚构值，不访问真实上游与真实群。
"""

import asyncio
import logging
import time
from contextlib import contextmanager

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.notifications import Dispatcher, NotificationConfig, message, outbox
from backend.bili_monitor.storage import Store
from backend.tests.management_support import UID
from backend.tests.notification_support import (
    ALL_WEBHOOK, BASE_URL, WEBHOOK, Clock, Receiver, assert_no_credentials, config_mapping,
    deliveries, events,
)
from backend.tests.root_notification_support import (
    DYNAMIC, SYSTEM_WEBHOOK, Source, configure, root_comment,
)

OVERRIDE_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/fake-up-123"


def archive_up_comment(path, comments=None):
    """真实归档链产生一条「UP 本人」的一级评论 → up 与 all 两个待投递目标。"""
    source = Source().add(DYNAMIC, comments or [root_comment("860001", text="虚构评论")])
    configure(path, source)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()

    asyncio.run(run())
    assert sorted(row["role"] for row in deliveries(path)) == ["all", "up"]
    return source


def run_once(path, mapping, *, transport=None, clock=None, **options):
    receiver = Receiver() if transport is None else transport
    asyncio.run(Dispatcher(Store(path), NotificationConfig.from_mapping(mapping),
                           transport=httpx.MockTransport(receiver) if transport is None else transport,
                           clock=clock or Clock(), **options).run_once())
    return receiver


def test_dynamic_override_applies_per_role_while_other_roles_inherit_up_defaults(tmp_path):
    """动态覆盖只替换对应角色；未覆盖的角色继承所属 UP 默认值，系统群不参与业务兜底。"""
    path = tmp_path / "monitor.sqlite"
    archive_up_comment(path)
    mapping = config_mapping(up=WEBHOOK, full=ALL_WEBHOOK, system=SYSTEM_WEBHOOK)
    mapping["dynamics"] = {DYNAMIC: {"up": "up-123"}}
    mapping["destinations"]["up-123"] = {"webhook": OVERRIDE_WEBHOOK}

    receiver = run_once(path, mapping)

    # UP 群用动态覆盖，全员群仍继承 UP 默认值。
    assert sorted(request["url"] for request in receiver.requests) == sorted([OVERRIDE_WEBHOOK, ALL_WEBHOOK])
    assert sorted((row["role"], row["state"]) for row in deliveries(path)) == [("all", "sent"), ("up", "sent")]
    # 业务投递不使用系统群。
    assert SYSTEM_WEBHOOK not in [request["url"] for request in receiver.requests]


def test_missing_business_route_never_falls_back_to_the_system_room(tmp_path):
    """业务角色缺失只让该目标等待配置；系统群不是 UP 群或全员群的后备。"""
    path = tmp_path / "monitor.sqlite"
    archive_up_comment(path)
    mapping = {"base_url": BASE_URL, "ups": {}, "system": "system-room",
               "destinations": {"system-room": {"webhook": SYSTEM_WEBHOOK}}}

    class NoNetwork:
        async def __call__(self, request):
            raise AssertionError("缺少业务路由时不得执行无效 HTTP")

    asyncio.run(Dispatcher(Store(path), NotificationConfig.from_mapping(mapping),
                           transport=httpx.MockTransport(NoNetwork()), clock=Clock()).run_once())

    assert sorted((row["role"], row["state"], row["error"]) for row in deliveries(path)) == [
        ("all", "waiting_config", "route_missing"), ("up", "waiting_config", "route_missing")]
    assert [event["kind"] for event in events(path)] == ["root_comment"]


def test_broken_destination_pauses_only_that_target_and_repair_sends_only_it(tmp_path):
    """单个目的地写错只让该目标等待修复；其他群照常发送，修复后只补发失败目标。"""
    path = tmp_path / "monitor.sqlite"
    archive_up_comment(path)
    checkpoint = Store(path).read_archive(DYNAMIC)
    broken = config_mapping(up=WEBHOOK, full=ALL_WEBHOOK)
    broken["destinations"]["all-room"] = {"webhook": "not-a-webhook"}

    # 单条目写错不能使整份配置不可用（否则两个群一起停摆）。
    loaded = NotificationConfig.from_mapping(broken)
    first = run_once(path, broken)
    assert [request["url"] for request in first.requests] == [WEBHOOK]
    assert sorted((row["role"], row["state"], row["error"]) for row in deliveries(path)) == [
        ("all", "waiting_config", "route_invalid"), ("up", "sent", None)]

    # 修复配置＝编辑文件后重启通知进程：只补发失败目标，不重发已成功目标。
    repaired = config_mapping(up=WEBHOOK, full=ALL_WEBHOOK)
    assert loaded.reference(UID, DYNAMIC, "all") == "all-room"
    sent_at = {row["role"]: row["sent_at"] for row in deliveries(path)}["up"]
    clock = Clock()
    clock.advance(60.0)
    second = run_once(path, repaired, clock=clock)
    assert [request["url"] for request in second.requests] == [ALL_WEBHOOK]
    rows = {row["role"]: row for row in deliveries(path)}
    # 已成功目标保持成功且不被再次投递。
    assert (rows["up"]["state"], rows["up"]["attempts"], rows["up"]["sent_at"]) == ("sent", 1, sent_at)
    assert (rows["all"]["state"], rows["all"]["attempts"], rows["all"]["error"]) == ("sent", 2, None)
    assert len(events(path)) == 1
    # 归档检查点与消息快照在等待和重试期间保持不变。
    assert Store(path).read_archive(DYNAMIC) == checkpoint
    assert {row["snapshot"]["comment_id"] for row in rows.values()} == {"860001"}
    assert {row["snapshot"]["text"] for row in rows.values()} == {"虚构评论"}


def test_waiting_config_rechecks_never_count_as_delivery_failures(tmp_path):
    """08 可用事实：`attempts` 含等待配置复检，不能当持续失败次数；只看 failures/last_failed_at。"""
    path = tmp_path / "monitor.sqlite"
    archive_up_comment(path)
    broken = config_mapping(up=WEBHOOK, full=ALL_WEBHOOK)
    broken["destinations"]["all-room"] = {"webhook": "not-a-webhook"}
    clock = Clock()

    def reject(request):
        return httpx.Response(200, json={"code": 9499, "msg": "Bad Request"})

    run_once(path, broken, transport=httpx.MockTransport(reject), clock=clock)
    rows = {row["role"]: row for row in deliveries(path)}
    assert (rows["up"]["state"], rows["up"]["error"], rows["up"]["attempts"]) == ("pending", "platform_rejected", 1)
    assert (rows["up"]["failures"], rows["up"]["last_failed_at"]) == (1, clock.now())
    assert (rows["all"]["state"], rows["all"]["error"], rows["all"]["attempts"]) == ("waiting_config", "route_invalid", 1)
    assert (rows["all"]["failures"], rows["all"]["last_failed_at"]) == (0, None)

    # 修复配置后：已失败目标退避到期重投成功，等待目标复检一次后成功。
    repaired = config_mapping(up=WEBHOOK, full=ALL_WEBHOOK)
    receiver = Receiver()
    clock.advance(2.0)
    run_once(path, repaired, transport=httpx.MockTransport(receiver), clock=clock)
    assert [request["url"] for request in receiver.requests] == [WEBHOOK]
    clock.advance(58.0)
    run_once(path, repaired, transport=httpx.MockTransport(receiver), clock=clock)
    assert sorted(request["url"] for request in receiver.requests) == sorted([WEBHOOK, ALL_WEBHOOK])
    rows = {row["role"]: row for row in deliveries(path)}
    assert (rows["up"]["state"], rows["up"]["failures"], rows["up"]["last_failed_at"]) == ("sent", 1, clock.now() - 60)
    # 成功不抹掉历史失败事实：等待目标整段复检都没被记成失败。
    assert (rows["all"]["state"], rows["all"]["attempts"], rows["all"]["failures"]) == ("sent", 2, 0)

    with Store(path).connection() as connection:
        facts = [dict(row) for row in outbox.delivery_failures(connection)]
    assert facts == [{
        "role": "up", "kind": "root_comment", "uid": UID, "dynamic_id": DYNAMIC, "state": "sent",
        "error": None, "failures": 1, "last_failed_at": clock.now() - 60,
    }]


def test_claim_uses_due_and_lease_indexes_with_a_bounded_batch(tmp_path):
    """默认领取走「到期」与「租约」两条索引并受批量限制，不全表扫描队列。"""
    path = tmp_path / "monitor.sqlite"
    archive_up_comment(path)
    with Store(path).connection() as connection:
        due_plan = " ".join(str(row["detail"]) for row in connection.execute(
            "EXPLAIN QUERY PLAN " + outbox.DUE_QUERY, (outbox.PENDING, outbox.WAITING_CONFIG, 1_000_000.0, 8)))
        lease_plan = " ".join(str(row["detail"]) for row in connection.execute(
            "EXPLAIN QUERY PLAN " + outbox.LEASE_QUERY, (outbox.INFLIGHT, 1_000_000.0, 8)))
        claimed = outbox.claim_due(connection, 1_000_000.0, 2, 30.0)
    assert "notification_due" in due_plan and "notification_lease" in lease_plan
    assert len(claimed) == 2
    assert {(item["role"], item["token"] is not None) for item in claimed} == {("up", True), ("all", True)}


def test_blocked_target_does_not_block_the_other_target_in_the_same_round(tmp_path):
    """一群的外部请求阻塞时，另一群仍在同一轮完成并保持成功。"""
    path = tmp_path / "monitor.sqlite"
    source = archive_up_comment(path)

    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()

        async def responder(request):
            if request.url == WEBHOOK:
                entered.set()
                await release.wait()
            return httpx.Response(200, json={"code": 0, "msg": "success"})

        dispatcher = Dispatcher(Store(path), NotificationConfig.from_mapping(
            config_mapping(up=WEBHOOK, full=ALL_WEBHOOK)),
            transport=httpx.MockTransport(responder), clock=Clock())
        running = asyncio.create_task(dispatcher.run_once())
        await asyncio.wait_for(entered.wait(), timeout=5)

        def states():
            return {row["role"]: row["state"] for row in deliveries(path)}

        deadline = time.monotonic() + 5
        while states().get("all") != "sent" and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        # UP 群的请求还阻塞着，全员群已经成功。
        assert states() == {"up": "inflight", "all": "sent"}
        release.set()
        await running
        await dispatcher.aclose()
        assert states() == {"up": "sent", "all": "sent"}

    asyncio.run(scenario())
    # 归档内容不受投递并发影响。
    assert Store(path).read_archive(DYNAMIC)["text"] == "虚构全文\n第二行 <b>仍是文本</b> 🙂"
    assert source.spec(DYNAMIC)["count"] == 1


def test_failed_target_backoff_does_not_hold_back_newer_deliveries(tmp_path):
    """失败目标的退避只作用于该记录：期间产生的新事件照常投递，不形成全局阻塞。"""
    path = tmp_path / "monitor.sqlite"
    source = archive_up_comment(path)
    clock = Clock()

    def reject(request):
        return httpx.Response(500, json={"code": -1})

    run_once(path, config_mapping(up=WEBHOOK, full=ALL_WEBHOOK),
             transport=httpx.MockTransport(reject), clock=clock)
    rows = deliveries(path)
    assert {row["state"] for row in rows} == {"pending"}
    assert {row["due_at"] for row in rows} == {clock.now() + 2.0}

    # 退避期间出现一条新评论：它的目标到期即可投递，不必等旧记录的重试时间。
    source.replace(DYNAMIC, [root_comment("860001", text="虚构评论"),
                             root_comment("860002", text="虚构新评论")])

    async def archive_again():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()

    asyncio.run(archive_again())
    assert len(deliveries(path)) == 4
    receiver = Receiver()
    clock.advance(0.5)
    run_once(path, config_mapping(up=WEBHOOK, full=ALL_WEBHOOK),
             transport=httpx.MockTransport(receiver), clock=clock)
    sent = sorted({row["snapshot"]["comment_id"] for row in deliveries(path) if row["state"] == "sent"})
    assert sent == ["860002"]
    assert len(receiver.requests) == 2


def test_lost_success_response_is_retried_and_may_duplicate_externally(tmp_path):
    """飞书已收到但响应丢失时按失败保留并重试；外部可能重复，只能保证内部状态幂等。"""
    path = tmp_path / "monitor.sqlite"
    archive_up_comment(path)
    clock = Clock()
    accepted = []

    def responder(request):
        accepted.append(request.url)
        if len(accepted) == 1:
            raise httpx.ReadTimeout("fictional response lost", request=request)
        return httpx.Response(200, json={"code": 0, "msg": "success"})

    mapping = config_mapping(up=WEBHOOK)
    run_once(path, mapping, transport=httpx.MockTransport(responder), clock=clock)
    waiting = next(row for row in deliveries(path) if row["role"] == "up")
    assert (waiting["state"], waiting["error"], waiting["failures"]) == ("pending", "timeout", 1)
    assert waiting["due_at"] == clock.now() + 2.0

    clock.advance(2.0)
    run_once(path, mapping, transport=httpx.MockTransport(responder), clock=clock)
    sent = next(row for row in deliveries(path) if row["role"] == "up")
    assert (sent["state"], sent["failures"], sent["sent_at"]) == ("sent", 1, clock.now())
    # 接收端实际收到两次：外部重复被允许，不宣称飞书端绝对一次送达。
    assert accepted == [WEBHOOK, WEBHOOK]
    assert len(events(path)) == 1


@contextmanager
def notifier_logs():
    """捕获通知进程日志：签名密钥与 webhook 都不允许出现在日志字段里。"""
    logger = logging.getLogger("bili_monitor.notifier")
    records = []
    handler = logging.Handler()
    handler.emit = records.append
    logger.addHandler(handler)
    try:
        yield records
    finally:
        logger.removeHandler(handler)


def test_signing_is_assembled_at_send_time_and_never_enters_the_queue(tmp_path):
    """签名密钥只在发送时组装；队列、消息快照与日志里都没有它。"""
    path = tmp_path / "monitor.sqlite"
    archive_up_comment(path)
    secret = "FICTIONAL_SECRET_SIGNING_06"
    mapping = config_mapping(up=WEBHOOK)
    mapping["destinations"]["up-room"]["secret"] = secret
    clock = Clock()
    receiver = Receiver()

    with notifier_logs() as records:
        run_once(path, mapping, transport=httpx.MockTransport(receiver), clock=clock)

    body = receiver.payloads[0]
    assert body["timestamp"] == str(int(clock.now()))
    assert body["sign"] == message.signature(secret, clock.now())
    assert_no_credentials(path, secret, "fake-up-token")
    assert all(secret not in record.getMessage() for record in records)
    assert secret not in repr(NotificationConfig.from_mapping(mapping))
    # 签名只是请求体外层的两个字段，消息本身与未签名载荷逐字一致。
    snapshot = next(row for row in deliveries(path) if row["role"] == "up")["snapshot"]
    assert {key: value for key, value in body.items() if key not in ("timestamp", "sign")} == (
        message.root_comment(snapshot, BASE_URL))
    # 未配置密钥时不追加签名字段。
    assert NotificationConfig.from_mapping(config_mapping(up=WEBHOOK)).secret(UID, DYNAMIC, "up") is None


def test_api_and_collector_never_start_the_notification_process(tmp_path):
    """API/采集不内嵌通知定时器：导入它们不加载进程入口，归档只留下待投递记录。"""
    script = (
        "import sys\n"
        "import backend.bili_monitor.app\n"
        "import backend.bili_monitor.collector\n"
        "print(sorted(name for name in sys.modules if 'notifier' in name))\n")
    from backend.tests.notification_process_support import run_python

    result = run_python(["-c", script])
    assert result.returncode == 0, result.stderr
    # 进程入口（单实例锁 + 轮询循环）不在 API/采集进程里。
    assert result.stdout.strip() == "[]"

    path = tmp_path / "monitor.sqlite"
    archive_up_comment(path)
    # 归档与只读读取路径只留下待投递记录，不会自己发飞书消息。
    with Store(path).connection() as connection:
        assert Store(path).read_archive(DYNAMIC)["content_state"] == "success"
    assert {row["state"] for row in deliveries(path)} == {"pending"}


def test_lease_override_is_validated_and_defaults_to_the_published_value(monkeypatch):
    """租约旋钮只接受正数秒；不设置时仍是既定的 30 秒，轮询间隔不变。"""
    from backend.bili_monitor import notifier
    from backend.bili_monitor.notifications import delivery

    monkeypatch.delenv("BILI_NOTIFIER_LEASE_SECONDS", raising=False)
    assert notifier.seconds("BILI_NOTIFIER_LEASE_SECONDS") is None
    assert delivery.LEASE_SECONDS == 30.0
    monkeypatch.setenv("BILI_NOTIFIER_LEASE_SECONDS", "45")
    assert notifier.seconds("BILI_NOTIFIER_LEASE_SECONDS") == 45.0
    for invalid in ("0", "-5", "abc"):
        monkeypatch.setenv("BILI_NOTIFIER_LEASE_SECONDS", invalid)
        with pytest.raises(SystemExit):
            notifier.seconds("BILI_NOTIFIER_LEASE_SECONDS")
