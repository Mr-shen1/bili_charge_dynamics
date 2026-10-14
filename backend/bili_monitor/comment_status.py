"""评论分项的公开状态：旧档案未知时间不补造，错误只用固定码。"""

from datetime import datetime, timezone


COMMENT_STATUS_FIELDS = (
    "root_comments_last_succeeded_at", "replies_last_succeeded_at", "comments_last_succeeded_at",
    "root_comments_error", "replies_error", "comments_error",
)


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def comment_status(document):
    return {field: document.get(field) for field in COMMENT_STATUS_FIELDS}
