"""01：通知 schema 迁移保留旧归档/观察状态、可重复执行且失败可回滚。"""

import asyncio
import json
import sqlite3

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from backend.tests.collector_support import configured
from backend.tests.management_support import UID
from backend.tests.notification_support import DYNAMIC, Source, deliveries, events, query

NOTIFICATION_TABLES = (
    "notification_deliveries", "notification_events", "notification_versions",
    "notification_body_claims", "notification_phases",
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

    assert version(path) == 16
    assert set(NOTIFICATION_TABLES) <= tables(path)
    assert Store(path).read_archive(DYNAMIC) == before["archive"]
    assert Store(path).read_checks(UID) == before["checks"]
    phases = query(path, "SELECT * FROM notification_phases")
    assert [(row["uid"], row["dynamic_id"], row["baseline_version"], row["sealed"]) for row in phases] == [
        (UID, DYNAMIC, before["archive"]["synced_version"], 0)]
    # 已有可信版本只作为静默基线：不补发旧版本。
    assert events(path) == [] and deliveries(path) == []

    Store(path).migrate()
    assert version(path) == 16
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
    assert version(path) == 16
    assert set(NOTIFICATION_TABLES) <= tables(path)
    assert Store(path).read_archive(DYNAMIC) == before["archive"]


def test_fresh_database_migrates_without_phases_or_events(tmp_path):
    path = tmp_path / "fresh.sqlite"
    Store(path).migrate()
    assert version(path) == 16
    assert set(NOTIFICATION_TABLES) <= tables(path)
    assert query(path, "SELECT * FROM notification_phases") == []
    assert query(path, "SELECT * FROM notification_deliveries") == []
    assert query(path, "SELECT * FROM notification_events") == []
