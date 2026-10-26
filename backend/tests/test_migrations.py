"""真实旧/新 SQLite 装配；断言公开 HTTP 与 schema 版本契约。"""

import sqlite3

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app
from backend.bili_monitor.comment_status import ROOT_METADATA_VERSION
from backend.tests.sqlite_fixtures import management_relation, quote
from backend.tests.management_support import BASE, UID, client_for
from backend.tests.archive_support import archive_content, NULL_COMMENT_STATUS


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
        assert database.execute("PRAGMA user_version").fetchone()[0] == 23


def test_future_database_refuses_startup_without_downgrading(tmp_path, caplog):
    path = tmp_path / "FICTIONAL_SECRET_FUTURE.sqlite"
    with sqlite3.connect(path) as database:
        database.execute("PRAGMA user_version = 24")
    with pytest.raises(RuntimeError, match="Unsupported database schema version"):
        with client_for(path):
            pytest.fail("A future schema must not serve requests")
    with sqlite3.connect(path) as database:
        assert database.execute("PRAGMA user_version").fetchone()[0] == 24
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
             "synced_comment_count": None, "synced_reply_comment_count": None, **NULL_COMMENT_STATUS}
    with client_for(path) as client:
        assert client.get("/api/archive/dynamics", params={"cursor": token}).status_code == 422
        assert client.get("/api/archive/dynamics/123").json() == {**saved, "comment_sync": None}
        assert client.get("/api/archive/dynamics").json() == {"items": [saved], "next_cursor": None}
    with client_for(path) as client:
        assert client.get("/api/archive/dynamics", params={"cursor": token}).status_code == 422
        assert client.get("/api/archive/dynamics/123").json() == {**saved, "comment_sync": None}


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


def test_v11_discovery_migration_preserves_config_archive_and_pending_checks(tmp_path):
    from backend.bili_monitor.storage import Store

    path = tmp_path / "v11.sqlite"
    store = check_store(path)
    store.claim_archive(UID, "123")
    store.record_check(UID, "123", signals(), CHECKED_AT, None)
    with client_for(path) as api:
        config = api.get(f"{BASE}/{UID}").json()
        archive = api.get("/api/archive/dynamics/123").json()
        checks = get_checks(api)
    # 固定旧版本输入，不将schema introspection当用户结果断言。
    with sqlite3.connect(path) as database:
        database.execute("DROP TABLE recent_discoveries")
        database.execute("DROP TABLE target_selections")
        database.execute("PRAGMA user_version = 11")
    for _ in range(2):
        with client_for(path) as api:
            assert api.get(f"{BASE}/{UID}").json() == config
            assert api.get("/api/archive/dynamics/123").json() == archive
            assert get_checks(api) == checks
            state = api.get(f"{BASE}/{UID}/discovery").json()
            assert state["status"] == "undiscovered" and state["trusted_result"] is None
    assert Store(path).pending_checks() == [{"uid": UID, "id": "123"}]


CHECKED_AT = "2030-01-01T00:00:00+00:00"
FINISHED_AT = "2030-01-01T00:00:01+00:00"
EDIT_VERSION = "2030-01-01T08:00+08:00"


def check_store(path, ids=("123",)):
    from backend.bili_monitor.storage import Store

    store = Store(path)
    store.migrate()
    store.add(UID, "虚构身份", None)
    store.update(UID, "specified", 10, True)
    for id in ids:
        store.add_target(UID, id)
    return store


def get_checks(client):
    response = client.get(f"{BASE}/{UID}/checks")
    assert response.status_code == 200
    return response.json()["checks"]


def signals(version=EDIT_VERSION, count=1):
    return {"edit_status": "observed", "observed_version": version,
            "edited_at": version, "source_comment_count": count,
            "author": {"id": UID, "nickname": "可信昵称", "avatar_url": None}}


def test_checks_unchecked_http_is_read_only_and_rejects_queries(tmp_path):
    path = tmp_path / "checks.sqlite"
    store = check_store(path, ("20", "123"))
    with client_for(path) as client:
        assert get_checks(client) == [
            {"id": id, "active": True, "last_checked_at": None, "last_succeeded_at": None,
             "check_status": "unchecked", "observed": {}, "revision": 0,
             "work": "pending", "check_error": None, "sync_error": None,
             "text_last_succeeded_at": None, "media_last_succeeded_at": None, "comment_media_last_succeeded_at": None,
             "media_errors": [], "comment_media_errors": [],
             "synced_version": None, "synced_comment_count": None,
             "local_comment_count": None, "local_reply_count": None, "comments_last_attempt": "pending",
             "root_comments_last_attempt": "pending", "replies_last_attempt": "pending",
             "synced_root_comment_count": None, "synced_reply_comment_count": None,
             **NULL_COMMENT_STATUS,
             "parts": dict.fromkeys(("text", "media", "comments", "replies", "comment_media"), "pending")} for id in ("123", "20")]
        assert client.get(f"{BASE}/999/checks").status_code == 404
        for query in ("?refresh=1", "?cursor=1&cursor=2"):
            assert client.get(f"{BASE}/{UID}/checks{query}").status_code == 422
    assert store.pending_checks() == []
    with sqlite3.connect(path) as database:
        assert database.execute("SELECT COUNT(*) FROM target_checks").fetchone()[0] == 0


def test_check_signals_merge_revision_and_real_success_timestamps_over_http(tmp_path):
    path = tmp_path / "checks.sqlite"
    store = check_store(path, ("123", "456"))
    assert store.enabled_targets() == [{"uid": UID, "id": "123"}, {"uid": UID, "id": "456"}]
    assert store.record_check(UID, "123", {**signals(), "text": "不得写入", "media_sources": []}, CHECKED_AT, None)
    first = store.claim_check_work(UID, "123")
    assert first["revision"] == 1
    assert first["observed"] == {
        "edit_status": "observed", "observed_version": EDIT_VERSION, "edited_at": EDIT_VERSION,
        "source_comment_count": 1, "author": {"id": UID, "nickname": "可信昵称"}}
    assert store.claim_check_work(UID, "123") is None
    assert store.pending_checks() == []
    assert store.finish_check_work(UID, "123", first["revision"], True, FINISHED_AT, None, token=first["token"])
    second_time = "2030-01-01T00:00:15+00:00"
    assert store.record_check(UID, "123", {
        "edit_status": "unknown", "observed_version": None, "edited_at": None,
        "source_comment_count": 2, "author": {"id": UID, "nickname": None,
                                                "avatar_url": "https://example.invalid/new.png"}}, second_time, None)
    assert store.record_check(UID, "456", {}, CHECKED_AT, None)
    assert store.pending_checks() == [{"uid": UID, "id": "123"}, {"uid": UID, "id": "456"}]
    with client_for(path) as client:
        current, unknown = get_checks(client)
        assert current["check_status"] == "checked"
        assert current["revision"] == 2 and current["work"] == "pending"
        assert current["last_succeeded_at"] == FINISHED_AT
        assert current["observed"]["observed_version"] == EDIT_VERSION
        assert current["observed"]["source_comment_count"] == 2
        assert current["observed"]["author"] == {"id": UID, "nickname": "可信昵称",
                                                 "avatar_url": "https://example.invalid/new.png"}
        assert unknown["revision"] == 1 and unknown["work"] == "pending"
        assert unknown["last_succeeded_at"] is None
        monitor = client.get(f"{BASE}/{UID}").json()["monitor"]
        assert monitor["last_checked_at"] == second_time
        assert monitor["last_succeeded_at"] == FINISHED_AT


def test_running_check_work_retains_new_observation_and_reopens_without_api_recovery(tmp_path):
    path = tmp_path / "checks.sqlite"
    store = check_store(path)
    store.record_check(UID, "123", signals(), CHECKED_AT, None)
    first = store.claim_check_work(UID, "123")
    new_version = "2030-01-01T08:15+08:00"
    store.record_check(UID, "123", signals(new_version), CHECKED_AT, None)
    with client_for(path) as client:
        current = get_checks(client)[0]
        assert current["revision"] == 2 and current["work"] == "running"
    assert store.pending_checks() == []
    assert store.claim_check_work(UID, "123") is None
    assert not store.finish_check_work(UID, "123", first["revision"], True, FINISHED_AT, None, token=first["token"])
    with client_for(path) as client:
        current = get_checks(client)[0]
        assert current["work"] == "pending" and current["last_succeeded_at"] is None
    second = store.claim_check_work(UID, "123")
    assert second["revision"] == 2 and second["observed"]["observed_version"] == new_version
    with client_for(path) as client:
        assert get_checks(client)[0]["work"] == "running"
    store.recover_check_work()
    assert store.pending_checks() == [{"uid": UID, "id": "123"}]
    third = store.claim_check_work(UID, "123")
    assert store.finish_check_work(UID, "123", third["revision"], True, FINISHED_AT, None, token=third["token"])
    with client_for(path) as client:
        assert get_checks(client)[0]["last_succeeded_at"] == FINISHED_AT


@pytest.mark.parametrize("error,expected", [("FICTIONAL_SECRET_SOURCE", "SOURCE_UNAVAILABLE"),
                                           ("SIGNAL_INVALID", "SIGNAL_INVALID")])
def test_failed_checks_and_work_keep_trusted_signals_and_safe_errors(tmp_path, error, expected):
    path = tmp_path / "checks.sqlite"
    store = check_store(path)
    store.record_check(UID, "123", signals(), CHECKED_AT, None)
    before = store.claim_check_work(UID, "123")
    assert not store.finish_check_work(UID, "123", before["revision"], False, FINISHED_AT, error, token=before["token"])
    with client_for(path) as client:
        current = get_checks(client)[0]
        assert current["sync_error"] == expected and current["last_succeeded_at"] is None
    assert store.record_check(UID, "123", signals("untrusted", 999), FINISHED_AT, error)
    with client_for(path) as client:
        current = get_checks(client)[0]
        assert current["check_status"] == "failed" and current["check_error"] == expected
        assert current["observed"] == before["observed"] and current["revision"] == 1
        assert "FICTIONAL_SECRET" not in str(current)
    assert store.record_check(UID, "123", None, FINISHED_AT, None)
    with client_for(path) as client:
        assert get_checks(client)[0]["check_error"] == "SOURCE_UNAVAILABLE"


@pytest.mark.parametrize("stop", ["disable", "recent", "remove", "delete"])
def test_inactive_targets_reject_stale_results_and_claims_but_keep_history(tmp_path, stop):
    path = tmp_path / "checks.sqlite"
    store = check_store(path)
    store.record_check(UID, "123", signals(), CHECKED_AT, None)
    before = store.read_checks(UID)[0]
    if stop == "disable":
        store.update(UID, "specified", 10, False)
    elif stop == "recent":
        store.update(UID, "recent", 10, True)
    elif stop == "remove":
        store.delete_target(UID, "123")
    else:
        store.delete_monitor(UID)
    assert store.enabled_targets() == [] and store.pending_checks() == []
    assert store.claim_check_work(UID, "123") is None
    assert not store.record_check(UID, "123", signals("stale"), FINISHED_AT, None)
    with client_for(path) as client:
        assert get_checks(client) == [{**before, "active": False}]
    if stop == "delete":
        store.add(UID, "虚构身份", None)
        store.update(UID, "specified", 10, True)
        store.add_target(UID, "123")
        assert store.pending_checks() == [{"uid": UID, "id": "123"}]


@pytest.mark.parametrize("complete,same_version,same_count", [
    (True, True, True), (False, True, True), (True, False, True), (True, True, False)])
def test_existing_archive_baseline_does_not_fabricate_sync_time(tmp_path, complete, same_version, same_count):
    import json

    path = tmp_path / "checks.sqlite"
    store = check_store(path)
    generation = store.claim_archive(UID, "123")
    assert generation is not None
    document = store.read_archive("123")
    document["observed_version"] = EDIT_VERSION if same_version else "older"
    document["synced_version"] = document["observed_version"]
    document["source_comment_count"] = document["synced_comment_count"] = 1 if same_count else 0
    document["work"] = dict.fromkeys(("text", "media", "comments", "replies"), "success")
    # 基线已是最新根元信息版本，媒体版本与正文同步；本用例只考察时间戳不回填。
    document["synced_root_metadata_version"] = ROOT_METADATA_VERSION
    document["media_version"] = document["observed_version"]
    if not complete:
        document["work"]["media"] = "pending"
    with sqlite3.connect(path) as database:
        database.execute("UPDATE archives SET document = ? WHERE id = '123'", (json.dumps(document),))
    store.record_check(UID, "123", signals(), CHECKED_AT, None)
    with client_for(path) as client:
        current = get_checks(client)[0]
        assert current["work"] == ("complete" if complete and same_version and same_count else "pending")
        assert current["last_succeeded_at"] is None
        assert client.get(f"{BASE}/{UID}").json()["monitor"]["last_succeeded_at"] is None


def test_real_v9_configuration_and_archive_migrate_to_checks_without_fabricating_history(tmp_path):
    from backend.bili_monitor.storage import Store

    path = tmp_path / "v9.sqlite"
    store = check_store(path)
    store.claim_archive(UID, "123")
    saved = store.read_archive("123")
    with sqlite3.connect(path) as database:
        database.execute("DROP TABLE target_checks")
        database.execute("DROP TABLE recent_discoveries")
        database.execute("DROP TABLE target_selections")
        database.execute("PRAGMA user_version = 9")
    with client_for(path) as client:
        check = get_checks(client)[0]
        assert check["check_status"] == "unchecked"
        assert {field: check[field] for field in NULL_COMMENT_STATUS} == NULL_COMMENT_STATUS
        current = client.get("/api/archive/dynamics/123").json()
        assert current["comment_sync"] == check
        assert archive_content(current) == saved
    with sqlite3.connect(path) as database:
        assert database.execute("PRAGMA user_version").fetchone()[0] == 23
        assert database.execute("PRAGMA foreign_key_check").fetchall() == []
    reopened = Store(path)
    assert reopened.record_check(UID, "123", {}, CHECKED_AT, None)
    claim = reopened.claim_check_work(UID, "123")
    assert claim["revision"] == 1
    assert claim["observed"]["author"]["id"] == UID
    assert claim["observed"].get("observed_version") is None
    with client_for(path) as client:
        assert get_checks(client)[0]["work"] == "running"


def test_complete_work_becomes_pending_only_for_trusted_version_change(tmp_path):
    path = tmp_path / "checks.sqlite"
    store = check_store(path)
    store.record_check(UID, "123", signals(), CHECKED_AT, None)
    first = store.claim_check_work(UID, "123")
    store.finish_check_work(UID, "123", first["revision"], True, FINISHED_AT, None, token=first["token"])
    # 即使未知结果含有占位版本，也不能替换可信版本或重新触发编辑工作。
    store.record_check(UID, "123", {"edit_status": "error", "observed_version": "untrusted",
                                    "edited_at": "untrusted"}, CHECKED_AT, None)
    with client_for(path) as client:
        current = get_checks(client)[0]
        assert current["revision"] == 1 and current["work"] == "complete"
        assert current["observed"]["observed_version"] == EDIT_VERSION
        assert current["observed"]["edited_at"] == EDIT_VERSION
    store.record_check(UID, "123", signals("2030-01-01T08:30+08:00"), CHECKED_AT, None)
    with client_for(path) as client:
        current = get_checks(client)[0]
        assert current["revision"] == 2 and current["work"] == "pending"
        assert current["last_succeeded_at"] == FINISHED_AT


def test_first_failed_check_remains_pending_and_historical_times_are_in_monitor_max(tmp_path):
    path = tmp_path / "checks.sqlite"
    store = check_store(path, ("123", "456"))
    store.record_check(UID, "123", signals(), CHECKED_AT, None)
    first = store.claim_check_work(UID, "123")
    store.finish_check_work(UID, "123", first["revision"], True, FINISHED_AT, None, token=first["token"])
    store.delete_target(UID, "123")
    latest = "2030-01-01T00:00:30+00:00"
    store.record_check(UID, "456", None, latest, "FICTIONAL_SECRET")
    with client_for(path) as client:
        history, failed = get_checks(client)
        assert not history["active"] and history["last_succeeded_at"] == FINISHED_AT
        assert failed["check_status"] == "failed" and failed["work"] == "pending"
        assert failed["observed"] == {} and failed["revision"] == 1
        monitor = client.get(f"{BASE}/{UID}").json()["monitor"]
        assert monitor["last_checked_at"] == latest
        assert monitor["last_succeeded_at"] == FINISHED_AT


def test_v9_check_migration_failure_rolls_back_version_and_can_retry(tmp_path):
    path = tmp_path / "v9.sqlite"
    store = check_store(path)
    with sqlite3.connect(path) as database:
        database.execute("DROP TABLE target_checks")
        database.execute("CREATE TABLE target_checks (fixture TEXT)")
        database.execute("DROP TABLE recent_discoveries")
        database.execute("DROP TABLE target_selections")
        database.execute("PRAGMA user_version = 9")
    with pytest.raises(RuntimeError, match="Database initialization failed"):
        with client_for(path):
            pytest.fail("A conflicting check schema must not serve requests")
    with sqlite3.connect(path) as database:
        assert database.execute("PRAGMA user_version").fetchone()[0] == 9
        database.execute("DROP TABLE target_checks")
    with client_for(path) as client:
        assert get_checks(client)[0]["check_status"] == "unchecked"
    with sqlite3.connect(path) as database:
        assert database.execute("PRAGMA user_version").fetchone()[0] == 23
