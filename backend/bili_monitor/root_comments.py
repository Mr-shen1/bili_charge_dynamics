"""根评论来源协议与独立同步；不采回复预览，不以来源计数猜根页数。"""

import time

from anyio import to_thread

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


async def sync_roots(store, client, id, generation, *, now=None, uid=None, on_failure=None):
    archive = await to_thread.run_sync(store.read_archive, id)
    if uid is None:
        uid = archive["author"]["id"]
    locator = archive.get("comment_locator")
    if not valid_locator(locator):
        collector_event("root_sync_unconfirmed", warning=True, reason="locator_missing")
        await to_thread.run_sync(store.finish_roots, id, generation, "unconfirmed", None)
        return
    observed_count = archive.get("source_comment_count")
    if not await to_thread.run_sync(store.begin_roots, id, generation):
        collector_event("root_sync_skipped", reason="stale_generation")
        return
    sync_refs = source_refs(uid=uid, dynamic_id=id)
    collector_event("root_sync_started", **sync_refs)
    phase = "page_fetch"
    pin_known, pinned_id = False, None

    def observe_pin(value):
        nonlocal pin_known, pinned_id
        pin_known, pinned_id = True, value

    try:
        number, baseline, seen, roots = 1, None, set(), {}
        while True:
            phase = "page_fetch"
            started = time.monotonic()
            documents, ids, counts = await fetch_root_page(client, id, locator, number, on_pin=observe_pin, uid=uid)
            phase = "pagination"
            if baseline is not None and counts[0] < baseline[0]:
                # 总数减少说明有删除，分页可能整体前移，重试以免漏内容。
                raise ValueError("Comment counts decreased during scan")
            if baseline is not None and counts != baseline:
                # 总数增长（多为楼中楼新增）不影响根分页一致性；页偏移由重复 ID 检测负责。
                collector_event("root_scan_count_grew", baseline=baseline[0], current=counts[0],
                                **sync_refs)
            baseline = counts
            if ids and not set(ids) - seen:
                raise ValueError("Comment pagination did not advance")
            phase = "save_page"
            if not await to_thread.run_sync(store.save_roots, id, generation, documents, observed_count):
                collector_event("root_sync_skipped", reason="stale_generation", page=number)
                return
            roots.update({document["id"]: document["source_reply_count"] for document in documents})
            # 每页一条批量 ID；根页节奏仍是发送前等待，这里只记录本次读取耗时。
            collector_event("root_page_saved", page=number, direction="forward", fetched=len(ids),
                            comment_ids=source_ids(ids),
                            elapsed_ms=max(0, int((time.monotonic() - started) * 1000)), **sync_refs)
            if not ids:
                if number > 1:
                    # 对候选空尾页复查；瞬时空、后续页失败或计数变化不能推进成功。
                    phase = "tail_fetch"
                    confirm_started = time.monotonic()
                    confirmation, confirmed_ids, confirmed_counts = await fetch_root_page(client, id, locator, number, uid=uid)
                    phase = "tail_save"
                    if not await to_thread.run_sync(store.save_roots, id, generation, confirmation, observed_count):
                        collector_event("root_sync_skipped", reason="stale_generation", page=number)
                        return
                    collector_event("root_page_saved", page=number, direction="tail_confirmation",
                                    fetched=len(confirmed_ids), comment_ids=source_ids(confirmed_ids),
                                    elapsed_ms=max(0, int((time.monotonic() - confirm_started) * 1000)),
                                    **sync_refs)
                    phase = "tail_validate"
                    if confirmed_ids or confirmed_counts != baseline:
                        raise ValueError("Unstable empty comment tail")
                break
            seen.update(ids)
            number += 1
        phase = "empty_confirmation"
        if not roots and (
                type(observed_count) is int and observed_count > 0
                or locator.get("source") in ("opus_fallback", "dynamic_id_fallback")):
            raise ValueError("Unconfirmed empty comment resource")
    except SourceRiskPaused:
        # 保护暂停不是根页失败：保留 pending 与已提交页，不改写失败事实。
        raise
    except Exception as error:
        collector_failure("root_sync_failed", error, stage=phase, page=number, **sync_refs)
        if on_failure is not None:
            # 采集侧只上报固定分类（含唯一可信的凭据信号），不把异常文本或正文带出去。
            on_failure(error)
        await to_thread.run_sync(store.finish_roots, id, generation, "failed", None)
        return
    if await to_thread.run_sync(lambda: store.finish_roots(
            id, generation, "success", observed_count, now() if now is not None else None,
            pin_known=pin_known, pinned_id=pinned_id)):
        collector_event("root_sync_finished", pages=number, roots=len(roots), pin_known=pin_known,
                        **sync_refs)
        return roots, observed_count
    collector_event("root_sync_skipped", reason="stale_generation", stage="finish")
