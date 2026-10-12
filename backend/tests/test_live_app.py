"""主线程 E2E 装配仍使用生产 HTTP/SQLite 与 card 解析。"""

from fastapi.testclient import TestClient

from backend.tests.live_app import create_app
from backend.tests.test_management import BASE, UID


def test_live_factory_uses_environment_database_and_fixed_fictional_cards(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("BILI_DATABASE_PATH", str(tmp_path / "live.sqlite"))
    with TestClient(create_app()) as client:
        assert client.get(BASE).json() == {"ups": []}
        first = client.post(BASE, json={"uid": UID})
        second = client.post(BASE, json={"uid": "202"})
        assert first.status_code == second.status_code == 201
        assert first.json()["name"] == "虚构星海"
        assert second.json()["name"] == "虚构晨光"
        assert client.post(BASE, json={"uid": "999"}).status_code == 502
        saved = client.get(BASE).json()
    with TestClient(create_app()) as reopened:
        assert reopened.get(BASE).json() == saved
