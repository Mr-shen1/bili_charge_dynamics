"""隔离运维凭据和外部等待，避免测试触碰生产输入或真实楼级节奏。"""

import asyncio

import pytest


@pytest.fixture(autouse=True)
def isolate_source_cookie_file(monkeypatch):
    # Cookie 专项测试如需配置，应在用例内显式设置虚构临时文件。
    monkeypatch.delenv("BILI_COOKIE_FILE", raising=False)
    # 仅替换外部时钟；楼级区间/请求时序由专项测试显式断言。
    async def no_real_reply_wait(seconds):
        assert 0.3 <= seconds <= 0.4
        await asyncio.sleep(0)

    monkeypatch.setattr("backend.bili_monitor.replies.sleep_after_root", no_real_reply_wait)
    # 既有用例按 15 秒节拍推进受控时钟；生产默认 2.7s±10% 由 test_collector_cadence 单独覆盖。
    monkeypatch.setenv("BILI_COLLECTOR_CADENCE_SECONDS", "15")
    # 既有用例每个节拍都期望页面信号（0 = 每节拍采样）；生产默认 60 秒由 test_page_signal_throttle 覆盖。
    monkeypatch.setenv("BILI_COLLECTOR_PAGE_CHECK_SECONDS", "0")
