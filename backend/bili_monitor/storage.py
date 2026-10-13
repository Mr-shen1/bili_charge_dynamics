"""身份与配置分离；每次操作独立连接，网络不进入 SQLite 事务。"""

import json
import sqlite3
import re
import time
from uuid import uuid4
from contextlib import contextmanager
from pathlib import Path

from .contracts import APIError
from .media import reconcile_media, refresh_media_progress


SNAPSHOT_TTL_SECONDS = 15 * 60
ARCHIVE_RESOURCE = "dynamics:all:published-desc:id-binary:v1"


def _merge_known(previous, observed):
    return {**previous, **{key: value for key, value in observed.items() if value is not None}}


def _merge_comment(previous, observed):
    document = _merge_known(previous, observed)
    document["author"] = _merge_known(previous["author"], observed["author"])
    return document


def _freeze_pages(documents, limit):
    pages = [documents[i:i + limit] for i in range(0, len(documents), limit)] or [[]]
    tokens = [uuid4().hex for _ in pages]
    results = [{"items": page, "next_cursor": tokens[i + 1] if i + 1 < len(pages) else None}
               for i, page in enumerate(pages)]
    return results[0], list(zip(tokens[1:], results[1:]))


class Store:
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
                if version > 8:
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
                connection.execute("PRAGMA user_version = 8")
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    def read(self, uid=None):
        with self.connection() as connection:
            rows = connection.execute(
                """SELECT i.uid, i.name, i.avatar_url,
                m.uid AS monitor_uid, m.mode, m.recent_n, m.enabled
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
                    "last_checked_at": None,
                    "last_succeeded_at": None,
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
                connection.execute("INSERT INTO monitors (uid) VALUES (?)", (uid,))
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
        return self.read(uid)[0]

    def update(self, uid, mode, recent_n, enabled):
        with self.connection() as connection:
            result = connection.execute(
                "UPDATE monitors SET mode = ?, recent_n = ?, enabled = ? WHERE uid = ?",
                (mode, recent_n, enabled, uid),
            )
            if result.rowcount == 0:
                raise APIError("NOT_FOUND")
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
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
        return {"id": id}

    def delete_target(self, uid, id):
        with self.connection() as connection:
            if not connection.execute("SELECT 1 FROM identities WHERE uid = ?", (uid,)).fetchone():
                raise APIError("NOT_FOUND")
            connection.execute("DELETE FROM targets WHERE uid = ? AND id = ?", (uid, id))

    def selected_targets(self, uid):
        saved = self.read(uid)
        if not saved:
            raise APIError("NOT_FOUND")
        monitor = saved[0]["monitor"]
        if not monitor or not monitor["enabled"] or monitor["mode"] != "specified":
            return []
        return self.targets(uid)

    def read_archive(self, id):
        with self.connection() as connection:
            row = connection.execute("SELECT document FROM archives WHERE id = ?", (id,)).fetchone()
        return json.loads(row[0]) if row else None

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

    def claim_archive(self, uid, id):
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
                if not connection.execute("""SELECT 1 FROM targets t JOIN monitors m ON m.uid = t.uid
                    WHERE t.uid = ? AND t.id = ? AND m.enabled = 1 AND m.mode = 'specified'""", (uid, id)).fetchone():
                    connection.commit()
                    return None
                row = connection.execute("SELECT uid FROM archives WHERE id = ?", (id,)).fetchone()
                if row and row[0] != uid:
                    raise APIError("TARGET_AUTHOR_MISMATCH")
                connection.execute("""INSERT INTO archives(id, uid, document, generation) VALUES (?, ?, ?, 1)
                    ON CONFLICT(id) DO UPDATE SET generation = archives.generation + 1""",
                    (id, uid, json.dumps(document, ensure_ascii=False)))
                generation = connection.execute("SELECT generation FROM archives WHERE id = ?", (id,)).fetchone()[0]
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
                if "author" in updates:
                    updates["author"] = _merge_known(document["author"], updates["author"])
                document.update(updates)
                if "media_sources" in updates:
                    reconcile_media(document, updates["media_sources"], updates.get("observed_version"))
                    self._prune_media_attempts(connection, id, document["media"])
                if document["observed_version"] != document["synced_version"]:
                    document["work"]["text"] = "pending"
                if document["observed_version"] != document["media_version"]:
                    document["work"]["media"] = "pending"
                connection.execute("UPDATE archives SET document = ? WHERE id = ? AND generation = ?",
                                   (json.dumps(document, ensure_ascii=False), id, generation))
                connection.commit()
                return True
            except BaseException:
                connection.rollback()
                raise

    def finish_archive(self, id, generation, status, body, version):
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute("SELECT document FROM archives WHERE id = ? AND generation = ?", (id, generation)).fetchone()
                if row is None:
                    connection.commit()
                    return False
                document = json.loads(row[0])
                document["last_attempt"] = status
                if status == "success":
                    if document["work"]["text"] == "pending":
                        document.update(body)
                        reconcile_media(document, document["media_sources"], version)
                        self._prune_media_attempts(connection, id, document["media"])
                        document["content_state"] = "success"
                        if version is not None:
                            document["synced_version"] = version
                    document["work"]["text"] = (
                        "success" if document["observed_version"] == document["synced_version"] else "pending"
                    )
                else:
                    if document["content_state"] != "success":
                        document["content_state"] = status
                    document["work"]["text"] = "pending"
                connection.execute("UPDATE archives SET document = ? WHERE id = ? AND generation = ?",
                                   (json.dumps(document, ensure_ascii=False), id, generation))
                connection.commit()
                # 只有当前可信观察版本已提交 checkpoint 才计正文成功。
                return status == "success" and document["work"]["text"] == "success"
            except BaseException:
                connection.rollback()
                raise

    def _prune_media_attempts(self, connection, id, media):
        # 来源切换后废弃旧令牌；当前组崩溃留下的令牌仍可由重试取代。
        connection.execute("""DELETE FROM media_attempts WHERE dynamic_id = ?
            AND media_id NOT IN (SELECT value FROM json_each(?))""",
                           (id, json.dumps([item["id"] for item in media])))

    def claim_media(self, id, media_id):
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute("SELECT document FROM archives WHERE id = ?", (id,)).fetchone()
                document = json.loads(row[0]) if row else None
                item = next((item for item in document["media"] if item["id"] == media_id), None) if document else None
                if item is None or item["status"] == "success":
                    connection.commit()
                    return None
                token = uuid4().hex
                connection.execute("""INSERT INTO media_attempts VALUES (?, ?, ?)
                    ON CONFLICT(dynamic_id, media_id) DO UPDATE SET token = excluded.token""", (id, media_id, token))
                item.update(status="pending", error=None)
                document["media_last_attempt"] = "pending"
                connection.execute("UPDATE archives SET document = ? WHERE id = ?",
                                   (json.dumps(document, ensure_ascii=False), id))
                connection.commit()
                return token
            except BaseException:
                connection.rollback()
                raise

    def finish_media(self, id, media_id, token, public_url, error):
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute("SELECT document FROM archives WHERE id = ?", (id,)).fetchone()
                document = json.loads(row[0]) if row else None
                item = next((item for item in document["media"] if item["id"] == media_id), None) if document else None
                claimed = connection.execute("DELETE FROM media_attempts WHERE dynamic_id = ? AND media_id = ? AND token = ?",
                                             (id, media_id, token)).rowcount
                if item is None or not claimed:
                    connection.commit()
                    return False
                item.update(public_url=public_url, status="failed" if error else "success", error=error)
                refresh_media_progress(document)
                connection.execute("UPDATE archives SET document = ? WHERE id = ?",
                                   (json.dumps(document, ensure_ascii=False), id))
                connection.commit()
                return True
            except BaseException:
                connection.rollback()
                raise

    def begin_roots(self, id, generation):
        return self._change_roots(id, generation, "pending", None, [])

    def save_roots(self, id, generation, documents):
        return self._change_roots(id, generation, "pending", None, documents)

    def finish_roots(self, id, generation, status, observed_count):
        return self._change_roots(id, generation, status, observed_count, [])

    def _change_roots(self, id, generation, status, observed_count, documents):
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
                    if previous is not None:
                        document = _merge_comment(json.loads(previous[0]), document)
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
                archive.setdefault("synced_root_comment_count", None)
                archive["work"]["comments"] = "pending"
                archive["work"]["replies"] = "pending"
                archive["replies_last_attempt"] = "pending"
                archive["comments_last_attempt"] = "pending" if status in ("pending", "success") else status
                if status == "success":
                    archive["synced_root_comment_count"] = observed_count
                    if archive.get("source_comment_count") == observed_count:
                        archive["work"]["comments"] = "success"
                connection.execute("UPDATE archives SET document = ? WHERE id = ? AND generation = ?",
                                   (json.dumps(archive, ensure_ascii=False), id, generation))
                connection.commit()
                return True
            except BaseException:
                connection.rollback()
                raise

    def list_roots(self, id, sort="hot", limit=20, cursor=None):
        resource = f"root-comments:{id}:{sort}:v1"
        with self.connection() as connection:
            if not connection.execute("SELECT 1 FROM archives WHERE id = ?", (id,)).fetchone():
                raise APIError("NOT_FOUND")
            if cursor is not None:
                if re.fullmatch(r"[a-f0-9]{32}", cursor) is None:
                    raise APIError("CURSOR_INVALID")
                row = connection.execute("""SELECT document FROM root_comment_pages
                    WHERE token = ? AND resource = ? AND batch_limit = ?""", (cursor, resource, limit)).fetchone()
                if row is None:
                    raise APIError("CURSOR_INVALID")
                return json.loads(row[0])
            connection.execute("BEGIN IMMEDIATE")
            try:
                documents = [json.loads(row[0]) for row in connection.execute(
                    "SELECT document FROM root_comments WHERE dynamic_id = ? ORDER BY "
                    + ("json_extract(document, '$.like_count') DESC, " if sort == "hot" else "")
                    + "json_extract(document, '$.published_at') DESC, id COLLATE BINARY ASC", (id,)
                )]
                first, following = _freeze_pages(documents, limit)
                for token, result in following:
                    connection.execute("INSERT INTO root_comment_pages VALUES (?, ?, ?, ?)",
                                       (token, resource, limit, json.dumps(result, ensure_ascii=False)))
                connection.commit()
                return first
            except BaseException:
                connection.rollback()
                raise

    def roots_for_replies(self, id, ids):
        with self.connection() as connection:
            documents = (json.loads(row[0]) for row in connection.execute(
                "SELECT document FROM root_comments WHERE dynamic_id = ? ORDER BY id COLLATE BINARY", (id,)
            ))
            return [document for document in documents if document["id"] in ids]

    def change_reply_root(self, id, generation, root_id, status, count=None):
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                if not connection.execute("SELECT 1 FROM archives WHERE id = ? AND generation = ?", (id, generation)).fetchone():
                    connection.commit()
                    return False
                connection.execute("""INSERT INTO reply_sync VALUES (?, ?, ?, ?)
                    ON CONFLICT(dynamic_id, root_id) DO UPDATE SET status = excluded.status,
                    synced_source_reply_count = CASE WHEN excluded.status = 'success'
                    THEN excluded.synced_source_reply_count ELSE reply_sync.synced_source_reply_count END""",
                    (id, root_id, status, count))
                connection.commit()
                return True
            except BaseException:
                connection.rollback()
                raise

    def save_replies(self, id, generation, root_id, documents, count):
        return self._change_replies(id, generation, "pending", None, root_id, documents, count)

    def finish_replies(self, id, generation, status, observed_count):
        return self._change_replies(id, generation, status, observed_count, None, [], None)

    def _change_replies(self, id, generation, status, observed_count, root_id, documents, count):
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
                archive["work"]["replies"] = "pending"
                if status == "success":
                    archive["synced_reply_comment_count"] = observed_count
                    if archive.get("source_comment_count") == observed_count:
                        archive["work"]["replies"] = "success"
                    if archive["work"]["comments"] == archive["work"]["replies"] == "success":
                        archive["comments_last_attempt"] = "success"
                        archive["synced_comment_count"] = observed_count
                elif status != "pending" and archive.get("root_comments_last_attempt") == "success":
                    archive["comments_last_attempt"] = status
                connection.execute("UPDATE archives SET document = ? WHERE id = ? AND generation = ?",
                                   (json.dumps(archive, ensure_ascii=False), id, generation))
                connection.commit()
                return True
            except BaseException:
                connection.rollback()
                raise

    def list_replies(self, id, root_id, cursor=None):
        resource = f"replies:{id}:{root_id}:time-asc:id-binary:3-10:v1"
        with self.connection() as connection:
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
                # 预览与追加是同一持久读取上下文，不按首批大小切所有后续页。
                first, following = _freeze_pages(documents[3:], 10)
                result = {"items": documents[:3], "next_cursor": uuid4().hex if documents[3:] else None}
                pages = [(result["next_cursor"], first)] + following if documents[3:] else []
                progress = connection.execute("SELECT status, synced_source_reply_count FROM reply_sync WHERE dynamic_id = ? AND root_id = ?",
                                              (id, root_id)).fetchone()
                metadata = {"source_reply_count": root.get("source_reply_count"), "local_reply_count": len(documents),
                            "replies_last_attempt": progress["status"] if progress else "pending",
                            "synced_source_reply_count": progress["synced_source_reply_count"] if progress else None}
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
        with self.connection() as connection:
            if (
                connection.execute(
                    "SELECT 1 FROM identities WHERE uid = ?", (uid,)
                ).fetchone()
                is None
            ):
                raise APIError("NOT_FOUND")
            connection.execute("DELETE FROM monitors WHERE uid = ?", (uid,))
