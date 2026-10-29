# 最终双轴独立审查

审查范围：`git diff 0c77c720112cdf151f6e812bc2512e7985ca5660...4d431e1`。固定基点为本轮开工的 main；后续外部并行推进的 main 部署改动不在本轮范围。两轴由独立 `review` 子代理并行执行，未重跑测试。下列为审查发现，处置状态见文末，不把候选问题或启发式自动当成已确认缺陷。

## Standards 原始报告

**硬违规**
1. 文案规则未收口：`docs/design/reading-ui-refresh.md:37-38` 要求可见文案不再称“归档”、保存动作按语义改写；`preview/imageStatus.ts:5-7`（图片待归档／图片归档失败／归档图片地址不可用）与 `dynamics/CommentItem.vue:81`（评论图片待归档）未改，而同文件 `:96`“回复尚未归档”已改为“回复尚未保存”。
2. token 规则被违反：`theme/theme.css:44-47` 写明“组件只引用 token”，但 `dynamics/CommentSection.vue:203-204,214-215,242-243,252-253` 硬写 14/22、13/20，致 `--font-section/--line-section`（`theme.css:34-35`）零引用；`mock/SelfCheckNav.vue:30-31` 同样。
3. 未声明 token：`--brand-soft` 未在 theme.css 定义，靠 fallback 用于 `CommentItem.vue:123,156`、`ReplyPreview.vue:59`、`ReplySection.vue:291`、`CommentThreadPage.vue:338,426`、`ConversationPage.vue:168`。
4. 票据纪律：`docs/agents/issue-tracker.md:31` 要求指针进 Decisions-so-far，09 条目写在 `## Notes`（`map.md:11`）；`map.md:19,21,22` 的 01/02/08 缺 `**NN 已 resolved**` 格式。
5. 提交 scope：`docs/agents/implement-spec.md:19` 取目录名或子系统名，`chore(evidence)`（703f931）、`feat(dynamics)`（ce71eca、0b872ab）均非顶层目录。低危。

**判断项（smell 启发式，非硬违规）**
- Duplicated Code：排序三件套两份——`CommentSection.vue:67-68,131-135` 与 `CommentThreadPage.vue:39-40,146-151`。
- Duplicated Code：`ConversationPage.vue:86-98,128-215` 复制 `CommentThreadPage.vue` 的条目与返回按钮样式；设计 §5 要求两者样式完全相同，复制会漂移。
- Data Clumps：`ReplyVisitReadState`（`snapshots.ts:84-89`）与 `ReplyPageState`（`useReplyPage.ts:22-27`）同形，`CommentThreadPage.vue:96-104` 手工重拼字段。
- Mysterious Name：`_reply_conversation_members`（`storage.py:181`）名为 members，实返 `(resolved, members)`。

未做真机与视觉签收属已授权人工边界（票 10），不计缺陷；README/API 文档同步与 `Refs:` 提交格式合规。

## Spec 原始报告

主体符合规格：排序先对完整本地集合执行，再分页；旧 time cursor 与定位语义未变；缺投影不推断入口；会话返回恢复排序、页码和位置；无来源 replace 到时间序第 1 页；多卡片按区域身份隔离；管理草稿、启停、独立删除未改业务关系。真实隔离 API 与浏览器用例对得上证据。以下 3 项有据可改。

### (c) 看似实现但实际错误

1. **异常环的对话起点随排序漂移**。`_reply_starts` 按调用方传入顺序（即请求 sort 顺序）选环的起点（backend/bili_monitor/storage.py:141-179、190-201），`read_conversation` 却固定时间序（同文件 1602-1626）。用 09 夹具（960021↔960022）可复现：`…/replies?page=1&limit=10&sort=hot` 的 `conversation.start_id="960022"`，而 `sort=time` 第 3 页与 `…/replies/960021/conversation` 都是 `"960021"`。影响：CommentThreadPage.vue:166-169 以 `start_id !== reply.id` 判入口，环数据下「查看对话」在两种排序下落点相反，投影起点与会话响应自相矛盾（规格 §5.1/§7 要求起点不由排序决定）。09 证据 §2“入口资格跨页稳定”只断言时间序（backend/tests/test_reading_ui_integration.py:199），hot×环无取证。
2. **会话页返回控件的无障碍名与可见文案不符**：frontend/src/pages/ConversationPage.vue:62 `aria-label="返回评论详情"`、显示 `‹ 会话列表`，违反 Label in Name，也与规格 §5.2“左上角只显示 `‹ 会话列表`”不符；conversation.spec.ts:156/167 等以该名字定位，把偏差固化成断言。

### (a) 部分实现

3. UI-01“应用生成文案无‘归档’阅读名称”仍漏一处：列表/单 UP 页签标题仍是“充电动态归档”（frontend/src/app/documentTitle.ts:4、25），unit/document-title.test.ts:14-16 已锁定；其他阅读页均改“动态详情/回复详情/会话列表”。打开 `/` 即可见。低严重度（可辩为产品名），但 09 台账 UI-01 记“通过”与该事实不符，需定稿。

### (b) 范围蔓延

未发现未要求的功能新增；3 处脚本修复已登记在 09 证据 §1.1/§1.3，属取证必需。

### 取证核验（只核对证据与代码，未重跑）

09-screens 63 张 PNG、diff-report 63 条（identicalBytes 全 false、最大 17.853%）、conditions.json `sourceCommit=b72d555` 与报告一致；`pnpm check` 的 32 个 Vitest 文件可对账（tests/unit 恰 32 个）。真机、真实飞书、部署与视觉人工签收按约定留给票 10，不代签。

## 处置与最终验证

由 [11 审查整改](../issues/11-independent-review-fixes.md)逐项复核与记录。两轴保持独立：先 Standards（S1–S5 与启发式 J1–J4），再 Spec（Spec1–Spec3），另记额外发现的提交消息问题 M1。确认的行为缺陷先在公开边界复现再修（Spec1 真实 HTTP＋临时 SQLite）；明显误报不以臆造仓库规则为由修改。所有处置后的候选验证见文末。

### Standards 轴处置

| 项 | 复核结论 | 处置与证据 |
| --- | --- | --- |
| S1 文案未收口 | 属实，已修 | 应用生成的图片状态改为“图片待保存／图片保存失败／已保存图片地址不可用”（`preview/imageStatus.ts`），评论图片提示改为“评论图片待保存”（`dynamics/CommentItem.vue`）；来源正文、昵称、API 字段与日志未动。列表页签的同类漏项并入 Spec3。断言同步在 `tests/unit/{list-page,comment-images,comment-reading}.test.ts` 与 `tests/e2e/{list,dynamic-images,comments,comment-images,preview-images}.spec.ts`；`grep` 复核 `frontend/src` 不再有旧文案。提交 `fd39cb0`。 |
| S2 token 规则被违反 | 属实，已修 | `dynamics/CommentSection.vue` 的 14/22 与 13/20 改引 `--font-section/--line-section` 与 `--font-meta/--line-meta`，`mock/SelfCheckNav.vue` 改引 `--font-link/--line-link`；对 `frontend/src` 统计后全部 28 个字号/行高 token 都有实际引用，无零引用 token 遗留。计算值仍是 14/22、13/20，`tests/e2e/detail.spec.ts` 的字号断言未改。提交 `3b9b99d`。 |
| S3 未声明 `--brand-soft` | 属实，已修 | `theme/theme.css` 新增 `--brand-soft: #e6f6f7` 作为品牌浅底语义 token；`CommentItem`、`ReplyPreview`、`ReplySection`、`CommentThreadPage`、`ConversationPage` 共 7 处去掉 `, #e6f6f7` fallback。颜色值不变，四宽度截图复核。提交 `3b9b99d`。 |
| S4a 09 指针不在 Decisions-so-far | 属实，已修 | `docs/agents/issue-tracker.md` 的 Resolve 步骤要求“append a context pointer to the map's Decisions-so-far”；09 条目原写在 `map.md` 的 Notes。已把该指针移到 Decisions-so-far，并补 11 的处置指针。 |
| S4b 01/02/08 缺 `**NN 已 resolved**` 粗体 | **误报，不修** | 复核 `docs/agents/issue-tracker.md`：执行态只要求 `Status:` 行取 `claimed`/`resolved`，结论追加在 `## Answer`，再给 map 指针；全文没有规定地图条目必须用粗体 `**NN 已 resolved**` 模板。地图里粗体与不粗体混用是历史排版，不是仓库规则；不为消除这条启发式另造格式规则。 |
| S5 提交 scope 必须顶层目录 | **误报，不修** | `docs/agents/implement-spec.md` 的原文只写“scope 取本仓库目录名……或子系统名……；跨范围用逗号并列”，没有“顶层目录”限制。`dynamics` 是本轮回复/评论阅读子系统的名字（01、02、03 的 `feat(dynamics)` 历史提交一致），`evidence` 是仓库内真实目录（`.scratch/reading-ui-refresh/evidence`）。scope 不改，历史提交保持原样；本轮新增提交按 `backend`/`frontend`/`docs`/`test` 现有目录名取 scope。 |

### 启发式判断项（J1–J4）

四项都是 smell 启发式，不是硬违规；逐项做最小、可 revert 的改进，没有新建框架、控件库或产品范围。

| 项 | 判断 | 最小处置 |
| --- | --- | --- |
| J1 排序三件套两份 | 属实，值得合并 | 新增 `dynamics/SortToggle.vue`：单按钮、只显示当前排序、`☰` 图标、13/20、44px 点击区、当前/下一排序的无障碍名只在这里定义。一级评论区与手机回复详情都改用它，页面只保留排序状态与切换后的重读行为；`@projects` 与角色定位的既有用例未改。 |
| J2 会话/回复页样式复制 | 属实，且设计 §5.2 要求两页相同 | 返回控件、访问容器、回复条目的身份/昵称/正文/目标/指标、列表、状态行与操作链接移到全局 `theme/reading.css`，用分组选择器一份定义；两页只留定位/入口标记、页头与计数等页面专属规则。声明值与原来逐项相同（均取 01 的 token），模板类名与 e2e 选择器不变。 |
| J3 两种读取状态同形 | 属实 | `snapshots.ts` 的 `ReplyVisitReadState` 直接复用 `useReplyPage` 的 `ReplyPageState`；新增 `replyReadState()` 收掉 `CommentThreadPage` 卸载时手工重拼四个字段。快照形状不变（仍是 status/data/reason/page）。 |
| J4 `_reply_conversation_members` 名不副实 | 属实 | 改名 `_reply_conversation_segments`，docstring 写明返回 `(逐条起点, 起点→成员)`；行为与投影不变。提交 `b8ef00a`。 |

### Spec 轴处置

| 项 | 复核结论 | 处置与证据 |
| --- | --- | --- |
| Spec1 异常环起点随请求排序漂移 | 属实，已修（先红后绿） | **red**：在 `backend/tests/test_reading_ui_integration.py` 新增真实 HTTP＋临时 SQLite 用例，同时读时间/热度各页、定位响应与 conversation 子资源；修复前失败 `AssertionError: ('hot', 1, '960021') … start_id '960022' != '960021'`。**修复**：`_reply_starts` 遇到环时按时间序（`published_at` 后置规则＋ID BINARY 收尾，与 `_reply_order("time")` 同键）取环内最早条目作起点，页面排序只决定本页条目顺序。**green**：同一用例通过，`960021/960022` 在两种排序、定位与 `conversation` 中都是 `{start_id: "960021", count: 2, incomplete: true}`，成员时间正序为 `[960021, 960022]`；`test_reply_sort.py`、`test_conversation_reading.py` 不受影响。无采集、无迁移、无新表。提交 `88849e6`。 |
| Spec2 会话返回控件无障碍名不符 | 属实，已修 | 显示 `‹ 会话列表`，无障碍名改为“会话列表，返回评论详情”：包含可见标签，并继续解释返回到来源评论详情。`tests/unit/conversation-reading.test.ts` 新增“名称包含可见标签”的显式断言；会话返回相关 20 处定位改为新名称，单元与 location/delivery 浏览器用例通过。无来源/不存在的独立“返回评论详情”按钮保持原可见名。提交 `c045f4e`。 |
| Spec3 列表页签仍含“归档” | 属实，已修 | `documentTitle.ts` 的兜底标题与 `frontend/index.html` 的初始 `<title>` 同为“充电动态”（首屏加载/读取失败也不露出旧名）；列表/单 UP 路由的标签标题随之统一。`tests/unit/document-title.test.ts` 锁住“列表页签不再称归档”，并新增断言把入口静态标题与 `baseDocumentTitle` 绑在一起。09 台账 UI-01“通过”的表述因此不完整，已在[09 证据](09-integrated-verification.md)追加说明，台账以本证据为准。提交 `fd39cb0`、`9bfdbaf`。 |

### 额外发现（M1）：提交消息类型

审查范围里 `e7924b3 style(frontend): 会话页与查看对话入口沿用统一阅读标尺` 的 `style` 不在 `docs/agents/implement-spec.md` 允许的 type 列表内。该提交只把本票新增元素的硬编码字号换成 01 的 token（3 个文件，无行为变化），因此按 `refactor(frontend)` 重写首行，正文与树保持不变。只整理本轮未推送历史中的这一条消息；其它提交只改由父 ID 变化导致的提交对象 ID。审计映射见[重写映射](commit-message-rewrite.json)。

### 最终验证（候选）

候选为审查整改后的分支 tip（整理前 `9bfdbaf`，截图同候选且工作树干净；提交消息整理后的同树 SHA 见重写映射）。命令均在 `frontend/` 下、Git 仓库根跑后端；Node v24.21.0 / pnpm 10.34.6，Python 用主树 `.venv`（`UV_PROJECT_ENVIRONMENT` + `--no-sync`），Chromium 145.0.7632.6（Playwright 1.58.2）。

| 命令 | 结果 |
| --- | --- |
| `pnpm check` | 通过：`vue-tsc`＋32 个 Vitest 文件 / 347 例＋e2e 项目覆盖守卫一致 |
| `pnpm check:dist` | 通过：生产与 mock 两次构建＋产物隔离（`dist` 无 mock 入口/夹具/归档数据） |
| `pnpm test:e2e` | 235 passed / 18 skipped（4.5m） |
| `pnpm test:e2e:production` | 3 passed / 3 skipped |
| `pnpm test:e2e:manage` | 9 passed（实际隔离 API＋SQLite） |
| `pnpm test:e2e:location` | 16 passed（实际隔离 API＋SQLite） |
| `DELIVERY_E2E_API_PORT=4402 DELIVERY_E2E_WEB_PORT=4403 pnpm test:e2e:delivery` | 6 passed（API＋采集＋通知三进程） |
| `NGINX_BIN=/tmp/nginx-16/nginx-1.28.0/objs/nginx … DELIVERY_PORT=4401 pnpm test:delivery` | 三阶段全部 PASS（mock 阅读/缓存/回退、入口更新与回退、生产产物＋实际 API/collector、401 与密钥扫描） |
| `VISUAL_OUT_DIR=…/evidence/final-screens pnpm visual:baseline` | 6 passed：63 张四宽度截图＋布局/触控/焦点审计；`conditions.json` 记录 `sourceCommit=9bfdbaf`、`sourceStatus=[]` |
| `pnpm visual:compare --current …/final-screens` | 预期差异：63/63 张不同（退出码 1），差异图已写出；黄金图未更新 |
| `pnpm visual:diff-report --current …/final-screens` | 字节完全相同 0 张；63 张像素权重差，最大 17.853% |
| 仓库根 `uv run --no-sync pytest backend/tests -q` | **1256 passed**（11m24s；含新增环排序用例）。首轮 1255 passed + 1 failed：`test_collector.py::test_fixed_ticks_skip_busy_check_without_blocking_other_targets` 在全量负载下出现既有 tick 竞态（断言 `("123", 15) not in requests`），单跑 3/3 通过、复跑全量通过；该用例不涉及本轮改动，未改测试或采集逻辑，如实记录为环境时序抖动。 |

候选截图在 `.scratch/reading-ui-refresh/evidence/final-screens/`（63 张 PNG＋`conditions.json`＋`diff-report.json`），09 的 `09-screens/` 保留为历史。未验证仍按原边界：人工视觉签收、iPhone Safari/真实 Chrome 设备、真实飞书/上游/OSS、目标机部署与持续运行；代理不代签、不操作生产。

### 提交消息整理与最终候选

- 整理范围：`0c77c72..4014a390b969b6e653b3061678461b50d879e029`（本轮未推送历史，59 个提交），不动 `main`、`spec/reading-ui-refresh` 或远端。
- 只改一条消息：`e7924b3` → `096a508d734968f7ef10b29b9ebc7c5969928307`，首行 `style(frontend):` → `refactor(frontend):`，正文与树不变。
- 其余 58 个提交的消息、树、作者、提交者、时间与父拓扑不变；其中 18 个在改写提交之前的提交 SHA 不变，41 个因父 ID 变化生成新提交对象。整段无签名与 `mergetag`/`encoding` 额外头；范围内 9 个合并提交的多父列表也按同一映射保留，脚本在遇到签名/额外头时中止。
- 同树证明：旧 tip `4014a390b969b6e653b3061678461b50d879e029` 与新 tip `a292a3d84c141ce0f7f060358a2fcc35046a411a` 的 tree 均为 `abbda4aead9314f3e5e51b8b8eeb1986dab1679c`；逐提交核验 59/59 棵树一致、author/committer 行逐字一致。
- 候选映射：代码候选 `9bfdbaf` → `2e1d0017a8208a0adfe26d65cc43b830f5c4f0d3`；截图候选 `446301d` → `b43ce3d576ff503f7693433eabf66dcdee56b252`。完整 old→new 账本见[重写映射](commit-message-rewrite.json)；旧证据中的旧 SHA 不追改，按此表可审计还原。
- 整理后分支不再以旧集成 tip 为父；merger 应核验本映射后只搬运新分支指针，不做普通 merge、不引回 `style` 历史。

另把 09 的历史截图与本轮 `final-screens` 逐张对照（同尺寸、ImageMagick AE＋1% fuzz）：48/63 张字节完全相同，其余 15 张像素差异均 ≤0.067%（其中 9 张低于 1% 判等阈值，属渲染抗锯齿；可见差异只在窄屏楼中楼的排序按钮，来自共用控件的图标与文字间距），支持“文案、无障碍名与共用样式没有改变目标视觉”的判断。

## 二次复核残留闭环（追加，不改上文）

上文与“处置与最终验证”保持原文。独立复核在 `4c6fe48` 上重开后，确认仍有 4 项残留并已闭环；完整扫描、逐项处置、例外登记与验证见[二次复核残留闭环](final-review-residual-closeout.md)。摘要：

- **S3 残留**：`CommentItem.vue` 两处仍是 `var(--brand-soft, #e6f6f7)`，首次处置实际只改了 5 处而非 7 处；本轮去掉 fallback（颜色值不变），并如实记为“首次不完全、二次补齐”，不回填上文表述。
- **S2 残留**：阅读组件仍有 12/20、13/20、13px 硬写；本轮按角色改引 `--font-badge`/`--font-meta`（计算值不变），另把布局对齐行高（24px）、预览/夹具/调试层与 `line-height: 1.7` 的比例行高、管理输入字号逐条登记为例外，不写“全已收口”。
- **配对返回控件**：`‹ 评论详情` 的 `aria-label` 改为“评论详情，返回动态详情”，先写公开可观察的 Label-in-Name 失败用例再改模板；返回行为与会话返回排序/页码未变。
- **`replyReadState()`**：核实 `useReplyPage` 只整对象替换、从不原地修改，删除该恒等复制助手，卸载快照直接 `read: state.value`，别名注释改为“同一份定义＋为什么可直接持有引用”。
- **最终候选**：`88b692f`（干净工作树）通过 `pnpm check`（348 例）、`check:dist`、主 e2e 235、production/manage/location/delivery e2e 与后端定向 38 项；`backend` 子树与前候选相同（tree `c25b57d…`）故沿用全量 1256 passed；63 张新截图在 `evidence/final-2-screens/`（`sourceCommit=88b692f`、`sourceStatus=[]`），与首次 `final-screens` 对照为 56 张字节相同、7 张仅抗锯齿级、0 张可见变化，黄金图未更新。隔离 Nginx 三阶段本轮未重跑，如实记录。视觉人工签收、真机、真实飞书/上游与部署仍未验证。
