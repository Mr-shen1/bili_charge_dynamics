"""精确入口：真实归档 HTTP + 隔离 SQLite，仅替换来源 HTTP。"""
import copy

from backend.tests.archive_support import archive_client
from backend.tests.root_support import ARCHIVE, COMMENTS, prepare, root_fixture, source_handler


def test_root_location_reads_later_batch_without_source_or_archive_writes(tmp_path):
    roots = []
    for index in range(45):
        root = copy.deepcopy(root_fixture()["data"]["replies"][0])
        root.update(rpid=8000 + index, rpid_str=str(8000 + index), like=45 - index, rcount=0)
        root["content"]["pictures"] = []
        root["content"]["message"] = f"Root {index}"
        roots.append(root)
    state = {"roots": roots, "dynamic_count": 45}
    path = tmp_path / "location.sqlite"
    with archive_client(path, source_handler(state)) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": "900719925474099312345"})
        assert client.get(ARCHIVE).json()["local_comment_count"] >= 45

    # 重启后不提供来源 handler：任何上游请求都将失败。
    with archive_client(path) as client:
        before = client.get(ARCHIVE).json()
        database = path.read_bytes()
        response = client.get(COMMENTS + "/8025/location")
        assert response.status_code == 200
        batch = response.json()
        assert batch["items"][0]["id"] == "8025"
        assert len(batch["items"]) == 20
        assert batch["items"][-1]["id"] == "8044"
        assert batch["next_cursor"] is None
        first = client.get(COMMENTS + "/8001/location").json()
        assert first["items"][0]["id"] == "8001"
        following = client.get(COMMENTS, params={"cursor": first["next_cursor"]}).json()
        assert following["items"][0]["id"] == "8021"
        assert client.get(COMMENTS, params={"cursor": first["next_cursor"], "sort": "latest"}).status_code == 422
        assert client.get(COMMENTS + "/9999/location").status_code == 404
        assert client.get("/api/archive/dynamics/999/comments/8025/location").status_code == 404
        assert client.get(COMMENTS + "/8025/location?sort=wrong").status_code == 422
        assert client.get(ARCHIVE).json() == before
        assert path.read_bytes() == database


def test_root_location_reports_and_reads_comments_before_the_target(tmp_path):
    """定位窗口之前还有多少条、怎么继续向前读：目标之前的评论必须真的能读到。"""
    roots = []
    for index in range(45):
        root = copy.deepcopy(root_fixture()["data"]["replies"][0])
        root.update(rpid=8000 + index, rpid_str=str(8000 + index), like=45 - index, rcount=0)
        root["content"]["pictures"] = []
        root["content"]["message"] = f"Root {index}"
        roots.append(root)
    state = {"roots": roots, "dynamic_count": 45}
    path = tmp_path / "location-earlier.sqlite"
    with archive_client(path, source_handler(state)) as client:
        prepare(client)
        client.post("/api/sync/initial", json={"uid": "900719925474099312345"})
        assert client.get(ARCHIVE).json()["local_comment_count"] >= 45

    with archive_client(path) as client:
        batch = client.get(COMMENTS + "/8025/location").json()
        assert batch["items"][0]["id"] == "8025"
        # 最热排序下 8025 之前有 25 条更早的评论（8000–8024）。
        assert batch["earlier_count"] == 25
        assert batch["prev_cursor"] is not None

        earlier = client.get(COMMENTS, params={"cursor": batch["prev_cursor"]}).json()
        assert [item["id"] for item in earlier["items"]] == [str(8000 + index) for index in range(5, 25)]
        assert earlier["earlier_count"] == 5
        assert earlier["prev_cursor"] is not None
        # 向前批次不给后向游标：任何“下一批”都会与已读窗口重叠，召唤方保留定位窗口的 next_cursor。
        assert earlier["next_cursor"] is None

        head = client.get(COMMENTS, params={"cursor": earlier["prev_cursor"]}).json()
        assert [item["id"] for item in head["items"]] == [str(8000 + index) for index in range(0, 5)]
        assert head["earlier_count"] == 0
        assert head["prev_cursor"] is None

        # 目标靠前时向前只有 1 条，后向续读仍由定位窗口自己给。
        near_head = client.get(COMMENTS + "/8001/location").json()
        assert near_head["earlier_count"] == 1
        assert near_head["next_cursor"] is not None
        only = client.get(COMMENTS, params={"cursor": near_head["prev_cursor"]}).json()
        assert [item["id"] for item in only["items"]] == ["8000"]
        assert [only["earlier_count"], only["prev_cursor"]] == [0, None]

        # 目标就在最前面时没有“更早”的概念，也不给伪造的游标。
        head_of_all = client.get(COMMENTS + "/8000/location").json()
        assert head_of_all["items"][0]["id"] == "8000"
        assert head_of_all["earlier_count"] == 0
        assert head_of_all["prev_cursor"] is None
