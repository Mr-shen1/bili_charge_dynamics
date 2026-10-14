"""17 / T2-T3：原始虚构回复 JSON → 公开首次同步 → SQLite/HTTP。"""

import copy
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from threading import Event

import anyio

import httpx
import pytest
import sqlite3
import shutil

from backend.tests.archive_support import BASE, TARGETS, UID, archive_client, set_specified
from backend.tests.root_support import ARCHIVE, COMMENTS, prepare, root_fixture, source_handler

ROOT = "900719925474099312346"
REPLIES = COMMENTS + "/" + ROOT + "/replies"


def reply_fixture():
    return json.loads((Path(__file__).parent / "fixtures/replies.json").read_text())


def reply_source(state):
    roots = source_handler(state)
    def handler(request):
        if request.url.path != "/x/v2/reply/reply":
            return roots(request)
        assert request.url.params["oid"] == "99123"
        assert request.url.params["type"] == "17"
        assert request.url.params["root"] == ROOT
        assert request.url.params["ps"] == "20"
        page = int(request.url.params["pn"])
        state.setdefault("reply_pages", []).append(page)
        if state.get("fail_reply_page") == page:
            raise httpx.ReadError("FICTIONAL_SECRET_REPLY")
        payload = copy.deepcopy(state.get("reply_payload", reply_fixture()))
        replies = state.get("replies", payload["data"]["replies"])
        payload["data"]["page"].update(num=page, count=len(replies))
        payload["data"]["replies"] = replies[(page - 1) * 20:page * 20] or None
        return httpx.Response(200, json=payload)
    return handler


def test_initial_archives_complete_replies_and_relations_after_reopen(tmp_path, monkeypatch):
    class AdvancingTime(datetime):
        tick = 0

        @classmethod
        def now(cls, tz=None):
            cls.tick += 1
            return datetime(2026, 10, 14, 12, 0, tzinfo=tz) + timedelta(seconds=cls.tick)

    # 仅替换墙钟，稳定跨越秒边界；生产 HTTP、SQLite 和同步链都保持真实。
    monkeypatch.setattr("backend.bili_monitor.comment_status.datetime", AdvancingTime)
    path, state = tmp_path / "replies.sqlite", {}
    with archive_client(path, reply_source(state)) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        first = client.get(REPLIES)
        assert first.status_code == 200
        first = first.json()
        assert len(first["items"]) == 3
        assert first["source_reply_count"] == first["local_reply_count"] == 5
        assert first["items"][0] == {
            "id": "900719925474099312350", "dynamic_id": "123", "root_id": ROOT, "parent_id": ROOT,
            "author": {"id": "202", "nickname": "虚构读者", "avatar_url": None},
            "published_at": "2026-10-09T10:38:20+08:00", "text": "已有回复 <b>文本</b> 🙂", "like_count": 1,
            "reply_to": {"id": UID, "nickname": "虚构星海", "avatar_url": "https://example.invalid/avatar.png"},
        }
        assert first["items"][1]["reply_to"]["id"] == "202"
        assert first["items"][2]["reply_to"] is None
        assert state["reply_pages"] == [1, 2, 2]
        saved = client.get(ARCHIVE).json()
        assert saved["local_reply_count"] == 5
        assert saved["work"]["comments"] == saved["work"]["replies"] == "success"
        assert saved["comments_last_attempt"] == "success"
        assert saved["synced_comment_count"] == 7
        assert saved["work"]["media"] == "pending"
        client.post("/api/sync/initial", json={"uid": UID})
        current = client.get(ARCHIVE).json()
        expected = copy.deepcopy(saved)
        # 显式 initial 会实际重扫评论；成功时间可推进，不能依赖两次恰好在同一秒。
        # 内容、关系、checkpoint 等其他字段仍完整比较，重开则验证最新完整快照。
        for field in ("root_comments_last_succeeded_at", "replies_last_succeeded_at", "comments_last_succeeded_at"):
            assert current[field] >= saved[field]
            assert current["comment_sync"][field] == current[field]
            expected[field] = expected["comment_sync"][field] = current[field]
        assert current == expected
        saved = current
    with archive_client(path) as client:
        second = client.get(REPLIES, params={"cursor": first["next_cursor"], "limit": 10}).json()
        assert len(second["items"]) == 2
        assert second["next_cursor"] is None
        assert client.get(ARCHIVE).json() == saved


def twenty_five_replies():
    template = reply_fixture()["data"]["replies"][0]
    replies = []
    for id in [str(value) for value in range(23, 0, -1)] + ["900719925474099312351", "900719925474099312350"]:
        reply = copy.deepcopy(template)
        reply.update(rpid_str=id, ctime=None if id == "23" else 1791513500)
        reply["content"]["message"] = "旧回复 " + id
        if id == "1":
            reply["parent_str"] = "900719925474099312350"  # 目标出现在另一来源页。
        replies.append(reply)
    return replies


def test_complete_25_reply_sort_snapshot_pagination_cursor_and_storage_retry(tmp_path):
    expected = ["1", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "2", "20", "21", "22", "3", "4", "5", "6", "7", "8", "9", "900719925474099312350", "900719925474099312351", "23"]
    path, state = tmp_path / "25.sqlite", {"replies": twenty_five_replies()}
    with archive_client(path, reply_source(state)) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        first = client.get(REPLIES, params={"limit": 3}).json()
        assert first["items"][0]["reply_to"]["id"] == "202"
        assert [item["id"] for item in first["items"]] == expected[:3]
        assert state["reply_pages"] == [1, 2, 3, 3]
        # 更新内容/时间和插入仅进入新首批，不进入原读取范围。
        state["replies"][0].update(ctime=1791513490)
        state["replies"][0]["content"]["message"] = "新回复 23"
        new = copy.deepcopy(state["replies"][0])
        new["rpid_str"] = "888"
        state["replies"].append(new)
        client.post("/api/sync/initial", json={"uid": UID})
        cursor = first["next_cursor"]
        second = client.get(REPLIES, params={"cursor": cursor}).json()
        assert [item["id"] for item in second["items"]] == expected[3:13]
        assert client.get(REPLIES, params={"cursor": cursor, "limit": 10}).json() == second
        for bad in ("0" * 32, "forged", cursor):
            url = COMMENTS + "/2/replies" if bad == cursor else REPLIES
            response = client.get(url, params={"cursor": bad})
            assert response.status_code == 422
            assert response.json()["error"]["code"] == "CURSOR_INVALID"
        root_cursor = client.get(COMMENTS, params={"limit": 1}).json()["next_cursor"]
        assert client.get(REPLIES, params={"cursor": root_cursor}).json()["error"]["code"] == "CURSOR_INVALID"
        assert client.get(COMMENTS, params={"cursor": cursor}).json()["error"]["code"] == "CURSOR_INVALID"
        with sqlite3.connect(path, isolation_level=None) as database:
            database.execute("BEGIN EXCLUSIVE")
            assert client.get(REPLIES, params={"cursor": cursor}).json()["error"]["code"] == "STORAGE_UNAVAILABLE"
            database.rollback()
        assert client.get(REPLIES, params={"cursor": cursor}).json() == second
        assert client.get(REPLIES).json()["items"][0]["text"] == "新回复 23"
        assert client.get(REPLIES, params={"cursor": cursor, "limit": 3}).json()["error"]["code"] == "CURSOR_INVALID"
    with archive_client(path) as client:
        assert client.get(REPLIES, params={"cursor": cursor}).json() == second
        third = client.get(REPLIES, params={"cursor": second["next_cursor"]}).json()
        fourth = client.get(REPLIES, params={"cursor": third["next_cursor"]}).json()
        items = first["items"] + second["items"] + third["items"] + fourth["items"]
        assert [len(first["items"]), len(second["items"]), len(third["items"]), len(fourth["items"])] == [3, 10, 10, 2]
        assert [item["id"] for item in items] == expected
        assert fourth["items"][-1]["text"] == "旧回复 23"
        assert fourth["next_cursor"] is None
        assert fourth["local_reply_count"] == fourth["source_reply_count"] == 25


def test_failure_does_not_advance_round_checkpoint_and_reopen_retries_without_new_signal(tmp_path, caplog):
    path, state = tmp_path / "partial.sqlite", {}
    with archive_client(path, reply_source(state)) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        state.update(replies=twenty_five_replies(), fail_reply_page=2, dynamic_count=8)
        client.post("/api/sync/initial", json={"uid": UID})
        saved = client.get(ARCHIVE).json()
        assert saved["synced_comment_count"] == saved["synced_reply_comment_count"] == 7
        assert saved["comments_last_attempt"] == saved["replies_last_attempt"] == "failed"
        assert saved["work"]["comments"] == "success"
        assert saved["synced_root_comment_count"] == saved["source_comment_count"] == 8
        assert saved["work"]["replies"] == "pending"
        assert saved["local_reply_count"] == 25  # 旧5 + 新取得20，不清理旧归档。
        assert "FICTIONAL_SECRET" not in str(saved) + caplog.text
    state.pop("fail_reply_page")
    state["detail_fail"] = True
    with archive_client(path, reply_source(state)) as client:
        assert client.get(ARCHIVE).json() == saved
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get(ARCHIVE).json()["work"]["replies"] == "success"
        assert client.get(ARCHIVE).json()["local_reply_count"] == 28
        assert client.get(ARCHIVE).json()["synced_comment_count"] == 8
        set_specified(client, enabled=False)
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["processed"] == 0
        client.delete(TARGETS + "/123")
        client.delete(f"{BASE}/{UID}/monitor")
        assert client.get(REPLIES).json()["local_reply_count"] == 28


def test_missing_reply_target_is_unknown_not_a_rejected_page_or_mentioned_user(tmp_path):
    state = {"reply_payload": reply_fixture()}
    state["reply_payload"]["data"]["replies"][0].pop("parent_str")
    state["reply_payload"]["data"]["replies"][0]["content"]["members"] = [{"mid": "404", "uname": "被提及"}]
    with archive_client(tmp_path / "target.sqlite", reply_source(state)) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get(ARCHIVE).json()["work"]["replies"] == "success"
        item = client.get(REPLIES).json()["items"][0]
        assert item["parent_id"] is None
        assert item["reply_to"] is None


def test_first_reply_failure_and_root_failure_are_not_successful_empty_rounds(tmp_path):
    state = {"fail_reply_page": 1}
    with archive_client(tmp_path / "first-failure.sqlite", reply_source(state)) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        saved = client.get(ARCHIVE).json()
        assert saved["synced_comment_count"] is None
        assert saved["synced_reply_comment_count"] is None
        assert saved["comments_last_attempt"] == "failed"
        thread = client.get(REPLIES).json()
        assert thread["items"] == []
        assert thread["replies_last_attempt"] == "failed"
        assert thread["source_reply_count"] == 5
        assert thread["local_reply_count"] == 0
        zero = client.get(COMMENTS + "/2/replies").json()
        assert zero["replies_last_attempt"] == "success"
        assert zero["source_reply_count"] == zero["local_reply_count"] == 0
        state.pop("fail_reply_page")
        state["fail_page"] = 2
        client.post("/api/sync/initial", json={"uid": UID})
        saved = client.get(ARCHIVE).json()
        assert saved["comments_last_attempt"] == "failed"
        assert saved["synced_comment_count"] is None
        assert saved["work"]["comments"] == saved["work"]["replies"] == "pending"


@pytest.mark.parametrize("case", ["business", "http", "missing_replies", "bad_count", "wrong_root", "wrong_oid", "wrong_type", "wrong_page", "wrong_item_root", "repeated", "count_changed", "count_too_small", "empty_nonzero", "transient_tail"])
def test_reply_source_errors_preserve_content_and_round_checkpoint(tmp_path, caplog, case):
    state = {"replies": twenty_five_replies()}
    normal = reply_source(state)
    attempts = 0
    def handler(request):
        nonlocal attempts
        response = normal(request)
        if request.url.path != "/x/v2/reply/reply" or not state.get("broken"):
            return response
        payload = response.json()
        page = int(request.url.params["pn"])
        if case == "http":
            return httpx.Response(403, text="FICTIONAL_SECRET_REPLY_DENIAL")
        if case == "business":
            payload = {"code": -403, "message": "FICTIONAL_SECRET_REPLY_DENIAL", "data": None}
        elif case == "missing_replies":
            payload["data"].pop("replies")
        elif case == "bad_count":
            payload["data"]["page"]["count"] = None
        elif case == "wrong_root":
            payload["data"]["root"]["rpid_str"] = "999"
        elif case == "wrong_oid":
            payload["data"]["root"]["oid"] = 123
        elif case == "wrong_type":
            payload["data"]["root"]["type"] = True
        elif case == "wrong_page":
            payload["data"]["page"]["num"] = "1"
        elif case == "wrong_item_root" and payload["data"]["replies"]:
            payload["data"]["replies"][0]["root_str"] = "2"
        elif case == "repeated":
            payload["data"]["replies"] = state["replies"][:20]
        elif case == "count_changed" and page == 2:
            payload["data"]["page"]["count"] = 26
        elif case == "count_too_small":
            payload["data"]["page"]["count"] = 5
        elif case == "empty_nonzero":
            payload["data"]["replies"] = None
        elif case == "transient_tail" and page == 2:
            attempts += 1
            if attempts == 1:
                payload["data"]["replies"] = None
        return httpx.Response(200, json=payload)
    with archive_client(tmp_path / "source-errors.sqlite", handler) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        before = client.get(REPLIES).json()
        state.update(broken=True, dynamic_count=8)
        client.post("/api/sync/initial", json={"uid": UID})
        saved = client.get(ARCHIVE).json()
        assert saved["synced_comment_count"] == saved["synced_reply_comment_count"] == 7
        assert saved["comments_last_attempt"] == saved["replies_last_attempt"] == "failed"
        assert saved["local_reply_count"] == 25
        assert client.get(REPLIES).json()["items"] == before["items"]
        assert "FICTIONAL_SECRET" not in str(saved) + caplog.text
        state["broken"] = False
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get(ARCHIVE).json()["synced_comment_count"] == 8


def test_slow_reply_scan_does_not_hold_database_or_finish_before_last_page(tmp_path):
    path, state = tmp_path / "slow.sqlite", {"replies": twenty_five_replies(), "phase": "old"}
    reached, release = Event(), Event()
    normal = reply_source(state)
    async def handler(request):
        phase = state["phase"]
        response = normal(request)
        if request.url.path == "/x/v2/reply/reply":
            if phase == "old" and request.url.params["pn"] == "2":
                reached.set()
                await anyio.to_thread.run_sync(lambda: release.wait(10))
                return httpx.Response(503, text="FICTIONAL_SECRET_OLD")
            payload = response.json()
            for reply in payload["data"]["replies"] or []:
                reply["content"]["message"] = phase
            return httpx.Response(200, json=payload)
        return response
    with archive_client(path, handler) as older, archive_client(path, handler) as newer:
        prepare(older)
        with ThreadPoolExecutor() as pool:
            future = pool.submit(older.post, "/api/sync/initial", json={"uid": UID})
            try:
                assert reached.wait(5)
                saved = newer.get(ARCHIVE).json()
                assert saved["synced_comment_count"] is None
                assert saved["work"]["comments"] == "success"
                assert saved["work"]["replies"] == "pending"
                assert newer.get(REPLIES).json()["local_reply_count"] == 20
                assert set_specified(newer).status_code == 200
                state["phase"] = "new"
                state["dynamic_count"] = 8
                newer.post("/api/sync/initial", json={"uid": UID})
            finally:
                release.set()
            assert future.result().status_code == 200
        saved = newer.get(ARCHIVE).json()
        assert saved["comments_last_attempt"] == "success"
        assert saved["synced_comment_count"] == 8
        assert saved["local_reply_count"] == 25
        assert newer.get(REPLIES).json()["items"][0]["text"] == "new"
    with archive_client(path) as client:
        assert client.get(ARCHIVE).json() == saved


def test_unknown_reply_count_and_successful_zero_remain_distinct(tmp_path):
    state = {"payload": root_fixture()}
    state["payload"]["data"]["replies"][0]["rcount"] = None
    normal = reply_source(state)
    def handler(request):
        response = normal(request)
        if request.url.path == "/x/v2/reply/reply":
            payload = response.json()
            payload["data"]["page"]["count"] = None
            return httpx.Response(200, json=payload)
        return response
    with archive_client(tmp_path / "unknown.sqlite", handler) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        thread = client.get(REPLIES).json()
        assert thread["source_reply_count"] is None
        assert thread["local_reply_count"] == 0
        assert thread["replies_last_attempt"] == "failed"
        zero = client.get(COMMENTS + "/2/replies").json()
        assert zero["source_reply_count"] == zero["local_reply_count"] == 0
        assert zero["replies_last_attempt"] == "success"
        assert client.get(ARCHIVE).json()["synced_comment_count"] is None


def test_cursor_no_ttl_and_missing_context_requires_explicit_restart(tmp_path, monkeypatch):
    path, backup, state = tmp_path / "cursor.sqlite", tmp_path / "older.sqlite", {}
    with archive_client(path, reply_source(state)) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
    shutil.copyfile(path, backup)  # 较早的完整数据库输入，尚无此次读取上下文。
    with archive_client(path) as client:
        first = client.get(REPLIES).json()
        cursor = first["next_cursor"]
        second = client.get(REPLIES, params={"cursor": cursor}).json()
        monkeypatch.setattr("backend.bili_monitor.storage.time.time", lambda: 4102444800)
        assert client.get(REPLIES, params={"cursor": cursor}).json() == second
    with archive_client(path) as client:
        assert client.get(REPLIES, params={"cursor": cursor}).json() == second
    shutil.copyfile(backup, path)
    with archive_client(path) as client:
        response = client.get(REPLIES, params={"cursor": cursor})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "CURSOR_INVALID"
        restarted = client.get(REPLIES).json()
        assert restarted["items"] == first["items"]
        assert restarted["next_cursor"] != cursor
        for query in ("limit=10", "limit=0", "limit=4", "limit=3&limit=3", "unknown=1"):
            assert client.get(REPLIES + "?" + query).status_code == 422
        assert client.get(COMMENTS + "/999/replies").status_code == 404
        assert client.get("/api/archive/dynamics/999/comments/" + ROOT + "/replies").status_code == 404


def test_v6_upgrade_preserves_roots_and_valid_root_cursor_then_archives_replies(tmp_path):
    path = tmp_path / "v6.sqlite"
    old = {
        "id": "123", "author": {"id": UID, "nickname": None, "avatar_url": None},
        "published_at": None, "edited_at": None, "edit_status": "unknown", "title": None,
        "text": "旧正文", "content_state": "success", "last_attempt": "success",
        "source_comment_count": 7, "local_comment_count": 1, "local_reply_count": 0,
        "media_sources": [], "comment_locator": {"oid": "99123", "type": 17},
        "observed_version": None, "synced_version": None,
        "root_comments_last_attempt": "success", "synced_root_comment_count": 7,
        "work": {"text": "success", "comments": "success", "replies": "pending", "media": "pending"},
    }
    root = {"id": ROOT, "dynamic_id": "123", "text": "旧根评论",
            "author": {"id": UID, "nickname": "虚构星海", "avatar_url": None},
            "published_at": "2026-10-09T10:38:16+08:00", "like_count": 8, "source_reply_count": 5,
            "root_id": "0", "parent_id": "0", "media_sources": [], "comment_locator": {"oid": "99123", "type": 17}}
    token = "a" * 32
    frozen = {"items": [root], "next_cursor": None}
    # 固定已发布 v6 文件只作迁移输入；关系及冻结内容从 HTTP 观察。
    with sqlite3.connect(path) as database:
        database.executescript("""
            CREATE TABLE identities(uid TEXT PRIMARY KEY, name TEXT, avatar_url TEXT);
            CREATE TABLE monitors(uid TEXT PRIMARY KEY REFERENCES identities(uid), mode TEXT, recent_n INTEGER, enabled INTEGER);
            CREATE TABLE targets(uid TEXT REFERENCES monitors(uid) ON DELETE CASCADE, id TEXT, PRIMARY KEY(uid,id));
            CREATE TABLE archives(id TEXT PRIMARY KEY, uid TEXT REFERENCES identities(uid), document TEXT, generation INTEGER DEFAULT 0);
            CREATE TABLE archive_pages(token TEXT PRIMARY KEY, batch_limit INTEGER, document TEXT, expires_at INTEGER, resource TEXT);
            CREATE TABLE root_comments(dynamic_id TEXT REFERENCES archives(id), id TEXT, document TEXT, PRIMARY KEY(dynamic_id,id));
            CREATE TABLE root_comment_pages(token TEXT PRIMARY KEY, resource TEXT, batch_limit INTEGER, document TEXT);
            PRAGMA user_version = 6;
        """)
        database.execute("INSERT INTO identities VALUES (?, NULL, NULL)", (UID,))
        database.execute("INSERT INTO monitors VALUES (?, 'specified', 10, 1)", (UID,))
        database.execute("INSERT INTO targets VALUES (?, '123')", (UID,))
        database.execute("INSERT INTO archives VALUES ('123', ?, ?, 0)", (UID, json.dumps(old)))
        database.execute("INSERT INTO root_comments VALUES ('123', ?, ?)", (ROOT, json.dumps(root)))
        database.execute("INSERT INTO root_comment_pages VALUES (?, 'root-comments:123:hot:v1', 20, ?)", (token, json.dumps(frozen)))
    with archive_client(path, reply_source({})) as client:
        assert client.get(COMMENTS, params={"cursor": token}).json() == frozen
        saved = client.get(ARCHIVE).json()
        assert saved["text"] == "旧正文"
        assert saved["synced_root_comment_count"] == 7
        assert saved["synced_comment_count"] is None
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get(ARCHIVE).json()["synced_comment_count"] == 7
        assert client.get(REPLIES).json()["local_reply_count"] == 5
        assert client.get(COMMENTS, params={"cursor": token}).json() == frozen
    with archive_client(path) as client:
        assert client.get(COMMENTS, params={"cursor": token}).json() == frozen
        assert client.get(REPLIES).json()["items"][1]["reply_to"]["id"] == "202"


def test_missing_observations_keep_known_reply_metadata_and_lifecycle_retains_archive(tmp_path):
    path, state = tmp_path / "retained.sqlite", {}
    with archive_client(path, reply_source(state)) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        before = client.get(REPLIES).json()["items"][0]
        state["reply_payload"] = reply_fixture()
        reply = state["reply_payload"]["data"]["replies"][0]
        reply.update(member={}, ctime=None, like=None)
        reply["content"].pop("message")
        reply.pop("parent_str")
        state["unknown_count"] = True
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get(REPLIES).json()["items"][0] == before
        state["fail_reply_page"] = 1
        client.post("/api/sync/initial", json={"uid": UID})
        set_specified(client, enabled=False)
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["processed"] == 0
        client.delete(TARGETS + "/123")
        client.delete(f"{BASE}/{UID}/monitor")
    with archive_client(path) as client:
        assert client.get(REPLIES).json()["items"][0] == before
        assert client.get(ARCHIVE).json()["local_reply_count"] == 5


def test_reply_cursor_is_bound_to_dynamic_even_with_same_root_id(tmp_path):
    state = {}
    normal = reply_source(state)
    def handler(request):
        response = normal(request)
        if request.url.path == "/opus/124":
            return httpx.Response(200, text=response.text.replace('"id_str":"123"', '"id_str":"124"'))
        if request.url.path == "/x/polymer/web-dynamic/v1/detail" and request.url.params["id"] == "124":
            payload = response.json()
            payload["data"]["item"]["id_str"] = "124"
            return httpx.Response(200, json=payload)
        return response
    with archive_client(tmp_path / "parents.sqlite", handler) as client:
        prepare(client)
        assert client.post(TARGETS, json={"id": "124"}).status_code == 201
        client.post("/api/sync/initial", json={"uid": UID})
        cursor = client.get(REPLIES).json()["next_cursor"]
        wrong = client.get("/api/archive/dynamics/124/comments/" + ROOT + "/replies", params={"cursor": cursor})
        assert wrong.status_code == 422
        assert wrong.json()["error"]["code"] == "CURSOR_INVALID"


def test_one_failed_root_does_not_block_other_readable_reply_threads(tmp_path):
    state = {"payload": root_fixture(), "fail_reply_page": 1}
    state["payload"]["data"]["replies"][1]["rcount"] = 1
    normal = reply_source(state)
    def handler(request):
        if request.url.path == "/x/v2/reply/reply" and request.url.params["root"] == "2":
            number = int(request.url.params["pn"])
            reply = copy.deepcopy(reply_fixture()["data"]["replies"][0])
            reply.update(rpid_str="700", root_str="2", parent_str="2")
            return httpx.Response(200, json={"code": 0, "data": {
                "page": {"num": number, "size": 20, "count": 1},
                "root": state["payload"]["data"]["replies"][1], "replies": [reply] if number == 1 else None,
            }})
        return normal(request)
    with archive_client(tmp_path / "threads.sqlite", handler) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get(REPLIES).json()["replies_last_attempt"] == "failed"
        other = client.get(COMMENTS + "/2/replies").json()
        assert other["replies_last_attempt"] == "success"
        assert other["source_reply_count"] == other["local_reply_count"] == 1
        assert other["items"][0]["reply_to"]["id"] == "202"
        assert client.get(ARCHIVE).json()["synced_comment_count"] is None
        state.pop("fail_reply_page")
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get(ARCHIVE).json()["local_reply_count"] == 6
        assert client.get(ARCHIVE).json()["comments_last_attempt"] == "success"


def test_unknown_new_root_reply_count_does_not_reuse_old_zero_to_skip_required_pages(tmp_path):
    state = {"payload": root_fixture()}
    state["payload"]["data"]["replies"][0]["rcount"] = 0
    with archive_client(tmp_path / "old-zero.sqlite", reply_source(state)) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get(REPLIES).json()["local_reply_count"] == 0
        assert "reply_pages" not in state
        state["payload"]["data"]["replies"][0]["rcount"] = None
        state["dynamic_count"] = 8
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get(REPLIES).json()["local_reply_count"] == 5
        assert client.get(REPLIES).json()["source_reply_count"] == 5
        assert client.get(ARCHIVE).json()["synced_comment_count"] == 8
