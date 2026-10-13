"""13 票：真实 SQLite 写入，经公开 HTTP 观察 scope 与持久快照。"""

import httpx
import pytest

from backend.bili_monitor.storage import Store
from backend.tests.management_support import BASE, UID, client_for

ARCHIVE = "/api/archive/dynamics"
UPS = "/api/archive/ups"


def unavailable_upstream(calls):
    def handler(request):
        calls.append(str(request.url))
        raise httpx.ConnectError("FICTIONAL_SECRET_UPSTREAM", request=request)
    return handler


def add_identity(store, uid, nickname="虚构身份", avatar_url=None):
    store.add(uid, nickname, avatar_url)
    store.update(uid, "specified", 10, True)


def save_archive(store, uid, id, published_at, text=None, version="2026-10-09T13:01+08:00"):
    store.add_target(uid, id)
    generation = store.claim_archive(uid, id)
    assert generation is not None
    assert store.observe_archive(id, generation, {
        "published_at": published_at,
        "edited_at": version,
        "edit_status": "observed",
        "observed_version": version,
    })
    assert store.finish_archive(id, generation, "success", {"text": text or "旧正文 " + id}, version)


def seed_twenty_five(store):
    for uid in (UID, "202"):
        add_identity(store, uid)
    save_archive(store, UID, "2", "2026-10-09T10:00:00+08:00")
    save_archive(store, "202", "10", "2026-10-09T10:00:00+08:00")
    for number in range(100, 123):
        published = ("2026-10-10T10:00:00+08:00" if number < 102
                     else "2026-10-09T10:00:00+08:00" if number < 120 else None)
        save_archive(store, UID if number % 2 == 0 else "202", str(number), published)


GLOBAL_IDS = ["100", "101", "10", "102", "103", "104", "105", "106", "107", "108",
              "109", "110", "111", "112", "113", "114", "115", "116", "117", "118",
              "119", "2", "120", "121", "122"]
UP_IDS = {
    UID: ["100", "102", "104", "106", "108", "110", "112", "114", "116", "118", "2", "120", "122"],
    "202": ["101", "10", "103", "105", "107", "109", "111", "113", "115", "117", "119", "121"],
}


def read_pages(client, params):
    pages = []
    while True:
        response = client.get(ARCHIVE, params=params)
        assert response.status_code == 200
        page = response.json()
        pages.append(page)
        if page["next_cursor"] is None:
            return pages
        assert len(pages) < 4, "Pagination must terminate"
        params = {**params, "cursor": page["next_cursor"]}


def test_navigation_reads_all_persistent_identities_after_stop_delete_and_reopen(tmp_path):
    path = tmp_path / "archive.sqlite"
    calls = []
    expected = {"ups": [
        {"id": "202", "nickname": None, "avatar_url": None},
        {"id": "303", "nickname": "已知空身份", "avatar_url": None},
        {"id": UID, "nickname": "虚构作者", "avatar_url": "https://example.invalid/avatar.png"},
    ]}
    with client_for(path, unavailable_upstream(calls)) as client:
        assert client.get(UPS).json() == {"ups": []}
        store = Store(path)
        add_identity(store, UID, "虚构作者", "https://example.invalid/avatar.png")
        add_identity(store, "202", None)
        add_identity(store, "303", "已知空身份")
        save_archive(store, UID, "123", None)
        save_archive(store, "202", "124", None)
        assert client.delete(f"{BASE}/{UID}/monitor").status_code == 204
        assert client.patch(f"{BASE}/202/monitor", json={"mode": "specified", "recent_n": 10, "enabled": False}).status_code == 200
        response = client.get(UPS)
        assert response.status_code == 200
        assert response.json() == expected
    with client_for(path, unavailable_upstream(calls)) as client:
        assert client.get(UPS).json() == expected
        assert client.get(UPS, params={"cursor": "FICTIONAL_SECRET"}).status_code == 422
    assert calls == []


def test_scope_distinguishes_unknown_up_from_known_empty_archive(tmp_path):
    path = tmp_path / "archive.sqlite"
    calls = []
    with client_for(path, unavailable_upstream(calls)) as client:
        add_identity(Store(path), UID)
        response = client.get(ARCHIVE, params={"scope": "up", "uid": UID})
        assert response.status_code == 200
        assert response.json() == {"items": [], "next_cursor": None}
        response = client.get(ARCHIVE, params={"scope": "up", "uid": "404"})
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "UNKNOWN_UP"
        assert client.get(ARCHIVE, params={"scope": "all"}).json() == {"items": [], "next_cursor": None}
    assert calls == []


@pytest.mark.parametrize("query", [
    "scope=other", "scope=", "scope=up", "scope=up&uid=", "scope=up&uid=0",
    "scope=up&uid=01", "scope=up&uid=-1", "scope=up&uid=1.5",
    "scope=up&uid=%EF%BC%91", "scope=up&uid=" + "1" * 129,
    "scope=all&uid=202", "uid=202", "scope=all&uid=",
    "scope=up&uid=202&uid=303", "scope=all&scope=up", "scope=all&limit=0",
    "scope=all&limit=11", "scope=all&limit=1&limit=2", "scope=all&resource=comments",
])
def test_invalid_scope_queries_are_rejected_without_upstream(tmp_path, query):
    calls = []
    with client_for(tmp_path / "archive.sqlite", unavailable_upstream(calls)) as client:
        response = client.get(ARCHIVE + "?" + query)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "INVALID_INPUT"
    assert calls == []


def test_two_up_complete_sets_sort_before_global_and_scoped_pagination(tmp_path):
    path = tmp_path / "archive.sqlite"
    calls = []
    with client_for(path, unavailable_upstream(calls)) as client:
        seed_twenty_five(Store(path))
        for params in ({}, {"scope": "all"}):
            pages = read_pages(client, params)
            assert [len(page["items"]) for page in pages] == [10, 10, 5]
            assert [item["id"] for page in pages for item in page["items"]] == GLOBAL_IDS
        for uid, expected in UP_IDS.items():
            pages = read_pages(client, {"scope": "up", "uid": uid})
            assert [len(page["items"]) for page in pages] == [10, len(expected) - 10]
            assert [item["id"] for page in pages for item in page["items"]] == expected
            assert all(item["author"]["id"] == uid for page in pages for item in page["items"])
    with client_for(path, unavailable_upstream(calls)) as client:
        for uid, expected in UP_IDS.items():
            pages = read_pages(client, {"scope": "up", "uid": uid})
            assert [item["id"] for page in pages for item in page["items"]] == expected
    assert calls == []


def test_cursors_bind_scope_uid_limit_and_resource_without_breaking_global_alias(tmp_path):
    path = tmp_path / "archive.sqlite"
    calls = []
    with client_for(path, unavailable_upstream(calls)) as client:
        seed_twenty_five(Store(path))
        scopes = [{}, {"scope": "up", "uid": UID}, {"scope": "up", "uid": "202"}]
        for origin in scopes:
            cursor = client.get(ARCHIVE, params=origin).json()["next_cursor"]
            same_batch = client.get(ARCHIVE, params={**origin, "cursor": cursor}).json()
            for destination in scopes:
                response = client.get(ARCHIVE, params={**destination, "cursor": cursor})
                if destination == origin:
                    assert response.status_code == 200
                    assert response.json() == same_batch
                else:
                    assert response.status_code == 422
                    assert response.json()["error"]["code"] == "INVALID_INPUT"
            for resource in (UPS, ARCHIVE + "/100", BASE + f"/{UID}/targets"):
                assert client.get(resource, params={"cursor": cursor}).status_code == 422
            for extra in ({"limit": 1}, {"resource": "comments"}, {"sort": "latest"}):
                assert client.get(ARCHIVE, params={**origin, "cursor": cursor, **extra}).status_code == 422
            assert client.get(ARCHIVE, params={**origin, "cursor": cursor}).json() == same_batch
            if origin == {}:
                assert client.get(ARCHIVE, params={"scope": "all", "cursor": cursor}).json() == same_batch
        explicit_cursor = client.get(ARCHIVE, params={"scope": "all"}).json()["next_cursor"]
        explicit_batch = client.get(ARCHIVE, params={"scope": "all", "cursor": explicit_cursor}).json()
        assert client.get(ARCHIVE, params={"cursor": explicit_cursor}).json() == explicit_batch
    assert calls == []


@pytest.mark.parametrize("params,expected", [
    ({}, GLOBAL_IDS),
    ({"scope": "up", "uid": UID}, UP_IDS[UID]),
    ({"scope": "up", "uid": "202"}, UP_IDS["202"]),
])
def test_snapshot_freezes_pending_pages_and_survives_updates_stop_delete_and_reopen(tmp_path, params, expected):
    path = tmp_path / "archive.sqlite"
    calls = []
    with client_for(path, unavailable_upstream(calls)) as client:
        store = Store(path)
        seed_twenty_five(store)
        first = client.get(ARCHIVE, params=params).json()
        assert [item["id"] for item in first["items"]] == expected[:10]
        assert first["next_cursor"] is not None
        for uid, id in ((UID, "120"), ("202", "121")):
            save_archive(store, uid, id, "2026-10-11T10:00:00+08:00", "新正文 " + id, "2026-10-11T13:02+08:00")
        save_archive(store, UID, "1", "2026-10-12T10:00:00+08:00")
        save_archive(store, "202", "9", "2026-10-12T10:00:00+08:00")
        second = client.get(ARCHIVE, params={**params, "cursor": first["next_cursor"]}).json()
        assert [item["id"] for item in second["items"]] == expected[10:20]
        assert client.get(ARCHIVE, params={**params, "cursor": first["next_cursor"]}).json() == second
        current = client.get(ARCHIVE, params=params).json()["items"]
        assert current[0]["id"] == ("9" if params.get("uid") == "202" else "1")
        assert client.get(ARCHIVE + "/120").json()["text"] == "新正文 120"
        assert client.delete(f"{BASE}/{UID}/monitor").status_code == 204
        assert client.patch(f"{BASE}/202/monitor", json={"mode": "specified", "recent_n": 10, "enabled": False}).status_code == 200
        for uid in (UID, "202"):
            assert client.post("/api/sync/initial", json={"uid": uid}).json() == {"processed": 0, "succeeded": 0, "failed": 0}
    with client_for(path, unavailable_upstream(calls)) as client:
        assert client.get(ARCHIVE, params={**params, "cursor": first["next_cursor"]}).json() == second
        frozen = first["items"] + second["items"]
        if second["next_cursor"] is not None:
            third = client.get(ARCHIVE, params={**params, "cursor": second["next_cursor"]}).json()
            assert third["next_cursor"] is None
            assert len(third["items"]) == 5
            assert client.get(ARCHIVE, params={**params, "cursor": second["next_cursor"]}).json() == third
            frozen += third["items"]
        assert [item["id"] for item in frozen] == expected
        for item in frozen:
            assert item["text"] == "旧正文 " + item["id"]
            assert item["edited_at"] == "2026-10-09T13:01+08:00"
            if item["id"] in ("120", "121", "122"):
                assert item["published_at"] is None
        assert {up["id"] for up in client.get(UPS).json()["ups"]} == {UID, "202"}
        fresh = [item for page in read_pages(client, params) for item in page["items"]]
        inserted = {"9"} if params.get("uid") == "202" else {"1"} if params.get("uid") == UID else {"1", "9"}
        assert {item["id"] for item in fresh} == set(expected) | inserted
        assert len(fresh) == len(expected) + len(inserted)
        assert client.get(ARCHIVE + "/120").json()["text"] == "新正文 120"
    assert calls == []


@pytest.mark.parametrize("params", [{}, {"scope": "up", "uid": UID}, {"scope": "up", "uid": "202"}])
def test_snapshot_expires_at_fifteen_minutes_including_after_reopen(tmp_path, monkeypatch, params):
    clock = {"now": 1800000000}
    monkeypatch.setattr("backend.bili_monitor.storage.time.time", lambda: clock["now"])
    path = tmp_path / "archive.sqlite"
    calls = []
    with client_for(path, unavailable_upstream(calls)) as client:
        seed_twenty_five(Store(path))
        cursor = client.get(ARCHIVE, params=params).json()["next_cursor"]
        batch = client.get(ARCHIVE, params={**params, "cursor": cursor}).json()
        clock["now"] += 899
        assert client.get(ARCHIVE, params={**params, "cursor": cursor}).json() == batch
    with client_for(path, unavailable_upstream(calls)) as client:
        assert client.get(ARCHIVE, params={**params, "cursor": cursor}).json() == batch
        clock["now"] += 1
        response = client.get(ARCHIVE, params={**params, "cursor": cursor})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "INVALID_INPUT"
        assert client.get(ARCHIVE, params=params).status_code == 200
    with client_for(path, unavailable_upstream(calls)) as client:
        assert client.get(ARCHIVE, params={**params, "cursor": cursor}).status_code == 422
        assert client.get(ARCHIVE + "/100").status_code == 200
    assert calls == []


def test_missing_local_detail_is_independent_of_unknown_up_and_empty_scope(tmp_path):
    calls = []
    path = tmp_path / "archive.sqlite"
    with client_for(path, unavailable_upstream(calls)) as client:
        add_identity(Store(path), UID)
        response = client.get(ARCHIVE + "/404")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "NOT_FOUND"
        assert client.get(ARCHIVE, params={"scope": "up", "uid": UID}).json() == {"items": [], "next_cursor": None}
    assert calls == []


def test_preexisting_v5_global_cursor_remains_readable_with_implicit_and_explicit_all(tmp_path):
    import json
    import sqlite3
    import time

    path = tmp_path / "v5.sqlite"
    token = "1234567890abcdef1234567890abcdef"
    saved = {"id": "123", "published_at": None, "text": "虚构旧归档"}
    batch = {"items": [saved], "next_cursor": None}
    # 已发布 v5 数据库的固定输入结构；不经新版分页器生成所谓“旧 cursor”。
    with sqlite3.connect(path) as database:
        database.executescript("""
            CREATE TABLE identities(uid TEXT PRIMARY KEY, name TEXT, avatar_url TEXT);
            CREATE TABLE monitors(uid TEXT PRIMARY KEY REFERENCES identities(uid), mode TEXT NOT NULL DEFAULT 'recent', recent_n INTEGER NOT NULL DEFAULT 10, enabled INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE targets(uid TEXT REFERENCES monitors(uid) ON DELETE CASCADE, id TEXT, PRIMARY KEY(uid,id));
            CREATE TABLE archives(id TEXT PRIMARY KEY, uid TEXT REFERENCES identities(uid), document TEXT, generation INTEGER DEFAULT 0);
            CREATE TABLE archive_pages(token TEXT PRIMARY KEY, batch_limit INTEGER, document TEXT, expires_at INTEGER NOT NULL DEFAULT 0, resource TEXT NOT NULL DEFAULT 'dynamics:all:published-desc:id-binary:v1');
            CREATE INDEX archive_pages_expiry ON archive_pages(expires_at);
            PRAGMA user_version = 5;
        """)
        database.execute("INSERT INTO identities VALUES (?, NULL, NULL)", (UID,))
        database.execute("INSERT INTO archives VALUES ('123', ?, ?, 0)", (UID, json.dumps(saved)))
        database.execute("INSERT INTO archive_pages VALUES (?, 10, ?, ?, ?)", (
            token, json.dumps(batch), int(time.time()) + 900, "dynamics:all:published-desc:id-binary:v1",
        ))
    calls = []
    for _ in range(2):
        with client_for(path, unavailable_upstream(calls)) as client:
            for params in ({"cursor": token}, {"scope": "all", "cursor": token}):
                response = client.get(ARCHIVE, params=params)
                assert response.status_code == 200
                assert response.json() == batch
            assert client.get(ARCHIVE + "/123").json() == {
                **saved, "local_reply_count": 0, "root_comments_last_attempt": "pending",
                "synced_root_comment_count": None, "work": {"comments": "pending", "replies": "pending"},
                "comments_last_attempt": "pending", "replies_last_attempt": "pending",
                "synced_comment_count": None, "synced_reply_comment_count": None,
            }
            assert client.get(ARCHIVE, params={"scope": "up", "uid": UID, "cursor": token}).status_code == 422
            assert client.get(UPS).json() == {"ups": [{"id": UID, "nickname": None, "avatar_url": None}]}
    assert calls == []
