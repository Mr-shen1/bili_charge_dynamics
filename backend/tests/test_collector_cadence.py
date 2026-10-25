"""固定节拍：生产默认 2.7 秒 ±10%，可用环境变量覆盖为固定值。"""

import asyncio

import httpx

from backend.bili_monitor.collector import CADENCE_JITTER, CADENCE_SECONDS, Collector, cadence_provider
from backend.bili_monitor.storage import Store
from backend.tests.collector_clock import ControlledClock, eventually


def test_default_cadence_is_2_7s_with_ten_percent_jitter(monkeypatch):
    monkeypatch.delenv("BILI_COLLECTOR_CADENCE_SECONDS", raising=False)
    provider = cadence_provider()
    samples = [provider() for _ in range(400)]
    assert min(samples) >= CADENCE_SECONDS * (1 - CADENCE_JITTER)
    assert max(samples) <= CADENCE_SECONDS * (1 + CADENCE_JITTER)
    # 有抖动：不是固定常量，避免机械节拍。
    assert len({round(value, 6) for value in samples}) > 1


def test_env_override_is_fixed(monkeypatch):
    monkeypatch.setenv("BILI_COLLECTOR_CADENCE_SECONDS", "3")
    provider = cadence_provider()
    assert {provider() for _ in range(20)} == {3.0}


def test_invalid_env_override_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("BILI_COLLECTOR_CADENCE_SECONDS", "abc")
    provider = cadence_provider()
    samples = [provider() for _ in range(50)]
    assert min(samples) >= CADENCE_SECONDS * (1 - CADENCE_JITTER)
    assert max(samples) <= CADENCE_SECONDS * (1 + CADENCE_JITTER)


def test_tick_uses_injected_cadence(tmp_path):
    path = tmp_path / "monitor.sqlite"

    async def scenario():
        clock = ControlledClock()
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200))) as client:
            collector = Collector(Store(path), client, clock=clock, cadence=lambda: 2.5)
            task = asyncio.create_task(collector.run())
            try:
                await eventually(lambda: clock.deadlines == [2.5])
                clock.advance(2.5)
                await eventually(lambda: clock.deadlines == [2.5, 5.0])
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())
