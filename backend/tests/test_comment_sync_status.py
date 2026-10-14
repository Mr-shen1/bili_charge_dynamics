"""26：原始 fixture transport → Collector 公开入口 → 临时 SQLite → HTTP。"""

import asyncio
import copy
import json
from pathlib import Path

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client, author_html, readable_html, detail_json
from backend.tests.collector_clock import ControlledClock
from backend.tests.collector_support import CHECKS, configured, empty_upstream
from backend.tests.management_support import UID
from backend.tests.root_support import root_fixture


ARCHIVE = "/api/archive/dynamics/123"
FIXTURES = Path(__file__).parent / "fixtures"


class CommentSource:
    def __init__(self):
        self.count = 70  # 不用根页或本地 2 + 5 代填独立来源数。
        self.roots = root_fixture()["data"]["replies"]
        for root in self.roots:
            root["content"]["pictures"] = []
        self.reply_payload = json.loads((FIXTURES / "replies.json").read_text())
        self.replies = self.reply_payload["data"]["replies"]
        self.html = readable_html(pictures=[])
        self.fail_root_page = self.fail_reply_page = None
        self.calls = []
        self.blocked = False

    def __call__(self, request):
        path = request.url.path
        self.calls.append(path)
        if path.startswith("/opus/"):
            return httpx.Response(200, text=self.html)
        if path == "/x/v2/reply/count":
            payload = json.loads((FIXTURES / "comment-count.json").read_text())
            payload["data"]["count"] = self.count
            return httpx.Response(200, json=payload)
        if path in ("/x/v2/reply", "/x/v2/reply/reply"):
            page = int(request.url.params["pn"])
            is_root = path == "/x/v2/reply"
            if page == (self.fail_root_page if is_root else self.fail_reply_page):
                raise httpx.ReadError("FICTIONAL_SECRET_COOKIE https://secret.invalid/token")
            payload = copy.deepcopy(root_fixture() if is_root else self.reply_payload)
            items = self.roots if is_root else self.replies
            payload["data"]["page"].update(num=page, count=len(items))
            if is_root:
                payload["data"]["page"]["acount"] = len(self.roots) + len(self.replies)
            payload["data"]["replies"] = items[(page - 1) * 20:page * 20] or None
            return httpx.Response(200, json=payload)
        if self.blocked and path.endswith("/detail"):
            payload = detail_json()
            payload["data"]["item"]["modules"]["module_dynamic"]["major"] = {"type": "MAJOR_TYPE_BLOCKED"}
            return httpx.Response(200, json=payload)
        return empty_upstream(request)


def snapshot(path):
    # API transport 未装上游；任何读取触发采集都会失败。
    with archive_client(path) as api:
        check = api.get(CHECKS)
        detail = api.get(ARCHIVE)
        assert check.status_code == detail.status_code == 200
        return check.json()["checks"][0], detail.json()


def test_root_success_reply_failure_has_independent_persistent_times_and_errors(tmp_path, caplog):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source, clock = CommentSource(), ControlledClock()
    source.fail_reply_page = 2  # 保留第一页五条，但未通过必要尾页确认。

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=clock)
            await collector.check_once(UID, "123")
            clock.advance(15)
            await collector.execute_pending()
            check, archive = snapshot(path)
            assert check["observed"]["source_comment_count"] == archive["source_comment_count"] == 70
            assert archive["local_comment_count"] == 2
            assert archive["local_reply_count"] == 5
            assert check["parts"]["comments"] == "success"
            assert check["parts"]["replies"] == "pending"
            assert check["root_comments_last_attempt"] == "success"
            assert check["replies_last_attempt"] == "failed"
            assert check["root_comments_last_succeeded_at"] == "2030-01-01T00:00:15+00:00"
            assert check["replies_last_succeeded_at"] is None
            assert check["comments_last_succeeded_at"] is None
            assert check["root_comments_error"] is None
            assert check["replies_error"] == check["comments_error"] == "REPLIES_FAILED"
            assert check["synced_root_comment_count"] == 70
            assert check["synced_reply_comment_count"] is None
            for field in ("root_comments_last_succeeded_at", "replies_last_succeeded_at",
                          "comments_last_succeeded_at", "root_comments_error", "replies_error", "comments_error"):
                assert archive[field] == check[field]
            assert archive["comment_sync"] == check
            assert "FICTIONAL_SECRET" not in json.dumps(archive) + caplog.text
            assert "secret.invalid" not in json.dumps(check) + caplog.text
            # 关闭重开由 snapshot 的 API lifespan 及新 Store 验证真实持久化。
            assert snapshot(path) == (check, archive)

    asyncio.run(scenario())


def test_failed_root_scan_preserves_old_success_and_retries_without_new_signal(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source, clock = CommentSource(), ControlledClock()

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=clock)
            await collector.check_once(UID, "123")
            clock.advance(15)
            await collector.execute_pending()
            before, saved = snapshot(path)
            assert before["work"] == "complete"
            source.count = 71
            source.fail_root_page = 2
            clock.advance(30)
            await collector.check_once(UID, "123")
            check, archive = snapshot(path)
            assert archive["source_comment_count"] == 70  # 尚未执行，不覆盖实际归档。
            assert archive["comment_sync"]["observed"]["source_comment_count"] == 71
            assert check["parts"]["comments"] == check["parts"]["replies"] == "pending"
            assert check["comments_last_succeeded_at"] == before["comments_last_succeeded_at"]
            clock.advance(45)
            await collector.execute_pending()
            failed, archive = snapshot(path)
            assert failed["root_comments_last_attempt"] == "failed"
            assert failed["replies_last_attempt"] == "unconfirmed"
            assert failed["root_comments_error"] == failed["comments_error"] == "ROOT_COMMENTS_FAILED"
            assert failed["replies_error"] is None  # 根失败，不冒充实际回复页失败。
            assert failed["synced_comment_count"] == failed["synced_root_comment_count"] == 70
            assert failed["synced_reply_comment_count"] == 70
            for field in ("root_comments_last_succeeded_at", "replies_last_succeeded_at", "comments_last_succeeded_at"):
                assert failed[field] == before[field] == "2030-01-01T00:00:15+00:00"
            assert archive["text"] == saved["text"]
            with archive_client(path) as api:
                roots = api.get(ARCHIVE + "/comments").json()["items"]
                replies = api.get(ARCHIVE + "/comments/900719925474099312346/replies").json()["items"]
                assert len(roots) == 2
                assert len(replies) == 3
            # 同计数、同版本，重开后公开执行入口仍重试整轮。
            source.fail_root_page = None
            source.calls.clear()
            clock.advance(60)
            collector = Collector(Store(path), client, clock=clock)
            await collector.check_once(UID, "123")
            unchanged, _ = snapshot(path)
            assert unchanged["revision"] == failed["revision"]
            assert unchanged["check_status"] == "unchanged"
            assert unchanged["comments_error"] == "ROOT_COMMENTS_FAILED"
            await collector.execute_pending()
            check, archive = snapshot(path)
            assert check["work"] == "complete"
            assert check["comments_last_attempt"] == "success"
            assert check["synced_comment_count"] == 71
            assert "/x/v2/reply" in source.calls and "/x/v2/reply/reply" in source.calls
            for field in ("root_comments_last_succeeded_at", "replies_last_succeeded_at", "comments_last_succeeded_at"):
                assert check[field] == "2030-01-01T00:01:00+00:00"
            assert check["comments_error"] is check["root_comments_error"] is check["replies_error"] is None
            # 无变化检查不能把检查时间冒充分项成功时间。
            source.calls.clear()
            clock.advance(75)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            unchanged, _ = snapshot(path)
            assert unchanged["last_checked_at"] == "2030-01-01T00:01:15+00:00"
            assert unchanged["comments_last_succeeded_at"] == check["comments_last_succeeded_at"]
            assert unchanged["root_comments_last_succeeded_at"] == check["root_comments_last_succeeded_at"]
            assert unchanged["replies_last_succeeded_at"] == check["replies_last_succeeded_at"]
            assert "/x/v2/reply" not in source.calls
            assert "/x/v2/reply/reply" not in source.calls

    asyncio.run(scenario())


def test_reply_failure_retries_after_reopen_without_advancing_revision(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source, clock = CommentSource(), ControlledClock()
    source.fail_reply_page = 1

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=clock)
            await collector.check_once(UID, "123")
            clock.advance(15)
            await collector.execute_pending()
            failed, archive = snapshot(path)
            assert archive["local_reply_count"] == 0
            assert failed["root_comments_last_succeeded_at"] == "2030-01-01T00:00:15+00:00"
            assert failed["replies_last_succeeded_at"] is None
            assert failed["replies_error"] == "REPLIES_FAILED"
            source.fail_reply_page = None
            clock.advance(30)
            # 不重新建目标，不需要再次 check_once 登记新信号。
            await Collector(Store(path), client, clock=clock).execute_pending()
            check, archive = snapshot(path)
            assert check["revision"] == failed["revision"]
            assert check["last_checked_at"] == failed["last_checked_at"]
            assert check["work"] == "complete"
            assert check["comments_last_attempt"] == "success"
            assert archive["local_reply_count"] == 5
            assert check["replies_error"] is check["comments_error"] is None
            assert check["replies_last_succeeded_at"] == check["comments_last_succeeded_at"] == "2030-01-01T00:00:30+00:00"

    asyncio.run(scenario())


@pytest.mark.parametrize("total", [None, 0, 70])
def test_restricted_body_does_not_block_comment_success_unknown_is_not_zero(tmp_path, total):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source, clock = CommentSource(), ControlledClock()
    source.count = total
    source.html = author_html() + "暂无权查看当前评论"
    source.blocked = True
    if total == 0:
        source.roots = source.replies = []

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=clock)
            await collector.check_once(UID, "123")
            with archive_client(path) as api:
                unchecked = api.get(CHECKS).json()["checks"][0]
                assert unchecked["local_comment_count"] is unchecked["local_reply_count"] is None
                assert unchecked["comments_last_succeeded_at"] is None
            clock.advance(15)
            await collector.execute_pending()
            check, archive = snapshot(path)
            assert archive["content_state"] == archive["last_attempt"] == "restricted"
            assert check["work"] == "pending"  # 评论成功不冒充正文/媒体完成。
            assert check["parts"]["text"] == "pending"
            assert check["parts"]["comments"] == check["parts"]["replies"] == "success"
            assert check["comments_last_attempt"] == "success"
            assert archive["source_comment_count"] == archive["synced_comment_count"] == total
            assert check["observed"].get("source_comment_count") == total
            assert check["synced_comment_count"] == check["synced_root_comment_count"] == check["synced_reply_comment_count"] == total
            assert check["observed"]["comment_count_status"] == ("failed" if total is None else "observed")
            assert check["local_comment_count"] == (0 if total == 0 else 2)
            assert check["local_reply_count"] == (0 if total == 0 else 5)
            for field in ("root_comments_last_succeeded_at", "replies_last_succeeded_at", "comments_last_succeeded_at"):
                assert check[field] == archive[field] == "2030-01-01T00:00:15+00:00"
            assert check["root_comments_error"] is check["replies_error"] is check["comments_error"] is None
            assert check["last_succeeded_at"] is None
            assert archive["comment_sync"] == check
            # 正文仍可重试，但已成功的评论分项不得因此重扫或更新成功时间。
            source.calls.clear()
            clock.advance(30)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            after, _ = snapshot(path)
            assert after["comments_last_succeeded_at"] == check["comments_last_succeeded_at"]
            assert "/x/v2/reply" not in source.calls
            assert "/x/v2/reply/reply" not in source.calls

    asyncio.run(scenario())


def test_legacy_success_without_timestamp_is_not_backdated_or_resynchronized(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    store = Store(path)
    generation = store.claim_archive(UID, "123")
    # 用公开仓储装配旧 Archive 文档：旧成功 checkpoint 有效，但从未记录分项时间。
    # 不读取/断言 SQL、私有属性或内部锁；兼容输入不伪称新采集的成功结果。
    store.observe_archive("123", generation, {
        "edit_status": "observed", "observed_version": "2026-10-09T13:01+08:00",
        "source_comment_count": 0, "comment_locator": {"oid": "99123", "type": 17},
        "root_comments_last_attempt": "success", "replies_last_attempt": "success",
        "comments_last_attempt": "success", "synced_root_comment_count": 0,
        "synced_reply_comment_count": 0, "synced_comment_count": 0,
        "work": dict.fromkeys(("text", "media", "comments", "replies"), "success"),
    })
    store.finish_archive("123", generation, "success", {}, "2026-10-09T13:01+08:00")
    # text 曾 pending，由公开正文提交保存可读历史文本，媒体空确认后建立旧基线。
    store.observe_archive("123", generation, {"text": "旧档案仍可阅读", "work":
        dict.fromkeys(("text", "media", "comments", "replies"), "success")})
    source, clock = CommentSource(), ControlledClock()
    source.count = 0

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=clock)
            check, archive = snapshot(path)
            assert check["check_status"] == "unchecked"
            assert archive["text"] == "旧档案仍可阅读"
            for field in ("root_comments_last_succeeded_at", "replies_last_succeeded_at", "comments_last_succeeded_at"):
                assert check[field] is archive[field] is None
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            check, archive = snapshot(path)
            assert check["work"] == "complete"
            assert check["last_succeeded_at"] is None
            assert check["comments_last_attempt"] == "success"
            assert "/x/v2/reply" not in source.calls
            assert archive["text"] == "旧档案仍可阅读"
            for field in ("root_comments_last_succeeded_at", "replies_last_succeeded_at", "comments_last_succeeded_at"):
                assert check[field] is archive[field] is None
            # 旧配置、归档和新状态在再次开启 API 后不丢失；新列表首读补未知 null。
            with archive_client(path) as api:
                item = api.get("/api/archive/dynamics").json()["items"][0]
                assert item["text"] == archive["text"]
                assert item["root_comments_last_succeeded_at"] is None
                assert item["replies_last_succeeded_at"] is None
                assert item["comments_last_succeeded_at"] is None
            assert snapshot(path) == (check, archive)

    asyncio.run(scenario())


def test_detail_projects_new_observation_while_old_execution_finishes(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source, clock = CommentSource(), ControlledClock()

    async def scenario():
        started, release = asyncio.Event(), asyncio.Event()

        async def upstream(request):
            if request.url.path == "/x/v2/reply/reply" and not release.is_set():
                started.set()
                await release.wait()
            return source(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client, clock=clock)
            await collector.check_once(UID, "123")
            clock.advance(15)
            execution = asyncio.create_task(collector.execute_pending())
            try:
                await asyncio.wait_for(started.wait(), 3)
                running, archive = snapshot(path)
                assert running["work"] == "running"
                assert archive["comment_sync"] == running
                assert running["parts"]["comments"] == "success"
                assert running["parts"]["replies"] == "pending"
                assert running["root_comments_last_succeeded_at"] == "2030-01-01T00:00:15+00:00"
                assert running["comments_last_succeeded_at"] is None
                source.count = 71
                clock.advance(30)
                await collector.check_once(UID, "123")
                newer, archive = snapshot(path)
                assert archive["source_comment_count"] == 70
                assert newer["observed"]["source_comment_count"] == 71
                assert archive["comment_sync"] == newer
                assert newer["parts"]["comments"] == newer["parts"]["replies"] == "pending"
                clock.advance(45)
            finally:
                release.set()
                await execution
            check, archive = snapshot(path)
            assert check["work"] == "pending"
            assert check["synced_comment_count"] == archive["synced_comment_count"] == 70
            assert check["comments_last_attempt"] == "success"  # 旧执行确实完成，不冒领新计数。
            assert check["root_comments_last_succeeded_at"] == "2030-01-01T00:00:15+00:00"
            assert check["replies_last_succeeded_at"] == check["comments_last_succeeded_at"] == "2030-01-01T00:00:45+00:00"
            assert check["parts"]["comments"] == check["parts"]["replies"] == "pending"
            assert archive["comment_sync"] == check
            assert check["last_succeeded_at"] is None

    asyncio.run(scenario())


def test_archive_cursor_freezes_attempt_checkpoint_times_and_errors_across_reopen(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path, ids=("123", "124"))
    first_source, second_source, clock = CommentSource(), CommentSource(), ControlledClock()
    second_source.html = readable_html(id="124", pictures=[])
    second_source.count = 0
    second_source.roots = second_source.replies = []

    async def scenario():
        started = {"99123": asyncio.Event(), "99124": asyncio.Event()}
        release = asyncio.Event()

        async def upstream(request):
            if request.url.path == "/x/v2/reply" and not release.is_set():
                started[request.url.params["oid"]].set()
                await release.wait()
            is_second = (request.url.path == "/opus/124" or request.url.params.get("id") == "124"
                         or request.url.params.get("oid") == "99124")
            return (second_source if is_second else first_source)(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client, clock=clock)
            await collector.check_once(UID, "123")
            await collector.check_once(UID, "124")
            execution = asyncio.create_task(collector.execute_pending())
            try:
                await asyncio.wait_for(asyncio.gather(*(event.wait() for event in started.values())), 3)
                with archive_client(path) as api:
                    first = api.get("/api/archive/dynamics", params={"limit": 1}).json()
                    assert first["items"][0]["id"] == "123"
                    cursor = first["next_cursor"]
                    assert cursor is not None
                    frozen = api.get("/api/archive/dynamics", params={"limit": 1, "cursor": cursor}).json()
                    assert frozen["items"][0]["id"] == "124"
                    assert frozen["items"][0]["comments_last_attempt"] == "pending"
                    assert frozen["items"][0]["comments_last_succeeded_at"] is None
                    assert frozen["items"][0]["synced_comment_count"] is None
                    assert "comment_sync" not in frozen["items"][0]
                clock.advance(15)
            finally:
                release.set()
                await execution
            with archive_client(path) as api:
                detail = api.get("/api/archive/dynamics/124").json()
                assert detail["comments_last_attempt"] == "success"
                assert detail["synced_comment_count"] == 0
                assert detail["comments_last_succeeded_at"] == "2030-01-01T00:00:15+00:00"
                assert api.get("/api/archive/dynamics", params={"limit": 1, "cursor": cursor}).json() == frozen
            # 下一次来源检查、根失败不改写旧 cursor 的尝试/错误/时间/正文元信息。
            second_source.count = 1
            second_source.fail_root_page = 1
            clock.advance(30)
            await collector.check_once(UID, "124")
            await collector.execute_pending()
            with archive_client(path) as api:
                detail = api.get("/api/archive/dynamics/124").json()
                assert detail["comments_last_attempt"] == "failed"
                assert detail["comments_error"] == "ROOT_COMMENTS_FAILED"
                assert detail["synced_comment_count"] == 0
                assert detail["comment_sync"]["observed"]["source_comment_count"] == 1
                assert api.get("/api/archive/dynamics", params={"limit": 1, "cursor": cursor}).json() == frozen
                new_first = api.get("/api/archive/dynamics", params={"limit": 1}).json()
                new_page = api.get("/api/archive/dynamics", params={"limit": 1, "cursor": new_first["next_cursor"]}).json()
                assert new_page["items"][0]["comments_error"] == "ROOT_COMMENTS_FAILED"
                assert new_page["items"][0]["comments_last_succeeded_at"] == "2030-01-01T00:00:15+00:00"
                assert frozen["items"][0]["text"] == new_page["items"][0]["text"]
                assert new_page["next_cursor"] is frozen["next_cursor"] is None

    asyncio.run(scenario())


def test_new_root_success_does_not_advance_old_reply_or_whole_round_success_time(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source, clock = CommentSource(), ControlledClock()

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=clock)
            await collector.check_once(UID, "123")
            clock.advance(15)
            await collector.execute_pending()
            before, saved = snapshot(path)
            source.count = 71
            source.fail_reply_page = 2
            clock.advance(30)
            await collector.check_once(UID, "123")
            clock.advance(45)
            await collector.execute_pending()
            check, archive = snapshot(path)
            assert check["synced_root_comment_count"] == 71
            assert check["synced_reply_comment_count"] == check["synced_comment_count"] == 70
            assert check["root_comments_last_succeeded_at"] == "2030-01-01T00:00:45+00:00"
            assert check["replies_last_succeeded_at"] == before["replies_last_succeeded_at"] == "2030-01-01T00:00:15+00:00"
            assert check["comments_last_succeeded_at"] == before["comments_last_succeeded_at"] == "2030-01-01T00:00:15+00:00"
            assert check["parts"]["comments"] == "success"
            assert check["parts"]["replies"] == "pending"
            assert check["comments_last_attempt"] == check["replies_last_attempt"] == "failed"
            assert check["replies_error"] == check["comments_error"] == "REPLIES_FAILED"
            assert archive["local_comment_count"] == saved["local_comment_count"] == 2
            assert archive["local_reply_count"] == saved["local_reply_count"] == 5
            assert archive["text"] == saved["text"]
            assert archive["comment_sync"] == check
            assert snapshot(path) == (check, archive)

    asyncio.run(scenario())
