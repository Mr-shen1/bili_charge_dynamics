"""完整楼中楼来源分页；目标作者只由同根已归档 parent 解析。

增量策略与参考脚本对齐：根页 rcount 与上次成功快照相同的楼层本轮不展开，
只在 rcount 变化、上次失败或满 FULL_SCAN_SECONDS 校准周期时重扫整楼。
"""

from datetime import datetime, timezone

from anyio import to_thread

from .root_comments import comment_fields, nonnegative, root_document, source_id
from .comment_status import utc_now
from .source_endpoints import REPLIES_URL
from .source_client import comment_request_headers
from .collector_logging import collector_event, collector_failure


# 与参考脚本 FULL_SCAN_INTERVAL 一致：每根每天至少完整校准一次，补偿增删抵消。
FULL_SCAN_SECONDS = 24 * 60 * 60


def scan_due(progress, observed_count, now_iso):
    """本轮是否需要重扫该楼：新楼层、rcount 变化、上次失败或超出校准周期。"""
    if progress is None or progress["status"] != "success":
        return True
    if progress["observed_count"] != observed_count:
        return True
    synced_at = progress["synced_at"]
    if not synced_at:
        return True
    if now_iso is None:
        return False
    try:
        age = (datetime.fromisoformat(now_iso) - datetime.fromisoformat(synced_at)).total_seconds()
    except (TypeError, ValueError):
        return True
    return age >= FULL_SCAN_SECONDS


def reply_document(reply, dynamic_id, root_id, locator):
    root = source_id(reply.get("root_str", reply.get("root")))
    try:
        parent = source_id(reply.get("parent_str", reply.get("parent")))
    except ValueError:
        parent = None
    if root != root_id:
        raise ValueError("Mismatched reply root")
    document = comment_fields(reply, dynamic_id, locator)
    if document["id"] in (root_id, parent):
        raise ValueError("Invalid reply relation")
    return {**document, "root_id": root_id, "parent_id": parent}


async def fetch_reply_page(client, dynamic_id, root_id, locator, number, *, uid=None):
    response = await client.get(REPLIES_URL, params={
        "oid": locator["oid"], "type": locator["type"], "root": root_id, "pn": number, "ps": 20,
    }, headers=comment_request_headers(uid), timeout=15)
    response.raise_for_status()
    payload = response.json()
    if type(payload.get("code")) is not int or payload["code"] != 0:
        raise ValueError("Reply source rejected request")
    data = payload["data"]
    page = data["page"]
    if type(page.get("num")) is not int or page["num"] != number or type(page.get("size")) is not int or page["size"] != 20:
        raise ValueError("Mismatched reply page")
    count = nonnegative(page.get("count"))
    if count is None:
        raise ValueError("Unknown reply count")
    root = root_document(data["root"], dynamic_id, locator)
    if root["id"] != root_id:
        raise ValueError("Mismatched reply resource")
    items = data["replies"]
    if items is None:
        items = []
    if not isinstance(items, list) or len(items) > 20 or (count == 0 and items):
        raise ValueError("Invalid reply page")
    documents = [reply_document(item, dynamic_id, root_id, locator) for item in items]
    ids = [document["id"] for document in documents]
    if len(set(ids)) != len(ids) or (number == 1 and count > 0 and not ids):
        raise ValueError("Unconfirmed reply page")
    return documents, ids, count


async def sync_replies(store, client, id, generation, roots_result, *, now=None, uid=None, full=False):
    if roots_result is None:
        collector_event("replies_sync_skipped", reason="roots_unconfirmed")
        await to_thread.run_sync(store.finish_replies, id, generation, "unconfirmed", None)
        return
    observed_replies, observed_count = roots_result
    if uid is None:
        archive = await to_thread.run_sync(store.read_archive, id)
        uid = archive["author"]["id"]
    roots = await to_thread.run_sync(store.roots_for_replies, id, observed_replies)
    progress = await to_thread.run_sync(store.reply_progress, id)
    # 只有存在历史成功记录时才需要判断校准周期；首轮不额外取时钟。
    checked_at = (now() if now is not None else utc_now()) if any(
        entry["status"] == "success" for entry in progress.values()) else None
    failed = False
    skipped = 0
    collector_event("replies_sync_started", roots=len(roots))
    for root_index, root in enumerate(roots, 1):
        observed = observed_replies[root["id"]]
        previous = progress.get(root["id"])
        if not full and not scan_due(previous, observed, checked_at):
            # 楼层回复数与上次成功快照相同且校准未到期：不重发回复请求，也不刷新校准计时。
            skipped += 1
            if not await to_thread.run_sync(lambda: store.change_reply_root(
                    id, generation, root["id"], "success", previous["source_count"],
                    observed=observed, succeeded_at=previous["synced_at"])):
                return
            continue
        if not await to_thread.run_sync(store.change_reply_root, id, generation, root["id"], "pending"):
            return
        # 只有本轮明确零才可跳页；持久旧零不能冒充新的未知观察。
        if observed == 0:
            if not await to_thread.run_sync(lambda: store.change_reply_root(
                    id, generation, root["id"], "success", 0, observed=0,
                    succeeded_at=now() if now is not None else None)):
                return
            continue
        phase = "page_fetch"
        try:
            number, baseline, seen = 1, None, set()
            while True:
                phase = "page_fetch"
                documents, page_ids, count = await fetch_reply_page(client, id, root["id"], root["comment_locator"], number, uid=uid)
                phase = "pagination"
                # 根页 rcount 与楼中楼 count 可能来自不同快照或口径（热帖持续增长、折叠/删除仍计数），
                # 以本次楼中楼分页自洽为准，不要求与根页旧值相等。
                if baseline is not None and count != baseline:
                    raise ValueError("Reply count changed during scan")
                baseline = count
                if page_ids and not set(page_ids) - seen:
                    raise ValueError("Reply pagination did not advance")
                phase = "save_page"
                if not await to_thread.run_sync(store.save_replies, id, generation, root["id"], documents, count):
                    return
                if not page_ids:
                    if number > 1:
                        phase = "tail_fetch"
                        confirmation, confirmed_ids, confirmed_count = await fetch_reply_page(client, id, root["id"], root["comment_locator"], number, uid=uid)
                        phase = "tail_save"
                        if not await to_thread.run_sync(store.save_replies, id, generation, root["id"], confirmation, confirmed_count):
                            return
                        phase = "tail_validate"
                        if confirmed_ids or confirmed_count != baseline:
                            raise ValueError("Unstable empty reply tail")
                    # 上游 count 可能包含未返回的回复（已删除、折叠、对当前账号不可见）。
                    # 翻完并连续确认空尾页即视为本轮可读内容已取全；差额只记录，不整根判失败。
                    if len(seen) > count:
                        # 反过来的偏差（返回比声称更多）说明分页/计数不可信，仍按失败保留旧内容。
                        raise ValueError("Reply count does not match root")
                    if len(seen) != count:
                        collector_event("reply_scan_short", archived=len(seen), source=count)
                    break
                seen.update(page_ids)
                number += 1
            phase = "finish_root"
            if not await to_thread.run_sync(lambda: store.change_reply_root(
                    id, generation, root["id"], "success", baseline, observed=observed,
                    succeeded_at=now() if now is not None else None)):
                return
        except Exception as error:
            # 单根失败不阻止其他根的可读回复，也不暴露来源异常文本。
            collector_failure("reply_sync_failed", error, stage=phase, page=number, root_index=root_index)
            failed = True
            if not await to_thread.run_sync(store.change_reply_root, id, generation, root["id"], "failed"):
                return
    await to_thread.run_sync(store.finish_replies, id, generation, "failed" if failed else "success", observed_count,
                            now() if now is not None and not failed else None)
    collector_event("replies_sync_finished", warning=failed, succeeded=not failed, roots=len(roots), skipped=skipped)
