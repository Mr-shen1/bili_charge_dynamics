"""按 UP 保存发现尝试；最近可信结果原子发布为近期窗口，不修改归档。"""

import json
from uuid import uuid4

from .comment_status import utc_now

from .checks import alert_epoch, record_alerts
from .contracts import APIError
from .selection import refresh_selections


class DiscoveryStore:
    def enabled_recent(self):
        with self.connection() as connection:
            return [dict(row) for row in connection.execute(
                "SELECT uid FROM monitors WHERE enabled = 1 AND mode = 'recent' ORDER BY uid COLLATE BINARY"
            )]

    def claim_discovery(self, uid, now):
        with self.connection() as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            monitor = connection.execute(
                "SELECT recent_n FROM monitors WHERE uid = ? AND mode = 'recent' AND enabled = 1", (uid,)
            ).fetchone()
            row = connection.execute("SELECT status FROM recent_discoveries WHERE uid = ?", (uid,)).fetchone()
            if monitor is None or row and row["status"] == "running":
                return None
            token = uuid4().hex
            attempt = {"recent_n": monitor["recent_n"], "started_at": now,
                       "finished_at": None, "ids": [], "error": None}
            connection.execute(
                """INSERT INTO recent_discoveries(uid, status, attempt, claim_token)
                VALUES (?, 'running', ?, ?) ON CONFLICT(uid) DO UPDATE SET
                status = 'running', attempt = excluded.attempt, claim_token = excluded.claim_token""",
                (uid, json.dumps(attempt), token),
            )
            return {"token": token, "recent_n": monitor["recent_n"]}

    def discovery_claim_active(self, uid, token):
        with self.connection() as connection:
            return self._active_discovery(connection, uid, token) is not None

    def _active_discovery(self, connection, uid, token):
        return connection.execute(
            """SELECT d.attempt FROM recent_discoveries d JOIN monitors m ON m.uid = d.uid
            WHERE d.uid = ? AND d.claim_token = ? AND d.status = 'running'
            AND m.mode = 'recent' AND m.enabled = 1
            AND m.recent_n = json_extract(d.attempt, '$.recent_n')""", (uid, token)
        ).fetchone()

    def record_discovery_progress(self, uid, token, ids):
        with self.connection() as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            row = self._active_discovery(connection, uid, token)
            if row is None:
                return False
            attempt = json.loads(row["attempt"])
            attempt["ids"] = ids
            connection.execute("UPDATE recent_discoveries SET attempt = ? WHERE uid = ?",
                               (json.dumps(attempt), uid))
            return True

    def finish_discovery(self, uid, token, result, now, error=None, alerts=()):
        with self.connection() as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            row = self._active_discovery(connection, uid, token)
            if row is None:
                return False
            attempt = json.loads(row["attempt"])
            attempt.update(finished_at=now, error=error)
            trusted = None
            if result is not None:
                attempt["ids"] = result["ids"]
                trusted = json.dumps({**result, "recent_n": attempt["recent_n"], "discovered_at": now})
            connection.execute(
                """UPDATE recent_discoveries SET status = ?, attempt = ?, claim_token = NULL,
                trusted_result = COALESCE(?, trusted_result) WHERE uid = ?""",
                ("discovered" if trusted is not None else "failed", json.dumps(attempt), trusted, uid),
            )
            if trusted is not None:
                refresh_selections(connection, uid)
            # 发现阶段的真实失败与尝试结果同事务登记告警；成功耗尽不告警。
            epoch = alert_epoch(now) if alerts else None
            if epoch is not None:
                record_alerts(connection, alerts, epoch)
            return True

    def stop_discovery(self, connection, uid):
        # 与配置变更同事务；旧尝试不能在停用后复活或提交到重建配置。
        connection.execute(
            """UPDATE recent_discoveries SET status = 'failed', claim_token = NULL,
            attempt = json_set(attempt, '$.error', 'DISCOVERY_STOPPED', '$.finished_at', ?)
            WHERE uid = ? AND status = 'running'""", (utc_now(), uid)
        )

    def recover_discoveries(self, now):
        # 仅取得采集进程锁后调用；API 重开不擅自恢复在途任务。
        with self.connection() as connection:
            connection.execute(
                """UPDATE recent_discoveries SET status = 'failed', claim_token = NULL,
                attempt = json_set(attempt, '$.error', 'DISCOVERY_INTERRUPTED', '$.finished_at', ?)
                WHERE status = 'running'""", (now,)
            )

    def read_discovery(self, uid):
        with self.connection() as connection:
            row = connection.execute(
                """SELECT m.mode, m.recent_n, m.enabled, d.status, d.attempt, d.trusted_result
                FROM identities i LEFT JOIN monitors m ON m.uid = i.uid
                LEFT JOIN recent_discoveries d ON d.uid = i.uid WHERE i.uid = ?""", (uid,)
            ).fetchone()
        if row is None:
            raise APIError("NOT_FOUND")
        active = row["mode"] == "recent" and bool(row["enabled"])
        status = row["status"] or "undiscovered"
        trusted = json.loads(row["trusted_result"]) if row["trusted_result"] else None
        return {
            "uid": uid, "mode": row["mode"], "recent_n": row["recent_n"],
            "enabled": bool(row["enabled"]), "active": active, "status": status,
            "attempt": json.loads(row["attempt"]) if row["attempt"] else None,
            "trusted_result": trusted,
            "current_ids": trusted["ids"] if active and trusted is not None else [],
            "retryable": active and status != "running" and (
                status != "discovered" or trusted["recent_n"] != row["recent_n"]),
            "incomplete": status != "discovered" or trusted is None or trusted["recent_n"] != row["recent_n"],
        }
