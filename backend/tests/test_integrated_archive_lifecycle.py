"""30 / T2-T3：编辑、计数和媒体组合经公开执行入口、真实 SQLite 与只读 HTTP。"""

import asyncio
import json

import httpx

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.media import ImageDownloader
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client, author_html, readable_html
from backend.tests.collector_clock import ControlledClock
from backend.tests.collector_support import CHECKS, configured
from backend.tests.management_support import UID
from backend.tests.test_comment_sync_status import CommentSource, snapshot, ARCHIVE
from backend.tests.test_recent_window_content import DYNAMIC_PICS, RecordingOSS, ROOT_ID, read_all


class LifecycleOSS(RecordingOSS):
    def __init__(self):
        super().__init__()
        self.fail = False

    async def upload(self, key, content, content_type):
        if self.fail:
            raise RuntimeError("FICTIONAL_SECRET_OSS https://secret.invalid/token")
        return await super().upload(key, content, content_type)


def download(request):
    assert request.url.host == "i0.hdslb.com"
    return httpx.Response(200, content=b"fictional image bytes", headers={"Content-Type": "image/png"})


def test_trusted_edit_updates_body_and_media_with_actual_part_times_and_retries_after_reopen(tmp_path, caplog):
    path = tmp_path / "lifecycle.sqlite"
    configured(path)
    source, clock, oss = CommentSource(), ControlledClock(), LifecycleOSS()
    source.html = readable_html("original", pictures=[DYNAMIC_PICS[0]])

    async def scenario():
        with archive_client(path) as api:
            unchecked = api.get(CHECKS).json()["checks"][0]
            assert unchecked["check_status"] == "unchecked"
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client, httpx.AsyncClient(
            transport=httpx.MockTransport(download)
        ) as media_client:
            collector = Collector(Store(path), client, ImageDownloader(media_client), oss, clock=clock)
            await collector.check_once(UID, "123")
            clock.advance(15)
            await collector.execute_pending()
            before, saved = snapshot(path)
            assert before["work"] == "complete"
            assert before["media_errors"] == before["comment_media_errors"] == []
            for field in ("text_last_succeeded_at", "media_last_succeeded_at", "comment_media_last_succeeded_at"):
                assert unchecked[field] is None
                assert before[field] == "2030-01-01T00:00:15+00:00"
            assert saved["text"] == "original"
            source.html = readable_html("edited", pictures=[DYNAMIC_PICS[1]]).replace("13:01", "13:02")
            oss.fail = True
            clock.advance(30)
            await collector.check_once(UID, "123")
            clock.advance(45)
            await collector.execute_pending()
            failed, archive = snapshot(path)
            assert archive["text"] == "edited"
            assert archive["synced_version"] == "2026-10-09T13:02+08:00"
            assert archive["media_sources"] == [DYNAMIC_PICS[1]]
            assert archive["media"][0]["status"] == "failed"
            assert archive["media"][0]["public_url"] is None
            assert archive["previous_media"] == saved["media"]
            assert failed["parts"] == {"text": "success", "media": "pending", "comments": "success",
                                       "replies": "success", "comment_media": "success"}
            assert failed["work"] == "pending" and failed["sync_error"] == "SYNC_INCOMPLETE"
            assert failed["media_errors"] == ["MEDIA_UPLOAD_FAILED"]
            assert failed["comment_media_errors"] == []
            assert failed["text_last_succeeded_at"] == "2030-01-01T00:00:45+00:00"
            assert failed["media_last_succeeded_at"] == before["media_last_succeeded_at"]
            assert failed["comment_media_last_succeeded_at"] == before["comment_media_last_succeeded_at"]
            assert failed["comments_last_succeeded_at"] == before["comments_last_succeeded_at"]
            # 重开、不改变可信信号；重试只处理失败媒体，不把无变化检查时间当成功时间。
            oss.fail = False
            source.calls.clear()
            clock.advance(60)
            collector = Collector(Store(path), client, ImageDownloader(media_client), oss, clock=clock)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            current, archive = snapshot(path)
            assert current["check_status"] == "unchanged" and current["revision"] == failed["revision"]
            assert current["work"] == "complete"
            assert current["media_errors"] == current["comment_media_errors"] == []
            assert current["text_last_succeeded_at"] == failed["text_last_succeeded_at"]
            assert current["media_last_succeeded_at"] == current["last_succeeded_at"] == "2030-01-01T00:01:00+00:00"
            assert archive["media"][0]["public_url"].startswith("https://archive.example.invalid/bili-charge/dynamics/123/")
            assert source.calls == ["/opus/123", "/x/v2/reply/count"]
            source.html = readable_html("not a trusted edit", pictures=[DYNAMIC_PICS[0]]).replace("13:01", "13:02")
            clock.advance(75)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            unchanged, unchanged_archive = snapshot(path)
            assert unchanged_archive["text"] == "edited"
            assert unchanged["media_last_succeeded_at"] == current["media_last_succeeded_at"]
            assert unchanged["text_last_succeeded_at"] == current["text_last_succeeded_at"]
            assert "FICTIONAL_SECRET" not in json.dumps(unchanged_archive) + caplog.text
            assert "secret.invalid" not in json.dumps(failed) + caplog.text

    asyncio.run(scenario())


def test_count_change_media_retry_and_new_observation_keep_independent_checkpoints_and_times(tmp_path):
    path = tmp_path / "comments.sqlite"
    configured(path)
    source, clock = CommentSource(), ControlledClock()
    root = source.roots[0]
    root["content"]["message"] = ""  # 纯图根；另一根保持独立 owner。

    def picture(url):
        root["content"]["pictures"] = [{"img_src": url, "img_width": 640, "img_height": 480}]

    picture(DYNAMIC_PICS[0]["url"])

    async def scenario():
        blocked, release = asyncio.Event(), asyncio.Event()
        pause = False

        class DelayedOSS(LifecycleOSS):
            async def upload(self, key, content, content_type):
                if pause:
                    blocked.set()
                    await release.wait()
                return await super().upload(key, content, content_type)

        oss = DelayedOSS()
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client, httpx.AsyncClient(
            transport=httpx.MockTransport(download)
        ) as media_client:
            collector = Collector(Store(path), client, ImageDownloader(media_client), oss, clock=clock)
            await collector.check_once(UID, "123")
            clock.advance(15)
            await collector.execute_pending()
            baseline, _ = snapshot(path)
            assert baseline["synced_comment_count"] == 70
            # 计数变化自动根+回复+一级评论图；回复分页失败不推进整轮 checkpoint。
            source.count = 71
            source.roots[0]["rcount"] = 6  # 楼中楼增量判定依据根 rcount
            picture("https://i0.hdslb.com/bfs/new/comment-v2.png")
            source.fail_reply_page = 2
            clock.advance(30)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            partial, _ = snapshot(path)
            assert partial["synced_root_comment_count"] == 71
            assert partial["synced_reply_comment_count"] == partial["synced_comment_count"] == 70
            assert partial["root_comments_last_succeeded_at"] == "2030-01-01T00:00:30+00:00"
            assert partial["replies_last_succeeded_at"] == baseline["replies_last_succeeded_at"]
            assert partial["parts"]["comments"] == partial["parts"]["comment_media"] == "success"
            assert partial["parts"]["replies"] == "pending"
            assert partial["comment_media_last_succeeded_at"] == "2030-01-01T00:00:30+00:00"
            # 失败整轮允许同计数重新扫根；新图失败不倒退已成功的评论文本。
            source.fail_reply_page = None
            picture("https://i0.hdslb.com/bfs/new/comment-v3.png")
            oss.fail = True
            clock.advance(45)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            failed, _ = snapshot(path)
            assert failed["synced_comment_count"] == 71
            assert failed["parts"]["comments"] == failed["parts"]["replies"] == "success"
            assert failed["parts"]["comment_media"] == "pending"
            assert failed["comment_media_errors"] == ["MEDIA_UPLOAD_FAILED"]
            assert failed["media_errors"] == []
            assert failed["comments_last_succeeded_at"] == "2030-01-01T00:00:45+00:00"
            assert failed["comment_media_last_succeeded_at"] == partial["comment_media_last_succeeded_at"]
            with archive_client(path) as api:
                roots = read_all(api, ARCHIVE + "/comments")
                pictured = next(item for item in roots if item["id"] == ROOT_ID)
                assert pictured["text"] == ""
                assert pictured["media"][0]["owner"] == {"type": "comment", "id": ROOT_ID}
                assert pictured["media"][0]["status"] == "failed"
                assert pictured["media"][0]["public_url"] is None
                assert len(pictured["previous_media"]) == 2
                assert len(read_all(api, ARCHIVE + f"/comments/{ROOT_ID}/replies")) == 5
            # 同计数只重试媒体；上传中又观察到新计数，旧完成不吞掉新工作。
            source.calls.clear()
            pause, oss.fail = True, False
            clock.advance(60)
            task = asyncio.create_task(collector.execute_pending())
            try:
                await asyncio.wait_for(blocked.wait(), 3)
                running, _ = snapshot(path)
                assert running["work"] == "running"
                assert running["comments_last_succeeded_at"] == failed["comments_last_succeeded_at"]
                assert source.calls == []  # 媒体重试不请求正文、根或回复。
                source.count = 72
                clock.advance(75)
                await collector.check_once(UID, "123")
                observed, _ = snapshot(path)
                assert observed["work"] == "running" and observed["revision"] == failed["revision"] + 1
                assert observed["parts"]["comments"] == observed["parts"]["replies"] == "pending"
                clock.advance(90)
                release.set()
                await task
            finally:
                release.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            old, _ = snapshot(path)
            assert old["work"] == "pending" and old["synced_comment_count"] == 71
            assert old["observed"]["source_comment_count"] == 72
            assert old["last_succeeded_at"] == baseline["last_succeeded_at"]
            assert old["comment_media_last_succeeded_at"] == "2030-01-01T00:01:30+00:00"
            assert old["comments_last_succeeded_at"] == failed["comments_last_succeeded_at"]
            assert old["parts"]["comment_media"] == "pending"  # 最新观察仍未处理。
            pause = False
            clock.advance(105)
            # 重开后无新信号，旧任务未清除的较新工作继续执行。
            await Collector(Store(path), client, ImageDownloader(media_client), oss, clock=clock).execute_pending()
            current, archive = snapshot(path)
            assert current["work"] == "complete" and current["synced_comment_count"] == 72
            assert current["media_errors"] == current["comment_media_errors"] == []
            assert current["comment_media_last_succeeded_at"] == current["comments_last_succeeded_at"] == "2030-01-01T00:01:45+00:00"
            assert current["text_last_succeeded_at"] == baseline["text_last_succeeded_at"]
            assert archive["comment_sync"] == current
            with archive_client(path) as api:
                roots = read_all(api, ARCHIVE + "/comments")
                media = next(item for item in roots if item["id"] == ROOT_ID)["media"]
                assert media[0]["status"] == "success"
                assert media[0]["public_url"].startswith(f"https://archive.example.invalid/bili-charge/comments/123/{ROOT_ID}/")
                assert all("media" not in item for item in read_all(api, ARCHIVE + f"/comments/{ROOT_ID}/replies"))

    asyncio.run(scenario())


def test_restricted_body_and_invalid_edit_do_not_block_comment_recovery_or_invent_success_times(tmp_path):
    path = tmp_path / "restricted.sqlite"
    configured(path)
    source, clock = CommentSource(), ControlledClock()
    source.blocked = True
    source.html = author_html().replace("编辑于 2026年10月09日 13:01", "编辑于 来源格式不可解析")
    source.fail_root_page = 1

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=clock)
            await collector.check_once(UID, "123")
            clock.advance(15)
            await collector.execute_pending()
            failed, archive = snapshot(path)
            assert failed["check_status"] == "failed" and failed["check_error"] == "SIGNAL_INVALID"
            assert failed["sync_error"] == "SYNC_INCOMPLETE" and failed["work"] == "pending"
            assert failed["comments_error"] == "ROOT_COMMENTS_FAILED"
            assert failed["synced_comment_count"] is None
            assert archive["content_state"] == "restricted"
            for field in ("text_last_succeeded_at", "media_last_succeeded_at", "comment_media_last_succeeded_at",
                          "root_comments_last_succeeded_at", "replies_last_succeeded_at", "last_succeeded_at"):
                assert failed[field] is None
            source.fail_root_page = None
            clock.advance(30)
            await Collector(Store(path), client, clock=clock).execute_pending()
            partial, archive = snapshot(path)
            assert archive["content_state"] == "restricted"
            # 受限是稳定登记：正文分项不冒充成功，整轮收敛完成。
            assert partial["parts"]["text"] == "restricted"
            assert partial["parts"]["comments"] == partial["parts"]["replies"] == partial["parts"]["comment_media"] == "success"
            assert partial["synced_comment_count"] == 70
            assert partial["observed"]["source_comment_count"] == 70
            assert partial["work"] == "complete" and partial["last_succeeded_at"] is None
            assert partial["text_last_succeeded_at"] is partial["media_last_succeeded_at"] is None
            for field in ("root_comments_last_succeeded_at", "replies_last_succeeded_at", "comments_last_succeeded_at",
                          "comment_media_last_succeeded_at"):
                assert partial[field] == "2030-01-01T00:00:30+00:00"
            with archive_client(path) as api:
                assert len(read_all(api, ARCHIVE + "/comments")) == 2
                assert len(read_all(api, ARCHIVE + f"/comments/{ROOT_ID}/replies")) == 5
            # 正文恢复且实际确认无动态图：空媒体组也须有真实完成时间。
            source.blocked = False
            source.html = readable_html("now readable", pictures=[])
            clock.advance(45)
            await collector.check_once(UID, "123")
            await collector.execute_pending()
            complete, archive = snapshot(path)
            assert complete["work"] == "complete" and archive["text"] == "now readable"
            assert complete["text_last_succeeded_at"] == complete["media_last_succeeded_at"] == "2030-01-01T00:00:45+00:00"
            assert complete["comments_last_succeeded_at"] == partial["comments_last_succeeded_at"]

    asyncio.run(scenario())
