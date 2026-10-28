"""05：恢复观察期累积与稳定清零（真实临时 SQLite、受控时钟）。

观察期只按“确有成功业务请求的活跃采集时间”累计：空闲与停机不抵扣，重启重新累计但
保留档位；观察期再次遇到 HTTP 412／429 沿用上一档的下一档。测试只通过公开的状态机
接口与真实来源报告入口驱动，不碰内部表。
"""

import asyncio
import logging
import sqlite3
from contextlib import contextmanager

from backend.bili_monitor.comment_status import epoch_from_iso
from backend.bili_monitor.risk import (
    OBSERVATION_SECONDS, RiskGate, SourceRiskPaused, format_epoch,
)
from backend.bili_monitor.source_gate import SourceReport, source_request
from backend.bili_monitor.storage import Store
from backend.tests.collector_clock import ControlledClock


BASE = epoch_from_iso(ControlledClock().now())


@contextmanager
def captured_events():
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


def open_gate(path, clock):
    store = Store(path)
    store.migrate()
    return store, RiskGate(store, clock=clock)


def request_for(path="/x/v2/reply", host="api.bilibili.com"):
    classified = source_request("GET", f"https://{host}{path}")
    assert classified is not None
    return classified


def trigger(gate, status_code=412):
    try:
        asyncio.run(gate.report(request_for("/x/v2/reply/reply"),
                                SourceReport(status_code=status_code)))
    except SourceRiskPaused:
        return True
    return False


def http(gate, status_code=200, path="/x/v2/reply", host="api.bilibili.com"):
    """一次真实发送的传输结果：只有 HTTP 状态，没有业务解析，因此不算成功业务请求。"""
    asyncio.run(gate.report(request_for(path, host), SourceReport(status_code=status_code)))


def business(gate, kind="comment_count"):
    """一次已通过业务解析／资源校验的请求：观察期只认这份事实。"""
    gate.note_business_success(kind)


def deadline_on_clock(status):
    return epoch_from_iso(status["next_probe_at"]) - BASE


def observing(gate, clock, step=1):
    """用真实状态转移把保护推进到第 `step` 档探测通过后的观察态（不手写内部表）。"""
    while gate.status()["state"] == "normal":
        assert trigger(gate) is True
    while gate.status()["backoff_step"] != step:
        clock.advance(deadline_on_clock(gate.status()))
        claim = asyncio.run(gate.claim_probe(["replies"]))
        assert claim is not None
        asyncio.run(gate.record_probe(claim, {"endpoint_type": "replies", "status": "failed"}))
        asyncio.run(gate.finish_probe(claim, False))
    clock.advance(deadline_on_clock(gate.status()))
    claim = asyncio.run(gate.claim_probe(["replies"]))
    assert claim is not None
    assert asyncio.run(gate.record_probe(
        claim, {"endpoint_type": "replies", "status": "passed"})) is True
    status = asyncio.run(gate.finish_probe(claim, True))
    assert status["state"] == "observing"
    return status


def tick(gate, elapsed):
    return asyncio.run(gate.observing_tick(elapsed))


def test_observation_clears_only_after_ten_active_minutes_of_successful_collection(tmp_path):
    clock = ControlledClock()
    _, gate = open_gate(tmp_path / "observe.sqlite", clock)
    with captured_events() as log:
        status = observing(gate, clock)
        # 进入观察态：档位保留，进度从零开始。
        assert status["backoff_step"] == 1
        assert status["observation"] == {
            "since": status["observing_since"], "active_ms": 0, "successes": 0,
            "required_ms": int(OBSERVATION_SECONDS * 1000),
        }

        # 每秒都有成功业务请求：9 分 59 秒仍不清零。
        for _ in range(59):
            business(gate)
            tick(gate, 10)
        business(gate)
        status = tick(gate, 9)
        assert status["state"] == "observing"
        assert status["backoff_step"] == 1
        assert status["observation"]["active_ms"] == 599_000
        assert status["observation"]["successes"] == 60

        # 满 10 分钟且有成功业务请求才回到 normal 并清零档位。
        business(gate)
        status = tick(gate, 1)
        assert status["state"] == "normal"
        assert status["backoff_step"] == 0
        assert status["observing_since"] is None
        assert status["observation"]["active_ms"] == 0
        assert status["observation"]["successes"] == 0

        # 稳定后没有额外计时：再推进时间也不会回头改写已清零的事实。
        assert tick(gate, 600) is None
        assert gate.status()["observation"]["active_ms"] == 0
    # 稳定恢复的日志带原风控代次、探测轮次与观察事实，供后续告警复用。
    cleared = events(log, "source_risk_observation_cleared")
    assert len(cleared) == 1
    assert "previous_state=observing" in cleared[0] and "risk_state=normal" in cleared[0]
    assert "backoff_step=0" in cleared[0] and "observing_ms=600000" in cleared[0]
    assert "probe_round_id=" in cleared[0] and "probe_round_id=none" not in cleared[0]




def test_idle_and_failed_ticks_never_discount_the_observation_window(tmp_path):
    clock = ControlledClock()
    _, gate = open_gate(tmp_path / "idle.sqlite", clock)
    observing(gate, clock)

    # 空闲十分钟：没有任何成功业务请求，不进观察进度。
    for _ in range(3):
        assert tick(gate, 200)["observation"]["active_ms"] == 0
    # 普通错误响应、HTTP 2xx 与仅有的预热都不算成功业务请求，也不抵扣。
    http(gate, status_code=500)
    assert tick(gate, 200)["state"] == "observing"
    http(gate, status_code=200)  # 只是传输成功，业务解析并未通过
    assert tick(gate, 200)["state"] == "observing"
    business(gate, kind="homepage_warmup")  # 预热即使成功也不算业务请求
    assert tick(gate, 200)["state"] == "observing"
    assert gate.status()["observation"]["active_ms"] == 0
    assert gate.status()["observation"]["successes"] == 0

    # 真正的成功请求才推进活跃时间，且需要累计满 10 分钟。
    business(gate)
    assert tick(gate, 300)["observation"]["active_ms"] == 300_000
    assert gate.status()["state"] == "observing"
    business(gate)
    status = tick(gate, 300)
    assert status["state"] == "normal"
    assert status["observation"]["successes"] == 0


def test_http_success_or_redirect_alone_never_advances_the_observation_window(tmp_path):
    """回归：HTTP 2xx／3xx 只是传输事实，业务拒绝（200+code=-352）与跳转都不是恢复证据。"""
    clock = ControlledClock()
    _, gate = open_gate(tmp_path / "http-only.sqlite", clock)
    observing(gate, clock)

    for status_code in (200, 204, 302, 200):
        http(gate, status_code=status_code)
        status = tick(gate, 300)
        assert status["state"] == "observing"
        assert status["backoff_step"] == 1
        assert status["observation"]["active_ms"] == 0
        assert status["observation"]["successes"] == 0

    # 只有业务解析／资源校验成功才推进，并仍然需要满 10 分钟。
    business(gate)
    assert tick(gate, 600)["state"] == "normal"


def test_observation_progress_is_persisted_for_the_read_only_status(tmp_path):
    clock = ControlledClock()
    path = tmp_path / "persisted.sqlite"
    _, gate = open_gate(path, clock)
    observing(gate, clock, step=2)
    business(gate)
    tick(gate, 120)

    # 另一个进程（同一 SQLite 的另一个 gate）读到的进度一致；探测轮次与档位保留。
    other = RiskGate(Store(path), clock=clock)
    status = other.status()
    assert status["state"] == "observing"
    assert status["backoff_step"] == 2
    assert status["observation"]["active_ms"] == 120_000
    assert status["observation"]["successes"] == 1


def test_restart_resets_observation_accumulation_and_keeps_the_step(tmp_path):
    clock = ControlledClock()
    _, gate = open_gate(tmp_path / "restart.sqlite", clock)
    observing(gate, clock, step=3)
    business(gate)
    tick(gate, 300)
    assert gate.status()["observation"]["active_ms"] == 300_000

    # 采集进程重启：停机时间不抵扣，观察期重新累计，但档位不回到 1。
    status = asyncio.run(gate.restart_observation())
    assert status["state"] == "observing"
    assert status["backoff_step"] == 3
    assert status["observation"]["active_ms"] == 0
    assert status["observation"]["successes"] == 0

    # 重新累计：重启前那次成功请求不参与重启后的第一个区间。
    assert tick(gate, 300)["observation"]["active_ms"] == 0
    business(gate)
    assert tick(gate, 300)["observation"]["active_ms"] == 300_000
    business(gate)
    status = tick(gate, 299)
    assert status["state"] == "observing"
    assert status["observation"]["active_ms"] == 599_000
    business(gate)
    status = tick(gate, 1)
    assert status["state"] == "normal"
    assert status["backoff_step"] == 0


def test_trigger_during_observation_advances_one_step_and_restarts_the_window(tmp_path):
    clock = ControlledClock()
    _, gate = open_gate(tmp_path / "retrigger.sqlite", clock)
    observing(gate, clock, step=2)
    business(gate)
    assert tick(gate, 300)["observation"]["active_ms"] == 300_000

    # 观察期再次遇到风控：进入当前档的下一档，不是从 1 分钟重来。
    assert trigger(gate, status_code=429) is True
    status = gate.status()
    assert status["state"] == "cooldown"
    assert status["backoff_step"] == 3
    assert deadline_on_clock(status) == clock.value + 240
    assert status["observation"]["active_ms"] == 0
    assert status["observation"]["successes"] == 0

    # 观察期内空转不会因为时间流逝直接清零。
    clock.advance(10**6)
    assert gate.status()["state"] == "cooldown"


def test_v26_migration_keeps_the_registered_pause_and_adds_observation_state(tmp_path):
    path = tmp_path / "v25.sqlite"
    clock = ControlledClock()
    store, gate = open_gate(path, clock)
    assert trigger(gate) is True
    paused = gate.status()

    # 旧库（v25，风险仍只有 03／04 字段）升级：保护状态原样保留，新列按默认值补齐。
    with sqlite3.connect(path) as database:
        for name in ("probe_origin", "probe_request_generation",
                     "observing_active_ms", "observing_successes"):
            database.execute(f"ALTER TABLE source_risk DROP COLUMN {name}")
        database.execute("PRAGMA user_version = 25")

    store.migrate()
    with sqlite3.connect(path) as database:
        assert database.execute("PRAGMA user_version").fetchone()[0] == 27
        columns = {row[1] for row in database.execute("PRAGMA table_info(source_risk)")}
        assert {"probe_origin", "probe_request_generation", "observing_active_ms",
                "observing_successes"} <= columns
    reloaded = RiskGate(Store(path), clock=clock).status()
    assert reloaded["state"] == "cooldown"
    assert reloaded["backoff_step"] == paused["backoff_step"]
    assert reloaded["next_probe_at"] == paused["next_probe_at"]
    assert reloaded["observation"]["active_ms"] == 0
    assert reloaded["manual"]["probe_registered"] is False
