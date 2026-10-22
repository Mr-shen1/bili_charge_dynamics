"""通过真实管理 HTTP 与运维日志核验资料失败分类；仅替换外部网络。"""

import json
import logging

import httpx
import pytest

from backend.tests.management_support import BASE, DEFAULT_MONITOR, UID, card, client_for


SECRET = "FICTIONAL_SECRET_PROFILE_DIAGNOSTIC"
PRIVATE_NAME = "仅用于测试的私人昵称"
PROFILE_LOGGER = "backend.bili_monitor.profiles"


def assert_safe_failure(tmp_path, caplog, handler, expected_message):
    caplog.set_level(logging.DEBUG)
    with client_for(tmp_path / "monitor.sqlite", handler) as client:
        response = client.post(
            BASE + "?token=" + SECRET,
            json={"uid": UID},
            headers={"Authorization": "Bearer " + SECRET, "Cookie": "session=" + SECRET},
        )
        assert response.status_code == 502
        assert response.json() == {
            "error": {"code": "PROFILE_UNAVAILABLE", "message": "无法取得完整公开资料"}
        }
        assert client.get(BASE).json() == {"ups": []}
    events = [record for record in caplog.records if record.name == PROFILE_LOGGER]
    assert len(events) == 1
    assert events[0].levelno == logging.WARNING
    assert events[0].getMessage() == expected_message
    assert events[0].exc_info is None
    assert events[0].stack_info is None
    observed = response.text + caplog.text
    for forbidden in (SECRET, PRIVATE_NAME, UID, "mid=", "https://", "Bearer", "session="):
        assert forbidden not in observed


@pytest.mark.parametrize(
    "error_type",
    [httpx.ReadTimeout, httpx.ConnectTimeout, httpx.WriteTimeout, httpx.PoolTimeout],
)
def test_profile_timeout_has_safe_server_diagnostic_and_unchanged_http_error(
    tmp_path, caplog, error_type
):
    def timeout(request):
        raise error_type(SECRET, request=request)

    assert_safe_failure(
        tmp_path,
        caplog,
        timeout,
        "profile_lookup_failed reason=timeout http_status=none",
    )


@pytest.mark.parametrize(
    "error_type",
    [httpx.ConnectError, httpx.RemoteProtocolError, httpx.DecodingError, httpx.TooManyRedirects],
)
def test_profile_network_failure_has_safe_classification(tmp_path, caplog, error_type):
    def unavailable(request):
        raise error_type(SECRET, request=request)

    assert_safe_failure(
        tmp_path,
        caplog,
        unavailable,
        "profile_lookup_failed reason=network_error http_status=none",
    )


@pytest.mark.parametrize(
    "status,expected_message",
    [
        (302, "profile_lookup_failed reason=http_status http_status=302"),
        (403, "profile_lookup_failed reason=http_status http_status=403"),
        (412, "profile_lookup_failed reason=http_status http_status=412"),
        (429, "profile_lookup_failed reason=http_status http_status=429"),
        (500, "profile_lookup_failed reason=http_status http_status=500"),
        (999, "profile_lookup_failed reason=http_status http_status=unknown"),
    ],
)
def test_profile_http_failure_logs_only_bounded_status(
    tmp_path, caplog, status, expected_message
):
    def rejected(request):
        return httpx.Response(
            status,
            content=SECRET,
            headers={
                "Location": "https://example.invalid/?token=" + SECRET,
                "Set-Cookie": "session=" + SECRET,
            },
        )

    assert_safe_failure(
        tmp_path,
        caplog,
        rejected,
        expected_message + " message_state=non_json upstream_message=null",
    )


@pytest.mark.parametrize("status", [True, 403.0, SECRET])
def test_profile_non_integer_http_status_cannot_enter_diagnostic_log(
    tmp_path, caplog, status
):
    def rejected(request):
        raise httpx.HTTPStatusError(
            SECRET,
            request=request,
            response=httpx.Response(status, request=request),
        )

    assert_safe_failure(
        tmp_path,
        caplog,
        rejected,
        "profile_lookup_failed reason=http_status http_status=unknown"
        " message_state=empty_body upstream_message=null",
    )


@pytest.mark.parametrize(
    "body,content_type,state,safe_message",
    [
        (json.dumps({"message": "请求被拦截"}).encode(), "application/json", "allowed", "请求被拦截"),
        (json.dumps({"msg": "Access Denied"}).encode(), "application/json", "allowed", "Access Denied"),
        (json.dumps({"message": SECRET}).encode(), "application/json", "not_allowlisted", None),
        (json.dumps({"message": PRIVATE_NAME}).encode(), "application/json", "not_allowlisted", None),
        (json.dumps({"message": UID}).encode(), "application/json", "not_allowlisted", None),
        (json.dumps({"message": "https://example.invalid/?token=" + SECRET}).encode(), "application/json", "not_allowlisted", None),
        (json.dumps({"message": "请求被拦截\n" + SECRET}).encode(), "application/json", "not_allowlisted", None),
        (json.dumps({"message": "x" * 201}).encode(), "application/json", "too_long", None),
        (b"{}", "application/json", "missing", None),
        (b'{"message":null}', "application/json", "missing", None),
        (b'{"message":[]}', "application/json", "invalid_type", None),
        (b"[]", "application/json", "invalid_payload", None),
        (json.dumps({"message": "Forbidden"}).encode(), "application/json; profile=html", "allowed", "Forbidden"),
        (b"<body>private</body>", "application/xhtml+xml; charset=utf-8", "html", None),
        (b"<html>" + SECRET.encode() + b"</html>", "text/html", "html", None),
        (b"<!DOCTYPE html><title>private</title>", "text/plain", "html", None),
        (SECRET.encode(), "text/plain", "non_json", None),
        (b"x" * 8193, "application/json", "body_too_large", None),
        (b"", "application/json", "empty_body", None),
        (json.dumps({"message": "", "msg": "Forbidden"}).encode(), "application/json", "allowed", "Forbidden"),
        (json.dumps({"message": None, "msg": "Forbidden"}).encode(), "application/json", "allowed", "Forbidden"),
        (json.dumps({"message": 123, "msg": "Forbidden"}).encode(), "application/json", "invalid_type", None),
        (json.dumps({"data": {"message": "Forbidden"}}).encode(), "application/json", "missing", None),
        (b"\xff", "application/json", "non_json", None),
        (b"[" * 1100 + SECRET.encode(), "application/json", "non_json", None),
        (json.dumps({"message": SECRET, "msg": "Forbidden"}).encode(), "application/json", "not_allowlisted", None),
        (json.dumps({"message": "  "}).encode(), "application/json", "missing", None),
    ],
    ids=lambda value: f"body-{len(value)}" if isinstance(value, bytes) else None,
)
def test_profile_http_error_logs_safe_message_or_explicit_unavailability(
    tmp_path, caplog, body, content_type, state, safe_message
):
    def rejected(request):
        return httpx.Response(412, content=body, headers={"Content-Type": content_type})

    expected = (
        "profile_lookup_failed reason=http_status http_status=412"
        f" message_state={state} upstream_message={json.dumps(safe_message, ensure_ascii=False)}"
    )
    assert_safe_failure(tmp_path, caplog, rejected, expected)


def test_profile_http_error_remains_failure_even_with_complete_success_card_body(
    tmp_path, caplog
):
    payload = {**card(), "message": "Forbidden"}
    assert_safe_failure(
        tmp_path,
        caplog,
        lambda request: httpx.Response(412, json=payload),
        'profile_lookup_failed reason=http_status http_status=412'
        ' message_state=allowed upstream_message="Forbidden"',
    )


def test_profile_unreadable_http_error_body_does_not_replace_safe_502(tmp_path, caplog):
    def rejected(request):
        raise httpx.HTTPStatusError(
            SECRET,
            request=request,
            response=httpx.Response(412, stream=httpx.ByteStream(SECRET.encode()), request=request),
        )

    assert_safe_failure(
        tmp_path,
        caplog,
        rejected,
        "profile_lookup_failed reason=http_status http_status=412"
        " message_state=unreadable upstream_message=null",
    )


def test_profile_diagnostic_body_failure_does_not_replace_known_upstream_failure(
    tmp_path, caplog
):
    class UnreadableResponse(httpx.Response):
        fail_body = False

        @property
        def content(self):
            if self.fail_body:
                raise OSError(SECRET)
            return super().content

    def rejected(request):
        response = UnreadableResponse(412, request=request)
        response.fail_body = True
        raise httpx.HTTPStatusError(SECRET, request=request, response=response)

    assert_safe_failure(
        tmp_path,
        caplog,
        rejected,
        "profile_lookup_failed reason=http_status http_status=412"
        " message_state=unreadable upstream_message=null",
    )


def test_profile_readd_failure_with_message_keeps_previous_identity(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    state = {"fail": False}

    def handler(request):
        if state["fail"]:
            return httpx.Response(412, json={"message": "Forbidden"})
        return httpx.Response(200, json=card())

    with client_for(tmp_path / "monitor.sqlite", handler) as client:
        saved = client.post(BASE, json={"uid": UID}).json()
        assert client.delete(f"{BASE}/{UID}/monitor").status_code == 204
        state["fail"] = True
        response = client.post(BASE, json={"uid": UID})
        assert response.status_code == 502
        assert response.json()["error"]["code"] == "PROFILE_UNAVAILABLE"
        assert client.get(f"{BASE}/{UID}").json() == {**saved, "monitor": None}
    events = [record for record in caplog.records if record.name == PROFILE_LOGGER]
    assert len(events) == 1
    assert events[0].getMessage() == (
        'profile_lookup_failed reason=http_status http_status=412'
        ' message_state=allowed upstream_message="Forbidden"'
    )
    assert saved["name"] not in caplog.text
    assert UID not in caplog.text


@pytest.mark.parametrize("code", [-403, 1, 10**100])
def test_profile_business_rejection_logs_category_not_upstream_code_or_private_message(
    tmp_path, caplog, code
):
    def rejected(request):
        return httpx.Response(200, json={"code": code, "message": SECRET})

    assert_safe_failure(
        tmp_path,
        caplog,
        rejected,
        "profile_lookup_failed reason=upstream_rejected http_status=none"
        " message_state=not_allowlisted upstream_message=null",
    )


@pytest.mark.parametrize(
    "field,message",
    [("message", "访问权限不足"), ("msg", "Forbidden")],
)
def test_profile_business_rejection_logs_approved_upstream_message(
    tmp_path, caplog, field, message
):
    def rejected(request):
        return httpx.Response(200, json={"code": -403, field: message})

    expected = (
        "profile_lookup_failed reason=upstream_rejected http_status=none"
        f" message_state=allowed upstream_message={json.dumps(message, ensure_ascii=False)}"
    )
    assert_safe_failure(tmp_path, caplog, rejected, expected)


@pytest.mark.parametrize(
    "body",
    [
        SECRET.encode(),
        b"null",
        b"[]",
        b"{}",
        b'{"code":"0"}',
        b'{"code":false}',
        b'{"code":0}',
        b'{"code":0,"data":null}',
        b'{"code":0,"data":{"card":[]}}',
        b'{"code":0,"data":{"card":{}}}',
    ],
)
def test_profile_invalid_payload_has_safe_classification(tmp_path, caplog, body):
    def malformed(request):
        return httpx.Response(200, content=body)

    assert_safe_failure(
        tmp_path,
        caplog,
        malformed,
        "profile_lookup_failed reason=payload_invalid http_status=none",
    )


@pytest.mark.parametrize("returned_uid", ["202", SECRET, False, None])
def test_profile_identity_mismatch_does_not_log_requested_or_returned_identity(
    tmp_path, caplog, returned_uid
):
    payload = card()
    payload["data"]["card"]["mid"] = returned_uid

    assert_safe_failure(
        tmp_path,
        caplog,
        lambda request: httpx.Response(200, json=payload),
        "profile_lookup_failed reason=uid_mismatch http_status=none",
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"name": None},
        {"name": "  "},
        {"name": 202},
        {"face": None},
        {"name": SECRET, "face": "http://example.invalid/avatar.png"},
        {"face": "https://user:" + SECRET + "@example.invalid/avatar.png"},
        {"face": "https://example.invalid:" + SECRET + "/avatar.png"},
        {"face": "https://example.invalid/" + SECRET + "\n"},
    ],
)
def test_profile_invalid_identity_fields_have_safe_classification(
    tmp_path, caplog, changes
):
    payload = card()
    payload["data"]["card"].update(changes)

    assert_safe_failure(
        tmp_path,
        caplog,
        lambda request: httpx.Response(200, json=payload),
        "profile_lookup_failed reason=profile_invalid http_status=none",
    )


@pytest.mark.parametrize(
    "missing_field,expected_message",
    [
        ("mid", "profile_lookup_failed reason=payload_invalid http_status=none"),
        ("name", "profile_lookup_failed reason=profile_invalid http_status=none"),
        ("face", "profile_lookup_failed reason=profile_invalid http_status=none"),
    ],
)
def test_profile_missing_fields_follow_documented_diagnostic_boundary(
    tmp_path, caplog, missing_field, expected_message
):
    payload = card()
    del payload["data"]["card"][missing_field]

    assert_safe_failure(
        tmp_path,
        caplog,
        lambda request: httpx.Response(200, json=payload),
        expected_message,
    )


def test_profile_success_preserves_dto_and_does_not_emit_failure_diagnostic(
    tmp_path, caplog
):
    caplog.set_level(logging.DEBUG)
    expected = {
        "uid": UID,
        "name": "虚构星海",
        "avatar_url": "https://example.invalid/avatar.png",
        "monitor": DEFAULT_MONITOR,
    }
    with client_for(tmp_path / "monitor.sqlite") as client:
        response = client.post(BASE, json={"uid": UID})
        assert response.status_code == 201
        assert response.json() == expected
        assert client.get(f"{BASE}/{UID}").json() == expected
    assert not [record for record in caplog.records if record.name == PROFILE_LOGGER]
