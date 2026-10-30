"""采集诊断日志：固定事件与分类，只放行已校验业务 ID；不发源内容、URL 或凭据。"""

import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
from itertools import count
from json import JSONDecodeError
import logging
import re
import sqlite3

import httpx

from .identifiers import is_valid_id


_LOGGER = logging.getLogger("bili_monitor.collector")
_ATTEMPT = ContextVar("collector_attempt", default=None)
_SEQUENCE = count(1)
_HANDLER = None

# 单条 ID 字段的渲染预算：超长按同一关联号分块，不静默截断定位 ID。
ID_FIELD_CHARS = 300

# 只识别应用自身的固定错误，不输出其他异常消息或上游响应正文。
# 上游业务码里唯一能证明「这条评论已不存在」的一个值：12006 没有该评论。
# 楼中楼页对已删除的根评论会整页返回它，属来源删除而不是采集故障。
DELETED_COMMENT_CODES = frozenset({12006})

_KNOWN_REASONS = {
    "Comment source rejected request": "source_rejected",
    "Reply source rejected request": "source_rejected",
    "Reply source deleted": "source_deleted",
    "Comment count source rejected request": "source_rejected",
    "Comment counts changed during scan": "pagination_changed",
    "Reply count changed during scan": "pagination_changed",
    "Comment counts decreased during scan": "comment_count_decreased",
    "Reply count decreased during scan": "reply_count_decreased",
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

# 可重试收敛的分页一致性校验：来源侧删除／插入会让页内计数基准短时漂移，下一次尝试
# 重新定位锚点并刷新基准即可继续，因此只保留 `collector_failure` 的 WARNING，不升级为
# 飞书告警——否则正常的删除行为会被当成采集故障反复提醒。`value_invalid` 这类兜底分类
# 不在其中：它代表未登记的校验失败，仍要提醒。
# 来源删除不是故障：已删楼由楼级退役收敛，不登记告警，也不该让整轮变成失败。
DELETION_REASONS = frozenset({"source_deleted"})

SELF_HEALING_REASONS = frozenset({
    "pagination_changed",
    "pagination_not_advancing",
    "pagination_unstable",
    "pagination_incomplete",
    "comment_count_decreased",
    "reply_count_decreased",
})

# 仅允许输出本应用协议中固定的键名，不回显任意 KeyError 参数。
_FAILURE_FIELDS = {
    "root_sync_failed": frozenset({"data", "page", "replies", "content", "img_src"}),
    "reply_sync_failed": frozenset({"data", "page", "root", "replies", "content"}),
}

# 上游业务码里唯一可当“凭据失效”的一个值：-101 账号未登录。
NOT_LOGGED_IN = -101


class SourceRejected(ValueError):
    """来源业务拒绝：只保留受控的上游 `code` 整数，不携带响应正文或 message。

    文案保持不变，便于既有 `_KNOWN_REASONS` 继续映射成 `source_rejected`；
    唯一多出来的是一个整数，供分类层判定是否是可信的凭据失效信号。
    """

    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code if type(code) is int else None


def is_source_deleted(error):
    """该失败是否已被上游确认为「评论不存在」：只认 `SourceRejected` 的整数业务码。"""
    return isinstance(error, SourceRejected) and error.code in DELETED_COMMENT_CODES


def credential_signal(error, *, credentials_configured=False):
    """最窄可信的凭据判定：上游业务码 -101，且本次确实配置了来源凭据。

    只比对整数，不读上游 message；`-111/-352/-401/-403/-412/-799` 等风控/频控/
    权限码、HTTP 401/403、超时与网络异常都不参与判定。未配置凭据时 -101 说明来源
    要求登录、本地是匿名访问，属配置问题，归入 `login_required`（采集异常）。
    """
    if getattr(error, "code", None) != NOT_LOGGED_IN:
        return None
    return "credential_rejected" if credentials_configured else "login_required"


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
    if isinstance(value, SourceId):
        return f'"{value.value}"'
    if isinstance(value, SourceIds):
        return "[" + ",".join(f'"{item}"' for item in value) + "]"
    if isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", value):
        return value
    return "unknown"


class SourceId:
    """一个已校验的业务 ID（UP、动态、根评论）：原样字符串，不经浮点数转换。

    只有本类型（与 `SourceIds`）能进日志的 ID 字段；其他字符串仍退化成
    `unknown`，因此新增定位信息不等于放行 Cookie、正文、URL 或异常原文。
    """

    __slots__ = ("value",)

    def __init__(self, value):
        text = str(value) if type(value) is int else value
        if not is_valid_id(text):
            raise ValueError("Invalid log identity")
        self.value = text

    def __eq__(self, other):
        return isinstance(other, SourceId) and other.value == self.value

    def __hash__(self):
        return hash(self.value)

    def __repr__(self):
        return f"SourceId({self.value!r})"


class SourceIds(tuple):
    """一页／一轮的全部已校验业务 ID；超预算时按同一关联号分块输出。"""

    def __new__(cls, values):
        return super().__new__(cls, [SourceId(value).value for value in values])


def source_id(value):
    return SourceId(value)


def correlation_id(value):
    """诊断关联号（如探测轮次）：与业务 ID 同一渲染白名单，但不是内部领取令牌。"""
    return SourceId(str(value))


def source_ids(values):
    return SourceIds(values)


def source_refs(**values):
    """只保留已校验的业务 ID 字段：缺失或非法的定位不会让日志本身失败。"""
    refs = {}
    for key, value in values.items():
        text = str(value) if type(value) is int else value
        if is_valid_id(text):
            refs[key] = SourceId(text)
    return refs


def _id_chunks(values):
    """按渲染长度贪心分块；单条超长时也单独成块，不丢任何 ID。"""
    chunks, current, size = [], [], 0
    for value in values:
        width = len(f'"{value}",')
        if current and size + width > ID_FIELD_CHARS:
            chunks.append(SourceIds(current))
            current, size = [], 0
        current.append(value)
        size += width
    if current:
        chunks.append(SourceIds(current))
    return chunks


def _emit(event, fields, warning):
    attempt = _ATTEMPT.get()
    if attempt is not None:
        fields = {"attempt": attempt, **fields}
    values = " ".join(f"{key}={_safe_value(value)}" for key, value in fields.items())
    _LOGGER.log(logging.WARNING if warning else logging.INFO, "%s %s", event, values)


def collector_event(event, *, warning=False, **fields):
    configure_collector_logging()
    for key, value in fields.items():
        if not isinstance(value, SourceIds):
            continue
        chunks = _id_chunks(value)
        if len(chunks) > 1:
            # 同一事件、同一关联号的多行；每块带序号与总数，读日志的人能重建全集。
            for index, chunk in enumerate(chunks, 1):
                _emit(event, {**fields, key: chunk, "ids_part": index,
                              "ids_chunks": len(chunks), "ids_total": len(value)}, warning)
            return
    _emit(event, fields, warning)


def failure_fields(error, *, allowed_fields=(), credentials_configured=False):
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
        signal = credential_signal(error, credentials_configured=credentials_configured)
        if signal is not None:
            reason = signal
        elif error.args and isinstance(error.args[0], str):
            reason = _KNOWN_REASONS.get(error.args[0], reason)
        if isinstance(error, SourceRejected):
            # 只放行来源业务码整数本身：上游 message、正文与 URL 仍不进日志。
            details["source_code"] = error.code
    elif isinstance(error, TypeError):
        reason = "type_invalid"
    elif isinstance(error, AttributeError):
        reason = "attribute_invalid"
    elif isinstance(error, IndexError):
        reason = "index_invalid"
    else:
        reason = "internal_error"
    return {"reason": reason, "http_status": status, **details}


def collector_failure(event, error, *, credentials_configured=False, **fields):
    diagnostics = failure_fields(error, allowed_fields=_FAILURE_FIELDS.get(event, ()),
                                 credentials_configured=credentials_configured)
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
