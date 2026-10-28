# 05 恢复观察期与人工探测：实施与验收证据

对应票据：[05 恢复观察期与人工探测](../issues/05-observation-and-manual-probe.md)；正式规则：[B 站限流／风控保护与全量归档续采](../../../docs/design/bilibili-risk-control.md) §4.1、§4.2、§5（RC-08，另含 RC-06／RC-07 的人工恢复闭环）；实施与测试决策：[父规格](../spec.md)「实施决策 9、12、13」「测试决策」；运行契约：[采集契约](../../../docs/backend/api/collector-api.md#恢复观察期与人工探测05)、[管理契约](../../../docs/backend/api/management-api.md#人工探测登记票据-05)。

结论：**本票范围（观察期只按成功业务请求的活跃采集时间累计、满 10 分钟清零档位、空闲／停机不抵扣、重启重新累计但保留档位、观察期再风控沿用下一档、人工态登记一轮受控探测、失败保持人工态、owner＋轮次 fencing 不可回退）已实施并有隔离自动化证据**，含真实 API 与采集子进程、同一临时 SQLite、共享文件时钟与传输账本。系统群生命周期告警属 09；本票只提供清晰的状态转换与日志事实。未访问真实 B 站、OSS 或飞书，未部署、未重启任何环境。

## 1. 环境与命令

- 环境：Linux，Python 3.12.15，`uv sync --locked`；pytest 8.4.2、httpx 0.28.1、requests 2.34.2、fastapi 0.115.12（`uv.lock`／`pyproject.toml` 未改）。工作树 `/tmp/bili-risk-control-05`，分支 `wt/bilibili-risk-control-05`，切自 `spec/bilibili-risk-control` 的 `f7f5755`；交付前按协调合并了最新集成 tip `851ea71`（07 的真实 merge 提交，已修复此前“补丁等价”拓扑问题），`git merge-base --is-ancestor spec/bilibili-risk-control HEAD` 通过（真实包含，不是 patch 等价）。合并只冲突在 `docs/README.md`、`docs/backend/api/collector-api.md`、`docs/design/bilibili-risk-control.md` 三处文字（两边同时改实施状态/索引），按双方内容合并；代码文件 `risk.py`／`risk_probe.py`／`collector.py` 与 07 的 `replies.py`／`scan_progress.py` 无交集，07 保留的回复步骤机 `SourceRiskPaused` 透传原样保留。此前曾按 07 预告 tip `f2708c1` 试合并过一次完整套件（1188 passed），因其仍是重放补丁拓扑，已在拿到真实 tip 后丢弃该合并提交，避免把重复的 04 提交带进集成。
- 代码定位：本工作树无 `.codegraph/` 索引，按 `docs/agents/codegraph.md` 的跳过条件回退到源码阅读与 grep。
- 新增用例：`backend/tests/test_risk_observation.py`（6）、`test_risk_observation_collector.py`（3）、`test_risk_manual_probe.py`（3）、`test_risk_observation_processes.py`（1，真实多进程）；`backend/tests/risk_probe_fixture.py` 增受控等待环境变量；迁移版本断言随 v26 更新（`test_migrations.py`、`test_notification_migration.py`、`test_inflight_recovery.py`、`test_root_page_resume.py`、`test_risk_state.py`、`test_three_process_delivery.py`）。
- 票范围命令与结果：
  - `uv run --no-sync pytest backend/tests/test_risk_observation.py backend/tests/test_risk_observation_collector.py backend/tests/test_risk_manual_probe.py backend/tests/test_risk_observation_processes.py -q` → **13 passed**（约 14 秒，含真实多进程用例）。
  - 风控与相关回归（18 个文件：03／04 四文件＋本票四文件、迁移、通知迁移、在途恢复、根页续采、三进程交付、管理、源入口、评论会话、07 的楼中楼续采／分页等待／增量）：**277 passed**（合并 `851ea71` 后）。
  - 全量：`uv run --no-sync pytest backend/tests -q` → **1188 passed**（合并 `851ea71` 后）。
- 前端：本票不新增页面、按钮或交互，`GET /api/manage/risk` 的新字段与 `409 RISK_PROBE_NOT_ALLOWED` 暂未被前端消费，因此未改 `frontend/`，未跑 `pnpm check`（工作树无 `node_modules`，安装需联网）。
- 已知与本票无关的既有抖动：`backend/tests/test_risk_probe.py::test_collector_run_probes_at_each_deadline_and_resumes_abandoned_work` 在基线提交 `f7f5755`（独立 worktree 实测）约 1/8 概率因“暂停瞬间在途请求的账本顺序”断言失败；本票未改该断言，也未借本票掩盖它。

## 2. 红绿过程（TDD，纵向切片）

1. **观察进度与稳定清零（`risk.py`）**：先写「进入 observing 后档位保留、9 分 59 秒不清零、满 10 分钟且有成功请求才回 normal」的失败用例，再实现 `OBSERVATION_SECONDS`／`OBSERVATION_MS`、`observing_tick`／`_observing_tick`、`restart_observation` 与 `public_status` 的 `observation`／`manual` 摘要。红在「观察期只用墙钟流逝就清零」。
2. **活跃边界**：成功业务请求只在 `RiskGate.report` 里按真实上游 HTTP 2xx／3xx 计数，预热类型（`homepage_warmup`／`space_warmup`）与普通错误不计；心跳只在区间内确有成功请求时累计，且累计上限为清零所需剩余毫秒。红在「空闲十分钟也清零」「500 与预热抵扣观察期」。
3. **停机与重启**：`Collector.run` 启动即调用 `restart_observation`：观察时间重新累计、`observing_since` 改为启动时刻，档位与人工态不动。红在「重启后沿用旧进度直接清零」。
4. **观察期再风控**：`_record_trigger` 在 `observing` 的转移里同时归零观察进度，档位 `+1`（第 6 档后转 manual）。红在「观察期再遇 429 从第 1 档重来或保留旧进度」。
5. **采集循环的心跳边界（`collector.py`）**：先写「逐秒推进累计到 599 秒仍观察、第 600 秒回 normal」「无目标空转十分钟账号不抵扣」「重启重新累计」三个失败用例，再实现 `_observation_tick`（单调时钟差、按上一拍节拍封顶、非观察态清基线）并把心跳接在探测处理之后、暂停判定之前。红在「没有心跳，观察期永不推进」。
6. **人工登记入口（HTTP）**：先写「普通／冷却未到期／正在探测／观察态 409、人工态 202 且重复登记幂等、query 与可写字段 422、API 不发请求、别的进程读到同一登记事实」的失败用例，再实现 `ProbeRequest`（`extra=forbid`）、`RiskGate.request_probe` 与 `POST /api/manage/risk/probe`。红在「404／500」「登记后既可清零档位又能改截止时间」。
7. **采集进程执行人工轮**：先写「登记后由采集进程领取一轮、失败保持人工态与第六档、不再自动叠加、状态查询区分登记／结果、无业务副作用」的失败用例，再让 `claim_probe` 接受 `manual`（要求 `probe_request_generation == generation`）、记录 `probe_origin`、`finish_probe` 按来源回到 `manual` 或 `observing`，并让 `risk_probe.probe_if_due`／`Collector.run` 认已登记的人工态。红在「人工态永远不触发探测」。
8. **owner＋轮次 fencing 与不可回退**：先写「租约内不能领第二轮、租约到期接管保留人工来源、旧 owner 的 `record_probe`／`finish_probe` 被拒且不改变状态、旧 owner 迟到的失败不能把观察态拉回人工」的失败用例，再在 `_claim_probe`／`_finish_probe` 里补齐 `probe_origin` 与 fencing 语义。
9. **迁移**：先写「v25（只有 03／04 字段）升级到 v26 后保护状态、档位与期限原样保留，新列按默认 0／NULL 补齐」的失败用例，再实现 `risk.migrate_observation` 与 `PRAGMA user_version = 26`（未来版本拒绝、原子回滚沿用既有迁移测试）。
10. **真实多进程**：先写「真实 API＋采集子进程：人工态登记 202 → 采集进程领取执行 → 观察 → 重启 → 逐拍累计到 599／600 秒」的失败用例，再给 fixture 的受控时钟加 `RISK_PROBE_CLOCK_SLEEP`（只压缩真实等待，不改变“现在”的推进粒度）。红在「子进程观察期不累计／重启后不清零」。

## 3. 验收条件 → 证据

| 票据验收条件 | 证据 |
| --- | --- |
| 全部必需类型通过后进入 observing，恢复正常发送与等待策略，不为观察期额外降低正常吞吐 | `test_round_with_every_type_passed_enters_observing_and_keeps_the_step`（04）＋本票 `test_collector_clears_observation_after_ten_active_minutes_of_real_collection`（观察期内检查工作推进到 `complete`）、真实进程用例（观察期后 `checks()[0]["work"] == "complete"`） |
| 连续正常采集 10 分钟且确有成功业务请求后才回 normal、清零档位；无请求空闲或停机不抵扣观察期，重启重新累计观察时间并保留档位 | `test_observation_clears_only_after_ten_active_minutes_of_successful_collection`（599 秒仍观察、第 600 秒清零）、`test_idle_and_failed_ticks_never_discount_the_observation_window`（空闲、500、仅预热都不累计）、`test_restart_resets_observation_accumulation_and_keeps_the_step`、`test_collector_does_not_discount_idle_observation_time`、`test_collector_restart_restarts_observation_accumulation_but_keeps_the_step`；真实进程用例（重启后 `active_ms=0`、`backoff_step=6`，随后 599／600 秒边界） |
| 观察期间再次遇 HTTP 412／429 进入上一档的下一档，不从 1 分钟重来；第六档后再次触发转 manual | `test_trigger_during_observation_advances_one_step_and_restarts_the_window`（第 2 档观察中 429 → 第 3 档 240 秒、进度归零）；第 6 档后转人工沿用 04 的 `test_trigger_during_observation_advances_one_step_and_sixth_goes_manual` |
| 新增 POST /api/manage/risk/probe，仅在 manual 登记一轮，202 仅表示已登记；正式 collector 领取执行，API 不直接发起探测 | `test_probe_endpoint_only_registers_one_round_in_the_manual_state`（202 只含公开状态、`source.sent == []`）、`test_registered_manual_probe_runs_once_under_the_collector_and_stays_manual_on_failure`（登记由 `risk_probe_claimed` 领取）、真实进程用例（真实 API 登记、真实采集进程领取探测） |
| 同一人工态代次重复登记幂等、不排多轮；collector 未运行时保持已登记；冷却未到期、正在探测及普通／观察态不可提前请求，不适用状态 409 RISK_PROBE_NOT_ALLOWED | `test_probe_endpoint_only_registers_one_round_in_the_manual_state`（重复 202 且响应体相同、`next_probe_at` 不变、另一个 gate 读到同一登记、normal／cooldown／probing／observing 均 409）、`test_manual_probe_success_enters_observation_and_old_owner_cannot_revert_it`（登记被领取后租约内不能再领第二轮） |
| 不接受 query 或可写状态字段，不允许通过请求体清零档位、改截止时间或绕过检查；沿用已有管理入口部署保护，不新增页面、按钮或鉴权体系 | 同上（`?state=normal` → 422；`{"state"}`／`{"backoff_step"}`／`{"next_probe_at"}` → 422 INVALID_INPUT 且状态不变）；前端未改，无新增页面 |
| 人工探测仍验证全部必需类型；通过进入同样观察期，失败保持人工态；无“强行恢复发送”入口 | `test_registered_manual_probe_runs_once_under_the_collector_and_stays_manual_on_failure`（冻结类型列表与 `ordered_types(required_types(...), trigger)` 一致、首类失败后其余保持 `pending`、状态仍是 manual 第 6 档）、`test_manual_probe_success_enters_observation_and_old_owner_cannot_revert_it`（通过 → observing 且 `backoff_step=6`、观察进度为 0） |
| 状态查询能表达登记、观察、稳定恢复和人工态；日志关联原风控代次、探测轮次及档位，不泄漏内部领取令牌，不产生业务通知 | `public_status` 的 `observation`／`manual` 字段表见[采集契约](../../../docs/backend/api/collector-api.md#恢复观察期与人工探测05)：`test_observation_progress_is_persisted_for_the_read_only_status`（另一进程读到同一进度）、`test_probe_endpoint_only_registers_one_round_in_the_manual_state`（`manual.probe_registered`）、`test_observation_clears_only_after_ten_active_minutes_of_successful_collection`（`source_risk_observation_cleared` 带 `previous_state`／`risk_generation`／`backoff_step`／`observing_ms`／`probe_round_id`）、`test_registered_manual_probe...`（`risk_probe_claimed` 含 `probe_origin=manual`，日志无 owner／lease、无 32 位 hex 令牌）、`snapshot` 前后相等且 `read_notification_switch()` 不变（无业务通知） |
| 真实应用及进程装配、临时数据库和受控时间覆盖 10 分钟边界、空闲／停机、重复请求、旧 owner 迟到提交、人工成功／失败及观察期再风控，更新管理与运行契约 | `test_risk_observation_processes.py`（真实 API＋采集子进程、同一临时 SQLite、共享文件时钟与账本）、`test_manual_probe_success_enters_observation_and_old_owner_cannot_revert_it`（旧 owner 迟到提交）、`test_collector_does_not_discount_idle_observation_time`、契约更新见 §6 |

## 4. 关键设计决定

- **观察进度是持久事实，提交者是采集进程**：`source_risk` 的 `observing_active_ms`／`observing_successes` 由采集进程的心跳写入，API 只读；这样只读状态查询能表达“观察中／稳定恢复”，而进程内对象不冒充跨进程事实。API 进程的成功响应不抵扣观察期，避免“采集停下、管理操作还在发请求”被当成正常采集。
- **活跃时间的判据放在状态层而不是调用点**：成功业务请求的计数点仍是 01 的唯一报告入口 `RiskGate.report`（真实上游 2xx／3xx 且非预热类型），不需要在检查、归档、发现、媒体各调用点各插一遍。心跳自带 `successful` 判定，业务代码不感知观察期。
- **每拍最多计入一个节拍**：`Collector` 把单调时钟差按上一拍节拍封顶后交给 `observing_tick`。停顿、休眠、事件循环阻塞都不会把十分钟一次“补”出来；同时它让受控时钟下的边界可以精确落在 599／600 秒。
- **重启只重置进度**：`restart_observation` 在采集进程启动时把 `observing_since` 改为启动时刻、进度归零，档位与人工态保留——这就是“停机不抵扣、重启重新累计”的最小持久语义，不需要额外进程代次。
- **人工登记是代次绑定的单条事实**：`probe_request_generation` 记“哪个人工态代次登记过”，`claim_probe` 只在该代次匹配时领取并清空登记；因此重复登记幂等、一轮执行后需重新登记，且不需要第二套探测执行器（`RiskProber` 原样复用）。
- **探测来源随轮次落库**：新增 `probe_origin`（`manual`／`cooldown`）让 `finish_probe` 知道失败该回人工态还是推进冷却；租约接管沿用原来源，人工轮不会因为接管被悄悄降级成自动冷却。
- **观察期清零也是一次状态转移**：`observing → normal` 只 `+1` 代次、清零档位并清空观察进度，日志走统一 `_transition`，因此 09 可以在同一短事务登记“恢复稳定”告警而无需重读或猜测。
- **迁移复用 03／04 的单行**：v26 只给 `source_risk` 补 4 列（`probe_origin`、`probe_request_generation`、`observing_active_ms`、`observing_successes`），`migrate_observation` 可重入（降级副本重放迁移号时不重置状态），未来版本仍拒绝启动。

## 5. 未覆盖与限制

- 未实现（属 09／10）：系统群生命周期告警（首次触发、进入人工态、稳定恢复）。本票只提供转换事实与统一日志，不登记告警行，也不产生任何业务通知。
- 人工探测仍只用本地已知有效样本（沿用 04 的 fail-closed）：没有可验证样本时记 `sample_missing` 并保持人工态，可能需要在完成一次成功归档后再登记。这是有意的保守取舍，不是遗漏。
- 观察进度的精度等于采集节拍：一个节拍内的成功请求只记 1 次 `successes`，`active_ms` 按节拍封顶累加；更细的请求级计时不在本票范围，也不影响 10 分钟门槛。
- 观察期固定 600 秒，未做成环境变量或运行时可调参数（正式设计只给一个窗口）。
- 迁移版本协调：本票在 07 确认“schema 仍 25”的前提上取 v26；若 08 的调度票在同一 tip 上也取了 v26，合入时需把本票的 `risk.migrate_observation` 与 `PRAGMA user_version` 顺延为 27（机械改动，列不变），不得两套 v26 并存。
- 未验证：真实 B 站 412／429 与人工恢复、真实代理行为、真实 OSS／飞书、目标机部署与重启、跨机器时钟偏差、长期运行下观察心跳的写库频率对 SQLite 的影响（只在 `observing` 期间每拍一次短事务）。
- 前端未改：无新增错误码页面映射与风控面板；`GET /api/manage/risk` 的 `observation`／`manual` 字段尚未被前端消费。

## 6. 代码与文档指针

- 修改（生产）：`risk.py`（`OBSERVATION_SECONDS`／`OBSERVATION_MS`、`observing_tick`／`restart_observation`、`request_probe`、`probe_origin` 与人工登记列、`_transition` 统一转移日志、`public_status` 的 `observation`／`manual`）；`collector.py`（启动重新累计观察、每拍心跳与节拍封顶、已登记人工态触发探测）；`risk_probe.py`（`probe_if_due` 接受人工态，领取仍由 `claim_probe` 判定）；`app.py`（`POST /api/manage/risk/probe`）；`contracts.py`（`ProbeRequest`、`409 RISK_PROBE_NOT_ALLOWED`）；`storage.py`（v26 迁移）。
- 新增（测试）：`backend/tests/test_risk_observation.py`、`test_risk_observation_collector.py`、`test_risk_manual_probe.py`、`test_risk_observation_processes.py`；`risk_probe_fixture.py` 增 `RISK_PROBE_CLOCK_SLEEP`（只压缩真实等待）。
- 文档：`docs/backend/api/collector-api.md`（新增「恢复观察期与人工探测（05）」、状态字段与日志）、`docs/backend/api/management-api.md`（「人工探测登记（票据 05）」与 `409` 映射、v26）、`docs/design/bilibili-risk-control.md`（实施状态与 §5）、`docs/deployment/static-delivery.md`（schema v26 与稳定清零）、`backend/README.md`、`docs/README.md`。
- 实现提交：`c72533c feat(collector): 恢复观察期稳定清零与人工探测登记`（概念提交，含测试与迁移）；契约与证据提交 `c625b33 docs(collector): 05 观察期与人工探测契约及验收证据`；集成合并 `Merge commit '851ea71' into wt/bilibili-risk-control-05`。

## 7. 供 09 复用的状态转换与事实

09 需要的三个生命周期事实都已集中在 `risk.py` 的短事务里，且每次转移只有一个写事务：

| 事实 | 转移点 | 事务内可见的行 | 已提交后的日志 |
| --- | --- | --- | --- |
| 首次触发（`normal→cooldown`／`observing→cooldown`／`observing→manual`） | `RiskGate._record_trigger` | 更新前的 `row`（前态、档位）与更新后的 `row` | `source_risk_triggered`（含 `previous_state`、`risk_state`、`risk_generation`、`backoff_step`、`probe_round_id`、`endpoint_type`、`http_status`） |
| 进入人工态（第六档失败／观察期第 6 档后再触发／人工轮失败） | `_finish_probe`（`origin=="manual"` 或档位满）、`_record_trigger` | 同上 | `risk_probe_round_finished`（`passed`、`probe_origin`、`risk_state=manual`）＋`source_risk_manual_wait` |
| 恢复稳定（`observing→normal`，清零档位） | `_observing_tick` | 更新前的 `row`（含 `observing_active_ms`／`observing_successes`）与更新后的 `row` | `source_risk_observation_cleared`（`previous_state=observing`、`observing_ms`、`successes`、`backoff_step=0`、`risk_generation`） |

- 在同一事务登记告警的写法与 `Collector._record_loop_alert` 相同：在这些方法的 `with write(self.store) as connection:` 内调用 `outbox.record_alert(connection, ...)`；网络与外发仍在事务外，登记失败只留固定分类日志。
- 转移后的公开事实统一由 `public_status(row)` 给出（`state`／`generation`／`backoff_step`／`observation`／`manual`／`probe`），09 不需要解析日志或重算状态。
- 人工登记（`_request_probe`）不是生命周期转移（不改状态、只记 `probe_request_generation`），日志为 `source_risk_manual_probe_registered`，可作为人工介入审计，不必单独告警。
- 本票的 `_transition` 是唯一的新增日志出口，后续若新增转移请沿用它，避免同一批事实出现两种字段集合。
