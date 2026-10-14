# 25 来源计数驱动根回复同步：自动化证据

## 范围与协议

对应 [#25](issues/25-comment-count-sync.md)、[实施协议](comment-count-protocol-plan.md)、[spec I4–I6 / T2–T3](spec.md)；接口现状见[采集契约](../../docs/backend/api/collector-api.md)。不交付 #26 阅读／管理展示，不代表父 #09 或全部产品验收通过。

每次公开检查通过已校验 locator 独立读取 `/x/v2/reply/count` 的 `data.count`，不省略该请求，也不拿网页 STAT、detail、根页 count/acount 或本地条数代填。只接受严格 code=0、非负整数 count（布尔、字符串、小数无效）。计数和编辑信号独立保存；失败保留旧可信值，`observed.comment_count_status` 表达本次读取可用性。

首次初始化、失败重试或可信计数变化才调用已有完整根＋必要回复同步。同步包含已有可读内容，不因旧 ID 截断，不每日校准或比对正文／图片。领取计数、实际评论 checkpoint、正文版本和本地根／回复数分开；同步期间新计数持久登记，旧完成只提交自己处理的计数，不能清新工作。沿用 v11 JSON／工作表和领取 token、归档 generation fencing，无新增 schema，不清旧归档或 cursor。

默认最多 4 个目标独立同步，检查和同步各有限且同目标不叠加。慢分页不阻止新检查或其他目标后续同步；网络不持有 SQLite 长事务。纯评论工作跳过已成功且版本匹配的正文；正文／根／回复／媒体独立推进，评论成功不等待 OSS，保留根媒体未完成也不撤销评论 checkpoint。

## 来源证据及不能宣称的内容

[来源协议证据](../../docs/backend/evidence/source-protocol-evidence.md#25-独立评论计数) 区分固定第三方文档、历史 235/501 样本与虚构 fixtures。本次已核对 count endpoint、参数及 `data.count` 响应结构；fixture 与两根／五回复原始 JSON 验证字段映射和归档协议，但不从分页量计算来源信号。

**精确根＋全部回复包含口径仍未验证。**固定第三方 count 文档标题为“评论区评论总数”，字段仅解释“评论条数”，没有明确枚举包含范围。历史样本数字一致也不证明普遍等价。本次没有授权真实来源枚举，不能把虚构一致数字当成真实平台证据；该项需要人工结合 #34 限定授权核验。保留独立计数请求，未据此删除任何未证实冗余的读取，也不宣称本票全部核验标准已通过。

## T2／T3 验证

`backend/tests/test_comment_count_sync.py`（23 项）：

- 原始独立计数 JSON 经公开 `Collector.check_once/execute_pending/run`、真实 SQLite 及 checks／归档 HTTP；独立数与网页／detail／根页不同、来源数大于本地数分别表达。
- 真实零、未知首次、增加、减少、不变；纯正文编辑不重扫；纯评论编辑与增删抵消明确验证为已知漏检，不偷偷校准。
- 缺字段、null、负数、布尔、字符串、小数、HTTP拒绝、业务失败、网络失败不归零、不覆盖旧可信值／归档、不制造成功时间或扫描。
- 45 根／25 回复完整必要分页（短页继续、空尾复核），根／回复中间页失败保留成功部分及旧整轮 checkpoint，重开无新信号可重试；已有 ID 内容仍更新，已删除来源内容保留。
- 旧根／回复分页中观察新计数，旧 checkpoint 只到旧计数，新 observed、pending 和分项投影保留；根成功不冒充回复成功。
- 网页失败不倒退已完成正文；评论图独立 pending，评论 checkpoint 可前进，媒体重试不重扫成功评论。
- 受控 0/15/30/45 节拍暂停评论分页，其他目标的检查和新计数同步仍推进，旧归档 HTTP 可读且配置可写。
- 显式 initial 与周期检查交互：已有独立观察后，detail 计数不同也不能替换可信计数或造成永久漏调度；尚无独立检查的旧 #02 初始化协议保留。计数失败时，另一可信正文编辑仍登记和提交，评论不重扫；聚合 failed 不表示各信号都失败。

`backend/tests/test_comment_count_recovery.py`（13 项）：

- 根／回复网络中取消，API 关闭重开不恢复 running；显式持锁 run 恢复并重领，无新计数仍可完成；竞争 collector 不能恢复工作。
- 同计数重复执行不发第二轮请求，同 revision 恢复重领后旧成功／失败均不能清除新 running；旧页不能覆盖新 generation。
- 实际根／回复 HTTP 和业务拒绝分别记录 failed，旧内容、可信数与成功 checkpoint 保留；重开无新信号重试。
- 整页无初始化 JSON、网页无权且计数未知时，仍从可信 detail locator 初始化实际可读根回复，不冒充正文成功。
- 三目标、`max_syncs=2`、公开 execute 与固定 run 两种入口，网络暂停证明最多两目标同步、同目标不叠加；释放一个槽后第三目标可推进，检查持续，旧归档读写不阻塞。

既有 #23/#24 测试只补新 count 传输和初次 locator 请求、明确执行阶段故障注入；不把 count 请求计为根分页重扫。旧基线测试新增正文匹配但评论 checkpoint 不匹配的情况，不能建立 complete 或补造成功时间。另构造旧 v11 已有 complete 但评论 checkpoint 与旧检查不同的输入，验证不变计数检查也能恢复真实 pending（revision 不虚增），重开完成后旧根／回复保留。

## Red → Green 与回归结果

- 独立来源计数贯通首测失败：没有独立请求／计数变化不登记；接入读取、revision 和领取计数后通过。
- 纯评论工作在网页失败后错误倒退正文成功，红测后跳过已成功且版本匹配的正文。
- 旧分页完成把评论媒体投影为新计数成功，红测后按对应 checkpoint 投影；回复失败时根成功被整轮投影掩盖，另一个红测后改为根／回复各自比较。
- 串行执行阻塞其他目标，随后整批等待又阻塞其他目标的新工作；两次红测后改为有限目标工作池与逐节拍独立领取。
- 后端全量一次出现新增受控时钟测试超时：推进下一节拍前未等待前一检查与调度 sleep 完成，导致合法忙跳过。补外部时钟等待条件，不放宽超时；该场景连续单测 10 次通过，随后全量通过。
- Spec 审查提出显式 initial 路径的范围疑问后，新增交互红测确认：detail 计数可覆盖已存在的独立计数，而下一相同检查不再登记。修为已有独立检查的 initial 绑定最近可信计数；未知仍未知。无独立检查的旧初始化不是本票的固定计数检查入口，保留其原协议并明确文档边界。
- 复核兼容边界时补旧 v11 记录红测：旧目标 complete、观察7／评论 checkpoint0，在新计数仍7时不能永远跳过。修为检查核验真实归档匹配，恢复 pending 而不伪造新信号或成功时间。
- 其余新异常／恢复场景初跑通过，作为回归证据，不冒称每项均发现新缺陷。

已执行：

- `uv run pytest backend/tests/test_comment_count_sync.py backend/tests/test_comment_count_recovery.py -q --tb=short`：36 passed。
- `uv run pytest backend/tests -q --tb=short`：363 passed；既有 Starlette／OSS SDK deprecation warnings。
- nvm 下 `pnpm typecheck` 多次通过；仓库未配置 Python 静态类型检查器，pytest 不冒称类型检查。
- `pnpm test --maxWorkers=2`：22 文件、234 passed。
- `pnpm build`、`git diff --check`：通过。

本票未运行 Playwright，不把 HTTP／单元回归当作 #26 UI 或正式浏览器证据；没有真实 Cookie／B站／OSS／生产部署、持续节拍或容量实测。控制流取消和 ACK／令牌恢复不是硬断电证据。

## 双轴审查

固定开工基点 `01d7a7d8a8f565d8eb32fc8d4f04de1c808020b9`，初审提交 `b27e640`；Standards 与 Spec 两个 `review` 子代理并行，经 CodeGraph 与 live source 只读审查。

### 规范轴（Standards）

无成文规范硬违规。3 项判断性 smell：固定 run 和单次 execute 有两种调度生命周期；两处评论元数据投影重复；扁平计数 checkpoint 字段可形成领域值。已提取共用 `comment_metadata`。保留两种调度入口：单次批次需处理起始集合，而 run 必须逐节拍领取后续工作；回到“等待整批完成”已被慢分页红测证明会阻断其他目标的新工作。暂不为既有 SQLite／JSON／HTTP 扁平 checkpoint 增加领域框架。标签沿用 #24 的待人工复核惯例，不把 ready-for-human 当作已验收。

### 规格轴（Spec）

初审无确认的实现缺陷，提出 2 项判断：显式 initial 仍有旧 STAT/detail 计数路径；计数失败令聚合 check failed 是否混淆分项。前者补交互红测后确认一个跨入口覆盖缺陷并修复：已有独立计数记录的 initial 绑定最近可信检查计数；无独立检查的 #02 初始化路径明确为旧兼容入口，不宣称其执行固定独立计数检查。后者保留“任一信号失败则检查聚合 failed”的现有语义，文档说明分项独立，新增原始协议回归证明计数失败不阻止可信正文编辑或触发评论重扫。

精确根＋全部回复口径仍是已知未验证项，两轴均未将 fixtures 当真实平台证明。修正 `92a13ab` 后 Spec 子代理复核：初审两点无残余确认缺陷，无新确认缺陷；保留 initial 使用最近可信计数而不是当前来源快照的既定节拍窗口。复核提出的文档精度提醒已修：网页读取失败时 `observed.edit_status` 保留旧值，需结合 `check_error/check_status`，不能仅凭旧编辑状态判断本次请求。随后补旧 v11 完成记录兼容红测与恢复修正 `1f0ed96`，Spec 子代理再次经 CodeGraph／live source 复核：恢复只针对实际未匹配完成记录，不虚增 revision、不清 running，正常无变化不重扫，无确认缺陷。

初审分别计数：Standards 0 硬违规、3 项判断建议（主要为调度生命周期）；Spec 2 项判断（主要为显式 initial 路径），其中交互缺陷经红测修正。两轴不合并排序。最终 Standards 无成文硬违规，Spec 无残余确认缺陷；真实计数包含口径仍待人工验收，不由审查通过代替。

## 与父 #09 的责任核对

#25 提供可信计数结构读取、触发／完整分页、未知／失败保留、版本绑定／恢复、分项 HTTP、媒体独立与慢分页调度证据；#26 负责生产 Adapter 和阅读／管理状态展示。最终媒体联动由 #30，真实计数包含口径、权限、自然来源变化与持续运行由 #34 限定授权核验。父票原清单不自动勾选，精确根＋回复口径必需项尚未验证，不能宣称父票或本期完整验收。
