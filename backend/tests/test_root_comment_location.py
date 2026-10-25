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
