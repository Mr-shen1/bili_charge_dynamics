"""03 票：楼中楼回复精确入口的只读定位读取；真实归档 HTTP + 隔离 SQLite，仅替换来源 HTTP。"""

import copy
import json
import sqlite3
from pathlib import Path

import httpx

from backend.tests.archive_support import archive_client
from backend.tests.root_support import ARCHIVE, COMMENTS, prepare, root_fixture, source_handler

ROOT = "900719925474099312346"
OTHER_ROOT = "900719925474099312400"
REPLIES = f"{COMMENTS}/{ROOT}/replies"


def reply_fixture():
    return json.loads((Path(__file__).parent / "fixtures/replies.json").read_text())


def raw_reply(root_id, index, *, base=9000, text=None):
    """虚构楼中楼条目：同一根下按 ctime 递增，时间正序即 ID 正序。"""
    return {
        "rpid_str": str(base + index), "oid": 99123, "type": 17,
        "root_str": root_id, "parent_str": root_id,
        "ctime": 1791513500 + index, "like": 0,
        "member": {"mid": "202", "uname": "虚构读者", "avatar": None},
        "content": {"message": text or f"虚构回复 {index}"},
    }


def reply_source(state):
    """根页 + 楼中楼页；每个根的来源回复集合由 state 给出。"""
    roots = source_handler(state)

    def handler(request):
        if request.url.path != "/x/v2/reply/reply":
            return roots(request)
        assert request.url.params["oid"] == "99123"
        assert request.url.params["type"] == "17"
        assert request.url.params["ps"] == "20"
        root_id = request.url.params["root"]
        page = int(request.url.params["pn"])
        state.setdefault("reply_pages", []).append((root_id, page))
        items = state["reply_sets"][root_id]
        payload = copy.deepcopy(reply_fixture())
        payload["data"]["root"].update(rpid_str=root_id, root_str="0", parent_str="0", rcount=len(items))
        payload["data"]["page"].update(num=page, size=20, count=len(items))
        payload["data"]["replies"] = items[(page - 1) * 20:page * 20] or None
        return httpx.Response(200, json=payload)
    return handler


def archived_state():
    """两个根：ROOT 有 25 条回复（读页 10/10/5），另一个根另有 3 条。"""
    roots = []
    for index, (root_id, rcount) in enumerate(((ROOT, 25), (OTHER_ROOT, 3))):
        root = copy.deepcopy(root_fixture()["data"]["replies"][0])
        root.update(rpid_str=root_id, rpid=root_id, like=2 - index, rcount=rcount)
        root["content"] = {"message": f"虚构根评论 {index + 1}", "pictures": []}
        root["replies"] = None
        roots.append(root)
    return {
        "roots": roots,
        "dynamic_count": 2,
        "reply_sets": {
            ROOT: [raw_reply(ROOT, index) for index in range(1, 26)],
            OTHER_ROOT: [raw_reply(OTHER_ROOT, index, base=7000, text=f"另一楼回复 {index}") for index in range(1, 4)],
        },
    }


def frozen_pages(path):
    with sqlite3.connect(path) as connection:
        return connection.execute("SELECT COUNT(*) FROM reply_pages").fetchone()[0]


def test_reply_location_returns_target_page_without_source_or_archive_writes(tmp_path):
    path = tmp_path / "reply-location.sqlite"
    with archive_client(path, reply_source(archived_state())) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": "900719925474099312345"})
        archived = client.get(ARCHIVE).json()
        assert archived["local_reply_count"] == 28

    # 重启后不提供来源 handler：任何上游请求都会失败，且分页快照数保持原样。
    with archive_client(path) as client:
        before = client.get(ARCHIVE).json()
        pages = frozen_pages(path)
        page_two = client.get(REPLIES, params={"page": "2"}).json()

        # 目标在第二页：返回目标所在页，而不是楼层第一页。
        middle = client.get(f"{REPLIES}/9014/location")
        assert middle.status_code == 200
        middle = middle.json()
        assert middle["page"] == 2
        assert [item["id"] for item in middle["items"]] == [str(9000 + index) for index in range(11, 21)]
        assert middle["count"] == 25
        assert middle["root"]["id"] == ROOT
        assert middle["local_reply_count"] == 25
        assert middle["source_reply_count"] == 25
        assert middle["replies_last_attempt"] == "success"
        assert middle["next_cursor"] is None
        # 页内条目与 page 模式逐项一致：同一排序、同一 reply_to 解析，不另拼一套读取。
        assert middle["items"] == page_two["items"]
        assert middle["root"] == page_two["root"]
        assert middle["items"][0]["reply_to"] == {
            "id": "900719925474099312345", "nickname": "虚构星海",
            "avatar_url": "https://example.invalid/avatar.png",
        }

        # 首屏目标与末页目标都直接给出所在页，不一次返回全部回复。
        first = client.get(f"{REPLIES}/9001/location").json()
        assert first["page"] == 1
        assert len(first["items"]) == 10
        last = client.get(f"{REPLIES}/9025/location").json()
        assert last["page"] == 3
        assert [item["id"] for item in last["items"]] == ["9021", "9022", "9023", "9024", "9025"]
        # 另一个根的回复只在它自己的楼里出现，跨楼定位返回 404。
        assert client.get(f"{COMMENTS}/{OTHER_ROOT}/replies/7002/location").json()["page"] == 1
        assert client.get(f"{REPLIES}/7002/location").status_code == 404
        assert client.get(f"{COMMENTS}/{OTHER_ROOT}/replies/9001/location").status_code == 404

        # 不存在与非法输入分开：目标/根/动态不存在是 404，非法查询是 422。
        assert client.get(f"{REPLIES}/9999/location").status_code == 404
        assert client.get(f"{COMMENTS}/9999/replies/9001/location").status_code == 404
        assert client.get(f"/api/archive/dynamics/999/comments/{ROOT}/replies/9001/location").status_code == 404
        assert client.get(f"{REPLIES}/9001/location?limit=10").status_code == 422
        assert client.get(f"{REPLIES}/9001/location?page=2").status_code == 422
        assert client.get(f"{REPLIES}/9001/location?sort=hot&sort=latest").status_code == 422

        # 只读定位：不写归档、不冻结分页快照。
        assert client.get(ARCHIVE).json() == before
        assert frozen_pages(path) == pages
