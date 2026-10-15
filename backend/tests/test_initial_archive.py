"""02 / T2-T3：公开 HTTP、真实 SQLite 重开，仅替换上游 transport。"""

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from threading import Event

import anyio
import httpx
import pytest

from backend.tests.archive_support import (
    BASE, UID, TARGETS, archive_client, archive_content, author_html, detail_json, readable_html, set_specified,
    NULL_COMMENT_STATUS,
)


def test_empty_targets_and_idempotent_delete_survive_reopen(tmp_path):
    path = tmp_path / "archive.sqlite"
    with archive_client(path) as client:
        assert client.post(BASE, json={"uid": UID}).status_code == 201
        response = client.get(TARGETS)
        assert response.status_code == 200
        assert response.json() == {"targets": []}
        assert client.delete(TARGETS + "/123").status_code == 204
    with archive_client(path) as client:
        assert client.get(TARGETS).json() == {"targets": []}
        assert client.get("/api/not-found?cursor=unknown").status_code == 404
        assert client.get(f"{BASE}/{UID}").json()["name"] == "虚构星海"
        assert client.get(f"{BASE}/202/targets").status_code == 404


def test_verified_target_persists_and_duplicate_is_idempotent(tmp_path):
    calls = 0
    def handler(request):
        nonlocal calls
        calls += 1
        assert request.url == "https://www.bilibili.com/opus/123"
        return httpx.Response(200, text=author_html())

    path = tmp_path / "archive.sqlite"
    with archive_client(path, handler) as client:
        client.post(BASE, json={"uid": UID})
        for _ in range(2):
            response = client.post(TARGETS, json={"id": "123"})
            assert response.status_code == 201
            assert response.json() == {"id": "123"}
        assert client.get(TARGETS).json() == {"targets": [{"id": "123"}]}
        assert calls == 2  # 重复提交仍重新验证归属，不将已存在伪装为本次验证成功。
    with archive_client(path) as client:
        assert client.get(TARGETS).json() == {"targets": [{"id": "123"}]}
        assert client.delete(TARGETS + "/123").status_code == 204
        assert client.get(TARGETS).json() == {"targets": []}


@pytest.mark.parametrize("html,status,code,message", [
    (author_html().replace(UID, "202"), 409, "TARGET_AUTHOR_MISMATCH", "动态作者与所选 UP 不符"),
    (author_html().replace('"mid":"' + UID + '"', '"mid":null'), 502, "TARGET_UNVERIFIED", "无法确认动态归属"),
    ("<script>window.__INITIAL_STATE__ = evil(FICTIONAL_SECRET);</script>", 502, "TARGET_UNVERIFIED", "无法确认动态归属"),
    (author_html().replace('"id_str":"123"', '"id_str":"456"'), 502, "TARGET_UNVERIFIED", "无法确认动态归属"),
])
def test_unverified_or_mismatched_author_never_associates(tmp_path, caplog, html, status, code, message):
    path = tmp_path / "archive.sqlite"
    with archive_client(path, lambda request: httpx.Response(200, text=html)) as client:
        client.post(BASE, json={"uid": UID})
        response = client.post(TARGETS, json={"id": "123"})
        assert response.status_code == status
        assert response.json() == {"error": {"code": code, "message": message}}
        assert "FICTIONAL_SECRET" not in response.text + caplog.text
        assert client.get(TARGETS).json() == {"targets": []}
    with archive_client(path) as client:
        assert client.get(TARGETS).json() == {"targets": []}


def test_initial_entry_skips_recent_disabled_or_deleted_and_read_is_local(tmp_path):
    path = tmp_path / "archive.sqlite"
    with archive_client(path) as client:
        client.post(BASE, json={"uid": UID})
        response = client.post("/api/sync/initial", json={"uid": UID})
        assert response.status_code == 200
        assert response.json() == {"processed": 0, "succeeded": 0, "failed": 0}
        assert client.get("/api/archive/dynamics").json() == {"items": [], "next_cursor": None}
        assert client.get("/api/archive/dynamics/123").status_code == 404
        assert client.post("/api/sync/initial", json={"uid": "202"}).status_code == 404


def test_failed_initial_attempt_is_persisted_retryable_and_local_reads_survive_lifecycle(tmp_path, caplog):
    state = {"fail": False}

    def handler(request):
        if state["fail"]:
            raise httpx.ReadError("FICTIONAL_SECRET_UPSTREAM")
        return httpx.Response(200, text=author_html())

    path = tmp_path / "archive.sqlite"
    with archive_client(path, handler) as client:
        client.post(BASE, json={"uid": UID})
        client.post(TARGETS, json={"id": "123"})
        set_specified(client)
        state["fail"] = True
        response = client.post("/api/sync/initial", json={"uid": UID})
        assert response.json() == {"processed": 1, "succeeded": 0, "failed": 1}
        detail = client.get("/api/archive/dynamics/123")
        assert detail.status_code == 200
        saved = detail.json()
        assert saved["author"]["id"] == UID
        assert saved["published_at"] is None
        assert saved["edited_at"] is None
        assert saved["content_state"] == saved["last_attempt"] == "failed"
        assert saved["source_comment_count"] is None
        assert saved["work"] == {"text": "pending", "media": "pending", "comments": "pending", "replies": "pending"}
        assert "FICTIONAL_SECRET" not in response.text + detail.text + caplog.text
        set_specified(client, enabled=False)
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["processed"] == 0
        client.delete(TARGETS + "/123")
        client.delete(f"{BASE}/{UID}/monitor")
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["processed"] == 0
    with archive_client(path) as client:
        current = client.get("/api/archive/dynamics/123").json()
        assert current["comment_sync"] is None
        assert archive_content(current) == archive_content(saved)
        assert client.get("/api/archive/dynamics").json() == {"items": [archive_content(saved)], "next_cursor": None}


def test_page_metadata_is_saved_even_when_body_unavailable_and_invalid_edits_do_not_erase_it(tmp_path):
    state = {"html": author_html()}
    path = tmp_path / "archive.sqlite"
    with archive_client(path, lambda request: httpx.Response(200, text=state["html"])) as client:
        client.post(BASE, json={"uid": UID})
        client.post(TARGETS, json={"id": "123"})
        set_specified(client)
        assert client.post("/api/sync/initial", json={"uid": UID}).json() == {"processed": 1, "succeeded": 0, "failed": 1}
        saved = client.get("/api/archive/dynamics/123").json()
        assert saved["published_at"] == "2026-10-09T10:38:16+08:00"
        assert saved["edited_at"] == saved["observed_version"] == "2026-10-09T13:01+08:00"
        assert saved["edit_status"] == "observed"
        assert saved["source_comment_count"] == 7
        assert saved["synced_version"] is None
        state["html"] = author_html().replace("2026年10月09日 13:01", "2026年02月31日 13:01").replace('"count":7', '"count":"FICTIONAL_SECRET"')
        client.post("/api/sync/initial", json={"uid": UID})
        saved = client.get("/api/archive/dynamics/123").json()
        assert saved["edit_status"] == "error"
        assert saved["edited_at"] == saved["observed_version"] == "2026-10-09T13:01+08:00"
        assert saved["source_comment_count"] == 7


def test_archive_pages_are_sorted_snapshot_bound_and_replay_after_reopen(tmp_path):
    def handler(request):
        id = request.url.path.rsplit("/", 1)[-1]
        html = author_html().replace('"id_str":"123"', f'"id_str":"{id}"')
        if id == "9":
            html = html.replace('"pub_ts":1791513496', '"pub_ts":null')
        elif id == "8":
            html = html.replace('"pub_ts":1791513496', '"pub_ts":1791600000')
        return httpx.Response(200, text=html)

    path = tmp_path / "archive.sqlite"
    with archive_client(path, handler) as client:
        client.post(BASE, json={"uid": UID})
        set_specified(client)
        for id in ("9", "2", "10", "8"):
            assert client.post(TARGETS, json={"id": id}).status_code == 201
        client.post("/api/sync/initial", json={"uid": UID})
        first = client.get("/api/archive/dynamics?limit=2").json()
        assert [item["id"] for item in first["items"]] == ["8", "10"]
        cursor = first["next_cursor"]
        assert isinstance(cursor, str)
        second = client.get("/api/archive/dynamics", params={"limit": 2, "cursor": cursor}).json()
        assert [item["id"] for item in second["items"]] == ["2", "9"]
        assert second["next_cursor"] is None
        # 将新档案插入同一排序区间，旧读取范围不重不漏，也不变正文快照。
        client.post(TARGETS, json={"id": "1"})
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get("/api/archive/dynamics", params={"limit": 2, "cursor": cursor}).json() == second
        assert client.get("/api/archive/dynamics", params={"limit": 1, "cursor": cursor}).status_code == 422
        assert client.get("/api/archive/dynamics", params={"cursor": "FICTIONAL_SECRET"}).status_code == 422
    with archive_client(path) as client:
        assert client.get("/api/archive/dynamics", params={"limit": 2, "cursor": cursor}).json() == second
        assert client.get("/api/archive/dynamics?limit=11").status_code == 422


def test_readable_full_page_archives_metadata_media_locator_and_version_idempotently(tmp_path):
    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.host == "www.bilibili.com":
            return httpx.Response(200, text=readable_html())
        assert request.url.path == "/x/polymer/web-dynamic/v1/detail"
        assert request.url.params["id"] == "123"
        return httpx.Response(200, json=detail_json())

    path = tmp_path / "archive.sqlite"
    with archive_client(path, handler) as client:
        client.post(BASE, json={"uid": UID})
        client.post(TARGETS, json={"id": "123"})
        set_specified(client)
        assert client.post("/api/sync/initial", json={"uid": UID}).json() == {"processed": 1, "succeeded": 1, "failed": 0}
        saved = client.get("/api/archive/dynamics/123").json()
        media_fields = {"media", "previous_media", "media_version", "synced_media_version", "media_last_attempt"}
        assert datetime.fromisoformat(saved["text_last_succeeded_at"]).utcoffset() is not None
        assert {key: value for key, value in archive_content(saved).items()
                if key not in media_fields | {"text_last_succeeded_at"}} == {
            "id": "123", "author": {"id": UID, "nickname": "虚构星海", "avatar_url": "https://example.invalid/avatar.png"},
            "published_at": "2026-10-09T10:38:16+08:00", "edited_at": "2026-10-09T13:01+08:00", "edit_status": "observed",
            "title": None, "text": "虚构全文\n第二行 <b>仍是文本</b> 🙂", "content_state": "success", "last_attempt": "success",
            "source_comment_count": 7, "local_comment_count": 0, "local_reply_count": 0,
            "root_comments_last_attempt": "failed", "synced_root_comment_count": None,
            "comments_last_attempt": "failed", "replies_last_attempt": "unconfirmed",
            **NULL_COMMENT_STATUS, "root_comments_error": "ROOT_COMMENTS_FAILED",
            "comments_error": "ROOT_COMMENTS_FAILED",
            "synced_comment_count": None, "synced_reply_comment_count": None,
            "media_sources": [{"url": "https://example.invalid/first.png", "width": 640, "height": 480},
                              {"url": "https://example.invalid/second.png", "width": 200, "height": 1200}],
            "comment_locator": {"oid": "99123", "type": 17},
            "observed_version": "2026-10-09T13:01+08:00", "synced_version": "2026-10-09T13:01+08:00",
            "work": {"text": "success", "media": "pending", "comments": "pending", "replies": "pending"},
        }
        before = list(calls)
        assert client.get("/api/archive/dynamics").json()["items"] == [archive_content(saved)]
        assert calls == before
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get("/api/archive/dynamics/123").json() == saved
    with archive_client(path) as client:
        assert client.get("/api/archive/dynamics/123").json() == saved


@pytest.mark.parametrize("newer_fails", [False, True])
def test_old_completion_cannot_claim_newer_observation_or_clear_pending_work(tmp_path, newer_fails):
    reached, release = Event(), Event()
    state = {"phase": "baseline"}

    async def handler(request):
        phase = state["phase"]
        if request.url.host == "www.bilibili.com":
            html = author_html() if phase == "newer" and newer_fails else readable_html(phase)
            minute = {"baseline": "13:01", "older": "13:02", "newer": "13:03"}[phase]
            return httpx.Response(200, text=html.replace("13:01", minute))
        if phase == "older":
            reached.set()
            await anyio.to_thread.run_sync(lambda: release.wait(10))
        if phase == "newer" and newer_fails:
            return httpx.Response(503, text="FICTIONAL_SECRET_FAILURE")
        return httpx.Response(200, json=detail_json())

    path = tmp_path / "archive.sqlite"
    with archive_client(path, handler) as old_client, archive_client(path, handler) as new_client:
        old_client.post(BASE, json={"uid": UID})
        old_client.post(TARGETS, json={"id": "123"})
        set_specified(old_client)
        old_client.post("/api/sync/initial", json={"uid": UID})
        state["phase"] = "older"
        with ThreadPoolExecutor() as pool:
            older = pool.submit(old_client.post, "/api/sync/initial", json={"uid": UID})
            try:
                assert reached.wait(5)
                # 上游延迟时管理与读取正常；网络不持有数据库长事务。
                assert new_client.get(TARGETS).status_code == 200
                intermediate = new_client.get("/api/archive/dynamics/123").json()
                assert intermediate["observed_version"] == "2026-10-09T13:02+08:00"
                assert intermediate["synced_version"] == "2026-10-09T13:01+08:00"
                assert intermediate["work"]["text"] == "pending"
                state["phase"] = "newer"
                new_client.post("/api/sync/initial", json={"uid": UID})
            finally:
                release.set()
            assert older.result().json() == {"processed": 1, "succeeded": 0, "failed": 1}
        saved = new_client.get("/api/archive/dynamics/123").json()
        assert saved["observed_version"] == "2026-10-09T13:03+08:00"
        assert saved["synced_version"] == ("2026-10-09T13:01+08:00" if newer_fails else "2026-10-09T13:03+08:00")
        assert saved["text"] == ("baseline" if newer_fails else "newer")
        assert saved["work"]["text"] == ("pending" if newer_fails else "success")
    with archive_client(path) as client:
        assert client.get("/api/archive/dynamics/123").json() == saved


def test_failed_html_keeps_independent_json_metadata_without_using_summary_as_body(tmp_path):
    state = {"fail_html": False}

    def handler(request):
        if request.url.host == "www.bilibili.com":
            if state["fail_html"]:
                return httpx.Response(200, text="<script>window.__INITIAL_STATE__=evil('FICTIONAL_SECRET');</script>")
            return httpx.Response(200, text=author_html())
        return httpx.Response(200, json=detail_json())

    path = tmp_path / "archive.sqlite"
    with archive_client(path, handler) as client:
        client.post(BASE, json={"uid": UID})
        client.post(TARGETS, json={"id": "123"})
        set_specified(client)
        state["fail_html"] = True
        assert client.post("/api/sync/initial", json={"uid": UID}).json() == {"processed": 1, "succeeded": 0, "failed": 1}
        saved = client.get("/api/archive/dynamics/123").json()
        assert saved["content_state"] == "failed"
        assert saved["text"] == ""
        assert saved["published_at"] == "2026-10-09T10:38:16+08:00"
        assert saved["edited_at"] is None
        assert saved["edit_status"] == "error"
        assert saved["source_comment_count"] == 7
        assert saved["comment_locator"] == {"oid": "99123", "type": 17}
        assert saved["media_sources"] == [{"url": "https://example.invalid/first.png", "width": 640, "height": 480}]
        assert "FICTIONAL_SECRET" not in str(saved)


def test_word_and_rich_nodes_are_plain_text_not_executable_or_links(tmp_path):
    state = {"html": author_html()}
    paragraph = {"para_type": 1, "text": {"nodes": [
        {"type": "TEXT_NODE_TYPE_WORD", "word": {"words": "文字 🙂 "}},
        {"type": "TEXT_NODE_TYPE_RICH", "rich": {"type": "RICH_TEXT_NODE_TYPE_AT", "text": "@虚构用户 "}},
        {"type": "TEXT_NODE_TYPE_RICH", "rich": {"type": "RICH_TEXT_NODE_TYPE_WEB", "text": "https://example.invalid/?x=<img>"}},
    ]}}
    content = {"module_type": "MODULE_TYPE_CONTENT", "module_content": {"paragraphs": [paragraph]}}
    path = tmp_path / "archive.sqlite"
    with archive_client(path, lambda request: httpx.Response(200, text=state["html"]) if request.url.host == "www.bilibili.com" else httpx.Response(200, json=detail_json())) as client:
        client.post(BASE, json={"uid": UID})
        client.post(TARGETS, json={"id": "123"})
        set_specified(client)
        state["html"] = author_html().replace('"modules":[', '"modules":[' + json.dumps(content, ensure_ascii=False) + ',')
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["succeeded"] == 1
        assert client.get("/api/archive/dynamics/123").json()["text"] == "文字 🙂 @虚构用户 https://example.invalid/?x=<img>"


def initial_cases():
    return json.loads((Path(__file__).parent / "fixtures/initial-cases.json").read_text())


def test_json_normal_empty_restricted_and_failed_initialization_survives_reopen(tmp_path, caplog):
    cases = initial_cases()
    responses = dict(zip(("101", "102", "103", "104"), cases.values()))

    def handler(request):
        if request.url.host == "www.bilibili.com":
            id = request.url.path.rsplit("/", 1)[-1]
            if id == "101":
                html = readable_html("正文\n<b>普通文本</b> 🙂", id=id, title="虚构标题",
                    pictures=[{"url": "https://example.invalid/one.png", "width": 640, "height": 480}])
            elif id == "102":
                html = readable_html(None, id=id, pictures=[])
            else:
                html = author_html().replace('"id_str":"123"', f'"id_str":"{id}"')
            return httpx.Response(200, text=html)
        return httpx.Response(200, json=responses[request.url.params["id"]])

    path = tmp_path / "archive.sqlite"
    with archive_client(path, handler) as client:
        client.post(BASE, json={"uid": UID})
        set_specified(client)
        for id in responses:
            assert client.post(TARGETS, json={"id": id}).status_code == 201
        assert client.post("/api/sync/initial", json={"uid": UID}).json() == {"processed": 4, "succeeded": 2, "failed": 2}
        saved = {id: client.get(f"/api/archive/dynamics/{id}").json() for id in responses}
        assert saved["101"]["title"] == "虚构标题"
        assert saved["101"]["text"] == "正文\n<b>普通文本</b> 🙂"
        assert saved["101"]["media_sources"] == [{"url": "https://example.invalid/one.png", "width": 640, "height": 480}]
        assert saved["101"]["comment_locator"] == {"oid": "99101", "type": 17}
        assert saved["101"]["author"] == {"id": UID, "nickname": "虚构作者", "avatar_url": "https://example.invalid/author.png"}
        assert saved["102"]["text"] == ""
        assert saved["102"]["content_state"] == "success"
        assert saved["103"]["text"] == ""
        assert saved["103"]["content_state"] == saved["103"]["last_attempt"] == "restricted"
        assert saved["103"]["work"]["text"] == "pending"
        assert saved["103"]["synced_version"] is None
        assert saved["104"]["content_state"] == "failed"
        assert saved["104"]["work"]["text"] == "pending"
        assert "FICTIONAL_SECRET" not in str(saved) + caplog.text
    with archive_client(path) as client:
        for id, document in saved.items():
            assert client.get(f"/api/archive/dynamics/{id}").json() == document


def test_draw_rich_text_and_ordered_media_without_edit_or_publication_signal(tmp_path):
    payload = initial_cases()["normal"]
    item = payload["data"]["item"]
    item["id_str"] = "123"
    item["modules"]["module_author"].pop("pub_ts")
    item["modules"]["module_dynamic"]["major"] = {
        "type": "MAJOR_TYPE_DRAW", "draw": {
            "summary": {"rich_text_nodes": [{"text": "第一行\n"}, {"text": "@虚构用户 🙂"}]},
            "items": [{"src": "https://example.invalid/a.png", "width": 12, "height": 30},
                      {"src": "https://example.invalid/b.png", "width": "invalid"}],
        },
    }
    html = readable_html("第一行\n@虚构用户 🙂", pictures=[
        {"url": "https://example.invalid/a.png", "width": 12, "height": 30},
        {"url": "https://example.invalid/b.png", "width": None, "height": None},
    ]).replace('"pub_ts":1791513496', '"pub_ts":null').replace("编辑于 2026年10月09日 13:01", "刚刚")
    path = tmp_path / "archive.sqlite"
    with archive_client(path, lambda request: httpx.Response(200, text=html) if request.url.host == "www.bilibili.com" else httpx.Response(200, json=payload)) as client:
        client.post(BASE, json={"uid": UID})
        client.post(TARGETS, json={"id": "123"})
        set_specified(client)
        assert client.post("/api/sync/initial", json={"uid": UID}).json() == {"processed": 1, "succeeded": 1, "failed": 0}
        saved = client.get("/api/archive/dynamics/123").json()
        assert saved["text"] == "第一行\n@虚构用户 🙂"
        assert saved["published_at"] is saved["edited_at"] is saved["observed_version"] is saved["synced_version"] is None
        assert saved["edit_status"] == "unknown"
        assert saved["media_sources"] == [{"url": "https://example.invalid/a.png", "width": 12, "height": 30},
                                         {"url": "https://example.invalid/b.png", "width": None, "height": None}]
        assert saved["work"] == {"text": "success", "media": "pending", "comments": "pending", "replies": "pending"}
    with archive_client(path) as client:
        assert client.get("/api/archive/dynamics/123").json() == saved


def test_optional_json_metadata_failures_do_not_block_body_or_erase_trusted_identity(tmp_path):
    state = {"html": readable_html("可信页面正文", pictures=[]), "payload": detail_json()}

    def handler(request):
        return httpx.Response(200, text=state["html"]) if request.url.host == "www.bilibili.com" else httpx.Response(200, json=state["payload"])

    path = tmp_path / "archive.sqlite"
    with archive_client(path, handler) as client:
        client.post(BASE, json={"uid": UID})
        client.post(TARGETS, json={"id": "123"})
        set_specified(client)
        client.post("/api/sync/initial", json={"uid": UID})
        before = client.get("/api/archive/dynamics/123").json()
        state["html"] = readable_html("可信页面正文", pictures=[]).replace(
            "编辑于 2026年10月09日 13:01", "编辑于 2026年02月31日 13:01"
        )
        item = state["payload"]["data"]["item"]
        item["basic"] = None
        item["modules"]["module_stat"] = {"comment": None}
        item["modules"]["module_author"] = {"mid": UID, "name": None, "face": "javascript:invalid", "pub_ts": None}
        assert client.post("/api/sync/initial", json={"uid": UID}).json() == {"processed": 1, "succeeded": 1, "failed": 0}
        saved = client.get("/api/archive/dynamics/123").json()
        assert saved["author"] == before["author"]
        assert saved["published_at"] == before["published_at"]
        assert saved["source_comment_count"] == 7
        assert saved["comment_locator"] == before["comment_locator"]
        assert saved["edit_status"] == "error"
        assert saved["edited_at"] == saved["observed_version"] == saved["synced_version"] == before["synced_version"]
        assert saved["text"] == before["text"]
    with archive_client(path) as client:
        assert client.get("/api/archive/dynamics/123").json() == saved


def test_body_failure_keeps_parsed_metadata_and_newer_unknown_version_stays_pending(tmp_path):
    state = {"html": readable_html("baseline", pictures=[]), "payload": detail_json()}
    item = state["payload"]["data"]["item"]
    path = tmp_path / "archive.sqlite"
    with archive_client(path, lambda request: httpx.Response(200, text=state["html"]) if request.url.host == "www.bilibili.com" else httpx.Response(200, json=state["payload"])) as client:
        client.post(BASE, json={"uid": UID})
        client.post(TARGETS, json={"id": "123"})
        set_specified(client)
        client.post("/api/sync/initial", json={"uid": UID})
        baseline = client.get("/api/archive/dynamics/123").json()
        state["html"] = author_html().replace("13:01", "13:02")
        item["modules"]["module_dynamic"]["major"]["opus"]["summary"] = None
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["failed"] == 1
        pending = client.get("/api/archive/dynamics/123").json()
        assert pending["text"] == baseline["text"]
        assert pending["content_state"] == "success"
        assert pending["last_attempt"] == "failed"
        assert pending["observed_version"] == "2026-10-09T13:02+08:00"
        assert pending["synced_version"] == baseline["synced_version"]
        state["html"] = readable_html("unknown newer body", pictures=[]).replace(
            "2026年10月09日 13:01", "编辑时间未知"
        )
        item["modules"]["module_dynamic"]["major"]["opus"]["summary"] = {"text": "摘要不能作为正文"}
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["failed"] == 1
        saved = client.get("/api/archive/dynamics/123").json()
        # #24：无可信实际版本的重试不能替换旧成功正文或冒领 checkpoint。
        assert saved["text"] == baseline["text"]
        assert saved["last_attempt"] == "failed"
        assert saved["observed_version"] == pending["observed_version"]
        assert saved["synced_version"] == baseline["synced_version"]
        assert saved["work"]["text"] == "pending"
    with archive_client(path) as client:
        assert client.get("/api/archive/dynamics/123").json() == saved


def test_invalid_body_and_counter_do_not_discard_other_parsed_metadata(tmp_path):
    payload = detail_json()
    payload["data"]["item"]["modules"]["module_dynamic"]["major"]["opus"]["summary"] = None
    html = author_html().replace('"comment":{"count":7}', '"comment":null')
    path = tmp_path / "archive.sqlite"
    with archive_client(path, lambda request: httpx.Response(200, text=html) if request.url.host == "www.bilibili.com" else httpx.Response(200, json=payload)) as client:
        client.post(BASE, json={"uid": UID})
        client.post(TARGETS, json={"id": "123"})
        set_specified(client)
        assert client.post("/api/sync/initial", json={"uid": UID}).json() == {"processed": 1, "succeeded": 0, "failed": 1}
        saved = client.get("/api/archive/dynamics/123").json()
        assert saved["content_state"] == "failed"
        assert saved["edited_at"] == saved["observed_version"] == "2026-10-09T13:01+08:00"
        assert saved["edit_status"] == "observed"
        assert saved["source_comment_count"] == 7
        assert saved["media_sources"] == [{"url": "https://example.invalid/first.png", "width": 640, "height": 480}]
        assert saved["comment_locator"] == {"oid": "99123", "type": 17}


def test_cursor_rejects_forgery_and_cross_resource_or_unsupported_scope(tmp_path):
    path = tmp_path / "archive.sqlite"
    with archive_client(path, lambda request: httpx.Response(200, text=author_html().replace('"id_str":"123"', '"id_str":"' + request.url.path.rsplit('/', 1)[-1] + '"'))) as client:
        client.post(BASE, json={"uid": UID})
        set_specified(client)
        for id in ("123", "124"):
            client.post(TARGETS, json={"id": id})
        client.post("/api/sync/initial", json={"uid": UID})
        cursor = client.get("/api/archive/dynamics?limit=1").json()["next_cursor"]
        assert client.get("/api/archive/dynamics", params={"limit": 1, "cursor": "0" * 32}).status_code == 422
        assert client.get("/api/archive/dynamics/123", params={"cursor": cursor}).status_code == 422
        assert client.get("/api/archive/dynamics", params={"limit": 1, "cursor": cursor, "uid": UID}).status_code == 422
        assert client.get("/api/archive/dynamics", params={"limit": 1, "cursor": cursor, "resource": "comments"}).status_code == 422
        assert client.get("/api/archive/dynamics", params={"limit": 1, "cursor": cursor, "sort": "latest"}).status_code == 422
        assert client.get(f"{BASE}/{UID}/targets", params={"cursor": cursor}).status_code == 422
        assert client.get(BASE, params={"cursor": cursor}).status_code == 422
        assert client.get(f"{BASE}/{UID}", params={"cursor": cursor}).status_code == 422
        assert client.get("/api/archive/dynamics", params={"limit": 1, "cursor": cursor}).status_code == 200


def test_twenty_five_global_archives_keep_content_snapshot_during_reordering_and_reopen(tmp_path):
    state = {"updated": False}
    ownership = {str(id): UID if id % 2 else "202" for id in range(101, 126)}

    def handler(request):
        id = request.url.path.rsplit("/", 1)[-1] if request.url.host == "www.bilibili.com" else request.url.params["id"]
        uid = ownership[id]
        changed = state["updated"] and id in ("101", "125")
        published = (1791700000 if id == "125" else 1791699999) if changed else (None if id == "125" else 1791513497 if id == "124" else 1791513496)
        if request.url.host == "www.bilibili.com":
            html = readable_html(("新正文 " if changed else "旧正文 ") + id, id=id, pictures=[]).replace(UID, uid)
            html = html.replace('"pub_ts":1791513496', '"pub_ts":' + (str(published) if published is not None else 'null'))
            return httpx.Response(200, text=html.replace("13:01", "13:02") if changed else html)
        payload = detail_json()
        item = payload["data"]["item"]
        item["id_str"] = id
        item["modules"]["module_author"].update(mid=uid, pub_ts=published)
        item["modules"]["module_dynamic"]["major"]["opus"]["summary"] = {"text": ("新正文 " if changed else "旧正文 ") + id}
        return httpx.Response(200, json=payload)

    path = tmp_path / "archive.sqlite"
    expected = ["124", "101", "102", "103", "104", "105", "106", "107", "108", "109",
                "110", "111", "112", "113", "114", "115", "116", "117", "118", "119",
                "120", "121", "122", "123", "125"]
    with archive_client(path, handler) as client:
        for uid in (UID, "202"):
            client.post(BASE, json={"uid": uid})
            client.patch(f"{BASE}/{uid}/monitor", json={"mode": "specified", "recent_n": 10, "enabled": True})
        for id, uid in ownership.items():
            assert client.post(f"{BASE}/{uid}/targets", json={"id": id}).status_code == 201
        for uid in (UID, "202"):
            assert client.post("/api/sync/initial", json={"uid": uid}).json()["failed"] == 0
        first = client.get("/api/archive/dynamics").json()
        assert [item["id"] for item in first["items"]] == expected[:10]
        state["updated"] = True
        for uid in (UID, "202"):
            client.post("/api/sync/initial", json={"uid": uid})
        second = client.get("/api/archive/dynamics", params={"cursor": first["next_cursor"]}).json()
        assert [item["id"] for item in second["items"]] == expected[10:20]
        assert [item["id"] for item in client.get("/api/archive/dynamics").json()["items"]][:3] == ["125", "101", "124"]
        assert client.get("/api/archive/dynamics/125").json()["text"] == "新正文 125"
    with archive_client(path) as client:
        third = client.get("/api/archive/dynamics", params={"cursor": second["next_cursor"]}).json()
        assert [item["id"] for item in third["items"]] == expected[20:]
        assert third["next_cursor"] is None
        assert third["items"][-1]["text"] == "旧正文 125"
        assert third["items"][-1]["published_at"] is None
        assert client.get("/api/archive/dynamics", params={"cursor": second["next_cursor"]}).json() == third
        assert [item["id"] for item in first["items"] + second["items"] + third["items"]] == expected


def test_author_verification_uses_valid_json_when_html_is_unavailable(tmp_path):
    def handler(request):
        if request.url.host == "www.bilibili.com":
            return httpx.Response(503, text="FICTIONAL_SECRET_PAGE_FAILURE")
        id = request.url.params["id"]
        if id == "125":
            return httpx.Response(200, json={"code": -1})
        payload = detail_json()
        payload["data"]["item"]["id_str"] = id
        if id == "124":
            payload["data"]["item"]["modules"]["module_author"]["mid"] = "202"
        return httpx.Response(200, json=payload)

    path = tmp_path / "archive.sqlite"
    with archive_client(path, handler) as client:
        client.post(BASE, json={"uid": UID})
        assert client.post(TARGETS, json={"id": "123"}).status_code == 201
        assert client.post(TARGETS, json={"id": "124"}).json()["error"]["code"] == "TARGET_AUTHOR_MISMATCH"
        assert client.post(TARGETS, json={"id": "125"}).json()["error"]["code"] == "TARGET_UNVERIFIED"
        assert client.get(TARGETS).json() == {"targets": [{"id": "123"}]}
    with archive_client(path) as client:
        assert client.get(TARGETS).json() == {"targets": [{"id": "123"}]}


def test_draw_images_without_summary_are_readable_without_inventing_text(tmp_path):
    payload = detail_json()
    payload["data"]["item"]["modules"]["module_dynamic"]["major"] = {
        "type": "MAJOR_TYPE_DRAW", "draw": {"items": [{"src": "https://example.invalid/draw.png", "width": 300, "height": 900}]},
    }
    html = readable_html(None, pictures=[{"url": "https://example.invalid/draw.png", "width": 300, "height": 900}])
    path = tmp_path / "archive.sqlite"
    with archive_client(path, lambda request: httpx.Response(200, text=html) if request.url.host == "www.bilibili.com" else httpx.Response(200, json=payload)) as client:
        client.post(BASE, json={"uid": UID})
        client.post(TARGETS, json={"id": "123"})
        set_specified(client)
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["succeeded"] == 1
        saved = client.get("/api/archive/dynamics/123").json()
        assert saved["text"] == ""
        assert saved["content_state"] == "success"
        assert saved["media_sources"] == [{"url": "https://example.invalid/draw.png", "width": 300, "height": 900}]


def test_page_identity_fills_missing_json_author_fields_without_using_edit_as_publication(tmp_path):
    payload = detail_json()
    payload["data"]["item"]["modules"]["module_author"] = {"mid": UID, "pub_time": "编辑于 2099年01月01日 00:00"}
    html = readable_html("身份页的完整正文", pictures=[]).replace('"pub_ts":1791513496', '"pub_ts":null').replace("虚构星海", "虚构页面作者").replace("avatar.png", "page-avatar.png")
    path = tmp_path / "archive.sqlite"
    with archive_client(path, lambda request: httpx.Response(200, text=html) if request.url.host == "www.bilibili.com" else httpx.Response(200, json=payload)) as client:
        client.post(BASE, json={"uid": UID})
        client.post(TARGETS, json={"id": "123"})
        set_specified(client)
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["succeeded"] == 1
        saved = client.get("/api/archive/dynamics/123").json()
        assert saved["author"] == {"id": UID, "nickname": "虚构页面作者", "avatar_url": "https://example.invalid/page-avatar.png"}
        assert saved["published_at"] is None
        assert saved["edited_at"] == "2026-10-09T13:01+08:00"
        assert saved["synced_version"] == saved["observed_version"] == saved["edited_at"]


def test_only_trusted_html_edit_changes_text_version_not_relative_time_or_content_differences(tmp_path):
    state = {"display": "刚刚", "text": "首次正文"}

    def handler(request):
        if request.url.host == "www.bilibili.com":
            html = readable_html(state["text"] + " 🙂", pictures=[])
            return httpx.Response(200, text=html.replace("编辑于 2026年10月09日 13:01", state["display"]))
        payload = detail_json()
        payload["data"]["item"]["modules"]["module_author"]["pub_time"] = "编辑于 2099年01月01日 00:00"
        payload["data"]["item"]["modules"]["module_dynamic"]["major"]["opus"]["summary"] = {"rich_text_nodes": [{"text": state["text"]}, {"text": " 🙂"}]}
        return httpx.Response(200, json=payload)

    path = tmp_path / "archive.sqlite"
    with archive_client(path, handler) as client:
        client.post(BASE, json={"uid": UID})
        client.post(TARGETS, json={"id": "123"})
        set_specified(client)
        client.post("/api/sync/initial", json={"uid": UID})
        saved = client.get("/api/archive/dynamics/123").json()
        assert saved["text"] == "首次正文 🙂"
        assert saved["observed_version"] is saved["synced_version"] is None
        state.update(display="一分钟前", text="仅内容不同")
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get("/api/archive/dynamics/123").json()["text"] == "首次正文 🙂"
        state.update(display="编辑于 2026年10月09日 13:01", text="编辑后正文")
        client.post("/api/sync/initial", json={"uid": UID})
        saved = client.get("/api/archive/dynamics/123").json()
        assert saved["text"] == "编辑后正文 🙂"
        assert saved["synced_version"] == saved["observed_version"] == "2026-10-09T13:01+08:00"
        state.update(display="编辑于\u00a0 2026年10月09日   13:01", text="同分钟不同正文")
        client.post("/api/sync/initial", json={"uid": UID})
        assert client.get("/api/archive/dynamics/123").json() == saved
        state.update(display="编辑于 2026年10月09日 13:02", text="下一版本正文")
        client.post("/api/sync/initial", json={"uid": UID})
        newer = client.get("/api/archive/dynamics/123").json()
        assert newer["text"] == "下一版本正文 🙂"
        assert newer["published_at"] == saved["published_at"]
        assert newer["synced_version"] == newer["observed_version"] == "2026-10-09T13:02+08:00"
    with archive_client(path) as client:
        assert client.get("/api/archive/dynamics/123").json() == newer


def test_successful_archive_is_retained_after_read_failure_and_target_or_config_removal(tmp_path):
    state = {"fail": False}

    def handler(request):
        if state["fail"]:
            raise httpx.ReadError("FICTIONAL_SECRET")
        return httpx.Response(200, text=readable_html("保留的成功正文", pictures=[])) if request.url.host == "www.bilibili.com" else httpx.Response(200, json=detail_json())

    path = tmp_path / "archive.sqlite"
    with archive_client(path, handler) as client:
        client.post(BASE, json={"uid": UID})
        client.post(TARGETS, json={"id": "123"})
        set_specified(client)
        client.post("/api/sync/initial", json={"uid": UID})
        successful = client.get("/api/archive/dynamics/123").json()
        state["fail"] = True
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["failed"] == 1
        saved = client.get("/api/archive/dynamics/123").json()
        for field in ("author", "text", "content_state", "published_at", "edited_at", "source_comment_count", "media_sources", "comment_locator", "observed_version", "synced_version",
                      "root_comments_last_succeeded_at", "replies_last_succeeded_at", "comments_last_succeeded_at"):
            assert saved[field] == successful[field]
        assert saved["last_attempt"] == "failed"
        assert saved["edit_status"] == "error"
        assert saved["work"]["text"] == "pending"
        set_specified(client, enabled=False)
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["processed"] == 0
        assert client.delete(TARGETS + "/123").status_code == 204
        set_specified(client)
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["processed"] == 0
        assert client.delete(f"{BASE}/{UID}/monitor").status_code == 204
    with archive_client(path) as client:
        current = client.get("/api/archive/dynamics/123").json()
        assert current["comment_sync"] is None
        assert archive_content(current) == archive_content(saved)
        assert client.get("/api/archive/dynamics").json() == {"items": [archive_content(saved)], "next_cursor": None}
        assert client.get(f"{BASE}/{UID}").json()["monitor"] is None


def test_same_observed_version_retries_after_failed_body_and_database_reopen(tmp_path):
    path = tmp_path / "archive.sqlite"
    def failed(request):
        return httpx.Response(200, text=author_html()) if request.url.host == "www.bilibili.com" else httpx.Response(503)

    with archive_client(path, failed) as client:
        client.post(BASE, json={"uid": UID})
        client.post(TARGETS, json={"id": "123"})
        set_specified(client)
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["failed"] == 1
        saved = client.get("/api/archive/dynamics/123").json()
        assert saved["observed_version"] == "2026-10-09T13:01+08:00"
        assert saved["synced_version"] is None
        assert saved["work"]["text"] == "pending"
    def readable(request):
        return httpx.Response(200, text=readable_html("可重试正文", pictures=[])) if request.url.host == "www.bilibili.com" else httpx.Response(200, json=detail_json())

    with archive_client(path, readable) as client:
        assert client.get("/api/archive/dynamics/123").json() == saved
        assert client.post("/api/sync/initial", json={"uid": UID}).json() == {"processed": 1, "succeeded": 1, "failed": 0}
        saved = client.get("/api/archive/dynamics/123").json()
        assert saved["text"] == "可重试正文"
        assert saved["synced_version"] == saved["observed_version"] == "2026-10-09T13:01+08:00"
        assert saved["work"] == {"text": "success", "media": "pending", "comments": "pending", "replies": "pending"}


def test_missing_opus_pictures_is_not_successful_empty_media_and_keeps_old_archive(tmp_path):
    state = {"html": readable_html("旧媒体正文"), "payload": detail_json()}
    path = tmp_path / "archive.sqlite"
    with archive_client(path, lambda request: httpx.Response(200, text=state["html"]) if request.url.host == "www.bilibili.com" else httpx.Response(200, json=state["payload"])) as client:
        client.post(BASE, json={"uid": UID})
        client.post(TARGETS, json={"id": "123"})
        set_specified(client)
        client.post("/api/sync/initial", json={"uid": UID})
        before = client.get("/api/archive/dynamics/123").json()
        state["html"] = author_html().replace("13:01", "13:02")
        opus = state["payload"]["data"]["item"]["modules"]["module_dynamic"]["major"]["opus"]
        opus["summary"] = {"text": "新正文但媒体结构缺失"}
        opus.pop("pics")
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["failed"] == 1
        saved = client.get("/api/archive/dynamics/123").json()
        assert saved["text"] == before["text"]
        assert saved["media_sources"] == before["media_sources"]
        assert saved["content_state"] == "success"
        assert saved["synced_version"] == before["synced_version"]
        assert saved["observed_version"] == "2026-10-09T13:02+08:00"
        assert saved["last_attempt"] == "failed"
        assert saved["work"]["text"] == "pending"
