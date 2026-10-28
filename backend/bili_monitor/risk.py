"""跨进程的 B 站源保护状态：HTTP 412／429 触发全局暂停，API 与采集共用 SQLite。

本模块是 `source_gate.SourceGate` 的持久实现，接在 01 建立的同一 Interface 上：
`permit` 在发送前核验共享状态并拒绝，`report` 在返回后合并风控响应。状态、状态代次、
退避档位、进入时间、下次探测时间、触发接口与探测 owner 租约都在同一个短事务里落库，
不按 UP 或动态拆开，也不使用进程内对象冒充全局保护。

状态机（正式设计 §4）：`normal` → `cooldown`（六档 1／2／4／8／15／30 分钟）→ 到期
由唯一 owner 领取 `probing` 并按接口类型串行探测 → 全部通过进 `observing`（保留档位，
观察窗口由 05 清零）／任一轮失败只推进一档、第六档失败转 `manual`。合法 Retry-After
只会把本地期限推后，不会被更短的档位等待覆盖；档位、期限与人工态随库持久，重启后
不能凭时间流逝自动放行。
"""

import json
import math
import sqlite3
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from uuid import uuid4

from anyio import to_thread

from .collector_logging import collector_event
from .comment_status import epoch_from_iso, utc_now
from .contracts import error_response
from .transaction import write


# 触发分类只有真实上游 HTTP 状态；业务码 -412／-352 与网络失败不在其中。
TRIGGER_STATUSES = frozenset({412, 429})
# 冷却阶梯（秒）：每档到期执行一轮探测，任一轮未通过只推进一档。
COOLDOWN_STEPS = (60, 120, 240, 480, 900, 1800)
# 探测 owner 租约：崩溃后必须等它过期才能接管，旧 owner 也不能再提交结果。
PROBE_LEASE_SECONDS = 300
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
    updated_at TEXT NOT NULL
)"""

_COLUMNS = ("state, generation, backoff_step, since, next_probe_at, observing_since, "
            "trigger_endpoint, trigger_status, trigger_at, probe_round_id, probe_owner, "
            "probe_lease_until, probe_results")


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
    """HTTP 与管理日志共用的形状：脱敏触发信息＋探测摘要，不含 owner／租约令牌。

    探测摘要按接口类型列出本轮状态（`pending`／`passed`／`failed`），因此只读状态查询
    就能区分“待探测”“通过”“失败”和下一档时间，而不需要新增风控页面。
    """
    triggered = row["trigger_endpoint"] is not None
    return {
        "state": row["state"],
        "generation": row["generation"],
        "since": row["since"],
        "backoff_step": row["backoff_step"],
        "next_probe_at": row["next_probe_at"],
        "observing_since": row["observing_since"],
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
            if row["state"] == "observing" and row["backoff_step"] >= len(COOLDOWN_STEPS):
                # 第 6 档之后再次触发：转人工，不再无限回到自动探测。
                connection.execute(
                    """UPDATE source_risk SET state = 'manual', generation = generation + 1,
                    since = ?, next_probe_at = NULL, observing_since = NULL,
                    trigger_endpoint = ?, trigger_status = ?, trigger_at = ?, probe_round_id = NULL,
                    probe_owner = NULL, probe_lease_until = NULL, probe_results = NULL,
                    updated_at = ? WHERE singleton = 1""",
                    (now, request.endpoint_type, status_code, now, now))
            else:
                step = 1 if row["state"] == "normal" else row["backoff_step"] + 1
                connection.execute(
                    """UPDATE source_risk SET state = 'cooldown', generation = generation + 1,
                    backoff_step = ?, since = ?, next_probe_at = ?, observing_since = NULL,
                    trigger_endpoint = ?, trigger_status = ?, trigger_at = ?, probe_round_id = NULL,
                    probe_owner = NULL, probe_lease_until = NULL, probe_results = NULL,
                    updated_at = ? WHERE singleton = 1""",
                    (step, now, _deadline(now, COOLDOWN_STEPS[step - 1], paused_seconds),
                     request.endpoint_type, status_code, now, now))
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM source_risk WHERE singleton = 1").fetchone()
        status = public_status(row)
        collector_event("source_risk_triggered", endpoint_type=request.endpoint_type,
                        http_status=status_code, backoff_step=status["backoff_step"],
                        risk_state=status["state"])
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

        非风控结果（普通错误、业务码）原样返回，不改变既有分类。
        """
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

    # ---- 探测轮次：唯一 owner 租约、冻结类型、结果与短路 ----

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
            if state not in ("cooldown", "probing"):
                return None
            if state == "cooldown":
                deadline = _epoch(row["next_probe_at"])
                # 期限缺失/不可解析按“未到期”处理：时间异常不能绕过暂停。
                if deadline is None or _epoch(now) < deadline:
                    return None
            elif not self._lease_expired(row["probe_lease_until"], now):
                # 仍在租约内的 owner 不允许被接管：不能同时探测。
                return None
            owner = uuid4().hex
            # 轮次是纯数字诊断关联号：可进日志白名单，且与内部领取令牌（owner）分开。
            round_id = str(uuid4().int)
            results = [{"endpoint_type": kind, "status": "pending"} for kind in types]
            connection.execute(
                """UPDATE source_risk SET state = 'probing', generation = generation + 1,
                next_probe_at = NULL, observing_since = NULL, probe_round_id = ?,
                probe_owner = ?, probe_lease_until = ?, probe_results = ?, updated_at = ?
                WHERE singleton = 1""",
                (round_id, owner, format_epoch(epoch_from_iso(now) + PROBE_LEASE_SECONDS),
                 json.dumps(results, ensure_ascii=False), now))
        return {"round": round_id, "owner": owner, "types": types}

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
            if passed:
                connection.execute(
                    """UPDATE source_risk SET state = 'observing', generation = generation + 1,
                    since = ?, next_probe_at = NULL, observing_since = ?, probe_owner = NULL,
                    probe_lease_until = NULL, updated_at = ? WHERE singleton = 1""",
                    (now, now, now))
            elif row["backoff_step"] >= len(COOLDOWN_STEPS):
                connection.execute(
                    """UPDATE source_risk SET state = 'manual', generation = generation + 1,
                    since = ?, next_probe_at = NULL, observing_since = NULL, probe_owner = NULL,
                    probe_lease_until = NULL, updated_at = ? WHERE singleton = 1""",
                    (now, now))
            else:
                connection.execute(
                    """UPDATE source_risk SET state = 'cooldown', generation = generation + 1,
                    backoff_step = backoff_step + 1, since = ?, next_probe_at = ?,
                    observing_since = NULL, probe_owner = NULL, probe_lease_until = NULL,
                    updated_at = ? WHERE singleton = 1""",
                    (now, _deadline(now, COOLDOWN_STEPS[row["backoff_step"]], paused_seconds), now))
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM source_risk WHERE singleton = 1").fetchone()
        status = public_status(row)
        collector_event("risk_probe_round_finished", passed=passed, risk_state=status["state"],
                        backoff_step=status["backoff_step"],
                        next_probe_in_s=retry_after_seconds(status["next_probe_at"], now) or 0)
        if status["state"] == "manual":
            collector_event("source_risk_manual_wait", backoff_step=status["backoff_step"])
        elif status["state"] == "observing":
            collector_event("source_risk_observing", backoff_step=status["backoff_step"])
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
