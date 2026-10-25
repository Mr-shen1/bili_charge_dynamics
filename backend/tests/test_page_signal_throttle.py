"""页面信号按独立低频节拍采样：计数检查走主节拍，页面请求默认 60 秒一次。"""

import asyncio

import httpx

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from backend.tests.collector_clock import ControlledClock, eventually
from backend.tests.collector_support import configured, empty_upstream, UID

DYN = "123"


def counting_upstream(requests, *, page_status=200, detail_status=200):
    def upstream(request):
        requests.append(request.url.path)
        if request.url.path.startswith("/opus/") and page_status != 200:
            return httpx.Response(page_status, json={"code": -352, "message": "blocked"})
        if request.url.path.endswith("/detail") and detail_status != 200:
            return httpx.Response(detail_status, json={"code": -352, "message": "blocked"})
        return empty_upstream(request)

    return upstream


async def run_checks(path, requests, *, ticks, clock_step=2.7, page_status=200, detail_status=200,
                     page_interval=60.0):
    clock = ControlledClock()
    transport = httpx.MockTransport(counting_upstream(
        requests, page_status=page_status, detail_status=detail_status))
    async with httpx.AsyncClient(transport=transport) as client:
        collector = Collector(Store(path), client, clock=clock, cadence=lambda: clock_step,
                              page_check_seconds=page_interval)
        accepted = []
        for index in range(ticks):
            clock.value = index * clock_step
            accepted.append(await collector.check_once(UID, DYN))
    return accepted


def test_page_signal_is_sampled_once_per_interval(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    requests = []
    asyncio.run(run_checks(path, requests, ticks=3))
    # 3 次检查（间隔 2.7 秒）只采样一次页面；每次都要读计数。
    assert requests.count("/opus/" + DYN) == 1
    assert requests.count("/x/v2/reply/count") == 3


def test_page_signal_resampled_after_interval(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    requests = []
    asyncio.run(run_checks(path, requests, ticks=24))     # 24 × 2.7s ≈ 64.8s
    assert requests.count("/opus/" + DYN) == 2


def test_page_failure_does_not_hammer_upstream(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    requests = []
    asyncio.run(run_checks(path, requests, ticks=3, page_status=412))
    # 页面失败时仍走一次 detail 兜底拿定位；之后按间隔节流，不每 tick 重试。
    assert requests.count("/opus/" + DYN) == 1
    assert requests.count("/x/polymer/web-dynamic/v1/detail") == 1
    assert requests.count("/x/v2/reply/count") == 3


def test_page_and_detail_failure_stops_hammering(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)
    requests = []
    asyncio.run(run_checks(path, requests, ticks=3, page_status=412, detail_status=412))
    # 两次来源都失败：只有第一轮打上游，之后进入间隔等待，也不发没有定位的计数请求。
    assert len(requests) == 2
    assert requests.count("/x/v2/reply/count") == 0


def test_count_only_tick_keeps_previous_signals(tmp_path):
    path = tmp_path / "monitor.sqlite"
    configured(path)

    async def scenario():
        clock = ControlledClock()
        async with httpx.AsyncClient(transport=httpx.MockTransport(counting_upstream([]))) as client:
            collector = Collector(Store(path), client, clock=clock, cadence=lambda: 2.7,
                                  page_check_seconds=60.0)
            await collector.check_once(UID, DYN)
            first = next(item for item in await asyncio.to_thread(collector.store.read_checks, UID)
                         if item["id"] == DYN)
            assert first["check_status"] != "failed"
            clock.value = 2.7
            await collector.check_once(UID, DYN)
            second = next(item for item in await asyncio.to_thread(collector.store.read_checks, UID)
                         if item["id"] == DYN)
            # 只读计数的一轮：保留页面信号，不写失败。
            assert second["check_status"] == "unchanged"
            assert second["check_error"] is None
            assert second["observed"]["observed_version"] == first["observed"]["observed_version"]

    asyncio.run(scenario())
