"""评论分项的公开状态：旧档案未知时间不补造，错误只用固定码。"""

from datetime import datetime, timezone


# 根评论采集格式版本：v1 置顶，v2 Requests 会话和定位策略，v3 缺 pictures 键确认无图。
# 旧归档只补采一次。
ROOT_METADATA_VERSION = 3


COMMENT_STATUS_FIELDS = (
    "root_comments_last_succeeded_at", "replies_last_succeeded_at", "comments_last_succeeded_at",
    "root_comments_error", "replies_error", "comments_error",
)


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def epoch_from_iso(value):
    """ISO 时间 → epoch 秒；带/不带时区与 `Z` 都接受。

    只做解析，不规定错误策略：解析失败就抛异常，怎么处理由调用方决定（告警登记
    宽松到不登记，采集节拍严格到按到期／报错），本函数不降级也不编造时刻。
    非字符串按原值交给 `fromisoformat`，抛 `TypeError`。
    """
    text = value.replace("Z", "+00:00") if isinstance(value, str) else value
    return datetime.fromisoformat(text).timestamp()


def comment_status(document):
    return {field: document.get(field) for field in COMMENT_STATUS_FIELDS}
