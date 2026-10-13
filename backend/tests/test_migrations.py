"""真实旧/新 SQLite 装配；断言公开 HTTP 与 schema 版本契约。"""

import sqlite3

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app
from backend.tests.sqlite_fixtures import management_relation, quote
from backend.tests.management_support import BASE, UID, client_for


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
        assert database.execute("PRAGMA user_version").fetchone()[0] == 8


def test_future_database_refuses_startup_without_downgrading(tmp_path, caplog):
    path = tmp_path / "FICTIONAL_SECRET_FUTURE.sqlite"
    with sqlite3.connect(path) as database:
        database.execute("PRAGMA user_version = 9")
    with pytest.raises(RuntimeError, match="Unsupported database schema version"):
        with client_for(path):
            pytest.fail("A future schema must not serve requests")
    with sqlite3.connect(path) as database:
        assert database.execute("PRAGMA user_version").fetchone()[0] == 9
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


def test_v4_indefinite_cursor_is_invalidated_without_losing_archive(tmp_path):
    import json
    path = tmp_path / "v4.sqlite"
    token = "1234567890abcdef1234567890abcdef"
    saved = {"id": "123", "published_at": None}
    # 已发布 v4 文件的固定结构，仅构造迁移输入；结果仍从公开 HTTP 验证。
    with sqlite3.connect(path) as database:
        database.executescript("""
            CREATE TABLE identities(uid TEXT PRIMARY KEY, name TEXT, avatar_url TEXT);
            CREATE TABLE monitors(uid TEXT PRIMARY KEY REFERENCES identities(uid), mode TEXT NOT NULL DEFAULT 'recent', recent_n INTEGER NOT NULL DEFAULT 10, enabled INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE targets(uid TEXT REFERENCES monitors(uid) ON DELETE CASCADE, id TEXT, PRIMARY KEY(uid,id));
            CREATE TABLE archives(id TEXT PRIMARY KEY, uid TEXT REFERENCES identities(uid), document TEXT, generation INTEGER DEFAULT 0);
            CREATE TABLE archive_pages(token TEXT PRIMARY KEY, batch_limit INTEGER, document TEXT);
            PRAGMA user_version = 4;
        """)
        database.execute("INSERT INTO identities VALUES (?, NULL, NULL)", (UID,))
        database.execute("INSERT INTO archives VALUES ('123', ?, ?, 0)", (UID, json.dumps(saved)))
        database.execute("INSERT INTO archive_pages VALUES (?, 10, ?)", (token, json.dumps({"items": [saved], "next_cursor": None})))
    saved = {**saved, "local_reply_count": 0, "root_comments_last_attempt": "pending",
             "synced_root_comment_count": None, "work": {"comments": "pending", "replies": "pending", "media": "pending"},
             "media": [], "previous_media": [], "media_version": None,
             "synced_media_version": None, "media_last_attempt": "pending",
             "replies_last_attempt": "pending", "comments_last_attempt": "pending",
             "synced_comment_count": None, "synced_reply_comment_count": None}
    with client_for(path) as client:
        assert client.get("/api/archive/dynamics", params={"cursor": token}).status_code == 422
        assert client.get("/api/archive/dynamics/123").json() == saved
        assert client.get("/api/archive/dynamics").json() == {"items": [saved], "next_cursor": None}
    with client_for(path) as client:
        assert client.get("/api/archive/dynamics", params={"cursor": token}).status_code == 422
        assert client.get("/api/archive/dynamics/123").json() == saved


def test_real_v1_configuration_migrates_through_targets_archives_and_snapshot_versions(tmp_path):
    path = tmp_path / "v1.sqlite"
    with sqlite3.connect(path) as database:
        database.executescript("""
            CREATE TABLE identities(uid TEXT PRIMARY KEY, name TEXT, avatar_url TEXT);
            CREATE TABLE monitors(uid TEXT PRIMARY KEY REFERENCES identities(uid), mode TEXT NOT NULL DEFAULT 'recent', recent_n INTEGER NOT NULL DEFAULT 10, enabled INTEGER NOT NULL DEFAULT 1);
            PRAGMA user_version = 1;
        """)
        database.execute("INSERT INTO identities VALUES (?, '虚构旧身份', NULL)", (UID,))
        database.execute("INSERT INTO monitors VALUES (?, 'specified', 23, 1)", (UID,))
    with client_for(path) as client:
        saved = client.get(f"{BASE}/{UID}").json()
        assert saved["name"] == "虚构旧身份"
        assert saved["monitor"]["recent_n"] == 23
        assert saved["monitor"]["mode"] == "specified"
        assert client.get(f"{BASE}/{UID}/targets").json() == {"targets": []}
        assert client.get("/api/archive/dynamics").json() == {"items": [], "next_cursor": None}
        assert client.post("/api/sync/initial", json={"uid": UID}).json() == {"processed": 0, "succeeded": 0, "failed": 0}
    with client_for(path) as client:
        assert client.get(f"{BASE}/{UID}").json() == saved


def test_reopened_v5_expired_and_foreign_resource_cursors_are_rejected_over_http(tmp_path):
    import json
    import time
    path = tmp_path / "v5.sqlite"
    with client_for(path):
        pass
    # 构造已有 v5 持久文件输入，无时钟 mock；过期标记/外资源标记不应被读取。
    with sqlite3.connect(path) as database:
        database.execute("INSERT INTO archive_pages VALUES (?, 10, ?, 1, ?)",
                         ("1" * 32, json.dumps({"items": [], "next_cursor": None}), "dynamics:all:published-desc:id-binary:v1"))
        database.execute("INSERT INTO archive_pages VALUES (?, 10, ?, ?, ?)",
                         ("2" * 32, json.dumps({"items": [], "next_cursor": None}), int(time.time()) + 900, "comments:123:latest"))
    with client_for(path) as client:
        for cursor in ("1" * 32, "2" * 32):
            assert client.get("/api/archive/dynamics", params={"cursor": cursor}).status_code == 422
        assert client.get("/api/archive/dynamics").json() == {"items": [], "next_cursor": None}
