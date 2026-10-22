"""参考脚本式评论会话：每次尝试独立 Requests Session，网络在线程池运行。"""

import asyncio
from contextlib import asynccontextmanager
import random
from urllib.parse import urlsplit

import httpx
import requests
from anyio import to_thread

from .collector_logging import collector_event, collector_failure
from .identifiers import is_valid_id
from .source_client import comment_request_headers
from .source_cookies import load_source_cookie_pairs
from .source_transport import SourcePacer


_COMMENT_HOSTS = frozenset({"api.bilibili.com", "www.bilibili.com", "space.bilibili.com"})
# requests 已按 Content-Encoding 解压；这些头描述的是线上字节，不能带到解压后的协议层。
_TRANSPORT_HEADERS = frozenset({"content-encoding", "content-length", "transfer-encoding"})


class _SourceSession(requests.Session):
    def send(self, request, **kwargs):
        # Requests 会在重定向时再次经过 send；不能把 Cookie 发给任意域或明文 HTTP。
        try:
            url = urlsplit(request.url)
            allowed = (request.method == "GET" and url.scheme == "https"
                       and url.hostname in _COMMENT_HOSTS and url.port in (None, 443)
                       and not url.username and not url.password)
        except ValueError:
            allowed = False
        if not allowed:
            request.headers.pop("Cookie", None)
            raise requests.RequestException("Unsupported comment source request")
        return super().send(request, **kwargs)


class RequestsCommentClient:
    def __init__(self, uid, cookie_pairs, pacer):
        if not is_valid_id(uid):
            raise ValueError("Invalid comment source author")
        self.uid = uid
        self.pacer = pacer
        self.lock = asyncio.Lock()
        self.session = _SourceSession()
        # 与参考 Session 默认一致：验证 TLS，使用环境代理，跟随受信来源内的跳转。
        self.session.trust_env = True
        self.session.headers.update(comment_request_headers(uid))
        for name, value in cookie_pairs:
            self.session.cookies.set(name, value, domain=".bilibili.com", path="/")

    def _get(self, url, params, headers, timeout):
        request = httpx.Request("GET", url, params=params)
        try:
            response = self.session.get(url, params=params, headers=headers, timeout=timeout)
            try:
                # 保留唯一一套 JSON/协议解析和 HTTP 状态错误分类，不拷贝脚本业务层。
                # requests 已经把 body 解码成明文，透传 Content-Encoding 会让 HTTPX 再解一次并失败。
                headers_sent = {name: value for name, value in response.headers.items()
                                if name.lower() not in _TRANSPORT_HEADERS}
                return httpx.Response(response.status_code, headers=headers_sent,
                                      content=response.content, request=httpx.Request("GET", response.url))
            finally:
                response.close()
        except requests.Timeout:
            raise httpx.TimeoutException("Comment source request timed out", request=request) from None
        except requests.RequestException:
            raise httpx.RequestError("Comment source request failed", request=request) from None

    async def get(self, url, *, params=None, headers=None, timeout=15):
        async with self.lock:
            await self.pacer.wait(url)
            return await to_thread.run_sync(self._get, url, params, headers, timeout)

    async def prepare(self):
        # 与 create_session 相同：每个 URL 独立 best-effort，返回后等 1–3 秒。
        for stage, url in (
            ("homepage", "https://www.bilibili.com/"),
            ("space", f"https://space.bilibili.com/{self.uid}/dynamic"),
        ):
            try:
                response = await self.get(url, timeout=10)
                collector_event("comment_session_warmup", stage=stage,
                                http_success=response.is_success, http_status=response.status_code)
                await asyncio.sleep(random.uniform(1, 3))
            except Exception as error:
                collector_failure("comment_session_warmup_failed", error, stage=stage)

    async def aclose(self):
        await to_thread.run_sync(self.session.close)


class RequestsCommentClientFactory:
    def __init__(self, *, cookie_pairs=None, pacer=None):
        self.cookie_pairs = load_source_cookie_pairs() if cookie_pairs is None else cookie_pairs
        self.pacer = pacer if pacer is not None else SourcePacer()

    @asynccontextmanager
    async def __call__(self, uid):
        client = RequestsCommentClient(uid, self.cookie_pairs, self.pacer)
        collector_event("comment_session_started", engine="requests")
        try:
            await client.prepare()
            yield client
        finally:
            await client.aclose()
            collector_event("comment_session_closed")


@asynccontextmanager
async def open_comment_client(source_client, uid, factory=None):
    """生产注入 Requests 工厂；显式传输替身继续走原 HTTPX I/O seam，不出真网。"""
    if factory is None:
        yield source_client
    else:
        async with factory(uid) as client:
            yield client
