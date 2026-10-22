"""采集诊断日志：固定事件与分类，不输出来源内容、身份 ID、URL 或凭据。"""

import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
from itertools import count
from json import JSONDecodeError
import logging
import re
import sqlite3

import httpx


_LOGGER = logging.getLogger("bili_monitor.collector")
_ATTEMPT = ContextVar("collector_attempt", default=None)
_SEQUENCE = count(1)
_HANDLER = None

# 只识别应用自身的固定错误，不输出其他异常消息或上游响应正文。
_KNOWN_REASONS = {
    "Comment source rejected request": "source_rejected",
    "Reply source rejected request": "source_rejected",
    "Comment count source rejected request": "source_rejected",
    "Comment counts changed during scan": "pagination_changed",
    "Reply count changed during scan": "pagination_changed",
    "Comment pagination did not advance": "pagination_not_advancing",
    "Reply pagination did not advance": "pagination_not_advancing",
    "Unstable empty comment tail": "pagination_unstable",
    "Unstable empty reply tail": "pagination_unstable",
    "Incomplete reply scan": "pagination_incomplete",
    "Unknown comment resource": "locator_missing",
    "Invalid comment ID": "comment_id_invalid",
    "Invalid comment locator": "locator_invalid",
    "Unverified fallback comment resource": "fallback_unconfirmed",
    "Reply count does not match root": "reply_count_mismatch",
    "Invalid root comment": "root_shape_invalid",
    "Invalid comment content": "content_shape_invalid",
    "Mismatched comment resource": "comment_resource_mismatch",
    "Mismatched comment type": "comment_type_mismatch",
    "Invalid comment text": "comment_text_invalid",
    "Not a root comment": "comment_not_root",
    "Unknown comment count": "comment_count_invalid",
    "Mismatched comment page": "comment_page_mismatch",
    "Unknown comment page count": "comment_page_count_invalid",
    "Invalid comment total": "comment_total_invalid",
    "Invalid comment page": "comment_page_invalid",
    "Invalid comment upper metadata": "upper_shape_invalid",
    "Invalid top comment": "top_shape_invalid",
    "Invalid hot comments": "hots_shape_invalid",
    "Unconfirmed empty comment resource": "comment_empty_unconfirmed",
    "Contradictory empty comment resource": "comment_empty_contradictory",
    "Invalid pictures": "pictures_shape_invalid",
    "Invalid media URL": "media_url_invalid",
    "Mismatched reply root": "reply_root_mismatch",
    "Invalid reply relation": "reply_relation_invalid",
    "Mismatched reply page": "reply_page_mismatch",
    "Unknown reply count": "reply_count_invalid",
    "Mismatched reply resource": "reply_resource_mismatch",
    "Invalid reply page": "reply_page_invalid",
    "Unconfirmed reply page": "reply_page_unconfirmed",
}

# 仅允许输出本应用协议中固定的键名，不回显任意 KeyError 参数。
_FAILURE_FIELDS = {
    "root_sync_failed": frozenset({"data", "page", "replies", "content", "img_src"}),
    "reply_sync_failed": frozenset({"data", "page", "root", "replies", "content"}),
}


def configure_collector_logging():
    global _HANDLER
    if _HANDLER is None:
        _HANDLER = logging.StreamHandler()
        _HANDLER.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
        _LOGGER.addHandler(_HANDLER)
    _LOGGER.setLevel(logging.INFO)
    _LOGGER.propagate = False


def _safe_value(value):
    if value is None:
        return "none"
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) is int:
        return str(value)
    if isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", value):
        return value
    return "unknown"


def collector_event(event, *, warning=False, **fields):
    configure_collector_logging()
    attempt = _ATTEMPT.get()
    if attempt is not None:
        fields = {"attempt": attempt, **fields}
    values = " ".join(f"{key}={_safe_value(value)}" for key, value in fields.items())
    _LOGGER.log(logging.WARNING if warning else logging.INFO, "%s %s", event, values)


def failure_fields(error, *, allowed_fields=()):
    status = None
    details = {}
    if isinstance(error, httpx.TimeoutException):
        reason = "timeout"
    elif isinstance(error, httpx.DecodingError):
        # 解压失败属于来源响应完整性，不是网络不可达；不能折叠成 network_error。
        reason = "decode_invalid"
    elif isinstance(error, httpx.HTTPStatusError):
        candidate = error.response.status_code
        status = candidate if type(candidate) is int and 100 <= candidate <= 599 else None
        reason = "http_status"
    elif isinstance(error, httpx.RequestError):
        reason = "network_error"
    elif isinstance(error, sqlite3.Error):
        reason = "storage_error"
    elif isinstance(error, JSONDecodeError):
        reason = "json_invalid"
    elif isinstance(error, KeyError):
        reason = "field_missing"
        if error.args and isinstance(error.args[0], str) and error.args[0] in allowed_fields:
            details["field"] = error.args[0]
    elif isinstance(error, UnicodeError):
        reason = "encoding_invalid"
    elif isinstance(error, ValueError):
        reason = "value_invalid"
        if error.args and isinstance(error.args[0], str):
            reason = _KNOWN_REASONS.get(error.args[0], reason)
    elif isinstance(error, TypeError):
        reason = "type_invalid"
    elif isinstance(error, AttributeError):
        reason = "attribute_invalid"
    elif isinstance(error, IndexError):
        reason = "index_invalid"
    else:
        reason = "internal_error"
    return {"reason": reason, "http_status": status, **details}


def collector_failure(event, error, **fields):
    diagnostics = failure_fields(error, allowed_fields=_FAILURE_FIELDS.get(event, ()))
    collector_event(event, warning=True, **fields, **diagnostics)


@contextmanager
def collector_attempt():
    """进程内流水号关联一次工作；不把持久领取令牌或来源 ID 写入日志。"""
    token = _ATTEMPT.set(next(_SEQUENCE))
    try:
        yield
    except asyncio.CancelledError:
        collector_event("collector_attempt_cancelled")
        raise
    finally:
        _ATTEMPT.reset(token)
