"""28：原始 feed → 共享检查/归档链 → SQLite/只读 HTTP 生命周期。"""

import asyncio
from copy import deepcopy

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client, readable_html, archive_content
from backend.tests.collector_support import configured, empty_upstream, CHECKS
from backend.tests.management_support import BASE, UID
from backend.tests.collector_clock import ControlledClock, eventually
from backend.tests.test_recent_discovery import feed_response, DISCOVERY


def recent(path, n=2):
    # 同时保留一个指定关联，核实近期选择不会混入指定集合。
    configured(path, ("999",))
    with archive_client(path) as api:
        assert api.patch(f"{BASE}/{UID}/monitor", json={
            "mode": "recent", "recent_n": n, "enabled": True,
        }).status_code == 200


def feed(ids):
    payload = feed_response()
    candidate = payload["data"]["items"][0]
    payload["data"]["items"] = [{**deepcopy(candidate), "id_str": id} for id in ids]
    return httpx.Response(200, json=payload)


def state(path):
    with archive_client(path) as api:
        return api.get(DISCOVERY).json(), api.get(CHECKS).json()["checks"]


def test_trusted_publication_selects_only_recent_window_and_initializes_without_edit_marker(tmp_path):
    path = tmp_path / "monitor.sqlite"
    recent(path)

    async def scenario():
        requests = []

        def upstream(request):
            requests.append(request.url.path)
            if request.url.path.endswith("/feed/space"):
                return feed(["123", "124", "125"])
            if request.url.path.startswith("/opus/"):
                id = request.url.path.split("/")[-1]
                return httpx.Response(200, text=readable_html(id=id, pictures=[]).replace(
                    "编辑于 2026年10月09日 13:01", "刚刚"))
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            assert await collector.discover_once(UID)
            published, checks = state(path)
            assert published["current_ids"] == ["123", "124"]
            assert [(c["id"], c["active"], c["check_status"]) for c in checks] == [
                ("123", True, "unchecked"), ("124", True, "unchecked"), ("999", False, "unchecked")]
            with archive_client(path) as api:
                assert api.get("/api/archive/dynamics").json()["items"] == []
            for id in ("123", "124"):
                assert await collector.check_once(UID, id)
            assert not await collector.check_once(UID, "999")
            await collector.execute_pending()
            with archive_client(path) as api:
                for id in ("123", "124"):
                    archive = api.get(f"/api/archive/dynamics/{id}").json()
                    assert archive["text"].startswith("虚构全文")
                    assert archive["edit_status"] == "unknown"
                    assert archive["work"] == dict.fromkeys(("text", "media", "comments", "replies"), "success")
                assert api.get("/api/archive/dynamics/125").status_code == 404
            assert all(c["work"] == "complete" for c in state(path)[1] if c["active"])
            before = state(path)
            assert await collector.discover_once(UID)
            for id in ("123", "124"):
                await collector.check_once(UID, id)
            requests.clear()
            await collector.execute_pending()
            assert requests == []
            assert [c["revision"] for c in state(path)[1]] == [c["revision"] for c in before[1]]

    asyncio.run(scenario())


@pytest.mark.parametrize("change", ["n", "mode", "stop", "delete"])
def test_late_discovery_cannot_replace_new_config_window_or_reactivate_targets(tmp_path, change):
    path = tmp_path / "monitor.sqlite"
    recent(path)

    async def scenario():
        slow = False
        blocked, release = asyncio.Event(), asyncio.Event()

        async def upstream(request):
            if request.url.path.endswith("/feed/space"):
                if slow:
                    blocked.set()
                    await release.wait()
                    return feed(["124", "125"])
                return feed(["123"])
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.discover_once(UID)
            await collector.check_once(UID, "123")
            slow = True
            task = asyncio.create_task(collector.discover_once(UID))
            try:
                await asyncio.wait_for(blocked.wait(), 3)
                with archive_client(path) as api:
                    if change == "delete":
                        assert api.delete(f"{BASE}/{UID}/monitor").status_code == 204
                    else:
                        assert api.patch(f"{BASE}/{UID}/monitor", json={
                            "mode": "specified" if change == "mode" else "recent",
                            "recent_n": 1 if change == "n" else 2,
                            "enabled": change != "stop",
                        }).status_code == 200
                # 新 N 未发现时保留旧可信窗口；停止/指定/删除不再入选近期目标。
                expected = ["123"] if change == "n" else []
                assert state(path)[0]["current_ids"] == expected
                slow = False
                if change == "n":
                    assert await collector.discover_once(UID)
                release.set()
                assert not await task
                published, checks = state(path)
                assert published["current_ids"] == expected
                assert published["trusted_result"]["ids"] == ["123"]
                assert not any(c["active"] for c in checks if c["id"] in ("124", "125"))
                if change != "n":
                    assert not await collector.check_once(UID, "123")
                    await collector.execute_pending()
                    assert next(c for c in state(path)[1] if c["id"] == "123")["work"] == "pending"
                if change == "mode":
                    assert await collector.check_once(UID, "999")
                    assert not await collector.check_once(UID, "123")
            finally:
                release.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


def test_failed_discovery_keeps_published_window_and_no_source_reads_on_http(tmp_path):
    path = tmp_path / "monitor.sqlite"
    recent(path)

    async def scenario():
        failing = False

        def upstream(request):
            if request.url.path.endswith("/feed/space"):
                return httpx.Response(503, text="FICTIONAL_SECRET") if failing else feed(["123", "124"])
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.discover_once(UID)
            failing = True
            assert not await collector.discover_once(UID)
            published, checks = state(path)
            assert published["status"] == "failed" and published["incomplete"]
            assert published["current_ids"] == ["123", "124"]
            assert {c["id"] for c in checks if c["active"]} == {"123", "124"}
            assert await collector.check_once(UID, "123")
            await collector.execute_pending()
            with archive_client(path) as api:
                # 无来源 handler，任意上游 I/O 都会失败；读取/删配置仍正常。
                assert api.get("/api/archive/dynamics/123").json()["work"]["text"] == "success"
                assert api.delete(f"{BASE}/{UID}/monitor").status_code == 204
                assert api.get(DISCOVERY).json()["current_ids"] == []
                assert not api.get(CHECKS).json()["checks"][0]["active"]
                assert api.get("/api/archive/dynamics/123").status_code == 200

    asyncio.run(scenario())


def test_explicit_initial_uses_same_current_window_and_preserves_archive_after_mode_switch(tmp_path):
    path = tmp_path / "monitor.sqlite"
    recent(path)

    async def publish():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: feed(["123"]))) as client:
            assert await Collector(Store(path), client).discover_once(UID)

    asyncio.run(publish())
    with archive_client(path, empty_upstream) as api:
        assert api.post("/api/sync/initial", json={"uid": UID}).json() == {
            "processed": 1, "succeeded": 1, "failed": 0,
        }
        assert api.get("/api/archive/dynamics/123").json()["text"].startswith("虚构全文")
        assert api.get("/api/archive/dynamics/999").status_code == 404
        api.patch(f"{BASE}/{UID}/monitor", json={"mode": "specified", "recent_n": 2, "enabled": True})
        assert api.post("/api/sync/initial", json={"uid": UID}).json()["processed"] == 1
        assert api.get("/api/archive/dynamics/999").status_code == 200
        assert api.get("/api/archive/dynamics/123").status_code == 200
        assert api.get(DISCOVERY).json()["current_ids"] == []


def test_recent_fixed_ticks_skip_busy_checks_and_drop_result_after_window_removal(tmp_path):
    path = tmp_path / "monitor.sqlite"
    recent(path)

    async def scenario():
        clock = ControlledClock()
        release = asyncio.Event()
        ids = ["123", "124"]
        pages = []
        discoveries = []

        async def upstream(request):
            if request.url.path.endswith("/feed/space"):
                discoveries.append(clock.value)
                return feed(ids)
            if request.url.path.startswith("/opus/"):
                id = request.url.path.split("/")[-1]
                pages.append((id, clock.value))
                if id == "123" and clock.value == 0:
                    await release.wait()
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client, clock=clock)
            await collector.discover_once(UID)
            running = asyncio.create_task(collector.run())
            try:
                await eventually(lambda: ("123", 0) in pages and 15 in clock.deadlines)
                await eventually(lambda: discoveries.count(0) == 2 and Store(path).read_discovery(UID)["status"] == "discovered")
                await eventually(lambda: any(c["last_checked_at"] for c in Store(path).read_checks(UID) if c["id"] == "124"))
                clock.advance(15)
                await eventually(lambda: ("124", 15) in pages and 30 in clock.deadlines)
                await eventually(lambda: Store(path).read_discovery(UID)["status"] == "discovered"
                                 and Store(path).read_discovery(UID)["trusted_result"]["discovered_at"] == clock.now())
                assert [stamp for id, stamp in pages if id == "123"] == [0]
                await eventually(lambda: any(c["last_checked_at"] == clock.now() for c in Store(path).read_checks(UID) if c["id"] == "124"))
                ids = ["124"]
                clock.advance(30)
                await eventually(lambda: Store(path).read_discovery(UID)["current_ids"] == ["124"] and 45 in clock.deadlines)
                release.set()
                await eventually(lambda: any(c["last_checked_at"] == clock.now() for c in Store(path).read_checks(UID) if c["id"] == "124"))
                # 给已返回检查完成持久提交；下个节拍重新纳入前，不能写旧观察。
                for _ in range(10):
                    await asyncio.sleep(0.01)
                assert not any(c["id"] == "123" and c["last_checked_at"] for c in Store(path).read_checks(UID))
                ids = ["123", "124"]
                clock.advance(45)
                await eventually(lambda: Store(path).read_discovery(UID)["current_ids"] == ids and 60 in clock.deadlines)
                clock.advance(60)
                await eventually(lambda: ("123", 60) in pages and 75 in clock.deadlines)
                assert not any(id == "123" and stamp in (15, 30) for id, stamp in pages)
            finally:
                release.set()
                running.cancel()
                await asyncio.gather(running, return_exceptions=True)

    asyncio.run(scenario())


def test_removed_pending_work_and_successful_content_survive_reopen_and_reinclusion(tmp_path):
    path = tmp_path / "monitor.sqlite"
    recent(path)

    async def scenario():
        ids = ["123", "124"]
        roots_fail = True
        requests = []

        def upstream(request):
            requests.append(request.url.path)
            if request.url.path.endswith("/feed/space"):
                return feed(ids)
            if request.url.path == "/x/v2/reply" and roots_fail:
                return httpx.Response(503, text="FICTIONAL_SECRET")
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.discover_once(UID)
            for id in ids:
                await collector.check_once(UID, id)
            await collector.execute_pending()
            with archive_client(path) as api:
                old = archive_content(api.get("/api/archive/dynamics/123").json())
                assert old["work"]["text"] == "success"
                assert old["work"]["comments"] == "pending"
            removed_before = next(c for c in state(path)[1] if c["id"] == "123")
            ids = ["124", "125"]
            await collector.discover_once(UID)
            # 新 Store 与新 HTTP 应用：窗口/配置/pending 均从磁盘恢复。
            reopened = Collector(Store(path), client)
            assert state(path)[0]["current_ids"] == ids
            removed = next(c for c in state(path)[1] if c["id"] == "123")
            assert removed == {**removed_before, "active": False}
            requests.clear()
            assert not await reopened.check_once(UID, "123")
            await reopened.execute_pending()
            assert "/opus/123" not in requests
            with archive_client(path) as api:
                assert archive_content(api.get("/api/archive/dynamics/123").json()) == old
                assert {item["id"] for item in api.get("/api/archive/dynamics").json()["items"]} == {"123", "124"}
                assert api.get("/api/archive/ups").json()["ups"][0]["id"] == UID
            ids = ["123", "125"]
            roots_fail = False
            await reopened.discover_once(UID)
            requests.clear()
            # 不需要新编辑或再次检查，直接恢复旧持久 pending。
            await Collector(Store(path), client).execute_pending()
            current = next(c for c in state(path)[1] if c["id"] == "123")
            assert current["active"] and current["work"] == "complete"
            assert current["revision"] == removed_before["revision"]
            assert "/opus/123" not in requests
            assert "/x/v2/reply" in requests
            with archive_client(path) as api:
                archive = api.get("/api/archive/dynamics/123").json()
                assert archive["text"] == old["text"]
                assert archive["synced_version"] == old["synced_version"]
                assert archive["comments_last_attempt"] == "success"

    asyncio.run(scenario())
