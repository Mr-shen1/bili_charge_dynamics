# 09：风控生命周期系统告警

Status: resolved

**What to build:** 系统群收到首次风控、自动恢复耗尽转人工及稳定恢复等关键生命周期告警；逐页及逐接口细节留在日志，告警遵守已有开关、去重和节流，不改变业务通知。

**Blocked by:** 05 — 恢复观察期与人工探测。

## 验收标准

- [x] 由真实风控状态转换登记首次触发、转人工与稳定恢复告警，而不是根据日志文本或全表扫描猜测；探测刚通过但尚未稳定 10 分钟不冒充稳定恢复。证据：`_record_trigger`／`_finish_probe`／`_observing_tick` 的同一短事务内登记；`test_first_trigger_registers_one_alert_for_the_system_group`、`test_exhausted_automatic_recovery_registers_one_manual_alert`、`test_recovery_alert_only_after_ten_stable_minutes_of_real_collection`（599 秒不发、600 秒才发）、`test_observing_trigger_after_the_last_step_registers_only_the_manual_alert`。
- [x] 复用既有 SQLite 事务发件箱和独立通知进程，状态事实与告警登记保持一致；登记故障沿用原安全处理，不把通知失败变成风控旁路。证据：`RiskGate._alert` → `outbox.record_alert`（同一连接、同一 `BEGIN IMMEDIATE`）＋ `checks.record_alerts` 的 SAVEPOINT 与固定日志；`test_alert_registration_failure_never_becomes_a_risk_bypass`（DROP 告警表后状态照常进 `cooldown`，只留 `alert_registration_failed reason=storage_error`）、`test_failed_alert_delivery_survives_a_restart_without_reregistering`（投递失败/重启不影响状态，重发同一条）。
- [x] 沿用系统群路由、已有类别／固定原因目录扩展方式、去重和节流，不把每页 412、每档等待或每接口结果分别刷群。证据：新增 3 个类别（`risk_triggered`／`risk_manual`／`risk_recovered`）与 3 个固定原因，对象统一 `source_risk`，节流键 `(category, object)` 未改；`test_exhausted_automatic_recovery_registers_one_manual_alert`（六档失败只有“触发＋转人工”两条）、`test_late_responses_restarts_and_repeated_triggers_merge_into_one_alert`（30 分钟内合并、超窗才再提醒）。
- [x] 通知 off 不发送也不暗中改变开关；system_only 与 all 均仅按既有系统告警资格投递，风控不改变通知起点或业务消息资格。证据：`test_notification_off_registers_nothing_and_reopening_never_backfills`（`off` 期间 0 请求、开关仍为 `off`、切回 `system_only` 不补发）、`test_alerts_go_only_to_the_system_group_and_leave_business_notifications_intact`（`all` 下正文变化照旧进 UP 群、告警只进系统群、同版本重复检查不新增消息）、`test_a_real_api_operation_that_meets_412_registers_the_alert_for_the_notifier`。
- [x] 重复触发、迟到响应、重启、人工重复登记和 owner 接管不会重复产生同一生命周期告警；复用既有去重／节流语义，不新建并行投递机制。证据：`test_late_responses_restarts_and_repeated_triggers_merge_into_one_alert`、`test_owner_takeover_and_old_owner_results_register_no_extra_alert`、`test_exhausted_automatic_recovery_registers_one_manual_alert`（人工轮失败与重复登记不产生告警）。
- [x] 消息只包含固定安全状态／原因及必要时间，不携带正文、完整 URL、Cookie、凭据或内部 owner／令牌；逐接口资源定位信息保留在结构化日志。证据：各用例逐字断言五字段消息（类别／对象／北京时间／固定原因／节流说明），未改消息模板、未新增自由文本入口；owner 与轮次令牌不进快照。
- [x] 用真实状态机、临时 SQLite、实际通知领取路径及飞书传输替身验证告警闭环、失败／重启及三态开关；同时证明探测不产生动态变化／新增评论通知，正常归档通知去重和资格不退化。证据：`backend/tests/test_risk_alerts.py`（12 例，真实 `RiskGate`＋临时 SQLite＋真实 `Dispatcher.tick()`＋`Collector.check_once`／真实 FastAPI 应用，飞书为 `MockTransport` 替身；`events()` 断言风控周期只留原有 `dynamic_changed`）。
- [x] 同步系统告警及运行契约，清楚说明告警可被既有开关关闭；不新增页面、告警专用文件日志或真实飞书发送。证据：[采集契约](../../../docs/backend/api/collector-api.md#风控生命周期系统告警09)、[通知契约](../../../docs/backend/api/notification-process.md#33-系统告警0809)、[正式设计 §5](../../../docs/design/bilibili-risk-control.md)、[后端 README](../../../backend/README.md)；前端未改，日志仍走既有 journald 链路。

## 验证范围

主要完成 RC-11，与 05 的稳定恢复事实联动；不依赖根／回复续采和公平调度的实现细节。

## Answer

风控三个生命周期事实各占一个新告警类别（`risk_triggered`／`risk_manual`／`risk_recovered`），对象统一为唯一的全局保护状态 `source_risk`，原因分别是 `risk_cooldown`／`risk_manual_wait`／`risk_stable`。之所以“一个事实一个类别”，是因为既有节流键是 `(category, object)`：若三者共用一个类别，13:00 的触发提醒会把 11 分钟后（600 秒观察期）的稳定恢复合并掉，恢复消息永远发不出去；分开之后消息仍是“对象：source_risk”，但每个事实只按自己的 30 分钟窗口节流。

登记点就是状态转移点：`_record_trigger`（`normal`／`observing` → `cooldown` 记触发；观察期第六档后直接转人工的一次转移只记转人工）、`_finish_probe`（`probe_origin != manual` 且进入人工态记转人工）、`_observing_tick`（`cleared` 分支记稳定恢复）。三处本来就在同一 `with write(self.store)` 里读旧行写新行，告警在该事务内用 `outbox.record_alert` 登记，复用 `checks.record_alerts` 的单条 SAVEPOINT：写不进只丢这条告警并留 `alert_registration_failed`，状态转移照常提交。`off` 时既有登记侧直接返回不登记，因此关闭期间不排队也不补发，风控也不改开关。每档等待、每类探测结果、每页 412、迟到响应、接管与人工重复登记都不产生告警。

未新增迁移（schema 仍 v26）、未新增环境变量、未改调度与前端。未做：真实飞书与真实系统群验证、真实三进程托管组合（属 10）、真实 B 站 412 复现。见[证据](../evidence/09-risk-system-alerts.md)。

## Comments

- 领取并按 TDD 纵向切片实施（Status: ready-for-agent → claimed → resolved）。新增 12 例测试（`backend/tests/test_risk_alerts.py`）；票范围 12 passed、风控与通知相关回归 17 个文件 157 passed、全量后端 1200 passed（基线 `4be7824` 上 1188）。红：把 `risk.py`／`message.py` 还原到 `4be7824` 后同一命令 12 failed。
- 提交与集成：实现提交 `feat(collector,notifications): 风控生命周期系统告警`，契约与证据提交 `docs(collector,notifications): 09 告警契约与验收证据`；交付前按协调把 `spec/bilibili-risk-control` 最新 tip 真实合入本工作树并跑 `git merge-base --is-ancestor spec/bilibili-risk-control HEAD`（见证据 §1）。
- 跨票影响：① 本票只在 `risk.py` 三处转移点加一行登记与一个 `_alert` 辅助，不改状态机语义、不改 `public_status` 形状；② 不改 `collector.py` 调度、不改迁移号，08 若取 v27 与本票无冲突；③ 新增的 3 个类别只影响 `message.py` 的白名单与 `notification_alerts` 行，既有 5 类系统告警行为不变。
- 依赖方向：`risk` 不能在模块级导入通知包（`source` 在导入期需要 `SourceRiskPaused`，通知包又导入 `source`），`_alert` 内延迟导入并在 docstring 说明。
- 环境限制：本工作树无 `.codegraph/` 索引，探索按 `docs/agents/codegraph.md` 回退到源码阅读与 grep。
