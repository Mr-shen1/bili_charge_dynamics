"""03：API 侧的跨进程风控暂停、状态查询与「暂不可用」契约。"""

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app
from backend.bili_monitor.comment_client import RequestsCommentClient
from backend.bili_monitor.risk import RiskGate
from backend.bili_monitor.source_transport import SourcePacer
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import UID, author_html, detail_json, readable_html
from backend.tests.management_support import BASE, enable, profile_response
from backend.tests.root_support import TARGETS, prepare, source_handler

RISK = "/api/manage/risk"
PAUSED_MESSAGE = "B 站来源保护中，需要访问来源的操作暂不可用"


class Source:
    """受控上游：记录每次真实发送；按「主机＋路径」配置返回 412／429／业务错误。"""

    def __init__(self, state=None):
        self.state = state if state is not None else {}
        self.sent = []
        roots = source_handler(self.state)

        def upstream(request):
            self.sent.append((request.url.host, request.url.path))
            armed = self.state.get("risk", {}).get(request.url.path)
            if armed is not None:
                return httpx.Response(armed, text="")
            failure = self.state.get("fail", {}).get(request.url.path)
            if isinstance(failure, Exception):
                raise failure
            if failure is not None:
                return httpx.Response(failure, text="")
            if request.url.path == "/x/web-interface/card":
                return profile_response(request)
            business = self.state.get("business", {}).get(request.url.path)
            if business is not None:
                return httpx.Response(200, json={"code": business})
            return roots(request)

        self.upstream = upstream

    def count(self, path=None):
        return len([item for item in self.sent if path is None or item[1] == path])


def paused_app(path, source, **kwargs):
    app = create_app(path, profile_transport=httpx.MockTransport(source.upstream), **kwargs)
    return app


def test_http_412_on_one_entry_pauses_every_other_source_entry(tmp_path):
    source = Source()
    with TestClient(paused_app(tmp_path / "risk.sqlite", source)) as client:
        assert client.post(BASE, json={"uid": UID}).status_code == 201
        assert client.get(RISK).json()["state"] == "normal"
        source.state["risk"] = {"/opus/123": 412}

        # 触发的那次操作同样明确暂不可用：它没有完成，也不返回伪成功统计。
        triggered = client.post(TARGETS, json={"id": "123"})
        assert (triggered.status_code, triggered.json()["error"]["code"]) == (503, "SOURCE_RISK_PAUSED")

        status = client.get(RISK).json()
        assert status["state"] == "cooldown"
        assert status["backoff_step"] == 1
        assert status["last_trigger"] == {
            "endpoint_type": "opus_page", "http_status": 412, "at": status["last_trigger"]["at"],
        }
        sent = len(source.sent)

        # 另一个入口在真正需要来源时明确返回暂不可用，且不再发送任何请求。
        blocked = client.post(TARGETS, json={"id": "123"})
        assert blocked.status_code == 503
        assert blocked.json()["error"] == {
            "code": "SOURCE_RISK_PAUSED", "message": PAUSED_MESSAGE,
            "state": "cooldown", "backoff_step": 1, "next_probe_at": status["next_probe_at"],
        }
        assert 1 <= int(blocked.headers["Retry-After"]) <= 60
        assert len(source.sent) == sent
        # 没有半成品：目标没有被关联，列表仍是空的。
        assert client.get(TARGETS).json()["targets"] == []


def test_http_429_also_pauses_and_keeps_the_trigger_endpoint_type(tmp_path):
    source = Source()
    with TestClient(paused_app(tmp_path / "risk.sqlite", source)) as client:
        assert client.post(BASE, json={"uid": UID}).status_code == 201
        source.state["risk"] = {"/opus/123": 429}
        assert client.post(TARGETS, json={"id": "123"}).status_code == 503

        status = client.get(RISK).json()
        assert status["state"] == "cooldown"
        assert status["last_trigger"]["http_status"] == 429
        assert status["last_trigger"]["endpoint_type"] == "opus_page"


def test_risk_status_is_read_only_and_never_triggers_collection(tmp_path):
    source = Source()
    with TestClient(paused_app(tmp_path / "risk.sqlite", source)) as client:
        assert client.post(BASE, json={"uid": UID}).status_code == 201
        sent = len(source.sent)

        first = client.get(RISK)
        assert first.status_code == 200
        body = first.json()
        assert body["state"] == "normal"
        assert body["backoff_step"] == 0
        assert body["next_probe_at"] is None
        assert body["observing_since"] is None
        assert body["last_trigger"] is None
        assert body["probe"] == {"round": None, "results": []}
        assert isinstance(body["since"], str) and body["since"]
        assert client.get(RISK).json() == body
        assert len(source.sent) == sent

        # 只读接口不接受 query 与可写字段（沿用既有 HTTP 错误映射：非本入口方法即 INVALID_INPUT）。
        assert client.get(RISK + "?state=normal").status_code == 422
        assert client.post(RISK, json={"state": "normal"}).status_code == 422
        serialized = json.dumps(body)
        for forbidden in ("owner", "lease", "claim", "token", "http://", "https://"):
            assert forbidden not in serialized


def test_manual_sync_mid_chain_pauses_without_fake_statistics(tmp_path):
    source = Source()
    with TestClient(paused_app(tmp_path / "risk.sqlite", source)) as client:
        prepare(client)
        source.state["risk"] = {"/x/v2/reply": 412}
        sent = len(source.sent)

        blocked = client.post("/api/sync/initial", json={"uid": UID})
        assert blocked.status_code == 503
        assert blocked.json()["error"]["code"] == "SOURCE_RISK_PAUSED"
        # 不返回伪成功统计：响应体里没有 processed／succeeded／failed。
        assert set(blocked.json()["error"]) == {"code", "message", "state", "backoff_step", "next_probe_at"}

        # 触发那一次之后不再翻页、不再重试：账本停在 412 的那次根页发送。
        paths = [path for _, path in source.sent]
        assert paths.count("/x/v2/reply") == 1
        assert paths[-1] == "/x/v2/reply"
        assert "/x/v2/reply/reply" not in paths
        assert len(source.sent) > sent

        archive = client.get("/api/archive/dynamics/123").json()
        # 风控不是「来源失败」：已提交正文保留，评论分项保持 pending 而非 failed。
        assert archive["work"]["comments"] == "pending"
        assert archive["work"]["replies"] == "pending"
        assert archive["comments_error"] is None and archive["replies_error"] is None

        after_trigger = len(source.sent)
        retry = client.post("/api/sync/initial", json={"uid": UID})
        assert retry.status_code == 503
        assert len(source.sent) == after_trigger


def test_local_reading_management_and_downloaded_media_stay_available_while_paused(tmp_path):
    source = Source()
    uploads = []

    class Uploader:
        async def upload(self, key, content, content_type):
            uploads.append(key)
            return "https://archive.example.invalid/" + key

    def download(request):
        return httpx.Response(200, content=b"fictional image bytes", headers={"Content-Type": "image/png"})

    pictures = [{"url": "https://i0.hdslb.com/bfs/new/first.png", "width": 640, "height": 480}]

    def upstream(request):
        if request.url.host == "www.bilibili.com" and request.url.path.startswith("/opus/"):
            return httpx.Response(200, text=readable_html(pictures=pictures))
        return source.upstream(request)

    app = create_app(tmp_path / "risk.sqlite", profile_transport=httpx.MockTransport(upstream),
                     media_transport=httpx.MockTransport(download), media_uploader=Uploader())
    with TestClient(app) as client:
        prepare(client)
        assert client.post("/api/sync/initial", json={"uid": UID}).status_code == 200
        assert len(uploads) == 1

        source.state["risk"] = {"/x/v2/reply": 412}
        assert client.post("/api/sync/initial", json={"uid": UID}).status_code == 503
        sent = len(source.sent)

        # 已下载数据提交与 OSS 上传不受暂停影响：全部成功时本地结算返回零处理。
        assert client.post("/api/sync/media/123").json() == {"processed": 0, "succeeded": 0, "failed": 0}
        # 归档阅读、纯本地管理与通知开关继续可用。
        assert client.get("/api/archive/dynamics/123").status_code == 200
        assert client.get("/api/manage/ups").status_code == 200
        assert client.put("/api/manage/notifications", json={"state": "system_only"}).status_code == 200
        assert client.delete(BASE + "/" + UID + "/monitor").status_code == 204
        assert len(source.sent) == sent
        assert len(uploads) == 1


def test_risk_response_during_image_download_keeps_completed_images(tmp_path):
    source = Source()
    uploads, downloads = [], []
    pictures = [{"url": "https://i0.hdslb.com/bfs/new/first.png", "width": 640, "height": 480},
                {"url": "https://i1.hdslb.com/bfs/new/second.png", "width": 640, "height": 480}]
    state = {"risk_media": False}

    class Uploader:
        async def upload(self, key, content, content_type):
            uploads.append(key)
            return "https://archive.example.invalid/" + key

    def download(request):
        downloads.append(str(request.url))
        if state["risk_media"] and request.url.host == "i1.hdslb.com":
            return httpx.Response(412, text="")
        return httpx.Response(200, content=b"fictional image bytes", headers={"Content-Type": "image/png"})

    def upstream(request):
        if request.url.host == "www.bilibili.com" and request.url.path.startswith("/opus/"):
            return httpx.Response(200, text=readable_html(pictures=pictures))
        return source.upstream(request)

    app = create_app(tmp_path / "risk.sqlite", profile_transport=httpx.MockTransport(upstream),
                     media_transport=httpx.MockTransport(download), media_uploader=Uploader())
    with TestClient(app) as client:
        prepare(client)
        state["risk_media"] = True
        blocked = client.post("/api/sync/initial", json={"uid": UID})
        assert blocked.status_code == 503
        # 已取得的第一张图仍安全提交并上传；第二张保持 pending，不记成下载失败。
        assert len(uploads) == 1 and uploads[0].endswith(".png")
        media = client.get("/api/archive/dynamics/123").json()["media"]
        assert [item["status"] for item in media] == ["success", "pending"]
        assert all(item.get("error") is None for item in media)
        assert client.get(RISK).json()["last_trigger"]["endpoint_type"] == "image_hdslb"

        # 重试不再发送：图片下载同样不能绕过保护。
        before = list(downloads)
        retry = client.post("/api/sync/media/123")
        assert retry.status_code == 503
        assert downloads == before
        assert len(uploads) == 1


def test_input_validation_and_local_conflicts_still_win_while_paused(tmp_path):
    source = Source()
    with TestClient(paused_app(tmp_path / "risk.sqlite", source)) as client:
        prepare(client)
        source.state["risk"] = {"/x/v2/reply": 412}
        assert client.post("/api/sync/initial", json={"uid": UID}).status_code == 503
        sent = len(source.sent)

        assert client.post(BASE, json={"uid": "not-a-uid"}).status_code == 422
        assert client.patch(BASE + "/" + UID + "/monitor",
                            json={"mode": "recent", "recent_n": 0, "enabled": True}).status_code == 422
        assert client.post(BASE, json={"uid": UID}).json()["error"]["code"] == "ALREADY_MONITORED"
        assert client.get(BASE + "/404/targets").status_code == 404
        assert len(source.sent) == sent


def test_state_storage_failure_blocks_sends_and_reports_storage_error(tmp_path):
    source = Source()
    path = tmp_path / "risk.sqlite"
    with TestClient(paused_app(path, source)) as client:
        store = Store(path)
        with store.connection() as connection:
            connection.execute("DROP TABLE source_risk")
            connection.commit()
        sent = len(source.sent)

        blocked = client.post(BASE, json={"uid": UID})
        assert blocked.status_code == 503
        assert blocked.json()["error"]["code"] == "STORAGE_UNAVAILABLE"
        assert client.get(RISK).json()["error"]["code"] == "STORAGE_UNAVAILABLE"
        # 状态不可读写时不降级放行：没有任何上游发送。
        assert len(source.sent) == sent


def test_business_code_and_ordinary_errors_do_not_pause(tmp_path):
    source = Source()
    with TestClient(paused_app(tmp_path / "risk.sqlite", source)) as client:
        prepare(client)
        # 业务码 -412 是 HTTP 200 的 JSON 字段，不是 HTTP 状态，不触发保护。
        source.state["business"] = {"/x/v2/reply": -412}
        assert client.post("/api/sync/initial", json={"uid": UID}).json() == {
            "processed": 1, "succeeded": 0, "failed": 1,
        }
        assert client.get(RISK).json()["state"] == "normal"

        # 普通服务端错误、网络失败与超时同样不扩大成风控。
        source.state["business"] = {}
        source.state["fail"] = {"/x/v2/reply": 500}
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["failed"] == 1
        assert client.get(RISK).json()["state"] == "normal"

        source.state["fail"] = {"/x/v2/reply": httpx.ReadError("FICTIONAL_SECRET")}
        assert client.post("/api/sync/initial", json={"uid": UID}).json()["failed"] == 1
        assert client.get(RISK).json()["state"] == "normal"
        assert "FICTIONAL_SECRET" not in json.dumps(client.get(RISK).json())


class TransportResponse:
    """最小 requests 响应替身：保留 Requests 自己解析重定向所需字段。"""

    reason = "OK"
    encoding = "utf-8"
    raw = None

    def __init__(self, status_code, request, headers=None, content=b""):
        import requests
        self.status_code, self.request, self.url = status_code, request, request.url
        self.headers = requests.structures.CaseInsensitiveDict(headers or {})
        self.content, self.closed, self.history = content, False, []

    @property
    def is_redirect(self):
        import requests
        return "location" in self.headers and self.status_code in requests.sessions.REDIRECT_STATI

    def close(self):
        self.closed = True


def test_warmup_risk_response_pauses_and_stops_the_second_warmup(tmp_path, monkeypatch):
    import requests

    store = Store(tmp_path / "risk.sqlite")
    store.migrate()
    gate = RiskGate(store)
    client = RequestsCommentClient(UID, (), SourcePacer(sleep=_no_wait), gate=gate)
    sent = []

    async def sleep(seconds):
        await asyncio.sleep(0)

    def send(adapter, request, **kwargs):
        sent.append(request.url.split("?")[0])
        return TransportResponse(412, request, {"Content-Type": "text/html"}, b"")

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    monkeypatch.setattr(asyncio, "sleep", sleep)
    asyncio.run(client.prepare())

    # 预热仍 best-effort 不抛异常，但风控在吞异常之前被记录。
    assert gate.status()["state"] == "cooldown"
    assert gate.status()["last_trigger"]["endpoint_type"] == "homepage_warmup"
    # 触发后不再继续预热第二个入口。
    assert sent == ["https://www.bilibili.com/"]


async def _no_wait(seconds):
    return None
