"""23：公开采集入口、真实 SQLite 与 HTTP；只控制时间和外部传输。"""

import asyncio
import json
import os
import subprocess
import sys

import httpx

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client, readable_html, set_specified, TARGETS
from backend.tests.collector_support import CHECKS, configured, empty_upstream
from backend.tests.collector_clock import ControlledClock, eventually
from backend.tests.management_support import BASE, UID


def test_check_registers_unknown_initial_work_without_claiming_sync_success(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    with archive_client(path) as api:
        assert api.get(CHECKS).json()["checks"][0]["check_status"] == "unchecked"
    html = readable_html(pictures=[]).replace("编辑于 2026年10月09日 13:01", "刚刚")

    async def check():
        requests = []

        def upstream(request):
            requests.append(request.url.path)
            if request.url.path.startswith("/opus/"):
                return httpx.Response(200, text=html)
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.check_once(UID, "123")
        assert requests == [
            "/opus/123", "/x/polymer/web-dynamic/v1/detail", "/x/v2/reply/count",
            "/opus/123", "/x/v2/reply/count",
        ]

    asyncio.run(check())
    with archive_client(path) as api:
        state = api.get(CHECKS).json()["checks"][0]
        assert state["work"] == "pending"
        assert state["revision"] == 1
        assert state["last_checked_at"] is not None
        assert state["last_succeeded_at"] is None
        assert api.get(f"{BASE}/{UID}").json()["monitor"]["last_succeeded_at"] is None
        assert state["observed"].get("observed_version") is None
        assert state["check_status"] == "unchanged"
        assert api.get("/api/archive/dynamics").json()["items"] == []


def test_fixed_ticks_skip_busy_check_without_blocking_other_targets(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path, ("123", "124"))

    async def scenario():
        clock = ControlledClock()
        release = asyncio.Event()
        requests = []

        async def upstream(request):
            id = request.url.path.split("/")[-1]
            if request.url.path.startswith("/opus/"):
                requests.append((id, clock.value))
                if id == "123" and clock.value == 0:
                    await release.wait()
                return httpx.Response(200, text=readable_html(id=id))
            raise httpx.ConnectError("FICTIONAL_SECRET", request=request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client, clock=clock)
            running = asyncio.create_task(collector.run())
            try:
                await eventually(lambda: len(requests) == 2 and 15 in clock.deadlines)
                # 第一个目标仍检查中；停用配置在慢 I/O 期间仍能写入/读出。
                with archive_client(path) as api:
                    assert api.get(CHECKS).status_code == 200
                    assert set_specified(api).status_code == 200
                await eventually(lambda: Store(path).read_checks(UID)[1]["last_checked_at"] == clock.now())
                clock.advance(15)
                await eventually(lambda: ("124", 15) in requests and 30 in clock.deadlines)
                await eventually(lambda: Store(path).read_checks(UID)[1]["last_checked_at"] == clock.now())
                clock.advance(30)
                await eventually(lambda: ("124", 30) in requests and 45 in clock.deadlines)
                assert [stamp for id, stamp in requests if id == "123"] == [0]
                release.set()
                await eventually(lambda: all(row["last_checked_at"] == clock.now() for row in Store(path).read_checks(UID)))
                clock.advance(45)
                await eventually(lambda: ("123", 45) in requests and 60 in clock.deadlines)
                assert ("123", 15) not in requests and ("123", 30) not in requests
            finally:
                running.cancel()
                try:
                    await running
                except asyncio.CancelledError:
                    pass

    asyncio.run(scenario())


def test_sync_must_not_complete_a_different_observation_version(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        newer = False

        def upstream(request):
            response = empty_upstream(request)
            if request.url.path.startswith("/opus/") and newer:
                return httpx.Response(200, text=response.text.replace("13:01", "13:02"))
            return response

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            newer = True
            await collector.execute_pending()

    asyncio.run(scenario())
    with archive_client(path) as api:
        state = api.get(CHECKS).json()["checks"][0]
        assert state["work"] == "pending"
        assert state["last_succeeded_at"] is None
        assert state["observed"]["observed_version"].endswith("13:01+08:00")


def test_invalid_edit_signal_preserves_trusted_version_but_records_readable_signals(tmp_path, caplog):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        html = readable_html()
        count = 7

        def upstream(request):
            if request.url.path.startswith("/opus/"):
                return httpx.Response(200, text=html)
            if request.url.path == "/x/v2/reply/count":
                return httpx.Response(200, json={"code": 0, "data": {"count": count}})
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            html = html.replace("编辑于 2026年10月09日 13:01", "编辑于 FICTIONAL_SECRET")
            count = 9
            await collector.check_once(UID, "123")

    asyncio.run(scenario())
    with archive_client(path) as api:
        state = api.get(CHECKS).json()["checks"][0]
        assert state["check_status"] == "failed"
        assert state["observed"]["observed_version"].endswith("13:01+08:00")
        assert state["observed"]["source_comment_count"] == 9
        assert state["observed"]["comment_count_status"] == "observed"
        assert state["revision"] == 2 and state["work"] == "pending"
        assert state["last_succeeded_at"] is None
        assert "FICTIONAL_SECRET" not in api.get(CHECKS).text + caplog.text


def test_slow_sync_keeps_checking_and_old_completion_cannot_clear_new_work(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path, ("123", "124"))

    async def scenario():
        clock = ControlledClock()
        release = asyncio.Event()
        blocked = asyncio.Event()
        pages = []

        async def upstream(request):
            if request.url.path.startswith("/opus/"):
                id = request.url.path.split("/")[-1]
                pages.append((id, clock.value))
                html = readable_html(id=id, pictures=[])
                if clock.value >= 30:
                    html = html.replace("13:01", "13:02")
                return httpx.Response(200, text=html)
            if clock.value >= 15 and request.url.path.endswith("/detail") and request.url.params["id"] == "123":
                blocked.set()
                await release.wait()
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client, clock=clock)
            running = asyncio.create_task(collector.run())
            try:
                await eventually(lambda: all(row["revision"] == 1 for row in Store(path).read_checks(UID)))
                clock.advance(15)
                await asyncio.wait_for(blocked.wait(), 3)
                with archive_client(path) as api:
                    assert api.get(CHECKS).json()["checks"][0]["work"] == "running"
                    assert set_specified(api).status_code == 200
                    assert api.get("/api/archive/dynamics").status_code == 200
                await eventually(lambda: all(row["last_checked_at"] == clock.now() for row in Store(path).read_checks(UID)))
                clock.advance(30)
                await eventually(lambda: all(row["revision"] == 2 for row in Store(path).read_checks(UID)))
                assert ("123", 30) in pages and ("124", 30) in pages
                release.set()
                await eventually(lambda: Store(path).read_checks(UID)[0]["work"] == "pending")
                with archive_client(path) as api:
                    state = api.get(CHECKS).json()["checks"][0]
                    assert state["observed"]["observed_version"].endswith("13:02+08:00")
                    assert state["last_succeeded_at"] is None
            finally:
                running.cancel()
                try:
                    await running
                except asyncio.CancelledError:
                    pass

    asyncio.run(scenario())


def test_runtime_restarts_interrupted_work_and_stop_blocks_new_requests(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def interrupt():
        blocked = asyncio.Event()
        executing = False

        async def upstream(request):
            if executing and request.url.path.endswith("/detail"):
                blocked.set()
                await asyncio.Event().wait()
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            executing = True
            task = asyncio.create_task(collector.execute_pending())
            await asyncio.wait_for(blocked.wait(), 3)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    asyncio.run(interrupt())
    with archive_client(path) as api:
        assert api.get(CHECKS).json()["checks"][0]["work"] == "running"
        assert api.get(CHECKS).json()["checks"][0]["last_succeeded_at"] is None

    async def restart():
        clock = ControlledClock()
        requests = []

        def upstream(request):
            requests.append(request.url.path)
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            running = asyncio.create_task(Collector(Store(path), client, clock=clock).run())
            try:
                await eventually(lambda: Store(path).read_checks(UID)[0]["work"] == "complete")
                with archive_client(path) as api:
                    assert api.get(CHECKS).json()["checks"][0]["last_succeeded_at"] == "2030-01-01T00:00:00+00:00"
                    set_specified(api, enabled=False)
                before = len(requests)
                clock.advance(15)
                await eventually(lambda: 30 in clock.deadlines)
                assert len(requests) == before
                with archive_client(path) as api:
                    assert api.get("/api/archive/dynamics/123").json()["content_state"] == "success"
                    assert api.delete(f"{TARGETS}/123").status_code == 204
                    assert not api.get(CHECKS).json()["checks"][0]["active"]
            finally:
                running.cancel()
                try:
                    await running
                except asyncio.CancelledError:
                    pass

    asyncio.run(restart())


def test_isolated_process_runs_multiple_ticks_and_can_restart(tmp_path):
    path = tmp_path / "demo.sqlite"
    command = [sys.executable, "-m", "backend.tests.collector_demo", "--database", str(path)]
    first = subprocess.run(command, capture_output=True, text=True, timeout=15, check=True)
    states = [json.loads(line) for line in first.stdout.splitlines()]
    assert [item["tick"] for item in states] == [0, 15, 30, 45]
    assert states[0]["checks"][0]["work"] == "pending"
    assert states[-1]["checks"][0]["work"] == "complete"
    success_time = states[-1]["checks"][0]["last_succeeded_at"]
    second = subprocess.run(command, capture_output=True, text=True, timeout=15, check=True)
    assert json.loads(second.stdout.splitlines()[-1])["checks"][0]["last_succeeded_at"] == success_time


def test_first_failed_check_retains_legacy_archive_trusted_observation(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    with archive_client(path, empty_upstream) as api:
        assert api.post("/api/sync/initial", json={"uid": UID}).json()["succeeded"] == 1
        saved = api.get("/api/archive/dynamics/123").json()

    async def scenario():
        def failed(request):
            raise httpx.ConnectError("FICTIONAL_SECRET", request=request)
        async with httpx.AsyncClient(transport=httpx.MockTransport(failed)) as client:
            await Collector(Store(path), client).check_once(UID, "123")

    asyncio.run(scenario())
    with archive_client(path) as api:
        state = api.get(CHECKS).json()["checks"][0]
        assert state["check_status"] == "failed"
        assert state["observed"]["observed_version"] == saved["observed_version"]
        archive = api.get("/api/archive/dynamics/123").json()
        assert archive.pop("comment_sync") == state
        assert saved.pop("comment_sync")["check_status"] == "unchecked"
        # 唯一实时投影变化不影响整份保留归档（包括成功时间与 checkpoint）。
        assert archive == saved


def test_http_exposes_partial_archive_without_claiming_whole_success(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        def upstream(request):
            if request.url.path.startswith("/opus/"):
                return httpx.Response(200, text=readable_html().replace('"count":7', '"count":0'))
            if request.url.path == "/x/v2/reply":
                raise httpx.ConnectError("FICTIONAL_SECRET", request=request)
            return empty_upstream(request)
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            await collector.check_once(UID, "123")

    asyncio.run(scenario())
    with archive_client(path) as api:
        state = api.get(CHECKS).json()["checks"][0]
        # 评论实际失败才是真实的未完成；未配置上传器的媒体不冒充完成也不阻碍完成。
        assert state["work"] == "pending" and state["last_succeeded_at"] is None
        assert state["parts"]["text"] == "success"
        assert state["parts"]["comments"] == state["parts"]["replies"] == "pending"
        assert state["parts"]["media"] == state["parts"]["comment_media"] == "pending"
        assert state["synced_version"].endswith("13:01+08:00")
        assert state["sync_error"] == "SYNC_INCOMPLETE" and state["check_error"] is None


def test_check_concurrency_is_bounded_and_skipped_targets_rotate(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path, ("123", "124", "125", "126", "127"))

    async def scenario():
        clock = ControlledClock()
        release = asyncio.Event()
        started, active, maximum = [], 0, 0

        async def upstream(request):
            nonlocal active, maximum
            if not request.url.path.startswith("/opus/"):
                raise httpx.ConnectError("Unavailable", request=request)
            id = request.url.path.split("/")[-1]
            started.append((id, clock.value))
            active += 1
            maximum = max(maximum, active)
            try:
                await release.wait()
                # 不可读来源登记失败，仍是可领取的初始化，后续执行可能继续失败。
                return httpx.Response(503)
            finally:
                active -= 1

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            running = asyncio.create_task(Collector(Store(path), client, clock=clock, max_checks=2).run())
            try:
                await eventually(lambda: len(started) == 2 and 15 in clock.deadlines)
                assert maximum == 2
                clock.advance(15)
                await eventually(lambda: 30 in clock.deadlines)
                assert len(started) == 2  # 容量用尽只跳过，不创建等待网络的检查任务。
                release.set()
                await eventually(lambda: sum(row["revision"] == 1 for row in Store(path).read_checks(UID)) == 2)
                clock.advance(30)
                await eventually(lambda: sum(row["revision"] == 1 for row in Store(path).read_checks(UID)) == 4)
                clock.advance(45)
                await eventually(lambda: 60 in clock.deadlines)
                await eventually(lambda: all(row["last_checked_at"] == clock.now()
                                            for row in Store(path).read_checks(UID) if row["id"] in ("123", "124")))
                clock.advance(60)
                await eventually(lambda: all(row["revision"] == 1 for row in Store(path).read_checks(UID)))
                assert {id for id, stamp in started} == {"123", "124", "125", "126", "127"}
                # 执行阶段另占一个 I/O，与有界检查槽无关；初始被阻塞检查阶段只占2。
            finally:
                running.cancel()
                try:
                    await running
                except asyncio.CancelledError:
                    pass

    asyncio.run(scenario())


def test_production_cli_runs_without_api_and_stops_cleanly_with_no_targets(tmp_path):
    path = tmp_path / "FICTIONAL_SECRET.sqlite"
    command = [sys.executable, "-m", "backend.bili_monitor.collector", "--database", str(path)]
    environment = {key: value for key, value in os.environ.items() if not key.startswith("BILI_OSS_")}
    assert subprocess.run(command + ["--once"], env=environment, capture_output=True, timeout=10).returncode == 0
    daemon = subprocess.Popen(command, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        # 等待可观察的进程锁；没有目标，不会触发任何真实来源请求。
        import fcntl
        import time
        deadline = time.monotonic() + 5
        acquired = False
        while time.monotonic() < deadline:
            with open(str(path.resolve()) + ".collector.lock", "a") as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    acquired = True
                    break
            time.sleep(0.01)
        assert acquired and daemon.poll() is None
        duplicate = subprocess.run(command + ["--once"], env=environment, capture_output=True, text=True, timeout=10)
        assert duplicate.returncode != 0
        # 采集诊断日志固定写在 stderr，失败结论文本仍单独一行且不携带来源内容。
        assert duplicate.stderr.strip().splitlines()[-1] == "Collector failed"
        daemon.terminate()
        stdout, stderr = daemon.communicate(timeout=5)
        assert daemon.returncode == 0
        assert "FICTIONAL_SECRET" not in (stdout + stderr).decode()
    finally:
        if daemon.poll() is None:
            daemon.kill()
            daemon.communicate(timeout=5)



def test_target_session_exit_settles_or_releases_the_lease_exactly_once(tmp_path):
    """目标会话只有 `_drop_session` 一个退出入口：结算路径由 `_finish_session` 释放租约，
    不结算路径（租约已失去／尚未领取）在此补释放，两条路径都记入本拍已尝试。

    回归对象是旧的五份复制块：漏一个 `attempted.add` 会在同一轮重复派发同目标，重复
    `release()` 会把已结算的租约再释放一次。
    """
    store = Store(tmp_path / "session-exit.sqlite")
    store.migrate()
    collector = Collector(store, None)
    settled_calls = []

    class Lease:
        def __init__(self):
            self.releases = 0

        async def release(self):
            self.releases += 1

    class Session:
        def __init__(self):
            self.target_lease = Lease()

    async def finish(session, *, succeeded=None, archive=None):
        settled_calls.append((succeeded, archive))
        await session.target_lease.release()

    collector._finish_session = finish
    for settled, expected in (("result", (None, None)),
                              ("failed", (False, None)),
                              (None, None)):
        settled_calls.clear()
        key = (str(settled), "1")
        session = Session()
        sessions, attempted = {key: session}, set()
        asyncio.run(collector._drop_session(sessions, attempted, key, session, settled=settled))
        assert key not in sessions and key in attempted
        # 结算路径与补释放路径都只需一次释放：重复释放会让已结算的租约被再交还一次。
        assert session.target_lease.releases == 1
        assert settled_calls == ([] if expected is None else [expected])
