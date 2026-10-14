# 25 评论计数同步实施协议

依据 [spec I4–I6 / T2–T3](spec.md)、[票据 25](issues/25-comment-count-sync.md) 与 [SRS FR-18 / DR-05](../../docs/product/SRS.md)。本文为实施约束，不是验收结果。

## 来源与触发

- 保留独立 `/x/v2/reply/count` 读取；网页 STAT、通用 detail、根页 page.count/acount 和本地归档数不作为跨接口恒等假设。只接受成功响应中的有效非负整数，缺失、类型错误、业务拒绝或网络失败都不是零。
- 初始化（包括计数未知）、失败重试与可信来源总数变化可执行已有根＋回复同步；纯正文编辑、相对时间变化、总数不变不登记新的评论扫描。无每日校准、见旧 ID 截断、内容比对或全历史动态回填。
- 网页／正文失败与评论计数和实际评论访问结果分别判断。存在可信评论 locator 时仍可初始化可读评论；未知计数不伪造精确版本。

## 工作与提交

- 最近可信 observed、实际完成的评论 checkpoint、本地根数与回复数分别表达。来源计数不等于已获取的内容数，未知不等于零。
- 评论同步领取时绑定实际处理计数，完整执行既有必要根页与逐根回复分页；任一必要页失败保留已归档部分和旧成功 checkpoint。
- 检查和慢同步分离；新计数可在旧分页中持久登记。旧完成只提交自己的版本，不能冒领新 observed 或清除较新 pending。沿用持久领取 fencing 与 generation 提交，重开恢复和重复执行保持幂等。
- 正文、评论、动态图和评论图独立提交。评论成功不等待 OSS；复用现有评论媒体关联、待处理和上传能力，不复制采集或上传路径。网络 I/O 不进入 SQLite 长事务。

## 已确认测试入口

- T3：固定虚构原始 HTML/JSON，经公开 `Collector.check_once/execute_pending/run` 和受控时钟，观察外部请求，证明无变化不重扫、必要分页失败可重试、新旧计数交错不丢工作。
- T2：真实临时 SQLite、公开归档与 checks HTTP、关闭重开，验证未知／零、observed／checkpoint／本地计数、部分失败与保留、脱敏和慢 I/O 期间读写。
- 来源分页不是并发快照；计数抵消、纯评论编辑及未改变计数的来源移动可漏检。原有读取 cursor 冻结协议保持不变，采集更新仅影响新首批，不更改旧读取快照。

## 最终接口与兼容

checks HTTP 保留 `observed.source_comment_count`，新增最近独立读取 `comment_count_status`；同时公开实际 `synced_comment_count`、本地根／回复数与 `comments_last_attempt`。`parts` 按最新观察与根／回复各自 checkpoint 投影，不用整轮结果掩盖根成功、回复失败。检查 failed 是任一信号失败的聚合，另一可信信号仍推进。

显式 initial 不是固定检查：无独立检查记录时沿用 #02 协议；已有独立计数记录时复用其最近可信计数（未知仍未知），不得以 STAT/detail 覆盖。无新增 schema，旧配置、归档、cursor 和 v11 未完成工作保留。

来源字段及真实口径证据限制见[来源协议](../../docs/backend/evidence/source-protocol-evidence.md#25-独立评论计数)，测试结果见[验收记录](acceptance-25.md)；精确根＋全部回复口径、真实来源、OSS、持续节拍、资源与正式设备验收仍待对应人工证据。
