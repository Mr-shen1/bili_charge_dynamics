# 15: 通知状态改三态（关闭即彻底不发）

**What to build:** 把管理页的“飞书通知开关”改成一个持久三态选择（`all` / `system_only` / `off`），
由状态决定登记与发送哪一类消息；关闭不做任何补发，切回全部通知只收之后的新变化。

**Blocked by:** 无（票据 13 限速与票据 14 闸门表已交付）。

**Status:** resolved

**来源：** 用户 2026-10-27 裁决，推翻票据 14 的「方案 A：保留并补发」。用户同时确认：飞书进程
默认启动（心跳与运维告警是必要能力）、页面用下拉框、初始值为 `off`。

## 变更点

- `backend/bili_monitor/notifications/outbox.py`
  - 三态常量与 `read_state` / `write_state`；`migrate_gate_states`（v23，重建表，默认 `off`）。
  - `_registration_open`：登记侧闸门，读不到按关闭处理，`system` 区分业务/系统类别。
  - `discard_queue`：作废未投递记录（可只作废业务角色）+ 清孤儿事件与悬空指针。
  - `realign`：切回 `all` 时前移评论起点并对齐正文基线。
  - `record_body` / `_record_comment` / `record_alert` / `record_heartbeat` 加闸门。
- `backend/bili_monitor/storage.py`：v23 迁移入口；`update_notification_switch` 在真实切换时收敛队列。
- `backend/bili_monitor/contracts.py`：`NotificationSwitch.state`（`Literal` 三态，禁止额外字段）。
- `backend/bili_monitor/app.py`：PUT 传 `body.state`，日志字段改 `state=<...>`。
- `backend/bili_monitor/notifications/delivery.py`：`_switch_enabled` 读状态，只有 `off` 才停发。
- 前端 `managementApi.ts` / `NotificationSwitch.vue`：三态类型、原生下拉框、三态文案。
- 文档：`notification-process.md` §1.1/§5.1/迁移清单、`management-api.md`、`feishu-notifications.md`、
  `static-delivery.md`、`backend/README.md`、`aliyun-ecs.md` 的 schema 口径。

## 验收

1. 新库与 v22 升级库都是 `off`；重放迁移不重置已选状态。
2. `off` 下采集照常归档，但 `notification_events` / `notification_deliveries` 不新增，心跳与告警也不生成。
3. `system_only` 下心跳与告警照常投递，业务消息不登记、不投递。
4. 进入 `off` 作废全部未投递记录；进入 `system_only` 只作废业务角色；管理页「待发」相应归零。
5. 切回 `all` 不补发关闭期间内容，之后的新变化与新评论照常投递；`comment_started_at` 前移、`baseline_version` 对齐。
6. 状态表缺失/读不到时按 `off` 处理，归档事务不受影响。
7. API 只接受三态字面量，其余 422；日志字段为 `state=<...>`，不含地址或凭据。

## Comments

- 2026-10-27：实现并验证。后端全量 1086 passed（含新增/改写 17 例闸门测试与 v22→v23 迁移测试）；
  前端 `pnpm typecheck` 通过、单测 294 passed、`tests/e2e/manage.spec.ts` 28 passed（桌面＋移动）。
