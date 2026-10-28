"""根评论来源协议与独立同步；不采回复预览，不以来源计数猜根页数。"""

import time
from typing import NamedTuple

from anyio import to_thread

from . import scan_progress
from .identifiers import is_valid_id
from .source import media_sources, published_time, safe_url
from .source_endpoints import ROOT_COMMENTS_URL
from .source_client import comment_request_headers
from .collector_logging import (
    SourceRejected, collector_event, collector_failure, source_ids, source_refs,
)
from .risk import SourceRiskPaused


def nonnegative(value):
    return value if type(value) is int and value >= 0 else None


def source_id(value, *, allow_zero=False):
    value = str(value) if type(value) is int else value
    if (allow_zero and value == "0") or is_valid_id(value):
        return value
    raise ValueError("Invalid comment ID")


def valid_locator(locator):
    return (isinstance(locator, dict) and is_valid_id(locator.get("oid"))
            and type(locator.get("type")) is int and locator["type"] > 0)


def comment_fields(reply, dynamic_id, locator):
    """根与回复共用的来源身份／文本字段，不涉及层级或业务图片。"""
    id = source_id(reply.get("rpid_str", reply.get("rpid")))
    if locator.get("source") in ("opus_fallback", "dynamic_id_fallback") and not (
            "oid" in reply and "type" in reply):
        raise ValueError("Unverified fallback comment resource")
    if "oid" in reply and source_id(reply["oid"]) != locator["oid"]:
        raise ValueError("Mismatched comment resource")
    if "type" in reply and (type(reply["type"]) is not int or reply["type"] != locator["type"]):
        raise ValueError("Mismatched comment type")
    content = reply.get("content")
    content = {} if content is None else content
    if not isinstance(content, dict):
        raise ValueError("Invalid comment content")
    text = content.get("message")
    if text is not None and not isinstance(text, str):
        raise ValueError("Invalid comment text")
    member = reply.get("member") or {}
    mid = member.get("mid")
    try:
        mid = source_id(mid)
    except ValueError:
        mid = None
    return {
        "id": id, "dynamic_id": dynamic_id,
        "author": {"id": mid, "nickname": member.get("uname") if isinstance(member.get("uname"), str) else None,
                   "avatar_url": safe_url(member.get("avatar"))},
        "published_at": published_time(reply.get("ctime")), "text": text,
        "like_count": nonnegative(reply.get("like")),
    }


def root_document(reply, dynamic_id, locator):
    if not isinstance(reply, dict):
        raise ValueError("Invalid root comment")
    root = source_id(reply.get("root_str", reply.get("root")), allow_zero=True)
    parent = source_id(reply.get("parent_str", reply.get("parent")), allow_zero=True)
    if root != "0" or parent != "0":
        raise ValueError("Not a root comment")
    document = comment_fields(reply, dynamic_id, locator)
    content = reply.get("content") or {}
    # 缺失或 null 都不是来源确认无图；参考脚本还支持 picture 单图回退。
    pictures = content.get("pictures")
    if not pictures and isinstance(content.get("picture"), dict):
        pictures = [content["picture"]]
    media = media_sources(pictures, "img_src", "img_") if pictures is not None else None
    return {**document, "source_reply_count": nonnegative(reply.get("rcount")),
            "root_id": root, "parent_id": parent, "comment_locator": locator, "media_sources": media}


async def fetch_comment_count(client, locator, *, uid=None):
    """读取独立评论区总数信号，不由根页／本地条数推导。"""
    if not valid_locator(locator):
        raise ValueError("Unknown comment resource")
    response = await client.get("https://api.bilibili.com/x/v2/reply/count", params={
        "oid": locator["oid"], "type": locator["type"],
    }, headers=comment_request_headers(uid), timeout=15)
    response.raise_for_status()
    payload = response.json()
    if type(payload.get("code")) is not int or payload["code"] != 0:
        raise SourceRejected("Comment count source rejected request", payload.get("code"))
    count = nonnegative(payload["data"].get("count"))
    if count is None:
        raise ValueError("Unknown comment count")
    return count


async def fetch_root_page(client, dynamic_id, locator, number, *, on_pin=None, uid=None):
    response = await client.get(ROOT_COMMENTS_URL, params={
        "oid": locator["oid"], "type": locator["type"], "pn": number, "ps": 20, "sort": 0,
    }, headers=comment_request_headers(uid), timeout=15)
    response.raise_for_status()
    payload = response.json()
    if type(payload.get("code")) is not int or payload["code"] != 0:
        raise SourceRejected("Comment source rejected request", payload.get("code"))
    data = payload["data"]
    page = data["page"]
    if type(page.get("num")) is not int or page["num"] != number or type(page.get("size")) is not int or page["size"] != 20:
        raise ValueError("Mismatched comment page")
    count = nonnegative(page.get("count"))
    if count is None:
        raise ValueError("Unknown comment page count")
    # acount 是接口的总数证据；缺失不写零，也不替代动态 module_stat 的来源信号。
    total = nonnegative(page.get("acount"))
    if "acount" in page and total is None:
        raise ValueError("Invalid comment total")
    counts = (count, total)
    replies = data["replies"]
    if replies is None:
        replies = []
    if not isinstance(replies, list) or len(replies) > 20 or (count == 0 and replies):
        raise ValueError("Invalid comment page")
    extras = []
    pin_known, pinned_id = False, None
    if number == 1:
        upper = data.get("upper")
        if upper is not None and not isinstance(upper, dict):
            raise ValueError("Invalid comment upper metadata")
        pin_known = isinstance(upper, dict) and "top" in upper
        top = upper.get("top") if isinstance(upper, dict) else None
        if top is not None:
            if not isinstance(top, dict):
                raise ValueError("Invalid top comment")
            extras.append(top)
            pinned_id = source_id(top.get("rpid_str", top.get("rpid")))
        hots = data.get("hots") or []
        if not isinstance(hots, list):
            raise ValueError("Invalid hot comments")
        extras.extend(hots)
    documents = {item["id"]: item for item in
                 (root_document(reply, dynamic_id, locator) for reply in extras + replies)}
    if number == 1 and count > 0 and not documents:
        raise ValueError("Unconfirmed empty comment resource")
    if count == 0 and documents:
        raise ValueError("Contradictory empty comment resource")
    # 置顶来自首页 envelope，与普通列表的同 ID 副本分开，避免去重时丢失。
    # 缺失 upper.top 表示未知；显式 null 才表示确认没有置顶。
    if number == 1 and pin_known and on_pin is not None:
        on_pin(pinned_id)
    return list(documents.values()), [source_id(reply.get("rpid_str", reply.get("rpid"))) for reply in replies], counts


class RootStep(NamedTuple):
    """一次可独立恢复的根页步骤：提交一页数据与对应进度，或收束整轮。

    07／08 可以把「一页」当作调度片：任一时刻中断后，下一次从 `store.read_root_scan`
    取回同一步位置即可继续，不需要把分页循环放在内存里跨节拍存活。
    """

    status: str            # 'page' | 'complete' | 'stale'
    page: int | None
    next_page: int | None
    fetched: int
    new: int
    confirmed: int
    reason: str | None
    root_ids: tuple
    reply_counts: tuple = ()  # (root_id, 来源 rcount) 对；避免可变默认值


def _stage(error, stage, page):
    """给异常附加固定阶段与页码：日志只输出固定分类，不回显异常原文。"""
    error.stage, error.page = stage, page
    return error


def _stale(page=None, reason="stale_generation"):
    return RootStep("stale", page, None, 0, 0, 0, reason, ())


def _empty_unconfirmed(observed_count, locator):
    """首个非空计数页没有任何根：来源未确认，不能当成功空集合。"""
    return ((type(observed_count) is int and observed_count > 0)
            or locator.get("source") in ("opus_fallback", "dynamic_id_fallback"))


async def _verify_anchor(store, client, id, generation, position, *, uid=None, observed_count=None):
    """恢复时校验页锚点：锚点页找不到时在有界窗口内前后重定位。

    只保存 `pn + 1` 就盲跳会在上游插入或删除后跳过内容，所以续采必须先重新看到上一次
    提交页的尾部，再按实际位移折算下一位置：

    - 对齐：分页没动，重叠页照常入库后从下一页继续。
    - 前移（删除）：内容整体提前，按锚点末项的新页位置续读，删除不影响已归档内容。
    - 后移（头部插入）：受影响区段是锚点之前新插入的页，只重读这几页，再回到锚点之后，
      不整轮重扫；锚点仍保留“最后已提交页”，不会把未读页冒充已确认。
    - 窗口内都找不到锚点：回到首屏按 ID 合并重扫。
    """
    anchor_page, anchor_ids = position.anchor_page, list(position.anchor_ids)
    found, shifted = None, None
    for offset in scan_progress.RESUME_PAGE_OFFSETS:
        candidate = anchor_page + offset
        if candidate < 1:
            continue
        try:
            documents, ids, counts = await fetch_root_page(client, id, position.locator, candidate, uid=uid)
        except Exception as error:
            raise _stage(error, "anchor_verify", candidate)
        hit = scan_progress.alignment(ids, anchor_ids)
        if hit is not None:
            shifted = scan_progress.shift(candidate, hit[0], anchor_page, len(anchor_ids),
                                          position.page_size)
            found = (candidate, hit[0], documents, ids, counts)
            break

    async def commit(documents):
        nonlocal updated
        saved = await to_thread.run_sync(
            lambda: store.save_root_page(id, generation, documents, observed_count, updated))
        if saved is None:
            return False
        updated = updated._replace(confirmed=saved["confirmed"])
        return True

    updated = position
    if found is None:
        # 锚点已不可见：受影响区段无法直接定位，回到首屏按 ID 合并重扫；已提交页保留。
        updated, reason = position._replace(
            phase=scan_progress.PAGES, next_page=1, anchor_page=0, anchor_ids=(),
            overlap_page=0, counts=None), "anchor_lost"
        saved = await to_thread.run_sync(lambda: store.save_root_position(id, generation, updated))
    else:
        page, index, documents, ids, counts = found
        reason = "aligned" if shifted == 0 else ("inserted" if shifted > 0 else "removed")
        updated = position._replace(phase=scan_progress.PAGES, overlap_page=0, counts=tuple(counts),
                                    next_page=scan_progress.following_page(page, index, len(ids)))
        if shifted > 0:
            affected = (shifted + position.page_size - 1) // position.page_size
            saved = True
            for number in range(1, affected + 1):
                try:
                    head, _, _ = await fetch_root_page(client, id, position.locator, number, uid=uid)
                except Exception as error:
                    raise _stage(error, "anchor_verify", number)
                saved = await commit(head)
                if not saved:
                    break
        else:
            saved = await commit(documents)
        if saved:
            saved = await to_thread.run_sync(lambda: store.save_root_position(id, generation, updated))
    if not saved:
        return None
    collector_event("root_scan_resumed", resume=reason, anchor_page=anchor_page,
                    overlap_page=anchor_page, page=updated.next_page, shift=shifted,
                    confirmed=updated.confirmed, **source_refs(uid=uid, dynamic_id=id))
    return updated


async def root_scan_step(store, client, id, generation, *, uid=None, resume=False, full=False):
    """推进一个根页步骤；`resume=True` 表示一次新尝试的第一步（开启锚点重叠校验）。"""
    archive = await to_thread.run_sync(store.read_archive, id)
    if archive is None:
        raise ValueError("Unknown comment resource")
    locator = archive.get("comment_locator")
    if not valid_locator(locator):
        raise _stage(ValueError("Unknown comment resource"), "locator", 1)
    if uid is None:
        uid = archive["author"]["id"]
    observed_count = archive.get("source_comment_count")
    reason = None
    if resume:
        started = await to_thread.run_sync(
            lambda: store.resume_root_scan(id, generation, locator, observed_count, full=full))
        if started is None:
            return _stale()
        position, reason = started["position"], started["reason"]
        collector_event("root_scan_position", resume=reason, phase=position.phase,
                        page=position.next_page, confirmed=position.confirmed, **source_refs(
                            uid=uid, dynamic_id=id))
        if position.overlap_page:
            position = await _verify_anchor(store, client, id, generation, position, uid=uid,
                                            observed_count=observed_count)
            if position is None:
                return _stale()
    else:
        position = await to_thread.run_sync(lambda: store.read_root_scan(id, generation))
        if position is None:
            return _stale()

    if position.phase == scan_progress.COMPLETE:
        return RootStep("complete", None, None, 0, 0, position.confirmed, "complete", ())

    number = position.next_page
    if position.phase == scan_progress.TAIL:
        try:
            documents, ids, counts = await fetch_root_page(client, id, locator, number, uid=uid)
        except Exception as error:
            raise _stage(error, "tail_fetch", number)
        confirm_started = time.monotonic()
        unstable = bool(ids) or tuple(counts) != position.counts
        # 复查页不空或计数又变了：退回锚点重新定位，不用同一旧基准反复判定到永远。
        outcome = (position._replace(phase=scan_progress.PAGES, counts=None,
                                     next_page=position.anchor_page or 1,
                                     overlap_page=position.anchor_page)
                   if unstable else position._replace(phase=scan_progress.COMPLETE, overlap_page=0))
        # 复查已取得的页照常保存：瞬时空、后续页失败或计数变化都不能丢掉可读内容。
        saved = await to_thread.run_sync(lambda: store.save_root_page(
            id, generation, documents, observed_count, outcome))
        if saved is None:
            return _stale(number)
        collector_event("root_page_saved", page=number, direction="tail_confirmation",
                        fetched=saved["fetched"], comment_ids=source_ids(ids),
                        elapsed_ms=max(0, int((time.monotonic() - confirm_started) * 1000)),
                        **source_refs(uid=uid, dynamic_id=id))
        if unstable:
            raise _stage(ValueError("Unstable empty comment tail"), "tail_validate", number)
        collector_event("root_tail_confirmed", page=number, direction=position.direction,
                        checkpoint="accepted", confirmed=saved["confirmed"],
                        **source_refs(uid=uid, dynamic_id=id))
        return RootStep("complete", number, None, 0, 0, saved["confirmed"], "tail_confirmed", (),
                        tuple(saved["reply_counts"].items()))

    pin = {}

    def observe_pin(value):
        pin["known"], pin["id"] = True, value

    started = time.monotonic()
    try:
        documents, ids, counts = await fetch_root_page(
            client, id, locator, number, on_pin=observe_pin, uid=uid)
    except Exception as error:
        raise _stage(error, "page_fetch", number)
    if pin.get("known"):
        position = position._replace(pin_known=True, pinned_id=pin.get("id"))
    counts = tuple(counts)
    if position.counts is not None and counts[0] < position.counts[0]:
        # 总数减少说明有删除，分页可能整体前移，重试以免漏内容。
        raise _stage(ValueError("Comment counts decreased during scan"), "pagination", number)
    if position.counts is not None and counts != position.counts:
        # 总数增长（多为楼中楼新增）不影响根分页一致性；页偏移由锚点与重复 ID 检测负责。
        collector_event("root_scan_count_grew", dynamic_id=id, page=number,
                        baseline=position.counts[0], current=counts[0])
    if ids and set(ids) <= set(position.anchor_ids):
        raise _stage(ValueError("Comment pagination did not advance"), "pagination", number)
    if not ids:
        if number == 1 and _empty_unconfirmed(observed_count, locator):
            raise _stage(ValueError("Unconfirmed empty comment resource"), "empty_confirmation", number)
        # 非首屏空页留待复读确认；首屏空集合直接收束。
        next_phase = scan_progress.TAIL if number > 1 else scan_progress.COMPLETE
    else:
        known = await to_thread.run_sync(lambda: store.known_root_count(id, ids)) == len(set(ids))
        if position.phase == scan_progress.GUARD:
            # 相邻两页都整页已确认：偏移没有把新根甩到后面，收束本轮。
            next_phase = scan_progress.COMPLETE if known else scan_progress.PAGES
        elif known and not position.full:
            # 整页已确认只前进到「守卫」：再用下一页确认收束，不整轮全量重扫。
            next_phase = scan_progress.GUARD
        else:
            next_phase = scan_progress.PAGES
    next_page = number + 1 if next_phase != scan_progress.TAIL else number
    updated = position._replace(phase=next_phase, next_page=next_page, anchor_page=number,
                                anchor_ids=tuple(ids), counts=counts, overlap_page=0)
    saved = await to_thread.run_sync(
        lambda: store.save_root_page(id, generation, documents, observed_count, updated))
    if saved is None:
        collector_event("root_page_rejected", page=number, reason="stale_generation",
                        **source_refs(uid=uid, dynamic_id=id))
        return _stale(number)
    # 每页一条批量业务 ID；根页节奏仍是发送前等待，这里只记录本次读取耗时。
    collector_event("root_page_saved", page=number, direction=updated.direction,
                    fetched=saved["fetched"], new=saved["new"], confirmed=saved["confirmed"],
                    comment_ids=source_ids(ids), phase=next_phase, checkpoint="accepted",
                    elapsed_ms=max(0, int((time.monotonic() - started) * 1000)),
                    **source_refs(uid=uid, dynamic_id=id))
    return RootStep("complete" if next_phase == scan_progress.COMPLETE else "page", number,
                    next_page, saved["fetched"], saved["new"], saved["confirmed"], reason,
                    tuple(ids), tuple(saved["reply_counts"].items()))


async def sync_roots(store, client, id, generation, *, now=None, uid=None, on_failure=None, full=False):
    """根评论整轮：逐页提交进度，失败或重开时从可验证断点继续。"""
    archive = await to_thread.run_sync(store.read_archive, id)
    if archive is None:
        collector_event("root_sync_skipped", reason="archive_missing")
        return
    if uid is None:
        uid = archive["author"]["id"]
    if not valid_locator(archive.get("comment_locator")):
        collector_event("root_sync_unconfirmed", warning=True, reason="locator_missing")
        await to_thread.run_sync(store.finish_roots, id, generation, "unconfirmed", None)
        return
    observed_count = archive.get("source_comment_count")
    sync_refs = source_refs(uid=uid, dynamic_id=id)
    collector_event("root_sync_started", **sync_refs)
    source_counts = {}
    try:
        step = await root_scan_step(store, client, id, generation, uid=uid, resume=True, full=full)
        while True:
            source_counts.update(dict(step.reply_counts))
            if step.status != "page":
                break
            step = await root_scan_step(store, client, id, generation, uid=uid)
    except SourceRiskPaused:
        # 保护暂停不是根页失败：保留 pending 与已提交页，进度行留给恢复后续采。
        raise
    except Exception as error:
        collector_failure("root_sync_failed", error, stage=getattr(error, "stage", "page_fetch"),
                          page=getattr(error, "page", None), **sync_refs)
        if on_failure is not None:
            # 采集侧只上报固定分类（含唯一可信的凭据信号），不把异常文本或正文带出去。
            on_failure(error)
        await to_thread.run_sync(store.finish_roots, id, generation, "failed", None)
        return
    if step.status == "stale":
        collector_event("root_sync_skipped", reason="stale_generation", page=step.page)
        return
    position = await to_thread.run_sync(lambda: store.read_root_scan(id, generation))
    if position is None:
        collector_event("root_sync_skipped", reason="stale_generation", stage="finish")
        return
    finished = await to_thread.run_sync(lambda: store.finish_roots(
        id, generation, "success", observed_count, now() if now is not None else None,
        pin_known=position.pin_known, pinned_id=position.pinned_id))
    if finished is None:
        collector_event("root_sync_skipped", reason="stale_generation", stage="finish")
        return
    # 楼中楼增量基准用整轮已存根集合，本轮实际读到的页用本次来源值覆盖：
    # 未重读的深层根沿用归档 rcount，避免早停把「未知」错配成旧零或反过来。
    roots = await to_thread.run_sync(store.root_reply_counts, id)
    roots.update(source_counts)
    collector_event("root_sync_finished", page=step.page, roots=len(roots),
                    confirmed=position.confirmed, pin_known=position.pin_known, **sync_refs)
    return roots, observed_count
