"""禁止依赖的传输/access 调试日志泄漏请求 URL、头和异常原文。"""

import logging


class DropTransportLog(logging.Filter):
    def filter(self, record):
        return False


_FILTER = DropTransportLog()


def configure_safe_logging():
    # logging 父 logger 的 filter 不作用于子 logger，因此挂到具体日志源。
    names = {
        "httpx",
        "oss2",
        "oss2.api",
        "oss2.auth",
        "oss2.http",
        "urllib3.connectionpool",
        "requests",
        "uvicorn.access",
        "httpcore.connection",
        "httpcore.connection_pool",
        "httpcore.http11",
        "httpcore.http2",
        "httpcore.proxy",
        "httpcore.socks",
    }
    names.update(
        name
        for name in logging.Logger.manager.loggerDict
        if name.startswith(("httpcore.", "oss2.", "urllib3.", "requests."))
    )
    for name in names:
        logger = logging.getLogger(name)
        if _FILTER not in logger.filters:
            logger.addFilter(_FILTER)
