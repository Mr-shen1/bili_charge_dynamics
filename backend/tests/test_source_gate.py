"""统一 B 站源发送入口：真实 API／collector 装配 + 外部传输替身账本。"""

import asyncio
import json
from pathlib import Path

import httpx
import requests
from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app
from backend.bili_monitor.collector import open_collector
from backend.bili_monitor.comment_client import RequestsCommentClient
from backend.bili_monitor.source_endpoints import REPLIES_URL, ROOT_COMMENTS_URL
from backend.bili_monitor.source_gate import GatedAsyncTransport, endpoint_type, source_request
from backend.bili_monitor.source_transport import SourcePacer
from backend.tests.archive_support import archive_client, detail_json, readable_html
from backend.tests.collector_clock import ControlledClock
from backend.tests.management_support import BASE, UID, card, client_for, enable, profile_response
from backend.tests.root_support import prepare
from backend.tests.test_replies import reply_source


class LedgerGate:
    """记录发送许可与结果报告；不改变发送，也不保存 URL、Cookie 或响应正文。"""

    def __init__(self):
        self.events = []

    async def permit(self, request):
        self.events.append(("permit", request.endpoint_type, request.method))

    async def report(self, request, report):
        self.events.append(("report", request.endpoint_type, report.status_code))

    def permitted(self):
        return [event[1] for event in self.events if event[0] == "permit"]

    def reported(self):
        return [(event[1], event[2]) for event in self.events if event[0] == "report"]


class LedgerTransport(httpx.AsyncBaseTransport):
    """最内层账本传输：记录实际发出的请求，证明没有请求绕过许可、也没有多余发送。"""

    def __init__(self, handler):
        self.handler = handler
        self.sent = []

    async def handle_async_request(self, request):
        classified = source_request(request.method, request.url)
        self.sent.append(classified.endpoint_type if classified is not None else None)
        return self.handler(request)


def test_up_profile_request_goes_through_unified_entry(tmp_path):
    gate = LedgerGate()

    def upstream(request):
        assert request.url.path == "/x/web-interface/card"
        return httpx.Response(200, json=card(request.url.params["mid"]))

    app = create_app(tmp_path / "gate.sqlite", profile_transport=httpx.MockTransport(upstream),
                     source_gate=gate)
    with TestClient(app) as client:
        assert client.post(BASE, json={"uid": UID}).status_code == 201
    assert gate.events == [("permit", "profile", "GET"), ("report", "profile", 200)]


def test_initial_archive_sends_every_source_request_through_gate(tmp_path):
    gate, state = LedgerGate(), {}
    source = reply_source(state)

    def upstream(request):
        if request.url.path == "/x/web-interface/card":
            return profile_response(request)
        return source(request)

    transport = LedgerTransport(upstream)
    app = create_app(tmp_path / "gate.sqlite", profile_transport=transport, source_gate=gate)
    with TestClient(app) as client:
        prepare(client)
        assert client.post("/api/sync/initial", json={"uid": UID}).status_code == 200

    # 评论计数不在显式初始化链上（它属于固定检查），由采集进程用例覆盖。
    expected = ["profile", "opus_page", "opus_page", "detail"]
    expected += ["root_comments"] * 3 + ["replies"] * 3
    # 传输层发送顺序就是许可顺序：没有请求绕过入口，入口也没有凭空放行。
    assert transport.sent == expected
    assert gate.permitted() == expected
    # 每次发送只报告一次结果，正常成功不改变既有错误处理。
    assert gate.reported() == [(kind, 200) for kind in expected]


class TransportResponse:
    """最小 requests 响应替身：保留 Requests 自己解析重定向所需字段。"""

    reason = "OK"
    encoding = "utf-8"
    raw = None

    def __init__(self, status_code, request, headers=None, content=b""):
        self.status_code = status_code
        self.request = request
        self.url = request.url
        self.headers = requests.structures.CaseInsensitiveDict(headers or {})
        self.content = content
        self.closed = False
        self.history = []

    @property
    def is_redirect(self):
        return "location" in self.headers and self.status_code in requests.sessions.REDIRECT_STATI

    def close(self):
        self.closed = True


def test_requests_comment_session_gates_every_page_and_redirect_hop(monkeypatch):
    gate, waits, pages = LedgerGate(), [], []

    async def sleep(seconds):
        waits.append(seconds)

    client = RequestsCommentClient(UID, (), SourcePacer(sleep=sleep), gate=gate)

    def send(adapter, request, **kwargs):
        target = request.url.split("?")[0]
        pages.append(target)
        if target == ROOT_COMMENTS_URL:
            # Requests 自己解析受信域内的跳转：每一跳都重新进入安装点。
            return TransportResponse(302, request, {"Location": REPLIES_URL})
        return TransportResponse(200, request, {"Content-Type": "application/json"}, b'{"code": 0}')

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    response = asyncio.run(client.get(ROOT_COMMENTS_URL, params={"oid": "99123", "type": 17, "pn": 1}))

    assert response.status_code == 200
    assert pages == [ROOT_COMMENTS_URL, REPLIES_URL]
    # 跳转的后续发送同样先取许可、返回后报告，不只看最外层调用。
    assert gate.permitted() == ["root_comments", "replies"]
    # 最终响应由跟随它的那一跳报告一次，外层不重复计数；中间 3xx 不当作独立结果。
    assert gate.reported() == [("replies", 200)]
    # 既有分页等待仍是每次调用一次，不因新增入口重复等待。
    assert len(waits) == 1 and 0.3 <= waits[0] <= 0.4


def _json_response(request, payload, status_code=200):
    return TransportResponse(status_code, request, {"Content-Type": "application/json"},
                             json.dumps(payload).encode())


def test_warmup_swallow_still_reports_result_to_gate(monkeypatch):
    """预热仍是 best-effort（不抛异常），但 412／429 不会被吞进日志就算完。"""
    gate, waits = LedgerGate(), []
    real_sleep = asyncio.sleep

    async def sleep(seconds):
        waits.append(seconds)
        await real_sleep(0)

    client = RequestsCommentClient(UID, (), SourcePacer(sleep=sleep), gate=gate)

    def send(adapter, request, **kwargs):
        return TransportResponse(412, request, {"Content-Type": "text/html"}, b"")

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    monkeypatch.setattr(asyncio, "sleep", sleep)
    asyncio.run(client.prepare())

    # 先报告再交给原 best-effort 处理：预热没抛异常，风控也能看到 412。
    assert gate.permitted() == ["homepage_warmup", "space_warmup"]
    assert gate.reported() == [("homepage_warmup", 412), ("space_warmup", 412)]
    # 预热原有的 1–3 秒间隔没有变化，也没有被入口复制。
    assert len(waits) == 2 and all(1 <= value <= 3 for value in waits)


def test_http_error_response_is_reported_before_business_error_handling(tmp_path):
    gate, state = LedgerGate(), {}
    source = reply_source(state)

    def upstream(request):
        if request.url.path == "/x/v2/reply":
            return httpx.Response(412, text="")
        return source(request)

    with archive_client(tmp_path / "gate.sqlite", upstream, gate=gate) as client:
        prepare(client)
        # 既有失败分类与统计口径不变：拦截仍是本目标的失败，不改判成别的错误。
        assert client.post("/api/sync/initial", json={"uid": UID}).json() == {
            "processed": 1, "succeeded": 0, "failed": 1,
        }
    assert ("root_comments", 412) in gate.reported()


FIXTURES = Path(__file__).parent / "fixtures"


def test_collector_assembly_sends_every_source_request_through_gate(tmp_path, monkeypatch):
    """采集进程同样只经统一入口：发现、检查、归档与评论页都记录在案。"""
    path = tmp_path / "collector.sqlite"
    with client_for(path) as api:
        assert api.post(BASE, json={"uid": "101"}).status_code == 201
        enable(api, "101")
    state = {}
    with archive_client(path, reply_source(state)) as api:
        prepare(api)

    gate, sent, waits = LedgerGate(), [], []
    real_sleep = asyncio.sleep

    async def sleep(seconds):
        waits.append(seconds)
        await real_sleep(0)

    def feed_page(request):
        offsets = {None: "page1", "page-2": "page2", "page-3": "empty"}
        name = offsets[request.url.params.get("offset")]
        return httpx.Response(200, json=json.loads((FIXTURES / f"recent-feed-{name}.json").read_text()))

    async def http_send(transport, request):
        sent.append(source_request(request.method, request.url).endpoint_type)
        if request.url.path == "/x/polymer/web-dynamic/v1/feed/space":
            return feed_page(request)
        if request.url.path.startswith("/opus/"):
            return httpx.Response(200, text=readable_html(id=request.url.path.rsplit("/", 1)[-1], pictures=[])
                                  .replace('"count":7', '"count":0'))
        payload = detail_json()
        payload["data"]["item"]["id_str"] = request.url.params["id"]
        payload["data"]["item"]["basic"].update(comment_id_str="99123", rid_str="99123")
        payload["data"]["item"]["modules"]["module_stat"]["comment"]["count"] = 0
        payload["data"]["item"]["modules"]["module_dynamic"]["major"]["opus"]["pics"] = []
        return httpx.Response(200, json=payload)

    def requests_send(adapter, request, **kwargs):
        sent.append(source_request(request.method, request.url).endpoint_type)
        target = request.url.split("?")[0]
        if target == "https://api.bilibili.com/x/v2/reply/count":
            return _json_response(request, {"code": 0, "data": {"count": 0}})
        if target == ROOT_COMMENTS_URL:
            return _json_response(request, {"code": 0, "data": {
                "page": {"num": 1, "size": 20, "count": 0, "acount": 0}, "replies": []}})
        return TransportResponse(200, request, {"Content-Type": "text/html"}, b"")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", http_send)
    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", requests_send)
    monkeypatch.setattr(asyncio, "sleep", sleep)

    async def scenario():
        async with open_collector(path, source_gate=gate, clock=ControlledClock()) as collector:
            assert await collector.discover_once("101")
            assert await collector.check_once(UID, "123")
            await collector.execute_pending()

    asyncio.run(scenario())

    expected = ["feed", "feed", "feed"]
    expected += ["opus_page", "detail", "homepage_warmup", "space_warmup", "comment_count"]
    expected += ["opus_page", "detail", "root_comments"]
    # 采集进程的每一次真实发送都先取许可、返回后报告，没有第二条通道。
    assert sent == expected
    assert gate.permitted() == expected
    assert gate.reported() == [(kind, 200) for kind in expected]
    # 既有等待没有被入口复制：刚好六次——feed 三页、会话预热两页、根页一次。
    assert len(waits) == 6
    assert all(0.8 <= value <= 1.5 for value in waits[:3])
    assert all(1 <= value <= 3 for value in waits[3:5])
    assert 0.3 <= waits[5] <= 0.4


def test_source_endpoint_types_follow_host_and_path_template():
    cases = {
        ("api.bilibili.com", "/x/v2/reply"): "root_comments",
        ("api.bilibili.com", "/x/v2/reply/reply"): "replies",
        ("api.bilibili.com", "/x/v2/reply/count"): "comment_count",
        ("api.bilibili.com", "/x/polymer/web-dynamic/v1/feed/space"): "feed",
        ("api.bilibili.com", "/x/polymer/web-dynamic/v1/detail"): "detail",
        ("api.bilibili.com", "/x/web-interface/card"): "profile",
        ("www.bilibili.com", "/"): "homepage_warmup",
        ("www.bilibili.com", "/opus/123"): "opus_page",
        ("space.bilibili.com", "/202/dynamic"): "space_warmup",
        ("i0.hdslb.com", "/bfs/new/first.png"): "media_image",
        # 非 B 站来源（OSS 交付、投递地址等）不受源站许可控制。
        ("example.invalid", "/x/v2/reply"): None,
        ("archive.example.invalid", "/bucket/key"): None,
    }
    for (host, path), expected in cases.items():
        assert endpoint_type(host, path) == expected
    # 资源 ID 与页码都在 query 里：同一路径模板不因 ID／页号产生新类型。
    request = source_request("GET", "https://api.bilibili.com/x/v2/reply?oid=99123&type=17&pn=2")
    assert (request.endpoint_type, request.method, request.host, request.path) == (
        "root_comments", "GET", "api.bilibili.com", "/x/v2/reply")


def test_media_download_is_gated_while_upload_and_local_reads_are_not(tmp_path):
    gate, uploads = LedgerGate(), []
    pictures = [{"url": "https://i0.hdslb.com/bfs/new/first.png", "width": 640, "height": 480}]

    class Uploader:
        async def upload(self, key, content, content_type):
            assert content == b"fictional image bytes"
            uploads.append(key)
            return "https://archive.example.invalid/" + key

    def upstream(request):
        if request.url.path == "/x/web-interface/card":
            return profile_response(request)
        if request.url.host == "www.bilibili.com":
            return httpx.Response(200, text=readable_html(pictures=pictures))
        if request.url.path == "/x/v2/reply":
            return httpx.Response(200, json={"code": 0, "data": {
                "page": {"num": 1, "size": 20, "count": 0, "acount": 0}, "replies": []}})
        return httpx.Response(200, json=detail_json())

    state = {"download_ok": False}

    def download(request):
        assert request.url.host == "i0.hdslb.com"
        if not state["download_ok"]:
            return httpx.Response(503)
        return httpx.Response(200, content=b"fictional image bytes",
                              headers={"Content-Type": "image/png"})

    app = create_app(tmp_path / "media.sqlite", profile_transport=httpx.MockTransport(upstream),
                     media_transport=httpx.MockTransport(download), media_uploader=Uploader(),
                     source_gate=gate)
    with TestClient(app) as client:
        prepare(client)
        assert client.post("/api/sync/initial", json={"uid": UID}).status_code == 200
        # 手动媒体重试复用同一入口，不另造只供 collector 使用的通道。
        state["download_ok"] = True
        assert client.post("/api/sync/media/123").json() == {"processed": 1, "succeeded": 1, "failed": 0}
        after_sync = len(gate.events)
        assert client.get("/api/archive/dynamics/123").status_code == 200
    # 图片下载走独立 client，但仍先取许可、返回后报告（含失败与手动重试）。
    assert gate.permitted().count("media_image") == 2
    assert ("media_image", 200) in gate.reported()
    assert len(uploads) == 1
    # 阅读 GET 只读本地归档：没有任何上游发送，因此也没有新的许可或报告。
    assert len(gate.events) == after_sync


def test_httpx_transport_gates_each_redirect_hop():
    """跟随跳转时，每一跳都重新经过同一接入点，不只观察最外层调用。"""
    gate, hops = LedgerGate(), []

    def upstream(request):
        hops.append(request.url.path)
        if request.url.path == "/x/v2/reply":
            return httpx.Response(302, headers={"Location": "https://api.bilibili.com/x/v2/reply/reply"})
        return httpx.Response(200, json={"code": 0})

    async def scenario():
        async with httpx.AsyncClient(transport=GatedAsyncTransport(httpx.MockTransport(upstream), gate=gate),
                                     follow_redirects=True) as client:
            response = await client.get(ROOT_COMMENTS_URL, params={"oid": "99123", "type": 17, "pn": 1})
            assert response.status_code == 200

    asyncio.run(scenario())
    assert hops == ["/x/v2/reply", "/x/v2/reply/reply"]
    assert gate.permitted() == ["root_comments", "replies"]
    assert gate.reported() == [("root_comments", 302), ("replies", 200)]
