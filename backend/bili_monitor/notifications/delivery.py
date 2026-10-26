"""独立投递：短事务领取 → 事务外请求飞书 → 按领取凭证短事务回写。

默认每秒轮询到期记录、有限批量；网络等待、限流与退避都不持有 SQLite 写事务。
发送前先按目的地过一遍主动限速（票据 13）：超预算只顺延 `due_at`，不算失败。
每个轮次开头读一次持久总开关（票据 14）：关闭时不领取、不发送、不生成心跳。
投递结果不回写归档成功 checkpoint。
"""

import asyncio
import sqlite3
import time

import httpx
from anyio import to_thread

from ..transaction import write
from . import heartbeat, message, outbox
from .log import notifier_event
from .ratelimit import RateLimiter

POLL_SECONDS = 1.0
BATCH = 8
LEASE_SECONDS = 30.0
REQUEST_TIMEOUT_SECONDS = 10.0
RETRY_BASE_SECONDS = 2.0
RETRY_CAP_SECONDS = 300.0
CONFIG_RECHECK_SECONDS = 60.0
# “飞书持续投递失败”的判定：同一业务目标真实失败至少 3 次且当前仍在待投递。
# 成功恢复（sent）、等待配置与过期都不算；心跳与告警自身不参与，避免递归告警。
DELIVERY_FAILURE_THRESHOLD = 3
# 限速键：系统角色（心跳与告警）走独立额度，业务角色按实际 webhook 共用一份。
SYSTEM_RATE_KEY = ("system",)
# 读不到总开关时的占位状态：与布尔态区分，使“存储异常”只在首次进入时记一条日志。
GATE_UNREADABLE = "unreadable"


def rate_key(role, webhook):
    """限速键是目的地：同群共用额度，跨群互不占用；系统角色独立成一键。

    用元组区分两种身份，避免业务 webhook 字符串与系统键在同一个字典里混用。
    """
    return SYSTEM_RATE_KEY if role == outbox.SYSTEM_ROLE else ("webhook", webhook)


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
                 poll_seconds=POLL_SECONDS, lease_seconds=LEASE_SECONDS, limiter=None):
        self.store = store
        self.config = config
        self.clock = clock or SystemClock()
        self.batch = batch
        self.poll_seconds = poll_seconds
        self.lease_seconds = lease_seconds
        # 预算窗口随进程存活（单实例 flock 保证同库只有一个投递进程）。
        self.limiter = limiter if limiter is not None else RateLimiter()
        # 上一轮读到的闸门状态：只在真的变化时记一次日志，不每秒刷屏。
        # 启动按开启计，因此正常启动不伪造一次“切换”日志；启动即关闭则记一条跳过。
        self.gate = True
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
        """一轮轮询：先读总开关，再登记本小时心跳（仅第 40 分钟窗口内），最后投递到期记录。

        心跳生成放在已有的独立通知进程轮询里，不新增时钟进程，也不放进 API。
        总开关关闭时不领取、不发送、不生成心跳，直接进入下一轮：进程存活、
        `flock` 与租约语义不变，采集与归档照常工作。
        """
        if not await self._allowed():
            return 0
        try:
            await to_thread.run_sync(self._publish_heartbeat)
        except Exception:
            # 心跳登记失败只丢本小时的一轮尝试，不能连带停掉业务投递。
            notifier_event("heartbeat_cycle_failed", warning=True, reason="internal_error")
        delivered = await self._dispatch_batch()
        try:
            await to_thread.run_sync(self._scan_delivery_alerts)
        except Exception:
            # 告警扫描失败不能停掉投递；原因固定分类，不含地址或凭据。
            notifier_event("alert_cycle_failed", warning=True, reason="internal_error")
        return delivered

    async def _allowed(self):
        """本轮的闸门判定：每轮只读一次持久开关，读不到按关闭处理（宁可停发也不误发）。"""
        try:
            return await to_thread.run_sync(self._switch_enabled)
        except sqlite3.Error:
            # 存储异常只在首次进入该状态时记一条：关闭期间不每秒刷日志。
            if self.gate is not GATE_UNREADABLE:
                notifier_event("delivery_cycle_failed", warning=True, reason="storage_error")
                self.gate = GATE_UNREADABLE
            return False

    def _switch_enabled(self):
        """读一次通知状态；只在状态真的变化时记日志（含从读失败/关闭恢复）。

        `system_only` 与 `all` 都要投递：业务记录在非 `all` 状态根本不登记，进入
        `system_only` 时已把业务角色的未投递记录作废，因此这里只区分“发”与“全停”。
        """
        with self.store.connection() as connection:
            state = outbox.read_state(connection)
        enabled = state != outbox.NOTIFICATION_OFF
        if enabled != self.gate:
            if enabled:
                notifier_event("notification_switch_opened")
            else:
                notifier_event("delivery_skipped", reason="switch_off")
            self.gate = enabled
        return enabled

    def _scan_delivery_alerts(self):
        """消费 06 的持久失败事实：持续投递失败 → 一条系统告警（节流由发件箱合并）。"""
        now = self.clock.now()
        created = 0
        with write(self.store) as connection:
            for row in outbox.delivery_failures(connection, limit=max(self.batch * 8, 50)):
                if row["kind"] not in outbox.BUSINESS_KINDS or row["role"] == outbox.SYSTEM_ROLE:
                    continue
                if row["state"] != outbox.PENDING or row["failures"] < DELIVERY_FAILURE_THRESHOLD:
                    continue
                alert = outbox.Alert("delivery", f"{row['role']}:{row['kind']}",
                                     row["error"] or "internal_error")
                if outbox.record_alert(connection, alert, now):
                    created += 1
        if created:
            notifier_event("delivery_alert_registered", count=created)
        return created

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
        with write(self.store) as connection:
            created = outbox.record_heartbeat(connection, slot, heartbeat.observe(connection), now)
        if created:
            # 日志字段只允许安全标识：时段身份含日期与冒号，这里只记小时。
            notifier_event("heartbeat_generated", hour=int(slot.identity[-2:]))
        return created

    async def run_once(self):
        """一轮领取＋投递（轮询与 `--once` 共用）；总开关关闭时不领取、不发 HTTP。"""
        if not await self._allowed():
            return 0
        return await self._dispatch_batch()

    async def _dispatch_batch(self):
        claimed = await to_thread.run_sync(self._claim)
        if not claimed:
            return 0
        await asyncio.gather(*(self._deliver(item) for item in claimed))
        return len(claimed)

    def _recheck_routes(self):
        with write(self.store) as connection:
            outbox.recheck_waiting_config(connection, self.clock.now())

    def _claim(self):
        now = self.clock.now()
        with write(self.store) as connection:
            return outbox.claim_due(connection, now, self.batch, self.lease_seconds)

    def _payload(self, item):
        """事件类型 → 载荷；每种已登记类型都必须有模板，未支持类型才走退避兜底。"""
        if item["kind"] == outbox.DYNAMIC_CHANGED:
            return message.dynamic_changed(item["snapshot"], self.config.base_url)
        if item["kind"] == outbox.ROOT_COMMENT:
            return message.root_comment(item["snapshot"], self.config.base_url)
        if item["kind"] == outbox.REPLY_COMMENT:
            return message.reply_comment(item["snapshot"], self.config.base_url)
        if item["kind"] == outbox.HEARTBEAT:
            return message.heartbeat(item["snapshot"])
        if item["kind"] == outbox.ALERT:
            return message.alert(item["snapshot"])
        return None

    async def _deliver(self, item):
        if item["expires_at"] is not None and self.clock.now() >= item["expires_at"]:
            # 过期不投递：只适用带有效期的记录（当前只有心跳），业务消息没有有效期。
            # 过期优先于缺路由：已过时的内容不值得保留等待配置，也不该在修复后补发。
            self._finish(item, state=outbox.EXPIRED, due_at=self.clock.now(), error="expired")
            notifier_event("delivery_expired", warning=True, role=item["role"], kind=item["kind"])
            return
        route = self.config.resolve(item["uid"], item["dynamic_id"], item["role"])
        if route.error is not None:
            # 缺目标/目的地不可用时保留记录并周期性复检，不每秒执行无效 HTTP，也不转投其他角色。
            # 单条目写错只影响该目标：其他群仍在同一轮投递。
            # 业务目标的缺失/错误路由是独立可观察事实：与“等待配置”回写同事务登记告警，
            # 只标识受影响的目标角色与动态，不回显 webhook 或签名。系统群自身不登记（不递归）。
            alert = None
            if item["role"] != outbox.SYSTEM_ROLE:
                alert = outbox.Alert("route",
                                     f"{item['role']}:{item['uid']}:{item['dynamic_id']}", route.error)
            self._finish(item, state=outbox.WAITING_CONFIG,
                         due_at=self.clock.now() + CONFIG_RECHECK_SECONDS, error=route.error, alert=alert)
            notifier_event("delivery_waiting_config", warning=True, role=item["role"], kind=item["kind"],
                           reason=route.error)
            return
        webhook, secret = route.webhook, route.secret
        payload = self._payload(item)
        if payload is None:
            # 已登记的事件缺模板属于实现缺陷：保留记录并计一次投递失败事实。
            self._finish(item, state=outbox.PENDING, due_at=self.clock.now() + RETRY_CAP_SECONDS,
                         error="unsupported_kind", failure=True)
            return
        # 主动限速在请求之前、事务之外：超预算只顺延，不等 429 也不占写事务。
        key = rate_key(item["role"], webhook)
        now = self.clock.now()
        delay = self.limiter.defer_seconds(key, now)
        if delay:
            if self._defer(item, now + delay):
                notifier_event("delivery_deferred", role=item["role"], kind=item["kind"],
                               reason="rate_limited")
            return
        self.limiter.record(key, now)
        if secret is not None:
            # 可选签名只在外发组装：时间戳与签名不进队列、快照或日志。
            payload = message.signed(payload, secret, self.clock.now())
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
                     error=result.error, failure=True)
        notifier_event("delivery_failed", warning=True, reason=result.error, role=item["role"])

    def _defer(self, item, due_at):
        """超预算顺延：留在 `pending`，下一轮轮询自然重领；不计失败也不消耗 attempts。

        返回 False 表示领取凭证已失效（记录已被新领取结果接管），不再另外记日志。
        """
        with write(self.store) as connection:
            accepted = outbox.defer_delivery(connection, item["delivery_id"], item["token"],
                                            due_at=due_at)
        if not accepted:
            notifier_event("delivery_lease_expired", warning=True, role=item["role"])
        return accepted

    def _finish(self, item, *, state, due_at, error=None, failure=False, alert=None):
        accepted = False
        with write(self.store) as connection:
            accepted = outbox.finish_delivery(
                connection, item["delivery_id"], item["token"], state=state, now=self.clock.now(),
                due_at=due_at, error=error, failure=failure)
            # 告警登记与失败事实同事务：失败事实被接受才登记，回滚则一起丢弃。
            # 单条告警写不进去不牵连投递结果（SAVEPOINT 隔离），只留固定分类日志。
            if accepted and alert is not None:
                try:
                    with outbox.alert_guard(connection):
                        outbox.record_alert(connection, alert, self.clock.now())
                except sqlite3.Error:
                    notifier_event("alert_registration_failed", warning=True, reason="storage_error")
        if not accepted:
            notifier_event("delivery_lease_expired", warning=True, role=item["role"])
