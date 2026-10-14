"""19 / T2-T3：协议 fixture→下载/模拟 OSS→真实 SQLite→公开 HTTP。"""

from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from urllib.parse import unquote

import anyio
import pytest
import logging
import multiprocessing
import os
import json
import sqlite3
import time
from pathlib import Path

import requests

import httpx
from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app
from backend.tests.archive_support import BASE, UID, TARGETS, archive_content, author_html, detail_json, readable_html, set_specified
from backend.tests.management_support import profile_response

ARCHIVE = "/api/archive/dynamics/123"
SYNC = "/api/sync/initial"
RETRY = "/api/sync/media/123"
PICS = [
    {"url": "https://i0.hdslb.com/bfs/new/first.png", "width": 640, "height": 480},
    {"url": "https://i0.hdslb.com/bfs/new/second.png", "width": 200, "height": 1200},
]


class FakeOSS:
    async def upload(self, key, content, content_type):
        assert content == b"fictional image bytes"
        assert content_type == "image/png"
        return "https://archive.example.invalid/" + key


@contextmanager
def media_client(path, state, uploader=None, download_handler=None, source_handler=None):
    def upstream(request):
        if request.url.path == "/x/web-interface/card":
            return profile_response(request)
        if source_handler is not None:
            return source_handler(request)
        if request.url.host == "www.bilibili.com":
            html = state["html"]
            if isinstance(html, dict):
                html = html[request.url.path.rsplit("/", 1)[-1]]
            return httpx.Response(200, text=html)
        if request.url.path == "/x/polymer/web-dynamic/v1/detail" and "detail" in state:
            return httpx.Response(200, json=state["detail"])
        if request.url.path == "/x/v2/reply" and "roots" in state:
            return httpx.Response(200, json=state["roots"])
        return httpx.Response(503)

    def download(request):
        return httpx.Response(200, content=b"fictional image bytes", headers={"Content-Type": "image/png"})

    with TestClient(create_app(
        path, profile_transport=httpx.MockTransport(upstream),
        media_transport=httpx.MockTransport(download_handler or download),
        media_uploader=uploader,
    )) as client:
        yield client


@pytest.fixture(autouse=True)
def no_real_oss_environment(monkeypatch):
    for name in ("ENDPOINT", "REGION", "BUCKET", "ACCESS_KEY_ID", "ACCESS_KEY_SECRET", "PUBLIC_BASE_URL", "SECURITY_TOKEN"):
        monkeypatch.delenv("BILI_OSS_" + name, raising=False)


def prepare(client):
    assert client.post(BASE, json={"uid": UID}).status_code == 201
    assert client.post(TARGETS, json={"id": "123"}).status_code == 201
    assert set_specified(client).status_code == 200


def test_protocol_images_are_archived_in_order_with_public_urls_and_survive_reopen(tmp_path):
    path = tmp_path / "media.sqlite"
    state = {"html": readable_html(pictures=PICS)}
    with media_client(path, state, FakeOSS()) as client:
        prepare(client)
        response = client.post(SYNC, json={"uid": UID})
        assert response.json() == {"processed": 1, "succeeded": 1, "failed": 0}
        saved = client.get(ARCHIVE).json()
        assert saved["work"]["text"] == saved["work"]["media"] == "success"
        assert saved["media_last_attempt"] == "success"
        assert saved["media_version"] == saved["synced_media_version"] == "2026-10-09T13:01+08:00"
        assert len(saved["media"]) == 2
        assert [item["position"] for item in saved["media"]] == [0, 1]
        assert [item["source_url"] for item in saved["media"]] == [pic["url"] for pic in PICS]
        assert [(item["width"], item["height"]) for item in saved["media"]] == [(640, 480), (200, 1200)]
        for item in saved["media"]:
            assert item["owner"] == {"type": "dynamic", "id": "123"}
            assert item["status"] == "success"
            assert item["error"] is None
            assert item["public_url"].startswith("https://archive.example.invalid/dynamics/123/")
        assert client.get("/api/archive/dynamics").json()["items"] == [archive_content(saved)]
        client.post(SYNC, json={"uid": UID})
        assert client.get(ARCHIVE).json() == saved
    with media_client(path, state) as client:
        assert client.get(ARCHIVE).json() == saved


@pytest.mark.parametrize("edit_signal_changes", [False, True])
@pytest.mark.parametrize("source_changes", [False, True])
def test_only_edit_signal_updates_body_and_media_even_with_unchanged_source_url(tmp_path, edit_signal_changes, source_changes):
    path = tmp_path / "media.sqlite"
    state = {"html": readable_html("original", title="原标题", pictures=[PICS[0]])}
    failing = False

    class VersionOSS(FakeOSS):
        async def upload(self, key, content, content_type):
            if failing:
                raise RuntimeError("FICTIONAL_VERSION_SECRET")
            return await super().upload(key, content, content_type)

    with media_client(path, state, VersionOSS()) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
        baseline = client.get(ARCHIVE).json()
        pictures = [PICS[1]] if source_changes else [PICS[0]]
        state["html"] = readable_html("revised", title="新标题", pictures=pictures)
        if edit_signal_changes:
            state["html"] = state["html"].replace("13:01", "13:02")
        failing = True
        client.post(SYNC, json={"uid": UID})
        saved = client.get(ARCHIVE).json()
        if not edit_signal_changes:
            assert saved == baseline
        else:
            assert saved["text"] == "revised"
            assert saved["title"] == "新标题"
            assert saved["media_sources"] == pictures
            assert saved["media_version"] == "2026-10-09T13:02+08:00"
            assert saved["work"]["text"] == "success"
            assert saved["work"]["media"] == "pending"
            assert saved["media"][0]["status"] == "failed"
            assert saved["media"][0]["public_url"] is None
            assert saved["previous_media"] == baseline["media"]
            assert saved["synced_media_version"] == "2026-10-09T13:01+08:00"


def test_one_image_failure_is_persisted_and_retries_without_body_or_new_signal(tmp_path, caplog):
    path = tmp_path / "media.sqlite"
    state = {"html": readable_html(pictures=PICS)}
    failing = True

    class PartialOSS(FakeOSS):
        async def upload(self, key, content, content_type):
            if failing and content == b"second image":
                raise RuntimeError("FICTIONAL_OSS_SECRET Authorization=secret")
            return "https://archive.example.invalid/" + key

    def download(request):
        content = b"fictional image bytes" if request.url.path.endswith("first.png") else b"second image"
        return httpx.Response(200, content=content, headers={"Content-Type": "image/png"})

    with media_client(path, state, PartialOSS(), download) as client:
        prepare(client)
        assert client.post(SYNC, json={"uid": UID}).json()["succeeded"] == 1
        saved = client.get(ARCHIVE).json()
        assert saved["work"]["text"] == "success"
        assert saved["work"]["media"] == "pending"
        assert saved["media_last_attempt"] == "failed"
        assert [item["status"] for item in saved["media"]] == ["success", "failed"]
        assert saved["media"][1]["error"] == "MEDIA_UPLOAD_FAILED"
        assert saved["media"][1]["public_url"] is None
        assert saved["synced_media_version"] is None
        assert "FICTIONAL_OSS_SECRET" not in str(saved) + caplog.text
        assert client.post(RETRY + "/bad").status_code == 404
    failing = False
    # 正文上游不可用，重开后独立重试，不重新处理/宣称正文成功。
    state["html"] = "unavailable"
    with media_client(path, state, PartialOSS(), download) as client:
        assert client.get(ARCHIVE).json() == saved
        assert client.post(RETRY).json() == {"processed": 1, "succeeded": 1, "failed": 0}
        retried = client.get(ARCHIVE).json()
        assert retried["media"][0] == saved["media"][0]
        assert [item["id"] for item in retried["media"]] == [item["id"] for item in saved["media"]]
        assert [item["position"] for item in retried["media"]] == [0, 1]
        assert retried["work"]["media"] == "success"
        assert retried["text"] == saved["text"]
        assert retried["last_attempt"] == saved["last_attempt"]
        assert client.post(RETRY).json() == {"processed": 0, "succeeded": 0, "failed": 0}
        assert client.post("/api/sync/media/999").status_code == 404
        assert client.post(RETRY + "?unknown=1").status_code == 422


@pytest.mark.parametrize("oss_status", [200, 403])
def test_configured_real_oss_adapter_uses_signed_put_and_never_exposes_credentials(tmp_path, monkeypatch, caplog, oss_status):
    for name, value in {
        "BILI_OSS_ENDPOINT": "https://oss-cn-hangzhou.aliyuncs.com",
        "BILI_OSS_REGION": "cn-hangzhou",
        "BILI_OSS_BUCKET": "fictional-archive",
        "BILI_OSS_ACCESS_KEY_ID": "FICTIONAL_ACCESS_ID",
        "BILI_OSS_ACCESS_KEY_SECRET": "FICTIONAL_ACCESS_SECRET",
        "BILI_OSS_SECURITY_TOKEN": "FICTIONAL_SECURITY_TOKEN",
        "BILI_OSS_PUBLIC_BASE_URL": "https://archive.example.invalid/images",
    }.items():
        monkeypatch.setenv(name, value)
    caplog.set_level(logging.DEBUG)
    uploaded = []

    def send(session, request, **kwargs):
        assert request.method == "PUT"
        assert unquote(request.url).startswith("https://fictional-archive.oss-cn-hangzhou.aliyuncs.com/dynamics/123/")
        assert request.headers["Authorization"].startswith("OSS4-HMAC-SHA256 ")
        assert request.headers["x-oss-security-token"] == "FICTIONAL_SECURITY_TOKEN"
        assert request.headers["Content-Type"] == "image/png"
        assert request.body.read() == b"fictional image bytes"
        uploaded.append(request.url)
        response = requests.Response()
        response.status_code = oss_status
        response.headers = {"ETag": '"fictional-etag"', "x-oss-request-id": "fictional-request"}
        response._content = b"" if oss_status == 200 else b"<Error><Code>AccessDenied</Code><Message>FICTIONAL_ACCESS_SECRET</Message></Error>"
        response.request = request
        return response

    monkeypatch.setattr(requests.Session, "send", send)
    state = {"html": readable_html(pictures=[PICS[0]])}
    with media_client(tmp_path / "media.sqlite", state) as client:
        prepare(client)
        assert client.post(SYNC, json={"uid": UID}).status_code == 200
        detail = client.get(ARCHIVE)
        saved = detail.json()
        assert len(uploaded) == 1
        assert saved["media"][0]["status"] == ("success" if oss_status == 200 else "failed")
        if oss_status == 200:
            assert saved["media"][0]["public_url"].startswith("https://archive.example.invalid/images/dynamics/123/")
            assert "?" not in saved["media"][0]["public_url"]
        else:
            assert saved["media"][0]["error"] == "MEDIA_UPLOAD_FAILED"
            assert saved["media"][0]["public_url"] is None
        for marker in ("FICTIONAL_ACCESS_ID", "FICTIONAL_ACCESS_SECRET", "FICTIONAL_SECURITY_TOKEN"):
            assert marker not in detail.text + caplog.text


@pytest.mark.parametrize("old_fails", [False, True])
def test_late_retry_of_same_association_cannot_overwrite_new_attempt(tmp_path, old_fails):
    path = tmp_path / "media.sqlite"
    state = {"html": readable_html(pictures=[PICS[0]])}
    reached, release = Event(), Event()
    old_attempt = True
    object_keys = []

    class InterleavedOSS:
        async def upload(self, key, content, content_type):
            object_keys.append(key)
            if old_attempt:
                reached.set()
                await anyio.to_thread.run_sync(lambda: release.wait(10))
                if old_fails:
                    raise RuntimeError("FICTIONAL_LATE_UPLOAD_SECRET")
            return "https://archive.example.invalid/" + key

    with media_client(path, state) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
    with media_client(path, state, InterleavedOSS()) as older_client, media_client(path, state, InterleavedOSS()) as newer_client:
        with ThreadPoolExecutor() as pool:
            older = pool.submit(older_client.post, RETRY)
            try:
                assert reached.wait(5)
                pending_response = newer_client.get(ARCHIVE)
                assert "attempt_token" not in pending_response.text
                old_attempt = False
                assert newer_client.post(RETRY).json() == {"processed": 1, "succeeded": 1, "failed": 0}
                saved = newer_client.get(ARCHIVE).json()
            finally:
                release.set()
            assert older.result().json() == {"processed": 1, "succeeded": 0, "failed": 1}
        assert newer_client.get(ARCHIVE).json() == saved
        assert saved["work"]["media"] == "success"
        assert len(object_keys) == 2
        assert object_keys[0] != object_keys[1]
        assert saved["media"][0]["public_url"] == "https://archive.example.invalid/" + object_keys[1]


@pytest.mark.parametrize("bad_url", [
    "https://i0.hdslb.com/fallback.png",
    "https://archive.example.invalid/image?signature=FICTIONAL_SECRET",
    "https://FICTIONAL_SECRET@archive.example.invalid/image",
])
def test_invalid_uploader_url_is_failure_not_a_business_source_fallback(tmp_path, bad_url, caplog):
    class InvalidOSS:
        async def upload(self, key, content, content_type):
            return bad_url

    state = {"html": readable_html(pictures=[PICS[0]])}
    with media_client(tmp_path / "media.sqlite", state, InvalidOSS()) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
        response = client.get(ARCHIVE)
        assert response.json()["media"][0]["public_url"] is None
        assert response.json()["media"][0]["error"] == "MEDIA_UPLOAD_FAILED"
        assert "FICTIONAL_SECRET" not in response.text + caplog.text


@pytest.mark.parametrize("content_type,body,status", [("text/html", b"not an image", 200), ("image/png", b"", 200), ("image/png", b"image", 302)])
def test_bad_download_response_is_independent_media_failure(tmp_path, content_type, body, status):
    def download(request):
        return httpx.Response(status, content=body, headers={"Content-Type": content_type, "Location": "http://127.0.0.1/private"})

    state = {"html": readable_html(pictures=[PICS[0]])}
    with media_client(tmp_path / "media.sqlite", state, FakeOSS(), download) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
        saved = client.get(ARCHIVE).json()
        assert saved["work"]["text"] == "success"
        assert saved["media"][0]["error"] == "MEDIA_DOWNLOAD_FAILED"
        assert saved["media"][0]["public_url"] is None


def test_source_cannot_download_internal_services(tmp_path):
    state = {"html": readable_html(pictures=[{**PICS[0], "url": "http://127.0.0.1/private"}])}

    def no_network(request):
        pytest.fail("An internal media origin must not reach the network")

    with media_client(tmp_path / "media.sqlite", state, FakeOSS(), no_network) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
        assert client.get(ARCHIVE).json()["media"][0]["error"] == "MEDIA_DOWNLOAD_FAILED"


def test_slow_upload_does_not_prevent_text_and_readable_comments_from_completing(tmp_path):
    path = tmp_path / "media.sqlite"
    detail = detail_json()
    detail["data"]["item"]["modules"]["module_stat"]["comment"]["count"] = 0
    reached, release = Event(), Event()
    state = {"html": readable_html(pictures=[PICS[0]]), "detail": detail,
             "roots": {"code": 0, "data": {"replies": [], "page": {"count": 0, "num": 1, "size": 20}}}}

    class BlockingOSS(FakeOSS):
        async def upload(self, key, content, content_type):
            reached.set()
            await anyio.to_thread.run_sync(lambda: release.wait(10))
            return await super().upload(key, content, content_type)

    with media_client(path, state, BlockingOSS()) as client:
        prepare(client)
        with ThreadPoolExecutor() as pool:
            syncing = pool.submit(client.post, SYNC, json={"uid": UID})
            try:
                assert reached.wait(5)
                saved = client.get(ARCHIVE).json()
                assert saved["work"]["text"] == "success"
                assert saved["comments_last_attempt"] == "success"
                assert saved["work"]["media"] == "pending"
            finally:
                release.set()
            assert syncing.result().status_code == 200


def test_media_updates_only_affect_new_reads_not_a_frozen_cursor(tmp_path):
    path = tmp_path / "media.sqlite"
    state = {"html": {id: readable_html(id=id, pictures=[PICS[0]]) for id in ("122", "123")}}
    with media_client(path, state) as client:
        prepare(client)
        assert client.post(TARGETS, json={"id": "122"}).status_code == 201
        client.post(SYNC, json={"uid": UID})
        cursor = client.get("/api/archive/dynamics?limit=1").json()["next_cursor"]
        frozen = client.get("/api/archive/dynamics", params={"limit": 1, "cursor": cursor}).json()
        assert frozen["items"][0]["id"] == "123"
        assert frozen["items"][0]["media"][0]["status"] == "pending"
    with media_client(path, state, FakeOSS()) as client:
        client.post(RETRY)
        assert client.get(ARCHIVE).json()["media"][0]["status"] == "success"
        assert client.get("/api/archive/dynamics", params={"limit": 1, "cursor": cursor}).json() == frozen
    with media_client(path, state) as client:
        assert client.get("/api/archive/dynamics", params={"limit": 1, "cursor": cursor}).json() == frozen


def test_edit_removing_images_keeps_previous_success_and_commits_confirmed_empty_group(tmp_path):
    state = {"html": readable_html(pictures=[PICS[0]])}
    with media_client(tmp_path / "media.sqlite", state, FakeOSS()) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
        old = client.get(ARCHIVE).json()
        state["html"] = readable_html("only text", pictures=[]).replace("13:01", "13:02")
        client.post(SYNC, json={"uid": UID})
        saved = client.get(ARCHIVE).json()
        assert saved["media"] == saved["media_sources"] == []
        assert saved["previous_media"] == old["media"]
        assert saved["work"]["media"] == "success"
        assert saved["synced_media_version"] == "2026-10-09T13:02+08:00"
        assert client.post(RETRY).json()["processed"] == 0


@pytest.mark.parametrize("bad_configuration", ["incomplete", "signed_base", "invalid_endpoint"])
def test_oss_configuration_errors_are_sanitized_at_startup(tmp_path, monkeypatch, caplog, bad_configuration):
    values = {
        "ENDPOINT": "https://oss-cn-hangzhou.aliyuncs.com", "REGION": "cn-hangzhou", "BUCKET": "fictional-archive",
        "ACCESS_KEY_ID": "FICTIONAL_CONFIGURATION_ID", "ACCESS_KEY_SECRET": "FICTIONAL_CONFIGURATION_SECRET",
        "PUBLIC_BASE_URL": "https://archive.example.invalid",
    }
    if bad_configuration == "incomplete":
        values.pop("BUCKET")
    elif bad_configuration == "signed_base":
        values["PUBLIC_BASE_URL"] += "/image?token=FICTIONAL_CONFIGURATION_SECRET"
    else:
        values["ENDPOINT"] = "https://FICTIONAL_CONFIGURATION_SECRET@oss-cn-hangzhou.aliyuncs.com"
    for name, value in values.items():
        monkeypatch.setenv("BILI_OSS_" + name, value)
    with pytest.raises(RuntimeError, match="Application lifecycle failed") as failure:
        with TestClient(create_app(tmp_path / "media.sqlite")):
            pytest.fail("Invalid configuration must not start serving")
    assert "FICTIONAL_CONFIGURATION" not in str(failure.value) + caplog.text


def test_same_version_body_retry_preserves_media_failure_until_media_attempt_begins(tmp_path):
    reached, release = Event(), Event()
    retrying_body = False
    detail = detail_json()
    detail["data"]["item"]["modules"]["module_dynamic"]["major"]["opus"]["pics"] = PICS

    async def source(request):
        if request.url.host == "www.bilibili.com":
            return httpx.Response(200, text=readable_html(pictures=PICS) if retrying_body else author_html())
        if request.url.path == "/x/polymer/web-dynamic/v1/detail":
            return httpx.Response(200, json=detail)
        if retrying_body:
            reached.set()
            await anyio.to_thread.run_sync(lambda: release.wait(10))
        return httpx.Response(503)

    class FailingOSS:
        async def upload(self, key, content, content_type):
            raise RuntimeError("FICTIONAL_MEDIA_FAILURE")

    with media_client(tmp_path / "media.sqlite", {}, FailingOSS(), source_handler=source) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
        failed = client.get(ARCHIVE).json()
        assert failed["media_last_attempt"] == "failed"
        retrying_body = True
        with ThreadPoolExecutor() as pool:
            syncing = pool.submit(client.post, SYNC, json={"uid": UID})
            try:
                assert reached.wait(5)
                saved = client.get(ARCHIVE).json()
                assert saved["work"]["text"] == "success"
                assert saved["media_last_attempt"] == "failed"
                assert saved["media"] == failed["media"]
            finally:
                release.set()
            assert syncing.result().status_code == 200


def test_individual_download_failures_can_be_retried_by_media_id(tmp_path):
    path = tmp_path / "media.sqlite"
    state = {"html": readable_html(pictures=PICS)}

    def unavailable(request):
        raise httpx.ReadError("FICTIONAL_DOWNLOAD_SECRET")

    with media_client(path, state, FakeOSS(), unavailable) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
        saved = client.get(ARCHIVE).json()
        assert [item["error"] for item in saved["media"]] == ["MEDIA_DOWNLOAD_FAILED", "MEDIA_DOWNLOAD_FAILED"]
        assert all(item["public_url"] is None for item in saved["media"])
    with media_client(path, state, FakeOSS()) as client:
        assert client.post(RETRY, params={"media_id": saved["media"][0]["id"]}).json() == {"processed": 1, "succeeded": 1, "failed": 0}
        retried = client.get(ARCHIVE).json()
        assert [item["status"] for item in retried["media"]] == ["success", "failed"]
        assert retried["media"][1] == saved["media"][1]
        assert client.post(RETRY, params={"media_id": "0" * 32}).status_code == 404
        assert client.post(RETRY, params={"media_id": "invalid"}).status_code == 422


def test_more_than_nine_images_are_pending_without_configuration_and_all_are_retryable(tmp_path):
    path = tmp_path / "media.sqlite"
    pictures = [{"url": f"https://i0.hdslb.com/bfs/new/{i}.png", "width": 640, "height": 480} for i in range(12)]
    pictures[11].pop("height")
    state = {"html": readable_html(pictures=pictures)}
    with media_client(path, state) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})
        saved = client.get(ARCHIVE).json()
        assert len(saved["media"]) == 12
        assert [item["position"] for item in saved["media"]] == list(range(12))
        assert all(item["status"] == "pending" and item["public_url"] is None for item in saved["media"])
        assert saved["media"][11]["height"] is None
        assert saved["work"]["text"] == "success"
        assert saved["work"]["media"] == "pending"
        assert client.post(RETRY).json()["processed"] == 0
    with media_client(path, state, FakeOSS()) as client:
        assert client.post(RETRY).json() == {"processed": 12, "succeeded": 12, "failed": 0}
        completed = client.get(ARCHIVE).json()
        assert len(completed["media"]) == 12
        assert len({item["id"] for item in completed["media"]}) == 12
        assert completed["work"]["media"] == "success"
        assert client.post(RETRY).json()["processed"] == 0


def crash_at_upload(path, state):
    class CrashingOSS:
        async def upload(self, key, content, content_type):
            os._exit(23)

    with media_client(path, state, CrashingOSS()) as client:
        prepare(client)
        client.post(SYNC, json={"uid": UID})


def test_process_exit_during_upload_leaves_pending_work_recoverable_after_reopen(tmp_path):
    path = tmp_path / "media.sqlite"
    state = {"html": readable_html(pictures=PICS)}
    process = multiprocessing.get_context("spawn").Process(target=crash_at_upload, args=(path, state))
    process.start()
    try:
        process.join(10)
        assert process.exitcode == 23
    finally:
        if process.is_alive():
            process.terminate()
            process.join(5)
    with media_client(path, state, FakeOSS()) as client:
        pending = client.get(ARCHIVE).json()
        assert pending["work"]["text"] == "success"
        assert pending["work"]["media"] == "pending"
        assert all(item["status"] == "pending" and item["public_url"] is None for item in pending["media"])
        assert all("attempt_token" not in item for item in pending["media"])
        assert client.post(RETRY).json() == {"processed": 2, "succeeded": 2, "failed": 0}
        completed = client.get(ARCHIVE).json()
        assert [item["id"] for item in completed["media"]] == [item["id"] for item in pending["media"]]
        assert completed["work"]["media"] == "success"


def test_v7_sources_migrate_to_pending_media_without_changing_old_cursor_or_content(tmp_path):
    path = tmp_path / "v7.sqlite"
    legacy = {
        "id": "123", "author": {"id": UID, "nickname": "虚构星海", "avatar_url": None},
        "text": "旧成功正文", "title": None, "content_state": "success", "last_attempt": "success",
        "published_at": None, "media_sources": PICS,
        "observed_version": "2026-10-09T13:01+08:00", "synced_version": "2026-10-09T13:01+08:00",
        "work": {"text": "success", "media": "pending", "comments": "pending", "replies": "pending"},
    }
    token = "a" * 32
    old_page = {"items": [legacy], "next_cursor": None}
    with sqlite3.connect(path) as database:
        database.executescript((Path(__file__).parent / "fixtures/archive-v7.sql").read_text())
        database.execute("INSERT INTO identities VALUES (?, '虚构星海', NULL)", (UID,))
        database.execute("INSERT INTO archives VALUES ('123', ?, ?, 0)", (UID, json.dumps(legacy)))
        database.execute("INSERT INTO archive_pages VALUES (?, 10, ?, ?, 'dynamics:all:published-desc:id-binary:v1')",
                         (token, json.dumps(old_page), int(time.time()) + 900))
    state = {"html": "unavailable"}
    with media_client(path, state, FakeOSS()) as client:
        migrated = client.get(ARCHIVE).json()
        assert {key: migrated[key] for key in legacy} == legacy
        assert all(item["status"] == "pending" and item["public_url"] is None for item in migrated["media"])
        assert migrated["synced_media_version"] is None
        assert client.post(RETRY).json() == {"processed": 2, "succeeded": 2, "failed": 0}
        completed = client.get(ARCHIVE).json()
        assert completed["text"] == "旧成功正文"
        assert completed["work"]["media"] == "success"
        assert client.get("/api/archive/dynamics", params={"cursor": token}).json() == old_page
    with media_client(path, state) as client:
        assert client.get(ARCHIVE).json() == completed
        assert client.get("/api/archive/dynamics", params={"cursor": token}).json() == old_page


def test_media_can_succeed_independently_when_full_body_is_unavailable(tmp_path):
    detail = detail_json()
    detail["data"]["item"]["modules"]["module_dynamic"]["major"]["opus"]["pics"] = PICS
    state = {"html": author_html(), "detail": detail}
    with media_client(tmp_path / "media.sqlite", state, FakeOSS()) as client:
        prepare(client)
        assert client.post(SYNC, json={"uid": UID}).json() == {"processed": 1, "succeeded": 0, "failed": 1}
        saved = client.get(ARCHIVE).json()
        assert saved["content_state"] == "failed"
        assert saved["work"]["text"] == "pending"
        assert saved["work"]["media"] == "success"
        assert [item["source_url"] for item in saved["media"]] == [pic["url"] for pic in PICS]
        assert saved["synced_version"] is None
        assert saved["synced_media_version"] == "2026-10-09T13:01+08:00"


@pytest.mark.parametrize("block_at", ["download", "upload"])
@pytest.mark.parametrize("newer_body_fails", [False, True])
@pytest.mark.parametrize("newer_upload_fails", [False, True])
def test_late_upload_does_not_replace_new_sources_or_clear_new_observation(tmp_path, block_at, newer_body_fails, newer_upload_fails):
    path = tmp_path / "media.sqlite"
    reached, release = Event(), Event()
    state = {"html": readable_html("baseline", pictures=[PICS[0]])}

    async def download(request):
        name = request.url.path.rsplit("/", 1)[-1].split(".", 1)[0]
        if name == "older" and block_at == "download":
            reached.set()
            await anyio.to_thread.run_sync(lambda: release.wait(10))
        return httpx.Response(200, content=name.encode(), headers={"Content-Type": "image/png"})

    class DelayedOSS:
        async def upload(self, key, content, content_type):
            if content == b"older" and block_at == "upload":
                reached.set()
                await anyio.to_thread.run_sync(lambda: release.wait(10))
            if content == b"newer" and newer_upload_fails:
                raise RuntimeError("FICTIONAL_NEW_MEDIA_SECRET")
            return "https://archive.example.invalid/" + key

    with media_client(path, state, DelayedOSS(), download) as old_client, media_client(path, state, DelayedOSS(), download) as new_client:
        prepare(old_client)
        old_client.post(SYNC, json={"uid": UID})
        baseline = old_client.get(ARCHIVE).json()
        state["html"] = readable_html("older", pictures=[{**PICS[0], "url": "https://i0.hdslb.com/older.png"}]).replace("13:01", "13:02")
        with ThreadPoolExecutor() as pool:
            older = pool.submit(old_client.post, SYNC, json={"uid": UID})
            try:
                assert reached.wait(5)
                # 下载/上传暂停时，真实 SQLite 上的归档读取和配置写入仍完成。
                assert new_client.get(ARCHIVE).status_code == 200
                assert set_specified(new_client).status_code == 200
                state["html"] = (author_html() if newer_body_fails else readable_html(
                    "newer", pictures=[{**PICS[0], "url": "https://i0.hdslb.com/newer.png"}]
                )).replace("13:01", "13:03")
                new_client.post(SYNC, json={"uid": UID})
                before_release = new_client.get(ARCHIVE).json()
                assert before_release["work"]["media"] == ("pending" if newer_body_fails or newer_upload_fails else "success")
            finally:
                release.set()
            assert older.result().status_code == 200
        saved = new_client.get(ARCHIVE).json()
        assert saved["observed_version"] == "2026-10-09T13:03+08:00"
        assert saved["work"]["media"] == ("pending" if newer_body_fails or newer_upload_fails else "success")
        assert baseline["media"][0] in saved["previous_media"]
        if not newer_body_fails:
            assert saved["media"] == before_release["media"]
            assert saved["media_version"] == "2026-10-09T13:03+08:00"
            assert saved["media"][0]["status"] == ("failed" if newer_upload_fails else "success")
            if newer_upload_fails:
                assert saved["media"][0]["public_url"] is None
            else:
                assert saved["synced_media_version"] == "2026-10-09T13:03+08:00"
        else:
            assert saved["media_version"] == "2026-10-09T13:02+08:00"
            assert saved["synced_media_version"] == "2026-10-09T13:02+08:00"
            assert saved["work"]["text"] == "pending"
    with media_client(path, state) as client:
        assert client.get(ARCHIVE).json() == saved
