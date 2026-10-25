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
- 当前实施：03、04 各自在独立工作树 `/tmp/feishu-worktrees/03`、`/tmp/feishu-worktrees/04` 实施，主工作树只做集成，不在主工作树开这两票的实现；09 的修复已合入集成分支。各票完成后只由合并代理操作集成分支；其余依赖边与 11 人工授权门槛不变。

- 起始可并行票为 01、02，分别在 `/tmp/feishu-worktrees/01`、`/tmp/feishu-worktrees/02` 实施。
- 本轮接续 01、02 已存在的未提交工作，保留其内容并由各实施代理核验、完成；不重置工作树。
- 本轮共享探索笔记放仓库外 `/tmp/feishu-notifications-research/implementation-notes.md`，供后续实现者参考；笔记不替代活文件及官方协议核验。
- 真实验收票 11 保持 `ready-for-human`；01–10 的隔离准备即使完成，也不自动关闭父规格或 11。

## Fog

- 真实飞书显示、内置浏览器、手机、代理可达性、授权目标环境三进程及资源证据均未取得，归票据 11。
- 各票隔离验证与最终双轴审查结果尚待形成。
