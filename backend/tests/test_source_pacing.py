"""30：分页节奏由外部时钟替身观测，不等待真实时间或请求真实上游。"""

import asyncio
import json
from pathlib import Path

import httpx
import requests

from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app
from backend.bili_monitor.collector import Collector, serve
from backend.bili_monitor.source_transport import PacedSourceTransport
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client
from backend.tests.management_support import BASE, UID, client_for, profile_response, enable
from backend.tests.root_support import ARCHIVE, COMMENTS, prepare
from backend.tests.test_replies import REPLIES, reply_source


FIXTURES = Path(__file__).parent / "fixtures"


def test_recent_pagination_waits_before_every_request_through_collector(tmp_path):
    path = tmp_path / "monitor.sqlite"
    with client_for(path) as api:
        assert api.post(BASE, json={"uid": "101"}).status_code == 201
        enable(api, "101")
    events = []

    async def sleep(seconds):
        assert 0.8 <= seconds <= 1.5
        events.append("wait")

    def upstream(request):
        events.append(request.url.params.get("offset", "first"))
        name = {None: "page1", "page-2": "page2", "page-3": "empty"}[request.url.params.get("offset")]
        return httpx.Response(200, json=json.loads((FIXTURES / f"recent-feed-{name}.json").read_text()))

    async def scenario():
        transport = PacedSourceTransport(httpx.MockTransport(upstream), sleep=sleep)
        async with httpx.AsyncClient(transport=transport) as client:
            assert await Collector(Store(path), client).discover_once("101")
    asyncio.run(scenario())
    assert events == ["wait", "first", "wait", "page-2", "wait", "page-3"]
    with archive_client(path) as api:
        state = api.get(f"{BASE}/101/discovery").json()
        assert state["trusted_result"]["exhausted"]
        assert state["current_ids"] == ["9007199254741009", "11", "800", "5"]


def test_root_and_reply_pages_including_tail_confirmation_share_waits(tmp_path):
    events, state = [], {}
    source = reply_source(state)

    async def sleep(seconds):
        assert 0.3 <= seconds <= 0.4
        events.append("wait")

    def upstream(request):
        if request.url.path == "/x/web-interface/card":
            return profile_response(request)
        if request.url.path in ("/x/v2/reply", "/x/v2/reply/reply"):
            events.append((request.url.path, request.url.params["pn"]))
        return source(request)

    path = tmp_path / "monitor.sqlite"
    transport = PacedSourceTransport(httpx.MockTransport(upstream), sleep=sleep)
    with TestClient(create_app(path, profile_transport=transport)) as api:
        prepare(api)
        assert api.post("/api/sync/initial", json={"uid": UID}).status_code == 200
        assert api.get(ARCHIVE).json()["comments_last_attempt"] == "success"
        assert len(api.get(COMMENTS).json()["items"]) == 2
        assert api.get(REPLIES).json()["local_reply_count"] == 5
    assert events == [
        "wait", ("/x/v2/reply", "1"),
        "wait", ("/x/v2/reply", "2"),
        "wait", ("/x/v2/reply", "2"),
        "wait", ("/x/v2/reply/reply", "1"),
        "wait", ("/x/v2/reply/reply", "2"),
        "wait", ("/x/v2/reply/reply", "2"),
    ]


def test_default_api_transport_paces_real_initialization(monkeypatch, tmp_path):
    events, state = [], {}
    source, real_sleep = reply_source(state), asyncio.sleep

    async def sleep(seconds):
        # 评论会话预热随机等 1–3 秒，不是分页节拍。
        if 0.3 <= seconds <= 0.4:
            events.append("wait")
        await real_sleep(0)

    async def upstream(transport, request):
        if request.url.path == "/x/web-interface/card":
            return profile_response(request)
        return source(request)

    class _Response:
        """最小 requests 响应替身：Requests 已解压，_get 会转成 HTTPX 响应。"""

        def __init__(self, response, request):
            self.status_code = response.status_code
            self.content = response.content
            self.headers = dict(response.headers)
            self.url = str(request.url)

        def close(self):
            pass

    def comment_get(session, url, params=None, headers=None, timeout=None, **kwargs):
        request = httpx.Request("GET", url, params=params)
        if request.url.path in ("/x/v2/reply", "/x/v2/reply/reply"):
            events.append("page")
            return _Response(source(request), request)
        # 首页/空间预热：不参与分页节拍断言。
        return _Response(httpx.Response(200, text=""), request)

    # 只替换外部网络与时间，不替换应用的生产客户端装配：
    # 普通来源走 HTTPX 传输，评论根/回复页走 Requests 会话。
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", upstream)
    monkeypatch.setattr(asyncio, "sleep", sleep)
    monkeypatch.setattr(requests.Session, "get", comment_get)
    with TestClient(create_app(tmp_path / "monitor.sqlite")) as api:
        prepare(api)
        assert api.post("/api/sync/initial", json={"uid": UID}).status_code == 200
        assert api.get(ARCHIVE).json()["comments_last_attempt"] == "success"
    assert events == ["wait", "page"] * 6


def test_collector_process_entry_uses_paced_feed_transport(monkeypatch, tmp_path):
    for name in ("ENDPOINT", "REGION", "BUCKET", "ACCESS_KEY_ID", "ACCESS_KEY_SECRET", "SECURITY_TOKEN", "PUBLIC_BASE_URL"):
        monkeypatch.delenv(f"BILI_OSS_{name}", raising=False)
    path = tmp_path / "monitor.sqlite"
    with client_for(path) as api:
        assert api.post(BASE, json={"uid": "101"}).status_code == 201
        enable(api, "101")
    events, real_sleep = [], asyncio.sleep

    async def sleep(seconds):
        if seconds > 0:
            assert 0.8 <= seconds <= 1.5
            events.append("wait")
        await real_sleep(0)

    async def upstream(transport, request):
        offset = request.url.params.get("offset")
        events.append(offset or "first")
        name = {None: "page1", "page-2": "page2", "page-3": "empty"}[offset]
        return httpx.Response(200, json=json.loads((FIXTURES / f"recent-feed-{name}.json").read_text()))

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", upstream)
    monkeypatch.setattr(asyncio, "sleep", sleep)
    asyncio.run(serve(path, once=True))
    assert events == ["wait", "first", "wait", "page-2", "wait", "page-3"]
    with archive_client(path) as api:
        assert api.get(f"{BASE}/101/discovery").json()["status"] == "discovered"


def test_shared_pacing_does_not_serialize_network_or_block_check_signals():
    async def scenario():
        waits, permits = asyncio.Queue(), asyncio.Queue()
        first_sent, network_release = asyncio.Event(), asyncio.Event()

        async def sleep(seconds):
            waits.put_nowait(seconds)
            await permits.get()

        async def upstream(request):
            if request.url.params.get("pn") == "1":
                first_sent.set()
                await network_release.wait()
            return httpx.Response(200, json={"code": 0, "data": {"count": 7}})

        transport = PacedSourceTransport(httpx.MockTransport(upstream), sleep=sleep)
        async with httpx.AsyncClient(transport=transport) as client:
            first = asyncio.create_task(client.get("https://api.bilibili.com/x/v2/reply?pn=1"))
            second = asyncio.create_task(client.get("https://api.bilibili.com/x/v2/reply/reply?pn=2"))
            try:
                assert 0.3 <= await asyncio.wait_for(waits.get(), 2) <= 0.4
                # 翻页还在等待发送机会时，轻量计数检查仍可完成。
                count = await asyncio.wait_for(client.get("https://api.bilibili.com/x/v2/reply/count"), 2)
                assert count.json()["data"]["count"] == 7
                assert waits.empty()
                permits.put_nowait(None)
                await asyncio.wait_for(first_sent.wait(), 2)
                assert 0.3 <= await asyncio.wait_for(waits.get(), 2) <= 0.4
                permits.put_nowait(None)
                # 第一张根页仍等待网络；另一根的楼中楼在独立等待后已经能返回。
                assert (await asyncio.wait_for(second, 2)).status_code == 200
                assert not first.done()
                network_release.set()
                assert (await asyncio.wait_for(first, 2)).status_code == 200
            finally:
                first.cancel()
                second.cancel()
                await asyncio.gather(first, second, return_exceptions=True)
    asyncio.run(scenario())


def test_cancelled_wait_never_sends_and_releases_next_page():
    async def scenario():
        waiting, release, sent = asyncio.Queue(), asyncio.Queue(), []

        async def sleep(seconds):
            waiting.put_nowait(seconds)
            await release.get()

        def upstream(request):
            sent.append(request.url.params["pn"])
            return httpx.Response(200)

        transport = PacedSourceTransport(httpx.MockTransport(upstream), sleep=sleep)
        async with httpx.AsyncClient(transport=transport) as client:
            first = asyncio.create_task(client.get("https://api.bilibili.com/x/v2/reply?pn=1"))
            await asyncio.wait_for(waiting.get(), 2)
            first.cancel()
            assert isinstance((await asyncio.gather(first, return_exceptions=True))[0], asyncio.CancelledError)
            second = asyncio.create_task(client.get("https://api.bilibili.com/x/v2/reply?pn=2"))
            await asyncio.wait_for(waiting.get(), 2)
            assert sent == []
            release.put_nowait(None)
            assert (await asyncio.wait_for(second, 2)).status_code == 200
            assert sent == ["2"]
    asyncio.run(scenario())
