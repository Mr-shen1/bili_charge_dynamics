"""04：一级评论从真实归档写事务到双群投递的主链。

真实归档/采集入口 → 临时 SQLite → 受控飞书接收端；只替换 B 站/飞书 HTTP 传输与
时间来源。身份、动态、评论与凭据均为虚构值，不访问真实上游与真实群。
"""

import asyncio
import json
import math
import sqlite3

import httpx

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.notifications import Dispatcher, NotificationConfig
from backend.bili_monitor.storage import Store
from backend.tests.management_support import UID
from backend.tests.archive_support import archive_client
from backend.tests.notification_support import (
    ALL_WEBHOOK, BASE_URL, WEBHOOK, Receiver, drain, message_text,
)
from backend.tests.root_notification_support import (
    DYNAMIC, FUTURE_CTIME, OTHER_DYNAMIC, OTHER_UID, OTHER_ALL_WEBHOOK, OTHER_UP_WEBHOOK, SYSTEM_WEBHOOK,
    Clock, Source, comment_id, configure, deliveries, delivered, dispatcher, events, query, root_comment,
    root_documents, started_at, two_up_mapping,
)


def expected_payload(text_lines, *, dynamic=DYNAMIC, nickname="虚构星海", published="2027-01-01 00:00:00",
                     comment_id="860001"):
    paragraphs = [[{"tag": "text", "text": f"动态：{dynamic}"}],
                  [{"tag": "text", "text": f"评论人：【{nickname}】"}],
                  [{"tag": "text", "text": f"时间：{published}"}]]
    paragraphs += [[{"tag": "text", "text": line if index else "内容：" + line}]
                   for index, line in enumerate(text_lines)]
    paragraphs.append([{"tag": "text", "text": "链接："},
                       {"tag": "a", "text": "查看该条评论",
                        "href": f"{BASE_URL}/dynamics/{dynamic}/comments/{comment_id}/locate"}])
    return {"msg_type": "post", "content": {"post": {"zh_cn": {"content": paragraphs}}}}


def test_up_own_root_comment_notifies_up_and_all_rooms_once(tmp_path):
    """UP 本人的一级评论同时进入 UP 群和全员群，消息含标题、昵称、时间、正文与精确链接。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [
        root_comment("860001", text="虚构新评论\n第二行 回复 @虚构读者：保留上下文")])
    configure(path, source)

    received = Receiver()

    def feishu(request):
        # 发送发生时，该评论已能经 02 的只读定位入口读取到本身。
        with archive_client(path) as api:
            located = api.get(f"/api/archive/dynamics/{DYNAMIC}/comments/860001/location")
            assert located.status_code == 200
            assert located.json()["items"][0]["id"] == "860001"
        return received(request)

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            await dispatcher(path, transport=httpx.MockTransport(feishu), full=ALL_WEBHOOK).run_once()
        receiver = received

        expected = expected_payload(["虚构新评论", "第二行 回复 @虚构读者：保留上下文"])
        assert sorted(request["url"] for request in receiver.requests) == sorted([WEBHOOK, ALL_WEBHOOK])
        assert receiver.payloads == [expected, expected]
        assert message_text(receiver.payloads[0]) == (
            "动态：123\n评论人：【虚构星海】\n时间：2027-01-01 00:00:00\n"
            "内容：虚构新评论\n第二行 回复 @虚构读者：保留上下文\n链接：查看该条评论")
        assert [(row["role"], row["state"], row["attempts"]) for row in deliveries(path)] == [
            ("up", "sent", 1), ("all", "sent", 1)]
        # 通知不修改归档原文与评论正文。
        assert Store(path).read_archive(DYNAMIC)["text"] == "虚构全文\n第二行 <b>仍是文本</b> 🙂"
        assert root_documents(path)["860001"]["text"] == "虚构新评论\n第二行 回复 @虚构读者：保留上下文"

    asyncio.run(scenario())


def test_routing_uses_dynamic_owner_uid_and_never_the_system_room(tmp_path):
    """至少两个 UP：本人、同名异 UID、另一受监控 UP 串门与普通作者按所属动态作者判定。"""
    path = tmp_path / "monitor.sqlite"
    source = Source()
    source.add(DYNAMIC, [
        root_comment("860001", author=UID, text="UP 自己的一级评论"),
        root_comment("860002", author=OTHER_UID, nickname="虚构晨光", text="另一受监控 UP 串门"),
        root_comment("860003", author="909", nickname="虚构星海", text="同名但不同 UID"),
        root_comment("860004", author="303", nickname="虚构路人", text="普通作者"),
    ])
    source.add(OTHER_DYNAMIC, [
        root_comment("860005", author=OTHER_UID, nickname="虚构晨光", text="202 自己动态下的评论"),
    ], uid=OTHER_UID)
    configure(path, source, uid=UID, ids=(DYNAMIC,))
    configure(path, source, uid=OTHER_UID, ids=(OTHER_DYNAMIC,))

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            for uid, dynamic in ((UID, DYNAMIC), (OTHER_UID, OTHER_DYNAMIC)):
                await collector.check_once(uid, dynamic)
            await collector.execute_pending()
        receiver = Receiver()
        await Dispatcher(Store(path), NotificationConfig.from_mapping(two_up_mapping()),
                         transport=httpx.MockTransport(receiver)).run_once()

        assert delivered(receiver) == sorted([
            # 所属动态作者本人：UP 群 + 全员群。
            ("860001", WEBHOOK), ("860001", ALL_WEBHOOK),
            # 另一受监控 UP 与本动态无关：只发全员群，不能按“是受监控 UP”升级成双群。
            ("860002", ALL_WEBHOOK),
            # 同名不同 UID 只按字符串 UID 判定，昵称不参与路由。
            ("860003", ALL_WEBHOOK),
            ("860004", ALL_WEBHOOK),
            # 另一位 UP 在自己动态下：用他自己的双群，不借用第一个人群。
            ("860005", OTHER_UP_WEBHOOK), ("860005", OTHER_ALL_WEBHOOK),
        ])
        assert SYSTEM_WEBHOOK not in [request["url"] for request in receiver.requests]
        assert sorted((row["role"], row["state"]) for row in deliveries(path)) == sorted([
            ("up", "sent"), ("all", "sent"), ("all", "sent"), ("all", "sent"),
            ("all", "sent"), ("up", "sent"), ("all", "sent")])

    asyncio.run(scenario())


def test_comment_start_filters_history_and_keeps_the_same_second_new(tmp_path):
    """起点在启用时持久保存：09:59 静默、同秒与 10:01 通知，且不以采集时间代替发表时间。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [])
    configure(path, source)
    start = started_at(path)
    assert isinstance(start, float)  # 起点在首次全量归档之前就已持久保存
    boundary = math.floor(start)
    source.add(DYNAMIC, [
        root_comment("860101", ctime=boundary - 60, text="起点前一分钟的旧评论"),
        root_comment("860102", ctime=boundary, text="与起点同一秒的评论"),
        root_comment("860103", ctime=boundary + 60, text="起点后一分钟的新评论"),
    ])

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
        receiver = Receiver()
        await dispatcher(path, transport=httpx.MockTransport(receiver), full=ALL_WEBHOOK).run_once()

        # 旧评论照常归档，但不产生事件；起点及其之后的评论各一条，逐目标发送。
        assert set(root_documents(path)) == {"860101", "860102", "860103"}
        assert delivered(receiver) == sorted([
            ("860102", WEBHOOK), ("860102", ALL_WEBHOOK),
            ("860103", WEBHOOK), ("860103", ALL_WEBHOOK)])
        assert [row["comment_id"] for row in events(path)] == ["860102", "860103"]
        assert root_documents(path)["860101"]["published_at"].endswith("+08:00")

    asyncio.run(scenario())


def test_missing_identity_or_time_is_held_as_candidate_and_completed_atomically(tmp_path):
    """作者 UID 或发表时间缺失只留候选；补齐后原子转成事件，跨重启不丢也不重设起点。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [
        root_comment("860201", author=None, text="缺少作者 UID 的评论"),
        root_comment("860202", ctime=None, text="缺少发表时间的评论"),
    ])
    configure(path, source)
    boundary = math.floor(started_at(path))

    async def archive():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()

    asyncio.run(archive())
    # 可合法归档的内容照常保存，但资格不全时没有事件，只留候选。
    assert set(root_documents(path)) == {"860201", "860202"}
    assert events(path) == [] and deliveries(path) == []
    assert sorted(row["comment_id"] for row in query(
        path, "SELECT comment_id FROM notification_candidates")) == ["860201", "860202"]

    # 重开采集与投递对象（等价进程重启）后再补齐来源字段；候选仍在原阶段。
    source.replace(DYNAMIC, [
        root_comment("860201", author=UID, text="缺少作者 UID 的评论"),
        root_comment("860202", author="303", nickname="虚构路人", ctime=boundary + 60, text="缺少发表时间的评论"),
        root_comment("860203", author="303", nickname="虚构路人", ctime=boundary - 120, text="同轮出现的旧评论"),
    ])

    async def complete():
        await archive()
        receiver = Receiver()
        await dispatcher(path, transport=httpx.MockTransport(receiver), full=ALL_WEBHOOK).run_once()
        assert query(path, "SELECT COUNT(*) AS total FROM notification_candidates")[0]["total"] == 0
        assert sorted(row["comment_id"] for row in events(path)) == ["860201", "860202"]
        assert delivered(receiver) == sorted([
            ("860201", WEBHOOK), ("860201", ALL_WEBHOOK), ("860202", ALL_WEBHOOK)])
        # 补齐只补字段：归档正文与发表时间都来自来源，不用采集时间冒充。
        assert root_documents(path)["860202"]["published_at"] is not None
        assert root_documents(path)["860203"]["text"] == "同轮出现的旧评论"

    asyncio.run(complete())


def test_rescan_edit_and_count_drop_never_duplicate_or_placeholder(tmp_path):
    """重复采集、补字段、纯编辑不重复；计数下降且无新评论时不发占位或删除通知。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [
        root_comment("860301", author=UID, text="第一条新评论"),
        root_comment("860302", author="303", nickname="虚构路人", text="第二条新评论"),
    ])
    configure(path, source)

    async def cycle(transport=None):
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
        receiver = Receiver()
        await dispatcher(path, transport=transport or httpx.MockTransport(receiver),
                         full=ALL_WEBHOOK).run_once()
        return receiver

    first = asyncio.run(cycle())
    assert len(first.requests) == 3
    # 同样内容重扫（来源补字段/重复扫描）不产生第二条事件。
    source.replace(DYNAMIC, [
        root_comment("860301", author=UID, text="第一条新评论", like=9),
        root_comment("860302", author="303", nickname="虚构路人", text="第二条新评论"),
    ])
    source.spec(DYNAMIC)["count"] = 3  # 计数变化触发重扫，但没有真正的新评论
    again = asyncio.run(cycle())
    source.spec(DYNAMIC)["count"] = 2
    # 计数下降：只保留一条，另一条本地照旧保留，不发删除或占位消息。
    source.add(DYNAMIC, [root_comment("860301", author=UID, text="第一条新评论（纯编辑）")])
    dropped = asyncio.run(cycle())
    assert again.requests == [] and dropped.requests == []
    assert sorted(row["comment_id"] for row in events(path)) == ["860301", "860302"]
    assert set(root_documents(path)) == {"860301", "860302"}
    assert root_documents(path)["860301"]["text"] == "第一条新评论（纯编辑）"
    # 真正的新评论照常逐条通知。
    source.add(DYNAMIC, [
        root_comment("860301", author=UID, text="第一条新评论（纯编辑）"),
        root_comment("860303", author="303", nickname="虚构路人", text="第三条新评论"),
    ])
    fresh = asyncio.run(cycle())
    assert delivered(fresh) == [("860303", ALL_WEBHOOK)]


def test_ready_page_delivers_even_when_a_later_page_fails(tmp_path):
    """单条就绪即可投递：后页失败不阻塞已提交页，也不宣称整轮评论集合完整。"""
    path = tmp_path / "monitor.sqlite"
    roots = [root_comment(str(860400 + index), author="303", nickname="虚构路人", text=f"虚构评论 {index}")
             for index in range(21)]
    source = Source().add(DYNAMIC, roots)
    configure(path, source)
    source.spec(DYNAMIC)["fail_pages"].add(2)

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
        receiver = Receiver()
        clock = Clock()
        notifier = dispatcher(path, transport=httpx.MockTransport(receiver), clock=clock, full=ALL_WEBHOOK)
        await drain(notifier, clock)  # 单轮批量与每秒额度都有限：按轮询节拍把 20 条发完
        assert len(root_documents(path)) == 20
        assert Store(path).read_archive(DYNAMIC)["root_comments_error"] == "ROOT_COMMENTS_FAILED"
        assert len(events(path)) == 20
        assert len(receiver.requests) == 20
        assert {comment for comment, _ in delivered(receiver)} == {str(860400 + index) for index in range(20)}

    asyncio.run(scenario())


def test_stop_before_comment_commit_keeps_content_without_new_event(tmp_path):
    """提交处核验阶段：停止后仍在途的根评论可以保存内容，但不产生失效阶段的通知。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment("860501", text="停止前发出的新评论")])
    configure(path, source)
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
            # 停止监控走真实管理 HTTP；在途采集仍按原规则保存内容。
            with archive_client(path) as api:
                assert api.patch(f"/api/manage/ups/{UID}/monitor",
                                 json={"mode": "specified", "recent_n": 10, "enabled": False}
                                 ).status_code == 200
            gate["release"].set()
            await running
        receiver = Receiver()
        await dispatcher(path, transport=httpx.MockTransport(receiver), full=ALL_WEBHOOK).run_once()
        assert set(root_documents(path)) == {"860501"}
        assert events(path) == [] and receiver.requests == []
        assert query(path, "SELECT COUNT(*) AS total FROM notification_candidates")[0]["total"] == 0

    asyncio.run(scenario())


def test_rollback_of_comment_event_leaves_no_partial_notification(tmp_path):
    """评论、事件与逐群投递同事务：一处失败整体回滚，修复后只成功发送一次。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment("860601", text="事务内的新评论")])
    configure(path, source)
    with sqlite3.connect(path) as database:
        database.execute("""CREATE TRIGGER fictional_delivery_failure
            BEFORE INSERT ON notification_deliveries
            BEGIN SELECT RAISE(ABORT, 'fictional delivery failure'); END""")

    async def archive():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()

    asyncio.run(archive())
    assert root_documents(path) == {} and events(path) == []
    with sqlite3.connect(path) as database:
        database.execute("DROP TRIGGER fictional_delivery_failure")
    asyncio.run(archive())
    receiver = Receiver()
    asyncio.run(dispatcher(path, transport=httpx.MockTransport(receiver), full=ALL_WEBHOOK).run_once())
    assert len(events(path)) == 1 and len(receiver.requests) == 2
    assert set(root_documents(path)) == {"860601"}


def test_snapshot_is_frozen_when_the_comment_event_is_generated(tmp_path):
    """事件快照冻结内容：归档随后更新不改写已入队消息。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment("860701", text="事件生成时的正文")])
    configure(path, source)

    async def archive():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()

    asyncio.run(archive())
    # 不投递，先让归档正文在后续扫描中变化（补字段/纯编辑不产生新事件）。
    source.add(DYNAMIC, [
        root_comment("860701", text="归档随后被编辑的正文"),
        root_comment("860702", author="303", nickname="虚构路人", text="另一条新评论"),
    ])
    asyncio.run(archive())
    receiver = Receiver()
    notifier = dispatcher(path, transport=httpx.MockTransport(receiver), full=ALL_WEBHOOK)
    asyncio.run(notifier.run_once())
    payload = next(payload for request, payload in zip(receiver.requests, receiver.payloads)
                   if comment_id(payload) == "860701")
    assert "事件生成时的正文" in message_text(payload)
    assert "归档随后被编辑的正文" not in message_text(payload)
    assert root_documents(path)["860701"]["text"] == "归档随后被编辑的正文"


def test_missing_all_room_waits_for_config_and_only_the_failed_target_resends(tmp_path):
    """逐目标独立：一个群缺失时保留该目标、其他群照常发送，修配后只补发未成功目标。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [root_comment("860801", author=UID, text="双群都要发的新评论")])
    configure(path, source)

    async def archive():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()

    asyncio.run(archive())
    clock = Clock()
    first = Receiver()
    # 只配置 UP 群：全员群缺失时不转投、不每秒空发，记录进入等待配置。
    asyncio.run(dispatcher(path, transport=httpx.MockTransport(first), clock=clock).run_once())
    assert [request["url"] for request in first.requests] == [WEBHOOK]
    states = {row["role"]: (row["state"], row["error"], row["attempts"]) for row in deliveries(path)}
    assert states["up"][0] == "sent"
    assert states["all"][0] == "waiting_config" and states["all"][1] == "route_missing"
    second = Receiver()
    notifier = dispatcher(path, transport=httpx.MockTransport(second), clock=clock, full=ALL_WEBHOOK)
    # 修配路由后不立即空转：先到复检周期，再只补发未成功的全员群。
    asyncio.run(notifier.run_once())
    assert second.requests == []
    clock.advance(60.0)
    asyncio.run(notifier.run_once())
    assert [request["url"] for request in second.requests] == [ALL_WEBHOOK]
    assert delivered(second) == [("860801", ALL_WEBHOOK)]
    assert {row["role"]: row["state"] for row in deliveries(path)} == {"up": "sent", "all": "sent"}


def test_existing_archive_stays_silent_when_comment_notifications_restart(tmp_path):
    """已有归档的评论作为静默基线：停止后重新启用只从新起点评估，不回填旧评论。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [])
    configure(path, source)
    start = math.floor(started_at(path))
    source.add(DYNAMIC, [
        root_comment("861001", ctime=start + 1, text="启用后发表的第一条"),
        root_comment("861002", ctime=start + 2, text="启用后发表的第二条"),
    ])

    async def cycle():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
        receiver = Receiver()
        await dispatcher(path, transport=httpx.MockTransport(receiver), full=ALL_WEBHOOK).run_once()
        return receiver

    first = asyncio.run(cycle())
    assert delivered(first) == sorted([
        ("861001", WEBHOOK), ("861001", ALL_WEBHOOK), ("861002", WEBHOOK), ("861002", ALL_WEBHOOK)])
    assert sorted(row["comment_id"] for row in events(path)) == ["861001", "861002"]
    # 停止再启用：结束后旧阶段、建立新阶段（新起点），已归档评论仍是静默基线。
    with archive_client(path) as api:
        for enabled in (False, True):
            assert api.patch(f"/api/manage/ups/{UID}/monitor",
                             json={"mode": "specified", "recent_n": 10, "enabled": enabled}
                             ).status_code == 200
    restarted = math.floor(started_at(path))
    assert restarted >= start
    source.add(DYNAMIC, [
        root_comment("861001", ctime=start + 1, text="启用后发表的第一条"),
        root_comment("861002", ctime=start + 2, text="启用后发表的第二条"),
        root_comment("861003", author="303", nickname="虚构路人", ctime=restarted + 60,
                     text="重新启用后发表的新评论"),
    ])
    second = asyncio.run(cycle())
    # 旧阶段已封存、重新启用只按新起点评估：回填不会发生，只有新评论进全员群。
    assert delivered(second) == [("861003", ALL_WEBHOOK)]
    assert sorted(row["comment_id"] for row in events(path)) == ["861001", "861002", "861003"]


def test_image_only_comment_uses_the_placeholder_without_uploading_images(tmp_path):
    """已知无文字但有图的一级评论用规定占位；不上传图片、不附父评论全文。"""
    path = tmp_path / "monitor.sqlite"
    source = Source().add(DYNAMIC, [
        root_comment("861101", text=None, pictures=["https://example.invalid/fictional.png"])])
    configure(path, source)

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
        receiver = Receiver()
        await dispatcher(path, transport=httpx.MockTransport(receiver), full=ALL_WEBHOOK).run_once()
        assert len(receiver.requests) == 2
        text = message_text(receiver.payloads[0])
        assert "内容：【图片评论，点击链接查看】" in text
        assert "img" not in json.dumps(receiver.payloads[0])
        assert root_documents(path)["861101"]["media_sources"]

    asyncio.run(scenario())
