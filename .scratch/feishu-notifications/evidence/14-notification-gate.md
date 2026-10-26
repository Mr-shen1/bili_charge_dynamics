# 14 飞书通知总开关：实施与验收证据

对应票据：[14 飞书通知总开关](../issues/14-notification-dry-run.md)；正式规则 [飞书通知需求与设计](../../../docs/design/feishu-notifications.md) §4.5；实现契约 [通知进程与事件投递](../../../docs/backend/api/notification-process.md) §1.1／§5.1／§7 与 [监控管理接口](../../../docs/backend/api/management-api.md)「通知总开关」；前端装配契约 [归档 API 客户端](../../../docs/backend/api/archive-api-client.md)「HTTP 与展示契约」。

结论：**票据范围（持久总开关 + 每轮只读一次 + 关闭不领取不发 HTTP 不生成心跳 + 重开按方案 A 补发并受限速 + 管理页开关与待发条数）已实施并取得自动化证据**。闸门只影响投递调度，不改路由、模板、事件资格与归档。真实飞书群、目标环境三进程与真机仍未验证，留给 11 的授权范围；本票不宣称“实时补发”。

## 1. 环境与命令

- 环境：Linux，Python 3.12.15（`.python-version`），uv，pytest 8.4.2；前端 Node 24 / pnpm（`frontend/README.md`「命令」段），Vitest + @testing-library/vue，Playwright 1.58.2。
- 隔离：临时 SQLite；B 站 HTML 为受控字节；飞书为进程内 `httpx.MockTransport` 替身；时间用受控时钟（`BeijingClock`）；凭据全部虚构（`fake-*-token`、`https://archive.example.invalid`）。前端 e2e 只替换 `/api/manage/**` 的 HTTP 响应。
- 新增用例：`backend/tests/test_notification_gate.py`（11 例）、`backend/tests/test_management.py`（12 例：开关读写 1 + 非法入参 9 + 查询参数 1 + 写失败 1；查询参数用例同时覆盖 `GET` 与 `PUT`）、`backend/tests/test_notification_migration.py`（1 例 v21 → v22）；前端 `frontend/tests/unit/manage-notification.test.ts`（5 例）、`frontend/tests/unit/management-api.test.ts`（4 例），`frontend/tests/e2e/manage.spec.ts`（2 例，桌面与 Pixel 7 各跑一遍）。

```sh
uv run pytest backend/tests/test_notification_gate.py -q
# 11 passed（持久开关 2 + 关闭不领取/心跳 3 + 重开补发 1 + 日志 5）

uv run pytest backend/tests/test_management.py -q
# 94 passed

uv run pytest backend/tests/test_notification_migration.py backend/tests/test_migrations.py \
  backend/tests/test_inflight_recovery.py backend/tests/test_three_process_delivery.py -q
# 迁移与三进程回归全部通过（schema 断言统一为 v22）

uv run pytest backend/tests -q
# 1065 passed in 189.38s（本票前基线 1041，本票新增 24 例）

cd frontend && pnpm check
# vue-tsc 通过；293 单测通过；e2e 项目覆盖守卫通过

cd frontend && NO_PROXY=127.0.0.1,localhost pnpm test:e2e
# 209 passed, 10 skipped in 3.9m（含 manage.spec.ts 的 2 个新用例 × 桌面/窄屏两个 project）
# 本轮整改后复核：manage.spec.ts 28 passed（两 project 共 28，含既有 12 例）

cd frontend && pnpm check:dist
# 生产/自检两次构建 + 产物隔离检查通过
```

## 2. 红绿过程（TDD，纵向切片）

1. **持久开关（迁移 + 读写 + 待发条数）**：先写 `test_new_database_opens_the_gate_and_reports_no_pending` 与 `test_switch_round_trips_and_counts_only_pending_deliveries`，运行得红 `AttributeError: 'Store' object has no attribute 'update_notification_switch'`（读路径同时因缺表报 `sqlite3.OperationalError: no such table: notification_gate`）。补 `outbox.migrate_gate/read_gate/write_gate/pending_count`、`Store.read_notification_switch/update_notification_switch` 与 v22 迁移后转绿：默认 `{"enabled": True, "pending": 0}`；两条待发消息时 `pending=2`；重复写同一值返回同样状态但 `changed=False`（幂等不制造日志噪声）。
2. **关闭即不领取、不发 HTTP、不生成心跳**：先写得红（`tick()` 照旧发送 3 条、并生成心跳）。补 `Dispatcher._allowed/_switch_enabled` 与 `_dispatch_batch` 拆解后转绿：3 轮 `tick` 返回 0，接收端 0 请求，投递记录仍 `pending` 且 `attempts/token/lease_until` 全未动，事件数不变；13:40 关闭时无心跳，13:41 打开仍不补本小时，只在 14:40 生成一条。
3. **读不到闸门时停发**：删表后 `tick` 返回 0、不发请求，只记 `delivery_cycle_failed reason=storage_error`；重放 v22 迁移建回表后同一条记录立即正常投递（fail-closed 但不粘死）。
4. **重开按方案 A 补发且受限速**：8 条同群积压 + 关闭 3 轮后打开，`drain` 跑完得 8 条 `sent`、8 个请求、事件数不变，任意 1 秒窗口内同目的地 ≤5 次（复用了 13 的预算），`attempts=1/failures=0` 证明没有重复发送也没有把限速顺延记成失败。
5. **日志分类**：切换与跳过都是固定字段；关闭期间每轮都跳过，但只落一条 `delivery_skipped reason=switch_off`，打开只落一条 `notification_switch_opened`；日志里没有 webhook 与令牌。API 侧 `notification_switch_changed enabled=<true|false>` 只在真的切换时出现（重复写同一值 2 次只产生 1 条）。
6. **管理 API 契约**：先写 HTTP 用例得红（三个新路由 404）。补 `GET/PUT /api/manage/notifications` 与 `NotificationSwitch` 严格模型后转绿：`GET` 返回 `{enabled, pending}`；`PUT` 返回新状态；9 种非法入参（缺字段、字符串/数字/null、额外字段、空数组、裸字符串、`null` 体）全部 `422 INVALID_INPUT` 且状态不变；未知查询参数 `422`；写失败（触发器 ABORT）返回 `503 STORAGE_UNAVAILABLE`，正文与日志都不含原始 SQLite 文案，回读仍是原状态。
7. **前端 Adapter**：先写用例得红（`readNotification is not a function`）。补 `parseNotification` 与两个方法后转绿：`GET` 只发 GET，`PUT` 完整提交 `{"enabled":false}` 且 `Content-Type: application/json`，形状/状态码不符整条判无效，503 走既有固定文案。
8. **页面开关**：先写得红（页面上没有开关）。补 `NotificationSwitch.vue` 后转绿：初始状态来自 `GET`、切换提交后按响应刷新状态行与按钮、失败保留原状态并给固定提示且可再次提交、提交中不重复发送、读取失败可原位重试。
   - 期间被测试与真机渲染纠正两次：①`typecheck` 报 `Tuple type '[]' of length '0' has no element at index '0'` 与 `Type '"success"' is not assignable to type '"error"'`，改用显式 `vi.fn<Update>` 声明；②首版用 `el-switch`，e2e 点击得红 `locator.click: element is not visible`——Element Plus 的 `input.el-switch__input` 是 `width:0;height:0;opacity:0`，真实用户点的是可见的胶囊体。改为与既有 UP 启停一致的带文字按钮（`aria-pressed` + “关闭飞书通知／开启飞书通知／正在提交…”），点击目标唯一、窄屏与触控可用，且不需要新的组件样式引入。
9. **双轴复核后的整改（Standards + Spec 两个子代理，各自独立复核）**：
   - 补丁性质的硬问题：`managementApi.ts:290` 被我的一次编辑把 JSDoc 与 `async listChecks(` 压成一行（typecheck 拦不住），已还原为两行。
   - 启动即伪造切换日志：`Dispatcher.gate` 初值为 `None`，导致进程每次启动（含 `--once`）首轮都记一条 `notification_switch_opened`，与“只在状态变化时记一条”冲突。改为初值 `True`（启动按开启计），并补 `test_startup_never_fakes_a_switch_transition` 与 `test_startup_with_a_closed_gate_logs_one_skip`。
   - 存储异常每秒刷日志：`delivery_cycle_failed reason=storage_error` 原先每轮一条。改为用 `GATE_UNREADABLE` 占位，只在首次进入该状态时记一条，恢复时记一条 `notification_switch_opened`；补 `test_unreadable_gate_logs_once_and_resumes_after_recovery`。
   - `PUT` 未拒绝未知查询参数（与 `GET`、与其它管理端点不一致）：补 `validate_query`，并在查询参数用例里断言 `PUT` 同样 `422` 且状态不变。
   - 判为判断意见、本轮不改的项：`NotificationSwitch.vue` 的读取侧与 `useManagementRead` 形状相近，但后者绑定 `ManagedUp[]`；泛型化会改动已交付并被签收的模块，收益不抵风险，写入侧已改为复用 `useManagementRequests` 的按目标防重锁（去掉整段自写的 busy/卸载隔离）。后端 `{"enabled","pending"}` 两处手搓已收敛到 `Store._notification_switch`，切换结果改为具名 `SwitchUpdate`。
10. **既有用例的连带修正**：`/manage` 顶部多了第二个可失败区域后，5 个既有列表页单测因 `findByRole('alert')` 命中两个提示而红。修正方式是让测试替身默认“通知开关读取成功、待发 0 条”（它本来就不是这些用例的被测对象），通知读取失败路径由新文件单独覆盖；`tests/e2e/manage.spec.ts` 的通用路由对 `/api/manage/notifications` 给固定默认响应且不进入 `calls`，需要断言它的用例在之后注册更具体的路由覆盖（Playwright 后注册优先）。

## 3. 验收条件对应

| 票据条件 | 证据 |
| --- | --- |
| 开关存 SQLite（迁移版本 +1），默认开启，既有库升级后行为不变 | `test_new_database_opens_the_gate_and_reports_no_pending`、`test_v21_database_gains_the_notification_gate_open`（v21 库升级后 `enabled=True`、`pending=1` 原样保留，重放迁移不重置已关闭状态）；schema 由 v21 → v22 |
| 关闭后：不生成心跳、不领取、不发任何 HTTP；进程存活、`flock` 与租约语义不变 | `test_closed_gate_claims_nothing_and_sends_no_request`、`test_closed_gate_skips_the_heartbeat_window_without_backfill`；锁与租约代码未改，关闭期间没有领取因此也没有凭证/租约写入 |
| API 与采集照常工作、归档不受影响 | 闸门只在 `Dispatcher` 内、只在投递轮次开头读；`/api/manage/*` 与采集路径未改动（`test_management.py` 94 例、采集/归档回归仍在全量中通过） |
| 打开后从下一轮正常投递；补发积压且受限速，不重复发送、不重复登记事件 | `test_reopening_delivers_the_backlog_once_within_the_send_budget`（8 条补发、每 1 秒窗口 ≤5 次、事件数不变、每条只发一次） |
| 心跳语义：关闭期间不生成，恢复后只在下一个 `:40` 生成 | 同上心跳用例：13:40 关闭无生成、13:41 打开不补、14:40 生成一条 |
| 管理 API：`GET {enabled,pending}`；`PUT` 改状态返回新状态；非法入参 422；写失败非 2xx 固定错误码 | `test_notification_switch_*` 4 组共 12 例（含 9 种非法入参、未知查询参数、触发器写失败 `503 STORAGE_UNAVAILABLE`） |
| 页面：初始状态来自 API，切换有成功/失败反馈，刷新后与真实状态一致，窄屏可用 | `manage-notification.test.ts` 5 例；`manage.spec.ts` 两个 e2e 用例（断言 `GET`/`PUT` 请求顺序与请求体、刷新后仍为已关闭）；四视口审计用例把新按钮纳入 44px 触控高度检查，窄屏 project（Pixel 7）同样通过 |
| 日志：状态切换与“因关闭而跳过”是固定分类字段，不含 webhook/密钥/URL | `test_switch_flips_are_logged_once_per_transition_and_stay_safe`、`test_switch_api_logs_only_real_flips_with_fixed_fields`、`test_startup_never_fakes_a_switch_transition`、`test_startup_with_a_closed_gate_logs_one_skip`、`test_unreadable_gate_logs_once_and_resumes_after_recovery` |
| 文档同步 | [通知进程契约](../../../docs/backend/api/notification-process.md) §1.1／§5.1／§7／§8、[管理接口](../../../docs/backend/api/management-api.md)「通知总开关」、[设计 §4.5](../../../docs/design/feishu-notifications.md)、[归档 API 客户端](../../../docs/backend/api/archive-api-client.md)「HTTP 与展示契约」、`backend/README.md` 管理接口清单与 schema 版本、两处部署文档 schema 版本 |

## 4. 已知限制与未验证事项

- **关闭期间的积压会成批迟到**：关闭 3 小时再打开，会按方案 A 补发一波迟到消息，只是被 13 的 5 次/秒 + 100 次/分钟摊开。这不是实时补发，也不承诺送达时刻。
- **真实飞书群、目标环境三进程与真机未验证**：本票全部证据来自受控传输与临时 SQLite；真实平台限流、真实群投递、systemd 托管下的开关操作仍属 11 的授权范围。
- **读不到开关时按关闭处理**：本地存储异常的那一轮不发送（只记 `delivery_cycle_failed reason=storage_error`），下一轮自动恢复；这是刻意的 fail-closed 选择，代价是单轮延迟，不是丢消息。
- **页面只做开关与待发条数**：没有逐条投递列表、手动重发、路由编辑或“清空积压”；这些会引入新的凭据与正文暴露面。
- **日志只在状态变化时记录**：关闭期间（含存储异常期间）不每秒刷一条，因此“确实跳过了多少轮”需要看投递记录 `attempts` 未增长这一事实，而不是日志条数。
