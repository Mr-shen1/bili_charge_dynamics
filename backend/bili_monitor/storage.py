"""身份与配置分离；每次操作独立连接，网络不进入 SQLite 事务。"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .contracts import APIError


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
                if version > 1:
                    raise RuntimeError("Unsupported database schema version")
                if version == 1:
                    connection.commit()
                    return
                connection.execute("""CREATE TABLE identities (
                    uid TEXT PRIMARY KEY, name TEXT, avatar_url TEXT
                )""")
                connection.execute("""CREATE TABLE monitors (
                    uid TEXT PRIMARY KEY REFERENCES identities(uid),
                    mode TEXT NOT NULL DEFAULT 'recent',
                    recent_n INTEGER NOT NULL DEFAULT 10,
                    enabled INTEGER NOT NULL DEFAULT 1
                )""")
                connection.execute("PRAGMA user_version = 1")
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
