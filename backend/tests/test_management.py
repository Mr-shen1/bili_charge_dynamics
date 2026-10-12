"""T2：只通过 HTTP 观察管理行为，SQLite 与生产上游解析均真实执行。"""

import logging
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import anyio
import httpx
import pytest
from backend.tests.management_support import BASE, DEFAULT_MONITOR, UID, card, client_for, profile_response
from backend.tests.sqlite_fixtures import (
    management_relation,
    quote,
    reject_config_inserts,
)


def test_add_fetches_public_card_and_persists_large_string_uid(tmp_path):
    with client_for(tmp_path / "monitor.sqlite") as client:
        response = client.post(BASE, json={"uid": UID})
        assert response.status_code == 201
        expected = {
            "uid": UID,
            "name": "虚构星海",
            "avatar_url": "https://example.invalid/avatar.png",
            "monitor": DEFAULT_MONITOR,
        }
        assert response.json() == expected
        assert client.get(f"{BASE}/{UID}").json() == expected
        assert client.get(BASE).json() == {"ups": [expected]}


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"uid": 202},
        {"uid": True},
        {"uid": None},
        {"uid": ""},
        {"uid": "0"},
        {"uid": "0202"},
        {"uid": "-2"},
        {"uid": "+2"},
        {"uid": "2.0"},
        {"uid": " 202"},
        {"uid": "202 "},
        {"uid": "202\n"},
        {"uid": "２０２"},
        {"uid": "١٢٣"},
        {"uid": "1" * 129},
        {"uid": "202", "name": "FICTIONAL_SECRET_BODY"},
        [],
        "FICTIONAL_SECRET_BODY",
    ],
)
def test_add_rejects_invalid_input_without_fetching_or_saving(tmp_path, body, caplog):
    def forbidden(request):
        pytest.fail("Invalid input must not request upstream")

    with client_for(tmp_path / "monitor.sqlite", forbidden) as client:
        response = client.post(BASE, json=body)
        assert response.status_code == 422
        assert response.json() == {
            "error": {"code": "INVALID_INPUT", "message": "输入无效"}
        }
        assert client.get(BASE).json() == {"ups": []}
    assert "FICTIONAL_SECRET_BODY" not in caplog.text


def test_duplicate_does_not_fetch_or_replace_saved_profile(tmp_path):
    def only_first(request):
        if used:
            raise httpx.ConnectError("FICTIONAL_SECRET_DUPLICATE", request=request)
        used.append(True)
        return profile_response(request)

    used = []
    with client_for(tmp_path / "monitor.sqlite", only_first) as client:
        first = client.post(BASE, json={"uid": UID}).json()
        response = client.post(BASE, json={"uid": UID})
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "ALREADY_MONITORED"
        assert client.get(f"{BASE}/{UID}").json() == first


def test_two_ups_have_independent_mode_n_and_enabled(tmp_path):
    with client_for(tmp_path / "monitor.sqlite") as client:
        assert client.post(BASE, json={"uid": UID}).status_code == 201
        assert client.post(BASE, json={"uid": "202"}).status_code == 201
        config = {"mode": "specified", "recent_n": 9007199254740991, "enabled": False}
        response = client.patch(f"{BASE}/{UID}/monitor", json=config)
        assert response.status_code == 200
        assert response.json()["monitor"] == {
            **config,
            "last_checked_at": None,
            "last_succeeded_at": None,
        }
        assert client.get(f"{BASE}/202").json()["monitor"] == DEFAULT_MONITOR
        second = {"mode": "recent", "recent_n": 234, "enabled": False}
        assert client.patch(f"{BASE}/202/monitor", json=second).status_code == 200
        assert client.get(f"{BASE}/{UID}").json()["monitor"]["mode"] == "specified"
        assert client.get(f"{BASE}/202").json()["monitor"]["recent_n"] == 234
        assert [up["uid"] for up in client.get(BASE).json()["ups"]] == ["202", UID]


@pytest.mark.parametrize(
    "change",
    [
        {"mode": "both"},
        {"mode": None},
        {"recent_n": 0},
        {"recent_n": -1},
        {"recent_n": True},
        {"recent_n": 1.0},
        {"recent_n": "10"},
        {"recent_n": 9007199254740992},
        {"enabled": "false"},
        {"enabled": 0},
        {"enabled": None},
        {"secret": "FICTIONAL_SECRET_PATCH"},
    ],
)
def test_patch_rejects_invalid_complete_config_and_preserves_saved_state(
    tmp_path, change
):
    with client_for(tmp_path / "monitor.sqlite") as client:
        saved = client.post(BASE, json={"uid": UID}).json()
        body = {"mode": "recent", "recent_n": 10, "enabled": True, **change}
        response = client.patch(f"{BASE}/{UID}/monitor", json=body)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "INVALID_INPUT"
        for incomplete in ({}, {"mode": "recent"}, {"recent_n": 10, "enabled": True}):
            assert (
                client.patch(f"{BASE}/{UID}/monitor", json=incomplete).status_code
                == 422
            )
        assert client.get(f"{BASE}/{UID}").json() == saved


def test_delete_is_idempotent_and_keeps_identity_readable(tmp_path):
    with client_for(tmp_path / "monitor.sqlite") as client:
        saved = client.post(BASE, json={"uid": UID}).json()
        for _ in range(2):
            response = client.delete(f"{BASE}/{UID}/monitor")
            assert response.status_code == 204
            assert response.content == b""
        retained = {**saved, "monitor": None}
        assert client.get(f"{BASE}/{UID}").json() == retained
        assert client.get(BASE).json() == {"ups": [retained]}
        response = client.patch(
            f"{BASE}/{UID}/monitor",
            json={
                "mode": "recent",
                "recent_n": 10,
                "enabled": True,
            },
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "NOT_FOUND"


@pytest.mark.parametrize(
    "method,path,body,status,code",
    [
        ("get", "/999", None, 404, "NOT_FOUND"),
        ("delete", "/999/monitor", None, 404, "NOT_FOUND"),
        (
            "patch",
            "/999/monitor",
            {"mode": "recent", "recent_n": 1, "enabled": True},
            404,
            "NOT_FOUND",
        ),
        ("get", "/01", None, 422, "INVALID_INPUT"),
        ("delete", "/FICTIONAL_SECRET_PATH/monitor", None, 422, "INVALID_INPUT"),
        (
            "patch",
            "/0/monitor",
            {"mode": "recent", "recent_n": 1, "enabled": True},
            422,
            "INVALID_INPUT",
        ),
        ("put", "", {"secret": "FICTIONAL_SECRET_BODY"}, 422, "INVALID_INPUT"),
        ("get", "/999/unknown", None, 404, "NOT_FOUND"),
    ],
)
def test_path_unknown_and_framework_errors_are_safe(
    tmp_path, method, path, body, status, code
):
    with client_for(tmp_path / "monitor.sqlite") as client:
        response = client.request(method, BASE + path, json=body)
        assert response.status_code == status
        assert response.json()["error"]["code"] == code
        assert "FICTIONAL_SECRET" not in response.text


@pytest.mark.parametrize(
    "payload",
    [
        {"code": -403, "message": "FICTIONAL_SECRET_UPSTREAM"},
        {
            "code": "0",
            "data": {
                "card": {
                    "mid": UID,
                    "name": "虚构",
                    "face": "https://example.invalid/a",
                }
            },
        },
        {
            "code": False,
            "data": {
                "card": {
                    "mid": UID,
                    "name": "虚构",
                    "face": "https://example.invalid/a",
                }
            },
        },
        {},
        {"code": 0},
        {"code": 0, "data": None},
        {"code": 0, "data": {"card": []}},
        {
            "code": 0,
            "data": {
                "card": {
                    "mid": "202",
                    "name": "虚构",
                    "face": "https://example.invalid/a",
                }
            },
        },
        *[
            {
                "code": 0,
                "data": {
                    "card": {
                        "mid": UID,
                        "name": name,
                        "face": "https://example.invalid/a",
                    }
                },
            }
            for name in (None, "", "  ", 202)
        ],
        *[
            {"code": 0, "data": {"card": {"mid": UID, "name": "虚构", "face": face}}}
            for face in (
                None,
                "",
                "http://example.invalid/a",
                "https://",
                "https://secret:FICTIONAL_SECRET@example.invalid/a",
                "https://example.invalid:bad/a",
                "https://example.invalid/a\n",
            )
        ],
    ],
)
def test_incomplete_rejected_or_mismatched_profile_never_creates_identity(
    tmp_path, payload, caplog
):
    with client_for(
        tmp_path / "monitor.sqlite", lambda request: httpx.Response(200, json=payload)
    ) as client:
        response = client.post(BASE, json={"uid": UID})
        assert response.status_code == 502
        assert response.json()["error"]["code"] == "PROFILE_UNAVAILABLE"
        assert "FICTIONAL_SECRET" not in response.text
        assert client.get(BASE).json() == {"ups": []}
    assert "FICTIONAL_SECRET" not in caplog.text


@pytest.mark.parametrize(
    "failure", ["connect", "timeout", "http403", "http500", "redirect", "json"]
)
def test_network_http_and_json_errors_are_safe_and_retryable(tmp_path, failure, caplog):
    secret = "FICTIONAL_SECRET_NETWORK"

    def handler(request):
        if failure == "connect":
            raise httpx.ConnectError(secret, request=request)
        if failure == "timeout":
            raise httpx.ReadTimeout(secret, request=request)
        if failure == "json":
            return httpx.Response(200, content=secret)
        status = {"http403": 403, "http500": 500, "redirect": 302}[failure]
        return httpx.Response(
            status,
            content=secret,
            headers={"Location": "https://example.invalid/?secret=" + secret},
        )

    path = tmp_path / "monitor.sqlite"
    with client_for(path, handler) as client:
        response = client.post(BASE, json={"uid": UID})
        assert response.status_code == 502
        assert response.json()["error"]["code"] == "PROFILE_UNAVAILABLE"
        assert secret not in response.text
        assert client.get(BASE).json() == {"ups": []}
    assert secret not in caplog.text


def test_application_restart_reopens_saved_config_and_deleted_identity(tmp_path):
    path = tmp_path / "monitor.sqlite"
    with client_for(path) as client:
        client.post(BASE, json={"uid": UID})
        client.post(BASE, json={"uid": "202"})
        client.patch(
            f"{BASE}/{UID}/monitor",
            json={"mode": "specified", "recent_n": 123, "enabled": False},
        )
        client.delete(f"{BASE}/202/monitor")
        saved = client.get(BASE).json()
    with client_for(path) as reopened:
        assert reopened.get(BASE).json() == saved
        assert reopened.get(f"{BASE}/{UID}").json()["monitor"] == {
            "mode": "specified",
            "recent_n": 123,
            "enabled": False,
            "last_checked_at": None,
            "last_succeeded_at": None,
        }
        assert reopened.get(f"{BASE}/202").json()["monitor"] is None


def test_readd_refreshes_complete_profile_and_defaults_after_delete(tmp_path):
    state = {"fail": False, "name": "虚构初始"}

    def handler(request):
        if state["fail"]:
            return httpx.Response(403, text="FICTIONAL_SECRET_READD")
        return httpx.Response(200, json=card(UID, state["name"]))

    with client_for(tmp_path / "monitor.sqlite", handler) as client:
        saved = client.post(BASE, json={"uid": UID}).json()
        client.patch(
            f"{BASE}/{UID}/monitor",
            json={"mode": "specified", "recent_n": 20, "enabled": False},
        )
        client.delete(f"{BASE}/{UID}/monitor")
        state["fail"] = True
        assert client.post(BASE, json={"uid": UID}).status_code == 502
        assert client.get(f"{BASE}/{UID}").json() == {**saved, "monitor": None}
        state.update(fail=False, name="虚构新资料")
        response = client.post(BASE, json={"uid": UID})
        assert response.status_code == 201
        assert response.json()["name"] == "虚构新资料"
        assert response.json()["monitor"] == DEFAULT_MONITOR


def test_unexpected_exception_is_safe_in_response_and_debug_logs(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)

    def broken(request):
        raise RuntimeError("FICTIONAL_SECRET_UNEXPECTED")

    with client_for(tmp_path / "monitor.sqlite", broken) as client:
        response = client.post(
            BASE + "?token=FICTIONAL_SECRET_QUERY", json={"uid": UID}
        )
        assert response.status_code == 500
        assert response.json() == {
            "error": {"code": "INTERNAL_ERROR", "message": "服务暂不可用"}
        }
        assert client.get(BASE).json() == {"ups": []}
    assert "FICTIONAL_SECRET" not in response.text + caplog.text
    assert "mid=" not in caplog.text


def test_simultaneous_duplicate_add_has_one_winner_without_profile_overwrite(tmp_path):
    entered = Event()
    release = Event()
    count = []

    async def handler(request):
        count.append(len(count) + 1)
        ordinal = count[-1]
        if len(count) == 2:
            entered.set()
        await anyio.to_thread.run_sync(release.wait, 5)
        return httpx.Response(200, json=card(UID, f"虚构并发{ordinal}"))

    with (
        client_for(tmp_path / "monitor.sqlite", handler) as client,
        ThreadPoolExecutor(max_workers=2) as pool,
    ):
        requests = [pool.submit(client.post, BASE, json={"uid": UID}) for _ in range(2)]
        try:
            assert entered.wait(5), "Both requests should reach the external boundary"
        finally:
            release.set()
        responses = [future.result(timeout=5) for future in requests]
        assert sorted(response.status_code for response in responses) == [201, 409]
        winner = next(
            response.json() for response in responses if response.status_code == 201
        )
        assert client.get(BASE).json() == {"ups": [winner]}
        loser = next(
            response.json() for response in responses if response.status_code == 409
        )
        assert loser["error"]["code"] == "ALREADY_MONITORED"


def test_paused_upstream_does_not_block_existing_reads_or_config_writes(tmp_path):
    entered, release = Event(), Event()

    async def handler(request):
        if request.url.params["mid"] == UID:
            entered.set()
            await anyio.to_thread.run_sync(release.wait, 10)
        return profile_response(request)

    with (
        client_for(tmp_path / "monitor.sqlite", handler) as client,
        ThreadPoolExecutor(max_workers=2) as pool,
    ):
        assert client.post(BASE, json={"uid": "202"}).status_code == 201
        pending = pool.submit(client.post, BASE, json={"uid": UID})
        assert entered.wait(5)
        try:
            read = pool.submit(client.get, BASE)
            assert read.result(timeout=3).json()["ups"][0]["uid"] == "202"
            write = pool.submit(
                client.patch,
                f"{BASE}/202/monitor",
                json={
                    "mode": "recent",
                    "recent_n": 1234,
                    "enabled": False,
                },
            )
            assert write.result(timeout=3).status_code == 200
            assert not pending.done()
        finally:
            release.set()
        assert pending.result(timeout=5).status_code == 201


def test_real_storage_lock_failure_is_safe_atomic_and_retryable(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    path = tmp_path / "monitor.sqlite"
    with client_for(path) as client:
        with sqlite3.connect(path, isolation_level=None) as blocker:
            blocker.execute("BEGIN IMMEDIATE")
            try:
                response = client.post(
                    BASE + "?secret=FICTIONAL_SECRET_LOCK", json={"uid": UID}
                )
                assert response.status_code == 503
                assert response.json()["error"]["code"] == "STORAGE_UNAVAILABLE"
                assert client.get(BASE).json() == {"ups": []}
            finally:
                blocker.rollback()
        assert client.post(BASE, json={"uid": UID}).status_code == 201
    assert "FICTIONAL_SECRET" not in response.text + caplog.text


def test_identity_and_config_creation_roll_back_together_on_real_write_failure(
    tmp_path, caplog
):
    path = tmp_path / "monitor.sqlite"
    with client_for(path) as client:
        reject_config_inserts(path)
        response = client.post(BASE, json={"uid": UID})
        assert response.status_code == 503
        assert client.get(BASE).json() == {"ups": []}
        assert client.get(f"{BASE}/{UID}").status_code == 404
    assert "FICTIONAL_SECRET" not in response.text + caplog.text


def test_readd_storage_failure_keeps_previous_successful_identity(tmp_path):
    path = tmp_path / "monitor.sqlite"
    state = {"name": "虚构旧资料"}

    def handler(request):
        return httpx.Response(200, json=card(UID, state["name"]))

    with client_for(path, handler) as client:
        saved = client.post(BASE, json={"uid": UID}).json()
        client.delete(f"{BASE}/{UID}/monitor")
        reject_config_inserts(path)
        state["name"] = "虚构新资料不可部分保存"
        assert client.post(BASE, json={"uid": UID}).status_code == 503
        assert client.get(f"{BASE}/{UID}").json() == {**saved, "monitor": None}


def test_app_connections_enforce_foreign_keys_and_deleted_config_keeps_archive_owner(
    tmp_path,
):
    path = tmp_path / "monitor.sqlite"
    with client_for(path) as client:
        monitor, identity, _, owner_key = management_relation(path)
        with sqlite3.connect(path) as database:
            database.execute(f"""CREATE TABLE fixture_archive (
                owner TEXT REFERENCES {quote(identity)}({quote(owner_key)})
            )""")
            database.execute(f"""CREATE TRIGGER fixture_orphan AFTER INSERT ON {quote(monitor)}
                BEGIN INSERT INTO fixture_archive VALUES ('999'); END""")
        assert client.post(BASE, json={"uid": UID}).status_code == 503
        assert client.get(BASE).json() == {"ups": []}
        with sqlite3.connect(path) as database:
            database.execute("DROP TRIGGER fixture_orphan")
        saved = client.post(BASE, json={"uid": UID}).json()
        with sqlite3.connect(path) as database:
            database.execute("INSERT INTO fixture_archive VALUES (?)", (UID,))
        assert client.delete(f"{BASE}/{UID}/monitor").status_code == 204
        assert client.get(f"{BASE}/{UID}").json() == {**saved, "monitor": None}


def test_numeric_card_mid_is_parsed_and_no_up_or_recent_n_product_caps(tmp_path):
    def handler(request):
        assert all(timeout > 0 for timeout in request.extensions["timeout"].values())
        uid = request.url.params["mid"]
        return httpx.Response(200, json=card(int(uid)))

    with client_for(tmp_path / "monitor.sqlite", handler) as client:
        for uid in ("202", "301", "302", "303", "304", "305", "1" * 128):
            response = client.post(BASE, json={"uid": uid})
            assert response.status_code == 201
            assert response.json()["uid"] == uid
        assert len(client.get(BASE).json()["ups"]) == 7
        response = client.patch(
            f"{BASE}/202/monitor",
            json={
                "mode": "recent",
                "recent_n": 1001,
                "enabled": True,
            },
        )
        assert response.status_code == 200
        assert response.json()["monitor"]["recent_n"] == 1001


@pytest.mark.parametrize(
    "body",
    [
        b'{"uid":"202", "secret":"FICTIONAL_SECRET_JSON"',
        b"\xffFICTIONAL_SECRET_ENCODING",
        b"null",
    ],
)
def test_malformed_or_non_object_json_errors_are_sanitized(tmp_path, body, caplog):
    caplog.set_level(logging.DEBUG)
    with client_for(tmp_path / "monitor.sqlite") as client:
        response = client.post(
            BASE + "?token=FICTIONAL_SECRET_QUERY",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "INVALID_INPUT"
        assert client.get(BASE).json() == {"ups": []}
    assert "FICTIONAL_SECRET" not in response.text + caplog.text


def test_list_sorts_uid_as_strings_including_retained_identity(tmp_path):
    with client_for(tmp_path / "monitor.sqlite") as client:
        for uid in ("202", "2", "10"):
            assert client.post(BASE, json={"uid": uid}).status_code == 201
        client.delete(f"{BASE}/10/monitor")
        ups = client.get(BASE).json()["ups"]
        assert [up["uid"] for up in ups] == ["10", "2", "202"]
        assert ups[0]["monitor"] is None
