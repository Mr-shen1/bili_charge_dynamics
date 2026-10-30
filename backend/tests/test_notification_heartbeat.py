"""09：小时心跳——北京时间每小时第 40 分钟到系统群，受控时间、真实持久状态。

真实 SQLite、真实采集/归档/通知模块；只替换 B 站与飞书 HTTP 传输和时间来源。
"""

import asyncio
import json
import os
import sqlite3
import time

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.media import ImageDownloader
from backend.bili_monitor.notifications import Dispatcher
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import readable_html
from backend.tests.collector_support import configured, empty_upstream
from backend.tests.management_support import UID
from backend.tests.notification_support import (
    BeijingClock, FailingUploader, Receiver, Source, assert_no_credentials, beijing_moment, config,
    media_download, message_text, query,
)

SYSTEM_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/fake-system-token"


class StoppingClock(BeijingClock):
    """轮询循环用：睡满次数后停止，不靠真实等待。"""

    def __init__(self, moment, sleeps=1):
        super().__init__(moment)
        self.remaining = sleeps

    async def sleep(self, seconds):
        self.remaining -= 1
        if self.remaining <= 0:
            raise asyncio.CancelledError
        self.advance(seconds)


# 08 告警用例与本票共用同一个受控北京时间（原先两处各写一份相同的实现）。
moment = beijing_moment


def dispatcher(path, receiver, clock, **sections):
    return Dispatcher(Store(path), config(system=SYSTEM_WEBHOOK, **sections),
                      transport=httpx.MockTransport(receiver), clock=clock)


def heartbeats(path):
    return query(path, """SELECT h.slot, h.generated_at, h.expires_at,
        d.role, d.state, d.error, d.expires_at AS delivery_expires_at, e.snapshot
        FROM notification_heartbeats h
        JOIN notification_deliveries d ON d.event_id = h.event_id
        JOIN notification_events e ON e.id = h.event_id ORDER BY h.slot""")


def text_of(receiver, index):
    return message_text(receiver.payloads[index])


def test_heartbeat_fires_at_beijing_minute_40_once_per_hour_across_restart(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)
    clock = BeijingClock(moment(13, 39, 59))
    receiver = Receiver()

    async def before_window():
        notifier = dispatcher(path, receiver, clock)
        try:
            await notifier.tick()
            assert receiver.requests == []  # 13:39:59 不在时段内，不提前生成
            clock.at(13, 40, 0)
            await notifier.tick()
            assert len(receiver.requests) == 1
            clock.advance(300)  # 13:45 同一小时重复调度
            await notifier.tick()
            assert len(receiver.requests) == 1
            assert len(heartbeats(path)) == 1  # 同一小时只有一条持久时段与事件
        finally:
            await notifier.aclose()

    asyncio.run(before_window())
    assert heartbeats(path)[0]["slot"] == "2026-10-09T13"

    async def after_restart():
        # 重开 Store 与 Dispatcher 等于进程重启：小时去重来自持久状态。
        clock.at(13, 59, 59)
        restarted = dispatcher(path, receiver, clock)
        try:
            await restarted.tick()
            assert len(receiver.requests) == 1
            clock.at(14, 40, 0)
            await restarted.tick()
            assert len(receiver.requests) == 2
        finally:
            await restarted.aclose()

    asyncio.run(after_restart())
    saved = heartbeats(path)
    assert [(row["slot"], row["role"], row["state"]) for row in saved] == [
        ("2026-10-09T13", "system", "sent"), ("2026-10-09T14", "system", "sent")]
    assert [(row["url"], ) for row in receiver.requests] == [(SYSTEM_WEBHOOK,), (SYSTEM_WEBHOOK,)]
    assert text_of(receiver, 0).splitlines()[0] == "心跳【2026-10-09 13:40】通知进程存活"
    assert text_of(receiver, 1).splitlines()[0] == "心跳【2026-10-09 14:40】通知进程存活"
    # 有效期不跨下一个心跳时段。
    assert saved[1]["expires_at"] - saved[0]["expires_at"] == 3600
    assert saved[0]["expires_at"] == moment(14, 40).timestamp()


def test_heartbeat_slot_follows_beijing_time_not_server_timezone(tmp_path, monkeypatch):
    path = tmp_path / "archive.sqlite"
    configured(path)
    clock = BeijingClock(moment(13, 10))
    receiver = Receiver()

    async def scenario():
        notifier = dispatcher(path, receiver, clock)
        original = os.environ.get("TZ")
        try:
            # 加尔各答是分钟偏移时区：北京 10 分时当地正好 40 分，不能因此生成。
            monkeypatch.setenv("TZ", "Asia/Kolkata")
            time.tzset()
            await notifier.tick()
            assert receiver.requests == []
            clock.at(13, 40)  # 当地反而是 10 分
            await notifier.tick()
            assert text_of(receiver, 0).splitlines()[0] == "心跳【2026-10-09 13:40】通知进程存活"
            for zone, hour in (("UTC", 14), ("America/New_York", 15), ("Pacific/Kiritimati", 16)):
                monkeypatch.setenv("TZ", zone)
                time.tzset()
                clock.at(hour, 40)
                await notifier.tick()
                assert text_of(receiver, hour - 13).splitlines()[0] == (
                    f"心跳【2026-10-09 {hour}:40】通知进程存活")
        finally:
            if original is None:
                monkeypatch.delenv("TZ", raising=False)
            else:
                monkeypatch.setenv("TZ", original)
            time.tzset()
            await notifier.aclose()

    asyncio.run(scenario())
    assert [row["slot"] for row in heartbeats(path)] == [
        "2026-10-09T13", "2026-10-09T14", "2026-10-09T15", "2026-10-09T16"]


def test_missed_slots_are_not_backfilled_and_slots_cross_hour_and_day(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)
    clock = BeijingClock(moment(13, 5))
    receiver = Receiver()

    async def scenario():
        notifier = dispatcher(path, receiver, clock)
        try:
            await notifier.tick()
            # 停机跨过 13:40–16:40：恢复后既不在时段内也不补发之前的时段。
            clock.moment = moment(17, 39, 59)
            await notifier.tick()
            assert receiver.requests == []
            clock.at(17, 40)
            await notifier.tick()
            assert len(receiver.requests) == 1
            assert text_of(receiver, 0).splitlines()[0] == "心跳【2026-10-09 17:40】通知进程存活"
            # 跨小时到跨天：23:40 → 次日 00:40 是两个时段。
            clock.at(23, 40)
            await notifier.tick()
            clock.moment = moment(0, 40, day=10)
            await notifier.tick()
        finally:
            await notifier.aclose()

    asyncio.run(scenario())
    assert [row["slot"] for row in heartbeats(path)] == [
        "2026-10-09T17", "2026-10-09T23", "2026-10-10T00"]
    assert [text_of(receiver, index).splitlines()[0] for index in range(3)] == [
        "心跳【2026-10-09 17:40】通知进程存活",
        "心跳【2026-10-09 23:40】通知进程存活",
        "心跳【2026-10-10 00:40】通知进程存活",
    ]


def test_heartbeat_window_is_only_the_fortieth_minute(tmp_path, monkeypatch):
    """第 40 分钟这一分钟内生成：之前不提前，之后同小时不重复，重启保留。"""
    path = tmp_path / "archive.sqlite"
    configured(path)
    clock = BeijingClock(moment(10, 39, 59))
    receiver = Receiver()

    async def scenario():
        notifier = dispatcher(path, receiver, clock)
        original = os.environ.get("TZ")
        try:
            # 服务器本地时区不参与窗口判定（东京时间比北京早 1 小时）。
            monkeypatch.setenv("TZ", "Asia/Tokyo")
            time.tzset()
            await notifier.tick()
            assert receiver.requests == []  # 10:39:59 还没到第 40 分钟
            clock.at(10, 40, 0)
            await notifier.tick()
            assert len(receiver.requests) == 1  # 10:40:00 到点
            clock.at(10, 40, 59)
            await notifier.tick()
            assert len(receiver.requests) == 1  # 同一分钟内重复轮询不生成第二条
        finally:
            if original is None:
                monkeypatch.delenv("TZ", raising=False)
            else:
                monkeypatch.setenv("TZ", original)
            time.tzset()
            await notifier.aclose()

    asyncio.run(scenario())

    async def after_restart():
        # 窗口关闭后重启（10:55）：已生成的心跳保留，不为本小时再补一条。
        clock.at(10, 55, 0)
        restarted = dispatcher(path, receiver, clock)
        try:
            await restarted.tick()
            assert len(receiver.requests) == 1
        finally:
            await restarted.aclose()

    asyncio.run(after_restart())
    assert [(row["slot"], row["state"]) for row in heartbeats(path)] == [("2026-10-09T10", "sent")]
    assert text_of(receiver, 0).splitlines()[0] == "心跳【2026-10-09 10:40】通知进程存活"


def test_first_start_after_the_window_never_backfills_the_hour(tmp_path):
    """本小时第 40 分钟之后才首次启动时不补发；窗口末端的一秒仍算到点。"""
    receiver = Receiver()

    async def first_start(path, clock):
        notifier = dispatcher(path, receiver, clock)
        try:
            await notifier.tick()
        finally:
            await notifier.aclose()

    late = tmp_path / "late.sqlite"
    configured(late)
    asyncio.run(first_start(late, BeijingClock(moment(10, 41, 0))))
    later = tmp_path / "later.sqlite"
    configured(later)
    asyncio.run(first_start(later, BeijingClock(moment(10, 55, 0))))
    # 10:41 与 10:55 首次启动都不补 10:40：错过的时段是空缺，不是迟补。
    assert receiver.requests == []
    assert heartbeats(late) == [] and heartbeats(later) == []

    edge = tmp_path / "edge.sqlite"
    configured(edge)
    clock = BeijingClock(moment(10, 40, 59))
    asyncio.run(first_start(edge, clock))
    # 窗口覆盖整分钟：1 秒轮询不必精确命中 :40:00。
    assert [row["slot"] for row in heartbeats(edge)] == ["2026-10-09T10"]
    assert text_of(receiver, 0).splitlines()[0] == "心跳【2026-10-09 10:40】通知进程存活"

    async def next_hour():
        notifier = dispatcher(edge, receiver, clock)
        try:
            clock.at(11, 40, 0)  # 恢复后只处理当前时段
            await notifier.tick()
        finally:
            await notifier.aclose()

    asyncio.run(next_hour())
    assert [row["slot"] for row in heartbeats(edge)] == ["2026-10-09T10", "2026-10-09T11"]
    assert len(receiver.requests) == 2


def test_generated_heartbeat_retries_outside_the_window_until_it_expires(tmp_path):
    """已生成待发的心跳在有效期前仍可重试：窗口关闭不等于放弃投递。"""
    path = tmp_path / "archive.sqlite"
    configured(path)
    clock = BeijingClock(moment(10, 40, 0))
    failing = {"on": True}

    def responder(request):
        if failing["on"]:
            return httpx.Response(500, json={"code": 500, "msg": "fictional"})
        return httpx.Response(200, json={"code": 0, "msg": "success"})

    receiver = Receiver(responder)

    async def scenario():
        notifier = dispatcher(path, receiver, clock)
        try:
            await notifier.tick()  # 10:40:00 生成，发送失败
            assert [(row["slot"], row["state"]) for row in heartbeats(path)] == [
                ("2026-10-09T10", "pending")]
            clock.at(10, 41, 0)  # 窗口已关闭，待发心跳仍按退避重试
            await notifier.tick()
            failing["on"] = False
            clock.at(10, 55, 0)
            await notifier.tick()
            await notifier.tick()
        finally:
            await notifier.aclose()

    asyncio.run(scenario())
    assert [(row["slot"], row["state"]) for row in heartbeats(path)] == [("2026-10-09T10", "sent")]
    # 三条请求都是已生成的那条 10:40 心跳，窗口关闭不新增第二条也不改标签。
    assert [text_of(receiver, index).splitlines()[0]
            for index in range(len(receiver.requests))] == [
        "心跳【2026-10-09 10:40】通知进程存活"] * 3


def test_missing_system_route_keeps_local_diagnosis_and_drops_heartbeat_after_expiry(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)
    clock = BeijingClock(moment(13, 40))
    receiver = Receiver()

    async def scenario():
        blocked = Dispatcher(Store(path), config(up=None, system=None),
                             transport=httpx.MockTransport(receiver), clock=clock)
        try:
            await blocked.tick()
        finally:
            await blocked.aclose()
        assert receiver.requests == []  # 系统群缺失：不发无效 HTTP，也不转投业务群
        assert [(row["slot"], row["state"], row["error"]) for row in heartbeats(path)] == [
            ("2026-10-09T13", "waiting_config", "route_missing")]

        clock.at(14, 40)  # 修复配置时已到本时段有效期末端（13 时段作废），本小时窗口仍在
        repaired = dispatcher(path, receiver, clock)
        try:
            await repaired.tick()
        finally:
            await repaired.aclose()

    asyncio.run(scenario())
    saved = heartbeats(path)
    assert [(row["slot"], row["state"], row["error"]) for row in saved] == [
        ("2026-10-09T13", "expired", "expired"), ("2026-10-09T14", "sent", None)]
    assert len(receiver.requests) == 1
    assert text_of(receiver, 0).splitlines()[0] == "心跳【2026-10-09 14:40】通知进程存活"
    assert_no_credentials(path, SYSTEM_WEBHOOK)


def test_failed_system_group_abandons_the_heartbeat_without_backfilling_later(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)
    clock = BeijingClock(moment(13, 40))
    failing = {"on": True}

    def responder(request):
        if failing["on"]:
            return httpx.Response(500, json={"code": 500, "msg": "fictional"})
        return httpx.Response(200, json={"code": 0, "msg": "success"})

    receiver = Receiver(responder)

    async def scenario():
        notifier = dispatcher(path, receiver, clock)
        try:
            await notifier.tick()
            assert [(row["slot"], row["state"]) for row in heartbeats(path)] == [("2026-10-09T13", "pending")]
            for delay in (2, 4, 8, 16, 32):  # 指数退避重试，不真实等待
                clock.advance(delay)
                await notifier.tick()
            # 05 之后：同一套退避与放弃规则也作用于心跳，四次尝试失败就放弃这一条。
            attempts = len(receiver.requests)
            assert attempts == 4 and all("13:40" in message_text(
                request["payload"]) for request in receiver.requests)
            failing["on"] = False
            clock.at(14, 40)  # 13 时段到此失效；14 时段窗口刚好打开
            await notifier.tick()
            await notifier.tick()
        finally:
            await notifier.aclose()
        return attempts

    asyncio.run(scenario())
    saved = heartbeats(path)
    # 放弃与过期共用同一个终态；错误原因可辨，且恢复后不补发已放弃的旧心跳。
    assert [(row["slot"], row["state"], row["error"]) for row in saved] == [
        ("2026-10-09T13", "expired", "retry_exhausted"), ("2026-10-09T14", "sent", None)]
    assert [text_of(receiver, index).splitlines()[0] for index in range(4, len(receiver.requests))] == [
        "心跳【2026-10-09 14:40】通知进程存活"]


class MultiSource:
    """124 的页面读取失败；125 带图且媒体上传失败，正文仍成功。"""

    def __init__(self):
        self.pictures = [{"url": "https://i0.hdslb.com/fake.png", "width": 1, "height": 1}]

    def __call__(self, request):
        if request.url.path.startswith("/opus/"):
            dynamic_id = request.url.path.rsplit("/", 1)[-1]
            if dynamic_id == "124":
                raise httpx.ConnectError("fictional body failure", request=request)
            pictures = self.pictures if dynamic_id == "125" else []
            return httpx.Response(200, text=readable_html(id=dynamic_id, pictures=pictures))
        return empty_upstream(request)


def test_heartbeat_reports_observable_collection_facts_without_claiming_success(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path, ids=("123", "124", "125"))
    clock = BeijingClock(moment(13, 39, 50))
    receiver = Receiver()

    async def scenario():
        source = MultiSource()
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client, \
                httpx.AsyncClient(transport=httpx.MockTransport(media_download)) as media:
            collector = Collector(Store(path), client, ImageDownloader(media), FailingUploader(),
                                  clock=clock.collector, page_check_seconds=0)
            for dynamic_id in ("123", "124", "125"):
                await collector.check_once(UID, dynamic_id)
            await collector.execute_pending()
        notifier = dispatcher(path, receiver, clock)
        try:
            clock.at(13, 40)
            await notifier.tick()
        finally:
            await notifier.aclose()

    asyncio.run(scenario())
    # 124 的页面读取失败在 08 之后还会产生一条系统告警：这里只取心跳那一条载荷。
    text = next(message_text(payload) for payload in receiver.payloads
                if message_text(payload).startswith("心跳【"))
    assert text.splitlines() == [
        "心跳【2026-10-09 13:40】通知进程存活",
        "采集观察：纳管 3 个目标，已检查 3 个，最近检查 2026-10-09 13:39:50",
        "最近一次检查：失败 1 个，正文待同步 2 个",
        "仅报告本地已记录状态，进程存活不等于采集成功",
    ]
    # 采集有失败与滞后时不得出现“正常/全部”一类断言。
    assert "正常" not in text and "全部" not in text


def test_heartbeat_reports_unknown_state_when_targets_are_not_checked_yet(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)
    clock = BeijingClock(moment(13, 40))
    receiver = Receiver()

    async def scenario():
        notifier = dispatcher(path, receiver, clock)
        try:
            await notifier.tick()
        finally:
            await notifier.aclose()

    asyncio.run(scenario())
    text = message_text(receiver.payloads[0])
    assert text.splitlines()[:3] == [
        "心跳【2026-10-09 13:40】通知进程存活",
        "采集观察：纳管 1 个目标，已检查 0 个，最近检查 无记录",
        "最近一次检查：失败 0 个，正文待同步 0 个",
    ]
    assert "正常" not in text and "全部" not in text


def test_heartbeat_expiry_never_drops_business_messages_sharing_the_queue(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)
    clock = BeijingClock(moment(13, 30))
    failing = {"on": True}

    def responder(request):
        if failing["on"]:
            return httpx.Response(500, json={"code": 500, "msg": "fictional"})
        return httpx.Response(200, json={"code": 0, "msg": "success"})

    receiver = Receiver(responder)

    async def scenario():
        source = Source("v1")
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=clock.collector, page_check_seconds=0)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            source.page = "v2"
            await collector.check_once(UID, "123")
            await collector.execute_pending()
        notifier = dispatcher(path, receiver, clock)
        try:
            await notifier.tick()  # 13:30 不在心跳时段，只有业务消息在队列里失败重试
            clock.at(13, 40)
            await notifier.tick()  # 心跳生成，飞书整体故障：两条都保留待重试
            failing["on"] = False
            clock.at(14, 40)  # 业务消息已超过一小时，13 时段心跳到期作废，14 时段窗口打开
            await notifier.tick()
            await notifier.tick()
        finally:
            await notifier.aclose()

    asyncio.run(scenario())
    rows = query(path, """SELECT d.role, d.state, d.error, d.expires_at, d.attempts, e.kind, e.snapshot
        FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
        ORDER BY d.id""")
    assert [(row["kind"], row["role"], row["state"]) for row in rows] == [
        ("dynamic_changed", "up", "sent"), ("heartbeat", "system", "expired"),
        ("heartbeat", "system", "sent")]
    assert rows[0]["expires_at"] is None  # 业务消息没有有效期，不会被心跳规则误删
    assert json.loads(rows[1]["snapshot"])["slot"] == "2026-10-09T13"
    assert rows[1]["attempts"] == 1 and rows[1]["error"] == "expired"
    assert json.loads(rows[2]["snapshot"])["slot"] == "2026-10-09T14"
    received = [message_text(request["payload"]) for request in receiver.requests]
    # 过期后不再尝试旧心跳；业务消息在超过一小时后仍被真正投递。
    assert len([text for text in received if text.startswith("心跳【2026-10-09 13:40】")]) == 1
    assert len([text for text in received if text.startswith("动态【123】")]) == 3
    assert len([text for text in received if text.startswith("心跳【2026-10-09 14:40】")]) == 1


def test_notification_loop_publishes_heartbeat_without_a_second_clock_process(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)
    clock = StoppingClock(moment(13, 40), sleeps=1)
    receiver = Receiver()

    async def scenario():
        notifier = Dispatcher(Store(path), config(system=SYSTEM_WEBHOOK),
                              transport=httpx.MockTransport(receiver), clock=clock, poll_seconds=0)
        try:
            with pytest.raises(asyncio.CancelledError):
                await notifier.run()
        finally:
            await notifier.aclose()

    asyncio.run(scenario())
    assert len(receiver.requests) == 1
    assert text_of(receiver, 0).splitlines()[0] == "心跳【2026-10-09 13:40】通知进程存活"


def test_heartbeat_only_uses_notification_state_and_never_touches_collection(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)
    clock = BeijingClock(moment(13, 40))
    receiver = Receiver()

    def counts():
        with sqlite3.connect(path) as connection:
            names = [row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'")]
            return {name: connection.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0] for name in names}

    before = counts()

    async def scenario():
        notifier = dispatcher(path, receiver, clock)
        try:
            await notifier.tick()
        finally:
            await notifier.aclose()

    asyncio.run(scenario())
    after = counts()
    changed = {name for name in after if after[name] != before[name]}
    # 心跳只写通知状态：不写检查、归档或监控配置，不能凭空制造“采集成功”。
    assert changed == {"notification_events", "notification_deliveries", "notification_heartbeats"}
    assert after["archives"] == after["target_checks"] == 0
