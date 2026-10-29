"""29：中断重启、较新观察与来源失败不能丢失旧归档/未完成信息。"""

import asyncio
import sqlite3

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.media import ImageDownloader
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client, archive_content
from backend.tests.collector_clock import ControlledClock, eventually
from backend.tests.collector_support import configured
from backend.tests.inflight_support import CHANGES, prepare, remove, restore
from backend.tests.management_support import BASE, UID
from backend.tests.test_inflight_lifecycle import checks
from backend.tests.test_recent_window_content import (
    RecentContentSource, RecordingOSS, RECENT_ID, ROOT_ID,
    read_content, read_all, read_state, assert_complete_content, no_real_oss_environment,
)


def read_partial(path):
    archive_url = f"/api/archive/dynamics/{RECENT_ID}"
    with archive_client(path) as api:
        document = archive_content(api.get(archive_url).json())
        roots = read_all(api, archive_url + "/comments")
        reply_url = archive_url + f"/comments/{ROOT_ID}/replies"
        if any(root["id"] == ROOT_ID for root in roots):
            replies = read_all(api, reply_url)
        else:
            assert api.get(reply_url).status_code == 404
            replies = []
        return document, roots, replies


@pytest.mark.parametrize("change", CHANGES)
@pytest.mark.parametrize("phase", ["body", "roots", "replies", "dynamic_upload", "comment_upload"])
def test_interrupted_sync_stays_stopped_across_locked_restart_and_resumes_pending(tmp_path, change, phase):
    path = tmp_path / "recovery.sqlite"
    prepare(path, change)
    source = RecentContentSource()

    async def scenario():
        blocked, release = asyncio.Event(), asyncio.Event()
        syncing = False
        clock = ControlledClock()
        routes = {"body": f"/opus/{RECENT_ID}", "roots": "/x/v2/reply", "replies": "/x/v2/reply/reply"}

        async def upstream(request):
            response = source(request)
            if syncing and request.url.path == routes.get(phase):
                blocked.set()
                await release.wait()
            return response

        class DelayedOSS(RecordingOSS):
            async def upload(self, key, content, content_type):
                if phase == ("comment_upload" if "/comments/" in key else "dynamic_upload"):
                    blocked.set()
                    await release.wait()
                return await super().upload(key, content, content_type)

        uploader = DelayedOSS()
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client, httpx.AsyncClient(
            transport=httpx.MockTransport(source.download)
        ) as media_client:
            collector = Collector(Store(path), client, ImageDownloader(media_client), uploader, clock=clock)
            if change == "window":
                assert await collector.discover_once(UID)
            assert await collector.check_once(UID, RECENT_ID)
            syncing = True
            execution = asyncio.create_task(collector.execute_pending())
            restarted = None
            try:
                await asyncio.wait_for(blocked.wait(), 3)
                await remove(path, change, collector, source)
                execution.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await execution
                interrupted = checks(path)[RECENT_ID]
                partial = read_partial(path)
                assert interrupted["work"] == "running" and not interrupted["active"]
                # API 重开不会自行恢复/领取，旧分项和 observed 完整保留。
                assert checks(path)[RECENT_ID] == interrupted and read_partial(path) == partial
                source.calls.clear()
                restarted = asyncio.create_task(Collector(
                    Store(path), client, ImageDownloader(media_client), uploader, clock=clock,
                ).run())
                await eventually(lambda: checks(path)[RECENT_ID]["work"] == "pending" and 15 in clock.deadlines)
                recovered = checks(path)[RECENT_ID]
                assert not recovered["active"] and recovered["observed"] == interrupted["observed"]
                assert recovered["revision"] == interrupted["revision"]
                assert recovered["last_succeeded_at"] == interrupted["last_succeeded_at"]
                assert read_partial(path) == partial
                assert not any(route == f"/opus/{RECENT_ID}" for route, _ in source.calls)
                # 等本轮发现真正提交再停，避免人为中断一个新的 discovery 领取。
                if change == "window":
                    await eventually(lambda: read_state(path)[0]["status"] == "discovered")
                # 正式进程已取得锁并恢复 pending；停下后新入口能继续实际分项。
                restarted.cancel()
                await asyncio.gather(restarted, return_exceptions=True)
                await restore(path, change, collector, source)
                release.set()
                reopened = Collector(Store(path), client, ImageDownloader(media_client), uploader, clock=clock)
                await reopened.execute_pending()
                assert checks(path)[RECENT_ID]["work"] == "complete"
                assert_complete_content(read_content(path))
                assert len(uploader.keys) == 3
            finally:
                release.set()
                execution.cancel()
                tasks = [execution]
                if restarted is not None:
                    restarted.cancel()
                    tasks.append(restarted)
                await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(scenario())


def test_new_observation_during_old_upload_survives_reinclusion_and_old_completion(tmp_path):
    path = tmp_path / "new-observation.sqlite"
    configured(path, (RECENT_ID,))
    source = RecentContentSource()

    async def scenario():
        blocked, release = asyncio.Event(), asyncio.Event()
        newer = False

        def upstream(request):
            if newer and request.url.path == "/x/v2/reply/count":
                return httpx.Response(200, json={"code": 0, "data": {"count": 8}})
            return source(request)

        class DelayedOSS(RecordingOSS):
            async def upload(self, key, content, content_type):
                blocked.set()
                await release.wait()
                return await super().upload(key, content, content_type)

        uploader = DelayedOSS()
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client, httpx.AsyncClient(
            transport=httpx.MockTransport(source.download)
        ) as media_client:
            collector = Collector(Store(path), client, ImageDownloader(media_client), uploader)
            assert await collector.check_once(UID, RECENT_ID)
            task = asyncio.create_task(collector.execute_pending())
            try:
                await asyncio.wait_for(blocked.wait(), 3)
                await remove(path, "stop", collector, source)
                await restore(path, "stop", collector, source)
                newer = True
                assert await collector.check_once(UID, RECENT_ID)  # 慢同步不禁止新检查。
                observed = checks(path)[RECENT_ID]
                assert observed["revision"] == 2 and observed["observed"]["source_comment_count"] == 8
                release.set()
                await task
                current = checks(path)[RECENT_ID]
                assert current["work"] == "pending" and current["revision"] == 2
                assert current["observed"] == observed["observed"]
                assert current["synced_comment_count"] == 7 and current["parts"]["comments"] == "pending"
                await Collector(Store(path), client, ImageDownloader(media_client), uploader).execute_pending()
                current = checks(path)[RECENT_ID]
                assert current["work"] == "complete" and current["synced_comment_count"] == 8
                # 评论不可编辑：新评论计数不改变根图版本，根图不重复上传；动态图也不重复上传。
                assert len(uploader.keys) == 3
                assert sum("/comments/" not in key for key in uploader.keys) == 2
            finally:
                release.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


@pytest.mark.parametrize("change", CHANGES)
@pytest.mark.parametrize("failure_status", [403, 404, 503])
def test_source_failure_during_config_change_preserves_successful_content_and_retry(tmp_path, change, failure_status, caplog):
    path = tmp_path / "failure.sqlite"
    prepare(path, change)
    source, uploader = RecentContentSource(), RecordingOSS()

    async def scenario():
        blocked, release = asyncio.Event(), asyncio.Event()
        stage = "baseline"

        async def upstream(request):
            route = request.url.path
            if stage == "failed" and not route.endswith("/feed/space"):
                if route == "/x/v2/reply":
                    blocked.set()
                    await release.wait()
                return httpx.Response(failure_status, text="FICTIONAL_SECRET_SOURCE")
            if stage != "baseline" and route == "/x/v2/reply/count":
                return httpx.Response(200, json={"code": 0, "data": {"count": 8}})
            response = source(request)
            if stage != "baseline" and route.startswith("/opus/"):
                return httpx.Response(200, text=response.text.replace("刚刚", "编辑于 2026年10月10日 13:01"))
            return response

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client, httpx.AsyncClient(
            transport=httpx.MockTransport(source.download)
        ) as media_client:
            collector = Collector(Store(path), client, ImageDownloader(media_client), uploader)
            if change == "window":
                assert await collector.discover_once(UID)
            assert await collector.check_once(UID, RECENT_ID)
            await collector.execute_pending()
            baseline = read_content(path)
            assert_complete_content(baseline)
            stage = "new"
            assert await collector.check_once(UID, RECENT_ID)
            latest = checks(path)[RECENT_ID]
            assert latest["revision"] == 2 and latest["work"] == "pending"
            stage = "failed"
            assert await collector.check_once(UID, RECENT_ID)
            failed_check = checks(path)[RECENT_ID]
            assert failed_check["observed"]["source_comment_count"] == 8
            assert failed_check["observed"]["comment_count_status"] == "failed"
            task = asyncio.create_task(collector.execute_pending())
            try:
                await asyncio.wait_for(blocked.wait(), 3)
                await remove(path, change, collector, source)
                release.set()
                await task
                saved = read_content(path)
                assert saved[0]["text"] == baseline[0]["text"]
                assert saved[0]["synced_version"] == baseline[0]["synced_version"]
                assert saved[0]["media"] == baseline[0]["media"]
                assert saved[2] == baseline[2]  # 回复成功内容不被删除。
                for root, old in zip(saved[1], baseline[1], strict=True):
                    # 新观察允许将根媒体投影改为 pending；实际成功数据保持原样。
                    for field in ("id", "dynamic_id", "author", "published_at", "text", "media_sources",
                                  "media", "previous_media", "media_version"):
                        assert root[field] == old[field]
                current = checks(path)[RECENT_ID]
                assert not current["active"] and current["work"] == "pending"
                assert current["synced_comment_count"] == 7
                assert current["observed"]["source_comment_count"] == 8
                assert current["check_error"] == "SOURCE_UNAVAILABLE"
                assert current["sync_error"] == "SYNC_INCOMPLETE"
                assert "FICTIONAL_SECRET" not in str(current) + str(saved) + caplog.text
                await restore(path, change, collector, source)
                stage = "new"
                reopened = Collector(Store(path), client, ImageDownloader(media_client), uploader)
                await reopened.execute_pending()  # 信号无需再次变化，重开后恢复分项。
                assert checks(path)[RECENT_ID]["work"] == "complete"
                assert checks(path)[RECENT_ID]["synced_comment_count"] == 8
                assert read_content(path)[0]["synced_version"] == "2026-10-10T13:01+08:00"
            finally:
                release.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


def test_v12_migration_failure_rolls_back_and_retries_without_losing_pending(tmp_path):
    path = tmp_path / "v12-rollback.sqlite"
    configured(path, (RECENT_ID,))

    async def record():
        async with httpx.AsyncClient(transport=httpx.MockTransport(RecentContentSource())) as client:
            assert await Collector(Store(path), client).check_once(UID, RECENT_ID)

    asyncio.run(record())
    before = checks(path)
    with sqlite3.connect(path) as database:
        database.execute("DROP TABLE target_selections")
        database.execute("CREATE TABLE target_selections (fixture TEXT)")
        database.execute("PRAGMA user_version = 12")
    with pytest.raises(RuntimeError, match="Database initialization failed"):
        with archive_client(path):
            pytest.fail("A conflicting migration must not serve requests")
    with sqlite3.connect(path) as database:
        assert database.execute("PRAGMA user_version").fetchone()[0] == 12
        database.execute("DROP TABLE target_selections")
    assert checks(path) == before
    with sqlite3.connect(path) as database:
        assert database.execute("PRAGMA user_version").fetchone()[0] == 28


@pytest.mark.parametrize("mode", ["specified", "recent"])
def test_v12_migration_keeps_archive_observations_and_pending_and_seeds_current_selection(tmp_path, mode):
    path = tmp_path / "v12.sqlite"
    prepare(path, "window" if mode == "recent" else "stop")
    source = RecentContentSource()

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            if mode == "recent":
                assert await collector.discover_once(UID)
            assert await collector.check_once(UID, RECENT_ID)
            await collector.execute_pending()  # 不配置 OSS，真实图未完成信息必须保留。
            before, saved = checks(path), read_content(path)
            with archive_client(path) as api:
                identity = api.get(f"{BASE}/{UID}").json()
            # 固定 v12 输入；SQLite 只用于装配迁移前的旧 schema，结果从公开 HTTP 验证。
            with sqlite3.connect(path) as database:
                database.execute("DROP TABLE target_selections")
                database.execute("PRAGMA user_version = 12")
            for _ in range(2):
                assert checks(path) == before and read_content(path) == saved
                with archive_client(path) as api:
                    assert api.get(f"{BASE}/{UID}").json() == identity
            await remove(path, "window" if mode == "recent" else "stop", collector, source)
            assert not await Collector(Store(path), client).check_once(UID, RECENT_ID)
            await restore(path, "window" if mode == "recent" else "stop", collector, source)
            async with httpx.AsyncClient(transport=httpx.MockTransport(source.download)) as media_client:
                oss = Collector(Store(path), client, ImageDownloader(media_client), RecordingOSS())
                # 生产同序：先检查再执行。无上传器时算完成的媒体记录，在配好上传后
                # 会被下一次检查重新登记为待办，不需要手动改库。
                await oss.check_once(UID, RECENT_ID)
                await oss.execute_pending()
            assert_complete_content(read_content(path))
            assert checks(path)[RECENT_ID]["work"] == "complete"

    asyncio.run(scenario())
