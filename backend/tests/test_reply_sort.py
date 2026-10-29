"""回复页码排序（阅读改版 05）：真实临时 SQLite + HTTP，不启动 lifespan，不访问来源。

夹具刻意让点赞最高的回复落在时间序的第 3 页，因此“只重排当前页”的实现会被抓出来。
"""

import json

import pytest
from fastapi.testclient import TestClient

from backend.bili_monitor.app import create_app
from backend.bili_monitor.storage import Store

DYNAMIC = "123"
ROOT = "900719925474099312346"
REPLIES = f"/api/archive/dynamics/{DYNAMIC}/comments/{ROOT}/replies"
LOCATION = f"{REPLIES}/910002/location"
CONVERSATION = f"{REPLIES}/910002/conversation"
# 25 条回复：时间每分钟一条，最后一条没有时间；第 22 条（时间序第 3 页）点赞最高。
IDS = [str(910001 + index) for index in range(25)]
TIME_ORDER = IDS
HOT_ORDER = [
    "910022",
    "910006", "910007", "910004", "910003",
    "910024", "910023", "910021", "910020", "910019",
    "910018", "910017", "910016", "910015", "910014",
    "910013", "910012", "910011", "910010", "910008",
    "910005", "910002", "910001", "910025",
    # 点赞缺失整组最后，不按 0 参与比较。
    "910009",
]
# 点赞相同时按发布时间降序；点赞与时间都相同才按 ID BINARY 升序。
LIKES = {21: 500, 2: 7, 3: 7, 5: 7, 6: 7, 8: None}
# 第 6 条与第 7 条同一时间，用来锁 ID 次级顺序。
SAME_TIME = {6: 5}


def author(id):
    return {"id": id, "nickname": f"author-{id}", "avatar_url": None}


def published(index):
    if index == 24:
        return None
    minute = index
    if index in SAME_TIME:
        minute = SAME_TIME[index]
    return f"2026-10-14T12:{minute:02d}:00+08:00"


def reply(index):
    id = IDS[index]
    document = {"id": id, "dynamic_id": DYNAMIC, "root_id": ROOT,
                "parent_id": "910001" if index == 1 else ROOT,
                "author": author("100" + id), "published_at": published(index),
                "text": f"reply-{id}", "like_count": LIKES.get(index, 0)}
    return document


def save_reply(connection, document):
    connection.execute("INSERT OR REPLACE INTO replies VALUES (?, ?, ?, ?)",
                       (DYNAMIC, document["root_id"], document["id"],
                        json.dumps(document, ensure_ascii=False)))


@pytest.fixture
def archive(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Archive reads must not access credentials or upstream")

    monkeypatch.setattr("backend.bili_monitor.app.load_source_cookie_pairs", forbidden)
    monkeypatch.setattr("httpx.AsyncClient.send", forbidden)
    store = Store(tmp_path / "reply-sort.sqlite")
    store.migrate()
    root = {"id": ROOT, "dynamic_id": DYNAMIC, "root_id": "0", "parent_id": "0",
            "author": author("202"), "published_at": "2026-10-14T11:00:00+08:00",
            "text": "root-before", "like_count": 3, "source_reply_count": 40,
            "local_reply_count": 25}
    with store.connection() as connection, connection:
        connection.execute("INSERT INTO identities VALUES (?, ?, ?)", ("202", "uploader", None))
        connection.execute("INSERT INTO archives (id, uid, document) VALUES (?, ?, ?)",
                           (DYNAMIC, "202", json.dumps({"id": DYNAMIC})))
        connection.execute("INSERT INTO root_comments VALUES (?, ?, ?)",
                           (DYNAMIC, ROOT, json.dumps(root)))
        connection.execute(
            "INSERT INTO reply_sync (dynamic_id, root_id, status, synced_source_reply_count) VALUES (?, ?, ?, ?)",
            (DYNAMIC, ROOT, "success", 40))
        # 反序插入：读取顺序必须由排序决定，而不是插入顺序。
        for index in reversed(range(25)):
            save_reply(connection, reply(index))
    client = TestClient(create_app(store.path))
    try:
        yield store, client
    finally:
        client.close()


def ids(batch):
    return [item["id"] for item in batch["items"]]


def test_hot_page_sorts_the_complete_local_set_before_slicing(archive):
    _, client = archive
    pages = [client.get(REPLIES, params={"page": str(page)}).json() for page in (1, 2, 3)]
    assert [ids(page) for page in pages] == [TIME_ORDER[:10], TIME_ORDER[10:20], TIME_ORDER[20:]]
    # 点赞最高的回复在时间序第 3 页：热度第 1 页必须把它排到最前，而不是只重排当前页。
    hot = [client.get(REPLIES, params={"page": str(page), "sort": "hot"}).json() for page in (1, 2, 3)]
    assert [ids(page) for page in hot] == [HOT_ORDER[:10], HOT_ORDER[10:20], HOT_ORDER[20:]]
    for page in pages + hot:
        assert page["count"] == page["local_reply_count"] == 25
        assert page["source_reply_count"] == 40
        assert page["next_cursor"] is None
        assert page["root"] == pages[0]["root"]
    assert pages[0]["source_reply_count"] == hot[0]["source_reply_count"] == 40
    assert pages[2]["replies_last_attempt"] == hot[2]["replies_last_attempt"] == "success"


def test_hot_ties_use_published_time_desc_then_id_binary(archive):
    _, client = archive
    page = client.get(REPLIES, params={"page": "1", "sort": "hot"}).json()
    # 同为 7 赞：先按发布时间降序（12:05 > 12:03 > 12:02），同一时间再按 ID 升序。
    assert ids(page)[1:5] == ["910006", "910007", "910004", "910003"]


def test_missing_like_and_missing_time_stay_deterministic(archive):
    _, client = archive
    tail = client.get(REPLIES, params={"page": "3", "sort": "hot"}).json()
    # 点赞缺失整组后置（不当作 0）；同组内缺时间条目排在有时间的之后。
    assert ids(tail) == ["910005", "910002", "910001", "910025", "910009"]
    # 时间序仍然旧到新、缺失后置、ID 次级顺序。
    time_tail = client.get(REPLIES, params={"page": "3"}).json()
    assert ids(time_tail) == TIME_ORDER[20:]


def test_omitted_and_explicit_time_sort_are_the_same_page(archive):
    _, client = archive
    for page in ("1", "3", "9"):
        default = client.get(REPLIES, params={"page": page}).json()
        explicit = client.get(REPLIES, params={"page": page, "sort": "time"}).json()
        assert explicit == default
    beyond = client.get(REPLIES, params={"page": "9", "sort": "hot"}).json()
    assert beyond["items"] == [] and beyond["count"] == 25


def test_time_cursor_resources_and_tokens_survive_hot_reads(archive):
    store, client = archive
    preview = client.get(REPLIES, params={"limit": 3}).json()
    token = preview["next_cursor"]
    assert token is not None
    frozen = client.get(REPLIES, params={"cursor": token, "limit": 10}).json()
    assert ids(frozen) == TIME_ORDER[3:13]
    with store.connection() as connection:
        before = connection.execute("SELECT token, resource FROM reply_pages ORDER BY token").fetchall()
    for page in ("1", "2", "3"):
        client.get(REPLIES, params={"page": page, "sort": "hot"})
    with store.connection() as connection:
        after = connection.execute("SELECT token, resource FROM reply_pages ORDER BY token").fetchall()
    # 热度页码只读：不冻结新 cursor 行，也不改写时间序资源标识。
    assert [(row["token"], row["resource"]) for row in after] == [(row["token"], row["resource"]) for row in before]
    assert all("time-asc" in row["resource"] for row in after)
    assert client.get(REPLIES, params={"cursor": token, "limit": 10}).json() == frozen


@pytest.mark.parametrize("value", ["latest", "HOT", "Time", "", "hot ", "hot,time", "1"])
def test_unknown_sort_values_are_invalid_input(archive, value):
    _, client = archive
    response = client.get(REPLIES, params={"page": "1", "sort": value})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_INPUT"


@pytest.mark.parametrize("query", [
    # 热度只扩展实时 page 模式：cursor 预览与首批是时间序冻结快照，没有排序维度。
    "limit=3&sort=time", "limit=3&sort=hot", "limit=10&cursor=" + "a" * 32 + "&sort=hot",
    "page=1&sort=hot&sort=time", "page=1&sort=hot&cursor=" + "b" * 32,
    "page=1&sort=hot&limit=3", "page=1&sort=hot&extra=1",
])
def test_sort_is_only_valid_with_the_live_page_mode(archive, query):
    _, client = archive
    response = client.get(REPLIES + "?" + query)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_INPUT"


def test_location_and_conversation_keep_time_semantics_and_reject_sort(archive):
    _, client = archive
    located = client.get(LOCATION).json()
    # 通知主动直达仍是时间序：热门的第 22 条不会被定位响应当成时间页。
    assert located["page"] == 1
    assert ids(located) == TIME_ORDER[:10]
    tail = client.get(f"{REPLIES}/910022/location").json()
    assert tail["page"] == 3
    assert ids(tail) == TIME_ORDER[20:]
    # 定位与对话端点参数不变：新排序参数一律拒绝，不静默忽略。
    for url in (LOCATION, f"{REPLIES}/910022/location", CONVERSATION):
        response = client.get(url, params={"sort": "hot"})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "INVALID_INPUT"
    conversation = client.get(CONVERSATION).json()
    assert [item["id"] for item in conversation["items"]] == ["910001", "910002"]
    # 先读热度页再看对话：会话内容与顺序不随排序改变。
    client.get(REPLIES, params={"page": "1", "sort": "hot"})
    assert client.get(CONVERSATION).json() == conversation


def test_hot_page_reads_do_not_write_the_archive_or_reach_upstream(archive):
    store, client = archive
    with store.connection() as connection:
        archive_before = connection.execute("SELECT document FROM archives").fetchall()
        root_before = connection.execute("SELECT document FROM root_comments").fetchall()
        replies_before = connection.execute("SELECT document FROM replies ORDER BY id").fetchall()
    before = client.get(REPLIES, params={"page": "1", "sort": "hot"}).json()
    with store.connection() as connection:
        assert connection.execute("SELECT document FROM archives").fetchall() == archive_before
        assert connection.execute("SELECT document FROM root_comments").fetchall() == root_before
        assert connection.execute("SELECT document FROM replies ORDER BY id").fetchall() == replies_before
        assert connection.execute("SELECT count(*) FROM reply_pages").fetchone()[0] == 0
    # 页面数据本身不被读取顺序改写：同一请求重复读取仍相同。
    assert client.get(REPLIES, params={"page": "1", "sort": "hot"}).json() == before
