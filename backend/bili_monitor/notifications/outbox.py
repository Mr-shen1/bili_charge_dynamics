"""事务发件箱：归档事务内登记通知事实，投递进程按索引领取到期记录。

本模块不打开连接、不提交事务、不执行网络 I/O：调用者已经持有写事务，
内容与事件、投递记录必须同时提交或同时回滚。

不变量：
- 通知阶段（`notification_phases`）是自有身份，不等于入选令牌：`reset=True`
  会轮换全部入选令牌（含持续入选的目标），阶段必须续存、不能重设基线。
- 目标退出入选即封存阶段；只有「未封存阶段 + 当次正文领取代次」同时成立，
  归档提交才能登记事件。重新入选建立新阶段，旧在途执行无法借新阶段发通知。
- `archives.generation` 是内容写围栏（每次领取 +1），不是阶段身份。
- 正文事件按动态 + 已成功取得的可信版本去重（`notification_versions`），
  跨重启、重复扫描与重新入选都有效。
- 已入队的事件与目标投递记录不随监控配置级联删除。
- 消息快照在取得资格时冻结；投递与重试不读取最新归档。
- 心跳按北京时间小时时段（`notification_heartbeats.slot`）去重，有效期写到该投递
  记录的 `expires_at`；领取前先丢弃过期心跳，业务记录的 `expires_at` 永远是 NULL。
"""

import json
import time
from uuid import uuid4

DYNAMIC_CHANGED = "dynamic_changed"
HEARTBEAT = "heartbeat"
UP_ROLE = "up"
SYSTEM_ROLE = "system"

# 投递状态：等待配置、到期待投、已领取（带租约）、已成功、已过期（心跳专用）。
WAITING_CONFIG = "waiting_config"
PENDING = "pending"
INFLIGHT = "inflight"
SENT = "sent"
EXPIRED = "expired"


def migrate(connection):
    # 旧库降级副本可能已带有通知表（既有测试会重放旧迁移号），建表必须可重入。
    connection.execute("""CREATE TABLE IF NOT EXISTS notification_phases (
        token TEXT PRIMARY KEY,
        uid TEXT NOT NULL,
        dynamic_id TEXT NOT NULL,
        started_at REAL NOT NULL,
        baseline_version TEXT,
        sealed INTEGER NOT NULL DEFAULT 0
    )""")
    connection.execute("CREATE INDEX IF NOT EXISTS notification_phase_target ON notification_phases(uid, dynamic_id)")
    connection.execute("""CREATE TABLE IF NOT EXISTS notification_body_claims (
        dynamic_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, phase TEXT NOT NULL
    )""")
    connection.execute("""CREATE TABLE IF NOT EXISTS notification_versions (
        dynamic_id TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(dynamic_id, version)
    )""")
    connection.execute("""CREATE TABLE IF NOT EXISTS notification_events (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        uid TEXT NOT NULL,
        dynamic_id TEXT NOT NULL,
        version TEXT,
        snapshot TEXT NOT NULL,
        created_at REAL NOT NULL,
        UNIQUE(kind, dynamic_id, version)
    )""")
    connection.execute("""CREATE TABLE IF NOT EXISTS notification_deliveries (
        id INTEGER PRIMARY KEY,
        event_id INTEGER NOT NULL REFERENCES notification_events(id),
        role TEXT NOT NULL,
        state TEXT NOT NULL,
        due_at REAL NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        token TEXT,
        lease_until REAL,
        error TEXT,
        sent_at REAL,
        UNIQUE(event_id, role)
    )""")
    # 心跳有效期：只有心跳记录写入该列；业务消息保持 NULL，不套用过期丢弃规则。
    columns = {row[1] for row in connection.execute("PRAGMA table_info(notification_deliveries)")}
    if "expires_at" not in columns:
        connection.execute("ALTER TABLE notification_deliveries ADD COLUMN expires_at REAL")
    connection.execute("CREATE INDEX IF NOT EXISTS notification_due ON notification_deliveries(state, due_at)")
    connection.execute("CREATE INDEX IF NOT EXISTS notification_lease ON notification_deliveries(state, lease_until)")
    # 心跳时段身份：`slot` 是北京时间的 `YYYY-MM-DDTHH`，主键即「每小时最多一次」的持久依据。
    connection.execute("""CREATE TABLE IF NOT EXISTS notification_heartbeats (
        slot TEXT PRIMARY KEY,
        generated_at REAL NOT NULL,
        expires_at REAL NOT NULL,
        event_id INTEGER
    )""")
    for row in connection.execute("SELECT uid, id, token FROM target_selections").fetchall():
        activate(connection, row["uid"], row["id"], row["token"])


def has_schema(connection):
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notification_phases'").fetchone() is not None


def activate(connection, uid, id, token):
    """开始通知阶段：首次启用复用已有可信版本，重新入选从下一份可信正文重建基线。

    `token` 是本次入选令牌，仅用于证明「此刻仍入选」；阶段身份由阶段自身令牌承担，
    所以持续入选时的令牌轮换（reset）不会开出新阶段、不会重设基线。
    """
    active = connection.execute(
        "SELECT 1 FROM notification_phases WHERE uid = ? AND dynamic_id = ? AND sealed = 0 LIMIT 1",
        (uid, id)).fetchone()
    if active is not None:
        return
    previous = connection.execute(
        "SELECT 1 FROM notification_phases WHERE uid = ? AND dynamic_id = ? LIMIT 1", (uid, id)).fetchone()
    baseline = None
    if previous is None:
        row = connection.execute("SELECT document FROM archives WHERE id = ? AND uid = ?", (id, uid)).fetchone()
        if row is not None:
            document = json.loads(row["document"])
            if document.get("content_state") == "success":
                baseline = document.get("synced_version")
    connection.execute(
        "INSERT INTO notification_phases(token, uid, dynamic_id, started_at, baseline_version) "
        "VALUES (?, ?, ?, ?, ?)", (token, uid, id, time.time(), baseline))
    if baseline is not None:
        connection.execute("INSERT OR IGNORE INTO notification_versions VALUES (?, ?)", (id, baseline))


def retire(connection, uid, id):
    """目标不再入选：封存当前阶段；已入队事件与投递记录保留。"""
    connection.execute(
        "UPDATE notification_phases SET sealed = 1 WHERE uid = ? AND dynamic_id = ? AND sealed = 0", (uid, id))


def claim_body(connection, uid, id, generation):
    """在正文领取事务里绑定该次执行与当前未封存阶段。

    领取时记录阶段身份，提交时不再重新推导：目标停止后即使仍在途也无阶段可挂。
    """
    phase = connection.execute("""SELECT p.token FROM notification_phases p
        JOIN target_selections s ON s.uid = p.uid AND s.id = p.dynamic_id
        WHERE p.uid = ? AND p.dynamic_id = ? AND p.sealed = 0
        ORDER BY p.started_at DESC LIMIT 1""", (uid, id)).fetchone()
    if phase is None:
        return
    connection.execute("""INSERT INTO notification_body_claims(dynamic_id, generation, phase) VALUES (?, ?, ?)
        ON CONFLICT(dynamic_id) DO UPDATE SET generation = excluded.generation, phase = excluded.phase""",
                       (id, generation, phase["token"]))


def _active_phase(connection, id, generation):
    """提交时核验：同一写代次 + 领取时绑定的阶段仍有效 + 目标此刻仍入选。"""
    return connection.execute("""SELECT p.token, p.baseline_version FROM notification_phases p
        JOIN target_selections s ON s.uid = p.uid AND s.id = p.dynamic_id
        JOIN notification_body_claims c ON c.phase = p.token AND c.dynamic_id = p.dynamic_id
        WHERE c.dynamic_id = ? AND c.generation = ? AND p.sealed = 0""", (id, generation)).fetchone()


def record_body(connection, id, generation, document, version):
    """正文实际成功归档时调用：建立基线或登记事件，与正文同事务提交。"""
    if version is None:
        return
    phase = _active_phase(connection, id, generation)
    if phase is None:
        return
    first_seen = connection.execute("INSERT OR IGNORE INTO notification_versions VALUES (?, ?)",
                                    (id, version)).rowcount == 1
    baseline = phase["baseline_version"]
    if baseline is not None and baseline != version and first_seen:
        uid = connection.execute("SELECT uid FROM archives WHERE id = ?", (id,)).fetchone()[0]
        snapshot = {"dynamic_id": id, "title": document.get("title")}
        event = connection.execute("""INSERT INTO notification_events
            (kind, uid, dynamic_id, version, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?)""",
            (DYNAMIC_CHANGED, uid, id, version, json.dumps(snapshot, ensure_ascii=False), time.time()))
        connection.execute("""INSERT INTO notification_deliveries(event_id, role, state, due_at)
            VALUES (?, ?, ?, 0)""", (event.lastrowid, UP_ROLE, PENDING))
    connection.execute("UPDATE notification_phases SET baseline_version = ? WHERE token = ?", (version, phase["token"]))


def record_heartbeat(connection, slot, facts, now):
    """登记本小时心跳：时段主键保证同一小时只生成一次。

    时段已存在即返回 False（重复调度与进程重启都不会再生成）；新时段写事件、
    快照与系统群投递记录，并写入有效期（不跨下一个心跳时段）。
    """
    created = connection.execute(
        "INSERT OR IGNORE INTO notification_heartbeats(slot, generated_at, expires_at) VALUES (?, ?, ?)",
        (slot.identity, now, slot.expires_at)).rowcount == 1
    if not created:
        return False
    snapshot = {"slot": slot.identity, "label": slot.label, **facts}
    # 心跳没有 UP 与动态：消息对象就是小时时段，`UNIQUE(kind, dynamic_id, version)` 再兜一层去重。
    event = connection.execute("""INSERT INTO notification_events
        (kind, uid, dynamic_id, version, snapshot, created_at) VALUES (?, '', ?, ?, ?, ?)""",
        (HEARTBEAT, slot.identity, slot.identity, json.dumps(snapshot, ensure_ascii=False), now))
    connection.execute("UPDATE notification_heartbeats SET event_id = ? WHERE slot = ?",
                       (event.lastrowid, slot.identity))
    connection.execute("""INSERT INTO notification_deliveries(event_id, role, state, due_at, expires_at)
        VALUES (?, ?, ?, 0, ?)""", (event.lastrowid, SYSTEM_ROLE, PENDING, slot.expires_at))
    return True


def expire_overdue(connection, now):
    """丢弃已过有效期的心跳：只影响带 `expires_at` 的记录，业务消息永不过期。"""
    return connection.execute("""UPDATE notification_deliveries
        SET state = ?, token = NULL, lease_until = NULL, due_at = ?, error = ?
        WHERE expires_at IS NOT NULL AND expires_at <= ? AND state IN (?, ?, ?)""",
        (EXPIRED, now, "expired", now, PENDING, WAITING_CONFIG, INFLIGHT)).rowcount


def recheck_waiting_config(connection, now):
    """进程启动时重新核验等待配置的目标，使修复后的配置无需等待复检周期。"""
    connection.execute("UPDATE notification_deliveries SET due_at = ? WHERE state = ?", (now, WAITING_CONFIG))


def claim_due(connection, now, limit, lease_seconds):
    """短事务领取：先丢弃过期心跳，再领到期待投、等待配置复检与过期租约。"""
    expire_overdue(connection, now)
    rows = connection.execute("""SELECT d.id AS delivery_id, d.role, d.attempts, d.expires_at, e.kind, e.uid,
            e.dynamic_id, e.version, e.snapshot
        FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
        WHERE (d.state IN (?, ?) AND d.due_at <= ?)
           OR (d.state = ? AND d.lease_until <= ?)
        ORDER BY d.due_at, d.id LIMIT ?""",
        (PENDING, WAITING_CONFIG, now, INFLIGHT, now, limit)).fetchall()
    claimed = []
    for row in rows:
        token = uuid4().hex
        changed = connection.execute("""UPDATE notification_deliveries
            SET state = ?, token = ?, lease_until = ?
            WHERE id = ? AND (state IN (?, ?) OR (state = ? AND lease_until <= ?))""",
            (INFLIGHT, token, now + lease_seconds, row["delivery_id"],
             PENDING, WAITING_CONFIG, INFLIGHT, now)).rowcount
        if changed != 1:
            continue
        item = dict(row)
        item["token"] = token
        item["snapshot"] = json.loads(row["snapshot"])
        claimed.append(item)
    return claimed


def finish_delivery(connection, delivery_id, token, *, state, now, due_at=None, error=None):
    """按领取凭证回写；失效凭证不能覆盖新领取结果。"""
    sent_at = now if state == SENT else None
    return connection.execute("""UPDATE notification_deliveries
        SET state = ?, token = NULL, lease_until = NULL, error = ?, due_at = ?, sent_at = ?,
            attempts = attempts + 1
        WHERE id = ? AND token = ? AND state = ?""",
        (state, error, now if due_at is None else due_at, sent_at,
         delivery_id, token, INFLIGHT)).rowcount == 1
