# 阅读与管理界面优化实施地图

## Notes

- 集成分支：`spec/reading-ui-refresh`；代码基点：`0c77c72`；需求基线：`8edbb2d`。
- 规格与依赖：[spec](spec.md)、[执行计划](implementation-plan.md)。
- 测试边界沿用规格“测试决定”：浏览器可观察行为、真实只读 HTTP＋临时 SQLite、必要 Adapter 契约；不增加私有状态测试边界。
- 首批前沿为 01、02、06；现 01–13 均已 `resolved`，最终代码候选 `b1dec5c`。10 已由用户明确确认验收完成，所有实现工作树及 `wt/` 分支已清理。
- 共享写入：01 主责主题/壳/UP条/生成文案，02 主责根评论读取区域/默认排序，06 主责对话读取/DTO/回复入口/会话页。相邻重叠在实现分支合入集成最新 tip 时协调，禁止最后写入覆盖。
- 本地 Markdown 关闭，10 按用户签收关闭，不代填未提供的设备信息。用户随后另行授权合 main 并 push；不创建 PR、不部署、不操作生产。
- 11 已完成双轴审查整改；后续 12/13 与返回样式小改均已交付。[10](issues/10-visual-and-real-device-acceptance.md)按用户明确“已经验收完成了”设为 `resolved`；设备留证限制保留，黄金图已按后续授权更新为版本 2 并独立复拍通过，未部署；用户授权整理提交、合 main 并 push。

## Decisions-so-far

- **黄金图更新已完成**（[证据](evidence/golden-baseline-update.md)）：用户在验收完成后以“更”明确授权，生成候选 `445465c` 的 63 张四宽度截图并更新黄金图版本 2，保留旧签收记录、原始截图与更新理由；独立全量复拍再次 63/63 比较通过。未恢复用户已要求停止的 4318；部署与真实外部服务未执行。

- **10 已 `resolved`，规格收口**（[用户验收结论](issues/10-visual-and-real-device-acceptance.md#answer)、[人工记录](evidence/10-visual-and-device-acceptance.md)）：用户在手机与 Chrome 验证后确认整体无明显问题，并明确验收完成。最终代码候选 `b1dec5c`，保留未提供的设备版本与 Safari 专项留证限制，不再作为本票阻塞；黄金图随后已获授权并更新，独立复拍 63/63 通过；用户已授权整理提交、合 main 并 push，部署仍需另行授权。

- [已确认设计](../../docs/design/reading-ui-refresh.md)与原型作为需求基线提交，不把签收当成正式实现结果。
- **06 已 `resolved`**（证据：[06 证据](evidence/06-conversation-reading.md)）：定稿 `conversation:{start_id,count,incomplete}` 投影（仅 page 与定位响应）与只读 `GET .../replies/{reply_id}/conversation?page&limit=10`，浏览器入口 `/dynamics/:dynamicId/comments/:rootId/replies/:replyId/conversation`。05 只追加回复 `sort`，07 只做会话往返恢复；本票不新增表/迁移/采集/索引，也不宣称 UI-11 或 UI-08 完成。
- **07 已 `resolved`**（证据：[07 证据](evidence/07-conversation-navigation-restoration.md)）：会话往返恢复定稿在客户端——独立回复访问（窄屏楼中楼页与窄屏回复精确入口）在导航协调器里存一份**仅内存**的访问快照（区域身份=动态+根评论、排序、页码、已读批次与失败原因、定位意图、阅读位置），按历史记录索引；`‹ 会话列表` 与浏览器返回/前进恢复该次访问，先按快照内容渲染再按锚点落点，不重读第 1 页、不重新定位，热度第 N 页返回仍是热度第 N 页；无来源时 `replace` 为所属回复详情的时间序第 1 页，新访问仍是第 1 页与顶部。无新接口/表/迁移/索引/采集；楼中楼路由加 `ThreadPage` 按访问标识重建。行为变化：前进也恢复该次访问（既有 thread e2e 断言同步更新）。本票不宣称 UI-04 或人工视觉签收完成。
- **05 已 `resolved`**（证据：[05 证据](evidence/05-mobile-reply-sort.md)）：只在 06 的回复读取链上追加 `sort=time|hot`，仅在实时 page 模式有效，省略等价 `time`；热度=点赞降序（缺失后置）+发布时间降序+ID BINARY 升序，对完整本地集合排序后每页 10 条；cursor 资源/旧 token/定位页码/会话时间序不变，无新表无迁移。手机回复详情用与 02 同形状的单按钮 `☰ 按时间/按热度`、13px 数量与控件，切换回第 1 页并作废该次定位意图；07 在此之上做往返恢复，本票不宣称 UI-08 或 UI-11 完成。
- **12 已 `resolved`**（仅代表实现完成，证据：[12 证据](evidence/12-avatar-and-management-alignment.md)）：UP 选择条改为 6px 内边距＋等量负外边距，选中（2+2）与键盘焦点（3+2）轮廓不再被横滑容器裁切，48px 头像、长昵称完整换行、隐藏滚动条与 12px 可见项留白不变；负外边距要求的裁剪空间由主栏新增的 6px 最小留白承接（桌面内容宽仍 724px），并在 700px 贴边宽度加了无横溢断言。管理表单把库的 32px 标签盒在 44px 行里交叉轴居中，输入命中盒保持 44px，可见描边与按钮同源改用 `::before`（桌面 32／手机 36）并接回默认/悬停/聚焦/禁用四态，手机 16px／桌面 14px 字号不变。用户视觉复验、黄金图与旧预览更新仍在 10 与主线程，本票不代签。
- 02 一级评论默认改按时间、单按钮排序、区域身份（`regionId`）与快照采纳规则已交付；03 用同一身份挂载列表内多区域，05 沿用同一控件形状。实现要点、测试与未验证范围见[02 证据](evidence/02-root-comment-sort.md)，客户端契约见[归档 API 客户端](../../docs/backend/api/archive-api-client.md#阅读改版-02-增量一级评论默认按时间与单按钮排序)。

- 01 阅读壳/用语/UP 条/排版标尺已交付：阅读页去公共顶栏（管理保留独立入口）、文案统一称“动态”并把保存动作按语义改写、UP 条上图下字并按可见项测高、`theme.css` 提供后续票复用的排版 token。评论区字号由 02 落地，管理排版与输入字号留给 08，详情页头留给 04。实现要点、四宽度验证与未验证范围见[01 证据](evidence/01-reading-shell-and-typography.md)。`scripts/compare-visual-baseline.mjs` 的 `magick` 未定义缺陷在 01 复验时暴露，交由 09/10 前修复。
- 08 管理紧凑布局已交付：管理两级页面改用 01 的标尺（18/20 页标题、16/24 区块标题、14/22 说明与状态、13/20 操作按钮），分区间距手机 20/桌面 24；单 UP 控制行状态在左、操作在右，按钮视觉 32/36px 而点击区仍 44px（`::before` 画可见块，本体保留命中盒），四字按钮 76px、右边缘差 0；手机输入 16px、桌面 14px，只在管理页输入行覆盖 `.el-input__inner`，基础字号与按钮不放大；启停/保存/删除与重新添加的既有语义与断言保留。实现要点、四宽度实测、候选截图差异与未验证范围见[08 证据](evidence/08-management-layout-and-controls.md)。真机 Safari 输入聚焦与视觉签收留给 10；黄金图未更新。`scripts/compare-visual-baseline.mjs` 的 `magick` 未定义缺陷仍未修，本票改用 `visual:diff-report` 取证。

- **03 已 `resolved`**（证据：[03 证据](evidence/03-desktop-inline-card-comments.md)）：宽屏卡片评论在卡片下方展开／收起一级评论，列表与 URL 不跳走，窄屏保持原站内入口；卡片区域复用 02 的 `CommentSection`（`regionId=list:{动态 ID}`），没有第二套评论读取状态机。列表快照新增按动态 ID 的 `comments`（键存在即展开，旧快照按未展开恢复），卡片点击忽略评论区内的目标、内联标题改静态计数避免同名按钮。实现要点、重复稳定性实验与未验证范围见证据；`list.spec.ts` 的既有竞态断言已在票内改为轮询（阈值未变）。04 可开始，07 的会话恢复与 09 的全量截图不在本票。
- **04 已 `resolved`**（证据：[04 证据](evidence/04-detail-tabs-and-mobile-navigation.md)）：宽屏正文入口改为真实新标签（`rel="noopener"` + `openInNewTab`），原列表 URL/滚动/内联评论排序与回复页码原样保留；组合键与中键交回浏览器原生语义，应用不再额外开窗。正常详情去掉可见页头：宽屏无标题无返回，窄屏只留 `‹ 动态列表`（失败/已取消/不存在两端都有退出入口），`h1` 保留为视觉隐藏标题。标签标题由新 `documentTitle.ts` 按路由决定（详情/精确根入口=动态详情，回复详情与会话各有名称），直达、刷新与新标签一致；通知精确链接的定位语义未改。无新导航方法（07 的会话段落原样保留）、无接口/表/迁移/采集。delivery 三进程用例在 `01716b2` 基线上同样失败（通知闸门默认 `off`），记为与本票无关的既有缺陷，未扩范围修复；Nginx 静态交付、真机、视觉与四宽度截图留给 09/10。
- **09 已 `resolved`**（证据：[09 证据](evidence/09-integrated-verification.md)）：同一候选（组合回归 `b72d555`、截图 `703f931`）上补了后端组合契约（真实 HTTP＋临时 SQLite：排序先于分页、入口资格跨页、关系不串父级/根/动态、旧时间 token 与定位兼容、零上游请求账本）与 location/manage/delivery 三条组合 e2e；修复视觉比较脚本的 `magick`、三进程投递的通知闸门初始化（先断言生产默认 `off` 再只在隔离库开 `all`）与被 04 标题变更暴露的交付回退陈旧断言。63 张四宽度候选截图与黄金图存在预期差异、黄金图未更新。视觉签收、iPhone Safari/真机、真实飞书/上游与部署留给 10。
- **11 已 `resolved`**（证据：[最终双轴独立审查](evidence/final-independent-review.md)）：逐项处置 S1–S5／J1–J4／Spec1–3 与额外提交消息 M1；行为修复先红后绿（环起点按时间序固定、会话返回无障碍名含可见标签、列表页签与图片状态文案收口），J1–J4 各做最小改进，S4b/S5 核实为误报不造规则。最终候选（整理前 `9bfdbaf`（整理后同树 `2e1d0017a8208a0adfe26d65cc43b830f5c4f0d3`））通过 `pnpm check`（347 例）/`check:dist`/主 e2e 235/production/manage/location/delivery e2e、隔离 Nginx 三阶段与后端全量 1256 passed；63 张候选截图在 `evidence/final-screens/`，黄金图未更新。提交消息只整理 `style(frontend)` 一条，old→new 同树映射见 `evidence/commit-message-rewrite.json`；视觉人工签收、真机、真实飞书/上游与部署仍留给 10。
- **11 二次复核残留已闭环**（证据：[二次复核残留闭环](evidence/final-review-residual-closeout.md)）：独立复核在 `4c6fe48` 重开确认 4 项残留——`CommentItem` 两处 `--brand-soft` fallback（首次实际只改 5 处）、阅读组件 12/20 与 13/20、13px 硬写、配对返回控件名不含可见标签、`replyReadState()` 恒等复制。已分别去掉 fallback、按角色改引 `--font-badge`/`--font-meta`（计算值不变，布局对齐行高与预览/夹具/调试层、比例行高、管理输入字号逐条登记为例外）、把无障碍名改为“评论详情，返回动态详情”（先红后绿）并直接持有所在读取结果对象。最终候选 `88b692f`（干净工作树）通过 `pnpm check`（348 例）/`check:dist`/主 e2e 235/production 3/manage 9/location 16/delivery 6/后端定向 38；`backend` 子树与父候选相同（tree `c25b57d…`）故沿用全量 1256 passed，隔离 Nginx 三阶段本轮未重跑（不涉交付脚本）。63 张新截图在 `evidence/final-2-screens/`（`sourceCommit=88b692f`、`sourceStatus=[]`），与首次 `final-screens` 对照 56 张字节相同、7 张仅抗锯齿级、0 张可见变化，黄金图未更新；视觉人工签收、真机、真实飞书/上游与部署仍未验证。

- [最终独立复核与交付状态](evidence/final-independent-verification.md)：Standards 确认缺陷 0、Spec 新引入缺陷 0；最终代码候选 `88b692f` 与被复核集成 tip `52cad46` 的前后端零差异。集成后重跑 `pnpm check`（348 例）及 `check:dist` 通过；后端同子树沿用 1256 全量，最终浏览器与截图证据见该记录；10 仍待人工，未合 main 或部署。

## Fog

- 用户已确认 10 验收完成；具体设备版本与 Safari 专项未单独留证，作为已披露限制保留。黄金图已按后续授权更新；部署及真实外部服务未授权。