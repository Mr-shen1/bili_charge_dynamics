"""根评论来源协议与独立同步；不采回复预览，不以来源计数猜根页数。"""

from anyio import to_thread

from .identifiers import is_valid_id
from .source import media_sources, published_time, safe_url


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
    if "oid" in reply and source_id(reply["oid"]) != locator["oid"]:
        raise ValueError("Mismatched comment resource")
    if "type" in reply and (type(reply["type"]) is not int or reply["type"] != locator["type"]):
        raise ValueError("Mismatched comment type")
    content = reply["content"]
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
    root = source_id(reply.get("root_str", reply.get("root")), allow_zero=True)
    parent = source_id(reply.get("parent_str", reply.get("parent")), allow_zero=True)
    if root != "0" or parent != "0":
        raise ValueError("Not a root comment")
    document = comment_fields(reply, dynamic_id, locator)
    content = reply["content"]
    # 缺字段不是来源确认无图；仓储会保留旧元信息，新评论仍公开空数组。
    media = media_sources(content["pictures"], "img_src", "img_") if "pictures" in content else None
    return {**document, "source_reply_count": nonnegative(reply.get("rcount")),
            "root_id": root, "parent_id": parent, "comment_locator": locator, "media_sources": media}


async def fetch_comment_count(client, locator):
    """读取独立评论区总数信号，不由根页／本地条数推导。"""
    if not valid_locator(locator):
        raise ValueError("Unknown comment resource")
    response = await client.get("https://api.bilibili.com/x/v2/reply/count", params={
        "oid": locator["oid"], "type": locator["type"],
    })
    response.raise_for_status()
    payload = response.json()
    if type(payload.get("code")) is not int or payload["code"] != 0:
        raise ValueError("Comment count source rejected request")
    count = nonnegative(payload["data"].get("count"))
    if count is None:
        raise ValueError("Unknown comment count")
    return count


async def fetch_root_page(client, dynamic_id, locator, number):
    response = await client.get("https://api.bilibili.com/x/v2/reply", params={
        "oid": locator["oid"], "type": locator["type"], "pn": number, "ps": 20, "sort": 0,
    })
    response.raise_for_status()
    payload = response.json()
    if type(payload.get("code")) is not int or payload["code"] != 0:
        raise ValueError("Comment source rejected request")
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
    if number == 1:
        top = (data.get("upper") or {}).get("top")
        if top is not None:
            extras.append(top)
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
    return list(documents.values()), [source_id(reply.get("rpid_str", reply.get("rpid"))) for reply in replies], counts


async def sync_roots(store, client, id, generation, *, now=None):
    archive = await to_thread.run_sync(store.read_archive, id)
    locator = archive.get("comment_locator")
    if not valid_locator(locator):
        await to_thread.run_sync(store.finish_roots, id, generation, "unconfirmed", None)
        return
    observed_count = archive.get("source_comment_count")
    if not await to_thread.run_sync(store.begin_roots, id, generation):
        return
    try:
        number, baseline, seen, roots = 1, None, set(), {}
        while True:
            documents, ids, counts = await fetch_root_page(client, id, locator, number)
            if baseline is not None and counts != baseline:
                raise ValueError("Comment counts changed during scan")
            baseline = counts
            if ids and not set(ids) - seen:
                raise ValueError("Comment pagination did not advance")
            if not await to_thread.run_sync(store.save_roots, id, generation, documents, observed_count):
                return
            roots.update({document["id"]: document["source_reply_count"] for document in documents})
            if not ids:
                if number > 1:
                    # 对候选空尾页复查；瞬时空、后续页失败或计数变化不能推进成功。
                    confirmation, confirmed_ids, confirmed_counts = await fetch_root_page(client, id, locator, number)
                    if not await to_thread.run_sync(store.save_roots, id, generation, confirmation, observed_count):
                        return
                    if confirmed_ids or confirmed_counts != baseline:
                        raise ValueError("Unstable empty comment tail")
                break
            seen.update(ids)
            number += 1
    except Exception:
        await to_thread.run_sync(store.finish_roots, id, generation, "failed", None)
        return
    if await to_thread.run_sync(store.finish_roots, id, generation, "success", observed_count,
                                now() if now is not None else None):
        return roots, observed_count
