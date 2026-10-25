"""01：真实归档/采集入口 → 临时 SQLite → 受控飞书接收端。

只替换 B 站/飞书的 HTTP 传输、媒体外部传输与时间；正文解析、检查、归档事务、
通知阶段、候选/事件生成、路由、格式与投递调度均使用生产代码。
"""

import asyncio
import json
import sqlite3

import httpx

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.media import ImageDownloader
from backend.bili_monitor.notifications import Dispatcher
from backend.bili_monitor.selection import refresh_selections
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client, set_specified
from backend.tests.collector_support import configured
from backend.tests.management_support import BASE, UID
from backend.tests.notification_support import (
    ALL_WEBHOOK, BASE_URL, DYNAMIC, WEBHOOK, Clock, FailingUploader, Receiver, Source,
    assert_no_credentials, config, deliveries, events, media_download, message_text, query,
)


def dispatcher(path, *, transport, clock=None, **sections):
    return Dispatcher(Store(path), config(**sections), transport=transport, clock=clock)


def test_committed_trusted_change_delivers_only_once_after_restart(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)

    async def scenario():
        source = Source("v1")
        received = []

        def receiver(request):
            # 发送发生时，正文已经可从真实本站 HTTP 读取。
            with archive_client(path) as api:
                detail = api.get("/api/archive/dynamics/123")
                assert detail.status_code == 200
                assert detail.json()["text"] == "第二版"
            received.append((str(request.url), json.loads(request.content)))
            return httpx.Response(200, json={"code": 0, "msg": "success"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            notifier = dispatcher(path, transport=httpx.MockTransport(receiver))
            await notifier.run_once()
            assert received == []  # 首次归档静默。
            source.page = "v2"
            await collector.check_once(UID, "123")
            await notifier.run_once()
            assert received == []  # 只观察到变化还不能发。
            await collector.execute_pending()
            # 提交后重开通知与采集对象，不依赖进程内回调。
            await dispatcher(path, transport=httpx.MockTransport(receiver)).run_once()
            assert received == [(WEBHOOK, {
                "msg_type": "post", "content": {"post": {"zh_cn": {"content": [
                    [{"tag": "text", "text": "动态【123】发生变化"}],
                    [{"tag": "text", "text": "链接："},
                     {"tag": "a", "text": "查看动态", "href": BASE_URL + "/dynamics/123"}],
                ]}}},
            })]
            await Collector(Store(path), client).execute_pending()
            await notifier.run_once()
            assert len(received) == 1

        saved = deliveries(path)
        assert [(row["role"], row["state"], row["attempts"]) for row in saved] == [("up", "sent", 1)]
        assert saved[0]["sent_at"] is not None
        assert_no_credentials(path, WEBHOOK, ALL_WEBHOOK)

    asyncio.run(scenario())


def test_titled_change_uses_title_and_blank_title_falls_back_to_dynamic_id(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)

    async def scenario():
        source = Source("v1")
        receiver = Receiver()
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            source.page, source.title = "v2", "  虚构标题  "
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            await dispatcher(path, transport=httpx.MockTransport(receiver)).run_once()
            source.title = "  "
            source.edited = "13:05"
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            await dispatcher(path, transport=httpx.MockTransport(receiver)).run_once()

        texts = [message_text(payload) for payload in receiver.payloads]
        assert texts[0].splitlines()[0] == "动态【虚构标题】发生变化"
        assert texts[1].splitlines()[0] == "动态【123】发生变化"
        # 标题与链接是真实可点击元素，不是整段纯文本。
        link = receiver.payloads[1]["content"]["post"]["zh_cn"]["content"][1][1]
        assert link == {"tag": "a", "text": "查看动态", "href": f"{BASE_URL}/dynamics/{DYNAMIC}"}
        assert all(item["url"] == WEBHOOK for item in receiver.requests)

    asyncio.run(scenario())


def test_first_body_baseline_and_untrusted_signals_never_notify(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)

    async def scenario():
        source = Source("v1")
        receiver = Receiver()
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            notifier = dispatcher(path, transport=httpx.MockTransport(receiver))
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            # 重复检查、计数观察与聚合代次推进都不产生动态变化事件。
            for _ in range(2):
                await collector.check_once(UID, DYNAMIC)
                await collector.execute_pending()
                await notifier.run_once()
            assert deliveries(path) == []
            # 未知/无效编辑信号（只有分钟没有日期）不能冒充新版本。
            source.page = "no-date"
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            await notifier.run_once()
            assert deliveries(path) == [] and events(path) == []
            # 受限终态同样不产生变化事件。
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            await notifier.run_once()
            assert deliveries(path) == []
        assert receiver.requests == []
        assert Store(path).read_archive(DYNAMIC)["text"] == "第一版"

    asyncio.run(scenario())


def test_body_failure_then_success_notifies_exactly_once(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)

    async def scenario():
        source = Source("v1")
        receiver = Receiver()
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            notifier = dispatcher(path, transport=httpx.MockTransport(receiver))
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            source.page, source.body_error = "v2", True
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            await notifier.run_once()
            assert receiver.requests == []  # 只有观察值变化，正文未成功归档。
            assert deliveries(path) == []
            assert Store(path).read_archive(DYNAMIC)["text"] == "第一版"
            source.body_error = False
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            await notifier.run_once()
            assert len(receiver.requests) == 1
            # 重复同步与普通重启不重复生成事件。
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            await dispatcher(path, transport=httpx.MockTransport(receiver)).run_once()
        assert len(receiver.requests) == 1
        assert len(events(path)) == 1
        assert query(path, "SELECT COUNT(*) AS total FROM notification_versions")[0]["total"] == 2

    asyncio.run(scenario())


def test_body_success_notifies_while_media_and_comments_still_fail(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)

    async def scenario():
        source = Source("v1")
        uploader = FailingUploader()
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client, \
                httpx.AsyncClient(transport=httpx.MockTransport(media_download)) as media:
            collector = Collector(Store(path), client, ImageDownloader(media), uploader)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            receiver = Receiver()
            notifier = dispatcher(path, transport=httpx.MockTransport(receiver))
            source.page, source.comments_error = "v2", True
            source.pictures = [{"url": "https://i0.hdslb.com/fake.png", "width": 1, "height": 1}]
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            await notifier.run_once()
        archive = Store(path).read_archive(DYNAMIC)
        assert archive["text"] == "第二版"
        # 评论计数观察失败、媒体上传失败都不阻止正文通知，也不冒充正文成功。
        assert Store(path).read_checks(UID)[0]["observed"]["comment_count_status"] == "failed"
        assert archive["work"]["media"] == "pending"
        assert uploader.attempts > 0
        assert len(receiver.requests) == 1
        assert "动态【123】发生变化" in message_text(receiver.payloads[0])

    asyncio.run(scenario())


def test_rollback_of_event_and_content_leaves_no_partial_notification(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)

    async def scenario():
        source = Source("v1")
        receiver = Receiver()
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            baseline = Store(path).read_archive(DYNAMIC)["synced_version"]
            assert baseline is not None
            # 故障注入：同一事务的投递记录写入失败，正文与事件必须一起回滚。
            with sqlite3.connect(path) as database:
                database.execute("""CREATE TRIGGER fictional_delivery_failure
                    BEFORE INSERT ON notification_deliveries
                    BEGIN SELECT RAISE(ABORT, 'fictional delivery failure'); END""")
            source.page = "v2"
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            archive = Store(path).read_archive(DYNAMIC)
            assert archive["text"] == "第一版"
            assert archive["synced_version"] == baseline
            assert events(path) == [] and deliveries(path) == []
            with sqlite3.connect(path) as database:
                database.execute("DROP TRIGGER fictional_delivery_failure")
            # 事务回滚后工作仍可重试；成功才发送，且只发送一次。
            await collector.execute_pending()
            assert len(events(path)) == 1
            await dispatcher(path, transport=httpx.MockTransport(receiver)).run_once()
            await dispatcher(path, transport=httpx.MockTransport(receiver)).run_once()
        assert len(receiver.requests) == 1
        assert Store(path).read_archive(DYNAMIC)["text"] == "第二版"
        assert deliveries(path)[0]["state"] == "sent"

    asyncio.run(scenario())


def test_stop_before_body_commit_keeps_content_without_new_notification(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)

    async def scenario():
        source = Source("v1")
        gate = {"enter": asyncio.Event(), "release": asyncio.Event(), "blocked": False}

        async def gated(request):
            if gate["blocked"] and request.url.path.startswith("/opus/"):
                gate["enter"].set()
                await gate["release"].wait()
            return source(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(gated)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            receiver = Receiver()
            source.page = "v2"
            await collector.check_once(UID, DYNAMIC)
            gate["blocked"] = True
            running = asyncio.create_task(collector.execute_pending())
            await gate["enter"].wait()
            # 停止监控走真实管理 HTTP；在途采集仍可按原规则保存内容。
            with archive_client(path) as api:
                assert set_specified(api, enabled=False).status_code == 200
            gate["release"].set()
            await running
            await dispatcher(path, transport=httpx.MockTransport(receiver)).run_once()
        assert Store(path).read_archive(DYNAMIC)["text"] == "第二版"
        assert receiver.requests == []
        assert deliveries(path) == []

    asyncio.run(scenario())


def test_reselection_rebuilds_baseline_and_old_inflight_execution_cannot_notify(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)

    async def scenario():
        source = Source("v1")
        gate = {"enter": asyncio.Event(), "release": asyncio.Event(), "blocked": False}

        async def gated(request):
            if gate["blocked"] and request.url.path.startswith("/opus/"):
                gate["enter"].set()
                await gate["release"].wait()
            return source(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(gated)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            receiver = Receiver()
            notifier = dispatcher(path, transport=httpx.MockTransport(receiver))
            source.page = "v2"
            await collector.check_once(UID, DYNAMIC)
            gate["blocked"] = True
            running = asyncio.create_task(collector.execute_pending())
            await gate["enter"].wait()
            with archive_client(path) as api:
                assert set_specified(api, enabled=False).status_code == 200
                assert set_specified(api, enabled=True).status_code == 200
            gate["release"].set()
            await running
            gate["blocked"] = False
            await notifier.run_once()
            # 旧任务不能借新入选阶段产生通知。
            assert receiver.requests == []
            assert deliveries(path) == []
            # 恢复后的第一份可信正文重建基线（不追补暂停期间编辑），其后的变化才通知。
            source.edited = "13:10"
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            await notifier.run_once()
            assert receiver.requests == []
            source.edited = "13:20"
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            await notifier.run_once()
        assert len(receiver.requests) == 1
        assert len(events(path)) == 1
        phases = query(path, "SELECT sealed FROM notification_phases ORDER BY started_at")
        assert [row["sealed"] for row in phases] == [1, 0]  # 旧阶段封存，新阶段独立

    asyncio.run(scenario())


def test_configuration_reset_keeps_phase_and_never_resets_baseline(tmp_path):
    """入选令牌 reset 会轮换全部目标，持续入选的通知阶段必须续存。"""
    path = tmp_path / "archive.sqlite"
    configured(path)

    async def scenario():
        source = Source("v1")
        receiver = Receiver()
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            notifier = dispatcher(path, transport=httpx.MockTransport(receiver))
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            source.page = "v2"
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            await notifier.run_once()
            assert len(receiver.requests) == 1
            before = query(path, "SELECT token, started_at FROM notification_phases")
            selected_before = query(path, "SELECT token FROM target_selections")[0]["token"]
            # 生产 reset 路径（recent_n/模式变化时调用）整体轮换入选令牌，目标仍持续入选。
            with Store(path).connection() as connection:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    refresh_selections(connection, UID, reset=True)
                    connection.commit()
                except BaseException:
                    connection.rollback()
                    raise
            selected_after = query(path, "SELECT token FROM target_selections")[0]["token"]
            assert selected_after != selected_before  # 入选令牌确实轮换
            after = query(path, "SELECT token, started_at, sealed FROM notification_phases")
            assert after == [{**row, "sealed": 0} for row in before]  # 同一阶段，未重设起点
            await notifier.run_once()
            assert len(receiver.requests) == 1  # 不重复已登记事件
            source.edited = "13:10"
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()
            await notifier.run_once()
        # 续选阶段下的新变化照常通知（没有退回“重建基线”的静默）。
        assert len(receiver.requests) == 2
        assert len(events(path)) == 2

    asyncio.run(scenario())


def test_explicit_api_initialization_registers_event_without_delivering(tmp_path):
    path = tmp_path / "archive.sqlite"
    configured(path)
    source = Source("v1")

    async def baseline():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client)
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()

    asyncio.run(baseline())
    source.page = "v2"

    async def observe_change():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            assert await Collector(Store(path), client).check_once(UID, DYNAMIC)

    asyncio.run(observe_change())
    # API 的显式初始化也是归档写入口：登记事实，但绝对不投递（无内嵌通知定时器）。
    with archive_client(path, source) as api:
        assert api.post("/api/sync/initial", json={"uid": UID}).status_code == 200
        assert api.get("/api/manage/ups").status_code == 200
    rows = deliveries(path)
    assert [(row["state"], row["attempts"], row["sent_at"]) for row in rows] == [("pending", 0, None)]
    assert Store(path).read_archive(DYNAMIC)["work"]["text"] == "success"
