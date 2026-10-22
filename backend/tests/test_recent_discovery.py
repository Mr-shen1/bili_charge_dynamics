"""27：公开发现执行 → 实际 SQLite → 只读管理 HTTP。"""

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from backend.tests.management_support import BASE, UID, client_for, enable
from backend.tests.archive_support import archive_client
from backend.tests.collector_clock import ControlledClock, eventually
from backend.tests.collector_support import configured, empty_upstream


DISCOVERY = f"{BASE}/{UID}/discovery"


def read_discovery_http(path, uid=UID):
    with archive_client(path) as api:
        response = api.get(f"{BASE}/{uid}/discovery")
        assert response.status_code == 200
        return response.json()


def test_discovery_unstarted_is_read_only_and_independent_of_specified_targets(tmp_path):
    path = tmp_path / "monitor.sqlite"
    with client_for(path) as api:
        assert api.post(BASE, json={"uid": UID}).status_code == 201
        enable(api)
        response = api.get(DISCOVERY)
        assert response.status_code == 200
        assert response.json() == {
            "uid": UID, "mode": "recent", "recent_n": 10, "enabled": True,
            "active": True, "status": "undiscovered", "attempt": None,
            "trusted_result": None, "current_ids": [], "retryable": True, "incomplete": True,
        }
        assert api.get(f"{BASE}/999/discovery").status_code == 404
        assert api.get(DISCOVERY + "?refresh=1").status_code == 422
        assert api.get(DISCOVERY + "?x=1&x=2").status_code == 422
        api.patch(f"{BASE}/{UID}/monitor", json={"mode": "specified", "recent_n": 25, "enabled": True})
        state = api.get(DISCOVERY).json()
        assert state["mode"] == "specified" and state["recent_n"] == 25
        assert not state["active"] and not state["retryable"]
        assert state["attempt"] is None
    with client_for(path) as api:
        assert api.get(DISCOVERY).json() == state


def feed_response(uid=UID):
    # 协议结构真实、内容虚构；同 ID 跨 UP 不共享发现状态。
    return {"code": 0, "data": {"items": [
        {"id_str": id, "modules": {
            "module_author": {"mid": uid, "icon_badge": {"text": "充电专属"}},
            "module_dynamic": {"major": {"type": "MAJOR_TYPE_OPUS", "opus": {"summary": {"text": "虚构摘要"}}}},
        }} for id in ("900719925474099312349", "100", "20")
    ], "has_more": False, "offset": ""}}


def test_first_failed_empty_is_distinct_from_later_trusted_exhausted_empty(tmp_path):
    path = tmp_path / "monitor.sqlite"
    with client_for(path) as api:
        api.post(BASE, json={"uid": UID})
        enable(api)

    async def scenario():
        success = False
        def upstream(request):
            payload = {"code": 0, "data": {"items": [], "has_more": False, "offset": ""}} if success else {"code": -101}
            return httpx.Response(200, json=payload)
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            assert not await collector.discover_once(UID)
            with archive_client(path) as api:
                failed = api.get(DISCOVERY).json()
                assert failed["status"] == "failed" and failed["trusted_result"] is None
                assert failed["attempt"]["ids"] == [] and failed["retryable"]
            success = True
            assert await collector.discover_once(UID)
    asyncio.run(scenario())
    with archive_client(path) as api:
        state = api.get(DISCOVERY).json()
        assert state["status"] == "discovered" and not state["incomplete"]
        assert state["trusted_result"]["ids"] == [] and state["trusted_result"]["exhausted"]


def test_raw_multi_page_feed_fixtures_cross_collector_sqlite_and_http(tmp_path):
    path = tmp_path / "monitor.sqlite"
    uid = "101"
    with client_for(path) as api:
        api.post(BASE, json={"uid": uid})
        enable(api, uid)

    async def scenario():
        def upstream(request):
            offset = request.url.params.get("offset")
            name = {None: "page1", "page-2": "page2", "page-3": "empty"}[offset]
            fixture = Path(__file__).parent / "fixtures" / f"recent-feed-{name}.json"
            return httpx.Response(200, json=json.loads(fixture.read_text()))
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            assert await Collector(Store(path), client).discover_once(uid)

    asyncio.run(scenario())
    for _ in range(2):
        with archive_client(path) as api:
            state = api.get(f"{BASE}/{uid}/discovery").json()
            assert state["trusted_result"]["ids"] == ["9007199254741009", "11", "800", "5"]
            assert state["trusted_result"]["exhausted"] and state["status"] == "discovered"
            assert api.get(f"{BASE}/{uid}/targets").json() == {"targets": []}
            assert api.get("/api/archive/dynamics").json()["items"] == []


def test_discovered_results_are_per_up_persisted_and_not_content_archives(tmp_path):
    path = tmp_path / "monitor.sqlite"
    other = "101"
    with client_for(path) as api:
        for uid in (UID, other):
            api.post(BASE, json={"uid": uid})
        enable(api, recent_n=2)
        enable(api, other)

    async def discover():
        def upstream(request):
            assert request.url.path.endswith("/feed/space")
            return httpx.Response(200, json=feed_response(request.url.params["host_mid"]))
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            assert await collector.discover_once(UID)
            assert await collector.discover_once(other)

    asyncio.run(discover())
    with archive_client(path) as api:
        first = api.get(DISCOVERY).json()
        second = api.get(f"{BASE}/{other}/discovery").json()
        assert first["status"] == second["status"] == "discovered"
        assert first["trusted_result"]["ids"] == ["900719925474099312349", "100"]
        assert second["trusted_result"]["ids"] == ["900719925474099312349", "100", "20"]
        assert first["trusted_result"]["recent_n"] == 2
        assert second["trusted_result"]["recent_n"] == 10
        assert not first["trusted_result"]["exhausted"]
        assert second["trusted_result"]["exhausted"]
        assert not first["incomplete"] and not first["retryable"]
        assert first["attempt"]["error"] is None
        assert first["attempt"]["finished_at"] is not None
        assert api.get(f"{BASE}/{UID}/targets").json() == {"targets": []}
        assert api.get("/api/archive/dynamics").json()["items"] == []
        assert api.get(f"{BASE}/{UID}").json()["monitor"]["last_succeeded_at"] is None
    with archive_client(path) as api:
        assert api.get(DISCOVERY).json() == first
        assert api.get(f"{BASE}/{other}/discovery").json() == second


@pytest.mark.parametrize("failure,expected_error", [
    ("business", "SOURCE_UNAVAILABLE"), ("http", "SOURCE_UNAVAILABLE"),
    ("transport", "SOURCE_UNAVAILABLE"), ("json", "SIGNAL_INVALID"),
    ("candidate", "SIGNAL_INVALID"), ("pagination", "PAGINATION_INVALID"),
    ("cursor", "PAGINATION_INVALID"),
])
def test_mid_pagination_failure_keeps_old_trusted_result_and_partial_attempt_after_reopen(
        tmp_path, caplog, failure, expected_error):
    path = tmp_path / "monitor.sqlite"
    with client_for(path) as api:
        api.post(BASE, json={"uid": UID})
        api.patch(f"{BASE}/{UID}/monitor", json={"mode": "recent", "recent_n": 2, "enabled": True})

    async def scenario():
        failing = False
        second_page = asyncio.Event()
        release = asyncio.Event()

        async def upstream(request):
            if not failing:
                return httpx.Response(200, json=feed_response())
            if "offset" in request.url.params:
                second_page.set()
                await release.wait()
                if failure == "business":
                    return httpx.Response(200, json={"code": -101, "message": "FICTIONAL_SECRET_BUSINESS"})
                if failure == "http":
                    return httpx.Response(412, text="FICTIONAL_SECRET_HTTP")
                if failure == "transport":
                    raise httpx.ConnectError("FICTIONAL_SECRET_TRANSPORT", request=request)
                if failure == "json":
                    return httpx.Response(200, text="FICTIONAL_SECRET_JSON")
                payload = feed_response()
                if failure == "candidate":
                    payload["data"]["items"][0]["id_str"] = "FICTIONAL_SECRET_ID"
                elif failure == "pagination":
                    payload["data"]["has_more"] = "false"
                elif failure == "cursor":
                    payload["data"].update(has_more=True, offset="FICTIONAL_SECRET_CURSOR")
                return httpx.Response(200, json=payload)
            payload = feed_response()
            payload["data"]["items"] = [payload["data"]["items"][2]]
            payload["data"].update(has_more=True, offset="FICTIONAL_SECRET_CURSOR")
            return httpx.Response(200, json=payload)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            assert await collector.discover_once(UID)
            trusted = read_discovery_http(path)["trusted_result"]
            failing = True
            with client_for(path) as api:
                api.patch(f"{BASE}/{UID}/monitor", json={"mode": "recent", "recent_n": 4, "enabled": True})
                assert api.get(DISCOVERY).json()["incomplete"]
            task = asyncio.create_task(collector.discover_once(UID))
            try:
                await asyncio.wait_for(second_page.wait(), 3)
                with archive_client(path) as api:
                    running = api.get(DISCOVERY).json()
                    assert running["status"] == "running"
                    assert running["attempt"]["ids"] == ["20"]
                    assert running["trusted_result"] == trusted
                    assert not running["retryable"] and running["incomplete"]
                release.set()
                assert not await task
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            with archive_client(path) as api:
                failed = api.get(DISCOVERY).json()
                assert failed["status"] == "failed" and failed["retryable"] and failed["incomplete"]
                assert failed["attempt"]["ids"] == ["20"]
                assert failed["attempt"]["error"] == expected_error
                assert failed["trusted_result"] == trusted
                assert "FICTIONAL_SECRET" not in api.get(DISCOVERY).text + caplog.text
            with archive_client(path) as api:
                assert api.get(DISCOVERY).json() == failed
            # 无新信号仍可重试，重新从首屏读取；之前的部分结果不混入。
            failing = False
            assert await collector.discover_once(UID)
            with archive_client(path) as api:
                state = api.get(DISCOVERY).json()
                assert state["trusted_result"]["ids"] == ["900719925474099312349", "100", "20"]
                assert state["trusted_result"]["recent_n"] == 4 and state["trusted_result"]["exhausted"]
                assert state["status"] == "discovered" and state["attempt"]["error"] is None

    asyncio.run(scenario())


def test_interrupted_discovery_persists_through_api_reopen_and_collector_restart_retries(tmp_path):
    path = tmp_path / "monitor.sqlite"
    with client_for(path) as api:
        for uid in (UID, "1"):
            api.post(BASE, json={"uid": uid})
            enable(api, uid)

    async def scenario():
        interrupted = False
        reached_second = asyncio.Event()
        hold = asyncio.Event()
        restart_blocker = asyncio.Event()
        clock = ControlledClock()

        async def upstream(request):
            uid = request.url.params["host_mid"]
            if uid == "1":
                await restart_blocker.wait()
            if interrupted and uid == UID:
                if "offset" in request.url.params:
                    reached_second.set()
                    await hold.wait()
                payload = feed_response()
                payload["data"]["items"] = [payload["data"]["items"][1]]
                payload["data"].update(has_more=True, offset="next")
                return httpx.Response(200, json=payload)
            return httpx.Response(200, json=feed_response(uid))

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client, clock=clock, max_discoveries=1)
            assert await collector.discover_once(UID)
            trusted = read_discovery_http(path)["trusted_result"]
            interrupted = True
            task = asyncio.create_task(collector.discover_once(UID))
            await asyncio.wait_for(reached_second.wait(), 3)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            for _ in range(2):
                with archive_client(path) as api:
                    state = api.get(DISCOVERY).json()
                    assert state["status"] == "running"
                    assert state["attempt"]["ids"] == ["100"]
                    assert state["trusted_result"] == trusted
            interrupted = False
            # 另一个慢 UP 占据名额，让恢复状态在首次新领取前可观察。
            running = asyncio.create_task(Collector(Store(path), client, clock=clock, max_discoveries=1).run())
            try:
                await eventually(lambda: 15 in clock.deadlines)
                with archive_client(path) as api:
                    recovered = api.get(DISCOVERY).json()
                    assert recovered["status"] == "failed" and recovered["retryable"]
                    assert recovered["attempt"]["error"] == "DISCOVERY_INTERRUPTED"
                    assert recovered["trusted_result"] == trusted
                restart_blocker.set()
                await eventually(lambda: read_discovery_http(path, "1")["status"] == "discovered")
                clock.advance(15)
                await eventually(lambda: read_discovery_http(path)["status"] == "discovered")
                with archive_client(path) as api:
                    state = api.get(DISCOVERY).json()
                    assert state["attempt"]["error"] is None
                    assert state["trusted_result"]["ids"] == ["900719925474099312349", "100", "20"]
                    assert state["trusted_result"]["discovered_at"] == clock.now()
            finally:
                running.cancel()
                await asyncio.gather(running, return_exceptions=True)

    asyncio.run(scenario())


@pytest.mark.parametrize("change", ["n", "specified", "delete"])
def test_inflight_config_change_invalidates_old_results_without_deleting_trusted_discovery(tmp_path, change):
    path = tmp_path / "monitor.sqlite"
    with client_for(path) as api:
        api.post(BASE, json={"uid": UID})
        enable(api)

    async def scenario():
        slow = False
        blocked = asyncio.Event()
        release = asyncio.Event()
        requests = []

        async def upstream(request):
            requests.append(str(request.url))
            if slow:
                if "offset" in request.url.params:
                    blocked.set()
                    await release.wait()
                payload = feed_response()
                payload["data"].update(has_more=True, offset="next")
                return httpx.Response(200, json=payload)
            return httpx.Response(200, json=feed_response())

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            assert await collector.discover_once(UID)
            trusted = read_discovery_http(path)["trusted_result"]
            slow = True
            task = asyncio.create_task(collector.discover_once(UID))
            try:
                await asyncio.wait_for(blocked.wait(), 3)
                with client_for(path) as api:
                    if change == "delete":
                        assert api.delete(f"{BASE}/{UID}/monitor").status_code == 204
                    else:
                        api.patch(f"{BASE}/{UID}/monitor", json={
                            "mode": "specified" if change == "specified" else "recent",
                            "recent_n": 1, "enabled": True,
                        })
                    stopped = api.get(DISCOVERY).json()
                    assert stopped["trusted_result"] == trusted
                    assert stopped["attempt"]["error"] == "DISCOVERY_STOPPED"
                    assert stopped["status"] == "failed"
                    if change == "delete":
                        assert stopped["mode"] is None and stopped["recent_n"] is None
                    assert api.get("/api/archive/ups").json()["ups"][0]["id"] == UID
                slow = False
                count = len(requests)
                if change == "n":
                    # 配置新N立即允许新领取；旧分页返回不能盖掉新成功。
                    assert await collector.discover_once(UID)
                    with archive_client(path) as api:
                        replacement = api.get(DISCOVERY).json()
                        assert replacement["trusted_result"]["recent_n"] == 1
                        assert replacement["trusted_result"]["ids"] == ["900719925474099312349"]
                else:
                    assert not await collector.discover_once(UID)
                    assert len(requests) == count
                    replacement = stopped
                release.set()
                assert not await task
                with archive_client(path) as api:
                    assert api.get(DISCOVERY).json() == replacement
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


def test_discovery_has_no_five_up_or_hundred_target_product_cap(tmp_path):
    path = tmp_path / "monitor.sqlite"
    uids = ["1", "2", "3", "4", "5", "6", "7"]
    with client_for(path) as api:
        for uid in uids:
            assert api.post(BASE, json={"uid": uid}).status_code == 201
            assert api.patch(f"{BASE}/{uid}/monitor", json={
                "mode": "recent", "recent_n": 101, "enabled": True,
            }).status_code == 200

    async def scenario():
        def upstream(request):
            uid = request.url.params["host_mid"]
            payload = feed_response(uid)
            template = payload["data"]["items"][0]
            payload["data"]["items"] = [{**template, "id_str": str(id)} for id in range(1000, 1101)]
            return httpx.Response(200, json=payload)
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            for uid in uids:
                assert await collector.discover_once(uid)

    asyncio.run(scenario())
    with archive_client(path) as api:
        for uid in uids:
            result = api.get(f"{BASE}/{uid}/discovery").json()["trusted_result"]
            assert result["recent_n"] == 101 and len(result["ids"]) == 101
            assert result["ids"][0] == "1000" and result["ids"][-1] == "1100"
            assert all(isinstance(id, str) for id in result["ids"])


def test_fixed_discovery_ticks_retry_and_skip_busy_without_blocking_checks_or_http(tmp_path, caplog):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    with client_for(path) as api:
        for uid in ("201", "202"):
            api.post(BASE, json={"uid": uid})
            enable(api, uid)

    async def scenario():
        clock = ControlledClock()
        release = asyncio.Event()
        feeds, pages = [], []

        async def upstream(request):
            if request.url.path.endswith("/feed/space"):
                uid = request.url.params["host_mid"]
                feeds.append((uid, clock.value))
                if uid == "201":
                    await release.wait()
                    payload = feed_response(uid)
                    payload["data"].update(has_more=True, offset="FICTIONAL_SECRET_OFFSET")
                    return httpx.Response(200, json=payload)
                if clock.value == 0:
                    raise httpx.ConnectError("FICTIONAL_SECRET_UPSTREAM", request=request)
                return httpx.Response(200, json=feed_response(uid))
            if request.url.path.startswith("/opus/"):
                pages.append(clock.value)
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            running = asyncio.create_task(Collector(Store(path), client, clock=clock).run())
            try:
                await eventually(lambda: len(feeds) == 2 and 15 in clock.deadlines)
                await eventually(lambda: read_discovery_http(path, "202")["status"] == "failed")
                with archive_client(path) as api:
                    busy = api.get(f"{BASE}/201/discovery").json()
                    assert busy["status"] == "running" and busy["trusted_result"] is None
                    assert api.get("/api/archive/dynamics").status_code == 200
                clock.advance(15)
                await eventually(lambda: ("202", 15) in feeds and 15 in pages and 30 in clock.deadlines)
                await eventually(lambda: read_discovery_http(path, "202")["status"] == "discovered")
                assert [stamp for uid, stamp in feeds if uid == "201"] == [0]
                # 慢 I/O 时停用可写；已发请求返回后不再发第二页。
                with client_for(path) as api:
                    assert api.patch(f"{BASE}/201/monitor", json={
                        "mode": "recent", "recent_n": 10, "enabled": False,
                    }).status_code == 200
                release.set()
                clock.advance(30)
                await eventually(lambda: ("202", 30) in feeds and 30 in pages and 45 in clock.deadlines)
                with archive_client(path) as api:
                    stopped = api.get(f"{BASE}/201/discovery").json()
                    assert stopped["status"] == "failed"
                    assert stopped["attempt"]["error"] == "DISCOVERY_STOPPED"
                    assert not stopped["active"] and not stopped["retryable"]
                    assert stopped["trusted_result"] is None
                    assert "FICTIONAL_SECRET" not in api.get(f"{BASE}/201/discovery").text + caplog.text
                assert [stamp for uid, stamp in feeds if uid == "201"] == [0]
            finally:
                running.cancel()
                await asyncio.gather(running, return_exceptions=True)

    asyncio.run(scenario())
