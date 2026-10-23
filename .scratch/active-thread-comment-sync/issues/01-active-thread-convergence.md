# 01: 活跃动态评论同步收敛

**What to build:** 评论持续增长的动态能正常收敛——根评论扫描不因总计数变化而失败，回复同步不被根扫描失败阻塞，`rcount` 未变的楼不重扫。

**Parent:** [spec.md](../spec.md)

**Blocked by:** 无

**Status:** done

## 依据与交付边界

- [spec.md](../spec.md)：诊断结论 D1/D2/D3 与方案 F1/F2/F3。
- 遵守 [票据 25](../../backend-integration/issues/25-comment-count-sync.md) 的「完整分页、禁止见旧 ID 截断」要求——本工作不引入窗口截断。
- 不引入退避、自适应频率或每日校准（`docs/backend/api/collector-api.md:15`）。

## 核验标准

- [x] 扫描期间总计数**增长**时，根评论扫描成功并落库（`root_comments.py:177`）
- [x] 扫描期间总计数**减少**时仍失败并保留旧内容
- [x] 楼中楼分页期间计数增长不失败（`replies.py:118-119`）
- [x] 根评论扫描失败时，回复同步不再整轮跳过，而是用已存根评论的基准重试到期/失败的楼（`replies.py:84-102`）
- [x] `comments_last_attempt` 为 failed/unconfirmed 时不再触发 `full=True` 全量重扫（`sync.py:109`）
- [x] `rcount` 未变且未到 24 小时校准的楼不产生回复请求
- [x] 分页出现重复 ID 时仍失败重试（不丢评论的保证，`root_comments.py:180-181`）
- [x] `uv run pytest backend/tests` 全量通过

## 实施记录

三处改动，均在 `backend/bili_monitor/`：

1. **`root_comments.py`（D1）** 把 `counts != baseline` 拆成两条：`counts[0] < baseline[0]` 才抛「总数减少」，增长只记 `root_scan_count_grew`。`counts = (page.count, page.acount)` 两者都是总评论数（根+楼中楼），用它校验根分页稳定性属于指标错配。
2. **`replies.py`（D1 同型 + D2）**
   - 楼中楼分页同样只拒绝计数减少（`Reply count decreased during scan`），增长记 `reply_scan_count_grew`。
   - `roots_result is None` 时不再整轮跳过：用 `store.reply_progress` + `store.roots_for_replies` 取已存根评论，以 `source_reply_count` 为本轮基准，只重扫 `scan_due` 判定的楼（失败楼必然重扫）。progress 为空才退回原来的 `replies_sync_skipped`。
3. **`sync.py`（D3）** 删除 `retry_comments`，改 `full=full_replies`。重试不再强制全量展开全部楼层，中断「全量重扫 → 期间计数变化 → 再全量重扫」的死循环。

**关键取舍：降级轮不改一致性语义。** 首版降级实现把 `archive["source_comment_count"]` 当成本轮基准传给 `finish_replies`，导致根未确认时 `synced_reply_comment_count` 被推进到新总数、`work.replies` 被判 success——这是「假装全集一致」，会掩盖根漏采。改为降级轮结束时记 `unconfirmed`、`observed_count=None`：回复数据照常落库可读，但不推进一致性 checkpoint 与成功时间，`work.replies` 保持 `pending`，下一轮继续重试根。

**测试**：新增 `test_root_scan_survives_total_count_growth_during_pagination`、`test_replies_retry_when_root_scan_fails`；因行为改变同步更新 `test_comment_sync_status.py:170`、`test_comment_count_sync.py:259` 的请求序列断言（降级轮已展开的楼在恢复轮不再重复展开）。

**全量**：`uv run pytest backend/tests` → **804 passed**（必须在仓库根运行；在 `backend/` 下运行会让两个 `-m backend.*` 子进程测试因包路径找不到而假失败）。

## Comments

2026-10-23：三处实现完成，票据核验标准全部满足。

**未验证**：真实上游的长期稳定性、跨页位移的极端场景、修复后在维护者本机实例上的实际收敛表现——需重启 `bili-charge-live-34.service` 后观察 `synced_comment_count` 是否脱离 13656 并追平 `observed.source_comment_count`。
