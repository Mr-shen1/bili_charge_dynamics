"""06 票：对话投影与只读 conversation 子资源；真实 Store／SQLite＋HTTP，只替换来源 HTTP。

关系只取已保存的 parent_id：一级评论是直接父级，父级缺失、跨根／跨动态与异常环都在断点
安全止步；昵称、正文前缀与 @ 文本不参与判定。page／location 响应只为当前页条目附带可空
投影，conversation 子资源缺省一次返回整段（显式 page 只作旧兼容），不新建持久 cursor 表或迁移。
"""

import copy
import json
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client
from backend.tests.root_support import ARCHIVE, COMMENTS, prepare, root_fixture, source_handler

DYNAMIC = "123"
ROOT = "900719925474099312346"
OTHER_ROOT = "900719925474099312400"
OTHER_DYNAMIC = "456"
REPLIES = f"/api/archive/dynamics/{DYNAMIC}/comments/{ROOT}/replies"
MISSING_PARENT = "9900"
FOREIGN_REPLY = "7001"

# 同一楼里 25 条回复；除时间序与父子关系外，作者昵称与部分正文刻意完全相同。
WIRING = {
    "9001": ROOT, "9002": "9001", "9003": "9001", "9004": "9002",
    "9005": "9001", "9006": "9001", "9007": "9001", "9008": "9001", "9009": "9001",
    "9010": "9001", "9011": "9001", "9012": "9001", "9013": "9001", "9014": "9001",
    "9015": ROOT, "9016": ROOT, "9017": ROOT, "9018": ROOT, "9019": ROOT, "9020": ROOT,
    "9021": MISSING_PARENT, "9022": "9021",
    "9023": "9024", "9024": "9023",
    "9025": FOREIGN_REPLY,
}


def author(nickname="同名回复者"):
    """同名作者：全部回复共用昵称与头像，关系仍只能由 parent_id 决定。"""
    return {"id": "909002", "nickname": nickname, "avatar_url": "https://example.invalid/same.png"}


def reply(id, parent_id, published_at):
    return {"id": id, "dynamic_id": DYNAMIC, "root_id": ROOT, "parent_id": parent_id,
            "author": author(), "published_at": published_at,
            "text": "同名正文前缀 回复 9001: 内容", "like_count": 0}


BASE_TIME = datetime(2026, 10, 14, 12, 0, 0, tzinfo=timezone(timedelta(hours=8)))


def stamp(index):
    """秒精度北京时间：index 越大越晚，超出小时安全进位。"""
    return (BASE_TIME + timedelta(seconds=index)).isoformat(timespec="seconds")


def save_reply(connection, document, *, dynamic=DYNAMIC, root=ROOT):
    connection.execute("INSERT OR REPLACE INTO replies VALUES (?, ?, ?, ?)",
                       (dynamic, root, document["id"], json.dumps(document)))


def seed(store, documents, foreign_document):
    root = {"id": ROOT, "dynamic_id": DYNAMIC, "root_id": "0", "parent_id": "0",
            "author": author("楼主"), "published_at": stamp(0), "text": "一级评论",
            "like_count": 0, "source_reply_count": len(documents), "local_reply_count": len(documents)}
    other_root = {"id": OTHER_ROOT, "dynamic_id": DYNAMIC, "root_id": "0", "parent_id": "0",
                  "author": author("楼主"), "published_at": stamp(0), "text": "另一个一级评论",
                  "like_count": 0, "source_reply_count": 1, "local_reply_count": 1}
    with store.connection() as connection, connection:
        connection.execute("INSERT INTO identities VALUES (?, ?, ?)", ("202", "uploader", None))
        connection.execute("INSERT INTO archives (id, uid, document) VALUES (?, ?, ?)",
                           (DYNAMIC, "202", json.dumps({"id": DYNAMIC})))
        for document in (root, other_root):
            connection.execute("INSERT INTO root_comments VALUES (?, ?, ?)",
                               (DYNAMIC, document["id"], json.dumps(document)))
        connection.execute(
            "INSERT INTO reply_sync (dynamic_id, root_id, status, synced_source_reply_count) VALUES (?, ?, ?, ?)",
            (DYNAMIC, ROOT, "success", len(documents)))
        # 故意反序插入：读取顺序只能来自时间与 ID，不沿用写入顺序。
        for document in reversed(documents):
            save_reply(connection, document)
        save_reply(connection, foreign_document, root=OTHER_ROOT)


def documents():
    """25 条回复：14 条属于 9001 起点的完整对话，另有独立、缺祖先、环与跨根条目。"""
    items = []
    for index in range(1, 26):
        id = str(9000 + index)
        published_at = None if id == "9025" else stamp(index)
        items.append(reply(id, WIRING[id], published_at))
    return items


def foreign_document():
    return reply(FOREIGN_REPLY, OTHER_ROOT, stamp(1))


@pytest.fixture
def archive(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Archive reads must not access credentials or upstream")

    monkeypatch.setattr("backend.bili_monitor.app.load_source_cookie_pairs", forbidden)
    monkeypatch.setattr("httpx.AsyncClient.send", forbidden)
    store = Store(tmp_path / "conversation.sqlite")
    store.migrate()
    seed(store, documents(), foreign_document())
    # 不进入 TestClient 上下文：运行 lifespan 会读取服务配置；读取路径不需要它。
    client = TestClient(create_app(store.path))
    try:
        yield store, client
    finally:
        client.close()


def conversations(document):
    return {item["id"]: item["conversation"] for item in document["items"]}


def test_page_reads_project_the_confirmable_conversation_for_the_current_page(archive):
    _store, client = archive
    first = client.get(REPLIES, params={"page": "1", "limit": "10"}).json()
    assert [item["id"] for item in first["items"]] == [str(9000 + index) for index in range(1, 11)]
    # 9001 是起点，其余同段成员都指向它；数量是整段本地对话量，与当前页无关。
    projected_first = conversations(first)
    assert set(projected_first) == {str(9000 + index) for index in range(1, 11)}
    assert all(value == {"start_id": "9001", "count": 14, "incomplete": False}
               for value in projected_first.values())
    second = client.get(REPLIES, params={"page": "2"}).json()
    projected = conversations(second)
    assert projected["9011"] == {"start_id": "9001", "count": 14, "incomplete": False}
    # 跨页：起点在前一页、成员在后续页；当前页不是判定边界。
    assert projected["9014"] == {"start_id": "9001", "count": 14, "incomplete": False}
    # 独立发言没有可读对话：同名作者与相同正文前缀都不构成关系证据。
    assert projected["9015"] is None and projected["9020"] is None
    third = client.get(REPLIES, params={"page": "3"}).json()
    assert [item["id"] for item in third["items"]] == [str(9000 + index) for index in range(21, 26)]
    remaining = conversations(third)
    # 父级缺失：断点止步、可确认的两条成段并标记上下文不完整；起点本身也带同一投影。
    assert remaining["9021"] == {"start_id": "9021", "count": 2, "incomplete": True}
    assert remaining["9022"] == {"start_id": "9021", "count": 2, "incomplete": True}
    # 异常环不会无界遍历：同一段可确认成员，标记不完整且起点稳定。
    assert remaining["9023"] == {"start_id": "9023", "count": 2, "incomplete": True}
    assert remaining["9024"] == {"start_id": "9023", "count": 2, "incomplete": True}
    # 父回复在另一个根里：不跨根合并，也没有可读对话。
    assert remaining["9025"] is None
    # 缺排序字段的条目仍安全可读（时间 null 后置），不参与关系猜测。
    assert third["items"][-1]["id"] == "9025"
    assert third["items"][-1]["published_at"] is None


def test_cursor_preview_keeps_its_frozen_shape_without_the_projection(archive):
    _store, client = archive
    preview = client.get(REPLIES, params={"limit": "3"}).json()
    assert [item["id"] for item in preview["items"]] == ["9001", "9002", "9003"]
    # cursor 预览不需要对话投影：字段根本不出现，不是伪造 false／null。
    assert all("conversation" not in item for item in preview["items"])


def test_location_response_carries_the_same_projection_for_its_page(archive):
    _store, client = archive
    page_two = client.get(REPLIES, params={"page": "2"}).json()
    located = client.get(f"{REPLIES}/9013/location").json()
    assert located["page"] == 2
    assert located["items"] == page_two["items"]
    assert conversations(located)["9014"] == {"start_id": "9001", "count": 14, "incomplete": False}
    assert conversations(located)["9016"] is None


def test_conversation_resource_returns_the_whole_confirmable_branch_in_one_read(archive):
    store, client = archive
    response = client.get(f"{REPLIES}/9004/conversation")
    assert response.status_code == 200
    body = response.json()
    assert body["dynamic_id"] == DYNAMIC
    assert body["root_id"] == ROOT
    assert body["reply_id"] == "9004"
    assert body["start_id"] == "9001"
    assert body["incomplete"] is False
    assert body["count"] == 14
    # 缺省即整段：不返回页码字段，字段缺席就是“整段模式”。
    assert "page" not in body
    assert body["next_cursor"] is None
    # 从起点按时间正序一次给出全部 14 条（超过一页也不截断）；一级评论不在会话正文里重复。
    assert [item["id"] for item in body["items"]] == [str(9000 + index) for index in range(1, 15)]
    assert "root" not in body
    # 同一响应条目与页码读取同源：排序与 reply_to 解析不另拼一套（会话条目不带投影）。
    page_items = {}
    for number in ("1", "2", "3"):
        for item in client.get(REPLIES, params={"page": number}).json()["items"]:
            page_items[item["id"]] = {key: value for key, value in item.items() if key != "conversation"}
    assert body["items"] == [page_items[item["id"]] for item in body["items"]]
    # 起点自己也是可读对话（返回整段），但界面上它没有入口。
    start = client.get(f"{REPLIES}/9001/conversation").json()
    assert start["start_id"] == "9001" and start["count"] == 14
    assert [item["id"] for item in start["items"]] == [str(9000 + index) for index in range(1, 15)]
    # 显式 page 是保留的旧兼容入口：与整段读取同一成员顺序，每页最多 10 条。
    second = client.get(f"{REPLIES}/9004/conversation", params={"page": "2", "limit": "10"}).json()
    assert second["page"] == 2
    assert second["count"] == 14
    assert second["items"] == body["items"][10:]
    # 页码越过末页是成功空页，带实际本地总数，由调用方收敛到末页。
    beyond = client.get(f"{REPLIES}/9004/conversation", params={"page": "9"}).json()
    assert beyond["items"] == [] and beyond["count"] == 14
    # 只读：不冻结回复 cursor 页，也不写归档。
    assert frozen_pages(store.path) == 0


def test_missing_ancestor_returns_only_the_confirmable_part_and_flags_it(archive):
    _store, client = archive
    partial = client.get(f"{REPLIES}/9022/conversation").json()
    assert partial["start_id"] == "9021"
    assert partial["incomplete"] is True
    assert [item["id"] for item in partial["items"]] == ["9021", "9022"]
    assert partial["count"] == 2
    # 跨根父回复：不拉入另一个根的内容，只保留可确认的一条并标记上下文不完整。
    foreign = client.get(f"{REPLIES}/9025/conversation").json()
    assert foreign["start_id"] == "9025"
    assert foreign["incomplete"] is True
    assert [item["id"] for item in foreign["items"]] == ["9025"]
    assert foreign["count"] == 1


def test_relationship_cycle_stays_bounded_and_never_fakes_a_start(archive):
    _store, client = archive
    for id in ("9023", "9024"):
        body = client.get(f"{REPLIES}/{id}/conversation").json()
        assert body["start_id"] == "9023"
        assert body["incomplete"] is True
        assert [item["id"] for item in body["items"]] == ["9023", "9024"]
        assert body["count"] == 2


def test_conversation_identity_errors_are_not_found_and_queries_are_validated(archive):
    _store, client = archive
    # 目标不存在、根不属于该动态、回复属于别的根／别的动态：一律 404，不暴露别楼内容。
    assert client.get(f"{REPLIES}/9999/conversation").status_code == 404
    assert client.get(f"{COMMENTS}/{OTHER_ROOT}/replies/9001/conversation").status_code == 404
    assert client.get(f"{REPLIES}/{FOREIGN_REPLY}/conversation").status_code == 404
    # 另一个根下自己的回复仍可读，只是不跨根合并。
    assert client.get(f"{COMMENTS}/{OTHER_ROOT}/replies/{FOREIGN_REPLY}/conversation").json()["count"] == 1
    assert client.get(f"{COMMENTS}/9999/replies/9001/conversation").status_code == 404
    assert client.get(f"/api/archive/dynamics/{OTHER_DYNAMIC}/comments/{ROOT}/replies/9001/conversation").status_code == 404
    # 非法页码／批量／未知与重复参数是 422 INVALID_INPUT，而不是空页或别页。
    # 批量只属于旧兼容的显式 page 模式：只给 limit 是冲突参数，同样拒绝。
    for query in ({"page": "0"}, {"page": "01"}, {"page": "abc"}, {"limit": "3"},
                  {"limit": "10"}, {"limit": "29"}, {"sort": "hot"}):
        assert client.get(f"{REPLIES}/9001/conversation", params=query).status_code == 422, query
    # 重复参数不静默取其中之一：显式 422，不猜调用方意图。
    assert client.get(f"{REPLIES}/9001/conversation?page=1&page=2").status_code == 422
    # 定位响应仍不接受新增参数。
    assert client.get(f"{REPLIES}/9001/location", params={"page": "1"}).status_code == 422


def test_conversation_reads_do_not_write_the_archive_or_access_upstream(archive):
    store, client = archive
    before = client.get(ARCHIVE).json()
    pages = frozen_pages(store.path)
    client.get(f"{REPLIES}/9004/conversation")
    client.get(f"{REPLIES}/9004/conversation", params={"page": "2"})
    assert client.get(ARCHIVE).json() == before
    assert frozen_pages(store.path) == pages


def frozen_pages(path):
    with sqlite3.connect(path) as connection:
        return connection.execute("SELECT COUNT(*) FROM reply_pages").fetchone()[0]


def raw_reply(root_id, index, parent, *, base=9000):
    return {
        "rpid_str": str(base + index), "oid": 99123, "type": 17,
        "root_str": root_id, "parent_str": parent,
        "ctime": 1791513500 + index, "like": 0,
        "member": {"mid": "909002", "uname": "同名回复者", "avatar": None},
        "content": {"message": f"虚构回复 {index}"},
    }


def relation_source(state):
    """根页 + 楼中楼页：parent_str 由夹具给出，验证真实归档链写下的关系。"""
    roots = source_handler(state)

    def handler(request):
        if request.url.path != "/x/v2/reply/reply":
            return roots(request)
        root_id = request.url.params["root"]
        page = int(request.url.params["pn"])
        state.setdefault("reply_pages", []).append((root_id, page))
        items = state["reply_sets"][root_id]
        payload = copy.deepcopy(json.loads(
            (Path(__file__).parent / "fixtures/replies.json").read_text()))
        payload["data"]["root"].update(rpid_str=root_id, root_str="0", parent_str="0", rcount=len(items))
        payload["data"]["page"].update(num=page, size=20, count=len(items))
        payload["data"]["replies"] = items[(page - 1) * 20:page * 20] or None
        return httpx.Response(200, json=payload)
    return handler


def relation_state():
    root = copy.deepcopy(root_fixture()["data"]["replies"][0])
    root.update(rpid_str=ROOT, rpid=ROOT, like=2, rcount=6)
    root["content"] = {"message": "虚构根评论", "pictures": []}
    root["replies"] = None
    return {
        "roots": [root],
        "dynamic_count": 1,
        "reply_sets": {ROOT: [
            raw_reply(ROOT, 1, ROOT),
            raw_reply(ROOT, 2, "9001"),
            raw_reply(ROOT, 3, "9001"),
            raw_reply(ROOT, 4, "9002"),
            raw_reply(ROOT, 5, ROOT),
            raw_reply(ROOT, 6, ROOT),
        ]},
    }


def test_archived_relations_drive_the_projection_and_the_conversation(tmp_path):
    """真实归档链：来源 parent 关系经同步落库后，page／location／conversation 一致可读。"""
    path = tmp_path / "conversation-source.sqlite"
    with archive_client(path, relation_source(relation_state())) as client:
        prepare(client)
        assert client.post("/api/sync/initial", json={"uid": "900719925474099312345"}).status_code == 200
        assert client.get(ARCHIVE).json()["local_reply_count"] == 6

    # 重启后不提供来源：任何上游请求都会失败，读取只依赖已保存的关系。
    with archive_client(path) as client:
        page = client.get(REPLIES, params={"page": "1"}).json()
        assert [item["id"] for item in page["items"]] == [str(9000 + index) for index in range(1, 7)]
        projected = conversations(page)
        assert projected["9001"] == {"start_id": "9001", "count": 4, "incomplete": False}
        assert projected["9004"] == {"start_id": "9001", "count": 4, "incomplete": False}
        assert projected["9005"] is None and projected["9006"] is None
        # 直接回根的回复解析 reply_to 为根评论作者，嵌套目标解析为父回复作者。
        assert page["items"][1]["reply_to"]["nickname"] == "同名回复者"
        assert page["items"][0]["reply_to"]["nickname"] == "虚构星海"
        located = client.get(f"{REPLIES}/9003/location").json()
        assert located["page"] == 1
        assert conversations(located)["9003"] == {"start_id": "9001", "count": 4, "incomplete": False}
        body = client.get(f"{REPLIES}/9003/conversation").json()
        assert body["start_id"] == "9001"
        assert [item["id"] for item in body["items"]] == ["9001", "9002", "9003", "9004"]
        assert body["count"] == 4 and body["incomplete"] is False


def counted_queries(monkeypatch):
    """统计真实 SQLite 语句数：用来证明投影与对话读取没有逐条 N+1。"""
    counter = {"statements": 0}
    original = sqlite3.connect

    def connect(*args, **kwargs):
        connection = original(*args, **kwargs)
        connection.set_trace_callback(lambda statement: counter.__setitem__(
            "statements", counter["statements"] + 1))
        return connection

    monkeypatch.setattr(sqlite3, "connect", connect)
    return counter


def build_floor(tmp_path, total):
    store = Store(tmp_path / f"floor-{total}.sqlite")
    store.migrate()
    chain = []
    for index in range(1, total + 1):
        id = str(100000 + index)
        parent = ROOT if index == 1 else str(100000 + index - 1)
        chain.append(reply(id, parent, stamp(index)))
    seed(store, chain, foreign_document())
    return store


def test_twenty_five_and_ten_thousand_replies_keep_the_same_query_and_response_cost(archive, tmp_path, monkeypatch):
    """万条回复夹具：查询次数与响应规模不随楼规模增长，只记录实测耗时（不设性能门槛）。"""
    _store, client = archive
    small = client.get(REPLIES, params={"page": "1", "limit": "10"}).json()
    small_conversation = client.get(f"{REPLIES}/9004/conversation").json()

    big = build_floor(tmp_path, 10000)
    big_client = TestClient(create_app(big.path))
    try:
        counter = counted_queries(monkeypatch)
        started = time.perf_counter()
        page = big_client.get(
            f"/api/archive/dynamics/{DYNAMIC}/comments/{ROOT}/replies", params={"page": "1", "limit": "10"}).json()
        page_ms = (time.perf_counter() - started) * 1000
        page_statements = counter["statements"]

        counter["statements"] = 0
        started = time.perf_counter()
        whole = big_client.get(
            f"/api/archive/dynamics/{DYNAMIC}/comments/{ROOT}/replies/110000/conversation").json()
        conversation_ms = (time.perf_counter() - started) * 1000
        conversation_statements = counter["statements"]

        counter["statements"] = 0
        started = time.perf_counter()
        tail = big_client.get(
            f"/api/archive/dynamics/{DYNAMIC}/comments/{ROOT}/replies/110000/conversation",
            params={"page": "1001"}).json()
        tail_ms = (time.perf_counter() - started) * 1000
        tail_statements = counter["statements"]
    finally:
        big_client.close()

    # 查询次数恒定：一次同根读取＋根／状态查询，不随 25 或 1 万条增长。
    assert page_statements <= 8, page_statements
    assert conversation_statements <= 8, conversation_statements
    assert tail_statements <= 8, tail_statements
    # 页码模式响应规模只与每页条数有关：仍是 10 条，投影不携带整楼关系全集。
    assert len(page["items"]) == 10 and page["count"] == 10000
    assert page["items"][0]["conversation"] == {"start_id": "100001", "count": 10000, "incomplete": False}
    assert len(small["items"]) == 10
    assert len(json.dumps(page["items"]).encode()) <= len(json.dumps(small["items"]).encode()) + 1024
    # 整段模式一次返回全部成员，条数不截断：不截成旧页码或固定上限。
    assert "page" not in whole
    assert whole["count"] == 10000 and len(whole["items"]) == 10000
    assert whole["items"][0]["id"] == "100001" and whole["items"][-1]["id"] == "110000"
    # 显式 page 是保留的旧兼容入口：越界页不返回整段内容，只有空 items 与实际总数。
    assert tail["page"] == 1001
    assert tail["items"] == [] and tail["count"] == 10000
    assert len(small_conversation["items"]) == 14
    # 实测耗时只作为观察记录，不是通过门槛。
    print(f"\nconversation-cost total=10000 page_ms={page_ms:.1f} conversation_ms={conversation_ms:.1f} "
          f"tail_ms={tail_ms:.1f} page_statements={page_statements} "
          f"conversation_statements={conversation_statements} tail_statements={tail_statements} "
          f"whole_bytes={len(json.dumps(whole).encode())}")
