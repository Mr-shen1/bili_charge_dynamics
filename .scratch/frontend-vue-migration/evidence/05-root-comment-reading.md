# 05 一级评论阅读与排序证据

- 对应票据：[05: 阅读一级评论、切换排序并恢复讨论进度](../issues/05-root-comment-reading.md)
- 对应规格：[前端重构实施规格](../spec.md) 实施决策 5、6、9–15、25 与「必须覆盖的场景」中的评论/回复、导航与恢复条目
- 实现位置：`frontend/src/dynamics/`（CommentSection、CommentList、CommentItem、ReadOnlyLike、useCommentsRead）、`frontend/src/app/`（snapshots、navigation、readingPosition、useVisitPosition）、`frontend/src/pages/DetailPage.vue` 的 DetailVisit 装配、`frontend/src/mock/archiveReader.ts`
- 证据状态：**Linux Chromium 自动化通过（Desktop Chrome 1280×720 与 Pixel 7 412×915 两个项目；锚点用例显式 1280→390，另覆盖 360/390/768/1280 无横溢）；真实 API/SQLite、iPhone Safari、新版视觉签收未在本票执行。**

## 1. 本票交付

| 区域 | 内容 |
| --- | --- |
| 默认排序 | 无有效会话的新访问从 `hot` 开始，与后端默认排序一致；有快照的访问按快照排序恢复 |
| cursor 追加 | 一级评论每批 20 条，用 `previous.nextCursor` 追加上一批，按 ID 去重；`nextCursor === null` 是唯一结束判据，结束后不再渲染追加入口也不再请求 |
| 同批重试 | 失败/取消保留已读条目与原 cursor，重试重发同一批；请求进行中拒绝重复批次（按钮禁用 + 实例内请求身份） |
| 排序切换 | 切换排序先定位评论区，再重置为目标排序的首批；整份快照（排序、批次 cursor、文字展开）清空，列表子树整体重挂载；点击已在用的排序不重置也不请求 |
| 迟到隔离 | 每次排序视图独立拥有 `AbortController` 身份与访问活性；旧排序的迟到成功/失败/异常都丢弃，不清除新排序加载态、不写入旧条目 |
| 访问快照 | `DetailSnapshot` 增加 `comments`（排序、已读批次与 cursor、文字展开）；按 `pageEntryId` 保存，同一动态多次访问互不覆盖；历史返回恢复批次与 cursor，继续追加不重读首批 |
| 入口意图 | `detailTarget` 在导航协调器中随访问登记；评论入口写入 `comments`，卡片/阅读全文保持 `top`；历史恢复（有快照）时不消费入口意图 |
| 状态区分 | 成功空 / 未完成同步未归档 / 读取失败 / 取消 / cursor 失效 / 正文受限分别表达；标题计数优先最新检查状态的来源总数 |
| 渲染 | 作者按 ID 判 UP、来源置顶标识、只读点赞、时间与计数兜底、纯图评论不写"暂无评论内容"、安全文本；6 行折叠沿用既有 `FoldableText` |
| 裁剪 | 不恢复编辑时间、整块归档/同步状态面板、状态读取按钮或旧评论结束结语 |
| mock 装配 | 45 条一级评论夹具（两种排序、置顶、6/7 行边界、缺字段、纯图、安全文本）与确认空/未完成同步/正文受限的归档状态；mock 读取器实现与生产一致的排序与 cursor 校验 |

不渲染回复区与评论图片：分别由 06/07 与 08 交付。切换排序时"回复展开状态"的重置由评论列表子树整体重挂载覆盖（DOM 与实例一起销毁），待 06 落地回复区后由该票验证组合行为。

## 2. 关键规则与实现位置

| 规则 | 位置 | 说明 |
| --- | --- | --- |
| 排序只在服务端 | `data/archiveReader.ts` 的 `readComments`、`mock/archiveReader.ts` | 适配器不重排当前批次；mock 对完整集合排序后切批，模拟服务端语义 |
| 冻结/同批重试 | `useCommentsRead.ts` | 失败不推进 cursor；请求身份比较丢弃忽略取消的迟到结果 |
| 结束后不再请求 | `useCommentsRead.ts` / `CommentList.vue` | `nextCursor === null` 同时停止读取与渲染追加区；不显示结语 |
| 入口定位只消费一次 | `CommentSection.vue` 的 `entryPending` + `DetailVisit` 的 `entryAllowed` | 首批落下后再定位；用户主动滚动/触摸/按键后不再抢回 |
| 排序定位 | `CommentSection.vue` 的 `sortModel` setter | 立即定位；旧批次卸载导致页面高度收缩、滚动被夹紧时，新批次落下后再定位一次 |
| 访问快照 | `app/snapshots.ts` 的 `CommentSnapshot`、`emptyCommentSnapshot` | 排序 + 已读批次 + 展开；`loading/cancelled` 的恢复会继续读取，`success/error` 等用户显式操作 |
| 入口意图 | `app/navigation.ts` 的 `detailTarget`、`openDetail(id, target)` | 只存在内存访问表，不写入历史元数据；`discussions:'not-archived'` 的读取器整块显示未归档且不发请求 |
| 同一动态多访问 | `DetailPage` 的 `:key="pageEntryId"` | 每次访问独立 DetailVisit 与独立快照 |
| 位置恢复 | `app/readingPosition.ts`、`useVisitPosition` | 新增用户交互回调；评论入口定位不覆盖历史锚点恢复，历史恢复不消费入口意图 |
| 状态派生 | `CommentList.vue`、`CommentSection.vue` | `rootCommentsLastAttempt ?? work.comments` 决定成功空是否可信；标题优先 `commentSync.sourceCommentCount` |

## 3. 自动化结果

在 `frontend/` 下执行（Linux CachyOS、Node 24.21.0、pnpm 10.34.6、Vue 3.5.44、Playwright 1.58.2，Chromium headless）。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（`vue-tsc` 覆盖 `.vue` 模板与 TS） |
| `pnpm test` | **89 passed**：新增 `comment-reading` 20 + `archive-reader-comments` 12，既有 57 |
| `pnpm test:e2e` | **126 passed / 10 skipped**；其中 `comments.spec.ts` 在桌面与 Pixel 7 两个生产装配项目各 6 例通过；跳过项仍为需要触摸环境的图片手势用例 |
| `pnpm test:e2e:production` | 3 passed / 3 skipped（生产六路由、404、无自检入口、fault 装配） |
| `pnpm build` / `pnpm build:mock` / `pnpm check:isolation` / `pnpm check:data-parity` | 均通过；`dist` 不含 mock 评论夹具，数据层副本与根 `src/data` 一致 |

新增/改写的自动化覆盖：

- `tests/unit/comment-reading.test.ts`（20 例）：默认最热与置顶顺序、20/20/5 追加与结束、追加失败同 cursor 重试、重复触发只发一次、排序切换重置首批与请求序列、重复点击同排序、旧排序迟到 success/error/reject 三态、历史恢复排序/批次/锚点且继续追加、评论入口重建讨论状态、同一动态多访问隔离、成功空与未完成同步参数化、读取器声明未归档能力、失败/取消/重试、失效 cursor 重新开始、正文受限、UP 按 ID、安全文本、计数时间兜底、只读点赞、纯图与空正文提示、不渲染归档面板与编辑信息。
- `tests/unit/archive-reader-comments.test.ts`（12 例）：两种排序 20/20/5 的 URL 序列、cursor 不透明编码、DTO 映射与未知兜底、仅 `422 CURSOR_INVALID` 映射 `invalid-cursor`、其余 HTTP/DTO 错误折叠、取消优先、非法入参不进入 HTTP。
- `tests/e2e/comments.spec.ts`（桌面与 Pixel 7 各 6 例）：评论入口定位评论区顶部、45 条 20/20/5 与结束不再请求、排序切换定位并在页面高度收缩后仍对齐、实际超过 6 行才折叠且切换排序重置展开、历史恢复排序/批次/锚点（视口 1280→390 后偏移保持）、主动入口优先旧位置、延迟旧排序响应不覆盖新选择、360/390/768/1280 四宽度无页面横溢。
- `tests/support/app.ts`：把详情测试的 RouterHost/路由/`showApp` 抽成共用宿主；`detail-reading.test.ts` 改用该宿主（仅搬运，不改断言）。

## 4. 实施中发现并修正的布局问题

1. **排序切换后定位被页面收缩夹紧**：切换瞬间旧批次卸载，页面高度变短，浏览器把滚动位置夹到新的最大值，评论区顶部停在下方（实测 296px）。现在切换时立即定位，并在新批次落下后再次定位；两次都只针对评论区，不改变用户滚动后的接管规则。
2. **评论入口迟到的首批会抢用户滚动**：首批结果落下才定位；若用户在此之前滚轮/触摸/按键，`entryAllowed` 已置 false，不再拉回。
3. **连续切换排序的取消监听滞留**（code-review 发现）：每次重挂定位都注册一组用户操作监听，旧组的解除函数会被覆盖。现在共享 `app/readingPosition.ts` 的 `onUserScroll`，重挂前先解除上一组，卸载时一并解除；用户操作检测不再由组件自己拼 window 事件。
4. **未归档能力与按键判定**（code-review 发现）：`reader.discussions === 'not-archived'` 的读取器现在整块显示未归档且不发请求（含页面行为用例）；`onUserScroll` 只对翻页类按键让位，Tab/Escape 不会取消排序后的二次定位。
5. **e2e 视口证据**（code-review 发现）：评论用例原先在每个项目都强制 1280×800，Pixel 7 只是名义项目。现在桌面/Pixel 7 各自使用项目视口，显式视口变化只留在锚点用例，并新增 360/390/768/1280 无横溢断言。

## 5. 未验证与边界

- **真实 API + 隔离 SQLite**：本票页面与 e2e 使用 HTTP 传输替身 / mock 受控归档；真实协议贯通留给集成回归（13）。
- **iPhone Safari**：只在 Linux Chromium 桌面与 Pixel 7 模拟项目验证；正式设备结论留待 15。
- **新版视觉签收**：评论区样式未由用户确认，不作为视觉回归基准（14）。
- **回复与评论图片**：回复区、宽屏/窄屏回复与独立楼中楼由 06/07 交付；评论图片由 08 交付。本票只保留"纯图评论不写空正文"的占位语义与待归档数量提示。
- **回复展开状态重置**：机制上由排序切换整体重挂载覆盖，本票无回复状态可断言；06/07 需补组合验证。
- **长列表性能与图片慢布局**：未构造 45 条×长图的慢加载组合；锚点恢复只覆盖视口变化与排序收缩两类真实布局变化。四宽度只断言无页面横溢，不声称视觉排版已签收。
- **定位断言层次**：单元测试断言请求/状态与不回到旧位置，评论区顶部对齐、排序后重新对齐等真实定位只在浏览器用例断言（jsdom 无排版）。
