"""10：告警、心跳、阶段切换、候选与失败队列在同一临时库里的组合回归。

单项语义已由 07/08/09 各自取证；这里只验证组合时不会互相压制或越阶段：
告警节流不压心跳、系统群自身失败不递归、过期只作用于心跳、封存阶段的候选不借
新旧阶段生成通知。真实存储与真实投递调度，只替换飞书 HTTP 传输与时间来源。
"""

import asyncio

import httpx
import pytest

from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client
from backend.tests.management_support import BASE, UID
from backend.tests.notification_support import (
    ALL_WEBHOOK, WEBHOOK, Receiver, message_text, query,
)
from backend.tests.root_notification_support import Source, root_comment, root_documents
from backend.tests.test_notification_alerts import (
    SYSTEM_WEBHOOK, Clock, alert_events, alerts, business_event, categories, dispatcher, run_check,
)
from backend.tests.test_notification_heartbeat import heartbeats

DYNAMIC = "123"


def all_failing(state, paths):
    """业务 UP 群与系统群同时失败：全员群仍正常，用来区分目标级隔离。"""
    def responder(request):
        if state["fail"] and str(request.url) in paths:
            return httpx.Response(500, json={"code": 500, "msg": "FICTIONAL_SECRET_RESPONSE"})
        return httpx.Response(200, json={"code": 0, "msg": "success"})
    return responder


def candidates(path):
    return query(path, "SELECT * FROM notification_candidates ORDER BY comment_id")


def test_alerts_heartbeat_expiry_and_phase_switch_do_not_suppress_each_other(tmp_path):
    path = tmp_path / "archive.sqlite"
    clock = Clock.start(13, 40)
    state = {"fail": True}
    receiver = Receiver(all_failing(state, {WEBHOOK, SYSTEM_WEBHOOK}))
    # 真实归档链产生一条本人一级评论：up + all 两个业务目标。
    assert [row["role"] for row in business_event(path)] == ["up", "all"]

    async def scenario():
        notifier = dispatcher(path, receiver, clock, full=ALL_WEBHOOK)
        try:
            await notifier.tick()          # up 失败 1 次；全员群成功；13:40 心跳生成并系统失败
            clock.advance(2)
            await notifier.tick()          # up 失败 2 次
            clock.advance(4)
            await notifier.tick()          # up 失败 3 次 → 登记“持续投递失败”告警
            await notifier.tick()          # 告警本身也发往失败的系统群
            clock.advance(1790)
            await notifier.tick()          # 30 分钟内：节流只合并，不新增同类告警
            # 告警节流不压心跳：本小时的心跳与告警在同一队列里各有一条。
            assert len(alert_events(path)) == 1
            assert len(heartbeats(path)) == 1
            # 系统群自身失败不递归：不存在对象为系统角色/心跳的告警事件。
            assert all(not row["snapshot"]["object"].startswith("system:")
                       for row in alerts(path))
            # 过期只作用于心跳：时钟越过心跳有效期后，心跳过期而业务与告警仍在队列。
            clock.advance(3600)
            await notifier.tick()
        finally:
            await notifier.aclose()

    asyncio.run(scenario())
    saved = {(row["kind"], row["role"]): row for row in query(path, """SELECT e.kind, d.role, d.state,
        d.expires_at FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
        ORDER BY d.id""")}
    assert saved[("heartbeat", "system")]["state"] == "expired"
    assert saved[("root_comment", "up")]["state"] == "pending"
    assert saved[("root_comment", "all")]["state"] == "sent"
    assert saved[("alert", "system")]["state"] == "pending"
    assert saved[("heartbeat", "system")]["expires_at"] is not None
    assert saved[("root_comment", "up")]["expires_at"] is None
    assert saved[("alert", "system")]["expires_at"] is None
    assert categories(path) == [("delivery", "up:root_comment")]

    # 阶段切换＋候选：候选属于当前阶段；停用封存后重新启用，补齐的旧候选作废。
    before_alerts = query(path, "SELECT category, object, last_alert_at, event_id FROM notification_alerts")
    before_heartbeats = query(path, "SELECT slot, generated_at, expires_at, event_id FROM notification_heartbeats")
    source = Source().add(DYNAMIC, [
        root_comment("7001", author=UID, nickname="虚构星海", text="已归档评论"),
        root_comment("860901", author=None, text="候选：缺作者"),
    ])
    run_check(path, source, clock, credentials_configured=False, sync=True)
    assert [row["comment_id"] for row in candidates(path)] == ["860901"]

    with archive_client(path) as api:
        for enabled in (False, True):
            assert api.patch(f"{BASE}/{UID}/monitor", json={
                "mode": "specified", "recent_n": 10, "enabled": enabled}).status_code == 200
    # 计数变化触发一次真实重扫：候选只在再次看到并补齐时被消费。
    completed = Source().add(DYNAMIC, [
        root_comment("7001", author=UID, nickname="虚构星海", text="已归档评论"),
        root_comment("860901", author=UID, nickname="虚构星海", text="候选补齐"),
        root_comment("860902", author="303", nickname="虚构路人", ctime=1791513496,
                   text="新出现的旧评论"),
    ])
    run_check(path, completed, clock, credentials_configured=False, sync=True)
    # 候选属于已封存阶段：内容照常归档，但不生成跨阶段通知；告警与心跳状态不被阶段切换清掉。
    assert candidates(path) == []
    assert [row for row in query(path, "SELECT id FROM notification_events WHERE kind = 'root_comment'")
            ] == [{"id": 1}]
    assert query(path, "SELECT category, object, last_alert_at, event_id FROM notification_alerts") == before_alerts
    assert query(path, "SELECT slot, generated_at, expires_at, event_id FROM notification_heartbeats") == before_heartbeats
    assert root_documents(path)["860901"]["text"] == "候选补齐"
    assert Store(path).read_archive(DYNAMIC)["root_comments_error"] is None
    # 系统群恢复后只补发已登记的那一条提醒，不因系统群失败补出新的告警。
    state["fail"] = False
    receiver2 = Receiver()

    async def repaired():
        notifier = dispatcher(path, receiver2, clock, full=ALL_WEBHOOK)
        try:
            clock.advance(3600)
            await notifier.tick()
            await notifier.tick()
        finally:
            await notifier.aclose()

    asyncio.run(repaired())
    alert_texts = [message_text(payload) for payload in receiver2.payloads
                   if "告警【" in message_text(payload)]
    assert len(alert_texts) == 1
    assert message_text(receiver2.payloads[0]).splitlines()[0].startswith("心跳【") is False
    assert categories(path) == [("delivery", "up:root_comment")]
