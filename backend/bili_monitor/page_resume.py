"""恢复续采时的锚点重定位：根页与楼中楼共用同一有界窗口与位移规则。

只做「重新找到上次提交页 → 折算位移 → 重读被插入影响的头部页」这一段；不保存进度、
不写归档。调用方把找到的页交给自己原有的保存路径，因此两处续采规则不会再各自漂移，
也不会因为一边改了窗口或位移公式而让另一边静默跳过内容。
"""

from typing import NamedTuple

from . import scan_progress


class Located(NamedTuple):
    """一次成功的锚点重定位：锚点页、锚点末项下标、该页数据与折算后的位移。"""

    page: int
    index: int
    documents: object
    ids: object
    extra: object
    shifted: int


def resume_reason(shifted):
    """续采日志用的固定原因：对齐、头部插入或删除前移。"""
    return "aligned" if shifted == 0 else ("inserted" if shifted > 0 else "removed")


def affected_pages(shifted, page_size):
    """头部插入影响的页数：位移为正时，锚点之前新插入的内容覆盖前几页。"""
    return 0 if shifted <= 0 else (shifted + page_size - 1) // page_size


async def locate(fetch, anchor_page, anchor_ids, page_size):
    """在锚点页前后有界窗口内重新找到锚点。

    `fetch(page)` 发一次真实请求并返回 `(documents, ids, extra)`；`extra` 是调用方自己的
    页码校验值（根页是 `(count, total)`，楼中楼是 `count`）。只有尾部连续重叠才算找到。
    返回 `(Located | None, 最后一次取到的 extra)`：找不到锚点时调用方仍需要最新一次
    取到的校验值来重新定位方向（倒序增量要从新末页起步），不能沿用旧基准。
    """
    latest = None
    for offset in scan_progress.RESUME_PAGE_OFFSETS:
        page = anchor_page + offset
        if page < 1:
            continue
        documents, ids, extra = await fetch(page)
        latest = extra
        hit = scan_progress.alignment(ids, anchor_ids)
        if hit is not None:
            return (Located(page, hit[0], documents, ids, extra,
                            scan_progress.shift(page, hit[0], anchor_page,
                                                len(anchor_ids), page_size)),
                    latest)
    return None, latest


async def reread_heads(fetch, commit, shifted, page_size):
    """按顺序重读受头部插入影响的页；任一页保存失败立即停止，不跳页继续。

    `commit(documents)` 返回假值即视为保存失败（进度已被取代或写库失败），后面
    的页不再读取——已提交页保留，下一次尝试从可验证断点重新定位。
    """
    for number in range(1, affected_pages(shifted, page_size) + 1):
        documents, _, _ = await fetch(number)
        if not await commit(documents):
            return False
    return True
