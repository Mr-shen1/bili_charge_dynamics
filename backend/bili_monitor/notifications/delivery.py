"""独立投递：短事务领取 → 事务外请求飞书 → 按领取凭证短事务回写。

默认每秒轮询到期记录、有限批量；网络等待、限流与退避都不持有 SQLite 写事务。
投递结果不回写归档成功 checkpoint。
"""

import asyncio
import time

import httpx
from anyio import to_thread

from . import message, outbox
from .log import notifier_event

POLL_SECONDS = 1.0
BATCH = 8
LEASE_SECONDS = 30.0
REQUEST_TIMEOUT_SECONDS = 10.0
RETRY_BASE_SECONDS = 2.0
RETRY_CAP_SECONDS = 300.0
CONFIG_RECHECK_SECONDS = 60.0


class SystemClock:
    def now(self):
        return time.time()

    async def sleep(self, seconds):
        await asyncio.sleep(seconds)


def _backoff(attempts):
    return min(RETRY_CAP_SECONDS, RETRY_BASE_SECONDS * (2 ** min(attempts, 8)))


class Dispatcher:
    """一个正式投递实例：领取、发送与回写各自独立事务。"""

    def __init__(self, store, config, *, transport=None, clock=None, batch=BATCH,
                 poll_seconds=POLL_SECONDS, lease_seconds=LEASE_SECONDS):
        self.store = store
        self.config = config
        self.clock = clock or SystemClock()
        self.batch = batch
        self.poll_seconds = poll_seconds
        self.lease_seconds = lease_seconds
        self.client = httpx.AsyncClient(transport=transport, timeout=REQUEST_TIMEOUT_SECONDS, trust_env=False)

    async def aclose(self):
        await self.client.aclose()

    async def run(self):
        routes_checked = False
        while True:
            try:
                if not routes_checked:
                    await to_thread.run_sync(self._recheck_routes)
                    routes_checked = True
                await self.run_once()
            except Exception:
                # 单轮领取/回写失败不能停掉整个投递进程；原因固定分类，不含 URL 或凭据。
                notifier_event("delivery_cycle_failed", warning=True, reason="internal_error")
            await self.clock.sleep(self.poll_seconds)

    async def run_once(self):
        claimed = await to_thread.run_sync(self._claim)
        if not claimed:
            return 0
        await asyncio.gather(*(self._deliver(item) for item in claimed))
        return len(claimed)

    def _recheck_routes(self):
        with self.store.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                outbox.recheck_waiting_config(connection, self.clock.now())
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    def _claim(self):
        now = self.clock.now()
        with self.store.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                items = outbox.claim_due(connection, now, self.batch, self.lease_seconds)
                connection.commit()
                return items
            except BaseException:
                connection.rollback()
                raise

    async def _deliver(self, item):
        webhook = self.config.webhook(item["uid"], item["dynamic_id"], item["role"])
        if webhook is None:
            # 缺目标时保留记录并周期性复检，不每秒执行无效 HTTP，也不转投其他角色。
            self._finish(item, state=outbox.WAITING_CONFIG,
                         due_at=self.clock.now() + CONFIG_RECHECK_SECONDS, error="route_missing")
            notifier_event("delivery_waiting_config", warning=True, role=item["role"], kind=item["kind"])
            return
        if item["kind"] != outbox.DYNAMIC_CHANGED:
            self._finish(item, state=outbox.PENDING, due_at=self.clock.now() + RETRY_CAP_SECONDS,
                         error="unsupported_kind")
            return
        payload = message.dynamic_changed(item["snapshot"], self.config.base_url)
        try:
            response = await self.client.post(webhook, json=payload)
        except Exception as error:
            result = message.transport_error(error)
        else:
            result = message.outcome(response.status_code, response.headers, response.content)
        if result.sent:
            self._finish(item, state=outbox.SENT, due_at=self.clock.now())
            notifier_event("delivery_sent", role=item["role"], kind=item["kind"])
            return
        delay = result.retry_after if result.error == "rate_limited" else None
        self._finish(item, state=outbox.PENDING, due_at=self.clock.now() + (delay or _backoff(item["attempts"])),
                     error=result.error)
        notifier_event("delivery_failed", warning=True, reason=result.error, role=item["role"])

    def _finish(self, item, *, state, due_at, error=None):
        with self.store.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                accepted = outbox.finish_delivery(
                    connection, item["delivery_id"], item["token"], state=state, now=self.clock.now(),
                    due_at=due_at, error=error)
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
        if not accepted:
            notifier_event("delivery_lease_expired", warning=True, role=item["role"])
