"""上游分页续采进度：与页数据同一短事务提交的定位、代次、方向与页锚点。

这不是归档阅读 cursor：读取端 cursor 冻结本地快照，这里记录「下一次向上游请求哪一页、
依据哪个已确认页锚点」，用于中断、失败、风控或重启后的可验证续采。根页（06）与楼中楼
（07）共用同一结构与规则，用 `stage`／`scope_id` 区分动态与具体楼层；本模块不把进度
当作“最新内容已全部完成”的证据——那是归档 checkpoint 的判断。
"""

import json
from typing import NamedTuple

from .comment_status import utc_now


ROOTS = "roots"
REPLIES = "replies"
PAGE_SIZE = 20
FORWARD = "forward"
REVERSE = "reverse"

PAGES = "pages"
GUARD = "guard"
TAIL = "tail"
COMPLETE = "complete"

# 恢复时校验锚点的有界窗口：锚点页本身，再前探／回溯各至多两页；都找不到才回首屏重定位。
RESUME_PAGE_OFFSETS = (0, 1, -1, 2)


class Position(NamedTuple):
    """一次上游分页扫描的持久位置；`counts` 是页内校验基准，不覆盖动态来源总数。"""

    stage: str
    generation: int
    locator: dict
    direction: str
    phase: str
    next_page: int
    page_size: int
    anchor_page: int
    anchor_ids: tuple
    overlap_page: int
    counts: tuple | None
    confirmed: int
    source_count: int | None
    pin_known: bool
    pinned_id: str | None
    full: bool
    updated_at: str


def migrate(connection):
    """缺失才建表：与既有迁移一致，可被更早版本的副本重放。"""
    connection.execute("""CREATE TABLE IF NOT EXISTS page_scan_progress (
        dynamic_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        scope_id TEXT NOT NULL DEFAULT '',
        generation INTEGER NOT NULL,
        locator TEXT NOT NULL,
        direction TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('pages', 'guard', 'tail', 'complete')),
        next_page INTEGER NOT NULL,
        page_size INTEGER NOT NULL,
        anchor_page INTEGER NOT NULL,
        anchor_ids TEXT NOT NULL,
        overlap_page INTEGER NOT NULL,
        counts TEXT,
        confirmed INTEGER NOT NULL,
        source_count INTEGER,
        pin_known INTEGER NOT NULL DEFAULT 0,
        pinned_id TEXT,
        full INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (dynamic_id, stage, scope_id)
    )""")


def last_page(count, page_size=PAGE_SIZE):
    """来源总数对应的末页：未知或零按第 1 页处理，末页倒序增量从这里起步。"""
    if not isinstance(count, int) or count < 1:
        return 1
    return (count + page_size - 1) // page_size


def locator_key(locator):
    """定位资源身份：只含 oid／type／来源策略，不含页码或时间。"""
    return {"oid": locator["oid"], "type": locator["type"], "source": locator.get("source")}


def start(dynamic_id, generation, locator, source_count=None, *, full=False, stage=ROOTS,
          direction=FORWARD):
    return Position(
        stage=stage, generation=generation, locator=dict(locator), direction=direction,
        phase=PAGES, next_page=1, page_size=PAGE_SIZE, anchor_page=0, anchor_ids=(),
        overlap_page=0, counts=None, confirmed=0, source_count=source_count,
        pin_known=False, pinned_id=None, full=bool(full), updated_at=utc_now(),
    )


def read(connection, dynamic_id, stage=ROOTS, scope_id=""):
    row = connection.execute("""SELECT stage, generation, locator, direction, phase, next_page,
        page_size, anchor_page, anchor_ids, overlap_page, counts, confirmed, source_count,
        pin_known, pinned_id, full, updated_at FROM page_scan_progress
        WHERE dynamic_id = ? AND stage = ? AND scope_id = ?""", (dynamic_id, stage, scope_id)).fetchone()
    if row is None:
        return None
    return Position(
        stage=row["stage"], generation=row["generation"], locator=json.loads(row["locator"]),
        direction=row["direction"], phase=row["phase"], next_page=row["next_page"],
        page_size=row["page_size"], anchor_page=row["anchor_page"],
        anchor_ids=tuple(json.loads(row["anchor_ids"])), overlap_page=row["overlap_page"],
        counts=None if row["counts"] is None else tuple(json.loads(row["counts"])),
        confirmed=row["confirmed"], source_count=row["source_count"],
        pin_known=bool(row["pin_known"]), pinned_id=row["pinned_id"], full=bool(row["full"]),
        updated_at=row["updated_at"],
    )


def write(connection, dynamic_id, position, scope_id=""):
    """在同一事务内写入位置；调用方负责 `BEGIN IMMEDIATE` 与提交。"""
    connection.execute("""INSERT INTO page_scan_progress
        (dynamic_id, stage, scope_id, generation, locator, direction, phase, next_page, page_size,
         anchor_page, anchor_ids, overlap_page, counts, confirmed, source_count, pin_known,
         pinned_id, full, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dynamic_id, stage, scope_id) DO UPDATE SET
        generation = excluded.generation, locator = excluded.locator, direction = excluded.direction,
        phase = excluded.phase, next_page = excluded.next_page, page_size = excluded.page_size,
        anchor_page = excluded.anchor_page, anchor_ids = excluded.anchor_ids,
        overlap_page = excluded.overlap_page, counts = excluded.counts,
        confirmed = excluded.confirmed, source_count = excluded.source_count,
        pin_known = excluded.pin_known, pinned_id = excluded.pinned_id, full = excluded.full,
        updated_at = excluded.updated_at""", (
        dynamic_id, position.stage, scope_id, position.generation,
        json.dumps(position.locator, ensure_ascii=False), position.direction, position.phase,
        position.next_page, position.page_size, position.anchor_page,
        json.dumps(list(position.anchor_ids)), position.overlap_page,
        None if position.counts is None else json.dumps(list(position.counts)),
        position.confirmed, position.source_count, 1 if position.pin_known else 0,
        position.pinned_id, 1 if position.full else 0, position.updated_at,
    ))


def alignment(fetched, anchor_ids):
    """锚点页校验：锚点末 ID 在本页且尾部连续重叠时返回 `(下标, 重叠长度)`。

    只接受连续重叠，避免偶合 ID 或分页错位被当成锚点；返回 None 表示本页不含锚点。
    """
    if not anchor_ids or not fetched:
        return None
    last = anchor_ids[-1]
    if last not in fetched:
        return None
    index = fetched.index(last)
    limit = min(len(anchor_ids), index + 1)
    overlap = 1
    while overlap < limit and fetched[index - overlap] == anchor_ids[-overlap - 1]:
        overlap += 1
    return None if overlap != limit else (index, overlap)


def following_page(page, index, length):
    """锚点末项之后的位置：本页还有内容就重读该页做重叠，否则从下一页继续。

    整页读取后才推进页码，因此「锚点末项是短页最后一条」与「满页最后一条」都不能
    跳过本页剩下的位置；前者没有剩余，才直接进入下一页。
    """
    return page if index + 1 < length else page + 1


def shift(fetched_page, index, anchor_page, anchor_count, page_size=PAGE_SIZE):
    """锚点末项的位置位移：正数表示前面插入了条目，负数表示删除或前移。"""
    return (fetched_page - anchor_page) * page_size + index - (anchor_count - 1)
