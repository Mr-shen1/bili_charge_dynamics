# 通知状态三态（`all` / `system_only` / `off`）

Status: resolved

用户 2026-10-27 裁决：**页面上那个开关不该是一个“暂停键”，而应该是一个状态**，由状态决定具体操作；
并且“关闭”意味着**彻底不发**——不产生、不排队、重开也不补发。同时**飞书进程默认启动**，心跳与运维
告警是必要能力，所以“关闭”只是不发，不是停进程。

这**推翻**票据 14 的「方案 A：关闭期间积压保留并补发」（`docs/backend/api/notification-process.md:41`、
`docs/design/feishu-notifications.md:185`、`docs/backend/api/management-api.md:71`）。

依据：[通知进程契约](../../docs/backend/api/notification-process.md)、[飞书通知设计](../../docs/design/feishu-notifications.md)、
[14 通知总开关](../feishu-notifications/issues/14-notification-gate.md)。

## 问题陈述

票据 14 的闸门只装在**投递侧**：关闭时通知进程不领取、不发送、不生成心跳，但事件登记发生在采集写
事务里（`storage.py:647`、`:829`、`:1054` → `notifications/outbox.py` 的 `record_body` / `record_root` /
`record_reply`），完全不受闸门影响。于是关闭期间的每次正文变化、每条新评论都照常入队为 `pending`，
重开时按 5 次/秒、100 次/分钟一次性补发。

用户的实际用法是「先关掉、安静爬一段数据，之后再打开只收新消息」。旧语义在这种用法下会一次吐出
成千条迟到消息，与「关闭」的直觉相反，也让「先爬数据再启用」无法进行。此外布尔开关只能表达
「全发／全不发」，无法表达「只保留心跳与告警、业务消息先别发」这个中间态。

## 解决方案

把布尔闸门换成**持久三态枚举**，并把它同时装在**登记侧**与**投递侧**：

| 状态 | 业务消息（动态变化／一级评论／楼中楼） | 系统消息（心跳／告警） |
| --- | --- | --- |
| `all` | 登记 + 投递 | 登记 + 投递 |
| `system_only` | 不登记、不投递 | 登记 + 投递 |
| `off` | 不登记、不投递 | 不登记、不投递 |

1. **登记侧闸门**：`record_body` / `_record_comment` / `record_alert` / `record_heartbeat` 在写事务内读
   一次状态，不满足即返回——不写事件、不写投递记录、不写候选、不推进正文基线。采集与归档本身
   完全不受影响。读不到状态按关闭处理，且**绝不让通知的存储问题拖垮归档事务**。
2. **切换即收敛队列**：进入 `off` 作废全部未投递记录；进入 `system_only` 只作废业务角色的未投递
   记录；`inflight` 无法撤回，由那一轮投递自行收尾。
3. **切回 `all` 前移起点**：对每个未封存且仍在入选的阶段，`comment_started_at` 置为切换时刻、
   `baseline_version` 对齐当前已归档可信版本（与 `activate` 同口径）；阶段延续、去重种子不清。
   关闭或仅系统期间的内容因此永不补发。
4. **默认 `off`**：新库与 v22 升级库一律 `off`，需要用户显式选择收哪一类。新语义下「默认不发」比
   「默认全发」安全：升级或首次部署瞬间不会突然开始投递没预期的消息。
5. **管理页改成下拉框**：三个选项（全部通知／仅心跳与告警／全部关闭），状态行与提示同步改成
   三态口径。

不做的事：不改事件身份与去重口径、不改限速、不改路由、不改心跳时段规则、不新增接口路径、
不引入「撤回已发送消息」、不改进程启停（仍由 `BILI_NOTIFICATION_CONFIG` 决定）。

## 关键取舍

- **重建表而不是加列**：`notification_gate` 从 `(id, enabled)` 重建成 `(id, state)`，避免两个真相。
  迁移幂等：已是三态表时直接返回，重放迁移不重置用户选择。
- **不删阶段**（`notification_phases`）：阶段令牌被 `notification_body_claims` 的 generation 引用，
  删阶段会让后续写事务静默丢弃全部通知；改基线与起点是等价且更安全的做法。
- **`inflight` 不撤销**：已经发出的 HTTP 请求无法撤回，窗口是单批投递时长。
- **`pending` 在 `off` 下恒为 0**：因为队列在切换瞬间就被作废，管理页「待发 N 条」不再需要解释
  「关着但攒着」。

## 验证入口

- 后端：`backend/tests/test_notification_gate.py`（17 例：默认 `off`、三态往返、`off` 不登记不投递、
  `system_only` 只发系统、切回 `all` 不补发且基线对齐、读不到状态不阻断归档、日志与 API 契约）。
- 迁移：`backend/tests/test_notification_migration.py`（v22 布尔闸门 → v23 三态、重放不重置）。
- 前端：`frontend/tests/unit/manage-notification.test.ts`、`tests/unit/management-api.test.ts`、
  `tests/e2e/manage.spec.ts`（下拉框切换与刷新一致性）。
