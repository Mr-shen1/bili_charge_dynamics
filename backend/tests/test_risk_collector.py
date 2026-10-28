"""03：采集进程在保护状态下的调度与失败事实（真实 SQLite、受控时钟）。"""

import asyncio
import logging
from contextlib import contextmanager

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.risk import RiskGate, SourceRiskPaused
from backend.bili_monitor.source_gate import GatedAsyncTransport, source_request
from backend.bili_monitor.storage import Store
from backend.tests.collector_clock import ControlledClock, eventually
from backend.tests.collector_support import configured, empty_upstream
from backend.tests.management_support import UID


def collector_for(store, upstream, *, clock=None, risk=True):
    gate = RiskGate(store) if risk else None
    client = httpx.AsyncClient(transport=GatedAsyncTransport(httpx.MockTransport(upstream), gate=gate))
    return client, gate, Collector(store, client, clock=clock, risk=gate)


@contextmanager
def captured_events():
    """采集进程的固定日志通道（journald 同源），用于断言事件与去重。"""
    logger = logging.getLogger("bili_monitor.collector")
    records = []

    class Capture(logging.Handler):
        def emit(self, record):
            records.append(record.getMessage())

    handler = Capture()
    logger.addHandler(handler)
    try:
        yield records
    finally:
        logger.removeHandler(handler)


def events(records, name):
    return [line for line in records if line.startswith(name)]


def test_paused_collector_stops_dispatching_without_new_failures(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    store = Store(path)

    async def scenario():
        clock = ControlledClock()
        requests = []

        def upstream(request):
            requests.append(request.url.path)
            if request.url.path == "/x/v2/reply/count":
                return httpx.Response(412, text="")
            return empty_upstream(request)


        client, gate, collector = collector_for(store, upstream, clock=clock)
        async with client:
            running = asyncio.create_task(collector.run())
            try:
                await eventually(lambda: gate.status()["state"] == "cooldown" and 15 in clock.deadlines)
                triggered = list(requests)
                for tick in (15, 30, 45):
                    clock.advance(tick)
                    await eventually(lambda: tick + 15 in clock.deadlines)
                assert requests == triggered
                assert requests[-1] == "/x/v2/reply/count"
            finally:
                running.cancel()
                try:
                    await running
                except asyncio.CancelledError:
                    pass

        assert gate.status()["state"] == "cooldown"
        # 被保护暂停不是来源失败：不写检查结果、不伪造成功时间，工作仍是 pending。
        check = store.read_checks(UID)[0]
        assert check["work"] == "pending"
        assert check["last_checked_at"] is None
        assert check["last_succeeded_at"] is None
        assert check["check_error"] is None and check["sync_error"] is None

    with captured_events() as records:
        asyncio.run(scenario())
    # 暂停期间不每节拍重复同一警告：一次状态转移只有一条固定事件。
    assert len(events(records, "collector_paused")) == 1
    assert len(events(records, "source_risk_triggered")) == 1
    assert len(events(records, "source_risk_paused_work_aborted")) == 1


def test_in_flight_execution_aborts_without_writing_failure_facts(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    store = Store(path)

    async def scenario():
        armed = {"value": False}

        def upstream(request):
            if armed["value"] and request.url.path == "/x/v2/reply":
                return httpx.Response(412, text="")
            return empty_upstream(request)

        client, gate, collector = collector_for(store, upstream)
        async with client:
            await collector.check_once(UID, "123")
            assert store.pending_checks() == [{"uid": UID, "id": "123"}]
            armed["value"] = True
            await collector.execute_pending()  # 不因暂停抛给调用方，也不写假失败
            assert gate.status()["state"] == "cooldown"

        # 取消语义：在途领取保留，重启恢复后再回到 pending，且没有失败事实。
        check = store.read_checks(UID)[0]
        assert check["work"] == "running"
        assert check["sync_error"] is None and check["last_succeeded_at"] is None
        store.recover_check_work()
        assert store.read_checks(UID)[0]["work"] == "pending"
        archive = store.read_archive("123")
        assert archive["work"]["comments"] == "pending"
        assert archive["work"]["replies"] == "pending"
        assert archive.get("comments_error") is None

    asyncio.run(scenario())


def test_loaded_state_is_visible_to_another_process_gate(tmp_path):
    """进程内对象不冒充全局保护：暂停后另建的 gate 立刻拒绝发送。"""
    path = tmp_path / "monitor.sqlite"
    configured(path)
    store = Store(path)

    async def scenario():
        armed = {"value": False}

        def upstream(request):
            if armed["value"] and request.url.path == "/x/v2/reply/count":
                return httpx.Response(429, text="")
            return empty_upstream(request)

        client, gate, collector = collector_for(store, upstream)
        async with client:
            await collector.check_once(UID, "123")
            armed["value"] = True
            # 单元被保护打断时抛给调度层结算：不写检查结果，也不吞成普通失败。
            with pytest.raises(SourceRiskPaused):
                await collector.check_once(UID, "123")

        second = RiskGate(Store(path))
        assert second.status()["last_trigger"]["endpoint_type"] == "comment_count"
        with pytest.raises(SourceRiskPaused):
            await second.permit(source_request("GET", "https://api.bilibili.com/x/v2/reply"))

    asyncio.run(scenario())
