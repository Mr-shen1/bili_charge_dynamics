"""01：独立投递的失败分类、退避、等待配置、租约与批量边界。

事件由真实归档/采集入口产生，投递进程使用受控时钟与受控飞书响应；
仅在验证租约/原子性时使用必要的数据库断言。
"""

import asyncio
import json
import sqlite3
from contextlib import contextmanager

import httpx

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.notifications import Dispatcher, NotificationConfig, outbox
from backend.bili_monitor.storage import Store
from backend.tests.collector_support import configured
from backend.tests.management_support import UID
from backend.tests.notification_support import (
    BASE_URL, DYNAMIC, WEBHOOK, Clock, Receiver, Source, config, deliveries, events, message_text,
)


def archived_changes(path, versions, *, title=None):
    """从真实检查/归档入口产生基线之后的可通知变化。"""
    source = Source("v1")

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            for edited in versions:
                source.page, source.title, source.edited = "v2", title, edited
                await collector.check_once(UID, DYNAMIC)
                await collector.execute_pending()

    configured(path)
    asyncio.run(run())


def pending(path):
    rows = deliveries(path)
    assert rows and all(row["state"] == "pending" for row in rows)
    return rows


def run_once(path, transport, *, clock=None, **sections):
    return asyncio.run(Dispatcher(Store(path), config(**sections), transport=transport, clock=clock).run_once())


def test_business_rejection_is_retried_with_backoff_until_accepted(tmp_path):
    path = tmp_path / "archive.sqlite"
    archived_changes(path, ["13:02"])
    clock = Clock()
    responses = [{"code": 9499, "msg": "Bad Request"}, {"code": 0, "msg": "success"}]

    def receiver(request):
        return httpx.Response(200, json=responses.pop(0) if responses else {"code": 0})

    run_once(path, httpx.MockTransport(receiver), clock=clock)
    failed = deliveries(path)[0]
    assert (failed["state"], failed["attempts"], failed["error"], failed["sent_at"]) == (
        "pending", 1, "platform_rejected", None)
    assert failed["due_at"] == clock.now() + 2.0  # 第一次失败退避 2 秒
    # 退避未到期不重复请求。
    run_once(path, httpx.MockTransport(receiver), clock=clock)
    assert responses == [{"code": 0, "msg": "success"}]
    clock.advance(2.0)
    run_once(path, httpx.MockTransport(receiver), clock=clock)
    sent = deliveries(path)[0]
    assert (sent["state"], sent["attempts"], sent["sent_at"]) == ("sent", 2, clock.now())
    assert len(events(path)) == 1


def test_rate_limit_uses_platform_suggestion_and_network_errors_retry(tmp_path):
    path = tmp_path / "archive.sqlite"
    archived_changes(path, ["13:02", "13:03"])
    clock = Clock()
    receiver = Receiver(
        lambda request: httpx.Response(429, headers={"x-ogw-ratelimit-reset": "45"}, json={"code": 11232}))
    run_once(path, httpx.MockTransport(receiver), clock=clock)
    limited = [row for row in deliveries(path) if row["state"] == "pending"]
    assert len(limited) == 2 and all(row["error"] == "rate_limited" for row in limited)
    assert all(row["due_at"] == clock.now() + 45.0 for row in limited)

    def broken(request):
        raise httpx.ConnectError("fictional network failure", request=request)

    clock.advance(45.0)
    run_once(path, httpx.MockTransport(broken), clock=clock)
    retried = [row for row in deliveries(path) if row["state"] == "pending"]
    assert len(retried) == 2 and all(row["error"] == "network_error" for row in retried)
    assert all(row["due_at"] > clock.now() for row in retried)


def test_missing_destination_waits_for_config_then_delivers_after_repair(tmp_path):
    path = tmp_path / "archive.sqlite"
    archived_changes(path, ["13:02"])
    clock = Clock()

    def unexpected(request):
        raise AssertionError("缺少目标时不得执行无效 HTTP")

    missing = NotificationConfig.from_mapping(
        {"base_url": BASE_URL, "ups": {UID: {}}, "destinations": {}})
    asyncio.run(Dispatcher(Store(path), missing, transport=httpx.MockTransport(unexpected),
                           clock=clock).run_once())
    waiting = deliveries(path)[0]
    assert (waiting["state"], waiting["error"], waiting["attempts"]) == ("waiting_config", "route_missing", 1)
    assert waiting["due_at"] == clock.now() + 60.0

    receiver = Receiver()
    clock.advance(60.0)
    run_once(path, httpx.MockTransport(receiver), clock=clock)
    assert [item["url"] for item in receiver.requests] == [WEBHOOK]
    assert deliveries(path)[0]["state"] == "sent"
    assert len(events(path)) == 1


def test_expired_lease_is_recovered_and_stale_completion_is_rejected(tmp_path):
    path = tmp_path / "archive.sqlite"
    archived_changes(path, ["13:02"])
    clock = Clock()
    with sqlite3.connect(path) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("BEGIN IMMEDIATE")
        claimed = outbox.claim_due(connection, clock.now(), 8, 30.0)
        connection.commit()
    assert len(claimed) == 1 and claimed[0]["snapshot"]["dynamic_id"] == DYNAMIC
    # 失效凭证不能覆盖仍有效的领取。
    with sqlite3.connect(path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        assert outbox.finish_delivery(connection, claimed[0]["delivery_id"], "stale-token",
                                      state="sent", now=clock.now()) is False
        connection.commit()
    assert deliveries(path)[0]["state"] == "inflight"
    # 租约到期后由新的领取恢复并真正发送。
    clock.advance(31.0)
    receiver = Receiver()
    run_once(path, httpx.MockTransport(receiver), clock=clock)
    assert len(receiver.requests) == 1
    row = deliveries(path)[0]
    assert (row["state"], row["token"], row["lease_until"]) == ("sent", None, None)


def test_batch_limit_and_independent_deliveries(tmp_path):
    path = tmp_path / "archive.sqlite"
    archived_changes(path, ["13:02", "13:03", "13:04"])
    receiver = Receiver()
    clock = Clock()
    checkpoint = Store(path).read_archive(DYNAMIC)
    assert len(pending(path)) == 3
    dispatcher = Dispatcher(Store(path), config(), transport=httpx.MockTransport(receiver), clock=clock, batch=2)
    asyncio.run(dispatcher.run_once())
    assert len(receiver.requests) == 2
    assert [row["state"] for row in deliveries(path)].count("sent") == 2
    asyncio.run(dispatcher.run_once())
    assert len(receiver.requests) == 3
    assert len(events(path)) == 3
    assert all(row["state"] == "sent" for row in deliveries(path))
    # 投递成功/失败不回写归档成功 checkpoint。
    assert Store(path).read_archive(DYNAMIC) == checkpoint


def test_snapshot_is_frozen_when_event_is_generated(tmp_path):
    path = tmp_path / "archive.sqlite"
    archived_changes(path, ["13:02"], title="旧标题")
    row = pending(path)[0]
    assert row["snapshot"] == {"dynamic_id": DYNAMIC, "title": "旧标题"}
    # 事件生成后归档更新（这里直接改归档文档）不改写消息快照。
    with sqlite3.connect(path) as connection:
        document = json.loads(connection.execute(
            "SELECT document FROM archives WHERE id = ?", (DYNAMIC,)).fetchone()[0])
        document["title"] = "新标题"
        connection.execute("UPDATE archives SET document = ? WHERE id = ?",
                           (json.dumps(document, ensure_ascii=False), DYNAMIC))
    receiver = Receiver()
    run_once(path, httpx.MockTransport(receiver))
    assert message_text(receiver.payloads[0]).splitlines()[0] == "动态【旧标题】发生变化"
    assert deliveries(path)[0]["snapshot"]["title"] == "旧标题"


def test_transient_cycle_failure_does_not_stop_the_delivery_loop(tmp_path):
    path = tmp_path / "archive.sqlite"
    archived_changes(path, ["13:02"])

    class FlakyStore:
        """第一次领取时数据库暂时不可用，之后恢复；模拟锁竞争等瞬时故障。"""

        def __init__(self, target):
            self.real = Store(target)
            self.calls = 0

        @contextmanager
        def connection(self):
            self.calls += 1
            if self.calls == 2:
                raise sqlite3.OperationalError("fictional database is locked")
            with self.real.connection() as connection:
                yield connection

    class StoppingClock(Clock):
        def __init__(self):
            super().__init__()
            self.sleeps = 0

        async def sleep(self, seconds):
            self.sleeps += 1
            if self.sleeps > 2:
                raise asyncio.CancelledError

    async def scenario():
        clock = StoppingClock()
        receiver = Receiver()
        dispatcher = Dispatcher(FlakyStore(path), config(), transport=httpx.MockTransport(receiver),
                                clock=clock, poll_seconds=0)
        try:
            await dispatcher.run()
        except asyncio.CancelledError:
            pass
        await dispatcher.aclose()
        return receiver, clock

    receiver, clock = asyncio.run(scenario())
    assert clock.sleeps == 3  # 单轮失败后继续轮询
    assert len(receiver.requests) == 1
    assert deliveries(path)[0]["state"] == "sent"


def test_feishu_request_does_not_hold_a_database_write_transaction(tmp_path):
    path = tmp_path / "archive.sqlite"
    archived_changes(path, ["13:02"])

    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()

        async def responder(request):
            entered.set()
            await release.wait()
            return httpx.Response(200, json={"code": 0, "msg": "success"})

        dispatcher = Dispatcher(Store(path), config(), transport=httpx.MockTransport(responder), clock=Clock())
        running = asyncio.create_task(dispatcher.run_once())
        await asyncio.wait_for(entered.wait(), timeout=5)

        def write():
            with sqlite3.connect(path, timeout=1) as connection:
                connection.execute("UPDATE monitors SET recent_n = recent_n + 1 WHERE uid = ?", (UID,))
                connection.commit()
                return connection.execute("SELECT recent_n FROM monitors WHERE uid = ?", (UID,)).fetchone()[0]

        # 飞书请求阻塞期间，另一路独立写事务仍能完成（不持有 SQLite 写锁）。
        assert await asyncio.wait_for(asyncio.to_thread(write), timeout=5) == 11
        release.set()
        await running
        await dispatcher.aclose()

    asyncio.run(scenario())
    assert deliveries(path)[0]["state"] == "sent"
