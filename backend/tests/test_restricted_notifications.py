"""受限动态也要可见：来源把动态标成 BLOCKED 时仍要发飞书，评论通知不受影响。

真实 SQLite、真实采集/归档/通知模块；只替换来源传输与时钟。场景对应生产上
「一条永远 BLOCKED 的动态」：正文永远拿不到，但受限本身与它下面的新评论都要通知。
"""

import asyncio
import json

import httpx

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.notifications import Dispatcher
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import author_html
from backend.tests.collector_clock import ControlledClock
from backend.tests.collector_support import configured
from backend.tests.management_support import UID
from backend.tests.notification_support import (
    BASE_URL, WEBHOOK, BeijingClock, Receiver, config, deliveries, events, query,
)
from backend.tests.test_comment_sync_status import CommentSource

DYNAMIC = "123"
# 远晚于阶段起点：证明「受限不影响起点之后的评论通知」。
FUTURE_CTIME = 1893456000


def blocked_source():
    """正文页面解析不出 CONTENT、detail 又是 BLOCKED：这条动态永远读不到正文。"""
    source = CommentSource()
    source.blocked = True
    source.html = author_html().replace(
        '"modules":[', '"modules":[{"module_type":"MODULE_TYPE_TITLE","module_title":{"text":"受限标题"}},')
    return source


def collect(path, source, clock, rounds=1):
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=clock)
            for _ in range(rounds):
                await collector.check_once(UID, DYNAMIC)
                await collector.execute_pending()

    asyncio.run(scenario())


def kinds(path):
    return [row["kind"] for row in query(path, "SELECT kind FROM notification_events ORDER BY id")]


def deliver(path):
    receiver = Receiver()

    async def scenario():
        notifier = Dispatcher(Store(path), config(), transport=httpx.MockTransport(receiver),
                              clock=BeijingClock.start(13, 0))
        try:
            await notifier.run_once()
        finally:
            await notifier.aclose()

    asyncio.run(scenario())
    return receiver


def test_blocked_body_notifies_once_per_phase(tmp_path):
    path = tmp_path / "blocked.sqlite"
    configured(path)
    source, clock = blocked_source(), ControlledClock()

    collect(path, source, clock)
    assert kinds(path) == ["dynamic_restricted"]
    # 只发 UP 群：受限提示与「发生变化」同角色，不进全员群。
    assert [(row["role"], row["state"]) for row in deliveries(path)] == [("up", "pending")]

    # 每 60 秒的重复页面检查不重复提示：事件身份按阶段令牌去重。
    clock.advance(15)
    collect(path, source, clock, rounds=2)
    assert kinds(path).count("dynamic_restricted") == 1


def test_blocked_notification_delivers_restricted_template(tmp_path):
    path = tmp_path / "deliver.sqlite"
    configured(path)
    collect(path, blocked_source(), ControlledClock())

    receiver = deliver(path)
    assert [request["url"] for request in receiver.requests] == [WEBHOOK]
    body = json.dumps(receiver.payloads[0], ensure_ascii=False)
    assert "受限" in body and "受限标题" in body
    assert f"{BASE_URL}/dynamics/{DYNAMIC}" in body
    assert [row["state"] for row in deliveries(path)] == ["sent"]


def test_new_comments_under_a_blocked_dynamic_still_notify(tmp_path):
    """受限只影响正文：起点之后的新评论照常登记并投递。"""
    path = tmp_path / "comments.sqlite"
    configured(path)
    source, clock = blocked_source(), ControlledClock()
    for root in source.roots:
        root["ctime"] = FUTURE_CTIME

    collect(path, source, clock)
    registered = kinds(path)
    assert registered.count("root_comment") == len(source.roots)
    assert registered.count("dynamic_restricted") == 1
    # 作者是 UP 本人：一级评论同时进 UP 群与全员群。
    assert {row["role"] for row in deliveries(path) if row["state"] == "pending"} == {"up", "all"}


def test_blocked_state_registers_nothing_when_notifications_are_off(tmp_path):
    path = tmp_path / "off.sqlite"
    configured(path)
    store = Store(path)
    store.update_notification_switch("off")

    collect(path, blocked_source(), ControlledClock())
    assert events(path) == [] and deliveries(path) == []


def test_blocked_notice_is_not_repeated_after_reentry(tmp_path):
    """受限是已确认终态：同一受限版本不再重抓，重新加入监控也不重复提示。"""
    path = tmp_path / "reentry.sqlite"
    configured(path)
    source, clock = blocked_source(), ControlledClock()
    collect(path, source, clock)
    assert kinds(path) == ["dynamic_restricted"]

    store = Store(path)
    store.delete_target(UID, DYNAMIC)
    store.add_target(UID, DYNAMIC)
    collect(path, source, clock)
    assert kinds(path).count("dynamic_restricted") == 1
