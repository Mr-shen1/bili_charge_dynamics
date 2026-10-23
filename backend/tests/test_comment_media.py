"""21 / T2-T3：根评论原始 JSON→共用下载/模拟 OSS→SQLite→HTTP。"""

import copy
import json
from datetime import datetime, timezone
import multiprocessing
import os
import sqlite3
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import anyio
import httpx
import pytest

from backend.tests.archive_support import UID, TARGETS, archive_content, NULL_COMMENT_STATUS, readable_html, detail_json, set_specified
from backend.tests.root_support import COMMENTS, root_fixture, source_handler
from backend.tests.test_dynamic_media import FakeOSS, PICS, SYNC, media_client, prepare, no_real_oss_environment

ARCHIVE = "/api/archive/dynamics/123"
RETRY = "/api/sync/media/123/comments/123"


def comment_state():
    roots = copy.deepcopy(root_fixture()["data"]["replies"])
    for root, id in zip(roots, ("123", "124")):
        root.update(rpid_str=id, rcount=0)
        root["content"].update(message="", pictures=[
            {"img_src": pic["url"], "img_width": pic["width"], "img_height": pic["height"]}
            for pic in PICS
        ])
    return {"roots": roots}


def roots_by_id(client):
    response = client.get(COMMENTS)
    assert response.status_code == 200
    return {root["id"]: root for root in response.json()["items"]}


def test_root_json_images_are_isolated_ordered_idempotent_and_http_readable(tmp_path):
    path = tmp_path / "comments.sqlite"
    state = comment_state()
    with media_client(path, state, FakeOSS(), source_handler=source_handler(state)) as client:
        prepare(client)
        assert client.post(SYNC, json={"uid": UID}).json()["failed"] == 1  # 正文受限不挡可读根图。
        saved = roots_by_id(client)
        for id, root in saved.items():
            assert root["text"] == ""
            assert root["work"]["media"] == "success"
            assert root["media_last_attempt"] == "success"
            assert len(root["media"]) == 2
            assert [item["position"] for item in root["media"]] == [0, 1]
            assert [item["source_url"] for item in root["media"]] == [pic["url"] for pic in PICS]
            assert [(item["width"], item["height"]) for item in root["media"]] == [(640, 480), (200, 1200)]
            for item in root["media"]:
                assert item["owner"] == {"type": "comment", "id": id}
                assert item["status"] == "success"
                assert item["error"] is None
                assert item["public_url"].startswith(f"https://archive.example.invalid/bili-charge/comments/123/{id}/")
                assert item["public_url"].endswith(".png")
        assert {item["id"] for item in saved["123"]["media"]}.isdisjoint(item["id"] for item in saved["124"]["media"])
        client.post(SYNC, json={"uid": UID})
        assert roots_by_id(client) == saved
    with media_client(path, state) as client:
        assert roots_by_id(client) == saved


def test_pending_pure_image_comments_recover_independently_after_reopen(tmp_path):
    path = tmp_path / "pending.sqlite"
    state = comment_state()
    with media_client(path, state, source_handler=source_handler(state)) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
        saved = roots_by_id(client)
        root = saved["123"]
        assert root["text"] == ""
        assert len(root["media"]) == 2
        assert root["work"]["media"] == root["media_last_attempt"] == "pending"
        assert all(item["public_url"] is None and item["status"] == "pending" for item in root["media"])
        archive = client.get("/api/archive/dynamics/123").json()
        assert archive["work"]["comments"] == archive["work"]["replies"] == "success"
        assert archive["comments_last_attempt"] == "success"
    with media_client(path, {"html": "unavailable"}, FakeOSS()) as client:
        assert roots_by_id(client) == saved
        media_id = root["media"][1]["id"]
        assert client.post(RETRY, params={"media_id": media_id}).json() == {"processed": 1, "succeeded": 1, "failed": 0}
        retried = roots_by_id(client)
        assert retried["124"] == saved["124"]
        assert retried["123"]["media"][0] == root["media"][0]
        assert retried["123"]["media"][1]["status"] == "success"
        assert retried["123"]["work"]["media"] == "pending"
        assert client.post(RETRY).json() == {"processed": 1, "succeeded": 1, "failed": 0}
        assert roots_by_id(client)["123"]["work"]["media"] == "success"
        assert "media_last_succeeded_at" not in roots_by_id(client)["123"]
        assert client.get("/api/archive/dynamics/123").json() == archive
        assert client.post(RETRY).json() == {"processed": 0, "succeeded": 0, "failed": 0}
        assert client.post(RETRY, params={"media_id": saved["124"]["media"][0]["id"]}).status_code == 404
        assert client.post("/api/sync/media/123", params={"media_id": media_id}).status_code == 404
        assert client.post("/api/sync/media/999/comments/123").status_code == 404
        assert client.post("/api/sync/media/123/comments/999").status_code == 404
        for params in ({"media_id": "bad"}, {"unknown": "1"}, [("media_id", media_id), ("media_id", media_id)]):
            assert client.post(RETRY, params=params).status_code == 422


def test_new_count_observation_survives_old_media_completion_when_root_page_fails(tmp_path):
    state = comment_state()
    with media_client(tmp_path / "observe.sqlite", state, source_handler=source_handler(state)) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
        baseline = roots_by_id(client)["123"]
        state.update(dynamic_count=8, fail_page=1)
        client.post(SYNC, json={"uid": UID})
        pending = roots_by_id(client)["123"]
        assert pending["observed_version"] == "comments:8"
        assert pending["media_version"] == "comments:7"
        assert pending["work"]["media"] == "pending"
        assert pending["media"] == baseline["media"]
    with media_client(tmp_path / "observe.sqlite", state, FakeOSS()) as client:
        assert client.post(RETRY).json()["succeeded"] == 2
        saved = roots_by_id(client)["123"]
        assert saved["synced_media_version"] == "comments:7"
        assert saved["work"]["media"] == "pending"
        archive = client.get(ARCHIVE).json()
        assert archive["synced_root_comment_count"] == 7
        assert archive["source_comment_count"] == 8
        assert archive["root_comments_last_attempt"] == "failed"


@pytest.mark.parametrize("failure_boundary", ["download", "upload"])
def test_single_image_failure_retains_other_images_text_and_checkpoints(tmp_path, caplog, failure_boundary):
    state = comment_state()
    failing = True

    class PartialOSS:
        async def upload(self, key, content, content_type):
            if failing and failure_boundary == "upload" and content == b"second":
                raise RuntimeError("FICTIONAL_COMMENT_OSS_SECRET")
            return "https://archive.example.invalid/" + key

    def download(request):
        second = request.url.path.endswith("second.png")
        if failing and failure_boundary == "download" and second:
            raise httpx.ReadError("FICTIONAL_COMMENT_DOWNLOAD_SECRET")
        return httpx.Response(200, content=b"second" if second else b"first", headers={"Content-Type": "image/png"})

    with media_client(tmp_path / "failure.sqlite", state, PartialOSS(), download, source_handler(state)) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
        saved = roots_by_id(client)["123"]
        assert [item["status"] for item in saved["media"]] == ["success", "failed"]
        assert saved["media"][1]["error"] == ("MEDIA_DOWNLOAD_FAILED" if failure_boundary == "download" else "MEDIA_UPLOAD_FAILED")
        assert saved["media"][1]["public_url"] is None
        assert saved["media_last_attempt"] == "failed"
        archive = client.get(ARCHIVE).json()
        assert archive["comments_last_attempt"] == "success"
        assert archive["synced_comment_count"] == 7
        assert archive["comment_sync"]["media_errors"] == []
        assert archive["comment_sync"]["comment_media_errors"] == [
            "MEDIA_DOWNLOAD_FAILED" if failure_boundary == "download" else "MEDIA_UPLOAD_FAILED"]
        assert "FICTIONAL_COMMENT" not in str(saved) + str(archive) + caplog.text
        failing = False
        started_at = datetime.now(timezone.utc).replace(microsecond=0)
        client.post(SYNC, json={"uid": UID})  # 显式 initial 会实际重扫评论，也恢复失败媒体。
        restored = roots_by_id(client)["123"]
        assert restored["media"][0] == saved["media"][0]
        assert [item["id"] for item in restored["media"]] == [item["id"] for item in saved["media"]]
        assert restored["work"]["media"] == restored["media_last_attempt"] == "success"
        current = client.get(ARCHIVE).json()
        # 实际重扫成功可以推进时间；其余归档（含正文、checkpoint、错误）仍完整不变。
        succeeded_times = {}
        for part in ("root_comments", "replies", "comments"):
            field = part + "_last_succeeded_at"
            assert current[part + "_last_attempt"] == "success"
            assert current[part + "_error"] is None
            timestamp = datetime.fromisoformat(current[field])
            assert started_at <= timestamp <= datetime.now(timezone.utc)
            assert timestamp >= datetime.fromisoformat(archive[field])
            succeeded_times[field] = current[field]
        media_time = datetime.fromisoformat(current["comment_media_last_succeeded_at"])
        assert started_at <= media_time <= datetime.now(timezone.utc)
        succeeded_times["comment_media_last_succeeded_at"] = current["comment_media_last_succeeded_at"]
        assert archive_content(current) == {**archive_content(archive), **succeeded_times}
        assert current["comment_sync"]["parts"]["comment_media"] == "success"
        assert current["comment_sync"]["comment_media_errors"] == []
        assert archive["comment_sync"]["parts"]["comment_media"] == "pending"


def test_actual_root_sync_versions_replace_same_url_and_retain_success_but_missing_pictures_do_not(tmp_path):
    state = comment_state()
    failing = False

    class VersionOSS(FakeOSS):
        async def upload(self, key, content, content_type):
            if failing:
                raise RuntimeError("FICTIONAL_SECRET")
            return await super().upload(key, content, content_type)

    with media_client(tmp_path / "versions.sqlite", state, VersionOSS(), source_handler=source_handler(state)) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
        baseline = roots_by_id(client)["123"]
        state["dynamic_count"] = 8
        failing = True
        client.post(SYNC, json={"uid": UID})
        newer = roots_by_id(client)["123"]
        assert newer["media_version"] == newer["observed_version"] == "comments:8"
        assert newer["synced_media_version"] == "comments:7"
        assert newer["previous_media"] == baseline["media"]
        assert newer["media_last_attempt"] == "failed"
        assert {item["id"] for item in newer["media"]}.isdisjoint(item["id"] for item in baseline["media"])
        for root in state["roots"]:
            root["content"].pop("pictures")
        client.post(SYNC, json={"uid": UID})
        saved = roots_by_id(client)["123"]
        assert saved["media_sources"] == newer["media_sources"]
        assert saved["media"] == newer["media"]
        assert saved["previous_media"] == newer["previous_media"]
        for root in state["roots"]:
            root["content"]["pictures"] = []
        client.post(SYNC, json={"uid": UID})
        empty = roots_by_id(client)["123"]
        assert empty["media"] == empty["media_sources"] == []
        assert empty["previous_media"] == baseline["media"]
        assert empty["work"]["media"] == empty["media_last_attempt"] == "success"
        assert empty["synced_media_version"] == "comments:8"


@pytest.mark.parametrize("boundary", ["download", "upload"])
@pytest.mark.parametrize("old_fails", [False, True])
@pytest.mark.parametrize("new_version", [False, True])
@pytest.mark.parametrize("new_fails", [False, True])
def test_late_media_completion_cannot_overwrite_new_version_or_new_attempt(tmp_path, boundary, old_fails, new_version, new_fails):
    path = tmp_path / "interleaved.sqlite"
    state = comment_state()
    with media_client(path, state, source_handler=source_handler(state)) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
        first_id = roots_by_id(client)["123"]["media"][0]["id"]
    entered, release = Event(), Event()
    first_download, first_upload = True, True
    keys = []

    async def download(request):
        nonlocal first_download
        block = boundary == "download" and first_download
        first_download = False
        if block:
            entered.set()
            assert await anyio.to_thread.run_sync(release.wait, 10)
            if old_fails:
                raise httpx.ReadError("FICTIONAL_SECRET_OLD_DOWNLOAD")
        return httpx.Response(200, content=b"fictional image bytes", headers={"Content-Type": "image/png"})

    class BlockingOSS(FakeOSS):
        async def upload(self, key, content, content_type):
            nonlocal first_upload
            keys.append(key)
            block = boundary == "upload" and first_upload
            first_upload = False
            if block:
                entered.set()
                assert await anyio.to_thread.run_sync(release.wait, 10)
                if old_fails:
                    raise RuntimeError("FICTIONAL_SECRET_OLD_UPLOAD")
            elif new_fails:
                raise RuntimeError("FICTIONAL_SECRET_NEW_UPLOAD")
            return await super().upload(key, content, content_type)

    with media_client(path, state, BlockingOSS(), download, source_handler(state)) as client:
        with ThreadPoolExecutor() as executor:
            old = executor.submit(client.post, RETRY, params={"media_id": first_id})
            try:
                assert entered.wait(5)
                # 图片等待时，评论根/回复已经成功；另一个 SQLite 应用仍可读写。
                with media_client(path, state) as other:
                    archive = other.get(ARCHIVE).json()
                    assert archive["comments_last_attempt"] == "success"
                    assert other.patch(f"/api/manage/ups/{UID}/monitor", json={
                        "mode": "specified", "recent_n": 11, "enabled": True,
                    }).status_code == 200
                    assert roots_by_id(other)["123"]["media"][0]["status"] == "pending"
                if new_version:
                    state["dynamic_count"] = 8
                    state["roots"][0]["content"]["message"] = "新版本根评论"
                    client.post(SYNC, json={"uid": UID})
                else:
                    assert client.post(RETRY, params={"media_id": first_id}).json()["succeeded"] == (0 if new_fails else 1)
                newer = roots_by_id(client)
                assert newer["123"]["media"][0]["status"] == ("failed" if new_fails else "success")
                assert newer["123"]["media"][0]["error"] == ("MEDIA_UPLOAD_FAILED" if new_fails else None)
            finally:
                release.set()
            assert old.result(timeout=5).json() == {"processed": 1, "succeeded": 0, "failed": 1}
        assert roots_by_id(client) == newer
        assert len(keys) == len(set(keys))  # 被取代的 PUT 不覆盖已发布对象。
        if new_version:
            assert newer["123"]["text"] == "新版本根评论"
            assert newer["123"]["synced_media_version"] == (None if new_fails else "comments:8")


def test_slow_initial_comment_upload_keeps_text_complete_and_owners_isolated(tmp_path):
    path = tmp_path / "owners.sqlite"
    state = comment_state()
    base_source = source_handler(state)
    entered, release = Event(), Event()

    def source(request):
        if request.url.host == "www.bilibili.com":
            return httpx.Response(200, text=readable_html(id=request.url.path.rsplit("/", 1)[-1], pictures=PICS))
        response = base_source(request)
        if request.url.path == "/x/polymer/web-dynamic/v1/detail":
            payload = response.json()
            payload["data"]["item"]["id_str"] = request.url.params["id"]
            return httpx.Response(200, json=payload)
        return response

    class BlockingOSS(FakeOSS):
        async def upload(self, key, content, content_type):
            if "/comments/" in key:
                entered.set()
                assert await anyio.to_thread.run_sync(release.wait, 10)
            return await super().upload(key, content, content_type)

    with media_client(path, state, BlockingOSS(), source_handler=source) as client:
        prepare(client)
        with ThreadPoolExecutor() as executor:
            syncing = executor.submit(client.post, SYNC, json={"uid": UID})
            try:
                assert entered.wait(5)
                archive = client.get(ARCHIVE).json()
                assert archive["work"]["text"] == archive["work"]["comments"] == archive["work"]["replies"] == "success"
                assert archive["comments_last_attempt"] == "success"
                assert roots_by_id(client)["123"]["media_last_attempt"] == "pending"
                assert archive["work"]["media"] == "success"  # 评论图不借用动态图状态。
            finally:
                release.set()
            assert syncing.result(timeout=5).json() == {"processed": 1, "succeeded": 1, "failed": 0}
        roots = roots_by_id(client)
        dynamic = client.get(ARCHIVE).json()["media"]
        assert all(item["owner"] == {"type": "dynamic", "id": "123"} for item in dynamic)
        assert {item["id"] for item in dynamic}.isdisjoint(item["id"] for item in roots["123"]["media"])
        assert client.post(TARGETS, json={"id": "124"}).status_code == 201
        client.post(SYNC, json={"uid": UID})
        others = client.get("/api/archive/dynamics/124/comments").json()["items"]
        other_root = next(root for root in others if root["id"] == "123")
        assert other_root["dynamic_id"] == "124"
        assert {item["id"] for item in other_root["media"]}.isdisjoint(item["id"] for item in roots["123"]["media"])
        assert all("/bili-charge/comments/124/123/" in item["public_url"] for item in other_root["media"])
        assert roots_by_id(client) == roots
        set_specified(client, enabled=False)
        assert client.post(SYNC, json={"uid": UID}).json()["processed"] == 0
        client.delete(TARGETS + "/123")
        client.delete(f"/api/manage/ups/{UID}/monitor")
        assert roots_by_id(client) == roots
    with media_client(path, state) as client:
        assert roots_by_id(client) == roots
        assert client.get(ARCHIVE).json()["media"] == dynamic


def test_comment_upload_does_not_rewrite_frozen_cursor_and_does_not_limit_to_nine_images(tmp_path):
    path = tmp_path / "cursor.sqlite"
    state = comment_state()
    state["roots"][1]["content"]["pictures"] = [
        {"img_src": f"https://i0.hdslb.com/bfs/new/{i}.png", "img_width": 640}
        for i in range(12)
    ]
    with media_client(path, state, source_handler=source_handler(state)) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
        cursor = client.get(COMMENTS, params={"limit": 1}).json()["next_cursor"]
        frozen = client.get(COMMENTS, params={"limit": 1, "cursor": cursor}).json()
        root = frozen["items"][0]
        assert root["id"] == "124"
        assert len(root["media"]) == 12
        assert [item["position"] for item in root["media"]] == list(range(12))
        assert all(item["height"] is None and item["public_url"] is None for item in root["media"])
    with media_client(path, state, FakeOSS()) as client:
        assert client.post("/api/sync/media/123/comments/124").json() == {"processed": 12, "succeeded": 12, "failed": 0}
        assert roots_by_id(client)["124"]["work"]["media"] == "success"
        assert client.get(COMMENTS, params={"limit": 1, "cursor": cursor}).json() == frozen
    with media_client(path, state) as client:
        assert client.get(COMMENTS, params={"limit": 1, "cursor": cursor}).json() == frozen


def crash_during_comment_upload(path, state):
    class CrashingOSS(FakeOSS):
        async def upload(self, key, content, content_type):
            os._exit(23)
    with media_client(path, state, CrashingOSS(), source_handler=source_handler(state)) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})


def test_process_exit_during_comment_upload_recovers_pending_owner_and_attempt(tmp_path):
    path = tmp_path / "crash.sqlite"
    state = comment_state()
    process = multiprocessing.get_context("spawn").Process(target=crash_during_comment_upload, args=(path, state))
    process.start()
    try:
        process.join(10)
        assert process.exitcode == 23
    finally:
        if process.is_alive():
            process.terminate()
            process.join(5)
    with media_client(path, state, FakeOSS()) as client:
        saved = roots_by_id(client)["123"]
        assert saved["media_last_attempt"] == saved["work"]["media"] == "pending"
        assert all(item["status"] == "pending" and item["public_url"] is None for item in saved["media"])
        assert "attempt_token" not in client.get(COMMENTS).text
        assert client.get(ARCHIVE).json()["comments_last_attempt"] == "success"
        assert client.post(RETRY).json() == {"processed": 2, "succeeded": 2, "failed": 0}
        restored = roots_by_id(client)["123"]
        assert [item["id"] for item in restored["media"]] == [item["id"] for item in saved["media"]]
        assert restored["work"]["media"] == "success"


@pytest.mark.parametrize("observed_count", [7, 8])
def test_v8_root_sources_migrate_to_pending_without_changing_frozen_pages_or_archives(tmp_path, observed_count):
    path = tmp_path / "v8.sqlite"
    archive = {"id": "123", "text": "旧成功正文", "source_comment_count": observed_count,
               "synced_root_comment_count": 7, "media": [], "work": {"text": "success", "media": "success"}}
    legacy = {"id": "123", "dynamic_id": "123", "author": {"id": UID, "nickname": "旧根作者", "avatar_url": None},
              "published_at": None, "text": "旧根正文", "like_count": 0, "source_reply_count": 0,
              "root_id": "0", "parent_id": "0", "comment_locator": {"oid": "99123", "type": 17}, "media_sources": PICS}
    token = "a" * 32
    frozen = {"items": [legacy], "next_cursor": None}
    with sqlite3.connect(path) as database:
        # 已发布 v8 输入：固定 v7 DDL 加 v8 媒体尝试表，不从当前 Store 导出。
        database.executescript((Path(__file__).parent / "fixtures/archive-v7.sql").read_text())
        database.executescript("""CREATE TABLE media_attempts (
            dynamic_id TEXT NOT NULL REFERENCES archives(id), media_id TEXT NOT NULL,
            token TEXT NOT NULL, PRIMARY KEY(dynamic_id, media_id)); PRAGMA user_version = 8;""")
        database.execute("INSERT INTO identities VALUES (?, '虚构星海', NULL)", (UID,))
        database.execute("INSERT INTO archives VALUES ('123', ?, ?, 0)", (UID, json.dumps(archive)))
        database.execute("INSERT INTO root_comments VALUES ('123', '123', ?)", (json.dumps(legacy),))
        database.execute("INSERT INTO root_comment_pages VALUES (?, 'root-comments:123:hot:v1', 1, ?)", (token, json.dumps(frozen)))
    with media_client(path, {}, FakeOSS()) as client:
        pending = roots_by_id(client)["123"]
        assert {key: pending[key] for key in legacy} == legacy
        assert pending["media_version"] == "comments:7"
        assert pending["observed_version"] == f"comments:{observed_count}"
        assert all(item["status"] == "pending" and item["public_url"] is None for item in pending["media"])
        expected_archive = {**archive, **NULL_COMMENT_STATUS, "comment_sync": None}
        assert client.get(ARCHIVE).json() == expected_archive
        assert client.post(RETRY).json() == {"processed": 2, "succeeded": 2, "failed": 0}
        completed = roots_by_id(client)["123"]
        assert completed["work"]["media"] == ("success" if observed_count == 7 else "pending")
        assert completed["synced_media_version"] == "comments:7"
        assert client.get(COMMENTS, params={"limit": 1, "cursor": token}).json() == frozen
        assert client.get(ARCHIVE).json() == expected_archive
    with media_client(path, {}) as client:
        assert roots_by_id(client)["123"] == completed
        assert client.get(COMMENTS, params={"limit": 1, "cursor": token}).json() == frozen


def test_absent_pictures_confirm_empty_media_only_when_no_image_was_ever_observed(tmp_path):
    """上游只在根评论确实带图时下发 pictures（同轮实测 2 条带图、其余缺键）。

    已观察到图片后缺键：保留已知组，不擦除也不冒充空组。
    从未观察到图片时缺键：确认空组，否则 work.media 永久 pending，整个目标永不完成。
    """
    state = comment_state()
    for root in state["roots"]:
        root["content"].pop("pictures")
    with media_client(tmp_path / "absent.sqlite", state, FakeOSS(), source_handler=source_handler(state)) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
        saved = roots_by_id(client)
        for id, root in saved.items():
            assert root["media"] == root["media_sources"] == []
            assert root["work"]["media"] == root["media_last_attempt"] == "success"
            assert root["media_version"] == root["observed_version"] == root["synced_media_version"]
        archive = client.get(ARCHIVE).json()
        assert archive["work"]["comments"] == archive["work"]["replies"] == "success"
        assert archive["comment_sync"]["parts"]["comment_media"] == "success"


def test_unknown_count_and_absent_pictures_are_not_confirmed_empty_media(tmp_path):
    state = comment_state()
    state["unknown_count"] = True
    state["roots"][1]["content"].pop("pictures")
    with media_client(tmp_path / "unknown.sqlite", state, FakeOSS(), source_handler=source_handler(state)) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
        saved = roots_by_id(client)
        assert saved["123"]["observed_version"] is None
        assert saved["123"]["media_version"] is None
        assert saved["123"]["work"]["media"] == "success"
        assert saved["124"]["media"] == []
        assert saved["124"]["work"]["media"] == saved["124"]["media_last_attempt"] == "success"
        assert client.get(ARCHIVE).json()["synced_comment_count"] is None


def test_actual_reply_and_embedded_preview_images_are_not_downloaded_or_archived(tmp_path):
    from backend.tests.test_replies import ROOT, REPLIES, reply_fixture, reply_source

    state = {"roots": copy.deepcopy(root_fixture()["data"]["replies"]), "replies": reply_fixture()["data"]["replies"]}
    for root in state["roots"]:
        root["content"]["pictures"] = [{"img_src": PICS[0]["url"], "img_width": 640, "img_height": 480}]
        root["replies"] = [{"content": {"message": "内嵌预览", "pictures": [{"img_src": "https://i0.hdslb.com/preview.png"}]}}]
    for reply in state["replies"]:
        reply["content"]["pictures"] = [{"img_src": "https://i0.hdslb.com/reply-only.png"}]
    downloaded = []

    def download(request):
        downloaded.append(str(request.url))
        return httpx.Response(200, content=b"fictional image bytes", headers={"Content-Type": "image/png"})

    with media_client(tmp_path / "replies.sqlite", state, FakeOSS(), download, reply_source(state)) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
        root = roots_by_id(client)[ROOT]
        assert root["work"]["media"] == "success"
        replies = client.get(REPLIES).json()
        assert replies["local_reply_count"] == 5
        assert client.get(ARCHIVE).json()["comments_last_attempt"] == "success"
        assert len(downloaded) == 2
        assert set(downloaded) == {PICS[0]["url"]}
        assert all("media" not in reply and "media_sources" not in reply for reply in replies["items"])
