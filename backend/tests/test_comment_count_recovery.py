"""25：取消恢复、领取隔离、拒绝与有限并发的公开采集／SQLite HTTP 证据。"""

import asyncio

import httpx
import pytest

from backend.bili_monitor.collector import Collector, collector_lock
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client
from backend.tests.collector_clock import ControlledClock, eventually
from backend.tests.collector_support import CHECKS, configured, empty_upstream
from backend.tests.management_support import UID
from backend.tests.test_comment_count_sync import ARCHIVE, CommentSource, snapshot


def read_items(api, url):
    """沿公开 cursor 读完归档，不假定首屏包含旧内容。"""
    items, params = [], {}
    while True:
        response = api.get(url, params=params)
        assert response.status_code == 200
        batch = response.json()
        items.extend(batch["items"])
        if batch["next_cursor"] is None:
            return items
        params = {"cursor": batch["next_cursor"]}


@pytest.mark.parametrize("blocked_path", ["/x/v2/reply", "/x/v2/reply/reply"])
def test_cancelled_comment_pages_only_recover_under_explicit_locked_run(tmp_path, blocked_path):
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
            clock = ControlledClock()
            collector = Collector(Store(path), client, clock=clock)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            before, saved = snapshot(path)
            with archive_client(path) as api:
                old_roots = read_items(api, ARCHIVE + "/comments")
                root_id = source.roots[0]["rpid_str"]
                old_replies = read_items(api, ARCHIVE + f"/comments/{root_id}/replies")
            source.expand()
            await collector.check_once(UID, "123")
            delay = True
            execution = asyncio.create_task(collector.execute_pending())
            try:
                await asyncio.wait_for(blocked.wait(), 3)
                execution.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await execution
                interrupted, partial = snapshot(path)
                assert interrupted["work"] == "running"
                assert interrupted["revision"] == before["revision"] + 1
                assert interrupted["observed"]["source_comment_count"] == 70
                assert interrupted["last_succeeded_at"] == before["last_succeeded_at"]
                assert partial["synced_comment_count"] == partial["synced_reply_comment_count"] == 7
                assert partial["text"] == saved["text"]
                assert partial["local_comment_count"] >= 20
                # API 多次关闭／重开不恢复任务；旧根／回复仍从真实归档 HTTP 可读。
                for _ in range(2):
                    assert snapshot(path) == (interrupted, partial)
                    with archive_client(path) as api:
                        roots = read_items(api, ARCHIVE + "/comments")
                        replies = read_items(api, ARCHIVE + f"/comments/{root_id}/replies")
                        assert {item["id"] for item in old_roots} <= {item["id"] for item in roots}
                        assert {item["id"] for item in old_replies} <= {item["id"] for item in replies}
                source.calls.clear()
                await Collector(Store(path), client, clock=clock).execute_pending()
                assert source.calls == []
                assert snapshot(path) == (interrupted, partial)

                blocked.clear()
                restarted = asyncio.create_task(Collector(Store(path), client, clock=clock).run())
                try:
                    await asyncio.wait_for(blocked.wait(), 3)
                    assert snapshot(path)[0]["work"] == "running"
                    # 正式 run 确实持有数据库旁的内核锁；竞争入口不能恢复其 running。
                    with pytest.raises(RuntimeError, match="Collector already running"):
                        await Collector(Store(path), client, clock=ControlledClock()).run()
                    assert snapshot(path)[0]["work"] == "running"
                    release.set()
                    await eventually(lambda: snapshot(path)[0]["work"] == "complete")
                    state, archive = snapshot(path)
                    assert state["revision"] == interrupted["revision"]
                    assert state["observed"]["source_comment_count"] == 70
                    assert state["sync_error"] is None
                    assert archive["synced_comment_count"] == archive["synced_reply_comment_count"] == 70
                    assert archive["local_comment_count"] == 45
                    assert archive["local_reply_count"] == 25
                    assert archive["comments_last_attempt"] == archive["replies_last_attempt"] == "success"
                    assert source.scans()[0] == ("/x/v2/reply", "1")
                    assert (blocked_path, "2") in source.scans()
                    assert clock.deadlines == [15]
                finally:
                    restarted.cancel()
                    await asyncio.gather(restarted, return_exceptions=True)
            finally:
                release.set()
                execution.cancel()
                await asyncio.gather(execution, return_exceptions=True)

    asyncio.run(scenario())


@pytest.mark.parametrize("late_response", ["success", "failure"])
def test_same_count_duplicate_and_recovered_revision_reject_late_old_pages(tmp_path, late_response):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source = CommentSource()

    async def scenario():
        old_blocked, old_release = asyncio.Event(), asyncio.Event()
        new_blocked, new_release = asyncio.Event(), asyncio.Event()
        delay = False
        clock = ControlledClock()

        async def old_upstream(request):
            if delay and request.url.path == "/x/v2/reply" and request.url.params["pn"] == "2":
                old_blocked.set()
                await old_release.wait()
                if late_response == "failure":
                    raise httpx.ReadError("FICTIONAL_SECRET_LATE_PAGE")
            return source(request)

        async def new_upstream(request):
            if request.url.path == "/x/v2/reply" and request.url.params["pn"] == "2":
                new_blocked.set()
                await new_release.wait()
            return source(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(old_upstream)) as old_client, httpx.AsyncClient(
            transport=httpx.MockTransport(new_upstream)
        ) as new_client:
            old = Collector(Store(path), old_client, clock=clock)
            await old.check_once(UID, "123")
            await old.execute_pending()
            source.expand()
            await old.check_once(UID, "123")
            delay = True
            old_task = asyncio.create_task(old.execute_pending())
            new_task = None
            try:
                await asyncio.wait_for(old_blocked.wait(), 3)
                initial, _ = snapshot(path)
                assert initial["work"] == "running"
                assert initial["observed"]["source_comment_count"] == 70
                # 同总数再次检查不增 revision；重复公开执行不发第二轮网络请求。
                await old.check_once(UID, "123")
                duplicate, _ = snapshot(path)
                assert duplicate["revision"] == initial["revision"]
                assert duplicate["work"] == "running"
                source.calls.clear()
                await asyncio.wait_for(asyncio.gather(
                    old.execute_pending(), Collector(Store(path), old_client, clock=clock).execute_pending()
                ), 3)
                assert source.calls == []
                assert snapshot(path)[0]["work"] == "running"

                # 显式持锁 run 恢复并重领同一 revision；旧 HTTP 回调仍可迟到。
                restarted = Collector(Store(path), new_client, clock=clock)
                new_task = asyncio.create_task(restarted.run())
                await asyncio.wait_for(new_blocked.wait(), 3)
                running, new_partial = snapshot(path)
                assert running["work"] == "running"
                assert running["revision"] == initial["revision"]
                assert new_partial["synced_comment_count"] == new_partial["synced_reply_comment_count"] == 7
                old_release.set()
                await asyncio.wait_for(old_task, 3)
                after_old, archive = snapshot(path)
                assert after_old["work"] == "running"
                assert after_old["revision"] == running["revision"]
                assert after_old["observed"]["source_comment_count"] == 70
                assert after_old["last_succeeded_at"] == running["last_succeeded_at"]
                assert after_old["sync_error"] == running["sync_error"]
                assert archive == new_partial
                assert "FICTIONAL_SECRET" not in str(after_old) + str(archive)
                new_release.set()
                await eventually(lambda: snapshot(path)[0]["work"] == "complete")
                state, archive = snapshot(path)
                assert state["revision"] == initial["revision"]
                assert state["sync_error"] is None
                assert archive["synced_comment_count"] == archive["synced_reply_comment_count"] == 70
                assert archive["local_comment_count"] == 45
                assert archive["local_reply_count"] == 25
                source.calls.clear()
                await restarted.execute_pending()
                assert source.calls == []
                assert snapshot(path)[0]["work"] == "complete"
            finally:
                old_release.set()
                new_release.set()
                old_task.cancel()
                if new_task is not None:
                    new_task.cancel()
                await asyncio.gather(*([old_task] + ([new_task] if new_task is not None else [])),
                                     return_exceptions=True)

    asyncio.run(scenario())


@pytest.mark.parametrize("succeeded", [True, False])
def test_same_revision_count_claim_token_rejects_old_finish_result(tmp_path, succeeded):
    # 网络交错之外，直接覆盖公开 Store 终结入口的成功／失败两种结果。
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source = CommentSource()

    async def scenario():
        clock = ControlledClock()
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=clock)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            source.count = 8
            await collector.check_once(UID, "123")
            store = Store(path)
            old = store.claim_check_work(UID, "123")
            assert old is not None
            with collector_lock(path):
                store.recover_check_work()
                new = store.claim_check_work(UID, "123")
                assert new is not None
                assert new["revision"] == old["revision"]
                assert new["observed"] == old["observed"]
                assert new["observed"]["source_comment_count"] == 8
                assert new["token"] != old["token"]
                before = snapshot(path)
                assert before[0]["work"] == "running"
                assert store.finish_check_work(
                    UID, "123", old["revision"], succeeded, clock.now(),
                    None if succeeded else "SYNC_INCOMPLETE", token=old["token"]
                ) is False
                assert snapshot(path) == before
                assert store.finish_check_work(
                    UID, "123", new["revision"], False, clock.now(), "SYNC_INCOMPLETE", token=new["token"]
                ) is False
            assert snapshot(path)[0]["work"] == "pending"
            await collector.execute_pending()
            state, archive = snapshot(path)
            assert state["work"] == "complete"
            assert archive["synced_comment_count"] == archive["synced_reply_comment_count"] == 8

    asyncio.run(scenario())


@pytest.mark.parametrize("rejected_path", ["/x/v2/reply", "/x/v2/reply/reply"])
@pytest.mark.parametrize("rejection", ["http", "business"])
def test_actual_comment_interface_rejection_is_failed_and_preserves_old_checkpoint(tmp_path, rejected_path, rejection):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source = CommentSource()

    async def scenario():
        reject = False
        refusals = []

        def upstream(request):
            if reject and request.url.path == rejected_path:
                refusals.append(dict(request.url.params))
                if rejection == "http":
                    return httpx.Response(403, text="FICTIONAL_SECRET_COMMENT_DENIED")
                return httpx.Response(200, json={"code": -403, "message": "FICTIONAL_SECRET_COMMENT_DENIED", "data": None})
            return source(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            before, saved = snapshot(path)
            root_id = source.roots[0]["rpid_str"]
            with archive_client(path) as api:
                old_roots = read_items(api, ARCHIVE + "/comments")
                old_replies = read_items(api, ARCHIVE + f"/comments/{root_id}/replies")
            source.count = 8
            # 楼中楼按根 rcount 变化增量重扫；这里同时模拟该根新增回复。
            source.roots[0]["rcount"] = 6
            await collector.check_once(UID, "123")
            reject = True
            await collector.execute_pending()
            failed, archive = snapshot(path)
            assert refusals and refusals[0]["pn"] == "1"
            assert failed["work"] == "pending"
            assert failed["sync_error"] == "SYNC_INCOMPLETE"
            assert failed["last_succeeded_at"] == before["last_succeeded_at"]
            assert failed["observed"]["source_comment_count"] == archive["source_comment_count"] == 8
            assert archive["synced_comment_count"] == archive["synced_reply_comment_count"] == 7
            assert archive["comments_last_attempt"] == "failed"
            attempt = "root_comments_last_attempt" if rejected_path == "/x/v2/reply" else "replies_last_attempt"
            assert archive[attempt] == "failed"
            assert archive["local_comment_count"] == saved["local_comment_count"] == 2
            assert archive["local_reply_count"] == saved["local_reply_count"] == 5
            assert archive["text"] == saved["text"]
            assert archive["synced_version"] == saved["synced_version"]
            assert "FICTIONAL_SECRET" not in str(failed) + str(archive)
            with archive_client(path) as api:
                assert {item["id"]: item["text"] for item in read_items(api, ARCHIVE + "/comments")} == {
                    item["id"]: item["text"] for item in old_roots}
                assert read_items(api, ARCHIVE + f"/comments/{root_id}/replies") == old_replies
            reject = False
            source.calls.clear()
            # 无新检查、计数不再变化，重开可完整重试失败轮。
            await Collector(Store(path), client).execute_pending()
            state, archive = snapshot(path)
            assert state["work"] == "complete"
            assert state["revision"] == failed["revision"]
            assert state["sync_error"] is None
            assert archive["synced_comment_count"] == archive["synced_reply_comment_count"] == 8
            assert archive["comments_last_attempt"] == archive["replies_last_attempt"] == "success"
            assert source.scans()[0] == ("/x/v2/reply", "1")
            assert ("/x/v2/reply/reply", "1") in source.scans()

    asyncio.run(scenario())


def test_first_unknown_count_and_denied_webpage_initialize_comments_from_detail_locator(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    source = CommentSource()
    source.count = None
    # 整页没有初始化 JSON／编辑字段／locator，不只是正文旁附加无权提示。
    source.html = "<html>暂无权查看当前评论</html>"

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            checked, _ = snapshot(path)
            assert checked["check_status"] == "failed"
            assert checked["check_error"] == "SOURCE_UNAVAILABLE"
            assert checked["observed"].get("source_comment_count") is None
            assert checked["observed"]["comment_count_status"] == "failed"
            assert checked["observed"]["comment_locator"] == {"oid": "99123", "type": 17, "source": "basic", "policy_version": 1}
            assert [route for route, _ in source.calls] == [
                "/opus/123", "/x/polymer/web-dynamic/v1/detail", "/x/v2/reply/count"]
            await collector.execute_pending()
            state, archive = snapshot(path)
            assert archive["source_comment_count"] is None
            assert archive["synced_comment_count"] is None
            assert archive["synced_reply_comment_count"] is None
            assert archive["local_comment_count"] == 2
            assert archive["local_reply_count"] == 5
            assert archive["comments_last_attempt"] == archive["replies_last_attempt"] == "success"
            assert archive["work"]["comments"] == archive["work"]["replies"] == "success"
            assert state["parts"]["comments"] == state["parts"]["replies"] == "success"
            assert archive["work"]["text"] == "pending"
            assert state["work"] == "pending"  # 评论初始化成功不冒充受限正文已完成。
            assert state["last_succeeded_at"] is None
            with archive_client(path) as api:
                roots = read_items(api, ARCHIVE + "/comments")
                assert len(roots) == 2
                assert len(read_items(api, ARCHIVE + f"/comments/{source.roots[0]['rpid_str']}/replies")) == 5
            source.calls.clear()
            await Collector(Store(path), client).execute_pending()
            assert source.scans() == []
            assert snapshot(path)[1]["synced_comment_count"] is None

    asyncio.run(scenario())


def read_checks(path):
    with archive_client(path) as api:
        response = api.get(CHECKS)
        assert response.status_code == 200
        return {item["id"]: item for item in response.json()["checks"]}


@pytest.mark.parametrize("entrypoint", ["execute_pending", "run"])
def test_three_targets_rotate_single_heavy_step_without_stalling_checks(tmp_path, entrypoint):
    """08：全局只有一个重型发送回合；慢页只阻塞当前分页，其他目标按步骤轮转。"""
    path = tmp_path / "monitor.sqlite"
    ids = ("123", "124", "125")
    configured(path, ids)
    source = CommentSource()

    async def scenario():
        clock = ControlledClock()
        started = {id: asyncio.Event() for id in ids}
        release = {id: asyncio.Event() for id in ids}
        active = {id: 0 for id in ids}
        peak, first_pages, counts = 0, [], {id: 0 for id in ids}

        async def upstream(request):
            nonlocal peak
            url = request.url
            if url.path == "/x/v2/reply/count":
                counts[url.params["oid"][2:]] += 1
            if url.path == "/x/v2/reply" and url.params["pn"] == "1":
                id = url.params["oid"][2:]
                first_pages.append(id)
                active[id] += 1
                peak = max(peak, sum(active.values()))
                started[id].set()
                try:
                    await release[id].wait()
                finally:
                    active[id] -= 1
            if url.path == "/opus/123" or url.params.get("oid") == "99123" or url.params.get("id") == "123":
                return source(request)
            return empty_upstream(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            collector = Collector(Store(path), client, clock=clock, max_syncs=2)
            for id in ids:
                await collector.check_once(UID, id)
            running = asyncio.create_task(getattr(collector, entrypoint)())
            try:
                await asyncio.wait_for(started["123"].wait(), 3)
                assert first_pages == ["123"]
                assert active == {"123": 1, "124": 0, "125": 0}
                assert peak == 1

                release["123"].set()
                await asyncio.wait_for(started["124"].wait(), 3)
                assert first_pages == ["123", "124"]
                assert peak == 1
                if entrypoint == "run":
                    await eventually(lambda: all(row["last_checked_at"] is not None
                                                 for row in read_checks(path).values()))

                release["124"].set()
                await asyncio.wait_for(started["125"].wait(), 3)
                assert first_pages == ["123", "124", "125"]
                assert peak == 1

                release["125"].set()
                if entrypoint == "run":
                    await eventually(lambda: all(row["work"] == "complete"
                                                 for row in read_checks(path).values()))
                else:
                    await asyncio.wait_for(running, 5)
                assert sorted(first_pages) == list(ids)
                assert all(first_pages.count(id) == 1 for id in ids)
                assert peak == 1
                assert active == dict.fromkeys(ids, 0)
                if entrypoint == "run":
                    await eventually(lambda: all(counts[id] >= 1 for id in ids))
                with archive_client(path) as api:
                    for id in ids:
                        response = api.get(f"/api/archive/dynamics/{id}")
                        assert response.status_code == 200
                        archive = response.json()
                        total = 7 if id == "123" else 0
                        assert archive["synced_comment_count"] == archive["synced_reply_comment_count"] == total
                        assert archive["comments_last_attempt"] == archive["replies_last_attempt"] == "success"
            finally:
                for event in release.values():
                    event.set()
                running.cancel()
                await asyncio.gather(running, return_exceptions=True)

    asyncio.run(scenario())
