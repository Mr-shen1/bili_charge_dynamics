"""14：飞书通知总开关——持久闸门、每轮只读一次、关闭不领取不发 HTTP 不生成心跳。

真实 SQLite、真实归档/采集/投递模块；只替换 B 站与飞书 HTTP 传输和时间来源。
闸门是持久标识而不是进程变量：关闭后进程照常运行，重开后按方案 A 补发积压。
"""

import asyncio
import logging
import sqlite3
from contextlib import contextmanager

import httpx

from backend.bili_monitor.notifications import Dispatcher
from backend.bili_monitor.storage import Store
from backend.tests.notification_support import (
    WEBHOOK, BeijingClock, Receiver, config, deliveries, drain, events, query,
)
from backend.tests.test_notification_alerts import SYSTEM_WEBHOOK
from backend.tests.test_notification_delivery import archived_changes

GATE_LOGGER = logging.getLogger("bili_monitor.notifier")


def dispatcher(path, transport, clock, **sections):
    sections.setdefault("system", SYSTEM_WEBHOOK)
    return Dispatcher(Store(path), config(**sections), transport=httpx.MockTransport(transport),
                      clock=clock)


def heartbeats(path):
    return query(path, "SELECT slot, generated_at, expires_at FROM notification_heartbeats ORDER BY slot")


@contextmanager
def notifier_logs():
    """捕获通知进程日志：切换与跳过都只留固定分类，不含 webhook 或凭据。"""
    records = []
    handler = logging.Handler()
    handler.emit = records.append
    GATE_LOGGER.addHandler(handler)
    try:
        yield records
    finally:
        GATE_LOGGER.removeHandler(handler)


# --- 持久开关（迁移默认开启、读写与待发统计） -------------------------------

def test_new_database_opens_the_gate_and_reports_no_pending(tmp_path):
    path = tmp_path / "archive.sqlite"
    Store(path).migrate()
    assert Store(path).read_notification_switch() == {"enabled": True, "pending": 0}


def test_switch_round_trips_and_counts_only_pending_deliveries(tmp_path):
    path = tmp_path / "archive.sqlite"
    archived_changes(path, ["13:02", "13:03"])

    assert Store(path).read_notification_switch() == {"enabled": True, "pending": 2}
    changed, state = Store(path).update_notification_switch(False)
    assert (changed, state) == (True, {"enabled": False, "pending": 2})
    assert Store(path).read_notification_switch() == {"enabled": False, "pending": 2}
    # 幂等：重复写入同一值仍返回新状态，但不算一次切换。
    assert Store(path).update_notification_switch(False) == (False, {"enabled": False, "pending": 2})
    assert Store(path).update_notification_switch(True)[0] is True
    assert Store(path).read_notification_switch()["enabled"] is True


# --- 关闭时：不领取、不发 HTTP、不生成心跳 ---------------------------------

def test_closed_gate_claims_nothing_and_sends_no_request(tmp_path):
    path = tmp_path / "archive.sqlite"
    archived_changes(path, ["13:02", "13:03", "13:04"])
    clock = BeijingClock.start(13, 0)
    receiver = Receiver()
    Store(path).update_notification_switch(False)
    registered = len(events(path))

    async def scenario():
        notifier_process = dispatcher(path, receiver, clock)
        try:
            for _ in range(3):
                assert await notifier_process.tick() == 0
                clock.advance(1.0)
        finally:
            await notifier_process.aclose()

    asyncio.run(scenario())
    assert receiver.requests == []
    # 关闭期间不领取：记录仍是待发、没有租约/凭证，也不消耗 attempts。
    assert {row["state"] for row in deliveries(path)} == {"pending"}
    assert all((row["attempts"], row["token"], row["lease_until"]) == (0, None, None)
               for row in deliveries(path))
    # 不重复登记事件：事件由采集写事务产生，通知进程关闭不写新事件。
    assert len(events(path)) == registered
    assert Store(path).read_notification_switch()["pending"] == 3


def test_closed_gate_skips_the_heartbeat_window_without_backfill(tmp_path):
    path = tmp_path / "archive.sqlite"
    archived_changes(path, ["13:02"])
    clock = BeijingClock.start(13, 40)
    receiver = Receiver()
    Store(path).update_notification_switch(False)

    async def scenario():
        notifier_process = dispatcher(path, receiver, clock)
        try:
            await notifier_process.tick()
            clock.at(13, 41)
            await notifier_process.tick()
            # 打开后不补关闭期间错过的心跳时段，只在下一个 :40 生成。
            Store(path).update_notification_switch(True)
            await notifier_process.tick()
            clock.at(14, 40)
            await notifier_process.tick()
        finally:
            await notifier_process.aclose()

    asyncio.run(scenario())
    assert [row["slot"] for row in heartbeats(path)] == ["2026-10-09T14"]
    # 只有重开后的一笔业务消息与 14:40 的心跳：关闭期间的心跳时段不补。
    assert [request["url"] for request in receiver.requests] == [WEBHOOK, SYSTEM_WEBHOOK]


def test_unreadable_gate_skips_the_round_instead_of_sending(tmp_path):
    """读不到开关时按关闭处理（不发送），下一轮恢复正常投递。"""
    path = tmp_path / "archive.sqlite"
    archived_changes(path, ["13:02"])
    clock = BeijingClock.start(13, 0)
    receiver = Receiver()
    with sqlite3.connect(path) as connection:
        connection.execute("DROP TABLE notification_gate")

    async def scenario():
        notifier_process = dispatcher(path, receiver, clock)
        try:
            assert await notifier_process.tick() == 0
        finally:
            await notifier_process.aclose()

    asyncio.run(scenario())
    assert receiver.requests == []
    assert [row["state"] for row in deliveries(path)] == ["pending"]

    # 恢复可读（重放 v22 迁移建回表）后，同一条记录立即正常投递。
    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA user_version = 21")
    Store(path).migrate()

    async def reopened():
        notifier_process = dispatcher(path, receiver, clock)
        try:
            await notifier_process.tick()
        finally:
            await notifier_process.aclose()

    asyncio.run(reopened())
    assert [row["state"] for row in deliveries(path)] == ["sent"]


# --- 重开：按方案 A 补发积压，受限速约束且不重复 ---------------------------

def test_reopening_delivers_the_backlog_once_within_the_send_budget(tmp_path):
    path = tmp_path / "archive.sqlite"
    archived_changes(path, [f"13:{minute:02d}" for minute in range(2, 10)])  # 8 条同群
    clock = BeijingClock.start(13, 0)
    calls = []

    def recorder(request):
        calls.append(clock.now())
        return httpx.Response(200, json={"code": 0, "msg": "success"})

    async def scenario():
        notifier_process = dispatcher(path, recorder, clock)
        try:
            Store(path).update_notification_switch(False)
            assert await notifier_process.tick() == 0
            Store(path).update_notification_switch(True)
            await drain(notifier_process, clock)
        finally:
            await notifier_process.aclose()

    asyncio.run(scenario())
    assert len(calls) == 8 and len(events(path)) == 8
    assert [row["state"] for row in deliveries(path)] == ["sent"] * 8
    # 补发走 13 的主动限速：任意 1 秒窗口内同一目的地不超过 5 次。
    windows = [sum(1 for moment in calls if start <= moment < start + 1.0) for start in set(calls)]
    assert max(windows) <= 5
    assert all((row["attempts"], row["failures"]) == (1, 0) for row in deliveries(path))


# --- 日志：切换与跳过都是固定分类，不含地址或凭据 --------------------------

def test_switch_flips_are_logged_once_per_transition_and_stay_safe(tmp_path):
    path = tmp_path / "archive.sqlite"
    archived_changes(path, ["13:02"])
    clock = BeijingClock.start(13, 0)
    receiver = Receiver()

    async def scenario():
        notifier_process = dispatcher(path, receiver, clock)
        try:
            with notifier_logs() as records:
                for _ in range(3):
                    Store(path).update_notification_switch(False)
                    await notifier_process.tick()
                    clock.advance(1.0)
                Store(path).update_notification_switch(True)
                await notifier_process.tick()
            return [record.getMessage() for record in records]
        finally:
            await notifier_process.aclose()

    lines = asyncio.run(scenario())
    skipped = [line for line in lines if line.startswith("delivery_skipped")]
    # 关闭期间每轮都跳过，但只记录一次固定分类，不每秒刷一条日志。
    assert len(skipped) == 1 and "switch_off" in skipped[0]
    assert len([line for line in lines if line.startswith("notification_switch_opened")]) == 1
    assert "fake-up-token" not in " ".join(lines) and "open.feishu.cn" not in " ".join(lines)


def test_switch_api_logs_only_real_flips_with_fixed_fields(tmp_path):
    """管理页切换留一条固定分类；幂等重复写不制造日志噪声，且不含地址或凭据。"""
    from backend.tests.management_support import client_for

    with client_for(tmp_path / "monitor.sqlite") as client:
        with notifier_logs() as records:
            for _ in range(2):
                assert client.put("/api/manage/notifications", json={"enabled": False}).status_code == 200
            assert client.put("/api/manage/notifications", json={"enabled": True}).status_code == 200
        lines = [record.getMessage() for record in records]
    changed = [line for line in lines if line.startswith("notification_switch_changed")]
    assert len(changed) == 2
    assert changed[0].startswith("notification_switch_changed enabled=false")
    assert changed[1].startswith("notification_switch_changed enabled=true")
    assert "open.feishu.cn" not in " ".join(lines) and "token" not in " ".join(lines)


def test_startup_never_fakes_a_switch_transition(tmp_path):
    """进程启动时开关本来就是开的：不记“切换”日志，免得每次重启都刷一条假事件。"""
    path = tmp_path / "archive.sqlite"
    archived_changes(path, ["13:02"])
    clock = BeijingClock.start(13, 0)
    receiver = Receiver()

    async def scenario():
        notifier_process = dispatcher(path, receiver, clock)
        try:
            with notifier_logs() as records:
                await notifier_process.tick()
            return [record.getMessage() for record in records]
        finally:
            await notifier_process.aclose()

    lines = asyncio.run(scenario())
    assert not [line for line in lines if line.startswith("notification_switch_opened")]
    assert [row["state"] for row in deliveries(path)] == ["sent"]


def test_startup_with_a_closed_gate_logs_one_skip(tmp_path):
    path = tmp_path / "archive.sqlite"
    archived_changes(path, ["13:02"])
    clock = BeijingClock.start(13, 0)
    receiver = Receiver()
    Store(path).update_notification_switch(False)

    async def scenario():
        notifier_process = dispatcher(path, receiver, clock)
        try:
            with notifier_logs() as records:
                await notifier_process.tick()
            return [record.getMessage() for record in records]
        finally:
            await notifier_process.aclose()

    lines = asyncio.run(scenario())
    assert [line for line in lines if line.startswith("delivery_skipped reason=switch_off")] == [
        "delivery_skipped reason=switch_off"]
    assert receiver.requests == []


def test_unreadable_gate_logs_once_and_resumes_after_recovery(tmp_path):
    """存储异常按关闭处理，但只记一条；恢复后重新开始投递并只记一次恢复。"""
    path = tmp_path / "archive.sqlite"
    archived_changes(path, ["13:02"])
    clock = BeijingClock.start(13, 0)
    receiver = Receiver()
    with sqlite3.connect(path) as connection:
        connection.execute("DROP TABLE notification_gate")

    async def scenario():
        notifier_process = dispatcher(path, receiver, clock)
        try:
            with notifier_logs() as records:
                for _ in range(3):
                    await notifier_process.tick()
                    clock.advance(1.0)
                with sqlite3.connect(path) as connection:
                    connection.execute("PRAGMA user_version = 21")
                Store(path).migrate()
                await notifier_process.tick()
            return [record.getMessage() for record in records]
        finally:
            await notifier_process.aclose()

    lines = asyncio.run(scenario())
    storage_errors = [line for line in lines if line.startswith("delivery_cycle_failed reason=storage_error")]
    assert len(storage_errors) == 1
    assert len([line for line in lines if line.startswith("notification_switch_opened")]) == 1
    assert [row["state"] for row in deliveries(path)] == ["sent"]
