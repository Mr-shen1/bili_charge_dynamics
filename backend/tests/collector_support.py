"""23 的公开 HTTP 配置与虚构来源装配，供测试和隔离演示共用。"""

import httpx

from backend.tests.archive_support import archive_client, readable_html, set_specified, TARGETS, detail_json
from backend.tests.management_support import BASE, UID


CHECKS = f"{BASE}/{UID}/checks"


def configured(path, ids=("123",)):
    with archive_client(path, lambda request: httpx.Response(200, text=readable_html(id=request.url.path.split('/')[-1]))) as api:
        assert api.post(BASE, json={"uid": UID}).status_code == 201
        set_specified(api)
        for id in ids:
            assert api.post(TARGETS, json={"id": id}).status_code == 201


def empty_upstream(request):
    if request.url.path.startswith("/opus/"):
        return httpx.Response(200, text=readable_html(pictures=[]).replace('"count":7', '"count":0'))
    if request.url.path.endswith("/detail"):
        payload = detail_json()
        payload["data"]["item"]["modules"]["module_stat"]["comment"]["count"] = 0
        payload["data"]["item"]["modules"]["module_dynamic"]["major"]["opus"]["pics"] = []
        return httpx.Response(200, json=payload)
    if request.url.path == "/x/v2/reply":
        return httpx.Response(200, json={"code": 0, "data": {"page": {"num": 1, "size": 20, "count": 0, "acount": 0}, "replies": []}})
    raise AssertionError("Unexpected upstream request")
