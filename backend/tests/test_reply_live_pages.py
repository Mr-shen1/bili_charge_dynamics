"""页码读取使用临时 SQLite；不启动 lifespan，不访问来源或凭据。"""

import json
import sqlite3
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app
from backend.bili_monitor.storage import Store

DYNAMIC = "123"
ROOT = "900719925474099312346"
REPLIES = f"/api/archive/dynamics/{DYNAMIC}/comments/{ROOT}/replies"
ORDERED_IDS = sorted(str(value) for value in range(1, 25)) + ["25"]


def author(id):
    return {"id": id, "nickname": f"author-{id}", "avatar_url": None}


def reply(id, parent_id=ROOT, published_at="2026-10-14T12:00:00+08:00"):
    return {"id": id, "dynamic_id": DYNAMIC, "root_id": ROOT, "parent_id": parent_id,
            "author": author("100" + id), "published_at": published_at,
            "text": f"reply-{id}", "like_count": 0}


def save_reply(connection, document):
    connection.execute("INSERT OR REPLACE INTO replies VALUES (?, ?, ?, ?)",
                       (DYNAMIC, document["root_id"], document["id"], json.dumps(document)))


@pytest.fixture
def archive(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Archive reads must not access credentials or upstream")

    monkeypatch.setattr("backend.bili_monitor.app.load_source_cookie_pairs", forbidden)
    monkeypatch.setattr("httpx.AsyncClient.send", forbidden)
    store = Store(tmp_path / "live-pages.sqlite")
    store.migrate()
    root = {"id": ROOT, "dynamic_id": DYNAMIC, "root_id": "0", "parent_id": "0",
            "author": author("202"), "published_at": "2026-10-14T11:00:00+08:00",
            "text": "root-before", "like_count": 0, "source_reply_count": 31,
            "local_reply_count": 25}
    with store.connection() as connection, connection:
        connection.execute("INSERT INTO identities VALUES (?, ?, ?)", ("202", "uploader", None))
        connection.execute("INSERT INTO archives (id, uid, document) VALUES (?, ?, ?)",
                           (DYNAMIC, "202", json.dumps({"id": DYNAMIC})))
        connection.execute("INSERT INTO root_comments VALUES (?, ?, ?)",
                           (DYNAMIC, ROOT, json.dumps(root)))
        connection.execute("INSERT INTO reply_sync (dynamic_id, root_id, status, synced_source_reply_count) VALUES (?, ?, ?, ?)",
                           (DYNAMIC, ROOT, "success", 31))
        # 故意反序插入；同时间按字符串 ID 排序，未知时间必须后置。
        for id in reversed(ORDERED_IDS):
            save_reply(connection, reply(id, published_at=None) if id == "25" else reply(id))
    # 不进入 TestClient 上下文，避免运行会读取服务配置的 lifespan。
    client = TestClient(create_app(store.path))
    try:
        yield store, client
    finally:
        client.close()


def test_same_page_reads_latest_data_and_metadata_but_old_cursor_stays_frozen(archive):
    store, client = archive
    preview = client.get(REPLIES, params={"limit": 3}).json()
    assert len(preview["items"]) == 3
    cursor = preview["next_cursor"]
    frozen = client.get(REPLIES, params={"cursor": cursor, "limit": 10}).json()
    assert len(frozen["items"]) == 10
    before = client.get(REPLIES, params={"page": "1"}).json()
    assert [item["id"] for item in before["items"]] == ORDERED_IDS[:10]
    assert before["count"] == before["local_reply_count"] == 25
    assert before["root"] == preview["root"]

    with store.connection() as connection, connection:
        save_reply(connection, reply("100", published_at="2026-10-14T11:30:00+08:00"))
        updated = reply(ORDERED_IDS[4])
        updated["text"] = "updated-reply"
        save_reply(connection, updated)
        root = dict(before["root"], text="root-after", source_reply_count=40, local_reply_count=26)
        connection.execute("UPDATE root_comments SET document = ? WHERE dynamic_id = ? AND id = ?",
                           (json.dumps(root), DYNAMIC, ROOT))
        connection.execute("UPDATE reply_sync SET status = 'failed', synced_source_reply_count = 35 WHERE dynamic_id = ? AND root_id = ?",
                           (DYNAMIC, ROOT))

    after = client.get(REPLIES, params={"page": "1", "limit": 10}).json()
    assert [item["id"] for item in after["items"]] == ["100"] + ORDERED_IDS[:9]
    assert after["items"][5]["text"] == "updated-reply"
    assert after["count"] == after["local_reply_count"] == 26
    assert after["source_reply_count"] == 40
    assert after["replies_last_attempt"] == "failed"
    assert after["synced_source_reply_count"] == 35
    assert after["root"] == root
    assert after["next_cursor"] is None
    second = client.get(REPLIES, params={"page": "2"}).json()
    assert second["root"] == root
    assert second["count"] == 26
    assert second["source_reply_count"] == 40
    assert second["replies_last_attempt"] == "failed"
    assert client.get(REPLIES, params={"cursor": cursor}).json() == frozen
    assert frozen["local_reply_count"] == 25
    assert frozen["source_reply_count"] == frozen["synced_source_reply_count"] == 31
    assert frozen["replies_last_attempt"] == "success"
    assert "root" not in frozen and "count" not in frozen
    sizes = [3]
    page = frozen
    while True:
        sizes.append(len(page["items"]))
        if page["next_cursor"] is None:
            break
        page = client.get(REPLIES, params={"cursor": page["next_cursor"]}).json()
    assert sizes == [3, 10, 10, 2]


def test_reply_to_resolves_parents_across_both_page_boundaries(archive):
    store, client = archive
    with store.connection() as connection, connection:
        save_reply(connection, reply(ORDERED_IDS[0], parent_id=ORDERED_IDS[20]))
        save_reply(connection, reply(ORDERED_IDS[10], parent_id=ORDERED_IDS[0]))
        save_reply(connection, reply(ORDERED_IDS[11], parent_id="999"))
        unknown = reply(ORDERED_IDS[12])
        unknown["author"] = {"id": None, "nickname": "unknown", "avatar_url": None}
        save_reply(connection, unknown)
        save_reply(connection, reply(ORDERED_IDS[13], parent_id=ORDERED_IDS[12]))
        # 其他根下的同名 parent 不是可确认的同根目标。
        connection.execute("INSERT INTO root_comments VALUES (?, ?, ?)",
                           (DYNAMIC, "777", json.dumps({"id": "777"})))
        other = dict(reply("999"), root_id="777")
        save_reply(connection, other)
    pages = [client.get(REPLIES, params={"page": str(page)}).json() for page in (1, 2, 3)]
    items = [item for page in pages for item in page["items"]]
    assert [item["id"] for item in items] == ORDERED_IDS
    assert [len(page["items"]) for page in pages] == [10, 10, 5]
    assert items[0]["parent_id"] == ORDERED_IDS[20]
    assert items[0]["reply_to"] == author("100" + ORDERED_IDS[20])
    assert items[10]["reply_to"] == author("100" + ORDERED_IDS[0])
    assert items[1]["reply_to"] == pages[0]["root"]["author"]
    assert items[11]["reply_to"] is None
    assert items[13]["reply_to"] is None
    assert all(page["count"] == 25 and page["next_cursor"] is None for page in pages)


@pytest.mark.parametrize("value", ["", "0", "-1", "01", "+1", " 1", "1 ", "1.0", "1e1", "true", "１", "١", "1\n"])
def test_page_requires_positive_ascii_integer_string(archive, value):
    _, client = archive
    response = client.get(REPLIES, params={"page": value})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_INPUT"


@pytest.mark.parametrize("query", [
    "page=1&cursor=", "page=1&cursor=" + "a" * 32,
    "page=1&limit=3", "page=1&limit=9", "page=1&limit=0", "page=1&limit=11",
    "page=1&extra=value", "page=1&page=2", "page=1&limit=10&limit=10",
    "page=1&cursor=a&cursor=b", "page=1&sort=latest",
])
def test_page_rejects_mixed_cursor_bad_limit_unknown_and_duplicate_query(archive, query):
    _, client = archive
    response = client.get(REPLIES + "?" + query)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_INPUT"


@pytest.mark.parametrize("page", ["4", "999", "9" * 5000])
def test_out_of_range_page_returns_latest_count_and_root(archive, page):
    store, client = archive
    response = client.get(REPLIES, params={"page": page})
    assert response.status_code == 200
    batch = response.json()
    assert batch["items"] == []
    assert batch["count"] == batch["local_reply_count"] == 25
    assert batch["source_reply_count"] == batch["synced_source_reply_count"] == 31
    assert batch["replies_last_attempt"] == "success"
    assert batch["root"]["id"] == ROOT
    assert batch["next_cursor"] is None
    with store.connection() as connection:
        save_reply(connection, reply("100"))
    latest = client.get(REPLIES, params={"page": page}).json()
    assert latest["items"] == []
    assert latest["count"] == latest["local_reply_count"] == 26


def test_empty_root_has_zero_count_but_does_not_invent_success(archive):
    store, client = archive
    with store.connection() as connection, connection:
        connection.execute("DELETE FROM replies")
        connection.execute("DELETE FROM reply_sync")
        root = {"id": ROOT, "author": author("202"), "source_reply_count": None}
        connection.execute("UPDATE root_comments SET document = ?", (json.dumps(root),))
    for page in (1, 20):
        batch = client.get(REPLIES, params={"page": page}).json()
        assert batch == {"items": [], "next_cursor": None, "count": 0, "root": root,
                         "source_reply_count": None, "local_reply_count": 0,
                         "replies_last_attempt": "pending", "synced_source_reply_count": None}


def test_page_is_read_only_and_never_reads_or_writes_reply_pages(archive, monkeypatch):
    store, client = archive
    preview = client.get(REPLIES).json()
    assert preview["next_cursor"] is not None
    original_connection = Store.connection
    with original_connection(store) as connection:
        snapshots = connection.execute("SELECT * FROM reply_pages ORDER BY token").fetchall()
    statements, denied = [], []

    def authorize(action, table, column, database, trigger):
        if table == "reply_pages":
            denied.append(action)
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    @contextmanager
    def read_only_connection(self):
        with original_connection(self) as connection:
            connection.execute("PRAGMA query_only = ON")
            connection.set_authorizer(authorize)
            connection.set_trace_callback(statements.append)
            yield connection

    monkeypatch.setattr(Store, "connection", read_only_connection)
    # 已有写事务不应被页码读取竞争；BEGIN IMMEDIATE 在此不能成功。
    with original_connection(store) as writer:
        writer.execute("BEGIN IMMEDIATE")
        for page in (1, 2, 99):
            response = client.get(REPLIES, params={"page": page})
            assert response.status_code == 200
            assert response.json()["count"] == 25
    assert denied == []
    assert [sql for sql in statements if sql.startswith("BEGIN")] == ["BEGIN"] * 3
    assert not any("reply_pages" in sql.lower() for sql in statements)
    with original_connection(store) as connection:
        assert connection.execute("SELECT * FROM reply_pages ORDER BY token").fetchall() == snapshots


@pytest.mark.parametrize("url", [
    f"/api/archive/dynamics/999/comments/{ROOT}/replies",
    f"/api/archive/dynamics/{DYNAMIC}/comments/999/replies",
])
def test_page_unknown_dynamic_or_root_is_not_found(archive, url):
    _, client = archive
    response = client.get(url, params={"page": "1"})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


@pytest.mark.parametrize("query,code", [
    ("limit=10", "INVALID_INPUT"), ("limit=0", "INVALID_INPUT"),
    ("cursor=" + "a" * 32 + "&limit=3", "CURSOR_INVALID"),
    ("cursor=" + "a" * 32 + "&limit=11", "INVALID_INPUT"),
    ("cursor=bad", "CURSOR_INVALID"), ("limit=3&limit=3", "INVALID_INPUT"),
    ("extra=1", "INVALID_INPUT"),
])
def test_legacy_validation_semantics_are_unchanged(archive, query, code):
    _, client = archive
    response = client.get(REPLIES + "?" + query)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == code
