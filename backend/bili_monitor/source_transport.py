"""上游分页共享节奏；只等待发送机会，不持有网络或存储事务。"""

import asyncio
import random

import httpx

from .source_endpoints import FEED_URL, ROOT_COMMENTS_URL, REPLIES_URL


PAGE_DELAYS = {FEED_URL: (0.8, 1.5), ROOT_COMMENTS_URL: (0.3, 0.4), REPLIES_URL: (0.3, 0.4)}


class PacedSourceTransport(httpx.AsyncBaseTransport):
    """同一进程的上游客户端共用，避免多目标分页同时突发请求。

    参考原脚本：动态页 0.8–1.5 秒，根评论／楼中楼页 0.3–0.4 秒。
    每次发送前等待（包括首页及空尾页复查）；不重试、不改变检查节拍。
    非分页信号请求无需排队，慢同步的网络 I/O 也不占等待锁。
    sleep 仅作为外部时间边界供受控测试使用。
    """

    def __init__(self, transport=None, *, sleep=None):
        self.transport = transport if transport is not None else httpx.AsyncHTTPTransport(trust_env=False)
        self.sleep = sleep if sleep is not None else asyncio.sleep
        self.lock = asyncio.Lock()

    async def handle_async_request(self, request):
        interval = PAGE_DELAYS.get(str(request.url.copy_with(query=None)))
        if interval is not None:
            async with self.lock:
                await self.sleep(random.uniform(*interval))
        return await self.transport.handle_async_request(request)

    async def aclose(self):
        await self.transport.aclose()
