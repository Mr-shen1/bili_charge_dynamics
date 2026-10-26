"""15：通知三态（`all` / `system_only` / `off`）——登记侧与投递侧共用一个持久状态。

真实 SQLite、真实归档/采集/投递模块；只替换 B 站与飞书 HTTP 传输和时间来源。
状态是持久标识而不是进程变量：`off` 期间不登记、不投递、不生成心跳，切回 `all`
时把业务起点前移到此刻，因此关闭期间的内容永远不会在切回后补发。
"""

import asyncio
import logging
import sqlite3
from contextlib import contextmanager

import httpx

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.notifications import Dispatcher
from backend.bili_monitor.storage import Store
from backend.tests.management_support import UID
from backend.tests.notification_support import (
    DYNAMIC, WEBHOOK, BeijingClock, Receiver, Source, config, deliveries, drain, events, query,
)
from backend.tests.test_notification_alerts import SYSTEM_WEBHOOK
from backend.tests.test_notification_delivery import archived_changes

GATE_LOGGER = logging.getLogger("bili_monitor.notifier")


def more_changes(path, versions):
    """在已配置的库上继续产生正文变化；不重新添加 UP（重复 `configured` 会重得 201）。"""
    source = Source("v1")

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            for edited in versions:
                source.page, source.edited = "v2", edited
                await collector.check_once(UID, DYNAMIC)
                await collector.execute_pending()

    asyncio.run(run())


def dispatcher(path, transport, clock, **sections):
    sections.setdefault("system", SYSTEM_WEBHOOK)
    return Dispatcher(Store(path), config(**sections), transport=httpx.MockTransport(transport),
                      clock=clock)


def heartbeats(path):
    return query(path, "SELECT slot, generated_at, expires_at FROM notification_heartbeats ORDER BY slot")


def state_of(path):
    return Store(path).read_notification_switch()["state"]


def switch(path, state):
    store = Store(path)
    store.migrate()
    return store.update_notification_switch(state)


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


def run_ticks(path, transport, clock, rounds=1):
    async def scenario():
        notifier_process = dispatcher(path, transport, clock)
        try:
            for _ in range(rounds):
                result = await notifier_process.tick()
                clock.advance(1.0)
            return result
        finally:
            await notifier_process.aclose()

    return asyncio.run(scenario())


# --- 持久状态（迁移默认 off、读写与待发统计） -------------------------------

def test_new_database_starts_off_with_nothing_pending(tmp_path):
    """新库默认 `off`：新语义下“默认不发”比“默认全发”安全。"""
    path = tmp_path / "archive.sqlite"
    Store(path).migrate()
    assert Store(path).read_notification_switch() == {"state": "off", "pending": 0}


def test_states_round_trip_and_switching_off_discards_the_queue(tmp_path):
    path = tmp_path / "archive.sqlite"
    switch(path, "all")
    archived_changes(path, ["13:02", "13:03"])

    assert Store(path).read_notification_switch() == {"state": "all", "pending": 2}
    # 进入 off：未投递的记录直接作废，不是“暂停待补”。
    changed, state = switch(path, "off")
    assert (changed, state) == (True, {"state": "off", "pending": 0})
    assert deliveries(path) == []
    assert events(path) == []
    # 幂等：重复写入同一状态仍返回新状态，但不算一次切换。
    assert switch(path, "off") == (False, {"state": "off", "pending": 0})
    assert switch(path, "all")[0] is True
    assert state_of(path) == "all"


def test_system_only_keeps_the_system_queue_and_discards_business(tmp_path):
    """进入 system_only 只作废业务角色的未投递记录，系统角色保留。"""
    path = tmp_path / "archive.sqlite"
    switch(path, "all")
    archived_changes(path, ["13:02"])
    with sqlite3.connect(path) as connection:
        connection.execute("""INSERT INTO notification_events(kind, uid, dynamic_id, version, snapshot, created_at)
            VALUES ('heartbeat', '', 'slot', 'slot', '{}', 0)""")
        connection.execute("""INSERT INTO notification_deliveries(event_id, role, state, due_at)
            VALUES ((SELECT MAX(id) FROM notification_events), 'system', 'pending', 0)""")

    changed, state = switch(path, "system_only")
    assert (changed, state) == (True, {"state": "system_only", "pending": 1})
    assert [row["role"] for row in deliveries(path)] == ["system"]


# --- off：不登记、不投递、不生成心跳 ---------------------------------------

def test_off_registers_nothing_new_from_collection(tmp_path):
    """关闭期间采集照常归档，但不产生任何通知记录。"""
    path = tmp_path / "archive.sqlite"
    switch(path, "all")
    archived_changes(path, ["13:02"])
    switch(path, "off")
    more_changes(path, ["13:05"])

    assert events(path) == [] and deliveries(path) == []
    assert Store(path).read_notification_switch()["pending"] == 0


def test_off_claims_nothing_and_sends_no_request(tmp_path):
    path = tmp_path / "archive.sqlite"
    switch(path, "all")
    archived_changes(path, ["13:02", "13:03", "13:04"])
    clock = BeijingClock.start(13, 0)
    receiver = Receiver()
    switch(path, "off")

    assert run_ticks(path, receiver, clock, rounds=3) == 0
    assert receiver.requests == []
    assert deliveries(path) == []


def test_off_skips_the_heartbeat_window_without_backfill(tmp_path):
    path = tmp_path / "archive.sqlite"
    clock = BeijingClock.start(13, 40)
    receiver = Receiver()

    async def scenario():
        notifier_process = dispatcher(path, receiver, clock)
        try:
            assert await notifier_process.tick() == 0
            clock.at(13, 41)
            assert await notifier_process.tick() == 0
            # 切回 all 后不补关闭期间错过的心跳时段，只在下一个 :40 生成。
            switch(path, "all")
            assert await notifier_process.tick() == 0
            clock.at(14, 40)
            await notifier_process.tick()
        finally:
            await notifier_process.aclose()

    asyncio.run(scenario())
    assert heartbeats(path) and [row["slot"] for row in heartbeats(path)] == ["2026-10-09T14"]
    assert [request["url"] for request in receiver.requests] == [SYSTEM_WEBHOOK]


# --- system_only：只登记并投递系统消息 -------------------------------------

def test_system_only_registers_heartbeat_but_no_business_events(tmp_path):
    path = tmp_path / "archive.sqlite"
    switch(path, "system_only")
    clock = BeijingClock.start(13, 40)
    receiver = Receiver()

    async def scenario():
        notifier_process = dispatcher(path, receiver, clock)
        try:
            await notifier_process.tick()
        finally:
            await notifier_process.aclose()

    asyncio.run(scenario())
    # 只有系统群的心跳，没有业务事件。
    assert [request["url"] for request in receiver.requests] == [SYSTEM_WEBHOOK]
    assert [row["kind"] for row in query(path, "SELECT kind FROM notification_events ORDER BY id")] == [
        "heartbeat"]


# --- 切回 all：起点前移，不补发 -------------------------------------------------

def test_switching_back_to_all_moves_the_cut_forward(tmp_path):
    path = tmp_path / "archive.sqlite"
    switch(path, "all")
    archived_changes(path, ["13:02"])
    switch(path, "off")
    more_changes(path, ["13:05"])          # 关闭期间的变化：不登记
    clock = BeijingClock.start(13, 10)
    receiver = Receiver()

    switch(path, "all")
    assert run_ticks(path, receiver, clock) == 0
    assert receiver.requests == []
    # 起点已前移：关闭期间那条内容不会在切回后补发。
    assert events(path) == []

    more_changes(path, ["13:12"])          # 切回之后的新变化：照常通知
    async def deliver():
        notifier_process = dispatcher(path, receiver, clock)
        try:
            await drain(notifier_process, clock)
        finally:
            await notifier_process.aclose()

    asyncio.run(deliver())
    assert [request["url"] for request in receiver.requests] == [WEBHOOK]
    assert [row["state"] for row in deliveries(path)] == ["sent"]


def test_switching_back_to_all_aligns_the_body_baseline(tmp_path):
    """切回 all 时正文基线对齐当前可信版本：不会为关闭期间的编辑补一条「发生变化」。"""
    path = tmp_path / "archive.sqlite"
    switch(path, "all")
    archived_changes(path, ["13:02"])
    switch(path, "off")
    more_changes(path, ["13:05"])

    switch(path, "all")
    baseline = query(path, "SELECT baseline_version FROM notification_phases")[0]["baseline_version"]
    synced = query(path, "SELECT json_extract(document, '$.synced_version') AS version FROM archives")[0]["version"]
    assert baseline == synced


# --- 读不到状态：按关闭处理，且不阻断归档 ---------------------------------

def test_unreadable_state_table_skips_the_round_instead_of_sending(tmp_path):
    """读不到状态时按关闭处理（不发送）；恢复后显式选 `all`，旧记录按硬停语义作废。"""
    path = tmp_path / "archive.sqlite"
    switch(path, "all")
    archived_changes(path, ["13:02"])
    clock = BeijingClock.start(13, 0)
    receiver = Receiver()
    with sqlite3.connect(path) as connection:
        connection.execute("DROP TABLE notification_gate")

    assert run_ticks(path, receiver, clock) == 0
    assert receiver.requests == []
    assert [row["state"] for row in deliveries(path)] == ["pending"]

    # 恢复可读（重放 v23 迁移建回表，默认 off）后，旧记录在切到 all 时作废。
    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA user_version = 22")
    Store(path).migrate()
    assert state_of(path) == "off"
    switch(path, "all")
    assert deliveries(path) == []

    # 恢复后新产生的变化照常投递。
    more_changes(path, ["13:06"])
    run_ticks(path, receiver, clock)
    assert [row["state"] for row in deliveries(path)] == ["sent"]


def test_unreadable_state_table_does_not_break_archiving(tmp_path):
    """状态表缺失时采集照常归档：通知的存储问题不能让归档事务回滚。"""
    path = tmp_path / "archive.sqlite"
    switch(path, "all")
    archived_changes(path, ["13:02"])
    registered = len(events(path))

    def synced_version():
        return query(path, "SELECT json_extract(document, '$.synced_version') AS version FROM archives")[0]["version"]

    before = synced_version()
    with sqlite3.connect(path) as connection:
        connection.execute("DROP TABLE notification_gate")

    more_changes(path, ["13:05"])

    # 归档照常推进，但一条通知都不登记。
    assert query(path, "SELECT COUNT(*) AS n FROM archives")[0]["n"] == 1
    assert synced_version() != before
    assert len(events(path)) == registered


# --- 日志：切换与跳过都是固定分类，不含地址或凭据 --------------------------

def test_switch_flips_are_logged_once_per_transition_and_stay_safe(tmp_path):
    path = tmp_path / "archive.sqlite"
    switch(path, "all")
    archived_changes(path, ["13:02"])
    clock = BeijingClock.start(13, 0)
    receiver = Receiver()

    async def scenario():
        notifier_process = dispatcher(path, receiver, clock)
        try:
            with notifier_logs() as records:
                for _ in range(3):
                    switch(path, "off")
                    await notifier_process.tick()
                    clock.advance(1.0)
                switch(path, "all")
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
                assert client.put("/api/manage/notifications",
                                  json={"state": "all"}).status_code == 200
            assert client.put("/api/manage/notifications",
                              json={"state": "off"}).status_code == 200
        lines = [record.getMessage() for record in records]
    changed = [line for line in lines if line.startswith("notification_switch_changed")]
    assert len(changed) == 2
    assert changed[0].startswith("notification_switch_changed state=all")
    assert changed[1].startswith("notification_switch_changed state=off")
    assert "open.feishu.cn" not in " ".join(lines) and "token" not in " ".join(lines)


def test_switch_api_rejects_unknown_states(tmp_path):
    from backend.tests.management_support import client_for

    with client_for(tmp_path / "monitor.sqlite") as client:
        for body in ({"state": "paused"}, {"state": "ALL"}, {"enabled": True}, {"state": "all", "x": 1}):
            assert client.put("/api/manage/notifications", json=body).status_code == 422


def test_startup_never_fakes_a_switch_transition(tmp_path):
    """进程启动时状态本来就是 all：不记“切换”日志，免得每次重启都刷一条假事件。"""
    path = tmp_path / "archive.sqlite"
    switch(path, "all")
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


def test_startup_with_off_state_logs_one_skip(tmp_path):
    path = tmp_path / "archive.sqlite"
    switch(path, "all")
    archived_changes(path, ["13:02"])
    clock = BeijingClock.start(13, 0)
    receiver = Receiver()
    switch(path, "off")

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


def test_unreadable_state_logs_once_and_resumes_after_recovery(tmp_path):
    """存储异常按关闭处理，但只记一条；恢复后重新开始登记并只记一次恢复。"""
    path = tmp_path / "archive.sqlite"
    switch(path, "all")
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
                    connection.execute("PRAGMA user_version = 22")
                Store(path).migrate()
                switch(path, "all")
                await notifier_process.tick()
            return [record.getMessage() for record in records]
        finally:
            await notifier_process.aclose()

    lines = asyncio.run(scenario())
    storage_errors = [line for line in lines if line.startswith("delivery_cycle_failed reason=storage_error")]
    assert len(storage_errors) == 1
    assert len([line for line in lines if line.startswith("notification_switch_opened")]) == 1
    # 恢复为 off 后切到 all：旧记录作废，新变化新登记。
    assert deliveries(path) == []
    more_changes(path, ["13:07"])
    run_ticks(path, receiver, clock)
    assert [row["state"] for row in deliveries(path)] == ["sent"]
