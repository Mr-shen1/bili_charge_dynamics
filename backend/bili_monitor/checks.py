"""持久检查与工作状态；网络读取由独立采集进程负责。"""

import json
from contextlib import contextmanager

from .contracts import APIError


ACTIVE_TARGET = """SELECT 1 FROM targets t JOIN monitors m ON m.uid = t.uid
    WHERE t.uid = ? AND t.id = ? AND m.enabled = 1 AND m.mode = 'specified'"""
ARCHIVE_SIGNALS = """json_object(
    'author', json_extract(a.document, '$.author'),
    'published_at', json_extract(a.document, '$.published_at'),
    'edited_at', json_extract(a.document, '$.edited_at'),
    'edit_status', json_extract(a.document, '$.edit_status'),
    'observed_version', json_extract(a.document, '$.observed_version'),
    'source_comment_count', json_extract(a.document, '$.source_comment_count'))"""
SIGNALS = {"published_at", "edited_at", "edit_status", "observed_version",
           "edited_version", "source_comment_count", "comment_locator"}


def safe_error(error):
    if error is None:
        return None
    return error if error in ("SIGNAL_INVALID", "SYNC_INCOMPLETE") else "SOURCE_UNAVAILABLE"


def trusted_version(metadata):
    if metadata.get("edit_status") in ("unknown", "error"):
        return None
    return metadata.get("edited_version") or metadata.get("observed_version")


def merge_signals(previous, metadata):
    updates = {key: value for key, value in metadata.items()
               if key in SIGNALS and value is not None}
    if trusted_version(metadata) is None:
        for key in ("edited_at", "edited_version", "observed_version"):
            updates.pop(key, None)
    observed = {**previous, **updates}
    if isinstance(metadata.get("author"), dict):
        observed["author"] = {**previous.get("author", {}), **{
            key: value for key, value in metadata["author"].items()
            if key in ("id", "nickname", "avatar_url") and value is not None
        }}
    return observed


@contextmanager
def transaction(store):
    with store.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise


def archive_complete(connection, uid, id, observed):
    # 已保留的可信版本不因最近信号 unknown/error 而失效；正文/根文档不加载到写事务。
    version = observed.get("observed_version")
    return connection.execute("""SELECT 1 FROM archives a WHERE a.uid = ? AND a.id = ?
        AND json_extract(a.document, '$.observed_version') IS ?
        AND json_extract(a.document, '$.synced_version') IS ?
        AND json_extract(a.document, '$.work.text') = 'success'
        AND json_extract(a.document, '$.work.media') = 'success'
        AND json_extract(a.document, '$.work.comments') = 'success'
        AND json_extract(a.document, '$.work.replies') = 'success'
        AND NOT EXISTS (SELECT 1 FROM root_comments r WHERE r.dynamic_id = a.id
            AND json_extract(r.document, '$.work.media') IS NOT 'success')""",
        (uid, id, version, version)).fetchone() is not None


class CheckStore:
    """Store 的检查能力，使用同一 SQLite 连接边界与身份生命周期。"""

    def enabled_targets(self):
        with self.connection() as connection:
            return [dict(row) for row in connection.execute("""SELECT t.uid, t.id
                FROM targets t JOIN monitors m ON m.uid = t.uid
                WHERE m.enabled = 1 AND m.mode = 'specified'
                ORDER BY t.uid COLLATE BINARY, t.id COLLATE BINARY""")]

    def record_check(self, uid, id, metadata, checked_at, error=None):
        with transaction(self) as connection:
            if not connection.execute(ACTIVE_TARGET, (uid, id)).fetchone():
                return False
            row = connection.execute("SELECT * FROM target_checks WHERE uid = ? AND id = ?", (uid, id)).fetchone()
            if row:
                previous = json.loads(row["observed"])
            else:
                archived = connection.execute(f"SELECT {ARCHIVE_SIGNALS} FROM archives a WHERE a.uid = ? AND a.id = ?",
                                              (uid, id)).fetchone()
                # 归档已保存的版本仍可信，即使最近一次 edit_status 为 unknown/error。
                previous = {key: value for key, value in json.loads(archived[0]).items()
                            if value is not None} if archived else {}
            failed = error is not None or metadata is None
            readable = metadata is not None and (not failed or (
                error == "SIGNAL_INVALID" and metadata.get("edit_status") == "error"))
            observed = merge_signals(previous, metadata) if readable else previous
            version = None if failed else trusted_version(metadata)
            # 未知信号不清除可信旧版本；计数和作者变化不推进 revision。
            changed = row is None or (version is not None and version != (
                previous.get("edited_version") or previous.get("observed_version")))
            revision = (row["revision"] + int(changed)) if row else 1
            work = row["work"] if row else "pending"
            if row is None and not failed and archive_complete(connection, uid, id, observed):
                work = "complete"
            elif changed and work != "running":
                work = "pending"
            status = "failed" if failed else ("checked" if changed else "unchanged")
            connection.execute("""INSERT INTO target_checks
                (uid, id, last_checked_at, check_status, observed, revision, work, check_error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(uid, id) DO UPDATE SET last_checked_at = excluded.last_checked_at,
                check_status = excluded.check_status, observed = excluded.observed,
                revision = excluded.revision, work = excluded.work, check_error = excluded.check_error""",
                (uid, id, checked_at, status, json.dumps(observed, ensure_ascii=False), revision,
                 work, safe_error(error) if error is not None else ("SOURCE_UNAVAILABLE" if failed else None)))
            return True

    def read_checks(self, uid):
        with self.connection() as connection:
            # 一个读取快照内核验身份并读取状态，不修改任务或请求上游。
            connection.execute("BEGIN")
            if not connection.execute("SELECT 1 FROM identities WHERE uid = ?", (uid,)).fetchone():
                raise APIError("NOT_FOUND")
            rows = connection.execute(f"""SELECT ids.id, c.last_checked_at, c.last_succeeded_at,
                c.check_status, CASE WHEN c.observed IS NOT NULL THEN c.observed
                    WHEN a.id IS NOT NULL THEN {ARCHIVE_SIGNALS} ELSE NULL END AS observed,
                c.revision, c.work, c.check_error, c.sync_error,
                json_extract(a.document, '$.work') AS parts,
                json_extract(a.document, '$.synced_version') AS synced_version,
                CASE WHEN a.id IS NOT NULL AND json_extract(a.document, '$.work.comments') = 'success'
                    AND NOT EXISTS (SELECT 1 FROM root_comments r WHERE r.dynamic_id = a.id
                        AND json_extract(r.document, '$.work.media') IS NOT 'success')
                    THEN 'success' ELSE 'pending' END AS comment_media,
                CASE WHEN t.id IS NOT NULL AND m.enabled = 1 AND m.mode = 'specified'
                     THEN 1 ELSE 0 END AS active
                FROM (SELECT uid, id FROM targets WHERE uid = ? UNION
                      SELECT uid, id FROM target_checks WHERE uid = ?) ids
                LEFT JOIN target_checks c ON c.uid = ? AND c.id = ids.id
                LEFT JOIN targets t ON t.uid = ? AND t.id = ids.id
                LEFT JOIN monitors m ON m.uid = ?
                LEFT JOIN archives a ON a.uid = ids.uid AND a.id = ids.id
                ORDER BY ids.id COLLATE BINARY""",
                (uid, uid, uid, uid, uid)).fetchall()
        return [{"id": row["id"], "active": bool(row["active"]),
                 "last_checked_at": row["last_checked_at"], "last_succeeded_at": row["last_succeeded_at"],
                 "check_status": row["check_status"] or "unchecked",
                 "observed": json.loads(row["observed"]) if row["observed"] else {},
                 "revision": row["revision"] or 0, "work": row["work"] or "pending",
                 "check_error": row["check_error"], "sync_error": row["sync_error"],
                 "synced_version": row["synced_version"],
                 "parts": {**(json.loads(row["parts"]) if row["parts"] else
                              dict.fromkeys(("text", "media", "comments", "replies"), "pending")),
                           "comment_media": row["comment_media"]}} for row in rows]

    def pending_checks(self):
        with self.connection() as connection:
            return [dict(row) for row in connection.execute("""SELECT c.uid, c.id
                FROM target_checks c JOIN targets t ON t.uid = c.uid AND t.id = c.id
                JOIN monitors m ON m.uid = c.uid
                WHERE c.work = 'pending' AND m.enabled = 1 AND m.mode = 'specified'
                ORDER BY c.uid COLLATE BINARY, c.id COLLATE BINARY""")]

    def claim_check_work(self, uid, id):
        with transaction(self) as connection:
            if not connection.execute(ACTIVE_TARGET, (uid, id)).fetchone():
                return None
            row = connection.execute("""SELECT revision, observed FROM target_checks
                WHERE uid = ? AND id = ? AND work = 'pending'""", (uid, id)).fetchone()
            if row is None:
                return None
            connection.execute("UPDATE target_checks SET work = 'running' WHERE uid = ? AND id = ?", (uid, id))
            return {"revision": row["revision"], "observed": json.loads(row["observed"])}

    def finish_check_work(self, uid, id, revision, succeeded, finished_at, error=None):
        with transaction(self) as connection:
            row = connection.execute("SELECT revision, work FROM target_checks WHERE uid = ? AND id = ?", (uid, id)).fetchone()
            if row is None or row["work"] != "running":
                return False
            complete = succeeded and row["revision"] == revision
            connection.execute("""UPDATE target_checks SET work = ?,
                last_succeeded_at = CASE WHEN ? THEN ? ELSE last_succeeded_at END,
                sync_error = ? WHERE uid = ? AND id = ?""",
                ("complete" if complete else "pending", complete, finished_at,
                 None if succeeded else (safe_error(error) or "SOURCE_UNAVAILABLE"), uid, id))
            return bool(complete)

    def recover_check_work(self):
        # 仅由已取得进程锁的独立 collector 显式调用；API 启动不得恢复。
        with transaction(self) as connection:
            connection.execute("UPDATE target_checks SET work = 'pending' WHERE work = 'running'")
