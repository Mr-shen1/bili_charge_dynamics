"""楼中楼分页与末页增量；目标作者只由同根已归档 parent 解析。

根页 rcount 不变且校准未到期时跳过；有已归档回复的楼从来源末页倒序增量，
首次、显式初始化与 locator 变化才正序全量。每页回复与对应进度（方向、阶段、
页锚点、下一页）同一短事务提交，整楼成功记录与最后一页同一事务：中断、失败、
风控或重开后先复核页锚点再按原方向续采，不把“页码 + 1”当作可验证断点，也不因
一次失败把整楼从头重扫。热帖新增只登记后续工作，一次尝试内允许一次末页重定位。
"""

from asyncio import sleep as sleep_after_root
import random
import time
from datetime import datetime
from typing import NamedTuple

from anyio import to_thread

from . import scan_progress
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
    age = _age_seconds(synced_at, now_iso)
    if age is None:
        return True
    return age >= FULL_SCAN_SECONDS


def _age_seconds(synced_at, now_iso):
    try:
        return (datetime.fromisoformat(now_iso) - datetime.fromisoformat(synced_at)).total_seconds()
    except (TypeError, ValueError):
        return None


def calibration_due(progress, now_iso):
    """24 小时校准是否到期。

    只用于区分“本轮刚观察到的零”与“沿用旧零”：后者可能是 06 根页早停留下的旧 rcount，
    不能因为旧零就永远不请求。不新增任何检测信号，只用既有校准周期。
    """
    if progress is None or progress["status"] != "success":
        return False
    if not progress.get("synced_at") or now_iso is None:
        return False
    age = _age_seconds(progress["synced_at"], now_iso)
    return age is None or age >= FULL_SCAN_SECONDS


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
    # 一页条目不能多于该页声明的楼层总数：来源自相矛盾时按页拒绝，不据此事后拼出缺失。
    if len(items) > count:
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
    """同一轮内计数再次漂移：本轮不再提交检查点，已提交页与进度保留。"""

    def __init__(self, page=None):
        super().__init__("Reply count changed during scan")
        self.page = page


class ReplyStep(NamedTuple):
    """一次可独立恢复的楼中楼步骤：提交一页回复与对应进度，或收束／跳过整楼。

    08 可以把「一页」当作调度片：任一时刻中断后，下一次从 `store.read_reply_scan`
    取回同一步位置即可继续，分页游标不驻留在进程内。
    """

    status: str            # 'page' | 'complete' | 'skipped' | 'failed' | 'stale'
    root_id: str
    direction: str         # 'forward' 正序全量 | 'reverse' 末页倒序增量
    page: int | None
    next_page: int | None
    fetched: int
    new: int
    confirmed: int
    reason: str | None
    reply_ids: tuple = ()  # 本步已校验的回复 ID（字符串）；日志用 source_ids() 渲染
    expanded: bool = False  # 本步是否真的请求过上游；楼级等待只在展开后缴纳
    source_count: int | None = None


# “调用方没给观察值”与“本轮来源未给出 rcount（未知）”是两件事：前者回落到存储里的
# 根页 rcount，后者必须保持未知，不能被陈旧旧零冒充。
UNOBSERVED = object()


def _stale(root_id, direction=scan_progress.FORWARD, page=None):
    return ReplyStep("stale", root_id, direction, page, None, 0, 0, 0, "stale_generation")


def _last_page(count):
    return scan_progress.last_page(count)


async def _verify_reply_anchor(store, client, id, generation, root_id, position, *, uid, local_ids):
    """恢复时校验页锚点：锚点页在当前编号里仍找得到才按原方向继续。

    与根页同一有界窗口（锚点页及前后至多两页）：

    - 对齐：分页没动，按方向继续下一页。
    - 后移（头部插入）：正序只重读被插入影响的头部页，再回到锚点之后，不整轮重扫。
    - 前移（删除）：按锚点页当前编号继续，历史回复不删。
    - 窗口内都找不到锚点：回到本方向起点按 ID 合并重扫，已提交页保留。

    倒序不在此处追末页：新末页由下一步的计数对比重新定位，避免同一尝试里重复读。
    """
    anchor_page, anchor_ids = position.anchor_page, list(position.anchor_ids)
    found, count = None, position.counts[0] if position.counts else None
    for offset in scan_progress.RESUME_PAGE_OFFSETS:
        candidate = anchor_page + offset
        if candidate < 1:
            continue
        documents, ids, current = await fetch_reply_page(
            client, id, root_id, position.locator, candidate, uid=uid, direction=position.direction)
        count = current
        hit = scan_progress.alignment(ids, anchor_ids)
        if hit is not None:
            found = (candidate, hit[0], documents, ids)
            break

    async def save(documents, updated):
        saved = await to_thread.run_sync(lambda: store.save_reply_page(
            id, generation, root_id, documents, None, updated))
        if saved is not None:
            local_ids.update(document["id"] for document in documents)
        return saved

    if found is None:
        if position.direction == scan_progress.REVERSE:
            updated = position._replace(
                phase=scan_progress.PAGES, anchor_page=0, anchor_ids=(), overlap_page=0,
                next_page=_last_page(count or 0), counts=None if count is None else (count, 0))
        else:
            updated = position._replace(
                phase=scan_progress.PAGES, anchor_page=0, anchor_ids=(), overlap_page=0,
                next_page=1, counts=None)
        if not await to_thread.run_sync(lambda: store.save_reply_position(id, generation, root_id, updated)):
            return None
        collector_event("reply_scan_resumed", resume="anchor_lost", anchor_page=anchor_page,
                        direction=position.direction, page=updated.next_page,
                        **source_refs(uid=uid, dynamic_id=id, root_id=root_id))
        return updated

    page, index, documents, ids = found
    shifted = scan_progress.shift(page, index, anchor_page, len(anchor_ids), position.page_size)
    # 页内计数基准以本次锚点页为准：旧基准可能来自失败页，沿用会让重试永远判“计数减少”。
    baseline = None if count is None else (count, 0)
    if position.direction == scan_progress.REVERSE:
        last = _last_page(count or 0)
        if last > page:
            # 中断期间热帖新增了末页：先重定位到新末页，再沿页递减，不静默漏掉新回复。
            next_page = last
        else:
            next_page = 1 if page == 1 else page - 1
        updated = position._replace(phase=scan_progress.PAGES, overlap_page=0, anchor_page=page,
                                    anchor_ids=tuple(ids), counts=baseline, next_page=next_page)
        if await save(documents, updated) is None:
            return None
    else:
        updated = position._replace(phase=scan_progress.PAGES, overlap_page=0, counts=baseline,
                                    next_page=scan_progress.following_page(page, index, len(ids)))
        if await save(documents, updated) is None:
            return None
        if shifted > 0:
            # 受影响区段只在锚点之前新插入的页：只重读这几页，不整楼重扫。
            affected = (shifted + position.page_size - 1) // position.page_size
            for number in range(1, affected + 1):
                head, _, _ = await fetch_reply_page(client, id, root_id, position.locator, number,
                                                    uid=uid, direction=position.direction)
                if await save(head, updated) is None:
                    return None
    collector_event("reply_scan_resumed",
                    resume="aligned" if shifted == 0 else ("inserted" if shifted > 0 else "removed"),
                    anchor_page=anchor_page, page=updated.next_page, shift=shifted,
                    direction=position.direction,
                    **source_refs(uid=uid, dynamic_id=id, root_id=root_id))
    return updated


async def reply_scan_step(store, client, id, generation, root_id, *, uid=None, resume=False,
                          full=False, observed=UNOBSERVED, now=None, on_failure=None, seen=None):
    """推进一个楼中楼步骤；`resume=True` 表示一次新尝试的第一步（开启锚点重叠校验）。

    一次调用最多提交一页回复，可能先做一次锚点复核与被插入影响的头部页重读。状态全部
    落在存储里，调用方不需要把分页循环放在内存里跨节拍存活。`status='stale'` 表示领取
    代次已过期，调用方必须停止该链、不要再请求上游。
    """
    archive = await to_thread.run_sync(store.read_archive, id)
    if archive is None:
        raise ValueError("Unknown reply resource")
    if uid is None:
        uid = archive["author"]["id"]
    refs = source_refs(uid=uid, dynamic_id=id, root_id=root_id)
    roots = await to_thread.run_sync(store.roots_for_replies, id, {root_id})
    if not roots:
        collector_event("reply_scan_skipped", reason="root_missing", **refs)
        return ReplyStep("skipped", root_id, scan_progress.FORWARD, None, None, 0, 0, 0, "root_missing")
    root = roots[0]
    locator = root["comment_locator"]
    observed_given = observed is not UNOBSERVED
    if not observed_given:
        observed = root["source_reply_count"]
    if seen is None:
        seen = await to_thread.run_sync(lambda: store.reply_ids(id, root_id))
    local_ids = seen.setdefault(root_id, set())
    progress, reason, checked_at = None, None, None
    if resume:
        progress = (await to_thread.run_sync(store.reply_progress, id)).get(root_id)
        if progress is not None and progress["status"] == "success":
            # 只有存在历史成功记录时才取时钟判断校准周期；首轮不额外取时钟。
            checked_at = now() if now is not None else utc_now()
        if not full and not scan_due(progress, observed, checked_at):
            # 楼层回复数与上次成功快照相同且校准未到期：不重发请求，也不刷新校准计时。
            if not await to_thread.run_sync(lambda: store.change_reply_root(
                    id, generation, root_id, "success", progress["source_count"],
                    observed=observed, succeeded_at=progress["synced_at"])):
                return _stale(root_id)
            return ReplyStep("skipped", root_id, scan_progress.FORWARD, None, None, 0, 0, 0, "unchanged")
        # 有已得回复即走末页倒序增量；首次、显式全量、无本地内容或定位资源已变
        # （旧断点属于另一资源）才正序全量重建。
        stored = await to_thread.run_sync(lambda: store.read_reply_scan(id, root_id))
        locator_changed = (stored is not None
                           and stored.locator != scan_progress.locator_key(locator))
        direction = (scan_progress.FORWARD if (full or locator_changed or not local_ids)
                     else scan_progress.REVERSE)
        started = await to_thread.run_sync(lambda: store.resume_reply_scan(
            id, generation, root_id, locator, observed, direction=direction, full=full))
        if started is None:
            return _stale(root_id, direction)
        position, reason = started["position"], started["reason"]
        collector_event("reply_scan_position", resume=reason, direction=position.direction,
                        phase=position.phase, page=position.next_page,
                        confirmed=position.confirmed, **refs)
        if position.phase == scan_progress.COMPLETE:
            return ReplyStep("complete", root_id, position.direction, None, None, 0, 0,
                             position.confirmed, "complete")
        if observed == 0 and not calibration_due(progress, checked_at):
            # 本轮明确零且校准未到期：不发请求，直接确认整楼。沿用旧零不能冒充新观察，
            # 其补采由既有 24 小时校准触发，不新增检测信号。
            updated = position._replace(phase=scan_progress.COMPLETE, overlap_page=0,
                                        anchor_page=0, anchor_ids=(), next_page=1, counts=(0, 0))
            saved = await to_thread.run_sync(lambda: store.save_reply_page(
                id, generation, root_id, [], None, updated, complete=True, observed=0,
                succeeded_at=now() if now is not None else None))
            if saved is None:
                return _stale(root_id, position.direction)
            collector_event("reply_root_finished", direction=position.direction, source="zero",
                            checkpoint="accepted", confirmed=saved["confirmed"], **refs)
            return ReplyStep("complete", root_id, position.direction, None, None, 0, 0,
                             saved["confirmed"], "empty_source")
        if position.overlap_page:
            verified = await _verify_reply_anchor(store, client, id, generation, root_id, position,
                                                 uid=uid, local_ids=local_ids)
            if verified is None:
                return _stale(root_id, position.direction)
            position = verified
    else:
        position = await to_thread.run_sync(lambda: store.read_reply_scan(id, root_id, generation))
        if position is None:
            return _stale(root_id)
        if not observed_given and position.source_count is not None:
            # 后续步骤沿用本次尝试开始时观察到的 rcount：页数据会刷新根文档的 rcount，
            # 不能让后续页用刚写回的值改写整楼的观察基准。
            observed = position.source_count
        if position.phase == scan_progress.COMPLETE:
            return ReplyStep("complete", root_id, position.direction, None, None, 0, 0,
                             position.confirmed, "complete")

    direction, number = position.direction, position.next_page
    expanded = False
    stage, page = "page_fetch", number
    started = time.monotonic()

    async def save(documents, count, updated, *, complete=False):
        return await to_thread.run_sync(lambda: store.save_reply_page(
            id, generation, root_id, documents, count, updated, complete=complete,
            observed=observed, succeeded_at=now() if now is not None else None))

    def log_page_saved(saved, number, ids, phase, *, resume=None):
        timing = getattr(client, "last_reply_page", None)
        collector_event("reply_page_saved", page=number, direction=direction,
                        fetched=saved["fetched"], new=saved["new"],
                        updated=saved["fetched"] - saved["new"], reply_ids=source_ids(ids),
                        phase=phase, checkpoint="accepted",
                        elapsed_ms=max(0, int((time.monotonic() - started) * 1000)),
                        wait_ms=timing.wait_ms if timing is not None else None,
                        **({"resume": resume} if resume is not None else {}), **refs)

    def finished(saved, stop):
        collector_event("reply_root_finished" if direction == scan_progress.FORWARD
                        else "reply_incremental_finished",
                        direction=direction, new=saved["new"], stopped_by=stop,
                        local_source_delta=len(local_ids) - (position.counts[0] if position.counts else 0),
                        checkpoint="accepted", confirmed=saved["confirmed"], **refs)
        return ReplyStep("complete", root_id, direction, number, None, saved["fetched"], saved["new"],
                         saved["confirmed"], stop, tuple(position.anchor_ids), True,
                         position.counts[0] if position.counts else None)

    try:
        if position.phase == scan_progress.TAIL:
            # 空尾复查：复读同一页；再不稳定就退回锚点重新定位，不用同一旧基准原地循环。
            stage = "tail_fetch"
            documents, ids, count = await fetch_reply_page(
                client, id, root_id, locator, number, uid=uid, direction=direction)
            expanded = True
            baseline = position.counts[0] if position.counts else None
            unstable = bool(ids) or (baseline is not None and count != baseline)
            if unstable:
                if direction == scan_progress.REVERSE:
                    updated = position._replace(
                        phase=scan_progress.PAGES, anchor_page=0, anchor_ids=(), overlap_page=0,
                        next_page=_last_page(count), counts=(count, 0))
                else:
                    updated = position._replace(
                        phase=scan_progress.PAGES, counts=None, next_page=position.anchor_page or 1,
                        overlap_page=position.anchor_page)
            else:
                updated = position._replace(phase=scan_progress.COMPLETE, overlap_page=0)
            stage = "tail_save"
            saved = await save(documents, count, updated, complete=not unstable)
            if saved is None:
                return _stale(root_id, direction, number)
            log_page_saved(saved, number, ids, updated.phase, resume="tail_confirmation")
            if unstable:
                raise ValueError("Unstable empty reply tail")
            collector_event("reply_tail_confirmed", page=number, direction=direction,
                            checkpoint="accepted", confirmed=saved["confirmed"], **refs)
            return ReplyStep("complete", root_id, direction, number, None, saved["fetched"],
                             saved["new"], saved["confirmed"], "empty_tail", tuple(ids), True, count)

        stage = "page_fetch"
        documents, ids, count = await fetch_reply_page(
            client, id, root_id, locator, number, uid=uid, direction=direction)
        expanded = True
        stage = "pagination"
        baseline, relocations = position.counts if position.counts else (None, 0)
        if position.anchor_page == 0 and relocations == 0:
            # 本次走位还没有提交页（首步）：页内计数基准从本页重新取，沿用旧基准会把它
            # 当成“计数减少”而无法收敛。已重定位过时保留基准，才能限制同一尝试的重定位次数。
            baseline = None
        last = _last_page(count)
        if (direction == scan_progress.REVERSE and position.anchor_page == 0 and relocations == 0
                and last != number):
            # 起点校准：沿用的根 rcount 或热帖新增让末页变了，先跳到真实末页；本页照常保存。
            # 只在本尝试尚未重定位时允许，否则热帖持续新增会让同一次尝试无限跳末页。
            updated = position._replace(next_page=last, anchor_page=number, anchor_ids=tuple(ids),
                                        counts=(count, relocations), overlap_page=0)
            stage = "page_save"
            saved = await save(documents, count, updated)
            if saved is None:
                return _stale(root_id, direction, number)
            local_ids.update(ids)
            log_page_saved(saved, number, ids, updated.phase, resume="retargeted")
            collector_event("reply_scan_resumed", resume="retargeted", page=last,
                            direction=direction, baseline=baseline, current=count, **refs)
            return ReplyStep("page", root_id, direction, number, last, saved["fetched"],
                             saved["new"], saved["confirmed"], "retargeted", tuple(ids), True, count)
        if baseline is not None and count < baseline:
            raise ValueError("Reply count decreased during scan")
        if baseline is not None and count != baseline:
            # 热帖持续新增只登记后续工作：保留已确认页与进度，不撤销本轮已得内容。
            collector_event("reply_scan_count_grew", page=number, baseline=baseline,
                            current=count, direction=direction, **refs)
            if direction == scan_progress.REVERSE:
                if relocations >= 1:
                    raise ReplyDrift(number)
                updated = position._replace(phase=scan_progress.PAGES, anchor_page=0, anchor_ids=(),
                                            overlap_page=0, next_page=last,
                                            counts=(count, relocations + 1))
                if not await to_thread.run_sync(
                        lambda: store.save_reply_position(id, generation, root_id, updated)):
                    return _stale(root_id, direction, number)
                collector_event("reply_scan_resumed", resume="retargeted", page=last,
                                direction=direction, baseline=baseline, current=count, **refs)
                return ReplyStep("page", root_id, direction, None, last, 0, 0, updated.confirmed,
                                 "retargeted", (), True, count)
        if direction == scan_progress.REVERSE:
            if number == 1:
                phase, stop = scan_progress.COMPLETE, "first_page"
            elif not ids:
                phase, stop = scan_progress.TAIL, "empty_tail"
            elif not set(ids) <= local_ids:
                phase, stop = scan_progress.PAGES, None
            elif position.phase == scan_progress.GUARD:
                # 整页已知后再向前重叠一页也已知：偏移没有把新回复甩到后面，收束本轮。
                phase, stop = scan_progress.COMPLETE, "known_page"
            else:
                # 命中已知页还不能停：再重叠一页，防止分页偏移漏掉新回复。
                phase, stop = scan_progress.GUARD, None
            next_page = 1 if phase == scan_progress.COMPLETE else (
                number if phase == scan_progress.TAIL else number - 1)
        else:
            if not ids:
                phase, stop = ((scan_progress.COMPLETE, "first_page") if number == 1
                               else (scan_progress.TAIL, "empty_tail"))
            elif set(ids) <= set(position.anchor_ids):
                raise ValueError("Reply pagination did not advance")
            else:
                phase, stop = scan_progress.PAGES, None
            next_page = 1 if phase == scan_progress.COMPLETE else (
                number if phase == scan_progress.TAIL else number + 1)
        updated = position._replace(phase=phase, next_page=next_page, anchor_page=number,
                                    anchor_ids=tuple(ids), counts=(count, relocations),
                                    overlap_page=0)
        stage = "page_save"
        complete = phase == scan_progress.COMPLETE
        saved = await save(documents, count, updated, complete=complete)
        if saved is None:
            collector_event("reply_page_rejected", page=number, reason="stale_generation", **refs)
            return _stale(root_id, direction, number)
        local_ids.update(ids)
        log_page_saved(saved, number, ids, phase)
        position = updated
        if complete:
            return finished(saved, stop)
        return ReplyStep("page", root_id, direction, number, next_page, saved["fetched"],
                         saved["new"], saved["confirmed"], stop, tuple(ids), True, count)
    except SourceRiskPaused:
        # 保护暂停不是楼级失败：不写失败、不清检查点或进度，留给恢复后续采。
        raise
    except Exception as error:
        # 单根失败不阻止其他根的可读回复，也不暴露来源异常文本；已提交页与进度保留。
        if isinstance(error, ReplyDrift):
            collector_event("reply_incremental_finished", warning=True, new=0,
                            stopped_by="drift", page=error.page, direction=direction, **refs)
        timing = getattr(client, "last_reply_page", None)
        collector_failure("reply_sync_failed", error, stage=stage, page=page,
                          elapsed_ms=timing.elapsed_ms if timing is not None else None,
                          wait_ms=timing.wait_ms if timing is not None else None, **refs)
        if on_failure is not None:
            on_failure(error)
        if not await to_thread.run_sync(store.change_reply_root, id, generation, root_id, "failed"):
            return _stale(root_id, direction, page)
        return ReplyStep("failed", root_id, direction, page, None, 0, 0, position.confirmed,
                         stage, (), expanded)


async def sync_replies(store, client, id, generation, roots_result, *, now=None, uid=None, full=False,
                       on_failure=None):
    """楼中楼整轮：逐楼逐页推进，失败、重开或风控后从可验证断点继续。"""
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
    seen_by_root = await to_thread.run_sync(store.reply_ids, id)
    failed = 0
    skipped = 0
    sync_refs = source_refs(uid=uid, dynamic_id=id)
    collector_event("replies_sync_started", roots=len(roots), **sync_refs)
    try:
        for root_index, root in enumerate(roots, 1):
            step = await reply_scan_step(
                store, client, id, generation, root["id"], uid=uid, resume=True, full=full,
                observed=observed_replies[root["id"]], now=now, on_failure=on_failure,
                seen=seen_by_root)
            expanded = step.expanded
            while step.status == "page":
                step = await reply_scan_step(
                    store, client, id, generation, root["id"], uid=uid, now=now,
                    on_failure=on_failure, seen=seen_by_root)
                expanded = expanded or step.expanded
            if step.status == "stale":
                # 领取代次已过期：旧执行不再请求上游，也不改写新进度。
                return
            if step.status == "failed":
                failed += 1
            elif step.status == "skipped":
                skipped += 1
            if expanded:
                # 楼级节奏在网络与 SQLite 事务外；只在实际展开楼中楼后等待，失败也等待。
                await sleep_after_root(random.uniform(0.3, 0.4))
    except SourceRiskPaused:
        raise
    # 降级轮只保证「已存根的可读回复」不落后，未确认根集合，故不宣称全集一致：
    # 沿用 unconfirmed 语义，synced_reply_comment_count 与成功时间不推进。
    await to_thread.run_sync(store.finish_replies, id, generation,
                             "unconfirmed" if degraded else ("failed" if failed else "success"),
                             None if degraded else observed_count,
                             now() if now is not None and not failed and not degraded else None)
    collector_event("replies_sync_finished", warning=bool(failed),
                    succeeded=not failed and not degraded, degraded=degraded, roots=len(roots),
                    skipped=skipped, **sync_refs)
