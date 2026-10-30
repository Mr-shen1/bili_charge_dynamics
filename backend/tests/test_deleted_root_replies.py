"""来源删除根评论：上游 12006「没有该评论」应退役该楼，不告警、不再请求、保留归档。"""

import asyncio
import logging
import sqlite3

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.collector_logging import SourceRejected
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import UID, archive_client
from backend.tests.collector_clock import ControlledClock
from backend.tests.root_support import prepare
from backend.tests.test_replies import ROOT
from backend.tests.test_reply_page_resume import DYNAMIC, HotSource


ARCHIVE = f"/api/archive/dynamics/{DYNAMIC}"
DELETED_PAYLOAD = {"code": 12006, "message": "没有该评论", "data": None}


class DeletedRootSource(HotSource):
    """在楼中楼来源替身上加「根评论被删除」与「其他业务码」两个开关，只影响 ROOT 这一栋。"""

    def __init__(self, total=3):
        super().__init__(total=total)
        self.deleted = False
        self.business_code = None

    def __call__(self, request):
        if request.url.path == "/x/v2/reply/reply" and request.url.params["root"] == ROOT:
            self.state["reply_pages"].append((ROOT, int(request.url.params["pn"])))
            if self.deleted:
                return httpx.Response(200, json=DELETED_PAYLOAD)
            if self.business_code is not None:
                return httpx.Response(200, json={"code": self.business_code,
                                                 "message": "FICTIONAL_SECRET_REJECT", "data": None})
        return super().__call__(request)


@pytest.fixture
def events():
    records = []
    logger = logging.getLogger("bili_monitor.collector")

    class Capture(logging.Handler):
        def emit(self, record):
            records.append(record.getMessage())

    handler = Capture()
    logger.addHandler(handler)
    try:
        yield lambda: "\n".join(records)
    finally:
        logger.removeHandler(handler)


def initial(path, source):
    with archive_client(path, source) as api:
        prepare(api)
        assert api.post("/api/sync/initial", json={"uid": UID}).status_code == 200


def check_once(path, source):
    """真实 Collector 的检查＋待处理执行链，只替换上游 HTTP 与墙钟。"""

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=ControlledClock())
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()

    asyncio.run(scenario())


def reply_status(path, root_id=ROOT):
    with sqlite3.connect(path) as connection:
        row = connection.execute(
            "SELECT status FROM reply_sync WHERE dynamic_id = ? AND root_id = ?",
            (DYNAMIC, root_id)).fetchone()
    return row[0] if row else None


def alert_policy(path, error):
    """采集告警登记策略（不依赖通知闸门）：返回该失败会登记哪些告警。"""
    return Collector(Store(path), None)._failure_alerts(error, f"{UID}:{DYNAMIC}")


def archive(path):
    with archive_client(path) as api:
        return api.get(ARCHIVE).json()


def test_deleted_root_retires_without_alert_and_keeps_archive(tmp_path, events):
    path, source = tmp_path / "deleted.sqlite", DeletedRootSource(total=3)
    initial(path, source)
    assert reply_status(path) == "success"
    assert archive(path)["local_reply_count"] == 3

    # 楼已被来源删除：根页仍带着旧 rcount（4），楼中楼页返回 12006。
    source.state["roots"][0]["rcount"] = 4
    source.deleted = True
    source.clear_pages()
    check_once(path, source)

    assert source.pages, "本轮应当请求过该楼的楼中楼页"
    assert reply_status(path) == "deleted"
    assert "reply_sync_deleted" in events()
    assert "source_code=12006" in events()
    assert "reply_sync_failed" not in events()
    assert "FICTIONAL_SECRET" not in events()
    assert alert_policy(path, SourceRejected("Reply source deleted", 12006)) == []
    # 归档内容保留，回复工作项不被一栋已删楼拖成失败。
    assert archive(path)["local_reply_count"] == 3
    assert archive(path)["work"]["replies"] == "success"

    # 退役后不再请求该楼：即使来源 rcount 依旧陈旧。
    source.clear_pages()
    check_once(path, source)
    assert source.pages == []
    assert reply_status(path) == "deleted"


def test_retired_root_is_revived_when_the_source_lists_it_again(tmp_path, events):
    path, source = tmp_path / "revived.sqlite", DeletedRootSource(total=3)
    initial(path, source)
    source.state["roots"][0]["rcount"] = 4
    source.deleted = True
    source.clear_pages()
    check_once(path, source)
    assert reply_status(path) == "deleted"

    # 来源恢复：根页重新列出该楼且 rcount 变化，应清除退役标记并重新采集。
    source.deleted = False
    source.state["roots"][0]["rcount"] = 5
    source.append(2)
    source.clear_pages()
    check_once(path, source)

    assert source.pages, "恢复后应当重新请求该楼的楼中楼页"
    assert reply_status(path) == "success"
    assert archive(path)["local_reply_count"] == 5


def test_other_business_codes_still_fail_and_alert(tmp_path, events):
    path, source = tmp_path / "rejected.sqlite", DeletedRootSource(total=3)
    initial(path, source)

    source.state["roots"][0]["rcount"] = 4
    source.business_code = -403
    source.clear_pages()
    check_once(path, source)

    assert reply_status(path) == "failed"
    assert "reply_sync_failed" in events()
    assert "source_code=-403" in events()
    assert "FICTIONAL_SECRET" not in events()
    assert [alert.category for alert in alert_policy(
        path, SourceRejected("Reply source rejected request", -403))] == ["collection"]
