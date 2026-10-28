"""08：单路重型、跨目标分页轮转、目标互斥与租约接管（隔离 SQLite）。"""

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app
from backend.bili_monitor.collector import Collector
from backend.bili_monitor.dispatch import DispatchLeases
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import readable_html
from backend.tests.collector_support import configured
from backend.tests.management_support import UID, profile_response
from backend.tests.root_support import root_fixture


IDS = tuple(f"9100{index}" for index in range(1, 9))
HUGE = "91001"
HUGE_ROOT = "900719925474099399000"
HUGE_TOTAL = 10000
FIXTURES = Path(__file__).parent / "fixtures"


def reply_template():
    return json.loads((FIXTURES / "replies.json").read_text())["data"]["replies"][0]


class HugeSource:
    """8 个目标、其中一个含一万条楼中楼回复；只替换外部 HTTP。"""

    def __init__(self):
        self.calls = []
        self.first_huge_reply = asyncio.Event()

    def __call__(self, request):
        path = request.url.path
        params = dict(request.url.params)
        self.calls.append((path, params))
        dynamic = params.get("id") or params.get("oid")
        if not dynamic:
            dynamic = path.rsplit("/", 1)[-1] if path.startswith("/opus/") else ""
        huge = dynamic in (HUGE, HUGE)
        if path == "/x/web-interface/card":
            return profile_response(request)
        if path.startswith("/opus/"):
            return httpx.Response(200, text=readable_html(id=dynamic, pictures=[])
                                  .replace('"count":7', '"count":0'))
        if path == "/x/polymer/web-dynamic/v1/detail":
            payload = json.loads((FIXTURES / "detail.json").read_text())
            item = payload["data"]["item"]
            item["id_str"] = dynamic
            item["basic"].update(comment_id_str=dynamic, rid_str=dynamic, comment_type=11)
            item["modules"]["module_stat"]["comment"]["count"] = HUGE_TOTAL if huge else 0
            item["modules"]["module_dynamic"]["major"]["opus"]["pics"] = []
            return httpx.Response(200, json=payload)
        if path == "/x/v2/reply/count":
            return httpx.Response(200, json={"code": 0, "data": {"count": HUGE_TOTAL if huge else 0}})
        if path == "/x/v2/reply":
            number = int(params["pn"])
            payload = (root_fixture() if huge else {
                "code": 0, "data": {"page": {"num": 1, "size": 20, "count": 0, "acount": 0},
                                    "replies": [], "hots": [], "upper": {"top": None}}})
            payload = json.loads(json.dumps(payload))
            if huge:
                root = payload["data"]["replies"][0]
                root.update(rpid_str=HUGE_ROOT, oid=int(dynamic), type=11, rcount=HUGE_TOTAL)
                root["content"] = {**root.get("content", {}), "pictures": []}
                payload["data"]["page"].update(num=number, count=1, acount=HUGE_TOTAL + 1)
                payload["data"]["replies"] = [root] if number == 1 else None
                payload["data"]["hots"] = []
                payload["data"]["upper"] = {"mid": int(UID), "top": None}
            else:
                payload["data"]["page"].update(num=number)
            return httpx.Response(200, json=payload)
        if path == "/x/v2/reply/reply":
            number = int(params["pn"])
            if not huge:
                return httpx.Response(200, json={
                    "code": 0, "data": {"page": {"num": number, "size": 20, "count": 0},
                                        "root": {}, "replies": []}})
            template = reply_template()
            root = json.loads(json.dumps(root_fixture()["data"]["replies"][0]))
            root.update(rpid_str=HUGE_ROOT, oid=int(dynamic), type=11, rcount=HUGE_TOTAL)
            root["content"] = {**root.get("content", {}), "pictures": []}
            start = (number - 1) * 20
            items = []
            if start < HUGE_TOTAL:
                for offset in range(20):
                    value = start + offset + 1
                    if value > HUGE_TOTAL:
                        break
                    item = json.loads(json.dumps(template))
                    item.update(rpid_str=str(900719925474099500000 + value),
                                root_str=HUGE_ROOT, parent_str=HUGE_ROOT,
                                oid=int(dynamic), type=11)
                    item["content"] = {**item.get("content", {}), "message": f"回复 {value}",
                                       "pictures": []}
                    items.append(item)
                self.first_huge_reply.set()
            return httpx.Response(200, json={
                "code": 0, "data": {"page": {"num": number, "size": 20, "count": HUGE_TOTAL},
                                    "root": root, "replies": items}})
        raise AssertionError(f"Unexpected upstream request: {path}")


@pytest.fixture
def source():
    return HugeSource()


def prepare_store(path):
    store = Store(path)
    store.migrate()
    store.add(UID, "虚构星海", "https://example.invalid/avatar.png")
    store.update(UID, "specified", 10, True)
    for id in IDS:
        store.add_target(UID, id)
    return store


@asynccontextmanager
async def _http_client_factory(client):
    yield client


def test_eight_targets_rotate_heavy_steps_and_complete_ten_thousand_replies(tmp_path, source):
    path = tmp_path / "fair.sqlite"
    store = prepare_store(path)

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(store, client,
                                  comment_client_factory=lambda uid: _http_client_factory(client))
            for id in IDS:
                assert await collector.check_once(UID, id)
            execution = asyncio.create_task(collector.execute_pending())
            # 轻量检查在重型分页之间仍有执行机会：巨大目标开始翻页后，检查一个已
            # 完成的目标仍可发出计数请求。
            await asyncio.wait_for(source.first_huge_reply.wait(), 5)
            light = asyncio.create_task(collector.check_once(UID, "91008", selection=None))
            await asyncio.wait_for(light, 5)
            await asyncio.wait_for(execution, 30)

    asyncio.run(scenario())

    checks = store.read_checks(UID)
    assert all(row["work"] == "complete" for row in checks)
    huge = store.read_archive(HUGE)
    assert huge["source_comment_count"] == HUGE_TOTAL
    assert huge["synced_reply_comment_count"] == huge["local_reply_count"] == HUGE_TOTAL
    assert huge["work"]["comments"] == huge["work"]["replies"] == "success"
    for id in IDS[1:]:
        archive = store.read_archive(id)
        assert archive["synced_comment_count"] == 0
        assert archive["work"]["comments"] == archive["work"]["replies"] == "success"

    root_pages = {params.get("oid"): index for index, (path, params) in enumerate(source.calls)
                  if path == "/x/v2/reply" and params.get("pn") == "1"}
    huge_reply_two = next(index for index, (path, params) in enumerate(source.calls)
                          if path == "/x/v2/reply/reply" and params.get("pn") == "2")
    # 其他目标在巨大目标翻到第 2 页之前都已取得根页机会；不是整条动态串行。
    for id in IDS[1:]:
        assert root_pages[id] < huge_reply_two


def test_target_lease_expiry_allows_safe_takeover_and_old_owner_cannot_release(tmp_path):
    path = tmp_path / "leases.sqlite"
    store = Store(path)
    store.migrate()

    class Clock:
        def __init__(self):
            self.value = "2030-01-01T00:00:00+00:00"

        def now(self):
            return self.value

    old = DispatchLeases(store, clock=Clock(), owner="old", target_ttl=1, heartbeat=False)
    new = DispatchLeases(store, clock=Clock(), owner="new", target_ttl=1, heartbeat=False)

    async def scenario():
        lease = await old.acquire_target(UID, "123")
        assert lease is not None
        assert await new.acquire_target(UID, "123") is None
        old.clock.value = "2030-01-01T00:00:02+00:00"
        new.clock.value = old.clock.value
        taken = await new.acquire_target(UID, "123")
        assert taken is not None
        # 旧 owner 失效后的释放不能删掉新 owner 的租约。
        await lease.release()
        assert await new.acquire_target(UID, "123") is None
        await taken.release()
        assert await new.acquire_target(UID, "123") is not None

    asyncio.run(scenario())


def test_api_initial_does_not_run_same_target_while_collector_holds_it(tmp_path):
    path = tmp_path / "mutex.sqlite"
    store = Store(path)
    store.migrate()
    store.add(UID, "虚构星海", "https://example.invalid/avatar.png")
    store.update(UID, "specified", 10, True)
    store.add_target(UID, "123")

    async def hold():
        leases = DispatchLeases(store, owner="collector")
        return await leases.acquire_target(UID, "123")

    hold_lease = asyncio.run(hold())
    try:
        def upstream(request):
            if request.url.path == "/x/web-interface/card":
                return profile_response(request)
            raise AssertionError("API must not touch the source while target is busy")

        with TestClient(create_app(path, profile_transport=httpx.MockTransport(upstream))) as api:
            response = api.post("/api/sync/initial", json={"uid": UID})
        assert response.status_code == 200
        assert response.json() == {"processed": 0, "succeeded": 0, "failed": 0}
    finally:
        asyncio.run(hold_lease.release())
