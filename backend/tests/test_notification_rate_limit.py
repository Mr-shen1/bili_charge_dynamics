"""13：主动限速——按目的地预算发送，超预算顺延 due_at 而不是等 429。

两层接缝：`RateLimiter` 的窗口/隔离/顺延语义；`Dispatcher` 的真实调度行为
（实际发送时刻、顺延不改状态与失败事实、系统角色独立额度、等待有上界）。
只替换飞书 HTTP 传输与时间来源。
"""

import asyncio

import httpx
import pytest

from backend.bili_monitor import notifier
from backend.bili_monitor.notifications import Dispatcher
from backend.bili_monitor.notifications.ratelimit import (
    DEFER_STEP_SECONDS, MAX_DEFER_SECONDS, RateLimiter,
)
from backend.bili_monitor.storage import Store
from backend.tests.notification_support import (
    BeijingClock, Receiver, config, deliveries, events, write_config,
)
from backend.tests.test_notification_alerts import SYSTEM_WEBHOOK
from backend.tests.test_notification_delivery import archived_changes


# --- 限速器本身 -------------------------------------------------------------

def test_destination_allows_five_per_second_and_defers_the_sixth():
    limiter = RateLimiter()
    for _ in range(5):
        assert limiter.defer_seconds("hook-a", 1_000.0) == 0.0
        limiter.record("hook-a", 1_000.0)
    # 同一秒内的第 6 条必须顺延到最早一条退出 1 秒窗口之后。
    assert limiter.defer_seconds("hook-a", 1_000.0) == 1.0
    # 顺延以 1 秒为步长，不返回亚秒级等待。
    assert limiter.defer_seconds("hook-a", 1_000.5) == 1.0
    assert limiter.defer_seconds("hook-a", 1_001.0) == 0.0
    limiter.record("hook-a", 1_001.0)
    assert limiter.defer_seconds("hook-a", 1_001.0) == 0.0


def test_destination_allows_one_hundred_per_minute_and_no_more():
    limiter = RateLimiter()
    now = 0.0
    for _ in range(100):  # 5 条/秒跑满一分钟额度
        assert limiter.defer_seconds("hook", now) == 0.0
        limiter.record("hook", now)
        now += 0.2
    # 第 101 条：分钟窗口已满，要等最早一条退出 60 秒窗口。
    assert limiter.defer_seconds("hook", 20.0) == 40.0
    assert limiter.defer_seconds("hook", 59.9) == 1.0
    # 走完一个完整分钟窗口后额度恢复。
    assert limiter.defer_seconds("hook", 60.0) == 0.0


def test_destinations_do_not_share_budget():
    limiter = RateLimiter()
    for _ in range(5):
        limiter.record("hook-a", 0.0)
    assert limiter.defer_seconds("hook-a", 0.0) == 1.0
    assert limiter.defer_seconds("hook-b", 0.0) == 0.0


def test_defer_step_matches_the_poll_interval_and_stays_bounded():
    assert DEFER_STEP_SECONDS == 1.0
    assert MAX_DEFER_SECONDS == 61.0


# --- 投递调度 ---------------------------------------------------------------

def dispatcher(path, transport, clock, **sections):
    sections.setdefault("system", SYSTEM_WEBHOOK)
    return Dispatcher(Store(path), config(**sections), transport=httpx.MockTransport(transport),
                      clock=clock)


def recorder(clock, calls, responder=None):
    """受控飞书接收端：记录每个请求的实际发送时刻（受控时钟）。"""
    def transport(request):
        calls.append((str(request.url), clock.now()))
        if responder is not None:
            return responder(request)
        return httpx.Response(200, json={"code": 0, "msg": "success"})
    return transport


def test_over_budget_records_are_deferred_without_counting_failures(tmp_path):
    path = tmp_path / "archive.sqlite"
    archived_changes(path, [f"13:{minute:02d}" for minute in range(2, 10)])  # 8 条同群 = 单轮批量
    clock = BeijingClock.start(13, 0)
    receiver = Receiver()

    async def scenario():
        notifier_process = dispatcher(path, receiver, clock)
        try:
            await notifier_process.run_once()
        finally:
            await notifier_process.aclose()

    asyncio.run(scenario())
    saved = deliveries(path)
    sent = [row for row in saved if row["state"] == "sent"]
    deferred = [row for row in saved if row["state"] == "pending"]
    assert (len(sent), len(deferred)) == (5, 3)
    # 顺延不是失败：留在 pending、只改 due_at，不消耗 attempts、不写 error、不增 failures。
    assert {row["due_at"] for row in deferred} == {clock.now() + 1.0}
    for row in deferred:
        assert (row["attempts"], row["failures"], row["error"], row["sent_at"]) == (0, 0, None, None)
        assert row["token"] is None and row["lease_until"] is None
    assert all(row["attempts"] == 1 and row["failures"] == 0 for row in sent)
    assert len(events(path)) == 8

    clock.advance(1.0)
    receiver2 = Receiver()

    async def next_tick():
        notifier_process = dispatcher(path, receiver2, clock)
        try:
            await notifier_process.run_once()
        finally:
            await notifier_process.aclose()

    asyncio.run(next_tick())
    # 顺延的记录下一轮自然重领，且只被真正发过一次。
    assert [row["state"] for row in deliveries(path)] == ["sent"] * 8
    assert all(row["attempts"] == 1 and row["failures"] == 0 for row in deliveries(path))


def test_failing_group_keeps_retry_waits_bounded_and_attempts_honest(tmp_path):
    path = tmp_path / "archive.sqlite"
    archived_changes(path, [f"13:{minute:02d}" for minute in range(2, 14)])  # 12 条同群
    clock = BeijingClock.start(13, 0)
    calls = []

    def always_500(request):
        return httpx.Response(500, json={"code": 500, "msg": "FICTIONAL_SECRET_RESPONSE"})

    async def scenario():
        notifier_process = dispatcher(path, recorder(clock, calls, always_500), clock)
        try:
            for _ in range(40):
                await notifier_process.tick()
                clock.advance(1.0)
        finally:
            await notifier_process.aclose()

    asyncio.run(scenario())
    saved = deliveries(path)
    # 退避上限 300 秒、限速顺延上限 61 秒，两者不累加：单条记录的最坏等待可计算。
    for row in saved:
        assert row["state"] == "pending"
        assert 0 < row["due_at"] - clock.now() <= 300.0 + MAX_DEFER_SECONDS
        # 顺延不消耗 attempts：每个 attempts 都对应一次真实发送失败。
        assert row["failures"] == row["attempts"]
    assert 0 < len(calls) <= 40 * 5


def test_environment_can_lower_but_never_loosen_the_platform_budget(monkeypatch):
    monkeypatch.delenv("BILI_NOTIFIER_SENDS_PER_SECOND", raising=False)
    assert notifier.quota("BILI_NOTIFIER_SENDS_PER_SECOND", 5) == 5
    monkeypatch.setenv("BILI_NOTIFIER_SENDS_PER_SECOND", "2")
    assert notifier.quota("BILI_NOTIFIER_SENDS_PER_SECOND", 5) == 2
    # 默认值是飞书官方额度：环境变量只能调小，不能放大。
    monkeypatch.setenv("BILI_NOTIFIER_SENDS_PER_SECOND", "500")
    assert notifier.quota("BILI_NOTIFIER_SENDS_PER_SECOND", 5) == 5
    for invalid in ("0", "-1", "5.5", "abc", ""):
        monkeypatch.setenv("BILI_NOTIFIER_SENDS_PER_SECOND", invalid)
        with pytest.raises(SystemExit):
            notifier.quota("BILI_NOTIFIER_SENDS_PER_SECOND", 5)


def test_environment_limiter_defaults_to_the_official_budget(monkeypatch):
    for name in ("BILI_NOTIFIER_SENDS_PER_SECOND", "BILI_NOTIFIER_SENDS_PER_MINUTE"):
        monkeypatch.delenv(name, raising=False)
    limiter = notifier.limiter_from_environment()
    assert (limiter.per_second, limiter.per_minute) == (5, 100)
    monkeypatch.setenv("BILI_NOTIFIER_SENDS_PER_SECOND", "2")
    monkeypatch.setenv("BILI_NOTIFIER_SENDS_PER_MINUTE", "3")
    limiter = notifier.limiter_from_environment()
    assert (limiter.per_second, limiter.per_minute) == (2, 3)
    # 两个额度互相矛盾时拒绝启动，不静默改动其中一个。
    monkeypatch.setenv("BILI_NOTIFIER_SENDS_PER_SECOND", "5")
    with pytest.raises(SystemExit):
        notifier.limiter_from_environment()


def test_unified_service_entry_passes_the_rate_limit_to_the_notifier(monkeypatch, tmp_path):
    """契约 §1 推荐的 `service` 三进程入口也读取额度环境变量，不只在 `notifier.main`。"""
    from backend.bili_monitor import service

    captured = {}

    def fake_serve(database, config, **options):
        captured.update(options)

        async def done():
            return None

        return done()

    monkeypatch.setattr(notifier, "serve", fake_serve)
    config_path = write_config(tmp_path / "notifications.json")
    monkeypatch.setenv("BILI_NOTIFIER_SENDS_PER_SECOND", "2")
    monkeypatch.setenv("BILI_NOTIFIER_SENDS_PER_MINUTE", "3")
    service.run_notifier(str(tmp_path / "archive.sqlite"), str(config_path))
    limiter = captured["limiter"]
    assert (limiter.per_second, limiter.per_minute) == (2, 3)
    # 矛盾的额度在托管入口同样拒绝启动，不静默回落默认值。
    monkeypatch.setenv("BILI_NOTIFIER_SENDS_PER_SECOND", "5")
    with pytest.raises(SystemExit):
        service.run_notifier(str(tmp_path / "archive.sqlite"), str(config_path))
