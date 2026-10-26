"""01：真实通知进程 + 本机受控飞书接收端 + 临时 SQLite。

进程使用生产入口 `python -m backend.bili_monitor.notifier`，事件由真实采集/归档
写入；只把飞书地址替换成本机替身，凭据全部是虚构值。跨进程装配见
`notification_process_support`（06 的终止/恢复用例复用同一套）。
"""

import json
import time

from backend.bili_monitor.storage import Store
from backend.tests.notification_process_support import (
    FeishuStub, NotifierProcess, archive_change, wait_for,
)
from backend.tests.notification_support import (
    BASE_URL, DYNAMIC, deliveries, events, message_text, write_config,
)


def test_notification_process_delivers_once_and_survives_restart(tmp_path):
    path = tmp_path / "monitor.sqlite"
    archive_change(path)
    config_path = write_config(tmp_path / "notifications.json")
    with FeishuStub() as stub:
        write_config(config_path, up=stub.url)
        with NotifierProcess(tmp_path, path, config_path) as notifier:
            wait_for(lambda: stub.count("fake-process") == 1, notifier)
            wait_for(lambda: deliveries(path)[0]["state"] == "sent", notifier)
            request = stub.requests[0]
            assert request["path"] == "/open-apis/bot/v2/hook/fake-process"
            assert message_text(request["payload"]).splitlines() == [
                "动态【123】发生变化", "链接：查看动态"]
            link = request["payload"]["content"]["post"]["zh_cn"]["content"][1][1]
            assert link["href"] == f"{BASE_URL}/dynamics/{DYNAMIC}"
            # 只允许一个投递实例：第二个进程必须退出。
            duplicate = NotifierProcess(tmp_path, path, config_path)
            duplicate.handle.wait(timeout=20)
            assert duplicate.handle.returncode != 0
            assert "Notifier already running" in duplicate.text
            first_log = notifier.text
        # 进程重启不重复投递，也不改写成功状态。
        with NotifierProcess(tmp_path, path, config_path) as restarted:
            time.sleep(2.5)
            assert stub.count("fake-process") == 1
            assert deliveries(path)[0]["state"] == "sent"
            assert "delivery_sent" not in restarted.text
        assert notifier_log_redacted(first_log, stub.url)
        # 真实进程也按墙钟登记小时心跳（本文件没有系统群路由，故只留待配置记录）；
        # 事件数只对业务类型断言，避免结果依赖测试运行时刻。
        assert len([event for event in events(path) if event["kind"] == "dynamic_changed"]) == 1
        saved = json.dumps(deliveries(path), ensure_ascii=False)
        assert "fake-process" not in saved


def notifier_log_redacted(text, webhook):
    token = webhook.rsplit("/", 1)[-1]
    assert "delivery_sent" in text
    return token not in text and "open-apis" not in text


def test_process_keeps_message_waiting_for_missing_route_then_delivers(tmp_path):
    path = tmp_path / "monitor.sqlite"
    archive_change(path)
    config_path = write_config(tmp_path / "notifications.json", up=None)
    with FeishuStub() as stub:
        with NotifierProcess(tmp_path, path, config_path) as notifier:
            wait_for(lambda: deliveries(path)[0]["state"] == "waiting_config", notifier)
            assert stub.requests == []
        assert deliveries(path)[0]["attempts"] == 1
        # 修复服务端配置后重启通知进程：保留原记录并补发，不重设阶段。
        write_config(tmp_path / "notifications.json", up=stub.url)
        with NotifierProcess(tmp_path, path, config_path) as repaired:
            wait_for(lambda: stub.count("fake-process") == 1, repaired)
            wait_for(lambda: deliveries(path)[0]["state"] == "sent", repaired)
        assert len([event for event in events(path) if event["kind"] == "dynamic_changed"]) == 1
        # 归档检查点不因投递结果改变。
        assert Store(path).read_archive(DYNAMIC)["content_state"] == "success"
