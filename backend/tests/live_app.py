"""仅测试使用：固定虚构上游（UP 资料、动态正文、空根评论页、近期发现页），不绕过生产解析或持久化。

除只读/既有写接口外，本模块额外提供**仅测试用**的采集驱动端点：
`POST /api/test/collect` 显式驱动一次真实 Collector 节拍、`POST /api/test/source-failure`
切换固定上游失败、`POST /api/test/root-comments` 为指定动态启用 45 条虚构一级评论、
`GET /api/test/source-requests` 读取本进程累计的上游请求计数。它们不在生产应用里注册，
也不访问真实上游或上传 OSS；默认根评论页仍为空，未启用时既有用例行为不变。

BILI_DATABASE_PATH=/tmp/bili-e2e.sqlite uv run uvicorn \
    backend.tests.live_app:create_app --factory --host 127.0.0.1 --port 8765
"""

import copy
import json
import os
from pathlib import Path

import httpx
from fastapi import HTTPException

from backend.bili_monitor.app import create_app as create_management_app
from backend.bili_monitor.collector import Collector
from backend.bili_monitor.source_endpoints import FEED_URL
from backend.bili_monitor.storage import Store

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
    "808": {"mid": "808", "name": "虚构楼阁", "face": "https://example.invalid/pavilion.png"},
}

# 一级评论定位夹具：默认关闭，只有显式启用后才给该动态下发 45 条虚构根评论。
ROOT_FIXTURE = {"dynamic": None, "size": 45}
# 本进程累计的上游请求：用于断言归档读取不触发采集。
SOURCE_REQUESTS = {"total": 0, "reply": 0, "count": 0}


def root_comments(dynamic):
    """45 条虚构一级评论：点赞递减，因此最热顺序即 860001…860045。"""
    template = json.loads((Path(__file__).parent / "fixtures/root-comments.json").read_text())
    root = template["data"]["replies"][0]
    comments = []
    for index in range(ROOT_FIXTURE["size"]):
        item = copy.deepcopy(root)
        item.update(rpid=860000 + index + 1, rpid_str=str(860000 + index + 1),
                    like=ROOT_FIXTURE["size"] - index, rcount=0, ctime=1791513496 - index,
                    root=0, root_str="0", parent=0, parent_str="0")
        item["member"] = {"mid": "909001", "uname": "虚构楼主", "avatar": None}
        item["content"] = {"message": f"虚构一级评论 {index + 1}\n第二行：换行与 emoji 🙂", "pictures": []}
        item["replies"] = None
        item["oid"], item["type"] = int("99" + dynamic), 17
        comments.append(item)
    return comments


def comment_page(dynamic, page):
    """按 20/20/5 分页下发根评论；页码与资源身份按请求回显。"""
    comments = root_comments(dynamic)
    start = (page - 1) * 20
    replies = comments[start:start + 20]
    return {"code": 0, "data": {
        "page": {"num": page, "size": 20, "count": len(comments), "acount": len(comments)},
        "upper": {"mid": int(CARDS[DYNAMICS[dynamic]]["mid"]), "top": None},
        "hots": [], "replies": replies or None,
    }}

# 动态 ID → 作者 UID。未列出的 ID 表示无法确认归属；800100 属于另一个作者。
DYNAMICS = {
    "9007199254740993123": "202", "900707": "707", "800100": "555",
    # 800300 专供一级评论定位读取：启用虚构根评论后才产生归档评论。
    # 800200 在管理用例里是“无法确认归属”的动态，不能给它建立归属。
    "800300": "808",
}

# 固定上游的失败开关：只影响本测试夹具，不影响生产代码路径。
SOURCE_FAILURE = {"feed": False, "reply": False}


def feed_items(uid):
    """近期发现页：只列该 UP 自己的动态，全部按充电专属标记入选。"""
    return [
        {
            "id_str": id,
            "modules": {
                "module_author": {"mid": uid},
                "module_dynamic": {"major": {"type": "MAJOR_TYPE_BLOCKED"}},
            },
        }
        for id, owner in DYNAMICS.items()
        if owner == uid
    ]


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
    payload = {"code": 0, "data": {"item": {
        "id_str": id,
        "basic": {"comment_id_str": "99" + id, "comment_type": 17},
        "modules": {"module_author": {
            "mid": uid, "name": card["name"], "face": card["face"], "pub_ts": 1791513496,
        }},
    }}}
    if ROOT_FIXTURE["dynamic"] == id:
        payload["data"]["item"]["modules"]["module_stat"] = {
            "comment": {"count": ROOT_FIXTURE["size"]},
        }
    return payload


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
    """动态页、detail、独立评论计数、根评论页与近期发现页；不返回真实上游内容。"""
    url = request.url
    if url.host == "www.bilibili.com" and url.path.startswith("/opus/"):
        id = url.path.rsplit("/", 1)[-1]
        uid = DYNAMICS.get(id)
        return httpx.Response(200, text=dynamic_html(id, uid)) if uid else httpx.Response(404)
    if url.host == "api.bilibili.com" and url.path == "/x/polymer/web-dynamic/v1/detail":
        id = url.params.get("id")
        uid = DYNAMICS.get(id)
        return httpx.Response(200, json=detail_payload(id, uid)) if uid else httpx.Response(404)
    if str(url.copy_with(query=None)) == FEED_URL:
        if SOURCE_FAILURE["feed"]:
            raise httpx.ConnectError("FICTIONAL_FEED_FAILURE", request=request)
        return httpx.Response(200, json={"code": 0, "data": {
            "has_more": 0, "items": feed_items(url.params.get("host_mid")),
        }})
    if url.host == "api.bilibili.com" and url.path == "/x/v2/reply/count":
        SOURCE_REQUESTS["count"] += 1
        enabled = ROOT_FIXTURE["dynamic"] == url.params.get("oid", "")[2:]
        return httpx.Response(200, json={"code": 0, "data": {"count": ROOT_FIXTURE["size"] if enabled else 0}})
    if url.host == "api.bilibili.com" and url.path == "/x/v2/reply":
        SOURCE_REQUESTS["reply"] += 1
        if SOURCE_FAILURE["reply"]:
            raise httpx.ConnectError("FICTIONAL_REPLY_FAILURE", request=request)
        page = int(url.params.get("pn", "1"))
        # 带 root 参数的是楼中楼请求：本夹具不提供具体回复，保持既有空页行为。
        enabled = (ROOT_FIXTURE["dynamic"] and not url.params.get("root")
                   and url.params.get("oid") in (ROOT_FIXTURE["dynamic"], "99" + ROOT_FIXTURE["dynamic"]))
        if enabled:
            return httpx.Response(200, json=comment_page(ROOT_FIXTURE["dynamic"], page))
        return httpx.Response(200, json={"code": 0, "data": {
            "page": {"num": page, "size": 20, "count": 0, "acount": 0},
            "replies": [], "upper": {"top": None}, "hots": [],
        }})
    raise RuntimeError("Unexpected test upstream request")


def upstream(request):
    SOURCE_REQUESTS["total"] += 1
    if request.url.host == "api.bilibili.com" and request.url.path == "/x/web-interface/card":
        return profile_transport(request)
    return dynamic_source(request)


def create_app():
    path = os.environ.get("BILI_DATABASE_PATH")
    if not path:
        raise RuntimeError("BILI_DATABASE_PATH is required for the test app")
    app = create_management_app(path, profile_transport=httpx.MockTransport(upstream))

    @app.post("/api/test/source-failure", include_in_schema=False)
    async def source_failure(payload: dict):
        """仅测试夹具：切换固定上游失败，用来产生真实的发现/根评论失败态。"""
        for key in SOURCE_FAILURE:
            if payload.get(key) is not None:
                SOURCE_FAILURE[key] = bool(payload[key])
        return dict(SOURCE_FAILURE)

    @app.post("/api/test/root-comments", include_in_schema=False)
    async def enable_root_comments(payload: dict):
        """仅测试夹具：为指定动态启用 45 条虚构一级评论；不写数据库，归档仍走 /api/sync/initial。"""
        ROOT_FIXTURE["dynamic"] = payload.get("dynamic")
        return {"dynamic": ROOT_FIXTURE["dynamic"], "size": ROOT_FIXTURE["size"]}

    @app.get("/api/test/source-requests", include_in_schema=False)
    async def read_source_requests():
        """仅测试夹具：本进程累计上游请求计数，用于断言归档读取不触发采集。"""
        return dict(SOURCE_REQUESTS)

    @app.post("/api/test/collect", include_in_schema=False)
    async def collect(payload: dict):
        """仅测试夹具：显式驱动一次真实 Collector 节拍，不连真实上游、不上传 OSS。"""
        action, uid = payload.get("action"), payload.get("uid")
        store = Store(path)
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream), trust_env=False) as client:
            collector = Collector(store, client)
            if action == "discover":
                return {"accepted": [await collector.discover_once(uid)]}
            if action == "check":
                return {"accepted": [await collector.check_once(uid, target["id"])
                                     for target in store.enabled_targets() if target["uid"] == uid]}
            if action == "execute":
                await collector.execute_pending()
                return {"accepted": [True]}
        raise HTTPException(status_code=422, detail="Unknown collect action")

    return app
