"""飞书消息载荷与业务响应判定。

协议依据（官方自定义机器人文档，2025-03 版本）：
- `POST` webhook，请求体为 JSON，`msg_type=post` 时 `content.post.zh_cn.content`
  是段落数组，段落内的 `{"tag": "a", "text": ..., "href": ...}` 是真实可点击链接，
  `zh_cn.title` 可选。
- 业务成功响应形如 `{"code": 0, "msg": "success", "StatusCode": 0}`；
  仅 HTTP 200 不能判定成功（`{"code": 9499}` 仍是失败）。
- 自定义机器人请求体不超过 20 KB；单租户单机器人 100 次/分钟、5 次/秒，
  超限可能返回 HTTP 429 或 `11232` 等限流业务码。

本模块只负责快照 → 载荷、序列化大小与响应分类，不打开连接、不读写数据库。
"""

import json
import re
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import quote

import httpx

from ..source import BEIJING

PAYLOAD_LIMIT_BYTES = 20 * 1024
ELLIPSIS = "……"
LONG_CONTENT = "……内容过长，点击链接查看全文"
IMAGE_COMMENT = "【图片评论，点击链接查看】"
RATE_LIMIT_CODES = frozenset({11232, 11233, 230020, 99991400})
RETRY_AFTER_HEADER = "x-ogw-ratelimit-reset"
RATE_LIMIT_FALLBACK_SECONDS = 60.0
RETRY_AFTER_LIMIT_SECONDS = 600.0

_UNSAFE_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def safe_text(value, *, single_line=False):
    """来源文本按不可信文本展示：不执行 HTML、不生成 @ 提及、不留控制字符。"""
    if not isinstance(value, str):
        return ""
    text = value.replace("\r\n", "\n").replace("\r", "\n")
    text = _UNSAFE_CONTROL.sub("", text)
    if single_line:
        return " ".join(text.split())
    return text.strip()


def text(value):
    return {"tag": "text", "text": value}


def link(label, href):
    return {"tag": "a", "text": label, "href": href}


def post(*paragraphs):
    """富文本载荷；段落由节点列表组成，不使用 at/img 标签。"""
    return {"msg_type": "post", "content": {"post": {"zh_cn": {
        "content": [list(paragraph) for paragraph in paragraphs]}}}}


def encoded(payload):
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def archive_href(base_url, path):
    return base_url.rstrip("/") + path


def dynamic_href(base_url, dynamic_id):
    return archive_href(base_url, "/dynamics/" + quote(str(dynamic_id), safe=""))


def dynamic_changed(snapshot, base_url):
    """动态变化模板：标题或动态 ID + 变化提示 + 可点击本站详情链接。"""
    dynamic_id = str(snapshot["dynamic_id"])
    title = safe_text(snapshot.get("title"), single_line=True) or dynamic_id
    href = dynamic_href(base_url, dynamic_id)

    def build(candidate):
        return post([text(f"动态【{candidate}】发生变化")], [text("链接："), link("查看动态", href)])

    payload = build(title)
    if len(encoded(payload)) <= PAYLOAD_LIMIT_BYTES:
        return payload
    # 超长标题只截断标题，链接与其他字段保持完整；裁到只剩标记时回退动态 ID。
    clipped = _clip(build, title)
    return build(dynamic_id if clipped == ELLIPSIS else clipped)


def comment_href(base_url, dynamic_id, comment_id):
    """一级评论精确入口（与 02 交付的浏览器路由一致，不用楼中楼页代替）。"""
    return archive_href(base_url, "/dynamics/{}/comments/{}/locate".format(
        quote(str(dynamic_id), safe=""), quote(str(comment_id), safe="")))


def _clip(build, value, marker=ELLIPSIS):
    """按序列化后 UTF-8 长度裁剪单个展示值；其他字段与链接保持完整。"""
    if not value:
        return ""
    clipped = value
    while clipped and len(encoded(build(clipped + marker))) > PAYLOAD_LIMIT_BYTES:
        clipped = clipped[: len(clipped) * 3 // 4]
    # 即使整段被裁完也留下截断标记：调用方能看出“这里还有内容被略去”。
    return clipped + marker


def beijing_time(value):
    """发表时间统一按北京时间显示到秒；不用采集或投递时间替代。"""
    try:
        return datetime.fromisoformat(value).astimezone(BEIJING).strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return ""


def root_comment(snapshot, base_url):
    """新增评论模板：动态、评论人、北京时间、正文与可点击的该条评论链接。

    保留原始换行与“回复 @某人”等上下文；正文为空但有归档媒体时用纯图占位；
    超长时只裁正文并追加热链接提示，其他字段与完整链接不被截掉。用完即弃的
    局部变量都不回写归档原文。
    """
    dynamic_id = str(snapshot["dynamic_id"])
    title = safe_text(snapshot.get("title"), single_line=True) or dynamic_id
    author = snapshot.get("author") if isinstance(snapshot.get("author"), dict) else {}
    nickname = (safe_text(author.get("nickname"), single_line=True)
                or safe_text(author.get("id"), single_line=True))
    published = beijing_time(snapshot.get("published_at"))
    href = comment_href(base_url, dynamic_id, snapshot["comment_id"])
    body = safe_text(snapshot.get("text")) or (IMAGE_COMMENT if snapshot.get("has_media") else "")

    def build(content, title_value, nickname_value):
        lines = content.split("\n")
        paragraphs = [[text(f"动态：{title_value}")],
                      [text(f"评论人：【{nickname_value}】")],
                      [text(f"时间：{published}")],
                      [text("内容：" + lines[0])]]
        paragraphs += [[text(line)] for line in lines[1:]]
        paragraphs.append([text("链接："), link("查看该条评论", href)])
        return post(*paragraphs)

    if len(encoded(build(body, title, nickname))) <= PAYLOAD_LIMIT_BYTES:
        return build(body, title, nickname)
    body = _clip(lambda value: build(value, title, nickname), body, LONG_CONTENT)
    if len(encoded(build(body, title, nickname))) > PAYLOAD_LIMIT_BYTES:
        nickname = _clip(lambda value: build(body, title, value), nickname)
    if len(encoded(build(body, title, nickname))) > PAYLOAD_LIMIT_BYTES:
        title = _clip(lambda value: build(body, value, nickname), title)
        title = dynamic_id if title == ELLIPSIS else title
    return build(body, title, nickname)


def heartbeat(snapshot):
    """心跳模板：只陈述本地已记录的事实，不把进程存活说成采集成功。"""
    label = safe_text(snapshot.get("label"), single_line=True)
    selected = int(snapshot.get("selected") or 0)
    checked = int(snapshot.get("checked") or 0)
    failed = int(snapshot.get("failed") or 0)
    pending = int(snapshot.get("pending") or 0)
    last_checked = safe_text(snapshot.get("last_checked_at"), single_line=True) or "无记录"
    if selected:
        observed = f"采集观察：纳管 {selected} 个目标，已检查 {checked} 个，最近检查 {last_checked}"
    else:
        observed = f"采集观察：暂无纳管目标，最近检查 {last_checked}"
    return post(
        [text(f"心跳【{label}】通知进程存活")],
        [text(observed)],
        [text(f"最近一次检查：失败 {failed} 个，正文待同步 {pending} 个")],
        [text("仅报告本地已记录状态，进程存活不等于采集成功")],
    )


@dataclass(frozen=True)
class DeliveryOutcome:
    sent: bool
    error: str | None = None
    retry_after: float | None = None


def retry_after(headers):
    value = headers.get(RETRY_AFTER_HEADER) if headers is not None else None
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    if seconds <= 0:
        return None
    return min(seconds, RETRY_AFTER_LIMIT_SECONDS)


def outcome(status_code, headers=None, body=b""):
    """飞书业务结果：HTTP 状态与响应体业务码都要核验。"""
    if status_code == 429:
        return DeliveryOutcome(False, "rate_limited", retry_after(headers) or RATE_LIMIT_FALLBACK_SECONDS)
    if status_code != 200:
        return DeliveryOutcome(False, "http_error")
    try:
        value = json.loads(body)
    except (TypeError, ValueError):
        return DeliveryOutcome(False, "invalid_response")
    if not isinstance(value, dict):
        return DeliveryOutcome(False, "invalid_response")
    code = value.get("code")
    if type(code) is int and code == 0:
        return DeliveryOutcome(True)
    if code is None and type(value.get("StatusCode")) is int and value["StatusCode"] == 0:
        # 旧版 webhook 只回 StatusCode；仍以业务码为成功依据。
        return DeliveryOutcome(True)
    if type(code) is int and code in RATE_LIMIT_CODES:
        return DeliveryOutcome(False, "rate_limited", retry_after(headers) or RATE_LIMIT_FALLBACK_SECONDS)
    return DeliveryOutcome(False, "platform_rejected")


def transport_error(error):
    """网络层失败只保留固定分类，不回显 URL、响应正文或异常原文。"""
    if isinstance(error, httpx.TimeoutException):
        return DeliveryOutcome(False, "timeout")
    if isinstance(error, httpx.RequestError):
        return DeliveryOutcome(False, "network_error")
    return DeliveryOutcome(False, "internal_error")
