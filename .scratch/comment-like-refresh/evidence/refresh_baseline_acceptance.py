#!/usr/bin/env python
"""04：真实备份基线验收——只读备份 + 替身来源 + 受控时钟跑一次完整夜间刷新。

* 备份库只读：脚本只从 `~/bili-testdata/likes-baseline.sqlite` 复制工作副本，
  原文件的 sha256/大小/mtime 在运行前后各取一次并断言不变。
* 样本＝备份里的全部 3 条动态 / 167 根 / 16,594 楼（不是抽样）。
* 替身来源按备份数据生成响应，并故意制造：部分点赞上调、一条真实 0、一条缺失
  点赞（空点赞）、部分已归档根评论与楼中楼不再返回。
* 逐字段 diff：行数与主键集合不变；只有 `like_count`/`is_pinned`/
  `source_reply_count` 可能变化；其余键（正文/作者/时间/媒体）逐字相等。

运行（在待验收的工作树里跑，脚本本身放在 tracker 的 evidence 目录）：

    cd ~/bili-worktrees/cmr-04
    UV_PROJECT_ENVIRONMENT=/home/kevin/Projects/PI/bili_charge_dynamics/.venv \
      uv run --no-sync python \
      /home/kevin/Projects/PI/bili_charge_dynamics/.scratch/comment-like-refresh/evidence/refresh_baseline_acceptance.py \
      --out /home/kevin/Projects/PI/bili_charge_dynamics/.scratch/comment-like-refresh/evidence/04-real-backup-baseline

`--predict-only` 只按备份数据算预期请求账本，不跑刷新。
`--fast` 把生产里的等待压缩成 0（仍按生产参数记账），用于快速回归。
"""

import argparse
import asyncio
import hashlib
import json
import logging
import shutil
import sqlite3
import sys
import time
import traceback
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_BASELINE = Path.home() / "bili-testdata" / "likes-baseline.sqlite"
# 计数类字段：刷新唯一允许改动的集合（规格 LR-03 / 票面「计数类字段」）。
ALLOWED_CHANGES = ("is_pinned", "like_count", "source_reply_count")
PAGE_SIZE = 20
BEIJING = timezone(timedelta(hours=8))
# 备份最后一次同步之后的下一个凌晨窗口起点（北京时间 2026-10-31 02:00）。
WINDOW_START = datetime(2026, 10, 31, 2, 0, tzinfo=BEIJING).astimezone(timezone.utc)
CADENCE_SECONDS = 15


# --------------------------------------------------------------------------- 备份只读


def file_identity(path):
    """来源库标识：文件名、大小、sha256、mtime。运行前后各取一次。"""
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    stat = Path(path).stat()
    return {"path": str(path), "bytes": stat.st_size, "sha256": digest.hexdigest(),
            "mtime": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(timespec="seconds")}


def read_only(path):
    connection = sqlite3.connect(f"file:{Path(path).absolute()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def table_counts(path):
    with read_only(path) as connection:
        return {name: connection.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
                for name in ("monitors", "targets", "target_selections", "target_checks", "archives",
                             "root_comments", "replies", "reply_sync", "root_comment_pages",
                             "reply_pages", "page_scan_progress", "notification_events",
                             "notification_candidates", "notification_deliveries",
                             "notification_alerts", "notification_phases", "notification_versions")}


# --------------------------------------------------------------------------- 备份 → 替身状态


def epoch_of(iso_text):
    return int(datetime.fromisoformat(iso_text).timestamp())


def load_state(path):
    """从备份读出「按来源页码顺序」的替身状态：每个动态的定位、根评论与逐楼回复。"""
    state = {}
    with read_only(path) as connection:
        archives = {}
        for row in connection.execute("SELECT id, uid, document FROM archives"):
            document = json.loads(row["document"])
            archives[row["id"]] = {
                "uid": row["uid"],
                "locator": document["comment_locator"],
                "source_comment_count": document["source_comment_count"],
                "title": document.get("title"),
            }
        roots = {dynamic: [] for dynamic in archives}
        for row in connection.execute(
                "SELECT dynamic_id, document FROM root_comments ORDER BY dynamic_id, id COLLATE BINARY"):
            roots[row["dynamic_id"]].append(json.loads(row["document"]))
        replies = {dynamic: {} for dynamic in archives}
        for row in connection.execute(
                "SELECT dynamic_id, root_id, document FROM replies"):
            replies[row["dynamic_id"]].setdefault(row["root_id"], []).append(json.loads(row["document"]))
    for dynamic, entry in archives.items():
        # 来源页码顺序固定为（发表时间, id）：翻页与 diff 都只依赖这一份确定性顺序。
        ordered = sorted(roots[dynamic], key=lambda doc: (doc.get("published_at") or "", doc["id"]))
        buildings = {root_id: sorted(items, key=lambda doc: (doc.get("published_at") or "", doc["id"]))
                     for root_id, items in replies[dynamic].items()}
        state[dynamic] = {**entry, "roots": ordered, "buildings": buildings}
    return state


def reply_totals(state):
    return {dynamic: sum(len(items) for items in entry["buildings"].values())
            for dynamic, entry in state.items()}


# --------------------------------------------------------------------------- 故意的来源变化

OMIT = object()


def pick(entries, index):
    return entries[index % len(entries)]


def build_plan(state):
    """确定性地安排替身变化：点赞上调、真实 0、缺失点赞、来源缺条、置顶移动。

    所有变化都在「会被服务到的行」上安排，因此 diff 里出现的每一条变化都能对应到
    本文件里的某一条安排，不会出现无法解释的差异。
    """
    plan = {"root_like": {}, "reply_like": {}, "missing_roots": {}, "dropped_replies": {},
            "pin": {}, "notes": []}
    dynamics = sorted(state)
    # 1) 来源不再返回的根评论：两条动态各摘掉一条中间位置的根。
    for dynamic in dynamics[:2]:
        roots = state[dynamic]["roots"]
        target = pick(roots, len(roots) // 2)
        plan["missing_roots"][dynamic] = {target["id"]}
        plan["notes"].append({
            "kind": "missing_root", "dynamic_id": dynamic, "root_id": target["id"],
            "like_count": target["like_count"],
            "why": "替身不再返回该根评论（模拟来源已删除/隐藏），本地行必须原样保留",
        })
    # 2) 楼中楼少返回：最大动态里两栋楼的末尾几条不再返回。
    big = max(dynamics, key=lambda dynamic: sum(len(items) for items in state[dynamic]["buildings"].values()))
    buildings = sorted(state[big]["buildings"].items(), key=lambda item: -len(item[1]))
    root_documents = {doc["id"]: doc for doc in state[big]["roots"]}
    for root_id, items in buildings[:2]:
        drop = 5 if root_id == buildings[0][0] else 3
        kept = items[:-drop]
        plan["dropped_replies"][(big, root_id)] = {doc["id"] for doc in items[-drop:]}
        plan["notes"].append({
            "kind": "missing_replies", "dynamic_id": big, "root_id": root_id,
            "dropped": [doc["id"] for doc in items[-drop:]], "served": len(kept),
            "local_replies": len(items),
            "source_reply_count_before": root_documents[root_id].get("source_reply_count"),
            "why": "替身整楼少返回末尾若干条回复，本地回复行必须原样保留",
        })
    # 3) 点赞：服务到的行里每 3 条上调 2 条，其余保持不变。
    for dynamic in dynamics:
        missing = plan["missing_roots"].get(dynamic, set())
        for index, doc in enumerate(state[dynamic]["roots"]):
            if doc["id"] in missing or doc.get("like_count") is None:
                continue
            if index % 3 == 2:
                continue
            plan["root_like"][(dynamic, doc["id"])] = doc["like_count"] + 7 + index % 5
        for root_id, items in state[dynamic]["buildings"].items():
            dropped = plan["dropped_replies"].get((dynamic, root_id), set())
            served = [doc for doc in items if doc["id"] not in dropped]
            for index, doc in enumerate(served):
                if doc.get("like_count") is None or index % 3 == 2:
                    continue
                plan["reply_like"][(dynamic, root_id, doc["id"])] = doc["like_count"] + 3 + index % 4
    # 4) 真实 0 与缺失点赞：根评论一条 0、一条缺 like；回复同样各一条。
    zero_dynamic = max(dynamics, key=lambda dynamic: len(state[dynamic]["roots"]))
    ranked = [doc for doc in state[zero_dynamic]["roots"]
              if doc["id"] not in plan["missing_roots"].get(zero_dynamic, set())
              and doc.get("like_count")]
    zero_root, blank_root = ranked[0], ranked[1]
    plan["root_like"][(zero_dynamic, zero_root["id"])] = 0
    plan["root_like"][(zero_dynamic, blank_root["id"])] = OMIT
    plan["notes"] += [
        {"kind": "like_zero", "table": "root_comments", "dynamic_id": zero_dynamic,
         "root_id": zero_root["id"], "like_count_before": zero_root["like_count"],
         "why": "来源明确返回点赞 0：必须写入 0，不能被「缺失才保留」挡住"},
        {"kind": "like_missing", "table": "root_comments", "dynamic_id": zero_dynamic,
         "root_id": blank_root["id"], "like_count_before": blank_root["like_count"],
         "why": "来源不返回 like 字段：未知不等于 0，必须保留旧值"},
    ]
    reply_candidates = [(root_id, doc) for root_id, items in state[zero_dynamic]["buildings"].items()
                        for doc in items if doc.get("like_count")
                        and doc["id"] not in plan["dropped_replies"].get((zero_dynamic, root_id), set())]
    reply_candidates.sort(key=lambda item: (-item[1]["like_count"], item[1]["id"]))
    for tag, entry in (("like_zero", reply_candidates[0]), ("like_missing", reply_candidates[1])):
        root_id, doc = entry
        key = (zero_dynamic, root_id, doc["id"])
        plan["reply_like"][key] = 0 if tag == "like_zero" else OMIT
        plan["notes"].append({
            "kind": tag, "table": "replies", "dynamic_id": zero_dynamic, "root_id": root_id,
            "reply_id": doc["id"], "like_count_before": doc["like_count"],
            "why": ("来源明确返回点赞 0：写入 0" if tag == "like_zero"
                    else "来源不返回 like 字段：保留旧值"),
        })
    # 5) 置顶移动：最大动态的置顶从原根评论换成点赞最高的另一条（置顶属计数类字段）。
    pinned = [doc for doc in state[zero_dynamic]["roots"] if doc.get("is_pinned")]
    if pinned:
        candidates = [doc for doc in state[zero_dynamic]["roots"]
                      if not doc.get("is_pinned")
                      and doc["id"] not in plan["missing_roots"].get(zero_dynamic, set())]
        candidates.sort(key=lambda doc: (-(doc.get("like_count") or 0), doc["id"]))
        plan["pin"][zero_dynamic] = candidates[0]["id"]
        plan["notes"].append({
            "kind": "pin_moved", "dynamic_id": zero_dynamic,
            "from": pinned[0]["id"], "to": candidates[0]["id"],
            "why": "置顶属计数类字段：只验证它允许变化，正文/作者/时间不受影响",
        })
    return plan


# --------------------------------------------------------------------------- 替身来源


def raw_root(doc, locator, like):
    item = {
        "rpid_str": doc["id"],
        "oid": int(locator["oid"]),
        "type": int(locator["type"]),
        "root_str": "0",
        "parent_str": "0",
        "ctime": epoch_of(doc["published_at"]),
        "content": {"message": doc["text"]},
        "member": {"mid": doc["author"]["id"], "uname": doc["author"]["nickname"],
                   "avatar": doc["author"]["avatar_url"]},
        "rcount": doc.get("source_reply_count"),
    }
    if like is not OMIT:
        item["like"] = like
    return item


def raw_reply(doc, locator, root_id, like):
    item = {
        "rpid_str": doc["id"],
        "oid": int(locator["oid"]),
        "type": int(locator["type"]),
        "root_str": root_id,
        "ctime": epoch_of(doc["published_at"]),
        "content": {"message": doc["text"]},
        "member": {"mid": doc["author"]["id"], "uname": doc["author"]["nickname"],
                   "avatar": doc["author"]["avatar_url"]},
    }
    # 缺失父级与缺失图片必须原样缺失：补一个值等于改写本地行，diff 会看出来。
    if doc.get("parent_id") is not None:
        item["parent_str"] = doc["parent_id"]
    if like is not OMIT:
        item["like"] = like
    return item


class StubSource:
    """按备份数据应答来源接口；只替换外部 HTTP，生产解析/限速/存储全部真实。"""

    def __init__(self, state, plan):
        self.uid = next(iter(state.values()))["uid"] if state else None
        self.calls = []      # (endpoint_type, oid, page, root_id, monotonic)
        self.plan = plan
        self.dynamics = {}
        for dynamic, entry in state.items():
            locator = entry["locator"]
            missing = plan["missing_roots"].get(dynamic, set())
            roots = []
            for doc in entry["roots"]:
                if doc["id"] in missing:
                    continue
                like = plan["root_like"].get((dynamic, doc["id"]), doc.get("like_count"))
                roots.append((doc, raw_root(doc, locator, like)))
            buildings = {}
            stored_rcount = {doc["id"]: doc.get("source_reply_count") for doc in entry["roots"]}
            # 没有楼中楼的根也要能应答空页：来源对零回复同样返回一个空的首屏。
            for doc in entry["roots"]:
                buildings.setdefault(doc["id"], {"items": [], "count": stored_rcount[doc["id"]] or 0})
            for root_id, items in entry["buildings"].items():
                dropped = plan["dropped_replies"].get((dynamic, root_id), set())
                served = [doc for doc in items if doc["id"] not in dropped]
                raw = [raw_reply(doc, locator, root_id,
                                 plan["reply_like"].get((dynamic, root_id, doc["id"]), doc.get("like_count")))
                       for doc in served]
                # 未被安排的楼照抄备份里的来源回复数：刷新不该顺手「修正」它。
                buildings[root_id] = {"items": raw,
                                      "count": len(raw) if dropped
                                      else (stored_rcount.get(root_id) or len(items))}
            self.dynamics[str(locator["oid"])] = {
                "dynamic": dynamic, "locator": locator, "roots": roots, "buildings": buildings,
                "source_comment_count": entry["source_comment_count"],
                "root_documents": {doc["id"]: doc for doc in entry["roots"]},
                "pin": plan["pin"].get(dynamic),
                "pinned": next((document for document, _ in roots
                                if document.get("is_pinned")), None),
            }

    # -- HTTP ------------------------------------------------------------
    def __call__(self, request):
        path, params = request.url.path, dict(request.url.params)
        stamp = time.monotonic()
        if path == "/x/v2/reply/count":
            self.calls.append(("comment_count", params.get("oid"), None, None, stamp))
            entry = self._entry(params["oid"])
            return self._json({"code": 0, "data": {"count": entry["source_comment_count"]}})
        if path == "/x/v2/reply":
            self.calls.append(("root_comments", params.get("oid"), int(params["pn"]), None, stamp))
            return self._json({"code": 0, "data": self._root_page(self._entry(params["oid"]), int(params["pn"]))})
        if path == "/x/v2/reply/reply":
            self.calls.append(("replies", params.get("oid"), int(params["pn"]), params.get("root"), stamp))
            entry = self._entry(params["oid"])
            return self._json({"code": 0, "data": self._reply_page(entry, params["root"], int(params["pn"]))})
        raise AssertionError(f"unexpected stub request: {path}")

    def _entry(self, oid):
        if str(oid) not in self.dynamics:
            raise AssertionError(f"unknown oid {oid}")
        return self.dynamics[str(oid)]

    def _root_page(self, entry, number):
        slice_ = entry["roots"][(number - 1) * PAGE_SIZE: number * PAGE_SIZE]
        items = [raw for _, raw in slice_] or None
        page = {"num": number, "size": PAGE_SIZE, "count": len(entry["roots"]),
                "acount": entry["source_comment_count"]}
        payload = {"page": page, "replies": items, "hots": []}
        if number == 1:
            pin_id = entry["pin"] or (entry["pinned"]["id"] if entry["pinned"] else None)
            top = None
            if pin_id is not None:
                like = self.plan["root_like"].get((entry["dynamic"], pin_id))
                document = entry["root_documents"][pin_id]
                top = raw_root(document, entry["locator"],
                               document.get("like_count") if like is None else like)
            payload["upper"] = {"top": top}
        return payload

    def _reply_page(self, entry, root_id, number):
        building = entry["buildings"].get(root_id)
        if building is None:
            raise AssertionError(f"unknown root {root_id}")
        document = entry["root_documents"][root_id]
        like = self.plan["root_like"].get((entry["dynamic"], root_id), document.get("like_count"))
        root = raw_root(document, entry["locator"], like)
        root["rcount"] = building["count"]
        items = building["items"][(number - 1) * PAGE_SIZE: number * PAGE_SIZE] or None
        return {"page": {"num": number, "size": PAGE_SIZE, "count": building["count"]},
                "root": root, "replies": items}

    @staticmethod
    def _json(payload):
        import httpx
        return httpx.Response(200, json=payload)

    # -- 账本 ------------------------------------------------------------
    def forget(self):
        self.calls.clear()

    def counts(self):
        total = {}
        for kind, *_ in self.calls:
            total[kind] = total.get(kind, 0) + 1
        return total

    def gaps(self, kind):
        stamps = [call[4] for call in self.calls if call[0] == kind]
        return [later - earlier for earlier, later in zip(stamps, stamps[1:])]


CONFIG = {"fast": False, "waits": []}


async def recorded_sleep(seconds):
    """生产的等待参数照实记账；`--fast` 只是把等待时长压成 0。"""
    CONFIG["waits"].append(seconds)
    await asyncio.sleep(0 if CONFIG["fast"] else seconds)


def fake_pause(seconds):
    """楼级等待的替身：参数照实记账，实际等待按模式压缩。"""
    return recorded_sleep(seconds)


# --------------------------------------------------------------------------- 行级快照与 diff


def read_rows(path):
    """两张评论表的完整文档：主键 → 文档。"""
    rows = {"root_comments": {}, "replies": {}}
    with read_only(path) as connection:
        for dynamic, root_id, document in connection.execute(
                "SELECT dynamic_id, id, document FROM root_comments"):
            rows["root_comments"][(dynamic, root_id)] = json.loads(document)
        for dynamic, root_id, reply_id, document in connection.execute(
                "SELECT dynamic_id, root_id, id, document FROM replies"):
            rows["replies"][(dynamic, root_id, reply_id)] = json.loads(document)
    return rows


def digest(document):
    """非计数类字段的指纹：用来证明正文/作者/时间/媒体逐字相等，而不靠抽样。"""
    content = {key: value for key, value in document.items() if key not in ALLOWED_CHANGES}
    return hashlib.sha256(json.dumps(content, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def count_fields(document):
    return {key: document.get(key) for key in ALLOWED_CHANGES}


def diff_rows(before, after):
    """逐主键、逐字段比较；返回逐行结果与汇总（不抽样）。"""
    report, summary = [], {
        "rows_before": {table: len(rows) for table, rows in before.items()},
        "rows_after": {table: len(rows) for table, rows in after.items()},
        "added": {table: [] for table in before},
        "removed": {table: [] for table in before},
        "changed": {table: 0 for table in before},
        "changed_fields": {table: {} for table in before},
        "unexplained": [],
        "content_mismatch": [],
    }
    for table in before:
        old, new = before[table], after[table]
        summary["added"][table] = sorted(set(new) - set(old))
        summary["removed"][table] = sorted(set(old) - set(new))
        for key in sorted(set(old) | set(new)):
            before_document, after_document = old.get(key), new.get(key)
            if before_document is None or after_document is None:
                report.append({"table": table, "key": list(key), "changed": ["<missing row>"]})
                continue
            changed = sorted(name for name in set(before_document) | set(after_document)
                             if before_document.get(name) != after_document.get(name))
            row = {"table": table, "key": list(key), "changed": changed,
                   "before": count_fields(before_document), "after": count_fields(after_document),
                   "content_sha256_before": digest(before_document),
                   "content_sha256_after": digest(after_document)}
            report.append(row)
            if changed:
                summary["changed"][table] += 1
                for name in changed:
                    bucket = summary["changed_fields"][table]
                    bucket[name] = bucket.get(name, 0) + 1
                for name in changed:
                    if name not in ALLOWED_CHANGES:
                        summary["unexplained"].append({"table": table, "key": list(key), "field": name,
                                                       "before": before_document.get(name),
                                                       "after": after_document.get(name)})
            if row["content_sha256_before"] != row["content_sha256_after"]:
                summary["content_mismatch"].append({"table": table, "key": list(key),
                                                    "fields": changed})
    summary["rows_compared"] = sum(len(before[table]) + len(after[table]) for table in before) // 2
    summary["all_count_fields"] = list(ALLOWED_CHANGES)
    summary["ok"] = (not summary["added"]["root_comments"] and not summary["added"]["replies"]
                     and not summary["removed"]["root_comments"] and not summary["removed"]["replies"]
                     and not summary["unexplained"] and not summary["content_mismatch"])
    summary["added"] = {table: [list(key) for key in keys] for table, keys in summary["added"].items()}
    summary["removed"] = {table: [list(key) for key in keys] for table, keys in summary["removed"].items()}
    return report, summary


def verify_plan(report, plan, state):
    """把「替身安排了什么」与「diff 里到底变了什么」逐条对上。

    这是 LR-04／LR-05 的直接证据：故意缺失的行必须一条都没动，空点赞必须保留旧值，
    真实 0 必须写成 0；反过来，diff 里不允许出现任何没有被安排的变化。
    """
    index = {(row["table"], *row["key"]): row for row in report}
    problems = []
    checks = {"like_written": 0, "like_preserved_when_missing": 0, "near_zero": 0,
              "missing_rows_untouched": 0, "rcount_changes": 0, "pin_changes": 0}

    def row(table, key):
        return index.get((table, *key))

    for (dynamic, root_id), value in plan["root_like"].items():
        entry = row("root_comments", (dynamic, root_id))
        if entry is None:
            problems.append({"missing_row": ["root_comments", dynamic, root_id]})
            continue
        if value is OMIT:
            checks["like_preserved_when_missing"] += 1
            if entry["after"]["like_count"] != entry["before"]["like_count"]:
                problems.append({"kept_but_changed": ["root_comments", dynamic, root_id],
                                 "before": entry["before"], "after": entry["after"]})
        else:
            checks["like_written"] += 1
            checks["near_zero"] += int(value == 0)
            if entry["after"]["like_count"] != value:
                problems.append({"like_mismatch": ["root_comments", dynamic, root_id],
                                 "expected": value, "after": entry["after"]["like_count"]})
    for (dynamic, root_id, reply_id), value in plan["reply_like"].items():
        entry = row("replies", (dynamic, root_id, reply_id))
        if entry is None:
            problems.append({"missing_row": ["replies", dynamic, root_id, reply_id]})
            continue
        if value is OMIT:
            checks["like_preserved_when_missing"] += 1
            if entry["after"]["like_count"] != entry["before"]["like_count"]:
                problems.append({"kept_but_changed": ["replies", dynamic, root_id, reply_id],
                                 "before": entry["before"], "after": entry["after"]})
        else:
            checks["like_written"] += 1
            checks["near_zero"] += int(value == 0)
            if entry["after"]["like_count"] != value:
                problems.append({"like_mismatch": ["replies", dynamic, root_id, reply_id],
                                 "expected": value, "after": entry["after"]["like_count"]})
    # 来源已缺失的行：一条都不许动（含计数类字段）。
    missing = [("root_comments", dynamic, root_id)
               for dynamic, ids in plan["missing_roots"].items() for root_id in ids]
    missing += [("replies", dynamic, root_id, reply_id)
                for (dynamic, root_id), ids in plan["dropped_replies"].items() for reply_id in ids]
    for key in missing:
        entry = row(key[0], key[1:])
        if entry is None:
            problems.append({"row_deleted": list(key)})
        elif entry["changed"]:
            problems.append({"missing_row_changed": list(key), "changed": entry["changed"]})
        else:
            checks["missing_rows_untouched"] += 1
    # 来源回复数的变化只允许出现在「整楼少返回」的两栋楼上。
    for (dynamic, root_id), ids in plan["dropped_replies"].items():
        entry = row("root_comments", (dynamic, root_id))
        before = entry["before"]["source_reply_count"]
        served = len(state[dynamic]["buildings"][root_id]) - len(ids)
        checks["rcount_changes"] += 1
        # 来源回复数跟随「本次实际服务到的条数」，与备份里可能已经过期的旧值无关。
        if entry["after"]["source_reply_count"] != served:
            problems.append({"rcount_mismatch": ["root_comments", dynamic, root_id],
                             "before": before, "served": served,
                             "after": entry["after"]["source_reply_count"]})
    for dynamic, pinned_id in plan["pin"].items():
        for document in state[dynamic]["roots"]:
            entry = row("root_comments", (dynamic, document["id"]))
            checks["pin_changes"] += 1
            expected = document["id"] == pinned_id
            if bool(entry["after"]["is_pinned"]) != bool(expected):
                problems.append({"pin_mismatch": ["root_comments", dynamic, document["id"]],
                                 "expected": expected, "after": entry["after"]["is_pinned"]})
    return {"checks": checks, "problems": problems, "ok": not problems,
            "missing_rows_planned": len(missing)}


def table_diff(before_path, after_path):
    """全库逐表内容差异：行数、新增行、消失行、内容变化的行（按整行多重集比较）。"""
    def rows(path, table, columns=None):
        with read_only(path) as connection:
            names = columns or [row[1] for row in connection.execute(f"PRAGMA table_info({table})")]
            return names, [tuple(row) for row in connection.execute(
                f"SELECT {', '.join(names)} FROM {table}")]

    def keyed(columns, values):
        indexed = {}
        for value in values:
            rendered = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
            indexed[rendered] = indexed.get(rendered, 0) + 1
        return indexed

    names = sorted(existing_table_names(before_path) & existing_table_names(after_path))
    result = {}
    for table in names:
        before_columns, _ = rows(before_path, table)
        after_columns, _ = rows(after_path, table)
        # 只比两边都有的列：v29 迁移新增的列不是刷新的效果。
        columns = [name for name in before_columns if name in after_columns]
        _, old = rows(before_path, table, columns)
        _, new = rows(after_path, table, columns)
        old_index, new_index = keyed(columns, old), keyed(columns, new)
        added = sum(max(0, count - old_index.get(row, 0)) for row, count in new_index.items())
        removed = sum(max(0, count - new_index.get(row, 0)) for row, count in old_index.items())
        result[table] = {"columns": columns,
                         "columns_added_by_migration": [name for name in after_columns
                                                        if name not in before_columns],
                         "rows_before": len(old), "rows_after": len(new),
                         "rows_added": added, "rows_removed": removed,
                         "rows_changed": min(added, removed), "identical": old_index == new_index}
    return result


def existing_table_names(path):
    with read_only(path) as connection:
        return {row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}


def archive_diff(before_path, after_path):
    """归档行的变化单独列出：它们本来就是同步状态，不属于评论内容。"""
    def load(path):
        with read_only(path) as connection:
            return {row["id"]: json.loads(row["document"])
                    for row in connection.execute("SELECT id, document FROM archives")}
    old, new = load(before_path), load(after_path)
    result = {}
    for dynamic in sorted(old):
        fields = sorted(name for name in set(old[dynamic]) | set(new[dynamic])
                        if old[dynamic].get(name) != new[dynamic].get(name))
        result[dynamic] = {name: {"before": old[dynamic].get(name), "after": new[dynamic].get(name)}
                           for name in fields}
    return result


# --------------------------------------------------------------------------- 「最热」排序快照


def hot_snapshot(path, state, plan):
    """经公开读取接口取「最热」结果：根层整份、楼中楼层取每动态最大的三栋。"""
    from backend.tests.archive_support import archive_client

    snapshot = {"roots": {}, "replies": {}}

    def capture(bucket, items):
        """排序结果连同参与排序的计数一起留下：后面才能验证「排序只由计数变化解释」。"""
        bucket["order"] = [item["id"] for item in items]
        bucket["like"] = {item["id"]: item.get("like_count") for item in items}
        bucket["published_at"] = {item["id"]: item.get("published_at") for item in items}
        if any("is_pinned" in item for item in items):
            bucket["is_pinned"] = {item["id"]: bool(item.get("is_pinned")) for item in items}
    with archive_client(str(path)) as api:
        for dynamic, entry in state.items():
            items, cursor = [], None
            while True:
                params = {"sort": "hot", "limit": PAGE_SIZE}
                if cursor is not None:
                    params["cursor"] = cursor
                response = api.get(f"/api/archive/dynamics/{dynamic}/comments", params=params)
                assert response.status_code == 200, response.text
                payload = response.json()
                items.extend(payload["items"])
                cursor = payload.get("next_cursor")
                if cursor is None:
                    break
            snapshot["roots"][dynamic] = {}
            capture(snapshot["roots"][dynamic], items)
            buildings = sorted(entry["buildings"].items(), key=lambda item: -len(item[1]))[:3]
            for root_id, _ in buildings:
                items, page = [], 1
                while True:
                    response = api.get(
                        f"/api/archive/dynamics/{dynamic}/comments/{root_id}/replies",
                        params={"page": page, "sort": "hot"})
                    assert response.status_code == 200, response.text
                    page_items = response.json()["items"]
                    items.extend(page_items)
                    if not page_items:
                        break
                    page += 1
                key = f"{dynamic}:{root_id}"
                snapshot["replies"][key] = {}
                capture(snapshot["replies"][key], items)
    return snapshot


def documented_order(bucket):
    """按归档契约的「最热」口径重排：置顶优先、点赞降序、发表时间降序、ID 升序。"""
    ids = list(bucket["order"])
    if any(bucket["like"][item] is None or bucket["published_at"][item] is None for item in ids):
        return None
    ids.sort()                                                       # id BINARY 升序
    ids.sort(key=lambda item: bucket["published_at"][item], reverse=True)
    ids.sort(key=lambda item: bucket["like"][item], reverse=True)
    if "is_pinned" in bucket:
        ids.sort(key=lambda item: 0 if bucket["is_pinned"][item] else 1)
    return ids


def order_summary(before, after):
    """排序变化：集合不变、位置变动条数、首屏对比、是否等于文档化的最热口径。"""
    result = {}
    for scope in ("roots", "replies"):
        result[scope] = {}
        for key, entry in before[scope].items():
            newer = after[scope].get(key)
            if newer is None:
                result[scope][key] = {"missing_after": True}
                continue
            old_order, new_order = entry["order"], newer["order"]
            moved = sum(1 for index, item in enumerate(old_order) if new_order[index] != item)
            like_changed = sum(1 for item in old_order
                               if entry["like"].get(item) != newer["like"].get(item))
            expected = documented_order(newer)
            result[scope][key] = {
                "items": len(old_order),
                "same_set": sorted(old_order) == sorted(new_order),
                "positions_changed": moved,
                "like_values_changed": like_changed,
                "matches_documented_hot_order": (expected == new_order) if expected else "未验证",
                "top_before": old_order[:5],
                "top_after": new_order[:5],
            }
    return result


# --------------------------------------------------------------------------- 跑刷新


class Driver:
    """受控时钟驱动器：只在没有在途领取时推进节拍，避免租约被模拟时间跳掉。"""

    def __init__(self, clock, path):
        self.clock = clock
        self.path = path
        self.ticks = 0

    def works(self):
        with read_only(self.path) as connection:
            return {row["id"]: (row["work"], row["like_refresh_succeeded_at"], row["sync_error"])
                    for row in connection.execute(
                        "SELECT id, work, like_refresh_succeeded_at, sync_error FROM target_checks")}

    def running(self):
        return any(state[0] == "running" for state in self.works().values())

    def finished(self):
        return all(state[0] == "complete" and state[1] for state in self.works().values())

    async def tick(self):
        from backend.tests.collector_clock import eventually
        await eventually(lambda: bool(self.clock.deadlines) and self.clock.deadlines[-1] > self.clock.value)
        self.clock.advance(self.clock.deadlines[-1] + 1)
        self.ticks += 1


@asynccontextmanager
async def stub_client_factory(source):
    """生产装配的评论客户端位置：真实 SourcePacer + ReplyPagePacer，只换最底层 HTTP。"""
    import httpx
    from backend.bili_monitor.reply_pacing import ReplyPagePacer
    from backend.bili_monitor.source_endpoints import REPLIES_URL
    from backend.bili_monitor.source_transport import PacedSourceTransport

    pacer = ReplyPagePacer(sleep=recorded_sleep)

    class ReplyPaced(httpx.AsyncBaseTransport):
        """楼中楼：生产里由 RequestsCommentClient 负责的页后等待，这里包同一实现。"""

        def __init__(self, inner):
            self.inner = inner

        async def handle_async_request(self, request):
            if str(request.url.copy_with(query=None)) == REPLIES_URL:
                async with pacer.page():
                    return await self.inner.handle_async_request(request)
            return await self.inner.handle_async_request(request)

    transport = PacedSourceTransport(ReplyPaced(httpx.MockTransport(source)), sleep=recorded_sleep)

    @asynccontextmanager
    async def factory(uid):
        async with httpx.AsyncClient(transport=transport) as client:
            yield client

    yield factory


async def run_refresh(path, source, clock, deadline_seconds):
    import httpx
    from backend.bili_monitor.collector import Collector
    from backend.bili_monitor.dispatch import DispatchLeases
    from backend.bili_monitor import replies as replies_module
    from backend.bili_monitor.storage import Store

    replies_module.sleep_after_root = fake_pause
    store = Store(path)
    driver = Driver(clock, path)
    started = time.monotonic()
    async with stub_client_factory(source) as factory:
        async with httpx.AsyncClient(transport=httpx.MockTransport(source)) as client:
            collector = Collector(store, client, clock=clock,
                                  scheduler=DispatchLeases(store, clock=clock),
                                  comment_client_factory=factory,
                                  cadence=lambda: float(CADENCE_SECONDS),
                                  page_check_seconds=86400)
            running = asyncio.create_task(collector.run())
            try:
                await driver.tick()                       # 进入窗口：登记 + 领取 + 开跑
                while not driver.finished():
                    if time.monotonic() - started > deadline_seconds:
                        raise TimeoutError(f"refresh did not finish in {deadline_seconds}s")
                    if driver.running():
                        await asyncio.sleep(0.05)         # 在途领取期间不推进模拟时间
                        continue
                    await driver.tick()
                for _ in range(2):                        # 让结算与再一拍检查落定
                    await driver.tick()
                await asyncio.sleep(2.0)                  # 在途检查写完再退出（不再推进节拍）
            finally:
                running.cancel()
                await asyncio.gather(running, return_exceptions=True)
    return {"wall_seconds": round(time.monotonic() - started, 3), "ticks": driver.ticks,
            "simulated_clock_seconds": round(clock.value, 3)}


# --------------------------------------------------------------------------- 预期成本


def predicted_requests(state, plan):
    """按备份数据与替身变化算出预期请求数（根页/楼页分开）。"""
    expected = {"root_pages": 0, "reply_pages": 0, "detail": {}}
    for dynamic, entry in state.items():
        missing = plan["missing_roots"].get(dynamic, set())
        served = [doc for doc in entry["roots"] if doc["id"] not in missing]
        roots = (len(served) + PAGE_SIZE - 1) // PAGE_SIZE
        expected["root_pages"] += roots + 2                  # + 空尾页 + 空尾复查
        detail = {"dynamics": 1, "root_pages": roots + 2, "reply_pages": 0, "buildings": 0,
                  "empty_buildings": 0}
        for root_id, items in entry["buildings"].items():
            dropped = plan["dropped_replies"].get((dynamic, root_id), set())
            count = len(items) - len(dropped)
            pages = (count + PAGE_SIZE - 1) // PAGE_SIZE
            expected["reply_pages"] += pages + 2              # + 空尾页 + 空尾复查
            detail["reply_pages"] += pages + 2
            detail["buildings"] += 1
        zero = [doc for doc in served if not (doc.get("source_reply_count") or 0)]
        detail["empty_buildings"] = len(zero)
        expected["reply_pages"] += len(zero)                  # 零楼仍需 1 次空页请求
        detail["reply_pages"] += len(zero)
        expected["detail"][dynamic] = detail
    return expected


# --------------------------------------------------------------------------- 主流程


def copy_database(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    return target


def migrate(path):
    from backend.bili_monitor.storage import Store, SCHEMA_VERSION
    Store(path).migrate()
    with read_only(path) as connection:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
    assert version == SCHEMA_VERSION, (version, SCHEMA_VERSION)
    return version


def write_json(path, payload):
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n")


def attach_collector_log(out_dir):
    """采集事件落到文件：用于核对刷新参数（like_refresh/direction）与告警。"""
    from backend.bili_monitor import collector_logging

    collector_logging.configure_collector_logging()
    logger = collector_logging._LOGGER
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
    handler = logging.FileHandler(out_dir / "collector-events.log", mode="w")
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    logger.addHandler(handler)
    return handler


def event_summary(path):
    summary = {"lines": 0, "warning": 0, "events": {}, "like_refresh_started": 0,
               "directions": {}, "registrations": 0}
    if not path.exists():
        return summary
    for line in path.read_text(errors="replace").splitlines():
        if not line.strip():
            continue
        summary["lines"] += 1
        if line.startswith("WARNING"):
            summary["warning"] += 1
        parts = line.split()
        name = parts[1] if len(parts) > 1 else parts[0]
        summary["events"][name] = summary["events"].get(name, 0) + 1
        if name == "sync_started" and "like_refresh=true" in line:
            summary["like_refresh_started"] += 1
        if name == "like_refresh_registered":
            summary["registrations"] += 1
        if name in ("reply_scan_position", "root_scan_position"):
            direction = next((token.split("=", 1)[1] for token in parts
                              if token.startswith("direction=")), None)
            if direction:
                summary["directions"][f"{name}:{direction}"] = summary["directions"].get(
                    f"{name}:{direction}", 0) + 1
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument("--workdir", type=Path, default=Path("/tmp/cmr04-acceptance"))
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--fast", action="store_true")
    parser.add_argument("--predict-only", action="store_true")
    parser.add_argument("--deadline", type=float, default=1800.0)
    args = parser.parse_args()

    repo = Path.cwd()
    assert (repo / "backend/bili_monitor/collector.py").exists(), \
        f"请在工作树根目录运行（当前 {repo}）"
    sys.path.insert(0, str(repo))
    CONFIG["fast"] = args.fast
    args.out.mkdir(parents=True, exist_ok=True)

    identity_before = file_identity(args.baseline)
    state = load_state(args.baseline)
    plan = build_plan(state)
    expected = predicted_requests(state, plan)
    totals = reply_totals(state)
    print(f"来源库 {identity_before['path']} {identity_before['bytes'] / 1048576:.1f} MiB "
          f"sha256={identity_before['sha256'][:16]}…")
    print(f"样本：{len(state)} 动态 / 根 {sum(len(entry['roots']) for entry in state.values())} / "
          f"楼中楼 {sum(totals.values())}；预期根页 {expected['root_pages']}、楼页 {expected['reply_pages']}")
    if args.predict_only:
        write_json(args.out / "predicted-ledger.json", expected)
        return 0

    workdir = args.workdir
    before_db = copy_database(args.baseline, workdir / "before.sqlite")
    work_db = copy_database(args.baseline, workdir / "work.sqlite")
    hot_before_db = copy_database(args.baseline, workdir / "hot-before.sqlite")
    print(f"工作副本 {workdir}（原库只读，未写入）")

    from backend.bili_monitor.storage import SCHEMA_VERSION
    rows_before = read_rows(before_db)
    tables_before = table_counts(before_db)
    hot_before = hot_snapshot(hot_before_db, state, plan)
    print(f"刷新前快照：根 {len(rows_before['root_comments'])} 行 / "
          f"楼中楼 {len(rows_before['replies'])} 行；最热根层 {len(hot_before['roots'])} 份、"
          f"楼中楼层 {len(hot_before['replies'])} 份")

    version = migrate(work_db)
    print(f"工作副本迁移到 schema v{version}（新增点赞刷新锚点列）")

    from backend.tests.collector_clock import ControlledClock
    clock = ControlledClock(WINDOW_START)
    source = StubSource(state, plan)
    log_handler = attach_collector_log(args.out)
    try:
        run = asyncio.run(run_refresh(work_db, source, clock, args.deadline))
    except Exception:
        (args.out / "run-error.txt").write_text(traceback.format_exc())
        raise
    finally:
        logging.getLogger("bili_monitor.collector").removeHandler(log_handler)
        log_handler.close()

    rows_after = read_rows(work_db)
    tables_after = table_counts(work_db)
    hot_after_db = copy_database(work_db, workdir / "hot-after.sqlite")
    hot_after = hot_snapshot(hot_after_db, state, plan)

    report, summary = diff_rows(rows_before, rows_after)
    verification = verify_plan(report, plan, state)
    with (args.out / "diff-rows.jsonl").open("w") as handle:
        for row in report:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    write_json(args.out / "diff-summary.json", summary)
    write_json(args.out / "verification.json", verification)
    write_json(args.out / "diff-archives.json", archive_diff(before_db, work_db))
    write_json(args.out / "diff-tables.json", table_diff(before_db, work_db))
    write_json(args.out / "ordering.json", {
        "before": hot_before, "after": hot_after,
        "changes": order_summary(hot_before, hot_after),
    })
    write_json(args.out / "planned-mutations.json", {
        "notes": plan["notes"],
        "root_like_changes_planned": sum(1 for value in plan["root_like"].values() if value is not OMIT),
        "root_like_missing_planned": sum(1 for value in plan["root_like"].values() if value is OMIT),
        "reply_like_changes_planned": sum(1 for value in plan["reply_like"].values() if value is not OMIT),
        "reply_like_missing_planned": sum(1 for value in plan["reply_like"].values() if value is OMIT),
        "missing_roots": {key: sorted(value) for key, value in plan["missing_roots"].items()},
        "dropped_replies": {f"{key[0]}:{key[1]}": sorted(value)
                            for key, value in plan["dropped_replies"].items()},
    })

    with (args.out / "ledger.jsonl").open("w") as handle:
        for index, (kind, oid, page, root_id, stamp) in enumerate(source.calls):
            handle.write(json.dumps({"index": index, "endpoint_type": kind, "oid": oid,
                                     "page": page, "root_id": root_id,
                                     "at": round(stamp, 6)}, ensure_ascii=False) + "\n")
    actual = source.counts()
    oid_dynamic = {str(entry["locator"]["oid"]): dynamic
                   for dynamic, entry in state.items()}
    by_dynamic = {dynamic: {} for dynamic in state}
    for kind, oid, *_rest in source.calls:
        dynamic = oid_dynamic.get(str(oid))
        if dynamic is None:
            continue
        by_dynamic[dynamic][kind] = by_dynamic[dynamic].get(kind, 0) + 1
    ledger = {
        "requests_total": len(source.calls),
        "predicted_vs_actual": {
            "root_pages": {"predicted": expected["root_pages"], "actual": actual.get("root_comments", 0)},
            "reply_pages": {"predicted": expected["reply_pages"], "actual": actual.get("replies", 0)},
        },
        "by_endpoint": actual,
        "by_dynamic_endpoint": by_dynamic,
        "expected": expected,
        "min_gap_seconds": {
            "root_comments": round(min(source.gaps("root_comments") or [0]), 4),
            "replies": round(min(source.gaps("replies") or [0]), 4),
        },
        "nominal_pacing_seconds": round(sum(CONFIG["waits"]), 3),
        "pacing_waits": len(CONFIG["waits"]),
        "run": run,
        "mode": "fast" if args.fast else "real",
    }
    write_json(args.out / "run-summary.json", ledger)
    events = event_summary(args.out / "collector-events.log")
    write_json(args.out / "collector-events-summary.json", events)
    write_json(args.out / "side-effects.json", {
        "tables_before": tables_before,
        "tables_after": tables_after,
        "changed": {name: {"before": tables_before.get(name), "after": tables_after.get(name)}
                    for name in tables_before if tables_before.get(name) != tables_after.get(name)},
    })
    identity_after = file_identity(args.baseline)
    write_json(args.out / "source-identity.json", {
        "before": identity_before, "after": identity_after,
        "unmodified": identity_before == identity_after,
        "row_totals": {"roots": len(rows_before["root_comments"]),
                       "replies": len(rows_before["replies"])},
        "per_dynamic_roots": {dynamic: len(entry["roots"]) for dynamic, entry in state.items()},
        "per_dynamic_replies": totals,
        "buildings": {dynamic: len(entry["buildings"]) for dynamic, entry in state.items()},
        "schema_version": SCHEMA_VERSION,
    })

    print("\n=== 结果 ===")
    print(f"请求：{ledger['requests_total']} 次 {ledger['by_endpoint']}（预期 {expected['root_pages']} + "
          f"{expected['reply_pages']}）")
    print(f"耗时：墙钟 {run['wall_seconds']}s / 模拟标称等待 {ledger['nominal_pacing_seconds']}s / "
          f"受控时钟 {run['simulated_clock_seconds']}s / 节拍 {run['ticks']}")
    print(f"diff：{summary['rows_compared']} 行逐字段比较，改变 {summary['changed']}，"
          f"字段 {summary['changed_fields']}，结论 ok={summary['ok']}")
    print(f"替身对账：{verification['checks']} 结论 ok={verification['ok']} "
          f"问题 {len(verification['problems'])}")
    print(f"来源库未被修改：{identity_before == identity_after}")
    return 0 if (summary["ok"] and verification["ok"]) else 1


if __name__ == "__main__":
    sys.exit(main())
