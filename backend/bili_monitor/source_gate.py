"""B 站源请求的统一发送许可与结果报告入口。

所有真实上游发送——API 的资料／作者校验／手动初始化／媒体重试与采集进程的检查、
发现、归档、预热和图片下载——都经过这里的同一 Interface：发送前取许可，返回或
失败后报告状态。调用方不各自实现熔断或等待。

本票只建立入口：`OpenSourceGate` 一律放行且不记录，原有网络行为、等待、Cookie、
主机白名单、重定向、代理、超时和解析保持原状。冷却、按接口探测与跨进程持久状态
由后续票接入同一 Interface；进程内对象不冒充跨进程保护。
"""

import asyncio
import re
from contextlib import nullcontext
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlsplit

import httpx

from .media import is_image_source_host
# 接口类型是 Gate、探测层、业务解析与日志共用的同一份常量（含图片域族与预热类型）。
from .source_endpoints import (
    COMMENT_COUNT, DETAIL, FEED, HOMEPAGE_WARMUP, OPUS_PAGE, OTHER_SOURCE,
    PROFILE, REPLIES, ROOT_COMMENTS, SPACE_WARMUP, image_endpoint_type, note_business_success,
)


# 来源主机白名单：与评论 Cookie 的发送范围一致；其他主机不受源站许可控制。
SOURCE_HOSTS = frozenset({"api.bilibili.com", "www.bilibili.com", "space.bilibili.com"})

# 接口类型按「主机 + 路径模板」归类：query 里的资源 ID 和页码不产生新类型，
# 后续按类型探测与日志才能覆盖不同拦截范围又不制造探测洪峰。
_API_ENDPOINTS = {
    "/x/v2/reply/count": COMMENT_COUNT,
    "/x/v2/reply/reply": REPLIES,
    "/x/v2/reply": ROOT_COMMENTS,
    "/x/polymer/web-dynamic/v1/feed/space": FEED,
    "/x/polymer/web-dynamic/v1/detail": DETAIL,
    "/x/web-interface/card": PROFILE,
}
_OPUS_PAGE_PATH = re.compile(r"/opus/[1-9][0-9]*")
_SPACE_DYNAMIC_PATH = re.compile(r"/[1-9][0-9]*/dynamic")


def endpoint_type(host, path):
    """按主机与路径模板给出接口类型；非 B 站来源返回 None（不受许可控制）。"""
    if is_image_source_host(host):
        return image_endpoint_type(host)
    if host not in SOURCE_HOSTS:
        return None
    if host == "api.bilibili.com":
        return _API_ENDPOINTS.get(path, OTHER_SOURCE)
    if host == "www.bilibili.com":
        if path == "/":
            return HOMEPAGE_WARMUP
        return OPUS_PAGE if _OPUS_PAGE_PATH.fullmatch(path) else OTHER_SOURCE
    return SPACE_WARMUP if _SPACE_DYNAMIC_PATH.fullmatch(path) else OTHER_SOURCE


@dataclass(frozen=True)
class SourceRequest:
    """一次真实发送的分类结果；不含 query，避免把凭据或完整 URL 带进日志。"""

    endpoint_type: str
    method: str
    host: str
    path: str


@dataclass(frozen=True)
class SourceReport:
    """一次发送的结果：HTTP 状态（含原始 Retry-After 头），或未能取得响应时的异常。"""

    status_code: int | None = None
    error: BaseException | None = None
    # 原样保留 Retry-After 头；合法解析与“取更晚期限”只在持久状态层做。
    retry_after: object = None


def source_request(method, url):
    """把实际发送的请求转成分类结果；非来源主机返回 None，调用方原样放行。"""
    parts = urlsplit(str(url))
    host = parts.hostname or ""
    kind = endpoint_type(host, parts.path)
    if kind is None:
        return None
    return SourceRequest(endpoint_type=kind, method=str(method).upper(), host=host, path=parts.path)


def _null_context():
    return nullcontext()


class SourceGate(Protocol):
    """发送许可与结果报告的接缝；实现必须逐次调用，不得缓存许可。"""

    async def permit(self, request: SourceRequest) -> None:
        """发送前调用；拒绝时抛异常，调用方不得再发出该请求。"""

    async def report(self, request: SourceRequest, report: SourceReport) -> None:
        """返回或失败后调用；先报告再交给原业务错误处理。

        实现可以在这里抛出保护异常来中止当前调用链（例如收到 HTTP 412／429）：调用方
        不会拿到该响应，因此不会继续翻页、重试或补做预热。
        """

    def note_business_success(self, endpoint_type: str) -> None:
        """业务层解析／资源校验成功后调用；传输状态本身不是业务成功。

        这是进程内的观察事实，不读写共享保护状态，因此同步且不参与许可判定：
        恢复观察期只认“确有成功业务请求的活跃采集”。
        """


class OpenSourceGate:
    """默认实现：一律放行且不记录，正常采集行为与本票之前一致。"""

    async def permit(self, request):
        return None

    async def report(self, request, report):
        return None

    def note_business_success(self, endpoint_type):
        return None


class GatedAsyncClient(httpx.AsyncClient):
    """携带 Gate 引用的来源客户端：业务解析成功后经同一 Gate 报告一次成功业务请求。

    只有业务会话用它；探测客户端刻意保持为普通 `httpx.AsyncClient`——探测不产生
    归档／通知副作用，也不能让观察期凭空累计。
    """

    def __init__(self, *args, gate=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.gate = gate

    def note_business_success(self, endpoint_type):
        note_business_success(self.gate, endpoint_type)


class GatedAsyncTransport(httpx.AsyncBaseTransport):
    """HTTPX 的最内层接入点：每次真实发送（正文／detail／feed／资料／图片）都过闸。

    位于 `PacedSourceTransport` 内层：外层的分页等待保持原样，许可核验紧贴发送。
    跟随重定向的客户端在每一跳都会再次调用 `handle_async_request`；当前来源 client
    不跟随重定向（`follow_redirects=False`），跳转仍须逐跳重新取许可。
    """

    def __init__(self, transport=None, *, gate=None, source_lease=None):
        self.transport = transport if transport is not None else httpx.AsyncHTTPTransport(trust_env=False)
        self.gate = gate if gate is not None else OpenSourceGate()
        # 08：跨进程发送许可包住「许可→发送→报告」；OSS 与本地处理不经过这里。
        self.source_lease = source_lease

    # 包装不改写被包装 transport 的启动／关闭语义：客户端进入本层时同样进入内层，
    # 内层启动失败照旧在 lifespan 处被替换为脱敏错误，而不是被包装层悄悄吞掉。
    async def __aenter__(self):
        await self.transport.__aenter__()
        return self

    async def __aexit__(self, exc_type=None, exc_value=None, traceback=None):
        await self.transport.__aexit__(exc_type, exc_value, traceback)

    async def handle_async_request(self, request):
        source = source_request(request.method, request.url)
        if source is None:
            return await self.transport.handle_async_request(request)
        lease = (self.source_lease.source_slot(source.endpoint_type)
                 if self.source_lease is not None else _null_context())
        async with lease:
            await self.gate.permit(source)
            try:
                response = await self.transport.handle_async_request(request)
            except Exception as error:
                await self.gate.report(source, SourceReport(error=error))
                raise
            try:
                await self.gate.report(source, SourceReport(
                    status_code=response.status_code, retry_after=response.headers.get("retry-after")))
            except BaseException:
                # 报告拒绝这次发送时先释放连接，再让保护异常中止调用链。
                await response.aclose()
                raise
            return response

    async def aclose(self):
        await self.transport.aclose()


class ThreadSourceGate:
    """把异步 Gate 桥接到线程内的同步逐跳发送（Requests 在线程池执行）。

    requests 的 `Session.send` 负责解析重定向，且每一跳都重新进入 `send`；因此每次
    `permit`／`report` 都单独提交，许可不会覆盖整条跳转链。
    """

    def __init__(self, gate, loop):
        self.gate = gate
        self.loop = loop

    def permit(self, request):
        return asyncio.run_coroutine_threadsafe(self.gate.permit(request), self.loop).result()

    def report(self, request, report):
        return asyncio.run_coroutine_threadsafe(self.gate.report(request, report), self.loop).result()
