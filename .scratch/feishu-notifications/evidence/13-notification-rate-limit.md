# 13 飞书发送主动限速：实施与验收证据

对应票据：[13 飞书发送主动限速](../issues/13-notification-rate-limit.md)；正式规则 [飞书通知需求与设计](../../../docs/design/feishu-notifications.md) §4.5；实现契约 [通知进程与事件投递](../../../docs/backend/api/notification-process.md) §5.2；派生来源：[11 真实验收](11-real-acceptance.md) §10。

结论：**票据范围（按目的地 5 次/秒 + 100 次/分钟主动限速、超预算顺延 `due_at` 不算失败、系统角色独立额度且领取优先、429 被动退避保留、可调但只能调小的额度入口）已实施并取得自动化证据**。真实飞书群投递与真实平台限流仍未验证；主动限速**降低但不消除** 429。本票未改动路由、模板、事件资格与归档。

## 1. 环境与命令

- 环境：Linux，Python 3.12.15（`.python-version`），uv，pytest 8.4.2；本票无前端改动。
- 隔离：临时 SQLite；B 站 HTML/JSON 为受控字节；飞书为进程内 `httpx.MockTransport` 替身；时间用受控时钟（`Clock` / `BeijingClock`）；凭据全部虚构（`fake-*-token`、`https://archive.example.invalid`）。
- 新增用例：`backend/tests/test_notification_rate_limit.py`（9 例）＋ `backend/tests/test_notification_combinations.py`（1 例「同群 20 条 + 一个心跳」，按票面指名的组合文件落位）。

```sh
uv run pytest backend/tests/test_notification_rate_limit.py -q
# 9 passed（限速器单元 4 + 顺延不失败 1 + 退避上界 1 + 额度环境变量 2 + 托管入口注入 1）

uv run pytest backend/tests/test_notification_rate_limit.py \
  backend/tests/test_notification_delivery.py \
  backend/tests/test_notification_combinations.py \
  backend/tests/test_notification_heartbeat.py \
  backend/tests/test_notification_alerts.py \
  backend/tests/test_dynamic_notifications.py \
  backend/tests/test_notification_protocol.py \
  backend/tests/test_notification_migration.py \
  backend/tests/test_root_comment_notifications.py \
  backend/tests/test_reply_notifications.py \
  backend/tests/test_notification_recovery.py \
  backend/tests/test_notification_recovery_processes.py \
  backend/tests/test_service_processes.py -q
# 169 passed

uv run pytest backend/tests -q
# 1041 passed in 188.20s（本票前基线 HEAD 收集 1031 例，本票新增 10 例）
```

## 2. 红绿过程（TDD，纵向切片）

1. **限速器窗口**：先写 `test_destination_allows_five_per_second_and_defers_the_sixth`、`test_destination_allows_one_hundred_per_minute_and_no_more`、`test_destinations_do_not_share_budget`、`test_defer_step_matches_the_poll_interval_and_stays_bounded`，运行得红 `ModuleNotFoundError: backend.bili_monitor.notifications.ratelimit`。补 `RateLimiter`（滑动窗口 `defer_seconds`/`record`，1 秒步长、分钟窗口上界 61 秒）后转绿。
   期间被测试纠正一次：100 条按 0.2 秒步进的用例在第 9 条误报需要顺延 1 秒——浮点累加的 `1.6 - 1.5999999999999999 = 2.2e-16` 被当成正等待。加 1µs 容差（`_EPSILON`）后转绿；这不是放宽额度，窗口边界上的记录本就应该算过期。
2. **超预算顺延不算失败**：先写 `test_over_budget_records_are_deferred_without_counting_failures`（单轮 8 条同群），得红 `assert (0, 8) == (5, 3)`（尚未接入限速，8 条全发）。补 `outbox.defer_delivery()` 与 `Dispatcher._defer()` 后转绿：5 条 `sent`、3 条仍 `pending` 且 `due_at = now + 1.0`、`attempts/failures/error` 分别为 `0/0/NULL`，下一轮全部 `sent` 且 `attempts == 1`。
   该片还暴露测试自身的装配错误（把 `httpx.MockTransport` 包了两次导致 `'MockTransport' object is not callable` 被分类成 `internal_error`），改回只包一次。
3. **同群 20 条 + 一个心跳**（落在票面指名的 `test_notification_combinations.py`）：先写 `test_same_group_burst_is_rate_limited_while_the_heartbeat_keeps_its_own_budget`，得红 `assert 8 <= 5`（同一秒 8 次）。接入限速后业务发送按 5 次/秒摊开、20 条最坏等待 `ceil(20/5) = 4 秒`，但心跳被批内顺序推到第 3 秒才发出。
   对照契约 §5.2「心跳与告警不排在业务积压后面」，把领取改成分角色查询（`SYSTEM_DUE_QUERY` + 「系统角色优先，再按 `due_at`/id」排序），心跳在第一轮就送出，用例收紧为「系统群发送时刻等于首批业务发送时刻」。
4. **退避与限速不叠加**：先写 `test_failing_group_keeps_retry_waits_bounded_and_attempts_honest`（12 条同群持续 500，跑 40 轮），得红（尚未有限速时 `attempts != failures` 之外的等待上界断言不成立）。接入后每条记录 `0 < due_at - now <= 361`（300 秒退避上限 + 61 秒顺延上限 + 1 秒轮询），且 `failures == attempts`——顺延不消耗 `attempts`。
5. **调参入口只能调小**：先写 `test_environment_can_lower_but_never_loosen_the_platform_budget` 与 `test_environment_limiter_defaults_to_the_official_budget`，得红 `AttributeError: module 'backend.bili_monitor.notifier' has no attribute 'amount'`。补 `notifier.amount()`（正整数、`min(parsed, default)`）、`limiter_from_environment()`（默认 5/100，`per_second > per_minute` 拒绝启动）并在 `serve()`/`main()` 注入 `RateLimiter` 后转绿。
6. **既有用例适配（新契约生效后的必要修改，未放宽断言）**：`test_root_comment_notifications.py`、`test_reply_notifications.py` 里有四处「一次 `run_once()` 就期望 20 条同群全部发出」的用例，在主动限速下按契约只会先发 5 条。新增共享助手 `notification_support.drain(notifier, clock)`：按 `poll_seconds` 推进受控时钟直到没有可领取记录。四处改为该助手后转绿，断言数量（20 条、12 条）与消息身份全部保留；`test_notification_recovery.py` 的索引断言同步覆盖新增的 `SYSTEM_DUE_QUERY`（`notification_due` 仍被命中）。

## 3. 验收条件 → 证据

| 票据验收条件 | 证据 |
| --- | --- |
| 同一目的地任意 1 秒 ≤ 5 次、任意 60 秒 ≤ 100 次；按目的地隔离 | 单元：`test_destination_allows_five_per_second_and_defers_the_sixth`、`test_destination_allows_one_hundred_per_minute_and_no_more`、`test_destinations_do_not_share_budget`；调度：`test_same_group_burst_is_rate_limited_while_the_heartbeat_keeps_its_own_budget`（组合文件）逐窗口断言 ≤ 5，`test_failing_group_...` 40 轮实测请求数 ≤ 40×5 |
| 超预算不改状态、不丢、不重复：仍 `pending`、`due_at` 顺延、下一轮重领 | `test_over_budget_records_are_deferred_without_counting_failures`（`state=pending`、`due_at=now+1`、`attempts=0`、下一轮 8 条全 `sent` 且各只发一次） |
| 限速等待不持有 SQLite 写事务，也不阻塞其他目标 | 实现：预算检查在 `client.post` 前后均为内存同步操作，顺延写回是独立短事务（`write(self.store)`）；跨目标独立性由系统群与业务群同时饱和的 `test_same_group_burst_...` 与 `test_destinations_do_not_share_budget` 覆盖 |
| 429 被动退避保留 | 既有 `test_rate_limit_uses_platform_suggestion_and_network_errors_retry` 仍通过（45 秒 `x-ogw-ratelimit-reset` 不变）；主动限速在请求前，被动退避在响应后，两者并存 |
| 心跳/告警时效有明确结论并有用例 | 独立限速键 + 领取优先：`test_same_group_burst_is_rate_limited_...` 断言心跳在第一轮送出且 `sent`、`attempts=1`；契约 §5.2 与设计 §4.5 写明「不排在业务积压后面」，并记录系统群与业务群共用同一 webhook 时的已知取舍 |
| 退避与限速不叠加成「永远轮不到」，最坏等待有上界且有测试 | `test_failing_group_keeps_retry_waits_bounded_and_attempts_honest`：`due_at - now <= 300 + 61`，且 `failures == attempts`；同键积压 `ceil(N/5)` 秒由组合用例锁定（20 → 4 秒） |
| 日志只有固定分类，新增事件沿用安全字段 | 超预算记 `delivery_deferred role=… kind=… reason=rate_limited`（`notifier_event` 白名单）；`assert_no_credentials` 相关既有用例仍通过，新用例不引入 URL/密钥输出 |
| 隔离条件明确：环境变量可调小、默认不得被放宽 | `test_environment_can_lower_but_never_loosen_...`（`500` 被夹到 `5`、非法值 `SystemExit`）、`test_environment_limiter_defaults_...`（默认 5/100、矛盾额度拒绝启动）、`test_unified_service_entry_passes_the_rate_limit_to_the_notifier` 与 `test_service_processes.py::test_notifier_entry_uses_the_published_process_module`（推荐的 `service` 三进程入口同样注入额度，矛盾值拒绝启动） |

## 4. 关键设计决定与依据

- **限速键 = 实际 webhook**，系统角色用固定键 `system`：同群共用额度，跨群互不占用；系统角色不计入业务额度（票据裁决 1、2、4）。键只存在于进程内字典，不写库、不进日志。
- **顺延而非等待**：`defer_delivery` 只写 `state=pending`/`token=NULL`/`lease_until=NULL`/`due_at`，不碰 `attempts`、`error`、`failures`。这样退避不被放大，08 的「持续投递失败」也不会被限速噪声触发（裁决 3）。
- **记账在请求之前**：占用平台额度的是外发尝试（含失败/超时），因此在 `client.post` 前 `record()`；检查与记账之间没有 `await`，单线程事件循环里天然原子。
- **领取分角色**：`DUE_QUERY` 排除系统角色、`SYSTEM_DUE_QUERY` 只取系统角色，合并时系统优先。原 `DUE_QUERY` 的 `LIMIT` 会让大批业务记录把心跳挤出本批，仅调整排序不够，因此必须单独取系统行；三条查询各自命中既有索引，`EXPLAIN QUERY PLAN` 断言同步更新。
- **额度入口只许调小**：`amount(name, maximum)` 取 `min(解析值, 官方默认)`；写错（非正整数、`per_second > per_minute`）直接拒绝启动且不回显原值，避免把测试旋钮变成生产提速开关。

## 5. 未覆盖与限制（不得据此宣称完整送达承诺）

- **真实平台限流未验证**：本票只证明本地调度不主动超预算；真实飞书群、真实机器人共享额度、`x-ogw-ratelimit-reset` 的真实取值仍未实测（沿用 11 的边界）。主动限速**降低但不消除** 429。
- **窗口状态在进程内存**：单实例 `flock` 保证同库只有一个投递进程，但重启会丢失窗口历史，重启瞬间可能有一小段超额；多实例部署不受支持，也不在票据范围。
- **不承诺送达时刻**：极端积压时迟到消息仍会成批到达；同键积压的最坏等待是 `ceil(N/5)` 秒再加批量轮次，不是 SLA。
- **未做真实压测**：按票据「不得用真实业务群做压力测试」，20 条同群与 12 条持续失败都在隔离环境与替身接收端完成。

## 6. 代码与文档指针

- 实现：`backend/bili_monitor/notifications/ratelimit.py`（`RateLimiter`、`PER_SECOND`/`PER_MINUTE`、`DEFER_STEP_SECONDS`、`MAX_DEFER_SECONDS`）、`notifications/delivery.py`（`rate_key`、`Dispatcher._defer`、请求前预算检查）、`notifications/outbox.py`（`defer_delivery`、`SYSTEM_DUE_QUERY`、`claim_due` 系统优先）、`backend/bili_monitor/notifier.py`（`amount`、`limiter_from_environment`、`serve(limiter=)`）。
- 测试：`backend/tests/test_notification_rate_limit.py`（新增 9 例）、`backend/tests/notification_support.py`（`drain` 助手）、`test_notification_recovery.py`（索引断言覆盖系统查询）、`test_root_comment_notifications.py` / `test_reply_notifications.py`（大批量投递改按轮询节拍发完）。
- 文档：契约 `docs/backend/api/notification-process.md` §4（三条领取查询）与 §5/§5.2（参数表、实现约定、边界）、设计 `docs/design/feishu-notifications.md` §4.5、运行说明 `backend/README.md`（环境变量与主动限速段落）、索引 `docs/README.md`。

## 7. 双轴复核与整改（Standards / Spec 并行子代理）

两轴各报回一份报告，共同指出的确认缺陷已修复：

1. **额度环境变量在推荐入口被静默忽略（确认缺陷，两轴均报）**：`backend/bili_monitor/service.py` 的 `run_notifier` 直接 `notifier_serve(database, NotificationConfig.load(config))`，没传 `limiter=`——`python -m backend.bili_monitor.service`（契约 §1 推荐的三进程入口）下 `BILI_NOTIFIER_SENDS_PER_*` 不生效，矛盾值也不会拒绝启动。修复：`run_notifier` 调用 `limiter_from_environment()` 并传入；补 `test_unified_service_entry_passes_the_rate_limit_to_the_notifier`（含矛盾值拒绝启动），既有 `test_service_processes.py` 的假 `serve` 同步接受 `limiter` 并断言默认 5/100（不是放宽断言，而是把新接线锁住）。
2. **契约 `attempts` 自相矛盾（确认，Spec 轴）**：§4 原写「每次回写都 +1」，与 §5.2「顺延不消耗 `attempts`」互斥。修复：§4 改为「每次**投递结果**回写 +1，限速顺延是例外，见 §5.2」。
3. **文档不变量没有单一来源（判断项）**：§5.2 原写「顺延步长与轮询间隔一致」，实际是独立常量。修复：改为「固定 1 秒，与默认轮询间隔相同，但不随 `poll_seconds` 覆盖变化」，并在 `RateLimiter.defer_seconds` 里用 `MAX_DEFER_SECONDS` 真正夹住上界（常量不再只被测试引用）。
4. **共用 webhook 边界未记录（判断项）**：系统角色按角色键控，若运维把 `system` 指向某个业务群同一 webhook，该目的地会同时持有两份额度。修复：契约 §5.2 明写这是裁决 4 的已知取舍，不做合并。
5. **顺延记录多一次短写事务、占一个批量名额（判断项）**：契约 §5.2 补「代价」一条。
6. **日志重复分类（判断项）**：`_defer` 在领取凭证失效时仍记 `delivery_deferred`，与 `delivery_lease_expired` 矛盾。修复：`_defer` 返回是否被接受，只有被接受才记顺延事件。
7. **代码气味小修**：`DUE_QUERY`/`SYSTEM_DUE_QUERY` 改用同一模板生成（去掉整条 SQL 复制）；`notifier.amount` 改名 `quota` 表达「额度上限」；限速键改为元组 `("webhook", url)` / `("system",)`，不再把 URL 与系统标识混在同一字符串键空间；`test_reply_notifications._drain` 这层纯转发壳删除，直接调用共享 `drain`；顺手删掉的 `CollectorClock` 空行噪声已还原。
8. **用例落位（判断项）**：「同群 20 条 + 一个心跳」从新文件移到票面指名的 `test_notification_combinations.py`，与既有组合回归同处。

整改后全量后端 `1041 passed`（188.20s），专项 169 passed。
