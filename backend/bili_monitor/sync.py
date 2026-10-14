"""显式的一次当前入选集合初始化；读取归档不调用本模块，无定时器。"""

from anyio import to_thread

from .source import fetch_detail, fetch_page, page_body, page_metadata
from .root_comments import sync_roots
from .replies import sync_replies
from .media import sync_media


async def initialize(store, client, uid, downloader=None, uploader=None):
    targets = await to_thread.run_sync(store.selected_targets, uid)
    checks = {item["id"]: item["observed"] for item in await to_thread.run_sync(store.read_checks, uid)}
    result = {"processed": 0, "succeeded": 0, "failed": 0}
    for target in targets:
        id = target["id"]
        generation = await to_thread.run_sync(store.claim_archive, uid, id)
        if generation is None:
            continue
        result["processed"] += 1
        observed = checks.get(id, {})
        # 已接入独立计数的目标，显式初始化也不得以旧 STAT/detail 覆盖可信观察。
        # 尚无检查记录的旧初始化协议保持兼容；它不是固定检查或计数观察入口。
        comments = observed if "comment_count_status" in observed else None
        succeeded = await sync_target(store, client, uid, id, generation, downloader, uploader,
                                      comment_observation=comments)
        result["succeeded" if succeeded else "failed"] += 1
    return result


def comment_metadata(observation):
    return {key: observation[key] for key in ("source_comment_count", "comment_locator")
            if key in observation}


async def sync_body(store, client, uid, id, generation, comment_observation):
    """正文仅提交实际读取版本；评论计数不得被正文 metadata 覆盖。"""
    page_meta, body = {"edit_status": "error"}, None
    try:
        page = await fetch_page(client, id)
        page_meta = page_metadata(page, uid)
        body = page_body(page)
    except Exception:
        # 可解析 metadata 不因正文/编辑字段失败丢失。
        pass
    if comment_observation is not None:
        page_meta.pop("source_comment_count", None)
        page_meta.update(comment_metadata(comment_observation))
    if not await to_thread.run_sync(store.observe_archive, id, generation, page_meta):
        return False
    status = "success" if body is not None else "failed"
    detail_meta = {}
    try:
        detail_meta, detail_status = await fetch_detail(client, id, uid)
        if comment_observation is not None:
            detail_meta.pop("source_comment_count", None)
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
    return succeeded


async def sync_target(store, client, uid, id, generation, downloader=None, uploader=None, *,
                      pending_comments_only=False, comment_observation=None, now=None):
    """复用同一归档链；已完成正文不因独立评论工作重新访问来源。"""
    archive = await to_thread.run_sync(store.read_archive, id)
    version = comment_observation.get("observed_version") if comment_observation is not None else None
    body_complete = (comment_observation is not None and archive["work"]["text"] == "success"
                     and archive["synced_version"] == version)
    if body_complete:
        metadata = comment_metadata(comment_observation)
        succeeded = await to_thread.run_sync(store.observe_archive, id, generation, metadata)
    else:
        succeeded = await sync_body(store, client, uid, id, generation, comment_observation)
    archive = await to_thread.run_sync(store.read_archive, id)
    if not pending_comments_only or any(archive["work"][part] != "success" for part in ("comments", "replies")):
        roots_result = await sync_roots(store, client, id, generation, now=now)
        await sync_replies(store, client, id, generation, roots_result, now=now)
    await sync_media(store, downloader, uploader, id, current_only=True)
    for root_id in await to_thread.run_sync(store.media_root_ids, id):
        await sync_media(store, downloader, uploader, id, current_only=True, root_id=root_id)
    return succeeded
