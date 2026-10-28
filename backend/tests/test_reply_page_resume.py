"""07：楼中楼逐页进度、方向续采、重定位与热帖追赶。

只替换外部上游：真实临时 SQLite、真实归档装配／`reply_scan_step`／Collector 与归档 GET。
"""

import asyncio
import copy
import json
import logging
from pathlib import Path

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.replies import reply_scan_step, sync_replies
from backend.bili_monitor.risk import SourceRiskPaused
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import UID, archive_client
from backend.tests.collector_clock import ControlledClock
from backend.tests.root_support import COMMENTS, prepare, root_fixture, source_handler
from backend.tests.test_replies import REPLIES, ROOT, reply_fixture, reply_source


DYNAMIC = "123"
ARCHIVE = "/api/archive/dynamics/123"
ZERO_ROOT = "2"
FIXTURES = Path(__file__).parent / "fixtures"


def count_fixture():
    return json.loads((FIXTURES / "comment-count.json").read_text())


@pytest.fixture
def events():
    """采集日志是产品表面：连到该 logger 自己的 handler 上取值，不依赖 propagate。"""
    records = []
    logger = logging.getLogger("bili_monitor.collector")

    class Capture(logging.Handler):
        def emit(self, record):
            records.append(record.getMessage())

    handler = Capture()
    logger.addHandler(handler)
    try:
        yield lambda: "\n".join(records)
    finally:
        logger.removeHandler(handler)


def make_reply(index, *, base=30000):
    """按来源顺序（旧→新）生成一条回复：ID／时间递增，文本可定位，无图片。"""
    reply = copy.deepcopy(reply_fixture()["data"]["replies"][0])
    identifier = str(base + index)
    reply.update(rpid_str=identifier, parent_str=ROOT, ctime=1791513500 + index,
                 like=index % 3, rcount=0)
    reply["content"] = {"message": f"回复 {identifier}", "pictures": []}
    reply.pop("replies", None)
    return reply


def root_documents(count):
    """两栋楼：ROOT 带着指定来源回复数，另一栋来源明确零回复。"""
    payload = copy.deepcopy(root_fixture())
    first, second = payload["data"]["replies"][:2]
    first["rcount"], second["rcount"] = count, 0
    return [first, second]


class HotSource:
    """楼中楼来源替身：可追加、删除与注入页失败，并记账每次真实请求。"""

    def __init__(self, total=45, oid="99123"):
        self.replies = [make_reply(index) for index in range(total)]
        self.oid = oid
        self.state = {"roots": root_documents(total), "reply_pages": []}
        self.inner = source_handler(self.state)
        self.fail_page = None
        self.fail_html = False

    def relocate(self, oid):
        """来源换到另一评论资源（oid）：根页、楼中楼回显与 detail 一致变化。"""
        self.oid = oid
        for reply in self.replies:
            reply["oid"] = int(oid)
        self.state["basic"] = {"comment_id_str": oid, "comment_type": 17, "rid_str": oid}

    def append(self, how_many, *, stale=False):
        """热帖新增；`stale=True` 表示根页这一轮没有被重读，楼中楼只看到旧 rcount。"""
        start = len(self.replies)
        self.replies = self.replies + [make_reply(index) for index in range(start, start + how_many)]
        if not stale:
            self.state["roots"][0]["rcount"] = len(self.replies)

    def remove(self, how_many):
        del self.replies[:how_many]
        self.state["roots"][0]["rcount"] = len(self.replies)

    @property
    def pages(self):
        """ROOT 这一栋楼真实请求过的页码（来源零回复的楼不计入）。"""
        return [page for root_id, page in self.state["reply_pages"] if root_id == ROOT]

    def clear_pages(self):
        self.state["reply_pages"].clear()

    @property
    def ids(self):
        return [reply["rpid_str"] for reply in self.replies]

    def __call__(self, request):
        path = request.url.path
        if self.fail_html and request.url.host == "www.bilibili.com":
            raise httpx.ReadError("FICTIONAL_SECRET_HTML https://secret.invalid/token")
        if path == "/x/v2/reply/count":
            payload = count_fixture()
            payload["data"]["count"] = len(self.replies)
            return httpx.Response(200, json=payload)
        if path == "/x/v2/reply":
            # 根页：回显当前评论资源身份，locator 变化时与新资源一致。
            oid, kind = int(request.url.params["oid"]), int(request.url.params["type"])
            number = int(request.url.params["pn"])
            roots = self.state["roots"]
            payload = copy.deepcopy(root_fixture())
            payload["data"]["page"].update(num=number, size=20, count=len(roots),
                                           acount=len(roots) + 5)
            payload["data"]["replies"] = roots[(number - 1) * 20:number * 20] or None
            payload["data"]["hots"] = []
            if number == 1:
                payload["data"]["upper"] = {"mid": UID, "top": None}
            else:
                payload["data"].pop("upper", None)
            for item in payload["data"]["replies"] or []:
                item.update(oid=oid, type=kind)
            return httpx.Response(200, json=payload)
        if path != "/x/v2/reply/reply":
            return self.inner(request)
        root_id = request.url.params["root"]
        number = int(request.url.params["pn"])
        assert request.url.params["ps"] == "20"
        self.state["reply_pages"].append((root_id, number))
        if self.fail_page == number:
            raise httpx.ReadError("FICTIONAL_SECRET_REPLY https://secret.invalid/token")
        replies = self.replies if root_id == ROOT else []
        payload = copy.deepcopy(reply_fixture())
        payload["data"]["page"].update(num=number, size=20, count=len(replies))
        payload["data"]["replies"] = replies[(number - 1) * 20:number * 20] or None
        payload["data"]["root"].update(rpid_str=root_id, rpid=int(root_id), rcount=len(replies),
                                       oid=int(self.oid), type=17)
        return httpx.Response(200, json=payload)


def initial(path, source, *, first=False):
    """真实归档装配的显式初始化：唯一替换的是上游 HTTP。"""
    with archive_client(path, source) as api:
        if first:
            prepare(api)
        assert api.post("/api/sync/initial", json={"uid": UID}).status_code == 200


def check_once(path, source, clock=None):
    """走真实 Collector 的检查＋待处理执行链，只替换外部 HTTP 与墙钟。"""
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=clock or ControlledClock())
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()

    asyncio.run(scenario())


def document(path):
    with archive_client(path) as api:
        return api.get(ARCHIVE).json()


def archived_replies(path, root_id=ROOT):
    items = []
    with archive_client(path) as api:
        url = f"{COMMENTS}/{root_id}/replies"
        while url:
            page = api.get(url).json()
            items.extend(page["items"])
            cursor = page["next_cursor"]
            url = f"{COMMENTS}/{root_id}/replies?cursor={cursor}" if cursor else None
    return items


def position(path, root_id=ROOT):
    return Store(path).read_reply_scan(DYNAMIC, root_id)


def test_failed_full_scan_resumes_from_anchor_after_reopen_without_rescanning_head(tmp_path, events):
    path = tmp_path / "reply-resume.sqlite"
    source = HotSource(45)
    source.fail_page = 3
    initial(path, source, first=True)
    assert source.pages == [1, 2, 3]

    saved = document(path)
    assert saved["local_reply_count"] == 40
    assert saved["replies_last_attempt"] == "failed"
    assert saved["work"]["replies"] == "pending"
    stopped = position(path)
    assert (stopped.stage, stopped.direction, stopped.phase, stopped.next_page,
            stopped.anchor_page, stopped.confirmed) == ("replies", "forward", "pages", 3, 2, 40)
    assert stopped.anchor_ids == tuple(source.ids[20:40])
    assert stopped.locator == {"oid": "99123", "type": 17, "source": "basic"}

    # 关闭重开：新进程、新 Store，先复核第 2 页锚点再续第 3 页，不从第一页重扫。
    source.fail_page = None
    source.clear_pages()
    initial(path, source)
    assert source.pages == [2, 3, 4, 4]

    saved = document(path)
    assert saved["local_reply_count"] == 45
    assert saved["replies_last_attempt"] == "success"
    assert saved["work"]["replies"] == "success"
    assert sorted(reply["id"] for reply in archived_replies(path)) == sorted(source.ids)
    finished = position(path)
    assert (finished.phase, finished.confirmed) == ("complete", 45)
    log = events()
    page_two = source.ids[20:40]
    assert "reply_page_saved" in log and "reply_scan_position" in log
    assert "resume=regenerated" in log
    assert 'dynamic_id="123"' in log and f'root_id="{ROOT}"' in log
    assert "direction=forward" in log
    assert "reply_ids=[" + ",".join(f'"{item}"' for item in page_two) + "]" in log
    assert "checkpoint=accepted" in log
    for forbidden in ("FICTIONAL_SECRET", "https://", "token", "回复 30000"):
        assert forbidden not in log


def test_incremental_tail_resumes_from_committed_pages_after_reopen(tmp_path):
    path = tmp_path / "reply-tail.sqlite"
    source = HotSource(25)
    initial(path, source, first=True)
    assert source.pages == [1, 2, 3, 3]

    source.append(25)
    source.fail_page = 2
    source.clear_pages()
    check_once(path, source)
    # 末页倒序增量：先提交最新第 3 页，第 2 页失败时已得内容保留。
    assert source.pages == [3, 2]
    assert document(path)["local_reply_count"] == 35
    stopped = position(path)
    assert (stopped.direction, stopped.phase, stopped.next_page, stopped.anchor_page) == (
        "reverse", "pages", 2, 3)
    assert stopped.anchor_ids == tuple(source.ids[40:50])

    # 关库重开：失败楼沿用同方向断点继续，不退回整楼从头正序全扫。
    source.fail_page = None
    source.clear_pages()
    check_once(path, source)
    assert source.pages == [3, 2, 1]
    saved = document(path)
    assert saved["local_reply_count"] == 50
    assert saved["replies_last_attempt"] == "success"
    assert sorted(reply["id"] for reply in archived_replies(path)) == sorted(source.ids)
    assert position(path).phase == "complete"


def test_page_movement_relocates_only_affected_pages_and_keeps_archived_replies(tmp_path, events):
    path = tmp_path / "move.sqlite"
    source = HotSource(45)
    source.fail_page = 3
    initial(path, source, first=True)
    assert source.pages == [1, 2, 3]

    # 中断期间倒序方向没走完；先把它跑完再制造页移动。
    source.fail_page = None
    source.clear_pages()
    initial(path, source)
    assert source.pages == [2, 3, 4, 4]

    archived_before = {reply["id"] for reply in archived_replies(path)}
    removed = source.ids[:5]
    source.remove(5)      # 头部删除：后面各页整体前移
    source.append(10)     # 末尾新增：末页后移
    source.clear_pages()
    check_once(path, source)

    log = events()
    saved = document(path)
    assert saved["replies_last_attempt"] == "success"
    archived = {reply["id"] for reply in archived_replies(path)}
    # 删除不删历史回复，新增全部取得。
    assert set(removed) <= archived and archived_before <= archived
    assert archived == archived_before | set(source.ids)
    # 只重定位必要区段：从末页倒序走到已知页后收束，不整楼从头正扫。
    assert source.pages[0] == 3
    assert len(source.pages) <= 3
    assert "reply_scan_resumed" in log and "direction=reverse" in log
    assert position(path).phase == "complete"


def test_locator_change_rebuilds_progress_without_mixing_resources(tmp_path):
    path = tmp_path / "locator.sqlite"
    source = HotSource(45)
    source.fail_page = 3
    initial(path, source, first=True)
    before = position(path)
    assert before.locator["oid"] == "99123"

    # 页面信号不可用时检查会重新核对 detail 定位；这是既有代码里 locator 真正会变的路径。
    source.relocate("99124")
    source.fail_html = True
    source.fail_page = None
    source.clear_pages()
    check_once(path, source)

    saved = document(path)
    assert saved["replies_last_attempt"] == "success"
    after = position(path)
    assert after.locator["oid"] == "99124"
    # 换资源后从头重建位置，旧资源已归档的回复不删除、也不冒充新资源的已确认分片。
    assert source.pages[0] == 1
    assert after.phase == "complete"
    assert len(archived_replies(path)) >= len(source.ids)


def test_single_page_steps_are_restartable_from_the_store(tmp_path):
    path = tmp_path / "reply-steps.sqlite"
    source = HotSource(25)
    initial(path, source, first=True)
    source.append(25)

    async def scenario():
        store = Store(path)
        generation = store.claim_archive(UID, DYNAMIC)
        assert generation is not None
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            # 每一步都只依赖存储里的进度：新 Store、新客户端也能接着走。
            step = await reply_scan_step(Store(path), client, DYNAMIC, generation, ROOT,
                                         resume=True, observed=50)
            assert (step.status, step.direction, step.page, step.next_page) == (
                "page", "reverse", 3, 2)
            assert step.new == 10 and step.confirmed == 10
            assert Store(path).read_reply_scan(DYNAMIC, ROOT).next_page == 2
            step = await reply_scan_step(Store(path), client, DYNAMIC, generation, ROOT)
            assert (step.status, step.page, step.next_page) == ("page", 2, 1)
            step = await reply_scan_step(Store(path), client, DYNAMIC, generation, ROOT)
            assert (step.status, step.reason) == ("complete", "first_page")
            assert Store(path).read_reply_scan(DYNAMIC, ROOT).phase == "complete"
            # 整楼成功记录与最后一页同一事务（轮级 summary 由整轮驱动写）；再次调用不再请求上游。
            assert Store(path).reply_progress(DYNAMIC)[ROOT]["status"] == "success"
            source.clear_pages()
            again = await reply_scan_step(Store(path), client, DYNAMIC, generation, ROOT)
            assert again.status == "complete" and source.pages == []

    asyncio.run(scenario())
    assert sorted(reply["id"] for reply in archived_replies(path)) == sorted(source.ids)


def test_stale_execution_cannot_request_or_overwrite_newer_reply_progress(tmp_path):
    path = tmp_path / "reply-stale.sqlite"
    source = HotSource(45)
    source.fail_page = 3
    initial(path, source, first=True)
    store = Store(path)
    old = store.read_reply_scan(DYNAMIC, ROOT)

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=ControlledClock())
            await collector.check_once(UID, DYNAMIC)
            newer = Store(path).claim_archive(UID, DYNAMIC)
            assert newer == old.generation + 1
            source.fail_page = None
            source.clear_pages()
            stale = await reply_scan_step(Store(path), client, DYNAMIC, old.generation, ROOT,
                                          resume=True)
            # 旧代次连一次上游页都不请求，也不改写新进度行。
            assert stale.status == "stale" and source.pages == []
            assert Store(path).read_reply_scan(DYNAMIC, ROOT) == old

    asyncio.run(scenario())


def test_risk_pause_mid_chain_keeps_progress_without_fake_failure(tmp_path):
    path = tmp_path / "reply-paused.sqlite"
    source = HotSource(45)
    source.fail_page = 3
    initial(path, source, first=True)
    before = position(path)
    saved_before = document(path)
    source.fail_page = None

    class Pausing:
        """风控优先于楼级失败：第二次楼中楼请求返回保护暂停。"""

        calls = 0
        last_reply_page = None

        async def get(self, url, **kwargs):
            if url.endswith("/x/v2/reply/reply"):
                self.calls += 1
                if self.calls > 1:
                    raise SourceRiskPaused({"state": "cooldown", "backoff_step": 1})
            request = httpx.Request("GET", url, params=kwargs.get("params"))
            response = source(request)
            response.request = request
            return response

    async def scenario():
        store = Store(path)
        generation = store.claim_archive(UID, DYNAMIC)
        assert generation is not None
        with pytest.raises(SourceRiskPaused):
            await sync_replies(store, Pausing(), DYNAMIC, generation, ({ROOT: 45, ZERO_ROOT: 0}, 2),
                               uid=UID, now=lambda: "2026-10-27T12:00:00+00:00")

    asyncio.run(scenario())
    # 暂停不是楼级失败：沿用上一轮的失败事实，不写新失败、不伪造成功时间。
    progress = Store(path).reply_progress(DYNAMIC)[ROOT]
    assert progress["status"] == "failed"
    assert progress["synced_at"] == Store(path).reply_progress(DYNAMIC)[ROOT]["synced_at"]
    saved = document(path)
    assert saved["replies_last_attempt"] != "success"
    assert saved["replies_last_succeeded_at"] == saved_before["replies_last_succeeded_at"]
    # 暂停前已提交的页与断点保留，恢复后从新末页倒序继续。
    after = position(path)
    assert (after.direction, after.phase, after.anchor_page, after.next_page) == (
        "reverse", "pages", 3, 2)
    assert len(archived_replies(path)) == 45
    assert before.anchor_page == 2 and before.phase == "pages"


def test_hot_root_converges_across_rounds_without_unconditional_full_rescans(tmp_path):
    path = tmp_path / "hot.sqlite"
    source = HotSource(25)
    clock = ControlledClock()
    with archive_client(path, source) as api:
        prepare(api)
    check_once(path, source, clock)
    assert source.pages == [1, 2, 3, 3]

    request_pages, archived_counts = [], []
    for how_many in (25, 10, 30):
        source.append(how_many)
        source.clear_pages()
        clock.advance(60)
        check_once(path, source, clock)
        request_pages.append(list(source.pages))
        archived_counts.append(len(archived_replies(path)))

    # 热帖持续新增：每轮从末页倒序起步、命中已知页后再重叠一页收束，不整楼重扫；
    # 已确认进度只增不减，请求数随新增量而非历史总量增长。
    assert request_pages == [[3, 2, 1], [3, 2, 1], [5, 4, 3, 2]]
    assert archived_counts == sorted(archived_counts) == [50, 60, 90]
    assert all(reply["id"] for reply in archived_replies(path))

    # 页移动（头部删除）后仍然收敛，删掉的回复不删历史、不影响剩余区段。
    removed = source.ids[:10]
    source.remove(10)
    source.append(5)
    source.clear_pages()
    clock.advance(60)
    check_once(path, source, clock)
    assert len(source.pages) <= 4
    archived = {reply["id"] for reply in archived_replies(path)}
    assert set(removed) <= archived
    assert archived == set(source.ids) | set(removed)
    assert document(path)["replies_last_attempt"] == "success"
    assert position(path).phase == "complete"


def test_stale_zero_deep_root_is_rechecked_by_calibration_instead_of_skipped_forever(tmp_path):
    path = tmp_path / "stale-zero.sqlite"
    source = HotSource(0)
    clock = ControlledClock()
    with archive_client(path, source) as api:
        prepare(api)
    check_once(path, source, clock)
    # 楼层来源明确零：不发楼中楼请求。
    assert source.pages == []
    assert Store(path).reply_progress(DYNAMIC)[ROOT]["observed_count"] == 0

    # 深层根（06 早停留下的旧 rcount=0）新增了回复，但这一轮根页没有重读它；
    # 动态评论数照常变化，因此本轮确实会进入楼中楼阶段。
    source.append(3, stale=True)
    clock.advance(60 * 60)
    source.clear_pages()
    check_once(path, source, clock)
    # 校准未到期：沿用旧零不再请求，也不删除旧内容（有界）。
    assert source.pages == []
    assert len(archived_replies(path)) == 0

    # 24 小时校准到期：即使仍只有旧零，也必须真的请求一次，取得新增回复。
    source.append(1, stale=True)
    clock.advance(24 * 60 * 60)
    source.clear_pages()
    check_once(path, source, clock)
    # 没有本地回复可续采：从首屏正序读一次（含空尾确认），取得全部新增回复。
    assert source.pages == [1, 2, 2]
    assert sorted(reply["id"] for reply in archived_replies(path)) == sorted(source.ids)
    assert Store(path).reply_progress(DYNAMIC)[ROOT]["observed_count"] == 0
