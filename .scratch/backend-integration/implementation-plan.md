# 后端集成剩余票拆分与执行顺序

## 基线与使用方式

- 按用户确认，#01、#02 已完成，作为后续实现底座；不改写它们的票据状态、验收记录或历史证据。
- 原 #03–#12 保留为**汇总票，不直接派工**，统一标为 `needs-triage`，等待维护者根据子票证据核验收口；原范围与核验清单仍有效。现有 #13–#35 共 23 张执行子票，一张子票只承诺自己明确负责的可观察结果，不代表父票或同号 AC 全部通过。
- 子票的 `Blocked by` 是实施依赖；`ready-for-agent` 表示内容已明确，不表示依赖已完成。子票不反向依赖其父汇总票，避免循环。
- 汇总票等所有子票交付并核对原清单后才能收口。实现依赖细化为子票关系，不再等待无关 UI/媒体任务；原父票之间的业务前置关系保留为背景说明。
- [规格](spec.md) 与 [SRS](../../docs/product/SRS.md) 仍为需求真值。未决 DTO、迁移、分页读取范围及工作版本协议在对应子票内先明确，再以契约测试证明；不另开纯设计/建表票，也不借拆分增加产品范围。

## 文档依据复核

初版拆分后的补读复核覆盖 `docs/` 全部 13 份文本文件、集成目录当时全部 38 份 Markdown，以及相关本地交叉引用；UI 图片资产未读，视觉依据使用已跟踪的文字规范。本次仅文档与必要源码核对，不是测试、部署或真实上游验证。

- 产品范围、架构和可行性分别以 [SRS](../../docs/product/SRS.md)、[HLD](../../docs/design/HLD.md)、[FSR](../../docs/product/FSR.md) 为依据；[样本证据](../../docs/backend/evidence/backend-feasibility.md) 不等于持续运行结论。
- 增量实现须兼容已有 [管理接口](../../docs/backend/api/management-api.md)、[归档接口](../../docs/backend/api/archive-api.md)、[归档客户端](../../docs/backend/api/archive-api-client.md) 和 [动态协议字段](../../docs/backend/evidence/dynamic-protocol-fields.md)，不重做 #01/#02 或忽略其保存的元信息。
- 展示和交付分别参考 [UI 文字规范](../../docs/design/ui-reference.md)、[静态交付](../../docs/deployment/README.md)；[票据](../../docs/agents/issue-tracker.md)、[标签](../../docs/agents/triage-labels.md) 及 [领域约定](../../docs/agents/domain.md) 约束追踪方式。
- 补读后修正汇总票派工状态，明确 #27 材料门槛，并补充 #15/#17 cursor 失效验收及 #15 对既有 `comment_locator` 的兼容验证；当时未改变产品范围和 22 张执行子票的依赖图。
- 用户随后确认按两张 UI 参考图一比一复刻，新增 #35 视觉专项并同步现行 SRS／规格／UI 参考；旧验收与票据交付状态不改写。#35 包含阅读一比一视觉及监控管理同风格改版，可复用已交付阅读／管理能力直接推进，#32/#33 的最终视觉证据需基于 #35 后的版本。

## 子票索引

| 汇总票 | 执行子票 | 可独立交付的结果 |
| --- | --- | --- |
| [03 多 UP 阅读](issues/03-multi-up-reading.md) | [13 scope 读取](issues/13-scoped-archive-reading.md)、[14 导航与卡片](issues/14-scope-navigation-cards.md) | 真实 scope 读取链路；选择条、卡片与访问恢复，新增视觉要求另由 #35 覆盖 |
| [04 一级评论](issues/04-root-comments.md) | [15 根评论归档](issues/15-root-comment-archive.md)、[16 评论区阅读](issues/16-root-comment-reading.md) | fixture→SQLite→HTTP；生产 Adapter→排序与局部态 |
| [05 楼中楼](issues/05-replies.md) | [17 回复归档](issues/17-reply-archive.md)、[18 回复阅读](issues/18-reply-reading.md) | 完整来源分页与关系；3/13/23/25 阅读及历史恢复 |
| [06 动态图](issues/06-dynamic-images.md) | [19 动态媒体归档](issues/19-dynamic-media-archive.md)、[20 动态图阅读](issues/20-dynamic-image-reading.md) | 独立上传/重试和公开 URL；网格、预览与历史 |
| [07 评论图](issues/07-comment-images.md) | [21 评论媒体归档](issues/21-comment-media-archive.md)、[22 评论图阅读](issues/22-comment-image-reading.md) | 复用上传、评论 owner 隔离；纯图评论和组内预览 |
| [08 固定检查与编辑](issues/08-periodic-edit-sync.md) | [23 固定检查](issues/23-fixed-cadence-checks.md)、[24 编辑同步](issues/24-versioned-edit-sync.md) | 独立采集进程与持久观察；版本绑定、失败恢复与正文状态 |
| [09 评论变化](issues/09-comment-change-sync.md) | [25 计数触发](issues/25-comment-count-sync.md)、[26 计数与分项状态](issues/26-comment-sync-status.md) | 计数驱动完整根回复同步；来源/本地/失败的可见区别 |
| [10 近期窗口](issues/10-recent-window.md) | [27 分页发现](issues/27-recent-target-discovery.md)、[28 窗口生命周期](issues/28-recent-window-lifecycle.md) | 原规则凑 N、失败保留；初始化/移出/重新纳入 |
| [11 整合](issues/11-monitoring-lifecycle.md) | [29 在途生命周期](issues/29-inflight-monitoring-lifecycle.md)、[30 全链路与聚合状态](issues/30-integrated-archive-lifecycle.md) | 配置变化与在途工作正确收口；全类型归档保留和自动媒体联动 |
| [12 交付验收](issues/12-delivery-acceptance.md) | [31 双进程与 Nginx](issues/31-reproducible-deployment.md)、[32 自动化验收](issues/32-automated-acceptance.md)、[33 正式浏览器验收](issues/33-browser-device-acceptance.md)、[34 上游与持续运行](issues/34-live-source-runtime-evidence.md)、[35 视觉与管理改版](issues/35-bilibili-visual-replica.md) | 可复现交付；AC 证据台账；独立真机证据；授权上游和资源实测；阅读一比一视觉与管理同风格改版 |

## 可并行推进的顺序

以下按依赖层次排列，不表示必须等整批完成才进入下一批；以各子票 `Blocked by` 及开工门槛为准。#27 须先确认原识别规则/协议材料可用；缺失时改为 `needs-info`，不得臆造规则。

1. 原先解锁：**#13、#15、#19、#23**。新增 **#35** 复用当前分支已交付的阅读／管理能力，可直接推进，不等待 #31/#33 或历史视觉人工签收。
2. 各自底座交付后：#14 ← #13；#16/#17 ← #15；#20 ← #19；#21 ← #15+#19；#24/#27 ← #23。
3. 后续分支：#18 ← #16+#17；#22 ← #16+#20+#21；#25 ← #17+#24；#28 ← #24+#27。
4. 状态与整合：#26 ← #16+#25；#29 ← #17+#19+#21+#24+#25+#28；#30 ← #14+#18+#20+#22+#26+#28+#29。
5. 交付：#31 ← #30；#32/#33 ← #31+#35；#34 ← #31。#33/#34 是人工执行票，环境与授权由维护者提供，不阻塞前面无凭据自动化开发。

## 所有执行子票的共同交付要求

1. 遵守父汇总票与规格既定边界；从现有公开能力扩展，不复制采集/上传/导航实现，不搭纯转发空框架。
2. 按票内 T1/T2/T3 入口验证公开行为。T1 使用生产 Adapter，传输可替身；T2 使用真实临时 SQLite、HTTP 和关闭重开；T3 从结构真实、内容虚构的 HTML/JSON 穿透执行入口，不只输入解析好的领域对象。
3. 数据变更含可复现迁移和旧归档保留验证；分页先写明读取期间更新的一致性范围、cursor 绑定及过期语义，再测试不重不漏。失败原批重试、ID 保持字符串、未知不等于零。
4. 各票即时保证自己负责数据的保留、幂等、独立失败与恢复，不能把基本正确性全部推到 #29/#30。正文/根回复/媒体完成分开；网络与 OSS 不进入 SQLite 长事务。
5. 自动化不用真实 Cookie、上游或 OSS；不采购、不操作真实部署、不读取仓库外凭据。用虚构秘密标记核查日志/HTTP/UI 脱敏。Python 仅 uv，Node 仅 nvm，前端仅 pnpm。
6. 交付时在票末 `## Comments` 追加实现与测试命令、结果、证据路径和未验证项。测试通过不能自动勾选父票全部 AC，移动模拟不能代替真机，模拟 OSS 不能代替实际云上传证据。

## 验收归属与收口

- #03–#11 原业务核验清单由既有业务子票共同覆盖；新增 #35 归 #12，负责 #03–#07 保留阅读区域的一比一视觉及监控管理同风格改版，复用 #01/#02/#24 管理／状态能力；#32 汇总 AC-31 与管理回归、#33 取得正式设备签收。每张子票明确边界和测试入口，不把旧视觉证据算作新复刻通过。跨票的编辑→动态图、计数→评论图以及在途配置变化分别由 #30、#29 收口。
- #12 原全量 AC 映射保留作为历史范围索引，新增执行责任表定位子票；#32 建立本期 AC-01–AC-34 台账并链接各类证据，不继承历史同号 AC 的通过结论。
- #33 负责 Linux Chrome 与 iPhone Safari 正式环境证据；#34 负责授权上游、真实媒体、实际规模持续调度和资源证据。两票各自更新 #32 台账的对应行；若尚未创建台账，先独立记录，随后由 #32 汇入。
- 环境缺失、授权未给或项目失败必须标为未验证/失败。#32 可以完成“台账和自动化验证”的交付，但必需人工项未验证时，#12 和整个功能仍不能宣称完整验收。
