"""楼中楼分页的页后等待：请求与等待同处一个串行段，跨调用方不能交错绕过。

正式设计 §3.2：每次**真实**楼中楼分页请求结束后异步等待至少 0.1 秒，覆盖首次、增量、
失败重试、空尾页复查与后续探测；第一个请求之前不加这段等待，最后一页之后仍然执行。

等待不是每个 worker 的独立延时：`ReplyPagePacer.page()` 在同一个锁内包住「发送 →
完成 → 等待」，因此第二个调用者最早也要等到上一个请求完成 100ms 之后才能发送，
多进程／多任务不能用交错发送绕过。锁内只有网络与等待，不持有 SQLite 写事务。

时间与等待可注入（`sleep`、`clock`、`delay`），既有只覆盖楼级 0.3—0.4 秒的测试替身
不会误吞或误约束这里；`PageTiming` 只带诊断用的毫秒数，供结构化日志区分请求耗时与
主动等待。
"""

import asyncio
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field


# 每次真实楼中楼分页请求结束后的最小等待；参数来源见正式设计 §3.2 等待规则表。
REPLY_PAGE_DELAY_SECONDS = 0.1


@dataclass
class PageTiming:
    """一次楼中楼分页请求的诊断数据：判断慢请求还是主动等待。"""

    delay_ms: int = int(round(REPLY_PAGE_DELAY_SECONDS * 1000))
    elapsed_ms: int = field(default=0)
    wait_ms: int = field(default=0)


class ReplyPagePacer:
    """楼中楼页后等待的协调器；同一实例被多个客户端共享时仍不能交错绕过。"""

    def __init__(self, *, sleep=None, clock=None, delay=REPLY_PAGE_DELAY_SECONDS):
        self.sleep = sleep if sleep is not None else asyncio.sleep
        self.clock = clock if clock is not None else time.monotonic
        self.delay = delay
        self.lock = asyncio.Lock()

    @asynccontextmanager
    async def page(self):
        """包住一次真实楼中楼发送：返回后等待；失败也等待；进入前不等待。"""
        timing = PageTiming(delay_ms=int(round(self.delay * 1000)))
        async with self.lock:
            started = self.clock()
            try:
                yield timing
            finally:
                # 请求耗时与主动等待分开记录；等待失败请求也已发生，不能在异常路径漏掉。
                timing.elapsed_ms = max(0, int((self.clock() - started) * 1000))
                await self.sleep(self.delay)
                timing.wait_ms = int(round(self.delay * 1000))
