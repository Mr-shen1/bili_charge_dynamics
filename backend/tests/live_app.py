"""仅测试使用：固定虚构 card 上游，不绕过生产解析或持久化。

BILI_DATABASE_PATH=/tmp/bili-e2e.sqlite uv run uvicorn \
    backend.tests.live_app:create_app --factory --host 127.0.0.1 --port 8765
"""

import os

import httpx

from backend.bili_monitor.app import create_app as create_management_app

CARDS = {
    "900719925474099312345": {
        "mid": "900719925474099312345",
        "name": "虚构星海",
        "face": "https://example.invalid/star.png",
    },
    "202": {"mid": 202, "name": "虚构晨光", "face": "https://example.invalid/dawn.png"},
}


def profile_transport(request):
    if (
        request.method != "GET"
        or request.url.host != "api.bilibili.com"
        or request.url.path != "/x/web-interface/card"
    ):
        raise RuntimeError("Unexpected test upstream request")
    if request.url.params.get("mid") == "303":
        raise httpx.ConnectError("FICTIONAL_SECRET_LIVE_PROFILE", request=request)
    profile = CARDS.get(request.url.params.get("mid"))
    if profile is None:
        return httpx.Response(
            200, json={"code": -404, "message": "Fictional profile unavailable"}
        )
    return httpx.Response(200, json={"code": 0, "data": {"card": profile}})


def create_app():
    path = os.environ.get("BILI_DATABASE_PATH")
    if not path:
        raise RuntimeError("BILI_DATABASE_PATH is required for the test app")
    return create_management_app(
        path, profile_transport=httpx.MockTransport(profile_transport)
    )
