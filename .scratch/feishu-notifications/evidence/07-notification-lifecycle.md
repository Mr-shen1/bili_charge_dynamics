# 07 停用、重纳入与在途通知：实施与验收证据

对应票据：[07 停用、重纳入与在途通知](../issues/07-notification-lifecycle.md)；实施规格 [spec.md](../spec.md)（§3 阶段/起点/去重、§4 持久与原子、§6 领取投递）；正式规则 [飞书通知需求与设计](../../../docs/design/feishu-notifications.md)（§3.4 停用/重纳入/进程重启、§4 发件箱、§7 FS-AC-06/07）；实现契约 [通知进程与事件投递](../../../docs/backend/api/notification-process.md)（§3.4 生命周期新增）；上游证据 [01 动态变化闭环](01-dynamic-change-notification.md)、[04 一级评论通知闭环](04-root-comment-notification.md)、[05 楼中楼回复通知闭环](05-reply-notification.md)、[06 双群独立投递与故障恢复](06-delivery-routing-recovery.md)、[08 系统告警闭环](08-system-alerts.md)。

结论：**票据范围的纵向生命周期矩阵（5 种停止原因 × 正文/一级评论/回复 + 候选变体）、重新入选与重启的区分、已入队消息在停止/删配置后的投递、旧候选不越阶段与新阶段同秒边界都已取得自动化与真实子进程证据**。本轮**没有发现需要修改产品实现的缺口**：01/04/05 已把阶段绑定（`notification_body_claims` generation → phase）做对，07 用矩阵把这些既有行为锁成回归证据，并用四处临时反向修改（mutation）证明这些用例真的能红（见 §2）。真实飞书群、飞书内置浏览器/手机、三进程托管与目标环境运行**未验证**（票据 10/11，需另行授权）。

## 1. 环境、基线与命令

- 环境：Linux；uv 0.12.23（`uv sync --locked`）；Python 3.12.15；pytest 8.4.2。本票无前端改动，未运行 Node/pnpm 命令。
- 分支与集成：工作树 `/tmp/feishu-worktrees/07`，分支 `feat/feishu-07`，基于 `feat/feishu-notifications`；开工 tip `2ccd677`（05 纯图回复占位修复合并）。开工后先把集成 tip 合并进来：`9296cff`（08 系统告警闭环 v21 + 合并安全记录），合并提交 `ed8df28`（`merge(feishu): 并入集成 tip 9296cff（08 告警 v21 与合并安全记录）`）。全部数字在合并后重跑。
- schema：`user_version = 21`（08 的 `notification_alerts` 与最新 `attempts/failures`、v20 候选主键都在）。**本票没有新增迁移、没有改表结构**，08 的告警事实与 05 的候选 v20 形态都保留。
- 隔离：临时 SQLite；B 站页面/detail/评论页/楼中楼页与 feed 由受控字节替身给出；飞书在单测里是进程内 `httpx.MockTransport`，跨进程用例是本机 `ThreadingHTTPServer` 真实 HTTP 服务 + 真实通知子进程（复用 06 的 `notification_process_support`）。管理操作全部走真实 HTTP 入口（PATCH/DELETE 监控与目标、`POST /api/sync/initial`、发现流程），没有直接改测试数据库绕过生命周期。身份、动态、评论、正文与凭据全部虚构（`fake-up-token`、`https://archive.example.invalid`）；未读取真实 `notifications.json`/Cookie/凭据，未向真实飞书或 B 站发请求，未推送、未部署。

```sh
# 本票新增：生命周期矩阵 + 队列/候选/重启（真实归档链 + 真实管理/发现入口 + 临时 SQLite + 受控飞书）
uv run --no-sync python -m pytest backend/tests/test_notification_lifecycle.py -q
# 36 passed

# 本票新增：真实通知子进程重启 vs 重新启用（本机受控 HTTP 接收端）
uv run --no-sync python -m pytest backend/tests/test_notification_lifecycle_processes.py -q
# 2 passed

# 专项与相邻回归（本票两个新文件 + 01/04/05/06/08/09 主链 + 迁移 + 在途/近期窗口/管理/集成归档）
uv run --no-sync python -m pytest \
  backend/tests/test_notification_lifecycle.py backend/tests/test_notification_lifecycle_processes.py \
  backend/tests/test_dynamic_notifications.py backend/tests/test_notification_process.py \
  backend/tests/test_root_comment_notifications.py backend/tests/test_reply_notifications.py \
  backend/tests/test_reply_location.py backend/tests/test_replies.py \
  backend/tests/test_notification_recovery.py backend/tests/test_notification_recovery_processes.py \
  backend/tests/test_notification_delivery.py backend/tests/test_notification_protocol.py \
  backend/tests/test_notification_heartbeat.py backend/tests/test_notification_alerts.py \
  backend/tests/test_notification_migration.py backend/tests/test_migrations.py \
  backend/tests/test_inflight_lifecycle.py backend/tests/test_inflight_recovery.py \
  backend/tests/test_recent_window_lifecycle.py backend/tests/test_management.py \
  backend/tests/test_integrated_archive_lifecycle.py -q
# 497 passed, 1 warning in 80.29s
```

- 未运行（按票据要求，避免重复全量；10 统一最终门槛）：后端全量、前端 `pnpm check`/e2e/`check:dist`、真实飞书群、飞书内置浏览器/手机、三进程整体托管与部署。08 证据已记录“既有 3 秒墙钟并发用例偶发”，本票没有删除或放宽该断言，交给 10 统一复核。
- 时间：门闩用 `asyncio.Event` 控制提交顺序；退避/等待配置复检用受控 `Clock`；只有两处“对齐到下一秒”的短等待（≤1 秒），用于让“新起点秒值”严格晚于“暂停期间发表时间”，不是长时间真实 sleep。

## 2. 红绿过程（TDD、反向验证与三处写错的测试）

本轮的产品代码**没有改动**：先按票据写矩阵用例，全部在既有实现上通过——这本身是 01/04/05 已修正阶段绑定的回归结论。为了让“通过与实现无关”这句话可检验，做了四处**临时反向修改**（改完立即还原，`git diff` 为空后重跑确认 38 passed），证明对应用例确实会红：

| 临时反向修改（mutation） | 变红的用例 | 观察到的失败 |
| --- | --- | --- |
| `outbox._active_phase` 去掉 `notification_body_claims` 绑定，退回“当前未封存阶段 + 仍入选”推导（04 的旧形态） | `test_deleted_and_recreated_config_starts_new_phase_and_claimed_work_cannot_join` | 迟到的一级评论进了新阶段：`business_events` 多出 `{'comment_id': '880002'}` |
| 候选分支忽略 `candidate["sealed"]`（只判是否仍入选） | `test_old_phase_candidates_never_cross_and_new_phase_same_second_comments_notify` | 旧候选补齐后生成了 `root_comment 880102` 与 `reply_comment 980102`，与新阶段同秒事件混在一起 |
| `selection.refresh_selections` 在 `reset=True` 时对**持续入选**也 `retire` | `test_equivalent_config_and_identical_window_keep_the_phase_until_a_real_reentry` | 旧阶段被错误封存、又开了新阶段：`phases` 从 1 条变 2 条（`sealed` 0 → `[1, 0]`） |
| `outbox.activate` 重新入选时复用上一阶段的 `baseline_version`（不重建基线） | `test_real_exit_and_reentry_rebuilds_body_baseline_and_skips_paused_comments` | 暂停期间的编辑被当成新变化：`business_events` 多出一条 `dynamic_changed` |

写用例过程中被测试纠正的三处**测试自身**错误（不是产品缺陷，如实记录）：

1. 受控来源里直接 `append` 回复条目但没有重新登记整楼集合，根页 `rcount` 没变 → `scan_due` 正确判定“无需重扫”，门闩永远等不到回复页请求。改为 `source.replies(...)` 重新登记（真实的 rcount 变化信号）。
2. 目标归属校验仍走上游：受控来源在 `POST /api/manage/ups/{uid}/targets` 之前没有登记该动态 → 502。改为先 `source.add(DYNAMIC, [])`，没有放宽真实校验。
3. 正文版本化来源与评论来源原先是两个替身，一个用例里无法同时驱动“编辑信号 + 评论”；新增 `EditableSource`（继承评论来源，只替换 `/opus/` 的编辑时间文本），仍是受控字节，不绕过解析。

## 3. 生命周期矩阵与逐项结果

“内容”指归档正文/一级评论/回复是否保存；“事件”指 `notification_events`（业务类型）；“候选”指 `notification_candidates`；“队列”指 `notification_deliveries`。所有行都在“任务已领取（claim + claim_archive 完成）→ 管理操作 → 归档随后提交”的门闩顺序下执行。

| 停止原因（真实入口） | 正文 | 一级评论 | 回复 | 候选变体（字段不全） | 阶段/归档/队列 |
| --- | --- | --- | --- | --- | --- |
| 停用 UP（`PATCH .../monitor enabled=false`） | 保存为第二版；无事件 | 保存；无事件 | 保存；无事件 | 根/回复都不写候选 | 旧阶段 `sealed=1`；起点/评论起点/`baseline_version` 不变；归档与只读归档 HTTP 200；队列为空 |
| 近期窗口移出（`discover` 重发不含该目标） | 同上 | 同上 | 同上 | 同上 | 同上 |
| 删除指定目标（`DELETE .../targets/{id}`） | 同上 | 同上 | 同上 | 同上 | 同上 |
| 删除监控配置（`DELETE .../monitor`） | 同上 | 同上 | 同上 | 同上 | 同上 |
| 模式切换后不再入选（recent → specified，目标不在指定集合） | 同上 | 同上 | 同上 | 同上 | 同上 |

用例：`test_claimed_archive_commit_after_each_stop_cause_saves_content_without_new_event[5 原因 × 3 类型 = 15]`、`test_claimed_incomplete_comment_after_stop_is_not_queued_as_candidate[5 原因 × 根/回复 = 10]`。断言还包括：`events == []`、`deliveries == []`、`candidates == []`、`phases == [sealed=1]`、阶段四元组（token/started_at/comment_started_at/baseline_version）逐字段不变、`content_state == success` 与 `work.text == success`（分项 checkpoint 语义不被通知生命周期改写）。

其它组合结果：

| 场景 | 用例 | 结果 |
| --- | --- | --- |
| 缺全员群 → 停用/删配置 → 修配 | `test_waiting_config_delivery_survives_stop_and_only_the_missing_target_is_repaired[disable/delete_monitor]` | UP 群 `sent`（1 次，不重发）；全员群 `waiting_config/route_missing` → 修复后只补发全员群 1 次；08 的路由告警行在停止与补发前后逐行相同（告警事实不被生命周期删除） |
| 目标真实失败退避 → 停用/删配置 → 重试 | `test_failed_target_backoff_keeps_retrying_after_stop_without_resending_success[...]` | 失败目标 `pending/failures=1/due=now+2s`；停止后按退避重试成功；成功不清零 `failures`；已成功目标 `attempts` 保持 1 |
| 两目标已领取（inflight）→ 停用/删配置 | `test_inflight_delivery_completes_after_stop_and_is_not_resent[...]` | 停止瞬间两目标都是 `inflight`；放行后都 `sent`；再起新投递对象零请求 |
| 真实通知进程重启（停用后） | `test_stopped_phase_queue_delivers_after_process_restart_and_is_never_resent` | 停用后进程仍投递队列（各 1 次）；重启后 2.5 秒内零请求、日志无 `delivery_sent`；阶段四元组不变；归档检查点相等 |
| 重启 vs 重新启用 | `test_restart_is_not_reentry_and_real_reentry_only_notifies_content_after_the_new_start` | 重启后阶段完全相同；真实重新启用后新阶段起点更晚；暂停期间发表的评论已归档但静默；新起点之后的评论双群各 1 条 |
| 旧候选不越阶段 + 新阶段同秒 | `test_old_phase_candidates_never_cross_and_new_phase_same_second_comments_notify` | 旧阶段的根/回复候选补齐后只被消费（不入事件、不留候选）；新阶段 `comment_started_at` 同秒发表的一级评论与回复都通知；旧候选发表时间晚于新起点（起点比较会放行），拦住它的是原阶段身份 |
| 删除配置再重建（真实退出再进入） | `test_deleted_and_recreated_config_starts_new_phase_and_claimed_work_cannot_join` | 旧阶段封存 + 新阶段（基线 NULL）；迟到内容保存但无事件；只读归档 HTTP 200；新阶段只通知新起点之后的评论 |
| 重新入选不追补 | `test_real_exit_and_reentry_rebuilds_body_baseline_and_skips_paused_comments` | 首份可信正文重建基线（暂停期间编辑不补发）；暂停期间的新评论静默；之后的新编辑与起点后评论各通知 1 次；重复扫描不重复生成 |
| 持续入选不重设 | `test_equivalent_config_and_identical_window_keep_the_phase_until_a_real_reentry` | 相同窗口重发、等价配置保存都不轮换入选令牌、不改阶段；真实 `recent_n` 变化让令牌整体轮换但阶段续存；真实移出再入选才新阶段（token/start 都变） |
| 普通重启保留起点/基线/队列 | `test_restart_keeps_phase_baseline_and_queue_and_old_event_never_advances_new_phase` | 重新入选后旧阶段入队事件照常投递，但不推进新阶段阶段四元组、不改归档检查点；`Store.migrate()`（API/通知启动）与新对象都不重设阶段 |

## 4. 验收条件 → 证据

| 票据验收条件 | 证据 |
| --- | --- |
| 停用、移出近期窗口、删除指定目标、删除监控配置、模式切换后不再入选，均结束相应通知阶段而不删除归档 | 上表 15 条矩阵用例（真实 HTTP/发现入口）；矩阵内每条都断言 `sealed=1`、归档仍可读（只读归档 HTTP 200）、正文/评论/回复表不受影响 |
| 动态、根评论和回复分别覆盖“任务已领取、管理操作发生、归档随后提交”；原 owner 规则可保存内容，失效阶段不生成新通知 | 15 条矩阵用例（`asyncio.Event` 门闩卡在 `/opus/`、`/x/v2/reply`、`/x/v2/reply/reply` 三类请求上）；正文落为第二版、评论/回复落库，但 `events/candidates/deliveries` 全空 |
| 通知阶段与入选代次在提交时核验，不只在任务开始检查；旧执行或旧候选不能借新阶段冒充新阶段事件 | 05 已修正的 `notification_body_claims` 绑定由 `test_deleted_and_recreated_config_...`（删除配置再重建后迟到提交）与 §2 mutation ① 反向验证；旧候选由 `test_old_phase_candidates_never_cross_...` 与 mutation ② 覆盖 |
| 已入队消息在停止后仍投递，包括等待配置、失败退避及在途领取；不随配置删除级联丢失，成功目标不重发 | 三个组合用例（waiting_config / backoff / inflight）× 停用与删配置；`test_stopped_phase_queue_...` 用真实通知子进程在停用后投递并重启验证不重发 |
| 尚未取得资格的候选与已入队事件区分：旧阶段结束后补齐信息不生成新事件；既有归档仍可读 | 10 条候选矩阵（迟到且字段不全 → 既无事件也无候选）+ 候选越阶段用例（补齐后只消费候选）；归档读取在矩阵中逐条断言 200 |
| 重新启用/重新入选创建新的持久起点，以恢复后第一份可信正文重建基线，不补暂停编辑；评论按新起点过滤，不补暂停期间评论 | `test_real_exit_and_reentry_...`（正文 13:10 静默、13:20 通知；暂停期间评论静默）+ `test_deleted_and_recreated_...`（基线 NULL 的新阶段）+ §2 mutation ④ |
| 新阶段初始化期间的新评论仍有资格；同秒边界与字段补齐沿用原时间规则，不因新扫描时间重新激活旧评论 | `test_old_phase_candidates_never_cross_and_new_phase_same_second_comments_notify`（`POST /api/sync/initial` 初始化期间，`floor(comment_started_at)` 同秒的一级评论与回复都通知；旧评论按来源发表时间而不是扫描时间过滤） |
| 普通 API、采集或通知进程重启不等于停用，原起点/基线/候选/队列保持；适当恢复未完成领取，不重建启用时间 | `test_restart_keeps_phase_...`（`Store.migrate` + 新 Store/Collector/Dispatcher 对象）、`test_restart_is_not_reentry_...` 与 `test_stopped_phase_queue_...`（真实通知子进程两次重启）；未完成领取的恢复复用 01/06 既有证据（`test_expired_lease_is_recovered_and_stale_completion_is_rejected`、`test_killed_process_recovers_lease_and_keeps_the_successful_target`，本轮 focused 回归含 `test_notification_recovery_processes.py` 3 passed） |
| 持续入选的目标在重复保存等价配置或重复发布相同窗口时不重设起点；真实移出再入选才新阶段 | `test_equivalent_config_and_identical_window_keep_the_phase_until_a_real_reentry`（令牌/阶段逐字段比较，含真实 `recent_n` reset 轮换）；§2 mutation ③ |
| 跨重启、重纳入、重复扫描的事件去重保持；停止后的投递结果不推进新阶段的归档或通知基线 | 重纳入用例末尾的重复扫描断言；`test_restart_keeps_phase_...` 断言旧阶段事件投递后新阶段四元组与归档检查点都不变 |
| 完整记录各停止原因、事件类型与候选/队列状态组合，回归原目标代次、归档保留及分项 checkpoint | 本文 §3 矩阵表；每条用例都断言 `sealed`/阶段四元组、`content_state`/`work.text`、归档读取与 `target_selections` 令牌行为 |

## 5. 关键设计决定与依据（本轮未改动实现，记录判定依据）

- **阶段是自有身份，入选令牌只证明“此刻仍入选”**。`reset=True`（启用开关/模式/`recent_n` 变化）会轮换全部令牌，因此不能用令牌相等做阶段判据；`refresh_selections` 只在“真正离开入选”集合上 `retire`，持续入选沿用原阶段。07 用真实 `recent_n` 变化验证“令牌轮换 + 阶段续存”（§3 最后两行）。
- **提交处核验领取时绑定的阶段**。`notification_body_claims(dynamic_id → generation, phase)` 在 `claim_archive` 时写入，`outbox._active_phase` 同时要求“同一写代次 + 绑定阶段未封存 + 目标仍入选”。正文、一级评论、回复共用这一判定，所以**停用/删除后迟到的在途内容只能保存、不能产事件**；旧阶段封存后即使重新入选，旧执行也拿不到新阶段。
- **候选不是队列**。`notification_candidates` 记录原阶段与发现时间，只在原阶段未封存时原子转事件；阶段结束即作废（补齐时消费掉、不进投递）。因此“字段不全的迟到内容”既不产生事件，也不留下待发项。
- **队列不随监控配置级联**。`notification_events`/`notification_deliveries` 不引用 `monitors`/`targets`；`retire` 只封存阶段。停止、删除目标、删除配置都不删事件或逐目标记录，`waiting_config`/`pending`/`inflight` 继续按原规则处理，成功目标不重发。
- **投递结果不回写阶段**。`finish_delivery` 只改该目标行的状态/次数/时间；阶段起点、评论起点、`baseline_version` 与归档 checkpoint 都由归档提交路径维护，因此旧阶段事件在新阶段投递不会推进新阶段基线。
- **同一秒语义**：`comment_started_at` 按 `math.floor` 比较，`published_at == floor(comment_started_at)` 属于“起点及之后”；新阶段初始化（`POST /api/sync/initial`）期间发表的新评论因此仍有资格，而旧评论仍按来源发表时间过滤，不用采集/扫描时间补造。
- **重启 ≠ 重新启用**：只有 `refresh_selections` 的真实增删会开/封阶段；`Store.migrate` 与新的 API/采集/通知对象都不触碰阶段。重启只恢复未完成领取（06 的租约恢复、23/29 的采集恢复），不重建启用时间。

## 6. 未覆盖与限制（不得据此宣称完整交付）

- **真实飞书群、飞书内置浏览器/手机、目标环境三进程**：未验证（票据 10/11，需授权）。所有“投递成功”都是受控接收端/本机 HTTP 服务。
- **全量与前端门槛未在本票重跑**：按票据“优先专项/相邻测试”执行，497 passed 的专项集合不含后端全量与前端命令；最终组合回归、三进程整体写竞争与交付准备由 10 统一执行。
- **08 的既有时钟用例**：08 证据记录过一次 3 秒墙钟并发用例偶发；本票没有删除或放宽任何断言，只在 focused 回归里原样运行（本轮通过），复核留给 10。
- **采集进程重启只用进程内新对象 + 启动迁移等价表达**：真实子进程只用于通知进程；采集侧未完成领取的恢复证据沿用 01/06/29 的既有真实进程/恢复用例，没有为本票新增第二个真实子进程。
- **“暂停期间”用秒级对齐表达**：新起点是 `time.time()` 的真实秒值，用例用 ≤1 秒的短等待对齐到下一秒，使“暂停期间发表”与“新起点同秒”在时间上可区分；没有引入可控时钟去改写生产起点。
- **旧阶段候选/事件不做清理**：候选行在阶段封存后仍留在表里（语义上作废），事件与投递记录按设计长期保留（`sent`/`failed` 事实供 08 与 10 使用）；本票不新增自动丢弃、备份或容量治理。
- **“不补暂停期间编辑”依赖可信编辑信号的分钟精度**：沿用 01 的既有裁决，暂停期间的多次编辑只重建为“恢复后第一份可信正文”，不保证逐次捕捉。

## 7. 代码、测试与文档指针

- 实现（本轮未改，作为契约事实引用）：`backend/bili_monitor/selection.py`（`refresh_selections` 的 `removed`/`retire`/`activate`）、`backend/bili_monitor/notifications/outbox.py`（`activate`/`retire`/`claim_body`/`_active_phase`/`record_body`/`record_root`/`record_reply`/`_record_comment`/`_candidate`/`claim_due`/`finish_delivery`）、`backend/bili_monitor/storage.py`（`update`/`delete_target`/`delete_monitor`/`claim_archive`/`finish_archive`/`_change_roots`/`_change_replies`）、`backend/bili_monitor/discovery_state.py`（`finish_discovery` → `refresh_selections`）。
- 测试：`backend/tests/test_notification_lifecycle.py`（36 例：15 停止矩阵 + 10 候选矩阵 + 队列/等待配置/退避/在途 + 候选越阶段/同秒 + 重入/持续入选/重启/删配置重建）、`backend/tests/test_notification_lifecycle_processes.py`（2 例：真实通知子进程重启与重新启用）。
- 可复用的测试入口（给 10）：`activation`/`archive`/`stop`/`in_flight`/`silent_baseline`/`stage_change`（本文件），`FeishuStub`/`NotifierProcess`/`wait_for`（06 的 `notification_process_support`），`feed_response`（27/28 的窗口替身），`POST /api/sync/initial`（显式初始化入口）。
- 正式契约：[通知进程与事件投递](../../../docs/backend/api/notification-process.md)（§3.4 生命周期：停用/移出/删除/模式切换/重启矩阵与语义）、[飞书通知需求与设计](../../../docs/design/feishu-notifications.md)（§3.4、§7 FS-AC-06/07）、[docs/README.md](../../../docs/README.md) 索引。
