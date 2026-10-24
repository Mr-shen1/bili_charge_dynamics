# 07 窄屏 UP 回复预览与独立楼中楼证据

- 对应票据：[07: 窄屏通过 UP 回复预览进入独立楼中楼](../issues/07-compact-comment-thread.md)
- 对应规格：[前端重构实施规格](../spec.md) 用户故事 65–68、实施决策 9、10、12、14、32–35 与「必须覆盖的场景」中的评论/回复、导航与恢复条目；[代码基线与文档差异](../baseline-differences.md)「窄屏入口」「独立页」「折叠例外」「错误语义」各节
- 实现位置：`frontend/src/dynamics/`（`ReplyPreview.vue`、`CommentItem.vue` 的窄屏分支、`useThreadAuthor.ts`）、`frontend/src/pages/CommentThreadPage.vue`、`frontend/src/app/navigation.ts`（`openThread`/`returnFromThread`）、`frontend/src/app/readError.ts` 与各读取 composable 的 `catch`
- 证据状态：**Linux Chromium 自动化通过（Pixel 7 项目 thread.spec.ts 4 例）；真实 API/SQLite、iPhone Safari 真机、新版视觉签收未在本票执行。**

## 1. 本票交付

| 区域 | 内容 |
| --- | --- |
| 窄屏判定 | 沿用 `useCompactViewport()`：阈值仍为 640px，`window.matchMedia` 不可用时按宽屏；宽屏继续内联回复区，窄屏改为预览入口 |
| 入口条件 | 只有**来源回复数为正**才渲染预览/入口：0 与未知（`null`）都不占位；未知也不被当成「有回复」。本地 0 条但来源为正仍可进入独立页 |
| UP 摘要 | 有合法来源摘要（`up_reply`，即该动态作者在此楼最早一条回复）时先展示这一条：作者身份、UP 标识按作者 ID、`replyTo` 可用时显示「回复 X:」、正文渲染期剥离来源自带 `回复 @某人:` 前缀；无摘要只留数量入口 |
| 入口文案 | 有摘要「UP主等人 共N条回复」，无摘要「共N条回复」，N 取来源回复数 |
| 独立路由 | `/dynamics/:dynamicId/comments/:rootId` 可直达与刷新；`CommentThreadPage.vue` 取代骨架占位，导航由唯一协调器的 `openThread`/`returnFromThread` 负责 |
| 页码读取 | 每页 `page` + 固定 `limit=10`，与 cursor 互斥；Adapter 对页码模式加 `cache:'no-store'`，响应必须带 `root` 且 `next_cursor` 为 null；页内替换，不累计追加 |
| 末页与越界 | 末页只由本地 `count`/`localReplyCount` 计算（最少 1 页）；数据缩减导致越界空页时按最新总数**真实读取**有效末页；不承诺跨页冻结 |
| 页头数量 | 来源数 → 本地 `count` → 本页 `items` 数；分页只用本地数；来源与本地归档摘要都有确定数量且来源更多时，才提示「已归档 x/y，上游另有 n 条回复未返回。」（缺字段不编造差额） |
| UP 标识来源 | 根评论与每条回复的 UP 标识来自额外的一次 `readDetail`（`useThreadAuthor`），失败/取消/迟到都不阻断回复主读取，也不产生页面错误 |
| 内容展示 | 根评论与回复正文直接安全渲染，不新增 6 行折叠；该页不渲染任何图片（根评论 `media` 也不展示）；条件化目标语义与宽屏一致 |
| 返回 | 有有效详情来源时 `router.back()` 并恢复详情自己的快照（批次/展开/位置）；无来源（直达/刷新）时 `replace` 到对应动态详情；分页器「收起」与「返回评论」同一条路径 |
| 首屏例外 | 每次重新挂载（含历史前进）都从 `page=1` 与页面顶部开始；楼中楼不写自己的阅读快照（`saveDetailSnapshot` 只接受详情路径），不新增持久化历史/页码记忆 |
| 错误语义 | 缺失根在 Adapter 层就是普通可重试读取错误，不新增详情式 not-found；取消优先；只有 `422 CURSOR_INVALID` 映射 `invalid-cursor`（提示「回复读取标记无效，请重新开始读取。」并可重开第 1 页），`404`/`422 INVALID_INPUT` 等为普通错误；失效标记保留当前页已读内容，分页按钮在重开前禁用 |
| 迟到隔离 | 离开楼中楼或返回详情后，取消的成功/失败/异常回调都不改写当前页面；重新进入是新挂载 |

## 2. 关键规则与实现位置

| 规则 | 位置 | 说明 |
| --- | --- | --- |
| 窄屏入口只认正来源数 | `ReplyPreview.vue` + `CommentItem.vue` | `replyCount > 0` 才渲染；`CommentItem` 的宽屏分支仍用 `hasReplies`（`null` 也读本地归档），两套语义互不干扰 |
| 摘要选取 | 读取契约 `Comment.upReply` + `archiveReader.parseUpReply` | 来源给哪条就展示哪条；结构不完整、指向根自身时只丢弃该预览字段，不判整批坏 DTO |
| 前缀剥离与目标 | `replyText.replyBodyText` / `replyTargetNickname` | 只剥离开头 `回复 @某人:` 形态，不改数据；回复行目标统一由 `replyTargetNickname`（父级非空且不是本楼根 + 目标昵称可用）判断，宽屏与楼中楼共用一份 |
| 进入楼中楼 | `navigation.openThread` | 只有当前记录确实是动态详情时才记 `sourcePageEntryId`；按地址进入不建立来源关系 |
| 退出楼中楼 | `navigation.returnFromThread` | 来源记录的路径必须等于本次动态详情才 `back()`，否则 `replace` 对应详情；与其后的 `afterPendingPersistence` 共用防取消机制 |
| 快照隔离 | `navigation.saveDetailSnapshot` | 只接受 `/dynamics/:id` 详情路径，楼中楼路径不进入快照表，因此不存在自身的页码/位置记忆 |
| 页码读取 | `useReplyPage`（复用 06） | `initialPage=1` 时挂载即读第 1 页；`page > lastPage` 时重读末页；旧请求身份失效后迟到结果丢弃 |
| 顶部定位 | `CommentThreadPage.vue` 的 `onMounted` | 与 `history.scrollRestoration='manual'` 配合，重新挂载一律 `scrollTo(0)`；该页不参与 `useVisitPosition` |
| 读取异常保真 | `app/readError.ts` + 各 composable `catch (error)` | 生产装配静默，非生产装配用 `console.error` 记录原始异常，避免编程错误被折成 `status:'error'` 后无从定位 |

## 3. 自动化结果

在 `frontend/` 下执行（Linux、Node 24.21.0、Vue 3.5.44、Vitest 4.0.18、Playwright 1.58.2、Chromium headless）。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（`vue-tsc` 覆盖 `.vue` 模板与 TS） |
| `pnpm test` | **135 passed**：新增 `thread-reading` 9、`compact-comment-preview` 4、`read-error` 2，`archive-reader-comments` 新增 2（12 → 14），`reply-text` 新增 1（2 → 3），既有 117 |
| `pnpm check` | 通过（typecheck + 单测 + e2e 项目覆盖守卫；新 spec 声明 `mobile-chromium-archive`，同时从 mock 项目排除） |
| `pnpm test:e2e` | **133 passed / 10 skipped**；新增 `thread.spec.ts` 4 例只跑移动生产装配项目；跳过项仍为需要触摸环境的图片手势用例 |
| `pnpm test:e2e:production` | 3 passed / 3 skipped；楼中楼路由断言从骨架文案改为「返回入口存在且不再是占位」 |
| `pnpm build` / `pnpm build:mock` / `pnpm check:isolation` / `pnpm check:data-parity` | 均通过；`dist` 无 mock 入口或归档夹具，数据层副本与根 `src/data` 一致 |

新增/改写的自动化覆盖：

- `tests/unit/compact-comment-preview.test.ts`（4 例，`matchMedia` 桩）：正来源数 + 有摘要的窄屏入口（UP 标识、目标、前缀剥离、文案「UP主等人 共25条回复」、不发任何回复读取）、无摘要只有数量入口且本地 0 条仍可进入独立页（页头按来源数、正文「暂无回复」）、来源 0 与未知都不出现预览/入口、无法判定视口时回落宽屏内联回复区（`limit=3` cursor）。
- `tests/unit/thread-reading.test.ts`（9 例）：直达楼中楼只发 `page=1&limit=10`（不带 cursor）、根评论/置顶/UP 标识、`data-reading-id` 顺序、不渲染根评论图片、无折叠入口、页头与「共3页」、页头回退链与未返回差额提示、25 条按 10/10/5 翻页并越界重读末页、返回与分页器收起都退回详情且详情 40 条已读内容不重读、无来源时 `replace` 详情且回退不再进入楼中楼、仅 `CURSOR_INVALID` 可重开与普通错误重试、UP 标识辅助读取失败不阻断、成功空显示「暂无回复」且无 not-found、离开后迟到翻页结果不改写详情且重进为第 1 页。
- `tests/unit/archive-reader-comments.test.ts`（+2 例）：`up_reply` DTO 映射（身份/目标/正文/时间/点赞缺失、直接回根 `parentId=null`、缺失与显式 `null` 的区别）、摘要结构不完整或自指时不展示且不拖垮整批。
- `tests/unit/read-error.test.ts`（2 例）：非生产装配记录原始异常、生产装配不输出。
- `tests/unit/reply-text.test.ts`（+1 例）：`replyTargetNickname` 只在父级不是本楼根且目标昵称可用时给目标，宽屏与楼中楼共用。
- `tests/e2e/thread.spec.ts`（生产装配 + HTTP 传输替身，Pixel 7 4 例）：窄屏入口正/零/未知来源数与有无摘要、摘要目标与前缀、进入后 `page=1&limit=10`、顶部定位、根评论/嵌套目标/无图片/无折叠、10/10/5 翻页、返回详情保留已读与展开状态、历史前进重挂载回首屏；直达与刷新可打开、分页器收起走 `replace` 且回退不再进入楼中楼；翻页在途离开后迟到结果不污染详情、再进入仍第 1 页；七行正文与超长 URL 在 360/390/768/1280 无横向溢出。
- `tests/e2e/app-shell.spec.ts`、`tests/e2e-production/assemblies.spec.ts`：楼中楼断言从骨架标题改为真实页面的返回入口（mock 装配另断言可重试读取错误）。

## 4. 顺手项（retro-06 第 3、4 条）

1. **读取层保留异常原因**：新增 `frontend/src/app/readError.ts`，`useListRead`/`useDetailRead`/`useCommentsRead`/`useReplyPreview`/`useReplyPage` 与 `useThreadAuthor` 的 `catch` 改为 `catch (error)` 并调用 `reportReadError(area, error)`。生产装配（`assembly.kind === 'production'`）保持静默，用户侧仍只有统一的失败状态；mock/fault/dev 装配用 `console.error` 输出 `[read] <区域>读取异常` 与原异常。记录发生在请求身份/取消校验之后，被取消的读取不算异常。
   范围说明：`frontend/src/data/archiveReader.ts` 的 `catch { return … failed }` 未改——该目录是与根 `src/data` 逐字节一致的共享数据层（`pnpm check:data-parity`），不能感知 Vue 装配模式，故本次只在读取编排层（页面/composable）保留原因。
2. **交付状态收敛为单一来源**：`frontend/README.md` 新增「已交付」表（02–07），其余三处复述改为一句指针 + 证据链接——`docs/design/frontend-migration.md` 的状态行与阶段进展段、`docs/README.md` 的设计索引行与任务表行（指向 `frontend/README.md#已交付`）。历史证据内容未改写。

## 5. 未验证与边界

- **真实 API + 隔离 SQLite**：本票页面与浏览器用例使用可注入 Adapter / HTTP 传输替身；真实协议贯通仍留给集成回归（13）。
- **iPhone Safari 与正式设备**：只在 Linux Chromium 的 Pixel 7 设备配置下验证，窄屏触摸与 390/412px 真机结论留待 15。
- **新版视觉签收**：预览卡片与楼中楼样式未由用户确认，不作为视觉回归基准（14）。
- **不可达分支未扩成需求**：生产 Adapter 的页码模式要求每页返回根评论，因此「空 root 兜底文案」不实现；缺失根按普通可重试读取错误处理。
- **页间实时一致性**：只承诺每次请求读当前归档，不承诺翻页之间计数稳定。
- **楼中楼图片与折叠**：按票据保持不渲染图片、不新增折叠；评论图片仍由票据 08 交付。
