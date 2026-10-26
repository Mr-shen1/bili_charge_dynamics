# 14: 飞书通知总开关（发送闸门 + 管理页开关）

**What to build:** 一个持久化的“飞书通知开关”：关闭后通知进程**一条都不发**（不是停进程，只是闸门关闭），管理页可以开关并看到状态与待发条数。

**Blocked by:** 无（13 建议先做，关→开后的积压靠 13 的限速兜住）。

**Status:** resolved

**来源：** 票据 [11](11-real-feishu-device-acceptance.md) 清理章节。用户先提“页面上做一个总开关，关闭时直接停止整个飞书相关进程”，随后明确**简化**为：“不停进程，只新增一个标识，通过标识判断”。

## 形态（用户已定）

- **不停进程**：通知进程照常运行、照常持有 `flock` 与租约，只在每个投递轮次开头读一次开关状态；关闭时**不领取、不发送、不生成心跳**，直接进入下一次轮询。
- **开关是持久标识**：存 SQLite（随库走，重启/重新部署/机器重启都保持），不是进程内变量。
- **管理页可操作**：`/manage` 顶部的开关，走既有 Basic 保护；页面显示“运行中/已关闭”与“待发 N 条”。

## 现状（已核对）

- 通知进程只有一个“进程级”总开关，即环境变量 `BILI_NOTIFICATION_CONFIG`（`backend/bili_monitor/service.py:116-121`、`notifier.py:85-88`），改它必须重启服务。
- 投递轮询在 `Dispatcher.tick`（`backend/bili_monitor/notifications/delivery.py:75-90`）：先 `_publish_heartbeat`（仅 `:40` 窗口），再 `run_once` 领取＋发送，最后 `_scan_delivery_alerts`。
- 管理入口与鉴权：`/api/manage/*` 与 `/manage` 由 nginx `auth_basic "bili manage"` 保护；管理 API 的实现与契约见 `docs/backend/api/management-api.md`。

## 裁决结果

**关闭期间产生的事件：方案 A —— 保留并补发**（用户 2026-10-26 裁决）。

- 关闭期间采集继续登记事件；重新打开后按票据 [13](13-notification-send-rate-limit.md) 的限速逐条补发，页面显示“待发 N 条”，让用户知道消息没丢、只是晚发。
- 被放弃的 B 方案（只归档不通知）需要额外的“丢弃”状态或时间戳判定，语义更重，本票不做。
- 已知代价：关闭 3 小时再打开会有一波迟到消息，靠 13 的限速摊开；这一点必须写进验收证据，不能事后说成“实时补发”。

## 文档（先行完成，作为实现依据）

契约已在实现前落到正式文档，实现时以文档为准：

- `docs/backend/api/notification-process.md`：新增 §1.1 发送闸门、§5.1 追加参数；§5.2 主动限速（13）同处。
- `docs/backend/api/management-api.md`：新增“通知总开关”一节，含 `GET`/`PUT` 契约、幂等、鉴权沿用与页面行为。
- `docs/design/feishu-notifications.md`：新增 §4.5，说明为什么不采用“停进程”形态、闸门与限速的取舍。

三处原先都标注“票据 13/14 契约，尚未实现”；票据 13 交付后，契约 §5.2 与设计 §4.5 已改为“13 已实现”，仅供本票使用的总开关（§1.1/§5.1 与 management-api.md）仍标注尚未实现，避免与已交付行为混淆。

## 验收条件

- [x] 开关存 SQLite（迁移版本 +1，v22 `notification_gate`），默认**开启**，既有库升级后行为不变。
- [x] 关闭后：`Dispatcher.tick` 不生成心跳、不领取、不发任何 HTTP；进程存活、`flock` 持有、租约不异常；API 与采集照常工作、归档不受影响。
- [x] 打开后：从下一轮开始正常投递；按 A 执行时补发积压且受 13 限速约束，不重复发送、不重复登记事件。
- [x] 心跳语义：关闭期间不生成（等价“错过不补”，与既有 `:40` 窗口规则一致），恢复后只在下一个 `:40` 生成。
- [x] 管理 API：`GET` 返回 `{enabled, pending}`（`pending` 为待发条数，只读聚合，不回显路由/凭据）；`PUT` 改状态并返回新状态；非法入参 `422`；写失败有非 2xx 与固定错误码。
- [x] 页面：开关初始状态来自 API（不是本地记忆），切换后有明确的成功/失败反馈，刷新后与真实状态一致，窄屏可用。
- [x] 日志：状态切换与“因关闭而跳过”都是固定分类字段，不含 webhook/密钥/URL。
- [x] 文档：`docs/backend/api/management-api.md`、`docs/backend/api/notification-process.md`、`docs/backend/api/archive-api-client.md`（若涉及页面）同步。

## 验证方式

- 后端：开关两态下 `Dispatcher` 的 HTTP 计数为 0 / 正常；关闭期间心跳不生成；打开后补发条数与限速符合预期；迁移默认值用例。
- 前端：单测开关状态渲染与请求；e2e 在管理页切换并断言请求体与状态刷新。
- 不新建第二个“通知开关”概念：环境变量仍决定**是否启动通知进程**，本票的标识决定**进程是否发送**。

## 完成与后续

上线运维闸门：出问题时在页面上一键止血，不需要改环境变量、不需要重启服务。与 13 独立，先做 13 更安全。

## 实施记录

- 证据：[14 实施与验收证据](../evidence/14-notification-gate.md)（后端新增 21 例、全量 `1062 passed`；前端 `pnpm check` 与 `pnpm test:e2e` `209 passed/10 skipped`、`check:dist` 通过）。
- 落地位置：`backend/bili_monitor/notifications/outbox.py`（`migrate_gate`/`read_gate`/`write_gate`/`pending_count`）、`backend/bili_monitor/storage.py`（v22 迁移 + `read_notification_switch`/`update_notification_switch`）、`backend/bili_monitor/notifications/delivery.py`（`_allowed`/`_switch_enabled`，`tick`/`run_once` 共用同一闸门）、`backend/bili_monitor/app.py` + `contracts.py`（`GET`/`PUT /api/manage/notifications`）、`frontend/src/manage/NotificationSwitch.vue` + `managementApi.ts`（`readNotification`/`updateNotification`）。
- 形态调整（实施时确认）：页面控件用与 UP 启停一致的带文字按钮（`aria-pressed`）而不是 `el-switch`——Element Plus 的开关输入框是零尺寸（`width:0;height:0;opacity:0`），真实点击命中的是可见胶囊体，e2e 直接点 role=switch 会 `element is not visible`；按钮点击目标唯一、窄屏与触控可用，也不需要额外引入组件样式。
- 读不到开关（本地存储异常）按关闭处理：该轮不发送、只记 `delivery_cycle_failed reason=storage_error`，下一轮恢复；日志只在状态变化时记一条，不每秒刷屏。
- 未验证：真实飞书群、目标环境三进程/托管下的开关操作与真机，仍属 11 的授权范围；关闭期间的补发是成批迟到而非实时。

## Comments

- 用户放弃原 dry-run 方案（env 开关 + `suppressed` 终态）与“停进程”方案，选定“不停进程 + 持久标识 + 页面开关”。
- 与票 11 的关系：11 记录的“关总开关会积压补发”风险由本票正面处理（默认方案 A 明确补发并受限速）。
