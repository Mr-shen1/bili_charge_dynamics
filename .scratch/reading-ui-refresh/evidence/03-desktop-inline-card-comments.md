# 03 桌面卡片内展开评论与独立阅读状态：实施证据

Status: resolved
依据：[实施规格](../spec.md)、[正式设计](../../../docs/design/reading-ui-refresh.md) §3.1／§4／§6、[票据](03-desktop-inline-card-comments.md)、[02 证据](02-root-comment-sort.md)。
本票只证明前端读取与受控浏览器行为；不含真机、正式视觉签收与部署。

## 1. 交付范围

| 行为 | 实现位置 | 说明 |
| --- | --- | --- |
| 宽屏卡片评论在卡片下方展开／收起 | `frontend/src/dynamics/ListVisit.vue`、`DynamicContent.vue` | 点击卡片评论按钮（气泡＋数字，计数语义未变）展开该卡片的一级评论阅读区；列表与 URL 都不跳走，再次点击收起 |
| 窄屏保持原入口 | `ListVisit.vue`、`useCompactViewport` | ≤640px 仍走 `openDetail(id, 'comments')` 站内进入详情并定位评论区；列表里不额外渲染一套内联评论 |
| 复用 02 的评论区域能力 | `CommentSection`（`regionId`）、`snapshots.ts`（`adoptCommentSnapshot`） | 卡片区域身份为 `list:{动态 ID}`，详情仍为 `detail:{动态 ID}`；没有第二套评论读取状态机 |
| 卡片状态各自独立 | `ListVisit.vue` + 既有 `useCommentsRead`／`useReplyPage` | 每张卡片一个 `CommentSection` 实例，排序、cursor 批次、正文展开、回复展开与页码天然分离 |
| 列表访问快照按卡片保存 | `frontend/src/app/snapshots.ts` | `ListSnapshot.comments?: Record<动态 ID, CommentSnapshot>`，键存在即展开；`listCommentSnapshots()` 只采纳身份匹配的状态，旧快照缺字段按未展开恢复 |
| 收起与离开的行为 | `ListVisit.vue` | 收起只停读并隐藏，再展开沿用同一面板的排序与已读批次；卸载时把仍在读取的面板记作已取消，返回后从原 cursor 继续；收起后焦点交还卡片评论入口 |
| 内部操作不导航正文 | `frontend/src/dynamics/DynamicCard.vue` | 卡片点击忽略 `[data-comment-region]` 内的目标：评论正文、评论图片、分页与文本选择都不触发正文/详情导航 |
| 无重复可访问名 | `frontend/src/dynamics/CommentSection.vue`（新增 `staticHeading`，默认 false） | 列表内联区的标题只显示“评论 N”，不再出现第二个同名“来源评论 N”按钮；详情入口行为不变 |

未改：后端与 API 契约（本票不读写新接口）、`DetailVisit.vue`、`useCommentsRead.ts`、`useReplyPage.ts`、`ReplySection.vue`、回复排序与会话（05／06）、正文新标签与手机返回（04）、管理布局（08）。

## 2. 测试决定与落点

沿用规格“测试决定”的既有边界，不新造框架：

- **单元（页面级，生产 Adapter + 传输替身）**：`frontend/tests/unit/list-card-comments.test.ts`
  展开/收起与 URL、窄屏入口、两卡片排序与回复页码独立、失败只落在本卡片、收起后迟到响应、scope 切换与返回恢复、点击评论正文不导航。
- **单元（纯快照规则）**：`frontend/tests/unit/comment-region-snapshot.test.ts`
  `listCommentSnapshots()` 只采纳本区域状态、旧快照缺字段按未展开。
- **浏览器（生产装配 + HTTP 传输替身，仍是真实 Adapter 的 DTO 映射）**：`frontend/tests/e2e/list-comments.spec.ts`
  两张卡片同时展开、独立排序与回复翻页、URL 不跳走、768/1280 无横向溢出、收起后焦点回入口、历史返回恢复、窄屏原入口。
- **既有用例更新**：`comments.spec.ts`（宽屏评论入口改列表内展开，详情区自身的历史恢复改由卡片正文进入；窄屏历史/主动入口用例只在窄屏跑）、`replies.spec.ts`（详情历史恢复同样改由卡片正文进入）、`comment-reading.test.ts`（同页详情入口改为窄屏语义）。

## 3. 命令与结果（本工作树）

实施基于集成 tip `870c7c1`（确认 `git merge-base --is-ancestor` 通过），收口前先合 06／08／05 已集成的 `spec/reading-ui-refresh`，最后一版为 `c2e4237`；合并提交见 §6，冲突为零。

| 命令 | 结果 |
| --- | --- |
| `cd frontend && pnpm check` | 通过：`vue-tsc` 无错；vitest 29 文件 / 328 passed；e2e 项目声明守卫一致 |
| `cd frontend && pnpm check:dist` | 通过：生产与 mock 两次构建 + `check:isolation`（dist 无 mock 入口／夹具，dist-mock 有） |
| `NO_PROXY=127.0.0.1,localhost pnpm test:e2e`（主 e2e，独占 4318/4319/4320） | 224 passed、15 skipped、0 failed（5.4 分钟） |
| `pnpm playwright test --project=desktop-chromium-archive tests/e2e/list-comments.spec.ts` | 2 passed、1 skipped（窄屏用例按视口跳过） |
| `pnpm playwright test --project=mobile-chromium-archive tests/e2e/list-comments.spec.ts` | 1 passed、2 skipped（宽屏用例按视口跳过） |
| `pnpm playwright test --project=desktop-chromium-archive tests/e2e/comments.spec.ts` | 7 passed、1 skipped |
| `pnpm playwright test --project=mobile-chromium-archive tests/e2e/comments.spec.ts` | 7 passed、1 skipped |
| `pnpm playwright test --project=desktop-chromium-archive tests/e2e/replies.spec.ts` | 3 passed |
| 重复稳定性：`list-comments + comments + list --repeat-each=10`（桌面 archive） | 180 passed、0 failed（修掉 §5 的既有竞态断言后） |

端口窗口：主 e2e 用硬编码 4318/4319/4320，每次开跑前用 `ss -ltn` 现查；`test:e2e:location` 的 4178/4325 是本轮 05 的窗口，本票未占用（本票不改接口，location 用例范围也不含列表宿主）；全程未触碰 8000／4273。

## 4. 验收条件逐项

| 票据条件 | 证据 |
| --- | --- |
| 气泡＋数字外观与计数语义不变；宽屏点击不跳详情、不改列表 URL，再次点击可收起；窄屏原入口不变 | 卡片评论按钮仍是 `DynamicContent` 的气泡图标＋数字（未改 DOM 与文案）；单元首例断言展开后 `router` 仍在 `/`、收起后区域消失且焦点回到该按钮；e2e 断言 `toHaveURL(/\/$/)` 与折叠后区域数；窄屏 e2e 断言进入 `/dynamics/1001` 并在列表里 `[data-comment-region]` 为 0 |
| 复用 02 的区域能力并绑定各自身份；不同卡片排序、cursor、正文展开、回复展开/页码与错误独立 | `CommentSection` 传 `regionId=list:{id}`，`data-comment-region` 在 e2e 与单元里可直接观察；单元“两张卡片同时展开时排序、批次与回复页码各自独立”逐项断言请求参数与列表条数；e2e 在真实浏览器里重复同一组断言 |
| 一级评论分页、置顶、评论图片与文本折叠可用；桌面楼中楼保留 3 条预览、展开每页 10 条替换且仍为时间正序 | 卡片内联区就是详情同一个 `CommentList`／`CommentItem`／`ReplySection`，未改造其行为；e2e 断言卡片内评论 4→6 追加、回复预览 3 条、展开后 10 条并出现分页；分页/图片/折叠的既有用例（`comment-images`、`replies`、`comment-reading`）原样通过 |
| 评论、图片、分页及文本选择均不触发正文导航；收起后焦点/位置落在卡片入口附近 | `DynamicCard` 忽略 `[data-comment-region]` 内目标；单元“评论正文与分页点击不触发动态正文导航”与 e2e 点击评论正文/标题后仍 `toHaveURL(/\/$/)`；收起后 `document.activeElement` 即该卡片评论按钮 |
| 列表加载更多、scope 切换与有效历史返回保留或恢复所属访问的卡片状态；旧快照缺字段安全按未展开 | 单元“离开列表再返回…”与“切换 scope 后不继承…”断言按访问恢复且不继承其他访问；`listCommentSnapshots()` 单测覆盖旧快照与异区状态；e2e 用真实返回恢复两张卡片并断言不重复请求 |
| 展开/收起及切换卡片、scope 时取消或隔离旧请求；某卡片失败不清空列表或其他卡片，不把旧数据当新结果 | 收起即卸载该卡片区域（`useCommentsRead` 在卸载时 abort）；单元“收起后迟到的评论响应不再显示…”“一张卡片读取失败只在自己区域提示…”分别覆盖迟到成功与失败隔离 |
| 生产 Adapter 浏览器覆盖两张卡片同时展开、独立排序与回复翻页；既有列表/详情及手机回复流程回归通过 | `tests/e2e/list-comments.spec.ts` 跑生产装配＋HTTP 传输替身，直接观察 `sort`／`cursor`／`page` 请求；`list.spec.ts`、`detail.spec.ts`、`comments.spec.ts`、`replies.spec.ts`、`thread.spec.ts` 等既有套件跑在同一轮主 e2e 里 |
| 布局与无障碍不依赖重复 DOM ID；768/1280 无横向溢出；窄屏切换时不出现额外内联入口 | 卡片区域身份只用 `data-comment-region`，无新增 DOM ID；卡片内联区标题改为静态文字，避免同一卡片两个同名按钮；e2e 在 1280 与 768 断言 `scrollWidth <= innerWidth`，收起后仅剩另一张卡片的区域；窄屏下 `[data-comment-region]` 计数为 0 |

## 5. 已知限制与未验证

- **顺手修掉的既有竞态断言（无产品行为改动）**：`tests/e2e/list.spec.ts` 的“UP 选择条…”用例把 `.up-strip` 的 `scrollLeft` 直接设到末尾后**不等测量帧**就读取长昵称高度，而 `ArchiveNavigation.measure()` 是在滚动事件后的 `requestAnimationFrame` 回调里解除 `--offscreen` 的。同一命令在本分支重复跑（`comments + list --repeat-each=10`）出现过 2/10 次读到尚未解除裁剪的 18px，集成基点 `dd81f4d` 的独立工作树 10/10 通过；该路径本票没有任何行为改动，属既有断言和机器装载之间的时序竞争。处置是把这段测量改成 `expect.poll` 等到稳定值，**断言阈值与意图不变**（仍要求完整展示、整排变高），修后 `--repeat-each=10` 与全量 e2e 均通过。该文件属 01 的阅读壳用例，若 01／09 认为应由其收口可回退这 8 行。
- **视觉黄金图将出现预期差异**：列表卡片多出可展开的评论区，卡片内标题改为静态计数。按规格与 09／10 约定，本票**未**运行 `pnpm visual:golden`、未更新 `tests/visual-baseline/`、未做四宽度全量截图；候选截图与人工签收属 09／10。
- **未验证**：真机（iPhone Safari）与部署；真实上游未访问（读取只用本机 HTTP 替身与领域夹具）。
- **不在本票**：宽屏“正文新标签”打开详情（04）、手机会话往返恢复（07）、09 的四宽度全截图与组合回归。卡片内联区的回复排序／会话入口沿用 05／06 的实现，本票未改动其语义。

## 6. 共享接口要点（给 04／05／07／09）

- `ListSnapshot.comments`（可选，按动态 ID 索引）是卡片评论的唯一落点；键存在即展开，`regionId` 必须是 `list:{动态 ID}`，否则视为未展开。
- `listCommentRegionId(dynamicId)` / `listCommentSnapshots(snapshot)` 是调用方唯一入口，不要自己拼字符串或读 DOM。
- `CommentSection` 新增可选 `staticHeading`（默认 false）：列表内联区传 true，标题只显示计数、不渲染定位按钮；详情入口保持原样。
- `DynamicContent` 暴露 `focusCommentEntry()`：收起内联评论后把焦点交还该卡片入口；04 若改正文入口的打开方式，请保留这个入口按钮本身。
- 09 组合回归需要覆盖：两张卡片同时展开 + 独立排序/翻页、窄屏入口不变、历史返回恢复、黄金图候选差异。
- **本票交付后 04 可以开始**：卡片评论按钮在宽屏已不再抢正文导航（`DynamicCard` 已忽略评论区内的所有目标），正文入口的新标签/详情页头改造不会再与列表内评论争同一个点击；04 只需保留卡片评论入口本身与 `focusCommentEntry()`。
