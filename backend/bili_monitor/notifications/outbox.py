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

楼中楼回复（05）额外约束：
- 接入位置是回复的实际写事务（`Store._change_replies`，逐页/逐楼提交），与一级
  评论共用同一阶段、评论起点、候选与模板，不另建身份规则或通知时钟。
- 定位条件由归档本身保证：回复只能指向已归档的所属根（`replies` 外键），
  且回复与根的 ID 都是本站可用的十进制身份，因此“根或站点不可定位”只表现为
  回复根本无法合法归档，本模块不为通知放宽外键或来源校验。
- 回复不采图片也不上传：只把来源响应已给出的 `content.pictures` 记成布尔存在性
  （`replies.reply_document` 的 `has_pictures`，不保存回复图片 URL），供纯图占位使用；
  未知（来源缺键或 null）不当成无图，快照也不会把未知媒体说成纯图。
"""

import json
import math
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime
from typing import NamedTuple
from uuid import uuid4

DYNAMIC_CHANGED = "dynamic_changed"
ROOT_COMMENT = "root_comment"
REPLY_COMMENT = "reply_comment"
HEARTBEAT = "heartbeat"
ALERT = "alert"

# 业务事件类型：告警阈值只统计这些类型的投递失败；心跳与告警本身不参与，避免递归告警。
BUSINESS_KINDS = frozenset({DYNAMIC_CHANGED, ROOT_COMMENT, REPLY_COMMENT})

# 告警节流：同一对象、同一类别首次立即提醒，此后每 30 分钟最多提醒一次；
# 未投递的同类提醒合并到上一条，不按轮询/重试次数堆积。
ALERT_COOLDOWN_SECONDS = 1800.0
UP_ROLE = "up"
ALL_ROLE = "all"
SYSTEM_ROLE = "system"

# 通知状态（v23）：一个持久枚举决定「登记什么」与「发送什么」，不再用布尔开关。
# `all` 登记并投递业务与系统消息；`system_only` 只登记并投递心跳/告警；
# `off` 一条都不登记、一条都不发（进程照常运行，只是不产生任何通知）。
NOTIFICATION_ALL = "all"
NOTIFICATION_SYSTEM_ONLY = "system_only"
NOTIFICATION_OFF = "off"
NOTIFICATION_STATES = (NOTIFICATION_ALL, NOTIFICATION_SYSTEM_ONLY, NOTIFICATION_OFF)

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


def migrate_alerts(connection):
    """v21 告警节流状态：`(category, object)` 是节流键，`event_id` 指向最近一条提醒。

    只保存类别、对象身份、最近提醒时间与最近事件；不保存凭据、响应正文或异常原文。
    旧库降级副本可能已带该表，建表必须可重入。
    """
    connection.execute("""CREATE TABLE IF NOT EXISTS notification_alerts (
        category TEXT NOT NULL,
        object TEXT NOT NULL,
        last_alert_at REAL NOT NULL,
        event_id INTEGER,
        PRIMARY KEY(category, object)
    )""")


def migrate_gate(connection):
    """v22 通知总开关：单行持久表，缺行即开启，迁移后既有库行为不变。

    旧库降级副本可能已带该表（既有测试会重放旧迁移号），建表必须可重入；
    已有行不被重放覆盖，关闭状态跨重启/重新部署保持。
    """
    connection.execute("""CREATE TABLE IF NOT EXISTS notification_gate (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
    )""")
    # 已被 v23 升成三态表的重放副本：不按旧形状写，也不回写默认值。
    if "enabled" not in {row[1] for row in connection.execute("PRAGMA table_info(notification_gate)")}:
        return
    connection.execute("INSERT OR IGNORE INTO notification_gate (id, enabled) VALUES (1, 1)")


def migrate_gate_states(connection):
    """v23 把布尔闸门换成三态：`all`（全部）／`system_only`（仅系统）／`off`（全停）。

    重建表而不是加列：`enabled` 的语义已被取代，留着它就会出现两个真相。
    升级后统一置 `off`——新语义下“默认不发”比“默认全发”安全：升级瞬间不会
    突然开始投递用户没预期的消息，用户需在管理页显式选择要收哪一类。
    已经是三态表时直接返回：重放迁移不重置用户已选的状态。
    """
    columns = {row[1] for row in connection.execute("PRAGMA table_info(notification_gate)")}
    if "state" in columns:
        return
    connection.execute("DROP TABLE IF EXISTS notification_gate_states")
    connection.execute("""CREATE TABLE notification_gate_states (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL CHECK (state IN ('all', 'system_only', 'off'))
    )""")
    connection.execute("INSERT INTO notification_gate_states (id, state) VALUES (1, 'off')")
    connection.execute("DROP TABLE IF EXISTS notification_gate")
    connection.execute("ALTER TABLE notification_gate_states RENAME TO notification_gate")


def read_state(connection):
    """当前通知状态；缺行按 `off` 处理（宁可停发不误发，不因数据缺失全发）。"""
    row = connection.execute("SELECT state FROM notification_gate WHERE id = 1").fetchone()
    if row is None:
        return NOTIFICATION_OFF
    value = row["state"]
    return value if value in NOTIFICATION_STATES else NOTIFICATION_OFF


def write_state(connection, state):
    """覆盖写入通知状态；同一行幂等，重复写同一值不算切换。"""
    if state not in NOTIFICATION_STATES:
        raise ValueError("Unknown notification state")
    connection.execute("""INSERT INTO notification_gate (id, state) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET state = excluded.state""", (state,))


def _registration_open(connection, *, system):
    """写事务内读一次状态，决定这次能不能登记通知记录。

    `system` 区分登记类别：业务消息（正文变化、评论、回复）只在 `all` 登记；
    系统消息（心跳、告警）在 `all` 与 `system_only` 都登记，`off` 一律不登记。
    读不到状态按关闭处理：通知的配置问题绝不能让归档事务回滚。
    """
    try:
        state = read_state(connection)
    except sqlite3.Error:
        return False
    return state == NOTIFICATION_ALL or (system and state == NOTIFICATION_SYSTEM_ONLY)


def discard_queue(connection, *, system):
    """作废还没发出去的通知记录；`system` 为真时连系统角色一起作废。

    只清「还没发出去」的 `pending` / `waiting_config`；正在发送中的 `inflight`
    无法撤回，由那一轮投递自行收尾。清完投递记录后连带清掉不再被引用的孤儿
    事件，以及心跳/告警里指向它们、已经悬空的指针。
    """
    if system:
        removed = connection.execute("DELETE FROM notification_deliveries WHERE state IN (?, ?)",
                                     (PENDING, WAITING_CONFIG)).rowcount
    else:
        removed = connection.execute(
            "DELETE FROM notification_deliveries WHERE state IN (?, ?) AND role <> ?",
            (PENDING, WAITING_CONFIG, SYSTEM_ROLE)).rowcount
    connection.execute("DELETE FROM notification_events WHERE id NOT IN "
                       "(SELECT event_id FROM notification_deliveries)")
    connection.execute("""DELETE FROM notification_heartbeats
        WHERE event_id IS NULL OR event_id NOT IN (SELECT id FROM notification_events)""")
    connection.execute("""UPDATE notification_alerts SET event_id = NULL
        WHERE event_id IS NOT NULL AND event_id NOT IN (SELECT id FROM notification_events)""")
    return removed


def realign(connection, now):
    """切回 `all` 时把业务通知起点前移到此刻：只通知之后的变化，不补发。

    评论起点取 `now`；正文基线对齐当前已归档的可信版本（与 `activate` 同口径）。
    阶段本身延续（不新开阶段、不清去重种子），`started_at` 保留真实的入选时刻。
    """
    _ensure_comment_start(connection)
    rows = connection.execute("""SELECT p.token, p.uid, p.dynamic_id FROM notification_phases p
        JOIN target_selections s ON s.uid = p.uid AND s.id = p.dynamic_id
        WHERE p.sealed = 0""").fetchall()
    for row in rows:
        baseline = None
        archived = connection.execute("SELECT document FROM archives WHERE id = ? AND uid = ?",
                                      (row["dynamic_id"], row["uid"])).fetchone()
        if archived is not None:
            document = json.loads(archived["document"])
            if document.get("content_state") == "success":
                baseline = document.get("synced_version")
        connection.execute("""UPDATE notification_phases SET comment_started_at = ?, baseline_version = ?
            WHERE token = ?""", (now, baseline, row["token"]))
        if baseline is not None:
            connection.execute("INSERT OR IGNORE INTO notification_versions VALUES (?, ?)",
                               (row["dynamic_id"], baseline))


def pending_count(connection):
    """待发条数：只读聚合 `pending` 的投递记录数，不含正文、路由或凭据。"""
    return connection.execute(
        "SELECT COUNT(*) FROM notification_deliveries WHERE state = ?", (PENDING,)).fetchone()[0]


class Alert(NamedTuple):
    """一条待登记告警：固定类别、表意对象键与固定原因，不含正文、地址或凭据。

    `object_key` 对应既有的 `notification_alerts.object` 列与消息快照的 `object` 字段：
    只把代码里穿行的位置元组换成有名字段，不改数据库列、载荷形状或节流键。
    """

    category: str
    object_key: str
    reason: str


def record_alert(connection, alert, now, cooldown=ALERT_COOLDOWN_SECONDS):
    """在同一事务里登记一条系统告警；被节流或合并时返回 False。

    判定顺序：同一 `(category, object)` 距上次提醒不足一个节流窗口 → 合并；
    上一条提醒仍未投递完成（非 `sent`/`expired`）→ 也合并，保证任何时刻最多只有
    一条未投递的同类提醒，系统群长期失败时不会按故障次数堆积告警。
    新建事件时写系统群投递记录，`expires_at` 为空：告警不套用心跳的过期丢弃规则。
    """
    if not _registration_open(connection, system=True):
        return False
    row = connection.execute(
        "SELECT last_alert_at, event_id FROM notification_alerts WHERE category = ? AND object = ?",
        (alert.category, alert.object_key)).fetchone()
    if row is not None:
        if now - row["last_alert_at"] < cooldown:
            return False
        if row["event_id"] is not None:
            previous = connection.execute(
                "SELECT state FROM notification_deliveries WHERE event_id = ? AND role = ?",
                (row["event_id"], SYSTEM_ROLE)).fetchone()
            if previous is not None and previous["state"] not in (SENT, EXPIRED):
                return False
    snapshot = {"category": alert.category, "object": alert.object_key,
                "occurred_at": now, "reason": alert.reason}
    # 事件身份按「类别 + 节流窗口」去重：重启或并发写入不会在同一窗口内重复登记。
    event = connection.execute("""INSERT OR IGNORE INTO notification_events
        (kind, uid, dynamic_id, version, snapshot, created_at) VALUES (?, '', ?, ?, ?, ?)""",
        (ALERT, alert.object_key, f"{alert.category}:{int(now // cooldown)}",
         json.dumps(snapshot, ensure_ascii=False), now))
    if event.rowcount != 1:
        return False
    connection.execute("""INSERT INTO notification_deliveries(event_id, role, state, due_at)
        VALUES (?, ?, ?, 0)""", (event.lastrowid, SYSTEM_ROLE, PENDING))
    connection.execute("""INSERT INTO notification_alerts(category, object, last_alert_at, event_id)
        VALUES (?, ?, ?, ?) ON CONFLICT(category, object) DO UPDATE SET
        last_alert_at = excluded.last_alert_at, event_id = excluded.event_id""",
        (alert.category, alert.object_key, now, event.lastrowid))
    return True


@contextmanager
def alert_guard(connection):
    """把单条告警登记包进 SAVEPOINT：写不进去时只丢这条告警，不牵连父事务。

    告警登记总是搭在别的事务里（检查结果、同步完成、投递回写）。如果一条告警
    因为本地存储问题写不进去就让父事务整体回滚，会把采集/投递主链拖垮；用
    SAVEPOINT 回滚到告警之前，父事务照常提交，由调用方留固定分类日志。
    """
    connection.execute("SAVEPOINT notification_alert")
    try:
        yield
    except sqlite3.Error:
        connection.execute("ROLLBACK TO notification_alert")
        connection.execute("RELEASE notification_alert")
        raise
    connection.execute("RELEASE notification_alert")


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


def migrate_candidate_roots(connection):
    """v20：候选身份补所属根，主键改为（动态、所属根、评论）。

    一级评论的所属根就是自身；旧候选按这个口径回填，不丢已有等待记录。旧库降级
    副本可能已经是本形态（既有测试重放旧迁移号），因此先核对列再重建，重建全程
    在同一迁移事务内，失败随版本号一起回滚。
    """
    if "root_id" in {row[1] for row in connection.execute("PRAGMA table_info(notification_candidates)")}:
        return
    exists = connection.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' "
                                "AND name = 'notification_candidates'").fetchone() is not None
    connection.execute("""CREATE TABLE notification_candidates_reply (
        dynamic_id TEXT NOT NULL, root_id TEXT NOT NULL, comment_id TEXT NOT NULL,
        phase TEXT NOT NULL, created_at REAL NOT NULL,
        PRIMARY KEY(dynamic_id, root_id, comment_id)
    )""")
    if exists:
        connection.execute("""INSERT OR IGNORE INTO notification_candidates_reply
            (dynamic_id, root_id, comment_id, phase, created_at)
            SELECT dynamic_id, comment_id, comment_id, phase, created_at FROM notification_candidates""")
        connection.execute("DROP TABLE notification_candidates")
    connection.execute("ALTER TABLE notification_candidates_reply RENAME TO notification_candidates")


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
    """提交时核验：同一写代次 + 领取时绑定的阶段仍有效 + 目标此刻仍入选。

    正文与评论共用：阶段在领取（`claim_body`）时与写代次绑定，提交处不能重新推导
    “当前阶段”——否则停用后重新启用的旧在途执行会把迟到内容算进新阶段（违反
    “旧执行不能借新阶段生成通知”）。
    """
    return connection.execute("""SELECT p.token, p.baseline_version, p.comment_started_at
        FROM notification_phases p
        JOIN target_selections s ON s.uid = p.uid AND s.id = p.dynamic_id
        JOIN notification_body_claims c ON c.phase = p.token AND c.dynamic_id = p.dynamic_id
        WHERE c.dynamic_id = ? AND c.generation = ? AND p.sealed = 0""", (id, generation)).fetchone()


def record_body(connection, id, generation, document, version):
    """正文实际成功归档时调用：建立基线或登记事件，与正文同事务提交。"""
    if version is None:
        return
    # 非 `all` 状态不登记业务事件、也不推进基线：切回 `all` 时由 `realign` 统一
    # 对齐，因此关闭期间的变化既不入队，也不会在切回后变成一条迟到的「发生变化」。
    if not _registration_open(connection, system=False):
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
    if not _registration_open(connection, system=True):
        return False
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


# 领取查询拆成三条：业务到期、系统角色到期、过期租约。业务与系统分开取是为了让
# 心跳/告警不排在业务积压后面（系统角色另有独立限速额度）；三者各自命中索引。
# 两条到期查询只差角色谓词，用同一段模板生成，避免复制整条 SQL。
_DUE_TEMPLATE = """SELECT d.id AS delivery_id, d.role, d.attempts, d.expires_at, d.due_at, e.kind, e.uid,
        e.dynamic_id, e.version, e.snapshot
    FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
    WHERE d.state IN (?, ?) AND d.due_at <= ? AND d.role {comparison} ?
    ORDER BY d.due_at, d.id LIMIT ?"""
DUE_QUERY = _DUE_TEMPLATE.format(comparison="<>")
SYSTEM_DUE_QUERY = _DUE_TEMPLATE.format(comparison="=")
LEASE_QUERY = """SELECT d.id AS delivery_id, d.role, d.attempts, d.expires_at, d.due_at, e.kind, e.uid,
        e.dynamic_id, e.version, e.snapshot
    FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
    WHERE d.state = ? AND d.lease_until <= ?
    ORDER BY d.lease_until, d.id LIMIT ?"""


def claim_due(connection, now, limit, lease_seconds):
    """短事务领取：先丢弃过期心跳，再领到期待投、等待配置复检与过期租约。

    三条查询各自命中索引，结果合并后按「系统角色优先 + 到期时间」排序并限批量，
    避免全表扫描、避免一次性抢光同一秒内堆积的记录，也避免大批业务积压把心跳
    挤到有效期之后。`limit` 是每类查询的上限，合并后再截断到 `limit`。
    """
    expire_overdue(connection, now)
    rows = list(connection.execute(DUE_QUERY, (PENDING, WAITING_CONFIG, now, SYSTEM_ROLE, limit)))
    rows += connection.execute(SYSTEM_DUE_QUERY,
                               (PENDING, WAITING_CONFIG, now, SYSTEM_ROLE, limit)).fetchall()
    rows += connection.execute(LEASE_QUERY, (INFLIGHT, now, limit)).fetchall()
    rows = sorted(rows, key=lambda row: (row["role"] != SYSTEM_ROLE, row["due_at"],
                                         row["delivery_id"]))[:limit]
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


def defer_delivery(connection, delivery_id, token, *, due_at):
    """超预算顺延：只改 `due_at` 并放回 `pending`，记录下一轮被自然重领。

    顺延不是失败：不消耗 `attempts`（否则会放大后续退避）、不改 `error`、
    不增长 `failures`（否则 08 会把限速噪音当成持续投递失败）。
    凭证失效时返回 False，与 `finish_delivery` 的 stale 语义一致。
    """
    return connection.execute("""UPDATE notification_deliveries
        SET state = ?, token = NULL, lease_until = NULL, due_at = ?
        WHERE id = ? AND token = ? AND state = ?""",
        (PENDING, due_at, delivery_id, token, INFLIGHT)).rowcount == 1


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


def _candidate(connection, dynamic_id, root_id, comment_id):
    """候选保留原阶段与起点：补齐时不重新制造启用时间，也不借新阶段发旧评论。

    身份是（动态、所属根、评论）：回复必须带上所属根，同一回复 ID 属于不同根时
    不会共用同一条候选。
    """
    return connection.execute("""SELECT c.phase, p.comment_started_at, p.sealed,
            (s.token IS NOT NULL) AS selected
        FROM notification_candidates c
        LEFT JOIN notification_phases p ON p.token = c.phase
        LEFT JOIN target_selections s ON p.uid = s.uid AND p.dynamic_id = s.id
        WHERE c.dynamic_id = ? AND c.root_id = ? AND c.comment_id = ?""",
                            (dynamic_id, root_id, comment_id)).fetchone()


def record_root(connection, uid, dynamic_id, archive, document, *, discovered, generation):
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
    # 一级评论的所属根就是自身：与回复共用同一事件身份口径（动态 + 根 + 评论）。
    _record_comment(connection, uid, dynamic_id, archive, document, discovered=discovered,
                    kind=ROOT_COMMENT, root_id=comment_id, generation=generation)


def record_reply(connection, uid, dynamic_id, archive, root_id, document, *, discovered, generation):
    """楼中楼回复写事务内登记事件或候选：与回复内容同事务提交或回滚。

    - 身份是「动态 + 所属根 + 回复」，不以回复计数或扫描轮次作键；补字段、重新分页
      与纯编辑都不重复登记。
    - 阶段、评论起点、候选与路由与一级评论完全一致：作者 UID 与该动态所属 UP 相等
      时发 UP 群 + 全员群，否则只发全员群；被回复者身份不参与路由。
    - 所属根必须先合法归档（`replies` 外键）；根或身份不可定位时回复本身就存不进
      归档，所以这里只为“已存内容 + 字段不全”保留候选，不虚构可定位性。
    """
    comment_id = document.get("id")
    if not isinstance(comment_id, str) or not comment_id:
        return
    if not isinstance(root_id, str) or not root_id:
        return
    _record_comment(connection, uid, dynamic_id, archive, document, discovered=discovered,
                    kind=REPLY_COMMENT, root_id=root_id, generation=generation)


def _record_comment(connection, uid, dynamic_id, archive, document, *, discovered, kind, root_id,
                    generation):
    # 非 `all` 状态连候选都不写：关闭期间新评论不该在切回后被补成通知。
    if not _registration_open(connection, system=False):
        return
    comment_id = document["id"]
    candidate = _candidate(connection, dynamic_id, root_id, comment_id)
    if candidate is not None:
        if not _comment_ready(document):
            return
        connection.execute("""DELETE FROM notification_candidates
            WHERE dynamic_id = ? AND root_id = ? AND comment_id = ?""",
                           (dynamic_id, root_id, comment_id))
        if candidate["sealed"] or not candidate["selected"] or candidate["comment_started_at"] is None:
            return
        _register_comment(connection, uid, dynamic_id, archive, document,
                          candidate["comment_started_at"], kind=kind, root_id=root_id)
        return
    if not discovered:
        return
    # 阶段取自本次领取时绑定的阶段，不重新推导“当前阶段”。
    phase = _active_phase(connection, dynamic_id, generation)
    # 阶段缺失/已封存，或评论起点缺失（旧库尚未完成回填）时不猜启用时间：宁可不发。
    if phase is None or phase["comment_started_at"] is None:
        return
    if not _comment_ready(document):
        connection.execute("""INSERT OR IGNORE INTO notification_candidates
            (dynamic_id, root_id, comment_id, phase, created_at) VALUES (?, ?, ?, ?, ?)""",
            (dynamic_id, root_id, comment_id, phase["token"], time.time()))
        return
    _register_comment(connection, uid, dynamic_id, archive, document, phase["comment_started_at"],
                      kind=kind, root_id=root_id)


def _register_comment(connection, uid, dynamic_id, archive, document, comment_started_at, *, kind, root_id):
    published = _epoch(document["published_at"])
    # 起点按秒取整：与起点同一秒发表的评论属于「起点及之后」，不因亚秒差被吞掉。
    if comment_started_at is None or published < math.floor(comment_started_at):
        return
    comment_id = document["id"]
    author = document["author"]
    roles = (UP_ROLE, ALL_ROLE) if author["id"] == uid else (ALL_ROLE,)
    snapshot = {
        "dynamic_id": dynamic_id, "title": archive.get("title"), "root_id": root_id,
        "comment_id": comment_id,
        "author": {"id": author["id"], "nickname": author.get("nickname")},
        "published_at": document["published_at"], "text": document.get("text"),
        # 纯图占位依据“已知有媒体”，不把“未知”说成“无图”：一级评论看归档媒体，
        # 回复只看来源已给出的布尔存在性（不保存、不上传回复图片）。
        "has_media": bool(document.get("media") or document.get("media_sources")
                           or document.get("has_pictures")),
    }
    inserted = connection.execute("""INSERT OR IGNORE INTO notification_events
        (kind, uid, dynamic_id, version, root_id, comment_id, snapshot, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (kind, uid, dynamic_id, None, root_id, comment_id,
         json.dumps(snapshot, ensure_ascii=False), time.time()))
    if inserted.rowcount != 1:
        return
    for role in roles:
        connection.execute("""INSERT INTO notification_deliveries(event_id, role, state, due_at)
            VALUES (?, ?, ?, 0)""", (inserted.lastrowid, role, PENDING))
