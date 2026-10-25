"""通知模块：配置、消息载荷、事务发件箱与独立投递。

调用者（采集/归档写事务）只通过 `outbox` 登记持久事实，不直接请求飞书；
飞书 I/O、领取、退避与结果回写由独立进程内的 `Dispatcher` 完成。
"""

from . import outbox
from .config import NotificationConfig, NotificationConfigError
from .delivery import Dispatcher

__all__ = ["Dispatcher", "NotificationConfig", "NotificationConfigError", "outbox"]
