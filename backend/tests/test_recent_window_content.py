"""28 / T2-T3：近期目标经真实协议、共享采集链与 SQLite HTTP 保留完整内容。"""

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.media import ImageDownloader
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import (
    archive_client, archive_content, detail_json, readable_html, TARGETS,
)
from backend.tests.collector_clock import ControlledClock, eventually
from backend.tests.collector_support import CHECKS
from backend.tests.management_support import BASE, UID
from backend.tests.root_support import root_fixture


FIXTURES = Path(__file__).parent / "fixtures"
RECENT_ID = "9007199254741009"
ROOT_ID = "900719925474099312346"
ARCHIVE = f"/api/archive/dynamics/{RECENT_ID}"
DISCOVERY = f"{BASE}/{UID}/discovery"
DYNAMIC_PICS = [
    {"url": "https://i0.hdslb.com/bfs/new/first.png", "width": 640, "height": 480},
    {"url": "https://i0.hdslb.com/bfs/new/second.png", "width": 200, "height": 1200},
]
COMMENT_PIC = "https://i0.hdslb.com/bfs/new/comment.png"


@pytest.fixture(autouse=True)
def no_real_oss_environment(monkeypatch):
    for name in ("ENDPOINT", "REGION", "BUCKET", "ACCESS_KEY_ID", "ACCESS_KEY_SECRET",
                 "PUBLIC_BASE_URL", "SECURITY_TOKEN"):
        monkeypatch.delenv("BILI_OSS_" + name, raising=False)


def fixture_json(name):
    return json.loads((FIXTURES / name).read_text())


class RecentContentSource:
    """只替换外部传输；feed/detail/计数/根/回复仍穿透生产 JSON/HTML 解析。"""

    def __init__(self):
        self.feed_id = RECENT_ID
        self.calls = []
        self.downloads = []

    def __call__(self, request):
        path = request.url.path
        params = dict(request.url.params)
        self.calls.append((path, params))
        assert request.method == "GET"
        if path == "/x/polymer/web-dynamic/v1/feed/space":
            assert params["host_mid"] == UID
            assert "offset" not in params  # N=1 在首个合格候选即停止，不补扫历史。
            payload = fixture_json("recent-feed-page1.json")
            for item in payload["data"]["items"]:
                item["modules"]["module_author"]["mid"] = UID
                if item["id_str"] == RECENT_ID:
                    item["id_str"] = self.feed_id
            return httpx.Response(200, json=payload)
        if path.startswith("/opus/"):
            assert path == f"/opus/{RECENT_ID}"
            html = readable_html(id=RECENT_ID, pictures=DYNAMIC_PICS).replace(
                "编辑于 2026年10月09日 13:01", "刚刚")
            return httpx.Response(200, text=html)
        if path == "/x/polymer/web-dynamic/v1/detail":
            assert params["id"] == RECENT_ID
            payload = detail_json()
            payload["data"]["item"]["id_str"] = RECENT_ID
            payload["data"]["item"]["modules"]["module_dynamic"]["major"]["opus"]["pics"] = DYNAMIC_PICS
            return httpx.Response(200, json=payload)
        assert params["oid"] == "99123"  # 可信 locator，不用近期动态 ID 猜评论资源。
        assert params["type"] == "17"
        if path == "/x/v2/reply/count":
            return httpx.Response(200, json=fixture_json("comment-count.json"))
        assert path in ("/x/v2/reply", "/x/v2/reply/reply")
        assert params["ps"] == "20"
        page = int(params["pn"])
        if path == "/x/v2/reply":
            assert params["sort"] == "0"
            payload = root_fixture()
            payload["data"]["replies"][0]["content"]["pictures"][0]["img_src"] = COMMENT_PIC
        else:
            assert params["root"] == ROOT_ID
            payload = fixture_json("replies.json")
        payload["data"]["page"]["num"] = page
        items = payload["data"]["replies"]
        payload["data"]["replies"] = items[(page - 1) * 20:page * 20] or None
        return httpx.Response(200, json=payload)

    def download(self, request):
        url = str(request.url)
        assert url in [pic["url"] for pic in DYNAMIC_PICS] + [COMMENT_PIC]
        self.downloads.append(url)
        return httpx.Response(200, content=b"fictional image bytes", headers={"Content-Type": "image/png"})


class RecordingOSS:
    def __init__(self):
        self.keys = []

    async def upload(self, key, content, content_type):
        assert content == b"fictional image bytes"
        assert content_type == "image/png"
        self.keys.append(key)
        return "https://archive.example.invalid/" + key


def configure_recent(path, *, enabled=True):
    with archive_client(path) as api:
        response = api.patch(f"{BASE}/{UID}/monitor", json={
            "mode": "recent", "recent_n": 1, "enabled": enabled,
        })
        assert response.status_code == 200


def prepare_recent(path):
    with archive_client(path) as api:
        assert api.post(BASE, json={"uid": UID}).status_code == 201
    configure_recent(path)


def read_state(path):
    with archive_client(path) as api:
        discovery = api.get(DISCOVERY)
        checks = api.get(CHECKS)
        assert discovery.status_code == checks.status_code == 200
        return discovery.json(), {item["id"]: item for item in checks.json()["checks"]}


def read_all(api, url):
    items, params = [], {}
    while True:
        response = api.get(url, params=params)
        assert response.status_code == 200
        batch = response.json()
        items.extend(batch["items"])
        if batch["next_cursor"] is None:
            return items
        params = {"cursor": batch["next_cursor"]}


def read_content(path):
    # 不提供任何内容上游 handler：归档、scope、身份和分页读取只能依赖真实 SQLite。
    with archive_client(path) as api:
        detail = api.get(ARCHIVE)
        assert detail.status_code == 200
        content = archive_content(detail.json())  # 仅排除可变的实时检查投影。
        for params in ({"scope": "all"}, {"scope": "up", "uid": UID}):
            response = api.get("/api/archive/dynamics", params=params)
            assert response.status_code == 200
            assert response.json()["items"] == [content]
        identities = api.get("/api/archive/ups")
        assert identities.status_code == 200
        assert [up["id"] for up in identities.json()["ups"]] == [UID]
        roots = read_all(api, ARCHIVE + "/comments")
        replies = read_all(api, ARCHIVE + f"/comments/{ROOT_ID}/replies")
        return content, roots, replies


def assert_complete_content(saved):
    archive, roots, replies = saved
    assert archive["author"]["id"] == UID
    assert archive["text"] == "虚构全文\n第二行 <b>仍是文本</b> 🙂"
    assert archive["edit_status"] == "unknown"  # 无编辑标记不能漏掉首次完整初始化。
    assert archive["work"] == dict.fromkeys(("text", "media", "comments", "replies"), "success")
    assert archive["source_comment_count"] == archive["synced_comment_count"] == 7
    assert archive["local_comment_count"] == len(roots) == 2
    assert archive["local_reply_count"] == len(replies) == 5
    assert [root["id"] for root in roots] == [ROOT_ID, "2"]
    assert roots[0]["text"] == "已有根评论\n<b>只作文本</b> 🙂"
    assert replies[0]["text"] == "已有回复 <b>文本</b> 🙂"
    assert {reply["id"] for reply in replies} == {
        "900719925474099312350", "900719925474099312351", "900719925474099312352",
        "900719925474099312353", "900719925474099312354",
    }
    assert all(reply["root_id"] == ROOT_ID and reply["dynamic_id"] == RECENT_ID for reply in replies)
    assert roots[0]["work"]["media"] == roots[1]["work"]["media"] == "success"
    for owner, media, sources in (
        ({"type": "dynamic", "id": RECENT_ID}, archive["media"], DYNAMIC_PICS),
        ({"type": "comment", "id": ROOT_ID}, roots[0]["media"], [
            {"url": COMMENT_PIC, "width": 640, "height": 480},
        ]),
    ):
        assert len(media) == len(sources)
        for position, (item, source) in enumerate(zip(media, sources)):
            assert item["owner"] == owner
            assert item["position"] == position
            assert item["source_url"] == source["url"]
            assert (item["width"], item["height"]) == (source["width"], source["height"])
            assert item["status"] == "success" and item["error"] is None
            # 对象键以 bili-charge/ 为命名空间前缀；评论媒体按 动态/根评论 两级归属。
            namespace = f"bili-charge/dynamics/{RECENT_ID}/"
            if owner["type"] == "comment":
                namespace = f"bili-charge/comments/{RECENT_ID}/{ROOT_ID}/"
            assert item["public_url"].startswith("https://archive.example.invalid/" + namespace)
            # 后缀按下载响应的 MIME 决定，不沿用来源 URL 的路径。
            assert item["public_url"].endswith(".png")
            assert item["public_url"] != item["source_url"]


def test_recent_full_content_survives_window_exit_stop_delete_and_reinclusion(tmp_path):
    path = tmp_path / "recent-content.sqlite"
    prepare_recent(path)
    source, uploader = RecentContentSource(), RecordingOSS()

    async def scenario():
        clock = ControlledClock()
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client, httpx.AsyncClient(
            transport=httpx.MockTransport(source.download)
        ) as media_client:
            collector = Collector(Store(path), client, ImageDownloader(media_client), uploader, clock=clock)
            assert await collector.discover_once(UID)
            discovery, checks = read_state(path)
            assert discovery["current_ids"] == [RECENT_ID]
            assert checks[RECENT_ID]["active"] and checks[RECENT_ID]["check_status"] == "unchecked"
            with archive_client(path) as api:
                assert api.get(ARCHIVE).status_code == 404
                assert api.get(TARGETS).json() == {"targets": []}
            assert await collector.check_once(UID, RECENT_ID)
            assert read_state(path)[1][RECENT_ID]["work"] == "pending"
            await collector.execute_pending()
            baseline = read_content(path)
            assert_complete_content(baseline)
            completed = read_state(path)[1][RECENT_ID]
            assert completed["work"] == "complete" and completed["last_succeeded_at"] == clock.now()
            assert completed["parts"] == dict.fromkeys(
                ("text", "media", "comments", "replies", "comment_media"), "success")
            assert len(uploader.keys) == len(source.downloads) == 3
            assert [params["pn"] for route, params in source.calls if route == "/x/v2/reply"] == ["1", "2", "2"]
            assert [params["pn"] for route, params in source.calls if route == "/x/v2/reply/reply"] == ["1", "2", "2"]

            # 相同窗口、相同信号只检查；不能重新初始化、重复下载或上传成功内容。
            source.calls.clear()
            clock.advance(15)
            assert await collector.discover_once(UID)
            assert await collector.check_once(UID, RECENT_ID)
            await collector.execute_pending()
            assert {route for route, _ in source.calls} == {
                "/x/polymer/web-dynamic/v1/feed/space", f"/opus/{RECENT_ID}", "/x/v2/reply/count",
            }
            assert read_content(path) == baseline
            assert read_state(path)[1][RECENT_ID]["revision"] == completed["revision"]

            source.feed_id = "124"
            assert await collector.discover_once(UID)
            discovery, checks = read_state(path)
            assert discovery["current_ids"] == ["124"]
            assert not checks[RECENT_ID]["active"] and checks["124"]["active"]
            source.calls.clear()
            assert not await collector.check_once(UID, RECENT_ID)
            await collector.execute_pending()  # 新目标尚未检查，不冒领或补扫其他动态。
            assert source.calls == []
            assert read_content(path) == baseline
            with archive_client(path) as api:
                assert api.get("/api/archive/dynamics/124").status_code == 404
                assert api.get(TARGETS).json() == {"targets": []}

            configure_recent(path, enabled=False)
            discovery, checks = read_state(path)
            assert discovery["current_ids"] == [] and discovery["trusted_result"]["ids"] == ["124"]
            assert all(not check["active"] for check in checks.values())
            assert not await collector.discover_once(UID)
            assert not await collector.check_once(UID, "124")
            await collector.execute_pending()
            assert source.calls == []
            assert read_content(path) == baseline

            with archive_client(path) as api:
                assert api.delete(f"{BASE}/{UID}/monitor").status_code == 204
            discovery, checks = read_state(path)
            assert discovery["mode"] is None and discovery["current_ids"] == []
            assert all(not check["active"] for check in checks.values())
            assert not await collector.discover_once(UID)
            assert not await collector.check_once(UID, RECENT_ID)
            await collector.execute_pending()
            assert source.calls == []
            assert read_content(path) == baseline  # 每次读取都关闭重开 HTTP 应用／数据库。

            with archive_client(path) as api:
                assert api.post(BASE, json={"uid": UID}).status_code == 201
            configure_recent(path)
            source.feed_id = RECENT_ID
            clock.advance(30)
            # 使用新 Store / Collector，不能凭旧对象的内存状态保持归档或去重。
            reopened = Collector(Store(path), client, ImageDownloader(media_client), uploader, clock=clock)
            assert await reopened.discover_once(UID)
            assert await reopened.check_once(UID, RECENT_ID)
            await reopened.execute_pending()
            discovery, checks = read_state(path)
            assert discovery["current_ids"] == [RECENT_ID]
            assert {id for id, check in checks.items() if check["active"]} == {RECENT_ID}
            assert checks[RECENT_ID]["work"] == "complete"
            assert checks[RECENT_ID]["revision"] == completed["revision"]
            assert checks[RECENT_ID]["last_succeeded_at"] == completed["last_succeeded_at"]
            assert read_content(path) == baseline
            assert len(uploader.keys) == len(source.downloads) == 3
            assert {route for route, _ in source.calls} == {
                "/x/polymer/web-dynamic/v1/feed/space", f"/opus/{RECENT_ID}", "/x/v2/reply/count",
            }
            with archive_client(path) as api:
                assert api.get(TARGETS).json() == {"targets": []}

    asyncio.run(scenario())


def test_cancelled_recent_media_sync_recovers_only_in_locked_run_then_completes(tmp_path):
    path = tmp_path / "recent-recovery.sqlite"
    prepare_recent(path)
    source = RecentContentSource()

    async def scenario():
        blocked, release = asyncio.Event(), asyncio.Event()
        clock = ControlledClock()

        class DelayedOSS(RecordingOSS):
            def __init__(self):
                super().__init__()
                self.attempts = []

            async def upload(self, key, content, content_type):
                self.attempts.append(key)
                blocked.set()
                await release.wait()  # 仅延迟外部 I/O，不 mock 工作领取／恢复／同步函数。
                return await super().upload(key, content, content_type)

        uploader = DelayedOSS()
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client, httpx.AsyncClient(
            transport=httpx.MockTransport(source.download)
        ) as media_client:
            collector = Collector(Store(path), client, ImageDownloader(media_client), uploader, clock=clock)
            assert await collector.discover_once(UID)
            assert await collector.check_once(UID, RECENT_ID)
            execution = asyncio.create_task(collector.execute_pending())
            restarted = None
            try:
                await asyncio.wait_for(blocked.wait(), 3)
                running = read_state(path)[1][RECENT_ID]
                assert running["work"] == "running" and running["last_succeeded_at"] is None
                partial = read_content(path)
                assert partial[0]["work"] == {
                    "text": "success", "media": "pending", "comments": "success", "replies": "success",
                }
                assert partial[0]["local_comment_count"] == 2 and partial[0]["local_reply_count"] == 5
                # 上传等待期间管理写入和保留读取正常，不被网络 I/O 锁住。
                configure_recent(path, enabled=False)
                execution.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await execution
                interrupted = read_state(path)[1][RECENT_ID]
                assert interrupted["work"] == "running" and not interrupted["active"]
                assert interrupted["revision"] == running["revision"]
                for _ in range(2):
                    assert read_state(path)[1][RECENT_ID] == interrupted
                    assert read_content(path) == partial  # API 重开不能擅自恢复 running。
                source.calls.clear()
                await Collector(Store(path), client, clock=clock).execute_pending()
                assert source.calls == [] and read_state(path)[1][RECENT_ID] == interrupted

                blocked.clear()
                restarted = asyncio.create_task(Collector(
                    Store(path), client, ImageDownloader(media_client), uploader, clock=clock,
                ).run())
                # 先停用来观察正式 run 持锁恢复到 pending，随后才允许下一节拍重新领取。
                await eventually(lambda: read_state(path)[1][RECENT_ID]["work"] == "pending"
                                 and clock.deadlines == [15])
                recovered = read_state(path)[1][RECENT_ID]
                assert recovered["revision"] == interrupted["revision"]
                assert recovered["observed"] == interrupted["observed"]
                assert recovered["last_succeeded_at"] is None
                assert read_content(path) == partial
                assert source.calls == []
                configure_recent(path)
                clock.advance(15)
                await asyncio.wait_for(blocked.wait(), 3)
                assert read_state(path)[1][RECENT_ID]["work"] == "running"
                with pytest.raises(RuntimeError, match="Collector already running"):
                    await Collector(Store(path), client, clock=ControlledClock()).run()
                assert read_state(path)[1][RECENT_ID]["work"] == "running"
                release.set()
                await eventually(lambda: read_state(path)[1][RECENT_ID]["work"] == "complete")
                final = read_content(path)
                assert_complete_content(final)
                completed = read_state(path)[1][RECENT_ID]
                assert completed["revision"] == interrupted["revision"]
                assert completed["last_succeeded_at"] == clock.now()
                assert completed["sync_error"] is None
                assert final[0]["text"] == partial[0]["text"]
                assert final[0]["comments_last_succeeded_at"] == partial[0]["comments_last_succeeded_at"]
                assert final[2] == partial[2]
                assert final[1][0]["text"] == partial[1][0]["text"]
                assert len(uploader.keys) == 3 and len(uploader.attempts) == 4
                assert len(set(uploader.attempts)) == 4  # 中断上传不复用旧 PUT 对象 key。
                assert uploader.attempts[0] not in uploader.keys
                assert not any(route in ("/x/polymer/web-dynamic/v1/detail", "/x/v2/reply", "/x/v2/reply/reply")
                               for route, _ in source.calls)
                await eventually(lambda: clock.deadlines == [15, 30])
            finally:
                release.set()
                execution.cancel()
                tasks = [execution]
                if restarted is not None:
                    restarted.cancel()
                    tasks.append(restarted)
                await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(scenario())
