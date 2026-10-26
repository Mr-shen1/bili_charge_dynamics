# 08 系统告警闭环：实施与验收证据

对应票据：[08 系统告警闭环](../issues/08-system-alerts.md)；实施规格 [spec.md](../spec.md)；正式规则 [飞书通知需求与设计](../../../docs/design/feishu-notifications.md) §6.1；实现契约 [通知进程与事件投递](../../../docs/backend/api/notification-process.md)（§3.3 告警、§4 持久状态、§5 参数、§6 模板、§7 迁移、§8 边界）；采集侧分类见 [固定节拍采集与检查状态](../../../docs/backend/api/collector-api.md)。

结论：**票据范围（五类真实故障 → 持久系统群、同对象同类首次提醒与 30 分钟节流跨重启、未投递同类提醒合并、系统群失败不递归、固定脱敏原因）已实施并取得自动化主链与迁移证据**。真实飞书系统群投递、真实凭据失效触发、三进程托管与目标环境运行未验证；与心跳的共存隔离在本票自动化中已覆盖，三进程整体组合与交付准备仍由票据 10 收口。

## 1. 环境与命令

- 环境：Linux；Python 3.12.15（`.python-version`，`uv sync --locked`）；uv 0.12.23；pytest 8.4.2。本票无前端改动，未运行 `pnpm check`/e2e（前端整体回归由票据 10 统一）。
- 集成：分支 `feat/feishu-08` 基于 `feat/feishu-notifications`。开始时集成 tip 为 `eab38ce`（06 已合并、schema v19），完成前 `git merge --no-ff cef38ff` 并入 05（楼中楼回复通知），并按要求**协调连续版本**：05 占 v20（候选主键补所属根），**本票的告警节流表顺延为 v21**，两侧迁移与契约都保留；合并提交 `22a280d`。收尾再 `git merge --no-ff 16fc18e` 并入最新集成 tip（07 解锁记录与纯图回复缺陷记录，只动 `map.md`/`implementation-plan.md` 与测试文件空行），合并提交 `1841021`，冲突只在测试文件末尾空行处；最后一次 `git merge --no-ff e612054` 并入 05 的纯图回复占位修复（只动 `replies.py`/`outbox.py` 快照/`message.py` 文案/`storage.py` 阅读接口摘字段与文档，**schema 仍 v20**、无新增迁移），自动合并无冲突，本票的告警节流表仍顺延 v21。
- 隔离：临时 SQLite；B 站页面/detail/评论页/楼中楼页由受控字节与受控 JSON 给出；飞书在单测里是进程内 `httpx.MockTransport`；时间用受控时钟（同一时刻同时供投递 epoch 秒与采集 UTC ISO）。凭据、身份、动态、评论与正文全部虚构（`fake-system-alert-token`、`archive.example.invalid`）。未读取真实 `notifications.json`/Cookie/凭据，未向真实飞书或 B 站发请求。

```sh
# 本票新增：五类触发、节流、合并、脱敏、不递归（真实采集/归档/投递入口 + 临时 SQLite + 受控传输与时间）
uv run --no-sync python -m pytest backend/tests/test_notification_alerts.py -q
# 27 passed

# 专项与相邻回归（合并 05 之后；含本票新文件、01/04/05/06/09 主链、协议、迁移、采集与评论协议）
uv run --no-sync python -m pytest \
  backend/tests/test_notification_alerts.py backend/tests/test_notification_delivery.py \
  backend/tests/test_notification_heartbeat.py backend/tests/test_notification_process.py \
  backend/tests/test_notification_protocol.py backend/tests/test_notification_recovery.py \
  backend/tests/test_notification_recovery_processes.py backend/tests/test_notification_migration.py \
  backend/tests/test_dynamic_notifications.py backend/tests/test_root_comment_notifications.py \
  backend/tests/test_reply_notifications.py backend/tests/test_migrations.py \
  backend/tests/test_collector.py backend/tests/test_comment_transport.py \
  backend/tests/test_replies.py backend/tests/test_comment_sync_status.py -q
# 236 passed

# 后端全量回归（合并 05、schema v21）
uv run --no-sync python -m pytest backend/tests -q
# 975 passed, 3 warnings in 158.34s（并入 05 纯图回复修复 e612054 后重跑；此前 16fc18e 时为 969）
```

- 迁移号：01→v16、09→v17、04→v18、06→v19、05→v20、**本票→v21**（只新增 `notification_alerts` 节流表，不重建既有表）。
- **全量回归观察到的偶发失败（非本票回归）**：并入 `e612054` 后的一次全量运行里，`backend/tests/test_comment_count_recovery.py::test_three_targets_obey_two_sync_slots_without_stalling_checks[run]` 失败一次；该用例用 `asyncio.wait_for(..., 3)` 的墙钟超等门闩，属既有节拍敏感用例。单独连跑 8 次与该文件连跑 3 次均通过，本票的改动也不在同步并发路径上（只在同步失败时追加告警登记）。按实记录，交由票据 10 统一复核，不在本票内改它的断言。

## 2. 红绿过程（TDD）

按纵向切片逐条推进，每片先写用例再补实现。

1. **可信凭据失效**（`test_rejected_credentials_alert_only_when_credentials_were_configured`）：先写“评论计数返回 `-101` 且本次配置了来源凭据 → 一条 `credential/source_credential` 告警，只发系统群”。运行得红：`TypeError: Collector.__init__() got an unexpected keyword argument 'credentials_configured'`。补 `SourceRejected(code)`（只带受控 int）、`credential_signal()`、告警登记与模板后转绿。
2. **不冒充登录失效**（`test_anonymous_not_logged_in_*`、`test_other_business_codes_never_impersonate_credential_failure`、`test_http_unauthorized_or_forbidden_is_only_a_collection_alert`）：先写“匿名 `-101` 归 `login_required`”“`-111/-352/-401/-403/-412/-799/12002` 与 HTTP 401/403 只能是采集异常”。首轮 7 条参数化用例全红——它们当时只跑 `check_once`，而 `/x/v2/reply` 的拒绝发生在同步阶段；据此把用例改为走真实同步入口，并把分类点从“只有检查”扩展到 `sync_roots/sync_replies` 的失败观察器（`on_failure`），转绿。
3. **采集异常 vs 正常增长**（`test_check_failure_alerts_collection_while_normal_growth_alerts_nothing`）：先写“计数读取超时 → 一条 `collection` 告警；正常计数增长 + 新评论归档 → 零告警，但确实产生 `root_comment` 事件”。红在 `NameError: root_comment`（用例缺夹具导入），补齐后转绿；该用例同时守住“正常业务活动不是故障”。
4. **主循环异常**（`test_captured_loop_failure_is_persisted_before_the_process_exits`）：先写“`run()` 内捕获异常 → 退出前登记 `loop/collector_loop` 告警”。首次红在分类：`('collection', 'collector_loop')`，说明复用采集分类不足以区分类别；给 `_failure_alerts` 增加类别参数后转绿。
5. **告警登记失败只留脱敏日志**（`test_alert_registration_failure_leaves_only_a_sanitized_log`）：先写“告警事实无处可写时只有 `alert_registration_failed reason=storage_error` 日志，不吞原异常、不伪造已外发”。前两版用例从 `caplog`/`capsys`/`capfd` 都取不到记录——采集 logger `propagate=False` 且 handler 绑定了旧 stream；改为直接挂一个临时 handler 读取实际日志记录后转绿。
6. **路由缺失与错误**（`test_missing_business_route_alerts_the_affected_role_and_keeps_the_message`、`test_invalid_destination_alert_is_a_route_fact_and_repair_only_resends_that_target`）：先写“业务目标缺路由／目的地写错 → `route` 告警，业务消息仍保留，修复后只补发失败目标、不重发已成功目标”。两块都先红在 `alerts(path) == []`（当时还没有路由告警），补 `_finish(alert=...)` 同事务登记后转绿。
7. **持续投递失败**（`test_delivery_failure_threshold_alerts_only_persistent_business_failures`、`test_business_target_recovered_below_threshold_never_alerts`、`test_persistent_failure_of_a_reply_delivery_also_alerts`）：先写“同一业务目标真实失败 3 次且仍在待投递才告警；2 次后恢复不告警；恢复成功的目标不再被判持续”。红在 `NameError: ALL_WEBHOOK`（用例夹具），补齐后转绿；合并 05 后补回复类型用例，把 `BUSINESS_KINDS` 扩到 `reply_comment`（先红在只报 `all:root_comment`）。
8. **节流、合并与重启**（`test_alert_throttle_is_per_object_and_survives_restart`、`test_undelivered_alert_merges_repeats_instead_of_stacking`）：先写“首次立即、+1799 秒合并、+1800 秒再提醒、不同对象独立、重开 Store/Dispatcher 仍按持久状态节流”“系统群一直失败时一小时 12 次同类故障只留 1 条提醒”。两次被实现/夹具纠正：① 末条断言漏算“另一对象那一条”，改为按累计事件数断言；② 合并用例最初在 async 场景里调用会自行 `asyncio.run` 的 `run_check`，拆出 `check_async` 后转绿；③ 系统群失败期间接收端会收到多次**同一内容**的重试（06 已声明的外部重复语义），断言改为“告警内容去重后只剩一条”。
9. **不递归**（`test_missing_system_route_never_recurses_into_more_alerts`、`test_failing_system_group_never_generates_a_second_alert`）：先写“系统群缺配置／发送失败时不为系统目标再生成告警”。首版红在业务群也被打成持续失败（用了一个“全失败”的接收端），改成“只让系统群接收端失败”后转绿；同时断言失败的心跳记录 `failures>=1` 也不会派生新告警。
10. **脱敏**（`test_alert_message_and_queue_carry_only_fixed_sanitized_fields`）：先写“告警消息与快照不含 webhook、签名密钥、上游响应正文/异常原文”；首版红在 `assert 0 == 1`——它在同一库上第二次构造失败，但归档已完成后 `pending_comments_only` 不再重扫评论页，改用单库单次失败场景后转绿。快照字段集合同样被断言锁定为四个固定字段。
11. **与心跳隔离**（`test_alert_throttle_and_heartbeat_use_separate_state`、`test_discovery_failure_alerts_the_up_and_keeps_the_old_window`）：先写“同一小时既收到告警也收到心跳，告警 `expires_at` 为空、心跳照常去重”。红在两处：心跳查询写了不存在的 `notification_heartbeats.state` 列（改为 join 投递表），以及发现失败用例未在 recent 模式启用 UP（补齐管理 API 装配）后转绿。
12. **迁移**（`test_v20_outbox_gains_alert_throttle_state_in_place`）：先写“v20 形状（05 交付）→ v21 新增告警节流表、旧事件与投递状态不动”。临时把 `migrate_alerts`/版本上界退回 v20 运行得红：`AssertionError: assert 19 == 20`（当时断言写成 v20），恢复后转绿；合并 05 后断言统一为 v21。

## 3. 验收条件 → 证据

| 票据验收条件 | 证据（用例/产物） |
| --- | --- |
| 五类告警都有可验证触发链：可信凭据失效、采集异常、主循环异常、飞书持续投递失败、路由缺失或错误 | 凭据：`test_rejected_credentials_alert_only_when_credentials_were_configured`、`test_comment_page_rejection_is_credential_failure_through_the_sync_path`；采集异常：`test_check_failure_alerts_collection_while_normal_growth_alerts_nothing`、`test_other_business_codes_never_impersonate_credential_failure`（同步阶段 `source_rejected`）、`test_discovery_failure_alerts_the_up_and_keeps_the_old_window`；主循环：`test_captured_loop_failure_is_persisted_before_the_process_exits`；持续投递失败：`test_delivery_failure_threshold_alerts_only_persistent_business_failures`、`test_persistent_failure_of_a_reply_delivery_also_alerts`；路由：`test_missing_business_route_alerts_the_affected_role_and_keeps_the_message`、`test_invalid_destination_alert_is_a_route_fact_and_repair_only_resends_that_target`。全部经真实采集/归档/投递入口与受控接收端断言**实际发出的消息**，不是只测模板函数 |
| 普通超时或网络故障不冒充登录失效；无可信信号时保持实际错误类型；正常计数增长或采集期间新增评论不生成故障告警 | `test_anonymous_not_logged_in_is_a_collection_alert_not_credential_failure`（匿名 `-101` → `login_required`，仍是采集异常）、`test_other_business_codes_never_impersonate_credential_failure`（`-111/-352/-401/-403/-412/-799/12002` → `source_rejected`）、`test_http_unauthorized_or_forbidden_is_only_a_collection_alert`（HTTP 401/403 → `http_status`）、`test_check_failure_alerts_collection_while_normal_growth_alerts_nothing`（计数超时 → `timeout`；正常增长 + 新评论 → 零告警且有 `root_comment` 业务事件）。每个告警用例都嵌套 `FICTIONAL_UPSTREAM_BODY` 断言它不进告警 |
| 告警只发系统群，业务评论不混入系统群；消息用类别、对象、发生时间及固定脱敏原因，不含凭据、响应正文或异常原文 | `test_rejected_credentials_alert_only_when_credentials_were_configured`（`{url} == {SYSTEM_WEBHOOK}`，五行固定文本逐字断言）、`test_alert_message_and_queue_carry_only_fixed_sanitized_fields`（webhook/`open-apis`/虚构 secret/上游 message 全部零命中；快照字段恰为 `category/object/occurred_at/reason`）、全票 `assert_no_credentials` |
| 同对象同类故障首次提醒，此后每 30 分钟最多一次，跨重启保留；不同对象与不同类型分别判断 | `test_alert_throttle_is_per_object_and_survives_restart`：`13:40:00` 首条 → `+1799` 秒合并（事件数不变）→ `+1800` 秒新增 → 另一对象独立成条 → 重开 `Store`+`Dispatcher`（等价重启）后窗口内不再提醒；`test_persistent_failure_of_a_reply_delivery_also_alerts` 证明不同 `kind` 分别成条 |
| 未投递的同类提醒不每次重试/每轮采集无限生成；明确定义并验证持续投递失败的判定与合并策略，保持已确认节流上限 | `test_undelivered_alert_merges_repeats_instead_of_stacking`（系统群持续失败时一小时 12 次同类故障只留 1 个事件、内容唯一，修复后只补发这一条）；`test_delivery_failure_threshold_alerts_only_persistent_business_failures`（`failures=1/2` 不告警、`3` 才告警，只读 `failures`/`state`/`error`，不用 `attempts`）；`test_missing_system_route_never_recurses_into_more_alerts`（`attempts` 因等待配置复检增长也不伪造失败） |
| 采集或主循环可捕获异常可靠登记；不把强杀、整机离线或数据库完全不可写时的即时告警写成保证 | 采集侧：检查/同步/发现的告警与结果**同事务**登记（`record_check`/`finish_check_work`/`finish_discovery`），单条告警用 `SAVEPOINT` 隔离——`test_dynamic_notifications.py::test_rollback_of_event_and_content_leaves_no_partial_notification`、`test_root_comment_notifications.py::test_rollback_of_comment_event_leaves_no_partial_notification` 注入“投递记录写入失败”后，归档与事件仍整体回滚、告警也被回滚，主链不受牵连；主循环异常用独立短事务 `_record_loop_alert`；`test_alert_registration_failure_leaves_only_a_sanitized_log` 证明写不进时只有脱敏日志。强杀/整机离线/整库不可写的能力边界写进契约 §8 |
| 缺失或错误业务路由保留原业务消息并产生系统提醒；修复后业务补发不重置历史基线、不重发已成功目标 | `test_missing_business_route_alerts_the_affected_role_and_keeps_the_message`（`up` 已 `sent`，`all` 仍 `waiting_config/route_missing` 且不丢消息）、`test_invalid_destination_alert_is_a_route_fact_and_repair_only_resends_that_target`（`route_invalid` → 修复后 UP 群只有 1 次请求、全员群补 1 次、告警仍 1 条）；阶段/起点不重设由 06 既有进程用例继续覆盖 |
| 系统群未配置或发送失败时留本地脱敏诊断并按原任务等待/重试，不递归产生系统群投递失败告警，不转发业务群 | `test_missing_system_route_never_recurses_into_more_alerts`（系统目标 `waiting_config/route_missing`、零系统 HTTP、请求只到业务群、只有业务路由那一条告警）、`test_failing_system_group_never_generates_a_second_alert`（告警投递 `failures>=3`、心跳也失败，仍只有 1 条告警事件，`expires_at IS NULL`） |
| 不增加恢复消息、飞书图片上传降级消息、免打扰或日上限；告警退避与采集固定节拍独立 | 模板只有 5 类告警一种固定文本（无恢复/降级分支）；`test_alert_throttle_and_heartbeat_use_separate_state` 证明告警不读写心跳时段、告警不套心跳有效期；采集节拍未改（本票不改 `collector.py` 的节拍/抖动与 `PAGE_CHECK_SECONDS`，全量回归含 `test_collector_cadence`/`test_page_signal_throttle`） |
| 对五类触发、首次/边界时间、重启、重复故障和系统群失败取得受控主链证据，不仅测试一个消息格式函数 | 上述 27 条用例全部从真实入口（`Collector.check_once`/`execute_pending`/`discover_once`/`run`、`Dispatcher.tick`、`Store.record_check`/`finish_check_work`）注入故障，断言的是受控接收端**实际收到的载荷**、`notification_events`/`notification_deliveries` 状态与重启后的持久行为 |

## 4. 关键设计决定与依据

- **可信凭据失效只认一个整数 + 一个本地事实**。解析点把上游 `code` 带成 `SourceRejected` 的受控 `int`（文案保持原样，`_KNOWN_REASONS` 仍映射 `source_rejected`），分类层只在 `code == -101` 且本次启动读到来源 Cookie 时才输出 `credential_rejected`；匿名 `-101` 归 `login_required`。`-111/-352/-401/-403/-412/-799`、HTTP 401/403、超时与网络异常一律不映射——这与公开文档一致（`-352/-412` 是风控、`-403` 在 WBI 场景是签名错、`-111` 是写接口 csrf），也避免改动 `raise_for_status()` 顺序。**不新增 `nav` 探针**、不用空页启发式推断登录态。
- **同事务 + SAVEPOINT 隔离**。告警必须与失败事实同事务（否则会出现“有失败无告警”或反过来），但一条告警写不进去不能把采集/投递结果一起回滚——否则“告警设施”会成为主链的新单点。`alert_guard` 用 `SAVEPOINT`/`ROLLBACK TO` 达到“同事务、独立回滚”，失败只留 `alert_registration_failed`。01/04 的既有回滚用例因此继续通过。
- **持续失败的判定用 06 的事实，不用 `attempts`**。阈值 `failures >= 3` 且 `state='pending'`、类型属业务集合（`dynamic_changed`/`root_comment`/`reply_comment`）、角色不是 `system`；`waiting_config` 属路由问题、`sent` 属已恢复，都不判持续失败；心跳与告警自身永不派生告警（`kind` 过滤 + 角色过滤双保险）。
- **节流键是 `(category, object)`，对象是稳定业务身份**（`source_credential`、`{uid}:{dynamic_id}`、`{uid}`、`collector_loop`、`{role}:{kind}`、`{role}:{uid}:{dynamic_id}`），不含 webhook、密钥或快照。事件身份用“类别 + 节流窗口序号”再兜一层唯一约束，重启/并发同窗口不会重复登记。
- **合并优先于上限**：除了 30 分钟窗口，还要求上一条同类提醒已 `sent`/`expired`，因此任何时刻最多只有一条未投递的同对象同类提醒——系统群长期不可用时既不刷屏也不丢“还在故障”这一事实，恢复后补发的是最新一条（时间与原因取自最近一次故障）。
- **告警不参与心跳的过期规则**：告警投递 `expires_at` 恒为 `NULL`，不会被“丢弃过期心跳”的逻辑误删；同时告警节流不读写 `notification_heartbeats`，两者互不抑制。
- **迁移顺延而非并行**：05 已占 v20，本票顺延 v21，两侧迁移块都在同一事务里顺序执行（v20 重建候选表、v21 建告警表），失败随版本号整体回滚。

## 5. 未覆盖与限制（不得据此宣称完整交付）

- **真实飞书系统群未验证**：所有“发送成功/失败”都来自受控接收端；真实群、飞书侧限流与签名开关、目标机代理可达性（投递客户端 `trust_env=False`）未验证（属票据 11）。
- **真实凭据失效未被实测**：本仓监控的只读端点（`/x/v2/reply`、`/x/v2/reply/reply`、`/x/v2/reply/count`、detail/feed）在上游公开文档的 code 表里没有 `-101` 条目，`-101` 记录在需要登录的写接口。因此本票交付的是“判定与闭环 + 受控注入证据”，**不声称真实凭据失效已被观测到**；也不得为了能触发而新增 `nav` 探针或放宽 HTTP 401/403 语义（那会改变已确认的“普通失败不冒充登录失效”）。文档层面的依据与限制见共享预研 `/tmp/feishu-notifications-research/alerts-auth-signal.md` §2、§7。
- **强杀、整机离线、整库不可写不承诺即时外发**：主循环异常登记需要能写库；数据库完全不可写时只有脱敏日志，进程被 SIGKILL/整机停机期间既无告警也无补偿（与 09 心跳同一口径）。
- **整份通知配置非法时仍按启动错误退出**：此时没有可用告警通道，只能靠进程托管与日志发现（契约 §2、§8）。
- **同步侧告警按“显式失败”判定**：正文读取失败、根/回复分页失败、执行异常会告警；单纯“待同步/媒体待完成”不会——因此长期卡在媒体重试的目标不会被告警覆盖。
- **与心跳/告警的三进程整体组合、写竞争与资源测量**：由票据 10 收口；本票只验证同进程内的节流隔离。
- **告警只有一个系统群角色**：不按类别分群，也没有静默时段/日上限（正式设计要求明确不加）。

## 6. 代码、测试与文档指针

- 实现：`backend/bili_monitor/notifications/outbox.py`（`ALERT`/`BUSINESS_KINDS`/`ALERT_COOLDOWN_SECONDS`、`migrate_alerts`、`record_alert`、`alert_guard`）、`notifications/message.py`（`ALERT_LABELS`/`ALERT_REASONS`/`alert_object`/`alert_reason`/`alert_time`/`alert`）、`notifications/delivery.py`（`DELIVERY_FAILURE_THRESHOLD`、`_scan_delivery_alerts`、路由告警与 `_finish(alert=...)`、`_payload` 的 `ALERT` 分支）、`notifications/outbox.py#migrate_alerts` + `storage.py`（v21）、`collector_logging.py`（`SourceRejected`/`credential_signal`/`failure_fields(credentials_configured=)`）、`root_comments.py`/`replies.py`（解析点带出 code）、`checks.py`（`record_alerts`/`alert_epoch`，`record_check`/`finish_check_work` 的 `alerts=`）、`discovery_state.py`（`finish_discovery(alerts=)`）、`collector.py`（`_failure_alerts`、`_record_loop_alert`、`credentials_configured`）、`sync.py`/`root_comments.py`/`replies.py` 的 `on_failure` 观察器。
- 测试：`backend/tests/test_notification_alerts.py`（27 例）；迁移用例 `backend/tests/test_notification_migration.py::test_v20_outbox_gains_alert_throttle_state_in_place`；版本上界/断言更新于 `test_migrations.py`、`test_inflight_recovery.py`；共用装配的 `notification_support.deliveries/events` 现在按 `kind != 'alert'` 读取业务事实（系统告警与业务共用队列，业务断言不混入告警行）。
- 正式契约与运行说明：[通知进程与事件投递](../../../docs/backend/api/notification-process.md)（§3.3 五类告警与边界、§4 `notification_alerts`、§5 节流与阈值、§6 告警模板、§7 v21 迁移、§8 未覆盖）、[固定节拍采集与检查状态](../../../docs/backend/api/collector-api.md)（凭据相关 reason 与同事务告警登记）、[backend/README.md](../../../backend/README.md)「飞书通知进程（01、04、05、06、08、09）」、[docs/README.md](../../../docs/README.md) 索引、[正式设计](../../../docs/design/feishu-notifications.md) 状态行。
- 给票据 10 的集成入口：`outbox.record_alert`/`alert_guard`（声明式登记，无需扫描日志）、`Dispatcher.tick()`（心跳 → 投递 → 告警扫描的顺序）、`Collector._record_loop_alert`、`notification_alerts` 表（节流状态独立于 `notification_heartbeats`）。10 只需验证三进程托管下“同小时既告警又心跳”的组合与资源占用，无需重做五类触发。
