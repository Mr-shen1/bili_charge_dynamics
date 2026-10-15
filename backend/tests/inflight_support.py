"""29 的公开配置操作和外部来源装配；不替换采集/存储内部函数。"""

import httpx

from backend.tests.archive_support import archive_client, readable_html, set_specified, TARGETS
from backend.tests.collector_support import configured
from backend.tests.management_support import BASE, UID
from backend.tests.test_recent_window_content import (
    RECENT_ID, prepare_recent,
)


CHANGES = ("stop", "delete_config", "delete_target", "mode", "window")


def prepare(path, change):
    if change == "window":
        prepare_recent(path)
    else:
        configured(path, (RECENT_ID,))


async def remove(path, change, collector, source):
    if change == "window":
        source.feed_id = "124"
        assert await collector.discover_once(UID)
        return
    with archive_client(path) as api:
        if change == "delete_config":
            assert api.delete(f"{BASE}/{UID}/monitor").status_code == 204
        elif change == "delete_target":
            assert api.delete(TARGETS + f"/{RECENT_ID}").status_code == 204
        else:
            assert api.patch(f"{BASE}/{UID}/monitor", json={
                "mode": "recent" if change == "mode" else "specified",
                "recent_n": 10, "enabled": change != "stop",
            }).status_code == 200


async def restore(path, change, collector, source):
    if change == "window":
        source.feed_id = RECENT_ID
        assert await collector.discover_once(UID)
        return

    def target_validation(request):
        return httpx.Response(200, text=readable_html(id=RECENT_ID))

    with archive_client(path, target_validation) as api:
        if change == "delete_config":
            assert api.post(BASE, json={"uid": UID}).status_code == 201
        assert set_specified(api).status_code == 200
        if change in ("delete_config", "delete_target"):
            assert api.post(TARGETS, json={"id": RECENT_ID}).status_code == 201
