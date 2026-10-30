"""01／02：凌晨窗口驱动的根评论与楼中楼点赞刷新（临时 SQLite＋替身来源＋受控时钟）。"""

import asyncio
import copy
import json
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
from backend.bili_monitor.replies import scan_due
from backend.bili_monitor.source_endpoints import ROOT_COMMENTS_URL
from backend.bili_monitor.source_transport import PAGE_DELAYS, PacedSourceTransport
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client, readable_html
from backend.tests.collector_clock import ControlledClock, eventually
from backend.tests.collector_support import configured, empty_upstream
from backend.tests.management_support import UID
from backend.tests.root_support import root_fixture


ARCHIVE = "/api/archive/dynamics/123"
COMMENTS = ARCHIVE + "/comments"
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
    """仅替换外部 HTTP：原始根／楼中楼 JSON，点赞数可控，根页与楼页可受控失败。"""

    def __init__(self):
        self.roots = copy.deepcopy(root_fixture()["data"]["replies"])
        for root in self.roots:
            root["content"]["pictures"] = []
        self.replies = json.loads((FIXTURES / "replies.json").read_text())["data"]["replies"]
        self.html = readable_html(pictures=[])
        # 逐楼回复条目：键是根评论 ID，值是来源顺序（旧→新）的回复。
        self.building = {self.roots[0]["rpid_str"]: self.replies}
        # 楼页响应里携带的所属根评论对象；未登记的楼沿用楼页 fixture 里的原值。
        self.reply_root_like = {}
        self.count = len(self.roots) + len(self.replies)
        self.fail_root_page = None
        self.fail_reply_page = None
        self.calls = []

    def __call__(self, request):
        path = request.url.path
        params = dict(request.url.params)
        self.calls.append((path, params))
        if path.startswith("/opus/"):
            return httpx.Response(200, text=self.html)
        if path == "/x/v2/reply/count":
            payload = json.loads((FIXTURES / "comment-count.json").read_text())
            payload["data"]["count"] = self.count
            return httpx.Response(200, json=payload)
        if path == "/x/v2/reply":
            number = int(params["pn"])
            if self.fail_root_page == number:
                self.fail_root_page = None
                raise httpx.ReadError("FICTIONAL_SECRET_ROOT_PAGE")
            payload = copy.deepcopy(root_fixture())
            payload["data"]["page"].update(num=number, count=len(self.roots),
                                           acount=len(self.roots) + len(self.replies))
            payload["data"]["replies"] = self.roots[(number - 1) * 20:number * 20] or None
            return httpx.Response(200, json=payload)
        if path == "/x/v2/reply/reply":
            number = int(params["pn"])
            if self.fail_reply_page == number:
                raise httpx.ReadError("FICTIONAL_SECRET_REPLY_PAGE")
            payload = copy.deepcopy(json.loads((FIXTURES / "replies.json").read_text()))
            root = payload["data"]["root"]
            root["rpid_str"] = params["root"]
            items = self.building.get(params["root"], [])
            root["rcount"] = len(items)
            # 楼页本来就带着所属根评论对象：点赞可由用例单独指定，缺失表示来源未返回。
            root.pop("like", None)
            if params["root"] in self.reply_root_like:
                root["like"] = self.reply_root_like[params["root"]]
            payload["data"]["page"].update(num=number, count=len(items))
            payload["data"]["replies"] = (
                items[(number - 1) * 20:number * 20] or None) if items else []
            return httpx.Response(200, json=payload)
        return empty_upstream(request)

    def expand(self):
        """补到 21 条根评论：跨两页，全量与增量的根页请求序列才可区分。"""
        template = copy.deepcopy(self.roots[1])
        template["rcount"] = 0
        template.pop("replies", None)
        for index in range(19):
            self.roots.append({**copy.deepcopy(template),
                               "rpid_str": str(900719925474099400000 + index)})
        self.recount()

    def expand_replies(self, total, *, root_index=0):
        """把某栋楼补到跨页：来源顺序（旧→新）递增时间与点赞，根页 rcount 同步。"""
        template = copy.deepcopy(self.replies[0])
        root_id = self.roots[root_index]["rpid_str"]
        items = []
        for index in range(total):
            identifier = str(30000 + index)
            reply = copy.deepcopy(template)
            reply.update(rpid_str=identifier, ctime=1791513500 + index, like=index + 1,
                         rcount=0, root_str=root_id, parent_str=root_id)
            reply["content"] = {"message": f"回复 {identifier}", "pictures": []}
            reply.pop("replies", None)
            items.append(reply)
        self.building[root_id] = items
        self.roots[root_index]["rcount"] = total
        self.recount()
        return root_id

    def recount(self):
        self.count = len(self.roots) + sum(len(items) for items in self.building.values())

    def root_pages(self):
        return [params["pn"] for path, params in self.calls if path == "/x/v2/reply"]

    def reply_pages(self, root_id=None):
        """楼中楼真实请求过的页码（按请求先后）：区分整楼正序与末页倒序。"""
        return [int(params["pn"]) for path, params in self.calls
                if path == "/x/v2/reply/reply" and (root_id is None or params["root"] == root_id)]

    def forget(self):
        self.calls.clear()


async def initial_archive(path, source, clock):
    """先在窗口外跑一轮普通归档，把目标做到「归档已完成、锚点为空」。"""
    async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
        collector = Collector(Store(path), client, clock=clock)
        assert await collector.check_once(UID, "123")
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


def work(path):
    return Store(path).read_checks(UID)[0]["work"]


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


def archived_replies(path, root_id):
    """公开楼中楼读取：完整行级 DTO，用于刷新前后的逐字段比对。"""
    items = []
    with archive_client(path) as api:
        url = f"{COMMENTS}/{root_id}/replies"
        while url:
            page = api.get(url).json()
            items.extend(page["items"])
            cursor = page["next_cursor"]
            url = f"{COMMENTS}/{root_id}/replies?cursor={cursor}" if cursor else None
    return items


def root_dto(path, root_id):
    for item in comments(path):
        if item["id"] == root_id:
            return item
    raise AssertionError("根评论没有出现在公开读取里")


def pages_of(calls):
    """上游分页账本：只看真实取数请求，(接口, 页码) 按发生顺序。"""
    return [(path, params.get("pn")) for path, params in calls
            if path in ("/x/v2/reply", "/x/v2/reply/reply")]


def refresh_tick(clock, *, jump=65 * 60):
    """推到窗口内且锚点已满间隔的下一拍（测试把刷新间隔调成 1 小时）。"""
    return tick(clock, jump=jump)


def test_refresh_scans_every_building_forward_to_the_empty_tail(tmp_path, monkeypatch):
    """LR-02：每个楼都从第 1 页正序翻到空尾页，不走末页倒序，也不因刚校准过而跳过。"""
    monkeypatch.setenv("BILI_COLLECTOR_LIKE_REFRESH_SECONDS", "3600")
    path = tmp_path / "reply-forward.sqlite"
    configured(path)
    source = LikeSource()
    source.expand()
    big = source.expand_replies(25, root_index=0)     # 两页数据 + 空尾页
    small = source.expand_replies(15, root_index=1)   # 一页数据 + 空尾页
    clock = ControlledClock(beijing(1, 0, day=1))

    async def scenario():
        await initial_archive(path, source, clock)
        # 前提：两栋楼都在 24 小时校准周期内成功扫过，增量路径会直接跳过它们。
        progress = Store(path).reply_progress("123")
        assert scan_due(progress[big], 25, clock.now()) is False
        assert scan_due(progress[small], 15, clock.now()) is False
        source.forget()
        async with collecting(path, source, clock):
            await tick(clock)
            await refresh_tick(clock)              # 北京 02:05：窗口内且到期
            await eventually(lambda: work(path) == "complete" and bool(source.root_pages()))
        # 25 条 → 1、2、3 页再复读空尾页；15 条 → 1 页再复读空尾页。
        assert source.reply_pages(big) == [1, 2, 3, 3]
        assert source.reply_pages(small) == [1, 2, 2]

    asyncio.run(scenario())


def test_interrupted_reply_refresh_stays_full_forward_and_keeps_committed_pages(tmp_path, monkeypatch):
    """LR-07：刷新中断后重新进入同一轮仍是整楼全量，已提交分页不重扫。"""
    monkeypatch.setenv("BILI_COLLECTOR_LIKE_REFRESH_SECONDS", "3600")
    path = tmp_path / "reply-resume.sqlite"
    configured(path)
    source = LikeSource()
    source.expand()
    big = source.expand_replies(45, root_index=0)     # 三页数据 + 空尾页
    clock = ControlledClock(beijing(1, 0, day=1))

    async def scenario():
        await initial_archive(path, source, clock)
        source.forget()
        async with collecting(path, source, clock):
            await tick(clock)
            # 第 3 页取数失败：第 1、2 页已提交，整楼留在待办。
            source.fail_reply_page = 3
            await refresh_tick(clock)
            await eventually(lambda: work(path) == "pending" and 3 in source.reply_pages(big))
            assert source.reply_pages(big) == [1, 2, 3]
            # 重新进入同一轮：仍整楼全量正序，先复核第 2 页锚点再往下；既不从第 1 页
            # 重扫，也不退回末页倒序（那样会是 3、2、1）。
            source.fail_reply_page = None
            source.forget()
            await tick(clock, jump=15)
            await eventually(lambda: work(path) == "complete" and bool(source.reply_pages(big)))
            assert source.reply_pages(big) == [2, 3, 4, 4]
        assert [item["id"] for item in archived_replies(path, big)] == [
            str(30000 + index) for index in range(45)]

    asyncio.run(scenario())


def test_reply_refresh_only_changes_count_fields(tmp_path, monkeypatch):
    """LR-03：刷新后楼中楼只改点赞，行数与主键不变，其余字段逐字段相等。"""
    monkeypatch.setenv("BILI_COLLECTOR_LIKE_REFRESH_SECONDS", "3600")
    path = tmp_path / "reply-fields.sqlite"
    configured(path)
    source = LikeSource()
    source.expand()
    big = source.expand_replies(25, root_index=0)
    clock = ControlledClock(beijing(1, 0, day=1))

    async def scenario():
        await initial_archive(path, source, clock)
        before = archived_replies(path, big)
        root_before = root_dto(path, big)
        assert len(before) == 25
        # 来源只把两处点赞调高，其余字段与页结构都不动。
        source.building[big][0]["like"] = 166
        source.building[big][7]["like"] = 99
        source.forget()
        async with collecting(path, source, clock):
            await tick(clock)
            await refresh_tick(clock)
            await eventually(lambda: work(path) == "complete" and bool(source.root_pages()))
        after = archived_replies(path, big)
        assert [item["id"] for item in after] == [item["id"] for item in before]
        by_id = {item["id"]: item for item in before}
        for item in after:
            old = by_id[item["id"]]
            assert set(item) == set(old)
            # 只有计数类字段可能变化；正文、作者、时间、图片存在性一字不变。
            assert {key for key in item if item[key] != old[key]} <= {"like_count"}
        refreshed = {item["id"]: item for item in after}
        assert by_id["30000"]["like_count"] == 1
        assert refreshed["30000"]["like_count"] == 166
        assert refreshed["30007"]["like_count"] == 99
        # 根评论的置顶与来源回复数语义不变：旁路只写计数类字段。
        root_after = root_dto(path, big)
        assert root_after["is_pinned"] == root_before["is_pinned"]
        assert root_after["source_reply_count"] == root_before["source_reply_count"] == 25
        assert {key for key in root_after if root_after[key] != root_before[key]} <= {"like_count"}

    asyncio.run(scenario())


def test_missing_reply_like_keeps_old_value_and_real_zero_is_written(tmp_path, monkeypatch):
    """LR-05：楼中楼来源缺点赞时保留旧值，返回真实 0 时写入 0。"""
    monkeypatch.setenv("BILI_COLLECTOR_LIKE_REFRESH_SECONDS", "3600")
    path = tmp_path / "reply-merge.sqlite"
    configured(path)
    source = LikeSource()
    source.expand()
    big = source.expand_replies(25, root_index=0)
    clock = ControlledClock(beijing(1, 0, day=1))

    async def scenario():
        await initial_archive(path, source, clock)
        before = {item["id"]: item for item in archived_replies(path, big)}
        assert [before[str(30000 + index)]["like_count"] for index in range(3)] == [1, 2, 3]
        source.building[big][0].pop("like")   # 来源完全不返回点赞：未知，不是 0
        source.building[big][1]["like"] = 0   # 真实的 0
        source.building[big][2]["like"] = 17
        source.forget()
        async with collecting(path, source, clock):
            await tick(clock)
            await refresh_tick(clock)
            await eventually(lambda: work(path) == "complete" and bool(source.root_pages()))
        after = {item["id"]: item for item in archived_replies(path, big)}
        assert after["30000"]["like_count"] == 1     # 旧可信点赞保留
        assert after["30001"]["like_count"] == 0     # 真实 0 不被「缺失才保留」挡住
        assert after["30002"]["like_count"] == 17

    asyncio.run(scenario())


def test_reply_page_root_like_is_written_back_without_extra_requests(tmp_path, monkeypatch):
    """零成本旁路：楼页携带的根评论点赞写回根文档，整轮请求序列一字不变。"""
    monkeypatch.setenv("BILI_COLLECTOR_LIKE_REFRESH_SECONDS", "3600")
    path = tmp_path / "reply-bypass.sqlite"
    configured(path)
    source = LikeSource()
    source.expand()
    big = source.expand_replies(25, root_index=0)
    clock = ControlledClock(beijing(1, 0, day=1))

    async def scenario():
        await initial_archive(path, source, clock)
        assert root_dto(path, big)["like_count"] == 8
        rounds = []
        async with collecting(path, source, clock):
            await tick(clock)
            # 两轮刷新：一轮楼页带着根评论点赞，一轮不带；请求账本必须完全相同。
            for like in (137, None):
                source.reply_root_like = {} if like is None else {big: like}
                source.forget()
                await refresh_tick(clock)
                await eventually(lambda: work(path) == "complete" and bool(source.root_pages())
                                 and bool(source.reply_pages(big)))
                rounds.append(pages_of(source.calls))
                if like is None:
                    assert root_dto(path, big)["like_count"] == 8
                else:
                    # 楼页本来就带着这个对象：写回不新增请求，只改计数类字段。
                    assert root_dto(path, big)["like_count"] == 137
                    assert root_dto(path, big)["source_reply_count"] == 25
        # 写回不增加任何请求：带旁路与不带旁路的上游分页账本逐条相同，且没有多出任何一页。
        assert rounds[0] == rounds[1] == [
            ("/x/v2/reply", "1"), ("/x/v2/reply", "2"), ("/x/v2/reply", "3"),
            ("/x/v2/reply", "3"), ("/x/v2/reply/reply", "1"), ("/x/v2/reply/reply", "2"),
            ("/x/v2/reply/reply", "3"), ("/x/v2/reply/reply", "3")]

    asyncio.run(scenario())
