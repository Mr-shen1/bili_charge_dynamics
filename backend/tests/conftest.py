"""隔离运维凭据，避免后续测试误读服务器的真实 Cookie 文件。"""

import pytest


@pytest.fixture(autouse=True)
def isolate_source_cookie_file(monkeypatch):
    # Cookie 专项测试如需配置，应在用例内显式设置虚构临时文件。
    monkeypatch.delenv("BILI_COOKIE_FILE", raising=False)
    # 既有用例按 15 秒节拍推进受控时钟；生产默认 2.7s±10% 由 test_collector_cadence 单独覆盖。
    monkeypatch.setenv("BILI_COLLECTOR_CADENCE_SECONDS", "15")
