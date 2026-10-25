# 36: 后端异步时序用例的全量跑偶发超时

**What to build:** 让 `backend/tests` 的全量执行稳定可复现：消除两例在机器负载下偶发的 3 秒 `asyncio.wait_for` 超时，或把它们的时序假设改成不依赖墙钟的确定性等待。

**Parent:** [12](12-delivery-acceptance.md)

**Status:** needs-triage

## 现象（2026-10-25，票据 17 复核时发现）

在 `feat/backend-integration` 分支、同一份未改动的后端代码上，全量 `uv run --no-sync pytest backend/tests -q` 连续三次的结果：

| 次数 | 结果 | 失败用例 |
| --- | --- | --- |
| 1 | 808 passed / 1 failed | `test_comment_count_recovery.py::test_three_targets_obey_two_sync_slots_without_stalling_checks[run]` |
| 2 | 808 passed / 1 failed | `test_inflight_recovery.py::test_interrupted_sync_stays_stopped_across_locked_restart_and_resumes_pending[body-window]` |
| 3 | **809 passed** | — |

两次失败都是用例内 `asyncio.wait_for(…, 3)` 抛 `TimeoutError`（`asyncio/timeouts.py:115`）。失败用例单独重跑、以及 `test_inflight_recovery.py` 整个文件连跑三次（各 44 passed）均全绿。

原始日志：[`pytest-full-1.log`](../../frontend-vue-migration/evidence/17-logs/pytest-full-1.log)、
[`pytest-full-2.log`](../../frontend-vue-migration/evidence/17-logs/pytest-full-2.log)、
[`pytest-full-3.log`](../../frontend-vue-migration/evidence/17-logs/pytest-full-3.log)（票据 17 的证据目录）。

## 边界

- 后端代码在本轮没有任何改动（`git diff 491a529..HEAD -- backend/` 为空），所以这不是前端迁移引入的回归，也不代表功能失败；
  但「全量 809 passed」这一基线目前不可稳定复现，会让依赖它的验收结论（AC-23/25/26/27/28 的历史依据）失去可重复性。
- 三次运行环境相同：CachyOS Linux `7.2.11-1-cachyos`、8 核 / 15GB、Python 3.12.15、uv 0.12.23；失败与负载相关，未做进一步归因。
- 未放宽断言、未跳过用例：票据 17 只记录现象，没有为了让流水线变绿而改测试。

## 可能的处理方向（待分诊）

1. 把两例里的固定 3 秒等待换成事件驱动的收敛条件（例如等待 collector 明确进入下一状态），而不是等墙钟；
2. 或用 `ControlledClock` 之外的可注入调度把「槽位释放」变成确定性步骤；
3. 若确认是被测行为本身对时序敏感，则在用例里显式标注已知时序依赖并降低并发影响（例如 pytest-xdist 关闭、单用例串行），但仍保留原始超时断言。

## 验收条件

- [ ] 在负载相当的情况下连续 5 次全量执行均 809 passed，且两次失败场景不再依赖墙钟超时
- [ ] 不删除、不弱化任何既有的并发/槽位/count 同步断言
- [ ] 若采用「时序敏感但有解释」的方案，在证据里写明为什么这不是功能缺陷，并保留失败样本日志

## Comments

（尚无）
