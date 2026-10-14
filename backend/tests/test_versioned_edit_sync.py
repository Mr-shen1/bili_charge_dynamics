"""24：原始 HTML → 公开 collector → SQLite 重开及归档/管理 HTTP。"""

import asyncio
import sqlite3
from pathlib import Path

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client, readable_html
from backend.tests.collector_support import CHECKS, configured, empty_upstream
from backend.tests.management_support import UID
from backend.tests.collector_clock import ControlledClock, eventually


VERSION_1 = "2026-10-09T13:01+08:00"
VERSION_2 = "2026-10-09T13:02+08:00"


def fixture(name):
    return (Path(__file__).parent / "fixtures/versioned_edit" / f"{name}.html").read_text()


def snapshot(path):
    # 每次启动真实 API/重新打开 SQLite，只经 HTTP 观察。
    with archive_client(path) as api:
        state = api.get(CHECKS).json()["checks"][0]
        archive = api.get("/api/archive/dynamics/123").json()
        # 正文保留不要求最新检查投影不变；投影一致性由 #26 专项验证。
        archive.pop("comment_sync", None)
        return state, archive


@pytest.fixture
def commit_fault(monkeypatch):
    """仅替换 sqlite3 外部连接工厂；SQL、事务和磁盘文件仍是真实 SQLite。"""
    connect = sqlite3.connect

    class Fault:
        armed = None

        def __init__(self):
            self.failures = []

        def arm(self, boundary):
            assert boundary in ("before", "after")
            assert self.armed is None
            self.armed = boundary

    fault = Fault()

    class Connection(sqlite3.Connection):
        def commit(self):
            boundary = fault.armed
            if boundary is None:
                return super().commit()
            fault.armed = None
            assert self.in_transaction
            if boundary == "after":
                super().commit()
                assert not self.in_transaction
            fault.failures.append(boundary)
            raise sqlite3.OperationalError("Injected commit failure")

    def fault_connect(*args, **kwargs):
        return connect(*args, **{**kwargs, "factory": Connection})

    monkeypatch.setattr(sqlite3, "connect", fault_connect)
    return fault


@pytest.mark.parametrize("boundary", ["before", "after"], ids=["before-commit", "after-commit-ack-loss"])
def test_sync_commit_failure_preserves_old_body_and_retries_without_new_signal(tmp_path, commit_fault, boundary):
    # 页面 HTTP 返回后下一次提交：执行阶段的归档观察事务，尚未提交正文 checkpoint。
    # before 在实际 commit 前抛错；after 在实际 commit 成功后抛错（ACK 丢失，不是硬断电）。
    # 不查询 SQL，也不按表名/内部函数筛选事务。
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        html = fixture("v1")
        inject = False
        requests = []

        def upstream(request):
            nonlocal inject
            requests.append(request.url.path)
            if request.url.path.startswith("/opus/"):
                if inject:
                    inject = False
                    commit_fault.arm(boundary)
                return httpx.Response(200, text=html)
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            html = fixture("v2")
            await collector.check_once(UID, "123")
            before, old_archive = snapshot(path)
            assert before["work"] == "pending"
            assert before["observed"]["observed_version"] == VERSION_2
            assert old_archive["synced_version"] == VERSION_1

            inject = True
            await collector.execute_pending()
            assert commit_fault.failures == [boundary]
            failed, archive = snapshot(path)
            assert failed["work"] == "pending"
            assert failed["sync_error"] == "SYNC_INCOMPLETE"
            assert failed["observed"] == before["observed"]
            assert failed["revision"] == 2
            assert failed["last_succeeded_at"] == before["last_succeeded_at"]
            assert archive["text"] == "第一版"
            assert archive["synced_version"] == VERSION_1
            assert archive["comments_last_attempt"] == "success"
            assert failed["parts"]["text"] == failed["parts"]["media"] == "pending"
            if boundary == "before":
                assert archive == old_archive
            else:
                # rollback 无法撤销已成功 commit 的观察；正文 checkpoint 尚未推进。
                assert archive["observed_version"] == VERSION_2
                assert archive["work"]["text"] == archive["work"]["media"] == "pending"
                assert archive["work"]["comments"] == archive["work"]["replies"] == "success"

            requests.clear()
            # 重开后直接领取持久 pending，不调用 check_once，不需要第三次编辑信号。
            reopened = Collector(Store(path), client)
            await reopened.execute_pending()
            state, archive = snapshot(path)
            assert state["work"] == "complete"
            assert state["sync_error"] is None
            assert state["revision"] == 2
            assert state["observed"] == before["observed"]
            assert archive["text"] == "第二版"
            assert archive["synced_version"] == VERSION_2
            assert archive["comments_last_attempt"] == "success"
            assert not any(url in ("/x/v2/reply", "/x/v2/reply/reply") for url in requests)
            completed = snapshot(path)
            requests.clear()
            await reopened.execute_pending()
            assert requests == []
            assert snapshot(path) == completed

    asyncio.run(scenario())


def test_edit_updates_body_without_rescanning_completed_comments(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        edited = False

        def upstream(request):
            if request.url.path.startswith("/opus/"):
                return httpx.Response(200, text=fixture("v2" if edited else "v1"))
            if edited and request.url.path in ("/x/v2/reply", "/x/v2/reply/reply"):
                raise AssertionError("Editing must not rescan completed comments")
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            assert snapshot(path)[0]["work"] == "complete"
            edited = True
            await collector.check_once(UID, "123")
            await collector.execute_pending()

    asyncio.run(scenario())
    state, archive = snapshot(path)
    assert archive["text"] == "第二版"
    assert archive["synced_version"] == VERSION_2
    assert state["work"] == "complete"
    assert archive["comments_last_attempt"] == "success"
    assert archive["published_at"] == "2026-10-09T10:38:16+08:00"


def test_old_body_commits_its_version_without_hiding_new_observation(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        edited = False
        executing = False
        blocked, release = asyncio.Event(), asyncio.Event()

        async def upstream(request):
            if request.url.path.startswith("/opus/"):
                return httpx.Response(200, text=fixture("v2" if edited else "v1"))
            if executing and request.url.path.endswith("/detail") and not release.is_set():
                blocked.set()
                await release.wait()
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            executing = True
            running = asyncio.create_task(collector.execute_pending())
            await asyncio.wait_for(blocked.wait(), 3)
            edited = True
            await collector.check_once(UID, "123")
            release.set()
            await running
            state, archive = snapshot(path)
            assert archive["text"] == "第一版"
            assert archive["synced_version"] == VERSION_1
            assert state["observed"]["observed_version"] == VERSION_2
            assert state["work"] == "pending"
            assert state["parts"]["text"] == "pending"
            assert state["parts"]["media"] == "pending"
            # 不需要第三次新信号，已登记的新版本可在重开后执行。
            await Collector(Store(path), client).execute_pending()

    asyncio.run(scenario())
    state, archive = snapshot(path)
    assert archive["text"] == "第二版"
    assert archive["synced_version"] == VERSION_2
    assert state["work"] == "complete"


@pytest.mark.parametrize("new_version", [VERSION_1, VERSION_2])
def test_recovered_claim_is_fenced_from_late_old_execution(tmp_path, new_version):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        old_blocked, old_release = asyncio.Event(), asyncio.Event()
        new_blocked, new_release = asyncio.Event(), asyncio.Event()
        old_executing = new_executing = False

        async def old_upstream(request):
            if old_executing and request.url.path.endswith("/detail"):
                old_blocked.set()
                await old_release.wait()
            return empty_upstream(request)

        async def new_upstream(request):
            if new_executing and request.url.path.endswith("/detail"):
                new_blocked.set()
                await new_release.wait()
            response = empty_upstream(request)
            if request.url.path.startswith("/opus/"):
                return httpx.Response(200, text=fixture("v2" if new_version == VERSION_2 else "v1"))
            return response

        async with httpx.AsyncClient(transport=httpx.MockTransport(old_upstream)) as old_client, httpx.AsyncClient(
            transport=httpx.MockTransport(new_upstream)
        ) as new_client:
            old = Collector(Store(path), old_client)
            await old.check_once(UID, "123")
            old_executing = True
            old_task = asyncio.create_task(old.execute_pending())
            await asyncio.wait_for(old_blocked.wait(), 3)
            # 模拟重开恢复后仍有旧 I/O 回调迟到：只调用公开运行入口，不改任务表。
            restarted = Collector(Store(path), new_client, clock=ControlledClock())
            await restarted.check_once(UID, "123")
            new_executing = True
            new_task = asyncio.create_task(restarted.run())
            try:
                await asyncio.wait_for(new_blocked.wait(), 3)
                assert snapshot(path)[0]["work"] == "running"
                old_release.set()
                await old_task
                assert snapshot(path)[0]["work"] == "running"
                new_release.set()
                await eventually(lambda: snapshot(path)[0]["work"] == "complete")
            finally:
                old_release.set()
                new_release.set()
                new_task.cancel()
                await asyncio.gather(new_task, old_task, return_exceptions=True)

    asyncio.run(scenario())
    state, archive = snapshot(path)
    assert state["synced_version"] == new_version
    assert archive["last_attempt"] == "success"


def test_untrusted_execution_cannot_replace_old_body_or_checkpoint(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        html = readable_html("可信旧正文", pictures=[]).replace('"count":7', '"count":0')

        def upstream(request):
            if request.url.path.startswith("/opus/"):
                return httpx.Response(200, text=html)
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            html = html.replace("13:01", "13:02")
            await collector.check_once(UID, "123")
            html = html.replace("编辑于 2026年10月09日 13:02", "编辑于 2026年02月30日 13:02").replace("可信旧正文", "不可绑定版本的正文")
            await collector.execute_pending()

    asyncio.run(scenario())
    state, archive = snapshot(path)
    assert archive["text"] == "可信旧正文"
    assert archive["synced_version"] == VERSION_1
    assert archive["edit_status"] == "error"
    assert state["work"] == "pending"
    assert state["last_succeeded_at"] is not None  # 历史成功，不是较新版本成功。


def test_unknown_retry_after_failed_new_body_preserves_old_success(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        html = readable_html("旧版", pictures=[]).replace('"count":7', '"count":0')

        def upstream(request):
            return httpx.Response(200, text=html) if request.url.path.startswith("/opus/") else empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            html = html.replace("13:01", "13:02")
            await collector.check_once(UID, "123")
            good_new_html = html.replace("旧版", "新版")
            html = good_new_html.replace('"para_type": 1', '"para_type": 99')
            await collector.execute_pending()
            assert snapshot(path)[1]["last_attempt"] == "failed"
            html = good_new_html.replace("编辑于 2026年10月09日 13:02", "编辑于 13:02")
            await Collector(Store(path), client).execute_pending()

    asyncio.run(scenario())
    state, archive = snapshot(path)
    assert archive["text"] == "旧版"
    assert archive["synced_version"] == VERSION_1
    assert archive["observed_version"] == VERSION_2
    assert archive["last_attempt"] == "failed"
    assert state["work"] == "pending"


@pytest.mark.parametrize("name, error", [
    ("invalid-date", "SIGNAL_INVALID"), ("no-date", "SIGNAL_INVALID"),
    ("malicious", "SOURCE_UNAVAILABLE"), ("missing-author", "SOURCE_UNAVAILABLE"),
    ("relative", None), ("reordered", None), ("same-signal", None),
])
def test_unusable_or_equivalent_html_never_erases_or_triggers_old_success(tmp_path, name, error, caplog):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        html = fixture("v1")

        def upstream(request):
            return httpx.Response(200, text=html) if request.url.path.startswith("/opus/") else empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            old = snapshot(path)[1]
            html = fixture(name)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            assert snapshot(path)[1] == old

    asyncio.run(scenario())
    state, archive = snapshot(path)
    assert state["revision"] == 1
    assert state["check_error"] == error
    assert state["check_status"] == ("failed" if error else "unchanged")
    assert state["observed"]["observed_version"] == VERSION_1
    assert archive["edited_at"] == archive["synced_version"] == VERSION_1
    assert "FICTIONAL_SECRET" not in str(state) + str(archive) + caplog.text


@pytest.mark.parametrize("name, edited, published", [
    ("relative", None, "2026-10-09T10:38:16+08:00"),
    ("no-published", VERSION_1, None),
])
def test_first_html_without_edit_marker_or_publish_time_initializes_independently(tmp_path, name, edited, published):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        def upstream(request):
            if request.url.path.startswith("/opus/"):
                return httpx.Response(200, text=fixture(name))
            if request.url.path.endswith("/detail"):
                # 来源 detail 也无发布时间，不允许用编辑时间补齐。
                response = empty_upstream(request)
                payload = response.json()
                payload["data"]["item"]["modules"]["module_author"].pop("pub_ts", None)
                return httpx.Response(200, json=payload)
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()

    asyncio.run(scenario())
    state, archive = snapshot(path)
    assert state["work"] == "complete"
    assert archive["content_state"] == "success"
    assert archive["published_at"] == published
    assert archive["edited_at"] == archive["synced_version"] == edited


def test_refetched_body_checkpoint_is_actual_version_not_claim_version(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        html = fixture("v1")

        def upstream(request):
            return httpx.Response(200, text=html) if request.url.path.startswith("/opus/") else empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            html = fixture("v2")
            await collector.execute_pending()
            state, archive = snapshot(path)
            assert state["work"] == "pending"
            assert state["observed"]["observed_version"] == VERSION_1
            assert state["last_succeeded_at"] is None
            assert archive["synced_version"] == VERSION_2
            assert archive["text"] == "第二版"
            # 下一固定检查确认实际版本后才允许完成领取；不用 claim 给正文冒领版本。
            await collector.check_once(UID, "123")
            await Collector(Store(path), client).execute_pending()

    asyncio.run(scenario())
    assert snapshot(path)[0]["work"] == "complete"


@pytest.mark.parametrize("stage", ["registered", "/opus/123", "/x/polymer/web-dynamic/v1/detail", "/x/v2/reply"])
def test_interrupted_stages_recover_without_new_edit_and_duplicate_execution_is_noop(tmp_path, stage):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        blocked = asyncio.Event()
        executing = False

        async def interrupted(request):
            if executing and request.url.path == stage:
                blocked.set()
                await asyncio.Event().wait()
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(interrupted)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            if stage != "registered":
                executing = True
                task = asyncio.create_task(collector.execute_pending())
                await asyncio.wait_for(blocked.wait(), 3)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                assert snapshot(path)[0]["work"] == "running"
                if stage == "/x/v2/reply":
                    state, archive = snapshot(path)
                    assert archive["text"] == "虚构全文\n第二行 <b>仍是文本</b> 🙂"
                    assert archive["synced_version"] == VERSION_1
                    assert state["parts"]["text"] == "success"
                    assert state["parts"]["comments"] == "pending"
                    assert state["last_succeeded_at"] is None

        requests = []

        def upstream(request):
            requests.append(request.url.path)
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client, clock=ControlledClock())
            restarted = asyncio.create_task(collector.run())
            try:
                await eventually(lambda: snapshot(path)[0]["work"] == "complete")
                before = snapshot(path)
                count = len(requests)
                await collector.execute_pending()
                await collector.execute_pending()
                assert len(requests) == count
                assert snapshot(path) == before
            finally:
                restarted.cancel()
                await asyncio.gather(restarted, return_exceptions=True)

    asyncio.run(scenario())
    state, archive = snapshot(path)
    assert state["revision"] == 1
    assert archive["synced_version"] == VERSION_1
    assert state["work"] == "complete"


def test_committed_archive_survives_interruption_before_target_finish_and_run_recovers(tmp_path):
    # Clock 是外部边界：依次记录检查、根成功、回复成功，目标 finish 的第四次 now 中断。
    # 覆盖所有分项已提交、目标尚未 finish 的窗口；模拟控制流中断，不宣称硬断电。
    class Interrupted(BaseException):
        pass

    class InterruptAtFinishClock(ControlledClock):
        def __init__(self):
            super().__init__()
            self.calls = 0

        def now(self):
            self.calls += 1
            if self.calls == 4:
                raise Interrupted("Interrupted before target finish")
            return super().now()

    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        requests = []

        def upstream(request):
            requests.append(request.url.path)
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            clock = InterruptAtFinishClock()
            collector = Collector(Store(path), client, clock=clock)
            await collector.check_once(UID, "123")
            with pytest.raises(Interrupted, match="Interrupted before target finish"):
                await collector.execute_pending()
            assert clock.calls == 4
            assert requests.count("/x/v2/reply") == 1

            running, committed_archive = snapshot(path)
            assert running["work"] == "running"
            assert running["revision"] == 1
            assert running["last_succeeded_at"] is None
            assert running["sync_error"] is None
            assert running["parts"] == dict.fromkeys(
                ("text", "media", "comments", "replies", "comment_media"), "success")
            assert committed_archive["work"] == dict.fromkeys(
                ("text", "media", "comments", "replies"), "success")
            assert committed_archive["text"] == "虚构全文\n第二行 <b>仍是文本</b> 🙂"
            assert committed_archive["synced_version"] == VERSION_1
            assert committed_archive["synced_comment_count"] == 0
            assert committed_archive["comments_last_attempt"] == "success"
            for field in ("root_comments_last_succeeded_at", "replies_last_succeeded_at", "comments_last_succeeded_at"):
                assert committed_archive[field] == "2030-01-01T00:00:00+00:00"
            # API 重开只能观察，不能擅自把 running 恢复或补成功时间。
            assert snapshot(path) == (running, committed_archive)

            requests.clear()
            # 只用取得真实进程锁的 run 入口恢复；来源仍是原信号，没有新编辑。
            reopened = Collector(Store(path), client, clock=ControlledClock())
            restarted = asyncio.create_task(reopened.run())
            try:
                await eventually(lambda: snapshot(path)[0]["work"] == "complete"
                                 and snapshot(path)[0]["check_status"] == "unchanged")
                complete, archive = snapshot(path)
                assert complete["revision"] == 1
                assert complete["observed"] == running["observed"]
                assert complete["last_succeeded_at"] is not None
                assert complete["sync_error"] is None
                assert complete["parts"] == running["parts"]
                assert archive == committed_archive
                assert requests == ["/opus/123", "/x/v2/reply/count"]
                assert not any(url in ("/x/v2/reply", "/x/v2/reply/reply") for url in requests)

                requests.clear()
                await reopened.execute_pending()
                await reopened.execute_pending()
                assert requests == []
                assert snapshot(path) == (complete, archive)
            finally:
                restarted.cancel()
                await asyncio.gather(restarted, return_exceptions=True)

    asyncio.run(scenario())


def test_successful_body_does_not_complete_failed_comments_or_unuploaded_media(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        comments_fail = True

        def upstream(request):
            if request.url.path.startswith("/opus/"):
                html = fixture("v1").replace('"paragraphs": [', '"paragraphs": [{"para_type":2,"pic":{"pics":[{"url":"https://i0.hdslb.com/fictional.png","width":10,"height":20}]}},')
                return httpx.Response(200, text=html)
            if comments_fail and request.url.path == "/x/v2/reply":
                raise httpx.ConnectError("FICTIONAL_SECRET", request=request)
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            state, archive = snapshot(path)
            assert state["parts"]["text"] == "success"
            assert state["parts"]["comments"] == "pending"
            assert state["parts"]["media"] == "pending"
            assert archive["root_comments_last_attempt"] == "failed"
            assert archive["synced_version"] == VERSION_1
            assert state["last_succeeded_at"] is None
            comments_fail = False
            await Collector(Store(path), client).execute_pending()

    asyncio.run(scenario())
    state, archive = snapshot(path)
    assert state["parts"]["comments"] == state["parts"]["replies"] == "success"
    assert state["parts"]["media"] == state["work"] == "pending"
    assert archive["media"][0]["public_url"] is None
    assert "FICTIONAL_SECRET" not in str(state) + str(archive)


def test_v10_database_migrates_without_losing_archive_observation_or_pending_edit(tmp_path):
    import sqlite3

    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def prepare():
        async with httpx.AsyncClient(transport=httpx.MockTransport(empty_upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
        def upstream(request):
            if request.url.path.startswith("/opus/"):
                return httpx.Response(200, text=fixture("v2"))
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            await Collector(Store(path), client).check_once(UID, "123")

    asyncio.run(prepare())
    before = snapshot(path)
    # 固定旧 schema 输入夹具；不经 SQL 观察业务结果。
    with sqlite3.connect(path) as database:
        database.execute("ALTER TABLE target_checks DROP COLUMN claim_token")
        database.execute("DROP TABLE recent_discoveries")
        database.execute("PRAGMA user_version = 10")
    assert snapshot(path) == before

    async def resume():
        def upstream(request):
            return httpx.Response(200, text=fixture("v2")) if request.url.path.startswith("/opus/") else empty_upstream(request)
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            await Collector(Store(path), client).execute_pending()

    asyncio.run(resume())
    state, archive = snapshot(path)
    assert state["work"] == "complete"
    assert archive["text"] == "第二版"
    assert archive["synced_version"] == VERSION_2
