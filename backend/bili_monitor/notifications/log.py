"""通知进程日志：固定事件名与安全值，不输出 webhook、响应正文或消息快照。"""

import logging
import re

_LOGGER = logging.getLogger("bili_monitor.notifier")
_HANDLER = None
_SAFE = re.compile(r"[a-z][a-z0-9_]{0,63}")


def configure_notifier_logging():
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
    if isinstance(value, str) and _SAFE.fullmatch(value):
        return value
    return "unknown"


def notifier_event(event, *, warning=False, **fields):
    configure_notifier_logging()
    values = " ".join(f"{key}={_safe_value(value)}" for key, value in fields.items())
    _LOGGER.log(logging.WARNING if warning else logging.INFO, "%s %s", event, values)
