# 06 双群独立投递与故障恢复：实施与验收证据

对应票据：[06 双群独立投递与故障恢复](../issues/06-delivery-routing-recovery.md)；实施规格 [spec.md](../spec.md)；正式规则 [飞书通知需求与设计](../../../docs/design/feishu-notifications.md)；实现契约 [通知进程与事件投递](../../../docs/backend/api/notification-process.md)；上游证据 [01 动态变化闭环](01-dynamic-change-notification.md)、[04 一级评论通知闭环](04-root-comment-notification.md)、[09 小时心跳](09-hourly-heartbeat.md)。

结论：**票据范围（路由覆盖与错项目的地隔离、逐目标故障恢复、失败事实、到期索引与租约、真实进程终止/重启、跨进程慢请求与写锁、可选签名与脱敏）已实施并取得自动化主链、隔离进程与迁移证据**。真实飞书群投递、目标环境代理可达性、三进程整体写竞争与部署未验证；本票未修改采集节拍与前端，前端整体回归留票据 10。

## 1. 环境与命令

- 环境：Linux；Python 3.12.15（`.python-version`，`uv sync --locked`）；uv 0.12.23；Node 未参与本票。
- 集成：分支 `feat/feishu-06` 基于 `feat/feishu-notifications`；完成前已 merge 集成 tip（`9b868f1`，含 02/03 精确入口返回恢复修复），本文件所有数字均在合并后重跑。迁移号：01→v16、09→v17、04→v18，**本票顺延为 v19**（只补 `notification_deliveries.failures/last_failed_at` 与两条索引，不重建表）。
- 隔离：临时 SQLite；B 站页面/详情/评论页由受控字节替身给出；飞书在单测里是进程内 `httpx.MockTransport`，在进程级用例里是**本机 `ThreadingHTTPServer` 真实 HTTP 服务**（通知进程是独立子进程，不是进程内替身）；身份、动态、评论、正文与凭据全部是虚构值（`fake-up-token`、`FICTIONAL_SECRET_SIGNING_06`、`https://archive.example.invalid`）。未读取真实 `notifications.json`/Cookie/凭据，未向真实飞书或 B 站发请求。

```sh
# 本票新增：路由覆盖/错项/失败事实/领取索引/隔离/不确定重试/签名（真实归档链 + 临时 SQLite + 受控飞书）
uv run --no-sync python -m pytest backend/tests/test_notification_recovery.py -q
# 11 passed

# 本票新增：真实子进程终止/重启、跨进程慢请求与写锁、路由修复后补发（本机 HTTP 服务）
uv run --no-sync python -m pytest backend/tests/test_notification_recovery_processes.py -q
# 3 passed

# 专项与相邻回归（合并集成 tip 后；含本票两个新文件、01/04/09 主链、协议、迁移与既有迁移用例）
uv run --no-sync python -m pytest \
  backend/tests/test_notification_recovery.py backend/tests/test_notification_recovery_processes.py \
  backend/tests/test_notification_process.py backend/tests/test_notification_delivery.py \
  backend/tests/test_notification_protocol.py backend/tests/test_notification_migration.py \
  backend/tests/test_notification_heartbeat.py backend/tests/test_root_comment_notifications.py \
  backend/tests/test_dynamic_notifications.py backend/tests/test_migrations.py -q
# 128 passed

# 后端全量回归（合并集成 tip 后）
uv run --no-sync python -m pytest backend/tests -q
# 928 passed, 3 warnings in 154.86s
```

- 未运行：前端任何命令（本票自身没有前端改动；分支里出现的 `frontend/` 差异全部来自合并的 02/03 精确入口返回恢复修复）、`frontend` e2e、真实飞书/三进程部署。前端整体回归与三进程交付准备按票据 10 统一执行。
- 时间：一秒轮询、退避、等待配置复检、租约全部用受控时钟（`Clock`）或真实子进程的墙钟短租约（`BILI_NOTIFIER_LEASE_SECONDS=2`），没有长时间真实 sleep 制造“偶然绿”。

## 2. 红绿过程（TDD）

1. **路由覆盖与错项目的地**（`test_notification_recovery.py`）：先写“动态覆盖只替换 `up` 角色、`all` 继承 UP 默认”与“单个目的地写错只让该目标等配置”。运行得红：`NotificationConfigError: Invalid notification destination`——整份配置因一个坏条目被拒绝，两个群一起停摆。改为**条目级容错**（坏地址/坏密钥/非对象条目 → 该目的地不可用、其它目的地照常）后转绿，并区分 `route_missing`（角色没配）与 `route_invalid`（引用写错或目的地不可用）。
2. **失败事实**（同文件 `test_waiting_config_rechecks_never_count_as_delivery_failures`）：先写“`attempts` 不能当失败次数，失败次数只在真实失败时增长”。运行得红：无 `failures`/`last_failed_at` 列。实现 v19 迁移 + `finish_delivery(failure=...)` + `outbox.delivery_failures` 后转绿；期间被测试纠正一处：断言“已成功目标 `attempts` 也 +1”是错的，已成功目标根本不会被重新领取，改为断言 `attempts` 保持 1、`sent_at` 不变。
3. **领取索引**（`test_claim_uses_due_and_lease_indexes_with_a_bounded_batch`）：先写 `EXPLAIN QUERY PLAN` 必须命中 `notification_due` / `notification_lease`。运行得红：`AttributeError: module ... has no attribute 'DUE_QUERY'`。把带 `OR` 的单条领取拆成两条索引查询（到期 / 过期租约）再合并排序、限批量后转绿。
4. **隔离与不确定重试**（`test_blocked_target_...`、`test_failed_target_backoff_...`、`test_lost_success_response_...`）：这三条验证的是既有语义，先跑即绿——说明 01/04 已把“逐目标独立”做对；本票用它们锁定“一群阻塞时另一群同一轮完成”“失败退避不阻塞新事件”“响应丢失后重试会造成外部重复”三条事实，避免后续票据改动把它们退回去。
5. **签名与脱敏**（`test_notification_protocol.py::test_signature_follows_the_official_hmac_construction`、`test_notification_recovery.py::test_signing_is_assembled_at_send_time...`）：先写官方构造 `base64(HMAC-SHA256(key="{ts}\n{secret}", msg=""))` 与“队列/日志/repr 无密钥”。运行得红：`message.signature` 不存在，且旧配置测试要求“坏 webhook 必须整体报错”（与本票整改方向冲突）。实现签名组装与条目级容错后转绿，并把那条旧断言改成新契约：结构错误仍拒绝启动，单条目错误只暂停该目标。
6. **真实进程**（`test_notification_recovery_processes.py`）：先写“SIGKILL 后重启恢复租约且已成功目标不重发”。第一次跑红在 `assert (all.attempts, ...) == (2, 0)`——被杀的领取没有回写，`attempts` 只统计已完成回写，因此重启恢复成功后是 1；据此把断言改成“`attempts`=1（被杀那次无回写）、`failures`=0（租约恢复不是投递失败）”，并在证据里写明这层语义。第二次跑又红在超时：接收端仍阻塞，恢复后的请求等满 10 秒超时；改为重启前放行接收端后转绿，同时证实“被杀那次请求已被接收端收到、恢复后重发＝外部可能重复”。

## 3. 验收条件 → 证据

| 票据验收条件 | 证据（用例/产物） |
| --- | --- |
| 每 UP 默认双群及动态对相应角色的覆盖优先级正确；未覆盖角色继承 UP 默认，系统群不充当业务后备 | `test_dynamic_override_applies_per_role_while_other_roles_inherit_up_defaults`（动态只覆盖 `up`，`all` 仍用 UP 默认，系统群零命中）、`test_missing_business_route_never_falls_back_to_the_system_room`（业务角色全缺时两个目标都 `waiting_config/route_missing`，系统群不顶位）；路由矩阵本身由 04 的 `test_routing_uses_dynamic_owner_uid_and_never_the_system_room` 锁定 |
| 逐目标保存角色/路由引用和投递结果，队列不复制 Webhook/签名密钥；消息快照在等待及重试期间保持不变 | `test_broken_destination_pauses_only_that_target_and_repair_sends_only_it`（等待→修复后快照仍是 `860001`/`虚构评论`）、`test_signing_is_assembled_at_send_time_and_never_enters_the_queue`（`assert_no_credentials` 扫 `notification_events`/`notification_deliveries`，密钥与 webhook token 零命中）、`test_killed_process...`（重启后快照不变）。裁决：队列只存目标角色（`up`/`all`/`system`），实际地址与密钥在发送时由服务端配置解析——与 04 的“链接基址发送时读取”一致，不在队列里留配置副本 |
| 缺失或错误路由只暂停受影响目标，其他群仍发送；暂停消息可持久保留，不每秒执行无效 HTTP、不丢弃、不转群 | `test_broken_destination_pauses_only_that_target_and_repair_sends_only_it`（`up` 已 `sent`、`all` 为 `waiting_config/route_invalid`，复检间隔 60 秒）、`test_wrong_destination_waits_then_repair_after_restart_only_sends_that_target`（真实进程：坏地址期间接收端零请求、记录持久保留） |
| 明确并验证配置加载、校验与修复后生效流程；补配后只恢复对应待发目标，不重置起点、不重新推送历史、不重发已成功目标，不要求额外热更新或 UI | `test_wrong_destination_waits_then_repair_after_restart_only_sends_that_target`（改文件+重启：只补发 `all`，`up` 仍 1 次请求；`notification_phases` 的 `token`/`comment_started_at` 不变；事件数仍是 1）、01 既有 `test_process_keeps_message_waiting_for_missing_route_then_delivers`（缺角色→修复→补发）。修复流程写进契约 §2（启动即复检、无热更新、整文件非法仍退出） |
| 一群成功另一群失败后仅后者重试；不同目标的故障或退避不造成所有目标全局阻塞 | `test_blocked_target_does_not_block_the_other_target_in_the_same_round`（`up` 请求阻塞时 `all` 已 `sent`）、`test_failed_target_backoff_does_not_hold_back_newer_deliveries`（旧记录退避期间新事件立刻投递）、`test_killed_process_recovers_lease_and_keeps_the_successful_target`（`up` 1 次成功不再发，`all` 重发） |
| HTTP 成功但飞书业务失败不标成功；网络超时、限流及业务错误使用经协议核验的分类和有限退避，保存下次尝试时间，不修改采集节拍 | `test_waiting_config_rechecks_never_count_as_delivery_failures`（`{"code":9499}` → `pending/platform_rejected/failures=1`，`due_at=now+2s`）、01 既有 429 + `x-ogw-ratelimit-reset` 用例、`test_business_rate_limit_code_and_signature_failure_are_classified`（HTTP 200 的 `11232`→`rate_limited` 60 秒、`19021`→`platform_rejected`、`{}`→失败）、`test_lost_success_response_...`（`ReadTimeout`→`timeout` 退避 2 秒）。采集节拍未改（本票未触碰 `collector.py`/`checks.py`，`test_collector_cadence`/`test_page_signal_throttle` 在全量回归中通过） |
| 默认每秒通过到期索引进行有限批量领取；持久领取凭证和有效期支持中断/过期恢复，失效执行的迟到成功或失败不能覆盖新领取结果 | `test_claim_uses_due_and_lease_indexes_with_a_bounded_batch`（`EXPLAIN QUERY PLAN` 命中两条索引、批量 2 只领 2 条）、`test_lease_override_is_validated_and_defaults_to_the_published_value`（默认租约仍 30 秒，旋钮只接受正数）、01 既有 `test_expired_lease_is_recovered_and_stale_completion_is_rejected`（stale token 回写被拒）、`test_killed_process_recovers_lease_and_keeps_the_successful_target`（SIGKILL 后租约过期由新进程恢复） |
| 正式投递保持单实例约束，额外启动不得造成未经控制的重复消费；从真实进程终止后恢复，已成功目标保持成功 | 01 既有 `test_notification_process_delivers_once_and_survives_restart`（第二个进程非 0 退出、`Notifier already running`；正常重启不重发）、`test_killed_process_recovers_lease_and_keeps_the_successful_target`（真实 SIGKILL → 重启 → 只补未完成目标） |
| 外部已接受但成功响应丢失时允许不确定重试，并在证据中说明可能重复；不能以内部去重宣称飞书端绝对一次 | `test_lost_success_response_is_retried_and_may_duplicate_externally`（接收端实际收到 2 次同目标请求，事件仍只有 1 条）、`test_killed_process...`（被杀那次请求已被接收端收到，恢复后再发一次）。契约 §6/§8 明确不承诺飞书端绝对一次 |
| 飞书慢请求或等待退避不持有 SQLite 写事务；阻塞发送期间另一路实际数据库提交可以完成，API 和采集不执行飞书网络请求 | `test_slow_feishu_request_never_holds_the_write_lock_for_another_process`（通知子进程阻塞在真实 HTTP 时，另一个 Python 子进程 `BEGIN IMMEDIATE` 提交 < 1 秒完成；记录仍是 `inflight`，说明回写不在网络期间）、单测层 `test_feishu_request_does_not_hold_a_database_write_transaction`、`test_api_and_collector_never_start_the_notification_process`（导入 app/collector 不加载 `notifier` 进程入口；归档只留 `pending`） |
| 稳定事件身份、候选转事件和逐群投递状态跨重开保持，不全表扫描评论来补偿队列问题；失败不改变归档 checkpoint | 本票进程用例重启后事件数仍为 1、逐目标状态保持；领取只查队列两条索引（见上一行），不读评论表；`test_broken_destination...` 与 `test_slow_feishu_request...` 都断言 `Store.read_archive` 与投递前相等；候选转事件与跨重开由 04 既有 `test_missing_identity_or_time_is_held_as_candidate_and_completed_atomically` 覆盖 |
| 配置、API、前端产物、错误、日志和消息快照无凭据泄漏；故障样本使用虚构内容，路由修复测试不操作真实机器人 | `test_signing_is_assembled_at_send_time_and_never_enters_the_queue`（密钥不在队列、`repr`、通知日志记录中）、`test_wrong_destination...`（两个进程日志都不含 webhook token、`open-apis` 路径）、01 既有 `assert_no_credentials` 与进程日志脱敏用例；全部故障样本是虚构正文与虚构凭据，接收端是本机替身 |

## 4. 关键设计决定与依据

- **条目级配置容错，结构级仍拒绝启动**。依据“缺失或错误路由只暂停受影响目标，其他群仍发送”（票据条件 3）与设计 §2.2。`webhook` 非 `http(s)`、`secret` 非非空字符串、条目非对象 → 该目的地不可用（`route_invalid`）；引用指向不存在的目的地也是 `route_invalid`；角色本身没配才 `route_missing`。整份 JSON 不可解析、`base_url` 非法、`ups`/`dynamics`/`destinations` 结构非法仍让进程退出——这类错误没有可隔离的“单个目标”，且启动失败没有告警通道（属 08/10 边界，已写进契约 §2）。
- **`failures`/`last_failed_at` 与 `attempts` 分开**。`attempts` 从 01 起就是“每次回写 +1”，含等待配置复检、过期、租约恢复，直接拿它判“持续投递失败”会把缺群配置刷成故障告警（见 04 证据 §5 的提醒）。本票只增加事实，不实现阈值：`failures` 在真实失败（网络异常/超时/HTTP 失败/业务失败/限流/缺模板）时 +1 并写 `last_failed_at`；成功、等待配置、过期都不加。旧库升级不倒推历史 `attempts`（旧记录 `failures=0`）。
- **领取拆两条索引查询**。原 `WHERE (state IN (…) AND due_at <= ?) OR (state = ? AND lease_until <= ?)` 让 `EXPLAIN QUERY PLAN` 无法稳定用上 `notification_due`/`notification_lease`；拆成 `DUE_QUERY` + `LEASE_QUERY` 后两条各自命中索引，再合并按 `(due_at, id)` 排序、`LIMIT batch`。批量、租约、fencing 语义不变（既有 stale-token 用例与进程用例都通过）。
- **租约可调但默认不变**：`BILI_NOTIFIER_LEASE_SECONDS`（必须 > 0，且应大于 10 秒请求超时）只影响领取有效期，不改轮询、退避与采集节拍。加它是为了真实进程用例能在数秒内复现“进程被杀→租约过期→恢复”，同时给慢网络一个不必改代码的运维旋钮；默认仍是 30 秒。
- **可选签名只在外发组装**。官方签名 `base64(HMAC-SHA256(key="{timestamp}\n{secret}", msg=""))`、`timestamp`/`sign` 加在请求体外层、时间戳 1 小时内有效；因此每次重试都必须重算，密钥不能进快照——队列里没有 `secret` 列，`repr(config)` 隐藏 `destinations`，日志字段只允许固定枚举。未配置 `secret` 时载荷与原来逐字一致（用例断言）。
- **队列只存目标角色，不存路由引用副本**。设计 §4.2 要求“角色/路由引用”，本票按“角色 + 发送时由服务端配置解析”落地（与 04 的链接基址裁决一致）：配置改了哪份凭据不需要回迁队列，也不会在队列里留下过期地址副本；代价是“当初指向哪个目的地”不可追溯，需要追溯时看进程日志里的 `role`/`reason`。此裁决已写入契约 §2。

## 5. 给票据 08 的可用故障事实契约

只读接口（`backend/bili_monitor/notifications/outbox.py`，不发告警、不做节流）：

```python
outbox.delivery_failures(connection, limit=50)
# → [{role, kind, uid, dynamic_id, state, error, failures, last_failed_at}, ...]
#   只返回 failures > 0 的逐目标记录，按 last_failed_at 倒序
```

语义（08 必须按这些事实判定，不能反推 `attempts`）：

| 字段 | 含义 | 典型取值 |
| --- | --- | --- |
| `state` | 该目标当前状态 | `pending`（退避中）/`waiting_config`（等配置）/`inflight`（已领取）/`sent`/`expired` |
| `error` | 最近一次结果的固定分类 | `timeout`/`network_error`/`internal_error`/`http_error`/`invalid_response`/`platform_rejected`/`rate_limited`/`unsupported_kind`/`route_missing`/`route_invalid`/`expired` |
| `failures` | 真实外部投递失败次数（单调不减，成功不清零） | 0 起的整数 |
| `last_failed_at` | 最近一次真实失败时间（epoch 秒） | 失败过才有值 |

边界与不含项：不含 webhook、签名密钥、消息快照或响应原文；`waiting_config` 复检只增 `attempts`，不会伪造 `failures`；心跳与业务消息共用同一张投递表，08 需要按 `kind` 过滤（`heartbeat` 与业务 `dynamic_changed`/`root_comment`）；`failures>0` 且 `state='sent'` 是“曾经失败但已恢复”，08 可自行决定是否提醒。阈值、30 分钟节流、系统群发送与“系统群失败不递归”仍属票据 08。

## 6. 未覆盖与限制（不得据此宣称完整交付）

- **真实飞书群投递未验证**：所有“发送成功/失败”都是受控接收端；真实群、飞书侧签名开关、代理可达性未验证。注意 `Dispatcher` 的 `httpx.AsyncClient` 是 `trust_env=False`（与 `backend/README.md` 传输边界一致），因此目标机若必须经代理访问 `open.feishu.cn`，当前实现不会走代理——这是既有裁决，需在票据 10/11 前确认。
- **三进程整体写竞争未测**：本票只测“通知进程 vs 另一个真实进程的一次写事务”。API＋collector＋notifier 同时写同一 SQLite 的竞争与吞吐属票据 10。
- **整份配置非法仍会退出**：启动失败时没有告警通道（08 无法对“文件本身坏了”发告警），运维只能靠进程托管与日志发现。
- **无热更新**：运行中改配置文件不生效，必须重启；`--once` 不做启动时的等待配置复检。
- **前端与部署未跑**：本票没有前端改动，未运行 `pnpm check`/e2e；证据里的链接形状沿用 04/02 的 `/dynamics/{id}/comments/{rootId}/locate`。
- **可能重复**：外部已接受但响应丢失时按失败重试，飞书端可能出现重复消息；内部事件与逐目标状态仍幂等。
- **`attempts` 语义**：只统计已完成回写；被 SIGKILL 打断的领取不留 `attempts` 增量，所以不能用 `attempts` 数“试过几次”。

## 7. 代码、测试与文档指针

- 实现：`backend/bili_monitor/notifications/config.py`（条目级容错、`route_error`、`secret`）、`notifications/message.py`（`signature`/`signed`、`19021`/限流码分类）、`notifications/delivery.py`（`route_invalid` 分支、签名组装、`failure` 标记）、`notifications/outbox.py`（`migrate_delivery_facts`、`finish_delivery(failure=)`、`delivery_failures`、`DUE_QUERY`/`LEASE_QUERY`）、`backend/bili_monitor/notifier.py`（`BILI_NOTIFIER_LEASE_SECONDS`）、`backend/bili_monitor/storage.py`（`<19` 迁移与 `user_version = 19`）。
- 测试：`backend/tests/test_notification_recovery.py`、`backend/tests/test_notification_recovery_processes.py`、`backend/tests/notification_process_support.py`（跨进程接收端/子进程装配，01 的进程测试同用）、`test_notification_protocol.py`（签名与分类）、`test_notification_migration.py`（v19 升级不倒退失败次数）。
- 正式契约：[通知进程与事件投递](../../../docs/backend/api/notification-process.md)（§1 进程、§2 配置与修复流程、§4 失败事实、§5 参数、§6 协议与签名、§7 迁移、§8 边界）；运行入口见 [backend/README.md](../../../backend/README.md)「飞书通知进程（01、04、06、09）」；索引见 [docs/README.md](../../../docs/README.md)。
- 官方协议核验（2026-01 复核，来源为飞书开放平台文档）：自定义机器人使用指南（签名校验算法、`timestamp`/`sign`、`19021`、请求体上限 20 KB）、频率控制指南（HTTP 429、`x-ogw-ratelimit-reset`、自定义机器人 100 次/分钟、5 次/秒、`11232`/`11233`/`230020`/`99991400`）。
