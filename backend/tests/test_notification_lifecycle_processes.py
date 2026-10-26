"""07：真实通知进程重启 vs 重新启用的跨进程证据（复用 06 的装配）。

通知进程使用生产入口与真实锁，飞书由本机受控 HTTP 服务充当（不是进程内
MockTransport），数据库是临时 SQLite。事件由真实归档链产生，管理操作走真实
HTTP 入口；身份、正文与凭据都是虚构值，不读取真实配置、不访问真实飞书。
"""

import asyncio
import math
import time

import httpx

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client
from backend.tests.management_support import BASE, UID
from backend.tests.notification_process_support import FeishuStub, NotifierProcess, wait_for
from backend.tests.notification_support import (
    DYNAMIC, deliveries, events, query, write_config,
)
from backend.tests.root_notification_support import (
    Source, configure, root_comment, root_documents, started_at,
)

STOPPED = {"mode": "specified", "recent_n": 10, "enabled": False}
STARTED = {"mode": "specified", "recent_n": 10, "enabled": True}


def arm(path, comments):
    """经公开管理 HTTP 建立身份/指定模式/目标；启用即建立通知起点。"""
    source = Source()
    source.add(DYNAMIC, comments)
    configure(path, source)
    return source


def archive(path, source):
    """真实归档链：受控来源 + 检查/归档入口，不直接写库。"""
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()

    asyncio.run(run())


def states(path):
    return {row["role"]: row["state"] for row in deliveries(path) if row["kind"] != "alert"}


def phases(path):
    return query(path, "SELECT token, started_at, comment_started_at, sealed"
                       " FROM notification_phases WHERE dynamic_id = ? ORDER BY started_at",
                 (DYNAMIC,))


def monitor(path, body):
    with archive_client(path) as api:
        response = api.patch(f"{BASE}/{UID}/monitor", json=body)
        assert response.status_code == 200


def test_stopped_phase_queue_delivers_after_process_restart_and_is_never_resent(tmp_path):
    """停用后已入队消息仍由真实进程投递；进程重启不重发、不改阶段与归档检查点。"""
    path = tmp_path / "monitor.sqlite"
    source = arm(path, [root_comment("860001", text="停用前入队的虚构评论")])
    archive(path, source)
    checkpoint = Store(path).read_archive(DYNAMIC)
    config_path = write_config(tmp_path / "notifications.json")
    with FeishuStub() as stub:
        write_config(config_path, up=stub.url_for("up07"), full=stub.url_for("all07"))
        # 真实管理入口停用 UP：阶段封存，但队列属于业务记录，不随监控配置级联。
        monitor(path, STOPPED)
        sealed = phases(path)
        assert [row["sealed"] for row in sealed] == [1]
        with NotifierProcess(tmp_path, path, config_path) as notifier:
            wait_for(lambda: states(path) == {"up": "sent", "all": "sent"}, notifier,
                     description="停用后已入队消息仍投递")
        assert (stub.count("up07"), stub.count("all07")) == (1, 1)

        # 普通进程重启：队列已空、成功目标不重发，阶段与起点不重建。
        with NotifierProcess(tmp_path, path, config_path) as restarted:
            time.sleep(2.5)
            assert (stub.count("up07"), stub.count("all07")) == (1, 1)
            assert "delivery_sent" not in restarted.text
        assert phases(path) == sealed
    assert Store(path).read_archive(DYNAMIC) == checkpoint
    assert len([row for row in events(path) if row["kind"] == "root_comment"]) == 1


def test_restart_is_not_reentry_and_real_reentry_only_notifies_content_after_the_new_start(tmp_path):
    """重启保留原起点；真实重新启用才建立新阶段，且只通知新起点之后的评论。"""
    path = tmp_path / "monitor.sqlite"
    source = arm(path, [root_comment("860101", text="启用后、停用前的新评论")])
    archive(path, source)
    config_path = write_config(tmp_path / "notifications.json")
    with FeishuStub() as stub:
        write_config(config_path, up=stub.url_for("up07b"), full=stub.url_for("all07b"))
        with NotifierProcess(tmp_path, path, config_path) as notifier:
            wait_for(lambda: states(path) == {"up": "sent", "all": "sent"}, notifier)
        first = phases(path)
        assert len(first) == 1 and first[0]["sealed"] == 0
        start1 = math.floor(first[0]["started_at"])

        # 通知进程重启：不是重新启用，起点/基线/阶段都不变。
        with NotifierProcess(tmp_path, path, config_path) as restarted:
            time.sleep(2.5)
            assert phases(path) == first
            assert (stub.count("up07b"), stub.count("all07b")) == (1, 1)

        # 真实停用在途期间出现的新评论不被采集；随后真实重新启用建立新阶段。
        monitor(path, STOPPED)
        assert [row["sealed"] for row in phases(path)] == [1]
        while time.time() < start1 + 1.05:
            time.sleep(0.02)
        monitor(path, STARTED)
        new_start = math.floor(started_at(path))
        assert new_start > start1
        source.add(DYNAMIC, [
            root_comment("860102", ctime=start1, text="暂停期间发表的评论"),
            root_comment("860103", ctime=new_start + 60, text="新阶段之后发表的新评论"),
        ])
        archive(path, source)
        # 暂停期间的评论已归档但静默；只有新起点之后的评论生成事件。
        assert set(root_documents(path)) == {"860101", "860102", "860103"}
        assert [row["comment_id"] for row in events(path) if row["kind"] == "root_comment"] == [
            "860101", "860103"]
        with NotifierProcess(tmp_path, path, config_path) as after_reentry:
            wait_for(lambda: "860103" in str(stub.payloads("up07b")), after_reentry,
                     description="新阶段评论投递")
        assert "860102" not in str(stub.payloads("up07b"))
        assert (stub.count("up07b"), stub.count("all07b")) == (2, 2)
        rows = phases(path)
        assert [row["sealed"] for row in rows] == [1, 0]
        assert rows[1]["token"] != rows[0]["token"]
        assert rows[1]["started_at"] > rows[0]["started_at"]
