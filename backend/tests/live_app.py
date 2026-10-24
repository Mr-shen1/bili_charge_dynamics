"""仅测试使用：固定虚构上游（UP 资料、动态正文、空根评论页），不绕过生产解析或持久化。

BILI_DATABASE_PATH=/tmp/bili-e2e.sqlite uv run uvicorn \
    backend.tests.live_app:create_app --factory --host 127.0.0.1 --port 8765
"""

import json
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
    "707": {"mid": "707", "name": "虚构晚风", "face": "https://example.invalid/dusk.png"},
    # 目标归属校验用例里的「别的作者」，不作为可新增的监控目标。
    "555": {"mid": "555", "name": "虚构他人", "face": "https://example.invalid/other.png"},
}

# 动态 ID → 作者 UID。未列出的 ID 表示无法确认归属；800100 属于另一个作者。
DYNAMICS = {"9007199254740993123": "202", "900707": "707", "800100": "555"}


def dynamic_html(id, uid):
    """页面 __INITIAL_STATE__ 只含作者与 CONTENT：正文来自页面，评论定位来自 detail 接口。"""
    card = CARDS[uid]
    state = {"detail": {"id_str": id, "modules": [
        {"module_type": "MODULE_TYPE_CONTENT", "module_content": {"paragraphs": [
            {"para_type": 1, "text": {"nodes": [
                {"type": "TEXT_NODE_TYPE_WORD", "word": {"words": f"虚构正文 {id}"}},
            ]}},
        ]}},
        {"module_type": "MODULE_TYPE_AUTHOR", "module_author": {
            "mid": uid, "name": card["name"], "face": card["face"], "pub_ts": 1791513496,
        }},
    ]}}
    return (
        '<!doctype html><html><body><script type="text/javascript">window.__INITIAL_STATE__ = '
        + json.dumps(state, ensure_ascii=False) + ";</script></body></html>"
    )


def detail_payload(id, uid):
    card = CARDS[uid]
    return {"code": 0, "data": {"item": {
        "id_str": id,
        "basic": {"comment_id_str": "99" + id, "comment_type": 17},
        "modules": {"module_author": {
            "mid": uid, "name": card["name"], "face": card["face"], "pub_ts": 1791513496,
        }},
    }}}


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


def dynamic_source(request):
    """动态页、detail 与根评论页；只覆盖本测试需要的协议，不返回真实上游内容。"""
    url = request.url
    if url.host == "www.bilibili.com" and url.path.startswith("/opus/"):
        id = url.path.rsplit("/", 1)[-1]
        uid = DYNAMICS.get(id)
        return httpx.Response(200, text=dynamic_html(id, uid)) if uid else httpx.Response(404)
    if url.host == "api.bilibili.com" and url.path == "/x/polymer/web-dynamic/v1/detail":
        id = url.params.get("id")
        uid = DYNAMICS.get(id)
        return httpx.Response(200, json=detail_payload(id, uid)) if uid else httpx.Response(404)
    if url.host == "api.bilibili.com" and url.path == "/x/v2/reply":
        page = int(url.params.get("pn", "1"))
        return httpx.Response(200, json={"code": 0, "data": {
            "page": {"num": page, "size": 20, "count": 0, "acount": 0},
            "replies": [], "upper": {"top": None}, "hots": [],
        }})
    raise RuntimeError("Unexpected test upstream request")


def upstream(request):
    if request.url.host == "api.bilibili.com" and request.url.path == "/x/web-interface/card":
        return profile_transport(request)
    return dynamic_source(request)


def create_app():
    path = os.environ.get("BILI_DATABASE_PATH")
    if not path:
        raise RuntimeError("BILI_DATABASE_PATH is required for the test app")
    return create_management_app(path, profile_transport=httpx.MockTransport(upstream))
