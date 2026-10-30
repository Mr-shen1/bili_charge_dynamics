"""跨进程的源发送许可、重型工作租约与分页公平轮转。

正式设计 §3.1：全局只推进一路重型归档，调度片是一个可提交的根页／楼中楼页／
单图下载步骤；B 站源请求统一排队发送。API 与 collector 共用一个 SQLite，本模块用
短事务在 `dispatch_leases` 中保存 owner、期限与工作负载，网络、等待与解析都不在写事务内。
租约到期或 owner 失效后，其他进程只能先接管再发送；旧 owner 的释放不会删掉新 owner。

`TargetSession` 把正文、根页、楼中楼页与单图下载拆成一次调用只推进一步的步骤机。
跨目标轮转由 collector 的 `execute_pending` 按会话轮转完成，API 的显式初始化同样按
步骤推进，因此不会因为某个目标有上万条回复而长期占住唯一的重型许可。
"""

import asyncio
import random
import sqlite3
import time
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import NamedTuple
from uuid import uuid4

from anyio import to_thread

from .collector_logging import collector_event, collector_failure, source_refs
from .comment_client import open_comment_client
from .comment_status import ROOT_METADATA_VERSION, optional_epoch
from .media import media_step
from . import replies as replies_module
from .replies import reply_scan_step
from .root_comments import root_scan_step, valid_locator
from .risk import SourceRiskPaused
from .sync import comment_metadata, sync_body
from .transaction import write


SOURCE_LEASE_SECONDS = 45.0
HEAVY_LEASE_SECONDS = 300.0
TARGET_LEASE_SECONDS = 300.0
LEASE_POLL_SECONDS = 0.02


class DispatchUnavailable(sqlite3.OperationalError):
    """租约存储不可用或等待超时：调用方不得在未取得许可时发送。"""


_SCHEMA = """CREATE TABLE IF NOT EXISTS dispatch_leases (
    name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    workload TEXT NOT NULL,
    kind TEXT NOT NULL,
    lease_until REAL NOT NULL,
    updated_at TEXT NOT NULL
)"""


def migrate(connection):
    """v27：跨进程发送许可、重型回合与目标互斥租约；可重入。"""
    connection.execute(_SCHEMA)


def _epoch(value):
    """租约时间 → epoch 秒；缺失或不可解析时回退真实时间。

    租约侧的回退语义与风控状态相反：期限算不清时必须按“已过期可接管”处理，不能
    把它当成永久有效。解析本身与 `risk._epoch` 共用 `optional_epoch`，回退写在各
    自的调用点上。
    """
    parsed = optional_epoch(value)
    return time.time() if parsed is None else parsed


class _HeldLease:
    """一条已取得的租约；可选心跳只续自己的 owner，不覆盖接管者。"""

    def __init__(self, leases, name, owner, ttl, *, heartbeat):
        self.leases = leases
        self.name = name
        self.owner = owner
        self.ttl = ttl
        self.heartbeat = heartbeat
        self.alive = True
        self._task = None

    async def start(self):
        if self.heartbeat and self.ttl >= 0.15:
            self._task = asyncio.create_task(self._beat())
        return self

    async def _beat(self):
        interval = max(0.05, self.ttl / 3)
        while True:
            await asyncio.sleep(interval)
            if not await to_thread.run_sync(self.leases._renew, self.name, self.owner, self.ttl):
                self.alive = False
                return

    async def renew(self):
        renewed = await to_thread.run_sync(self.leases._renew, self.name, self.owner, self.ttl)
        self.alive = renewed
        return renewed

    async def release(self):
        self.alive = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        await to_thread.run_sync(self.leases._release, self.name, self.owner)


class TargetLease:
    """一个目标会话的互斥租约：跨步骤持有，失去后不得再提交/发送。"""

    def __init__(self, leases, held):
        self.leases = leases
        self.held = held
        self.name = held.name

    @property
    def alive(self):
        return self.held.alive

    async def renew(self):
        return await self.held.renew()

    async def release(self):
        await self.held.release()


class BorrowedTargetLease:
    """并发 API 初始化共用同一目标时的无主租约；只有真正持锁者释放。"""

    name = ""
    alive = True

    async def renew(self):
        return True

    async def release(self):
        return None


class DispatchLeases:
    """SQLite 租约集合：`source` 逐次发送、`heavy` 单路重型、`target:*` 同目标互斥。"""

    def __init__(self, store, clock=None, *, owner=None, source_ttl=SOURCE_LEASE_SECONDS,
                 heavy_ttl=HEAVY_LEASE_SECONDS, target_ttl=TARGET_LEASE_SECONDS,
                 heartbeat=False, poll=LEASE_POLL_SECONDS, acquire_timeout=60.0):
        self.store = store
        self.clock = clock
        self.owner = owner or uuid4().hex
        self.source_ttl = float(source_ttl)
        self.heavy_ttl = float(heavy_ttl)
        self.target_ttl = float(target_ttl)
        self.heartbeat = heartbeat
        self.poll = poll
        self.acquire_timeout = acquire_timeout
        self._source_holder = ContextVar("dispatch_source_holder", default=None)

    def _now(self):
        return _epoch(self.clock.now() if self.clock is not None else None)

    def _try_acquire(self, name, owner, workload, kind, ttl):
        now = self._now()
        with write(self.store) as connection:
            row = connection.execute(
                "SELECT owner, lease_until FROM dispatch_leases WHERE name = ?", (name,)).fetchone()
            if row is not None and row["lease_until"] > now:
                return False
            connection.execute("""INSERT INTO dispatch_leases
                (name, owner, workload, kind, lease_until, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, workload = excluded.workload,
                kind = excluded.kind, lease_until = excluded.lease_until, updated_at = excluded.updated_at""",
                (name, owner, workload, kind, now + ttl, self._timestamp()))
            return True

    def _timestamp(self):
        return self.clock.now() if self.clock is not None else time.strftime(
            "%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())

    def _renew(self, name, owner, ttl):
        now = self._now()
        with write(self.store) as connection:
            changed = connection.execute("""UPDATE dispatch_leases SET lease_until = ?, updated_at = ?
                WHERE name = ? AND owner = ?""",
                (now + ttl, self._timestamp(), name, owner)).rowcount
            return bool(changed)

    def _release(self, name, owner):
        try:
            with write(self.store) as connection:
                connection.execute("DELETE FROM dispatch_leases WHERE name = ? AND owner = ?",
                                   (name, owner))
        except sqlite3.Error:
            # 释放失败不能掩盖原异常；到期后其他进程仍可安全接管。
            return

    async def _acquire(self, name, workload, kind, ttl, *, wait=True):
        owner = f"{self.owner}:{uuid4().hex}"
        deadline = time.monotonic() + self.acquire_timeout
        while True:
            try:
                acquired = await to_thread.run_sync(self._try_acquire, name, owner, workload, kind, ttl)
            except sqlite3.Error as error:
                raise DispatchUnavailable("Dispatch lease storage unavailable") from error
            if acquired:
                return await _HeldLease(self, name, owner, ttl, heartbeat=self.heartbeat).start()
            if not wait or time.monotonic() >= deadline:
                return None
            await asyncio.sleep(self.poll)

    @asynccontextmanager
    async def _hold(self, name, workload, kind, ttl, *, wait=True):
        held = await self._acquire(name, workload, kind, ttl, wait=wait)
        if held is None:
            raise DispatchUnavailable("Dispatch lease is busy")
        try:
            yield held
        finally:
            await held.release()

    @asynccontextmanager
    async def source_slot(self, endpoint_type):
        """一次真实来源发送（或包住发送+页后等待）的跨进程许可。"""
        if self._source_holder.get() is not None:
            # 楼中楼页后等待／重定向已在外层持有同一许可：不重复取，也不提前释放。
            yield None
            return
        async with self._hold("source", "source", endpoint_type, self.source_ttl) as held:
            token = self._source_holder.set(held)
            try:
                yield held
            finally:
                self._source_holder.reset(token)

    @asynccontextmanager
    async def heavy_slot(self, workload, kind):
        """全局唯一重型步骤；步骤提交后立即释放，让其他目标/进程获得下一次机会。"""
        async with self._hold("heavy", workload, kind, self.heavy_ttl) as held:
            yield held

    async def _holder_kind(self, name):
        def read():
            with self.store.connection() as connection:
                connection.execute("BEGIN")
                row = connection.execute(
                    "SELECT kind FROM dispatch_leases WHERE name = ?", (name,)).fetchone()
                return row["kind"] if row is not None else None
        try:
            return await to_thread.run_sync(read)
        except sqlite3.Error:
            return None

    async def acquire_target(self, uid, id, *, wait=False):
        name = f"target:{uid}:{id}"
        held = await self._acquire(name, f"{uid}:{id}", "collector", self.target_ttl, wait=wait)
        return None if held is None else TargetLease(self, held)

    async def acquire_api_target(self, uid, id):
        """API 手动初始化的目标互斥：挡住 collector；并发手动初始化仍走 generation fencing。"""
        name = f"target:{uid}:{id}"
        held = await self._acquire(name, f"{uid}:{id}", "api", self.target_ttl, wait=False)
        if held is not None:
            return TargetLease(self, held)
        if await self._holder_kind(name) == "api":
            return BorrowedTargetLease()
        return None

    async def snapshot(self):
        def read():
            with self.store.connection() as connection:
                connection.execute("BEGIN")
                return [dict(row) for row in connection.execute(
                    "SELECT name, workload, kind, lease_until FROM dispatch_leases "
                    "ORDER BY name COLLATE BINARY")]
        return await to_thread.run_sync(read)


class StepOutcome(NamedTuple):
    stage: str
    status: str
    page: int | None = None
    reason: str | None = None
    done: bool = False
    failed: bool = False


@dataclass
class TargetSession:
    """一个目标的步骤机；一次 `advance()` 最多提交一个可调度片。"""

    store: object
    client: object
    uid: str
    id: str
    generation: int
    observed: dict
    downloader: object = None
    uploader: object = None
    comment_client_factory: object = None
    now: object = None
    on_failure: object = None
    pending_comments_only: bool = True
    full_replies: bool = False
    # 本次领取是每日点赞刷新（窗口内且锚点到期）：完整翻根页到空尾页，不使用
    # 「遇到已知评论就提前收束」的裁切，也不改增量路径本身。
    like_refresh: bool = False
    stage: str = "body"
    text_succeeded: bool = False
    run_comments: bool = True
    full_roots: bool = False
    roots_started: bool = False
    degraded: bool = False
    failed_roots: int = 0
    skipped_roots: int = 0
    replies: list | None = None
    reply_index: int = 0
    reply_started: set = field(default_factory=set)
    observed_replies: dict | None = None
    root_reply_counts: dict = field(default_factory=dict)
    observed_count: object = None
    seen: dict | None = None
    media_owners: list | None = None
    media_owner_index: int = 0
    media_attempted: set = field(default_factory=set)
    done: bool = False
    claim: dict | None = None
    alerts: list = field(default_factory=list)
    # 本次会话登记的失败全是可自愈分页校验：错误事实已落库并留 WARNING，但不再由
    # `comments_error` 兜底补一条“评论分页失败”告警。
    suppressed: bool = False
    target_lease: object = None

    async def advance(self):
        if self.stage == "body":
            return await self._body_step()
        if self.stage == "roots":
            return await self._root_step()
        if self.stage == "replies":
            return await self._reply_step()
        if self.stage == "media":
            return await self._media_step()
        self.done = True
        return StepOutcome("finish", "complete", done=True)

    def _fail(self, error):
        if self.on_failure is not None:
            self.on_failure(error)

    async def _body_step(self):
        archive = await to_thread.run_sync(self.store.read_archive, self.id)
        if archive is None:
            self.done = True
            return StepOutcome("body", "failed", reason="archive_missing", done=True, failed=True)
        observed = self.observed or {}
        version = observed.get("observed_version")
        body_complete = (self.observed is not None
                         and archive["work"]["text"] == "success"
                         and archive["synced_version"] == version
                         and archive.get("media_version") == version)
        body_restricted = (self.observed is not None
                           and archive["work"]["text"] == "restricted"
                           and archive.get("restricted_version") == version
                           and observed.get("content_visible") is not True)
        if body_complete or body_restricted:
            metadata = comment_metadata(observed)
            await to_thread.run_sync(self.store.observe_archive, self.id, self.generation, metadata)
            self.text_succeeded = True
        else:
            self.text_succeeded = await sync_body(
                self.store, self.client, self.uid, self.id, self.generation,
                self.observed, self.now)
        archive = await to_thread.run_sync(self.store.read_archive, self.id)
        if archive is None:
            self.done = True
            return StepOutcome("body", "failed", reason="archive_missing", done=True, failed=True)
        previous_locator = observed.get("comment_locator") or {}
        current_locator = archive.get("comment_locator") or {}
        locator_changed = any(previous_locator.get(key) != current_locator.get(key)
                              for key in ("oid", "type"))
        metadata_version_old = (archive.get("synced_root_metadata_version", 0)
                                < ROOT_METADATA_VERSION)
        # 点赞刷新不改写任何信号，已成功的分项也不会自行重开——必须显式逼出全量根页。
        self.full_roots = (not self.pending_comments_only or metadata_version_old
                           or self.like_refresh)
        # 同一次刷新对楼中楼也是整楼正序：不走末页倒序增量，也不使用任何
        # 「遇到已知回复就收束」的裁切（方向由 `full` 决定）。上一轮整楼全量没走完时
        # 续采保持全量：判定只读持久进度，中断后重新进入同一轮不需要调用方再传参。
        resumed_full_replies = await to_thread.run_sync(
            self.store.resuming_full_replies, self.id)
        self.full_replies = (self.full_replies or self.like_refresh or resumed_full_replies)
        self.run_comments = (not self.pending_comments_only or self.like_refresh
                             or locator_changed or metadata_version_old
                             or any(archive["work"][part] != "success"
                                    for part in ("comments", "replies")))
        self.stage = "roots" if self.run_comments else "media"
        collector_event("dispatch_stage", stage="body", next_stage=self.stage,
                        checkpoint="accepted", **source_refs(uid=self.uid, dynamic_id=self.id))
        return StepOutcome("body", "committed", failed=not self.text_succeeded)

    async def _root_step(self):
        archive = await to_thread.run_sync(self.store.read_archive, self.id)
        if archive is not None and not valid_locator(archive.get("comment_locator")):
            collector_event("root_sync_unconfirmed", warning=True, reason="locator_missing",
                            **source_refs(uid=self.uid, dynamic_id=self.id))
            await to_thread.run_sync(self.store.finish_roots, self.id, self.generation,
                                     "unconfirmed", None)
            self.degraded = True
            await self._prepare_replies()
            return StepOutcome("roots", "unconfirmed", reason="locator_missing")
        try:
            async with open_comment_client(self.client, self.uid, self.comment_client_factory) as comments:
                step = await root_scan_step(
                    self.store, comments, self.id, self.generation, uid=self.uid,
                    resume=not self.roots_started, full=self.full_roots)
        except SourceRiskPaused:
            raise
        except Exception as error:
            collector_failure("root_sync_failed", error,
                              stage=getattr(error, "stage", "page_fetch"),
                              page=getattr(error, "page", None),
                              **source_refs(uid=self.uid, dynamic_id=self.id))
            self._fail(error)
            await to_thread.run_sync(self.store.finish_roots, self.id, self.generation,
                                     "failed", None)
            self.degraded = True
            await self._prepare_replies()
            return StepOutcome("roots", "failed", reason="source_failed", failed=True)
        self.roots_started = True
        self.root_reply_counts.update(dict(step.reply_counts))
        if step.status == "page":
            return StepOutcome("roots", "page", page=step.page, reason=step.reason)
        if step.status == "stale":
            self.done = True
            return StepOutcome("roots", "stale", page=step.page, reason="stale_generation",
                               done=True, failed=True)
        position = await to_thread.run_sync(
            lambda: self.store.read_root_scan(self.id, self.generation))
        archive = await to_thread.run_sync(self.store.read_archive, self.id)
        observed_count = archive.get("source_comment_count")
        finished = await to_thread.run_sync(lambda: self.store.finish_roots(
            self.id, self.generation, "success", observed_count,
            self.now() if self.now is not None else None,
            pin_known=position.pin_known if position is not None else False,
            pinned_id=position.pinned_id if position is not None else None,
            # 完整根页扫描即一次点赞刷新：成功就在这次提交里推进锚点。中断过的全量轮次
            # 由持久进度保持全量（重启续采不需要调用方再传参），因此也按全量记账。
            like_refresh=self.full_roots or bool(position is not None and position.full)))
        if finished is None:
            self.done = True
            return StepOutcome("roots", "stale", page=step.page, reason="stale_generation",
                               done=True, failed=True)
        self.observed_count = observed_count
        # 未重读的深层根沿用归档 rcount；本次实际读到的页覆盖为最新来源值。
        self.observed_replies = await to_thread.run_sync(self.store.root_reply_counts, self.id)
        self.observed_replies.update(self.root_reply_counts)
        self.degraded = False
        await self._prepare_replies()
        return StepOutcome("roots", "complete", page=step.page, reason=step.reason)

    async def _prepare_replies(self):
        if self.degraded:
            progress = await to_thread.run_sync(self.store.reply_progress, self.id)
            if not progress:
                collector_event("replies_sync_skipped", reason="roots_unconfirmed",
                                **source_refs(dynamic_id=self.id))
                await to_thread.run_sync(self.store.finish_replies, self.id, self.generation,
                                         "unconfirmed", None)
                self.stage = "media"
                return
            roots = await to_thread.run_sync(self.store.roots_for_replies, self.id, set(progress))
            self.observed_replies = {root["id"]: root["source_reply_count"] for root in roots}
            collector_event("replies_sync_degraded", roots=len(self.observed_replies),
                            **source_refs(dynamic_id=self.id))
        if self.observed_replies is None:
            self.observed_replies = await to_thread.run_sync(self.store.root_reply_counts, self.id)
        self.replies = await to_thread.run_sync(
            self.store.roots_for_replies, self.id, set(self.observed_replies))
        self.seen = await to_thread.run_sync(self.store.reply_ids, self.id)
        self.reply_index = 0
        self.reply_started = set()
        self.failed_roots = 0
        self.skipped_roots = 0
        self.stage = "replies"
        collector_event("replies_sync_started", roots=len(self.replies),
                        **source_refs(uid=self.uid, dynamic_id=self.id))

    async def _reply_step(self):
        if self.replies is None:
            await self._prepare_replies()
            if self.stage != "replies":
                return StepOutcome("replies", "skipped", reason="roots_unconfirmed")
        if self.reply_index >= len(self.replies):
            status = "unconfirmed" if self.degraded else (
                "failed" if self.failed_roots else "success")
            succeeded_at = (self.now() if self.now is not None and status == "success" else None)
            await to_thread.run_sync(lambda: self.store.finish_replies(
                self.id, self.generation, status,
                None if self.degraded else self.observed_count, succeeded_at))
            collector_event("replies_sync_finished", warning=bool(self.failed_roots),
                            succeeded=status == "success", degraded=self.degraded,
                            roots=len(self.replies), skipped=self.skipped_roots,
                            **source_refs(uid=self.uid, dynamic_id=self.id))
            self.stage = "media"
            return StepOutcome("replies", "complete", reason=status)
        root = self.replies[self.reply_index]
        resume = root["id"] not in self.reply_started
        async with open_comment_client(self.client, self.uid, self.comment_client_factory) as comments:
            step = await reply_scan_step(
                self.store, comments, self.id, self.generation, root["id"], uid=self.uid,
                resume=resume, full=self.full_replies,
                observed=self.observed_replies[root["id"]], now=self.now,
                on_failure=self._fail, seen=self.seen)
        self.reply_started.add(root["id"])
        if step.status == "page":
            return StepOutcome("replies", "page", page=step.page, reason=step.reason)
        if step.status == "stale":
            self.done = True
            return StepOutcome("replies", "stale", page=step.page, reason="stale_generation",
                               done=True, failed=True)
        if step.status == "failed":
            self.failed_roots += 1
        elif step.status == "skipped":
            self.skipped_roots += 1
        self.reply_index += 1
        if step.expanded:
            await replies_module.sleep_after_root(random.uniform(0.3, 0.4))
        return StepOutcome("replies", step.status, page=step.page, reason=step.reason,
                           failed=step.status == "failed")

    async def _media_step(self):
        if self.media_owners is None:
            roots = await to_thread.run_sync(self.store.media_root_ids, self.id)
            self.media_owners = [None] + list(roots)
            self.media_owner_index = 0
        while self.media_owner_index < len(self.media_owners):
            root_id = self.media_owners[self.media_owner_index]
            result = await media_step(
                self.store, self.downloader, self.uploader, self.id, root_id=root_id,
                current_only=True, now=self.now, skip=self.media_attempted)
            if result is not None and result.get("processed"):
                self.media_attempted.add(result["media_id"])
                return StepOutcome("media", "item", reason=root_id,
                                   failed=bool(result.get("failed")))
            self.media_owner_index += 1
        self.stage = "finish"
        self.done = True
        collector_event("dispatch_stage", stage="media", next_stage="finish",
                        checkpoint="accepted", **source_refs(uid=self.uid, dynamic_id=self.id))
        return StepOutcome("media", "complete", done=True)

    async def result(self):
        """目标完成判定沿用既有归档分项语义；不由调度器另造成功口径。"""
        archive = await to_thread.run_sync(self.store.read_archive, self.id)
        if archive is None:
            return False, None, []
        observed = self.observed or {}
        version = observed.get("observed_version")
        restricted_current = (archive["work"]["text"] == "restricted"
                              and archive.get("restricted_version") == version
                              and observed.get("content_visible") is not True)
        media_upload = self.uploader is not None
        succeeded = ((self.text_succeeded or restricted_current)
                     and all(value in ("success", "restricted")
                             for part, value in archive["work"].items()
                             if media_upload or part != "media")
                     and archive["work"]["comments"] == archive["work"]["replies"] == "success"
                     and (not media_upload or archive["work"]["media"] != "restricted"
                          or restricted_current)
                     and (archive["synced_version"] == version or restricted_current)
                     and archive["synced_comment_count"] == observed.get("source_comment_count"))
        if media_upload:
            for root_id in await to_thread.run_sync(self.store.media_root_ids, self.id):
                root = await to_thread.run_sync(self.store.read_media_owner, self.id, root_id)
                succeeded = succeeded and root["work"]["media"] == "success"
        return succeeded, archive, []
