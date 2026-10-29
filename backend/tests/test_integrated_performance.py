"""10 RC-12：一次有界的等价工作量对照与诚实开销报告（不连接真实来源）。

项目侧使用生产加载路径、真实临时 SQLite、真实 Requests／HTTPX 发送入口，只把外部
HTTP 换成固定状态、把显式等待换成受控虚拟时钟；参考侧按 `script_demo` 的静态核对
结论在测试内重建请求序列，不执行、不导入原始脚本。两侧结果集合必须相等；无法证明
完整等价时只报告可比链路，整体性能记为未验收（性能公式本身是非硬性参考目标）。
"""

import asyncio
import json
import math
import random
import time

import httpx
import requests

from backend.bili_monitor.collector import Collector
from backend.bili_monitor.comment_client import RequestsCommentClientFactory
from backend.bili_monitor.dispatch import DispatchLeases
from backend.bili_monitor.reply_pacing import ReplyPagePacer
from backend.bili_monitor.risk import format_epoch
from backend.bili_monitor.source_gate import GatedAsyncTransport, OpenSourceGate
from backend.bili_monitor.source_transport import PacedSourceTransport, SourcePacer
from backend.bili_monitor.storage import Store
from backend.tests.integrated_fixture import (
    HUGE, TARGETS, UID, AsyncSource, Source, install_requests, reply_id, root_id,
)


BASE = 1_800_000_000


class VirtualClock:
    """立即推进的虚拟时钟：显式等待成为可加总的数值，不真实睡眠。"""

    def __init__(self):
        self.value = 0.0
        self.waits = []

    def monotonic(self):
        return self.value

    def now(self):
        return format_epoch(BASE + self.value)

    async def sleep(self, seconds):
        self.waits.append(seconds)
        self.value += seconds


class NoWarmup:
    """性能对照只比较一次归档；会话预热按参考笔记单列，不混入可比链路。"""

    async def ensure(self, key, prepare):
        return None

    async def aclose(self):
        return None


def state():
    dynamics = {}
    for dynamic in TARGETS:
        dynamics[dynamic] = {
            "uid": UID, "name": "虚构性能作者", "text": f"虚构正文 {dynamic}",
            "version": "v1", "title": f"标题 {dynamic}", "roots": 1,
            "replies": 10000 if dynamic == HUGE else 0,
            "reply_root": True, "media": False, "locator_type": 17,
        }
    return {"dynamics": dynamics}


def reference_workload(value):
    """按 `script_demo` 静态核对规则重建请求与显式等待（A1 关闭 inline 复用）。

    参考侧：每个目标读取页面／详情／计数；根页预取到实际尾页并在空尾时复查；
    楼中楼按算术 `pn*size >= total` 终止，收尾对整楼等待一次；**没有**每页 0.1 秒。
    A2：为协议必需的尾页确认补一次请求（方向安全：让参考侧多做而不是放宽预算）。
    """
    requests = {}
    waits = 0.0

    def add(kind, count=1):
        requests[kind] = requests.get(kind, 0) + count

    for spec in value["dynamics"].values():
        add("opus_page")  # 页面信号
        add("detail")    # 解析 locator / 正文
        add("comment_count")
        roots = int(spec["roots"])
        root_pages = max(1, math.ceil(roots / 20)) + (1 if roots >= 20 else 0) + 1  # 尾页复查
        add("root_comments", root_pages)
        waits += 0.35 * root_pages
        replies = int(spec["replies"]) if spec.get("reply_root", True) else 0
        if replies:
            data_pages = math.ceil(replies / 20)
            add("replies", data_pages + 1)  # A2：协议必需确认页
            waits += 0.35  # 每楼一次等待
    add("profile")
    return requests, waits


def project_counts(records):
    counts = {}
    for _, kind, _, phase, _ in records:
        if phase == "send":
            counts[kind] = counts.get(kind, 0) + 1
    return counts


def test_bounded_performance_comparison_reports_truthfully(tmp_path, monkeypatch):
    """结果集合必须等价；请求与等待账本如实报告，公式非硬性目标不阻塞本票。"""
    started = time.monotonic()
    # 固定随机和显式等待：两侧同一套数值，避免抖动冒充性能差异。
    monkeypatch.setattr(random, "uniform", lambda low, high: (low + high) / 2)
    clock = VirtualClock()
    monkeypatch.setattr("backend.bili_monitor.replies.sleep_after_root", clock.sleep)
    value = state()
    records = []

    def record(role, kind, page, phase, oid):
        records.append((role, kind, page, phase, oid))

    source = Source("project", directory=None, state=value)
    async_source = AsyncSource(source, directory=None, role="project", record=record)
    monkeypatch.setattr(requests.Session, "send",
                        install_requests(source, directory=None, role="project", record=record))

    store = Store(tmp_path / "performance.sqlite")
    store.migrate()
    store.add(UID, "虚构性能作者", "https://example.invalid/avatar.png")
    store.update(UID, "specified", 10, True)
    for dynamic in TARGETS:
        store.add_target(UID, dynamic)
    leases = DispatchLeases(store, clock=clock)

    async def scenario():
        pacer = SourcePacer(sleep=clock.sleep)
        page_pacer = ReplyPagePacer(sleep=clock.sleep, clock=clock.monotonic, jitter=0)
        factory = RequestsCommentClientFactory(
            cookie_pairs=[], pacer=pacer, gate=OpenSourceGate(), reply_page_pacer=page_pacer,
            warmup=NoWarmup(), clock=clock.monotonic, source_lease=leases)
        async with httpx.AsyncClient(
                transport=PacedSourceTransport(
                    GatedAsyncTransport(httpx.MockTransport(async_source), gate=OpenSourceGate(),
                                        source_lease=leases), pacer=pacer),
                trust_env=False, follow_redirects=False) as client:
            collector = Collector(store, client, comment_client_factory=factory,
                                  clock=clock, scheduler=leases)
            try:
                for dynamic in TARGETS:
                    assert await collector.check_once(UID, dynamic)
                await collector.execute_pending()
            finally:
                await factory.aclose()

    asyncio.run(scenario())

    huge = store.read_archive(HUGE)
    assert huge["local_reply_count"] == 10000
    assert huge["source_comment_count"] == 10001
    assert huge["work"]["replies"] == "success"
    stored = store.reply_ids(HUGE)
    assert set().union(*stored.values()) == {reply_id(HUGE, index) for index in range(1, 10001)}
    for dynamic in TARGETS:
        archive = store.read_archive(dynamic)
        assert archive["local_comment_count"] == 1
        assert archive["work"]["comments"] == "success"
    assert {row["id"] for row in store.list_roots(HUGE)["items"]} == {root_id(HUGE, 1)}

    counts = project_counts(records)
    assert sum(counts.values()) <= 700, counts       # 有界请求预算：不靠重复请求扩大对照
    assert clock.value <= 120, clock.value            # 有界虚拟等待预算
    assert time.monotonic() - started <= 120, "性能对照超出墙钟预算"
    expected, reference_waits = reference_workload(value)
    t_new = clock.value
    t_reference = reference_waits
    # P_replies：无故障固定样本中实际必需的楼中楼页数（含协议确认页），不含探空页。
    p_replies = sum(math.ceil(spec["replies"] / 20) + 1
                    for spec in value["dynamics"].values() if spec.get("replies"))
    budget = 1.2 * t_reference + 0.1 * p_replies
    project_only = {
        "sqlite_page_transactions": sum(counts.get(kind, 0) for kind in counts),
        "notification_process": "excluded",
        "oss_upload": "excluded (media disabled in sample)",
        "session_warmup": "excluded (single archived pass)",
    }
    equivalent = counts == expected
    report = {
        "targets": len(TARGETS),
        "replies": 10000,
        "project_requests": counts,
        "reference_requests": expected,
        "t_new_virtual_seconds": round(t_new, 3),
        "t_reference_virtual_seconds": round(t_reference, 3),
        "p_replies": p_replies,
        "budget_seconds": round(budget, 3),
        "meets_non_hard_goal": t_new <= budget,
        "equivalent": equivalent,
        "project_only_costs": project_only,
        "conclusion": ("整体性能未验收：参考侧为静态核对重建的隔离 Adapter，"
                       "无法证明与原始脚本完整等价；上表只报告可比链路的请求数与显式等待。"
                       if not equivalent else
                       "请求集合一致；仍受参考 Adapter 为重建实现限制，整体性能未验收。"),
    }
    print("RC12-PERFORMANCE " + json.dumps(report, ensure_ascii=False, sort_keys=True))
    # 完整性为硬要求；性能公式是非硬性参考目标，达成与否都只如实记录。
    assert report["project_requests"]["replies"] <= 502
    assert "整体性能未验收" in report["conclusion"]
