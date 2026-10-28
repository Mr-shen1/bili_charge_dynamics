"""参考脚本式评论会话：按 UP 复用session，预热按 TTL 缓存，网络在线程池运行。"""

import asyncio
from contextlib import asynccontextmanager
import hashlib
import random
import time
from urllib.parse import urlsplit

import httpx
import requests
from anyio import to_thread

from .collector_logging import collector_event, collector_failure
from .identifiers import is_valid_id
from .source_client import comment_request_headers
from .source_cookies import load_source_cookie_pairs
from .reply_pacing import ReplyPagePacer
from .risk import SourceRiskPaused
from .source_gate import OpenSourceGate, SOURCE_HOSTS, SourceReport, ThreadSourceGate, source_request
from .source_transport import SourcePacer


# 会话与预热都按 UP 复用：固定节拍下每次尝试都重开会话会把连接和预热请求放大数倍。
SESSION_TTL_SECONDS = 30 * 60
WARMUP_TTL_SECONDS = 5 * 60
WARMUP_RETRY_SECONDS = 60


def cookie_fingerprint(cookie_pairs):
    """只用于判断 Cookie 是否换过，不可逆、不进日志。"""
    digest = hashlib.sha256()
    for name, value in cookie_pairs:
        digest.update(f"{name}={value};".encode())
    return digest.hexdigest()
# requests 已按 Content-Encoding 解压；这些头描述的是线上字节，不能带到解压后的协议层。
_TRANSPORT_HEADERS = frozenset({"content-encoding", "content-length", "transfer-encoding"})


class _SourceSession(requests.Session):
    """Requests 的逐跳安装点：重定向的后续发送也先取许可、返回后报告。

    `hop` 由 `RequestsCommentClient.get` 在协程侧设置，因为会话的同步发送在线程池
    里执行；缺失桥接说明有代码绕过 `get` 直接发送，宁可失败也不静默绕过许可。
    """

    def __init__(self):
        super().__init__()
        self.hop = None

    def send(self, request, **kwargs):
        # Requests 会在重定向时再次经过 send；不能把 Cookie 发给任意域或明文 HTTP。
        try:
            url = urlsplit(request.url)
            allowed = (request.method == "GET" and url.scheme == "https"
                       and url.hostname in SOURCE_HOSTS and url.port in (None, 443)
                       and not url.username and not url.password)
        except ValueError:
            allowed = False
        if not allowed:
            request.headers.pop("Cookie", None)
            raise requests.RequestException("Unsupported comment source request")
        source = source_request(request.method, request.url)
        if source is None or self.hop is None:
            raise RuntimeError("Comment source gate is not attached")
        self.hop.permit(source)
        try:
            response = super().send(request, **kwargs)
        except Exception as error:
            self.hop.report(source, SourceReport(error=error))
            raise
        if not response.history:
            # 跟随跳转时，最终响应已由它自己那一跳报告；外层不重复计数同一次发送。
            try:
                self.hop.report(source, SourceReport(status_code=response.status_code))
            except BaseException:
                # 报告拒绝这次发送时先释放响应，再让保护异常中止调用链。
                response.close()
                raise
        return response


class RequestsCommentClient:
    def __init__(self, uid, cookie_pairs, pacer, gate=None, reply_page_pacer=None):
        if not is_valid_id(uid):
            raise ValueError("Invalid comment source author")
        self.uid = uid
        self.pacer = pacer
        self.lock = asyncio.Lock()
        self.gate = gate if gate is not None else OpenSourceGate()
        # 楼中楼页后等待与发送在同一个串行段内；是否进入等待按接口类型分类，不按调用点。
        self.reply_page_pacer = reply_page_pacer if reply_page_pacer is not None else ReplyPagePacer()
        self.last_reply_page = None
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
            source = source_request("GET", url)
            if source is None or source.endpoint_type != "replies":
                return await self._send(url, params, headers, timeout)
            # 楼中楼：发送与页后等待同一个串行段，失败的请求也等待；首个请求前不等待。
            timing = None
            try:
                async with self.reply_page_pacer.page() as timing:
                    return await self._send(url, params, headers, timeout)
            finally:
                self.last_reply_page = timing

    async def _send(self, url, params, headers, timeout):
        # 每一跳都在线程内重新取许可；桥接持有本次调用所在事件循环。
        self.session.hop = ThreadSourceGate(self.gate, asyncio.get_running_loop())
        try:
            return await to_thread.run_sync(self._get, url, params, headers, timeout)
        finally:
            self.session.hop = None

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
            except SourceRiskPaused:
                # 预热仍是 best-effort，但触发后不再做第二次预热；报告已在传输层完成。
                collector_event("comment_session_warmup_paused", stage=stage)
                return
            except Exception as error:
                collector_failure("comment_session_warmup_failed", error, stage=stage)

    async def aclose(self):
        await to_thread.run_sync(self.session.close)


class WarmupCache:
    """按 (UP, Cookie 指纹) 缓存预热结果：有效期内不访问首页/空间页，过期后后台刷新。"""

    def __init__(self, *, ttl=WARMUP_TTL_SECONDS, retry=WARMUP_RETRY_SECONDS, clock=time.monotonic):
        self.ttl, self.retry, self.clock = ttl, retry, clock
        self._warmed = {}
        self._attempted = {}
        self._tasks = {}

    def fresh(self, key):
        warmed = self._warmed.get(key)
        return warmed is not None and self.clock() - warmed < self.ttl

    def cooling(self, key):
        attempted = self._attempted.get(key)
        return attempted is not None and self.clock() - attempted < self.retry

    async def ensure(self, key, prepare):
        """首次使用同步预热；过期且不在冷却期时后台刷新；其余立即返回。"""
        if self.fresh(key):
            return
        if self._attempted.get(key) is None:
            # 首次没有任何预热记录：先完成再发业务请求，保持与既有初始化顺序一致。
            await self._run(key, prepare)
            return
        if self.cooling(key) or key in self._tasks:
            return
        self._tasks[key] = asyncio.create_task(self._run(key, prepare))

    async def _run(self, key, prepare):
        self._attempted[key] = self.clock()
        try:
            await prepare()
            self._warmed[key] = self.clock()
            collector_event("comment_session_warmup_cached", ttl_seconds=self.ttl)
        except asyncio.CancelledError:
            raise
        except SourceRiskPaused:
            # 不把暂停记成预热失败，也不写「已预热」：冷却窗口到期后仍会重试。
            collector_event("comment_session_warmup_paused", stage="cached")
        except Exception as error:
            # 预热本来就是 best-effort；冷却窗口限制重试频率，不打断业务请求。
            collector_failure("comment_session_warmup_failed", error, stage="cached")
        finally:
            self._tasks.pop(key, None)

    async def aclose(self):
        tasks = [task for task in self._tasks.values() if not task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()


class RequestsCommentClientFactory:
    """按 UP 复用会话：Cookie 变化或超过 session TTL 才重建，预热由 WarmupCache 控制。"""

    def __init__(self, *, cookie_pairs=None, pacer=None, client_factory=None,
                 session_ttl=SESSION_TTL_SECONDS, warmup=None, clock=time.monotonic, gate=None,
                 reply_page_pacer=None):
        self.cookie_pairs = load_source_cookie_pairs() if cookie_pairs is None else cookie_pairs
        self.pacer = pacer if pacer is not None else SourcePacer()
        self.gate = gate if gate is not None else OpenSourceGate()
        # 一个进程内一次装配只用一个协调器：不同 UP 的楼中楼页也不能交错绕过等待。
        self.reply_page_pacer = (reply_page_pacer if reply_page_pacer is not None
                                 else ReplyPagePacer())
        self._new_client = client_factory or (
            lambda uid, pairs, pacer: RequestsCommentClient(
                uid, pairs, pacer, gate=self.gate, reply_page_pacer=self.reply_page_pacer))
        self.session_ttl = session_ttl
        self.warmup = warmup if warmup is not None else WarmupCache(clock=clock)
        self.clock = clock
        self._entries = {}
        self._lock = asyncio.Lock()

    def _fingerprint(self):
        return cookie_fingerprint(self.cookie_pairs)

    async def _entry(self, uid):
        fingerprint = self._fingerprint()
        async with self._lock:
            entry = self._entries.get(uid)
            expired = entry is not None and (
                entry["fingerprint"] != fingerprint
                or self.clock() - entry["created"] >= self.session_ttl)
            if entry is None or expired:
                if entry is not None:
                    await self._close(entry["client"])
                client = self._new_client(uid, self.cookie_pairs, self.pacer)
                entry = {"client": client, "created": self.clock(), "fingerprint": fingerprint}
                self._entries[uid] = entry
                collector_event("comment_session_started", engine="requests")
            return entry

    @asynccontextmanager
    async def __call__(self, uid):
        entry = await self._entry(uid)
        # 预热结果按 (UP, Cookie) 缓存：命中时本轮零预热请求，过期时才后台刷新。
        await self.warmup.ensure((uid, entry["fingerprint"]), entry["client"].prepare)
        yield entry["client"]

    async def aclose(self):
        await self.warmup.aclose()
        async with self._lock:
            entries = list(self._entries.values())
            self._entries.clear()
        for entry in entries:
            await self._close(entry["client"])

    async def _close(self, client):
        try:
            await client.aclose()
        except Exception as error:
            collector_failure("comment_session_close_failed", error)
        collector_event("comment_session_closed")


@asynccontextmanager
async def open_comment_client(source_client, uid, factory=None):
    """生产注入 Requests 工厂；显式传输替身继续走原 HTTPX I/O seam，不出真网。"""
    if factory is None:
        yield source_client
    else:
        async with factory(uid) as client:
            yield client
