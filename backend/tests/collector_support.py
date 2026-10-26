"""23 的公开 HTTP 配置与虚构来源装配，供测试和隔离演示共用。"""

import httpx

from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client, readable_html, set_specified, TARGETS, detail_json
from backend.tests.management_support import BASE, UID


CHECKS = f"{BASE}/{UID}/checks"


def open_notifications(path):
    """通知三态默认 `off`：需要产生消息的用例统一在这里显式切到 `all`。

    生产语义是“默认不发”，所以只有相关用例自选开启，不为测试另开一条默认值捷径。
    """
    store = Store(path)
    store.migrate()
    store.update_notification_switch("all")


def configured(path, ids=("123",)):
    def upstream(request):
        if request.url.path.startswith("/opus/"):
            return httpx.Response(200, text=readable_html(id=request.url.path.split("/")[-1]))
        return empty_upstream(request)

    with archive_client(path, upstream) as api:
        assert api.post(BASE, json={"uid": UID}).status_code == 201
        set_specified(api)
        for id in ids:
            assert api.post(TARGETS, json={"id": id}).status_code == 201
    open_notifications(path)


def empty_upstream(request):
    if request.url.path.startswith("/opus/"):
        return httpx.Response(200, text=readable_html(id=request.url.path.split("/")[-1], pictures=[]).replace('"count":7', '"count":0'))
    if request.url.path.endswith("/detail"):
        payload = detail_json()
        id = request.url.params["id"]
        payload["data"]["item"]["id_str"] = id
        payload["data"]["item"]["basic"]["comment_id_str"] = f"99{id}"
        payload["data"]["item"]["basic"]["rid_str"] = f"99{id}"
        payload["data"]["item"]["modules"]["module_stat"]["comment"]["count"] = 0
        payload["data"]["item"]["modules"]["module_dynamic"]["major"]["opus"]["pics"] = []
        return httpx.Response(200, json=payload)
    if request.url.path == "/x/v2/reply/count":
        return httpx.Response(200, json={"code": 0, "data": {"count": 0}})
    if request.url.path == "/x/v2/reply":
        return httpx.Response(200, json={"code": 0, "data": {"page": {"num": 1, "size": 20, "count": 0, "acount": 0}, "replies": []}})
    raise AssertionError("Unexpected upstream request")
