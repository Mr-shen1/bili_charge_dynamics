"""10：统一托管入口（API＋collector＋可选通知进程）的启动顺序、单实例语义与收尾。

这里用可控进程替身验证托管编排本身：迁移顺序、任一子进程退出的联动、TERM 后
按反向顺序停止以及没有通知配置时的两进程兼容形态。真实子进程的锁与投递语义由
三进程集成用例与通知进程契约覆盖，不用进程内替身冒充。
"""

import os
import signal
import threading

import pytest

from backend.bili_monitor import service


class FakeEvent:
    def __init__(self):
        self.flag = False

    def set(self):
        self.flag = True

    def is_set(self):
        return self.flag

    def wait(self, timeout=None):
        return self.flag


class FakeProcess:
    counter = iter(range(1, 1000))

    def __init__(self, context, name):
        self.context = context
        self.name = name
        self.pid = next(self.counter)
        self.alive = True
        self.terminated = False
        self.closed = False
        self.joined = False

    def start(self):
        self.context.started.append(self.name)
        if self.name == "bili-api":
            self.context.ready.set()
        if self.name in self.context.dead_on_start:
            self.alive = False
        if len(self.context.started) >= self.context.expected_children:
            self.context.all_started.set()

    def is_alive(self):
        return self.alive

    def terminate(self):
        self.terminated = True
        self.context.stopped.append(self.name)
        self.alive = False

    def join(self):
        self.joined = True

    def close(self):
        self.closed = True


class FakeContext:
    def __init__(self, expected_children, *, dead_on_start=()):
        self.ready = FakeEvent()
        self.all_started = threading.Event()
        self.started = []
        self.stopped = []
        self.dead_on_start = set(dead_on_start)
        self.expected_children = expected_children
        self.processes = []

    def Event(self):
        return self.ready

    def Process(self, target=None, args=(), name=None):
        process = FakeProcess(self, name)
        self.processes.append(process)
        return process


def stop_after_started(context):
    """在全部子进程启动后向本进程发 TERM，模拟外部托管的正常停止。"""
    finished = threading.Event()

    def trigger():
        context.all_started.wait(timeout=10)
        if not finished.is_set():
            os.kill(os.getpid(), signal.SIGTERM)

    thread = threading.Thread(target=trigger, daemon=True)
    thread.start()
    return finished


def test_three_processes_start_in_migration_order_and_stop_in_reverse(monkeypatch, tmp_path):
    config = tmp_path / "notifications.json"
    config.write_text("{}")
    monkeypatch.setenv("BILI_NOTIFICATION_CONFIG", str(config))
    context = FakeContext(3)
    finished = stop_after_started(context)
    try:
        service.serve(tmp_path / "monitor.sqlite", "127.0.0.1", 0, context=context, startup_timeout=5)
    finally:
        finished.set()
    # 迁移先由 API 完成（uvicorn lifespan），再启动 collector，最后才是独立通知进程。
    assert context.started == ["bili-api", "bili-collector", "bili-notifier"]
    # TERM 后按“通知 → 采集 → API”的反向顺序等待各自真正退出。
    assert context.stopped == ["bili-notifier", "bili-collector", "bili-api"]
    assert all(process.joined and process.closed for process in context.processes)


def test_missing_notification_config_keeps_the_supported_two_process_form(monkeypatch, tmp_path):
    monkeypatch.delenv("BILI_NOTIFICATION_CONFIG", raising=False)
    context = FakeContext(2)
    finished = stop_after_started(context)
    try:
        service.serve(tmp_path / "monitor.sqlite", "127.0.0.1", 0, context=context, startup_timeout=5)
    finally:
        finished.set()
    assert context.started == ["bili-api", "bili-collector"]
    assert context.stopped == ["bili-collector", "bili-api"]


def test_any_child_exit_stops_the_others_and_fails_the_service(monkeypatch, tmp_path):
    config = tmp_path / "notifications.json"
    config.write_text("{}")
    monkeypatch.setenv("BILI_NOTIFICATION_CONFIG", str(config))
    context = FakeContext(3, dead_on_start={"bili-collector"})
    with pytest.raises(RuntimeError, match="Backend process exited"):
        service.serve(tmp_path / "monitor.sqlite", "127.0.0.1", 0, context=context, startup_timeout=5)
    # 采集进程退出后，已启动的通知进程与 API 都被要求停止并等待退出；已退出的子进程只回收。
    assert context.stopped == ["bili-notifier", "bili-api"]
    assert all(process.joined and process.closed for process in context.processes)


def test_api_not_ready_is_a_startup_failure_without_starting_workers(monkeypatch, tmp_path):
    monkeypatch.setenv("BILI_NOTIFICATION_CONFIG", str(tmp_path / "notifications.json"))
    context = FakeContext(3, dead_on_start={"bili-api"})
    with pytest.raises(RuntimeError, match="API startup failed"):
        service.serve(tmp_path / "monitor.sqlite", "127.0.0.1", 0, context=context, startup_timeout=5)
    assert context.started == ["bili-api"]
    assert context.stopped == []
    assert context.processes[0].joined and context.processes[0].closed


def test_notifier_entry_uses_the_published_process_module(monkeypatch, tmp_path):
    """第三个子进程仍是生产通知入口与真实配置加载，不在托管层复制投递逻辑。"""
    calls = {}

    class FakeDispatcher:
        def __init__(self, *arguments, **keywords):
            calls["served"] = True

    async def fake_serve(database, config):
        calls["database"] = database
        calls["config"] = config

    import backend.bili_monitor.notifier as notifier_module
    from backend.bili_monitor.notifications import config as config_module

    class Config:
        @classmethod
        def load(cls, path):
            calls["path"] = path
            return "config-object"

    monkeypatch.setattr(config_module, "NotificationConfig", Config)
    monkeypatch.setattr(notifier_module, "serve", fake_serve)
    service.run_notifier(str(tmp_path / "monitor.sqlite"), str(tmp_path / "notifications.json"))
    assert calls["database"].endswith("monitor.sqlite")
    assert calls["path"].endswith("notifications.json")
    assert calls["config"] == "config-object"
