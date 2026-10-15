"""入选代次：同一事务内跟随配置/窗口变化，不与内容版本或执行令牌混用。"""

from uuid import uuid4


SELECTED_TARGETS = """SELECT t.uid, t.id FROM targets t JOIN monitors m ON m.uid = t.uid
    WHERE m.enabled = 1 AND m.mode = 'specified'
    UNION ALL
    SELECT d.uid, member.value AS id FROM recent_discoveries d
    JOIN monitors m ON m.uid = d.uid
    JOIN json_each(d.trusted_result, '$.ids') member
    WHERE m.enabled = 1 AND m.mode = 'recent'"""


def selection_token(connection, uid, id):
    row = connection.execute("SELECT token FROM target_selections WHERE uid = ? AND id = ?",
                             (uid, id)).fetchone()
    return row[0] if row else None


def selection_matches(current, expected):
    """省略快照仅兼容 Store 的即时调用；有快照则必须匹配同一有效资格。"""
    return current is not None and (expected is None or current == expected)


def refresh_selections(connection, uid, *, reset=False):
    """调用者持有写事务；reset 刷新整个 UP，否则只增删变动成员，令牌永不复用。"""
    selected = {row[0] for row in connection.execute(
        f"SELECT id FROM ({SELECTED_TARGETS}) WHERE uid = ?", (uid,))}
    previous = {row[0] for row in connection.execute(
        "SELECT id FROM target_selections WHERE uid = ?", (uid,))}
    for id in previous if reset else previous - selected:
        connection.execute("DELETE FROM target_selections WHERE uid = ? AND id = ?", (uid, id))
    for id in selected if reset else selected - previous:
        connection.execute("INSERT INTO target_selections(uid, id, token) VALUES (?, ?, ?)",
                           (uid, id, uuid4().hex))
