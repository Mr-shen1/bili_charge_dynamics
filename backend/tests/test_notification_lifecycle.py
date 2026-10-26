"""07：停用、移出、删除、模式切换与在途通知的生命周期矩阵。

真实管理/发现/归档入口 → 临时 SQLite → 受控来源与飞书接收端；只替换 B 站/飞书
HTTP 传输与外部时间。门闩（asyncio.Event）精确安排“已领取 → 管理操作 → 迟到提交”
的顺序，不直接改测试数据库绕开生命周期。身份、动态、评论与凭据均为虚构值。
"""

import asyncio
import math
import time

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client
from backend.tests.management_support import BASE, UID
from backend.tests.notification_support import (
    ALL_WEBHOOK, WEBHOOK, Clock, Receiver, deliveries, events, query,
)
from backend.tests.notification_support import Source as BodySource
from backend.tests.root_notification_support import (
    DYNAMIC, comment_id, dispatcher, page_html, reply_documents, reply_item, root_comment,
    root_documents, started_at,
)
from backend.tests.root_notification_support import Source as CommentSource
from backend.tests.test_recent_discovery import feed_response

OTHER_DYNAMIC = "456"
FEED_PATH = "/x/polymer/web-dynamic/v1/feed/space"
BASELINE_ROOT = "880001"
OLD_REPLY = "980001"
NEW_ROOT = "880002"
NEW_REPLY = "980002"

# 五种停止原因：停用 UP、近期窗口移出、删除指定目标、删除监控配置、模式切换不再入选。
STOP_CAUSES = ("disable", "recent_window", "delete_target", "delete_monitor", "mode_switch")
EVENT_TYPES = ("body", "root", "reply")

BLOCKED = {
    "body": lambda path: path.startswith("/opus/"),
    "root": lambda path: path == "/x/v2/reply",
    "reply": lambda path: path == "/x/v2/reply/reply",
}


def window(*ids, uid=UID):
    payload = feed_response(uid)
    candidate = payload["data"]["items"][0]
    payload["data"]["items"] = [{**candidate, "id_str": id} for id in ids]
    payload["data"]["has_more"] = False
    payload["data"]["offset"] = ""
    return httpx.Response(200, json=payload)


def routed(source, ids, uid=UID):
    """同一受控来源：feed 走窗口替身，其余交给归档/评论来源。"""

    def handler(request):
        if request.url.path == FEED_PATH:
            return window(*ids, uid=uid)
        return source(request)

    return handler


async def discover_once(path, source, ids, uid=UID):
    async with httpx.AsyncClient(transport=httpx.MockTransport(routed(source, ids, uid))) as client:
        assert await Collector(Store(path), client).discover_once(uid)


def discover(path, source, ids, uid=UID):
    asyncio.run(discover_once(path, source, ids, uid))


def archive(path, source, dynamic=DYNAMIC):
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, dynamic)
            await collector.execute_pending()

    asyncio.run(scenario())


def arm(path, source, *, mode="specified", ids=(DYNAMIC,), window_ids=(DYNAMIC, OTHER_DYNAMIC)):
    with archive_client(path, source) as api:
        assert api.post(BASE, json={"uid": UID}).status_code == 201
        assert api.patch(f"{BASE}/{UID}/monitor",
                         json={"mode": mode, "recent_n": 2, "enabled": True}).status_code == 200
        if mode == "specified":
            for id in ids:
                assert api.post(f"{BASE}/{UID}/targets", json={"id": id}).status_code == 201
    if mode == "recent":
        discover(path, source, window_ids)


async def stop(path, source, cause):
    """真实管理/发现入口；不使用直接改库绕过生命周期。"""
    with archive_client(path, source) as api:
        if cause == "disable":
            response = api.patch(f"{BASE}/{UID}/monitor",
                                 json={"mode": "specified", "recent_n": 10, "enabled": False})
        elif cause == "delete_target":
            response = api.delete(f"{BASE}/{UID}/targets/{DYNAMIC}")
        elif cause == "delete_monitor":
            response = api.delete(f"{BASE}/{UID}/monitor")
        elif cause == "mode_switch":
            response = api.patch(f"{BASE}/{UID}/monitor",
                                 json={"mode": "specified", "recent_n": 10, "enabled": True})
        else:
            response = None
        if response is not None:
            assert response.status_code in (200, 204)
    if cause == "recent_window":
        await discover_once(path, source, (OTHER_DYNAMIC,))


def candidates(path):
    return query(path, "SELECT * FROM notification_candidates ORDER BY comment_id")


def phases(path, dynamic=DYNAMIC):
    return query(path, "SELECT * FROM notification_phases WHERE dynamic_id = ? ORDER BY started_at",
                 (dynamic,))


def silent_baseline(path, source, event):
    """阶段起点之后才允许通知：历史正文/评论/回复都先于起点，全部静默。"""
    before = math.floor(started_at(path)) - 600
    if event == "body":
        archive(path, source)
        assert Store(path).read_archive(DYNAMIC)["synced_version"] is not None
    else:
        roots = [root_comment(BASELINE_ROOT, author="303", nickname="虚构路人", ctime=before,
                              text="起点前的旧评论")]
        source.add(DYNAMIC, roots)
        source.replies(DYNAMIC, BASELINE_ROOT, [
            reply_item(OLD_REPLY, root=BASELINE_ROOT, author="303", nickname="虚构路人",
                       ctime=before, text="起点前的旧回复")])
        archive(path, source)
    assert events(path) == []
    assert candidates(path) == []


def stage_change(source, event):
    """按事件类型准备“起点之后”的新内容；计数变化是真实采集信号，不是绕过校验。"""
    published = math.floor(time.time()) + 60
    if event == "body":
        source.page = "v2"
        return published
    spec = source.spec(DYNAMIC)
    if event == "root":
        spec["roots"].append(root_comment(NEW_ROOT, author=UID, nickname="虚构星海",
                                          ctime=published, text="停用后迟到的一级评论"))
        spec["count"] = len(spec["roots"])
    else:
        items = list(spec["reply_threads"][BASELINE_ROOT]["items"]) + [
            reply_item(NEW_REPLY, root=BASELINE_ROOT, author=UID, nickname="虚构星海",
                       ctime=published, text="停用后迟到的楼中楼回复")]
        # 重新登记该楼完整回复集合：根页 rcount 随之变化，是真实的重新扫描信号。
        source.replies(DYNAMIC, BASELINE_ROOT, items)
        spec["count"] += 1
    return published


async def in_flight(path, source, event, *, while_blocked):
    """已领取（正文/根/回复同一条归档链）→ 门闩 → 管理操作 → 迟到提交。"""
    gate = {"enter": asyncio.Event(), "release": asyncio.Event(), "blocked": False}
    blocked = BLOCKED[event]

    async def gated(request):
        if gate["blocked"] and blocked(request.url.path):
            gate["enter"].set()
            await gate["release"].wait()
        return source(request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(gated)) as client:
        collector = Collector(Store(path), client)
        await collector.check_once(UID, DYNAMIC)
        gate["blocked"] = True
        running = asyncio.create_task(collector.execute_pending())
        await asyncio.wait_for(gate["enter"].wait(), 10)
        await while_blocked()
        gate["release"].set()
        await running


@pytest.mark.parametrize("event", EVENT_TYPES)
@pytest.mark.parametrize("cause", STOP_CAUSES)
def test_claimed_archive_commit_after_each_stop_cause_saves_content_without_new_event(tmp_path, cause, event):
    """停用/移出/删除/删配置/模式切换后，已领取的正文、根评论与回复不得生成新通知。"""
    path = tmp_path / "monitor.sqlite"
    source = BodySource("v1") if event == "body" else CommentSource()
    if event != "body":
        # 目标归属校验仍走上游受控来源，不放宽真实校验。
        source.add(DYNAMIC, [])
        source.add(OTHER_DYNAMIC, [])
    if cause in ("recent_window", "mode_switch"):
        arm(path, source, mode="recent")
    else:
        arm(path, source)
    silent_baseline(path, source, event)
    checkpoint = Store(path).read_archive(DYNAMIC)
    baseline_phase = phases(path)[0]
    stage_change(source, event)

    asyncio.run(in_flight(path, source, event, while_blocked=lambda: stop(path, source, cause)))

    # 内容按原 owner 规则照常保存（只受内容写代次约束）。
    if event == "body":
        assert Store(path).read_archive(DYNAMIC)["text"] == "第二版"
    elif event == "root":
        assert set(root_documents(path)) == {BASELINE_ROOT, NEW_ROOT}
    else:
        assert set(reply_documents(path)) == {OLD_REPLY, NEW_REPLY}
    # 失效阶段不产生任何新事件、候选或投递。
    assert events(path) == []
    assert candidates(path) == []
    assert deliveries(path) == []
    # 阶段已封存，起点、评论起点与正文基线不被迟到提交改写。
    sealed = phases(path)
    assert [row["sealed"] for row in sealed] == [1]
    assert [(row["token"], row["started_at"], row["comment_started_at"], row["baseline_version"])
            for row in sealed] == [(baseline_phase["token"], baseline_phase["started_at"],
                                    baseline_phase["comment_started_at"],
                                    baseline_phase["baseline_version"])]
    # 归档不因停止原因被删除；正文事件之外的内容不被迟到通知改写。
    retained = Store(path).read_archive(DYNAMIC)
    assert retained is not None
    assert query(path, "SELECT uid FROM archives WHERE id = ?", (DYNAMIC,))[0]["uid"] == UID
    # 分项 checkpoint 语义不变：正文成功仍写 success，评论/回复生命周期不改正文 checkpoint。
    assert retained["content_state"] == "success"
    assert retained["work"]["text"] == "success"
    if event != "body":
        assert retained["text"] == checkpoint["text"]
        assert set(root_documents(path)) >= {BASELINE_ROOT}

    receiver = Receiver()
    asyncio.run(dispatcher(path, transport=httpx.MockTransport(receiver), full=ALL_WEBHOOK).run_once())
    assert receiver.requests == []


# ---------------------------------------------------------------------------
# 已入队消息：停止/删配置后仍投递，等待配置与失败退避不随阶段结束丢失
# ---------------------------------------------------------------------------

def business_events(path):
    """业务事件（正文/评论/回复）；告警事件属于 08，不参与生命周期断言。"""
    return [row for row in events(path) if row["kind"] != "alert"]


def business_deliveries(path):
    return [row for row in deliveries(path) if row["kind"] != "alert"]


def alert_rows(path):
    return query(path, "SELECT * FROM notification_alerts ORDER BY category, object")


def up_own_comment_pending(path):
    """基线静默后登记一条 UP 本人一级评论：up 与 all 两个待投递目标。"""
    source = CommentSource()
    source.add(DYNAMIC, [])
    arm(path, source)
    silent_baseline(path, source, "root")
    stage_change(source, "root")
    archive(path, source)
    assert [(row["kind"], row["comment_id"]) for row in business_events(path)] == [
        ("root_comment", NEW_ROOT)]
    return source


def delivery_states(path):
    return {row["role"]: (row["state"], row["error"]) for row in business_deliveries(path)}


@pytest.mark.parametrize("cause", ("disable", "delete_monitor"))
def test_waiting_config_delivery_survives_stop_and_only_the_missing_target_is_repaired(tmp_path, cause):
    """缺全员群时保留待发；停止/删配置后修复路由仍只补发缺的目标，成功目标不重发。"""
    path = tmp_path / "monitor.sqlite"
    source = up_own_comment_pending(path)
    alerts_before = alert_rows(path)
    phase_before = phases(path)[0]
    clock = Clock()

    first = Receiver()
    asyncio.run(dispatcher(path, transport=httpx.MockTransport(first), clock=clock).run_once())
    assert [request["url"] for request in first.requests] == [WEBHOOK]
    assert delivery_states(path) == {"up": ("sent", None), "all": ("waiting_config", "route_missing")}
    # 08 的“路由缺失”告警事实是独立记录，不冒充业务事件。
    assert alert_rows(path) and alerts_before != alert_rows(path)
    alerts_after_failure = alert_rows(path)

    asyncio.run(stop(path, source, cause))
    assert phase_before["sealed"] == 0
    assert [row["sealed"] for row in phases(path)] == [1]
    assert alert_rows(path) == alerts_after_failure  # 生命周期变化不删除告警事实

    second = Receiver()
    notifier = dispatcher(path, transport=httpx.MockTransport(second), clock=clock, full=ALL_WEBHOOK)
    clock.advance(60.0)
    asyncio.run(notifier.run_once())

    # 只补发缺的全员群；已成功的 UP 群不重发，事件与快照仍是一条。
    assert [request["url"] for request in second.requests] == [ALL_WEBHOOK]
    assert delivery_states(path) == {"up": ("sent", None), "all": ("sent", None)}
    assert len(business_events(path)) == 1
    assert alert_rows(path) == alerts_after_failure  # 补发后告警事实仍在
    retained = Store(path).read_archive(DYNAMIC)
    assert retained is not None and retained["text"].startswith("虚构全文")


@pytest.mark.parametrize("cause", ("disable", "delete_monitor"))
def test_failed_target_backoff_keeps_retrying_after_stop_without_resending_success(tmp_path, cause):
    """失败退避中的目标在停止/删配置后继续按退避重试；已成功目标与失败事实都保留。"""
    path = tmp_path / "monitor.sqlite"
    source = up_own_comment_pending(path)
    clock = Clock()

    def failing(request):
        if str(request.url) == ALL_WEBHOOK:
            return httpx.Response(500, json={"code": -1})
        return httpx.Response(200, json={"code": 0, "msg": "success"})

    first = Receiver(responder=failing)
    asyncio.run(dispatcher(path, transport=httpx.MockTransport(first), clock=clock,
                            full=ALL_WEBHOOK).run_once())
    assert [request["url"] for request in first.requests] == [WEBHOOK, ALL_WEBHOOK]
    rows = {row["role"]: row for row in business_deliveries(path)}
    assert (rows["up"]["state"], rows["up"]["attempts"]) == ("sent", 1)
    assert (rows["all"]["state"], rows["all"]["failures"], rows["all"]["attempts"]) == ("pending", 1, 1)
    assert rows["all"]["due_at"] == clock.now() + 2.0

    asyncio.run(stop(path, source, cause))
    second = Receiver()
    notifier = dispatcher(path, transport=httpx.MockTransport(second), clock=clock, full=ALL_WEBHOOK)
    clock.advance(2.0)
    asyncio.run(notifier.run_once())
    assert [request["url"] for request in second.requests] == [ALL_WEBHOOK]
    rows = {row["role"]: row for row in business_deliveries(path)}
    assert rows["all"]["state"] == "sent" and rows["all"]["failures"] == 1  # 成功不抹掉历史失败
    assert rows["up"]["attempts"] == 1  # 已成功目标不重发
    assert len(business_events(path)) == 1


@pytest.mark.parametrize("cause", ("disable", "delete_monitor"))
def test_inflight_delivery_completes_after_stop_and_is_not_resent(tmp_path, cause):
    """已领取（inflight）的投递在停止/删配置后仍完成；重启后不重发已成功目标。"""
    path = tmp_path / "monitor.sqlite"
    source = up_own_comment_pending(path)
    gate = {"enter": asyncio.Event(), "release": asyncio.Event()}

    async def blocked(request):
        gate["enter"].set()
        await gate["release"].wait()
        return httpx.Response(200, json={"code": 0, "msg": "success"})

    async def scenario():
        notifier = dispatcher(path, transport=httpx.MockTransport(blocked), full=ALL_WEBHOOK)
        running = asyncio.create_task(notifier.run_once())
        await asyncio.wait_for(gate["enter"].wait(), 10)
        # 两个目标都在同一轮被领取（inflight），此时停止监控/删除配置。
        assert {row["state"] for row in business_deliveries(path)} == {"inflight"}
        await stop(path, source, cause)
        gate["release"].set()
        await running
        await notifier.aclose()

    asyncio.run(scenario())
    assert delivery_states(path) == {"up": ("sent", None), "all": ("sent", None)}
    restarted = Receiver()
    asyncio.run(dispatcher(path, transport=httpx.MockTransport(restarted), full=ALL_WEBHOOK).run_once())
    assert restarted.requests == []  # 成功目标在进程重启后不重发
    assert len(business_events(path)) == 1
    assert [row["sealed"] for row in phases(path)] == [1]


# ---------------------------------------------------------------------------
# 候选不越阶段：旧阶段候选补齐后也不得据新阶段生成事件；新阶段同秒边界照常通知
# ---------------------------------------------------------------------------

def restart_monitor(path, *, enabled=True, mode="specified", recent_n=10):
    with archive_client(path) as api:
        response = api.patch(f"{BASE}/{UID}/monitor",
                             json={"mode": mode, "recent_n": recent_n, "enabled": enabled})
        assert response.status_code == 200


def comment_start(path):
    return query(path, "SELECT comment_started_at FROM notification_phases WHERE sealed = 0")[0][
        "comment_started_at"]


def initialize(path, source):
    with archive_client(path, source) as api:
        assert api.post("/api/sync/initial", json={"uid": UID}).status_code == 200


def test_old_phase_candidates_never_cross_and_new_phase_same_second_comments_notify(tmp_path):
    """旧阶段候选补齐后仍作废；新阶段起点同秒发表的一级评论与回复照常通知。"""
    path = tmp_path / "monitor.sqlite"
    source = CommentSource()
    source.add(DYNAMIC, [])
    arm(path, source)
    start1 = math.floor(started_at(path))
    before = start1 - 600
    historical_root = "880101"
    candidate_root = "880102"
    same_second_root = "880103"
    historical_reply = "980101"
    candidate_reply = "980102"
    same_second_reply = "980103"
    published = start1 + 600  # 晚于任何新起点：起点比较会放行，只能靠原阶段身份拦住

    source.add(DYNAMIC, [root_comment(historical_root, author="303", nickname="虚构路人",
                                      ctime=before, text="起点前的旧评论")])
    source.replies(DYNAMIC, historical_root, [
        reply_item(historical_reply, root=historical_root, author="303", nickname="虚构路人",
                   ctime=before, text="起点前的旧回复")])
    spec = source.spec(DYNAMIC)
    spec["roots"].append(root_comment(candidate_root, author=None, ctime=published,
                                      text="缺作者的一级评论"))
    spec["count"] = len(spec["roots"])
    source.replies(DYNAMIC, historical_root, [
        reply_item(historical_reply, root=historical_root, author="303", nickname="虚构路人",
                   ctime=before, text="起点前的旧回复"),
        reply_item(candidate_reply, root=historical_root, author=None, ctime=published,
                   text="缺作者的回复")])
    archive(path, source)
    assert business_events(path) == []
    assert [row["comment_id"] for row in candidates(path)] == [candidate_root, candidate_reply]

    # 真实退出再进入：旧阶段封存、新阶段新起点（不等于重设旧阶段）。
    restart_monitor(path, enabled=False)
    restart_monitor(path, enabled=True)
    start2 = comment_start(path)
    assert math.floor(start2) <= published  # 旧候选的发表时间晚于新起点：起点比较不能拦住它
    boundary = math.floor(start2)

    spec["roots"] = [
        root_comment(historical_root, author="303", nickname="虚构路人", ctime=before,
                     text="起点前的旧评论"),
        # 旧候选补齐作者/时间：内容仍归档，但不得据旧候选生成新阶段事件。
        root_comment(candidate_root, author="303", nickname="虚构路人", ctime=published,
                     text="补齐作者的一级评论"),
        # 新阶段起点同秒发表的新评论：属于“起点及之后”。
        root_comment(same_second_root, author=UID, nickname="虚构星海", ctime=boundary,
                     text="新阶段同秒的一级评论"),
    ]
    spec["count"] = len(spec["roots"])
    source.replies(DYNAMIC, historical_root, [
        reply_item(historical_reply, root=historical_root, author="303", nickname="虚构路人",
                   ctime=before, text="起点前的旧回复"),
        reply_item(candidate_reply, root=historical_root, author="303", nickname="虚构路人",
                   ctime=published, text="补齐作者的回复"),
        reply_item(same_second_reply, root=historical_root, author=UID, nickname="虚构星海",
                   ctime=boundary, text="新阶段同秒的回复"),
    ])
    initialize(path, source)

    assert candidates(path) == []  # 旧候选被消费，不留在队列里
    assert [(row["kind"], row["comment_id"]) for row in business_events(path)] == [
        ("root_comment", same_second_root), ("reply_comment", same_second_reply)]
    assert set(root_documents(path)) == {historical_root, candidate_root, same_second_root}
    assert set(reply_documents(path)) == {historical_reply, candidate_reply, same_second_reply}
    assert [row["sealed"] for row in phases(path)] == [1, 0]


# ---------------------------------------------------------------------------
# 未取得资格的候选不是队列：失效阶段的迟到内容既不进事件也不进候选
# ---------------------------------------------------------------------------

def stage_incomplete(source, kind):
    published = math.floor(time.time()) + 60
    spec = source.spec(DYNAMIC)
    if kind == "root":
        spec["roots"].append(root_comment("880201", author=None, ctime=published,
                                          text="停用后迟到且缺作者的一级评论"))
        spec["count"] = len(spec["roots"])
    else:
        items = list(spec["reply_threads"][BASELINE_ROOT]["items"]) + [
            reply_item("980201", root=BASELINE_ROOT, author=None, ctime=published,
                       text="停用后迟到且缺作者的回复")]
        source.replies(DYNAMIC, BASELINE_ROOT, items)
        spec["count"] += 1
    return published


@pytest.mark.parametrize("kind", ("root", "reply"))
@pytest.mark.parametrize("cause", STOP_CAUSES)
def test_claimed_incomplete_comment_after_stop_is_not_queued_as_candidate(tmp_path, cause, kind):
    """失效阶段的迟到内容即使字段不全，也不得留下候选（候选不是已入队事件）。"""
    path = tmp_path / "monitor.sqlite"
    source = CommentSource()
    source.add(DYNAMIC, [])
    source.add(OTHER_DYNAMIC, [])
    if cause in ("recent_window", "mode_switch"):
        arm(path, source, mode="recent")
    else:
        arm(path, source)
    silent_baseline(path, source, "root")
    stage_incomplete(source, kind)

    asyncio.run(in_flight(path, source, kind, while_blocked=lambda: stop(path, source, cause)))

    assert candidates(path) == []
    assert business_events(path) == []
    assert business_deliveries(path) == []
    assert [row["sealed"] for row in phases(path)] == [1]
    if kind == "root":
        assert "880201" in root_documents(path)
    else:
        assert "980201" in reply_documents(path)


# ---------------------------------------------------------------------------
# 重新启用/重新入选 vs 普通进程重启
# ---------------------------------------------------------------------------

EDITED_MARKER = "编辑于 2026年10月09日 13:01"


class EditableSource(CommentSource):
    """同一受控来源同时提供“编辑时间可信版本”的正文与评论来源。"""

    def __init__(self):
        super().__init__()
        self.edited = "13:01"

    def __call__(self, request):
        if request.url.path.startswith("/opus/"):
            id = request.url.path.rsplit("/", 1)[-1]
            html = page_html(UID, id)
            return httpx.Response(200, text=html.replace(
                EDITED_MARKER, f"编辑于 2026年10月09日 {self.edited}"))
        return super().__call__(request)


def test_real_exit_and_reentry_rebuilds_body_baseline_and_skips_paused_comments(tmp_path):
    """重新入选建立新起点：首份可信正文重建基线，暂停期间的新评论与编辑都不追补。"""
    path = tmp_path / "monitor.sqlite"
    source = EditableSource()
    source.add(DYNAMIC, [])
    arm(path, source)
    start1 = math.floor(started_at(path))
    source.add(DYNAMIC, [
        root_comment("880301", author="303", nickname="虚构路人", ctime=start1 - 600,
                     text="起点前的旧评论")])
    archive(path, source)  # 第一份可信正文只建立基线
    assert business_events(path) == []

    asyncio.run(stop(path, source, "disable"))
    # 暂停期间：正文被再次编辑，并发表了一条新评论（暂停期间不会被采集）。
    source.edited = "13:10"
    spec = source.spec(DYNAMIC)
    spec["roots"].append(root_comment("880302", author="303", nickname="虚构路人", ctime=start1,
                                      text="暂停期间发表的新评论"))
    spec["count"] = len(spec["roots"])
    # 对齐到下一秒再重新入选：新起点的秒值严格晚于暂停期间的发表时间，边界不含糊。
    while time.time() < start1 + 1.05:
        time.sleep(0.02)
    restart_monitor(path, enabled=True)
    start2 = comment_start(path)
    assert math.floor(start2) > start1

    archive(path, source)
    # 恢复后的第一份可信正文重建基线（不追补暂停期间编辑），暂停期间的评论按新起点静默。
    assert business_events(path) == []
    assert "880302" in root_documents(path)
    assert [row["sealed"] for row in phases(path)] == [1, 0]

    # 其后的新编辑与新评论照常通知。
    source.edited = "13:20"
    spec["roots"].append(root_comment("880303", author="303", nickname="虚构路人",
                                      ctime=math.floor(start2) + 60, text="新阶段的新评论"))
    spec["count"] = len(spec["roots"])
    archive(path, source)
    assert [(row["kind"], row["comment_id"]) for row in business_events(path)] == [
        ("dynamic_changed", None), ("root_comment", "880303")]
    assert "880303" in root_documents(path)
    # 新阶段内重复扫描同一批内容不重复生成已登记事件。
    archive(path, source)
    assert [(row["kind"], row["comment_id"]) for row in business_events(path)] == [
        ("dynamic_changed", None), ("root_comment", "880303")]


def test_equivalent_config_and_identical_window_keep_the_phase_until_a_real_reentry(tmp_path):
    """持续入选的等价保存与相同窗口不重设起点；真实移出再入选才建立新阶段。"""
    path = tmp_path / "monitor.sqlite"
    source = CommentSource()
    source.add(DYNAMIC, [])
    source.add(OTHER_DYNAMIC, [])
    arm(path, source, mode="recent")
    phase1 = phases(path)[0]

    # 相同窗口重复发布 + 等价配置保存（真实管理入口）：阶段与起点都不动。
    tokens = query(path, "SELECT id, token FROM target_selections ORDER BY id")
    discover(path, source, (DYNAMIC, OTHER_DYNAMIC))
    restart_monitor(path, mode="recent", recent_n=2, enabled=True)
    assert phases(path) == [phase1]
    assert query(path, "SELECT id, token FROM target_selections ORDER BY id") == tokens
    # 真实 recent_n 变化会让入选令牌整体轮换（reset），但持续入选的通知阶段必须续存。
    restart_monitor(path, mode="recent", recent_n=3, enabled=True)
    rotated = query(path, "SELECT id, token FROM target_selections ORDER BY id")
    assert [row["id"] for row in rotated] == [row["id"] for row in tokens]
    assert all(row["token"] != before["token"] for row, before in zip(rotated, tokens))
    assert phases(path) == [phase1]
    restart_monitor(path, mode="recent", recent_n=2, enabled=True)

    # 持续入选期间仍按原起点通知新评论。
    spec = source.spec(DYNAMIC)
    spec["roots"].append(root_comment("880401", author="303", nickname="虚构路人",
                                      ctime=math.floor(phase1["comment_started_at"]) + 60,
                                      text="持续入选期间的新评论"))
    spec["count"] = len(spec["roots"])
    archive(path, source)
    assert [row["comment_id"] for row in business_events(path)] == ["880401"]

    # 真实移出近期窗口：阶段封存。
    discover(path, source, (OTHER_DYNAMIC,))
    assert [row["sealed"] for row in phases(path)] == [1]
    # 再次入选：新阶段、新起点，不复用旧阶段。
    discover(path, source, (DYNAMIC, OTHER_DYNAMIC))
    rows = phases(path)
    assert [row["sealed"] for row in rows] == [1, 0]
    assert rows[1]["token"] != rows[0]["token"]
    assert rows[1]["started_at"] > rows[0]["started_at"]
    assert rows[1]["comment_started_at"] > rows[0]["comment_started_at"]


def test_restart_keeps_phase_baseline_and_queue_and_old_event_never_advances_new_phase(tmp_path):
    """普通重启不改起点/基线/队列；旧阶段入队事件的投递结果不推进新阶段基线。"""
    path = tmp_path / "monitor.sqlite"
    source = CommentSource()
    source.add(DYNAMIC, [])
    arm(path, source)
    silent_baseline(path, source, "root")
    stage_change(source, "root")  # 一条待投递的 UP 本人一级评论
    archive(path, source)
    assert [(row["kind"], row["comment_id"]) for row in business_events(path)] == [
        ("root_comment", NEW_ROOT)]

    restart_monitor(path, enabled=False)
    restart_monitor(path, enabled=True)
    rows = phases(path)
    assert [row["sealed"] for row in rows] == [1, 0]
    new_phase = rows[1]

    checkpoint = Store(path).read_archive(DYNAMIC)
    first = Receiver()
    asyncio.run(dispatcher(path, transport=httpx.MockTransport(first), full=ALL_WEBHOOK).run_once())
    assert sorted(request["url"] for request in first.requests) == sorted([WEBHOOK, ALL_WEBHOOK])
    # 旧阶段事件的投递结果不推进新阶段的归档/通知基线，也不改归档检查点。
    assert phases(path)[1] == new_phase
    assert Store(path).read_archive(DYNAMIC) == checkpoint

    # 普通重启：迁移（API/通知进程启动）+ 新的采集/通知对象都不重设阶段、不重发成功目标。
    Store(path).migrate()
    second = Receiver()
    asyncio.run(dispatcher(path, transport=httpx.MockTransport(second), full=ALL_WEBHOOK).run_once())
    assert second.requests == []
    assert phases(path) == [rows[0], new_phase]

    # 采集进程重启（新对象）后按原起点继续通知新评论。
    spec = source.spec(DYNAMIC)
    spec["roots"].append(root_comment("880501", author="303", nickname="虚构路人",
                                      ctime=math.floor(new_phase["comment_started_at"]) + 60,
                                      text="重启后的新评论"))
    spec["count"] = len(spec["roots"])
    archive(path, source)
    third = Receiver()
    asyncio.run(dispatcher(path, transport=httpx.MockTransport(third), full=ALL_WEBHOOK).run_once())
    assert all(comment_id in {NEW_ROOT, "880501"} for comment_id in
               [comment_id(payload) for payload in third.payloads])
    assert [row["comment_id"] for row in business_events(path)] == [NEW_ROOT, "880501"]


def test_deleted_and_recreated_config_starts_new_phase_and_claimed_work_cannot_join(tmp_path):
    """删除配置再重建＝真实退出再进入：归档保留，旧在途执行不得借新阶段发通知。"""
    path = tmp_path / "monitor.sqlite"
    source = CommentSource()
    source.add(DYNAMIC, [])
    arm(path, source)
    silent_baseline(path, source, "root")
    stage_change(source, "root")  # 旧阶段领取、停用后迟到的完整一级评论
    before = phases(path)[0]

    async def recreate():
        with archive_client(path, source) as api:
            assert api.delete(f"{BASE}/{UID}/monitor").status_code == 204
            assert api.post(BASE, json={"uid": UID}).status_code == 201
            assert api.patch(f"{BASE}/{UID}/monitor",
                             json={"mode": "specified", "recent_n": 10, "enabled": True}).status_code == 200
            assert api.post(f"{BASE}/{UID}/targets", json={"id": DYNAMIC}).status_code == 201

    asyncio.run(in_flight(path, source, "root", while_blocked=recreate))

    # 归档与迟到内容都保留，但旧执行不能借新阶段生成事件或候选。
    assert NEW_ROOT in root_documents(path)
    assert business_events(path) == [] and candidates(path) == []
    rows = phases(path)
    assert [row["sealed"] for row in rows] == [1, 0]
    assert (rows[0]["token"], rows[0]["started_at"], rows[0]["comment_started_at"]) == (
        before["token"], before["started_at"], before["comment_started_at"])
    with archive_client(path) as api:
        assert api.get(f"/api/archive/dynamics/{DYNAMIC}").status_code == 200

    # 新阶段照常只通知新起点之后的评论；旧阶段迟到归档的评论不补发。
    spec = source.spec(DYNAMIC)
    spec["roots"].append(root_comment("880302", author="303", nickname="虚构路人",
                                      ctime=math.floor(rows[1]["comment_started_at"]) + 60,
                                      text="重建配置后的新评论"))
    spec["count"] = len(spec["roots"])
    archive(path, source)
    assert [row["comment_id"] for row in business_events(path)] == ["880302"]
