# 04 一级评论通知闭环：实施与验收证据

对应票据：[04 一级评论通知闭环](../issues/04-root-comment-notification.md)；实施规格 [spec.md](../spec.md)；正式规则 [飞书通知需求与设计](../../../docs/design/feishu-notifications.md)；实现契约 [通知进程与事件投递](../../../docs/backend/api/notification-process.md)；上游证据 [01 动态变化闭环](01-dynamic-change-notification.md)、[02 一级评论精确链接](02-root-comment-deep-link.md)、[09 小时心跳](09-hourly-heartbeat.md)。

结论：**票据范围（一级评论从真实归档写事务 → 事务发件箱 → 双群受控投递 → 本站精确阅读）已实施并取得自动化主链、迁移与隔离浏览器证据**。真实飞书群投递、飞书内置浏览器/手机实机、三进程托管与目标环境运行未验证，也未部署。楼中楼回复（05）、复杂故障矩阵（06）、告警（08）不在本票范围。

## 1. 环境与命令

- 环境：Linux；Python 3.12.15（`uv sync --locked`）；Node 24.21.0 + pnpm 10.34.6（`.nvmrc`）；本机设置了 `HTTP(S)_PROXY`，跑 e2e 需 `NO_PROXY=127.0.0.1,localhost`。
- 隔离：临时 SQLite；B 站页面/详情/评论页由受控字节替身给出；飞书是进程内 `httpx.MockTransport` 接收端；全部身份、动态、评论、正文与凭据均为虚构值（`fiction-token`、`https://archive.example.invalid`）。
- 集成：分支 `feat/feishu-04` 基于 `feat/feishu-notifications`，完成前已 merge 集成 tip（含 01/02/03 与 09 的心跳 schema、窗口修复；本票最后一次合并是 `4e855dd`，并已在合并后重跑下述命令）。迁移号协调：**09 占用 v17（心跳时段表、`notification_deliveries.expires_at`、`system` 角色），本票的评论增量顺延为 v18**，两侧结构、既有断言与迁移链（`<17` 心跳 → `<18` 评论 → `PRAGMA 18`）都保留。

```sh
# 本票主链（真实归档链 + 临时 SQLite + 受控飞书替身）
uv run --no-sync python -m pytest backend/tests/test_root_comment_notifications.py -q
# 12 passed

# 评论消息模板与预算（含 01 既有载荷用例回归）
uv run --no-sync python -m pytest backend/tests/test_notification_protocol.py -q
# 32 passed

# 迁移（含 01/09 既有用例与 v18 增量）
uv run --no-sync python -m pytest backend/tests/test_notification_migration.py backend/tests/test_notification_delivery.py -q
# 13 passed

# 后端全量回归（含采集/归档/评论/媒体/心跳/部署进程/迁移；合并 03 后）
uv run --no-sync python -m pytest backend/tests -q
# 909 passed, 3 warnings

# 前端一趟绿灯（typecheck + 单测 + e2e 项目声明守卫）
cd frontend && pnpm check
# Tests 271 passed；e2e 项目覆盖与声明一致

# 生产装配 + 归档 HTTP 替身（桌面与 Pixel 7 两个项目）
pnpm test:e2e
# 198 passed, 10 skipped（含 03 新增的回复定位 spec）

# 本票新增：真实投递产物链接 → 生产浏览器读取（独立端口 4179/4326、独占 SQLite）
pnpm test:e2e:notification
# 2 passed

# 相邻入口回归（实际 API + 隔离 SQLite）
pnpm test:e2e:location   # 4 passed（含 03 的回复定位 2 例）
pnpm test:e2e:manage     # 7 passed
pnpm check:dist          # 两次构建 + 产物隔离通过
```

## 2. 红绿过程（TDD）

1. 先写 `backend/tests/root_notification_support.py`（受控来源多动态夹具、双 UP 配置、投递产物断言助手）与首个主链用例，运行得红：`assert [] == [WEBHOOK, ALL_WEBHOOK]`——根评论已归档但没有任何投递。过程中被夹具纠正两次：`add_target` 的归属校验必须走受控上游（不能跳过真实校验）；页面替身必须带 CONTENT 模块（`author_html` 只有作者，正文解析会 `Invalid …`）。
2. 实现 `outbox.migrate_comments` + `record_root` + `storage._change_roots` 接线 → 首个用例转绿（2 群、模板、归档原文不变、发送时经 02 定位入口可读到该评论）。
3. 路由矩阵用例先红（系统群收到业务评论 / 另一受监控 UP 被误判为本人），实现“作者 UID == 动态所属 UP 的字符串相等”后转绿；同时把断言改成集合比较——`execute_pending` 多目标并发，事件 id 顺序不稳定，顺序断言会假红。
4. 起点用例先红（旧评论也通知），实现 `comment_started_at` 与“起点按秒取整”后转绿。
5. 候选用例先红（缺字段直接没事件也没候选），实现 `notification_candidates`（记录原阶段）与补齐转换后转绿。
6. 去重/计数下降、后页失败、停止门闩、事务回滚、快照冻结依次先红→绿；期间被测试纠正两处实现缺陷：`_register_comment` 漏取 `comment_id`（`NameError` 被采集侧折叠成 `internal_error`，表现为“根同步失败”）、`_clip` 在整段被裁完时丢掉截断标记（会让“长标题+长昵称+长正文”的提示消失）。
7. 迁移用例先红（v16/v17 库升级后 `comment_started_at` 为 NULL），补“只回填 NULL 的升级时刻”后转绿。
8. 浏览器用例先红（只收到 1 条投递）：`live_app` 的夹具评论作者是“虚构楼主”，按真实路由只发全员群。把“刚发表”的夹具评论作者改为该动态所属 UP 后转绿——这里改的是夹具事实，不是放宽路由规则。

## 3. 验收条件 → 证据

| 票据验收条件 | 证据（用例/产物） |
| --- | --- |
| 开始有效通知阶段时持久保存起点，不等首次全量归档结束；已有归档静默作为基线 | `test_comment_start_filters_history_and_keeps_the_same_second_new`（归档前断言 `notification_phases` 已有起点）、`test_existing_archive_stays_silent_when_comment_notifications_restart`（已归档评论在重新启用后仍静默）、`test_upgrade_never_backfills_already_archived_comments` |
| 10:00 启用：09:59 静默、10:01 通知；无归档/有归档/同秒边界；不以采集时间代替发表时间 | `test_comment_start_filters_history_and_keeps_the_same_second_new`（以持久起点构造 `-60s`、同秒、`+60s` 三个样例，旧评论照常归档但不发）、`test_existing_archive_stays_silent_when_comment_notifications_restart`、协议用例 `test_root_comment_time_is_beijing_seconds_regardless_of_source_offset` |
| 新根评论与合格事件/候选同事务保存；候选取得资格原子转事件；提交前失败/回滚与提交后重启不造成孤立事件或永久遗漏 | `test_rollback_of_comment_event_leaves_no_partial_notification`（投递表插入失败 → 评论、事件、投递一起回滚，修复后只发一次）、`test_missing_identity_or_time_is_held_as_candidate_and_completed_atomically`（跨重开对象保留候选再补齐）、`test_snapshot_is_frozen_when_the_comment_event_is_generated`（重启后不重复） |
| 作者 UID 或有效发表时间缺失时只留候选并暂缓，后续补齐按原阶段起点判断，不伪造字段或放宽身份校验 | `test_missing_identity_or_time_is_held_as_candidate_and_completed_atomically`（缺 mid / 缺 ctime 各一条候选，补齐后 `up+all` 与 `all` 各按作者判定）、`test_stop_before_comment_commit_keeps_content_without_new_event`（封存阶段的候选不产生事件） |
| 评论保存且可通过 02 入口读取定位后即可投递；后续分页或图片失败不阻塞已就绪评论，不宣称来源集合完整 | `test_up_own_root_comment_notifies_up_and_all_rooms_once`（接收端回调里用真实 `GET /api/archive/dynamics/123/comments/860001/location` 断言 `items[0].id` 就是该评论）、`test_ready_page_delivers_even_when_a_later_page_fails`（第 2 页失败，第 1 页 20 条全部投递，`root_comments_error=ROOT_COMMENTS_FAILED`） |
| 计数增加并发现两条新评论时发送两条；计数下降且无新评论时不发占位或删除通知；重复扫描/补字段/纯编辑不重复 | `test_rescan_edit_and_count_drop_never_duplicate_or_placeholder`（2 条 → 3 条投递；重扫 0 条；计数 3→2、纯编辑 0 条；真正新增 1 条）、`test_routing_uses_dynamic_owner_uid_and_never_the_system_room`（一次 4 条） |
| 至少两个 UP，覆盖本人、同名异 UID、另一受监控 UP 串门、普通作者；按所属动态作者 UID 判定，双群/全员群正确，系统群不收业务评论 | `test_routing_uses_dynamic_owner_uid_and_never_the_system_room`（7 条投递逐项断言；`system` webhook 零命中；另一 UP 在自己动态下用他自己的双群） |
| 规范模板：动态标题或 ID、昵称或作者 UID、北京时间到秒、原正文、可点击具体评论链接；保留换行与回复前缀，不附父评论全文、不上传图片 | `test_up_own_root_comment_notifies_up_and_all_rooms_once`（逐节点断言富文本结构）、`test_root_comment_payload_is_one_message_with_clickable_locate_link`、`test_root_comment_time_is_beijing_seconds_regardless_of_source_offset` |
| 纯图占位、标题空白与昵称缺失回退；来源文本不执行 HTML 或触发任意提及；不修改归档原文 | `test_image_only_comment_uses_the_placeholder_without_uploading_images`（真实归档链 + 载荷无 `img`）、`test_root_comment_blank_title_falls_back_to_dynamic_id`、`test_root_comment_missing_nickname_falls_back_to_author_uid`、`test_root_comment_untrusted_text_is_shown_as_text_without_mentions`、主链用例里“归档正文与评论原文不变” |
| 超长正文在真实载荷限制内安全截断，保留其他字段、全文提示与链接；标题/昵称纳入序列化预算，不拆多条 | `test_over_long_comment_clips_only_the_body_and_keeps_the_link`（20 000 字标题 + 5 000 字昵称 + 40 000 字正文，序列化 ≤ 20 KB、单个载荷、链接完整、含 `……内容过长，点击链接查看全文`） |
| 事件快照冻结内容，逐群记录结果；一个目标失败不重发已成功目标；停止后旧候选不能新增事件，普通重启不重置基线 | `test_snapshot_is_frozen_when_the_comment_event_is_generated`、`test_missing_all_room_waits_for_config_and_only_the_failed_target_resends`（UP 群 `sent`、全员群 `waiting_config/route_missing`，复检后仅补发全员群）、`test_stop_before_comment_commit_keeps_content_without_new_event`、`test_upgrade_never_backfills_already_archived_comments` |
| 从实际归档链驱动飞书替身，取其真实生成的链接进入生产浏览器读取并验证目标 | `tests/e2e-notification/delivery-link.spec.ts`（`pnpm test:e2e:notification`）：真实 Collector 归档 45 条 → 真实 `Dispatcher` 投递 2 群 → 从载荷里取 `href` → 浏览器直开定位第 26 条（第二批）+ 窄屏刷新 |

## 4. 关键设计决定与依据

- **评论起点独立于正文基线**（`notification_phases.comment_started_at`）。01 的 `started_at` 是阶段建立时刻，可能远早于评论通知能力上线；直接复用它会在升级瞬间把 01 部署以来的历史评论判成“起点之后”批量补发。裁决：**升级时已有阶段以升级时刻填评论起点（只补 NULL），升级前已归档以及 01 之后 04 之前发表但未接入评论通知的评论静默**，升级后发表的照常通知。依据：设计 §3.3“起点必须在开始该有效通知阶段时持久建立”“已有记录在启用时静默建立基线”。
- **first insert 与候选补齐分开**。`_change_roots` 传入 `discovered = previous is None`：只有首次插入才可能登记事件或建候选；补字段、纯编辑、重复扫描一律不新增，只有“存在候选且字段补齐”才走转换，并且**按候选原阶段的评论起点**判定。这既满足“补齐后按原起点评估”，也避免把首屏置顶/热评 extras（历史评论、每次首扫都会出现）当成新增。
- **起点按秒取整比较**：`published_at >= floor(comment_started_at)`，与“起点及之后”一致，同秒边界不因亚秒误差被吞掉；比较前两边都解析成时间戳，不做字符串比较（来源是 `+08:00`，服务端“现在”是 UTC）。
- **事件身份 `(kind, dynamic_id, root_id, comment_id)`**：一级评论 `root_id` 就是自身；05 的回复用所属根作 `root_id`，因此“同一源评论 ID 属于不同根”不会撞键。用部分唯一索引（`WHERE comment_id IS NOT NULL`）与既有 `UNIQUE(kind, dynamic_id, version)` 并存，避免重建表、保住 `IF NOT EXISTS` 可重入与旧库降级重放。
- **候选单独成表**，不塞进投递状态机：`claim_due` 的谓词与索引只覆盖 `pending/waiting_config/inflight`，候选不是“待投递的目标”，混进去会变成 60 秒一轮的空转或 `route_missing` 噪音。
- **kind → 模板在投递侧穷尽**（`Dispatcher._payload`）：`dynamic_changed` / `root_comment` / `heartbeat` 各有模板，未知类型仍走 `unsupported_kind` 退避兜底，不再让“登记了事件但没有模板”的消息永久空转。09 合并后沿用它的 `_payload` 结构，没有引入第二套分派。
- **链接基址在发送时读取配置**（与 01 一致）：快照冻结动态/作者/时间/正文，URL 由 `base_url + 02 的 locate 路径` 生成；改基址会影响尚未发出的消息，这是既有裁决，本票不改。
- **逐目标独立**：一个角色缺路由只让该角色进入 `waiting_config`（`error=route_missing`），不做无效 HTTP、不转投其他角色，复检 60 秒后补发；已成功的角色不重发。

## 5. 面向后续票据的稳定契约（06/07 可直接引用）

| 关注点 | 稳定位置 |
| --- | --- |
| 投递状态取值 | `notifications/outbox.py`：`WAITING_CONFIG`/`PENDING`/`INFLIGHT`/`SENT`/`EXPIRED`（常量，文档见契约 §4） |
| 失败分类（`error` 列） | `notifications/message.py`：`DeliveryOutcome.error` ∈ `timeout`/`network_error`/`internal_error`/`http_error`/`invalid_response`/`platform_rejected`/`rate_limited`；缺路由与过期由投递侧写 `route_missing`/`expired`；未知 kind 写 `unsupported_kind` |
| 逐目标结果与 `attempts` | `notification_deliveries`：`role`/`state`/`attempts`/`due_at`/`token`/`lease_until`/`error`/`sent_at`/`expires_at`；**`attempts` 每次回写都 +1，包含 `waiting_config` 复检，因此不能直接当“持续失败次数”**（06/08 需按 `state`/`error` 分流） |
| 角色与路由解析 | `notifications/config.py`：业务角色 `up`/`all` 走 `reference(uid, dynamic_id, role)`（动态覆盖 → UP 默认，不跨角色补位）；`SYSTEM_ROLE` 是顶层 `system` |
| 事件与候选身份 | `notification_events(kind, dynamic_id, version, root_id, comment_id, snapshot)`、`notification_candidates(dynamic_id, comment_id, phase)`；去重索引 `notification_event_comment` |
| 阶段与起点 | `notification_phases(token, uid, dynamic_id, started_at, comment_started_at, baseline_version, sealed)`；阶段有效性判定 `outbox._comment_phase`（未封存 + 仍入选） |
| 领取/回写 | `outbox.claim_due`/`outbox.finish_delivery`；参数常量在 `notifications/delivery.py` |

## 6. 未覆盖与限制（不得据此宣称完整交付）

- **真实飞书群投递与真实客户端未验证**：自动化里的“飞书成功”都是受控接收端返回，不是真实群；飞书内置浏览器/手机实机与目标环境运行属票据 11（需授权）。
- **浏览器证据边界**：`tests/e2e-notification` 只用 Linux Chromium（桌面与 390 宽窄屏模拟），不是真机；它验证的是“投递产物链接 → 生产装配定位”，真实设备/客户端另计。
- Spec 审查发现 02/03 的 `isDetailPath` 不识别精确入口，导致快照与楼中楼来源丢失；修复在 03 的通知树进行，本票不改前端，事件链接形状（`/dynamics/{id}/comments/{rootId}/locate`）不变，修复后本票浏览器用例需按集成 tip 复跑（已随本次合并重跑通过）。
- 楼中楼回复事件与定位（05）、多群复杂故障恢复矩阵（06）、告警与节流（08）、跨事件生命周期（07）未实施；本票只保证一级评论的原子保存、基础去重与有效阶段约束。
- 升级静默的裁决意味着 **01 之后、04 之前发表且未接入评论通知的评论不会补发**；这是为避免历史回填做的显式取舍，需在交付说明中保留。
- 评论定位入口的续读游标不冻结快照（02 的裁决），因此“定位后再翻页”期间窗口边界可能移动；本票消息链接只定位单条，不受影响。
- 通知进程的并发写竞争（三进程同时写同一 SQLite）只在单进程 + 进程内传输下验证，属票据 10。
- 飞书已接收但响应丢失时仍可能重复（用户已接受）；1 秒轮询不是送达承诺。

## 7. 代码与文档指针

- 实现：`backend/bili_monitor/notifications/outbox.py`（`migrate_comments`、`activate` 的评论起点、`record_root`、`_register_comment`、`_candidate`）、`notifications/message.py`（`root_comment`、`comment_href`、`beijing_time`、`_clip`）、`notifications/delivery.py`（`_payload` 分派）、`backend/bili_monitor/storage.py`（`_change_roots` 内同事务登记、`migrate` 的 `<18` 增量）。
- 测试装配：`backend/tests/root_notification_support.py`、`backend/tests/test_root_comment_notifications.py`、`backend/tests/test_notification_protocol.py`（评论模板）、`backend/tests/test_notification_migration.py`（v18 升级静默）。
- 浏览器：`frontend/playwright.notification.config.ts`、`frontend/tests/e2e-notification/delivery-link.spec.ts`、`frontend/package.json` 的 `test:e2e:notification`、`backend/tests/live_app.py` 的 `POST /api/test/notify-roots`（仅测试夹具，不在生产应用注册）。
- 正式契约：[通知进程与事件投递](../../../docs/backend/api/notification-process.md)（§2 配置、§3.1 一级评论、§4 持久状态、§6 载荷、§7 迁移）；运行入口见 [backend/README.md](../../../backend/README.md)「飞书通知进程（01、04、09）」。
