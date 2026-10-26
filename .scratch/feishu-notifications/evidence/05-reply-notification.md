# 05 楼中楼回复通知闭环：实施与验收证据

对应票据：[05 楼中楼回复通知闭环](../issues/05-reply-notification.md)；实施规格 [spec.md](../spec.md)（§2 资格与快照、§3 阶段/起点/去重、§4 持久与原子、§5 路由、§6 领取投递、§7 精确读取）；正式规则 [飞书通知需求与设计](../../../docs/design/feishu-notifications.md)（§2 模板与路由矩阵、§3.2/§3.4 评论资格与阶段、§5 精确链接、§7 FS-AC-02/04/05/07/11）；实现契约 [通知进程与事件投递](../../../docs/backend/api/notification-process.md)（§3.2 新增）；上游证据 [03 楼中楼回复精确链接](03-reply-deep-link.md)、[04 一级评论通知闭环](04-root-comment-notification.md)、[06 双群独立投递与故障恢复](06-delivery-routing-recovery.md)。

结论：**票据范围（回复写事务内登记事件/候选、双群按回复作者路由、历史静默与同秒起点、字段补齐原子转事件、单条/单页就绪即投递、去重与跨重启、投递产物链接在生产前端宽窄屏直达后续页回复）已实施并取得自动化主链、迁移与浏览器证据**。真实飞书群、飞书内置浏览器/手机实机、三进程托管与目标环境运行**未验证**（属票据 10/11，需另行授权）。

## 1. 环境、基线与命令

- 环境：Linux；Python 3.12.15（`uv sync --locked`，uv 0.12.23）；Node 24.21.0 + pnpm 10.34.6（`.nvmrc`）。本机设置了 `HTTP(S)_PROXY`，浏览器用例统一加 `NO_PROXY=127.0.0.1,localhost`。
- 分支与集成：工作树 `/tmp/feishu-worktrees/05`，分支 `feat/feishu-05`，基于 `feat/feishu-notifications`；开工 tip `9b868f1`（含 02/03 精确入口返回恢复修复），交付轮合并集成 tip `eab38ce`（含 06 双群独立投递与故障恢复，代码 tip `fb2e77b`）。**合并核验修复轮**从 `8822f1f` 起，先合并集成 tip `0f79ed7`，提交前再合并最新集成 tip `16fc18e`（重开本缺陷的文档提交，合并后 focused 回归重跑仍 264 passed），再在 worktree 内完成本轮修复；本轮只重跑 focused 回归（主链 18 passed、专项相邻 264 passed），全量与前端数字是上一轮记录、已明确标注未重跑。
- 迁移号协调：01→v16、09→v17、04→v18、06→v19（`failures`/`last_failed_at` 与到期/租约索引）；**本票顺延为 v20**（只重建 `notification_candidates` 主键，不触碰 06 的投递列、索引、错误分类与配置形状）。两侧分支在同一 `migrate` 里顺序执行，各自可重入。
- 隔离：临时 SQLite；B 站页面/detail/评论页/楼中楼页由受控字节替身给出；飞书在单测里是进程内 `httpx.MockTransport`，在浏览器用例里是 `live_app` 进程内的受控接收端（消息链接是其实际投递产物）。身份、动态、评论、回复、正文与凭据全部虚构（`fake-up-token`、`https://archive.example.invalid`）。未读取真实 `notifications.json`/Cookie/凭据，未向真实飞书或 B 站发请求，未部署、未推送。

```sh
# 本票主链（真实归档链 + 临时 SQLite + 受控飞书）
uv run --no-sync python -m pytest backend/tests/test_reply_notifications.py -q
# 18 passed（原有 12 条 + 本轮合并核验修复新增 6 条纯图占位/快照冻结用例）

# 专项与相邻回归（回复定位契约、既有回复同步、04 根评论主链、01 正文、投递、协议、两侧迁移、在途生命周期）
uv run --no-sync python -m pytest backend/tests/test_reply_notifications.py \
  backend/tests/test_reply_location.py backend/tests/test_replies.py \
  backend/tests/test_root_comment_notifications.py backend/tests/test_dynamic_notifications.py \
  backend/tests/test_notification_delivery.py backend/tests/test_notification_protocol.py \
  backend/tests/test_notification_migration.py backend/tests/test_migrations.py \
  backend/tests/test_inflight_lifecycle.py -q
# 264 passed（上一轮 258 + 本轮新增 6 条）
```

以下数字是**上一轮交付时**的记录，本轮合并核验修复**未重跑**（按票据要求只跑 focused 回归，不重复全量）：上一轮全量 941 条加上本轮新增的 6 条用例后未在本轮重跑验证，交付/build 级数字以合并方统一重跑为准；本票无 UI 改动，新增用例全在 `backend/tests/test_reply_notifications.py`。

```sh
# 后端全量回归（合并集成 tip 后）
uv run --no-sync python -m pytest backend/tests -q
# 941 passed, 3 warnings in 156.11s

# 前端一趟绿灯（类型检查 + 单测 + e2e 项目覆盖守卫）
cd frontend && pnpm check
# Tests 275 passed（24 files）；e2e 项目覆盖与各 spec 声明一致

# 生产装配 + 归档 HTTP 替身（桌面 1280 与 Pixel 7 两个项目）
NO_PROXY=127.0.0.1,localhost pnpm test:e2e
# 203 passed, 10 skipped

# 本票的浏览器证据（投递产物链接；独立端口 4179/4326，不与 04/03 抢端口）
NO_PROXY=127.0.0.1,localhost pnpm test:e2e:notification
# 4 passed（04 的 2 例 + 本票 2 例，同一隔离 SQLite 顺序执行）

# 相邻入口回归
NO_PROXY=127.0.0.1,localhost pnpm test:e2e:location    # 4 passed
NO_PROXY=127.0.0.1,localhost pnpm test:e2e:manage      # 7 passed
NO_PROXY=127.0.0.1,localhost pnpm test:e2e:production  # 3 passed, 3 skipped
pnpm check:dist                                        # 两次构建 + 产物隔离通过
```

- 未运行：真实飞书群投递、飞书内置浏览器/手机实机、真实 B 站采集、三进程托管与部署（票据 10/11）；视觉基准（本票没有样式改动）。
- 时间：起点/同秒边界用来源 `ctime` 与阶段 `comment_started_at` 的真实值；门闩用 `asyncio.Event` 控制提交顺序，没有长时间真实 sleep。

## 2. 红绿过程（TDD）

1. **回复事件与投递**（`test_up_own_reply_notifies_up_and_all_rooms_once`）：先写“UP 本人的回复进两个群、消息是统一模板、链接是回复精确入口”。红在两处：投递只发出一条全员群消息（只有所属根的事件），且回复的两条投递记录为 `pending/unsupported_kind`——`delivery._payload` 还没有 `reply_comment` 分派、`message` 没有回复链接。补 `outbox.record_reply`、`message.reply_comment`/`reply_href`（与一级评论共用同一个 `_new_comment` 模板函数）与 kind 分派后转绿。
2. **路由按回复作者而非被回复者**（`test_routing_uses_the_reply_author_not_the_replied_to_identity`）：先写“UP 本人回复普通人 → 双群；普通人回复 UP 的评论 → 仅全员群；同名异 UID、另一受监控 UP 串门 → 仅本次动态的全员群，系统群与我方其他 UP 的目的地零命中”。绿在复用 04 的作者 UID 判定（没有为回复新建第二套身份规则）；该用例同时锁定“被回复者身份不参与路由”。
3. **起点、历史静默与同秒**（`test_reply_start_filters_history_and_keeps_the_same_second`）：起点前 60 秒的旧回复只归档不通知，起点同秒与之后各通知一条；`published_at` 保留 `+08:00` 来源偏移，不用采集时间补造。
4. **字段候选与补齐**（`test_missing_reply_identity_or_time_is_held_as_candidate_and_completed_atomically`）：缺作者 UID／缺发表时间只写候选（带所属根），补齐后按原阶段起点原子转事件；同轮出现的历史回复仍静默，补齐不重设起点。
5. **旧阶段候选不越界**（`test_stopped_phase_reply_candidate_cannot_be_completed_in_the_new_phase`）：停用再启用（新阶段、新起点）后补齐字段，候选被消费但不生成事件；归档字段照常写入。
6. **单条/单页就绪即投递**（`test_ready_reply_pages_deliver_while_a_later_page_fails`）：25 条回复第 2 页失败时，第 1 页 20 条照常进两个群，`replies_error` 如实保留 `REPLIES_FAILED`，不宣称整轮完整。
7. **根扫描失败不取消已就绪条目**（`test_root_scan_failure_does_not_cancel_ready_replies_or_claim_completeness`）：根页整体失败时 `ROOT_COMMENTS_FAILED`、`work.comments` 不为 success，但停用前已登记且未投递的回复事件照常发出（这就锁定了“局部失败既不虚报完整、也不收回资格”）。
8. **去重与重启**（`test_rescan_repagination_and_field_completion_never_duplicate_reply_events`）：整楼重新分页 + 补字段（点赞）+ 纯编辑 + 新增一条起点前旧回复，事件数不变；重开采集/投递对象（等价进程重启）后仍不重复。
9. **事务回滚**（`test_rollback_of_reply_event_leaves_no_partial_notification`）：用 `BEFORE INSERT ON notification_deliveries` 的 `RAISE(ABORT)` 制造失败，回复内容与事件一起回滚（`replies` 表为空）；撤掉触发器后重跑只成功发送一次。
10. **提前 Spec 审查的两项（本票修复）**：
    - **① 阶段必须绑定领取时的身份**：`test_late_root_comment_from_a_stopped_execution_cannot_join_the_new_phase` 与 `test_late_reply_from_a_stopped_execution_cannot_join_the_new_phase` 先写“旧执行已领取写代次 → 目标停用再启用（新起点）→ 旧执行迟到提交”。**跑在 04 的实现上是红的**：迟到的一级评论真的进了新阶段（多出一条 `root_comment` 事件）。根因是 `record_root` 只用“当前未封存阶段 + 仍入选”推导阶段（`outbox._comment_phase`），而正文路径早已用 `notification_body_claims`（generation → phase）绑定。改为**根/回复/正文共用领取时绑定**（`_active_phase` 连带返回 `comment_started_at`，删除 `_comment_phase`）后转绿，且用例显式断言“评论起点早于该回复的发表时间”，证明拦住它的只能是阶段绑定而不是起点比较。两条用例还各带一条收尾断言，证明新阶段照常工作（重新领取后的新评论仍通知）。
    - **② 候选主键必须含所属根**：`test_reply_candidates_keep_their_owning_root` 断言候选行是 `(dynamic_id, root_id, comment_id)` 且 `PRAGMA table_info` 的 PK 顺序就是这三列。把 v20 迁移临时关掉重跑为红：候选写入失败 → 回复分页整体回滚（日志 `root_sync_failed reason=storage_error`），回复根本没归档——**说明不放宽存储校验、也不靠“碰不到”来回避**；加上 v20 重建后转绿。
11. **迁移**（`test_v19_upgrade_keys_existing_candidates_by_their_owning_root`，在 `test_notification_migration.py`）：建库 → 退回 v18 候选形态（旧主键、无 `root_id`）→ `migrate` 到 v20，旧候选按自身回填 `root_id` 且阶段令牌不变；再迁一次仍是 v20 且不丢候选。06 的 v19 用例（`test_v18_outbox_gains_failure_facts_without_backfilling_attempts`）数字同步顺延到 v20 并继续断言“`attempts` 不倒推成失败次数”。

被测试纠正的三处写法：宽屏断言“目标在第 2 页”错了——“刚发表”的回复按发表时间排序落在最后（末页 5 条），改为固定第 3 页并用真实定位响应的 `page` 交叉核对；路由用例里 `delivered_replies` 最初把一级评论也当回复参与排序（`None` 与元组比较报错），改为只统计回复消息；候选用例最初把回复挂在另一个根上（`source.replies` 只登记真实存在的根），修正为同一根。

12. **合并核验修复：已知纯图回复的占位（本轮，05 重开 claimed 后 TDD）**：上一轮把“纯图回复显示空正文”当结论交付，属于规格偏差——设计 §2.1 要求“已知无文字但有图片的评论”显示 `【图片评论，点击链接查看】`，并声明该兜底“不扩大现有回复图片采集范围”。根因是 `replies.reply_document` 用 `comment_fields` 组装文档，**整体丢弃了来源响应里已有的 `content.pictures`**，归档回复没有任何媒体信号，`outbox._register_comment` 的 `has_media` 恒为 `False`；纯图回复因此双群各发一条 `内容：` 空行（一级评论走 `root_document.media_sources` 一直正常）。
    - **先红**：`test_image_only_reply_uses_the_placeholder_and_records_only_picture_presence` 用受控来源给回复 `content={"message": "", "pictures": [一张]}`，驱动真实归档写事务 → 真实 `Dispatcher` → 进程内飞书接收端，断言实际投递文本是 `内容：【图片评论，点击链接查看】`。**跑在旧实现上是红的**：投递文本为 `内容：`（正文为空、无占位），归档回复里也没有任何图片字段。
    - **再绿**：`reply_document` 新增 `has_pictures`（`None` 未知 / `True`/`False` 已知），复用与根评论同一条 `media_sources(pictures, "img_src", "img_")` 形状与 URL 校验但**只落布尔值**——不保存回复图片 URL、不下载上传、不新增上游请求、不改前端回复图片范围；`_register_comment` 的 `has_media` 追加该信号。归档 `text` 仍是来源空串，`notification_events.snapshot.has_media` 在登记时冻结为 `True`。
    - **必要边界（同批红→绿）**：`test_reply_text_with_pictures_keeps_the_source_text`（有文字+图片照旧显示原文，不被占位替换）；`test_empty_reply_text_without_known_pictures_keeps_the_original_empty_body`（参数化 `unknown-missing-key`/`confirmed-empty`：无图或来源未给键时保持原空正文行为，不凭空造占位，`has_pictures` 分别为 `None`/`False`）；`test_registered_reply_keeps_its_frozen_has_media_across_rescan`（先以未知发出空正文，重扫补出图片存在性后文档变 `True`，但已登记事件快照仍是 `False` 且不重发）；`test_candidate_completion_keeps_known_picture_presence_for_the_placeholder`（候选补齐沿用既有元信息合并语义：先已知有图、后来来源缺键也不会被抹成无图，补齐后按占位发送）。根评论不退化由 04 的 `test_image_only_comment_uses_the_placeholder_without_uploading_images` 与协议层 `test_root_comment_image_only_uses_placeholder_and_never_uploads_images` 在同一轮 focused 回归里守住。
    - **阅读契约不变**：`Store._reply_reading` 把 `has_pictures` 从阅读投影里摘掉（它只是通知用的簿记），主链用例顺带断言回复阅读接口既不发布该键、也看不到图片 URL；`test_replies.py` 的既有回复项逐字段断言无需改动即通过。

## 3. 验收条件 → 证据

| 票据验收条件 | 证据（用例/产物） |
| --- | --- |
| 回复按当前通知起点过滤历史，初始化期间发表的新回复保留资格；不补造发表时间 | `test_reply_start_filters_history_and_keeps_the_same_second`（起点前 60 秒静默、同秒与之后通知、`published_at` 保留 `+08:00`）；起点在启用时即持久（04 的 `started_at`/`comment_started_at` 同一时刻建立，本票不新增时钟） |
| 回复及其合格事件或候选同事务保存；去重使用动态、所属根与稳定回复身份 | `_change_replies` 内 `outbox.record_reply`；`test_up_own_reply_notifies_up_and_all_rooms_once` 断言事件身份 `(reply_comment, 870001, 970001)`；`test_rollback_of_reply_event_leaves_no_partial_notification`（一处失败整体回滚） |
| 根评论/身份/时间/定位条件不全时可靠暂缓，补齐后原子生成一次事件，跨重启不丢候选，不放宽合法归档校验 | `test_missing_reply_identity_or_time_is_held_as_candidate_and_completed_atomically`（候选带根、补齐后转事件、跨重开不丢）；`test_reply_candidates_keep_their_owning_root`（候选键含根）；根/定位条件的边界如实记录：`replies` 外键 + 双方 ID 都是本站合法十进制身份，因此“根不可定位”只表现为回复无法合法归档（这一点在 v20 关闭时被实测为 `storage_error` 整页回滚），**没有放宽外键、来源解析或字段校验** |
| 所属根与回复在本站可展示定位后即可发送，不等其他楼层/后页/媒体；根扫描失败不虚报完整、不取消已就绪资格 | `test_ready_reply_pages_deliver_while_a_later_page_fails`（第 1 页 20 条照常发，`REPLIES_FAILED`）、`test_root_scan_failure_does_not_cancel_ready_replies_or_claim_completeness`（`ROOT_COMMENTS_FAILED` 且 `work.comments != success`，已入队回复仍发出）；发信时点用真实只读定位入口 `/comments/{root}/replies/{reply}/location` 断言目标可读 |
| 本人回复双群、其他回复仅全员群；覆盖普通人、回复 UP、同名用户、另一受监控 UP，始终按回复作者判定 | `test_routing_uses_the_reply_author_not_the_replied_to_identity`（4 种作者 × 2 种被回复者组合 + 系统群/其他 UP 目的地零命中） |
| 统一评论模板、原始正文与上下文；不剥前缀、不附父评论全文、不扩大图片范围 | `test_up_own_reply_notifies_up_and_all_rooms_once` 逐段落断言模板与“第二行 回复 @虚构读者：保留上下文”，并断言归档正文与 `parent_id` 未被改写；模板函数与 04 共用 `message._new_comment`。纯图占位按设计 §2.1 同样适用：`test_image_only_reply_uses_the_placeholder_and_records_only_picture_presence`（空正文 + 已知有图 → `内容：【图片评论，点击链接查看】`，归档 `text` 仍为空串、只多布尔 `has_pictures`、载荷无图片节点与 URL）、`test_reply_text_with_pictures_keeps_the_source_text`、`test_empty_reply_text_without_known_pictures_keeps_the_original_empty_body`（无图/未知保持原空正文） |
| 链接携带完整定位身份，受控投递生成的链接能打开后续页具体回复，宽窄屏都加载、展开并高亮 | `frontend/tests/e2e-notification/reply-link.spec.ts`（真实归档链 + 真实 `Dispatcher` 打到进程内飞书替身，从投递产物取链接）：宽屏直开第 3 页（末页 5 条）、`data-located=true` 唯一、目标贴近视口顶部、分页 `aria-current=3`、归档 `local_reply_count` 仍 25；窄屏刷新后仍直达并高亮、无横向溢出、上游请求计数与归档内容不变 |
| 同回复反复分页、补字段、纯编辑与采集失败重试不重复生成已登记事件；暂停阶段旧候选不借新阶段 | `test_rescan_repagination_and_field_completion_never_duplicate_reply_events`、`test_stopped_phase_reply_candidate_cannot_be_completed_in_the_new_phase`、`test_late_{root_comment,reply}_from_a_stopped_execution_cannot_join_the_new_phase` |
| 事件快照与逐群结果沿用既有不变量；根计数下降但无新回复时不制造删除或占位通知 | 快照在登记时冻结（模板只读快照，重试不读归档）；逐群结果由 04/06 的投递层承担（本票未改投递字段）；`test_ready_reply_pages...` 与 `test_root_scan_failure...` 覆盖“失败保留、不占位”；本票没有新增删除/占位消息路径 |
| 覆盖保存回滚、提交后中断、候选转事件中断和重开去重，回归一级评论通知及两类精确链接 | `test_rollback_of_reply_event_leaves_no_partial_notification`、`test_rescan...`（重开对象）、`test_stopped_phase_reply_candidate...`（候选不越阶段）；相邻回归 258 passed 含 04 根评论主链、01 正文、02/03 定位契约；浏览器 4 passed 含 04 的两条一级评论链接用例 |

## 4. 交付的接口与契约（供 07/08/10 使用）

| 项 | 契约 |
| --- | --- |
| 事件类型 | 新增 kind `reply_comment`（`notifications/outbox.py`）；`delivery._payload` 已穷尽分派，未知 kind 仍走 `unsupported_kind` 退避兜底 |
| 事件身份 | `(kind='reply_comment', dynamic_id, root_id, comment_id)`，`root_id` 为所属根；与一级评论共用 `notification_event_comment` 部分唯一索引 |
| 候选身份 | `notification_candidates(dynamic_id, root_id, comment_id, phase, created_at)`，v20 重建；一级评论的 `root_id` 即自身。补齐后按**候选原阶段**的评论起点转事件，阶段结束即作废 |
| 写入入口 | `outbox.record_root(..., discovered=, generation=)`、`outbox.record_reply(..., root_id, discovered=, generation=)`；`generation` 用于绑定领取时阶段，调用方必须传（`storage._change_roots`/`_change_replies` 已在事务内传入） |
| 阶段有效性 | `outbox._active_phase(connection, dynamic_id, generation)`：同一写代次 + 领取时绑定的阶段未封存 + 目标仍入选，返回 `token`/`baseline_version`/`comment_started_at`。正文、一级评论、回复共用这一个判定（`_comment_phase` 已删除） |
| 消息模板 | `message.reply_comment(snapshot, base_url)` + `message.reply_href(...)`；与 `root_comment` 共用 `_new_comment`，链接 `{base}/dynamics/{d}/comments/{root}/replies/{reply}/locate`；快照 `has_media` 取一级评论的归档媒体或回复的布尔 `has_pictures`，登记时冻结 |
| 回复图片存在性 | 归档回复文档字段 `has_pictures`（`None` 未知 / `True` / `False`），由 `replies.reply_pictures` 从来源 `content.pictures` 推出并沿 `_merge_comment` 的元信息合并语义保留；**不存 URL**，也不经 `Store._reply_reading` 发布到阅读接口 |
| 测试驱动接口 | `live_app`：`POST /api/test/replies {dynamic, root, fresh:[n]}`（`fresh` 的回复按“刚发表”并把作者设为该动态所属 UP）、`POST /api/test/notify`（`/api/test/notify-roots` 保留为别名，投递所有待发事件） |
| 迁移 | `user_version = 20`；`outbox.migrate_candidate_roots` 只重建候选表，06 的 `migrate_delivery_facts`（v19）与投递列/索引/错误分类保持不变 |

## 5. 未覆盖与限制（不得据此宣称完整交付）

- **真实飞书群、飞书内置浏览器/手机实机、目标环境第三进程**：未验证（票据 10/11，需授权）。浏览器证据是 Linux Chromium（桌面 1280 与 Pixel 7 视口模拟），不是真机证据。
- **回复图片**：仍然不在采集、归档阅读与上传范围内（归档只多一个布尔 `has_pictures`，不存 URL、不下载上传、不新增上游请求）；已知空正文但有图的回复按设计 §2.1 显示 `【图片评论，点击链接查看】`，来源未给/未知时保持空正文，不冒充纯图。尚未归档或尺寸/变体信息仍不可见（兜底只证明“有图”，不保证可预览）。
- **定位只读但非快照**：链接按当前归档实时定位，期间新增/删除会让页码含义变化（沿用 03 的取舍，每次进入重新定位）。
- **候选转事件的时机**依赖来源触发重扫（rcount 变化、上次失败重试或 24 小时校准）：本票不为候选轮询全表，符合“不扫描评论表推断新增”；代价是补齐后的最坏延迟受这些触发点约束。
- 本票没有修改采集节拍、媒体、路由配置形状与投递重试参数，也没有新增告警（08）。
