"""29 / T2-T3：真实 SQLite、HTTP 与阻塞外部 I/O 验证入选代次和归档保留。"""

import asyncio

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from backend.bili_monitor.media import ImageDownloader
from backend.bili_monitor.sync import initialize
from backend.tests.archive_support import archive_client, readable_html
from backend.tests.collector_support import configured, empty_upstream, CHECKS
from backend.tests.management_support import BASE, UID
from backend.tests.inflight_support import CHANGES, prepare, remove, restore
from backend.tests.test_recent_window_content import (
    RecentContentSource, RecordingOSS, RECENT_ID, ROOT_ID, read_content, read_all, assert_complete_content,
    no_real_oss_environment,
)
from backend.tests.test_recent_window_lifecycle import feed


def checks(path):
    with archive_client(path) as api:
        response = api.get(CHECKS)
        assert response.status_code == 200
        return {item["id"]: item for item in response.json()["checks"]}


def set_enabled(path, enabled):
    with archive_client(path) as api:
        assert api.patch(f"{BASE}/{UID}/monitor", json={
            "mode": "specified", "recent_n": 10, "enabled": enabled,
        }).status_code == 200


def test_check_from_before_stop_and_reinclusion_cannot_publish_or_request_more_signals(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        blocked, release = asyncio.Event(), asyncio.Event()
        requests = []

        async def upstream(request):
            requests.append(request.url.path)
            if request.url.path == "/opus/123":
                blocked.set()
                await release.wait()
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            task = asyncio.create_task(Collector(Store(path), client).check_once(UID, "123"))
            try:
                await asyncio.wait_for(blocked.wait(), 3)
                set_enabled(path, False)
                set_enabled(path, True)
                release.set()
                assert not await task
                current = checks(path)["123"]
                assert current["active"] and current["last_checked_at"] is None
                assert current["check_status"] == "unchecked" and current["observed"] == {}
                assert requests == ["/opus/123"]
                # 新对象经真实 SQLite 获得新资格，正常登记和完成应有工作。
                reopened = Collector(Store(path), client)
                assert await reopened.check_once(UID, "123")
                await reopened.execute_pending()
                assert checks(path)["123"]["work"] == "complete"
            finally:
                release.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


@pytest.mark.parametrize("change", CHANGES)
@pytest.mark.parametrize("reinclude_before_return", [False, True])
def test_pending_snapshot_does_not_claim_reincluded_target(tmp_path, change, reinclude_before_return):
    path = tmp_path / "monitor.sqlite"
    configured(path, ("123", RECENT_ID))
    source = RecentContentSource()
    if change == "window":
        with archive_client(path) as api:
            assert api.patch(f"{BASE}/{UID}/monitor", json={
                "mode": "recent", "recent_n": 2, "enabled": True,
            }).status_code == 200

    async def scenario():
        blocked, release = asyncio.Event(), asyncio.Event()
        syncing = False
        requests = []

        async def upstream(request):
            requests.append((request.url.path, dict(request.url.params)))
            if request.url.path.endswith("/feed/space"):
                return feed(["123", source.feed_id])
            if syncing and request.url.path == "/opus/123":
                blocked.set()
                await release.wait()
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client, max_syncs=1)
            if change == "window":
                assert await collector.discover_once(UID)
            for id in ("123", RECENT_ID):
                assert await collector.check_once(UID, id)
            syncing = True
            task = asyncio.create_task(collector.execute_pending())
            try:
                await asyncio.wait_for(blocked.wait(), 3)
                await remove(path, change, collector, source)
                if reinclude_before_return:
                    await restore(path, change, collector, source)
                requests.clear()
                release.set()
                await task
                current = checks(path)[RECENT_ID]
                assert current["active"] is reinclude_before_return
                assert current["work"] == "pending"
                assert not any(route == f"/opus/{RECENT_ID}" for route, _ in requests)
                with archive_client(path) as api:
                    assert api.get(f"/api/archive/dynamics/{RECENT_ID}").status_code == 404
                if not reinclude_before_return:
                    await restore(path, change, collector, source)
                await Collector(Store(path), client).execute_pending()
                assert checks(path)[RECENT_ID]["work"] == "complete"
            finally:
                release.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


@pytest.mark.parametrize("change", CHANGES)
@pytest.mark.parametrize("phase", ["page", "locator", "count"])
@pytest.mark.parametrize("reinclude_before_return", [False, True])
def test_check_configuration_phase_matrix(tmp_path, change, phase, reinclude_before_return):
    path = tmp_path / "checks.sqlite"
    prepare(path, change)
    source = RecentContentSource()

    async def scenario():
        blocked, release = asyncio.Event(), asyncio.Event()
        routes = {
            "page": f"/opus/{RECENT_ID}",
            "locator": "/x/polymer/web-dynamic/v1/detail",
            "count": "/x/v2/reply/count",
        }

        async def upstream(request):
            response = source(request)
            if request.url.path == routes[phase]:
                blocked.set()
                await release.wait()
            return response

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            if change == "window":
                assert await collector.discover_once(UID)
            task = asyncio.create_task(collector.check_once(UID, RECENT_ID))
            try:
                await asyncio.wait_for(blocked.wait(), 3)
                await remove(path, change, collector, source)
                if reinclude_before_return:
                    await restore(path, change, collector, source)
                source.calls.clear()
                release.set()
                assert not await task
                current = checks(path).get(RECENT_ID)
                # 删除指定关联且从未检查的目标允许不再投影；其他情况必须无旧观察。
                if current is not None:
                    assert current["last_checked_at"] is None and current["observed"] == {}
                    assert current["active"] is reinclude_before_return
                assert source.calls == []  # 旧网页/detail 返回后不继续开下一个信号请求。
                with archive_client(path) as api:
                    assert api.get(f"/api/archive/dynamics/{RECENT_ID}").status_code == 404
                if not reinclude_before_return:
                    assert not await Collector(Store(path), client).check_once(UID, RECENT_ID)
                    await restore(path, change, collector, source)
                assert await Collector(Store(path), client).check_once(UID, RECENT_ID)
                assert checks(path)[RECENT_ID]["observed"]["source_comment_count"] == 7
            finally:
                release.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


@pytest.mark.parametrize("change", CHANGES)
@pytest.mark.parametrize("phase", [
    "body", "roots", "replies", "dynamic_download", "comment_download", "dynamic_upload", "comment_upload",
])
@pytest.mark.parametrize("reinclude_before_return", [False, True])
def test_claimed_sync_configuration_phase_matrix(tmp_path, change, phase, reinclude_before_return, caplog):
    path = tmp_path / "sync.sqlite"
    prepare(path, change)
    source = RecentContentSource()

    async def scenario():
        blocked, release = asyncio.Event(), asyncio.Event()
        syncing = False
        routes = {"body": f"/opus/{RECENT_ID}", "roots": "/x/v2/reply", "replies": "/x/v2/reply/reply"}

        async def upstream(request):
            response = source(request)
            if syncing and request.url.path == routes.get(phase):
                blocked.set()
                await release.wait()
            return response

        async def download(request):
            response = source.download(request)
            comment = request.url.path.endswith("comment.png")
            if phase == ("comment_download" if comment else "dynamic_download"):
                blocked.set()
                await release.wait()
            return response

        class DelayedOSS(RecordingOSS):
            async def upload(self, key, content, content_type):
                comment = "/comments/" in key
                if phase == ("comment_upload" if comment else "dynamic_upload"):
                    blocked.set()
                    await release.wait()
                return await super().upload(key, content, content_type)

        uploader = DelayedOSS()
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client, httpx.AsyncClient(
            transport=httpx.MockTransport(download)
        ) as media_client:
            collector = Collector(Store(path), client, ImageDownloader(media_client), uploader)
            if change == "window":
                assert await collector.discover_once(UID)
            assert await collector.check_once(UID, RECENT_ID)
            syncing = True
            task = asyncio.create_task(collector.execute_pending())
            try:
                await asyncio.wait_for(blocked.wait(), 3)
                before = checks(path)[RECENT_ID]
                assert before["work"] == "running"
                # 外部 I/O 阻塞时，HTTP 配置写入和已有部分归档读取不等网络释放。
                with archive_client(path) as api:
                    assert api.get(f"/api/archive/dynamics/{RECENT_ID}").status_code == 200
                await remove(path, change, collector, source)
                assert not checks(path)[RECENT_ID]["active"]
                if reinclude_before_return:
                    await restore(path, change, collector, source)
                release.set()
                await task
                saved = read_content(path)  # 完整 owner、顺序、URL、正文、根与回复逐项断言。
                assert_complete_content(saved)
                current = checks(path)[RECENT_ID]
                assert current["active"] is reinclude_before_return
                assert current["work"] == "pending" and current["last_succeeded_at"] is None
                assert current["observed"] == before["observed"]
                assert current["revision"] == before["revision"]
                source.calls.clear()
                reopened = Collector(Store(path), client, ImageDownloader(media_client), uploader)
                if not reinclude_before_return:
                    assert not await reopened.check_once(UID, RECENT_ID)
                    await reopened.execute_pending()
                    assert source.calls == [] and read_content(path) == saved
                    await restore(path, change, reopened, source)
                    source.calls.clear()
                await reopened.execute_pending()
                assert checks(path)[RECENT_ID]["work"] == "complete"
                assert read_content(path) == saved
                assert source.calls == [] and len(uploader.keys) == len(source.downloads) == 3
                await reopened.execute_pending()  # 完成后的重复执行幂等。
                assert source.calls == [] and read_content(path) == saved
                assert "FICTIONAL_SECRET" not in str(saved) + str(checks(path)) + caplog.text
            finally:
                release.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


def test_old_claim_cannot_attach_archive_to_another_up_after_config_deletion(tmp_path):
    path = tmp_path / "owner.sqlite"
    configured(path, (RECENT_ID,))
    source = RecentContentSource()
    other_uid = "42"

    async def scenario():
        blocked, release = asyncio.Event(), asyncio.Event()
        syncing = False
        new_author = False

        async def upstream(request):
            if new_author and request.url.path.startswith("/opus/"):
                return httpx.Response(200, text=readable_html(id=RECENT_ID).replace(UID, other_uid))
            response = source(request)
            if syncing and request.url.path.startswith("/opus/"):
                blocked.set()
                await release.wait()
            return response

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client, httpx.AsyncClient(
            transport=httpx.MockTransport(source.download)
        ) as media_client:
            collector = Collector(Store(path), client, ImageDownloader(media_client), RecordingOSS())
            assert await collector.check_once(UID, RECENT_ID)
            syncing = True
            task = asyncio.create_task(collector.execute_pending())
            try:
                await asyncio.wait_for(blocked.wait(), 3)
                # 来源作者变化也不能将已有 archive ID 的持久 owner 迁给另一个 UP。
                with archive_client(path, lambda request: httpx.Response(
                    200, text=readable_html(id=RECENT_ID).replace(UID, other_uid),
                )) as api:
                    assert api.delete(f"{BASE}/{UID}/monitor").status_code == 204
                    assert api.post(BASE, json={"uid": other_uid}).status_code == 201
                    assert api.patch(f"{BASE}/{other_uid}/monitor", json={
                        "mode": "specified", "recent_n": 10, "enabled": True,
                    }).status_code == 200
                    assert api.post(f"{BASE}/{other_uid}/targets", json={"id": RECENT_ID}).status_code == 201
                new_author = True
                assert await Collector(Store(path), client).check_once(other_uid, RECENT_ID)
                await Collector(Store(path), client).execute_pending()  # 冲突归属不领取归档。
                release.set()
                await task
                with archive_client(path) as api:
                    archive_url = f"/api/archive/dynamics/{RECENT_ID}"
                    assert_complete_content((api.get(archive_url).json(), read_all(api, archive_url + "/comments"),
                                             read_all(api, archive_url + f"/comments/{ROOT_ID}/replies")))
                    old_check = api.get(CHECKS).json()["checks"][0]
                    other = api.get(f"{BASE}/{other_uid}/checks").json()["checks"][0]
                    assert not old_check["active"] and old_check["work"] == "pending"
                    assert other["active"] and other["work"] == "pending"
                    assert other["synced_version"] is None and other["last_succeeded_at"] is None
                    assert other["sync_error"] == "SYNC_INCOMPLETE"
                    assert api.get("/api/archive/dynamics", params={"scope": "up", "uid": other_uid}).json()["items"] == []
                    assert api.get(f"/api/archive/dynamics/{RECENT_ID}").json()["author"]["id"] == UID
            finally:
                release.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


@pytest.mark.parametrize("phase", ["check", "sync"])
def test_recent_to_specified_switch_fences_old_work_even_when_target_remains_selected(tmp_path, phase):
    path = tmp_path / "mode-overlap.sqlite"
    configured(path, (RECENT_ID,))
    source = RecentContentSource()
    with archive_client(path) as api:
        assert api.patch(f"{BASE}/{UID}/monitor", json={
            "mode": "recent", "recent_n": 1, "enabled": True,
        }).status_code == 200

    async def scenario():
        blocked, release = asyncio.Event(), asyncio.Event()
        blocking = phase == "check"

        async def upstream(request):
            response = source(request)
            if blocking and request.url.path.startswith("/opus/"):
                blocked.set()
                await release.wait()
            return response

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client, httpx.AsyncClient(
            transport=httpx.MockTransport(source.download)
        ) as media_client:
            collector = Collector(Store(path), client, ImageDownloader(media_client), RecordingOSS())
            assert await collector.discover_once(UID)
            if phase == "sync":
                assert await collector.check_once(UID, RECENT_ID)
                blocking = True
            task = asyncio.create_task(collector.check_once(UID, RECENT_ID) if phase == "check"
                                       else collector.execute_pending())
            try:
                await asyncio.wait_for(blocked.wait(), 3)
                set_enabled(path, True)  # recent → specified，ID 虽重合仍不能接纳旧代次。
                assert checks(path)[RECENT_ID]["active"]
                release.set()
                result = await task
                current = checks(path)[RECENT_ID]
                assert current["work"] == "pending" and current["last_succeeded_at"] is None
                if phase == "check":
                    assert result is False and current["last_checked_at"] is None
                else:
                    assert_complete_content(read_content(path))
            finally:
                release.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


def test_explicit_initial_snapshot_cannot_initialize_recreated_configuration(tmp_path):
    path = tmp_path / "initial.sqlite"
    configured(path, ("123", "124"))

    async def scenario():
        blocked, release = asyncio.Event(), asyncio.Event()
        requests = []

        async def upstream(request):
            requests.append(request.url.path)
            if request.url.path == "/opus/123":
                blocked.set()
                await release.wait()
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            task = asyncio.create_task(initialize(Store(path), client, UID))
            try:
                await asyncio.wait_for(blocked.wait(), 3)
                set_enabled(path, False)
                set_enabled(path, True)
                release.set()
                assert await task == {"processed": 1, "succeeded": 1, "failed": 0}
                assert "/opus/124" not in requests
                with archive_client(path) as api:
                    assert api.get("/api/archive/dynamics/123").status_code == 200
                    assert api.get("/api/archive/dynamics/124").status_code == 404
                assert await initialize(Store(path), client, UID) == {"processed": 2, "succeeded": 2, "failed": 0}
            finally:
                release.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


@pytest.mark.parametrize("mode", ["specified", "recent"])
def test_noop_config_and_unchanged_window_keep_inflight_check_eligible(tmp_path, mode):
    path = tmp_path / "noop.sqlite"
    prepare(path, "window" if mode == "recent" else "stop")
    source = RecentContentSource()

    async def scenario():
        blocked, release = asyncio.Event(), asyncio.Event()

        async def upstream(request):
            response = source(request)
            if request.url.path.startswith("/opus/"):
                blocked.set()
                await release.wait()
            return response

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            if mode == "recent":
                assert await collector.discover_once(UID)
            task = asyncio.create_task(collector.check_once(UID, RECENT_ID))
            try:
                await asyncio.wait_for(blocked.wait(), 3)
                with archive_client(path) as api:
                    assert api.patch(f"{BASE}/{UID}/monitor", json={
                        "mode": mode, "recent_n": 1 if mode == "recent" else 10, "enabled": True,
                    }).status_code == 200
                if mode == "recent":
                    assert await Collector(Store(path), client).discover_once(UID)
                release.set()
                assert await task
                assert checks(path)[RECENT_ID]["observed"]["source_comment_count"] == 7
            finally:
                release.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


def test_claimed_sync_saves_content_but_cannot_complete_reincluded_selection(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path, (RECENT_ID,))
    source, uploader = RecentContentSource(), RecordingOSS()

    async def scenario():
        blocked, release = asyncio.Event(), asyncio.Event()
        syncing = False

        async def upstream(request):
            if syncing and request.url.path.startswith("/opus/"):
                blocked.set()
                await release.wait()
            return source(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client, httpx.AsyncClient(
            transport=httpx.MockTransport(source.download)
        ) as media_client:
            collector = Collector(Store(path), client, ImageDownloader(media_client), uploader)
            assert await collector.check_once(UID, RECENT_ID)
            syncing = True
            task = asyncio.create_task(collector.execute_pending())
            try:
                await asyncio.wait_for(blocked.wait(), 3)
                set_enabled(path, False)
                set_enabled(path, True)
                release.set()
                await task
                # 旧归档领取可保存整个链；完成不得算到重纳入的新资格。
                assert_complete_content(read_content(path))
                current = checks(path)[RECENT_ID]
                assert current["active"] and current["work"] == "pending"
                assert current["last_succeeded_at"] is None
                source.calls.clear()
                reopened = Collector(Store(path), client, ImageDownloader(media_client), uploader)
                await reopened.execute_pending()
                assert checks(path)[RECENT_ID]["work"] == "complete"
                assert source.calls == []  # 复用全部分项，不重扫或重复上传。
                assert len(uploader.keys) == 3
            finally:
                release.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())
