"""楼中楼分页与末页增量；目标作者只由同根已归档 parent 解析。

根页 rcount 不变且校准未到期时跳过；成功且已有回复的楼从末页倒序补采，
首次、失败与显式全量仍正序扫描。
"""

from asyncio import sleep as sleep_after_root
import random
import time
from datetime import datetime, timezone

from anyio import to_thread

from .root_comments import comment_fields, nonnegative, root_document, source_id
from .source import media_sources
from .comment_status import utc_now
from .source_endpoints import REPLIES_URL
from .source_client import comment_request_headers
from .collector_logging import (
    SourceRejected, collector_event, collector_failure, source_ids, source_refs,
)
from .risk import SourceRiskPaused


# 与参考脚本 FULL_SCAN_INTERVAL 一致：每根每天至少完整校准一次，补偿增删抵消。
FULL_SCAN_SECONDS = 24 * 60 * 60


def scan_due(progress, observed_count, now_iso):
    """本轮是否需要扫描该楼：新楼层、rcount 变化、上次失败或超出校准周期。"""
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
    return {**document, "root_id": root_id, "parent_id": parent,
            "has_pictures": reply_pictures(reply.get("content") or {})}


def reply_pictures(content):
    """只记下来源已经给出的图片存在性（布尔），不保存回复图片 URL。

    缺失或 null 都不是来源确认无图：保持未知（`None`），由现有元信息合并语义保留
    已观察到的存在性。这里既不新增上游请求，也不扩大回复图片的采集与上传范围。

    回复的图片元信息只是“是否存在”的可选提示，不是归档前置条件：非 list、条目缺
    `img_src`、非法 URL 或条目不是对象时无法可靠解释，按未知（`None`）降级，绝不让
    整页合法文字回复因图片字段失败；只要列表里有一个可可靠解释的图片条目即已知有图。
    根评论的严格图片校验保持不变，不在此处复用降级规则。
    """
    pictures = content.get("pictures")
    if pictures is None:
        return None
    if not isinstance(pictures, list):
        return None
    if not pictures:
        return False
    for picture in pictures:
        try:
            if media_sources([picture], "img_src", "img_"):
                return True
        except (KeyError, TypeError, ValueError):
            continue
    return None


async def fetch_reply_page(client, dynamic_id, root_id, locator, number, *, uid=None, direction="forward"):
    response = await client.get(REPLIES_URL, params={
        "oid": locator["oid"], "type": locator["type"], "root": root_id, "pn": number, "ps": 20,
    }, headers=comment_request_headers(uid), timeout=15)
    response.raise_for_status()
    payload = response.json()
    if type(payload.get("code")) is not int or payload["code"] != 0:
        raise SourceRejected("Reply source rejected request", payload.get("code"))
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
    # 每页一条批量 ID；请求耗时与页后等待分开，分块由日志层按关联号做。
    timing = getattr(client, "last_reply_page", None)
    collector_event("reply_page_fetched", endpoint_type="replies", page=number, direction=direction,
                    fetched=len(ids), reply_ids=source_ids(ids),
                    elapsed_ms=timing.elapsed_ms if timing is not None else None,
                    wait_ms=timing.wait_ms if timing is not None else None,
                    **source_refs(uid=uid, dynamic_id=dynamic_id, root_id=root_id))
    return documents, ids, count


class ReplyDrift(ValueError):
    def __init__(self, pages_fetched):
        super().__init__("Reply count changed during scan")
        self.pages_fetched = pages_fetched


async def fetch_reply_tail(client, dynamic_id, root_id, locator, seen_ids, page_number, *, uid=None):
    """从末页向前取；一次 count 漂移重启扫描，再漂移则本轮不提交。"""
    pages_fetched = 0
    drifted = False
    while True:
        page_number[0] = 1
        first = await fetch_reply_page(client, dynamic_id, root_id, locator, 1, uid=uid, direction="reverse")
        pages_fetched += 1
        count = first[2]
        collected = []
        if count == 0:
            return collected, count, pages_fetched, "first_page"
        number = (count + 19) // 20
        restart = False
        while number >= 1:
            page_number[0] = number
            page = first if number == 1 else await fetch_reply_page(
                client, dynamic_id, root_id, locator, number, uid=uid, direction="reverse")
            if number != 1:
                pages_fetched += 1
            documents, page_ids, current = page
            if current != count:
                if drifted:
                    raise ReplyDrift(pages_fetched)
                drifted = restart = True
                break
            if not page_ids:
                # count 可包含折叠/不可见条目；沿用正序全量的空尾页复查。
                confirmation = await fetch_reply_page(client, dynamic_id, root_id, locator, number, uid=uid, direction="reverse")
                pages_fetched += 1
                if confirmation[1] or confirmation[2] != count:
                    raise ReplyDrift(pages_fetched)
                return collected, count, pages_fetched, "first_page"
            collected.extend(documents)
            if set(page_ids) <= seen_ids and number > 1:
                # 整页已知还不能停：向前重叠一页，防止分页偏移漏掉新回复。
                number -= 1
                page_number[0] = number
                overlap = first if number == 1 else await fetch_reply_page(
                    client, dynamic_id, root_id, locator, number, uid=uid, direction="reverse")
                if number != 1:
                    pages_fetched += 1
                overlap_docs, overlap_ids, overlap_count = overlap
                if overlap_count != count:
                    if drifted:
                        raise ReplyDrift(pages_fetched)
                    drifted = restart = True
                    break
                if not overlap_ids:
                    confirmation = await fetch_reply_page(client, dynamic_id, root_id, locator, number, uid=uid, direction="reverse")
                    pages_fetched += 1
                    if confirmation[1] or confirmation[2] != count:
                        raise ReplyDrift(pages_fetched)
                    return collected, count, pages_fetched, "first_page"
                collected.extend(overlap_docs)
                if set(overlap_ids) <= seen_ids:
                    return collected, count, pages_fetched, "known_page"
            number -= 1
        if not restart:
            return collected, count, pages_fetched, "first_page"


async def sync_replies(store, client, id, generation, roots_result, *, now=None, uid=None, full=False,
                       on_failure=None):
    degraded = roots_result is None
    if degraded:
        # 根扫描失败时降级：用已存根评论及其上次基准继续，只重扫到期/失败的楼，不整轮跳过。
        # 发现新根仍依赖根扫描成功；此处只保证已可读内容不因根失败而被阻塞。
        progress = await to_thread.run_sync(store.reply_progress, id)
        if not progress:
            collector_event("replies_sync_skipped", reason="roots_unconfirmed",
                            **source_refs(dynamic_id=id))
            await to_thread.run_sync(store.finish_replies, id, generation, "unconfirmed", None)
            return
        roots = await to_thread.run_sync(store.roots_for_replies, id, set(progress))
        # 以已存根评论的 rcount 作为本轮基准：失败的楼因 status != success 重扫，
        # 已成功且 rcount 未变的楼仍然跳过，不因根失败而全量重扫。
        observed_replies = {root["id"]: root["source_reply_count"] for root in roots}
        collector_event("replies_sync_degraded", roots=len(observed_replies),
                        **source_refs(dynamic_id=id))
        roots_result = (observed_replies, None)
    observed_replies, observed_count = roots_result
    if uid is None:
        archive = await to_thread.run_sync(store.read_archive, id)
        uid = archive["author"]["id"]
    roots = await to_thread.run_sync(store.roots_for_replies, id, observed_replies)
    progress = await to_thread.run_sync(store.reply_progress, id)
    seen_by_root = await to_thread.run_sync(store.reply_ids, id)
    # 只有存在历史成功记录时才需要判断校准周期；首轮不额外取时钟。
    checked_at = (now() if now is not None else utc_now()) if any(
        entry["status"] == "success" for entry in progress.values()) else None
    failed = False
    skipped = 0
    sync_refs = source_refs(uid=uid, dynamic_id=id)
    collector_event("replies_sync_started", roots=len(roots), **sync_refs)
    for root_index, root in enumerate(roots, 1):
        observed = observed_replies[root["id"]]
        previous = progress.get(root["id"])
        root_refs = source_refs(root_id=root["id"], **sync_refs)
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
        phase = "page_fetch"
        number = 1
        page_number = [1]
        local_ids = seen_by_root.setdefault(root["id"], set())
        incremental = not full and previous is not None and previous["status"] == "success" and bool(local_ids)
        seen_before = local_ids.copy() if incremental else set()
        expanded = False

        async def fetch_page(number):
            # 楼级等待只在真正展开楼中楼后缴纳：跳过、零回复与根页失败都不额外等待。
            nonlocal expanded
            expanded = True
            return await fetch_reply_page(client, id, root["id"], root["comment_locator"],
                                          number, uid=uid)
        try:
            # 只有本轮明确零才可跳页；持久旧零不能冒充新的未知观察。
            if observed == 0:
                if not await to_thread.run_sync(lambda: store.change_reply_root(
                        id, generation, root["id"], "success", 0, observed=0,
                        succeeded_at=now() if now is not None else None)):
                    return
                collector_event("reply_root_finished", local_source_delta=len(local_ids), **root_refs)
                continue
            if incremental:
                collector_event("reply_incremental_started", root_index=root_index, **root_refs)
                phase = "tail_fetch"
                expanded = True
                documents, baseline, pages_fetched, stopped_by = await fetch_reply_tail(
                    client, id, root["id"], root["comment_locator"], local_ids, page_number, uid=uid)
                phase = "save_page"
                if not await to_thread.run_sync(store.save_replies, id, generation, root["id"], documents, baseline):
                    return
                local_ids.update(document["id"] for document in documents)
                collector_event(
                    "reply_page_saved", direction="reverse", pages_fetched=pages_fetched,
                    fetched=len(documents), new=len(local_ids - seen_before),
                    updated=len(documents) - len(local_ids - seen_before), accepted=True,
                    **root_refs)
            else:
                number, baseline, seen = 1, None, set()
                while True:
                    phase = "page_fetch"
                    documents, page_ids, count = await fetch_page(number)
                    phase = "pagination"
                    # 根页 rcount 与楼中楼 count 可能来自不同快照或口径，以本次分页为准。
                    if baseline is not None and count < baseline:
                        raise ValueError("Reply count decreased during scan")
                    if baseline is not None and count != baseline:
                        collector_event("reply_scan_count_grew", baseline=baseline, current=count)
                    baseline = count
                    if page_ids and not set(page_ids) - seen:
                        raise ValueError("Reply pagination did not advance")
                    phase = "save_page"
                    known = set(local_ids)
                    accepted = await to_thread.run_sync(
                        store.save_replies, id, generation, root["id"], documents, count)
                    if not accepted:
                        return
                    local_ids.update(page_ids)
                    collector_event(
                        "reply_page_saved", page=number, direction="forward", fetched=len(page_ids),
                        new=len(set(page_ids) - known), updated=len(set(page_ids) & known),
                        accepted=True, **root_refs)
                    if not page_ids:
                        if number > 1:
                            phase = "tail_fetch"
                            confirmation, confirmed_ids, confirmed_count = await fetch_page(number)
                            phase = "tail_save"
                            if not await to_thread.run_sync(store.save_replies, id, generation, root["id"], confirmation, confirmed_count):
                                return
                            phase = "tail_validate"
                            if confirmed_ids or confirmed_count != baseline:
                                raise ValueError("Unstable empty reply tail")
                        # 来源可含不可见回复；沿用正序全量的空尾页确认规则。
                        if len(seen) > count:
                            raise ValueError("Reply count does not match root")
                        if len(seen) != count:
                            collector_event("reply_scan_short", archived=len(seen), source=count,
                                            **root_refs)
                        break
                    seen.update(page_ids)
                    number += 1
            phase = "finish_root"
            if not await to_thread.run_sync(lambda: store.change_reply_root(
                    id, generation, root["id"], "success", baseline, observed=observed,
                    succeeded_at=now() if now is not None else None)):
                return
            if incremental:
                collector_event("reply_incremental_finished", pages_fetched=pages_fetched,
                                new=len(local_ids - seen_before), stopped_by=stopped_by,
                                local_source_delta=len(local_ids) - baseline, **root_refs)
            else:
                collector_event("reply_root_finished", local_source_delta=len(local_ids) - baseline,
                                **root_refs)
        except SourceRiskPaused:
            # 风控优先于「单根失败不阻止其他根」：不继续下一楼、不写该楼失败。
            raise
        except Exception as error:
            # 单根失败不阻止其他根的可读回复，也不暴露来源异常文本。
            if isinstance(error, ReplyDrift):
                collector_event("reply_incremental_finished", warning=True,
                                pages_fetched=error.pages_fetched, new=0, stopped_by="drift",
                                **root_refs)
            timing = getattr(client, "last_reply_page", None)
            collector_failure("reply_sync_failed", error, stage=phase,
                              page=page_number[0] if incremental else number, root_index=root_index,
                              elapsed_ms=timing.elapsed_ms if timing is not None else None,
                              wait_ms=timing.wait_ms if timing is not None else None,
                              **root_refs)
            if on_failure is not None:
                on_failure(error)
            failed = True
            if not await to_thread.run_sync(store.change_reply_root, id, generation, root["id"], "failed"):
                return
        finally:
            # 楼级节奏在网络与 SQLite 事务外；只在实际展开楼中楼后等待，失败也等待，跳过楼不等待。
            if expanded:
                await sleep_after_root(random.uniform(0.3, 0.4))
    # 降级轮只保证「已存根的可读回复」不落后，未确认根集合，故不宣称全集一致：
    # 沿用 unconfirmed 语义，synced_reply_comment_count 与成功时间不推进。
    await to_thread.run_sync(store.finish_replies, id, generation,
                             "unconfirmed" if degraded else ("failed" if failed else "success"),
                             None if degraded else observed_count,
                             now() if now is not None and not failed and not degraded else None)
    collector_event("replies_sync_finished", warning=failed, succeeded=not failed and not degraded,
                    degraded=degraded, roots=len(roots), skipped=skipped, **sync_refs)
