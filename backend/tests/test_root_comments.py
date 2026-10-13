"""15 / T2-T3：原始来源 JSON → 首次同步 → SQLite → 公开 HTTP。"""

import copy
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import anyio
from pathlib import Path

import httpx
import pytest

from backend.tests.archive_support import (
    BASE, UID, TARGETS, archive_client, author_html, detail_json, set_specified,
)

ARCHIVE = "/api/archive/dynamics/123"
COMMENTS = ARCHIVE + "/comments"


def root_fixture():
    return json.loads((Path(__file__).parent / "fixtures/root-comments.json").read_text())


def source_handler(state):
    def handler(request):
        if request.url.host == "www.bilibili.com":
            html = author_html()
            if state.get("unknown_count"):
                html = html.replace('"count":7', '"count":null')
            return httpx.Response(200, text=html + "暂无权查看当前评论")
        if request.url.path == "/x/polymer/web-dynamic/v1/detail":
            payload = detail_json()
            if state.get("detail_fail"):
                raise httpx.ReadError("FICTIONAL_SECRET_DETAIL")
            payload["data"]["item"]["modules"]["module_dynamic"]["major"] = {"type": "MAJOR_TYPE_BLOCKED"}
            if "basic" in state:
                payload["data"]["item"]["basic"] = state["basic"]
            if state.get("unknown_count"):
                payload["data"]["item"]["modules"]["module_stat"]["comment"]["count"] = None
            return httpx.Response(200, json=payload)
        assert request.url.path == "/x/v2/reply"
        assert request.url.params["oid"] == "99123"  # 不等于动态 ID
        assert request.url.params["type"] == "17"
        assert request.url.params["ps"] == "20"
        assert request.url.params["sort"] == "0"
        page = int(request.url.params["pn"])
        state.setdefault("pages", []).append(page)
        if state.get("fail_page") == page:
            raise httpx.ReadError("FICTIONAL_SECRET_COMMENT")
        payload = copy.deepcopy(state.get("payload", root_fixture()))
        payload["data"]["page"]["num"] = page
        roots = state.get("roots", payload["data"]["replies"])
        payload["data"]["replies"] = roots[(page - 1) * 20:page * 20] or None
        if "roots" in state:
            payload["data"]["page"].update(count=len(roots), acount=len(roots) + 5)
        return httpx.Response(200, json=payload)
    return handler


def prepare(client):
    assert client.post(BASE, json={"uid": UID}).status_code == 201
    assert client.post(TARGETS, json={"id": "123"}).status_code == 201
    assert set_specified(client).status_code == 200


def test_initial_archives_existing_roots_independently_of_restricted_body(tmp_path):
    state = {}
    path = tmp_path / "roots.sqlite"
    with archive_client(path, source_handler(state)) as client:
        prepare(client)
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["failed"] == 1
        saved = client.get(ARCHIVE).json()
        assert saved["content_state"] == "restricted"
        assert saved["source_comment_count"] == 7
        assert saved["local_comment_count"] == 2
        assert saved["local_reply_count"] == 0
        assert saved["work"]["comments"] == "success"
        assert saved["work"]["replies"] == saved["work"]["media"] == "pending"
        assert saved["root_comments_last_attempt"] == "success"
        assert saved["synced_root_comment_count"] == 7
        roots = client.get(COMMENTS).json()
        assert roots["next_cursor"] is None
        assert roots["items"][0] == {
            "id": "900719925474099312346", "dynamic_id": "123",
            "author": {"id": UID, "nickname": "虚构星海", "avatar_url": "https://example.invalid/avatar.png"},
            "published_at": "2026-10-09T10:38:16+08:00", "text": "已有根评论\n<b>只作文本</b> 🙂",
            "like_count": 8, "source_reply_count": 5,
            "root_id": "0", "parent_id": "0", "comment_locator": {"oid": "99123", "type": 17},
            "media_sources": [{"url": "https://example.invalid/comment.png", "width": 640, "height": 480}],
        }
        assert state["pages"] == [1, 2, 2]  # 短页也明确读至空页，不由总数猜结束。
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get(COMMENTS).json() == roots
    with archive_client(path) as client:
        assert client.get(COMMENTS).json() == roots
        assert client.get(ARCHIVE).json() == saved


def test_partial_page_failure_retains_old_roots_and_checkpoint_then_retries_after_reopen(tmp_path, caplog):
    path = tmp_path / "partial.sqlite"
    state = {}
    with archive_client(path, source_handler(state)) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        state["fail_page"] = 2
        state["payload"] = root_fixture()
        state["payload"]["data"]["replies"][0]["content"]["message"] = "本轮已取得的更新"
        state["payload"]["data"]["replies"][0].update(rpid=900, rpid_str="900")
        client.post("/api/sync/initial", json={"uid": UID})
        saved = client.get(ARCHIVE).json()
        assert saved["local_comment_count"] == 3
        assert saved["synced_root_comment_count"] == 7
        assert saved["work"]["comments"] == "pending"
        assert saved["root_comments_last_attempt"] == "failed"
        assert client.get(COMMENTS).json()["items"][0]["text"] == "本轮已取得的更新"
        assert "FICTIONAL_SECRET" not in str(saved) + caplog.text
    state.pop("fail_page")
    state["detail_fail"] = True  # 来源无新信号仍沿用既有 locator 重试。
    with archive_client(path, source_handler(state)) as client:
        assert client.get(ARCHIVE).json() == saved
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get(ARCHIVE).json()["work"]["comments"] == "success"
        assert client.get(ARCHIVE).json()["local_comment_count"] == 3
        set_specified(client, enabled=False)
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["processed"] == 0
        client.delete(TARGETS + "/123")
        client.delete(f"{BASE}/{UID}/monitor")
    with archive_client(path) as client:
        assert len(client.get(COMMENTS).json()["items"]) == 3


@pytest.mark.parametrize("basic", [None, {}, {"comment_id_str": "0", "comment_type": 17}, {"comment_id_str": "99123", "comment_type": True}])
def test_missing_locator_is_unconfirmed_not_successful_empty(tmp_path, basic):
    state = {"basic": basic}
    with archive_client(tmp_path / "unknown.sqlite", source_handler(state)) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        saved = client.get(ARCHIVE).json()
        assert saved["root_comments_last_attempt"] == "unconfirmed"
        assert saved["work"]["comments"] == "pending"
        assert saved["synced_root_comment_count"] is None
        assert client.get(COMMENTS).json() == {"items": [], "next_cursor": None}
        assert "pages" not in state


def forty_five_roots():
    template = root_fixture()["data"]["replies"][1]
    roots = []
    for id in range(45, 0, -1):
        reply = copy.deepcopy(template)
        reply.update(rpid_str=str(id), ctime=1791513496, like=0)
        reply["content"]["message"] = "旧评论 " + str(id)
        roots.append(reply)
    by_id = {reply["rpid_str"]: reply for reply in roots}
    for id in ("10", "2", "40"):
        by_id[id].update(like=1, ctime=1791513498)
    by_id["41"].update(like=1, ctime=1791513497)
    by_id["42"].update(ctime=None)
    by_id["43"].update(like=None, ctime=None)
    by_id["44"].update(like=None, ctime=1791513499)
    by_id["45"].update(like=9, ctime=None)
    return roots


@pytest.mark.parametrize("sort,expected", [
    ("hot", ["45", "10", "2", "40", "41", "1", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "3", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "4", "5", "6", "7", "8", "9", "42", "44", "43"]),
    ("latest", ["44", "10", "2", "40", "41", "1", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "3", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "4", "5", "6", "7", "8", "9", "42", "43", "45"]),
])
def test_complete_sort_then_20_20_5_frozen_pages_survive_updates_and_reopen(tmp_path, sort, expected):
    path = tmp_path / "pages.sqlite"
    state = {"roots": forty_five_roots()}
    with archive_client(path, source_handler(state)) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        assert state["pages"] == [1, 2, 3, 4, 4]
        first = client.get(COMMENTS, params={"sort": sort}).json()
        assert [item["id"] for item in first["items"]] == expected[:20]
        assert first["next_cursor"] is not None
        # 修改内容和排序、新增，旧快照不混新内容。
        state["roots"][0].update(like=999, ctime=1791513599)
        state["roots"][0]["content"]["message"] = "新评论 45"
        new = copy.deepcopy(state["roots"][0])
        new["rpid_str"] = "900"
        state["roots"].append(new)
        client.post("/api/sync/initial", json={"uid": UID})
        second = client.get(COMMENTS, params={"sort": sort, "cursor": first["next_cursor"]}).json()
        assert [item["id"] for item in second["items"]] == expected[20:40]
        for params in (
            {"sort": "latest" if sort == "hot" else "hot", "cursor": first["next_cursor"]},
            {"sort": sort, "limit": 19, "cursor": first["next_cursor"]},
            {"sort": sort, "cursor": "0" * 32},
        ):
            assert client.get(COMMENTS, params=params).json()["error"]["code"] == "CURSOR_INVALID"
        assert client.get("/api/archive/dynamics", params={"cursor": first["next_cursor"]}).status_code == 422
    with archive_client(path) as client:  # 未附上游 transport，读取绝不发上游请求。
        assert client.get(COMMENTS, params={"sort": sort, "cursor": first["next_cursor"]}).json() == second
        third = client.get(COMMENTS, params={"sort": sort, "cursor": second["next_cursor"]}).json()
        assert [item["id"] for item in third["items"]] == expected[40:]
        assert third["next_cursor"] is None
        items = first["items"] + second["items"] + third["items"]
        assert [item["id"] for item in items] == expected
        assert next(item for item in items if item["id"] == "45")["text"] == "旧评论 45"
        assert client.get(COMMENTS, params={"sort": sort}).json()["items"][0]["text"] == "新评论 45"


@pytest.mark.parametrize("case", ["business", "http", "missing_replies", "bad_count", "bad_total", "wrong_oid", "nested", "nonadvancing", "empty_denied"])
def test_source_errors_are_not_successful_empty_or_destructive(tmp_path, caplog, case):
    state = {}
    normal = source_handler(state)
    def handler(request):
        response = normal(request)
        if not state.get("broken") or request.url.path != "/x/v2/reply":
            return response
        payload = response.json()
        if case == "http":
            return httpx.Response(403, text="FICTIONAL_SECRET_DENIAL")
        if case == "business":
            payload = {"code": -403, "message": "FICTIONAL_SECRET_DENIAL", "data": None}
        elif case == "missing_replies":
            payload["data"].pop("replies")
        elif case == "bad_count":
            payload["data"]["page"]["count"] = None
        elif case == "bad_total":
            payload["data"]["page"]["acount"] = "FICTIONAL_SECRET_COUNT"
        elif case == "wrong_oid":
            if payload["data"]["replies"]:
                payload["data"]["replies"][0]["oid"] = 123
        elif case == "nested":
            if payload["data"]["replies"]:
                payload["data"]["replies"][0]["root_str"] = "555"
        elif case == "nonadvancing":
            payload["data"]["replies"] = root_fixture()["data"]["replies"]
        elif case == "empty_denied":
            payload["data"]["replies"] = None
        return httpx.Response(200, json=payload)

    with archive_client(tmp_path / "errors.sqlite", handler) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        old_roots = client.get(COMMENTS).json()
        state["broken"] = True
        state["unknown_count"] = True
        # HTML 来源计数也未知，不能覆盖旧可信 7。
        client.post("/api/sync/initial", json={"uid": UID})
        saved = client.get(ARCHIVE).json()
        assert saved["root_comments_last_attempt"] == "failed"
        assert saved["work"]["comments"] == "pending"
        assert saved["source_comment_count"] == saved["synced_root_comment_count"] == 7
        assert client.get(COMMENTS).json() == old_roots
        assert "FICTIONAL_SECRET" not in str(saved) + caplog.text


def test_pinned_roots_are_deduplicated_and_reply_preview_is_not_archived(tmp_path):
    state = {"payload": root_fixture()}
    state["payload"]["data"]["upper"]["top"] = copy.deepcopy(state["payload"]["data"]["replies"][0])
    state["payload"]["data"]["hots"] = [copy.deepcopy(state["payload"]["data"]["replies"][1])]
    with archive_client(tmp_path / "pins.sqlite", source_handler(state)) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get(ARCHIVE).json()["local_comment_count"] == 2
        assert client.get(ARCHIVE).json()["local_reply_count"] == 0
        assert [item["id"] for item in client.get(COMMENTS).json()["items"]] == ["900719925474099312346", "2"]


def test_valid_empty_source_and_unknown_counts_are_distinct_from_failure(tmp_path):
    state = {"payload": root_fixture()}
    state["payload"]["data"]["replies"] = []
    state["payload"]["data"]["page"].update(count=0, acount=0)
    with archive_client(tmp_path / "empty.sqlite", source_handler(state)) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        saved = client.get(ARCHIVE).json()
        assert saved["work"]["comments"] == "success"
        assert saved["local_comment_count"] == saved["local_reply_count"] == 0
        assert saved["source_comment_count"] == 7  # 不拿接口不同口径的数冒充动态信号。
        assert client.get(COMMENTS).json() == {"items": [], "next_cursor": None}
        assert client.get("/api/archive/dynamics/999/comments").status_code == 404
        for query in ("sort=wrong", "limit=21", "limit=0", "sort=hot&sort=latest", "unknown=1"):
            assert client.get(COMMENTS + "?" + query).status_code == 422


def test_v5_locator_and_dynamic_cursor_survive_upgrade_and_root_retry(tmp_path):
    path = tmp_path / "v5.sqlite"
    old = {
        "id": "123", "author": {"id": UID, "nickname": None, "avatar_url": None},
        "published_at": None, "edited_at": None, "edit_status": "unknown", "title": None,
        "text": "旧归档", "content_state": "success", "last_attempt": "success",
        "source_comment_count": 7, "local_comment_count": 0, "media_sources": [],
        "comment_locator": {"oid": "99123", "type": 17},
        "observed_version": None, "synced_version": None,
        "work": {"text": "success", "comments": "pending", "media": "pending"},
    }
    token = "a" * 32
    # 固定已发布 v5 文件只作输入，不从 SQL 观察同步结果。
    with sqlite3.connect(path) as database:
        database.executescript("""
            CREATE TABLE identities(uid TEXT PRIMARY KEY, name TEXT, avatar_url TEXT);
            CREATE TABLE monitors(uid TEXT PRIMARY KEY REFERENCES identities(uid), mode TEXT, recent_n INTEGER, enabled INTEGER);
            CREATE TABLE targets(uid TEXT REFERENCES monitors(uid) ON DELETE CASCADE, id TEXT, PRIMARY KEY(uid,id));
            CREATE TABLE archives(id TEXT PRIMARY KEY, uid TEXT REFERENCES identities(uid), document TEXT, generation INTEGER DEFAULT 0);
            CREATE TABLE archive_pages(token TEXT PRIMARY KEY, batch_limit INTEGER, document TEXT, expires_at INTEGER, resource TEXT);
            PRAGMA user_version = 5;
        """)
        database.execute("INSERT INTO identities VALUES (?, NULL, NULL)", (UID,))
        database.execute("INSERT INTO monitors VALUES (?, 'specified', 10, 1)", (UID,))
        database.execute("INSERT INTO targets VALUES (?, '123')", (UID,))
        database.execute("INSERT INTO archives VALUES ('123', ?, ?, 0)", (UID, json.dumps(old)))
        database.execute("INSERT INTO archive_pages VALUES (?, 10, ?, 4102444800, ?)",
                         (token, json.dumps({"items": [old], "next_cursor": None}), "dynamics:all:published-desc:id-binary:v1"))
    state = {"detail_fail": True}
    with archive_client(path, source_handler(state)) as client:
        upgraded = client.get(ARCHIVE).json()
        assert upgraded == {**old, "local_reply_count": 0, "root_comments_last_attempt": "pending",
                            "synced_root_comment_count": None, "work": {**old["work"], "replies": "pending"}}
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get(ARCHIVE).json()["comment_locator"] == {"oid": "99123", "type": 17}
        assert client.get(ARCHIVE).json()["work"]["comments"] == "success"
        assert len(client.get(COMMENTS).json()["items"]) == 2
        assert client.get("/api/archive/dynamics", params={"cursor": token}).json() == {"items": [old], "next_cursor": None}
    with archive_client(path) as client:
        assert len(client.get(COMMENTS).json()["items"]) == 2


def test_cursor_rejects_other_parent_and_transient_storage_failure_retries_same_batch(tmp_path):
    path = tmp_path / "read-retry.sqlite"
    state = {"roots": forty_five_roots()}
    normal = source_handler(state)
    def handler(request):
        if request.url.path == "/opus/124":
            return httpx.Response(200, text=author_html().replace('"id_str":"123"', '"id_str":"124"'))
        if request.url.path == "/x/polymer/web-dynamic/v1/detail" and request.url.params["id"] == "124":
            payload = detail_json()
            payload["data"]["item"]["id_str"] = "124"
            payload["data"]["item"]["basic"] = None
            return httpx.Response(200, json=payload)
        return normal(request)
    with archive_client(path, handler) as client:
        prepare(client)
        client.post(TARGETS, json={"id": "124"})
        client.post("/api/sync/initial", json={"uid": UID})
        cursor = client.get(COMMENTS).json()["next_cursor"]
        second = client.get(COMMENTS, params={"cursor": cursor}).json()
        response = client.get("/api/archive/dynamics/124/comments", params={"cursor": cursor})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "CURSOR_INVALID"
        dynamic_cursor = client.get("/api/archive/dynamics?limit=1").json()["next_cursor"]
        assert client.get(COMMENTS, params={"cursor": dynamic_cursor}).status_code == 422
        with sqlite3.connect(path, isolation_level=None) as database:
            database.execute("BEGIN EXCLUSIVE")
            failure = client.get(COMMENTS, params={"cursor": cursor})
            assert failure.status_code == 503
            assert failure.json()["error"]["code"] == "STORAGE_UNAVAILABLE"
            database.rollback()
        assert client.get(COMMENTS, params={"cursor": cursor}).json() == second


def test_slow_old_scan_does_not_hold_database_or_overwrite_new_root_completion(tmp_path):
    path = tmp_path / "concurrent.sqlite"
    reached, release = Event(), Event()
    state = {"phase": "baseline"}
    base_handler = source_handler({})
    async def handler(request):
        phase = state["phase"]
        response = base_handler(request)
        if request.url.path != "/x/v2/reply":
            return response
        if phase == "older" and request.url.params["pn"] == "2":
            reached.set()
            await anyio.to_thread.run_sync(lambda: release.wait(10))
            return httpx.Response(503)
        payload = response.json()
        if payload["data"]["replies"]:
            payload["data"]["replies"][0]["content"]["message"] = phase
        return httpx.Response(200, json=payload)
    with archive_client(path, handler) as older, archive_client(path, handler) as newer:
        prepare(older)
        older.post("/api/sync/initial", json={"uid": UID})
        state["phase"] = "older"
        with ThreadPoolExecutor() as pool:
            future = pool.submit(older.post, "/api/sync/initial", json={"uid": UID})
            try:
                assert reached.wait(5)
                assert newer.get(COMMENTS).status_code == 200
                assert set_specified(newer).status_code == 200
                assert newer.get(ARCHIVE).json()["work"]["comments"] == "pending"
                state["phase"] = "newer"
                newer.post("/api/sync/initial", json={"uid": UID})
            finally:
                release.set()
            assert future.result().status_code == 200
        assert newer.get(COMMENTS).json()["items"][0]["text"] == "newer"
        assert newer.get(ARCHIVE).json()["work"]["comments"] == "success"
        assert newer.get(ARCHIVE).json()["root_comments_last_attempt"] == "success"


def test_missing_optional_observations_do_not_erase_trusted_root_metadata(tmp_path):
    state = {}
    with archive_client(tmp_path / "metadata.sqlite", source_handler(state)) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        old = client.get(COMMENTS).json()["items"][0]
        state["payload"] = root_fixture()
        root = state["payload"]["data"]["replies"][0]
        root.update(like=None, rcount="invalid", ctime=None, member={})
        root["content"].pop("pictures")
        state["basic"] = {"comment_id_str": "0", "comment_type": False}
        state["unknown_count"] = True
        client.post("/api/sync/initial", json={"uid": UID})
        saved = client.get(COMMENTS).json()["items"][0]
        for key in ("like_count", "source_reply_count", "published_at", "author", "media_sources"):
            assert saved[key] == old[key]
        assert client.get(ARCHIVE).json()["source_comment_count"] == 7
        assert client.get(ARCHIVE).json()["work"]["comments"] == "success"


def test_first_unknown_dynamic_count_stays_unknown_not_local_or_zero(tmp_path):
    state = {"unknown_count": True}
    with archive_client(tmp_path / "unknown-count.sqlite", source_handler(state)) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        saved = client.get(ARCHIVE).json()
        assert saved["source_comment_count"] is None
        assert saved["synced_root_comment_count"] is None
        assert saved["local_comment_count"] == 2
        assert saved["work"]["comments"] == "success"  # 只证明根页，不证明来源计数观察成功。


def test_transient_empty_tail_is_not_premature_completion(tmp_path):
    state = {"roots": forty_five_roots()}
    normal = source_handler(state)
    empty_once = False
    def handler(request):
        nonlocal empty_once
        response = normal(request)
        if request.url.path == "/x/v2/reply" and request.url.params["pn"] == "2" and not empty_once:
            empty_once = True
            payload = response.json()
            payload["data"]["replies"] = None
            return httpx.Response(200, json=payload)
        return response
    with archive_client(tmp_path / "transient.sqlite", handler) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": UID})
        saved = client.get(ARCHIVE).json()
        assert saved["work"]["comments"] == "pending"
        assert saved["synced_root_comment_count"] is None
        assert saved["local_comment_count"] == 40  # 复查已取得的下一页也保留，不伪造本轮成功。
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get(ARCHIVE).json()["local_comment_count"] == 45
        assert client.get(ARCHIVE).json()["work"]["comments"] == "success"
