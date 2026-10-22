"""手动清空全部业务数据；须先停止 API 和 collector，不备份、不操作 OSS。"""

import argparse
from pathlib import Path
import sqlite3
from urllib.parse import quote


TABLES = (
    "reply_pages", "root_comment_pages", "archive_pages",
    "replies", "reply_sync", "root_comments", "media_attempts",
    "target_checks", "target_selections", "recent_discoveries",
    "targets", "archives", "monitors", "identities",
)


def main():
    parser = argparse.ArgumentParser(description="清空全部业务数据，保留表结构；不创建备份。")
    parser.add_argument("--database", required=True, help="需要清空的 SQLite 文件路径")
    args = parser.parse_args()
    print("请先停止 API 和 collector。此操作会删除全部身份、监控及归档数据，不备份，不能撤销。")
    try:
        if input("确认清空请输入 CLEAR：") != "CLEAR":
            print("已取消，未修改数据库。")
            return
    except (EOFError, KeyboardInterrupt):
        print("\n已取消，未修改数据库。")
        return

    path = str(Path(args.database).expanduser().resolve())
    db = None
    try:
        db = sqlite3.connect("file:" + quote(path, safe="/") + "?mode=rw", uri=True)
        db.execute("PRAGMA foreign_keys = ON")
        with db:
            db.execute("BEGIN IMMEDIATE")
            # 只允许已知 schema 的业务表，避免新表的数据被无声遗漏。
            tables = {row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )}
            if tables != set(TABLES):
                raise ValueError("Unsupported database schema")
            for table in TABLES:
                db.execute(f"DELETE FROM {table}")
    except (sqlite3.Error, OSError, ValueError):
        raise SystemExit("清空失败，未提交删除；请检查文件路径、表结构及数据库占用情况。") from None
    finally:
        if db is not None:
            db.close()
    print("数据库已清空，未创建备份；表结构、OSS 对象和服务端凭据未修改。")


if __name__ == "__main__":
    main()
