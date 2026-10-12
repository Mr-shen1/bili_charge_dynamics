"""全文、摘要和 metadata 的公开 HTTP 区别。"""

import json

import httpx

from backend.tests.archive_support import (
    BASE, UID, TARGETS, archive_client, author_html, detail_json, readable_html, set_specified,
)


def prepare(client):
    client.post(BASE, json={"uid": UID})
    assert client.post(TARGETS, json={"id": "123"}).status_code == 201
    set_specified(client)


def test_opus_summary_is_not_successful_full_body_when_html_content_missing(tmp_path):
    def handler(request):
        if request.url.host == "www.bilibili.com":
            return httpx.Response(200, text=author_html())
        return httpx.Response(200, json=detail_json())

    with archive_client(tmp_path / "full.sqlite", handler) as client:
        prepare(client)
        assert client.post("/api/sync/initial", json={"uid": UID}).json() == {
            "processed": 1, "succeeded": 0, "failed": 1,
        }
        saved = client.get("/api/archive/dynamics/123").json()
        assert saved["text"] == ""
        assert saved["content_state"] == "failed"
        assert saved["synced_version"] is None
        assert saved["work"]["text"] == "pending"
        assert saved["source_comment_count"] == 7
        assert saved["comment_locator"] == {"oid": "99123", "type": 17}
        assert saved["media_sources"][0]["url"] == "https://example.invalid/first.png"


def test_full_html_title_and_http_media_survive_reopen_without_source_fallback(tmp_path):
    title = {"module_type": "MODULE_TYPE_TITLE", "module_title": {"text": "独立标题 <b>不是标签</b>"}}
    html = readable_html("完整正文，不等于摘要").replace(
        '"modules":[', '"modules":[' + json.dumps(title, ensure_ascii=False) + ','
    ).replace("https://example.invalid/first.png", "http://example.invalid/first.png")
    path = tmp_path / "full.sqlite"
    def handler(request):
        return httpx.Response(200, text=html) if request.url.host == "www.bilibili.com" else httpx.Response(200, json=detail_json())
    with archive_client(path, handler) as client:
        prepare(client)
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["succeeded"] == 1
        saved = client.get("/api/archive/dynamics/123").json()
        assert saved["title"] == "独立标题 <b>不是标签</b>"
        assert saved["text"] == "完整正文，不等于摘要"
        assert saved["media_sources"][0]["url"] == "http://example.invalid/first.png"
        assert saved["work"]["media"] == "pending"
    with archive_client(path) as client:
        assert client.get("/api/archive/dynamics/123").json() == saved


def test_restricted_attempt_is_not_counted_as_successful_body(tmp_path):
    payload = detail_json()
    payload["data"]["item"]["modules"]["module_dynamic"]["major"] = {"type": "MAJOR_TYPE_BLOCKED"}
    def handler(request):
        return httpx.Response(200, text=author_html()) if request.url.host == "www.bilibili.com" else httpx.Response(200, json=payload)
    with archive_client(tmp_path / "restricted.sqlite", handler) as client:
        prepare(client)
        assert client.post("/api/sync/initial", json={"uid": UID}).json() == {
            "processed": 1, "succeeded": 0, "failed": 1,
        }
        saved = client.get("/api/archive/dynamics/123").json()
        assert saved["content_state"] == saved["last_attempt"] == "restricted"
        assert saved["work"]["text"] == "pending"
        assert saved["synced_version"] is None


def test_invalid_optional_title_does_not_block_full_body(tmp_path):
    html = readable_html("标题无效时仍保留的正文", title="损坏标题").replace(
        '"text": "损坏标题"', '"text": 17'
    )
    def handler(request):
        return httpx.Response(200, text=html) if request.url.host == "www.bilibili.com" else httpx.Response(200, json=detail_json())

    with archive_client(tmp_path / "optional-title.sqlite", handler) as client:
        prepare(client)
        assert client.post("/api/sync/initial", json={"uid": UID}).json() == {
            "processed": 1, "succeeded": 1, "failed": 0,
        }
        saved = client.get("/api/archive/dynamics/123").json()
        assert saved["content_state"] == "success"
        assert saved["title"] is None
        assert saved["text"] == "标题无效时仍保留的正文"
