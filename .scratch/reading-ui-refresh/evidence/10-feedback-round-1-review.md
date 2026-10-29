# 10 首轮反馈整改：双轴审查逐项处置（Standards + Spec）

本文件记录首轮代码审查（Standards 轴与 Spec 轴）每一确认缺陷与判断项的处置、依据与红绿，
**不是**视觉签收、真机验收、黄金图更新或部署结论。两份审查报告的原文副本保存在
[`10-feedback-round-1/round1-standards-review.md`](10-feedback-round-1/round1-standards-review.md) 与
[`10-feedback-round-1/round1-spec-review.md`](10-feedback-round-1/round1-spec-review.md)，
下列编号（S1、J1–J8、Spec 1–6）直接对应那两份报告的章节号。

## 0. 范围与版本

| 项 | 值 |
| --- | --- |
| 审查对象（sourceSHA） | `093b40d0b8aca9219f410fa3884fd441288d03ee`；两轴区间均为 `7ebf5aa…093b40d` |
| 整改分支 | `wt/reading-ui-refresh-review`（本地，未 push） |
| 整改提交 | `c85d35b` 阅读定位收敛（J1/J2/J3）、`64a6e28` 会话未显示即离开不记账（J7）、`a6d5c09` 注释/乱码/README 对齐（S1、J5、Spec 1）、`c04ff76` 合入集成 tip、本文件所在提交记录证据 |
| 集成 tip | 完成前合入 `spec/reading-ui-refresh` @ `e233fcf`（J6 由主线程在 `16f5c35`/`e233fcf` 统一更新正式设计、规格、索引与票 10 状态；本分支只合入，不改正式设计/spec/索引） |
| 运行环境 | Node v24.21.0 / pnpm 10.34.6；Playwright 自带 Linux Chromium；location 集成端口 4178/4325 |
| 未触碰 | 主 e2e 4318、旧 4337/4339/4180、8000/4273、另一 verifier 的 4330/4331/4332 与 production/delivery 端口；未更新黄金图、未合 `main`、未部署、未代签人工通过 |

跑 Playwright 前要先摘掉本机代理环境：`HTTP_PROXY`/`HTTPS_PROXY` 指向 `127.0.0.1:12000` 时，
Playwright 的 webServer 探活会经代理拿到 400 而误判“端口已被占用”，实测跑法见 §4。

## 1. 确认缺陷（2 项，均已修复）

### S1 `layout.spec.ts` 注释编码损坏（Standards S1 / Spec 2）— 修复

原文“有 `` `::before` `` 看它，没有<U+FFFD><U+FFFD><U+FFFD>退回 wrapper 自身的底色”里有三个 U+FFFD，
由 `d81779b` 引入，全 diff 仅此一处。已还原为“没有 `` `::before` `` 时退回 wrapper 自身的底色”。
验证：修复后 `grep -rl $'\xef\xbf\xbd' frontend/src frontend/tests` 无命中，范围仅为这两个源码/测试目录，并非全仓。两份审查原文副本故意保留原始坏行，另有既存部署脚本的替换字符不在本轮范围，不追改。
纯注释改动，不影响断言与运行。

### Spec 1 `frontend/README.md` 会话契约过时 — 修复

原文仍写新只读资源 `GET .../replies/{reply_id}/conversation?page&limit=10` “提供整段可确认对话”，
与三处实现/文档冲突：`archiveReader.ts` 的会话读取不带查询串且出现 `page` 键即判 `error`；
`docs/backend/api/archive-api.md` 缺省即整段、整段响应无 `page` 键；客户端契约同口径。
票 13 的交付清单本就包含“相关 API 文档/前端 README”，本轮漏改这一处。现在写明：不带查询参数、
一次读完整个本地可确认集合，显式 `?page=N&limit=10` 只为冻结的旧预览产物保留兼容、本轮 UI 不使用。

## 2. 判断项（逐项“修复”或“保留及依据”）

### J1 重复交互注册 — 修复

`restoreReadingPosition` 与 `centerReadingAnchor` 曾各自复制同一套“wheel/touchmove/pointerdown + 翻页键
⇒ 停止定位”的注册与逐条注销。现共用同文件内的 `interruptOnUserAction(interrupt)`，两处都只保留
`const release = …` 与返回时 `stop(); release();`。没有新增模块或参数开关。

`onUserScroll` 保持自己的更窄事件集，**不**并入：它的三处调用
（`useLocateTarget`、`ListVisit` 的卡片评论区、`CommentSection` 的排序让位）是“待落下的定位/排序落点”
的让位窗口，单纯按下并不改变阅读位置，若并入则任何点击都会打断尚未落点的定位——那是行为变更，
既无需求支撑也不在本次审查的诉求内。注释已写明这处差异的理由。

验证：`pnpm check` 351 例、`pnpm test:e2e:location` 17 例全绿（后者用真实导航与真实 API 覆盖
“居中/恢复/用户滚动让位”三条路径）。

### J2 无需求抽象两处 — 修复

- `centerReadingAnchor` 的 `options: { gap?: number }`：全仓无调用方传 `gap`（唯一调用点是
  `ConversationPage.vue` 的三参调用），删掉参数，留 `const gap = 8;`，函数注释从“留白（`gap`）”改为“（8px）”。
- `measure()` 返回的 `maximum`：只在该函数内参与算 `tail`，`locate` 只读 `top/lead/tail`，
  从返回类型与返回对象里去掉（内部变量保留，`tail` 仍靠它算）。

行为不变：既有“居中 146 / 首条补 162 停 8 / 短会话尾留白 222”断言全部原样通过。

### J3 首尾留白类型重复 — 修复

`CenterPadding` 从 `readingPosition.ts` 移到 `snapshots.ts`：`ConversationRead.padding` 本就是同一形状，
现直接复用该类型；`ConversationPage.vue` 的 `ref({lead, tail})` 标注为 `ref<CenterPadding>`。
方向不变因而不成环：`readingPosition` 原本就从 `snapshots` 取 `ReadingPosition` 类型，反向 import 才会成环。
没有新增文件或层。

### J4 两处测试几何辅助重复 — 保留，依据如下

`layout.spec.ts:formFrames` 与 `manage.spec.ts:visibleHeight` 都按 `::before` 的 content/top/bottom 推算可见高度，
但不适合合并：

- 两者分别位于 visual 与主 e2e 的 `page.evaluate` 闭包，直接共享模块闭包变量不可行；可以提取不依赖模块外变量的可序列化纯函数再传给 `page.evaluate`，技术上并非不能共享。
- 本轮选择不为约 6 行 inset 计算新增跨项目公共模块；这是一项按当前收益作出的保留判断，不是工具能力限制。
- 两个版本返回的字段也不同（一个带 `border/background` 供四态框色断言，另一个带 `hit` 与文字中心），
  合并会同时改掉两边断言的粒度。

结论：保留两份，不给审查凑抽象；若将来第三个调用点出现再评估。

### J5 注释与覆盖不符 — 修复

`manage.css` 两处：“把图的可见描边”改为“把框的可见描边”；“layout.spec.ts（四宽度可见等高、命中 ≥43、
四态框色）”改为“（四宽度可见等高、命中 ≥43；390px 四态框色）”——四态框色确实只在 390px 一条用例里跑
（`layout.spec.ts` 的管理输入框用例），四宽度覆盖的是可见等高与命中盒。

### J6 文档/票据状态不一致 — 主线程统一处理，本分支不改

正式设计、实施规格、`docs/README.md` 与票 10 状态由主线程在 `16f5c35`、`e233fcf` 统一更新为
“12/13 已实现并通过范围自动化、组合候选审查中、人工待复验”。本分支在完成前合入该 tip，
但没有改正式设计/spec/索引，也没有改动旧证据文件。

### J7 会话未显示内容也被记成“已居中过” — 修复（红先绿后，见 §3）

`ConversationPage.vue` 的 `onBeforeUnmount` 曾无条件 `saveConversationRead`：加载中、读取失败或
“不存在”就离开也会写一份空位置（没有锚点，`pixelY` 是当时的滚动量）。此后按历史前进回到同一次访问，
`restored` 为真 ⇒ 走位置恢复而不是居中，于是这次虽然读到了整段，入口回复不再居中、“刚才查看”可能落在视口外，
与 `navigation.ts` 里“只有已经显示过（并居中或恢复过位置）的访问才有”的注释不符。

修复：只在首屏结果真的显示过、且内容仍在页面上时保存 —— `if (!settled || !state.value.data) return;`。
`settled` 表示一次性落点已发生（成功首屏渲染后置位），`state.data` 非空表示内容此刻仍在页面上
（重试后转失败就不再保存）。用户取消自动定位后 `settled` 仍为真，其实际阅读位置照常保存；
短会话补的首尾留白也与位置一起保存，历史还原行为不变。

### J8 提交正文像测试清单 — 保留历史，后续不再堆

`d81779b`/`fb4bfe5` 的正文不回写（不改写历史）。本分支三个整改提交的正文只写做了什么、波及哪里、
为什么这样判断，不列 `pnpm check`/`check:dist` 计数或命令清单；验证数字只放在本证据里。
提交序列里保留一个集成 tip 的 merge 提交，按仓库既有习惯不压平。

## 3. J7 红 → 绿

反馈轮回合（同一测试，`frontend/` 下）：

```bash
pnpm vitest run tests/unit/conversation-navigation.test.ts -t '会话内容还没显示就离开'
```

红（修复前，loading 分支）：
`AssertionError: expected 300 to be 146 // Object.is equality` —— 断言位置在
`conversation-navigation.test.ts` 的 `await waitFor(() => expect(layout.scrollY()).toBe(146))`。
300 是离开前“还没有内容”时的滚动量，146 是入口回复（列表第 2 条）在排版替身里的居中位置，
即 bug 的用户可见症状：前进回来既不居中、又落回无内容处。

红（同一缺陷的 error 分支，单独确认）：把修复那一行临时注掉、并把迭代改成只跑 `'error'`，
同一断言同样 `expected 300 to be 146`；随后还原代码与测试，未留在提交里。

绿（修复后）：`Tests 11 passed (11)`，同文件内两条既有回归同时通过——
“同一会话访问返回时恢复上次阅读位置，不重复居中也不抢用户滚动”（600）与
“短会话末条居中的留白随历史恢复一起还原，不被最大滚动夹回”（留白 222、位置 120）。

测试怎么构造边界（`conversation-navigation.test.ts` 新增用例）：

1. 手机视图下从楼中楼页点真实的「查看对话」进入（真实来源 ⇒ 离开时是真实 `router.back()`，前进才有同一历史记录）；
2. 首次会话读取分别停在“加载中”与“读取失败”：断言只有加载/失败提示、**没有** `对话内容` 列表；
3. 页面已滚到 300（代表无内容时的位置）后点 `‹ 会话列表` 离开；
4. `router.go(1)` 历史前进回同一访问，这次读取成功 ⇒ 必须重新居中找到 146。

真实 API + 真实导航的对照回归：`pnpm test:e2e:location` 的 17 例全绿，其中
“短会话末条居中：留白撑开的范围随历史前进一起还原，不被夹回页首”与
“手机普通回复页：整段会话一次呈现、入口回复居中并唯一标记‘刚才查看’”
覆盖首尾留白的历史还原与入口居中未被本次改动影响。

## 4. 本轮验证与结果

| 命令（`frontend/` 下） | 结果 |
| --- | --- |
| `pnpm check`（typecheck + vitest + e2e 项目声明） | 32 文件 / 351 例通过（稍后合入集成 tip 后复跑仍 351 通过） |
| `pnpm check:dist`（build + build:mock + 产物隔离） | 两次构建通过，隔离检查通过（dist 无 mock 入口/夹具，dist-mock 含自检页） |
| `env -u HTTP_PROXY -u HTTPS_PROXY NO_PROXY=127.0.0.1,localhost pnpm test:e2e:location` | 17 例通过（comment-location / conversation / integrated-reading / reply-location / reply-sort），端口 4178/4325 |
| `grep -rl $'\xef\xbf\xbd' frontend/src frontend/tests` | 无命中（S1 已还原） |

未跑、也不构成本轮结论：主 e2e（4318）、production/delivery e2e、visual 黄金图比较与截图
（S1/J5 是纯注释改动，未更新黄金图）、后端全量（本轮无后端/adapter 改动）。

## 5. 保留项与已知限度

- **J4 保留**（依据见 §2）；**Spec 6 保留期**：库的 `.el-form-item.is-error … .el-input__wrapper`
  未被 `::before` 接管，但当前管理表单没有 `:rules`/`validate`，全仓 `src/` 也搜不到 `is-error`，
  该态不可达；补接管属于为将来需求预埋，本轮不做，等真的加校验时随需求一起处理。
- 两份报告里“明确未发现问题”的部分（后端整段契约、adapter 拒绝 `page` 键与条数不符、库样式覆盖登记、
  token 登记、提交格式）本轮未再改动，也未重新举证。
- 未验证项沿用前票与本轮限度：真机 / iPhone Safari 的输入聚焦失焦、视觉人工签收、黄金图、
  目标机部署与真实上游；本分支未 push、未合 `main`、未代签任何人工结论。
