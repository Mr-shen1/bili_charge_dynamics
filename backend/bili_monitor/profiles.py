"""公开 card 协议解析；仅传输可替换，不制造默认成功资料。"""

import json
import logging
from urllib.parse import urlsplit

import httpx

from .contracts import APIError


logger = logging.getLogger(__name__)

# 仅允许完全匹配的固定安全文本，不代表 B站当前实际使用这些消息。
_SAFE_UPSTREAM_MESSAGES = frozenset(
    {
        "请求被拦截",
        "请求被拦截，请稍后再试",
        "访问权限不足",
        "请求过于频繁",
        "请求过于频繁，请稍后再试",
        "Access Denied",
        "Forbidden",
        "Precondition Failed",
        "Too Many Requests",
    }
)


def _safe_error_message(response):
    """只输出审核过的固定消息；任意未知上游文本不能保证不含秘密。"""
    try:
        body = response.content
    except httpx.StreamError:
        return "unreadable", None
    if len(body) > 8192:
        return "body_too_large", None
    if not body.strip():
        return "empty_body", None
    content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if (
        content_type in {"text/html", "application/xhtml+xml"}
        or body.lstrip().lower().startswith((b"<html", b"<!doctype html"))
    ):
        return "html", None
    try:
        payload = json.loads(body)
    except (ValueError, RecursionError):
        return "non_json", None
    if not isinstance(payload, dict):
        return "invalid_payload", None
    message = payload.get("message")
    if message is None or (isinstance(message, str) and not message.strip()):
        message = payload.get("msg")
    if message is None:
        return "missing", None
    if not isinstance(message, str):
        return "invalid_type", None
    if len(message) > 200:
        return "too_long", None
    message = message.strip()
    if not message:
        return "missing", None
    if message not in _SAFE_UPSTREAM_MESSAGES:
        return "not_allowlisted", None
    return "allowed", message


async def fetch_profile(client, uid):
    failure_reason = "payload_invalid"
    safe_status = "none"
    diagnostic_response = None
    try:
        response = await client.get(
            "https://api.bilibili.com/x/web-interface/card",
            params={"mid": uid},
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or type(payload.get("code")) is not int:
            raise ValueError("Invalid profile response")
        if payload["code"] != 0:
            failure_reason = "upstream_rejected"
            diagnostic_response = response
            raise ValueError("Rejected profile response")
        profile = payload["data"]["card"]
        mid = profile["mid"]
        if type(mid) not in (int, str) or str(mid) != uid:
            failure_reason = "uid_mismatch"
            raise ValueError("Mismatched profile")
        failure_reason = "profile_invalid"
        name, face = profile["name"], profile["face"]
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Missing name")
        if (
            not isinstance(face, str)
            or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in face)
            or "\\" in face
        ):
            raise ValueError("Invalid avatar URL")
        url = urlsplit(face)
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username is not None
            or url.password is not None
        ):
            raise ValueError("Invalid avatar URL")
        # 访问 port 触发非法端口校验，但不跟随该 URL 发起任何请求。
        _ = url.port
        return name, face
    except httpx.TimeoutException:
        failure_reason = "timeout"
    except httpx.HTTPStatusError as error:
        failure_reason = "http_status"
        diagnostic_response = error.response
        status = error.response.status_code
        safe_status = status if type(status) is int and 100 <= status <= 599 else "unknown"
    except httpx.HTTPError:
        failure_reason = "network_error"
    except (ValueError, KeyError, TypeError):
        pass
    message_details = ""
    if diagnostic_response is not None:
        try:
            state, message = _safe_error_message(diagnostic_response)
        except Exception:
            # 诊断是尽力而为的旁路，不能覆盖已经确定的资料失败或记录异常原文。
            state, message = "unreadable", None
        message_details = (
            f" message_state={state}"
            f" upstream_message={json.dumps(message, ensure_ascii=False)}"
        )
    logger.warning(
        "profile_lookup_failed reason=%s http_status=%s%s",
        failure_reason,
        safe_status,
        message_details,
    )
    raise APIError("PROFILE_UNAVAILABLE") from None
