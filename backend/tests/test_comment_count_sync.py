"""25：原始计数 JSON 经公开检查／执行、真实 SQLite 与 HTTP。"""

import asyncio
import copy
import json
from pathlib import Path

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client, readable_html
from backend.tests.collector_support import CHECKS, configured, empty_upstream
from backend.tests.management_support import UID
from backend.tests.root_support import root_fixture
from backend.tests.collector_clock import ControlledClock, eventually


ARCHIVE = "/api/archive/dynamics/123"


def snapshot(path):
    with archive_client(path) as api:
        return api.get(CHECKS).json()["checks"][0], api.get(ARCHIVE).json()


def count_fixture():
    return json.loads((Path(__file__).parent / "fixtures/comment-count.json").read_text())


class CommentSource:
    """仅替换外部 HTTP；保留原始根／回复 JSON 与独立计数响应结构。"""
    def __init__(self):
        self.count = 7
        self.roots = root_fixture()["data"]["replies"]
        for root in self.roots:
            root["content"]["pictures"] = []
        self.reply_payload = json.loads((Path(__file__).parent / "fixtures/replies.json").read_text())
        self.replies = self.reply_payload["data"]["replies"]
        self.fail_root_page = self.fail_reply_page = None
        self.html = readable_html(pictures=[])
        self.calls = []

    def __call__(self, request):
        path = request.url.path
        self.calls.append((path, dict(request.url.params)))
        if path.startswith("/opus/"):
            return httpx.Response(200, text=self.html)
        if path == "/x/v2/reply/count":
            payload = count_fixture()
            payload["data"]["count"] = self.count
            return httpx.Response(200, json=payload)
        if path in ("/x/v2/reply", "/x/v2/reply/reply"):
            page = int(request.url.params["pn"])
            is_root = path == "/x/v2/reply"
            if page == (self.fail_root_page if is_root else self.fail_reply_page):
                raise httpx.ReadError("FICTIONAL_SECRET_PAGE")
            payload = copy.deepcopy(root_fixture() if is_root else self.reply_payload)
            items = self.roots if is_root else self.replies
            payload["data"]["page"].update(num=page, count=len(items))
            payload["data"]["replies"] = items[(page - 1) * 20:page * 20] or None
            return httpx.Response(200, json=payload)
        return empty_upstream(request)

    def expand(self):
        root = copy.deepcopy(self.roots[1])
        self.roots += [{**copy.deepcopy(root), "rpid_str": str(1000 + index)} for index in range(43)]
        reply = self.replies[0]
        self.replies += [{**copy.deepcopy(reply), "rpid_str": str(2000 + index)} for index in range(20)]
        self.roots[0]["rcount"] = 25
        self.count = 70

    def scans(self):
        return [(path, params["pn"]) for path, params in self.calls
                if path in ("/x/v2/reply", "/x/v2/reply/reply")]


def test_independent_source_total_is_observed_and_changes_rescan_completed_comments(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        total = 7
        calls = []

        def upstream(request):
            calls.append(request.url.path)
            if request.url.path == "/x/v2/reply/count":
                assert dict(request.url.params) == {"oid": "99123", "type": "17"}
                payload = count_fixture()
                payload["data"]["count"] = total
                return httpx.Response(200, json=payload)
            # 网页 count=7、通用 detail=0、根分页=0，不假定与独立总数相等。
            if request.url.path.startswith("/opus/"):
                return httpx.Response(200, text=readable_html(pictures=[]))
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            state, _ = snapshot(path)
            assert state["observed"]["source_comment_count"] == 7
            assert "/x/v2/reply/count" in calls
            await collector.execute_pending()
            state, archive = snapshot(path)
            assert archive["source_comment_count"] == archive["synced_comment_count"] == 7
            assert archive["local_comment_count"] == archive["local_reply_count"] == 0
            assert state["synced_comment_count"] == 7
            assert state["local_comment_count"] == state["local_reply_count"] == 0
            assert state["comments_last_attempt"] == "success"
            assert state["work"] == "complete"
            calls.clear()
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            assert "/x/v2/reply/count" in calls
            assert "/x/v2/reply" not in calls
            total = 8
            calls.clear()
            await collector.check_once(UID, "123")
            state, archive = snapshot(path)
            assert state["work"] == "pending"
            assert state["parts"]["comments"] == state["parts"]["replies"] == "pending"
            assert archive["synced_comment_count"] == 7
            await Collector(Store(path), client).execute_pending()
            state, archive = snapshot(path)
            assert "/x/v2/reply" in calls
            assert archive["synced_comment_count"] == 8
            assert state["work"] == "complete"

    asyncio.run(scenario())


@pytest.mark.parametrize("invalid", [None, -1, True, "7", 1.5, "missing", "business", "denied", "network"])
def test_untrusted_count_never_becomes_zero_or_overwrites_old_trusted_total(tmp_path, invalid):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        value = 7
        calls = []

        def upstream(request):
            calls.append(request.url.path)
            if request.url.path == "/x/v2/reply/count":
                if value == "network":
                    raise httpx.ReadError("FICTIONAL_SECRET_COUNT")
                if value == "denied":
                    return httpx.Response(403, text="FICTIONAL_SECRET_COUNT")
                payload = count_fixture()
                if value == "missing":
                    payload["data"].pop("count")
                else:
                    payload["data"]["count"] = value
                if value == "business":
                    payload["code"] = -403
                    payload["message"] = "FICTIONAL_SECRET_COUNT"
                return httpx.Response(200, json=payload)
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            before, saved = snapshot(path)
            value = invalid
            calls.clear()
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            state, archive = snapshot(path)
            assert state["observed"]["source_comment_count"] == 7
            assert state["observed"]["comment_count_status"] == "failed"
            assert state["check_status"] == "failed"
            assert state["revision"] == before["revision"]
            assert state["last_succeeded_at"] == before["last_succeeded_at"]
            assert archive == saved
            assert "/x/v2/reply" not in calls
            assert "FICTIONAL_SECRET" not in str(state) + str(archive)

    asyncio.run(scenario())


@pytest.mark.parametrize("total", [None, 0])
def test_first_unknown_or_real_zero_initializes_readable_existing_comments(tmp_path, total):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source = CommentSource()
    source.count = total
    source.html = source.html.replace("编辑于 2026年10月09日 13:01", "刚刚") + "暂无权查看当前评论"
    if total == 0:
        source.roots = source.replies = []

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            state, _ = snapshot(path)
            assert state["observed"].get("source_comment_count") == total
            await collector.execute_pending()
            state, archive = snapshot(path)
            assert archive["source_comment_count"] == archive["synced_comment_count"] == total
            assert archive["comments_last_attempt"] == "success"
            assert archive["local_comment_count"] == (0 if total == 0 else 2)
            assert archive["local_reply_count"] == (0 if total == 0 else 5)
            assert archive["work"]["comments"] == archive["work"]["replies"] == "success"
            source.calls.clear()
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            assert source.scans() == []
            if total is None:
                source.count = 7
                await collector.check_once(UID, "123")
                await collector.execute_pending()
                assert snapshot(path)[1]["synced_comment_count"] == 7
                assert source.scans()

    asyncio.run(scenario())


@pytest.mark.parametrize("failure", ["root", "reply"])
def test_required_page_failure_keeps_partial_archive_and_retries_without_new_count(tmp_path, failure):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source = CommentSource()

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            assert snapshot(path)[1]["synced_comment_count"] == 7
            source.expand()
            if failure == "root":
                source.fail_root_page = 2
            else:
                source.fail_reply_page = 2
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            state, archive = snapshot(path)
            assert archive["source_comment_count"] == 70
            assert archive["synced_comment_count"] == 7
            assert archive["comments_last_attempt"] != "success"
            assert archive["local_comment_count"] >= 20
            assert archive["local_reply_count"] >= 5
            if failure == "reply":
                assert state["parts"]["comments"] == "success"
                assert state["parts"]["replies"] == "pending"
            assert state["work"] == "pending" and state["sync_error"] == "SYNC_INCOMPLETE"
            assert "FICTIONAL_SECRET" not in str(state) + str(archive)
            source.fail_root_page = source.fail_reply_page = None
            source.calls.clear()
            # 重开、无新检查/计数即可领取同一失败工作。
            await Collector(Store(path), client).execute_pending()
            state, archive = snapshot(path)
            assert archive["synced_comment_count"] == 70
            assert archive["local_comment_count"] == 45
            assert archive["local_reply_count"] == 25
            assert archive["comments_last_attempt"] == "success"
            assert source.scans() == [("/x/v2/reply", n) for n in ("1", "2", "3", "4", "4")] + [
                ("/x/v2/reply/reply", n) for n in ("1", "2", "3", "3")]
            assert state["work"] == "complete"
            source.calls.clear()
            await Collector(Store(path), client).execute_pending()
            assert source.calls == []

    asyncio.run(scenario())


def test_decrease_and_zero_rescan_but_net_zero_and_pure_edits_are_known_blind_spots(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source = CommentSource()

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            root_id = source.roots[0]["rpid_str"]
            with archive_client(path) as api:
                old_text = api.get(ARCHIVE + "/comments").json()["items"][0]["text"]
            # 纯评论编辑：独立总数仍为7，即使正文编辑也不重扫。
            source.roots[0]["content"]["message"] = "评论已编辑但计数未变"
            source.html = source.html.replace("13:01", "13:02")
            source.calls.clear()
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            assert source.scans() == []
            # 增删抵消：替换一条根，仍为7，不默认校准。
            source.roots[1]["rpid_str"] = "99999"
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            assert source.scans() == []
            with archive_client(path) as api:
                items = api.get(ARCHIVE + "/comments").json()["items"]
                assert next(item["text"] for item in items if item["id"] == root_id) == old_text
                assert "99999" not in [item["id"] for item in items]
            # 总数减少触发全轮，已有 ID 内容仍更新，旧归档不删除。
            source.count = 6
            source.calls.clear()
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            assert source.scans()
            with archive_client(path) as api:
                items = api.get(ARCHIVE + "/comments").json()["items"]
                assert next(item["text"] for item in items if item["id"] == root_id) == "评论已编辑但计数未变"
                assert len(items) == 3
            source.count = 0
            source.roots = source.replies = []
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            state, archive = snapshot(path)
            assert archive["synced_comment_count"] == archive["source_comment_count"] == 0
            assert archive["local_comment_count"] == 3
            assert archive["local_reply_count"] == 5
            assert state["parts"]["comments"] == state["parts"]["replies"] == "success"
            # 未再读到的保留根媒体可以独立 pending，不撤销评论零版本成功。

    asyncio.run(scenario())


def test_comment_only_change_does_not_retry_successful_body_or_lose_it_on_page_failure(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source = CommentSource()

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            saved = snapshot(path)[1]
            source.html = "<html>暂无权查看当前评论</html>"
            source.count = 8
            await collector.check_once(UID, "123")
            source.calls.clear()
            await collector.execute_pending()
            state, archive = snapshot(path)
            assert archive["synced_comment_count"] == 8
            assert archive["text"] == saved["text"]
            assert archive["work"]["text"] == "success"
            assert archive["synced_version"] == saved["synced_version"]
            assert state["work"] == "complete"
            assert all(not path.startswith("/opus/") and not path.endswith("/detail")
                       for path, _ in source.calls)

    asyncio.run(scenario())


@pytest.mark.parametrize("blocked_path", ["/x/v2/reply", "/x/v2/reply/reply"])
def test_old_pagination_only_commits_its_count_and_reopen_keeps_new_work(tmp_path, blocked_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source = CommentSource()

    async def scenario():
        blocked, release = asyncio.Event(), asyncio.Event()
        delay = False

        async def upstream(request):
            if delay and request.url.path == blocked_path and request.url.params["pn"] == "2":
                blocked.set()
                await release.wait()
            return source(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            source.expand()
            await collector.check_once(UID, "123")
            delay = True
            running = asyncio.create_task(collector.execute_pending())
            await asyncio.wait_for(blocked.wait(), 3)
            source.count = 71
            await collector.check_once(UID, "123")
            state, archive = snapshot(path)
            assert state["observed"]["source_comment_count"] == 71
            assert state["work"] == "running"
            # 网络等待时另一个 API 读写都可完成，无长事务。
            with archive_client(path) as api:
                assert api.get(ARCHIVE + "/comments").status_code == 200
                assert api.patch(f"/api/manage/ups/{UID}/monitor", json={
                    "mode": "specified", "recent_n": 11, "enabled": True}).status_code == 200
            release.set()
            await running
            state, archive = snapshot(path)
            assert archive["synced_comment_count"] == 70
            assert state["observed"]["source_comment_count"] == 71
            assert state["work"] == "pending"
            assert state["parts"]["comments"] == state["parts"]["replies"] == "pending"
            assert state["parts"]["comment_media"] == "pending"
            await Collector(Store(path), client).execute_pending()
            state, archive = snapshot(path)
            assert archive["synced_comment_count"] == 71
            assert state["work"] == "complete"

    asyncio.run(scenario())


def test_slow_comment_pages_do_not_block_fixed_checks_or_another_targets_sync(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path, ("123", "124"))
    source = CommentSource()
    source.expand()

    async def scenario():
        clock = ControlledClock()
        blocked, release = asyncio.Event(), asyncio.Event()
        check_counts = {"99123": 0, "99124": 0}

        async def upstream(request):
            url = request.url
            if url.path == "/x/polymer/web-dynamic/v1/detail" and url.params["id"] == "124":
                payload = empty_upstream(request).json()
                payload["data"]["item"]["id_str"] = "124"
                payload["data"]["item"]["basic"]["comment_id_str"] = "99124"
                return httpx.Response(200, json=payload)
            if url.path == "/opus/124":
                return httpx.Response(200, text=readable_html(id="124", pictures=[]))
            if url.path == "/x/v2/reply/count":
                check_counts[url.params["oid"]] += 1
                if url.params["oid"] == "99124":
                    return httpx.Response(200, json={"code": 0, "data": {"count": 1 if clock.value >= 30 else 0}})
            if url.path == "/x/v2/reply" and url.params["oid"] == "99124":
                return empty_upstream(request)
            if url.path == "/x/v2/reply" and url.params["pn"] == "2":
                blocked.set()
                await release.wait()
            return source(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            running = asyncio.create_task(Collector(Store(path), client, clock=clock).run())
            try:
                await eventually(lambda: all(row["revision"] == 1 for row in Store(path).read_checks(UID)))
                await eventually(lambda: clock.deadlines[-1] == 15)
                clock.advance(15)
                await asyncio.wait_for(blocked.wait(), 3)
                await eventually(lambda: Store(path).read_checks(UID)[1]["work"] == "complete")
                # 明确等本节拍检查完成、调度器进入下一等待，再推进受控时钟。
                await eventually(lambda: all(row["last_checked_at"] == clock.now() for row in Store(path).read_checks(UID)))
                await eventually(lambda: clock.deadlines[-1] == 30)
                clock.advance(30)
                await eventually(lambda: all(row["last_checked_at"] == clock.now() for row in Store(path).read_checks(UID)))
                assert check_counts["99123"] >= 3 and check_counts["99124"] >= 3
                await eventually(lambda: clock.deadlines[-1] == 45)
                clock.advance(45)
                await eventually(lambda: Store(path).read_archive("124")["synced_comment_count"] == 1)
                assert not release.is_set()
                with archive_client(path) as api:
                    assert api.get("/api/archive/dynamics/124").json()["comments_last_attempt"] == "success"
                    assert api.get(ARCHIVE + "/comments").status_code == 200
                release.set()
                await eventually(lambda: Store(path).read_checks(UID)[0]["work"] == "complete")
            finally:
                running.cancel()
                await asyncio.gather(running, return_exceptions=True)

    asyncio.run(scenario())


def test_comment_checkpoint_advances_while_comment_media_remains_independently_pending(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source = CommentSource()
    source.roots[0]["content"]["pictures"] = [{
        "img_src": "https://i0.hdslb.com/bfs/test/comment.png", "img_width": 640, "img_height": 480}]

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)  # 未配置 uploader，不访问真实 OSS。
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            source.count = 8
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            state, archive = snapshot(path)
            assert archive["synced_comment_count"] == 8
            assert archive["comments_last_attempt"] == "success"
            assert state["parts"]["comments"] == state["parts"]["replies"] == "success"
            assert state["parts"]["text"] == state["parts"]["media"] == "success"
            assert state["parts"]["comment_media"] == "pending"
            assert state["work"] == "pending"
            with archive_client(path) as api:
                root = api.get(ARCHIVE + "/comments").json()["items"][0]
                assert root["observed_version"] == root["media_version"] == "comments:8"
                assert root["media"][0]["public_url"] is None
                assert root["work"]["media"] == "pending"
            source.calls.clear()
            await collector.execute_pending()
            assert source.scans() == []  # 媒体失败重试不重扫已成功评论。

    asyncio.run(scenario())


def test_legacy_explicit_initialization_cannot_replace_independent_count_with_detail_count(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source = CommentSource()  # 独立计数7；detail为0。

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            with archive_client(path, source) as api:
                assert api.post("/api/sync/initial", json={"uid": UID}).status_code == 200
            state, archive = snapshot(path)
            assert archive["source_comment_count"] == archive["synced_comment_count"] == 7
            assert state["observed"]["source_comment_count"] == 7
            assert state["parts"]["comments"] == state["parts"]["replies"] == "success"
            source.calls.clear()
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            assert source.scans() == []
            assert snapshot(path)[1]["synced_comment_count"] == 7

    asyncio.run(scenario())


def test_failed_count_observation_does_not_block_trusted_body_edit_or_rescan_comments(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source = CommentSource()

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            before, _ = snapshot(path)
            source.count = None
            source.html = readable_html("计数失败期间的新正文", pictures=[]).replace("13:01", "13:02")
            source.calls.clear()
            await collector.check_once(UID, "123")
            checked, _ = snapshot(path)
            assert checked["check_status"] == "failed"  # 检查聚合：不是两种信号均失败。
            assert checked["check_error"] == "SOURCE_UNAVAILABLE"
            assert checked["observed"]["edit_status"] == "observed"
            assert checked["observed"]["comment_count_status"] == "failed"
            assert checked["observed"]["source_comment_count"] == 7
            assert checked["revision"] == before["revision"] + 1
            await collector.execute_pending()
            state, archive = snapshot(path)
            assert archive["text"] == "计数失败期间的新正文"
            assert archive["synced_version"] == "2026-10-09T13:02+08:00"
            assert archive["synced_comment_count"] == 7
            assert state["parts"]["text"] == "success"
            assert source.scans() == []

    asyncio.run(scenario())
