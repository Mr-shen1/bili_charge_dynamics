# 06 宽屏回复预览与实时页码证据

- 对应票据：[06: 宽屏预览回复并按实时页码阅读](../issues/06-wide-screen-live-replies.md)
- 对应规格：[前端重构实施规格](../spec.md) 实施决策 9、10、11、12、14、15、32–35 与「必须覆盖的场景」中的回复/实时页码条目；[代码基线与文档差异](../baseline-differences.md) 第 13–17、25–31 项
- 实现位置：`frontend/src/dynamics/`（ReplySection、ReplyPager、useReplyPreview、useReplyPage、replyPaging、replyText、CommentItem 内的回复区挂载）、`frontend/src/app/`（snapshots 的 `ReplySnapshot`、useCompactViewport）、`frontend/src/mock/archiveReader.ts`
- 证据状态：**Linux Chromium 自动化通过（Desktop Chrome 生产装配项目 replies.spec.ts 3 例）；真实 API/SQLite、iPhone Safari、新版视觉签收未在本票执行。窄屏回复入口按票据 07 边界未交付。**

## 1. 本票交付

| 区域 | 内容 |
| --- | --- |
| 预览 | 宽屏内联回复区用 cursor 模式首批最多 3 条（`limit=3`），只读这一批，不累计追加 |
| 展开 | 展开走互斥的 `page` 模式，固定 `limit=10`，请求带 `cache:'no-store'`；每次展开都重读第 1 页 |
| 页内替换 | 25 条本地回复按 10/10/5 替换当前页，不累积累加；同页重读也发真实请求，不使用页缓存 |
| 末页 | 页数只由本地 `count`/`localReplyCount` 计算（最少 1 页），`nextCursor` 恒为 null 也不当作"没有其他页"；数据缩减导致越界时说清楚空页后按最新总数重读有效末页 |
| 收起 | 取消在途页码请求，DOM 收起后把所属根评论定位到开头，快照记 `expanded=false` 与 `page=1`；再次展开重新首读第 1 页 |
| 详情恢复 | `CommentSnapshot.replies` 按根评论 ID 保存预览结果、`expanded`、`page` 与回复正文展开；历史返回时已展开的回复区按保存页码**实时重读**，不复用冻结页 |
| 空态区分 | 本地零条不被解释成来源没有回复：`repliesLastAttempt` 为 `pending`/`failed`/`unconfirmed` 时分别提示「回复尚未完成归档。」「回复最近归档失败。」「回复归档尚未确认完成。」，只有确认成功才是「暂无回复」（不恢复整块归档统计面板） |
| 文案与身份 | 时间正序沿用服务端顺序；作者身份与 UP 标识按 ID；仅嵌套回复且目标昵称可用时显示「回复 X:」，渲染时剥离来源自带的 `回复 @某人:` 前缀，不伪造缺失目标 |
| 折叠 | 回复正文沿用 `FoldableText`（`subject='回复正文'`），按实际超过 6 行才出现展开入口；`FoldableText` 新增可选 `prefix` 插槽承载目标文案 |
| 失败隔离 | 每个回复区独立请求身份：失败/取消只影响该区域并保留已有内容，可重试；根评论列表与其它回复区不受影响 |
| 错误映射 | 生产 Adapter 只把 `422 CURSOR_INVALID` 映射为 `invalid-cursor`（提示「回复读取标记无效，请重新开始读取。」并可重新开始）；`404`、`422 INVALID_INPUT` 等为普通可重试 error；取消前后都优先 |
| 迟到隔离 | 收起取消、切换排序重挂载、切换访问（离开详情）后，忽略取消的成功/失败/异常回调都不改写新视图 |
| 能力位 | `reader.replies === 'not-archived'` 时整块提示「回复尚未归档。」且不发请求；一级评论来源回复数为 0 不建回复区，未知（null）仍读本地归档 |
| mock 装配 | 首个一级评论 25 条回复夹具（10/10/5、嵌套目标、UP 作者、缺时间兜底、7 行折叠边界）；mock 读取器实现与生产一致的 cursor/页码校验与 `count`/`root` 返回 |

窄屏（≤640px）回复预览与独立楼中楼路由页不在本票：由票据 07 交付。`CommentSection` 已按 `useCompactViewport()`（640px，无法判定按宽屏）分出宽窄分支，窄屏当前不渲染内联回复区，07 在该分支接入 UP 预览与独立页。

## 2. 关键规则与实现位置

| 规则 | 位置 | 说明 |
| --- | --- | --- |
| 预览只读首批 | `useReplyPreview.ts` | 已有预览结果时不再追加 cursor；失败保留原结果，重试沿用同一请求 |
| 页码只为正安全整数 | `useReplyPage.ts` | `Number.isSafeInteger(page) && page >= 1` 才发请求；Adapter 侧同样在传输前拒绝非法页码、混用 cursor 与错误批量 |
| 每次展开首读第 1 页 | `ReplySection.vue` 的 `expand()` | 展开即 `live.loadPage(1)`，不恢复任何缓存页 |
| 越界重读末页 | `useReplyPage.ts` | 成功响应按 `count ?? localReplyCount ?? items.length` 得到末页，`page > lastPage` 时改为真实读取末页 |
| 收起 | `ReplySection.vue` 的 `collapse()` | `live.cancel()` → 收起 → `nextTick` 后 `closest('[data-reading-id^="comment:"]').scrollIntoView({block:'start'})`；快照页码记 1 |
| 快照结构 | `app/snapshots.ts` 的 `ReplySnapshot`/`CommentSnapshot.replies` | `emptyCommentSnapshot()` 一并清空 `replies`，排序切换与重新开始读取自然重置回复展开状态 |
| 快照写出 | `CommentItem.vue` → `CommentList.vue` → `CommentSection.vue` → `DetailVisit.vue` | 回复区任何状态变化都发布到详情访问快照，卸载时按 `pageEntryId` 保存 |
| 宽窄分支 | `app/useCompactViewport.ts`（自 `preview/` 迁入） | 阈值 640px，`window.matchMedia` 缺失时按宽屏；`CommentSection` 单点订阅后向下传递 |
| 输出文案 | `replyText.ts` | 只剥离开头 `回复 @某人:` 形态的重复前缀，不改数据、不猜缺失目标 |
| 分页窗口 | `replyPaging.ts` + `ReplyPager.vue` | 宽屏保留当前页前后各两页与首尾页，窄屏精简窗口（供 07 复用） |

## 3. 自动化结果

在 `frontend/` 下执行（Linux CachyOS、Node 24.21.0、pnpm 10.34.6、Vue 3.5.44、Playwright 1.58.2，Chromium headless）。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（`vue-tsc` 覆盖 `.vue` 模板与 TS） |
| `pnpm test` | **117 passed**：新增 `reply-reading` 15、`archive-reader-replies` 7、`reply-paging` 4、`reply-text` 2，既有 89 |
| `pnpm test:e2e` | **129 passed / 10 skipped**；新增 `replies.spec.ts` 3 例仅在生产装配的桌面项目运行，窄屏项目与 mock 项目显式排除；跳过项仍为需要触摸环境的图片手势用例 |
| `pnpm test:e2e:production` | 3 passed / 3 skipped（生产六路由、404、无自检入口、fault 装配） |
| `pnpm build` / `pnpm build:mock` / `pnpm check:isolation` / `pnpm check:data-parity` | 均通过；`dist` 不含 mock 回复夹具，数据层副本与根 `src/data` 一致 |

新增/改写的自动化覆盖：

- `tests/unit/reply-reading.test.ts`（13 例）：宽屏 3 条 cursor 预览与展开入口（回复数 0 不建区、不请求）、展开 `page=1&limit=10` 与 10/10/5 页内替换、同页重读发真实请求、收起取消在途请求并定位根评论开头且再次展开首读、历史恢复 expanded/page 并按保存页实时重读（同页内容变化可观察）、越界页重读有效末页、单区失败与重试、仅 `CURSOR_INVALID` 可重新开始、翻页失败保留当前页并可重试、嵌套目标文案与来源前缀剥离、页码在途时禁用连点、切换排序重置并丢弃旧页码迟到结果、离开详情取消在途请求且新访问不继承展开、能力位与未知计数、收起后迟到失败/异常结果不改写预览态、本地零条与未完成/失败/未确认归档的区分。
- `tests/unit/archive-reader-replies.test.ts`（7 例）：cursor 预览 URL 与不加缓存参数、页码模式 `page&limit=10` + `cache:'no-store'` + `count`/`root` 映射、越界空页是成功、错误码映射（`CURSOR_INVALID`/`404`/`422 INVALID_INPUT`/`503`）、页码响应结构校验、非法入参不进 HTTP、DTO 映射与取消优先。
- `tests/unit/reply-paging.test.ts`（4 例）：每页 10 条、末页只由本地总数决定、宽屏与窄屏页码窗口。
- `tests/unit/reply-text.test.ts`（2 例）：前缀剥离与不误剥。
- `tests/e2e/replies.spec.ts`（生产装配 + HTTP 传输替身，桌面 3 例）：预览 3 条 → 展开 10/10/5 → 收起后根评论顶到视口 0px → 再展开重新读第 1 页；详情历史返回恢复页码 2 并在归档变化后实时重读、恢复正文展开状态；7 行折叠与 6 行不折叠，1280/1024/768 三宽度无页面横溢。

## 4. 实施中确认的边界

1. **窄屏不渲染内联回复**：`CommentSection` 已按 640px 分支，但窄屏 UP 预览与独立楼中楼页由 07 交付；因此 `replies.spec.ts` 只跑桌面项目，并在配置中显式从 mock/窄屏项目排除，避免把"窄屏无回复区"当成 06 的验收结论。
2. **`nextCursor` 不参与末页判断**：页码模式每页 `next_cursor` 恒为 null，分页只按 `count`/`localReplyCount` 计算，浏览器用例在每页 `next_cursor:null` 的数据下仍显示 3 页。
3. **未知来源回复数**：一级评论 `replyCount === null` 仍读取本地归档回复（避免把未知当零）；只有明确的 0 才不建回复区。可展开只由预览批次的 `nextCursor` 决定，不用来源回复数推断本地页数。
4. **折叠与文字状态**：jsdom 无排版，6 行折叠与 `expandedTexts` 只由真实浏览器用例断言；历史恢复的文字状态通过"恢复后回到第 1 页仍显示收起按钮"验证。

## 5. 未验证与边界

- **真实 API + 隔离 SQLite**：本票页面与 e2e 使用 HTTP 传输替身 / mock 受控归档；真实协议贯通留给集成回归（13）。
- **iPhone Safari 与正式设备**：只在 Linux Chromium 桌面验证；正式设备结论留待 15。
- **新版视觉签收**：回复区样式（左侧竖线、紧凑身份行、分页器）未由用户确认，不作为视觉回归基准（14）。
- **窄屏回复与独立楼中楼**：由 07 交付，本票不声称已覆盖窄屏预览、`up_reply` 入口与独立页页码。
- **页间实时一致性**：只承诺"每次请求读当前归档"，不承诺跨页冻结或翻页间计数稳定（规格决策 32）。
- **长列表性能**：未构造 45 条一级评论 × 25 条回复全展开的组合压测。
