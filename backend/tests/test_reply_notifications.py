"""05：楼中楼回复从真实归档写事务到双群投递的主链。

真实归档/采集入口 → 临时 SQLite → 受控飞书接收端；只替换 B 站/飞书 HTTP 传输与
时间来源。身份、动态、评论、回复与凭据均为虚构值，不访问真实上游与真实群。
"""

import asyncio
import json
import math
import sqlite3
import time

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.notifications import Dispatcher, NotificationConfig
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client
from backend.tests.management_support import BASE, UID
from backend.tests.notification_support import (
    ALL_WEBHOOK, BASE_URL, WEBHOOK, Clock, Receiver, drain, message_text,
)
from backend.tests.root_notification_support import (
    DYNAMIC, FUTURE_CTIME, OTHER_ALL_WEBHOOK, OTHER_UID, OTHER_UP_WEBHOOK, SYSTEM_WEBHOOK, Source,
    configure, deliveries, delivered_replies, dispatcher, events, query, reply_documents, reply_item,
    reply_locate, root_comment, root_documents, two_up_mapping,
)

ROOT = "870001"


def expected_payload(text_lines, *, dynamic=DYNAMIC, root=ROOT, reply="970001",
                     nickname="虚构星海", published="2027-01-01 00:00:00"):
    """新增评论模板：一级评论与楼中楼共用，链接换成该条回复的精确入口。"""
    paragraphs = [[{"tag": "text", "text": f"动态：{dynamic}"}],
                  [{"tag": "text", "text": f"评论人：【{nickname}】"}],
                  [{"tag": "text", "text": f"时间：{published}"}]]
    paragraphs += [[{"tag": "text", "text": line if index else "内容：" + line}]
                   for index, line in enumerate(text_lines)]
    paragraphs.append([{"tag": "text", "text": "链接："},
                       {"tag": "a", "text": "查看该条评论",
                        "href": f"{BASE_URL}/dynamics/{dynamic}/comments/{root}/replies/{reply}/locate"}])
    return {"msg_type": "post", "content": {"post": {"zh_cn": {"content": paragraphs}}}}


def archive(path, source, uid=UID, dynamic=DYNAMIC):
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(uid, dynamic)
            await collector.execute_pending()
    asyncio.run(scenario())


def comment_start(path):
    """当前未封存阶段的评论起点：边界用例以它为准，不用采集时间冒充发表时间。"""
    rows = query(path, "SELECT comment_started_at FROM notification_phases WHERE sealed = 0")
    return rows[0]["comment_started_at"]


def candidates(path):
    return query(path, "SELECT * FROM notification_candidates ORDER BY comment_id")


def restart_monitor(path, enabled):
    with archive_client(path) as api:
        assert api.patch(f"{BASE}/{UID}/monitor", json={
            "mode": "specified", "recent_n": 10, "enabled": enabled}).status_code == 200


def test_up_own_reply_notifies_up_and_all_rooms_once(tmp_path):
    """UP 本人的回复同时进入 UP 群和全员群，消息含统一模板与该条回复的精确链接。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment(ROOT, author="303", nickname="虚构路人", text="虚构根评论")])
    source.replies(DYNAMIC, ROOT, [reply_item(
        "970001", root=ROOT, author=UID, nickname="虚构星海",
        text="虚构回复\n第二行 回复 @虚构读者：保留上下文")])
    configure(path, source)

    received = Receiver()

    def feishu(request):
        # 发送发生时，该回复已能经 03 的只读定位入口读取到本身与所属根。
        with archive_client(path) as api:
            located = api.get(f"/api/archive/dynamics/{DYNAMIC}/comments/{ROOT}/replies/970001/location")
            assert located.status_code == 200
            page = located.json()
            assert [item["id"] for item in page["items"]] == ["970001"]
            assert page["root"]["id"] == ROOT
        return received(request)

    archive(path, source)
    asyncio.run(dispatcher(path, transport=httpx.MockTransport(feishu), full=ALL_WEBHOOK).run_once())

    expected = expected_payload(["虚构回复", "第二行 回复 @虚构读者：保留上下文"])
    replies = [(request["url"], payload) for request, payload in zip(received.requests, received.payloads)
               if reply_locate(payload) == (ROOT, "970001")]
    assert sorted(url for url, _ in replies) == sorted([WEBHOOK, ALL_WEBHOOK])
    assert [payload for _, payload in replies] == [expected, expected]
    assert message_text(replies[0][1]) == (
        "动态：123\n评论人：【虚构星海】\n时间：2027-01-01 00:00:00\n"
        "内容：虚构回复\n第二行 回复 @虚构读者：保留上下文\n链接：查看该条评论")
    reply_delivery = [row for row in deliveries(path) if row["comment_id"] == "970001"]
    assert [(row["kind"], row["role"], row["state"], row["attempts"]) for row in reply_delivery] == [
        ("reply_comment", "up", "sent", 1), ("reply_comment", "all", "sent", 1)]
    # 事件身份是「动态 + 所属根 + 回复」，不是计数或扫描轮次。
    assert [(row["kind"], row["root_id"], row["comment_id"]) for row in events(path)] == [
        ("root_comment", ROOT, ROOT), ("reply_comment", ROOT, "970001")]
    # 通知不修改归档原文，也不附带父评论全文。
    assert reply_documents(path)["970001"]["text"] == "虚构回复\n第二行 回复 @虚构读者：保留上下文"
    assert reply_documents(path)["970001"]["parent_id"] == ROOT


def test_late_root_comment_from_a_stopped_execution_cannot_join_the_new_phase(tmp_path):
    """提交处核验领取时绑定的阶段：旧执行不能借重新启用的新阶段发通知。

    旧执行先领取归档写代次（绑定阶段 1），随后目标被停用再启用（阶段 2、新起点）。
    迟到提交的评论发表时间晚于新起点，因此“起点比较”会放行；只有领取时绑定的阶段
    已封存才能拦住它。内容照常归档，但不产生任何事件或候选。
    """
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [])
    configure(path, source)
    published = int(time.time()) + 60
    source.add(DYNAMIC, [root_comment("870101", ctime=published, text="重新启用之后发表的评论")])
    gate = {"enter": asyncio.Event(), "release": asyncio.Event(), "blocked": False}

    async def gated(request):
        if gate["blocked"] and request.url.path == "/x/v2/reply":
            gate["enter"].set()
            await gate["release"].wait()
        return source(request)

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(gated)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            gate["blocked"] = True
            running = asyncio.create_task(collector.execute_pending())
            await gate["enter"].wait()
            # 在途期间停用再启用：旧阶段封存，新阶段建立新起点。
            restart_monitor(path, False)
            restart_monitor(path, True)
            gate["release"].set()
            await running

    asyncio.run(scenario())
    # 起点比较本身会放行这条评论，所以要拦下它只能靠领取时绑定的阶段。
    assert math.floor(comment_start(path)) < published
    assert set(root_documents(path)) == {"870101"}
    assert events(path) == [] and candidates(path) == []
    receiver = Receiver()
    asyncio.run(dispatcher(path, transport=httpx.MockTransport(receiver), full=ALL_WEBHOOK).run_once())
    assert receiver.requests == []
    # 新阶段本身照常工作：重新领取后发表的新评论正常通知。
    source.add(DYNAMIC, [
        root_comment("870101", ctime=published, text="重新启用之后发表的评论"),
        root_comment("870102", ctime=published + 60, text="新执行领取后的新评论")])
    archive(path, source)
    receiver = Receiver()
    asyncio.run(dispatcher(path, transport=httpx.MockTransport(receiver), full=ALL_WEBHOOK).run_once())
    assert [row["comment_id"] for row in events(path)] == ["870102"]


def test_late_reply_from_a_stopped_execution_cannot_join_the_new_phase(tmp_path):
    """回复与一级评论共用同一阶段边界：旧执行的迟到回复也不能进新阶段。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment(ROOT, author="303", nickname="虚构路人")])
    published = int(time.time()) + 60
    source.replies(DYNAMIC, ROOT, [reply_item("970101", root=ROOT, ctime=published, text="迟到的回复")])
    configure(path, source)
    gate = {"enter": asyncio.Event(), "release": asyncio.Event(), "blocked": False}

    async def gated(request):
        if gate["blocked"] and request.url.path == "/x/v2/reply/reply":
            gate["enter"].set()
            await gate["release"].wait()
        return source(request)

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(gated)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            gate["blocked"] = True
            running = asyncio.create_task(collector.execute_pending())
            await gate["enter"].wait()
            restart_monitor(path, False)
            restart_monitor(path, True)
            gate["release"].set()
            await running

    asyncio.run(scenario())
    assert math.floor(comment_start(path)) < published
    assert set(reply_documents(path)) == {"970101"}
    # 所属根在旧阶段（停用前）已合法登记；回复是旧阶段封存后的迟到提交，不能进新阶段。
    assert [(row["kind"], row["comment_id"]) for row in events(path)] == [("root_comment", ROOT)]
    assert candidates(path) == []


def test_reply_candidates_keep_their_owning_root(tmp_path):
    """候选主键必须含所属根：同一回复 ID 属于不同根时不能互相撞键。"""
    path = tmp_path / "monitor.sqlite"
    root = "870201"
    source = Source().add(DYNAMIC, [root_comment(root, author="303", nickname="虚构路人")])
    source.replies(DYNAMIC, root, [reply_item("970201", root=root, author=None, text="缺作者 UID 的回复")])
    configure(path, source)
    archive(path, source)

    assert set(reply_documents(path)) == {"970201"}
    # 缺作者 UID 的回复只留候选：没有回复事件，也没有伪造作者或时间。
    assert [(row["kind"], row["comment_id"]) for row in events(path)] == [("root_comment", root)]
    assert [(row["dynamic_id"], row["root_id"], row["comment_id"]) for row in candidates(path)] == [
        (DYNAMIC, root, "970201")]
    with sqlite3.connect(path) as connection:
        # 存储不变量：候选主键是（动态、所属根、评论），不是（动态、评论）。
        keys = sorted((row[1], row[5]) for row in connection.execute(
            "PRAGMA table_info(notification_candidates)") if row[5])
    assert keys == [("comment_id", 3), ("dynamic_id", 1), ("root_id", 2)]


def test_routing_uses_the_reply_author_not_the_replied_to_identity(tmp_path):
    """回复作者与该动态所属 UP 相等才双群；被回复者身份、同名用户与其他 UP 都不参与。"""
    path = tmp_path / "monitor.sqlite"
    plain = "870301"
    up_owned = "870302"
    source = Source().add(DYNAMIC, [
        root_comment(plain, author="303", nickname="虚构路人", text="普通作者的根评论"),
        root_comment(up_owned, author=UID, text="UP 本人的根评论"),
    ])
    source.replies(DYNAMIC, plain, [
        # UP 本人回复普通人的评论：作者是 UP 本人 → 双群。
        reply_item("970301", root=plain, author=UID, nickname="虚构星海",
                   text="回复 @虚构路人：UP 本人的回复"),
        # 同名但不同 UID：昵称不参与判定 → 只发全员群。
        reply_item("970302", root=plain, parent="970301", author="909", nickname="虚构星海",
                   text="同名不同 UID 的回复"),
        # 另一位受监控 UP 串门：只发本次动态的全员群，不能借用他自己的双群。
        reply_item("970303", root=plain, parent="970301", author=OTHER_UID, nickname="虚构晨光",
                   text="另一个 UP 的回复"),
    ])
    source.replies(DYNAMIC, up_owned, [
        # 普通作者回复 UP 本人的评论：被回复者是 UP，但作者不是 → 只发全员群。
        reply_item("970304", root=up_owned, author="303", nickname="虚构路人",
                   text="回复 @虚构星海：普通作者的回复"),
    ])
    configure(path, source)
    archive(path, source)

    received = Receiver()
    clock = Clock()

    async def deliver_all():
        notifier = Dispatcher(Store(path), NotificationConfig.from_mapping(two_up_mapping()),
                              transport=httpx.MockTransport(received), clock=clock)
        await drain(notifier, clock)

    asyncio.run(deliver_all())

    assert delivered_replies(received) == sorted([
        ((plain, "970301"), WEBHOOK), ((plain, "970301"), ALL_WEBHOOK),
        ((plain, "970302"), ALL_WEBHOOK),
        ((plain, "970303"), ALL_WEBHOOK),
        ((up_owned, "970304"), ALL_WEBHOOK),
    ])
    assert SYSTEM_WEBHOOK not in [request["url"] for request in received.requests]
    assert OTHER_UP_WEBHOOK not in [request["url"] for request in received.requests]
    assert OTHER_ALL_WEBHOOK not in [request["url"] for request in received.requests]


def test_reply_start_filters_history_and_keeps_the_same_second(tmp_path):
    """起点在启用时持久保存：起点前的旧回复静默，起点及之后（含同秒）通知。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment(ROOT, author="303", nickname="虚构路人")])
    configure(path, source)
    boundary = math.floor(comment_start(path))
    source.replies(DYNAMIC, ROOT, [
        reply_item("970401", root=ROOT, author="303", nickname="虚构路人", ctime=boundary - 60,
                   text="起点前一分钟的旧回复"),
        reply_item("970402", root=ROOT, author="303", nickname="虚构路人", ctime=boundary,
                   text="与起点同一秒的回复"),
        reply_item("970403", root=ROOT, author="303", nickname="虚构路人", ctime=boundary + 60,
                   text="起点后一分钟的新回复"),
    ])
    archive(path, source)

    received = Receiver()
    asyncio.run(dispatcher(path, transport=httpx.MockTransport(received), full=ALL_WEBHOOK).run_once())

    # 旧回复照常归档，但不产生事件；来源发表时间保留原始偏移，不用采集时间补造。
    assert set(reply_documents(path)) == {"970401", "970402", "970403"}
    assert reply_documents(path)["970401"]["published_at"].endswith("+08:00")
    assert delivered_replies(received) == [((ROOT, "970402"), ALL_WEBHOOK), ((ROOT, "970403"), ALL_WEBHOOK)]
    assert [row["comment_id"] for row in events(path) if row["kind"] == "reply_comment"] == [
        "970402", "970403"]


def test_missing_reply_identity_or_time_is_held_as_candidate_and_completed_atomically(tmp_path):
    """作者 UID 或发表时间缺失只留候选（带所属根）；补齐后原子转事件，不重设起点。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment(ROOT, author="303", nickname="虚构路人")])
    configure(path, source)
    boundary = math.floor(comment_start(path))
    source.replies(DYNAMIC, ROOT, [
        reply_item("970501", root=ROOT, author=None, text="缺少作者 UID 的回复"),
        reply_item("970502", root=ROOT, author="303", nickname="虚构路人", ctime=None,
                   text="缺少发表时间的回复"),
    ])
    archive(path, source)
    assert set(reply_documents(path)) == {"970501", "970502"}
    assert [row["kind"] for row in events(path)] == ["root_comment"]
    assert sorted((row["root_id"], row["comment_id"]) for row in candidates(path)) == [
        (ROOT, "970501"), (ROOT, "970502")]

    # 重开采集与投递对象（等价进程重启）后补齐来源字段，并让来源计数变化触发重扫。
    source.replies(DYNAMIC, ROOT, [
        reply_item("970501", root=ROOT, author=UID, nickname="虚构星海", text="缺少作者 UID 的回复"),
        reply_item("970502", root=ROOT, author="303", nickname="虚构路人", ctime=boundary + 60,
                   text="缺少发表时间的回复"),
        reply_item("970503", root=ROOT, author="303", nickname="虚构路人", ctime=boundary - 120,
                   text="同轮出现的旧回复"),
    ])
    source.spec(DYNAMIC)["count"] = 2
    archive(path, source)

    received = Receiver()
    asyncio.run(dispatcher(path, transport=httpx.MockTransport(received), full=ALL_WEBHOOK).run_once())
    assert candidates(path) == []
    assert delivered_replies(received) == sorted([
        ((ROOT, "970501"), WEBHOOK), ((ROOT, "970501"), ALL_WEBHOOK), ((ROOT, "970502"), ALL_WEBHOOK)])
    # 补齐只补字段：发表时间来自来源，旧回复不因补齐而获得资格。
    assert reply_documents(path)["970502"]["published_at"] is not None
    assert reply_documents(path)["970503"]["text"] == "同轮出现的旧回复"


def test_stopped_phase_reply_candidate_cannot_be_completed_in_the_new_phase(tmp_path):
    """旧阶段的候选不越阶段：停用再启用后补齐字段，也不生成新阶段的通知。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment(ROOT, author="303", nickname="虚构路人")])
    configure(path, source)
    boundary = math.floor(comment_start(path))
    source.replies(DYNAMIC, ROOT, [reply_item("970601", root=ROOT, author=None, text="旧阶段的待定回复")])
    archive(path, source)
    assert [(row["root_id"], row["comment_id"]) for row in candidates(path)] == [(ROOT, "970601")]

    restart_monitor(path, False)
    restart_monitor(path, True)
    # 楼内新增一条旧回复触发重扫：补齐字段的候选原来会在这里被转成事件。
    source.replies(DYNAMIC, ROOT, [
        reply_item("970601", root=ROOT, author=UID, nickname="虚构星海", ctime=boundary + 120,
                   text="旧阶段的待定回复"),
        reply_item("970602", root=ROOT, author="303", nickname="虚构路人", ctime=boundary - 300,
                   text="同轮出现的旧回复")])
    source.spec(DYNAMIC)["count"] = 2
    archive(path, source)

    received = Receiver()
    asyncio.run(dispatcher(path, transport=httpx.MockTransport(received), full=ALL_WEBHOOK).run_once())
    assert delivered_replies(received) == []
    assert [row["kind"] for row in events(path)] == ["root_comment"]
    # 补齐的字段照常写进归档，只是不再有资格进入新阶段。
    assert reply_documents(path)["970601"]["author"]["id"] == UID


def deliver(path):
    """跑完所有待发记录，返回受控飞书接收端。"""
    received = Receiver()
    clock = Clock()
    notifier = dispatcher(path, transport=httpx.MockTransport(received), clock=clock, full=ALL_WEBHOOK)
    asyncio.run(drain(notifier, clock))
    return received


def test_ready_reply_pages_deliver_while_a_later_page_fails(tmp_path):
    """单条就绪即可投递：后页失败不收回已提交页的资格，也不宣称整轮回复完整。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment(ROOT, author="303", nickname="虚构路人")])
    source.replies(DYNAMIC, ROOT, [
        reply_item(str(970700 + index), root=ROOT, author="303", nickname="虚构路人",
                   ctime=FUTURE_CTIME + index, text=f"虚构回复 {index}")
        for index in range(25)], fail_pages={2})
    configure(path, source)
    archive(path, source)

    received = deliver(path)
    assert len(reply_documents(path)) == 20
    assert Store(path).read_archive(DYNAMIC)["replies_error"] == "REPLIES_FAILED"
    assert len([row for row in events(path) if row["kind"] == "reply_comment"]) == 20
    assert len(delivered_replies(received)) == 20


def test_root_scan_failure_does_not_cancel_ready_replies_or_claim_completeness(tmp_path):
    """根扫描局部失败如实记录、不虚报完整；已就绪的回复照常投递，不因根失败被取消。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment(ROOT, author="303", nickname="虚构路人")])
    source.replies(DYNAMIC, ROOT, [
        reply_item("970801", root=ROOT, author="303", nickname="虚构路人", text="根扫描失败前就绪的回复")])
    configure(path, source)
    archive(path, source)
    # 不投递：先让根扫描整体失败，再看已入队事件是否仍在。
    source.spec(DYNAMIC)["fail_pages"].add(1)
    source.spec(DYNAMIC)["count"] = 2
    archive(path, source)

    archive_document = Store(path).read_archive(DYNAMIC)
    assert archive_document["root_comments_error"] == "ROOT_COMMENTS_FAILED"
    assert archive_document["work"]["comments"] != "success"
    assert [(row["kind"], row["comment_id"]) for row in events(path) if row["kind"] == "reply_comment"] == [
        ("reply_comment", "970801")]
    assert delivered_replies(deliver(path)) == [((ROOT, "970801"), ALL_WEBHOOK)]


def test_rescan_repagination_and_field_completion_never_duplicate_reply_events(tmp_path):
    """重新分页、补字段与纯编辑不重复产生已登记事件；重开进程也保持去重。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment(ROOT, author="303", nickname="虚构路人")])
    items = [reply_item(str(970900 + index), root=ROOT, author="303", nickname="虚构路人",
                        ctime=FUTURE_CTIME + index, text=f"虚构回复 {index}") for index in range(12)]
    source.replies(DYNAMIC, ROOT, items)
    configure(path, source)
    before_start = math.floor(comment_start(path)) - 600
    archive(path, source)
    assert len(delivered_replies(deliver(path))) == 12

    # 来源补字段（点赞）与一条纯编辑，并新增一条起点前的旧回复触发整楼重新分页：
    # 12 条已登记事件不得重复，旧回复仍静默。
    edited = [dict(item, like=7) for item in items]
    edited[0] = dict(edited[0], content={"message": "虚构回复 0（纯编辑）", "pictures": []})
    edited.append(reply_item("970999", root=ROOT, author="303", nickname="虚构路人",
                             ctime=before_start, text="起点前的旧回复"))
    source.replies(DYNAMIC, ROOT, edited)
    source.spec(DYNAMIC)["count"] = 2
    archive(path, source)
    assert delivered_replies(deliver(path)) == []
    # 重开对象等价进程重启：事件与去重记录都在库里，不重复生成。
    archive(path, source)
    assert delivered_replies(deliver(path)) == []
    assert len([row for row in events(path) if row["kind"] == "reply_comment"]) == 12
    assert reply_documents(path)["970900"]["text"] == "虚构回复 0（纯编辑）"


def test_rollback_of_reply_event_leaves_no_partial_notification(tmp_path):
    """回复、事件与逐群投递同事务：一处失败整体回滚，修复后只成功发送一次。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment(ROOT, author="303", nickname="虚构路人")])
    source.replies(DYNAMIC, ROOT, [
        reply_item("970901", root=ROOT, author="303", nickname="虚构路人", text="事务内的新回复")])
    configure(path, source)
    with sqlite3.connect(path) as database:
        database.execute("""CREATE TRIGGER fictional_delivery_failure
            BEFORE INSERT ON notification_deliveries
            BEGIN SELECT RAISE(ABORT, 'fictional delivery failure'); END""")

    archive(path, source)
    assert reply_documents(path) == {}
    assert [row["kind"] for row in events(path)] == []

    with sqlite3.connect(path) as database:
        database.execute("DROP TRIGGER fictional_delivery_failure")
    archive(path, source)
    assert delivered_replies(deliver(path)) == [((ROOT, "970901"), ALL_WEBHOOK)]
    assert len(reply_documents(path)) == 1


def reply_payloads(received, reply=None):
    """实际发往各群、携带指定回复的载荷：链接身份取自投递产物，不重算拼接。"""
    located = [(reply_locate(payload), payload) for payload in received.payloads]
    return [payload for where, payload in located
            if where is not None and (reply is None or where[1] == reply)]


def test_image_only_reply_uses_the_placeholder_and_records_only_picture_presence(tmp_path):
    """已知无文字但有图的回复按 §2.1 用占位：只留布尔存在性，不落、不上传图片 URL。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment(ROOT, author="303", nickname="虚构路人", text="虚构根评论")])
    source.replies(DYNAMIC, ROOT, [reply_item(
        "970701", root=ROOT, author=UID, nickname="虚构星海", text="",
        pictures=["https://reply-pictures.invalid/fictional-reply.png"])])
    configure(path, source)
    archive(path, source)

    received = deliver(path)
    assert delivered_replies(received) == sorted([
        ((ROOT, "970701"), WEBHOOK), ((ROOT, "970701"), ALL_WEBHOOK)])
    assert [message_text(payload) for payload in reply_payloads(received)] == [
        "动态：123\n评论人：【虚构星海】\n时间：2027-01-01 00:00:00\n"
        "内容：【图片评论，点击链接查看】\n链接：查看该条评论"] * 2
    # 兜底不扩大范围：载荷里没有图片节点，也没有来源图片 URL。
    for payload in reply_payloads(received):
        assert "img" not in json.dumps(payload)
        assert "reply-pictures.invalid" not in json.dumps(payload)
    document = reply_documents(path)["970701"]
    # 归档正文保留来源的空串，文档只多一个布尔存在性，不保存回复图片 URL。
    assert document["text"] == ""
    assert document["has_pictures"] is True
    assert "reply-pictures.invalid" not in json.dumps(document)
    assert [json.loads(row["snapshot"])["has_media"]
            for row in events(path) if row["kind"] == "reply_comment"] == [True]
    # 阅读接口与回复图片范围不变：通知内部的布尔存在性不外泄，也看不到图片 URL。
    with archive_client(path) as api:
        page = api.get(f"/api/archive/dynamics/{DYNAMIC}/comments/{ROOT}/replies").json()
    assert "has_pictures" not in page["items"][0]
    assert "reply-pictures.invalid" not in json.dumps(page)


def test_reply_text_with_pictures_keeps_the_source_text(tmp_path):
    """有文字又有图的回复照常显示原文，不被占位替换。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment(ROOT, author="303", nickname="虚构路人")])
    source.replies(DYNAMIC, ROOT, [reply_item(
        "970702", root=ROOT, author="303", nickname="虚构路人",
        text="回复 @虚构星海：看图\n第二行", pictures=["https://reply-pictures.invalid/with-text.png"])])
    configure(path, source)
    archive(path, source)

    received = deliver(path)
    assert delivered_replies(received) == [((ROOT, "970702"), ALL_WEBHOOK)]
    text = message_text(reply_payloads(received)[0])
    assert "内容：回复 @虚构星海：看图\n第二行" in text
    assert "图片评论" not in text
    assert reply_documents(path)["970702"]["text"] == "回复 @虚构星海：看图\n第二行"


@pytest.mark.parametrize("pictures", [None, ()], ids=["unknown-missing-key", "confirmed-empty"])
def test_empty_reply_text_without_known_pictures_keeps_the_original_empty_body(tmp_path, pictures):
    """无图（或来源未给）且空正文的回复保持原行为：不凭空造占位。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment(ROOT, author="303", nickname="虚构路人")])
    item = reply_item("970703", root=ROOT, author="303", nickname="虚构路人", text="")
    if pictures is None:
        item["content"].pop("pictures")
    source.replies(DYNAMIC, ROOT, [item])
    configure(path, source)
    archive(path, source)

    received = deliver(path)
    assert delivered_replies(received) == [((ROOT, "970703"), ALL_WEBHOOK)]
    assert message_text(reply_payloads(received)[0]) == (
        "动态：123\n评论人：【虚构路人】\n时间：2027-01-01 00:00:00\n内容：\n链接：查看该条评论")
    assert reply_documents(path)["970703"]["has_pictures"] is (None if pictures is None else False)


def test_registered_reply_keeps_its_frozen_has_media_across_rescan(tmp_path):
    """快照在生成时冻结 has_media：重扫补出图片存在性也不改写已发消息、不重发。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment(ROOT, author="303", nickname="虚构路人")])
    configure(path, source)
    before_start = math.floor(comment_start(path)) - 600
    unconfirmed = reply_item("970704", root=ROOT, author="303", nickname="虚构路人", text="")
    unconfirmed["content"].pop("pictures")
    source.replies(DYNAMIC, ROOT, [unconfirmed])
    archive(path, source)
    assert delivered_replies(deliver(path)) == [((ROOT, "970704"), ALL_WEBHOOK)]

    # 重扫得知该回复有图（并新增一条起点前的旧回复触发整楼重新分页）：文档补上存在性，
    # 已登记事件与快照不变，不再发送第二条消息。
    source.replies(DYNAMIC, ROOT, [
        reply_item("970704", root=ROOT, author="303", nickname="虚构路人", text="",
                   pictures=["https://reply-pictures.invalid/later.png"]),
        reply_item("970705", root=ROOT, author="303", nickname="虚构路人", ctime=before_start,
                   text="起点前的旧回复")])
    source.spec(DYNAMIC)["count"] = 2
    archive(path, source)
    assert reply_documents(path)["970704"]["has_pictures"] is True
    assert delivered_replies(deliver(path)) == []
    assert [json.loads(row["snapshot"])["has_media"]
            for row in events(path) if row["comment_id"] == "970704"] == [False]


@pytest.mark.parametrize("pictures", [
    [{"img_width": 640}],
    {"img_src": "https://reply-pictures.invalid/not-a-list.png"},
    [{"img_src": "javascript:alert(1)"}],
    [None],
], ids=["missing-img-src", "not-a-list", "invalid-url", "non-object-entry"])
def test_unreadable_reply_picture_metadata_never_rejects_the_legal_page(tmp_path, pictures):
    """来源图片元信息无法可靠解释时只降级为“未知”，不否决整页合法文字回复。

    回归背景：05 的纯图占位补丁曾用与根评论相同的严格校验解析回复图片，
    缺 `img_src`、非 list 或非法 URL 都会抛错并让整页失败，导致同页合法文字回复
    既不归档也不通知。未知存在性也不能被当成“无图”，更不能抹掉已观察到的已知值。
    """
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment(ROOT, author="303", nickname="虚构路人")])
    malformed = reply_item("970708", root=ROOT, author=UID, nickname="虚构星海", text="第一条合法文字")
    malformed["content"]["pictures"] = pictures
    source.replies(DYNAMIC, ROOT, [
        malformed,
        reply_item("970709", root=ROOT, author="303", nickname="虚构路人", text="第二条合法文字"),
    ])
    configure(path, source)
    archive(path, source)

    documents = reply_documents(path)
    assert documents["970708"]["text"] == "第一条合法文字"
    assert documents["970708"]["has_pictures"] is None  # 未知，不是“确认无图”
    assert documents["970709"]["text"] == "第二条合法文字"
    received = deliver(path)
    assert delivered_replies(received) == sorted([
        ((ROOT, "970708"), WEBHOOK), ((ROOT, "970708"), ALL_WEBHOOK),
        ((ROOT, "970709"), ALL_WEBHOOK)])
    assert "图片评论" not in "\n".join(message_text(payload) for payload in received.payloads)


def test_unknown_reply_picture_metadata_keeps_an_already_known_presence(tmp_path):
    """重扫只剩无法解释的图片元信息时保留已知有图，不把占位改成空正文。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment(ROOT, author="303", nickname="虚构路人")])
    configure(path, source)
    source.replies(DYNAMIC, ROOT, [reply_item(
        "970710", root=ROOT, author=UID, nickname="虚构星海", text="",
        pictures=["https://reply-pictures.invalid/known.png"])])
    archive(path, source)
    assert reply_documents(path)["970710"]["has_pictures"] is True
    first = deliver(path)
    assert sorted(delivered_replies(first)) == sorted([
        ((ROOT, "970710"), WEBHOOK), ((ROOT, "970710"), ALL_WEBHOOK)])

    before_start = math.floor(comment_start(path)) - 600
    unknown = reply_item("970710", root=ROOT, author=UID, nickname="虚构星海", text="")
    unknown["content"]["pictures"] = [{"img_width": 640}]
    source.replies(DYNAMIC, ROOT, [
        unknown,
        reply_item("970711", root=ROOT, author="303", nickname="虚构路人", ctime=before_start,
                   text="起点前的旧回复")])
    source.spec(DYNAMIC)["count"] = 2
    archive(path, source)

    assert reply_documents(path)["970710"]["has_pictures"] is True
    assert [json.loads(row["snapshot"])["has_media"]
            for row in events(path) if row["comment_id"] == "970710"] == [True]
    assert delivered_replies(deliver(path)) == []


def test_root_comment_picture_validation_stays_strict(tmp_path):
    """根评论的既有严格图片校验不因回复降级而放宽：非法元信息仍整页失败。"""
    path = tmp_path / "monitor.sqlite"
    root = root_comment(ROOT, author="303", nickname="虚构路人", text="合法文字")
    root["content"]["pictures"] = [{"img_width": 640}]
    source = Source().add(DYNAMIC, [root])
    configure(path, source)
    archive(path, source)

    assert root_documents(path) == {}
    assert Store(path).read_archive(DYNAMIC)["root_comments_error"] == "ROOT_COMMENTS_FAILED"
    assert [row for row in events(path) if row["kind"] != "dynamic_changed"] == []


def test_candidate_completion_keeps_known_picture_presence_for_the_placeholder(tmp_path):
    """候选补齐沿用元信息合并语义：先已知有图，后来来源缺键也不抹成“无图”。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment(ROOT, author="303", nickname="虚构路人")])
    configure(path, source)
    before_start = math.floor(comment_start(path)) - 600
    source.replies(DYNAMIC, ROOT, [reply_item(
        "970706", root=ROOT, author=None, text="", pictures=["https://reply-pictures.invalid/known.png"])])
    archive(path, source)
    assert [(row["root_id"], row["comment_id"]) for row in candidates(path)] == [(ROOT, "970706")]
    assert [row["kind"] for row in events(path)] == ["root_comment"]

    completed = reply_item("970706", root=ROOT, author=UID, nickname="虚构星海", text="")
    completed["content"].pop("pictures")
    source.replies(DYNAMIC, ROOT, [
        completed,
        reply_item("970707", root=ROOT, author="303", nickname="虚构路人", ctime=before_start,
                   text="起点前的旧回复")])
    source.spec(DYNAMIC)["count"] = 2
    archive(path, source)

    received = deliver(path)
    assert candidates(path) == []
    assert delivered_replies(received) == sorted([
        ((ROOT, "970706"), WEBHOOK), ((ROOT, "970706"), ALL_WEBHOOK)])
    assert [message_text(payload) for payload in reply_payloads(received)] == [
        "动态：123\n评论人：【虚构星海】\n时间：2027-01-01 00:00:00\n"
        "内容：【图片评论，点击链接查看】\n链接：查看该条评论"] * 2
