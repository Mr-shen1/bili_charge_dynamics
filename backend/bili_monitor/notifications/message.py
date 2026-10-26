"""飞书消息载荷与业务响应判定。

协议依据（官方自定义机器人文档，2025-03 版本）：
- `POST` webhook，请求体为 JSON，`msg_type=post` 时 `content.post.zh_cn.content`
  是段落数组，段落内的 `{"tag": "a", "text": ..., "href": ...}` 是真实可点击链接，
  `zh_cn.title` 可选。
- 业务成功响应形如 `{"code": 0, "msg": "success", "StatusCode": 0}`；
  仅 HTTP 200 不能判定成功（`{"code": 9499}` 仍是失败）。
- 自定义机器人请求体不超过 20 KB；单租户单机器人 100 次/分钟、5 次/秒，
  超限可能返回 HTTP 429 或 `11232` 等限流业务码。
- 可选签名校验：`timestamp`（秒）与密钥拼成 `"{timestamp}\n{secret}"` 作为 HMAC
  key，对空字符串做 HmacSHA256 后 Base64；`timestamp`/`sign` 加在请求体外层。
  时间戳需距发送时不超过 1 小时，校验失败返回 `19021`。

本模块只负责快照 → 载荷、签名组装、序列化大小与响应分类，不打开连接、不读写数据库。
"""

import base64
import hashlib
import hmac
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


def signature(secret, timestamp):
    """官方签名：`base64(HMAC-SHA256(key="{timestamp}\n{secret}", msg=""))`。"""
    key = f"{int(timestamp)}\n{secret}".encode("utf-8")
    return base64.b64encode(hmac.new(key, b"", digestmod=hashlib.sha256).digest()).decode("ascii")


def signed(payload, secret, timestamp):
    """只在外发组装时签名：签名与密钥不进消息快照、队列或日志。"""
    return {**payload, "timestamp": str(int(timestamp)), "sign": signature(secret, timestamp)}


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


def dynamic_restricted(snapshot, base_url):
    """受限提示模板：来源把动态标记为受限时也要说清楚，而不是静默不发。"""
    dynamic_id = str(snapshot["dynamic_id"])
    title = safe_text(snapshot.get("title"), single_line=True) or dynamic_id
    href = dynamic_href(base_url, dynamic_id)

    def build(candidate):
        return post(
            [text(f"动态【{candidate}】暂时受限，读不到正文")],
            [text("原因：来源把该动态标记为受限（充电专属、仅粉丝可见或已下架等），"
                  "本站这段时间拿不到正文与图片。")],
            [text("链接："), link("查看动态", href)],
        )

    payload = build(title)
    if len(encoded(payload)) <= PAYLOAD_LIMIT_BYTES:
        return payload
    clipped = _clip(build, title)
    return build(dynamic_id if clipped == ELLIPSIS else clipped)


def comment_href(base_url, dynamic_id, comment_id):
    """一级评论精确入口（与 02 交付的浏览器路由一致，不用楼中楼页代替）。"""
    return archive_href(base_url, "/dynamics/{}/comments/{}/locate".format(
        quote(str(dynamic_id), safe=""), quote(str(comment_id), safe="")))


def reply_href(base_url, dynamic_id, root_id, reply_id):
    """楼中楼回复精确入口（与 03 交付的浏览器路由一致，携带所属根与目标回复）。"""
    return archive_href(base_url, "/dynamics/{}/comments/{}/replies/{}/locate".format(
        quote(str(dynamic_id), safe=""), quote(str(root_id), safe=""),
        quote(str(reply_id), safe="")))


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


# 告警只用固定枚举：类别、原因都是白名单，对象只接受不含空白的稳定身份。
# 这里没有任何自由文本入口，上游响应正文、异常原文与凭据都不会进入消息。
ALERT_LABELS = {
    "credential": "来源凭据失效",
    "collection": "采集异常",
    "loop": "主循环异常",
    "delivery": "飞书投递持续失败",
    "route": "路由缺失或错误",
}
ALERT_REASONS = {
    "credential_rejected": "来源凭据被拒绝",
    "login_required": "来源要求登录且未配置凭据",
    "timeout": "请求超时",
    "network_error": "网络错误",
    "http_status": "HTTP 状态异常",
    "decode_invalid": "来源响应无法解码",
    "json_invalid": "来源响应不是合法 JSON",
    "storage_error": "本地数据库读写失败",
    "source_rejected": "来源拒绝请求",
    "source_unavailable": "来源不可用",
    "signal_invalid": "来源信号无效",
    "pagination_invalid": "来源分页无效",
    "body_failed": "正文读取失败",
    "comments_failed": "评论分页失败",
    "route_missing": "目标群未配置",
    "route_invalid": "目标群配置无效",
    "internal_error": "内部异常",
    "unsupported_kind": "事件类型缺少模板",
    "platform_rejected": "飞书拒绝消息",
    "rate_limited": "飞书限流",
}
_ALERT_TOKEN = re.compile(r"[a-z][a-z0-9_]{0,63}")
_ALERT_OBJECT = re.compile(r"[A-Za-z0-9_:.\-]{1,80}")


def alert_object(value):
    return value if isinstance(value, str) and _ALERT_OBJECT.fullmatch(value) else "unknown"


def alert_reason(value):
    """固定脱敏原因：优先中文短语，其次仍受限的固定 token，其余一律未分类。"""
    if not isinstance(value, str):
        return "未分类"
    if value in ALERT_REASONS:
        return ALERT_REASONS[value]
    return value if _ALERT_TOKEN.fullmatch(value) else "未分类"


def alert_time(value):
    """发生时间按北京时间到秒；不用投递时间替代，解析不了就如实留未知。"""
    if type(value) not in (int, float):
        return "未知"
    try:
        return datetime.fromtimestamp(value, BEIJING).strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, OSError, OverflowError):
        return "未知"


def alert(snapshot):
    """告警模板：类别、对象、发生时间与固定脱敏原因。

    不带链接与业务内容：系统群不混入评论正文，也不因缺本站基址而无法提醒。
    """
    label = ALERT_LABELS.get(snapshot.get("category"), "运行故障")
    return post(
        [text(f"告警【{label}】")],
        [text(f"对象：{alert_object(snapshot.get('object'))}")],
        [text(f"发生时间：{alert_time(snapshot.get('occurred_at'))}")],
        [text(f"原因：{alert_reason(snapshot.get('reason'))}")],
        [text("同类同对象 30 分钟内最多提醒一次")],
    )


def root_comment(snapshot, base_url):
    """新增评论模板：动态、评论人、北京时间、正文与可点击的该条评论链接。

    保留原始换行与“回复 @某人”等上下文；正文为空但有归档媒体时用纯图占位；
    超长时只裁正文并追加热链接提示，其他字段与完整链接不被截掉。用完即弃的
    局部变量都不回写归档原文。
    """
    return _new_comment(snapshot, comment_href(
        base_url, str(snapshot["dynamic_id"]), snapshot["comment_id"]))


def reply_comment(snapshot, base_url):
    """楼中楼回复：与一级评论共用模板，只把链接换成该条回复的精确入口。

    正文保留来源的“回复 @某人”前缀与换行，不附加父评论全文；不采集也不上传回复
    图片，只按来源已知的图片存在性给纯图占位（与一级评论同一规则）。
    """
    return _new_comment(snapshot, reply_href(
        base_url, str(snapshot["dynamic_id"]), snapshot["root_id"], snapshot["comment_id"]))


def _new_comment(snapshot, href):
    """新增评论（一级评论与楼中楼共用同一模板，一条评论一条消息）。"""
    dynamic_id = str(snapshot["dynamic_id"])
    title = safe_text(snapshot.get("title"), single_line=True) or dynamic_id
    author = snapshot.get("author") if isinstance(snapshot.get("author"), dict) else {}
    nickname = (safe_text(author.get("nickname"), single_line=True)
                or safe_text(author.get("id"), single_line=True))
    published = beijing_time(snapshot.get("published_at"))
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
