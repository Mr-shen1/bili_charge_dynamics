# 飞书通知实施地图

## Notes

- 集成分支：`feat/feishu-notifications`；基准：`4b4761a161d5fe077110823d6c1cede889b8f082`。
- 规格与依赖：[spec.md](spec.md)、[implementation-plan.md](implementation-plan.md)。
- 按票据独立分支、worktree、TDD 实施并经合并代理集成；完成判据是验收与证据，不是提交存在。
- 01–10 仅实现和隔离验证；11 等待真实群、设备、环境及操作边界授权，不自动完成（当前仍为 `ready-for-human`）。
- 不修改或提交用户已有的 `.pi/subagents-lite.json` 修改；不推送、不部署、不读取真实机器人配置、不向真实 B 站或飞书发请求。
- 本地 Markdown 票据使用 `claimed` / `resolved` 记录领取与完成；最终父规格保留未完成真实验收的含义。

## Decisions-so-far

- 01 已 `resolved`：动态变化闭环落地事务发件箱 + 独立通知进程（schema v16）；通知阶段自有令牌，入选令牌轮换不重设起点；证据见 [evidence/01-dynamic-change-notification.md](evidence/01-dynamic-change-notification.md)。
- 02 已 `resolved`：一级评论精确链接贯通只读定位读取契约（`GET /api/archive/dynamics/{id}/comments/{root_id}/location`）与生产前端入口 `/dynamics/{dynamicId}/comments/{rootId}/locate`；定位读取零写入、不冻结快照、续读用无状态偏移游标，链接只含字符串身份与无凭据；证据见 [evidence/02-root-comment-deep-link.md](evidence/02-root-comment-deep-link.md)。
- 02 已用 `--no-ff` 合并进集成分支（合并 tip `594476c`，源 `a297ab0`）：无冲突，01 通知模块与 schema v16 迁移未变，02 只重构一级评论排序/窗口读取；定位契约与链接形状供 03（`.../replies/{replyId}/locate` 同形状）与 04（消息链接）复用。
- 09 已 `resolved`（含一次历史重开）：系统群心跳落地于既有通知进程轮询（`Dispatcher.tick()`），时段身份 `notification_heartbeats.slot` 持久去重，有效期到下一个 `:40`，领取与投递前复查过期，业务记录 `expires_at` 恒为 `NULL` 因此不套用过期丢弃；schema 迁移到 v17；证据见 [evidence/09-hourly-heartbeat.md](evidence/09-hourly-heartbeat.md)。
- 09 首次合并（`--no-ff`，合并 tip `4d69f86`，源 `5c18193`）：无冲突，`docs/README.md` 索引行按 01/02/09 证据并列；合并后全量后端回归 `881 passed`，通知四套（heartbeat/delivery/migration/protocol）`43 passed`。
- 09 历史缺陷（已修复，保留记录）：合并代理在同一集成分支复现 `heartbeat.slot()` 只按「当前北京时间分钟数 `>= 40`」判定时段，进程在 `:40`–`:59` 之间冷启动（例如 10:55 首次启动、10:40 从未运行过）仍生成并立即投递一条标记为 `10:40` 的心跳（有效期到 `11:40`），即最多 20 分钟的时段内迟补，与票据/规格「北京时间每小时第 40 分钟生成」「停机错过不追赶」冲突。既有用例未覆盖该窗口（重启用例在 13:59:59 重启但 13 时段已存在；停机用例恢复到 17:39:59，恰在 `:40` 之前），证据 §5 只写明「送达时刻常是第 40 分钟后的若干秒」。原规格无歧义，属实现偏差而非新业务决策，因此按原规格在 `/tmp/feishu-worktrees/09` 以红→绿修复（`slot()` 仅在北京时间 `:40:00`–`:40:59` 整分钟窗口内返回时段），复现方式与红绿结果见证据 §7。
- 09 修复已 `--no-ff` 合并进集成分支（合并 tip `0ba443c`，源 `cfd10a1`）：无冲突，改动只涉心跳生成窗口与相关文档；合并后心跳专项 `13 passed`、心跳＋迁移 `17 passed`、通知六套 `58 passed`、全量后端回归 `884 passed`。
- 03 已 `resolved`：楼中楼回复精确链接贯通只读定位读取契约（`GET /api/archive/dynamics/{id}/comments/{root_id}/replies/{reply_id}/location`）与生产前端入口 `/dynamics/{dynamicId}/comments/{rootId}/replies/{replyId}/locate`；宽屏复用动态详情原回复区（先按 02 契约取含所属根评论的批次，再取目标所在页），窄屏复用原独立楼中楼页直接显示目标页；回复页切片抽为共享 `_reply_reading`/`_reply_page_document`，不改变既有 `page` 模式、冻结快照与计数口径；证据见 [evidence/03-reply-deep-link.md](evidence/03-reply-deep-link.md)。
- 03 已用 `--no-ff` 合并进集成分支（合并 tip `880d235`，源 `68842aa`，合并前 `4e3b611`）：无冲突，保留双方文档改动（`docs/README.md` 索引同列 01/02/03/09，并顺带修正索引行残留断行碎片）；存储 schema 保持 v17，`backend/bili_monitor/notifications/` 与 09 心跳/告警 hook 未被改动，02 的 `Store.locate_root` 与 `/comments/{root_id}/location` 端点保持。合并后在集成分支跑专项：`test_root_comment_location`＋`test_reply_location`＋`test_dynamic_notifications`＋`test_notification_heartbeat`＋`test_notification_migration` 合计 `29 passed`，相邻回复读取回归 `test_replies`＋`test_comment_sync_status` `42 passed`，`git diff --check` 通过（全量回归留 10 统一执行）。
- 04 已 `resolved`：一级评论闭环落地「写事务内登记事件或候选 → 独立通知进程按角色投递 → 本站精确阅读」；评论起点独立成 `notification_phases.comment_started_at`（与 01 的正文基线分开，升级只回填 NULL，历史静默），事件身份 `(kind, dynamic_id, root_id, comment_id)` 预留 05 的所属根，候选单独成表并按原阶段起点转换，schema 顺延到 v18（09 占用 v17，链为 `<17` 心跳 → `<18` 评论 → `PRAGMA 18`）；证据见 [evidence/04-root-comment-notification.md](evidence/04-root-comment-notification.md)。
- 04 已用 `--no-ff` 合并进集成分支（合并 tip `be8dfa5`，源 `9aaa92f`，合并前 `4e855dd`）：无冲突，19 个文件、+1461/−66，`docs/README.md` 索引同列 01/02/03/04/09。合并后在集成分支只跑专项：`test_root_comment_notifications`＋`test_notification_heartbeat`＋`test_notification_migration`＋`test_reply_location` 合计 `31 passed`，迁移链 `test_migrations` `27 passed`，`git diff --check` 通过；09 的 v17 心跳与 04 的 v18 评论增量共存，`<17`→`<18` 两段结构与既有断言两侧保留（全量回归留 10 统一执行；04 分支上的记录为后端 `909 passed`、`pnpm check` 271、`pnpm test:e2e` 198/10 skipped、`test:e2e:notification` 2、`test:e2e:location` 4、`test:e2e:manage` 7、`check:dist` 通过）。证据核验：主链用例真存在（`test_root_comment_notifications.py` 12 例，驱动真实归档事务、临时 SQLite 与进程内受控接收端）；浏览器产物链在 `frontend/tests/e2e-notification/delivery-link.spec.ts` 里确实“从投递载荷取 `href` 再去生产装配打开”，而 `message.comment_href` 生成的形状 `/dynamics/{id}/comments/{commentId}/locate` 与 02 合约一致；但传输仍为 `httpx.MockTransport`、`POST /api/test/notify-roots` 仅测试夹具，spec 额外断言了一个期望 URL，真实飞书与真机未验（属 11）。
- 当前实施：**04 已合并收口**，下一批可派发 **06**（唯一直接阻塞 04 已 resolved，票据 `ready-for-agent`）；主工作树只做集成，不在主工作树开实现。**05 的 04 依赖已满足，但 03 仍有提前 Spec 审查发现的「精确入口返回恢复」缺陷在 `/tmp/feishu-worktrees/03` 独立工作树修复中，该修复合并前不启动 05**；07 待 05＋06，08 待 06，10 待 07＋08＋09。各票完成后只由合并代理操作集成分支；其余依赖边与 11 人工授权门槛不变。

- 起始可并行票为 01、02，分别在 `/tmp/feishu-worktrees/01`、`/tmp/feishu-worktrees/02` 实施。
- 已合并的 01/02/09 工作树不再用于实施；`04` 工作树随本票合并收口（保留备查，不重开）。`/tmp/feishu-worktrees/03` 另用于 Fog 中精确入口返回恢复缺陷的修复，修复件按 03 原规格验收后合并。
- 本轮接续 01、02 已存在的未提交工作，保留其内容并由各实施代理核验、完成；不重置工作树。
- 本轮共享探索笔记放仓库外 `/tmp/feishu-notifications-research/implementation-notes.md`，供后续实现者参考；笔记不替代活文件及官方协议核验。
- 真实验收票 11 保持 `ready-for-human`；01–10 的隔离准备即使完成，也不自动关闭父规格或 11。

## Fog

- **未消除**：提前 Spec 审查发现 02/03 精确定位入口未进入原详情快照/楼中楼来源体系，可能在返回时丢失阅读位置并重复主动定位（`4e855dd` 记录该缺陷）。修复在 `/tmp/feishu-worktrees/03` 独立工作树以红→绿补测进行；修复件合并前，03 不作为 05 的已完成依赖，**05 不启动**。链接契约（`/dynamics/{id}/comments/{rootId}[/replies/{replyId}]/locate`）不变，不需新业务决策。
- 真实飞书显示、内置浏览器、手机、代理可达性、授权目标环境三进程及资源证据均未取得，归票据 11。
- 各票隔离验证与最终双轴审查结果尚待形成。
