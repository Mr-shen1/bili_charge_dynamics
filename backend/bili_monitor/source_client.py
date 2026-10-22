"""来源普通请求配置；评论由独立 Requests 会话执行，不将 nav 当作预热。"""

from .identifiers import is_valid_id
from .source_cookies import source_cookie_event_hooks


SOURCE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Origin": "https://space.bilibili.com",
}
_SOURCE_ACCEPT = {
    "api.bilibili.com": "application/json, text/plain, */*",
    "www.bilibili.com": "text/html, application/xhtml+xml;q=0.9, */*;q=0.8",
}


async def _prepare_source_request(request):
    if (
        request.method == "GET"
        and request.url.scheme == "https"
        and request.url.port in (None, 443)
        and not request.url.username
        and not request.url.password
    ):
        accept = _SOURCE_ACCEPT.get(request.url.host)
        if accept is not None:
            request.headers["Accept"] = accept


def source_client_event_hooks(*, cookie_pairs=None):
    """正文/detail/feed 的 HTTPX 会话；凭据发送范围与媒体保持隔离。"""
    hooks = source_cookie_event_hooks(cookie_pairs=cookie_pairs)
    hooks.setdefault("request", []).insert(0, _prepare_source_request)
    return hooks


def comment_request_headers(uid=None):
    """参考脚本普通头；每个采集尝试的 Referer 取当前 UP。"""
    headers = {**SOURCE_HEADERS, "Accept": _SOURCE_ACCEPT["api.bilibili.com"]}
    if is_valid_id(uid):
        headers["Referer"] = f"https://space.bilibili.com/{uid}/dynamic"
    return headers
