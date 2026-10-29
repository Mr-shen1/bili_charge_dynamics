"""02：正常发现、检查、归档、分页与媒体的结构化日志（业务 ID + 页后等待 + 脱敏）。"""

import asyncio
import contextlib
import json
import logging
import re
from pathlib import Path

import httpx
import requests
from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app
from backend.bili_monitor.collector import open_collector
from backend.bili_monitor.source_endpoints import REPLIES_URL

from backend.tests.archive_support import BASE, TARGETS, UID, detail_json, readable_html, set_specified
from backend.tests.collector_clock import ControlledClock
from backend.tests.archive_support import archive_client
from backend.tests.management_support import client_for, enable, profile_response
from backend.tests.root_support import prepare
from backend.tests.test_replies import reply_source


FIXTURES = Path(__file__).parent / "fixtures"
ROOT_ID = "900719925474099312346"
PICTURE = "https://i0.hdslb.com/bfs/new/first.png"


@contextlib.contextmanager
def captured_logs():
    """捕获采集 logger 的实际输出（生产只有一个 stderr handler，这里另挂一个观察者）。"""
    messages = []

    class Handler(logging.Handler):
        def emit(self, record):
            messages.append(record.getMessage())

    logger = logging.getLogger("bili_monitor.collector")
    handler = Handler()
    logger.addHandler(handler)
    try:
        yield messages
    finally:
        logger.removeHandler(handler)


class _Response:
    def __init__(self, response, request):
        self.status_code = response.status_code
        self.content = response.content
        self.headers = dict(response.headers)
        self.url = str(request.url)

    def close(self):
        pass


class Uploader:
    def __init__(self):
        self.uploads = []

    async def upload(self, key, content, content_type):
        self.uploads.append(key)
        return f"https://oss.example.invalid/{key}"


def page_upstream(state):
    """完整归档链的虚构来源：正文可读、两个根、五个回复、一张受信图片。"""
    replies = reply_source(state)

    def source(request):
        if request.url.path == "/x/v2/reply/count":
            return httpx.Response(200, json={"code": 0, "data": {"count": 2}})
        return replies(request)

    def handler(request):
        if request.url.host == "www.bilibili.com":
            return httpx.Response(200, text=readable_html(
                id=request.url.path.rsplit("/", 1)[-1],
                pictures=[{"url": PICTURE, "width": 640, "height": 480}]))
        if request.url.path == "/x/polymer/web-dynamic/v1/detail":
            payload = detail_json()
            payload["data"]["item"]["basic"].update(comment_id_str="99123", rid_str="99123")
            payload["data"]["item"]["modules"]["module_dynamic"]["major"]["opus"]["pics"] = []
            payload["data"]["item"]["modules"]["module_stat"]["comment"]["count"] = 7
            return httpx.Response(200, json=payload)
        return source(request)

    return handler


def root_payload_without_comment_pictures():
    """根评论固件带一张不可信评论图；本票只验证动态图片链路，去掉评论图片避免噪声。"""
    payload = json.loads((FIXTURES / "root-comments.json").read_text())
    for item in payload["data"]["replies"]:
        item["content"].pop("pictures", None)
        item["content"].pop("picture", None)
    return payload


def run_initial(path, monkeypatch, state):
    state.setdefault("payload", root_payload_without_comment_pictures())
    upstream = page_upstream(state)
    uploader = Uploader()

    def comment_get(session, url, params=None, headers=None, timeout=None, **kwargs):
        request = httpx.Request("GET", url, params=params)
        if request.url.path.startswith("/x/"):
            return _Response(upstream(request), request)
        return _Response(httpx.Response(200, text=""), request)

    async def http_send(transport, request):
        if request.url.path == "/x/web-interface/card":
            return profile_response(request)
        return upstream(request)

    def image(request):
        return httpx.Response(200, content=b"\x89PNG fake", headers={"content-type": "image/png"})

    monkeypatch.setattr(requests.Session, "get", comment_get)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", http_send)
    with TestClient(create_app(path, media_transport=httpx.MockTransport(image),
                               media_uploader=uploader)) as api:
        prepare(api)
        assert api.post("/api/sync/initial", json={"uid": UID}).status_code == 200
    return uploader


def events(messages, name):
    return [message for message in messages if message.split(" ", 1)[0] == name]


def test_initial_archive_logs_business_ids_pages_and_waits(tmp_path, monkeypatch):
    with captured_logs() as messages:
        run_initial(tmp_path / "logs.sqlite", monkeypatch, {})
    text = "\n".join(messages)
    # 正文、根页、楼中楼页、媒体与整轮结果都能串起来。
    body = events(messages, "body_sync_finished")
    assert body and f'uid="{UID}"' in body[0] and 'dynamic_id="123"' in body[0]
    root_page = events(messages, "root_page_saved")
    assert root_page and f'uid="{UID}"' in root_page[0]
    assert 'dynamic_id="123"' in root_page[0] and "page=1" in root_page[0]
    assert f'comment_ids=["{ROOT_ID}"' in root_page[0]
    fetched = events(messages, "reply_page_fetched")
    assert [line.split(" page=")[1].split(" ")[0] for line in fetched] == ["1", "2", "2"]
    for line in fetched:
        assert f'root_id="{ROOT_ID}"' in line and 'dynamic_id="123"' in line
        assert "direction=forward" in line and "endpoint_type=replies" in line
        wait_ms = int(line.split("wait_ms=")[1].split(" ")[0])
        assert 100 <= wait_ms <= 200 and "elapsed_ms=" in line
        assert 'reply_ids=[' in line
    assert 'reply_ids=["900719925474099312350"' in fetched[0]
    saved = events(messages, "reply_page_saved")
    # 07 起页提交结果沿用根页的 `checkpoint=accepted`，不再另设 accepted=true。
    assert saved and "new=" in saved[0] and "updated=" in saved[0] and "checkpoint=accepted" in saved[0]
    media = events(messages, "media_sync_finished")
    assert media and 'dynamic_id="123"' in media[0]
    assert "processed=1" in media[0] and "succeeded=1" in media[0]
    # 每页一条批量 ID，不为每条回复单独刷 INFO。
    assert len(fetched) == 3
    assert not any("message=" in line or "reply_text" in line for line in messages)
    # 脱敏负向断言：Cookie、正文、完整 URL、内部领取令牌都不进日志。
    assert "http://" not in text and "https://" not in text
    assert "FICTIONAL" not in text
    assert "已有回复" not in text and "虚构全文" not in text
    assert "token=" not in text


def test_long_reply_page_splits_ids_into_chunks_without_dropping_any(tmp_path, monkeypatch):
    template = json.loads((FIXTURES / "replies.json").read_text())["data"]["replies"][0]
    dynamic_ids = [f"90071992547409{index:05d}" for index in range(1, 21)]
    state = {"replies": []}
    for index, id in enumerate(dynamic_ids):
        item = json.loads(json.dumps(template))
        item.update(rpid_str=id, parent_str=ROOT_ID)
        item["content"]["message"] = f"回复 {index}"
        state["replies"].append(item)
    with captured_logs() as messages:
        run_initial(tmp_path / "chunks.sqlite", monkeypatch, state)
    fetched = events(messages, "reply_page_fetched")
    first = [line for line in fetched if "page=1 " in line]
    assert len(first) == 2, "一页 20 条长 ID 必须分块而不是静默截断"
    ids = []
    for line in first:
        assert "ids_chunks=2" in line and "ids_total=20" in line
        match = re.search(r"reply_ids=\[([^\]]*)\]", line)
        ids.extend(re.findall(r'"([0-9]+)"', match.group(1)))
    assert sorted(ids) == sorted(dynamic_ids)


def test_collector_logs_uid_claims_and_round_result(tmp_path, monkeypatch):
    path = tmp_path / "collector.sqlite"
    with client_for(path) as api:
        assert api.post(BASE, json={"uid": "101"}).status_code == 201
        enable(api, "101")
    with archive_client(path, page_upstream({})) as api:
        prepare(api)

    source = page_upstream({})

    def feed_page(request):
        name = {None: "page1", "page-2": "page2", "page-3": "empty"}[request.url.params.get("offset")]
        return httpx.Response(200, json=json.loads((FIXTURES / f"recent-feed-{name}.json").read_text()))

    async def http_send(transport, request):
        if request.url.path == "/x/polymer/web-dynamic/v1/feed/space":
            return feed_page(request)
        if request.url.path == "/x/web-interface/card":
            return profile_response(request)
        return source(request)

    def comment_get(session, url, params=None, headers=None, timeout=None, **kwargs):
        request = httpx.Request("GET", url, params=params)
        if request.url.path.startswith("/x/"):
            return _Response(source(request), request)
        return _Response(httpx.Response(200, text=""), request)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", http_send)
    monkeypatch.setattr(requests.Session, "get", comment_get)

    async def scenario():
        async with open_collector(path, clock=ControlledClock(),
                                  media_transport=httpx.MockTransport(
                                      lambda request: httpx.Response(200, content=b"\x89PNG fake",
                                                                    headers={"content-type": "image/png"})),
                                  media_uploader=Uploader()) as collector:
            assert await collector.discover_once("101")
            assert await collector.check_once(UID, "123")
            await collector.execute_pending()

    with captured_logs() as messages:
        asyncio.run(scenario())
    started = events(messages, "discovery_started")
    assert started and 'uid="101"' in started[0]
    finished = events(messages, "discovery_finished")
    assert finished and 'uid="101"' in finished[0] and "dynamic_ids=[" in finished[0]
    check_started = events(messages, "check_started")
    assert check_started and f'uid="{UID}"' in check_started[0] and 'dynamic_id="123"' in check_started[0]
    check_finished = events(messages, "check_finished")
    assert check_finished and 'dynamic_id="123"' in check_finished[0]
    assert 'comment_count_status=observed' in check_finished[0]
    sync_started = events(messages, "sync_started")
    assert sync_started and f'uid="{UID}"' in sync_started[0] and 'dynamic_id="123"' in sync_started[0]
    sync_finished = events(messages, "sync_finished")
    assert sync_finished and 'dynamic_id="123"' in sync_finished[0]
    assert "text=" in sync_finished[0] and "replies=" in sync_finished[0]
    assert events(messages, "reply_page_fetched")
    assert events(messages, "root_page_saved")
    text = "\n".join(messages)
    assert "http://" not in text and "https://" not in text
    assert "token=" not in text and "FICTIONAL" not in text


def test_only_validated_ids_are_accepted_for_log_fields():
    from backend.bili_monitor.collector_logging import source_id, source_ids, source_refs

    assert source_id(123).value == "123"
    assert tuple(source_ids([])) == ()
    assert source_refs(uid="900719925474099312345", dynamic_id="not-an-id", root_id=None) == {
        "uid": source_refs(uid="900719925474099312345")["uid"]}
    for invalid in ("", "0", "00123", "12 3", "１２３", None, 1.5, True):
        try:
            source_id(invalid)
        except ValueError:
            continue
        raise AssertionError(f"{invalid!r} must not be loggable as a business ID")
