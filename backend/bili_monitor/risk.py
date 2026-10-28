"""跨进程的 B 站源保护状态：HTTP 412／429 触发全局暂停，API 与采集共用 SQLite。

本模块是 `source_gate.SourceGate` 的持久实现，接在 01 建立的同一 Interface 上：
`permit` 在发送前核验共享状态并拒绝，`report` 在返回后合并风控响应。状态、状态代次、
退避档位、进入时间、下次探测时间、触发接口与探测 owner 租约都在同一个短事务里落库，
不按 UP 或动态拆开，也不使用进程内对象冒充全局保护。

状态机（正式设计 §4）：`normal` → `cooldown`（六档 1／2／4／8／15／30 分钟）→ 到期
由唯一 owner 领取 `probing` 并按接口类型串行探测 → 全部通过进 `observing`（保留档位，
观察期由 `observing_tick` 在确有成功业务请求的活跃采集满 10 分钟后清零）／任一轮失败只推进一档、第六档失败转 `manual`。合法 Retry-After
只会把本地期限推后，不会被更短的档位等待覆盖；档位、期限与人工态随库持久，重启后
不能凭时间流逝自动放行。

观察期只按“确有成功业务请求的活跃采集时间”累计（`observing_tick`）：空闲、普通失败
与停机都不抵扣，重启只让观察时间重新累计、档位保留；满 10 分钟才回到 `normal` 并
清零档位。人工态由管理入口登记一轮探测（`request_probe`），仍由采集进程领取执行，
通过后进入同一观察期，失败保持人工态；没有强行解除保护的入口。
"""

import json
import math
import sqlite3
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from uuid import uuid4

from anyio import to_thread

from .collector_logging import collector_event, correlation_id
from .comment_status import epoch_from_iso, utc_now
from .contracts import error_response
from .transaction import write


# 触发分类只有真实上游 HTTP 状态；业务码 -412／-352 与网络失败不在其中。
TRIGGER_STATUSES = frozenset({412, 429})
# 冷却阶梯（秒）：每档到期执行一轮探测，任一轮未通过只推进一档。
COOLDOWN_STEPS = (60, 120, 240, 480, 900, 1800)
# 探测 owner 租约：崩溃后必须等它过期才能接管，旧 owner 也不能再提交结果。
PROBE_LEASE_SECONDS = 300
# 恢复观察期（秒）：全部接口探测通过后仍需连续成功正常采集这么久才清零档位。
OBSERVATION_SECONDS = 600
OBSERVATION_MS = int(OBSERVATION_SECONDS * 1000)
# 业务“成功”只看真实上游返回的 HTTP 状态；风控状态与普通错误都不算采集活跃。
SUCCESS_STATUSES = range(200, 400)
# 预热只是会话前置，不算一次成功业务请求，不能让观察期凭预热空转清零。
NON_BUSINESS_TYPES = frozenset({"homepage_warmup", "space_warmup"})
# 禁止普通来源发送的状态；`normal` 与 `observing` 都按正常调度发送。
BLOCKED_STATES = frozenset({"cooldown", "probing", "manual"})
ACTIVE_STATES = frozenset({"normal", "observing"})

_SCHEMA = """CREATE TABLE IF NOT EXISTS source_risk (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    state TEXT NOT NULL CHECK (state IN ('normal', 'cooldown', 'probing', 'observing', 'manual')),
    generation INTEGER NOT NULL DEFAULT 0,
    backoff_step INTEGER NOT NULL DEFAULT 0,
    since TEXT NOT NULL,
    next_probe_at TEXT,
    observing_since TEXT,
    trigger_endpoint TEXT,
    trigger_status INTEGER,
    trigger_at TEXT,
    probe_round_id TEXT,
    probe_owner TEXT,
    probe_lease_until TEXT,
    probe_results TEXT,
    probe_origin TEXT,
    probe_request_generation INTEGER,
    observing_active_ms INTEGER NOT NULL DEFAULT 0,
    observing_successes INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
)"""

_COLUMNS = ("state, generation, backoff_step, since, next_probe_at, observing_since, "
            "trigger_endpoint, trigger_status, trigger_at, probe_round_id, probe_owner, "
            "probe_lease_until, probe_results, probe_origin, probe_request_generation, "
            "observing_active_ms, observing_successes")

# v26 新增列：人工探测登记（按人工态代次）、探测来源（人工／自动）与观察期进度。
_OBSERVATION_COLUMNS = (
    ("probe_origin", "TEXT"),
    ("probe_request_generation", "INTEGER"),
    ("observing_active_ms", "INTEGER NOT NULL DEFAULT 0"),
    ("observing_successes", "INTEGER NOT NULL DEFAULT 0"),
)


class SourceRiskPaused(Exception):
    """保护状态拒绝新的源请求；`status` 只含可公开的状态事实，不含 owner 或令牌。"""

    def __init__(self, status):
        self.status = status
        super().__init__("SOURCE_RISK_PAUSED")


def migrate(connection, now=None):
    """v24：单行保护状态；可重入（降级副本会重放迁移号），不重置既有状态。"""
    connection.execute(_SCHEMA)
    stamp = now or utc_now()
    connection.execute(
        """INSERT INTO source_risk(singleton, state, generation, backoff_step, since, updated_at)
        SELECT 1, 'normal', 0, 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM source_risk)""",
        (stamp, stamp),
    )


def migrate_observation(connection):
    """v26：观察期进度与人工探测登记，复用 `source_risk` 单行；可重入不重置状态。"""
    connection.execute(_SCHEMA)
    present = {row[1] for row in connection.execute("PRAGMA table_info(source_risk)")}
    for name, definition in _OBSERVATION_COLUMNS:
        if name not in present:
            connection.execute(f"ALTER TABLE source_risk ADD COLUMN {name} {definition}")


def format_epoch(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec="seconds")


def _epoch(value):
    """ISO 时间 → epoch 秒；缺失或不可解析返回 None（调用方按失败即关闭处理）。"""
    try:
        return epoch_from_iso(value)
    except (TypeError, ValueError):
        return None


def parse_retry_after(value, now=None):
    """合法 Retry-After → 等待秒数（向上取整）；缺失、非法或已过期返回 None。

    支持 delta-seconds 与 HTTP-date 两种合法形式。非法值不能当成“服务端要求 0 秒”，
    否则更短的本地期限会覆盖服务端要求。
    """
    if value is None or isinstance(value, bool):
        return None
    seconds = None
    if isinstance(value, (int, float)):
        seconds = float(value)
    elif isinstance(value, str):
        text = value.strip()
        if text.isdigit():
            seconds = float(int(text))
        elif text:
            try:
                parsed = parsedate_to_datetime(text)
            except (TypeError, ValueError, OverflowError):
                return None
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            try:
                reference = _epoch(now) if now is not None else datetime.now(timezone.utc).timestamp()
            except (TypeError, ValueError):
                reference = datetime.now(timezone.utc).timestamp()
            seconds = parsed.timestamp() - reference
    if seconds is None or not math.isfinite(seconds) or seconds < 0:
        return None
    return math.ceil(seconds)


def _deadline(now, seconds, retry_after=None):
    """本地档位期限与服务端 Retry-After 取更晚者；服务端要求不会被更短期限覆盖。"""
    total = float(seconds)
    if retry_after is not None:
        total = max(total, float(retry_after))
    return format_epoch(epoch_from_iso(now) + total)


def retry_after_seconds(next_probe_at, now=None):
    """未来截止时间的剩余秒数（向上取整）；已到期或缺失返回 None，不编造等待。"""
    if not next_probe_at:
        return None
    try:
        remaining = epoch_from_iso(next_probe_at) - epoch_from_iso(now or utc_now())
    except (TypeError, ValueError):
        return None
    return max(0, math.ceil(remaining)) or None


def paused_response(status, now=None):
    """503 契约：固定安全提示＋当前状态与可空探测时间；有未来截止时间才附 Retry-After。"""
    headers = {}
    remaining = retry_after_seconds(status["next_probe_at"], now)
    if remaining:
        headers["Retry-After"] = str(remaining)
    return error_response("SOURCE_RISK_PAUSED", details={
        "state": status["state"], "backoff_step": status["backoff_step"],
        "next_probe_at": status["next_probe_at"],
    }, headers=headers)


def public_status(row):
    """HTTP 与管理日志共用的形状：脱敏触发信息＋探测摘要＋观察／人工摘要。

    探测摘要按接口类型列出本轮状态（`pending`／`passed`／`failed`）；观察摘要给出已累计的
    活跃采集时间与成功请求数，人工摘要给出本轮人工态是否已登记探测，因此只读状态查询
    就能区分“待探测”“通过”“失败”“观察中”“稳定恢复”“人工待登记／已登记”，而不需要
    新增风控页面；返回形状不含 owner／租约令牌。
    """
    triggered = row["trigger_endpoint"] is not None
    return {
        "state": row["state"],
        "generation": row["generation"],
        "since": row["since"],
        "backoff_step": row["backoff_step"],
        "next_probe_at": row["next_probe_at"],
        "observing_since": row["observing_since"],
        "observation": {
            "since": row["observing_since"],
            "active_ms": row["observing_active_ms"] or 0,
            "successes": row["observing_successes"] or 0,
            "required_ms": OBSERVATION_MS,
        },
        "manual": {
            "probe_registered": (row["state"] == "manual"
                                 and row["probe_request_generation"] == row["generation"]),
        },
        "last_trigger": None if not triggered else {
            "endpoint_type": row["trigger_endpoint"],
            "http_status": row["trigger_status"],
            "at": row["trigger_at"],
        },
        "probe": {
            "round": row["probe_round_id"],
            "results": json.loads(row["probe_results"]) if row["probe_results"] else [],
        },
    }


class RiskGate:
    """共享 SQLite 上的发送许可：正常/观察态放行，保护态拒绝，迟到响应只合并一次。"""

    def __init__(self, store, clock=None):
        self.store = store
        # 受控时钟只替换“现在”，不替换持久状态；跨进程仍读同一份 SQLite。
        self.clock = clock
        self._logged = set()
        # 观察期的“确有成功业务请求”：只在本进程累积，由采集进程的心跳消费并落库。
        # API 进程不心跳，它的成功响应不会抵扣观察期（观察期只认正常采集）。
        self._source_successes = 0
        self._consumed_successes = 0

    def now(self):
        return self.clock.now() if self.clock is not None else utc_now()

    def _read(self):
        with self.store.connection() as connection:
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM source_risk WHERE singleton = 1").fetchone()
        if row is None:
            # 迁移保证单行存在；缺行说明库被改坏，按存储错误拒绝发送而不是当成 normal。
            raise sqlite3.OperationalError("Source risk state is missing")
        return row

    def status(self):
        return public_status(self._read())

    def _permit(self):
        row = self._read()
        if row["state"] in ACTIVE_STATES:
            return None
        status = public_status(row)
        self._log_once(("blocked", row["generation"]), "source_risk_blocked",
                       risk_state=status["state"], backoff_step=status["backoff_step"])
        return status

    def _record_trigger(self, request, status_code, retry_after=None):
        now = self.now()
        paused_seconds = parse_retry_after(retry_after, now)
        with write(self.store) as connection:
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM source_risk WHERE singleton = 1").fetchone()
            if row["state"] not in ACTIVE_STATES:
                # 一波迟到的风控响应只合并到同一状态代次，不推进档位、不延长期限。
                self._log_once(("merged", row["generation"]), "source_risk_late_response_merged",
                               risk_state=row["state"], backoff_step=row["backoff_step"])
                return public_status(row)
            previous_state = row["state"]
            if row["state"] == "observing" and row["backoff_step"] >= len(COOLDOWN_STEPS):
                # 第 6 档之后再次触发：转人工，不再无限回到自动探测。
                connection.execute(
                    """UPDATE source_risk SET state = 'manual', generation = generation + 1,
                    since = ?, next_probe_at = NULL, observing_since = NULL,
                    observing_active_ms = 0, observing_successes = 0,
                    trigger_endpoint = ?, trigger_status = ?, trigger_at = ?, probe_round_id = NULL,
                    probe_owner = NULL, probe_lease_until = NULL, probe_results = NULL,
                    updated_at = ? WHERE singleton = 1""",
                    (now, request.endpoint_type, status_code, now, now))
            else:
                step = 1 if row["state"] == "normal" else row["backoff_step"] + 1
                connection.execute(
                    """UPDATE source_risk SET state = 'cooldown', generation = generation + 1,
                    backoff_step = ?, since = ?, next_probe_at = ?, observing_since = NULL,
                    observing_active_ms = 0, observing_successes = 0,
                    trigger_endpoint = ?, trigger_status = ?, trigger_at = ?, probe_round_id = NULL,
                    probe_owner = NULL, probe_lease_until = NULL, probe_results = NULL,
                    updated_at = ? WHERE singleton = 1""",
                    (step, now, _deadline(now, COOLDOWN_STEPS[step - 1], paused_seconds),
                     request.endpoint_type, status_code, now, now))
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM source_risk WHERE singleton = 1").fetchone()
        status = public_status(row)
        self._transition("source_risk_triggered", previous_state, status,
                         endpoint_type=request.endpoint_type, http_status=status_code)
        if status["state"] == "manual":
            collector_event("source_risk_manual_wait", backoff_step=status["backoff_step"])
        return status

    def _log_once(self, key, event, **fields):
        """同一进程内同一原因只留一条固定日志：暂停期间不每 2.7 秒重复同一警告。"""
        if key in self._logged:
            return
        self._logged.add(key)
        collector_event(event, **fields)

    async def permit(self, request):
        status = await to_thread.run_sync(self._permit)
        if status is not None:
            raise SourceRiskPaused(status)

    async def report(self, request, report):
        """风控响应先落库再拒绝这次发送：当前调用链不再翻页、重试或补做预热。

        非风控结果（普通错误、业务码）原样返回，不改变既有分类；正常 HTTP 响应在本进程
        记一次“成功业务请求”，供观察期心跳判断这段时间是否真有采集，而不是空转。
        """
        if (report.status_code in SUCCESS_STATUSES
                and request.endpoint_type not in NON_BUSINESS_TYPES):
            self._source_successes += 1
        if report.status_code not in TRIGGER_STATUSES:
            return
        retry_after = getattr(report, "retry_after", None)
        status = await to_thread.run_sync(self._record_trigger, request, report.status_code, retry_after)
        raise SourceRiskPaused(status)

    async def pause(self):
        """只读快照：调度层据此跳过本轮派发，不当作许可或恢复依据。"""
        status = await to_thread.run_sync(self.status)
        return None if status["state"] in ACTIVE_STATES else status

    async def snapshot(self):
        """完整只读状态：调度层据此决定是否到期探测、是否恢复在途中止的工作。"""
        return await to_thread.run_sync(self.status)

    # ---- 恢复观察期：只按成功业务请求的活跃时间累计，满 10 分钟才清零档位 ----

    def _observing_tick(self, elapsed_seconds, successful):
        """观察心跳：本区间确有成功业务请求才累计活跃时间，满 10 分钟回 normal。

        活跃时间只由采集进程按自己的节拍提交，且每区间最多计入一个节拍的时长；
        空闲、普通失败、停机与重启都不抵扣，重启由 `restart_observation` 重新累计。
        """
        elapsed_ms = max(0, min(int(round(float(elapsed_seconds) * 1000)), OBSERVATION_MS))
        now = self.now()
        with write(self.store) as connection:
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM source_risk WHERE singleton = 1").fetchone()
            if row["state"] != "observing":
                # 不在观察期（稳定、冷却、探测或人工）：心跳不写任何状态。
                return None
            active = row["observing_active_ms"] or 0
            successes = row["observing_successes"] or 0
            if successful and elapsed_ms:
                active = min(active + elapsed_ms, OBSERVATION_MS)
                successes += 1
            cleared = active >= OBSERVATION_MS and successes > 0
            if cleared:
                # 稳定恢复：回到 normal 并清零档位；只 +1 代次，不额外发业务通知。
                connection.execute(
                    """UPDATE source_risk SET state = 'normal', generation = generation + 1,
                    backoff_step = 0, since = ?, next_probe_at = NULL, observing_since = NULL,
                    observing_active_ms = 0, observing_successes = 0, updated_at = ?
                    WHERE singleton = 1""",
                    (now, now))
            else:
                connection.execute(
                    """UPDATE source_risk SET observing_active_ms = ?, observing_successes = ?,
                    updated_at = ? WHERE singleton = 1""",
                    (active, successes, now))
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM source_risk WHERE singleton = 1").fetchone()
        status = public_status(row)
        if cleared:
            self._transition("source_risk_observation_cleared", "observing", status,
                             observing_ms=active, successes=successes)
        return status

    async def observing_tick(self, elapsed_seconds):
        """采集进程的观察心跳：返回最新公开状态；不在观察期时返回 None。"""
        seen = self._source_successes
        successful = seen > self._consumed_successes
        self._consumed_successes = seen
        return await to_thread.run_sync(self._observing_tick, elapsed_seconds, successful)

    def _restart_observation(self):
        """进程重启：保留档位与人工态，观察时间重新累计（停机不抵扣）。"""
        now = self.now()
        with write(self.store) as connection:
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM source_risk WHERE singleton = 1").fetchone()
            if row["state"] != "observing":
                return None
            connection.execute(
                """UPDATE source_risk SET observing_since = ?, observing_active_ms = 0,
                observing_successes = 0, updated_at = ? WHERE singleton = 1""",
                (now, now))
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM source_risk WHERE singleton = 1").fetchone()
        status = public_status(row)
        self._transition("source_risk_observation_restarted", "observing", status)
        return status

    async def restart_observation(self):
        """采集进程启动时调用：观察态重新累计，其它状态原样不动。"""
        self._consumed_successes = self._source_successes
        return await to_thread.run_sync(self._restart_observation)

    def _transition(self, event, previous_state, status, **fields):
        """统一的状态转移日志：带前态、新态、代次、档位与探测轮次，便于跨重启串联。

        只记已提交的转移（在事务外调用），不输出 owner／租约；09 的告警登记可在各自
        的短事务内复用同一批转移事实，而不必重读或重现猜测状态。
        """
        collector_event(event, previous_state=previous_state, risk_state=status["state"],
                        risk_generation=status["generation"],
                        backoff_step=status["backoff_step"],
                        probe_round_id=correlation_id(status["probe"]["round"])
                        if status["probe"]["round"] else None,
                        **fields)
        return status

    # ---- 探测轮次：唯一 owner 租约、冻结类型、结果与短路 ----

    def _request_probe(self):
        """人工态登记一轮探测：绑定当前人工态代次，重复登记幂等。

        只落一条“已登记”事实，不执行探测、不改档位与截止时间，也不清零任何状态；
        采集进程未运行时登记会一直保留，直到被唯一 owner 领取。
        """
        now = self.now()
        with write(self.store) as connection:
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM source_risk WHERE singleton = 1").fetchone()
            if row["state"] != "manual":
                # 冷却未到期、正在探测、普通／观察态都不能借这个入口提前请求。
                return None
            registered = row["probe_request_generation"] != row["generation"]
            if registered:
                connection.execute(
                    "UPDATE source_risk SET probe_request_generation = ?, updated_at = ? "
                    "WHERE singleton = 1", (row["generation"], now))
                row = connection.execute(
                    f"SELECT {_COLUMNS} FROM source_risk WHERE singleton = 1").fetchone()
        status = public_status(row)
        if registered:
            self._transition("source_risk_manual_probe_registered", "manual", status)
        return status

    async def request_probe(self):
        """登记人工探测；当前状态不允许时返回 None（调用方映射固定 409）。"""
        return await to_thread.run_sync(self._request_probe)

    def _claim_probe(self, endpoint_types):
        now = self.now()
        types = [kind for kind in endpoint_types]
        if not types:
            # 没有可验证类型就不可能确认恢复；宁可保持暂停，也不伪造“全部通过”。
            return None
        with write(self.store) as connection:
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM source_risk WHERE singleton = 1").fetchone()
            state = row["state"]
            if state not in ("cooldown", "probing", "manual"):
                return None
            if state == "cooldown":
                deadline = _epoch(row["next_probe_at"])
                # 期限缺失/不可解析按“未到期”处理：时间异常不能绕过暂停。
                if deadline is None or _epoch(now) < deadline:
                    return None
                origin = "cooldown"
            elif state == "manual":
                # 人工态只执行已经登记的那一轮：登记要绑在当前人工态代次上。
                if row["probe_request_generation"] != row["generation"]:
                    return None
                origin = "manual"
            else:
                if not self._lease_expired(row["probe_lease_until"], now):
                    # 仍在租约内的 owner 不允许被接管：不能同时探测。
                    return None
                # 接管保留本轮来源：人工轮失败仍回人工态，不顺带降为自动冷却。
                origin = row["probe_origin"] or "cooldown"
            owner = uuid4().hex
            # 轮次是纯数字诊断关联号：可进日志白名单，且与内部领取令牌（owner）分开。
            round_id = str(uuid4().int)
            results = [{"endpoint_type": kind, "status": "pending"} for kind in types]
            connection.execute(
                """UPDATE source_risk SET state = 'probing', generation = generation + 1,
                next_probe_at = NULL, observing_since = NULL, probe_round_id = ?,
                probe_owner = ?, probe_lease_until = ?, probe_results = ?, probe_origin = ?,
                probe_request_generation = NULL, updated_at = ?
                WHERE singleton = 1""",
                (round_id, owner, format_epoch(epoch_from_iso(now) + PROBE_LEASE_SECONDS),
                 json.dumps(results, ensure_ascii=False), origin, now))
        collector_event("risk_probe_claimed", endpoint_types=len(types), probe_origin=origin,
                        probe_round_id=correlation_id(round_id), backoff_step=row["backoff_step"])
        return {"round": round_id, "owner": owner, "types": types, "origin": origin}

    def _lease_expired(self, lease_until, now):
        deadline = _epoch(lease_until)
        if deadline is None:
            # 没有可读租约说明 owner 已不可信：允许接管，但接管仍要重新探测通过。
            return True
        return _epoch(now) >= deadline

    @staticmethod
    def _owns(row, claim):
        return (row["state"] == "probing"
                and row["probe_round_id"] == claim["round"]
                and row["probe_owner"] == claim["owner"])

    def _record_probe(self, claim, result):
        with write(self.store) as connection:
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM source_risk WHERE singleton = 1").fetchone()
            if not self._owns(row, claim):
                # 旧 owner／旧轮次不能提交结果：接管后由新 owner 重新确认本轮类型。
                return False
            results, replaced = [], False
            for entry in json.loads(row["probe_results"] or "[]"):
                if entry.get("endpoint_type") == result["endpoint_type"]:
                    results.append({**entry, **result})
                    replaced = True
                else:
                    results.append(entry)
            if not replaced:
                return False
            connection.execute("UPDATE source_risk SET probe_results = ?, updated_at = ? "
                               "WHERE singleton = 1",
                               (json.dumps(results, ensure_ascii=False), self.now()))
            return True

    def _finish_probe(self, claim, passed, retry_after=None):
        now = self.now()
        paused_seconds = parse_retry_after(retry_after, now)
        with write(self.store) as connection:
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM source_risk WHERE singleton = 1").fetchone()
            if not self._owns(row, claim):
                return None
            origin = row["probe_origin"] or "cooldown"
            if passed:
                # 全部接口通过：进入观察期，档位保留到稳定恢复才清零。
                connection.execute(
                    """UPDATE source_risk SET state = 'observing', generation = generation + 1,
                    since = ?, next_probe_at = NULL, observing_since = ?,
                    observing_active_ms = 0, observing_successes = 0,
                    probe_owner = NULL, probe_lease_until = NULL, probe_origin = NULL,
                    updated_at = ? WHERE singleton = 1""",
                    (now, now, now))
            elif origin == "manual" or row["backoff_step"] >= len(COOLDOWN_STEPS):
                # 人工轮失败仍保持人工态，不自动重试也不回退档位。
                connection.execute(
                    """UPDATE source_risk SET state = 'manual', generation = generation + 1,
                    since = ?, next_probe_at = NULL, observing_since = NULL,
                    probe_owner = NULL, probe_lease_until = NULL, probe_origin = NULL,
                    updated_at = ? WHERE singleton = 1""",
                    (now, now))
            else:
                connection.execute(
                    """UPDATE source_risk SET state = 'cooldown', generation = generation + 1,
                    backoff_step = backoff_step + 1, since = ?, next_probe_at = ?,
                    observing_since = NULL, probe_owner = NULL, probe_lease_until = NULL,
                    probe_origin = NULL, updated_at = ? WHERE singleton = 1""",
                    (now, _deadline(now, COOLDOWN_STEPS[row["backoff_step"]], paused_seconds), now))
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM source_risk WHERE singleton = 1").fetchone()
        status = public_status(row)
        collector_event("risk_probe_round_finished", passed=passed, probe_origin=origin,
                        risk_state=status["state"], backoff_step=status["backoff_step"],
                        probe_round_id=correlation_id(claim["round"]),
                        next_probe_in_s=retry_after_seconds(status["next_probe_at"], now) or 0)
        if status["state"] == "manual":
            collector_event("source_risk_manual_wait", backoff_step=status["backoff_step"])
        elif status["state"] == "observing":
            self._transition("source_risk_observing", "probing", status)
        return status

    async def claim_probe(self, endpoint_types):
        """到期或可接管时领取唯一探测轮次；写入冻结类型、owner 与租约。"""
        return await to_thread.run_sync(self._claim_probe, list(endpoint_types))

    async def record_probe(self, claim, result):
        """提交一类接口的探测结果；owner/轮次不匹配（旧 owner）返回 False。"""
        return await to_thread.run_sync(self._record_probe, claim, result)

    async def finish_probe(self, claim, passed, retry_after=None):
        """结束本轮：全部通过进 observing，否则只推进一档（第六档转 manual）。"""
        return await to_thread.run_sync(self._finish_probe, claim, passed, retry_after)
