"""近期目标来源读取；候选结果不是归档或窗口提交。"""

import httpx

from .identifiers import is_valid_id
from .source_endpoints import FEED_URL


class DiscoveryError(Exception):
    """只暴露固定错误码，不携带上游响应、URL 或异常文本。"""

    def __init__(self, code):
        if code not in {"SOURCE_UNAVAILABLE", "SIGNAL_INVALID", "PAGINATION_INVALID"}:
            code = "SIGNAL_INVALID"
        self.code = code
        super().__init__(code)


class DiscoveryStopped(Exception):
    """主动停用；不得作为成功耗尽或来源错误提交。"""

    def __init__(self):
        super().__init__("DISCOVERY_STOPPED")


def _candidate(item, uid):
    if not isinstance(item, dict) or not is_valid_id(item.get("id_str")):
        raise DiscoveryError("SIGNAL_INVALID") from None
    modules = item.get("modules")
    if not isinstance(modules, dict):
        raise DiscoveryError("SIGNAL_INVALID") from None
    author = modules.get("module_author")
    dynamic = modules.get("module_dynamic")
    if not isinstance(author, dict) or not isinstance(dynamic, dict):
        raise DiscoveryError("SIGNAL_INVALID") from None
    # 协议作者 mid 是数值；兼容已保存的字符串，不接受 bool/float 或未知归属。
    mid = author.get("mid")
    mid = str(mid) if type(mid) is int else mid
    if not is_valid_id(mid) or mid != uid:
        raise DiscoveryError("SIGNAL_INVALID") from None
    badge = author.get("icon_badge")
    major = dynamic.get("major")
    if badge is not None and (
            not isinstance(badge, dict) or not isinstance(badge.get("text"), str)):
        raise DiscoveryError("SIGNAL_INVALID") from None
    if major is not None and (
            not isinstance(major, dict) or not isinstance(major.get("type"), str)):
        raise DiscoveryError("SIGNAL_INVALID") from None
    # 原 is_charge 的两条 OR；不以正文、动态类型或 major 的其他类型筛选。
    qualified = ((badge is not None and badge["text"] == "充电专属")
                 or (major is not None and major["type"] == "MAJOR_TYPE_BLOCKED"))
    return item["id_str"], qualified


async def discover_recent(client, uid, n, *, should_continue=None, on_progress=None):
    """按 feed 次序凑 N 个唯一 ID；达到 N 不宣称扫描了全部历史。

    每页请求前 await should_continue；返回 false 抛 DiscoveryStopped。
    任务取消原样传播 CancelledError，保留调用者的中断恢复边界。
    有效页的累计候选副本经 on_progress 上报，成功提交由调用者另行完成。
    只在不足 N 且协议明确结束时 exhausted=true；失败不返回空集合。
    客户端由调用者管理；本函数不处理凭据，不增加签名或风控参数，不回填全部历史。
    """
    if not is_valid_id(uid) or type(n) is not int or n <= 0:
        raise DiscoveryError("SIGNAL_INVALID") from None
    return await _discover(client, uid, n, should_continue, on_progress)


async def _discover(client, uid, n, should_continue, on_progress):
    ids, seen, offset, cursors = [], set(), None, set()
    while True:
        if should_continue is not None and not await should_continue():
            raise DiscoveryStopped() from None
        params = {"host_mid": uid}
        if offset is not None:
            params["offset"] = offset
        try:
            response = await client.get(
                FEED_URL, params=params,
            )
            response.raise_for_status()
        except httpx.HTTPError:
            raise DiscoveryError("SOURCE_UNAVAILABLE") from None
        try:
            payload = response.json()
        except ValueError:
            raise DiscoveryError("SIGNAL_INVALID") from None
        if not isinstance(payload, dict) or type(payload.get("code")) is not int:
            raise DiscoveryError("SIGNAL_INVALID") from None
        if payload["code"] != 0:
            raise DiscoveryError("SOURCE_UNAVAILABLE") from None
        data = payload.get("data")
        if not isinstance(data, dict):
            raise DiscoveryError("SIGNAL_INVALID") from None
        has_more = data.get("has_more")
        items = data.get("items")
        next_offset = data.get("offset")
        if (type(has_more) not in (bool, int) or has_more not in (0, 1)
                or not isinstance(items, list)
                or ("offset" in data and not isinstance(next_offset, str))
                or (has_more and (not items or not next_offset))):
            raise DiscoveryError("PAGINATION_INVALID") from None
        if next_offset:
            if next_offset in cursors:
                raise DiscoveryError("PAGINATION_INVALID") from None
            cursors.add(next_offset)
        # 先核验整份已请求响应，损坏条目不能靠不合格或提前截断被隐藏。
        candidates = [_candidate(item, uid) for item in items]
        for id, qualified in candidates:
            if qualified:
                if id not in seen:
                    ids.append(id)
                    seen.add(id)
                if len(ids) == n:
                    break
        if on_progress is not None:
            await on_progress(ids.copy())
        if len(ids) == n:
            return {"ids": ids, "exhausted": False}
        if not has_more:
            return {"ids": ids, "exhausted": True}
        offset = next_offset
