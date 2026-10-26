"""06：真实进程终止/恢复、跨进程慢请求与写锁、路由修复后的补发。

通知进程使用生产入口与真实锁；飞书由本机受控 HTTP 服务充当（不是进程内
MockTransport），数据库是临时 SQLite。事件由真实归档链产生，全部身份、正文与
凭据都是虚构值；不读取真实配置，也不访问真实飞书或 B 站。
"""

import asyncio
import json
import sqlite3
import time

import httpx

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from backend.tests.management_support import UID
from backend.tests.notification_process_support import (
    FeishuStub, NotifierProcess, archive_change, business_deliveries, business_events, run_python, wait_for,
)
from backend.tests.notification_support import DYNAMIC, config_mapping, query, write_config
from backend.tests.root_notification_support import Source, configure, root_comment

# 另一路进程的真实数据库写：BEGIN IMMEDIATE 成功与否直接说明通知进程是否占着写锁。
# 只有真的等不到锁才会失败（等到 busy 预算耗尽 → OperationalError）；不把「写得多快」
# 当断言，避免负载下的墙钟假失败。
WRITE_BUSY_SECONDS = 3.0
WRITE_SCRIPT = f"""
import sqlite3, sys, time
start = time.monotonic()
connection = sqlite3.connect(sys.argv[1], timeout={WRITE_BUSY_SECONDS})
connection.execute("BEGIN IMMEDIATE")
connection.execute("UPDATE monitors SET recent_n = recent_n")
connection.commit()
connection.close()
print(f"{{time.monotonic() - start:.3f}}")
"""
# 强杀后观察租约用的时长：与进程默认租约一致，保证「仍在未来」不是毫秒级竞态。
LEASE_SECONDS = 30


def archive_up_comment(path):
    """真实归档链产生一条 UP 本人一级评论：up 与 all 两个待投递目标。"""
    source = Source().add(DYNAMIC, [root_comment("860001", text="虚构评论")])
    configure(path, source)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()

    asyncio.run(run())
    assert sorted(row["role"] for row in business_deliveries(path)) == ["all", "up"]


def states(path):
    """业务投递的逐角色状态；系统心跳是独立合法事件，不算业务结果（见 business_deliveries）。"""
    return {row["role"]: row["state"] for row in business_deliveries(path)}


def test_slow_feishu_request_never_holds_the_write_lock_for_another_process(tmp_path):
    """飞书请求阻塞期间，另一路真实进程的数据库提交仍能完成；回写不在网络期间发生。"""
    path = tmp_path / "monitor.sqlite"
    archive_change(path)
    config_path = write_config(tmp_path / "notifications.json")
    checkpoint = Store(path).read_archive(DYNAMIC)
    with FeishuStub() as stub:
        stub.block("fake-up")
        write_config(config_path, up=stub.url_for("fake-up"))
        with NotifierProcess(tmp_path, path, config_path) as notifier:
            wait_for(lambda: stub.entered("fake-up").is_set(), notifier,
                     description="飞书请求已发出并处于阻塞中")
            # 网络等待期间：领取事务已提交，记录为 inflight，没有任何写事务被占住。
            assert states(path) == {"up": "inflight"}
            result = run_python(["-c", WRITE_SCRIPT, str(path)])
            # 写锁若被网络等待占住，这次写会耗光 busy 预算并失败；成功即证明锁是自由的。
            assert result.returncode == 0, result.stderr
            # 写完成时请求仍在阻塞中：回写没有在网络期间发生。
            assert states(path) == {"up": "inflight"}
            assert business_deliveries(path)[0]["attempts"] == 0
            stub.release("fake-up")
            wait_for(lambda: states(path) == {"up": "sent"}, notifier)
        assert len(stub.payloads("fake-up")) == 1
    # 失败/成功都不改动归档检查点与消息快照。
    assert Store(path).read_archive(DYNAMIC) == checkpoint
    assert business_deliveries(path)[0]["snapshot"] == {"dynamic_id": DYNAMIC, "title": None}


def test_killed_process_recovers_lease_and_keeps_the_successful_target(tmp_path):
    """真实 SIGKILL 后重启：租约过期被恢复并只重投未完成目标，已成功目标保持成功。"""
    path = tmp_path / "monitor.sqlite"
    archive_up_comment(path)
    checkpoint = Store(path).read_archive(DYNAMIC)
    config_path = write_config(tmp_path / "notifications.json")
    with FeishuStub() as stub:
        stub.block("fake-all")
        write_config(config_path, up=stub.url_for("fake-up"), full=stub.url_for("fake-all"))
        started = time.time()
        with NotifierProcess(tmp_path, path, config_path,
                             BILI_NOTIFIER_LEASE_SECONDS=LEASE_SECONDS) as notifier:
            wait_for(lambda: states(path) == {"up": "sent", "all": "inflight"}, notifier,
                     description="UP 群已成功、全员群仍阻塞")
            wait_for(lambda: stub.entered("fake-all").is_set(), notifier)
            # 真实强杀：不会回写 in-flight 记录，租约由 expiration 自行恢复。
            notifier.kill()
        killed = {row["role"]: row for row in business_deliveries(path)}
        clock_now = time.time()
        assert (killed["up"]["state"], killed["up"]["attempts"]) == ("sent", 1)
        assert killed["all"]["state"] == "inflight"
        assert killed["all"]["token"] is not None
        # 租约 = 领取时刻 + 配置时长：仍在未来（所以恢复只能来自过期），且不超过配置值。
        # 30 秒预算让这两条在负载下也是结构断言，而不是毫秒级墙钟竞态。
        assert clock_now < killed["all"]["lease_until"] <= clock_now + LEASE_SECONDS

        # 放行接收端：被杀的那次连接已断，重启后的重新领取会再发一次。
        # 不真等 30 秒：只把这条租约推到过去（相当于时间流逝），其余记录不动。
        stub.release("fake-all")
        with sqlite3.connect(path) as connection:
            connection.execute("UPDATE notification_deliveries SET lease_until = ? WHERE role = ?",
                               (started, "all"))
        with NotifierProcess(tmp_path, path, config_path) as restarted:
            wait_for(lambda: states(path) == {"up": "sent", "all": "sent"}, restarted,
                     description="租约过期后恢复投递")
        # 已成功目标不重发；被杀时的那次请求已被接收端收到，重投意味着外部可能重复。
        assert stub.count("fake-up") == 1
        assert stub.count("fake-all") == 2
        rows = {row["role"]: row for row in business_deliveries(path)}
        assert (rows["up"]["attempts"], rows["up"]["sent_at"]) == (1, rows["up"]["sent_at"])
        # attempts 只统计已完成的回写（被杀那次没有回写）；租约恢复本身不算投递失败。
        assert (rows["all"]["attempts"], rows["all"]["failures"]) == (1, 0)
        assert rows["all"]["token"] is None and rows["all"]["lease_until"] is None
        # 迟到结果不会覆盖新领取：最终状态由重启后的领取回写。
        assert rows["all"]["sent_at"] is not None
    assert len(business_events(path)) == 1
    assert Store(path).read_archive(DYNAMIC) == checkpoint
    assert {row["snapshot"]["comment_id"] for row in business_deliveries(path)} == {"860001"}


def test_wrong_destination_waits_then_repair_after_restart_only_sends_that_target(tmp_path):
    """单目标路由写错时进程照常运行并保留待发；修复＝改文件后重启，只补发该目标。"""
    path = tmp_path / "monitor.sqlite"
    archive_up_comment(path)
    started = query(path, "SELECT token, comment_started_at FROM notification_phases")
    checkpoint = Store(path).read_archive(DYNAMIC)
    config_path = tmp_path / "notifications.json"
    with FeishuStub() as stub:
        broken = config_mapping(up=stub.url_for("fake-up"), full=stub.url_for("fake-all"))
        broken["destinations"]["all-room"] = {"webhook": "not-a-webhook"}
        config_path.write_text(json.dumps(broken, ensure_ascii=False))
        with NotifierProcess(tmp_path, path, config_path) as notifier:
            wait_for(lambda: states(path) == {"up": "sent", "all": "waiting_config"}, notifier)
            wait_for(lambda: stub.count("fake-up") == 1, notifier)
            first_log = notifier.text
            assert stub.count("fake-all") == 0  # 不每秒对错误路由发无效 HTTP
        rows = {row["role"]: row for row in business_deliveries(path)}
        assert (rows["all"]["state"], rows["all"]["error"]) == ("waiting_config", "route_invalid")

        write_config(config_path, up=stub.url_for("fake-up"), full=stub.url_for("fake-all"))
        with NotifierProcess(tmp_path, path, config_path) as repaired:
            wait_for(lambda: states(path) == {"up": "sent", "all": "sent"}, repaired)
        # 只补发失败目标，已成功目标不被重发；阶段与起点不重设，不补历史。
        assert stub.count("fake-up") == 1
        assert stub.count("fake-all") == 1
        assert query(path, "SELECT token, comment_started_at FROM notification_phases") == started
        assert len(business_events(path)) == 1
        # 进程日志只记固定分类，不含 webhook 或签名密钥。
        assert "delivery_waiting_config" in first_log
        assert "route_invalid" in first_log
        for text in (first_log, repaired.text):
            assert "fake-up" not in text and "fake-all" not in text and "open-apis" not in text
    assert Store(path).read_archive(DYNAMIC) == checkpoint
