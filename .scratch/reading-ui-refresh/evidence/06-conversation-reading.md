# 06 证据：真实关系驱动的查看对话与完整分支阅读

票据：[06 查看对话](../issues/06-conversation-reading.md)。依据：[实施规格](../spec.md)、[正式设计](../../../docs/design/reading-ui-refresh.md)（UI-09、UI-10、UI-11 的会话展示部分、UI-15 只读边界）、[领域词汇](../../../GLOSSARY.md)。

- 实施工作树：`/tmp/reading-ui-refresh-worktrees/06`，分支 `wt/reading-ui-refresh-06`。
- 开工基线：`spec/reading-ui-refresh` tip `eca658b`（与工作树 HEAD 相同，`git log HEAD..spec/reading-ui-refresh` 为空，确认基于集成 tip 开工，无需调整）。
- 报告前合并集成 tip：`91db518`（02 一级评论默认时间与单按钮排序）与 `5d26773`（01 阅读壳/排版标尺/UP 条/文案）。见 §9。
- 环境：Node `v24.21.0`（nvm）+ pnpm `10.34.6`；Python 3.12 + uv（工作树内 `.venv`，`uv sync` 后 `uv run --no-sync`）。
- 本票独占回复读取链的写入权：`contracts.ts` 的 `ReplyBatch`/`Reply`、生产 Adapter 与 mock 的 `readReplies`/会话读取、`storage.py` 的回复读取段、`app.py` 的 replies 相关 handler、`router.ts` 与 `tests/support/app.ts` 的路由表。05（回复热度排序）在本票完成后追加 `sort`，没有提前实现任何 hot 语义；07（会话往返恢复）在本票基础上扩展。

## 1. 交付内容

| 层 | 交付 |
| --- | --- |
| 存储查询 | `storage.py` 新增 `_reply_starts`/`_reply_conversation_members`/`_reply_conversations` 与 `Store.read_conversation`；关系只取已保存的 `parent_id`，一次同根集合内算完整段，路径压缩 + 环检测，无新表、无迁移、无索引、无采集 |
| 读取契约 | 回复 `page` 响应与回复定位响应为当前页条目增加可空 `conversation:{start_id,count,incomplete}`；新增只读 `GET /api/archive/dynamics/{id}/comments/{root_id}/replies/{reply_id}/conversation?page&limit` |
| 生产 Adapter | `contracts.ts` 增 `ReplyConversation`/`ConversationBatch`/`ConversationResult`/`readConversation`；`archiveReader.ts` 严格映射投影与会话 DTO，404→`not-found`，其余失败 `error`，取消优先 |
| mock Reader | 同一语义：25 条回复带 A→B、旁支、跨页成员、缺祖先与环的关系夹具；page 模式带投影、cursor 预览不带；实现 `readConversation` |
| 入口与页面 | `CommentThreadPage.vue` 手机条目显示「查看对话」（至少两条且非起点，仅窄屏）；新 `ConversationPage.vue` + 路由 `.../replies/:replyId/conversation`；`navigation.ts` 增 `openConversation`/`returnFromConversation` |
| 测试 | 后端 `test_conversation_reading.py`（10 例）、前端 `conversation-reading.test.ts`（7 例）+ Adapter 契约 3 例、真实 API 浏览器 `tests/e2e-location/conversation.spec.ts`（4 例） |
| 正式文档 | [归档 API](../../../docs/backend/api/archive-api.md#阅读改版-06-增量回复对话投影与只读-conversation-子资源) 新增增量段并在 page 模式段补指针；[客户端契约](../../../docs/backend/api/archive-api-client.md#阅读改版-06-增量对话投影与手机会话页) 新增契约与页面行为段 |

### 定稿的 URL 与 DTO（供 05/07 引用）

- 投影：`items[i].conversation = {start_id, count, incomplete} | null`，只出现在 `replies?page=` 与 `replies/{reply_id}/location`；`cursor` 预览不带该键。
- 会话：`GET /api/archive/dynamics/{id}/comments/{root_id}/replies/{reply_id}/conversation?page=N&limit=10` →
  `{dynamic_id, root_id, reply_id, start_id, incomplete, count, page, items[≤10], next_cursor:null}`；无 `root`（一级评论只作身份校验上下文，不在会话正文重复）。
- 错误：身份不存在/父级身份不符 `404 NOT_FOUND`；非法页码/批量/未知或重复参数 `422 INVALID_INPUT`；暂时失败沿用 `503 STORAGE_UNAVAILABLE`／`500 INTERNAL_ERROR`；缺失祖先不是错误，而是 `incomplete:true` 的 200 部分结果。
- 浏览器入口：`/dynamics/:dynamicId/comments/:rootId/replies/:replyId/conversation`（路由名 `conversation`）。
- 客户端：`DynamicReader.readConversation({dynamicId,rootId,replyId,page,limit,signal})` → `ConversationResult`；`Reply.conversation?` 可选。

## 2. 关系与入口判定（实现口径）

- 父关系只认已保存的 `parent_id`：等于所属根评论 ID 表示直接回根（该条即对话起点）；父级不在本根本地集合内（缺失、跨根、跨动态、未知）在断点止步，把该条当作可确认段起点并标 `incomplete`；`parent_id` 成环时遍历在环内终止，同样标 `incomplete`。
- 成员 = 起点本身 + 所有沿父链解析到该起点的本地回复；一级评论不计入、不出现在 `items`；同名作者、相同正文前缀与 @ 文本不参与判定。
- 每条的投影从完整同根集合一次算好后映射到当前页（`count` 与当前页/排序无关），不逐条发请求、不下发整楼关系全集。
- 入口资格由界面按「`conversation` 非空且条目 ID 不等于 `start_id`」判定，并与 640px 分支组合：手机回复详情显示，桌面不新增会话入口；缺少投影（旧响应、cursor 预览）不出入口，也不按昵称或当前页猜测。

## 3. 真实 Store／SQLite＋HTTP 证据（后端）

`backend/tests/test_conversation_reading.py`：临时 SQLite 直插 25 条同楼回复（同名作者、相同正文前缀、缺时间、跨根父 ID、环、缺祖先）+ 另一根的回复；`TestClient` 走真实 `create_app`，禁止上游与凭据访问。

| 用例 | 覆盖 |
| --- | --- |
| `test_page_reads_project_the_confirmable_conversation_for_the_current_page` | 起点/分支/跨页成员共享 14 条计数；独立发言与同名作者无投影；缺祖先 `{start:9021,count:2,incomplete:true}`；环 `{start:9023,count:2,incomplete:true}` 且无界遍历不发生；跨根父 ID 不合并；缺时间条目安全后置 |
| `test_cursor_preview_keeps_its_frozen_shape_without_the_projection` | cursor 预览条目不含 `conversation` 键（不是伪造 `false`/`null`） |
| `test_location_response_carries_the_same_projection_for_its_page` | 定位响应条目与该页 `page` 响应逐项相同 |
| `test_conversation_resource_reads_the_whole_confirmable_branch_by_live_page` | 身份回显、起点、本地总数、10/4 两页、越界空页 + 实际总数、条目与 page 模式同源（除投影）、`reply_pages` 零写入 |
| `test_missing_ancestor_returns_only_the_confirmable_part_and_flags_it` | 缺祖先部分结果与跨根不拉入别楼 |
| `test_relationship_cycle_stays_bounded_and_never_fakes_a_start` | 环的两条入口返回同一有限成员、起点稳定、标不完整 |
| `test_conversation_identity_errors_are_not_found_and_queries_are_validated` | 目标不存在/根或回复跨楼跨动态 404；页 0/前导零/非数字/批量≠10/未知/重复参数 422；定位端点仍拒新参数 |
| `test_conversation_reads_do_not_write_the_archive_or_access_upstream` | 归档内容与 `reply_pages` 不变 |
| `test_archived_relations_drive_the_projection_and_the_conversation` | 真实归档链：来源 `parent_str` 经 `/api/sync/initial` 落库后，page/location/conversation 一致；`reply_to` 对根作者与父回复作者分别解析；重启后无来源仍可读 |
| `test_twenty_five_and_ten_thousand_replies_keep_the_same_query_and_response_cost` | 万条夹具的查询次数与响应规模不变性（见 §5） |

运行：`uv run --no-sync python -m pytest backend/tests/test_conversation_reading.py -q` → **10 passed**。
全量后端：合并前 `uv run --no-sync python -m pytest backend/tests -q` → **1227 passed**（票据基线 1217 + 本票 10）；合并 02 后 → **1228 passed**（+02 的服务端默认 hot 兼容用例）。

## 4. 前端与浏览器证据

单元（`pnpm check` 的一部分，`pnpm test`）：

- `tests/unit/archive-reader-replies.test.ts` 新增 3 例：页码与定位条目映射可空投影（缺失字段不推断、形状非法整页拒绝、cursor 预览为空）；会话读取只发一条 `no-store` 请求并映射身份/起点/页码；会话读取的 404/非法身份/页码或身份不符/批量与页码校验/取消优先。
- `tests/unit/conversation-reading.test.ts` 新增 7 例：mock 投影（A→B、旁支、跨页、缺祖先、独立发言、cursor 无投影）与会话读取（分页、身份回显、缺祖先、非法/不存在/取消）；会话页从第 1 页正序、只有 `‹ 会话列表`、无排序控件与重复标题、入口回复轻微标记；入口回复在后续页时不自动跳页、翻页后标记、无「收起」；缺祖先提示「部分上下文暂不可用」、暂时失败局部重试、`not-found` 与失败分开；手机条目才有「查看对话」且返回那次访问、桌面零入口；直达/刷新无来源时替换到所属回复详情。

真实 API＋隔离 SQLite 浏览器（`NO_PROXY=127.0.0.1,localhost HTTP_PROXY= HTTPS_PROXY= pnpm test:e2e:location`，端口 4178/4325 本次独占）：

- `tests/e2e-location/conversation.spec.ts` 4 例 →
  1. 真实 HTTP 契约：page 1/2/3 投影、定位响应与 page 2 逐项相同、会话 11 条按 10/1 分页、越界空页、缺祖先部分结果、404/422、上游请求计数与归档内容不变；
  2. 手机普通回复页：翻到回复第 2 页 → `查看对话` 打开会话 → 10 条 → `下一页` 1 条并标记入口回复 → `‹ 会话列表` 回到楼中楼页；
  3. 通知定位页：`/replies/960020/locate` 直达页进入会话再返回该次定位（`data-located=true` 仍在）；缺祖先与异常环页面提示「部分上下文暂不可用」且条目有限；
  4. 直达/刷新会话页独立读取，无来源时 `‹ 会话列表` 替换为所属回复详情第 1 页。
- 同项目回归：`tests/e2e-location/comment-location.spec.ts`（2 例）与 `reply-location.spec.ts`（2 例）在同一批关系夹具下仍通过 → 合计 **8 passed**。

全量前端门槛：合并前 `pnpm check`（typecheck + vitest **304 passed** + e2e 项目覆盖守卫）通过；合并 02 后 **27 files / 309 passed**。`pnpm check:dist`（两次构建 + 产物隔离）通过。

`pnpm test:e2e`（mock 装配 + 图片夹具 + 生产装配 + 管理项目，端口 4318/4319/4320）在并行票据 01 的 Playwright 进程让出端口后完整跑完：**207 passed / 10 skipped / 2 failed**。2 个失败都在 `tests/e2e/app-shell.spec.ts:29`，与本票无关且**在基线 tip `eca658b` 上同样失败**：该断言用子串匹配取 `getByRole('link', {name:'UP 列表'})`，而 `/manage/ups/:id` 同时渲染管理壳的「UP 列表」与 `UpVisit.vue:39` 的「返回 UP 列表」，Playwright 1.58.2 的 strict 模式因此判为两个元素。验证方式：`git stash` 只收起本票的已跟踪改动后重跑该 spec → `1 failed / 2 passed`，恢复后仍是同一失败；该 spec 的文案/壳断言属 01 的写入面，本票不改它，也不把它记为本票的通过项。

`backend/tests/live_app.py` 只新增测试夹具能力：`REPLY_PARENTS`（1 基序号 → 父回复 ID，含缺父 `"990000"` 与互指环 21↔22）与 `POST /api/test/replies` 的可选 `parents` 覆盖；默认行为对既有 `comment-location`/`reply-location` 用例保持不变，且默认链路即本票浏览器用例使用的关系集。

## 5. 万条回复夹具的读取成本（记录，不是门槛）

`test_twenty_five_and_ten_thousand_replies_keep_the_same_query_and_response_cost`：临时 SQLite 直插 1 万条同楼回复（单链，起点 `100001`），生产 `create_app` + `TestClient`，SQLite 语句数用 `set_trace_callback` 统计。

实测（本机，`uv run --no-sync python -m pytest backend/tests/test_conversation_reading.py -q -s -k ten_thousand`）：

```text
conversation-cost total=10000 page_ms=235.2 conversation_ms=177.2 tail_ms=172.2
page_statements=7 conversation_statements=6 tail_statements=6
```

- 查询次数恒定（同一楼 25 条时一致），证明没有逐条 N+1；断言上限 8 条语句/请求。
- 响应规模只与每页条数有关：`items` 恒为当页最多 10 条，1 万条楼的首页条目序列化后不超过 25 条楼首页 + 1KB；越界页只有空 `items` 与实际 `count`。
- 耗时只作观察记录，**未设性能门槛**，也没有新增数据库索引或缓存；长期容量与真实上游规模仍未评估。

## 6. 与相邻票据的边界

- **05（回复热度排序）**：本票只定稿并实现回复 page/location 的投影与会话读取，没有 `sort` 参数、没有热度排序函数、没有热度 cursor；05 在此契约上追加 `sort=time|hot`，并允许旧响应键全集断言改为兼容新增字段。
- **07（会话导航恢复）**：本票的 `returnFromConversation` 只做「有效来源真实后退／无来源替换为所属回复详情第 1 页」，不保存也不恢复回复排序、页码与滚动位置，不区分主动通知定位与热度意图；这些由 07 在 `navigation.ts` 的访问表内新增短期快照收口。本票通过不代表 UI-11 完成。
- **01/02**：本票未改 `App.vue`、`theme.css`、`ArchiveNavigation.vue`、`CommentSection.vue`、`CommentList.vue`、`useCommentsRead.ts`、`snapshots.ts` 的排序默认值；会话页只复用既有 `ReplyPager`（新增 `dismissible` 开关）与 `ReadNotice`。
- **08/09/10**：管理布局、组合回归与视觉签收不在本票；本票没有更新视觉黄金图。

## 7. 未验证与限制

- `pnpm test:e2e` 首跑（合并 02 后、01 之前）曾有 2 个基线已有的 `app-shell.spec.ts` 链接名断言失败（详见 §4 末段），01 合入后该断言已修；合并 01 后整套 **221 passed / 10 skipped / 0 failed**。`pnpm test:e2e:production` 与 `test:e2e:manage`/`test:e2e:delivery` 未在本票单独重跑（本票未改生产装配路由表之外的壳/管理/投递语义，`dist` 隔离与六路由冒烟已由 `check:dist` 与 `test:e2e` 的生产装配项目覆盖）。
- 未运行 `pnpm visual:*`：本票新增页面为独立路由，未改主题标尺、既有页面结构与既有视觉断言；视觉与设备签收归 10，黄金图未更新。
- 真实手机（iPhone Safari）、真实飞书客户端深链接、真实上游与部署未验证，均不在本票授权范围。
- 环关系的「起点」在数据损坏时按解析顺序落在环内最早条目上（同一次读取内稳定），不承诺更深层的语义；此情形的界面只保证不无界遍历、不伪造入口与可解释的部分结果。
- 会话页与楼中楼页一样没有自己的访问快照：从会话返回楼中楼页会重新挂载并回到第 1 页（`07` 负责恢复排序/页码/滚动）。
- 未新增数据库索引；1 万条实测只证明查询次数与响应规模不随楼规模增长，不证明亚线性耗时。

## 8. 运行命令与端口

```bash
# 后端（工作树内 .venv）
uv sync
uv run --no-sync python -m pytest backend/tests/test_conversation_reading.py -q
uv run --no-sync python -m pytest backend/tests -q

# 前端
cd frontend && nvm use && pnpm install --offline
pnpm check
# 本机设置了 HTTP(S)_PROXY 时必须显式绕过回环地址，否则 Playwright 会把代理对
# http://127.0.0.1:<port>/ 的应答当成“端口已被占用”而拒绝启动 webServer。
NO_PROXY=127.0.0.1,localhost HTTP_PROXY= HTTPS_PROXY= pnpm test:e2e:location
NO_PROXY=127.0.0.1,localhost HTTP_PROXY= HTTPS_PROXY= pnpm test:e2e   # 4318/4319/4320，需先确认空闲
pnpm check:dist
```

- 端口：`test:e2e:location` 使用 API `4178` + web `4325`（本次独占）；`test:e2e` 使用 `4318`/`4319`/`4320`，运行前确认并行票据已让出；未触碰 `8000`/`4273` 等既有实例，也未改任何 Playwright 配置端口。
- 证据不包含截图：本票只交付读写契约与会话页行为，视觉基准由 10 处理。

## 9. 合并集成 tip 与复验

两次合并都落在报告前，均未 push、未合 main：

1. **02（`91db518`）→ 合并提交 `273fb30`**：唯一文本冲突是 `.scratch/reading-ui-refresh/map.md` 的 Decisions-so-far（两侧各追加一条结论），按“两条都保留、06 在前”合并，未改动对方文字；`archive-api.md`／`archive-api-client.md` 由 git 自动合并（02 写根评论段、06 写回复/会话段，无重叠语义）。复验：后端 `test_conversation_reading`／`test_root_comments`／`test_reply_location`／`test_live_app`／`test_root_comment_location` **42 passed**，全量后端 **1228 passed**；`pnpm check` 309 passed；`pnpm test:e2e:location` 8 passed。
2. **01（`5d26773`）**：无冲突自动合并。01 的 `ReplySection.vue`／`CommentThreadPage.vue` 改动是排版标尺 token 与文案（“归档”→“保存”），本票的「查看对话」入口与投影读取逻辑保留；本票随之把会话页与新入口按钮改用 01 的标尺（`--font-link`／`--font-meta`／`--font-comment*`／`--column-max`／`--action`），并把 `not-found` 文案改成“不存在或未保存”以保持一致。合并没有覆盖 01 的缩进/样式文件，也没有改 02 的实现文件。

合并后最终复验（本分支 tip）：

- `pnpm check`：**27 files / 309 passed**（typecheck + 单测 + e2e 项目覆盖守卫）。
- `pnpm test:e2e`：**221 passed / 10 skipped / 0 failed**（mock 装配 + 图片夹具 + 生产装配 + 管理）。首次合并后首跑出现 1 个 `tests/e2e/list.spec.ts` 的 UP 条滚动断言失败（“360px 滑到长昵称后应完整展示”，属 01 的写入面），单独重跑该 spec 9 passed、整套重跑 221 passed，判定为一次性滚动测量抖动，如实记录。
- `pnpm test:e2e:location`：**8 passed**（02 的 comment-location + 06 的 conversation + 03 的 reply-location，共用同一隔离 SQLite 与关系夹具）。
- 后端：**1228 passed**（全量）。

结论：本票与 01／02 可同时存在；05 可在本票契约上追加回复 `sort`，无需重写投影与会话资源。

## 10. 结论

票据验收条件中属于本票的部分已实现并取证：真实父关系驱动、无新表无迁移无采集、跨页入口资格、只读会话子资源、缺失祖先与异常环的安全边界、手机页面与返回、生产/mock 映射与错误、真实 SQLite/HTTP 与浏览器闭环、万条夹具的查询与规模记录、契约文档同步；`pnpm check` 与 `pnpm check:dist` 通过，`pnpm test:e2e` 仅有基线已有的 2 个 app-shell 断言失败（§4、§7）。**未验证项（视觉、真机、真实上游、部署）见 §7**；07 的完整往返恢复与 05 的热度排序仍待各自票据完成，本票不宣称 UI-11 或 UI-08 整体完成。
