"""按接口类型的最小有效探测：串行、失败短路、只用本地已知有效样本。

正式设计 §4.3／§4.4：每轮冻结「触发接口类型 ∪ 当前待执行任务所需类型」，按主机与
路径模板分类，不按动态 ID、根 ID 或页码逐一探测；每类只发一个最小有效 GET，走正常
业务同一套凭据、代理、等待与解析校验。任一类型未通过立即结束本轮，其余类型不再请求。
没有已知有效样本时记录固定原因并保持暂停，不在线无限寻找或把 HTTP 200 当成功。

探测只验证可用性：本模块只读取本地样本、发 GET 并写探测结果，不提交归档分片、
不推进评论 checkpoint、不写检查／成功时间，也不生成任何业务通知。
"""

import time

from anyio import to_thread

from .collector_logging import collector_event, correlation_id, failure_fields, source_refs
from .comment_client import RequestsCommentClient
from .contracts import APIError
from .discovery import DiscoveryError, discover_recent
from .profiles import fetch_profile
from .replies import fetch_reply_page
from .reply_pacing import ReplyPagePacer
from .risk import TRIGGER_STATUSES
from .root_comments import fetch_comment_count, fetch_root_page
from .source import fetch_detail, fetch_page
from .source_gate import IMAGE_BILIIMG, IMAGE_HDSLB, source_request


# 一轮内其余类型的固定顺序；触发类型总是排在最前，先验证拦住我们的那类接口。
CANONICAL_ORDER = (
    "feed", "comment_count", "root_comments", "replies", "detail", "opus_page",
    "profile", "homepage_warmup", "space_warmup", IMAGE_HDSLB, IMAGE_BILIIMG,
)
IMAGE_TYPES = (IMAGE_HDSLB, IMAGE_BILIIMG)
# 没有可用样本的固定原因：保持暂停，不冒充已恢复。
SAMPLE_MISSING = "sample_missing"


class ProbeSampleMissing(Exception):
    """本地没有可验证样本：本轮未通过，但不是一个新识别出的风控类型。"""


def _image_type(url):
    classified = source_request("GET", url)
    if classified is None or classified.endpoint_type not in IMAGE_TYPES:
        return None
    return classified.endpoint_type


def required_types(facts):
    """当前待执行任务真正需要的接口类型；没在工作里用到的功能不加入探测。"""
    types = set()
    if facts["selected"]:
        # 每个节拍要采样页面信号并读取独立评论计数。
        types.update(("opus_page", "comment_count"))
        if facts["pending_work"] or facts["comment"] is None:
            # 位置未知或需要评论同步时会再读 detail 刷新 locator。
            types.add("detail")
    if facts["pending_work"] and facts["comment"] is not None:
        types.add("root_comments")
        if facts["replies"] is not None:
            types.add("replies")
    if facts["recent"]:
        types.add("feed")
    for item in facts["media"]:
        if item["status"] == "success":
            continue
        kind = _image_type(item["url"])
        if kind is not None:
            types.add(kind)
    return types


def ordered_types(required, trigger=None):
    """触发类型先探测，其余按固定顺序；未知类型（例如 source_other）留在末尾。"""
    ordered = [trigger] if trigger else []
    ordered += [kind for kind in CANONICAL_ORDER if kind in required and kind != trigger]
    ordered += sorted(kind for kind in required
                      if kind not in CANONICAL_ORDER and kind != trigger)
    return ordered


def _first(values):
    return values[0] if values else None


def _need(value):
    if value is None or value == "":
        raise ProbeSampleMissing()
    return value


def probe_reason(error):
    """探测失败的固定原因：不复用“普通业务失败”分类，也不把上游原文带出去。"""
    if isinstance(error, DiscoveryError):
        return error.code.lower()
    if isinstance(error, APIError):
        return error.code.lower()
    diagnostics = failure_fields(error)
    if diagnostics["http_status"] in TRIGGER_STATUSES:
        return "source_risk"
    return diagnostics["reason"]


class RiskProber:
    """唯一 owner 的探测执行者：领取轮次 → 串行探测 → 逐类记录 → 结束本轮。

    `client` 是不经发送许可的独立装配（仍用正式凭据、代理、解析与等待），因为发送
    许可在探测期间本来就拒绝普通来源请求；探测轮次的唯一性由持久 owner 租约保证。
    `comments` 必须是提供 `.client(uid)` 的评论会话工厂：它按 UP 复用正式会话，但
    不触发首页／空间预热。
    """

    def __init__(self, store, gate, client, *, comments=None, downloader=None,
                 clock=None, reply_page_pacer=None):
        self.store = store
        self.gate = gate
        self.client = client
        self.comments = comments
        self.downloader = downloader
        self.clock = clock if clock is not None else time.monotonic
        self.reply_page_pacer = (reply_page_pacer if reply_page_pacer is not None
                                 else ReplyPagePacer())
        self._timing = None

    async def probe_if_due(self):
        """到期（或租约过期可接管）时执行一轮探测；返回新的公开状态，否则 None。"""
        status = await self.gate.snapshot()
        if status["state"] not in ("cooldown", "probing"):
            return None
        facts = await to_thread.run_sync(self.store.risk_probe_facts)
        trigger = (status.get("last_trigger") or {}).get("endpoint_type")
        claim = await self.gate.claim_probe(ordered_types(required_types(facts), trigger))
        if claim is None:
            return None
        round_ref = correlation_id(claim["round"])
        collector_event("risk_probe_started", probe_round_id=round_ref,
                        endpoint_types=len(claim["types"]), backoff_step=status["backoff_step"])
        passed, retry_after = True, None
        for kind in claim["types"]:
            result, retry = await self._probe(kind, facts)
            accepted = await self.gate.record_probe(claim, result)
            collector_event("risk_probe_finished", probe_round_id=round_ref, endpoint_type=kind,
                            result=result["status"], http_status=result["http_status"],
                            reason=result["reason"], elapsed_ms=result["elapsed_ms"],
                            wait_ms=result["wait_ms"],
                            **source_refs(uid=result["uid"], dynamic_id=result["dynamic_id"],
                                          root_id=result["root_id"]))
            if not accepted:
                # 轮次已被接管：旧 owner 不能继续提交，也不改状态。
                return None
            if result["status"] != "passed":
                passed = False
                retry_after = retry
                break
        return await self.gate.finish_probe(claim, passed, retry_after)

    async def _probe(self, kind, facts):
        watch = {"uid": None, "dynamic_id": None, "root_id": None}
        self._timing = None
        started = self.clock()
        retry_after = None
        try:
            retry_after = await self._run(kind, facts, watch)
            result = {"status": "passed", "http_status": 200, "reason": None}
        except ProbeSampleMissing:
            result = {"status": "failed", "http_status": None, "reason": SAMPLE_MISSING}
        except Exception as error:
            diagnostics = failure_fields(error)
            result = {"status": "failed", "http_status": diagnostics["http_status"],
                      "reason": probe_reason(error)}
            retry_after = self._retry_after(error)
        timing = self._timing
        return ({
            "endpoint_type": kind, **result,
            "elapsed_ms": max(0, int((self.clock() - started) * 1000)),
            "wait_ms": getattr(timing, "wait_ms", None) if timing is not None else None,
            **watch,
        }, retry_after)

    def _retry_after(self, error):
        response = getattr(error, "response", None)
        headers = getattr(response, "headers", None)
        if headers is None:
            return None
        try:
            return headers.get("retry-after")
        except Exception:
            return None

    async def _comment_client(self, uid):
        if self.comments is not None:
            return await self.comments.client(uid)
        return self.client

    async def _run(self, kind, facts, watch):
        """发一个最小有效 GET 并走原解析校验；失败原样抛给本轮结算。"""
        if kind == "feed":
            uid = _need(_first(facts["recent"]))
            watch["uid"] = uid
            # 只验证当前 recent UP 的首批，不继续翻页。
            await discover_recent(self.client, uid, 1, pages=1)
        elif kind == "opus_page":
            target = _need(_first(facts["selected"]))
            watch.update(uid=target["uid"], dynamic_id=target["id"])
            await fetch_page(self.client, target["id"])
        elif kind == "detail":
            target = _need(_first(facts["selected"]))
            watch.update(uid=target["uid"], dynamic_id=target["id"])
            # 仍校验目标与作者：不接受别的动态或别的作者顶替。
            await fetch_detail(self.client, target["id"], target["uid"])
        elif kind == "profile":
            uid = _need(_first(facts["identities"]))
            watch["uid"] = uid
            await fetch_profile(self.client, uid)
        elif kind in ("comment_count", "root_comments"):
            sample = _need(facts["comment"])
            watch.update(uid=sample["uid"], dynamic_id=sample["dynamic_id"])
            client = await self._comment_client(sample["uid"])
            locator = {"oid": sample["oid"], "type": sample["type"]}
            if kind == "comment_count":
                await fetch_comment_count(client, locator, uid=sample["uid"])
            else:
                await fetch_root_page(client, sample["dynamic_id"], locator, 1, uid=sample["uid"])
        elif kind == "replies":
            sample = _need(facts["replies"])
            watch.update(uid=sample["uid"], dynamic_id=sample["dynamic_id"],
                         root_id=sample["root_id"])
            client = await self._comment_client(sample["uid"])
            locator = {"oid": sample["oid"], "type": sample["type"]}
            await self._reply_page(client, sample, locator)
        elif kind in ("homepage_warmup", "space_warmup"):
            uid = _need(_first(facts["identities"]))
            watch["uid"] = uid
            client = await self._comment_client(uid)
            url = ("https://www.bilibili.com/" if kind == "homepage_warmup"
                   else f"https://space.bilibili.com/{uid}/dynamic")
            response = await client.get(url, timeout=10)
            response.raise_for_status()
        elif kind in IMAGE_TYPES:
            url = _need(self._image_sample(facts, kind))
            if self.downloader is None:
                raise ProbeSampleMissing()
            await self.downloader.download(url)
        else:
            # 白名单内但尚无样本模板的类型：没有已知有效样本，不能冒充通过。
            raise ProbeSampleMissing()
        return None

    async def _reply_page(self, client, sample, locator):
        """楼中楼探测同样等待 100ms：生产会话在 get() 内已覆盖发送＋完成＋等待。"""
        arguments = (client, sample["dynamic_id"], sample["root_id"], locator, 1)
        if isinstance(client, RequestsCommentClient):
            try:
                await fetch_reply_page(*arguments, uid=sample["uid"])
            finally:
                # 生产会话自己记录了发送耗时与页后等待；这里只读取诊断值。
                self._timing = client.last_reply_page
            return
        timing = None
        try:
            async with self.reply_page_pacer.page() as timing:
                await fetch_reply_page(*arguments, uid=sample["uid"])
        finally:
            self._timing = timing

    @staticmethod
    def _image_sample(facts, kind):
        candidates = [item for item in facts["media"] if _image_type(item["url"]) == kind]
        if not candidates:
            return None
        # 优先未成功项：那正是后续采集需要的图片类型。
        pending = [item for item in candidates if item["status"] != "success"]
        return (pending or candidates)[0]["url"]
