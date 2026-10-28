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


# 来源主机白名单：与评论 Cookie 的发送范围一致；其他主机不受源站许可控制。
SOURCE_HOSTS = frozenset({"api.bilibili.com", "www.bilibili.com", "space.bilibili.com"})

# 接口类型按「主机 + 路径模板」归类：query 里的资源 ID 和页码不产生新类型，
# 后续按类型探测与日志才能覆盖不同拦截范围又不制造探测洪峰。
_API_ENDPOINTS = {
    "/x/v2/reply/count": "comment_count",
    "/x/v2/reply/reply": "replies",
    "/x/v2/reply": "root_comments",
    "/x/polymer/web-dynamic/v1/feed/space": "feed",
    "/x/polymer/web-dynamic/v1/detail": "detail",
    "/x/web-interface/card": "profile",
}
_OPUS_PAGE_PATH = re.compile(r"/opus/[1-9][0-9]*")
_SPACE_DYNAMIC_PATH = re.compile(r"/[1-9][0-9]*/dynamic")

# 图片按受信域族区分：两族分别代表不同 CDN 拦截面，探测与日志不能互相代替。
IMAGE_HDSLB = "image_hdslb"
IMAGE_BILIIMG = "image_biliimg"
IMAGE_ENDPOINTS = (("hdslb.com", IMAGE_HDSLB), ("biliimg.com", IMAGE_BILIIMG))
# 白名单内、但尚无专门模板的来源路径仍须经过许可，不因分类缺失而放行。
OTHER_SOURCE = "source_other"


def endpoint_type(host, path):
    """按主机与路径模板给出接口类型；非 B 站来源返回 None（不受许可控制）。"""
    if is_image_source_host(host):
        return next(kind for domain, kind in IMAGE_ENDPOINTS
                    if host == domain or host.endswith("." + domain))
    if host not in SOURCE_HOSTS:
        return None
    if host == "api.bilibili.com":
        return _API_ENDPOINTS.get(path, OTHER_SOURCE)
    if host == "www.bilibili.com":
        if path == "/":
            return "homepage_warmup"
        return "opus_page" if _OPUS_PAGE_PATH.fullmatch(path) else OTHER_SOURCE
    return "space_warmup" if _SPACE_DYNAMIC_PATH.fullmatch(path) else OTHER_SOURCE


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


class OpenSourceGate:
    """默认实现：一律放行且不记录，正常采集行为与本票之前一致。"""

    async def permit(self, request):
        return None

    async def report(self, request, report):
        return None


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
