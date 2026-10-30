"""05：飞书通知同群严格按评论时间保序。

投递进程装配边界：真实 SQLite + 真实发件箱与投递循环 + 替身飞书传输 + 受控时钟。
只替换外部 HTTP 与时间来源；领取、排序、顺延、退避、放弃与告警全部走生产代码。
身份、动态、评论与凭据均为虚构值，不访问真实上游与真实群。
"""

import asyncio
import json
import logging
import sqlite3
from contextlib import contextmanager

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.notifications import Dispatcher, outbox
from backend.bili_monitor.storage import Store
from backend.bili_monitor.transaction import write
from backend.tests.collector_support import configured
from backend.tests.management_support import UID
from backend.tests.notification_support import (
    ALL_WEBHOOK, WEBHOOK, BeijingClock, Clock, Source as VersionSource, config, events, query,
    message_text,
)
from backend.tests.root_notification_support import (
    DYNAMIC, FUTURE_CTIME, Source as CommentSource, comment_id, configure, reply_item,
    reply_locate, root_comment,
)

ROOT = "870001"
SYSTEM_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/fake-system-order"


# --- 装配 -------------------------------------------------------------------

@contextmanager
def notifier_logs():
    """捕获通知进程的实际输出：生产只有一个 stderr handler，这里另挂一个观察者。"""
    messages = []

    class Handler(logging.Handler):
        def emit(self, record):
            messages.append(record.getMessage())

    logger = logging.getLogger("bili_monitor.notifier")
    handler = Handler()
    logger.addHandler(handler)
    try:
        yield messages
    finally:
        logger.removeHandler(handler)

def feishu(clock, calls, responder=None):
    """替身飞书传输：按实际发送顺序记录目的地、发送时刻与载荷，默认回业务成功。"""
    def transport(request):
        calls.append({"url": str(request.url), "at": clock.now(),
                      "payload": json.loads(request.content)})
        if responder is not None:
            return responder(request)
        return httpx.Response(200, json={"code": 0, "msg": "success"})
    return transport


def dispatcher(path, clock, transport, **sections):
    sections.setdefault("full", ALL_WEBHOOK)
    sections.setdefault("system", SYSTEM_WEBHOOK)
    return Dispatcher(Store(path), config(**sections), transport=httpx.MockTransport(transport),
                      clock=clock)


def run_once(path, clock, transport, **sections):
    async def scenario():
        notifier = dispatcher(path, clock, transport, **sections)
        try:
            return await notifier.run_once()
        finally:
            await notifier.aclose()
    return asyncio.run(scenario())


def tick(path, clock, transport, **sections):
    async def scenario():
        notifier = dispatcher(path, clock, transport, **sections)
        try:
            return await notifier.tick()
        finally:
            await notifier.aclose()
    return asyncio.run(scenario())


def archive_comments(path, roots, *, replies=()):
    """真实采集/归档入口：一级评论与楼中楼都只走生产代码。"""
    source = CommentSource().add(DYNAMIC, list(roots))
    if replies:
        source.replies(DYNAMIC, ROOT, list(replies))
    configure(path, source)

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()

    asyncio.run(scenario())
    return source


def archive_dynamic_changes(path, versions, *, title=None):
    """真实采集/归档入口产生的正文变化事件（只进 UP 群）。"""
    source = VersionSource("v1")

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            for edited in versions:
                source.page, source.title, source.edited = "v2", title, edited
                await collector.check_once(UID, DYNAMIC)
                await collector.execute_pending()

    asyncio.run(scenario())
    return source


def register_alert(path, now, object_key):
    """按生产调用形状登记一条系统告警（系统群的入队入口）。"""
    with write(Store(path)) as connection:
        assert outbox.record_alert(connection, outbox.Alert("collector", object_key,
                                                           "fictional_failure"), now)


def deliveries(path):
    rows = query(path, """SELECT d.*, e.kind, e.dynamic_id, e.snapshot, e.sort_at
        FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
        ORDER BY d.id""")
    for row in rows:
        row["snapshot"] = json.loads(row["snapshot"])
    return {row["id"]: row for row in rows}


def replies_sent(calls):
    """实际发出的楼中楼回复身份，按发送顺序。"""
    return [reply_locate(call["payload"])[1] for call in calls if reply_locate(call["payload"])]


# --- NO-01 排序键生效 --------------------------------------------------------

def test_no01_replies_are_sent_in_published_order_even_when_archived_newest_first(tmp_path):
    """末页倒序读入（较新先入库）时，实际发送顺序仍按发表时间从早到晚。"""
    path = tmp_path / "monitor.sqlite"
    archive_comments(
        path,
        [root_comment(ROOT, author="303", nickname="虚构路人", ctime=FUTURE_CTIME - 600,
                      text="虚构根评论")],
        replies=[reply_item("970003", root=ROOT, author="303", ctime=FUTURE_CTIME + 300, text="第三句"),
                 reply_item("970002", root=ROOT, author="303", ctime=FUTURE_CTIME + 200, text="第二句"),
                 reply_item("970001", root=ROOT, author="303", ctime=FUTURE_CTIME + 100, text="第一句")])
    # 入库顺序确实是“较新先”：事件 id 顺序与发表顺序相反。
    archived = [row for row in events(path) if row["kind"] == "reply_comment"]
    assert [row["comment_id"] for row in archived] == ["970003", "970002", "970001"]
    # 入队时记录可比较的排序时刻：评论类取发表时间。
    assert [row["sort_at"] for row in archived] == [
        FUTURE_CTIME + 300, FUTURE_CTIME + 200, FUTURE_CTIME + 100]

    clock = Clock(now=FUTURE_CTIME + 3600)
    calls = []
    run_once(path, clock, feishu(clock, calls))

    assert replies_sent(calls) == ["970001", "970002", "970003"]
    assert {call["url"] for call in calls} == {ALL_WEBHOOK}


# --- NO-02 同群严格排队 ------------------------------------------------------

def always_reject(request):
    """UP 群持续拒绝，其余目的地正常：用于观察同群阻塞与跨群隔离。"""
    if str(request.url) == WEBHOOK:
        return httpx.Response(500, json={"code": -1})
    return httpx.Response(200, json={"code": 0, "msg": "success"})


def uptown(calls):
    return [call for call in calls if call["url"] == WEBHOOK]


def all_room(calls):
    return [call for call in calls if call["url"] == ALL_WEBHOOK]


def test_no02_group_head_in_backoff_blocks_its_own_group_only(tmp_path):
    """队头退避时同群后续一条都不发；全员群与系统群照常推进。"""
    path = tmp_path / "monitor.sqlite"
    archive_comments(path, [
        root_comment("860001", author="303", nickname="虚构路人", ctime=FUTURE_CTIME + 100,
                     text="第一句"),
        root_comment("860002", author="303", nickname="虚构路人", ctime=FUTURE_CTIME + 200,
                     text="第二句")])
    archive_dynamic_changes(path, ["13:02", "13:03"])
    clock = Clock(now=FUTURE_CTIME + 3600)
    register_alert(path, clock.now(), "collector:first")
    calls = []
    transport = feishu(clock, calls, always_reject)

    run_once(path, clock, transport)
    # UP 群：只有队头被尝试过一次，其余同群消息一条都没动。
    up = [row for row in deliveries(path).values() if row["role"] == "up"]
    head, rest = up[0], up[1:]
    assert (head["state"], head["failures"], head["due_at"]) == ("pending", 1, clock.now() + 2.0)
    assert [(row["state"], row["attempts"]) for row in rest] == [("pending", 0)] * len(rest)
    assert len(uptown(calls)) == 1
    # 另外两个群在同一拍就完成了：一个群卡住不影响其他群。
    assert [(row["role"], row["state"]) for row in deliveries(path).values()
            if row["role"] != "up"] == [("all", "sent"), ("all", "sent"), ("system", "sent")]

    # 退避期间同群仍一条都不发，但系统群继续推进。
    register_alert(path, clock.now(), "collector:second")
    clock.advance(1.0)
    run_once(path, clock, transport)
    assert len(uptown(calls)) == 1
    assert [row["state"] for row in deliveries(path).values() if row["role"] == "system"] == ["sent", "sent"]

    # 退避到期只重试队头本身：同群后续依然排队。
    clock.advance(1.0)
    run_once(path, clock, transport)
    assert len(uptown(calls)) == 2
    up = [row for row in deliveries(path).values() if row["role"] == "up"]
    assert (up[0]["state"], up[0]["failures"], up[0]["due_at"]) == ("pending", 2, clock.now() + 4.0)
    assert all(row["attempts"] == 0 for row in up[1:])


# --- NO-03 限速顺延不插队 ----------------------------------------------------

def test_no03_rate_limited_head_is_deferred_without_letting_the_queue_jump_ahead(tmp_path):
    """触发主动限速时被顺延的仍是该群队头，同群后续消息一条都不被领取。"""
    path = tmp_path / "monitor.sqlite"
    archive_comments(path, [
        root_comment(f"86000{index}", author="303", nickname="虚构路人",
                     ctime=FUTURE_CTIME + index * 10, text=f"第 {index} 句")
        for index in range(1, 9)])
    clock = Clock(now=FUTURE_CTIME + 3600)
    calls = []
    transport = feishu(clock, calls)

    run_once(path, clock, transport)
    # 5 次/秒额度用尽：第 6 条（仍是队头顺序里的下一条）被顺延，其余保持原样。
    assert [comment_id(call["payload"]) for call in calls] == [
        "860001", "860002", "860003", "860004", "860005"]
    pending = {row["snapshot"]["comment_id"]: row for row in deliveries(path).values()
               if row["state"] == "pending"}
    assert sorted(pending) == ["860006", "860007", "860008"]
    deferred = pending["860006"]
    assert deferred["due_at"] == clock.now() + 1.0
    assert (deferred["attempts"], deferred["failures"], deferred["error"], deferred["token"]) == (
        0, 0, None, None)
    for comment in ("860007", "860008"):
        assert (pending[comment]["due_at"], pending[comment]["attempts"]) == (0.0, 0)

    # 顺延未到期时同一拍内再跑一轮也不发：被顺延的队头仍然堵住这个群。
    run_once(path, clock, transport)
    assert len(calls) == 5

    # 顺延到期后按原顺序继续，不把被顺延的那条甩到最后。
    clock.advance(1.0)
    run_once(path, clock, transport)
    assert [comment_id(call["payload"]) for call in calls] == [
        "860001", "860002", "860003", "860004", "860005",
        "860006", "860007", "860008"]
    assert [row["state"] for row in deliveries(path).values()] == ["sent"] * 8
    assert [row["attempts"] for row in deliveries(path).values()] == [1] * 8


# --- NO-04 退避与放弃 -------------------------------------------------------

def alert_events(path):
    rows = query(path, """SELECT a.category, a.object, e.snapshot FROM notification_alerts a
        JOIN notification_events e ON e.id = a.event_id ORDER BY e.id""")
    for row in rows:
        row["snapshot"] = json.loads(row["snapshot"])
    return rows


def test_no04_real_failures_back_off_two_four_eight_then_abandon_the_head(tmp_path):
    """退避步长仍是 2、4、8 秒；真实失败最多重试三次，仍失败就放弃并推进队头。"""
    path = tmp_path / "monitor.sqlite"
    configured(path)
    archive_dynamic_changes(path, ["13:02", "13:03"])
    clock = Clock(now=FUTURE_CTIME + 3600)
    calls = []
    transport = feishu(clock, calls, always_reject)

    run_once(path, clock, transport)
    assert [call["at"] for call in uptown(calls)] == [clock.now()]
    head = deliveries(path)[1]
    assert (head["state"], head["failures"], head["due_at"]) == ("pending", 1, clock.now() + 2.0)

    clock.advance(2.0)
    run_once(path, clock, transport)
    head = deliveries(path)[1]
    assert (head["failures"], head["due_at"]) == (2, clock.now() + 4.0)

    clock.advance(4.0)
    run_once(path, clock, transport)
    head = deliveries(path)[1]
    assert (head["failures"], head["due_at"]) == (3, clock.now() + 8.0)

    clock.advance(8.0)
    run_once(path, clock, transport)
    # 四次尝试都失败：进入既有终态「已过期」，错误原因可辨，登记既有类别告警。
    assert [call["at"] for call in uptown(calls)[:4]] == [
        FUTURE_CTIME + 3600, FUTURE_CTIME + 3602, FUTURE_CTIME + 3606, FUTURE_CTIME + 3614]
    head = deliveries(path)[1]
    assert (head["state"], head["failures"], head["attempts"]) == ("expired", 4, 4)
    assert head["error"] == "retry_exhausted"
    assert head["sent_at"] is None
    assert [(row["category"], row["object"], row["snapshot"]["reason"]) for row in alert_events(path)] == [
        ("delivery", "up:dynamic_changed", "retry_exhausted")]
    # 队头推进到下一条：同群第二条在同一个节拍里就被尝试，不再永久占住队头。
    second = deliveries(path)[2]
    assert (second["state"], second["attempts"], second["failures"]) == ("pending", 1, 1)


# --- NO-05 平台限流不消耗重试额度 --------------------------------------------

def test_no05_platform_rate_limits_defer_without_consuming_the_retry_budget(tmp_path):
    """HTTP 429 与业务限流码都按平台给出的等待时间顺延，不计入那三次重试。"""
    path = tmp_path / "monitor.sqlite"
    configured(path)
    archive_dynamic_changes(path, ["13:02"])
    clock = Clock(now=FUTURE_CTIME + 3600)
    responses = [
        httpx.Response(429, headers={"x-ogw-ratelimit-reset": "3"}, json={"code": 11232}),
        httpx.Response(200, headers={"x-ogw-ratelimit-reset": "5"}, json={"code": 230020}),
        httpx.Response(429, headers={"x-ogw-ratelimit-reset": "3"}, json={"code": 11232}),
        httpx.Response(429, headers={"x-ogw-ratelimit-reset": "3"}, json={"code": 11232}),
        httpx.Response(200, json={"code": 0, "msg": "success"}),
    ]
    calls = []

    def transport(request):
        calls.append({"url": str(request.url), "at": clock.now()})
        return responses.pop(0) if responses else httpx.Response(200, json={"code": 0})

    for delay in (0.0, 3.0, 5.0, 3.0, 3.0):
        clock.advance(delay)
        run_once(path, clock, transport)
        if not responses:
            break

    row = deliveries(path)[1]
    # 5 次 HTTP 尝试（4 次限流 + 1 次成功），但真实失败次数为 0：限流不消耗那三次额度。
    assert (row["state"], row["failures"], row["attempts"]) == ("sent", 0, 5)
    assert [call["at"] for call in calls] == [
        FUTURE_CTIME + 3600, FUTURE_CTIME + 3603, FUTURE_CTIME + 3608,
        FUTURE_CTIME + 3611, FUTURE_CTIME + 3614]
    assert alert_events(path) == []  # 限流不是「发不出去」，不登记投递失败告警


# --- NO-06 配置未就绪兜底 ----------------------------------------------------

def test_no06_missing_route_rechecks_minutely_then_abandons_after_ten_minutes(tmp_path):
    """路由缺失仍按 60 秒粒度复检，但受 10 分钟驻留上限约束，超过就放弃并推进队头。"""
    path = tmp_path / "monitor.sqlite"
    archive_comments(path, [
        root_comment("860001", author="303", nickname="虚构路人", ctime=FUTURE_CTIME + 100,
                     text="第一句"),
        root_comment("860002", author="303", nickname="虚构路人", ctime=FUTURE_CTIME + 200,
                     text="第二句")])
    clock = Clock(now=FUTURE_CTIME + 3600)
    calls = []
    transport = feishu(clock, calls)

    run_once(path, clock, transport, full=None)
    head = deliveries(path)[1]
    assert (head["state"], head["error"], head["attempts"], head["failures"]) == (
        "waiting_config", "route_missing", 1, 0)
    assert head["due_at"] == clock.now() + 60.0
    assert deliveries(path)[2]["attempts"] == 0  # 队头没出结果，同群后续不领
    assert all_room(calls) == []  # 配置未就绪不发无效 HTTP

    # 每 60 秒复检一次，等待配置的复检不算投递失败。
    for minute in range(1, 10):  # 到第 9 分钟为止仍然只是复检
        clock.advance(60.0)
        run_once(path, clock, transport, full=None)
        head = deliveries(path)[1]
        assert (head["state"], head["attempts"], head["failures"]) == (
            "waiting_config", minute + 1, 0)
    assert clock.now() == FUTURE_CTIME + 3600 + 540.0

    # 第 10 分钟：驻留上限到了，同一条放弃路径收尾。
    clock.advance(60.0)
    run_once(path, clock, transport, full=None)
    head = deliveries(path)[1]
    assert (head["state"], head["error"]) == ("expired", "config_timeout")
    assert head["sent_at"] is None
    assert [(row["category"], row["object"], row["snapshot"]["reason"]) for row in alert_events(path)] == [
        ("route", f"all:{UID}:{DYNAMIC}", "route_missing"),
        ("delivery", "all:root_comment", "config_timeout")]
    # 队头推进：第二条重新开始自己的 10 分钟驻留，而不是继承前一条的计时。
    second = deliveries(path)[2]
    assert (second["state"], second["error"], second["attempts"]) == (
        "waiting_config", "route_missing", 1)
    assert all_room(calls) == []


# --- NO-07 公告类有确定位置 --------------------------------------------------

def kinds(calls, *, url=SYSTEM_WEBHOOK):
    """系统群实际收到的消息类型，按发送顺序。"""
    return [message_text(call["payload"]).splitlines()[0].split("【")[0]
            for call in calls if call["url"] == url]


def test_no07_alerts_and_heartbeats_take_their_enqueue_position_in_the_system_group(tmp_path):
    """告警与心跳按入队时刻参与排序：不排到最前，也不排到最后。"""
    path = tmp_path / "monitor.sqlite"
    configured(path)
    clock = BeijingClock.start(13, 39, 30)
    calls = []
    transport = feishu(clock, calls)

    register_alert(path, clock.now(), "collector:before-heartbeat")
    tick(path, clock, transport)  # 13:39:30：告警先发；此时还没有本小时的心跳
    assert kinds(calls) == ["告警"]

    clock.at(13, 40, 0)
    tick(path, clock, transport)  # 13:40:00：心跳按入队时刻排在告警之后
    register_alert(path, clock.now(), "collector:after-heartbeat")
    tick(path, clock, transport)  # 之后的告警排在心跳之后
    assert kinds(calls) == ["告警", "心跳", "告警"]
    # 心跳的入队时刻就是时段开始，排序键与条目类型无关。
    heartbeat = next(row for row in deliveries(path).values() if row["kind"] == "heartbeat")
    alert = next(row for row in deliveries(path).values() if row["kind"] == "alert")
    assert heartbeat["sort_at"] == clock.now()
    assert alert["sort_at"] < heartbeat["sort_at"]


def test_no07_heartbeat_expiry_still_drops_it_ahead_of_the_rest_of_the_group(tmp_path):
    """心跳原有有效期仍是额外约束：过期的心跳不发、不占住队头。"""
    path = tmp_path / "monitor.sqlite"
    configured(path)
    clock = BeijingClock.start(13, 40, 0)
    calls = []
    transport = feishu(clock, calls, lambda request: httpx.Response(500, json={"code": -1}))

    register_alert(path, clock.now(), "collector:blocking-head")
    tick(path, clock, transport)  # 告警失败退避，心跳排在它后面
    heartbeat = next(row for row in deliveries(path).values() if row["kind"] == "heartbeat")
    assert heartbeat["state"] == "pending" and heartbeat["expires_at"] is not None
    assert "心跳" not in kinds(calls)  # 一直被队头挡住，还没发出去

    clock.advance(3601.0)  # 越过本时段有效期
    tick(path, clock, transport)
    heartbeat = next(row for row in deliveries(path).values() if row["kind"] == "heartbeat")
    assert (heartbeat["state"], heartbeat["error"]) == ("expired", "expired")
    assert "心跳" not in kinds(calls)  # 过期内容不发


# --- NO-08 类型一致 ---------------------------------------------------------

def single_message(path, kind, clock, transport):
    """按类型造出唯一一条待发消息；返回它在投递表里的角色。"""
    if kind == "root_comment":
        archive_comments(path, [root_comment("860001", author="303", nickname="虚构路人",
                                            text="虚构评论")])
        return "all"
    configured(path)
    if kind == "dynamic_changed":
        archive_dynamic_changes(path, ["13:02"])
        return "up"
    if kind == "alert":
        register_alert(path, clock.now(), "collector:consistent")
        return "system"
    # 心跳由投递进程自己在第 40 分钟登记，与生产路径一致。
    clock.at(13, 40, 0)
    tick(path, clock, transport)
    return "system"


@pytest.mark.parametrize("kind", ["root_comment", "dynamic_changed", "alert", "heartbeat"])
def test_no08_every_message_kind_follows_the_same_retry_and_abandon_rule(tmp_path, kind):
    """评论、正文变化、系统告警与心跳在同样的失败序列下表现一致，不按类型或角色区分。"""
    path = tmp_path / "monitor.sqlite"
    clock = BeijingClock.start(13, 0, 0)
    calls = []
    transport = feishu(clock, calls, lambda request: httpx.Response(500, json={"code": -1}))
    role = single_message(path, kind, clock, transport)
    started = clock.now()
    if kind != "heartbeat":  # 心跳的首次尝试由生成它的那一拍完成
        run_once(path, clock, transport)

    with notifier_logs() as logs:
        for delay in (2.0, 4.0, 8.0):
            clock.advance(delay)
            run_once(path, clock, transport)

    row = next(row for row in deliveries(path).values() if row["kind"] == kind)
    url = {"all": ALL_WEBHOOK, "up": WEBHOOK, "system": SYSTEM_WEBHOOK}[role]
    assert [call["at"] - started for call in calls if call["url"] == url] == [0.0, 2.0, 6.0, 14.0]
    assert (row["state"], row["error"], row["failures"], row["attempts"]) == (
        "expired", "retry_exhausted", 4, 4)
    # 放弃留痕对所有类型一致：终态行内原因可辨，并留一条 WARNING 日志。
    assert row["error"] == "retry_exhausted"
    assert any("delivery_abandoned" in line and f"role={role}" in line
               and "reason=retry_exhausted" in line for line in logs)
    # 放弃告警登记：业务目标登记既有类别告警；系统目标自身不再递归生成告警。
    abandoned = [item for item in alert_events(path) if item["snapshot"]["reason"] == "retry_exhausted"]
    assert len(abandoned) == (0 if role == "system" else 1)


# --- NO-09 旧库迁移 ---------------------------------------------------------

def version(path):
    with sqlite3.connect(path) as connection:
        return connection.execute("PRAGMA user_version").fetchone()[0]


def test_no09_old_database_gets_sort_keys_and_an_empty_key_is_not_first_or_last(tmp_path):
    """旧库升级后按入队时刻补齐排序键；空键按入队时刻排序，不当成最早或最晚。"""
    path = tmp_path / "monitor.sqlite"
    archive_comments(path, [
        root_comment("860001", author="303", nickname="虚构路人", text="第一句"),
        root_comment("860002", author="303", nickname="虚构路人", text="第二句"),
        root_comment("860003", author="303", nickname="虚构路人", text="第三句")])
    # 退回旧形态：没有排序列与驻留起点的 v28。
    with sqlite3.connect(path) as connection:
        connection.execute("ALTER TABLE notification_events DROP COLUMN sort_at")
        connection.execute("ALTER TABLE notification_deliveries DROP COLUMN waiting_since")
        connection.execute("PRAGMA user_version = 28")
    assert version(path) == 28

    Store(path).migrate()
    assert version(path) == 29
    # 旧行按入队时刻补齐，不插队也不落到末尾。
    rows = query(path, "SELECT id, created_at, sort_at FROM notification_events ORDER BY id")
    assert [row["sort_at"] for row in rows] == [row["created_at"] for row in rows]

    # 空排序键不是最早也不是最晚：中间那条置空后仍按入队时刻停在中间。
    with sqlite3.connect(path) as connection:
        connection.execute("UPDATE notification_events SET sort_at = NULL WHERE id = ?", (rows[1]["id"],))
    clock = Clock(now=FUTURE_CTIME + 3600)
    calls = []
    run_once(path, clock, feishu(clock, calls))
    assert [comment_id(call["payload"]) for call in calls] == ["860001", "860002", "860003"]


# --- NO-10 串行不降低吞吐 ---------------------------------------------------

def test_no10_per_group_serialization_keeps_the_rate_limit_as_the_bottleneck(tmp_path):
    """限速受限的积压场景里，每群串行的实际发送速率不下降：瓶颈仍是限速而不是轮询。"""
    path = tmp_path / "monitor.sqlite"
    archive_comments(path, [
        root_comment(f"8600{index:02d}", author="303", nickname="虚构路人",
                     ctime=FUTURE_CTIME + index * 10, text=f"第 {index} 句")
        for index in range(1, 13)])
    clock = Clock(now=FUTURE_CTIME + 3600)
    calls = []
    transport = feishu(clock, calls)

    for _ in range(3):  # 三个 1 秒的轮询节拍
        run_once(path, clock, transport)
        clock.advance(1.0)

    assert len(calls) == 12
    elapsed = calls[-1]["at"] - calls[0]["at"]
    assert elapsed <= 2.0  # 1 条/秒的退化实现需要 11 秒
    assert len(calls) / max(elapsed, 1.0) >= 4.0
    assert [row["state"] for row in deliveries(path).values()] == ["sent"] * 12
    assert [comment_id(call["payload"]) for call in calls] == [
        f"8600{index:02d}" for index in range(1, 13)]
