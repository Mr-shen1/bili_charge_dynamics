# 集成分支双轴审查

- 固定基准：`4b4761a161d5fe077110823d6c1cede889b8f082`。
- 被审版本：`2d408c325c91107148f0c90f4f4cb693ca8c6bc0`。
- 差异：`git diff 4b4761a...2d408c3`，126 个文件；完整提交范围为 `git log 4b4761a..2d408c3 --oneline`。
- 两轴均由 `review` 代理独立、并行只读审查，先 CodeGraph、再核验活文件。以下保留两轴分离，不合并排序。
- 状态：审查已完成；以下维护性项与风险待同一实施代理集中处置，最终复核结果另补。

## Standards

原报告把以下 1–6 项列为“确定的规范违背 / 重复代码”。它们没有给出具体被违反的仓库规范条款，故处置时须区分可证重复、契约不同与气味判断，不能仅凭气味认定硬性规范违背。

1. **定位 UI 推导重复**：`ReplySection.vue:68–76`、`CommentThreadPage.vue:40–47` 的 `highlightId` / `locateMissing` / `noticeStatus` 近乎相同，`CommentList.vue:35–40`、`DetailVisit.vue:34` 有变体。建议统一目标就绪和 not-found 提示推导。
2. **定位滚动例程重复**：`CommentThreadPage.vue:50–58`、`ReplySection.vue:133–142` 都拼回复锚点、维护一次性待定位状态并 `scrollIntoView`。
3. **新增导出零引用**：`readStatus.ts:4` 的 `LocateStatus` 仅定义，`snapshots.ts`、`useDetailRead.ts` 仍手写联合。删除未用抽象或真实复用。
4. **短事务样板重复**：`notifications/delivery.py:87–108、110–138、141–149、151–161、224–245` 重复 BEGIN/commit/rollback；`checks.transaction`、`Collector._record_loop_alert` 还有同形逻辑。建议共享短事务 helper。
5. **测试时钟替身重复**：`test_notification_alerts.py:72–85`、`test_notification_heartbeat.py:58–70` 的 `_CollectorClock` 相同；两者还各定义投递时钟，支持文件已有 `Clock`。
6. **ISO→epoch 两套实现**：`checks.alert_epoch`（失败 None）与 `collector._timestamp`（失败抛异常）需核验是否可共享解析而保留各自错误契约。

判断项（不是硬性规范违背）：

- **可能 Data Clumps / Primitive Obsession / Mysterious Name**：告警以 `(category, object, reason)` 位置元组穿行，投递侧使用 `[0]/[1]/[2]`，`object` 名称不清且覆盖内建。建议有命名字段的小类型。
- **可能 Duplicated Code**：`config.reference/destination/route_error/webhook/secret` 重复目的地查询；考虑统一 route 解析，保留凭据边界。
- **可能 Repeated Switches**：kind 分派和种类集合分散，但当前只有一处级联，原报告也明确不足以判缺陷，不应为此强造多态。

文档归属、前端命令与新增 e2e 声明同步未发现违背；已披露并恢复的 08 Git 误操作不作为新代码缺陷重复报告。

## Spec

**未发现确认的规格违背。** 独立核验通过：畸形回复图片元信息降未知但不否决文字归档；根原校验未放宽；告警失败事实可恢复且不误报已成功目标；两类 cursor 与只读定位隔离；generation→phase 绑定、起点、退选/重纳入/重启语义与 v17–v21 迁移成立；11 仍在人工授权门槛。

判断项（非确认违约）：

1. 定位后端仍全量读取该动态根评论/回复再切窗口，响应/DOM 只有 20/10 条，未违反“不渲染全部评论”，但有 O(N) 本地读取成本，应如实记录。
2. 重试使用当前服务端基址拼链接；业务字段快照冻结、契约已有说明，不额外要求绝对 URL 冻结。
3. `expire_overdue` 没有 `expires_at` 索引，长期积压有扫描成本；当前未要求容量治理，属观察项，不能借此自动丢弃业务消息。

**证据不足风险**：10 首次全量 4 个失败集中于 `FeishuStub` / `NotifierProcess` 装配，原证据未保留首次失败断言/stderr，不能只以第二次全绿免除风险。审查发现纯墙钟断言：SQLite 忙等须小于 1 秒，claim→kill 的租约剩余须在 (0, 2.5] 秒；负载下可能假失败。主线程将保留独立复跑完整输出；有失败须诊断，不删除或放宽断言掩盖。

## 分轴汇总

Standards：6 项维护性问题、3 项判断项，主要关注重复短事务及定位逻辑；Spec：0 项确认违约、3 项观察项、1 项跨进程时序风险，主要待复核偶发失败。两轴不合并排名。
