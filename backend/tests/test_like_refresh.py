"""01／03：凌晨窗口驱动的根评论点赞刷新与刷新会话的副作用隔离。

临时 SQLite＋替身来源＋受控时钟，其余全用真实持久层、限速、租约与会话状态机。
"""

import asyncio
import copy
import json
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from backend.bili_monitor.collector import (
    LIKE_REFRESH_SECONDS, LIKE_REFRESH_WINDOW, Collector, like_refresh_configuration,
    like_refresh_due, like_refresh_window_open,
)
from backend.bili_monitor.dispatch import DispatchLeases
from backend.bili_monitor.media import ImageDownloader
from backend.bili_monitor.source_endpoints import ROOT_COMMENTS_URL
from backend.bili_monitor.source_transport import PAGE_DELAYS, PacedSourceTransport
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client, readable_html
from backend.tests.collector_clock import ControlledClock, eventually
from backend.tests.collector_support import configured, empty_upstream
from backend.tests.management_support import UID
from backend.tests.root_support import root_fixture
from backend.tests.test_flow_logs import captured_logs


ARCHIVE = "/api/archive/dynamics/123"
COMMENTS = ARCHIVE + "/comments"
PICTURES = [
    {"img_src": "https://i0.hdslb.com/bfs/new/first.png", "img_width": 640, "img_height": 480},
    {"img_src": "https://i0.hdslb.com/bfs/new/second.png", "img_width": 200, "img_height": 1200},
]
# 凌晨窗口是北京时间整点时段：起点含、终点不含，与心跳整分钟窗口同形态。
BEIJING = timezone(timedelta(hours=8))
FIXTURES = Path(__file__).parent / "fixtures"


def beijing(hour, minute=0, day=2):
    """北京时间 → 受控时钟起点（UTC 时刻）。"""
    return datetime(2030, 1, day, hour, minute, tzinfo=BEIJING).astimezone(timezone.utc)


def at(hour, minute=0, day=2):
    return beijing(hour, minute, day).isoformat(timespec="seconds")


def test_night_window_is_a_beijing_whole_minute_window():
    assert LIKE_REFRESH_WINDOW == ("02:00", "05:00")
    assert like_refresh_window_open(at(1, 59)) is False
    assert like_refresh_window_open(at(2, 0)) is True
    assert like_refresh_window_open(at(3, 30)) is True
    assert like_refresh_window_open(at(4, 59)) is True
    assert like_refresh_window_open(at(5, 0)) is False
    assert like_refresh_window_open(at(5, 1)) is False
    # 同一时刻换一种写法：北京 02:00 就是前一日 18:00Z，判定不能跟着字符串时区漂移。
    assert like_refresh_window_open(beijing(2, 0).isoformat()) is True
    # 窗口本身可配置，仍按整分钟起点含、终点不含。
    assert like_refresh_window_open(at(1, 30), ("01:00", "02:00")) is True
    assert like_refresh_window_open(at(2, 0), ("01:00", "02:00")) is False


def test_refresh_is_due_when_anchor_missing_or_interval_elapsed():
    assert LIKE_REFRESH_SECONDS == 24 * 60 * 60
    now = at(2, 30)
    assert like_refresh_due(None, now) is True
    assert like_refresh_due(at(2, 30, day=1), now) is True
    assert like_refresh_due(at(2, 31, day=1), now) is False
    assert like_refresh_due(at(2, 30, day=1), now, 3600) is True
    # 间隔 0 关闭该通道：无论锚点为空还是很久以前都不到期。
    assert like_refresh_due(None, now, 0) is False
    assert like_refresh_due(at(2, 30, day=1), now, 0) is False


def test_refresh_configuration_defaults_and_invalid_values_fall_back(monkeypatch):
    for name in ("BILI_COLLECTOR_LIKE_REFRESH_SECONDS", "BILI_COLLECTOR_LIKE_REFRESH_WINDOW"):
        monkeypatch.delenv(name, raising=False)
    config = like_refresh_configuration()
    assert config["interval"] == 86400
    assert config["window"] == ("02:00", "05:00")
    assert config["interval_source"] == config["window_source"] == "default"

    monkeypatch.setenv("BILI_COLLECTOR_LIKE_REFRESH_SECONDS", "0")
    monkeypatch.setenv("BILI_COLLECTOR_LIKE_REFRESH_WINDOW", "03:10-04:20")
    config = like_refresh_configuration()
    assert config["interval"] == 0
    assert config["window"] == ("03:10", "04:20")
    assert config["interval_source"] == config["window_source"] == "environment"

    monkeypatch.setenv("BILI_COLLECTOR_LIKE_REFRESH_SECONDS", "每天")
    monkeypatch.setenv("BILI_COLLECTOR_LIKE_REFRESH_WINDOW", "05:00-02:00")
    config = like_refresh_configuration()
    assert config["interval"] == 86400
    assert config["window"] == ("02:00", "05:00")
    # 非法值可观测：来源标成 invalid，启动日志据此告警。
    assert config["interval_source"] == config["window_source"] == "invalid"


class LikeSource:
    """仅替换外部 HTTP：原始根／楼中楼 JSON，点赞数可控，根页可受控失败一次。"""

    def __init__(self):
        self.roots = copy.deepcopy(root_fixture()["data"]["replies"])
        for root in self.roots:
            root["content"]["pictures"] = []
        self.replies = json.loads((FIXTURES / "replies.json").read_text())["data"]["replies"]
        self.count = len(self.roots) + len(self.replies)
        self.fail_root_page = None
        self.fail_reply_page = None
        self.fail_replies = False
        self.shrink_at_page = None
        self.calls = []

    def __call__(self, request):
        path = request.url.path
        params = dict(request.url.params)
        self.calls.append((path, params))
        if path.startswith("/opus/"):
            # 正文页按实际请求的动态回显身份：多目标用例里另一条动态也要能归档正文。
            return httpx.Response(200, text=readable_html(pictures=[], id=path.rsplit("/", 1)[-1]))
        if path == "/x/v2/reply/count":
            payload = json.loads((FIXTURES / "comment-count.json").read_text())
            payload["data"]["count"] = self.count
            return httpx.Response(200, json=payload)
        if path == "/x/v2/reply":
            number = int(params["pn"])
            if self.fail_root_page == number:
                self.fail_root_page = None
                raise httpx.ReadError("FICTIONAL_SECRET_ROOT_PAGE")
            if self.shrink_at_page == number:
                # 来源在扫描途中少了一条根评论：总数回落，按既有规则本轮应失败。
                self.shrink_at_page = None
                self.roots.pop()
                self.count = len(self.roots) + len(self.replies)
            payload = copy.deepcopy(root_fixture())
            payload["data"]["page"].update(num=number, count=len(self.roots),
                                           acount=len(self.roots) + len(self.replies))
            payload["data"]["replies"] = self.roots[(number - 1) * 20:number * 20] or None
            self._echo(payload, params)
            return httpx.Response(200, json=payload)
        if path == "/x/v2/reply/reply":
            number = int(params["pn"])
            if self.fail_replies or self.fail_reply_page == number:
                self.fail_reply_page = None
                raise httpx.ReadError("FICTIONAL_SECRET_REPLY_PAGE")
            payload = copy.deepcopy(json.loads((FIXTURES / "replies.json").read_text()))
            root = payload["data"]["root"]
            root["rpid_str"] = params["root"]
            owned = params["root"] == self.roots[0]["rpid_str"]
            items = self.replies if owned else []
            payload["data"]["page"].update(num=number, count=len(items))
            payload["data"]["replies"] = (
                items[(number - 1) * 20:number * 20] or None) if items else []
            self._echo(payload, params)
            return httpx.Response(200, json=payload)
        return empty_upstream(request)

    def _echo(self, payload, params):
        """回显本次请求的资源身份：多目标用例靠 oid 区分请求归属。"""
        oid, kind = params["oid"], params["type"]
        uppers = (payload["data"].get("upper") or {}).get("top")
        echoed = list(payload["data"].get("replies") or []) + list(payload["data"].get("hots") or [])
        if payload["data"].get("root") is not None:
            echoed.append(payload["data"]["root"])
        if isinstance(uppers, dict):
            echoed.append(uppers)
        for item in echoed:
            if "oid" in item:
                item["oid"] = int(oid)
            if "type" in item:
                item["type"] = int(kind)

    def give_media(self, index=0):
        self.roots[index]["content"]["pictures"] = copy.deepcopy(PICTURES)

    def notifiable(self):
        """把根与楼中楼的发表时间改到通知起点之后：原本的通知用例里已归档评论会被起点吞掉。"""
        later = int(time.time()) + 30 * 24 * 3600
        for index, root in enumerate(self.roots):
            root["ctime"] = later + index
        for index, reply in enumerate(self.replies):
            reply["ctime"] = later + 100 + index

    def grow(self, count=2):
        """来源新增根评论（计数增长）：刷新只记录、不停工。"""
        template = copy.deepcopy(self.roots[1])
        template["rcount"] = 0
        template.pop("replies", None)
        for index in range(count):
            self.roots.append({**copy.deepcopy(template),
                               "rpid_str": str(900719925474099400500000 + index)})
        self.count = len(self.roots) + len(self.replies)

    def expand(self, total=21):
        """补到 `total` 条根评论：跨多页，全量与增量的根页请求序列才可区分。"""
        template = copy.deepcopy(self.roots[1])
        template["rcount"] = 0
        template.pop("replies", None)
        for index in range(total - len(self.roots)):
            self.roots.append({**copy.deepcopy(template),
                               "rpid_str": str(900719925474099400000 + index)})
        self.count = len(self.roots) + len(self.replies)

    def root_pages(self):
        return [params["pn"] for path, params in self.calls if path == "/x/v2/reply"]

    def reply_pages(self):
        return [params["pn"] for path, params in self.calls if path == "/x/v2/reply/reply"]

    def root_pages_for(self, oid):
        return [params["pn"] for path, params in self.calls
                if path == "/x/v2/reply" and params.get("oid") == oid]

    def forget(self):
        self.calls.clear()


async def initial_archive(path, source, clock, id="123", **kwargs):
    """先在窗口外跑一轮普通归档，把目标做到「归档已完成、锚点为空」。"""
    async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
        collector = Collector(Store(path), client, clock=clock, **kwargs)
        assert await collector.check_once(UID, id)
        await collector.execute_pending()


@asynccontextmanager
async def collecting(path, source, clock, **kwargs):
    async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
        running = asyncio.create_task(Collector(Store(path), client, clock=clock, **kwargs).run())
        try:
            yield running
        finally:
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)


async def tick(clock, *, jump=0):
    """推进一个采集节拍：等进程进入下一拍等待后越过它，再额外向前 `jump` 秒。

    只往前拨：等待中的节拍被唤醒后看到的就是拨过之后的时刻。
    """
    await eventually(lambda: bool(clock.deadlines) and clock.deadlines[-1] > clock.value)
    clock.advance(clock.deadlines[-1] + 1 + jump)


def work(path, id="123"):
    return {check["id"]: check["work"] for check in Store(path).read_checks(UID)}[id]


def test_completed_target_is_reopened_in_window_and_rescanned_to_the_end(tmp_path):
    path = tmp_path / "like-refresh.sqlite"
    configured(path)
    source = LikeSource()
    source.expand()
    # 起点是前一日北京 00:00：首轮归档的完整根页扫描把锚点记在此时，26 小时后才满 24 小时。
    clock = ControlledClock(beijing(0, 0, day=1))

    async def scenario():
        await initial_archive(path, source, clock)
        assert work(path) == "complete"
        source.forget()
        async with collecting(path, source, clock):
            await tick(clock)
            # 窗口前一分钟：已完成、已满 24 小时（到期），但窗口外不登记、不重扫。
            await tick(clock, jump=25 * 3600 + 59 * 60)
            assert work(path) == "complete"
            assert source.root_pages() == []
            # 窗口起点：登记把「完成」置回「待办」，会话被领取后完整翻根页到空尾页。
            await tick(clock, jump=60)
            await eventually(lambda: work(path) == "complete" and bool(source.root_pages()))
            # 21 条根评论全是已知的：仍翻到第 3 页并复读空尾页，没有「遇到已知就收束」。
            assert source.root_pages() == ["1", "2", "3", "3"]
            # 登记只发生一次：窗口内后续节拍不再重开一轮。
            source.forget()
            await tick(clock, jump=30 * 60)
            await tick(clock)
            assert source.root_pages() == []
            assert work(path) == "complete"
            # 窗口结束后即使满 24 小时也不再登记。
            await tick(clock, jump=3 * 3600 + 30 * 60)
            await tick(clock)
            assert source.root_pages() == []
            assert work(path) == "complete"

    asyncio.run(scenario())


def test_failed_refresh_does_not_advance_anchor_and_retries_inside_the_window(tmp_path):
    path = tmp_path / "like-refresh-retry.sqlite"
    configured(path)
    source = LikeSource()
    source.expand()
    clock = ControlledClock(beijing(0, 0, day=1))

    async def scenario():
        await initial_archive(path, source, clock)
        source.forget()
        async with collecting(path, source, clock):
            await tick(clock)
            await tick(clock, jump=26 * 3600)
            # 窗口内第一拍：领取后根页取数失败。失败不推进锚点，同步工作留在待办。
            source.fail_root_page = 1
            await tick(clock)
            await eventually(lambda: work(path) == "pending" and source.root_pages() == ["1"])
            # 窗口内下一拍仍会重试，且参数没有从全量退化成增量（仍完整翻到空尾页）。
            source.fail_root_page = 1
            await tick(clock, jump=15)
            await eventually(lambda: work(path) == "pending" and source.root_pages() == ["1", "1"])
            await tick(clock, jump=15)
            await eventually(lambda: work(path) == "complete"
                             and source.root_pages() == ["1", "1", "1", "2", "3", "3"])
            # 成功即推进锚点：同一窗口内不再重开一轮。
            source.forget()
            await tick(clock, jump=30 * 60)
            await tick(clock)
            assert source.root_pages() == []
            assert work(path) == "complete"
            # 满 24 小时后的下一个窗口再到期，重新完整重扫。
            await tick(clock, jump=24 * 3600)
            await eventually(lambda: work(path) == "complete"
                             and source.root_pages() == ["1", "2", "3", "3"])

    asyncio.run(scenario())


def comments(path, sort="latest"):
    """公开评论读取：完整行级 DTO，用于刷新前后的逐字段比对。"""
    with archive_client(path) as api:
        response = api.get(f"{COMMENTS}?sort={sort}&limit=20")
        assert response.status_code == 200
        return response.json()["items"]


def test_refresh_only_changes_count_fields(tmp_path):
    path = tmp_path / "like-refresh-fields.sqlite"
    configured(path)
    source = LikeSource()
    source.expand()
    clock = ControlledClock(beijing(0, 0, day=1))

    async def scenario():
        await initial_archive(path, source, clock)
        before = comments(path)
        assert len(before) == 20
        source.roots[0]["like"] = 148
        source.roots[3]["like"] = 21
        source.forget()
        async with collecting(path, source, clock):
            await tick(clock)
            await tick(clock, jump=26 * 3600)
            await eventually(lambda: work(path) == "complete" and bool(source.root_pages()))
        after = comments(path)
        # 行数与主键集合完全不变：刷新不新增、不删除任何根评论。
        assert [item["id"] for item in after] == [item["id"] for item in before]
        by_id = {item["id"]: item for item in before}
        for item in after:
            old = by_id[item["id"]]
            assert set(item) == set(old)
            # 只有计数类字段可能变化；正文、作者、时间戳、媒体一字不变。
            assert {key for key in item if item[key] != old[key]} <= {
                "like_count", "source_reply_count", "is_pinned"}
            assert item["text"] == old["text"]
            assert item["author"] == old["author"]
            assert item["published_at"] == old["published_at"]
        refreshed = {item["id"]: item for item in after}
        updated, other = source.roots[0]["rpid_str"], source.roots[3]["rpid_str"]
        assert by_id[updated]["like_count"] == 8
        assert refreshed[updated]["like_count"] == 148
        assert refreshed[other]["like_count"] == 21

    asyncio.run(scenario())


def test_missing_like_keeps_old_value_and_real_zero_is_written(tmp_path):
    path = tmp_path / "like-refresh-merge.sqlite"
    configured(path)
    source = LikeSource()
    source.expand()
    source.roots[1]["like"] = 5
    clock = ControlledClock(beijing(0, 0, day=1))

    async def scenario():
        await initial_archive(path, source, clock)
        before = {item["id"]: item for item in comments(path)}
        assert before["900719925474099312346"]["like_count"] == 8
        assert before["2"]["like_count"] == 5
        # 来源的一条完全不返回点赞（未知），一条明确返回 0，一条下调到 6。
        source.roots[0].pop("like")
        source.roots[1]["like"] = 0
        source.roots[2]["like"] = 6
        source.forget()
        async with collecting(path, source, clock):
            await tick(clock)
            await tick(clock, jump=26 * 3600)
            await eventually(lambda: work(path) == "complete" and bool(source.root_pages()))
        after = {item["id"]: item for item in comments(path)}
        # 未知不等于 0：缺失观察保留旧可信点赞。
        assert after["900719925474099312346"]["like_count"] == 8
        # 真实的 0 就是 0，不被「缺失才保留」的规则挡住。
        assert after["2"]["like_count"] == 0
        assert after[source.roots[2]["rpid_str"]]["like_count"] == 6

    asyncio.run(scenario())


class PeakLeases:
    """记录重型许可的并发峰值与次数；许可本身仍是真实的 DispatchLeases。"""

    def __init__(self, inner):
        self.inner = inner
        self.active = 0
        self.peak = 0
        self.acquired = 0

    async def acquire_target(self, uid, id, *, wait=False):
        return await self.inner.acquire_target(uid, id, wait=wait)

    def heavy_slot(self, workload, kind):
        return self._counted(self.inner.heavy_slot(workload, kind))

    @asynccontextmanager
    async def _counted(self, slot):
        async with slot:
            self.active += 1
            self.acquired += 1
            self.peak = max(self.peak, self.active)
            try:
                yield None
            finally:
                self.active -= 1


def paced_factory(source, sent):
    """生产装配里的根页发送前等待：真实 SourcePacer，只替换最底层的 HTTP 传输。"""

    def handler(request):
        if request.url.path == "/x/v2/reply":
            sent.append(time.monotonic())
        return source(request)

    @asynccontextmanager
    async def factory(uid):
        async with httpx.AsyncClient(
                transport=PacedSourceTransport(httpx.MockTransport(handler))) as client:
            yield client

    return factory


def test_refresh_requests_keep_configured_pacing_and_one_heavy_lane(tmp_path):
    path = tmp_path / "like-refresh-rate.sqlite"
    configured(path)
    source = LikeSource()
    source.expand()
    clock = ControlledClock(beijing(0, 0, day=1))
    sent = []

    async def scenario():
        await initial_archive(path, source, clock)
        source.forget()
        scheduler = PeakLeases(DispatchLeases(Store(path), clock=clock))
        async with collecting(path, source, clock, scheduler=scheduler,
                              comment_client_factory=paced_factory(source, sent)):
            await tick(clock)
            sent.clear()
            await tick(clock, jump=26 * 3600)
            await eventually(lambda: work(path) == "complete" and len(sent) >= 4)
        # 相邻根页请求的发送间隔不小于既有逐请求等待配置（0.3–0.4 秒的下界）。
        assert len(sent) == 4
        gaps = [later - earlier for earlier, later in zip(sent, sent[1:])]
        assert min(gaps) >= PAGE_DELAYS[ROOT_COMMENTS_URL][0]
        # 重型许可一次只放一路，且粒度是一页一步（整轮刷新取了多次）。
        assert scheduler.peak == 1
        assert scheduler.acquired > 4

    asyncio.run(scenario())


class CountingUploads:
    """OSS 替身：只记账，不访问真实对象存储。"""

    def __init__(self):
        self.keys = []

    async def upload(self, key, content, content_type):
        assert content == b"fictional image bytes"
        assert content_type == "image/png"
        self.keys.append(key)
        return "https://archive.example.invalid/" + key


def media_traffic(downloads):
    """生产装配里的图片下载器：真实 ImageDownloader，只替换最底层传输并记账。"""

    def download(request):
        downloads.append(request.url.path)
        return httpx.Response(200, content=b"fictional image bytes",
                              headers={"Content-Type": "image/png"})

    return httpx.MockTransport(download)


def media_state(items):
    """逐字段的媒体快照：ID、状态、交付地址与来源地址。"""
    return [[(item["id"], item["status"], item["public_url"], item["source_url"])
             for item in root["media"]] for root in items]


def test_refresh_does_not_download_or_upload_succeeded_media_again(tmp_path):
    path = tmp_path / "like-refresh-media.sqlite"
    configured(path)
    source = LikeSource()
    source.expand()
    source.give_media(0)
    clock = ControlledClock(beijing(0, 0, day=1))
    downloads = []
    uploads = CountingUploads()

    async def scenario():
        async with httpx.AsyncClient(transport=media_traffic(downloads)) as client:
            downloader = ImageDownloader(client)
            await initial_archive(path, source, clock, downloader=downloader, uploader=uploads)
            before = comments(path)
            assert len(uploads.keys) == len(PICTURES)
            assert downloads
            assert media_state(before) and all(
                item["status"] == "success"
                for root in before for item in root["media"])
            assert Store(path).read_archive("123")["work"]["media"] == "success"
            synced_at = Store(path).read_archive("123")["comment_media_last_succeeded_at"]
            uploads.keys.clear()
            downloads.clear()
            source.roots[0]["like"] = 99
            source.forget()
            async with collecting(path, source, clock, downloader=downloader, uploader=uploads):
                await tick(clock)
                await tick(clock, jump=26 * 3600)
                await eventually(lambda: work(path) == "complete" and bool(source.root_pages()))
        after = comments(path)
        # 点赞确实刷新了，媒体则一字未动：没有新的下载，也没有新的上传。
        assert {item["id"]: item["like_count"] for item in after}[source.roots[0]["rpid_str"]] == 99
        assert downloads == []
        assert uploads.keys == []
        assert media_state(after) == media_state(before)
        archive = Store(path).read_archive("123")
        assert archive["work"]["media"] == "success"
        # 媒体成功时间也不因刷新被补成“刚上传”。
        assert archive["comment_media_last_succeeded_at"] == synced_at

    asyncio.run(scenario())


def reply_items(path, root="900719925474099312346"):
    """公开楼中楼读取（实时 page 模式）：完整行级 DTO，用于刷新前后比对。"""
    with archive_client(path) as api:
        response = api.get(f"{COMMENTS}/{root}/replies?page=1")
        assert response.status_code == 200
        return response.json()["items"]


def archive(path, id="123"):
    return Store(path).read_archive(id)


def anchor(path, id="123"):
    """点赞刷新锚点不在公开投影里，直接读检查行。"""
    with sqlite3.connect(path) as connection:
        return connection.execute(
            "SELECT like_refresh_succeeded_at FROM target_checks WHERE id = ?", (id,)).fetchone()[0]


def test_refresh_keeps_comments_the_source_no_longer_returns(tmp_path):
    path = tmp_path / "like-refresh-keep.sqlite"
    configured(path)
    source = LikeSource()
    source.expand()
    clock = ControlledClock(beijing(0, 0, day=1))

    async def scenario():
        await initial_archive(path, source, clock)
        before = {item["id"]: item for item in comments(path)}
        before_replies = reply_items(path)
        before_counts = (archive(path)["local_comment_count"], archive(path)["local_reply_count"])
        assert len(before) == 20 and len(before_replies) == 5
        # 来源侧「删掉」一条已归档根评论与两条楼中楼：刷新重扫不能让本地对应行消失。
        dropped = source.roots.pop(5)["rpid_str"]
        source.replies = source.replies[:-2]
        source.forget()
        async with collecting(path, source, clock):
            await tick(clock)
            await tick(clock, jump=26 * 3600)
            await eventually(lambda: bool(source.root_pages()) and bool(source.reply_pages()))
        after = {item["id"]: item for item in comments(path)}
        # 行数与主键集合一字不变：归档是只增不删的。
        assert list(after) == list(before)
        assert dropped in after
        for id, item in after.items():
            assert item["text"] == before[id]["text"]
            assert item["author"] == before[id]["author"]
            assert item["published_at"] == before[id]["published_at"]
            assert item["like_count"] == before[id]["like_count"]
            assert media_state([item]) == media_state([before[id]])
        # 楼中楼同理：少返回的两条仍在本地，内容逐字段不变。
        after_replies = reply_items(path)
        assert [item["id"] for item in after_replies] == [item["id"] for item in before_replies]
        assert {item["id"]: item["text"] for item in after_replies} == {
            item["id"]: item["text"] for item in before_replies}
        # 归档自报的本地条数同样没被「以来源为准」改写。
        assert (archive(path)["local_comment_count"], archive(path)["local_reply_count"]) == before_counts

    asyncio.run(scenario())


def test_count_growth_is_only_recorded_and_does_not_stop_the_refresh(tmp_path):
    path = tmp_path / "like-refresh-growth.sqlite"
    configured(path)
    source = LikeSource()
    source.expand()
    clock = ControlledClock(beijing(0, 0, day=1))

    async def scenario():
        await initial_archive(path, source, clock)
        before = archive(path)
        source.grow(2)
        source.roots[0]["like"] = 120
        source.forget()
        async with collecting(path, source, clock):
            await tick(clock)
            await tick(clock, jump=26 * 3600)
            await eventually(lambda: work(path) == "complete" and len(source.root_pages()) >= 4)
        after = archive(path)
        # 增长只记录：本轮不失败、不中断，刷新照常跑完。
        check = Store(path).read_checks(UID)[0]
        assert check["check_error"] is None and check["sync_error"] is None
        assert work(path) == "complete"
        # 新评论确实归档了，旧行也没被覆盖。
        assert after["local_comment_count"] == before["local_comment_count"] + 2
        # 一致性检查点等于本轮真实观察到的来源总数，既不落后也不超前。
        assert after["source_comment_count"] == source.count
        assert after["synced_comment_count"] == after["synced_root_comment_count"] == source.count
        assert after["comments_last_attempt"] == "success"
        assert {item["id"]: item["like_count"] for item in comments(path)}[
            source.roots[0]["rpid_str"]] == 120

    asyncio.run(scenario())


def test_count_decrease_fails_by_existing_rule_and_keeps_the_checkpoint(tmp_path):
    path = tmp_path / "like-refresh-shrink.sqlite"
    configured(path)
    source = LikeSource()
    source.expand()
    clock = ControlledClock(beijing(0, 0, day=1))

    async def scenario():
        await initial_archive(path, source, clock)
        before = archive(path)
        before_anchor = anchor(path)
        before_rows = {item["id"]: item for item in comments(path)}
        # 第二页取数时来源少了一条根评论：分页可能整体前移，既有规则判本轮失败。
        source.shrink_at_page = 2
        source.roots[0]["like"] = 111
        source.forget()
        async with collecting(path, source, clock):
            await tick(clock)
            await tick(clock, jump=26 * 3600)
            await eventually(lambda: source.root_pages() == ["1", "2"] and work(path) == "pending")
        after = archive(path)
        # 计数减少仍按既有规则失败：错误码与分项状态不变口径。
        assert after["root_comments_error"] == "ROOT_COMMENTS_FAILED"
        assert after["work"]["comments"] == "pending"
        # 一致性检查点没被这一轮推进。
        assert after["synced_comment_count"] == before["synced_comment_count"]
        assert after["synced_root_comment_count"] == before["synced_root_comment_count"]
        assert after["comments_last_succeeded_at"] == before["comments_last_succeeded_at"]
        # 旧内容原样保留：行数不减，已提交的第一页数据不被后续失败回滚。
        kept = {item["id"]: item for item in comments(path)}
        assert list(kept) == list(before_rows)
        for id, item in kept.items():
            assert item["text"] == before_rows[id]["text"]
            assert item["author"] == before_rows[id]["author"]
        # 失败页之前已确认的页照常落库（只拒绝减少、不撤销已提交数据）。
        assert kept[source.roots[0]["rpid_str"]]["like_count"] == 111
        # 失败不推进锚点：窗口内仍可重试，窗口外等次日。
        assert anchor(path) == before_anchor

    asyncio.run(scenario())


def test_failed_replies_do_not_advance_the_comment_checkpoint(tmp_path):
    path = tmp_path / "like-refresh-checkpoint.sqlite"
    configured(path)
    source = LikeSource()
    source.expand()
    clock = ControlledClock(beijing(0, 0, day=1))

    async def scenario():
        await initial_archive(path, source, clock)
        before = archive(path)
        before_anchor = anchor(path)
        # 楼中楼这一轮一直取不到：刷新不能因此把「评论总数已同步」记成完成。
        source.fail_replies = True
        source.roots[0]["like"] = 99
        source.forget()
        async with collecting(path, source, clock):
            await tick(clock)
            await tick(clock, jump=26 * 3600)
            await eventually(lambda: bool(source.reply_pages()) and work(path) == "pending")
        after = archive(path)
        assert after["synced_comment_count"] == before["synced_comment_count"]
        assert after["synced_reply_comment_count"] == before["synced_reply_comment_count"]
        assert after["comments_last_succeeded_at"] == before["comments_last_succeeded_at"]
        assert after["comments_last_attempt"] == "failed"
        assert after["work"]["replies"] == "pending"
        # 根页扫描成功即推进点赞刷新锚点：不在刷新路径上等所有分项都成功。
        assert anchor(path) != before_anchor
        # 点赞本身仍然刷新了：楼中楼失败不影响本次已经读到的计数。
        assert {item["id"]: item["like_count"] for item in comments(path)}[
            source.roots[0]["rpid_str"]] == 99

    asyncio.run(scenario())


def notification_rows(path):
    """通知事件、逐群投递与候选的前后快照：刷新不应新增任何一条。"""
    with sqlite3.connect(path) as connection:
        events = connection.execute(
            "SELECT id, kind, dynamic_id, root_id, comment_id, snapshot, created_at"
            " FROM notification_events ORDER BY id").fetchall()
        deliveries = connection.execute(
            "SELECT id, event_id, role, state, due_at, attempts, token, lease_until, error, sent_at"
            " FROM notification_deliveries ORDER BY id").fetchall()
        candidates = connection.execute(
            "SELECT dynamic_id, root_id, comment_id, phase FROM notification_candidates"
            " ORDER BY comment_id").fetchall()
    return events, deliveries, candidates


def test_refresh_never_notifies_archived_comments_again(tmp_path):
    path = tmp_path / "like-refresh-notify.sqlite"
    configured(path)
    source = LikeSource()
    source.expand()
    source.notifiable()
    clock = ControlledClock(beijing(0, 0, day=1))

    async def scenario():
        await initial_archive(path, source, clock)
        before = notification_rows(path)
        events, deliveries, _ = before
        # 非空基线：归档首轮确实登记了根评论与楼中楼事件，并逐群写了投递记录。
        assert {event[1] for event in events} == {"root_comment", "reply_comment"}
        assert {delivery[2] for delivery in deliveries} == {"up", "all"}
        before_replies_at = archive(path)["replies_last_succeeded_at"]
        source.roots[0]["like"] = 77
        source.forget()
        async with collecting(path, source, clock):
            await tick(clock)
            await tick(clock, jump=26 * 3600)
            await eventually(lambda: work(path) == "complete" and bool(source.root_pages()))
        # 本轮确实重写了已归档的根与楼中楼：点赞变了、楼中楼成功时间也推进了。
        assert {item["id"]: item["like_count"] for item in comments(path, sort="hot")}.get(
            source.roots[0]["rpid_str"]) == 77
        assert source.reply_pages()
        assert archive(path)["replies_last_succeeded_at"] > before_replies_at
        # 但通知事件、投递记录与候选一条不增。
        assert notification_rows(path) == before

    asyncio.run(scenario())


def test_count_growth_does_not_repeat_the_full_rescan_on_every_tick(tmp_path):
    path = tmp_path / "like-refresh-repeat.sqlite"
    configured(path)
    source = LikeSource()
    source.expand(total=61)
    clock = ControlledClock(beijing(0, 0, day=1))

    async def scenario():
        await initial_archive(path, source, clock)
        source.forget()
        with captured_logs() as logs:
            # 第一轮：窗口内登记的词条目标完整翻到底（61 条根评论 4 页，空页再复读一次）。
            async with collecting(path, source, clock):
                await tick(clock)
                await tick(clock, jump=26 * 3600)
                await eventually(lambda: work(path) == "complete" and len(source.root_pages()) == 6)
                assert source.root_pages() == ["1", "2", "3", "4", "5", "5"]
            source.forget()
            # 同一个夜里来源计数持续增长：每一拍都重新检查，但都不再重来一遍全量。
            async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
                collector = Collector(Store(path), client, clock=clock)
                for _ in range(3):
                    source.grow(1)
                    assert await collector.check_once(UID, "123")
                    await collector.execute_pending()
                    assert work(path) == "complete"
            pages = source.root_pages()
            # 全量会翻到第 5 页；增量在已知评论上收束，深层页不再重扫。
            assert pages and "5" not in pages
            assert pages.count("1") <= 2 * 3
            refreshes = [line for line in logs if "sync_started" in line
                         and 'dynamic_id="123"' in line and "like_refresh=true" in line]
        # 整晚只有一次全量刷新会话。
        assert len(refreshes) == 1

    asyncio.run(scenario())


def test_root_scan_failure_does_not_skip_the_reply_refresh(tmp_path):
    path = tmp_path / "like-refresh-degraded.sqlite"
    configured(path)
    source = LikeSource()
    source.expand()
    clock = ControlledClock(beijing(0, 0, day=1))

    async def scenario():
        await initial_archive(path, source, clock)
        source.fail_root_page = 1
        source.forget()
        async with collecting(path, source, clock):
            await tick(clock)
            await tick(clock, jump=26 * 3600)
            # 根页首屏失败：本轮按既有降级语义继续刷新楼中楼，不整轮跳过。
            await eventually(lambda: source.root_pages() == ["1"]
                             and archive(path)["replies_last_attempt"] == "unconfirmed")
            degraded = archive(path)
            assert degraded["root_comments_error"] == "ROOT_COMMENTS_FAILED"
            assert degraded["work"]["comments"] == "pending"
            # 楼中楼不是被跳过：确实发出了翻页请求，并按既有降级出口结算。
            assert source.reply_pages()
            assert degraded["work"]["replies"] == "pending"
            # 一轮失败不等于整轮放弃：会话结算回待办后，下一拍重新尝试根页并跑到底。
            await eventually(lambda: work(path) == "pending")
            source.forget()
            await tick(clock, jump=15)
            await eventually(lambda: work(path) == "complete"
                             and source.root_pages() == ["1", "2", "3", "3"])

    asyncio.run(scenario())


def test_another_target_still_checks_new_comments_while_a_refresh_runs(tmp_path):
    path = tmp_path / "like-refresh-isolation.sqlite"
    configured(path, ids=("123", "456"))
    source = LikeSource()
    source.expand()
    clock = ControlledClock(beijing(0, 0, day=1))

    async def scenario():
        # 123 的锚点在前一日零点：窗口一开就到期，成为当晚的点赞刷新。
        await initial_archive(path, source, clock, "123")
        before_anchor = anchor(path, "123")
        # 456 在窗口前一小时才首次归档，锚点新鲜：它是「新评论检查」，不是刷新。
        clock.advance(25 * 3600)
        await initial_archive(path, source, clock, "456")
        source.grow(2)
        source.forget()
        clock.advance(26 * 3600)
        scheduler = PeakLeases(DispatchLeases(Store(path), clock=clock))
        with captured_logs() as logs:
            async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
                collector = Collector(Store(path), client, clock=clock, scheduler=scheduler)
                # 两条目标都因来源计数增长而待办；同一轮重活里一条是刷新、一条是新评论检查。
                assert await collector.check_once(UID, "123")
                assert await collector.check_once(UID, "456")
                await collector.execute_pending()
        # 123 确实是刷新（全量根页），456 是普通增量检查。
        assert any("sync_started" in line and "like_refresh=true" in line
                   and 'dynamic_id="123"' in line for line in logs)
        assert any("sync_started" in line and "like_refresh=false" in line
                   and 'dynamic_id="456"' in line for line in logs)
        assert source.root_pages_for("99123") == ["1", "2", "3", "3"]
        assert source.root_pages_for("99456") == ["1", "2", "3", "3"]
        # 456 的检查插在 123 的刷新轮次中间：刷新没有把其他目标整轮堵死。
        calls = [params["oid"] for path_, params in source.calls if path_ == "/x/v2/reply"]
        first, last = calls.index("99123"), len(calls) - 1 - calls[::-1].index("99123")
        assert "99456" in calls[first:last]
        # 全程只有一路重型任务在推进，粒度是一页一步（整轮取了多次）。
        assert scheduler.peak == 1
        assert scheduler.acquired > 4
        # 两条目标都收束，刷新不把目标留在待办里。
        assert work(path, "123") == work(path, "456") == "complete"
        assert anchor(path, "123") != before_anchor
        assert Store(path).read_archive("456")["local_comment_count"] == 23
        assert Store(path).read_archive("123")["local_comment_count"] == 23

    asyncio.run(scenario())
