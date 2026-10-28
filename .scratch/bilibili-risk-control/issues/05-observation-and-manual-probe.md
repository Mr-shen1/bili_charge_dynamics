# 05：恢复观察期与人工探测

Status: resolved

**What to build:** 探测通过后先保留退避档位观察正常采集，稳定 10 分钟才清零；自动恢复耗尽后，执行者可幂等请求一轮人工探测，但不能强行解除保护。

**Blocked by:** 04 — 六档冷却与分接口探测。

## 验收标准

- [x] 全部必需类型通过后进入 observing，恢复正常发送与等待策略，不为观察期额外降低正常吞吐。证据：`test_round_with_every_type_passed_enters_observing_and_keeps_the_step`（04）＋`test_collector_clears_observation_after_ten_active_minutes_of_real_collection`（观察期内检查工作照常推进到 `complete`）与真实进程用例。
- [x] 连续正常采集 10 分钟且确有成功业务请求后才回 normal、清零档位；无请求空闲或停机不抵扣观察期，重启重新累计观察时间并保留档位。证据：`test_observation_clears_only_after_ten_active_minutes_of_successful_collection`、`test_idle_and_failed_ticks_never_discount_the_observation_window`、`test_restart_resets_observation_accumulation_and_keeps_the_step`、`test_collector_does_not_discount_idle_observation_time`、`test_collector_restart_restarts_observation_accumulation_but_keeps_the_step`、真实进程 599／600 秒边界。
- [x] 观察期间再次遇 HTTP 412／429 进入上一档的下一档，不从 1 分钟重来；第六档后再次触发转 manual，不无限卡在末档。证据：`test_trigger_during_observation_advances_one_step_and_restarts_the_window`（第 2 档观察中 429 → 第 3 档 240 秒、进度归零）；第 6 档后转人工沿用 04 `test_trigger_during_observation_advances_one_step_and_sixth_goes_manual`。
- [x] 新增 POST /api/manage/risk/probe，仅在 manual 登记一轮，202 仅表示已登记；正式 collector 领取执行，API 不直接发起探测。证据：`test_probe_endpoint_only_registers_one_round_in_the_manual_state`（202 只有公开状态、`source.sent == []`）、`test_registered_manual_probe_runs_once_under_the_collector_and_stays_manual_on_failure`、`test_registered_manual_probe_runs_in_the_collector_and_clears_only_after_ten_minutes`（真实 API 登记、真实采集进程领取）。
- [x] 同一人工态代次重复登记幂等，不排多轮；collector 未运行时保持已登记。冷却未到期、正在探测及普通／观察态不可借该入口提前请求，不适用状态返回 409 RISK_PROBE_NOT_ALLOWED。证据：同上（重复 202 且响应体相同、另一个 gate 读到同一登记；normal／cooldown／probing／observing 均 409）、`test_manual_probe_success_enters_observation_and_old_owner_cannot_revert_it`（登记被领取后租约内不能再领第二轮）。
- [x] 不接受 query 或可写状态字段，不允许通过请求体清零档位、改截止时间或绕过检查；沿用已有管理入口部署保护，不新增页面、按钮或鉴权体系。证据：同上（`?state=normal` → 422；`{"state"}`／`{"backoff_step"}`／`{"next_probe_at"}` → 422 INVALID_INPUT 且状态不变）；前端未改。
- [x] 人工探测仍验证全部必需类型；通过进入同样观察期，失败保持人工态；无“强行恢复发送”入口。证据：`test_registered_manual_probe_runs_once_under_the_collector_and_stays_manual_on_failure`（冻结类型与 `ordered_types(required_types(...), trigger)` 一致、首类失败短路、仍 manual 第 6 档）、`test_manual_probe_success_enters_observation_and_old_owner_cannot_revert_it`（通过 → observing、`backoff_step=6`、观察进度为 0）。
- [x] 状态查询能表达登记、观察、稳定恢复和人工态；对应日志关联到原风控代次、探测轮次及档位，不泄漏内部领取令牌，不产生业务通知。证据：`GET /api/manage/risk` 新增 `observation`／`manual`（字段表见[采集契约](../../../docs/backend/api/collector-api.md#恢复观察期与人工探测05)）、`test_observation_progress_is_persisted_for_the_read_only_status`、`source_risk_observation_cleared`／`risk_probe_claimed` 的字段断言与 owner／令牌负向断言、`snapshot` 与通知开关不变。
- [x] 真实应用及进程装配、临时数据库和受控时间覆盖 10 分钟边界、空闲／停机、重复请求、旧 owner 迟到提交、人工成功／失败及观察期再风控，更新管理与运行契约。证据：`test_risk_observation_processes.py`（真实 API＋采集子进程、同一临时 SQLite、共享文件时钟与账本）＋`test_manual_probe_success_enters_observation_and_old_owner_cannot_revert_it`（旧 owner 迟到提交）；契约见 §6。

## 验证范围

主要完成 RC-08，并补齐 RC-06／RC-07 中的人工恢复闭环；系统群生命周期告警由 09 接入。

## Answer

`risk.py` 把 04 的 `observing` 补成可持续的观察期：状态查询新增 `observation`（`since`／`active_ms`／`successes`／`required_ms=600000`）与 `manual`（`probe_registered`）摘要，`source_risk` 单行在 v26 只补 `observing_active_ms`／`observing_successes`／`probe_request_generation`／`probe_origin` 四列。观察进度只由采集进程的固定节拍提交：`Collector` 每拍把单调时钟差按上一拍节拍封顶后交给 `RiskGate.observing_tick`，只有该区间确有成功业务请求（`RiskGate.report` 收到真实上游 2xx／3xx 且非预热类型）才累计；满 600 秒且有成功请求就回到 `normal`、清零档位并 `+1` 代次，同时清空观察进度。采集进程启动即 `restart_observation`：观察时间重新累计、`observing_since` 改为启动时刻，档位与人工态保留；观察期再遇 412／429 沿用下一档并归零进度。

人工恢复入口 `POST /api/manage/risk/probe` 只在 `manual` 登记一轮：`probe_request_generation` 绑定当前人工态代次，重复登记幂等、202 只表示已登记，API 不发任何来源请求；其它状态返回固定 `409 RISK_PROBE_NOT_ALLOWED`，请求不接受 query，`ProbeRequest(extra="forbid")` 让 `state`／`backoff_step`／`next_probe_at` 之类字段直接 422。`claim_probe` 在人工态只领取已登记代次并记录 `probe_origin=manual`，`RiskProber`／`Collector` 原样复用 04 的执行器与类型集合；全部通过进同一观察期，失败回到 `manual`（档位不变、需重新登记）。owner＋轮次 fencing 不变：租约内不能领第二轮，接管保留人工来源，旧 owner 的结果与结束被拒，迟到的失败不能把观察态拉回人工。

日志统一走 `_transition`：转移事件带 `previous_state`、`risk_state`、`risk_generation`、`backoff_step` 与 `probe_round_id`（纯数字关联号），另有 `risk_probe_claimed`、`source_risk_manual_probe_registered`、`source_risk_observation_restarted`、`source_risk_observation_cleared`；不含 owner／租约，也不产生业务通知。09 可在对应短事务内复用这批转换事实登记生命周期告警（见[证据](../evidence/05-observation-and-manual-probe.md) §7）。

未做：系统群生命周期告警（属 09）、页后 100ms 的增量／重试／尾页全覆盖（属 02／07）、单路调度与日志 ID 全覆盖（属 08）。前端未改（无新增页面与错误映射需求）。真实 B 站／OSS／飞书、部署与重启未验证。

## Comments

- 领取并按 TDD 纵向切片实施（Status: claimed → resolved）。新增 4 个测试文件（13 例，含 1 个真实多进程用例）；票范围 13 passed、风控与相关回归 18 个文件 277 passed、全量 1188 passed（均已合并最新集成 tip `851ea71` 后重跑）。实现提交 `c72533c`，契约与证据 `c625b33`，集成合并 `851ea71`（`git merge-base --is-ancestor spec/bilibili-risk-control HEAD` 通过）。基线 `f7f5755` 上 `test_risk_probe.py::test_collector_run_probes_at_each_deadline_and_resumes_abandoned_work` 有约 1/8 概率的既有账本顺序抖动（独立 worktree 复核），本票未改它。
- 迁移协调：本票在 07 确认“schema 仍 25”的前提下取 v26；若 08 也从同一 tip 取了 v26，合入时把本票迁移顺延为 27（列不变），不得两套 v26 并存。
- 跨票影响：① `RiskGate` 新增 `observing_tick`／`restart_observation`／`request_probe` 与 `public_status` 的 `observation`／`manual`，08 若改变调度需保证仍由采集进程提交观察心跳；② `claim_probe` 返回值新增 `origin` 字段（非令牌），09 可按它区分人工／自动轮次；③ 迁移 v26 只动 `source_risk`，07 的 v25 页进度不受影响。
- 环境限制：本工作树无 `.codegraph/` 索引，探索按 `docs/agents/codegraph.md` 回退到源码阅读与 grep。
