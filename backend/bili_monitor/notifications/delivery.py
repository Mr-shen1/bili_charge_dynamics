"""独立投递：短事务领取 → 事务外请求飞书 → 按领取凭证短事务回写。

默认每秒轮询到期记录、有限批量；网络等待、限流与退避都不持有 SQLite 写事务。
投递结果不回写归档成功 checkpoint。
"""

import asyncio
import time

import httpx
from anyio import to_thread

from . import heartbeat, message, outbox
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
                await self.tick()
            except Exception:
                # 单轮领取/回写失败不能停掉整个投递进程；原因固定分类，不含 URL 或凭据。
                notifier_event("delivery_cycle_failed", warning=True, reason="internal_error")
            await self.clock.sleep(self.poll_seconds)

    async def tick(self):
        """一轮轮询：先登记本小时心跳（仅在第 40 分钟窗口内），再投递到期记录。

        心跳生成放在已有的独立通知进程轮询里，不新增时钟进程，也不放进 API。
        """
        try:
            await to_thread.run_sync(self._publish_heartbeat)
        except Exception:
            # 心跳登记失败只丢本小时的一轮尝试，不能连带停掉业务投递。
            notifier_event("heartbeat_cycle_failed", warning=True, reason="internal_error")
        return await self.run_once()

    def _publish_heartbeat(self):
        now = self.clock.now()
        slot = heartbeat.slot(now)
        if slot is None:
            return False
        # 第 40 分钟窗口内每秒都会走到这里（窗口外 slot 为 None，早返回）：
        # 先只读判重，避免同一分钟里每秒抢写锁。
        with self.store.connection() as connection:
            if connection.execute("SELECT 1 FROM notification_heartbeats WHERE slot = ?",
                                  (slot.identity,)).fetchone() is not None:
                return False
        with self.store.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                created = outbox.record_heartbeat(connection, slot, heartbeat.observe(connection), now)
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
        if created:
            # 日志字段只允许安全标识：时段身份含日期与冒号，这里只记小时。
            notifier_event("heartbeat_generated", hour=int(slot.identity[-2:]))
        return created

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

    def _payload(self, item):
        """事件类型 → 载荷；每种已登记类型都必须有模板，未支持类型才走退避兜底。"""
        if item["kind"] == outbox.DYNAMIC_CHANGED:
            return message.dynamic_changed(item["snapshot"], self.config.base_url)
        if item["kind"] == outbox.ROOT_COMMENT:
            return message.root_comment(item["snapshot"], self.config.base_url)
        if item["kind"] == outbox.HEARTBEAT:
            return message.heartbeat(item["snapshot"])
        return None

    async def _deliver(self, item):
        if item["expires_at"] is not None and self.clock.now() >= item["expires_at"]:
            # 过期不投递：只适用带有效期的记录（当前只有心跳），业务消息没有有效期。
            # 过期优先于缺路由：已过时的内容不值得保留等待配置，也不该在修复后补发。
            self._finish(item, state=outbox.EXPIRED, due_at=self.clock.now(), error="expired")
            notifier_event("delivery_expired", warning=True, role=item["role"], kind=item["kind"])
            return
        webhook = self.config.webhook(item["uid"], item["dynamic_id"], item["role"])
        if webhook is None:
            # 缺目标时保留记录并周期性复检，不每秒执行无效 HTTP，也不转投其他角色。
            self._finish(item, state=outbox.WAITING_CONFIG,
                         due_at=self.clock.now() + CONFIG_RECHECK_SECONDS, error="route_missing")
            notifier_event("delivery_waiting_config", warning=True, role=item["role"], kind=item["kind"])
            return
        payload = self._payload(item)
        if payload is None:
            self._finish(item, state=outbox.PENDING, due_at=self.clock.now() + RETRY_CAP_SECONDS,
                         error="unsupported_kind")
            return
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
