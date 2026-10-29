# 02 一级评论默认按时间与单按钮排序：实施证据

Status: resolved
依据：[实施规格](../spec.md)、[正式设计](../../../docs/design/reading-ui-refresh.md) §4／§6、[票据](02-root-comment-sort-toggle.md)。
本票只证明前端读取行为与受控浏览器结果；不含真机、正式视觉签收与部署。

## 1. 交付范围

| 行为 | 实现位置 | 说明 |
| --- | --- | --- |
| 新访问显式按时间 | `frontend/src/app/snapshots.ts`、`frontend/src/data/archiveReader.ts`（未改） | `emptyCommentSnapshot()` 默认 `latest`；生产 Adapter 一直显式下发 `sort`，不存在省略参数的请求 |
| 快照恢复原排序 | `frontend/src/app/snapshots.ts`、`frontend/src/dynamics/CommentSection.vue` | 历史返回用快照里的 `sort`，不拿默认值覆盖用户选择 |
| 单按钮只显示当前排序 | `frontend/src/dynamics/CommentSection.vue` | 文字 `☰ 按时间`／`☰ 按热度`，可访问名 `当前按时间，点击切换为按热度`（与原型一致）；点击切到另一种 |
| 排版与触控 | 同上（scoped CSS） | 排序 13／20、点击区 44px、最小宽度 80px；“评论 N”14／22、字重 500，小于动态正文 16px |
| 切换复位与定位 | `CommentSection.vue` | 切换重置首批、正文展开与回复展开（列表整体重挂载），再定位评论区；旧排序迟到结果不入新选择 |
| 定位带当前排序 | `useCommentsRead.ts`（原有语义）＋ `CommentSection.vue` | 根评论定位读取与普通分页都取当前 `sort`；精确入口切换排序后按新排序重新定位同一目标 |
| 区域身份 | `CommentSection.vue`、`CommentList.vue`、`useCommentsRead.ts`、`snapshots.ts` | `regionId` 显式传入并写入 `data-comment-region`；快照带 `regionId`，标着别的区域时不采纳；无全局排序、无固定 DOM id |
| 服务端 hot 默认兼容 | 未改后端 | 省略 `sort` 仍为 `hot`；新增回归测试锁住该兼容与 cursor 资源隔离 |

未改：后端排序与分页实现、`DetailVisit.vue`、`theme.css`、回复读取链、`CommentThreadPage.vue`（05 的排序控件与 06 的会话入口不在本票）。

## 2. 契约与测试决定

- 排序规则（置顶优先→热度/时间→ID）与 20 条一批由既有服务端实现；本票只改客户端默认与控件，另加后端兼容回归。
- 新前端测试落在既有入口：`tests/unit/comment-region-snapshot.test.ts`（新增纯快照身份规则）、`comment-reading.test.ts`、`comment-images.test.ts`、`reply-reading.test.ts`、生产 Adapter＋HTTP 替身 `tests/e2e/comments.spec.ts`／`comment-location.spec.ts`／`locate-return*.spec.ts`、实际 API＋隔离 SQLite `tests/e2e-location/comment-location.spec.ts`。
- 只改受影响断言，不重写无关用例；`sortOption`（双选项单选组）替换为 `commentSort(region, current)` 与 `switchCommentSort(region)` 两个按可访问名定位的 helper。

## 3. 命令与结果（本工作树）

| 命令 | 结果 |
| --- | --- |
| `cd frontend && pnpm check` | 通过：`vue-tsc` 无错；vitest 26 文件 / 299 passed；e2e 项目声明守卫一致 |
| `cd frontend && pnpm check:dist` | 通过：生产与 mock 两次构建 + `check:isolation`（dist 无 mock 入口/夹具，dist-mock 有） |
| `UV_PROJECT_ENVIRONMENT=<主工作树>/.venv uv run --no-sync pytest backend/tests/test_root_comments.py backend/tests/test_root_comment_location.py -q` | 29 passed（含新增 `test_omitted_sort_stays_hot_for_clients_that_do_not_send_it`） |
| `NO_PROXY=127.0.0.1,localhost pnpm test:e2e` | 209 passed、10 skipped、**2 failed**；失败均为 `tests/e2e/app-shell.spec.ts` 的“UP 列表”链接严格模式冲突，与本票无关（见 §5） |
| `UV_PROJECT_ENVIRONMENT=<主工作树>/.venv NO_PROXY=127.0.0.1,localhost pnpm test:e2e:location` | 4 passed（实际归档 API＋本次运行独占 SQLite，页面默认 latest 的定位与普通读取都对得上真实契约） |

端口窗口：主 e2e 使用硬编码 4318/4319/4320，开跑前探测到其它运行占用（20:42），等其结束后于 20:46:25 独占开跑并跑完；`test:e2e:location` 使用 4178/4325，20:51:51 探测空闲后串行执行。未触碰 8000／4273。

## 4. 验收条件逐项

| 票据条件 | 证据 |
| --- | --- |
| 无快照新访问显式读 latest；有快照恢复；服务端省略 sort 的 hot 默认不破 | 单元 `comment-reading.test.ts`“无会话新访问的详情默认按时间…”与“历史返回恢复排序…”、`comment-region-snapshot.test.ts`；浏览器 `comments.spec.ts` 首批请求 `sort=latest`、`comment-location.spec.ts` 定位请求 `sort=latest`；后端新回归测试同时锁 hot 默认与 cursor 资源隔离 |
| 控件只显示当前排序、13px、≥44px 点击区；“评论 N”14px 小于正文 | 浏览器 `comments.spec.ts`“排序是显示当前排序的单按钮…”（`getComputedStyle` 13px、box ≥44、h2 与按钮 14px < 正文 16px、无 radiogroup） |
| 置顶优先、完整集合排序后每批 20、次级/缺失/ID 规则不变 | 后端 `test_complete_sort_then_20_20_5_frozen_pages_survive_updates_and_reopen`（hot/latest 参数化）与 `test_omitted_sort_stays_hot...`；前端不重排服务端顺序（`comments.spec.ts` 首批与置顶断言、单元置顶用例） |
| 切换复位首批与文字/回复展开状态并定位评论区；加载中/失败重试/快速切换不混旧批 | 单元“切换排序重置为目标排序首批”“单按钮每次点击都切到另一种排序”“快速切换排序时旧排序迟到的 success/error/reject”“切换排序重置回复展开状态…”；浏览器 `comments.spec.ts` 折叠/展开复位与迟到响应隔离、`locate-return.spec.ts` 两个受控延迟场景 |
| 根评论精确定位显式传当前排序；通知定位仍落到目标 | 单元“根评论精确定位显式传入当前排序：切换后按新排序重新定位同一目标”；浏览器 `comment-location.spec.ts` 定位期间切换排序（`['latest','hot']`）、`locate-return*.spec.ts`、实际 API `tests/e2e-location/comment-location.spec.ts`（目标落在第二批、刷新与窄屏直达） |
| 读取与交互状态由显式区域身份隔离；详情入口直接可用；无唯一全局排序/固定 DOM ID | `CommentSection` 的 `regionId`（详情默认 `detail:{dynamicId}`）＋`data-comment-region`；快照 `regionId` + `adoptCommentSnapshot` 纯函数用例（异区域不采纳）；`CommentList`/`useCommentsRead` 透传身份，诊断带区域；浏览器断言 `data-comment-region="detail:1001"` |
| 生产 Adapter 与受控浏览器证明请求参数/返回内容/延迟隔离 | `comments.spec.ts`、`comment-location.spec.ts`、`locate-return*.spec.ts` 均跑生产装配＋HTTP 替身，直接观察 `sort`／`cursor`／定位返回值；实际 API＋隔离 SQLite 另证契约一致性 |
| 保留分页、评论图片、折叠、只读点赞与错误边界 | 既有用例原样通过：`comment-reading.test.ts`（分页/失败重试/失效 cursor/去重/未归档）、`comment-images.test.ts` 与 `tests/e2e/comment-images.spec.ts`（评论图片与预览历史）、`reply-reading.test.ts` |

## 5. 已知限制与未验证

- **既有失败（非本票引入）**：`tests/e2e/app-shell.spec.ts:29` 的 `getByRole('link', { name: 'UP 列表' })` 同时匹配 `UpVisit` 的“返回 UP 列表”，严格模式冲突在桌面与 Pixel 7 项目各失败一次。已在未修改的集成 tip（`eca658b`）独立工作树复现（`--project=desktop-chromium tests/e2e/app-shell.spec.ts` → 1 failed / 2 passed），本票未改该用例与相关组件，留给对应票或单独修复。
- **视觉黄金图将出现预期差异**：评论区标题 17→14px、排序控件由单选组改为单按钮。按规格与 09/10 票约定，本票**未**运行 `pnpm visual:golden`、未更新 `tests/visual-baseline/`；候选截图与人工签收属 09／10。
- 未做真机（iPhone Safari）与部署验证；真实上游未访问（读取只读本地归档）。
- 区域身份目前只有详情入口一个实际实例；列表内多区域挂载由 03 承接，本票只保证挂载方可用显式身份隔离状态，不提前把半成品评论挂到列表。
- “更早评论”（`prevCursor`）在切换排序后随首批重置而丢弃，属既有语义，本票未扩展。

## 6. 共享接口要点（给 03／05）

- `CommentSection` props 新增可选 `regionId`（不传时 `detail:{dynamicId}`）；`data-comment-region` 暴露身份。
- `CommentSnapshot` 新增可选 `regionId`；容器可用 `adoptCommentSnapshot(snapshot, regionId)` 决定采纳或退回默认，避免多区域共用容器时串状态。
- `emptyCommentSnapshot(sort = 'latest')`：新区域默认按时间；显式恢复时用快照 sort。
- `CommentList` / `useCommentsRead` 需要 `regionId`（读取与交互状态的键，也进开发期失败诊断）。
- 排序控件 helper：`tests/e2e/support.ts` 的 `commentSort(region, 'latest' | 'hot')`、`switchCommentSort(region)`；05 的回复排序控件应保持同一文字/可访问名形状，便于共用断言。
