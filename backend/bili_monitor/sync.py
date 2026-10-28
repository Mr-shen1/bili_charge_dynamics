"""显式的一次当前入选集合初始化与正文提交；读取归档不调用本模块，无定时器。

评论与媒体由 08 的 `TargetSession` 步骤机按可提交分片推进；本模块内的整轮入口
（`sync_target`／`sync_roots`）已因无调用者删除，`sync.py` 只留 `initialize`、
`comment_metadata` 与 `sync_body`。`replies.sync_replies` 仍作为历史专项回归适配器
保留，只由 `test_reply_incremental`／`test_reply_page_pacing`／`test_reply_page_resume`
三个测试文件调用，生产统一经 `TargetSession`／单页步骤推进，不由它分派。
"""

from anyio import to_thread

from .source import fetch_detail, fetch_page, page_body, page_metadata
from .collector_logging import collector_event, collector_failure, source_refs
from .risk import SourceRiskPaused


async def initialize(store, client, uid, downloader=None, uploader=None, *, comment_client_factory=None,
                     scheduler=None):
    # 局部导入避免 `dispatch` → `sync`（步骤机复用 sync_body）的模块循环。
    from .dispatch import TargetSession

    targets = await to_thread.run_sync(lambda: store.selected_targets(uid, with_selection=True))
    checks = {item["id"]: item["observed"] for item in await to_thread.run_sync(store.read_checks, uid)}
    result = {"processed": 0, "succeeded": 0, "failed": 0}
    for target in targets:
        id = target["id"]
        lease = await scheduler.acquire_api_target(uid, id) if scheduler is not None else None
        if scheduler is not None and lease is None:
            # collector 正在执行同一目标：不重复执行，也不把跳过报成同步成功。
            continue
        try:
            generation = await to_thread.run_sync(lambda: store.claim_archive(
                uid, id, selection=target["selection"]))
            if generation is None:
                continue
            result["processed"] += 1
            observed = checks.get(id, {})
            # 已接入独立计数的目标，显式初始化也不得以旧 STAT/detail 覆盖可信观察。
            # 尚无检查记录的旧初始化协议保持兼容；它不是固定检查或计数观察入口。
            comments = observed if "comment_count_status" in observed else None
            session = TargetSession(
                store, client, uid, id, generation, comments,
                downloader=downloader, uploader=uploader,
                comment_client_factory=comment_client_factory,
                pending_comments_only=False, full_replies=True)
            while not session.done:
                if scheduler is not None:
                    if not await lease.renew():
                        result["failed"] += 1
                        break
                    async with scheduler.heavy_slot(f"{uid}:{id}", session.stage):
                        await session.advance()
                else:
                    await session.advance()
            # 显式初始化的既有统计口径只表示本次正文（含受限判定）是否成功；
            # 评论／媒体分项仍各自持久，不能因为分项未完成改报正文失败。
            succeeded = session.text_succeeded
            result["succeeded" if succeeded else "failed"] += 1
        finally:
            if lease is not None:
                await lease.release()
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
    except SourceRiskPaused:
        # 已取得的内容仍按原规则提交，但风控不能写成正文读取失败。
        raise
    except Exception as error:
        # 可解析 metadata 不因正文/编辑字段失败丢失。
        collector_failure("body_source_failed", error, stage="page",
                          **source_refs(uid=uid, dynamic_id=id))
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
    except SourceRiskPaused:
        raise
    except Exception as error:
        # 通用接口失败不阻断独立已解析的 HTML 正文。
        collector_failure("body_source_failed", error, stage="detail",
                          **source_refs(uid=uid, dynamic_id=id))
    if body is not None:
        body = dict(body)
        if not body["media_sources"]:
            body["media_sources"] = detail_meta.get("media_sources", [])
    succeeded = await to_thread.run_sync(
        store.finish_archive, id, generation, status, body, page_meta.get("observed_version"), now() if now else None
    )
    collector_event("body_sync_finished", outcome=status, accepted=succeeded,
                    **source_refs(uid=uid, dynamic_id=id))
    return succeeded


