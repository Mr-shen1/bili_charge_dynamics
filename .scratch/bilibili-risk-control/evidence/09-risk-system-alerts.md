# 09 风控生命周期系统告警：实施与验收证据

对应票据：[09 风控生命周期系统告警](../issues/09-risk-system-alerts.md)；正式规则：[B 站限流／风控保护与全量归档续采](../../../docs/design/bilibili-risk-control.md) §5（RC-11）；实施与测试决策：[父规格](../spec.md)「实施决策 17」「用户故事 65–66」「测试决策 10」；运行契约：[采集契约](../../../docs/backend/api/collector-api.md#风控生命周期系统告警09)、[通知进程与事件投递](../../../docs/backend/api/notification-process.md#33-系统告警0809)、[后端 README](../../../backend/README.md)。

结论：**本票范围（由真实风控状态转移登记首次触发、自动恢复耗尽转人工与稳定恢复三类系统群告警，复用既有事务发件箱、系统群路由、类别／固定原因目录、30 分钟去重节流与通知三态开关；`off` 不登记不排队不补发且不暗中改开关；探测刚通过但未稳定不冒充恢复；重复触发／迟到响应／重启／人工重复登记／owner 接管不重复事实；消息只含固定安全字段；不产生业务通知、无新迁移）已实施并有隔离自动化证据**，包含真实 `RiskGate` 状态机、真实临时 SQLite、真实 `Collector`／API 入口、真实 `Dispatcher` 领取与回写路径，飞书传输为进程内替身。未访问真实 B 站、OSS 或飞书，未部署、未重启任何环境。

## 1. 环境与命令

- 环境：Linux，Python 3.12.15，`uv sync --locked`；pytest 8.4.2、httpx 0.28.1、fastapi 0.115.12（`uv.lock`／`pyproject.toml` 未改）。工作树 `/tmp/bili-risk-control-09`，分支 `wt/bilibili-risk-control-09`，切自 `spec/bilibili-risk-control` 的 `4be7824`（性能公式已改为非硬性参考目标的最新 tip；本票不涉及性能，未恢复旧硬门槛）。
- 代码定位：本工作树无 `.codegraph/` 索引，按 `docs/agents/codegraph.md` 的跳过条件回退到源码阅读与 grep。
- 新增用例：`backend/tests/test_risk_alerts.py`（12 例）。未新增迁移、未改测试 fixture、未改前端。
- 交付前集成：`git merge spec/bilibili-risk-control` 输出“已经是最新的”（最新 tip 就是本票基点 `4be7824`，08 的并行分支尚未合入），`git merge-base --is-ancestor spec/bilibili-risk-control HEAD` 通过，无需解冲突，随后在合入后的工作树上重跑票范围与全量。
- 票范围命令与结果：
  - `uv run --no-sync pytest backend/tests/test_risk_alerts.py -q` → **12 passed**（约 0.7 秒）。
  - 风控与通知相关回归（17 个文件：本票、03／04／05 全部风控用例、通知告警／三态／投递／迁移／心跳／通知进程、迁移、三进程交付）→ **157 passed**（约 57 秒）。
  - 全量：`uv run --no-sync pytest backend/tests -q` → **1200 passed**（约 299 秒；基线 1188，本票 +12）。
  - 合入最新 tip 并提交后重跑：票范围 **12 passed**、全量 **1200 passed**（约 309 秒），与提交前一致（树内容相同）。
- 前端：本票不新增页面、按钮或交互，未改 `frontend/`，未跑 `pnpm check`。

## 2. 红绿过程（TDD，纵向切片）

红线基准：把 `backend/bili_monitor/risk.py` 与 `backend/bili_monitor/notifications/message.py` 还原到 `4be7824`，仅保留新测试文件运行
`uv run --no-sync pytest backend/tests/test_risk_alerts.py -q` → **12 failed**（全部落在“系统群一条消息都没有”）。恢复实现后同一命令 12 passed。

1. **首次触发闭环**：先写「一次真实 412 → 系统群恰好一条五字段消息、业务群一条都不发、逐接口细节不刷群」的失败用例（红：`receiver.requests == []`），再在 `_record_trigger` 的 `with write(...)` 内登记 `risk_triggered`，并在 `message.py` 扩展固定类别／原因目录。
2. **稳定恢复与“未稳定不冒充”**：先写「探测通过只进 `observing`、599 秒不发恢复、满 600 秒才发一条、且不被 11 分钟前的触发告警节流吞掉」的失败用例，再在 `_observing_tick` 的 `cleared` 分支同事务登记 `risk_recovered`。
3. **耗尽转人工**：先写「六档失败只产生‘触发＋转人工’两条（每档等待与每类结果不刷群）、人工轮失败不重复、同一人工态代次重复登记不产生告警」的失败用例，再在 `_finish_probe` 的转人工分支按 `probe_origin != manual` 登记 `risk_manual`。
4. **观察期末档再触发**：先写「第 6 档后观察期再遇 429 直接转人工，只登记一个事实」的失败用例，再让 `_record_trigger` 按转移后的状态区分：转人工只登记 `risk_manual`，其余登记 `risk_triggered`。
5. **重复／迟到／重启／接管**：先写「同代次迟到 429 合并、重启后新 `RiskGate` 不重复、观察期再触发在 30 分钟内合并、超过窗口的新触发才是新提醒、租约接管与旧 owner 迟到结果不产生告警」的失败用例，再确认复用既有 `notification_alerts` 节流与 owner／轮次 fencing 即可满足，不新增并行去重。
6. **真实入口**：先写「真实 `Collector.check_once` 遇到计数接口 412」与「真实 API（`TestClient`）新增目标时动态网页 412 → 503」两条用例，确认告警由业务调用链上的真实报告入口登记，两进程都不自己投递，由独立通知进程领取。
7. **三态开关**：先写「`off` 下触发与冷却推进都不登记、通知状态不被改动、切到 `system_only` 不补发关闭期间的事实、只有之后的新稳定恢复才投递」的失败用例，再验证既有 `off` 语义已满足（登记侧 `_registration_open`）。
8. **业务通知不受影响**：先写「正文变化照旧发 UP 群、风控告警只发系统群、探测与观察不产生动态变化／新增评论事件、同版本重复检查不新增消息」的失败用例，确认为新增类别与登记点，未触碰业务通知资格与去重。
9. **投递失败与重启**：先写「系统群 500 → 记录留在 `pending`、`error=http_error`，重启后的投递进程在退避到期后重发同一条、告警事件仍只有 1 条」的失败用例，复用既有投递退避与告警事件身份，不新增补发机制。
10. **登记失败不旁路**：先写「DROP `notification_alerts` 后触发 → 风控状态照常进 `cooldown` 第 1 档，只留 `alert_registration_failed reason=storage_error`」的失败用例，复用 `checks.record_alerts` 的 SAVEPOINT 隔离。

## 3. 验收条件 → 证据

| 票据验收条件 | 证据 |
| --- | --- |
| 由真实风控状态转换登记首次触发、转人工与稳定恢复告警，而不是根据日志文本或全表扫描猜测；探测刚通过但尚未稳定 10 分钟不冒充稳定恢复 | `_record_trigger`／`_finish_probe`／`_observing_tick` 三处同一短事务登记（代码见 §6）；`test_first_trigger_registers_one_alert_for_the_system_group`、`test_exhausted_automatic_recovery_registers_one_manual_alert`、`test_recovery_alert_only_after_ten_stable_minutes_of_real_collection`（599 秒不发、600 秒才发）、`test_observing_trigger_after_the_last_step_registers_only_the_manual_alert` |
| 复用既有 SQLite 事务发件箱和独立通知进程，状态事实与告警登记保持一致；登记故障沿用原安全处理，不把通知失败变成风控旁路 | `RiskGate._alert` → `outbox.record_alert`（同一连接、同一 `BEGIN IMMEDIATE`）＋`checks.record_alerts` 的 SAVEPOINT 与固定日志；`test_alert_registration_failure_never_becomes_a_risk_bypass`（状态照常转移，只留 `alert_registration_failed`）、`test_failed_alert_delivery_survives_a_restart_without_reregistering`（投递失败不影响状态、重启后重发同一条） |
| 沿用系统群路由、已有类别／固定原因目录扩展方式、去重和节流，不把每页 412、每档等待或每接口结果分别刷群 | 新增 3 个类别（`risk_triggered`／`risk_manual`／`risk_recovered`）与 3 个固定原因，对象统一为 `source_risk`；节流键 `(category, object)` 未改。`test_exhausted_automatic_recovery_registers_one_manual_alert`（六档失败只有两条消息）、`test_late_responses_restarts_and_repeated_triggers_merge_into_one_alert`（30 分钟内合并、超过窗口才再提醒） |
| 通知 off 不发送也不暗中改变开关；system_only 与 all 均仅按既有系统告警资格投递，风控不改变通知起点或业务消息资格 | `test_notification_off_registers_nothing_and_reopening_never_backfills`（`off` 期间 0 请求、`read_notification_switch()["state"] == "off"`、切回 `system_only` 不补发）、`test_alerts_go_only_to_the_system_group_and_leave_business_notifications_intact`（`all` 下正文变化照旧进 UP 群、告警只进系统群、同版本重复检查不新增消息）、`test_a_real_api_operation_that_meets_412_registers_the_alert_for_the_notifier` |
| 重复触发、迟到响应、重启、人工重复登记和 owner 接管不会重复产生同一生命周期告警；复用既有去重／节流语义，不新建并行投递机制 | `test_late_responses_restarts_and_repeated_triggers_merge_into_one_alert`（迟到 429、重启后的新 gate、观察期再触发均合并）、`test_owner_takeover_and_old_owner_results_register_no_extra_alert`（租约内不能双探测、接管与旧 owner 迟到结果不产生告警）、`test_exhausted_automatic_recovery_registers_one_manual_alert`（人工轮失败与重复登记不产生告警） |
| 消息只包含固定安全状态／原因及必要时间，不携带正文、完整 URL、Cookie、凭据或内部 owner／令牌；逐接口资源定位信息保留在结构化日志 | 逐字断言五字段消息（类别／对象／北京时间／固定原因／节流说明）见各用例；未改模板、未新增自由文本入口，类别与原因都是白名单，owner／轮次令牌不进快照（`test_owner_takeover_...` 只经状态机触发，消息内容仍只有固定字段） |
| 用真实状态机、临时 SQLite、实际通知领取路径及飞书传输替身验证告警闭环、失败／重启及三态开关；同时证明探测不产生动态变化／新增评论通知，正常归档通知去重和资格不退化 | 全部用例共用真实 `RiskGate`＋临时 SQLite＋真实 `Dispatcher.tick()` 领取／回写（飞书传输为 `MockTransport` 替身）；`test_a_real_check_that_meets_412_registers_the_trigger_alert`（真实采集检查链）、`test_a_real_api_operation_...`（真实 FastAPI 应用）；`test_failed_alert_delivery_survives_a_restart_without_reregistering`（失败与重启）、`test_notification_off_...`（三态）；`events(path)` 断言风控周期只留下原有 `dynamic_changed` |
| 同步系统告警及运行契约，清楚说明告警可被既有开关关闭；不新增页面、告警专用文件日志或真实飞书发送 | 契约见 §6；前端未改、未新增日志出口（仍走 `collector_event` 与既有 journald 链路）、无真实飞书调用 |

## 4. 关键设计决定

- **三个事实 → 三个类别，一个对象**：既有节流键是 `(category, object)`，而风控状态全局只有一行，因此若三个事实共用一个类别，“触发”（例如 13:00）与“稳定恢复”（观察期 600 秒后，约 13:11）会在 30 分钟窗口内被合并，恢复消息永远发不出去。改成每个生命周期事实一个类别、对象仍为唯一的 `source_risk`：消息读起来仍是“对象：source_risk”，但每个事实只按自己的窗口节流；六档等待、每类探测结果、每页 412 继续只进日志。
- **登记点就是状态转移点**：`_record_trigger`、`_finish_probe`、`_observing_tick` 各自已在同一 `with write(self.store)` 里读旧行、写新行，告警在同一事务里登记即可，不需要读日志、不需要全表扫描，也不会出现“状态提交了但告警丢了半个事实”。转移后的公开事实仍由 `public_status(row)` 给出。
- **`off` 语义交给既有登记侧**：`outbox.record_alert` 先读 `notification_gate`，`off` 直接返回 `False`，既不写事件也不写节流状态，因此关闭期间的生命周期事实天然不排队、不补发，风控也不碰开关。
- **不冒充稳定恢复、不重复事实**：恢复只在 `_observing_tick` 的 `cleared` 分支登记（探测通过只是 `observing`）；人工轮失败仍停在 `manual`，不是新事实，按 `probe_origin != manual` 排除；人工登记本身不改状态，不单独告警。
- **登记失败只丢该条告警**：复用 `checks.record_alerts`（单条 `SAVEPOINT` ＋固定 `alert_registration_failed reason=storage_error`），父事务照常提交，风控状态不会被通知存储问题回滚或旁路。
- **延迟导入**：`source` 在导入期就需要本模块的 `SourceRiskPaused`，而通知包导入 `source`；`risk` 模块级导入通知包会形成循环，因此 `_alert` 内延迟导入 `checks` 与 `notifications.outbox`（只在真正登记时解析一次）。这条依赖方向写在方法 docstring 里，避免后来者“顺手”挪回模块级。
- **无新迁移**：告警完全复用既有 `notification_events`／`notification_deliveries`／`notification_alerts`，schema 保持 v26（风险 24＋页进度 25＋观察 26），不与 08 可能取的 v27 竞争。

## 5. 未覆盖与限制

- 未访问真实飞书与真实系统群：消息结构、路由、节流与回写只按受控替身验证；真实平台限流与真实群表现为既有限制（同 08／13／14 证据）。
- 未在真实目标环境跑三进程托管：本票用真实 `Dispatcher`／`Collector`／FastAPI 应用共享同一临时 SQLite 覆盖进程内装配与独立领取路径，真实子进程三进程组合仍由 10 覆盖。
- 未验证真实 B 站 412／429 触发（不授权诱发风控），也未验证真实时钟偏差下的告警时间。
- 告警数量与真实故障量无关的“抑制”只依赖既有 30 分钟节流：窗口之外同一事实会再次提醒，这是既有系统告警语义，本票未改。
- 08 正在并行做跨进程调度：本票不改 `collector.py` 调度、不改迁移号、不加新环境变量，合入时只需保留 `risk.py` 三处登记点。

## 6. 代码与文档指针

- 修改（生产）：`risk.py`（`ALERT_OBJECT`／`ALERT_TRIGGERED`／`ALERT_MANUAL`／`ALERT_RECOVERED`、`RiskGate._alert`，以及在 `_record_trigger`、`_finish_probe`、`_observing_tick` 的短事务内登记）；`notifications/message.py`（3 个固定类别标签与 3 个固定原因短语）。
- 新增（测试）：`backend/tests/test_risk_alerts.py`（12 例，覆盖闭环、去重／迟到／重启／接管、三态开关、业务通知不受影响、投递失败重启、登记失败不旁路、真实采集与 API 入口）。
- 文档：`docs/backend/api/collector-api.md`（新增「风控生命周期系统告警（09）」）、`docs/backend/api/notification-process.md`（§3.3 类别表与判定边界）、`docs/design/bilibili-risk-control.md`（实施状态与 §5）、`backend/README.md`（系统群告警类别）、`docs/README.md`（本证据入口）。

## 7. 供 10 复用的结论

- RC-11 的实现事实：三类告警只由 `normal／observing → cooldown`、`→ manual`、`observing → normal` 三种真实转移登记；`off` 下这些事实不登记也不补发，`system_only`／`all` 只按既有系统角色资格投递；探测与观察不产生任何业务事件。
- 组合回归建议：三进程（API＋collector＋notifier）跑一次“412 → 冷却 → 探测失败六档 → 人工 → 稳定恢复”的链路时，系统群应恰好收到触发、转人工、恢复各一条（同一类别在同一 30 分钟窗口内不重复），业务群消息数量与票 09 之前一致。
- 已知抖动：`test_risk_probe.py::test_collector_run_probes_at_each_deadline_and_resumes_abandoned_work` 的既有账本顺序抖动（05 证据 §1 已记录）与本票无关，本票未改该断言；本次全量运行未复现。
