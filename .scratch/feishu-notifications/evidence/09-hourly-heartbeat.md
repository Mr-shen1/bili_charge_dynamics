# 09 小时心跳闭环：实施与验收证据

对应票据：[09 小时心跳闭环](../issues/09-hourly-heartbeat.md)；实施规格 [spec.md](../spec.md)；正式规则 [飞书通知需求与设计](../../../docs/design/feishu-notifications.md) §6.2；实现契约 [通知进程与投递](../../../docs/backend/api/notification-process.md)。

结论：**票据范围（北京时间每小时第 40 分钟窗口 → 系统群心跳 → 过期不投递、错过不补发、同小时去重）已实施，并按已确认规格做过一轮生成窗口收紧修正，取得自动化主链、受控时间边界与迁移证据**。§7 记录合并代理在集成分支复现的 `:41`–`:59` 冷启动迟补缺陷、修复的红绿结果与文档同步；该修正是把实现对齐已确认的需求（第 40 分钟生成、停机错过不追赶），不是需要用户重新决策的事项。真实飞书系统群投递、三进程托管、目标环境运行未验证，也未部署；与 08 告警的 30 分钟节流共存由 10 集成验证。

## 1. 环境与命令

- 环境：Linux，Python 3.12.15（`.python-version`），uv 0.12.23（`uv sync --locked`），pytest 8.4.2。Node/前端未参与本票（无前端改动）。
- 隔离：临时 SQLite；B 站 HTML/JSON 为受控字节；飞书为进程内 `httpx.MockTransport` 替身（01 的同款装配）；时间用受控时钟（同一时刻同时供投递进程 epoch 秒与采集 UTC ISO 字符串）；凭据全部虚构（`fake-system-token`、`https://archive.example.invalid`）。
- 本票新增/更新的测试：

```sh
uv run --no-sync python -m pytest \
  backend/tests/test_notification_heartbeat.py \
  backend/tests/test_notification_migration.py -q
# 17 passed（13 条心跳用例 + 4 条 migration 用例，其中 1 条为本票新增 v16→v17 升级；
# 13 条心跳用例 = 初版 10 条 + 窗口收紧修正新增 3 条）

uv run --no-sync python -m pytest \
  backend/tests/test_dynamic_notifications.py \
  backend/tests/test_notification_protocol.py \
  backend/tests/test_notification_delivery.py \
  backend/tests/test_notification_migration.py \
  backend/tests/test_notification_process.py \
  backend/tests/test_notification_heartbeat.py -q
# 58 passed（01 的 44 条 + 本票 14 条）
```

- 全量后端回归（含采集/归档/评论/媒体/迁移/部署进程用例）：

```sh
uv run --no-sync python -m pytest backend/tests -q
# 本票完成时：880 passed, 3 warnings in 143.03s（本票前基线 869 passed）
# 合并集成 tip c10e70b（含 02 一级评论精确链接）后：881 passed, 3 warnings in 145.62s
# 窗口收紧修正后（已先合并集成 tip e17ce4f）：884 passed, 3 warnings in 159.83s
```

- 合并：`git merge refs/heads/feat/feishu-notifications`（tip `c10e70b`）。冲突只有 `docs/README.md` 索引行，按“01/02/09 证据并列、其余票据未实施”合并；`storage.py` 自动合并后确认 schema v17 与 02 的 `locate_root` 读取契约共存；`frontend/` 与本分支合并前一致，本票未改前端。
- 修正回合的合并：`git merge --no-ff e17ce4f`（09 合并记录与迟补边界记录）与完成前的 `git merge --no-ff c9e9282`（09 重开与既定规格修复记录，只改 `map.md`/`implementation-plan.md`），均无冲突；随后在本分支收紧生成窗口并补测。

## 2. 红绿过程（TDD）

按纵向切片一条一条推进，每片先写用例再补实现：

1. **时段与小时去重**：先写 `test_heartbeat_fires_at_beijing_minute_40_once_per_hour_across_restart`，运行得红
   `AttributeError: 'Dispatcher' object has no attribute 'tick'`（当时只有 01 的 `run_once`，没有任何整点入口）。
   补 `heartbeat.slot()`/`observe()`、`outbox.record_heartbeat()`、`message.heartbeat()`、`Dispatcher.tick()` 后转绿。
   同片两次被测试纠正：① 用例里一度用 `notifier._heartbeat()` 断言去重，属于私有实现耦合，改为断言“同一小时只有一条持久时段 + 没有新请求”；
   ② `heartbeat_generated` 日志字段传了 `slot=2026-10-09T13`，被既有 `notifier_event` 的安全白名单压成 `slot=unknown`，改为只记 `hour=13`（日志仍不泄露内容）。
2. **时区无关**：`test_heartbeat_slot_follows_beijing_time_not_server_timezone` 用 `TZ=Asia/Kolkata`（分钟偏移时区，北京 13:10 时当地 10:40）证明“当地第 40 分钟”不会触发，“北京第 40 分钟”一定触发；再换 `UTC`/`America/New_York`/`Pacific/Kiritimati` 各跑一小时，时段标签仍按北京时间，一次通过（实现用 `datetime.fromtimestamp(now, BEIJING)` 绝对时区换算）。
3. **错过不补发、跨小时跨天**：`test_missed_slots_are_not_backfilled_and_slots_cross_hour_and_day`（13:05 → 停机到 17:39:59 → 17:40 只发一条；23:40 → 次日 00:40 是两条），通过。
4. **过期丢弃 + 系统群缺失**：`test_missing_system_route_keeps_local_diagnosis_and_drops_heartbeat_after_expiry`（系统群缺失 → `waiting_config`/`route_missing` 且零 HTTP；14:40 修好配置时 13 时段已到有效期，旧心跳直接 `expired`，只有 14:40 那条被真正发出）与 `test_failed_system_group_retries_then_stops_delivering_expired_heartbeat`（500 失败指数退避 6 次，跨过有效期后不再尝试旧心跳）。两片通过后发现漏项：先前把两条 `expired` 的 `attempts` 预期写成 2，实际过期发生在领取前、不产生 HTTP，改为 1（用例断言被实现纠正的正是“过期不投递”这条业务规则）。
5. **状态表述真实**：`test_heartbeat_reports_observable_collection_facts_without_claiming_success` 第一次运行得红：断言 3 个目标里“失败 1 个”，实际“失败 2 个”。原因是测试数据把图片段落塞进了 `versioned_html("v1", ...)`，多目标场景下 `id_str` 没替换成对应动态，第 2、3 个目标都以 `value_invalid` 失败。改用既有 `readable_html(id=...)` 构造真实页面（124 页面读取失败、125 带图且媒体上传失败）后，失败 1 个 + 正文待同步 2 个符合预期；同时断言文本里不出现“正常/全部”。
6. **业务消息不被过期规则误删**：`test_heartbeat_expiry_never_drops_business_messages_sharing_the_queue` 第一次运行差一条：漏算了 14:40 会同时生成新时段心跳（预期行数少一条），并纠正“过期前只有 1 次 HTTP 尝试”的实际行为；最终证明超过一小时的业务投递记录（`expires_at IS NULL`）在心跳过期后仍被真正投递。
7. **进程轮询与只写通知状态**：`test_notification_loop_publishes_heartbeat_without_a_second_clock_process`（`Dispatcher.run()` 循环内生成本小时心跳，没有第二个时钟进程）与 `test_heartbeat_only_uses_notification_state_and_never_touches_collection`（一轮心跳只改 `notification_events`/`notification_deliveries`/`notification_heartbeats`，`archives`/`target_checks` 仍是 0 行），通过。
8. **迁移增量**：`test_v16_outbox_is_upgraded_in_place_with_heartbeat_state` 把真实库退回 v16 形状（删 `notification_heartbeats`、`ALTER TABLE ... DROP COLUMN expires_at`、`user_version=16`）再 `Store.migrate()`，证明 v17 原地升级保留已入队业务事件与状态、业务记录 `expires_at` 为 `NULL`。
9. **生成窗口收紧（合并后修正回合）**：先写 `test_first_start_after_the_window_never_backfills_the_hour`，运行得红——
   进程首次启动在 10:41 与 10:55 时各生成并投递了一条 `10:40` 心跳（`AssertionError: assert [{...}] == []`，stderr 两条 `heartbeat_generated hour=10` + `delivery_sent`），与「停机错过不追赶」冲突；
   这正是合并代理在集成分支复现的缺陷（见 §7）。把 `heartbeat.slot()` 的判定由「分钟 `>= 40`」改为「落在 `:40:00`–`:40:59` 整分钟窗口内」后转绿。
   同片另加两条用例守边界：`test_heartbeat_window_is_only_the_fortieth_minute`（10:39:59 不生成、10:40:00 到点、10:40:59 同小时不重复、10:55 重启保留、`TZ=Asia/Tokyo` 下同样以北京时间为准）与
   `test_generated_heartbeat_retries_outside_the_window_until_it_expires`（窗口关闭后已生成待发的心跳仍按退避重试到 `expires_at`，不新增第二条也不改标签）。
   收紧窗口后有三条既有用例变红（它们在 `14:41` 修复配置/重试并依赖迟补生成 14 时段），改到 `14:40`——13 时段有效期恰好在此刻到期，仍然证明“旧心跳作废 + 当前时段照发”，断言对象与业务规则不变。

## 3. 验收条件 → 证据

| 票据验收条件 | 证据（用例） |
| --- | --- |
| 按 Asia/Shanghai 计算第 40 分钟时段，不随服务器时区变化；时段身份与生成结果持久保存 | `test_heartbeat_fires_at_beijing_minute_40_once_per_hour_across_restart`（13:39:59 不生成、13:40:00 生成、标签为北京时间）；`test_heartbeat_window_is_only_the_fortieth_minute`（10:39:59 不生成、10:40:00 到点、10:40:59 不重复、`TZ=Asia/Tokyo` 下仍按北京时间）；`test_heartbeat_slot_follows_beijing_time_not_server_timezone`（`TZ=Asia/Kolkata/UTC/America/New_York/Pacific/Kiritimati`）；`notification_heartbeats` 保存 `slot`/`generated_at`/`expires_at`/`event_id` |
| 同一小时重复调度或进程重启不重复生成；用真实持久状态而非进程内标记 | 同一用例：同小时再 tick 与新开 `Store`+`Dispatcher`（等价重启）都只发 1 条，`heartbeats(path)` 只有该小时 1 行；`test_notification_loop_publishes_heartbeat_without_a_second_clock_process` 证明生成发生在进程轮询里 |
| 停机错过的时段不追赶、过期不投递、有效期不跨下一个时段、恢复后不积压旧心跳 | `test_missed_slots_are_not_backfilled_and_slots_cross_hour_and_day`（13:05→17:39:59 空窗后只发 17:40）；`test_first_start_after_the_window_never_backfills_the_hour`（10:41／10:55 首次启动都不补 10:40，`10:40:59` 冷启动仍生成，`heartbeats` 为空证明确实空缺）；`test_generated_heartbeat_retries_outside_the_window_until_it_expires`（窗口关闭后待发心跳仍重试到有效期，不新增时段）；`test_failed_system_group_retries_then_stops_delivering_expired_heartbeat`（失败重试跨过有效期后不再投递，恢复后只有当前时段）；`expires_at - 上一时段 expires_at == 3600` 且 `expires_at == 下一时段 :40` |
| 心跳只发系统群；系统群缺失/故障保留本地诊断并遵守有效期，不转投业务群、不无限补发过期内容 | `test_missing_system_route_keeps_local_diagnosis_and_drops_heartbeat_after_expiry`（零 HTTP、`waiting_config`+`route_missing` 落库、过期后 `expired`）；两个用例都断言只有系统群 URL 收到请求，UP 群 URL 从未出现；`assert_no_credentials` 证明发件箱无 webhook |
| 只报告可观察事实，采集失败/未知/滞后不得说成全部正常，进程存活 ≠ 采集成功 | `test_heartbeat_reports_observable_collection_facts_without_claiming_success`（真实采集产生 1 个检查失败 + 2 个正文待同步，文本逐行断言）；`test_heartbeat_reports_unknown_state_when_targets_are_not_checked_yet`（纳管 1、已检查 0、最近检查“无记录”）；两例都断言文本不含“正常/全部”；`test_heartbeat_only_uses_notification_state_and_never_touches_collection`（不写归档/检查，不能凭空制造成功） |
| 心跳独立时段去重，不共用故障 30 分钟节流键 | 去重身份是 `notification_heartbeats.slot` 主键（小时），不读不写任何节流状态；`test_heartbeat_only_uses_notification_state_and_never_touches_collection` 限定一轮心跳只改三张通知表（告警表尚未存在，属 08）。与真实 30 分钟节流共存由 10 集成 |
| 动态变化/评论事件不套用过期丢弃规则；共用队列不误删业务待发任务 | `test_heartbeat_expiry_never_drops_business_messages_sharing_the_queue`：同一队列里业务事件停留超过一小时仍被投递（`expires_at IS NULL`），过期心跳 `expired`，两者状态与收到的消息分别核验 |
| 飞书 HTTP 在事务外、凭据与错误脱敏；不承诺离线可达或一秒精准 | 复用 01 的 `claim → 事务外 POST → finish` 结构（本票只在领取事务里加“先丢弃过期心跳”）；错误分类固定为 `route_missing`/`expired`/`http_error`；`assert_no_credentials` 覆盖心跳行与投递行；离线/精准送达边界写入契约 §8 |
| 受控时间覆盖第 40 分钟、跨小时、不同时区、同小时重启、长停顿、网络故障后过期，并核验受控系统群实际收到的消息 | 上述各条用例共同覆盖；断言对象是受控接收端**实际收到的载荷文本**（`message_text`）与投递行状态，不是内部函数调用 |

## 4. 关键设计决定与依据

- **时段身份 = 北京时间 `YYYY-MM-DDTHH`，主键去重**：`notification_heartbeats.slot` 是“每小时最多一条”的持久依据；`notification_events` 的 `UNIQUE(kind, dynamic_id, version)` 再兜一层（心跳事件的 `dynamic_id`/`version` 就是时段身份，`uid` 为空）。两条都不依赖进程内标记，所以重启、重开数据库、重复 tick 都只有一条。
- **有效期 1 小时、写到投递记录**：`expires_at = 时段开始 + 1h = 下一个 :40`，即“不跨下一个心跳时段”。过期处理做成投递层的通用机制：领取事务先 `expire_overdue`（只影响 `expires_at IS NOT NULL`），`_deliver` 前再按同一时钟复查一次。业务记录永远是 `NULL`，因此“共用队列不误删业务消息”是结构性成立，而不是靠约定。
- **生成窗口是第 40 分钟这一整分钟（`:40:00`–`:40:59`），判重只读**：窗口内每秒都会走到心跳入口，因此先用一次只读 `SELECT` 判重，只有时段缺失时才开写事务（汇总状态 + 写时段/事件/投递）；避免同一分钟里每秒抢 SQLite 写锁影响采集。窗口而不是精确整秒，是因为 1 秒轮询只保证 60 次机会，不保证恰好命中 `:40:00`；窗口之外 `slot()` 返回 `None`，本小时再无生成入口。**窗口只约束生成，不约束投递**：已生成待发的心跳仍按退避重试到 `expires_at`。
- **不新增时钟进程**：心跳登记挂在已有通知进程的轮询轮里（`Dispatcher.tick()` = 登记本小时心跳 + 投递到期记录），`run()` 每轮调用它。API/collector 依旧没有通知定时器；`--once` 仍只跑一轮投递（运维排查用），不写心跳。
- **状态文本只取本地事实**：`heartbeat.observe()` 只读 `targets`/`recent_discoveries`（既有 `SELECTED_TARGETS`）、`target_checks` 的 `check_status`/`work`/`last_checked_at`，不访问上游、不写归档。四个维度分别暴露：纳管数、已检查数、最近检查时间（UTC ISO 转北京时间）、失败数、待同步数，并固定加一句“仅报告本地已记录状态，进程存活不等于采集成功”。**不出现“正常/全部正常”**，所以“采集滞后/未知”在文本上都看得见。
- **系统群单独配置**：配置顶层 `system` 引用一个目的地；`NotificationConfig.reference()` 对 `system` 角色直接返回它，不参与 UP/动态覆盖解析，缺失即 `waiting_config`，绝不跨角色补位。
- **迁移 v17 原地升级**：`outbox.migrate` 保持可重入（`IF NOT EXISTS` + `PRAGMA table_info` 判断列），v15（01 之前）与 v16（01 交付）走同一入口，`user_version` 推进到 17；测试基线同步更新（`test_migrations.py` 16→17、未来版本 17→18、`test_inflight_recovery.py`、`test_notification_migration.py`）。

## 5. 未覆盖与限制（不得据此宣称完整交付）

- **真实飞书系统群投递未验证**：所有“成功”都由受控接收端返回，不构成真实群验收（属 11，另需授权）。
- **与 08 告警的 30 分钟节流共存未集成验证**：本票只保证心跳去重与告警节流是两套状态（心跳不读写任何节流键）；组合行为（同小时既告警又心跳、系统群故障不递归）由 10 收口。
- **三进程托管未落地**：`backend/bili_monitor/service.py` 仍只托管 API＋collector，`--once`/systemd 第三进程属 10。
- **离线/强杀不补发也不承诺可达**：心跳只在通知进程存活且轮询落在第 40 分钟窗口内时生成；整机停机、进程重启晚于 `:40:59` 的时段永久空缺（符合“错过不追”），也不能据此判断采集是否失败。
- **投递时刻不是精准的 :40:00**：窗口是整分钟，1 秒轮询加上队列与网络耗时，实际送达常是 `:40:00` 之后的若干秒（最长到本分钟末）；消息标签仍是时段（`:40`），不代表送达时刻。
- **状态文本不是健康度评分**：只按最近一次检查状态汇总，不区分“本轮尚未检查”与“检查长期不更新”的具体阈值；滞后通过“纳管 vs 已检查”和最近检查时间暴露，不做额外推断。
- **`attempts` 不是故障计数**：系统群未配置/待修复时，60 秒复检会不断累加该记录的 `attempts`（心跳过期后转为 `expired` 才停止）。08 的“飞书持续投递失败”判定必须按 `state`/`error` 分流，不能只看 `attempts`，否则等待配置的心跳会被刷成故障告警。
- 队列容量、多目标写竞争与资源测量属 10；飞书已接收但响应丢失仍可能重复（用户已接受）。

## 6. 代码与文档指针

- 实现：`backend/bili_monitor/notifications/heartbeat.py`（时段/有效期/可观察状态）、`outbox.py`（`record_heartbeat`/`expire_overdue`/`claim_due`/`notification_heartbeats` 迁移）、`delivery.py`（`tick`/`_publish_heartbeat`/过期复查/`_payload` 分派）、`message.py`（`heartbeat` 载荷）、`config.py`（顶层 `system` 角色）、`storage.py`（`user_version = 17`）。
- 测试装配：`backend/tests/test_notification_heartbeat.py`（新增，13 例：初版 10 + 窗口收紧 3）、`backend/tests/test_notification_migration.py`（+1 例 v16→v17）、`backend/tests/notification_support.py`（`config_mapping(system=...)`）。
- 契约文档：[通知进程与投递](../../../docs/backend/api/notification-process.md)（§1 轮询含心跳、§2 `system`、§3.1 小时心跳、§4 持久状态、§5 参数、§7 迁移 v17、§8 未覆盖）；索引 [docs/README.md](../../../docs/README.md)；运行入口 [backend/README.md](../../../backend/README.md)「飞书通知进程（01、09）」。
- 后续：10 负责三进程与告警/心跳共存台账；11 负责真实系统群与设备验收。

## 7. 合并后复核与修正：`:41`–`:59` 冷启动迟补已收紧到第 40 分钟窗口

合并代理在 tip `4d69f86`（源 `5c18193`）上复核，发现并记录了一条实现与已确认规格的偏差；本轮把它修掉，不是需要用户重新决策的事项。

### 7.1 发现的缺陷（合并代理复现）

- 代码事实（修正前）：`heartbeat.slot()` 只按「当前北京时间分钟数是否 `>= 40`」判定时段成立，不校验“生成时刻是否落在此刻正在经过的第 40 分钟”。
- 复现方式（受控时钟，一次 `Dispatcher.tick()`，进程首次启动即在 10:55、10:40 从未运行过）：得到 `notification_heartbeats.slot = 2026-10-09T10`、投递状态 `sent`、有效期 `2026-10-09T11:40`，接收端首行为 `心跳【2026-10-09 10:40】通知进程存活`——一条比标称时刻晚 15 分钟的心跳；最坏情况 `:59:59` 冷启动，迟补接近 20 分钟。
- 判定：与正式设计 §6.2 / 规格 / 本票「北京时间每小时第 40 分钟生成」「停机错过不追赶」冲突，属实现偏差。用户已确认的规格没有歧义，因此按原规格修正，不新开决策。
- 既有用例为何没发现：`test_heartbeat_fires_at_beijing_minute_40_once_per_hour_across_restart` 在 13:59:59 重启，但 13 时段已存在（走的是去重分支）；`test_missed_slots_are_not_backfilled_and_slots_cross_hour_and_day` 恢复到 17:39:59，恰好落在 `:40` 之前。§5 只写过“送达时刻常是第 40 分钟后的若干秒”，未覆盖冷启动窗口。

### 7.2 修正（TDD 红 → 绿）

- 红：新增 `test_first_start_after_the_window_never_backfills_the_hour`（首次启动在 10:41 与 10:55 都不应补 10:40；`10:40:59` 冷启动仍应生成），在修正前运行失败——两个空库各发出一条 `10:40` 心跳（`heartbeat_generated hour=10` + `delivery_sent`，`receiver.requests` 有 2 条）。
- 绿：`heartbeat.slot()` 改为「`now` 落在北京时间 `:40:00` ≤ now < `:41:00` 才返回时段」，窗口外返回 `None`。同一张用例转绿；三条既有用例（在 `14:41` 依赖迟补生成 14 时段）改到 `14:40` 后同样通过，断言意图不变。
- 同时新增 `test_heartbeat_window_is_only_the_fortieth_minute`（10:39:59 不生成／10:40:00 到点／10:40:59 同小时不重复／10:55 重启保留／`TZ=Asia/Tokyo` 仍按北京时间）与 `test_generated_heartbeat_retries_outside_the_window_until_it_expires`（窗口关闭后待发心跳继续退避重试到 `expires_at`）。
- 窗口取整分钟而不是精确秒：1 秒轮询只保证一分钟内有 60 次机会，要求“恰好 `:40:00`”会因为一次调度抖动整天不生成。
- 不改变的部分：有效期仍到下一个 `:40`；已生成待发的心跳仍可在 `expires_at` 之前重试；动态变化/评论业务消息与（后续 08 的）告警不受窗口或过期规则影响；迁移（schema v17）无变化。

### 7.3 修正后实测

```sh
uv run --no-sync python -m pytest backend/tests/test_notification_heartbeat.py -q
# 13 passed
uv run --no-sync python -m pytest backend/tests/test_notification_heartbeat.py backend/tests/test_notification_migration.py -q
# 17 passed
uv run --no-sync python -m pytest backend/tests/test_dynamic_notifications.py \
  backend/tests/test_notification_protocol.py backend/tests/test_notification_delivery.py \
  backend/tests/test_notification_migration.py backend/tests/test_notification_process.py \
  backend/tests/test_notification_heartbeat.py -q
# 58 passed
uv run --no-sync python -m pytest backend/tests -q
# 884 passed, 3 warnings in 159.83s（合并集成 tip c9e9282 后再跑一次：884 passed, 3 warnings in 161.94s）
```

### 7.4 文档同步与边界

- 长期契约同步：[通知进程与投递](../../../docs/backend/api/notification-process.md) §1（轮询小节引用改正为 §3.1）、§3.1（窗口定义、`:41` 起冷启动不补、窗口只约束生成不约束投递）、§5 参数表（心跳时段 = 第 40 分钟窗口）；运行说明 [backend/README.md](../../../backend/README.md) 同步一句窗口措辞。
- `map.md` 与 `implementation-plan.md` 中“是否收紧需另立决策”“迟补边界待决策”属于合并代理的记录，按分工由合并代理统一更新，本票不编辑这两份文件。
- 仍未覆盖：真实飞书系统群投递、与 08 告警节流的共存（10）、三进程托管与目标环境（10/11）。窗口收紧不改变这些未验证边界。
