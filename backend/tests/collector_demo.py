"""23 的隔离进程演示：真实数据库/HTTP状态，虚构传输和受控时钟。"""

import argparse
import asyncio
import json

import httpx

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.storage import Store
from backend.tests.archive_support import archive_client
from backend.tests.collector_clock import ControlledClock, eventually
from backend.tests.management_support import UID
from backend.tests.collector_support import CHECKS, configured, empty_upstream


async def demonstrate(path):
    store = Store(path)
    store.migrate()
    if not store.read(UID):
        configured(path)
    clock = ControlledClock()
    async with httpx.AsyncClient(transport=httpx.MockTransport(empty_upstream)) as client:
        running = asyncio.create_task(Collector(store, client, clock=clock).run())
        try:
            for tick in (0, 15, 30, 45):
                if tick:
                    clock.advance(tick)
                await eventually(lambda: store.read_checks(UID)[0]["last_checked_at"] == clock.now())
                await eventually(lambda: tick + 15 in clock.deadlines)
                if tick:
                    await eventually(lambda: store.read_checks(UID)[0]["work"] == "complete")
                # 短事务完成之后输出公开HTTP，而非内部状态。
                with archive_client(path) as api:
                    print(json.dumps({"tick": tick, **api.get(CHECKS).json()}, ensure_ascii=False), flush=True)
        finally:
            running.cancel()
            try:
                await running
            except asyncio.CancelledError:
                pass


def main():
    parser = argparse.ArgumentParser(description="Isolated collector demonstration")
    parser.add_argument("--database", required=True)
    args = parser.parse_args()
    asyncio.run(demonstrate(args.database))


if __name__ == "__main__":
    main()
