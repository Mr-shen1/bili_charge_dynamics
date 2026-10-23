"""受限登记、正文恢复和媒体版本栅栏的回归。"""

import asyncio
import json

import httpx

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import author_html, readable_html
from backend.tests.collector_clock import ControlledClock
from backend.tests.collector_support import configured
from backend.tests.management_support import UID
from backend.tests.test_comment_sync_status import CommentSource, snapshot


def test_restricted_observation_settles_without_inventing_success_or_rescanning(tmp_path):
    path = tmp_path / "restricted.sqlite"
    configured(path)
    source, clock = CommentSource(), ControlledClock()
    source.html = author_html().replace(
        '"modules":[',
        '"modules":[{"module_type":"MODULE_TYPE_TITLE","module_title":{"text":"Restricted title"}},',
    )
    source.blocked = True

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=clock)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            check, archive = snapshot(path)
            assert check["work"] == "complete"
            assert check["sync_error"] is None
            assert check["parts"] == {
                "text": "restricted", "media": "restricted", "comments": "success",
                "replies": "success", "comment_media": "success",
            }
            assert archive["published_at"] is not None
            assert archive["title"] == "Restricted title"
            assert archive["synced_version"] is archive["media_version"] is None
            assert check["text_last_succeeded_at"] is check["media_last_succeeded_at"] is None
            # 受限是该版本的确认终态：整轮已完成，记目标级成功时间；
            # 正文/媒体自己的时间仍为 null，不冒充实际提交。
            assert check["last_succeeded_at"] == "2030-01-01T00:00:00+00:00"
            source.calls.clear()
            clock.advance(15)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            assert source.calls.count("/opus/123") == 1  # 仅检查，不再重抓正文。
            assert "/x/polymer/web-dynamic/v1/detail" not in source.calls
            assert "/x/v2/reply" not in source.calls
            assert "/x/v2/reply/reply" not in source.calls
            assert snapshot(path)[0]["work"] == "complete"

    asyncio.run(scenario())


def test_restricted_body_recovers_when_visible_without_edit_version_change(tmp_path):
    path = tmp_path / "recover.sqlite"
    configured(path)
    source, clock = CommentSource(), ControlledClock()
    source.html, source.blocked = author_html(), True

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=clock)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            before, _ = snapshot(path)
            source.html = readable_html("now visible", title="Recovered title", pictures=[])
            source.blocked = False
            clock.advance(15)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            after, archive = snapshot(path)
            assert after["observed"]["observed_version"] == before["observed"]["observed_version"]
            assert after["revision"] > before["revision"]
            assert archive["content_state"] == archive["work"]["text"] == "success"
            assert archive["text"] == "now visible"
            assert archive["title"] == "Recovered title"
            assert after["work"] == "complete"
            assert after["text_last_succeeded_at"] == "2030-01-01T00:00:15+00:00"

    asyncio.run(scenario())


def test_blocked_detail_is_valid_metadata_when_html_is_unavailable(tmp_path):
    path = tmp_path / "metadata.sqlite"
    configured(path)
    source = CommentSource()
    source.html, source.blocked = "<html>No initial state</html>", True

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=ControlledClock())
            await collector.check_once(UID, "123")
            check = Store(path).read_checks(UID)[0]
            assert check["check_status"] == "checked"
            assert check["check_error"] is None
            assert check["observed"]["edit_status"] == "unknown"
            assert check["observed"]["published_at"] is not None
            assert check["observed"]["source_comment_count"] == source.count
            await collector.execute_pending()
            check, archive = snapshot(path)
            assert check["work"] == "complete"
            assert archive["work"]["text"] == "restricted"
            assert archive["synced_version"] is None
            assert check["last_succeeded_at"] == "2030-01-01T00:00:00+00:00"

    asyncio.run(scenario())


def test_media_version_repair_requires_real_source_confirmation(tmp_path):
    path = tmp_path / "media.sqlite"
    configured(path)
    source, clock = CommentSource(), ControlledClock()
    source.html = readable_html(pictures=[])
    store = Store(path)

    class NoUploadNeeded:
        async def upload(self, key, content, content_type):
            raise AssertionError("无图组不应上传")

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            # 配置了上传器：媒体版本栅栏属于完成条件，落后时必须回源头重新确认。
            collector = Collector(store, client, None, NoUploadNeeded(), clock=clock)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            with store.connection() as connection:
                row = connection.execute("SELECT document, generation FROM archives WHERE id = '123'").fetchone()
                document = json.loads(row["document"])
                document["media_version"] = "old-media-version"
                document["work"]["media"] = "pending"
                connection.execute("UPDATE archives SET document = ? WHERE id = '123'", (json.dumps(document),))
            assert store.observe_archive("123", row["generation"], {})
            assert store.read_archive("123")["media_version"] == "old-media-version"
            source.calls.clear()
            clock.advance(15)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            _, archive = snapshot(path)
            assert source.calls.count("/opus/123") == 2  # 检查 + 实际正文/来源确认。
            assert archive["media_version"] == archive["observed_version"]
            assert archive["work"]["media"] == "success"

    asyncio.run(scenario())


def test_missing_comment_picture_list_confirms_empty_not_restricted(tmp_path):
    path = tmp_path / "unknown-pictures.sqlite"
    configured(path)
    source = CommentSource()
    for root in source.roots:
        root["content"].pop("pictures")

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            store = Store(path)
            collector = Collector(store, client, clock=ControlledClock())
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            for root_id in store.media_root_ids("123"):
                root = store.read_media_owner("123", root_id)
                # 缺 pictures 键是来源确认无图：既不是借用正文的 restricted，也不是永久未知。
                assert root["work"]["media"] == "success"
                assert root["media"] == []
            assert snapshot(path)[0]["parts"]["comment_media"] == "success"

    asyncio.run(scenario())
