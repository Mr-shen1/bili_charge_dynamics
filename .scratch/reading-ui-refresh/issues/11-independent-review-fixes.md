# 11：独立审查整改与最终候选复验

Status: resolved
Blocked by: 09

这是 implement-spec 收尾要求的审查整改票，不新增产品功能。依据：[双轴审查](../evidence/final-independent-review.md)、[规格](../spec.md)、[正式设计](../../../docs/design/reading-ui-refresh.md)。

## 验收条件

- [x] 逐项处置 Standards 与 Spec 的发现；误报、判断项的保留有原文和代码依据，不发明既有规范。
- [x] 对话环的起点与投影不随回复排序变化，page/locate/conversation 一致，并通过真实 HTTP＋临时 SQLite 回归。
- [x] 会话返回可见标签与无障碍名匹配；列表标签标题及图片保存状态文案收口。
- [x] 字号与颜色 token 统一，明确判断重复控件、样式、类型与命名的实际改进，避免仅为消除启发式而造新框架。
- [x] 仅整理本轮未推送的提交消息，保留概念边界/树/拓扑，修正不允许的 `style` 类型；不改 main 或混入外部并行部署变更。
- [x] 在最终代码候选上完成前端检查/构建、受影响浏览器/实际隔离接口与后端回归；候选截图与10待办同步，黄金图不动，不代签设备与部署。
- [x] 追加 Answer、状态 resolved，并在 map Decisions-so-far 写最终证据指针。

## Answer

审查整改在本候选完成，没有新增产品功能。逐项结论、误报依据与验证证据见[最终双轴独立审查](../evidence/final-independent-review.md)；下面只列验收条件对应的结果与提交（提交消息统一整理后的同树 SHA 见[重写映射](../evidence/commit-message-rewrite.json)）。

| 验收条件 | 结果 | 提交 |
| --- | --- | --- |
| Standards 与 Spec 逐项处置 | S1–S3 属实并修复；Spec1–Spec3 属实并修复；S4b 粗体格式与 S5 顶层 scope 经原文核实判为误报，不造新规则；J1–J4 各做最小改进。两轴处置与证据见[审查证据](../evidence/final-independent-review.md) | `88849e6`、`b8ef00a`、`c045f4e`、`fd39cb0`、`3b9b99d`、`9bfdbaf` |
| 对话环起点不随排序漂移，page/locate/conversation 一致 | 环内起点改按时间序取最早条目；新增真实 HTTP＋临时 SQLite 用例先红后绿，两种排序各页、定位与 conversation 子资源同一起点与成员；无采集/迁移 | `88849e6` |
| 会话可见标签与无障碍名匹配；列表标签与图片状态文案收口 | 返回控件名“会话列表，返回评论详情”（含可见标签）；列表页签“充电动态”与入口静态 `<title>` 一致；图片状态按保存语义改写，来源正文/昵称未动 | `c045f4e`、`fd39cb0`、`9bfdbaf` |
| 字号/颜色 token 与重复控件/样式/类型的判断 | 组件字号引用 01 的 token 且无零引用 token；`--brand-soft` 成为声明过的语义 token；排序控件、两页共用样式、读取状态类型与 tuple 命名各只有一份定义；未建新框架 | `3b9b99d`、`b8ef00a` |
| 仅整理未推送提交消息，保留概念/树/拓扑 | 只把 `style(frontend)` 改成允许的 `refactor(frontend)`（仅首行）；其余提交只改由父 ID 变化产生的提交对象，树/作者/时间/拓扑/其它消息不变；old→new 映射见 `evidence/commit-message-rewrite.json` | 见映射 |
| 最终候选的前端、实际隔离接口与后端复验 | `pnpm check`（32 文件/347 例）、`check:dist`、主 e2e 235 passed、production 3、manage 9、location 16、delivery 6、隔离 Nginx 三阶段、后端全量 1256 passed；四宽度候选截图 63 张在 `evidence/final-screens/`，黄金图未更新 | 见证据“最终验证” |
| 追加 Answer、状态 resolved、map 指针 | 本 Answer；`map.md` Decisions-so-far 已补 11 指针；10 保持 `ready-for-human`，只更新候选与截图指针，不代签 | — |

### 候选与截图

- 代码候选：整理前 `9bfdbaf`（干净工作树），整理后同树 `2e1d0017a8208a0adfe26d65cc43b830f5c4f0d3`；分支 tip 整理前 `4014a390b969b6e653b3061678461b50d879e029`→整理后 `a292a3d84c141ce0f7f060358a2fcc35046a411a`。
- 截图候选：`evidence/final-screens/`，`conditions.json` 记录 `sourceCommit=9bfdbaf`、`sourceStatus=[]`；截图提交整理前 `446301d`→整理后 `b43ce3d576ff503f7693433eabf66dcdee56b252`。09 的 `09-screens/` 保留为历史。
- 未验证：人工视觉签收、iPhone Safari/真实设备、真实飞书/上游/OSS、目标机部署与持续运行，均由票 10 与另行授权处理。

### 二次复核残留闭环（追加）

独立复核在 `4c6fe48` 上确认仍有 4 项残留后，本票重开并已闭环；完整扫描、例外登记与验证见[二次复核残留闭环](../evidence/final-review-residual-closeout.md)，本票状态由此改为 `resolved`。恰好本次也把首次证据“7 处”与实际不符的情形记清：首次只落了 5 处，本轮补齐两处，不改写首次记录。

| 复核项 | 结论 | 处置 | 提交 |
| --- | --- | --- | --- |
| S3 残留：`CommentItem.vue` 两处 `var(--brand-soft, #e6f6f7)` | 成立（首次只改 5 处，非 7 处） | 去掉 fallback，改用已声明的 `--brand-soft`；颜色值不变，`grep '#e6f6f7' frontend/src` 只剩 token 声明 | `f8fee65` |
| S2 残留：阅读组件 12/20、13/20、13px 硬写 | 成立 | 按角色改引 `--font-badge`/`--line-badge`、`--font-meta`/`--line-meta`（计算值不变）；布局对齐行高 24px、图片预览/夹具/调试层、`line-height: 1.7` 比例行高与管理输入字号逐条登记为有意例外，不宣称“全已收口” | `f8fee65` |
| 配对返回控件名不含可见标签 | 成立（`0c77c72` 起既有，非本次引入） | 先写公开可观察的 Label-in-Name 失败用例，再把 `aria-label` 改为“评论详情，返回动态详情”；返回行为与会话返回排序/页码/位置不变，定位该按钮的单测与浏览器断言同步更新 | `1fe56a7` |
| `replyReadState()` 恒等复制 | 成立 | 核实 `useReplyPage` 只整对象替换、从不原地修改，删除助手与调用，快照直接 `read: state.value`；别名注释改为“同一份定义＋为什么可直接持有引用” | `88b692f` |

- 最终代码候选：`88b692facc0c0e39ea527fbe87895c4544be5291`（干净工作树）。
- 验证：`pnpm check`（32 文件/348 例）、`check:dist`、主 e2e 235 passed/18 skipped、production 3 passed、manage 9 passed、location 16 passed、delivery 6 passed、后端定向 38 passed；`backend` 子树与前候选相同（tree `c25b57d…`），沿用父候选全量 1256 passed；隔离 Nginx 三阶段本轮未重跑（改动不涉交付脚本与路由），如实记录。
- 四宽度截图：新目录 `evidence/final-2-screens/`（63 张＋`conditions.json`，`sourceCommit=88b692f`、`sourceStatus=[]`）；与首次 `final-screens` 逐张对照 56 张字节相同、7 张仅抗锯齿级（AE@1% fuzz=0，权重和 <1 像素）、0 张可见变化，黄金图未更新。
- 旧指针保留：`9bfdbaf`/`final-screens` 仍是首次处置的候选记录，不改写；本轮候选以 `88b692f`/`final-2-screens` 为准。
