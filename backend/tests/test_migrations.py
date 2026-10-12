"""真实旧/新 SQLite 装配；断言公开 HTTP 与 schema 版本契约。"""

import sqlite3

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app
from backend.tests.sqlite_fixtures import management_relation, quote
from backend.tests.test_management import BASE, UID, client_for


def test_empty_unversioned_database_migrates_and_reopens(tmp_path):
    path = tmp_path / "legacy.sqlite"
    with sqlite3.connect(path) as database:
        database.execute("CREATE TABLE legacy_note (note TEXT)")
        database.execute("INSERT INTO legacy_note VALUES ('虚构旧资料')")
    with client_for(path) as client:
        assert client.get(BASE).json() == {"ups": []}
        assert client.post(BASE, json={"uid": UID}).status_code == 201
        saved = client.get(BASE).json()
    with client_for(path) as client:
        assert client.get(BASE).json() == saved
    with sqlite3.connect(path) as database:
        assert database.execute("PRAGMA user_version").fetchone()[0] == 1


def test_future_database_refuses_startup_without_downgrading(tmp_path, caplog):
    path = tmp_path / "FICTIONAL_SECRET_FUTURE.sqlite"
    with sqlite3.connect(path) as database:
        database.execute("PRAGMA user_version = 2")
    with pytest.raises(RuntimeError, match="Unsupported database schema version"):
        with client_for(path):
            pytest.fail("A future schema must not serve requests")
    with sqlite3.connect(path) as database:
        assert database.execute("PRAGMA user_version").fetchone()[0] == 2
    assert "FICTIONAL_SECRET" not in caplog.text


def test_startup_storage_errors_do_not_expose_database_path(tmp_path, caplog):
    path = tmp_path / "FICTIONAL_SECRET_BROKEN.sqlite"
    path.write_text("FICTIONAL_SECRET_DATABASE_CONTENT")
    with pytest.raises(RuntimeError, match="Database initialization failed") as failure:
        with client_for(path):
            pytest.fail("A broken database must not serve requests")
    assert "FICTIONAL_SECRET" not in str(failure.value) + caplog.text


def test_v0_migration_rolls_back_schema_and_version_then_can_retry(tmp_path):
    reference = tmp_path / "reference.sqlite"
    with client_for(reference):
        monitor, _, _, _ = management_relation(reference)
    path = tmp_path / "legacy.sqlite"
    with sqlite3.connect(path) as database:
        database.execute(f"CREATE TABLE {quote(monitor)} (fixture TEXT)")
    with pytest.raises(RuntimeError, match="Database initialization failed"):
        with client_for(path):
            pytest.fail("Conflicting legacy schema must not serve requests")
    with sqlite3.connect(path) as database:
        assert database.execute("PRAGMA user_version").fetchone()[0] == 0
        database.execute(f"DROP TABLE {quote(monitor)}")
    # 如果上次 DDL 曾被隐式提交，重试会因第一张表冲突而失败。
    with client_for(path) as client:
        assert client.post(BASE, json={"uid": UID}).status_code == 201
        assert client.get(f"{BASE}/{UID}").json()["uid"] == UID


def test_existing_v1_nullable_identity_is_read_without_rewriting_saved_fields(tmp_path):
    path = tmp_path / "monitor.sqlite"
    with client_for(path) as client:
        client.post(BASE, json={"uid": UID})
    _, identity, _, owner_key = management_relation(path)
    # 构造已存在的旧资料；可空 name/avatar_url 是公开契约的兼容数据。
    with sqlite3.connect(path) as database:
        database.execute(
            f"UPDATE {quote(identity)} SET name = NULL, avatar_url = NULL WHERE {quote(owner_key)} = ?",
            (UID,),
        )
    with client_for(path) as client:
        response = client.get(f"{BASE}/{UID}")
        assert response.status_code == 200
        assert response.json()["name"] is None
        assert response.json()["avatar_url"] is None
        assert response.json()["monitor"]["last_checked_at"] is None


def test_unexpected_transport_startup_failure_is_sanitized(tmp_path, caplog):
    class BrokenStartup(httpx.AsyncBaseTransport):
        async def __aenter__(self):
            raise RuntimeError("FICTIONAL_SECRET_STARTUP")

        async def handle_async_request(self, request):
            raise AssertionError("Transport must fail at startup")

    application = create_app(
        tmp_path / "monitor.sqlite", profile_transport=BrokenStartup()
    )
    with pytest.raises(RuntimeError, match="Application lifecycle failed") as failure:
        with TestClient(application):
            pytest.fail("A failed transport must not serve requests")
    assert "FICTIONAL_SECRET" not in str(failure.value) + caplog.text
