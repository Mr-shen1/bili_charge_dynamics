"""跨进程的 B 站源保护状态：HTTP 412／429 触发全局暂停，API 与采集共用 SQLite。

本模块是 `source_gate.SourceGate` 的持久实现，接在 01 建立的同一 Interface 上：
`permit` 在发送前核验共享状态并拒绝，`report` 在返回后只合并风控响应。状态、状态代次、
退避档位、进入时间、下次探测时间、触发接口与探测 owner 租约都在同一个短事务里落库，
不按 UP 或动态拆开，也不使用进程内对象冒充全局保护。

本票只实现「触发 → 第 1 档冷却 → 拒绝新发送」：六档到期探测（04）与观察期／人工恢复
（05）复用这里的字段与代次语义，不改表结构。冷却到期不会自动放行，也没有强制解锁入口。
"""

import json
import math
import sqlite3
from datetime import datetime, timezone

from anyio import to_thread

from .collector_logging import collector_event
from .comment_status import epoch_from_iso, utc_now
from .contracts import error_response
from .transaction import write


# 触发分类只有真实上游 HTTP 状态；业务码 -412／-352 与网络失败不在其中。
TRIGGER_STATUSES = frozenset({412, 429})
# 冷却阶梯（秒）：每档到期执行一轮探测，本票只进入第 1 档。
COOLDOWN_STEPS = (60, 120, 240, 480, 900, 1800)

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
            "trigger_endpoint, trigger_status, trigger_at, probe_round_id, probe_results")


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


def retry_after_seconds(next_probe_at, now=None):
    """未来截止时间的剩余秒数（向上取整）；已到期或缺失返回 None，不编造等待。"""
    if not next_probe_at:
        return None
    try:
        remaining = epoch_from_iso(next_probe_at) - epoch_from_iso(now or utc_now())
    except (TypeError, ValueError):
        return None
    return max(0, math.ceil(remaining)) or None


def paused_response(status):
    """503 契约：固定安全提示＋当前状态与可空探测时间；有未来截止时间才附 Retry-After。"""
    headers = {}
    remaining = retry_after_seconds(status["next_probe_at"])
    if remaining:
        headers["Retry-After"] = str(remaining)
    return error_response("SOURCE_RISK_PAUSED", details={
        "state": status["state"], "backoff_step": status["backoff_step"],
        "next_probe_at": status["next_probe_at"],
    }, headers=headers)


def public_status(row):
    """HTTP 与管理日志共用的形状：脱敏触发信息＋探测摘要，不含 owner／租约令牌。"""
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
    """共享 SQLite 上的发送许可：正常态放行，保护态拒绝，迟到响应只合并一次。"""

    def __init__(self, store):
        self.store = store
        self._logged = set()

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
        if row["state"] == "normal":
            return None
        status = public_status(row)
        self._log_once(("blocked", row["generation"]), "source_risk_blocked",
                       risk_state=status["state"], backoff_step=status["backoff_step"])
        return status

    def _record_trigger(self, request, status_code):
        now = utc_now()
        with write(self.store) as connection:
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM source_risk WHERE singleton = 1").fetchone()
            if row["state"] != "normal":
                # 一波迟到的风控响应只合并到同一状态代次，不推进档位、不延长期限。
                self._log_once(("merged", row["generation"]), "source_risk_late_response_merged",
                               risk_state=row["state"], backoff_step=row["backoff_step"])
                return public_status(row)
            connection.execute(
                """UPDATE source_risk SET state = 'cooldown', generation = generation + 1,
                backoff_step = 1, since = ?, next_probe_at = ?, observing_since = NULL,
                trigger_endpoint = ?, trigger_status = ?, trigger_at = ?, probe_round_id = NULL,
                probe_owner = NULL, probe_lease_until = NULL, probe_results = NULL, updated_at = ?
                WHERE singleton = 1""",
                (now, format_epoch(epoch_from_iso(now) + COOLDOWN_STEPS[0]),
                 request.endpoint_type, status_code, now, now),
            )
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM source_risk WHERE singleton = 1").fetchone()
        status = public_status(row)
        collector_event("source_risk_triggered", endpoint_type=request.endpoint_type,
                        http_status=status_code, backoff_step=status["backoff_step"],
                        risk_state=status["state"])
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
        status = await to_thread.run_sync(self._record_trigger, request, report.status_code)
        raise SourceRiskPaused(status)

    async def pause(self):
        """只读快照：调度层据此跳过本轮派发，不当作许可或恢复依据。"""
        status = await to_thread.run_sync(self.status)
        return None if status["state"] == "normal" else status
