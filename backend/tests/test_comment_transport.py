"""评论 Requests 会话：已解压的响应体不能再交给 HTTPX 解第二次。"""

import json

import httpx
import pytest

from backend.bili_monitor import comment_client
from backend.bili_monitor.collector_logging import failure_fields

_UID = "3493130286402061"
_URL = "https://api.bilibili.com/x/v2/reply"
_PAYLOAD = {"code": 0, "data": {"page": {"num": 1, "size": 20, "count": 1, "acount": 1}, "replies": []}}
_TRANSPORT_HEADERS = ("content-encoding", "transfer-encoding")


class _FakeRequestsResponse:
    """模拟 requests 的行为：content 已是解压后的明文，头仍带 Content-Encoding。"""

    def __init__(self, payload):
        self.status_code = 200
        self.content = json.dumps(payload).encode()
        self.headers = {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Encoding": "gzip",
            "Content-Length": str(len(self.content)),
            "Transfer-Encoding": "chunked",
            "Vary": "Origin",
        }
        self.url = _URL
        self.closed = False

    def close(self):
        self.closed = True


class _FakeSession:
    def __init__(self, response):
        self.response = response
        self.requests = []

    def get(self, url, params=None, headers=None, timeout=None):
        self.requests.append((url, params))
        return self.response


def _client(session):
    client = comment_client.RequestsCommentClient(_UID, (), comment_client.SourcePacer())
    client.session = session
    return client


def test_decoded_body_is_not_decompressed_twice():
    response = _FakeRequestsResponse(_PAYLOAD)
    client = _client(_FakeSession(response))

    result = client._get(_URL, {"oid": "1", "type": 11}, {}, 15)

    assert isinstance(result, httpx.Response)
    assert result.json() == _PAYLOAD
    assert response.closed is True


@pytest.mark.parametrize("header", _TRANSPORT_HEADERS)
def test_transport_headers_are_not_forwarded_to_source_protocol(header):
    client = _client(_FakeSession(_FakeRequestsResponse(_PAYLOAD)))

    result = client._get(_URL, {}, {}, 15)

    assert header not in {name.lower() for name in result.headers}


def test_content_length_describes_the_decoded_body():
    client = _client(_FakeSession(_FakeRequestsResponse(_PAYLOAD)))

    result = client._get(_URL, {}, {}, 15)

    assert result.headers["content-length"] == str(len(result.content))


def test_other_response_headers_survive_transport_sanitizing():
    client = _client(_FakeSession(_FakeRequestsResponse(_PAYLOAD)))

    result = client._get(_URL, {}, {}, 15)

    assert result.headers["content-type"] == "application/json; charset=utf-8"
    assert result.headers["vary"] == "Origin"


def test_plain_body_without_encoding_header_is_unchanged():
    response = _FakeRequestsResponse(_PAYLOAD)
    response.headers.pop("Content-Encoding")
    client = _client(_FakeSession(response))

    assert client._get(_URL, {}, {}, 15).json() == _PAYLOAD


def test_decoding_failure_has_its_own_reason():
    assert failure_fields(httpx.DecodingError("bad gzip")) == {"reason": "decode_invalid", "http_status": None}
    assert failure_fields(httpx.ConnectError("down")) == {"reason": "network_error", "http_status": None}


def test_decoding_reason_keeps_timeout_and_http_status_classification():
    request = httpx.Request("GET", _URL)
    assert failure_fields(httpx.ReadTimeout("slow", request=request))["reason"] == "timeout"
    status = httpx.HTTPStatusError("bad", request=request, response=httpx.Response(412, request=request))
    assert failure_fields(status) == {"reason": "http_status", "http_status": 412}
