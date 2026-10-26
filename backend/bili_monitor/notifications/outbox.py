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

评论事件（04）额外约束：
- 评论起点（`notification_phases.comment_started_at`）独立于正文基线：接入评论
  通知时不能把 01 阶段早就写下的 `started_at` 当评论起点，否则升级瞬间会回填
  01 部署以来的历史评论。升级时已有阶段以升级时刻建立评论起点，升级前已归档
  的评论作为静默基线。
- 事件身份按（动态、所属根、评论）去重：一级评论的 root_id 就是自身，回复（05）
  的 root_id 是所属根，因此同一源评论 ID 属于不同根时不会撞键。
- 作者 UID 或发表时间缺失时只保存候选（保留原阶段），补齐后原子转成事件；
  已结束阶段的候选作废，不越阶段生成通知。
"""

import json
import math
import time
from datetime import datetime
from uuid import uuid4

DYNAMIC_CHANGED = "dynamic_changed"
ROOT_COMMENT = "root_comment"
HEARTBEAT = "heartbeat"
UP_ROLE = "up"
ALL_ROLE = "all"
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
        comment_started_at REAL,
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


def migrate_delivery_facts(connection):
    """v19 投递失败事实：`failures` 只统计真实失败，供 08 判定“飞书持续投递失败”。

    旧库降级副本可能已带这些列（既有测试会重放旧迁移号），因此按「缺失才建」。
    旧记录默认为 0 次失败、没有失败时间：不把历史 `attempts`（含等待配置复检）
    倒推成失败次数。
    """
    columns = {row[1] for row in connection.execute("PRAGMA table_info(notification_deliveries)")}
    if "failures" not in columns:
        connection.execute("ALTER TABLE notification_deliveries ADD COLUMN failures INTEGER NOT NULL DEFAULT 0")
    if "last_failed_at" not in columns:
        connection.execute("ALTER TABLE notification_deliveries ADD COLUMN last_failed_at REAL")


def has_schema(connection):
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notification_phases'").fetchone() is not None


def migrate_comments(connection):
    """v18 评论通知：事件身份列、待判定候选与评论起点。

    旧库降级副本可能已带这些结构（既有测试会重放旧迁移号），因此列与索引都按
    「缺失才建」处理。已有阶段以本次升级时刻作为评论起点：升级前已归档的评论
    静默，不因 01 阶段的 `started_at` 回填历史。
    """
    columns = {row[1] for row in connection.execute("PRAGMA table_info(notification_events)")}
    if "root_id" not in columns:
        connection.execute("ALTER TABLE notification_events ADD COLUMN root_id TEXT")
    if "comment_id" not in columns:
        connection.execute("ALTER TABLE notification_events ADD COLUMN comment_id TEXT")
    connection.execute("""CREATE UNIQUE INDEX IF NOT EXISTS notification_event_comment
        ON notification_events(kind, dynamic_id, root_id, comment_id) WHERE comment_id IS NOT NULL""")
    connection.execute("""CREATE TABLE IF NOT EXISTS notification_candidates (
        dynamic_id TEXT NOT NULL, comment_id TEXT NOT NULL, phase TEXT NOT NULL, created_at REAL NOT NULL,
        PRIMARY KEY(dynamic_id, comment_id)
    )""")
    _ensure_comment_start(connection)
    # 已有阶段（含 01 建立的）以本次升级时刻作为评论起点：升级前已归档的评论成为静默基线。
    connection.execute("UPDATE notification_phases SET comment_started_at = ? "
                       "WHERE comment_started_at IS NULL", (time.time(),))


def _phase_columns(connection):
    return {row[1] for row in connection.execute("PRAGMA table_info(notification_phases)")}


def _ensure_comment_start(connection):
    if "comment_started_at" not in _phase_columns(connection):
        connection.execute("ALTER TABLE notification_phases ADD COLUMN comment_started_at REAL")


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
    # 评论起点与正文起点同一时刻建立；旧阶段由迁移另行给定升级时刻作为评论起点。
    _ensure_comment_start(connection)
    started_at = time.time()
    connection.execute(
        "INSERT INTO notification_phases(token, uid, dynamic_id, started_at, comment_started_at, baseline_version) "
        "VALUES (?, ?, ?, ?, ?, ?)", (token, uid, id, started_at, started_at, baseline))
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


# 领取查询拆成两条：到期记录走 (state, due_at) 索引，过期租约走 (state, lease_until)
# 索引。合成一个带 OR 的语句会让计划退化成扫描。
DUE_QUERY = """SELECT d.id AS delivery_id, d.role, d.attempts, d.expires_at, d.due_at, e.kind, e.uid,
        e.dynamic_id, e.version, e.snapshot
    FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
    WHERE d.state IN (?, ?) AND d.due_at <= ?
    ORDER BY d.due_at, d.id LIMIT ?"""
LEASE_QUERY = """SELECT d.id AS delivery_id, d.role, d.attempts, d.expires_at, d.due_at, e.kind, e.uid,
        e.dynamic_id, e.version, e.snapshot
    FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
    WHERE d.state = ? AND d.lease_until <= ?
    ORDER BY d.lease_until, d.id LIMIT ?"""


def claim_due(connection, now, limit, lease_seconds):
    """短事务领取：先丢弃过期心跳，再领到期待投、等待配置复检与过期租约。

    两条查询各自命中一条索引，结果合并后仍按到期时间排序并限制批量，避免全表扫描
    和一次性抢光同一秒内堆积的记录。
    """
    expire_overdue(connection, now)
    rows = connection.execute(DUE_QUERY, (PENDING, WAITING_CONFIG, now, limit)).fetchall()
    rows = list(rows) + connection.execute(LEASE_QUERY, (INFLIGHT, now, limit)).fetchall()
    rows = sorted(rows, key=lambda row: (row["due_at"], row["delivery_id"]))[:limit]
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


def finish_delivery(connection, delivery_id, token, *, state, now, due_at=None, error=None, failure=False):
    """按领取凭证回写；失效凭证不能覆盖新领取结果。

    `failures` 与 `attempts` 分开记：`attempts` 每次回写都 +1（包括等待配置的周期性
    复检），`failures` 只在外部投递真的失败时 +1，并留下最后一次失败时间。票据 08
    只能用后者判定“飞书持续投递失败”，不能用 `attempts`。
    """
    sent_at = now if state == SENT else None
    return connection.execute("""UPDATE notification_deliveries
        SET state = ?, token = NULL, lease_until = NULL, error = ?, due_at = ?, sent_at = ?,
            attempts = attempts + 1, failures = failures + ?,
            last_failed_at = CASE WHEN ? THEN ? ELSE last_failed_at END
        WHERE id = ? AND token = ? AND state = ?""",
        (state, error, now if due_at is None else due_at, sent_at, int(bool(failure)),
         int(bool(failure)), now, delivery_id, token, INFLIGHT)).rowcount == 1


def delivery_failures(connection, limit=50):
    """只读失败事实：给票据 08 的最小接口，本模块不实现告警阈值与节流。

    只返回真实失败过的逐目标记录（`failures > 0`），不包含 webhook、签名或消息快照。
    已成功目标也保留历史失败次数与最后失败时间，成功不被用来抹掉故障事实。
    """
    return connection.execute("""SELECT d.role AS role, e.kind AS kind, e.uid AS uid,
            e.dynamic_id AS dynamic_id, d.state AS state, d.error AS error,
            d.failures AS failures, d.last_failed_at AS last_failed_at
        FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
        WHERE d.failures > 0
        ORDER BY d.last_failed_at DESC, d.id LIMIT ?""", (limit,)).fetchall()


def _epoch(value):
    """发表时间是来源给的本站时间（+08:00、秒精度）；比较必须解析，不能比字符串。"""
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        return None


def _comment_ready(document):
    """身份与时间是否足以判定路由与起点：缺失就只留候选，不伪造字段。"""
    author = document.get("author")
    author_id = author.get("id") if isinstance(author, dict) else None
    if not isinstance(author_id, str) or not author_id:
        return False
    return _epoch(document.get("published_at")) is not None


def _comment_phase(connection, uid, dynamic_id):
    """当前阶段只在「未封存且目标仍入选」时有效，提交处核验而不是任务开始时核验。"""
    return connection.execute("""SELECT p.token, p.comment_started_at FROM notification_phases p
        JOIN target_selections s ON s.uid = p.uid AND s.id = p.dynamic_id
        WHERE p.uid = ? AND p.dynamic_id = ? AND p.sealed = 0
        ORDER BY p.started_at DESC LIMIT 1""", (uid, dynamic_id)).fetchone()


def _candidate(connection, dynamic_id, comment_id):
    """候选保留原阶段与起点：补齐时不重新制造启用时间，也不借新阶段发旧评论。"""
    return connection.execute("""SELECT c.phase, p.comment_started_at, p.sealed,
            (s.token IS NOT NULL) AS selected
        FROM notification_candidates c
        LEFT JOIN notification_phases p ON p.token = c.phase
        LEFT JOIN target_selections s ON p.uid = s.uid AND p.dynamic_id = s.id
        WHERE c.dynamic_id = ? AND c.comment_id = ?""", (dynamic_id, comment_id)).fetchone()


def record_root(connection, uid, dynamic_id, archive, document, *, discovered):
    """根评论写事务内登记评论事件或待判定候选：与评论内容同事务提交或回滚。

    - `discovered` 是本次事务前该评论首次插入（`previous is None`）。补字段、纯编辑
      与重复扫描不是新增，只有候选补齐才走转换。
    - 只有「当前有效阶段 + 发表时间不早于评论起点」才录入事件；起点之前的历史评论
      静默（首屏置顶/热评 extras 也因此不会被当成新增）。
    - 作者 UID 或发表时间缺失时只保存候选（记录原阶段），补齐后再判定；已结束阶段
      的候选作废，不越阶段生成通知。
    - 路由按评论作者 UID 与该动态所属 UP 的 UID 是否相等决定，系统群不在业务角色里。
    """
    comment_id = document.get("id")
    if not isinstance(comment_id, str) or not comment_id:
        return
    candidate = _candidate(connection, dynamic_id, comment_id)
    if candidate is not None:
        if not _comment_ready(document):
            return
        connection.execute("DELETE FROM notification_candidates WHERE dynamic_id = ? AND comment_id = ?",
                           (dynamic_id, comment_id))
        if candidate["sealed"] or not candidate["selected"] or candidate["comment_started_at"] is None:
            return
        _register_comment(connection, uid, dynamic_id, archive, document, candidate["comment_started_at"])
        return
    if not discovered:
        return
    phase = _comment_phase(connection, uid, dynamic_id)
    # 评论起点缺失（旧库尚未完成回填）时不猜启用时间：宁可不发，也不回填历史。
    if phase is None or phase["comment_started_at"] is None:
        return
    if not _comment_ready(document):
        connection.execute("""INSERT OR IGNORE INTO notification_candidates
            (dynamic_id, comment_id, phase, created_at) VALUES (?, ?, ?, ?)""",
            (dynamic_id, comment_id, phase["token"], time.time()))
        return
    _register_comment(connection, uid, dynamic_id, archive, document, phase["comment_started_at"])


def _register_comment(connection, uid, dynamic_id, archive, document, comment_started_at):
    published = _epoch(document["published_at"])
    # 起点按秒取整：与起点同一秒发表的评论属于「起点及之后」，不因亚秒差被吞掉。
    if comment_started_at is None or published < math.floor(comment_started_at):
        return
    comment_id = document["id"]
    author = document["author"]
    roles = (UP_ROLE, ALL_ROLE) if author["id"] == uid else (ALL_ROLE,)
    snapshot = {
        "dynamic_id": dynamic_id, "title": archive.get("title"), "comment_id": comment_id,
        "author": {"id": author["id"], "nickname": author.get("nickname")},
        "published_at": document["published_at"], "text": document.get("text"),
        # 纯图占位依据归档已知媒体，不把“未知”说成“无图”。
        "has_media": bool(document.get("media") or document.get("media_sources")),
    }
    inserted = connection.execute("""INSERT OR IGNORE INTO notification_events
        (kind, uid, dynamic_id, version, root_id, comment_id, snapshot, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (ROOT_COMMENT, uid, dynamic_id, None, comment_id, comment_id,
         json.dumps(snapshot, ensure_ascii=False), time.time()))
    if inserted.rowcount != 1:
        return
    for role in roles:
        connection.execute("""INSERT INTO notification_deliveries(event_id, role, state, due_at)
            VALUES (?, ?, ?, 0)""", (inserted.lastrowid, role, PENDING))
