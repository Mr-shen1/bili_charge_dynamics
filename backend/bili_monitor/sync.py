"""显式的一次指定集合初始化；读取归档不调用本模块，无定时器。"""

from anyio import to_thread

from .source import fetch_detail, fetch_page, page_body, page_metadata
from .root_comments import sync_roots
from .replies import sync_replies


async def initialize(store, client, uid):
    targets = await to_thread.run_sync(store.selected_targets, uid)
    result = {"processed": 0, "succeeded": 0, "failed": 0}
    for target in targets:
        id = target["id"]
        generation = await to_thread.run_sync(store.claim_archive, uid, id)
        if generation is None:
            continue
        result["processed"] += 1
        page_meta, body = {"edit_status": "error"}, None
        try:
            page = await fetch_page(client, id)
            page_meta = page_metadata(page, uid)
            body = page_body(page)
        except Exception:
            # 可解析 metadata 不因正文/编辑字段失败丢失。
            pass
        if not await to_thread.run_sync(store.observe_archive, id, generation, page_meta):
            result["failed"] += 1
            continue
        status = "success" if body is not None else "failed"
        detail_meta = {}
        try:
            detail_meta, detail_status = await fetch_detail(client, id, uid)
            await to_thread.run_sync(store.observe_archive, id, generation, {**page_meta, **detail_meta})
            if body is None and detail_status == "restricted":
                status = "restricted"
        except Exception:
            # 通用接口失败不阻断独立已解析的 HTML 正文。
            pass
        if body is not None:
            body = dict(body)
            if not body["media_sources"]:
                body["media_sources"] = detail_meta.get("media_sources", [])
        succeeded = await to_thread.run_sync(
            store.finish_archive, id, generation, status, body, page_meta.get("observed_version")
        )
        result["succeeded" if succeeded else "failed"] += 1
        roots_result = await sync_roots(store, client, id, generation)
        await sync_replies(store, client, id, generation, roots_result)
    return result
