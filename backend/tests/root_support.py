"""根／回复公开同步测试共用的原始来源装配，仅替换外部 HTTP。"""

import copy
import json
from pathlib import Path

import httpx

from backend.tests.archive_support import BASE, UID, TARGETS, author_html, detail_json, set_specified

ARCHIVE = "/api/archive/dynamics/123"
COMMENTS = ARCHIVE + "/comments"


def root_fixture():
    return json.loads((Path(__file__).parent / "fixtures/root-comments.json").read_text())


def source_handler(state):
    def handler(request):
        count = None if state.get("unknown_count") else state.get("dynamic_count", 7)
        if request.url.host == "www.bilibili.com":
            html = author_html().replace('"count":7', '"count":' + json.dumps(count))
            return httpx.Response(200, text=html + "暂无权查看当前评论")
        if request.url.path == "/x/polymer/web-dynamic/v1/detail":
            payload = detail_json()
            if state.get("detail_fail"):
                raise httpx.ReadError("FICTIONAL_SECRET_DETAIL")
            payload["data"]["item"]["modules"]["module_dynamic"]["major"] = {"type": "MAJOR_TYPE_BLOCKED"}
            if "basic" in state:
                payload["data"]["item"]["basic"] = state["basic"]
            payload["data"]["item"]["modules"]["module_stat"]["comment"]["count"] = count
            return httpx.Response(200, json=payload)
        assert request.url.path == "/x/v2/reply"
        # 定位来源可为 basic（oid=99123）或兜底（动态 ID=123）；真实上游按请求回显资源身份。
        oid, kind = request.url.params["oid"], request.url.params["type"]
        assert oid in ("99123", "123")
        assert kind == ("17" if oid == "99123" else "11")
        state.setdefault("locators", []).append((oid, kind))
        assert request.url.params["ps"] == "20"
        assert request.url.params["sort"] == "0"
        page = int(request.url.params["pn"])
        state.setdefault("pages", []).append(page)
        if state.get("fail_page") == page:
            raise httpx.ReadError("FICTIONAL_SECRET_COMMENT")
        payload = copy.deepcopy(state.get("payload", root_fixture()))
        payload["data"]["page"]["num"] = page
        roots = state.get("roots", payload["data"]["replies"])
        payload["data"]["replies"] = roots[(page - 1) * 20:page * 20] or None
        if "roots" in state:
            payload["data"]["page"].update(count=len(roots), acount=len(roots) + 5)
        # 回显本次请求的资源身份，否则条目会被当作其它资源而拒绝。
        uppers = (payload["data"].get("upper") or {}).get("top")
        echoed = [item for item in (payload["data"]["replies"] or []) + (payload["data"].get("hots") or [])
                  + ([uppers] if isinstance(uppers, dict) else [])]
        for item in echoed:
            if "oid" in item:
                item["oid"] = int(oid)
            if "type" in item:
                item["type"] = int(kind)
        return httpx.Response(200, json=payload)
    return handler


def prepare(client):
    assert client.post(BASE, json={"uid": UID}).status_code == 201
    assert client.post(TARGETS, json={"id": "123"}).status_code == 201
    assert set_specified(client).status_code == 200
