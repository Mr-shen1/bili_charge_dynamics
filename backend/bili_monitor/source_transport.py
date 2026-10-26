"""Feed/根页共享发送节奏；楼中楼的楼级等待由同步流程负责。"""

import asyncio
import random

import httpx

from .source_endpoints import FEED_URL, ROOT_COMMENTS_URL


PAGE_DELAYS = {FEED_URL: (0.8, 1.5), ROOT_COMMENTS_URL: (0.3, 0.4)}


class SourcePacer:
    """在同一事件循环共享等待锁；实际同步网络请求另在线程池执行。"""

    def __init__(self, *, sleep=None):
        self.sleep = sleep if sleep is not None else asyncio.sleep
        self.lock = asyncio.Lock()

    async def wait(self, url):
        interval = PAGE_DELAYS.get(str(httpx.URL(url).copy_with(query=None)))
        if interval is not None:
            async with self.lock:
                await self.sleep(random.uniform(*interval))


class PacedSourceTransport(httpx.AsyncBaseTransport):
    """Feed/根页发送前等待，包括首页和空尾页；不改变检查节拍。"""

    def __init__(self, transport=None, *, sleep=None, pacer=None):
        self.transport = transport if transport is not None else httpx.AsyncHTTPTransport(trust_env=False)
        self.pacer = pacer if pacer is not None else SourcePacer(sleep=sleep)
        self.sleep = self.pacer.sleep
        self.lock = self.pacer.lock

    async def handle_async_request(self, request):
        await self.pacer.wait(request.url)
        return await self.transport.handle_async_request(request)

    async def aclose(self):
        await self.transport.aclose()
