# 规格：活跃动态的评论同步收敛

**问题：** 评论持续增长的动态，根评论扫描必然失败，且失败会连坐跳过回复扫描，导致新评论（绝大多数是楼中楼回复）永远无法归档。表现为页面上看不到新评论，`target_checks.work` 永远停在 `pending`。

**状态：** 诊断完成，修复待实施（TDD）。

## 1. 诊断结论（2026-10-23 实测）

目标动态 `1219141791464292387`（79 根评论 / 13577 回复 / 总计数 13656）：

```
12:07:40  work=running  observed=13659  synced=13656  roots=79
12:09:00  work=running  observed=13660  synced=13656  roots=79
```

`observed` 持续增长，`synced` 与根评论数从未推进，`comments_last_attempt` 停在 `pending`。

### 因果链

```
root_comments.py:177  翻页时 counts != baseline → raise ValueError("Comment counts changed during scan")
  → root_comments.py:207-210  finish_roots("failed")，return None
    → sync.py:107  sync_roots 抛出
      → sync.py:108  sync_replies 未执行
        → replies.py:86-89  replies_sync_skipped
  → checks.py:151  count_changed → revision++ → work="pending"，下一节拍重复
```

### 三个独立缺陷

**D1：校验指标错配（`root_comments.py:175-177`）**

`counts` 是 `(page.count, page.acount)`，两者都是**总评论数（根 + 楼中楼）**。参考脚本注释明确（`script_demo/bili_charge_monitor.py:544`）：

> total_snapshot 是评论接口第一页的总数（根评论+子回复）；

用总数校验**根评论**分页的稳定性不成立：楼中楼回复占总数的 99.4%（13577 / 13658），却能让 0.6% 的根评论扫描失败。当前实现还比参考脚本更严——比对元组两个值，任一抖动即失败。

**D2：失败连坐（`sync.py:107-108`）**

`sync_roots` 抛异常后 `sync_replies` 完全不执行。而新评论绝大多数是**回复**，因此永远不落库。讽刺的是 `replies.py:22-37` 的 `scan_due` 本来有很便宜的增量路径（`rcount` 未变则跳过），稳态一轮仅 6 个请求，但因拿不到 `roots_result` 而永远进不去。

**D3：重试触发全量重扫（`sync.py:109`）**

```python
full=full_replies or retry_comments
```

根扫描一失败 → `comments_last_attempt` 变为 `failed` → 下轮 `retry_comments=True` → `full=True` → **全量重扫 79 个楼（约 883 请求 / 约 5 分钟）** → 期间计数必然变化 → 又失败。这是 5 分钟一轮的来源。

而 `scan_due` 已覆盖「上次失败要重扫」（`progress["status"] != "success"` → True），`full` 的额外语义是多余的。

## 2. 目标

1. **不丢评论**——不得为了收敛而截断分页或跳过必要内容
2. **尽快看到最新评论**——回复同步不得被根扫描失败阻塞
3. **根评论未变化时不得扫描其楼中楼**——依赖 `rcount` 增量，而非全量重扫

## 3. 方案

| # | 改动 | 位置 |
|---|---|---|
| F1 | count 校验改为**只拒绝减少**：增长只记录事件，减少仍失败（删除会导致分页前移） | `root_comments.py:175-177` |
| F2 | **解除连坐**：根扫描失败时仍执行回复同步 | `sync.py:107-108` |
| F3 | 去掉 `retry_comments` 触发的全量重扫，保留显式初始化的 `full_replies` | `sync.py:109` |

**F1 为什么不丢评论**：分页偏移的直接症状是**重复 ID**，而 `root_comments.py:180-181` 已有检测：

```python
if ids and not set(ids) - seen:
    raise ValueError("Comment pagination did not advance")
```

头部插入新根评论导致页偏移时必然重复，该检测会捕获并整轮重试。因此 count 严格相等是多余防线，而它的代价是活跃动态永远失败。

**F2 的回复增量语义**：`scan_due(progress, observed_count, now_iso)` 已正确覆盖——新楼（`progress is None`）、上次失败（`status != "success"`）、`rcount` 变化、24 小时校准到期均重扫，其余跳过。F2 后该路径才真正可达。

**F2 实现位置修正**：连坐不在 `sync.py`——`sync.py` 只负责顺序调用，真正的拦截在 `replies.py:84-102`（`roots_result is None` 时 `replies_sync_skipped`）。解除连坐因此落在 `replies.py`：降级取 `store.reply_progress` + `store.roots_for_replies`，以已存根评论的 `source_reply_count` 为本轮基准。

**F1 同样适用于楼中楼**：`replies.py:138-146` 原本也是 `count != baseline` 即失败，热帖的楼同样永远不收敛，已一并改为只拒绝减少。

## 4. 验证标准

- [x] 扫描期间总计数增长时，根评论扫描成功并落库
- [x] 扫描期间总计数减少时，仍失败并保留旧内容
- [x] 根评论扫描失败时，回复仍被同步（不再 `replies_sync_skipped`）
- [x] `rcount` 未变且未到校准周期的楼不产生回复请求
- [x] 分页出现重复 ID 时仍失败重试（不丢评论的保证）
- [x] 现有 `backend/tests/` 全量通过（804 passed）

## 5. 边界

- 本工作**不**引入「只扫最近 N 页」的截断（票据 25 明确禁止），根评论仍全量分页
- 本工作**不**引入退避或自适应频率（`collector-api.md:15` 明确没有）
- 真实上游的长期稳定性、跨页位移的极端场景仍需在维护者环境验证

## 6. 实施结果

done。三处改动与关键取舍见 [issues/01-active-thread-convergence.md](issues/01-active-thread-convergence.md)。
