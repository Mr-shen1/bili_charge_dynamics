"""持久检查与工作状态；网络读取由独立采集进程负责。"""

import json
from contextlib import contextmanager
from uuid import uuid4

from .contracts import APIError
from .comment_status import COMMENT_STATUS_FIELDS, ROOT_METADATA_VERSION
from .selection import SELECTED_TARGETS, selection_token, selection_matches


ARCHIVE_SIGNALS = """json_object(
    'author', json_extract(a.document, '$.author'),
    'published_at', json_extract(a.document, '$.published_at'),
    'edited_at', json_extract(a.document, '$.edited_at'),
    'edit_status', json_extract(a.document, '$.edit_status'),
    'observed_version', json_extract(a.document, '$.observed_version'),
    'content_visible', json_extract(a.document, '$.content_visible'),
    'source_comment_count', json_extract(a.document, '$.source_comment_count'),
    'comment_locator', json_extract(a.document, '$.comment_locator'))"""
SIGNALS = {"published_at", "edited_at", "edit_status", "observed_version",
           "edited_version", "source_comment_count", "comment_locator", "comment_count_status",
           "content_visible"}


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


def check_parts(row):
    parts = json.loads(row["parts"]) if row["parts"] else dict.fromkeys(
        ("text", "media", "comments", "replies"), "pending")
    observed = json.loads(row["observed"]) if row["observed"] else {}
    # 管理分项针对最新检查观察；旧归档成功不能冒充新正文/媒体完成。
    version = observed.get("observed_version")
    restricted_current = (parts["text"] == "restricted"
                          and row["restricted_version"] == version
                          and observed.get("content_visible") is not True)
    if not restricted_current and (version != row["synced_version"] or parts["text"] == "restricted"):
        parts["text"] = "pending"
    if not restricted_current and version != row["media_version"]:
        parts["media"] = "pending"
    count = observed.get("source_comment_count")
    roots_current = count == row["synced_root_comment_count"]
    if not roots_current:
        parts["comments"] = "pending"
    if count != row["synced_reply_comment_count"]:
        parts["replies"] = "pending"
    return {**parts, "comment_media": row["comment_media"] if roots_current else "pending"}


def archive_complete(connection, uid, id, observed, *, media_upload=True):
    # 已保留的可信版本不因最近信号 unknown/error 而失效；正文/根文档不加载到写事务。
    version = observed.get("observed_version")
    locator = observed.get("comment_locator") or {}
    # 未配置媒体上传时 media.py 直接返回、从不推进媒体状态，有图的归档永远无法完成。
    # 此时不把媒体作为完成条件，否则目标永久未完成并每 tick 重领工作；
    # 媒体分项仍如实保持 pending，不冒充已上传。
    media_clause, media_args = ("""
        AND ((json_extract(a.document, '$.work.media') = 'success'
              AND json_extract(a.document, '$.media_version') IS ?)
             OR (json_extract(a.document, '$.work.media') = 'restricted'
                 AND json_extract(a.document, '$.work.text') = 'restricted'))
        AND NOT EXISTS (SELECT 1 FROM root_comments r WHERE r.dynamic_id = a.id
            AND json_extract(r.document, '$.work.media') IS NOT 'success')""",
                                   (version,)) if media_upload else ("", ())
    return connection.execute("""SELECT 1 FROM archives a WHERE a.uid = ? AND a.id = ?
        AND json_extract(a.document, '$.observed_version') IS ?
        AND ((json_extract(a.document, '$.work.text') = 'success'
              AND json_extract(a.document, '$.synced_version') IS ?)
             OR (json_extract(a.document, '$.work.text') = 'restricted'
                 AND json_extract(a.document, '$.restricted_version') IS ? AND ? = 0))
        AND json_extract(a.document, '$.synced_comment_count') IS ?
        AND json_extract(a.document, '$.comment_locator.oid') IS ?
        AND json_extract(a.document, '$.comment_locator.type') IS ?
        AND json_extract(a.document, '$.work.comments') = 'success'
        AND json_extract(a.document, '$.work.replies') = 'success'
        AND json_extract(a.document, '$.synced_root_metadata_version') >= ?""" + media_clause,
        (uid, id, version, version, version, int(observed.get("content_visible") is True),
         observed.get("source_comment_count"), locator.get("oid"), locator.get("type"),
         ROOT_METADATA_VERSION) + media_args).fetchone() is not None


class CheckStore:
    """Store 的检查能力，使用同一 SQLite 连接边界与身份生命周期。"""

    def enabled_targets(self, *, with_selection=False):
        # 默认保留 Store 既有返回形状；采集快照附内部资格，HTTP 不暴露令牌。
        columns = "uid, id, token AS selection" if with_selection else "uid, id"
        with self.connection() as connection:
            return [dict(row) for row in connection.execute(f"""SELECT {columns}
                FROM target_selections ORDER BY uid COLLATE BINARY, id COLLATE BINARY""")]

    def check_selection(self, uid, id):
        with self.connection() as connection:
            return selection_token(connection, uid, id)

    def record_check(self, uid, id, metadata, checked_at, error=None, *, comment_observation=None,
                     selection=None, media_upload=True):
        with transaction(self) as connection:
            current = selection_token(connection, uid, id)
            if not selection_matches(current, selection):
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
            if comment_observation is not None:
                observed = merge_signals(observed, comment_observation)
            # 可信总数是独立评论版本；失败/未知不清旧值，也不阻断其他可信信号。
            count_changed = observed.get("source_comment_count") != previous.get("source_comment_count")
            old_locator, new_locator = previous.get("comment_locator") or {}, observed.get("comment_locator") or {}
            locator_changed = any(old_locator.get(key) != new_locator.get(key) for key in ("oid", "type"))
            visibility_changed = (previous.get("content_visible") is not None
                                  and "content_visible" in observed
                                  and bool(observed["content_visible"]) != bool(previous["content_visible"]))
            changed = (row is None or count_changed or locator_changed or visibility_changed
                       or (version is not None and version != (
                           previous.get("edited_version") or previous.get("observed_version"))))
            if comment_observation is not None and comment_observation["comment_count_status"] != "observed":
                failed = True
                error = error or "SOURCE_UNAVAILABLE"
            revision = (row["revision"] + int(changed)) if row else 1
            work = row["work"] if row else "pending"
            if row is None and not failed and archive_complete(connection, uid, id, observed,
                                                              media_upload=media_upload):
                work = "complete"
            elif changed and work != "running":
                work = "pending"
            elif (work == "complete" and comment_observation is not None
                  and not archive_complete(connection, uid, id, observed, media_upload=media_upload)):
                # 旧 v11 的整轮完成判断未核对计数；不变信号也要恢复真实未完成工作。
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
            connection.execute("BEGIN")
            return self._read_checks(connection, uid)

    def _read_checks(self, connection, uid):
        # 调用者持有同一只读快照，归档 detail 可复用而不产生读写/采集。
        status_columns = ", ".join(
            f"json_extract(a.document, '$.{field}') AS {field}" for field in COMMENT_STATUS_FIELDS)
        if not connection.execute("SELECT 1 FROM identities WHERE uid = ?", (uid,)).fetchone():
            raise APIError("NOT_FOUND")
        rows = connection.execute(f"""WITH selected AS ({SELECTED_TARGETS})
            SELECT ids.id, c.last_checked_at, c.last_succeeded_at,
            c.check_status, CASE WHEN c.observed IS NOT NULL THEN c.observed
                WHEN a.id IS NOT NULL THEN {ARCHIVE_SIGNALS} ELSE NULL END AS observed,
            c.revision, c.work, c.check_error, c.sync_error,
            json_extract(a.document, '$.work') AS parts,
            json_extract(a.document, '$.text_last_succeeded_at') AS text_last_succeeded_at,
            json_extract(a.document, '$.media_last_succeeded_at') AS media_last_succeeded_at,
            json_extract(a.document, '$.comment_media_last_succeeded_at') AS comment_media_last_succeeded_at,
            (SELECT json_group_array(DISTINCT json_extract(m.value, '$.error'))
                FROM json_each(a.document, '$.media') m
                WHERE json_extract(m.value, '$.status') = 'failed'
                AND json_extract(m.value, '$.error') IN ('MEDIA_DOWNLOAD_FAILED', 'MEDIA_UPLOAD_FAILED')) AS media_errors,
            (SELECT json_group_array(DISTINCT json_extract(m.value, '$.error'))
                FROM root_comments r, json_each(r.document, '$.media') m
                WHERE r.dynamic_id = ids.id AND json_extract(m.value, '$.status') = 'failed'
                AND json_extract(m.value, '$.error') IN ('MEDIA_DOWNLOAD_FAILED', 'MEDIA_UPLOAD_FAILED')) AS comment_media_errors,
            json_extract(a.document, '$.synced_version') AS synced_version,
            json_extract(a.document, '$.restricted_version') AS restricted_version,
            json_extract(a.document, '$.media_version') AS media_version,
            json_extract(a.document, '$.synced_comment_count') AS synced_comment_count,
            json_extract(a.document, '$.synced_root_comment_count') AS synced_root_comment_count,
            json_extract(a.document, '$.synced_reply_comment_count') AS synced_reply_comment_count,
            json_extract(a.document, '$.local_comment_count') AS local_comment_count,
            json_extract(a.document, '$.local_reply_count') AS local_reply_count,
            json_extract(a.document, '$.comments_last_attempt') AS comments_last_attempt,
            json_extract(a.document, '$.root_comments_last_attempt') AS root_comments_last_attempt,
            json_extract(a.document, '$.replies_last_attempt') AS replies_last_attempt,
            {status_columns},
            CASE WHEN a.id IS NOT NULL AND json_extract(a.document, '$.work.comments') = 'success'
                AND NOT EXISTS (SELECT 1 FROM root_comments r WHERE r.dynamic_id = a.id
                    AND json_extract(r.document, '$.work.media') IS NOT 'success')
                THEN 'success' ELSE 'pending' END AS comment_media,
            CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END AS active
            FROM (SELECT uid, id FROM targets WHERE uid = ? UNION
                  SELECT uid, id FROM target_checks WHERE uid = ? UNION
                  SELECT uid, id FROM selected WHERE uid = ?) ids
            LEFT JOIN target_checks c ON c.uid = ids.uid AND c.id = ids.id
            LEFT JOIN selected s ON s.uid = ids.uid AND s.id = ids.id
            LEFT JOIN archives a ON a.uid = ids.uid AND a.id = ids.id
            ORDER BY ids.id COLLATE BINARY""",
            (uid, uid, uid)).fetchall()
        return [{"id": row["id"], "active": bool(row["active"]),
                 "last_checked_at": row["last_checked_at"], "last_succeeded_at": row["last_succeeded_at"],
                 "check_status": row["check_status"] or "unchecked",
                 "observed": json.loads(row["observed"]) if row["observed"] else {},
                 "revision": row["revision"] or 0, "work": row["work"] or "pending",
                 "check_error": row["check_error"], "sync_error": row["sync_error"],
                 "text_last_succeeded_at": row["text_last_succeeded_at"],
                 "media_last_succeeded_at": row["media_last_succeeded_at"],
                 "comment_media_last_succeeded_at": row["comment_media_last_succeeded_at"],
                 "media_errors": sorted(json.loads(row["media_errors"])),
                 "comment_media_errors": sorted(json.loads(row["comment_media_errors"])),
                 "synced_version": row["synced_version"],
                 "synced_comment_count": row["synced_comment_count"],
                 "local_comment_count": row["local_comment_count"], "local_reply_count": row["local_reply_count"],
                 "comments_last_attempt": row["comments_last_attempt"] or "pending",
                 "root_comments_last_attempt": row["root_comments_last_attempt"] or "pending",
                 "replies_last_attempt": row["replies_last_attempt"] or "pending",
                 "synced_root_comment_count": row["synced_root_comment_count"],
                 "synced_reply_comment_count": row["synced_reply_comment_count"],
                 **{field: row[field] for field in COMMENT_STATUS_FIELDS},
                 "parts": check_parts(row)} for row in rows]

    def pending_checks(self, *, with_selection=False):
        columns = "c.uid, c.id, s.token AS selection" if with_selection else "c.uid, c.id"
        with self.connection() as connection:
            return [dict(row) for row in connection.execute(f"""SELECT {columns}
                FROM target_checks c JOIN target_selections s ON s.uid = c.uid AND s.id = c.id
                WHERE c.work = 'pending'
                ORDER BY c.uid COLLATE BINARY, c.id COLLATE BINARY""")]

    def claim_check_work(self, uid, id, *, selection=None):
        with transaction(self) as connection:
            current = selection_token(connection, uid, id)
            if not selection_matches(current, selection):
                return None
            row = connection.execute("""SELECT revision, observed FROM target_checks
                WHERE uid = ? AND id = ? AND work = 'pending'""", (uid, id)).fetchone()
            if row is None:
                return None
            token = uuid4().hex
            connection.execute("UPDATE target_checks SET work = 'running', claim_token = ? WHERE uid = ? AND id = ?",
                               (token, uid, id))
            return {"revision": row["revision"], "observed": json.loads(row["observed"]), "token": token,
                    "selection": current}

    def finish_check_work(self, uid, id, revision, succeeded, finished_at, error=None, *, token,
                          selection=None, record_success=True):
        # 旧 Store 的 finish(None) 可释放失活目标的领取，跳过代次校验；不同于
        # selection_matches(None) 仍要求当前入选。Collector 必传领取资格，不能省略。
        with transaction(self) as connection:
            row = connection.execute("SELECT revision, work, claim_token FROM target_checks WHERE uid = ? AND id = ?", (uid, id)).fetchone()
            if row is None or row["work"] != "running" or row["claim_token"] != token:
                return False
            complete = (succeeded and row["revision"] == revision
                        and (selection is None or selection_token(connection, uid, id) == selection))
            connection.execute("""UPDATE target_checks SET work = ?, claim_token = NULL,
                last_succeeded_at = CASE WHEN ? THEN ? ELSE last_succeeded_at END,
                sync_error = ? WHERE uid = ? AND id = ?""",
                ("complete" if complete else "pending", complete and record_success, finished_at,
                 None if succeeded else (safe_error(error) or "SOURCE_UNAVAILABLE"), uid, id))
            return bool(complete)

    def recover_check_work(self):
        # 仅由已取得进程锁的独立 collector 显式调用；API 启动不得恢复。
        with transaction(self) as connection:
            connection.execute("UPDATE target_checks SET work = 'pending', claim_token = NULL WHERE work = 'running'")
