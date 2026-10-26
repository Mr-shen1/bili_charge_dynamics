"""通知配置：服务端持有路由与凭据，队列只保存路由引用。

配置文件形状（JSON）：

    {"base_url": "https://archive.example",
     "ups": {"<uid>": {"up": "up-room", "all": "all-room"}},
     "dynamics": {"<dynamic-id>": {"up": "up-room-123"}},
     "system": "system-room",
     "destinations": {"up-room": {"webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/<token>"}}}

动态覆盖优先于所属 UP 的默认角色；两者都缺失时该目标进入等待配置，
不会转投其他角色。系统群单独配置（顶层 `system`），告警与心跳只发这一个角色。
`repr`、日志和发件箱都不复制 webhook 或签名密钥。

单条目写错（webhook 不是 http 地址、`secret` 不是非空字符串、条目不是对象）只把
该目的地标成不可用：对应目标进入等待配置（`route_invalid`），其他群照常投递。
整份文件不可解析、`base_url` 或路由表结构非法仍按配置错误处理——此时通知进程
不启动，也没有告警通道（属票据 08/10 的边界）。
"""

import json
from dataclasses import dataclass
from urllib.parse import urlsplit

from .outbox import SYSTEM_ROLE

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
    """目的地地址不可用时返回 None（单条目错误），由目标自己等待配置。"""
    if not isinstance(value, str) or not value.strip():
        return None
    parsed = urlsplit(value.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username is not None:
        return None
    return value.strip()


def _secret(value):
    """可选的签名密钥：只在外发时组装签名，不进入队列、日志或消息快照。

    非空字符串以外的东西算写错，由调用方把该目的地标成不可用。
    """
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()


def _destination(entry):
    """单个目的地条目：地址或密钥写错都只标成不可用，不影响其他目的地。"""
    if not isinstance(entry, dict):
        return {"webhook": None, "secret": None}
    webhook = _webhook(entry.get("webhook"))
    secret = None
    if entry.get("secret") is not None:
        secret = _secret(entry.get("secret"))
        if secret is None:
            webhook = None
    return {"webhook": webhook, "secret": secret}


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


def _reference(value):
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise NotificationConfigError("Invalid notification system role")
    return value.strip()


def _destinations(value):
    if not isinstance(value, dict):
        raise NotificationConfigError("Invalid notification destinations")
    destinations = {}
    for reference, entry in value.items():
        if not isinstance(reference, str) or not reference:
            raise NotificationConfigError("Invalid notification destinations")
        destinations[reference] = _destination(entry)
    return destinations


@dataclass(frozen=True, repr=False)
class Route:
    """一次解析出来的目标路由：错误码（`None` 表示可投递）、地址与可选签名密钥。

    地址与密钥只在组装外发载荷时取出；`repr` 不复制凭据，队列、日志与异常都
    不应持有本对象。
    """

    error: str | None
    webhook: str | None = None
    secret: str | None = None

    def __repr__(self):
        return f"Route(error={self.error!r}, webhook=<hidden>, secret=<hidden>)"


@dataclass(frozen=True, repr=False)
class NotificationConfig:
    base_url: str
    ups: dict
    dynamics: dict
    destinations: dict
    system: str | None = None

    def __repr__(self):
        return (f"NotificationConfig(base_url={self.base_url!r}, ups={sorted(self.ups)!r}, "
                f"dynamics={sorted(self.dynamics)!r}, system={self.system!r}, "
                f"destinations=<{len(self.destinations)} hidden>)")

    @classmethod
    def from_mapping(cls, value):
        if not isinstance(value, dict):
            raise NotificationConfigError("Invalid notification config")
        destinations = value.get("destinations")
        return cls(
            _base_url(value.get("base_url")),
            _section(value.get("ups"), "ups"),
            _section(value.get("dynamics"), "dynamics"),
            _destinations({} if destinations is None else destinations),
            _reference(value.get("system")),
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
        """系统群单独配置；业务角色动态覆盖优先，其次所属 UP 默认值。不跨角色借用。"""
        if role == SYSTEM_ROLE:
            return self.system
        return (self.dynamics.get(str(dynamic_id), {}).get(role)
                or self.ups.get(str(uid), {}).get(role))

    def resolve(self, uid, dynamic_id, role):
        """解析该目标的唯一一次路由：缺引用、目的地不可用或可投递（含地址与密钥）。

        投递、告警与重试判定共用这一处解析：路由规则（系统群单配、动态覆盖优先、
        不跨角色补位）只有一份，不在四个查询里各写一遍。
        """
        reference = self.reference(uid, dynamic_id, role)
        if reference is None:
            return Route("route_missing")
        destination = self.destinations.get(reference)
        if destination is None or destination.get("webhook") is None:
            return Route("route_invalid")
        return Route(None, destination["webhook"], destination.get("secret"))

    def route_error(self, uid, dynamic_id, role):
        """该目标为什么不能投递：缺路由（`route_missing`）或目的地不可用（`route_invalid`）。

        不跨角色补位：角色自身缺失只让这一目标等待配置，其他目标不受影响。
        """
        return self.resolve(uid, dynamic_id, role).error

    def webhook(self, uid, dynamic_id, role):
        return self.resolve(uid, dynamic_id, role).webhook

    def secret(self, uid, dynamic_id, role):
        """签名密钥只在发送时读取，绝不写入发件箱或消息快照。"""
        return self.resolve(uid, dynamic_id, role).secret
