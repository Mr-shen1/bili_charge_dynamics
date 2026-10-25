"""身份与配置分离；每次操作独立连接，网络不进入 SQLite 事务。"""

import hashlib
import json
import sqlite3
import re
import time
from uuid import uuid4
from contextlib import contextmanager
from pathlib import Path

from .notifications import outbox
from .contracts import APIError
from .checks import CheckStore
from .selection import refresh_selections, selection_token, selection_matches
from .discovery_state import DiscoveryStore
from .comment_status import comment_status, utc_now, ROOT_METADATA_VERSION
from .media import reconcile_media, refresh_media_progress


SNAPSHOT_TTL_SECONDS = 15 * 60
ARCHIVE_RESOURCE = "dynamics:all:published-desc:id-binary:v1"


def _merge_known(previous, observed):
    return {**previous, **{key: value for key, value in observed.items() if value is not None}}


def _merge_comment(previous, observed):
    document = _merge_known(previous, observed)
    document["author"] = _merge_known(previous["author"], observed["author"])
    return document


def _comment_media_version(count):
    # 来源计数只标识实际根同步版本，不用于检测图片/评论编辑。
    return f"comments:{count}" if count is not None else None


def _observe_root_media(document, count):
    observed = _comment_media_version(count)
    if observed is not None or "observed_version" not in document:
        document["observed_version"] = observed
    document.setdefault("work", {}).setdefault("media", "pending")
    if document["observed_version"] != document.get("media_version"):
        document["work"]["media"] = "pending"


def _reconcile_root_media(document, sources, count, observed_count):
    _observe_root_media(document, observed_count)
    version = _comment_media_version(count)
    if sources is not None:
        reconcile_media(document, sources, version, owner_type="comment")
    elif not document.get("media"):
        # 该接口只在根评论确实带图时下发 pictures（实测同一轮响应里带图的根有键、无图则缺键），
        # 因此从未观察到图片的组在缺键时可确认空；否则 work.media 永久 pending，
        # checks.py 的「无 pending 根」谓词也会让目标永远重领工作。
        reconcile_media(document, [], version, owner_type="comment")
    # 已有图片项却缺键时什么都不做：不擦除已知媒体，也不冒充空组。


def _root_resource(id, sort):
    return f"root-comments:{id}:{sort}:v1"


def _root_order(sort):
    """一级评论排序：置顶优先，最热再看点赞，最后按发表时间与 ID 稳定收尾。"""
    return ("CASE WHEN json_extract(document, '$.is_pinned') = 1 THEN 0 ELSE 1 END ASC, "
            + ("json_extract(document, '$.like_count') DESC, " if sort == "hot" else "")
            + "json_extract(document, '$.published_at') DESC, id COLLATE BINARY ASC")


def _root_offset_cursor(resource, limit, offset):
    """定位窗口的续读游标：无状态偏移，摘要绑定动态、排序与批量，读取不写库。"""
    digest = hashlib.sha256(f"{resource}|{limit}|{offset}".encode()).hexdigest()[:16]
    return f"{offset:x}-{digest}"


def _root_offset(resource, limit, cursor):
    matched = re.fullmatch(r"([0-9a-f]{1,8})-([0-9a-f]{16})", cursor)
    if matched is None:
        return None
    offset = int(matched.group(1), 16)
    # 摘要不符时按无效游标处理：不猜来源动态/排序，也不接受被改写的偏移。
    return offset if _root_offset_cursor(resource, limit, offset) == cursor else None


def _freeze_pages(documents, limit):
    pages = [documents[i:i + limit] for i in range(0, len(documents), limit)] or [[]]
    tokens = [uuid4().hex for _ in pages]
    results = [{"items": page, "next_cursor": tokens[i + 1] if i + 1 < len(pages) else None}
               for i, page in enumerate(pages)]
    return results[0], list(zip(tokens[1:], results[1:]))


class Store(CheckStore, DiscoveryStore):
    def __init__(self, path):
        self.path = str(path)

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.path, timeout=2, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
        finally:
            connection.close()

    def migrate(self):
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                version = connection.execute("PRAGMA user_version").fetchone()[0]
                if version > 17:
                    raise RuntimeError("Unsupported database schema version")
                if version == 0:
                    connection.execute("""CREATE TABLE identities (
                        uid TEXT PRIMARY KEY, name TEXT, avatar_url TEXT
                    )""")
                    connection.execute("""CREATE TABLE monitors (
                        uid TEXT PRIMARY KEY REFERENCES identities(uid),
                        mode TEXT NOT NULL DEFAULT 'recent',
                        recent_n INTEGER NOT NULL DEFAULT 10,
                        enabled INTEGER NOT NULL DEFAULT 1
                    )""")
                if version < 2:
                    connection.execute("""CREATE TABLE targets (
                        uid TEXT NOT NULL REFERENCES monitors(uid) ON DELETE CASCADE,
                        id TEXT NOT NULL, PRIMARY KEY(uid, id)
                    )""")
                if version < 3:
                    connection.execute("""CREATE TABLE archives (
                        id TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES identities(uid),
                        document TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0
                    )""")
                if version < 4:
                    connection.execute("""CREATE TABLE archive_pages (
                        token TEXT PRIMARY KEY, batch_limit INTEGER NOT NULL,
                        document TEXT NOT NULL
                    )""")
                if version < 5:
                    connection.execute("ALTER TABLE archive_pages ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0")
                    connection.execute(f"ALTER TABLE archive_pages ADD COLUMN resource TEXT NOT NULL DEFAULT '{ARCHIVE_RESOURCE}'")
                    connection.execute("CREATE INDEX archive_pages_expiry ON archive_pages(expires_at)")
                connection.execute("DELETE FROM archive_pages WHERE expires_at <= ?", (int(time.time()),))
                if version < 6:
                    connection.execute("""CREATE TABLE root_comments (
                        dynamic_id TEXT NOT NULL REFERENCES archives(id),
                        id TEXT NOT NULL, document TEXT NOT NULL,
                        PRIMARY KEY(dynamic_id, id)
                    )""")
                    connection.execute("""CREATE TABLE root_comment_pages (
                        token TEXT PRIMARY KEY, resource TEXT NOT NULL,
                        batch_limit INTEGER NOT NULL, document TEXT NOT NULL
                    )""")
                    # 为旧归档补齐新增状态；旧动态 cursor 的冻结内容不重写。
                    for row in connection.execute("SELECT id, document FROM archives").fetchall():
                        document = json.loads(row["document"])
                        document.setdefault("local_reply_count", 0)
                        document.setdefault("root_comments_last_attempt", "pending")
                        document.setdefault("synced_root_comment_count", None)
                        document.setdefault("work", {}).setdefault("comments", "pending")
                        document["work"].setdefault("replies", "pending")
                        connection.execute("UPDATE archives SET document = ? WHERE id = ?",
                                           (json.dumps(document, ensure_ascii=False), row["id"]))
                if version < 7:
                    connection.execute("""CREATE TABLE replies (
                        dynamic_id TEXT NOT NULL, root_id TEXT NOT NULL,
                        id TEXT NOT NULL, document TEXT NOT NULL,
                        PRIMARY KEY(dynamic_id, root_id, id),
                        FOREIGN KEY(dynamic_id, root_id) REFERENCES root_comments(dynamic_id, id)
                    )""")
                    connection.execute("""CREATE TABLE reply_sync (
                        dynamic_id TEXT NOT NULL, root_id TEXT NOT NULL, status TEXT NOT NULL,
                        synced_source_reply_count INTEGER,
                        PRIMARY KEY(dynamic_id, root_id),
                        FOREIGN KEY(dynamic_id, root_id) REFERENCES root_comments(dynamic_id, id)
                    )""")
                    connection.execute("""CREATE TABLE reply_pages (
                        token TEXT PRIMARY KEY, resource TEXT NOT NULL, document TEXT NOT NULL
                    )""")
                    for row in connection.execute("SELECT id, document FROM archives").fetchall():
                        document = json.loads(row["document"])
                        document.update({"replies_last_attempt": "pending", "comments_last_attempt": "pending",
                                         "synced_comment_count": None, "synced_reply_comment_count": None})
                        document.setdefault("work", {})["replies"] = "pending"
                        connection.execute("UPDATE archives SET document = ? WHERE id = ?",
                                           (json.dumps(document, ensure_ascii=False), row["id"]))
                if version < 8:
                    connection.execute("""CREATE TABLE media_attempts (
                        dynamic_id TEXT NOT NULL REFERENCES archives(id), media_id TEXT NOT NULL,
                        token TEXT NOT NULL, PRIMARY KEY(dynamic_id, media_id)
                    )""")
                    for row in connection.execute("SELECT id, document FROM archives").fetchall():
                        document = json.loads(row["document"])
                        reconcile_media(document, document.get("media_sources", []), document.get("synced_version"),
                                        empty_confirmed=document.get("content_state") == "success")
                        connection.execute("UPDATE archives SET document = ? WHERE id = ?",
                                           (json.dumps(document, ensure_ascii=False), row["id"]))
                if version < 9:
                    connection.execute("ALTER TABLE media_attempts ADD COLUMN root_id TEXT NOT NULL DEFAULT ''")
                    for row in connection.execute("SELECT dynamic_id, id, document FROM root_comments").fetchall():
                        document = json.loads(row["document"])
                        archive = json.loads(connection.execute(
                            "SELECT document FROM archives WHERE id = ?", (row["dynamic_id"],)
                        ).fetchone()[0])
                        sources = document.get("media_sources") or None
                        _reconcile_root_media(document, sources, archive.get("synced_root_comment_count"),
                                              archive.get("source_comment_count"))
                        connection.execute("UPDATE root_comments SET document = ? WHERE dynamic_id = ? AND id = ?",
                                           (json.dumps(document, ensure_ascii=False), row["dynamic_id"], row["id"]))
                if version < 10:
                    connection.execute("""CREATE TABLE target_checks (
                        uid TEXT NOT NULL REFERENCES identities(uid), id TEXT NOT NULL,
                        last_checked_at TEXT, last_succeeded_at TEXT,
                        check_status TEXT NOT NULL CHECK(check_status IN ('checked', 'unchanged', 'failed')),
                        observed TEXT NOT NULL, revision INTEGER NOT NULL,
                        work TEXT NOT NULL CHECK(work IN ('pending', 'running', 'complete')),
                        check_error TEXT CHECK(check_error IN ('SOURCE_UNAVAILABLE', 'SIGNAL_INVALID')),
                        sync_error TEXT CHECK(sync_error IN ('SOURCE_UNAVAILABLE', 'SIGNAL_INVALID', 'SYNC_INCOMPLETE')),
                        PRIMARY KEY(uid, id)
                    )""")
                if version < 11:
                    # revision 是观察代次，不能 fencing 同一代次的重新领取。
                    connection.execute("ALTER TABLE target_checks ADD COLUMN claim_token TEXT")
                if version < 12:
                    connection.execute("""CREATE TABLE recent_discoveries (
                        uid TEXT PRIMARY KEY REFERENCES identities(uid),
                        status TEXT NOT NULL CHECK(status IN ('running', 'discovered', 'failed')),
                        attempt TEXT NOT NULL, trusted_result TEXT, claim_token TEXT
                    )""")
                if version < 13:
                    connection.execute("""CREATE TABLE target_selections (
                        uid TEXT NOT NULL REFERENCES identities(uid), id TEXT NOT NULL,
                        token TEXT NOT NULL, PRIMARY KEY(uid, id)
                    )""")
                    for row in connection.execute("SELECT uid FROM monitors").fetchall():
                        refresh_selections(connection, row[0])
                if version < 14:
                    # 楼中楼增量判定：记录上次成功时的根页 rcount 与成功时间。
                    # 已被更高版本建过表的降级副本也要能重放，先核对缺失列。
                    columns = {row[1] for row in connection.execute("PRAGMA table_info(reply_sync)")}
                    if "synced_at" not in columns:
                        connection.execute("ALTER TABLE reply_sync ADD COLUMN synced_at TEXT")
                    if "observed_reply_count" not in columns:
                        connection.execute("ALTER TABLE reply_sync ADD COLUMN observed_reply_count INTEGER")
                if version < 15:
                    # 页面信号（编辑时间/正文与图片版本）按独立低频节拍采样，计数检查仍走主节拍。
                    columns = {row[1] for row in connection.execute("PRAGMA table_info(target_checks)")}
                    if "page_checked_at" not in columns:
                        connection.execute("ALTER TABLE target_checks ADD COLUMN page_checked_at TEXT")
                if version < 17:
                    # 通知 schema 可重入：v15 重放与 v16 增量（心跳时段/有效期）走同一入口。
                    outbox.migrate(connection)
                connection.execute("PRAGMA user_version = 17")
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    def read(self, uid=None):
        with self.connection() as connection:
            rows = connection.execute(
                """SELECT i.uid, i.name, i.avatar_url,
                m.uid AS monitor_uid, m.mode, m.recent_n, m.enabled,
                (SELECT MAX(c.last_checked_at) FROM target_checks c WHERE c.uid = i.uid) AS last_checked_at,
                (SELECT MAX(c.last_succeeded_at) FROM target_checks c WHERE c.uid = i.uid) AS last_succeeded_at
                FROM identities i LEFT JOIN monitors m ON m.uid = i.uid
            """
                + (
                    " WHERE i.uid = ?"
                    if uid is not None
                    else " ORDER BY i.uid COLLATE BINARY"
                ),
                (uid,) if uid is not None else (),
            ).fetchall()
        return [
            dict(
                uid=row["uid"],
                name=row["name"],
                avatar_url=row["avatar_url"],
                monitor=None
                if row["monitor_uid"] is None
                else {
                    "mode": row["mode"],
                    "recent_n": row["recent_n"],
                    "enabled": bool(row["enabled"]),
                    "last_checked_at": row["last_checked_at"],
                    "last_succeeded_at": row["last_succeeded_at"],
                },
            )
            for row in rows
        ]

    def archive_ups(self):
        with self.connection() as connection:
            return [dict(row) for row in connection.execute(
                """SELECT uid AS id, name AS nickname, avatar_url FROM identities
                ORDER BY uid COLLATE BINARY"""
            )]

    def add(self, uid, name, avatar_url):
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                if (
                    connection.execute(
                        "SELECT 1 FROM monitors WHERE uid = ?", (uid,)
                    ).fetchone()
                    is not None
                ):
                    raise APIError("ALREADY_MONITORED")
                connection.execute(
                    """INSERT INTO identities (uid, name, avatar_url) VALUES (?, ?, ?)
                    ON CONFLICT(uid) DO UPDATE SET name = excluded.name, avatar_url = excluded.avatar_url
                """,
                    (uid, name, avatar_url),
                )
                # 新增 UP 默认停止监控：先保存身份与配置，由用户显式启用后才进入检查/发现。
                connection.execute(
                    "INSERT INTO monitors (uid, enabled) VALUES (?, 0)",
                    (uid,),
                )
                refresh_selections(connection, uid)
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
        return self.read(uid)[0]

    def update(self, uid, mode, recent_n, enabled):
        with self.connection() as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            previous = connection.execute(
                "SELECT mode, recent_n, enabled FROM monitors WHERE uid = ?", (uid,)
            ).fetchone()
            if previous and tuple(previous) != (mode, recent_n, enabled):
                self.stop_discovery(connection, uid)
            result = connection.execute(
                "UPDATE monitors SET mode = ?, recent_n = ?, enabled = ? WHERE uid = ?",
                (mode, recent_n, enabled, uid),
            )
            if result.rowcount == 0:
                raise APIError("NOT_FOUND")
            selection_changed = (previous["mode"] != mode or previous["enabled"] != enabled
                                 or (mode == "recent" and previous["recent_n"] != recent_n))
            if selection_changed:
                refresh_selections(connection, uid, reset=True)
        return self.read(uid)[0]

    def targets(self, uid):
        with self.connection() as connection:
            if not connection.execute(
                "SELECT 1 FROM identities WHERE uid = ?", (uid,)
            ).fetchone():
                raise APIError("NOT_FOUND")
            return [{"id": row[0]} for row in connection.execute(
                "SELECT id FROM targets WHERE uid = ? ORDER BY id COLLATE BINARY", (uid,)
            )]

    def add_target(self, uid, id):
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                if not connection.execute(
                    "SELECT 1 FROM monitors WHERE uid = ?", (uid,)
                ).fetchone():
                    raise APIError("NOT_FOUND")
                connection.execute("INSERT OR IGNORE INTO targets (uid, id) VALUES (?, ?)", (uid, id))
                refresh_selections(connection, uid)
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
        return {"id": id}

    def delete_target(self, uid, id):
        with self.connection() as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            if not connection.execute("SELECT 1 FROM identities WHERE uid = ?", (uid,)).fetchone():
                raise APIError("NOT_FOUND")
            connection.execute("DELETE FROM targets WHERE uid = ? AND id = ?", (uid, id))
            refresh_selections(connection, uid)

    def selected_targets(self, uid, *, with_selection=False):
        saved = self.read(uid)
        if not saved:
            raise APIError("NOT_FOUND")
        # 与 enabled_targets/pending_checks 一致，默认保留 Store 列表契约。
        columns = "id, token AS selection" if with_selection else "id"
        with self.connection() as connection:
            return [dict(row) for row in connection.execute(
                f"SELECT {columns} FROM target_selections WHERE uid = ? ORDER BY id COLLATE BINARY", (uid,)
            )]

    def read_archive(self, id):
        with self.connection() as connection:
            row = connection.execute("SELECT document FROM archives WHERE id = ?", (id,)).fetchone()
        if row is None:
            return None
        document = json.loads(row[0])
        return {**document, **comment_status(document)}

    def read_archive_detail(self, id):
        # 归档与最新检查投影在同一只读快照内返回；无网络或状态变更。
        with self.connection() as connection:
            connection.execute("BEGIN")
            row = connection.execute("SELECT uid, document FROM archives WHERE id = ?", (id,)).fetchone()
            if row is None:
                return None
            document = json.loads(row["document"])
            checks = self._read_checks(connection, row["uid"])
            return {**document, **comment_status(document),
                    "comment_sync": next((check for check in checks if check["id"] == id), None)}

    def list_archives(self, limit=10, cursor=None, uid=None):
        # 保留已发布的全局 resource，使旧 cursor 与显式 all 互通。
        resource = ARCHIVE_RESOURCE if uid is None else f"dynamics:up:{uid}:published-desc:id-binary:v1"
        now = int(time.time())
        with self.connection() as connection:
            if uid is not None and not connection.execute(
                "SELECT 1 FROM identities WHERE uid = ?", (uid,)
            ).fetchone():
                raise APIError("UNKNOWN_UP")
            # 启动与每次列表读取回收过期页；不保留进程内长期快照。
            connection.execute("DELETE FROM archive_pages WHERE expires_at <= ?", (now,))
            if cursor is not None:
                if re.fullmatch(r"[a-f0-9]{32}", cursor) is None:
                    raise APIError("INVALID_INPUT")
                row = connection.execute(
                    """SELECT document FROM archive_pages WHERE token = ? AND batch_limit = ?
                    AND resource = ? AND expires_at > ?""",
                    (cursor, limit, resource, now),
                ).fetchone()
                if row is None:
                    raise APIError("INVALID_INPUT")
                return json.loads(row[0])
            connection.execute("BEGIN IMMEDIATE")
            try:
                # 同一短事务中冻结完整内容、顺序和批量；cursor 重读/重开不受更新影响。
                documents = [json.loads(row[0]) for row in connection.execute(
                    "SELECT document FROM archives"
                    + (" WHERE uid = ?" if uid is not None else "")
                    + " ORDER BY json_extract(document, '$.published_at') DESC, id COLLATE BINARY ASC",
                    (uid,) if uid is not None else (),
                )]
                documents = [{**document, **comment_status(document)} for document in documents]
                first, following = _freeze_pages(documents, limit)
                for token, result in following:
                    connection.execute("""INSERT INTO archive_pages
                        (token, batch_limit, document, expires_at, resource) VALUES (?, ?, ?, ?, ?)""",
                        (token, limit, json.dumps(result, ensure_ascii=False), now + SNAPSHOT_TTL_SECONDS, resource))
                connection.commit()
                return first
            except BaseException:
                connection.rollback()
                raise

    def claim_archive(self, uid, id, *, selection=None):
        identity = self.read(uid)[0]
        document = {
            "id": id,
            "author": {"id": uid, "nickname": identity["name"], "avatar_url": identity["avatar_url"]},
            "published_at": None, "edited_at": None, "edit_status": "unknown",
            "title": None, "text": "", "content_state": "failed", "last_attempt": "failed",
            "source_comment_count": None, "local_comment_count": 0,
            "media_sources": [], "media": [], "previous_media": [],
            "media_version": None, "synced_media_version": None, "media_last_attempt": "pending",
            "comment_locator": None,
            "observed_version": None, "synced_version": None,
            "local_reply_count": 0, "replies_last_attempt": "pending", "comments_last_attempt": "pending",
            "synced_comment_count": None, "synced_reply_comment_count": None,
            "work": {"text": "pending", "media": "pending", "comments": "pending", "replies": "pending"},
        }
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                # 已选集合与领取之间可能停止/删除；提交前重新核验配置与关联。
                current = selection_token(connection, uid, id)
                if not selection_matches(current, selection):
                    connection.commit()
                    return None
                row = connection.execute("SELECT uid FROM archives WHERE id = ?", (id,)).fetchone()
                if row and row[0] != uid:
                    raise APIError("TARGET_AUTHOR_MISMATCH")
                connection.execute("""INSERT INTO archives(id, uid, document, generation) VALUES (?, ?, ?, 1)
                    ON CONFLICT(id) DO UPDATE SET generation = archives.generation + 1""",
                    (id, uid, json.dumps(document, ensure_ascii=False)))
                generation = connection.execute("SELECT generation FROM archives WHERE id = ?", (id,)).fetchone()[0]
                outbox.claim_body(connection, uid, id, generation)
                connection.commit()
                return generation
            except BaseException:
                connection.rollback()
                raise

    def observe_archive(self, id, generation, metadata):
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute("SELECT document FROM archives WHERE id = ? AND generation = ?", (id, generation)).fetchone()
                if row is None:
                    connection.commit()
                    return False
                document = json.loads(row[0])
                updates = dict(metadata)
                if document["content_state"] == "success":
                    updates.pop("media_sources", None)
                    updates.pop("title", None)
                if "author" in updates:
                    updates["author"] = _merge_known(document["author"], updates["author"])
                document.update(updates)
                if updates.get("source_comment_count") is not None:
                    count = updates["source_comment_count"]
                    if count != document.get("synced_comment_count"):
                        document["work"]["comments"] = document["work"]["replies"] = "pending"
                    # 与动态观察原子提交，防止旧上传在两次提交间误清新工作。
                    # 未变观察的根已由观察/来源协调保持 observed != media ⇒ pending，不重复写回。
                    for root in connection.execute("""SELECT id, document FROM root_comments WHERE dynamic_id = ?
                        AND json_extract(document, '$.observed_version') IS NOT ?""",
                        (id, _comment_media_version(count))).fetchall():
                        root_document = json.loads(root["document"])
                        _observe_root_media(root_document, count)
                        self._write_media_owner(connection, id, root["id"], root_document)
                if "media_sources" in updates:
                    reconcile_media(document, updates["media_sources"], updates.get("observed_version"))
                    self._prune_media_attempts(connection, id, document["media"])
                restricted_current = (document["work"]["text"] == "restricted"
                                      and document.get("restricted_version") == document["observed_version"])
                if not restricted_current and document["observed_version"] != document["synced_version"]:
                    document["work"]["text"] = "pending"
                if not restricted_current and document["observed_version"] != document["media_version"]:
                    document["work"]["media"] = "pending"
                connection.execute("UPDATE archives SET document = ? WHERE id = ? AND generation = ?",
                                   (json.dumps(document, ensure_ascii=False), id, generation))
                connection.commit()
                return True
            except BaseException:
                connection.rollback()
                raise

    def finish_archive(self, id, generation, status, body, version, succeeded_at=None):
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute("SELECT document FROM archives WHERE id = ? AND generation = ?", (id, generation)).fetchone()
                if row is None:
                    connection.commit()
                    return False
                document = json.loads(row[0])
                # 未知/无效编辑信号无法将新正文绑定到可信版本；保留已有成功归档。
                if (status == "success" and version is None and document["observed_version"] is not None
                        and document["content_state"] == "success" and document["work"]["text"] == "pending"):
                    status = "failed"
                document["last_attempt"] = status
                if status == "success":
                    if (document["work"]["text"] in ("pending", "restricted")
                            or (version == document["observed_version"] and document["media_version"] != version)):
                        previous_media_version = document.get("media_version")
                        media_was_complete = document["work"]["media"] == "success"
                        document.update(body)
                        reconcile_media(document, document["media_sources"], version)
                        completed_at = succeeded_at or utc_now()
                        document["text_last_succeeded_at"] = completed_at
                        if document["work"]["media"] == "success" and (
                                not document["media"] or not media_was_complete or previous_media_version != version):
                            document["media_last_succeeded_at"] = completed_at
                        self._prune_media_attempts(connection, id, document["media"])
                        document["content_state"] = "success"
                        document.pop("restricted_version", None)
                        if version is not None:
                            document["synced_version"] = version
                        outbox.record_body(connection, id, generation, document, version)
                    document["work"]["text"] = (
                        "success" if document["observed_version"] == document["synced_version"] else "pending"
                    )
                else:
                    if document["content_state"] != "success":
                        document["content_state"] = status
                    if status == "restricted":
                        # 受限是本次观察的终态，不冒充正文/媒体上传成功，也不删除历史归档。
                        document["restricted_version"] = document["observed_version"]
                        document["work"]["text"] = "restricted"
                        if document["work"]["media"] != "success":
                            document["work"]["media"] = "restricted"
                    else:
                        document["work"]["text"] = "pending"
                connection.execute("UPDATE archives SET document = ? WHERE id = ? AND generation = ?",
                                   (json.dumps(document, ensure_ascii=False), id, generation))
                connection.commit()
                # 返回值仍表示实际正文成功；collector 另行识别受限终态。
                return status == "success" and document["work"]["text"] == "success"
            except BaseException:
                connection.rollback()
                raise

    def read_media_owner(self, id, root_id=None):
        with self.connection() as connection:
            return self._read_media_owner(connection, id, root_id)

    def _read_media_owner(self, connection, id, root_id):
        if root_id is None:
            row = connection.execute("SELECT document FROM archives WHERE id = ?", (id,)).fetchone()
        else:
            row = connection.execute("SELECT document FROM root_comments WHERE dynamic_id = ? AND id = ?",
                                     (id, root_id)).fetchone()
        return json.loads(row[0]) if row else None

    def _write_media_owner(self, connection, id, root_id, document):
        value = json.dumps(document, ensure_ascii=False)
        if root_id is None:
            connection.execute("UPDATE archives SET document = ? WHERE id = ?", (value, id))
        else:
            connection.execute("UPDATE root_comments SET document = ? WHERE dynamic_id = ? AND id = ?",
                               (value, id, root_id))

    def media_root_ids(self, id):
        with self.connection() as connection:
            return [row[0] for row in connection.execute(
                "SELECT id FROM root_comments WHERE dynamic_id = ? ORDER BY id COLLATE BINARY", (id,)
            )]

    def _prune_media_attempts(self, connection, id, media, root_id=None):
        # 来源切换后废弃旧令牌；当前组崩溃留下的令牌仍可由重试取代。
        connection.execute("""DELETE FROM media_attempts WHERE dynamic_id = ? AND root_id = ?
            AND media_id NOT IN (SELECT value FROM json_each(?))""",
                           (id, root_id or "", json.dumps([item["id"] for item in media])))

    def claim_media(self, id, media_id, root_id=None):
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                document = self._read_media_owner(connection, id, root_id)
                item = next((item for item in document["media"] if item["id"] == media_id), None) if document else None
                if item is None or item["status"] == "success":
                    connection.commit()
                    return None
                token = uuid4().hex
                connection.execute("""INSERT INTO media_attempts(dynamic_id, media_id, token, root_id) VALUES (?, ?, ?, ?)
                    ON CONFLICT(dynamic_id, media_id) DO UPDATE SET token = excluded.token""", (id, media_id, token, root_id or ""))
                item.update(status="pending", error=None)
                document["media_last_attempt"] = "pending"
                self._write_media_owner(connection, id, root_id, document)
                connection.commit()
                return token
            except BaseException:
                connection.rollback()
                raise

    def finish_media(self, id, media_id, token, public_url, error, root_id=None, succeeded_at=None):
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                document = self._read_media_owner(connection, id, root_id)
                item = next((item for item in document["media"] if item["id"] == media_id), None) if document else None
                claimed = connection.execute("DELETE FROM media_attempts WHERE dynamic_id = ? AND media_id = ? AND token = ? AND root_id = ?",
                                             (id, media_id, token, root_id or "")).rowcount
                if item is None or not claimed:
                    connection.commit()
                    return False
                item.update(public_url=public_url, status="failed" if error else "success", error=error)
                refresh_media_progress(document)
                if root_id is None and document["work"]["media"] == "success" and error is None:
                    document["media_last_succeeded_at"] = succeeded_at or utc_now()
                self._write_media_owner(connection, id, root_id, document)
                if root_id is not None:
                    self._refresh_comment_media_success(connection, id, succeeded_at, media_completed=error is None)
                connection.commit()
                return True
            except BaseException:
                connection.rollback()
                raise

    def settle_empty_media(self, id, root_id, version):
        """根评论组本来没有图片、又落后一个观察版本时按当前版本结算。

        计数回落会让 observed_version 与 media_version 分开，而 sync_media 的版本守卫
        会提前返回；如果没有这一步，work.media 永久 pending，目标每个节拍都会重新领工作。
        """
        if root_id is None:
            return False
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                document = self._read_media_owner(connection, id, root_id)
                if document is None or document.get("media") or document.get("media_sources"):
                    connection.commit()
                    return False
                document["media_version"] = version
                document["synced_media_version"] = version
                document.setdefault("work", {})["media"] = "success"
                document["media_last_attempt"] = "success"
                self._write_media_owner(connection, id, root_id, document)
                self._refresh_comment_media_success(connection, id, None, media_completed=True)
                connection.commit()
                return True
            except BaseException:
                connection.rollback()
                raise

    def _refresh_comment_media_success(self, connection, id, succeeded_at, *, media_completed=False):
        # 仅在实际根分页或上传提交时推进；读取/检查不补造旧归档的成功时间。
        row = connection.execute("SELECT document FROM archives WHERE id = ?", (id,)).fetchone()
        archive = json.loads(row[0])
        if (archive["work"].get("comments") != "success"
                or connection.execute("""SELECT 1 FROM root_comments WHERE dynamic_id = ?
                    AND json_extract(document, '$.work.media') IS NOT 'success' LIMIT 1""", (id,)).fetchone()):
            return
        # 有图时仅由真正的上传完成推进；全空组由实际成功根分页确认。
        # 旧成功图片缺时间不能在检查、读取或同版本重扫时被补成“刚上传”。
        has_images = connection.execute("""SELECT 1 FROM root_comments WHERE dynamic_id = ?
            AND json_array_length(document, '$.media') > 0 LIMIT 1""", (id,)).fetchone()
        if media_completed or not has_images:
            archive["comment_media_last_succeeded_at"] = succeeded_at or utc_now()
            self._write_media_owner(connection, id, None, archive)

    def begin_roots(self, id, generation):
        return self._change_roots(id, generation, "pending", None, [])

    def save_roots(self, id, generation, documents, observed_count):
        return self._change_roots(id, generation, "pending", observed_count, documents)

    def finish_roots(self, id, generation, status, observed_count, succeeded_at=None, *,
                     pin_known=False, pinned_id=None):
        return self._change_roots(id, generation, status, observed_count, [], succeeded_at,
                                  pin_known=pin_known, pinned_id=pinned_id)

    def _change_roots(self, id, generation, status, observed_count, documents, succeeded_at=None, *,
                      pin_known=False, pinned_id=None):
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute("SELECT document FROM archives WHERE id = ? AND generation = ?", (id, generation)).fetchone()
                if row is None:
                    connection.commit()
                    return False
                archive = json.loads(row[0])
                for document in documents:
                    previous = connection.execute(
                        "SELECT document FROM root_comments WHERE dynamic_id = ? AND id = ?", (id, document["id"])
                    ).fetchone()
                    sources = document["media_sources"]
                    if previous is not None:
                        document = _merge_comment(json.loads(previous[0]), document)
                    _reconcile_root_media(document, sources, observed_count, archive.get("source_comment_count"))
                    self._prune_media_attempts(connection, id, document["media"], document["id"])
                    if document["media_sources"] is None:
                        document["media_sources"] = []
                    connection.execute("""INSERT INTO root_comments(dynamic_id, id, document) VALUES (?, ?, ?)
                        ON CONFLICT(dynamic_id, id) DO UPDATE SET document = excluded.document""",
                        (id, document["id"], json.dumps(document, ensure_ascii=False)))
                archive["local_comment_count"] = connection.execute(
                    "SELECT count(*) FROM root_comments WHERE dynamic_id = ?", (id,)
                ).fetchone()[0]
                archive.setdefault("local_reply_count", 0)
                archive["root_comments_last_attempt"] = status
                archive["root_comments_error"] = (
                    "ROOT_COMMENTS_FAILED" if status == "failed" else
                    "COMMENT_LOCATOR_UNCONFIRMED" if status == "unconfirmed" else None)
                archive["replies_error"] = None
                archive["comments_error"] = archive["root_comments_error"]
                archive.setdefault("synced_root_comment_count", None)
                archive["work"]["comments"] = "pending"
                archive["work"]["replies"] = "pending"
                archive["replies_last_attempt"] = "pending"
                archive["comments_last_attempt"] = "pending" if status in ("pending", "success") else status
                if status == "success":
                    # 只有整轮分页成功才发布置顶状态；失败/缺失字段保留旧可信值。
                    # 取消置顶仅清标记，不删除历史评论，也不改写已冻结分页。
                    if pin_known:
                        connection.execute("""UPDATE root_comments SET document = json_set(
                            document, '$.is_pinned', json(CASE WHEN id = ? THEN 'true' ELSE 'false' END))
                            WHERE dynamic_id = ?""", (pinned_id, id))
                    archive["synced_root_metadata_version"] = ROOT_METADATA_VERSION
                    archive["synced_root_comment_count"] = observed_count
                    archive["root_comments_last_succeeded_at"] = succeeded_at or utc_now()
                    if archive.get("source_comment_count") == observed_count:
                        archive["work"]["comments"] = "success"
                connection.execute("UPDATE archives SET document = ? WHERE id = ? AND generation = ?",
                                   (json.dumps(archive, ensure_ascii=False), id, generation))
                if status == "success":
                    self._refresh_comment_media_success(connection, id, succeeded_at)
                connection.commit()
                return True
            except BaseException:
                connection.rollback()
                raise

    def list_roots(self, id, sort="hot", limit=20, cursor=None):
        resource = _root_resource(id, sort)
        with self.connection() as connection:
            if not connection.execute("SELECT 1 FROM archives WHERE id = ?", (id,)).fetchone():
                raise APIError("NOT_FOUND")
            if cursor is not None:
                if re.fullmatch(r"[a-f0-9]{32}", cursor) is not None:
                    row = connection.execute("""SELECT document FROM root_comment_pages
                        WHERE token = ? AND resource = ? AND batch_limit = ?""",
                        (cursor, resource, limit)).fetchone()
                    if row is None:
                        raise APIError("CURSOR_INVALID")
                    return json.loads(row[0])
                # 定位入口给出的续读游标不冻结整份快照：按当前排序重新取窗口，读取不写库。
                offset = _root_offset(resource, limit, cursor)
                if offset is None:
                    raise APIError("CURSOR_INVALID")
                return self._root_window(resource, limit, offset, self._ordered_roots(connection, id, sort))
            connection.execute("BEGIN IMMEDIATE")
            try:
                documents = self._ordered_roots(connection, id, sort)
                first, following = _freeze_pages(documents, limit)
                for token, result in following:
                    connection.execute("INSERT INTO root_comment_pages VALUES (?, ?, ?, ?)",
                                       (token, resource, limit, json.dumps(result, ensure_ascii=False)))
                connection.commit()
                return first
            except BaseException:
                connection.rollback()
                raise

    def locate_root(self, id, sort, root_id, limit=20):
        """按动态与目标评论身份给出以目标开头的批次；只读归档，不冻结快照也不访问上游。"""
        with self.connection() as connection:
            if not connection.execute("SELECT 1 FROM archives WHERE id = ?", (id,)).fetchone():
                raise APIError("NOT_FOUND")
            documents = self._ordered_roots(connection, id, sort)
            for index, document in enumerate(documents):
                if document["id"] == root_id:
                    return self._root_window(_root_resource(id, sort), limit, index, documents)
            # 目标属于别的动态或尚未归档：一律当作不存在，不暴露其他动态的评论。
            raise APIError("NOT_FOUND")

    def _ordered_roots(self, connection, id, sort):
        documents = [json.loads(row[0]) for row in connection.execute(
            "SELECT document FROM root_comments WHERE dynamic_id = ? ORDER BY " + _root_order(sort), (id,)
        )]
        self._attach_up_replies(connection, id, documents)
        return documents

    def _root_window(self, resource, limit, offset, documents):
        following = offset + limit
        return {
            "items": documents[offset:following],
            # 续读沿用同一排序与批量；无更多时为 null，不伪造结束结语。
            "next_cursor": _root_offset_cursor(resource, limit, following) if following < len(documents) else None,
        }

    def _attach_up_replies(self, connection, id, documents):
        """为楼中楼预览附上作者最早的一条回复；未参与讨论时为 null。"""
        row = connection.execute("SELECT uid FROM archives WHERE id = ?", (id,)).fetchone()
        if row is None:
            return
        authors = {document["id"]: document["author"] for document in documents}
        up_first = {}
        ordering = ("json_extract(document, '$.published_at') IS NULL ASC, "
                    "json_extract(document, '$.published_at') ASC, id COLLATE BINARY ASC")
        for stored in connection.execute(
                "SELECT document FROM replies WHERE dynamic_id = ? ORDER BY " + ordering, (id,)):
            reply = json.loads(stored[0])
            authors.setdefault(reply["id"], reply["author"])
            if reply["author"].get("id") == row[0]:
                up_first.setdefault(reply["root_id"], reply)
        for document in documents:
            reply = up_first.get(document["id"])
            parent = authors.get(reply["parent_id"]) if reply is not None else None
            document["up_reply"] = None if reply is None else {
                "id": reply["id"], "author": reply["author"], "published_at": reply["published_at"],
                "text": reply["text"], "like_count": reply["like_count"],
                # 直接回根评论不重复“回复 X”；回复其他楼才带目标昵称。
                "reply_to": None if reply["parent_id"] == document["id"] else parent,
            }

    def roots_for_replies(self, id, ids):
        with self.connection() as connection:
            documents = (json.loads(row[0]) for row in connection.execute(
                "SELECT document FROM root_comments WHERE dynamic_id = ? ORDER BY id COLLATE BINARY", (id,)
            ))
            return [document for document in documents if document["id"] in ids]

    def change_reply_root(self, id, generation, root_id, status, count=None, *, observed=None, succeeded_at=None):
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                if not connection.execute("SELECT 1 FROM archives WHERE id = ? AND generation = ?", (id, generation)).fetchone():
                    connection.commit()
                    return False
                # 只在成功时推进增量基准；失败保留上次可用的 rcount、来源数与时间。
                connection.execute("""INSERT INTO reply_sync
                    (dynamic_id, root_id, status, synced_source_reply_count, observed_reply_count, synced_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(dynamic_id, root_id) DO UPDATE SET status = excluded.status,
                    synced_source_reply_count = CASE WHEN excluded.status = 'success'
                    THEN excluded.synced_source_reply_count ELSE reply_sync.synced_source_reply_count END,
                    observed_reply_count = CASE WHEN excluded.status = 'success'
                    THEN excluded.observed_reply_count ELSE reply_sync.observed_reply_count END,
                    synced_at = CASE WHEN excluded.status = 'success'
                    THEN excluded.synced_at ELSE reply_sync.synced_at END""",
                    (id, root_id, status, count, observed,
                     (succeeded_at or utc_now()) if status == "success" else None))
                connection.commit()
                return True
            except BaseException:
                connection.rollback()
                raise

    def reply_progress(self, id):
        """逐根增量基准：上次成功时的根页 rcount、来源数与时间。"""
        with self.connection() as connection:
            return {row["root_id"]: {"status": row["status"],
                                     "source_count": row["synced_source_reply_count"],
                                     "observed_count": row["observed_reply_count"],
                                     "synced_at": row["synced_at"]}
                    for row in connection.execute(
                        "SELECT root_id, status, synced_source_reply_count, observed_reply_count, synced_at"
                        " FROM reply_sync WHERE dynamic_id = ?", (id,))}

    def save_replies(self, id, generation, root_id, documents, count):
        return self._change_replies(id, generation, "pending", None, root_id, documents, count)

    def finish_replies(self, id, generation, status, observed_count, succeeded_at=None):
        return self._change_replies(id, generation, status, observed_count, None, [], None, succeeded_at)

    def _change_replies(self, id, generation, status, observed_count, root_id, documents, count, succeeded_at=None):
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute("SELECT document FROM archives WHERE id = ? AND generation = ?", (id, generation)).fetchone()
                if row is None:
                    connection.commit()
                    return False
                archive = json.loads(row[0])
                for document in documents:
                    previous = connection.execute(
                        "SELECT document FROM replies WHERE dynamic_id = ? AND root_id = ? AND id = ?",
                        (id, root_id, document["id"])
                    ).fetchone()
                    if previous is not None:
                        document = _merge_comment(json.loads(previous[0]), document)
                    connection.execute("""INSERT INTO replies VALUES (?, ?, ?, ?)
                        ON CONFLICT(dynamic_id, root_id, id) DO UPDATE SET document = excluded.document""",
                        (id, root_id, document["id"], json.dumps(document, ensure_ascii=False)))
                if root_id is not None and count is not None:
                    root = json.loads(connection.execute(
                        "SELECT document FROM root_comments WHERE dynamic_id = ? AND id = ?", (id, root_id)
                    ).fetchone()[0])
                    root["source_reply_count"] = count
                    connection.execute("UPDATE root_comments SET document = ? WHERE dynamic_id = ? AND id = ?",
                                       (json.dumps(root, ensure_ascii=False), id, root_id))
                archive["local_reply_count"] = connection.execute(
                    "SELECT count(*) FROM replies WHERE dynamic_id = ?", (id,)
                ).fetchone()[0]
                archive["replies_last_attempt"] = status
                archive["replies_error"] = "REPLIES_FAILED" if status == "failed" else None
                archive["comments_error"] = archive.get("root_comments_error") or archive["replies_error"]
                archive["work"]["replies"] = "pending"
                if status == "success":
                    archive["replies_last_succeeded_at"] = succeeded_at or utc_now()
                    archive["synced_reply_comment_count"] = observed_count
                    if archive.get("source_comment_count") == observed_count:
                        archive["work"]["replies"] = "success"
                    if archive["work"]["comments"] == archive["work"]["replies"] == "success":
                        archive["comments_last_attempt"] = "success"
                        archive["synced_comment_count"] = observed_count
                        archive["comments_last_succeeded_at"] = archive["replies_last_succeeded_at"]
                elif status != "pending" and archive.get("root_comments_last_attempt") == "success":
                    archive["comments_last_attempt"] = status
                connection.execute("UPDATE archives SET document = ? WHERE id = ? AND generation = ?",
                                   (json.dumps(archive, ensure_ascii=False), id, generation))
                connection.commit()
                return True
            except BaseException:
                connection.rollback()
                raise

    def list_replies(self, id, root_id, cursor=None, page=None):
        resource = f"replies:{id}:{root_id}:time-asc:id-binary:3-10:v1"
        with self.connection() as connection:
            if page is not None:
                if cursor is not None:
                    raise APIError("INVALID_INPUT")
                # 页码读取在同一短只读事务内取得根、回复、计数与状态，不访问持久分页快照。
                connection.execute("BEGIN")
            row = connection.execute("SELECT document FROM root_comments WHERE dynamic_id = ? AND id = ?", (id, root_id)).fetchone()
            if row is None:
                raise APIError("NOT_FOUND")
            if cursor is not None:
                if re.fullmatch(r"[a-f0-9]{32}", cursor) is None:
                    raise APIError("CURSOR_INVALID")
                saved = connection.execute("SELECT document FROM reply_pages WHERE token = ? AND resource = ?", (cursor, resource)).fetchone()
                if saved is None:
                    raise APIError("CURSOR_INVALID")
                return json.loads(saved[0])
            if page is None:
                connection.execute("BEGIN IMMEDIATE")
            try:
                root = json.loads(connection.execute(
                    "SELECT document FROM root_comments WHERE dynamic_id = ? AND id = ?", (id, root_id)
                ).fetchone()[0])
                documents = [json.loads(row[0]) for row in connection.execute(
                    """SELECT document FROM replies WHERE dynamic_id = ? AND root_id = ? ORDER BY
                    json_extract(document, '$.published_at') IS NULL ASC,
                    json_extract(document, '$.published_at') ASC, id COLLATE BINARY ASC""", (id, root_id)
                )]
                authors = {item["id"]: item["author"] for item in [root] + documents}
                for document in documents:
                    author = authors.get(document["parent_id"])
                    document["reply_to"] = author if author and author.get("id") is not None else None
                progress = connection.execute("SELECT status, synced_source_reply_count FROM reply_sync WHERE dynamic_id = ? AND root_id = ?",
                                              (id, root_id)).fetchone()
                metadata = {"source_reply_count": root.get("source_reply_count"), "local_reply_count": len(documents),
                            "replies_last_attempt": progress["status"] if progress else "pending",
                            "synced_source_reply_count": progress["synced_source_reply_count"] if progress else None}
                if page is not None:
                    # 超长正整数页码必然越界，避免转换为 Python/SQLite 整数时溢出。
                    offset = (int(page) - 1) * 10 if len(str(page)) <= len(str(len(documents))) else len(documents)
                    result = {"items": documents[offset:offset + 10], "next_cursor": None,
                              "root": root, "count": len(documents), **metadata}
                    connection.commit()
                    return result
                # 预览与追加是同一持久读取上下文，不按首批大小切所有后续页。
                first, following = _freeze_pages(documents[3:], 10)
                result = {"items": documents[:3], "next_cursor": uuid4().hex if documents[3:] else None}
                # 楼中楼详情页需要根评论本身；只在首批返回，不重复到后续分页。
                result["root"] = root
                pages = [(result["next_cursor"], first)] + following if documents[3:] else []
                result.update(metadata)
                for token, page in pages:
                    page.update(metadata)
                    connection.execute("INSERT INTO reply_pages VALUES (?, ?, ?)",
                                       (token, resource, json.dumps(page, ensure_ascii=False)))
                connection.commit()
                return result
            except BaseException:
                connection.rollback()
                raise

    def delete_monitor(self, uid):
        with self.connection() as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            if (
                connection.execute(
                    "SELECT 1 FROM identities WHERE uid = ?", (uid,)
                ).fetchone()
                is None
            ):
                raise APIError("NOT_FOUND")
            self.stop_discovery(connection, uid)
            connection.execute("DELETE FROM monitors WHERE uid = ?", (uid,))
            refresh_selections(connection, uid)
