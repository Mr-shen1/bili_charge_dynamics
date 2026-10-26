# 集成分支双轴审查

- 固定基准：`4b4761a161d5fe077110823d6c1cede889b8f082`。
- 被审版本：`2d408c325c91107148f0c90f4f4cb693ca8c6bc0`。
- 差异：`git diff 4b4761a...2d408c3`，126 个文件；完整提交范围为 `git log 4b4761a..2d408c3 --oneline`。
- 两轴均由 `review` 代理独立、并行只读审查，先 CodeGraph、再核验活文件。以下保留两轴分离，不合并排序。
- 状态：审查已完成；以下维护性项与风险已由同一实施代理在 `feat/feishu-review-fixes` 集中处置（逐项结论见文末「处置（整改实施记录）」，门槛与限制见 [review-fixes.md](review-fixes.md)）。

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

## 处置（整改实施记录）

- 整改分支/工作树：`feat/feishu-review-fixes` / `/tmp/feishu-worktrees/review-fixes`（基线 `306356c`，被审代码仍为 `2d408c3`）。
- 以上原发现全部保留；本节逐项给出处置与证据，结论只有三类：**接受修复**、**证据驳回**、**成本观察记录**。完整门槛命令与限制见 [review-fixes.md](review-fixes.md)。

### Standards 逐项

1. **定位 UI 推导重复 —— 接受修复。** 新增 `frontend/src/dynamics/locate.ts`：`confirmedTarget(target, items)`（只在已读条目里确认目标）、`targetMissing(target, status)`、`noticeStatus(status)`（`not-found` 不冒充读取失败）。`ReplySection.vue`、`pages/CommentThreadPage.vue`、`CommentList.vue` 三处改用同一份推导（`CommentList` 的“回复精确入口不高亮根评论”差异通过传入 `null` 表达）。`DetailVisit.vue` 保留自己的写法并注明原因：详情页把“不存在”渲染成独立提示，通用提示要**不渲染**（`null`），与“当成功”是不同契约，不做机械合并。
2. **定位滚动例程重复 —— 接受修复。** 新增 `frontend/src/dynamics/useLocateTarget.ts`（`arm()`/`settle()`/`pending`，目标读不到退回容器、只消费一次）；两个精确入口共用，`ReplySection` 传 `releaseOnUserScroll: true` 保留“用户先滚动就不再抢回”，`CommentThreadPage` 不启用（原行为就是不释放）。“加载中跳过”的判定留在组件内，未引入第二套导航或状态系统。保护用例：`tests/unit/{reply-reading,thread-reading,comment-reading,locate-return}.test.ts` 与 `test:e2e:location`、`test:e2e:delivery`、`test:e2e` 中的定位/返回用例（全绿，见 review-fixes.md）。
3. **新增导出零引用 —— 接受修复（复用而非删除）。** `ReadStatus`/`LocateStatus` 迁到 `frontend/src/data/contracts.ts`（两轴各层都已依赖的契约层），`app/snapshots.ts`（列表/评论/回复状态）与 `dynamics/useDetailRead.ts` 改用它们；`dynamics/readStatus.ts` 删除，手写联合不再重复。
4. **短事务样板重复 —— 接受修复。** 新增 `backend/bili_monitor/transaction.py` 的 `write(store)`/`immediate(connection)`（`BEGIN IMMEDIATE` → 提交，异常回滚原样抛出）。`notifications/delivery.py` 5 处（领取、路由复检、心跳登记、告警扫描、回写）、`checks.py` 4 处（原 `checks.transaction` 删除）、`collector._record_loop_alert` 1 处改为调用它；“事务外网络”不变，由 `test_notification_recovery_processes.py::test_slow_feishu_request_never_holds_the_write_lock_for_another_process` 继续锁定（整改后该用例改为“另一进程写成功即证明锁自由”，见 Spec 风险处置）。
5. **测试时钟替身重复 —— 部分接受修复。** 两处完全相同的 `_CollectorClock` 合并为 `tests/notification_support.py` 的 `CollectorClock`；两处投递时钟合并为同一 `BeijingClock`（含 `start()` 与 `beijing_moment()`），`test_notification_alerts.py` 以 `Clock = BeijingClock` 别名复用、`test_notification_heartbeat.py` 的 `StoppingClock` 继续继承它。`notification_support.Clock`（固定 epoch 秒、无 ISO/时区概念）语义不同，保留不合并。
6. **ISO→epoch 两套实现 —— 接受修复（共享核心 + 保留各自错误契约）。** 核心解析落在 `comment_status.epoch_from_iso()`；`checks.alert_epoch()` 继续“解析不了返回 `None`、不登记不编造时刻”，采集节拍（原 `collector._timestamp`）继续“非法时间直接抛错”，两处只是调用同一解析。`collector.SystemClock.now()` 同时改为复用 `comment_status.utc_now()`（原为同一格式的第二份实现）。

判断项：

- **告警三元组 —— 接受修复。** 新增 `outbox.Alert(category, object_key, reason)`（`NamedTuple`），采集/采集主循环/投递/告警扫描全部用它穿行，`outbox.record_alert(connection, alert, now)` 只接受该类型。数据库列 `notification_alerts.object` 与消息快照字段 `object` **不迁移**（列名与飞书载荷形状属于既有契约），只把代码里的位置参数 `object` 换成表意名 `object_key`，不再覆盖内建名。既有告警用例（08 五类故障、节流、合并、不递归、快照四字段）全部继续通过。
- **config route 重复解析 —— 接受修复（有限）。** 新增 `NotificationConfig.resolve()` 与 `Route`（`error`/`webhook`/`secret`，`repr` 隐藏凭据），投递侧由“先查错误、再查地址、再查密钥”三次查询改为一次解析；`route_error()`/`webhook()`/`secret()` 保留为薄包装（既有测试与调用方契约不变），删掉因此不再被使用的 `destination()`。新用例 `test_one_route_resolution_covers_error_address_and_secret_without_repring_them` 锁定语义与脱敏。
- **Repeated switches / kind 分派 —— 证据驳回（不做）。** 当前只有一处 kind 级联（`Dispatcher._payload`），种类集合本身是契约常量；为一个观察项造多态会凭空增加第二套抽象，原报告也已声明不足以判缺陷，故明确记录“不做”。

### Spec 逐项

- **确认违背（0 项）—— 维持。** 本轮只做结构集中与测试观测整改，未改业务过滤、路由、阶段/基线、快照冻结、回复图片降级等任何语义；逐项自动化证据仍全绿。
- **观察项 1（定位后端 O(N) 本地读取）—— 成本观察记录。** 在 `docs/backend/api/archive-api.md` 的 02/03 两节显式写明“读出该动态根评论/该根全部回复后再切窗口，成本随单动态量线性增长；响应与 DOM 仍只有 20/10 条；本期不加专用索引或容量治理”。不改实现、不加索引。
- **观察项 2（重试用当前服务端基址拼链接）—— 证据驳回（维持既有契约）。** 业务字段快照在登记时冻结，`base_url` 只影响链接前缀且属可修复配置；契约已说明不承诺绝对 URL 冻结。未扩大要求，也未改动。
- **观察项 3（`expire_overdue` 无 `expires_at` 索引）—— 成本观察记录。** 在 `docs/backend/api/notification-process.md` 记录：该列无独立索引，是每轮领取的额外扫描成本；当前记录规模不足以要求容量治理，本期不新增索引，且**不会**因此自动丢弃业务消息（业务记录 `expires_at` 恒为空）。
- **跨进程时序风险 —— 接受修复（只改测试 seam 与观测，不删用例/不放宽断言）。** 细节与红绿/反向验证见 [review-fixes.md](review-fixes.md) §3：①1 秒忙等墙钟断言改为“另一进程在 busy 预算内写成功”，并用“真占写锁 ⇒ 该写失败”做反向验证；②`(0, 2.5]` 秒租约剩余窗口改为 30 秒预算下的结构断言 + 受控过期（不再真等）；③发现并处置了一处与墙钟直接相关的观测缺陷：真通知进程会在**真实北京时间第 40 分钟**生成合法心跳，而进程级用例按整张投递表断言，会在这一分钟内必假失败——改为按业务身份观测（`business_deliveries`/`business_events`），生产时钟不加测试开关。

### 分轴复核结论

Standards：6 项维护性问题中 5 项接受修复、1 项部分接受（测试时钟）；3 项判断项中 2 项接受修复、1 项证据驳回并记录不做。Spec：0 项确认违背维持，3 项观察项 1 项驳回 2 项成本记录，1 项跨进程时序风险按测试 seam 整改并保留实质断言。两轴结论仍不合并排名；01–10 的 `resolved` 语义仅限隔离证据，11 仍为人工授权门槛，未勾真项、未关闭父规格。

### 最新只读复核与收尾（同一整改分支）

- **两轴结论**：最终只读复核 **Standards 硬性 0 项、Spec 确认 0 项**；上表各项保持已给出的处置类型，没有新增确认缺陷。
- **主线程独立复核**：把整改分支合入主集成后，对合并点 `166d706` 独立首次全量 **1030 passed, 3 warnings, 194.04s**（日志 `/tmp/feishu-independent-backend-final.log`）。此前对被审基线 `306356c` 的独立首轮全绿（1029 passed/191.05s）一并作为补证；10 §12 的首轮 4 例失败历史保留不改写。
- **收尾三处小改（不扩大重构）**：
  1. `frontend/src/dynamics/useLocateTarget.ts` 删除全仓未使用的 `pending` getter（`arm()`/`settle()` 两个真实使用面不变）。
  2. `docs/backend/api/notification-process.md` 把“事务样板集中一处”限定为**本轮实际覆盖**：通知投递（领取/回写/路由复检/心跳登记/告警扫描）、检查状态写入（`record_check`/`claim_check_work`/`finish_check_work`/`recover_check_work`）与采集主循环告警登记；并明写归档/发现等既有模块仍是自己的 inline `BEGIN IMMEDIATE`、行为不变、本轮未合并，不得理解为全仓储统一。
  3. `backend/bili_monitor/comment_status.py` 的 `epoch_from_iso` 注释改为“只做解析、不规定错误策略，调用方决定”，撤掉“解析不了就是真实错误”的过强措辞（`Collector._page_due` 实际会吞 `ValueError` 按到期处理）。
- **记录在案的受控变化（不改）**：`NotificationConfig.secret()` 在目的地不可用（webhook 无效）时返回 `None`；因投递侧现由 `resolve()` 一次拿到错误码+地址+密钥，且 `route.error is not None` 在组装/发送之前就返回等待配置，故发送路径不会出现“有密钥无地址”的组合，凭据不可达路径不变。既有脱敏用例（队列/日志/快照/repr）继续通过。
- **仍明示的风险**：跨进程用例的墙钟依赖已按 §3 收窄，但 SQLite 忙等、进程调度与极端 CI 负载仍可能让 `wait_for` 预算（5–30 秒）在与被测行为无关的环节耗尽；本轮不再放宽任何断言或调大超时，若未来复现应作为新的独立问题诊断。
- **收尾验证**（本分支，代码无后端语义变化）：`pnpm check` exit 0（275 单测/24 文件 + typecheck + e2e 项目守卫）；`pnpm test:e2e:location` 4 passed、`pnpm test:e2e:notification` 4 passed；后端定向 `test_collector.py`+`test_notification_protocol.py` 48 passed。未重跑后端全量或全部 e2e（见下方 review-fixes 收尾记录）。
