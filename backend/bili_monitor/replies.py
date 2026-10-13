"""完整楼中楼来源分页；目标作者只由同根已归档 parent 解析。"""

from anyio import to_thread

from .root_comments import comment_fields, nonnegative, root_document, source_id


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


async def fetch_reply_page(client, dynamic_id, root_id, locator, number):
    response = await client.get("https://api.bilibili.com/x/v2/reply/reply", params={
        "oid": locator["oid"], "type": locator["type"], "root": root_id, "pn": number, "ps": 20,
    })
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


async def sync_replies(store, client, id, generation, roots_result):
    if roots_result is None:
        await to_thread.run_sync(store.finish_replies, id, generation, "unconfirmed", None)
        return
    observed_replies, observed_count = roots_result
    roots = await to_thread.run_sync(store.roots_for_replies, id, observed_replies)
    failed = False
    for root in roots:
        if not await to_thread.run_sync(store.change_reply_root, id, generation, root["id"], "pending"):
            return
        # 只有本轮明确零才可跳页；持久旧零不能冒充新的未知观察。
        if observed_replies[root["id"]] == 0:
            if not await to_thread.run_sync(store.change_reply_root, id, generation, root["id"], "success", 0):
                return
            continue
        try:
            number, baseline, seen = 1, None, set()
            while True:
                documents, page_ids, count = await fetch_reply_page(client, id, root["id"], root["comment_locator"], number)
                if baseline is not None and count != baseline:
                    raise ValueError("Reply count changed during scan")
                baseline = count
                if page_ids and not set(page_ids) - seen:
                    raise ValueError("Reply pagination did not advance")
                if not await to_thread.run_sync(store.save_replies, id, generation, root["id"], documents, count):
                    return
                if not page_ids:
                    if number > 1:
                        confirmation, confirmed_ids, confirmed_count = await fetch_reply_page(client, id, root["id"], root["comment_locator"], number)
                        if not await to_thread.run_sync(store.save_replies, id, generation, root["id"], confirmation, confirmed_count):
                            return
                        if confirmed_ids or confirmed_count != baseline:
                            raise ValueError("Unstable empty reply tail")
                    if len(seen) != count:
                        raise ValueError("Incomplete reply scan")
                    break
                seen.update(page_ids)
                number += 1
            if not await to_thread.run_sync(store.change_reply_root, id, generation, root["id"], "success", baseline):
                return
        except Exception:
            # 单根失败不阻止其他根的可读回复，也不暴露来源异常文本。
            failed = True
            if not await to_thread.run_sync(store.change_reply_root, id, generation, root["id"], "failed"):
                return
    await to_thread.run_sync(store.finish_replies, id, generation, "failed" if failed else "success", observed_count)
