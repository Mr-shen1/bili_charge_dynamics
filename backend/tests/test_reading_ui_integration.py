"""09：阅读改版组合回归——同一候选、同一数据库的真实 HTTP＋SQLite 公开边界。

01–08 的读取契约单独取证后，这里把它们放进**同一次请求序列**里复核，避免“各票局部通过、
拼起来未必成立”：根评论与回复都先对完整本地集合排序再分页、对话入口资格跨页稳定、
关系不串父级／根／动态、旧时间 cursor 与定位语义仍兼容，且全部读取不产生采集请求。
只替换来源 HTTP（账本记录任何上游请求）；归档、排序、分页与关系都由生产 Store／HTTP 实现。
"""

import json
import sqlite3

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app
from backend.bili_monitor.storage import Store

DYNAMIC = "123"
UID = "202"
ROOT = "900719925474099312346"
OTHER_ROOT = "900719925474099312400"
COMMENTS = f"/api/archive/dynamics/{DYNAMIC}/comments"
REPLIES = f"{COMMENTS}/{ROOT}/replies"
OTHER_REPLIES = f"{COMMENTS}/{OTHER_ROOT}/replies"

# 25 条一级评论：点赞与时间刻意不同向，因此「按时间」与「按热度」的批次顺序不同；
# 两个带回复的根评论都落在时间序第 2 批（按热度在第 1 批），用于跨批定位。
ROOT_IDS = [f"8700{index:02d}" for index in range(1, 24)] + [ROOT, OTHER_ROOT]
LATEST_ROOTS = [
    "870001", "870002", "870003", "870004", "870005", "870006", "870007", "870008", "870009", "870010",
    "870011", "870012", "870013", "870014", "870015", "870016", "870017", "870018", "870019", "870020",
    "870021", "870022", "870023", ROOT, OTHER_ROOT,
]
HOT_ROOTS = [
    "870011", "870022", "870007", "870018", "870003", "870014", OTHER_ROOT, "870010", "870021", "870006",
    "870017", "870002", "870013", ROOT, "870009", "870020", "870005", "870016", "870001", "870012",
    "870023", "870008", "870019", "870004", "870015",
]

# 25 条回复：时间每分钟一条、点赞随序号递增，热度正好是时间序的倒序。
# 点赞最高的 960025 在时间序第 3 页——只重排当前页的实现会被抓出来。
TIME_REPLIES = [f"9600{index:02d}" for index in range(1, 26)]
HOT_REPLIES = list(reversed(TIME_REPLIES))
# 真实父回复关系：960002 起点下有两条分支与 8 条跨页成员（共 11 条，10/1 两页）；
# 960007 的父未保存（上下文不完整）；960021/960022 互指成环（有限止步）。
PARENTS = {
    3: "960002", 4: "960002",
    7: "990000", 8: "960007",
    13: "960002", 14: "960002", 15: "960002", 16: "960002",
    17: "960002", 18: "960002", 19: "960002", 20: "960002",
    21: "960022", 22: "960021",
}
CONVERSATION_START = "960002"
CONVERSATION_IDS = ["960002", "960003", "960004"] + [f"9600{index:02d}" for index in range(13, 21)]
CONVERSATION_COUNT = 11
# 另一楼的回复把父级指到本楼：跨根关系一律不合并，不能被串成一楼。
OTHER_REPLY_IDS = [f"9700{index:02d}" for index in range(1, 6)]
OTHER_PARENTS = {2: "960002"}


def author():
    # 全部回复共用同一昵称与正文前缀：关系只能由 parent_id 证明，不能按名字或文本拼接。
    return {"id": "909002", "nickname": "同名回复者", "avatar_url": "https://example.invalid/same.png"}


def root_document(index, id):
    return {
        "id": id, "dynamic_id": DYNAMIC, "root_id": "0", "parent_id": "0",
        "author": {"id": UID, "nickname": "虚构楼主", "avatar_url": None},
        "published_at": f"2026-10-14T11:{59 - index:02d}:00+08:00",
        "text": f"同名正文前缀 一级评论 {id}", "like_count": (index * 7) % 26,
        "is_pinned": False, "source_reply_count": 40, "local_reply_count": 25,
    }


def reply_document(id, root_id, index, parent_id):
    return {
        "id": id, "dynamic_id": DYNAMIC, "root_id": root_id, "parent_id": parent_id,
        "author": author(), "published_at": f"2026-10-14T12:{index:02d}:00+08:00",
        "text": f"同名正文前缀 回复 {id}: 内容", "like_count": index,
    }


def seed(store):
    with store.connection() as connection, connection:
        connection.execute("INSERT INTO identities VALUES (?, ?, ?)", (UID, "uploader", None))
        connection.execute("INSERT INTO archives (id, uid, document) VALUES (?, ?, ?)",
                           (DYNAMIC, UID, json.dumps({"id": DYNAMIC})))
        # 反序插入：读取顺序必须由排序决定，而不是插入顺序。
        for index, id in reversed(list(enumerate(ROOT_IDS, 1))):
            connection.execute("INSERT INTO root_comments VALUES (?, ?, ?)",
                               (DYNAMIC, id, json.dumps(root_document(index, id), ensure_ascii=False)))
        for root_id, size, parents in ((ROOT, 25, PARENTS), (OTHER_ROOT, 5, OTHER_PARENTS)):
            connection.execute(
                "INSERT INTO reply_sync (dynamic_id, root_id, status, synced_source_reply_count)"
                " VALUES (?, ?, ?, ?)", (DYNAMIC, root_id, "success", 40),
            )
            ids = TIME_REPLIES if root_id == ROOT else OTHER_REPLY_IDS
            for index, id in reversed(list(enumerate(ids, 1))):
                document = reply_document(id, root_id, index, parents.get(index, root_id))
                connection.execute("INSERT INTO replies VALUES (?, ?, ?, ?)",
                                   (DYNAMIC, root_id, id, json.dumps(document, ensure_ascii=False)))
            assert size == len(ids)


@pytest.fixture
def archive(tmp_path, monkeypatch):
    ledger = []

    def record(request):
        ledger.append(str(request.url))
        raise AssertionError("归档读取不得请求来源")

    monkeypatch.setattr("backend.bili_monitor.app.load_source_cookie_pairs", lambda: [])
    store = Store(tmp_path / "reading-ui.sqlite")
    store.migrate()
    seed(store)
    client = TestClient(create_app(store.path, profile_transport=httpx.MockTransport(record)))
    try:
        yield store, client, ledger
    finally:
        client.close()


def ids(batch):
    return [item["id"] for item in batch["items"]]


def root_batch(client, sort, cursor=None):
    params = {"sort": sort, "limit": "20"}
    if cursor:
        params["cursor"] = cursor
    return client.get(COMMENTS, params=params).json()


def reply_page(client, path, page, sort=None):
    params = {"page": str(page)}
    if sort:
        params["sort"] = sort
    return client.get(path, params=params).json()


def test_sorting_precedes_paging_for_roots_and_replies(archive):
    _, client, _ = archive
    # 一级评论：两种排序作用于完整 25 条集合，再按 20/5 切批，批次内没有重复或遗漏。
    latest_first = root_batch(client, "latest")
    hot_first = root_batch(client, "hot")
    assert ids(latest_first) == LATEST_ROOTS[:20]
    assert ids(hot_first) == HOT_ROOTS[:20]
    latest_second = root_batch(client, "latest", latest_first["next_cursor"])
    hot_second = root_batch(client, "hot", hot_first["next_cursor"])
    assert ids(latest_second) == LATEST_ROOTS[20:]
    assert ids(hot_second) == HOT_ROOTS[20:]
    for first, second in ((latest_first, latest_second), (hot_first, hot_second)):
        assert set(ids(first)) | set(ids(second)) == set(ROOT_IDS)
        assert len(set(ids(first)) & set(ids(second))) == 0
        assert first["next_cursor"] is not None and second["next_cursor"] is None

    # 回复：热度第 1 页是时间序第 3 页的尾部——排序发生在完整集合上，而不是当前页。
    time_pages = [ids(reply_page(client, REPLIES, page)) for page in (1, 2, 3)]
    hot_pages = [ids(reply_page(client, REPLIES, page, "hot")) for page in (1, 2, 3)]
    assert time_pages == [TIME_REPLIES[:10], TIME_REPLIES[10:20], TIME_REPLIES[20:]]
    assert hot_pages == [HOT_REPLIES[:10], HOT_REPLIES[10:20], HOT_REPLIES[20:]]
    for page in (1, 2, 3):
        batch = reply_page(client, REPLIES, page)
        assert batch["count"] == batch["local_reply_count"] == 25
        # 来源计数多于本地：不用于推算本地页数，也不改变成员资格。
        assert batch["source_reply_count"] == 40


def test_conversation_projection_and_entry_eligibility_are_stable_across_pages(archive):
    _, client, _ = archive
    expected = {"start_id": CONVERSATION_START, "count": CONVERSATION_COUNT, "incomplete": False}
    time_first = reply_page(client, REPLIES, 1)
    time_second = reply_page(client, REPLIES, 2)
    hot_first = reply_page(client, REPLIES, 1, "hot")
    for batch in (time_first, time_second, hot_first):
        projected = {item["id"]: item["conversation"] for item in batch["items"]}
        for id in CONVERSATION_IDS:
            if id in projected:
                assert projected[id] == expected
        # 起点恰好一条时没有入口；一级评论、无关发言与同名作者都不产生投影。
        for id in ("960001", "960005", "960006", "960009", "960012", "960024", "960025"):
            if id in projected:
                assert projected[id] is None
    assert "960002" not in ids(hot_first)
    assert set(CONVERSATION_IDS) & set(ids(time_second)) == {"960013", "960014", "960015", "960016",
                                                            "960017", "960018", "960019", "960020"}

    # 定位响应使用与所在页相同的投影：通知直达也能看到入口。
    located = client.get(f"{REPLIES}/960013/location").json()
    assert located.pop("page") == 2
    assert located == time_second
    # 缺祖先与异常环：可确认成员有限、起点稳定、明确标注上下文不完整。
    located_partial = client.get(f"{REPLIES}/960008/location").json()
    assert {item["id"]: item["conversation"] for item in located_partial["items"]}["960008"] == {
        "start_id": "960007", "count": 2, "incomplete": True}
    cycle = reply_page(client, REPLIES, 3)
    assert {item["id"]: item["conversation"] for item in cycle["items"]}["960022"] == {
        "start_id": "960021", "count": 2, "incomplete": True}


def test_cycle_start_does_not_depend_on_request_sort(archive):
    _, client, _ = archive
    # 960021 与 960022 互指成环：页面请求排序只决定本页条目顺序，不能换掉这段对话的起点。
    expected = {"start_id": "960021", "count": 2, "incomplete": True}
    seen = set()
    for sort in ("time", "hot"):
        for page in (1, 2, 3):
            projected = {item["id"]: item["conversation"]
                         for item in reply_page(client, REPLIES, page, sort)["items"]}
            for id in ("960021", "960022"):
                if id in projected:
                    seen.add(id)
                    assert projected[id] == expected, (sort, page, id)
    # 两种排序都读到了环的两端，才证明上面比较的是同一份关系而不是没读到。
    assert seen == {"960021", "960022"}

    # 定位响应与 conversation 子资源给出同一个起点与同一段成员（时间正序）。
    located = client.get(f"{REPLIES}/960022/location").json()
    assert {item["id"]: item["conversation"] for item in located["items"]}["960021"] == expected
    for id in ("960021", "960022"):
        conversation = client.get(f"{REPLIES}/{id}/conversation").json()
        assert conversation["start_id"] == "960021"
        assert conversation["count"] == 2 and conversation["incomplete"] is True
        assert [item["id"] for item in conversation["items"]] == ["960021", "960022"]


def test_conversation_reads_the_full_branch_set_without_crossing_parents(archive):
    _, client, _ = archive
    conversation = client.get(f"{REPLIES}/{CONVERSATION_START}/conversation").json()
    assert conversation == {
        **conversation,
        "dynamic_id": DYNAMIC, "root_id": ROOT, "reply_id": CONVERSATION_START,
        "start_id": CONVERSATION_START, "incomplete": False, "count": CONVERSATION_COUNT,
        "next_cursor": None,
    }
    # 缺省即整段：11 条一次全给，不截成旧页码、不返回 page 字段。
    assert "page" not in conversation
    assert [item["id"] for item in conversation["items"]] == CONVERSATION_IDS
    # 显式 page 是保留的旧兼容入口（前端不得使用），仍与整段成员同源。
    tail = client.get(f"{REPLIES}/960020/conversation", params={"page": "2", "limit": "10"}).json()
    assert tail["page"] == 2
    assert [item["id"] for item in tail["items"]] == CONVERSATION_IDS[10:]
    assert tail["items"] == conversation["items"][10:]
    # 起点本身是唯一成员时也能读，但 UI 不会给入口；一级评论不出现在会话正文里。
    assert client.get(f"{REPLIES}/960005/conversation").json()["count"] == 1
    # 一级评论只作身份校验上下文：会话响应不重复下发根评论正文（回复的 reply_to 仍是父回复作者投影）。
    assert "root" not in conversation

    # 跨根：另一楼把父级指到本楼，仍按各自楼的关系读，不合并、不串父级。
    other = client.get(f"{OTHER_REPLIES}/970002/conversation").json()
    assert other["root_id"] == OTHER_ROOT
    assert other["count"] == 1 and other["start_id"] == "970002"
    assert [item["id"] for item in other["items"]] == ["970002"]
    assert not ({item["id"] for item in conversation["items"]} & set(OTHER_REPLY_IDS))
    # 同名作者与相同正文前缀不参与判定：独立发言不因名字相同被并入对话。
    assert "960005" not in [item["id"] for item in conversation["items"]]
    # 身份错误一律 404，不暴露其它楼/其它动态的关系。
    assert client.get(f"{REPLIES}/970002/conversation").status_code == 404
    assert client.get(f"{COMMENTS}/999999/replies/960002/conversation").status_code == 404
    assert client.get("/api/archive/dynamics/456/comments/" + ROOT + "/replies/960002/conversation"
                      ).status_code == 404


def test_old_time_tokens_and_location_semantics_survive_hot_reads(archive):
    store, client, _ = archive
    # 旧 token：根评论与回复的时间序冻结快照。先取 token，再跑热度读取，旧 token 仍返回同一批。
    latest_token = root_batch(client, "latest")["next_cursor"]
    hot_token = root_batch(client, "hot")["next_cursor"]
    frozen_latest = root_batch(client, "latest", latest_token)
    frozen_hot = root_batch(client, "hot", hot_token)
    preview = client.get(REPLIES, params={"limit": "3"}).json()
    frozen_replies = client.get(REPLIES, params={"cursor": preview["next_cursor"], "limit": "10"}).json()
    assert ids(frozen_replies) == TIME_REPLIES[3:13]
    with store.connection() as connection:
        before = [tuple(row) for row in connection.execute(
            "SELECT token, resource FROM reply_pages ORDER BY token").fetchall()]
    for page in (1, 2, 3):
        reply_page(client, REPLIES, page, "hot")
        root_batch(client, "hot")
    with store.connection() as connection:
        after = [tuple(row) for row in connection.execute(
            "SELECT token, resource FROM reply_pages ORDER BY token").fetchall()]
    assert after == before
    assert root_batch(client, "latest", latest_token) == frozen_latest
    assert root_batch(client, "hot", hot_token) == frozen_hot
    assert client.get(REPLIES, params={"cursor": preview["next_cursor"], "limit": "10"}).json() == frozen_replies

    # 定位仍是它自己那一套页码语义：一级评论按请求排序给出以目标开头的批次，
    # 回复定位固定按时间序页码（热度读取不改变它）。
    located_latest = client.get(f"{COMMENTS}/{ROOT}/location", params={"sort": "latest"}).json()
    assert located_latest["items"][0]["id"] == ROOT
    assert located_latest["earlier_count"] == 23
    assert located_latest["prev_cursor"] is not None
    located_hot = client.get(f"{COMMENTS}/{ROOT}/location", params={"sort": "hot"}).json()
    assert located_hot["items"][0]["id"] == ROOT
    assert located_hot["earlier_count"] == 13
    located_reply = client.get(f"{REPLIES}/960022/location").json()
    assert located_reply["page"] == 3
    assert ids(located_reply) == TIME_REPLIES[20:]
    assert {item["id"]: item["conversation"] for item in located_reply["items"]}["960022"] == {
        "start_id": "960021", "count": 2, "incomplete": True}
    # 定位与会话不接受排序参数：不把热度页码当定位页码，也不静默忽略。
    for url in (f"{REPLIES}/960022/location", f"{REPLIES}/{CONVERSATION_START}/conversation"):
        response = client.get(url, params={"sort": "hot"})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "INVALID_INPUT"


def test_reading_never_calls_upstream_or_writes_archives(archive):
    store, client, ledger = archive
    archive_before = client.get(f"/api/archive/dynamics/{DYNAMIC}").json()
    with store.connection() as connection:
        counts_before = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("archives", "root_comments", "replies", "reply_sync", "reply_pages")
        }

    client.get(COMMENTS, params={"sort": "latest", "limit": "20"})
    client.get(COMMENTS, params={"sort": "hot", "limit": "20"})
    client.get(f"/api/archive/dynamics/{DYNAMIC}")
    client.get("/api/archive/dynamics")
    client.get("/api/archive/ups")
    for page in (1, 2, 3):
        reply_page(client, REPLIES, page)
        reply_page(client, REPLIES, page, "hot")
    client.get(f"{REPLIES}/960013/location")
    client.get(f"{REPLIES}/{CONVERSATION_START}/conversation")
    client.get(f"{REPLIES}/960008/conversation")
    client.get(f"{OTHER_REPLIES}/970002/conversation")

    # 请求账本：任何上游请求都会被记录并让用例失败，这里再显式断言一次。
    assert ledger == []
    assert client.get(f"/api/archive/dynamics/{DYNAMIC}").json() == archive_before
    with store.connection() as connection:
        counts_after = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("archives", "root_comments", "replies", "reply_sync", "reply_pages")
        }
    assert counts_after == counts_before


def test_unknown_identity_is_not_found_not_empty(archive):
    _, client, _ = archive
    assert client.get("/api/archive/dynamics/456/comments").status_code == 404
    assert client.get(f"/api/archive/dynamics/456/comments/{ROOT}/replies",
                      params={"page": "1"}).status_code == 404
    # 跨根请求回复位置：目标不在该楼，按不存在处理，不泄露其它楼的数据。
    assert client.get(f"{OTHER_REPLIES}/960013/location").status_code == 404
