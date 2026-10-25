"""01／04：通知 schema 迁移保留旧归档/观察状态、可重复执行且失败可回滚。"""

import asyncio
import json
import sqlite3
import time

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from backend.tests.collector_support import configured
from backend.tests.management_support import UID
from backend.tests.notification_support import DYNAMIC, Source, deliveries, events, query

NOTIFICATION_TABLES = (
    "notification_deliveries", "notification_events", "notification_versions",
    "notification_body_claims", "notification_phases", "notification_heartbeats",
    "notification_candidates",
)


def archived_database(path):
    """用真实采集/归档入口建库，再退回「尚未引入通知表」的 v15 形态。"""
    configured(path)
    source = Source("v1")

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()

    asyncio.run(run())
    with sqlite3.connect(path) as connection:
        for table in NOTIFICATION_TABLES:
            connection.execute(f"DROP TABLE {table}")
        connection.execute("PRAGMA user_version = 15")
    return {"archive": Store(path).read_archive(DYNAMIC), "checks": Store(path).read_checks(UID)}


def version(path):
    with sqlite3.connect(path) as connection:
        return connection.execute("PRAGMA user_version").fetchone()[0]


def tables(path):
    return {row["name"] for row in query(path, "SELECT name FROM sqlite_master WHERE type = 'table'")}


def test_existing_database_keeps_archive_and_checks_and_reuses_trusted_baseline(tmp_path):
    path = tmp_path / "legacy.sqlite"
    before = archived_database(path)
    assert version(path) == 15

    Store(path).migrate()

    assert version(path) == 18
    assert set(NOTIFICATION_TABLES) <= tables(path)
    assert Store(path).read_archive(DYNAMIC) == before["archive"]
    assert Store(path).read_checks(UID) == before["checks"]
    phases = query(path, "SELECT * FROM notification_phases")
    assert [(row["uid"], row["dynamic_id"], row["baseline_version"], row["sealed"]) for row in phases] == [
        (UID, DYNAMIC, before["archive"]["synced_version"], 0)]
    # 已有可信版本只作为静默基线：不补发旧版本。
    assert events(path) == [] and deliveries(path) == []

    Store(path).migrate()
    assert version(path) == 18
    assert len(query(path, "SELECT token FROM notification_phases")) == 1
    assert events(path) == []


def test_failed_notification_migration_rolls_back_and_can_retry(tmp_path):
    path = tmp_path / "legacy.sqlite"
    before = archived_database(path)
    # 同名不同结构的残留对象让建索引失败；迁移事务必须整体回滚。
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE notification_phases (token TEXT PRIMARY KEY)")

    with pytest.raises(sqlite3.OperationalError):
        Store(path).migrate()

    assert version(path) == 15
    assert {name for name in tables(path) if name.startswith("notification_")} == {"notification_phases"}
    assert Store(path).read_archive(DYNAMIC) == before["archive"]
    with sqlite3.connect(path) as connection:
        connection.execute("DROP TABLE notification_phases")
    Store(path).migrate()
    assert version(path) == 18
    assert set(NOTIFICATION_TABLES) <= tables(path)
    assert Store(path).read_archive(DYNAMIC) == before["archive"]


def test_fresh_database_migrates_without_phases_or_events(tmp_path):
    path = tmp_path / "fresh.sqlite"
    Store(path).migrate()
    assert version(path) == 18
    assert set(NOTIFICATION_TABLES) <= tables(path)
    assert query(path, "SELECT * FROM notification_phases") == []
    assert query(path, "SELECT * FROM notification_deliveries") == []
    assert query(path, "SELECT * FROM notification_events") == []


def test_upgrade_never_backfills_already_archived_comments(tmp_path):
    """v17 → v18：01 阶段的旧起点不回填历史评论；升级后发表的新评论照常通知。"""
    from backend.tests.root_notification_support import (
        DYNAMIC as ROOT_DYNAMIC, Source, configure, delivered, dispatcher, root_comment, started_at,
    )
    from backend.tests.notification_support import ALL_WEBHOOK, WEBHOOK, Receiver
    from backend.bili_monitor.collector import Collector
    from backend.tests.management_support import UID as ROOT_UID
    import math

    path = tmp_path / "upgrade.sqlite"
    source = Source().add(ROOT_DYNAMIC, [])
    configure(path, source)
    boundary = math.floor(started_at(path))
    # 01 阶段开始后、04 升级前的评论：它们的起点早于评论通知能力存在的时间。
    source.add(ROOT_DYNAMIC, [root_comment("860901", ctime=boundary - 3600, text="01 之后、04 之前归档的评论")])

    async def archive():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(ROOT_UID, ROOT_DYNAMIC)
            await collector.execute_pending()

    asyncio.run(archive())
    assert len(query(path, "SELECT id FROM root_comments")) == 1  # 历史评论照常归档
    assert events(path) == []
    # 还原成评论增量之前的形态：没有评论起点列值，也没有评论事件索引与候选表。
    with sqlite3.connect(path) as connection:
        connection.execute("UPDATE notification_phases SET comment_started_at = NULL")
        connection.execute("DROP INDEX IF EXISTS notification_event_comment")
        connection.execute("DROP TABLE notification_candidates")
        connection.execute("DELETE FROM notification_deliveries")
        connection.execute("DELETE FROM notification_events")
        connection.execute("PRAGMA user_version = 16")

    Store(path).migrate()
    assert version(path) == 18
    phase = query(path, "SELECT started_at, comment_started_at FROM notification_phases")[0]
    # 已有的 01 起点保留为正文基线，但评论起点从升级时刻重新建立。
    assert phase["comment_started_at"] > phase["started_at"]
    # 评论起点是升级时刻：晚于升级前已归档评论的发表时间，因此不会回填历史。
    assert phase["comment_started_at"] > boundary - 3599

    # 强制重扫已归档评论：升级前已归档的评论静默，不产生回填事件。
    source.spec(ROOT_DYNAMIC)["count"] = 2
    source.add(ROOT_DYNAMIC, [
        root_comment("860901", ctime=boundary - 3600, text="01 之后、04 之前归档的评论"),
        root_comment("860902", author="303", nickname="虚构路人", ctime=boundary - 3599, text="升级前发表但未归档"),
    ])
    asyncio.run(archive())
    receiver = Receiver()
    asyncio.run(dispatcher(path, transport=httpx.MockTransport(receiver), full=ALL_WEBHOOK).run_once())
    assert receiver.requests == [] and events(path) == []

    # 升级之后发表的评论仍按新起点进入通知。
    source.add(ROOT_DYNAMIC, [
        root_comment("860901", ctime=boundary - 3600, text="01 之后、04 之前归档的评论"),
        root_comment("860902", author="303", nickname="虚构路人", ctime=boundary - 3599, text="升级前发表但未归档"),
        root_comment("860903", author=ROOT_UID, ctime=int(time.time()) + 60, text="升级后发表的新评论"),
    ])
    asyncio.run(archive())
    receiver = Receiver()
    asyncio.run(dispatcher(path, transport=httpx.MockTransport(receiver), full=ALL_WEBHOOK).run_once())
    assert delivered(receiver) == sorted([("860903", WEBHOOK), ("860903", ALL_WEBHOOK)])


def heartbeat_database(path):
    """真实归档产生一条待投递业务消息，模拟 01 交付的 v16 发件箱。"""
    configured(path)
    source = Source("v1")

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            source.page = "v2"
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()

    asyncio.run(run())


def test_v16_outbox_is_upgraded_in_place_with_heartbeat_state(tmp_path):
    path = tmp_path / "v16.sqlite"
    heartbeat_database(path)
    before_deliveries = deliveries(path)
    assert [(row["kind"], row["state"]) for row in before_deliveries] == [("dynamic_changed", "pending")]
    assert version(path) == 18

    # 退回 01 交付时的 v16 形状：没有心跳时段表，投递表也没有有效期列。
    with sqlite3.connect(path) as connection:
        connection.execute("DROP TABLE notification_heartbeats")
        connection.execute("ALTER TABLE notification_deliveries DROP COLUMN expires_at")
        connection.execute("PRAGMA user_version = 16")

    Store(path).migrate()

    assert version(path) == 18
    assert "notification_heartbeats" in tables(path)
    with sqlite3.connect(path) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(notification_deliveries)")}
    assert "expires_at" in columns
    # 已入队的业务消息与事件不因迁移丢失或改状态。
    upgraded = query(path, """SELECT e.kind, d.state, d.expires_at FROM notification_deliveries d
        JOIN notification_events e ON e.id = d.event_id""")
    assert [(row["kind"], row["state"], row["expires_at"]) for row in upgraded] == [
        ("dynamic_changed", "pending", None)]
    assert len(events(path)) == 1
    assert query(path, "SELECT * FROM notification_heartbeats") == []
