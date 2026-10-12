"""管理与归档 HTTP 测试共享的虚构公开资料。"""

from contextlib import contextmanager

import httpx
from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app

UID = "900719925474099312345"
BASE = "/api/manage/ups"
DEFAULT_MONITOR = {
    "mode": "recent",
    "recent_n": 10,
    "enabled": True,
    "last_checked_at": None,
    "last_succeeded_at": None,
}


def card(uid=UID, name="虚构星海"):
    return {
        "code": 0,
        "data": {
            "card": {
                "mid": uid,
                "name": name,
                "face": "https://example.invalid/avatar.png",
            }
        },
    }


def profile_response(request):
    assert request.url.host == "api.bilibili.com"
    assert request.url.path == "/x/web-interface/card"
    assert request.method == "GET"
    return httpx.Response(200, json=card(request.url.params["mid"]))


@contextmanager
def client_for(path, handler=profile_response):
    app = create_app(path, profile_transport=httpx.MockTransport(handler))
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client
