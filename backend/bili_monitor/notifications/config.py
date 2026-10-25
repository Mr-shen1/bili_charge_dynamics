"""通知配置：服务端持有路由与凭据，队列只保存路由引用。

配置文件形状（JSON）：

    {"base_url": "https://archive.example",
     "ups": {"<uid>": {"up": "up-room", "all": "all-room"}},
     "dynamics": {"<dynamic-id>": {"up": "up-room-123"}},
     "destinations": {"up-room": {"webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/<token>"}}}

动态覆盖优先于所属 UP 的默认角色；两者都缺失时该目标进入等待配置，
不会转投其他角色。`repr`、日志和发件箱都不复制 webhook。
"""

import json
from dataclasses import dataclass
from urllib.parse import urlsplit

ENVIRONMENT_PATH = "BILI_NOTIFICATION_CONFIG"


class NotificationConfigError(ValueError):
    """固定错误，不回显配置内容或凭据。"""


def _base_url(value):
    if not isinstance(value, str) or not value.strip():
        raise NotificationConfigError("Invalid notification base url")
    parsed = urlsplit(value.strip())
    if (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment):
        raise NotificationConfigError("Invalid notification base url")
    return value.strip().rstrip("/")


def _webhook(value):
    if not isinstance(value, str) or not value.strip():
        raise NotificationConfigError("Invalid notification destination")
    parsed = urlsplit(value.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username is not None:
        raise NotificationConfigError("Invalid notification destination")
    return value.strip()


def _section(value, name):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise NotificationConfigError(f"Invalid notification {name}")
    section = {}
    for key, roles in value.items():
        if not isinstance(key, str) or not key or not isinstance(roles, dict):
            raise NotificationConfigError(f"Invalid notification {name}")
        section[key] = {}
        for role, reference in roles.items():
            if not isinstance(role, str) or not isinstance(reference, str) or not reference:
                raise NotificationConfigError(f"Invalid notification {name}")
            section[key][role] = reference
    return section


def _destinations(value):
    if not isinstance(value, dict):
        raise NotificationConfigError("Invalid notification destinations")
    destinations = {}
    for reference, entry in value.items():
        if not isinstance(reference, str) or not reference or not isinstance(entry, dict):
            raise NotificationConfigError("Invalid notification destinations")
        destinations[reference] = {"webhook": _webhook(entry.get("webhook"))}
    return destinations


@dataclass(frozen=True, repr=False)
class NotificationConfig:
    base_url: str
    ups: dict
    dynamics: dict
    destinations: dict

    def __repr__(self):
        return (f"NotificationConfig(base_url={self.base_url!r}, ups={sorted(self.ups)!r}, "
                f"dynamics={sorted(self.dynamics)!r}, destinations=<{len(self.destinations)} hidden>)")

    @classmethod
    def from_mapping(cls, value):
        if not isinstance(value, dict):
            raise NotificationConfigError("Invalid notification config")
        return cls(
            _base_url(value.get("base_url")),
            _section(value.get("ups"), "ups"),
            _section(value.get("dynamics"), "dynamics"),
            _destinations(value.get("destinations") or {}),
        )

    @classmethod
    def load(cls, path):
        try:
            with open(path, encoding="utf-8") as source:
                value = json.load(source)
        except (OSError, ValueError):
            raise NotificationConfigError("Notification config could not be loaded") from None
        return cls.from_mapping(value)

    def reference(self, uid, dynamic_id, role):
        """动态覆盖优先，其次所属 UP 默认值；不跨角色借用。"""
        return (self.dynamics.get(str(dynamic_id), {}).get(role)
                or self.ups.get(str(uid), {}).get(role))

    def destination(self, uid, dynamic_id, role):
        reference = self.reference(uid, dynamic_id, role)
        return self.destinations.get(reference) if reference is not None else None

    def webhook(self, uid, dynamic_id, role):
        destination = self.destination(uid, dynamic_id, role)
        return destination["webhook"] if destination is not None else None
