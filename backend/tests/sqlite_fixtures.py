"""故障装配通过 SQLite 元数据定位关系，不固定生产表名。仅用于测试。"""

import sqlite3


def quote(identifier):
    return '"' + identifier.replace('"', '""') + '"'


def management_relation(path):
    with sqlite3.connect(path) as database:
        for (table,) in database.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ):
            keys = database.execute(
                f"PRAGMA foreign_key_list({quote(table)})"
            ).fetchall()
            if keys:
                key = keys[0]
                return table, key[2], key[3], key[4]
    raise AssertionError("Fixture requires an existing management relationship")


def reject_config_inserts(path):
    monitor, _, _, _ = management_relation(path)
    with sqlite3.connect(path) as database:
        database.execute(f"""CREATE TRIGGER fixture_reject BEFORE INSERT ON {quote(monitor)}
            BEGIN SELECT RAISE(ABORT, 'FICTIONAL_SECRET_STORAGE'); END""")


def reject_switch_writes(path):
    """让通知总开关写入失败：错误码可见，且不回显原始 SQLite 文案。"""
    with sqlite3.connect(path) as database:
        database.execute("""CREATE TRIGGER fixture_reject_switch BEFORE UPDATE ON notification_gate
            BEGIN SELECT RAISE(ABORT, 'FICTIONAL_SECRET_SWITCH'); END""")
