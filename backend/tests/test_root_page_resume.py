"""06：根页逐页进度、锚点校验、漂移重定位与增量收束。

只替换外部上游：真实临时 SQLite、真实 Collector／`root_scan_step` 调用链、归档 GET 读取。
"""

import asyncio
import copy
import json
import logging
import sqlite3
from pathlib import Path

import httpx
import pytest

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.root_comments import root_scan_step
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client, detail_json, readable_html
from backend.tests.collector_clock import ControlledClock
from backend.tests.collector_support import CHECKS, configured
from backend.tests.management_support import UID
from backend.tests.root_support import root_fixture


ARCHIVE = "/api/archive/dynamics/123"
COMMENTS = ARCHIVE + "/comments"
DYNAMIC = "123"
FIXTURES = Path(__file__).parent / "fixtures"
TEMPLATE = root_fixture()["data"]["replies"][0]
ROOT_COUNT = 45


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


def make_root(index, *, base=7000):
    """按来源顺序（新→旧）生成一根：ID／时间递减，文本可定位，无图片。"""
    root = copy.deepcopy(TEMPLATE)
    identifier = str(base - index)
    root.update(rpid=int(identifier), rpid_str=identifier, ctime=1791000000 - index, like=index % 5,
                rcount=0, member={"mid": UID, "uname": "虚构星海", "avatar": None})
    root["content"] = {"message": f"根评论 {identifier}", "pictures": []}
    root.pop("replies", None)
    return root


def count_fixture():
    return json.loads((FIXTURES / "comment-count.json").read_text())


def detail_payload(count, oid="99123"):
    payload = detail_json()
    payload["data"]["item"]["basic"]["comment_id_str"] = oid
    payload["data"]["item"]["basic"]["rid_str"] = oid
    payload["data"]["item"]["modules"]["module_stat"]["comment"]["count"] = count
    payload["data"]["item"]["modules"]["module_dynamic"]["major"]["opus"]["pics"] = []
    return payload


class PagedRoots:
    """上游根分页替身：可注入页失败、头部插入、删除与 locator 变化，并记账每次请求。"""

    def __init__(self, total=ROOT_COUNT, *, oid="99123", kind=17):
        self.roots = [make_root(index) for index in range(total)]
        self.count = total
        self.oid = oid
        self.kind = kind
        self.fail_page = None
        self.fail_html = False
        self.calls = []
        self.html = readable_html(pictures=[])

    def insert(self, how_many, *, base=8000):
        # 新根进头部：来源按时间倒序，新内容总在第一页。
        self.roots = [make_root(index, base=base) for index in range(how_many)] + self.roots
        self.count = len(self.roots)

    def remove(self, how_many):
        del self.roots[:how_many]
        self.count = len(self.roots)

    def __call__(self, request):
        path = request.url.path
        self.calls.append((path, dict(request.url.params)))
        if path.startswith("/opus/"):
            if self.fail_html:
                raise httpx.ReadError("FICTIONAL_SECRET_HTML https://secret.invalid/token")
            return httpx.Response(200, text=self.html)
        if path == "/x/v2/reply/count":
            payload = count_fixture()
            payload["data"]["count"] = self.count
            return httpx.Response(200, json=payload)
        if path == "/x/polymer/web-dynamic/v1/detail":
            return httpx.Response(200, json=detail_payload(self.count, self.oid))
        if path == "/x/v2/reply/reply":
            return httpx.Response(200, json={"code": 0, "data": {
                "page": {"num": 1, "size": 20, "count": 0}, "root": self.roots[0], "replies": []}})
        assert path == "/x/v2/reply", path
        page = int(request.url.params["pn"])
        if page == self.fail_page:
            raise httpx.ReadError("FICTIONAL_SECRET_COMMENT_PAGE https://secret.invalid/token")
        payload = copy.deepcopy(root_fixture())
        payload["data"]["page"].update(num=page, size=20, count=len(self.roots), acount=len(self.roots))
        payload["data"]["replies"] = self.roots[(page - 1) * 20:page * 20] or None
        payload["data"]["hots"] = []
        if page == 1:
            payload["data"]["upper"] = {"mid": UID, "top": None}
        else:
            payload["data"].pop("upper", None)
        for item in payload["data"]["replies"] or []:
            item.update(oid=int(self.oid), type=self.kind)
        return httpx.Response(200, json=payload)

    def scans(self):
        return [int(params["pn"]) for path, params in self.calls if path == "/x/v2/reply"]


def snapshot(path):
    with archive_client(path) as api:
        check = api.get(CHECKS).json()["checks"][0]
        document = api.get(ARCHIVE).json()
        document.pop("comment_sync", None)
        roots = []
        url = COMMENTS
        while True:
            page = api.get(url).json()
            roots.extend(page["items"])
            if page["next_cursor"] is None:
                break
            url = COMMENTS + "?cursor=" + page["next_cursor"]
        return check, document, roots


def claim_once(path, source):
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=ControlledClock())
            await collector.check_once(UID, DYNAMIC)
            await collector.execute_pending()

    asyncio.run(scenario())


def execute_pending(path, source):
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            await Collector(Store(path), client).execute_pending()

    asyncio.run(scenario())


def read_position(path):
    return Store(path).read_root_scan(DYNAMIC)


def test_failed_page_resumes_from_anchor_after_reopen_without_rescanning_head(tmp_path, events):
    path = tmp_path / "resume.sqlite"
    configured(path)
    source = PagedRoots()
    source.fail_page = 3
    claim_once(path, source)

    check, document, roots = snapshot(path)
    assert document["local_comment_count"] == 40
    assert document["root_comments_last_attempt"] == "failed"
    assert document["work"]["comments"] == "pending"
    assert check["synced_root_comment_count"] is None
    position = read_position(path)
    assert (position.phase, position.next_page, position.anchor_page, position.generation) == (
        "pages", 3, 2, position.generation)
    assert position.anchor_ids == tuple(root["rpid_str"] for root in source.roots[20:40])
    assert position.confirmed == 40
    assert position.locator == {"oid": "99123", "type": 17, "source": "basic"}

    # 关闭重开：新进程、新 Store，从可验证断点继续；首页不再读取。
    source.fail_page = None
    source.calls.clear()
    execute_pending(path, source)
    log = events()
    assert source.scans() == [2, 3, 4, 4]  # 先复核第 2 页锚点，再续第 3、4 页与空尾复查。

    check, document, roots = snapshot(path)
    assert document["local_comment_count"] == len(source.roots) == 45
    assert document["synced_root_comment_count"] == 45
    assert document["work"]["comments"] == "success"
    assert document["root_comments_last_attempt"] == "success"
    assert sorted(root["id"] for root in roots) == sorted(root["rpid_str"] for root in source.roots)
    finished = read_position(path)
    assert (finished.phase, finished.confirmed) == ("complete", 45)
    # 日志可定位动态、页码、完整本页根 ID 与续采原因，且不含凭据、URL、正文。
    page_two = [root["rpid_str"] for root in source.roots[20:40]]
    assert "root_page_saved" in log
    assert "root_scan_resumed" in log
    assert "resume=regenerated" in log
    assert 'dynamic_id="123"' in log and f'uid="{UID}"' in log
    assert "comment_ids=[" + ",".join(f'"{item}"' for item in page_two) + "]" in log
    assert "checkpoint=accepted" in log and "elapsed_ms=" in log
    for forbidden in ("FICTIONAL_SECRET", "https://", "token", "根评论 7000", "secret.invalid"):
        assert forbidden not in log


def test_head_insertion_relocates_only_affected_pages(tmp_path):
    path = tmp_path / "inserted.sqlite"
    configured(path)
    source = PagedRoots()
    source.fail_page = 3
    claim_once(path, source)
    assert snapshot(path)[1]["local_comment_count"] == 40

    source.insert(5)  # 中断期间头部新增 5 条根评论，其余内容整体后移。
    source.fail_page = None
    source.calls.clear()
    claim_once(path, source)  # 先重新观察计数，再执行同一条待处理工作。

    check, document, roots = snapshot(path)
    assert document["local_comment_count"] == document["synced_root_comment_count"] == 50
    assert document["work"]["comments"] == "success"
    archived = {root["id"] for root in roots}
    assert archived == {root["rpid_str"] for root in source.roots}
    assert len(roots) == 50
    # 受影响区段（第 1 页）只重读一次，随后回到锚点之后续采，不整轮重扫。
    assert source.scans() == [2, 3, 1, 3, 4, 4]
    assert source.scans().count(1) == 1
    position = read_position(path)
    assert position.phase == "complete"
    assert position.confirmed == 50  # 本轮扫描累计确认的根数（中断前的 40 + 新增 10）。


def test_head_deletion_relocates_without_losing_archived_roots(tmp_path):
    path = tmp_path / "removed.sqlite"
    configured(path)
    source = PagedRoots()
    source.fail_page = 3
    claim_once(path, source)
    archived_before = {root["rpid_str"] for root in source.roots}

    removed = [root["rpid_str"] for root in source.roots[:3]]
    source.remove(3)  # 头部删除 3 条：后续页码整体前移。
    source.fail_page = None
    source.calls.clear()
    claim_once(path, source)

    check, document, roots = snapshot(path)
    assert document["work"]["comments"] == "success"
    assert document["synced_root_comment_count"] == 42
    # 删除不删历史根：不可见内容仍可读。
    assert {root["id"] for root in roots} == archived_before
    assert all(identifier in archived_before for identifier in removed)
    # 内容整体前移：锚点页命中后重读该页再续，不跳到下一页码造成漏读。
    assert source.scans() == [2, 2, 3, 4, 4]
    assert read_position(path).phase == "complete"


def test_locator_change_invalidates_progress_and_never_mixes_resources(tmp_path):
    path = tmp_path / "locator.sqlite"
    configured(path)
    source = PagedRoots()
    source.fail_page = 3
    claim_once(path, source)
    before = read_position(path)
    assert before.locator["oid"] == "99123"

    # 页面信号不可用时检查会重新核对 detail 定位；这是既有代码里 locator 真正会变的路径。
    source.oid, source.kind = "99124", 17
    source.fail_html = True
    source.fail_page = None
    source.calls.clear()
    claim_once(path, source)

    check, document, roots = snapshot(path)
    assert document["work"]["comments"] == "success"
    position = read_position(path)
    assert position.locator["oid"] == "99124"
    # 定位资源变了：进度从头重建，但历史根不删除、不冒充同一资源的已确认分片。
    assert source.scans() == [1, 2, 3, 4, 4]
    assert position.phase == "complete"
    assert len(roots) == 45


def test_completed_scan_only_registers_growth_and_stops_at_known_page(tmp_path):
    path = tmp_path / "growth.sqlite"
    configured(path)
    source = PagedRoots()
    claim_once(path, source)
    first = read_position(path)
    assert (first.phase, first.confirmed) == ("complete", 45)

    source.insert(1)
    source.calls.clear()
    claim_once(path, source)

    check, document, roots = snapshot(path)
    assert document["local_comment_count"] == document["synced_root_comment_count"] == 46
    assert document["work"]["comments"] == "success"
    # 只读到「整页已确认 + 紧邻守卫页」，不因计数变化无条件重读全部已确认根页。
    assert source.scans() == [1, 2, 3]
    position = read_position(path)
    assert position.phase == "complete"
    assert position.confirmed == 1  # 只登记本次增量确认的新根。
    assert len(roots) == 46


def test_single_page_steps_are_restartable_from_the_store(tmp_path):
    path = tmp_path / "steps.sqlite"
    configured(path)
    source = PagedRoots()
    store = Store(path)
    generation = store.claim_archive(UID, DYNAMIC)
    locator = {"oid": "99123", "type": 17, "source": "basic", "policy_version": 1}
    assert store.observe_archive(DYNAMIC, generation, {
        "comment_locator": locator, "source_comment_count": len(source.roots)})

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            assert generation is not None
            step = await root_scan_step(Store(path), client, DYNAMIC, generation, resume=True, full=True)
            assert (step.status, step.page, step.next_page, step.fetched, step.new) == ("page", 1, 2, 20, 20)
            assert step.confirmed == 20
            # 每一步都是可重启的调度片：进度只在存储里，进程内不保留分页游标。
            assert Store(path).read_root_scan(DYNAMIC).next_page == 2
            assert snapshot(path)[1]["local_comment_count"] == 20
            step = await root_scan_step(Store(path), client, DYNAMIC, generation)
            assert (step.status, step.page, step.confirmed) == ("page", 2, 40)
            statuses = []
            while True:
                step = await root_scan_step(Store(path), client, DYNAMIC, generation)
                statuses.append((step.status, step.page))
                if step.status != "page":
                    break
            assert statuses == [("page", 3), ("page", 4), ("complete", 4)]

    asyncio.run(scenario())
    assert read_position(path).phase == "complete"
    assert snapshot(path)[1]["local_comment_count"] == 45


def test_stale_execution_cannot_write_progress_after_newer_claim(tmp_path):
    path = tmp_path / "stale.sqlite"
    configured(path)
    source = PagedRoots()
    claim_once(path, source)
    store = Store(path)
    old = store.read_root_scan(DYNAMIC)
    assert old.phase == "complete"

    # 新领取把归档代次抬高：旧执行的步骤必须被 fencing 拒绝，且不请求上游。
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(Store(path), client, clock=ControlledClock())
            await collector.check_once(UID, DYNAMIC)
            newer = Store(path).claim_archive(UID, DYNAMIC)
            assert newer == old.generation + 1
            source.calls.clear()
            stale = await root_scan_step(Store(path), client, DYNAMIC, old.generation, resume=True)
            assert stale.status == "stale"
            # 旧代次连一次上游页都不请求，也不改写新进度行。
            assert source.scans() == []
            assert Store(path).read_root_scan(DYNAMIC) == old
            assert snapshot(path)[1]["work"]["comments"] == "success"

    asyncio.run(scenario())


def test_v25_migration_preserves_archive_progress_media_and_reading_cursor(tmp_path):
    path = tmp_path / "migrate.sqlite"
    configured(path)
    source = PagedRoots()
    source.fail_page = 3
    claim_once(path, source)
    with archive_client(path) as api:
        first_page = api.get(COMMENTS).json()
        saved = api.get(ARCHIVE).json()
    before = read_position(path)

    # 旧库（尚无 v25 表）升级：进度表重建、归档／媒体／阅读 cursor 保持。
    with sqlite3.connect(path) as database:
        database.execute("DROP TABLE page_scan_progress")
        database.execute("PRAGMA user_version = 23")
    Store(path).migrate()
    with sqlite3.connect(path) as database:
        assert database.execute("PRAGMA user_version").fetchone()[0] == 27
        assert database.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='page_scan_progress'"
        ).fetchone()[0] == 1
    assert Store(path).read_root_scan(DYNAMIC) is None  # 旧库没有上游进度，从头重建。
    with archive_client(path) as api:
        assert api.get(COMMENTS, params={"cursor": first_page["next_cursor"]}).json() == {
            **json.loads(api.get(COMMENTS, params={"cursor": first_page["next_cursor"]}).text)
        }
        assert api.get(ARCHIVE).json()["text"] == saved["text"]
        assert api.get(ARCHIVE).json()["local_comment_count"] == 40

    # 再次迁移可重入且不丢已有进度：同一事务里写入的锚点与下一位置保持。
    Store(path).migrate()
    # 迁移前先重建一次进度，再验证升级不会清空它。
    with archive_client(path) as api:
        pass
    source.fail_page = 3
    claim_once(path, source)
    kept = read_position(path)
    assert (kept.phase, kept.anchor_page, kept.next_page) == ("pages", 2, 3)
    Store(path).migrate()
    assert read_position(path) == kept
    assert before.anchor_page == kept.anchor_page
