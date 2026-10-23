"""显式的一次当前入选集合初始化；读取归档不调用本模块，无定时器。"""

from anyio import to_thread

from .source import fetch_detail, fetch_page, page_body, page_metadata
from .root_comments import sync_roots
from .replies import sync_replies
from .media import sync_media
from .comment_status import ROOT_METADATA_VERSION
from .collector_logging import collector_event, collector_failure
from .comment_client import open_comment_client


async def initialize(store, client, uid, downloader=None, uploader=None, *, comment_client_factory=None):
    targets = await to_thread.run_sync(lambda: store.selected_targets(uid, with_selection=True))
    checks = {item["id"]: item["observed"] for item in await to_thread.run_sync(store.read_checks, uid)}
    result = {"processed": 0, "succeeded": 0, "failed": 0}
    for target in targets:
        id = target["id"]
        generation = await to_thread.run_sync(lambda: store.claim_archive(uid, id, selection=target["selection"]))
        if generation is None:
            continue
        result["processed"] += 1
        observed = checks.get(id, {})
        # 已接入独立计数的目标，显式初始化也不得以旧 STAT/detail 覆盖可信观察。
        # 尚无检查记录的旧初始化协议保持兼容；它不是固定检查或计数观察入口。
        comments = observed if "comment_count_status" in observed else None
        succeeded = await sync_target(store, client, uid, id, generation, downloader, uploader,
                                      comment_observation=comments, comment_client_factory=comment_client_factory,
                                      full_replies=True)
        result["succeeded" if succeeded else "failed"] += 1
    return result


def comment_metadata(observation):
    return {key: observation[key] for key in ("source_comment_count", "comment_locator")
            if key in observation}


async def sync_body(store, client, uid, id, generation, comment_observation, now=None):
    """正文仅提交实际读取版本；评论计数不得被正文 metadata 覆盖。"""
    page_meta, body = {"edit_status": "error"}, None
    try:
        page = await fetch_page(client, id)
        page_meta = page_metadata(page, uid)
        body = page_body(page)
    except Exception as error:
        # 可解析 metadata 不因正文/编辑字段失败丢失。
        collector_failure("body_source_failed", error, stage="page")
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
    except Exception as error:
        # 通用接口失败不阻断独立已解析的 HTML 正文。
        collector_failure("body_source_failed", error, stage="detail")
    if body is not None:
        body = dict(body)
        if not body["media_sources"]:
            body["media_sources"] = detail_meta.get("media_sources", [])
    succeeded = await to_thread.run_sync(
        store.finish_archive, id, generation, status, body, page_meta.get("observed_version"), now() if now else None
    )
    collector_event("body_sync_finished", outcome=status, accepted=succeeded)
    return succeeded


async def sync_target(store, client, uid, id, generation, downloader=None, uploader=None, *,
                      pending_comments_only=False, comment_observation=None, now=None, comment_client_factory=None,
                      full_replies=False):
    """复用同一归档链；已完成正文不因独立评论工作重新访问来源。"""
    archive = await to_thread.run_sync(store.read_archive, id)
    previous_locator = archive.get("comment_locator") or {}
    version = comment_observation.get("observed_version") if comment_observation is not None else None
    body_complete = (comment_observation is not None and archive["work"]["text"] == "success"
                     and archive["synced_version"] == version)
    body_restricted = (comment_observation is not None and archive["work"]["text"] == "restricted"
                       and archive.get("restricted_version") == version
                       and comment_observation.get("content_visible") is not True)
    # 受限登记不冒充正文成功；版本变化或正文恢复可见时重新读取。
    # 媒体组落后于正文时也须重新确认来源，不能只凭历史图片成功推进版本。
    body_complete = body_complete and archive.get("media_version") == version
    if body_complete or body_restricted:
        metadata = comment_metadata(comment_observation)
        succeeded = await to_thread.run_sync(store.observe_archive, id, generation, metadata)
    else:
        succeeded = await sync_body(store, client, uid, id, generation, comment_observation, now)
    archive = await to_thread.run_sync(store.read_archive, id)
    current_locator = archive.get("comment_locator") or {}
    locator_changed = any(previous_locator.get(key) != current_locator.get(key) for key in ("oid", "type"))
    if (not pending_comments_only or locator_changed
            or archive.get("synced_root_metadata_version", 0) < ROOT_METADATA_VERSION
            or any(archive["work"][part] != "success" for part in ("comments", "replies"))):
        async with open_comment_client(client, uid, comment_client_factory) as comments_client:
            roots_result = await sync_roots(store, comments_client, id, generation, now=now, uid=uid)
            # 增量基准完全由 replies.scan_due 决定（新楼、rcount 变化、上次失败、校准到期）；
            # 不让重试触发 full=True，否则热帖会陷入「全量重扫 → 期间计数变化 → 再全量重扫」。
            await sync_replies(store, comments_client, id, generation, roots_result, now=now, uid=uid,
                               full=full_replies)
    await sync_media(store, downloader, uploader, id, current_only=True, now=now)
    for root_id in await to_thread.run_sync(store.media_root_ids, id):
        await sync_media(store, downloader, uploader, id, current_only=True, root_id=root_id, now=now)
    return succeeded
