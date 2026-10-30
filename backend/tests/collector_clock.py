"""外部时钟测试替身，等待边界可观察；不替换调度器。"""

import asyncio
from datetime import datetime, timedelta, timezone


class ControlledClock:
    def __init__(self, start=None):
        # 起点可换：凌晨窗口这类按北京时间判定的用例需要从一个已知时刻起算。
        self.start = start if start is not None else datetime(2030, 1, 1, tzinfo=timezone.utc)
        self.value = 0
        self.waiters = []
        self.deadlines = []

    def monotonic(self):
        return self.value

    def now(self):
        return (self.start + timedelta(seconds=self.value)).isoformat(timespec="seconds")

    async def sleep(self, seconds):
        deadline = self.value + seconds
        self.deadlines.append(deadline)
        future = asyncio.get_running_loop().create_future()
        self.waiters.append((deadline, future))
        await future

    def advance(self, value):
        self.value = value
        for deadline, future in self.waiters:
            if deadline <= value and not future.done():
                future.set_result(None)


async def eventually(predicate):
    async def wait():
        while not await asyncio.to_thread(predicate):
            await asyncio.sleep(0.001)
    await asyncio.wait_for(wait(), timeout=10)
