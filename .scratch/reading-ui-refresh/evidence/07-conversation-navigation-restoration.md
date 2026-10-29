# 07 会话直达、刷新与返回阅读位置：实现与验证

Status: resolved（实现与自动化取证完成；视觉、真机、真实上游与部署未验证）

依据：[实施规格](../spec.md)与[正式设计 §5](../../../docs/design/reading-ui-refresh.md)。本票覆盖 UI-11 的会话导航部分、UI-15 的直达与只读边界，接口客户端语义见[归档 API 客户端阅读改版 07 增量](../../../docs/backend/api/archive-api-client.md#阅读改版-07-增量会话往返恢复回复访问)。

## 1. 结论

- 会话身份仍是 `dynamicId + rootId + replyId`（URL 路径、`conversation` 命名），与应用浏览会话（`AppSession`、`pageEntryId`）无关，不以页码或昵称充当身份。会话页本身不保存阅读快照，永远从第 1 页（对话起点）开始。
- 新增**独立回复访问快照**（`ReplyVisitSnapshot`）：属于窄屏独立楼中楼页与窄屏楼中楼回复精确入口，保存区域身份（`dynamicId/rootId`）、排序、页码、已读批次与失败原因、定位意图与阅读位置；只活在当前标签页导航协调器的内存访问表，按历史记录（`pageEntryId`）索引，**不跨重启、不跨标签页**。
- `‹ 会话列表`、浏览器返回与前进回到该访问时，先按快照的排序、页码与内容渲染再按锚点落点：不会只恢复坐标却先显示第 1 页。从热度第 N 页进入会话再返回仍是热度第 N 页，**不重读第 1 页、不调用时间序定位**；通知主动定位页返回后仍是那次时间序定位访问（页码、目标 `data-located` 与位置都在），不重复定位。
- 无有效来源（直达、刷新、复制地址）时 `replace` 到所属回复详情的时间序第 1 页：不回错动态、不离开本站、历史里不留会话地址，因此不构成返回循环。
- 新访问（直达/刷新/从详情或列表重新进入同一地址）没有快照，仍是时间序第 1 页与页面顶部；图片预览关闭优先等既有规则未改。
- 读取状态分开表达：首屏加载、局部失败（重试同一页）、`not-found`（会话不存在／未保存）、`incomplete`（部分上下文暂不可用）互不冒充；离开时已保存的来源快照不会因会话读取失败而丢。
- **不改任何归档 HTTP 契约**：没有新增/改动接口、没有新表、没有迁移、没有索引，也不触发采集。

## 2. 实现位置

| 位置 | 内容 |
| --- | --- |
| `frontend/src/app/snapshots.ts` | `ReplyVisitReadState`／`ReplyVisitSnapshot`（区域身份、排序、定位意图、位置、页码读取结果）、`replyVisitRegion()`、`adoptReplyVisitSnapshot()`：身份不符一律按新访问处理。 |
| `frontend/src/app/navigation.ts` | `PageEntry.replyVisitSnapshot`、`saveReplyVisitSnapshot()` 与 `replyVisitSnapshot` 读取；`isReplyVisitPath()` 把楼中楼页与窄屏回复精确入口视为同一种回复访问；`openConversation` 把回复访问与详情族都记为来源，`returnFromConversation` 有来源时真实后退、无来源时 `replace` 为楼中楼页。 |
| `frontend/src/dynamics/useReplyPage.ts` | 新增可选 `restored` 初始状态：已完成读取不重读；只有上次 `loading`／`cancelled` 的读取才补读同一页，失败沿用既有“保留内容 + 局部重试”。 |
| `frontend/src/pages/CommentThreadPage.vue` | 采纳快照（排序、页码、`locating`、位置），恢复不重新 `arm()` 定位、不强制回顶；`onBeforeUnmount` 保存快照（含卸载前 `captureReadingPosition`）。 |
| `frontend/src/pages/ThreadPage.vue`（新）、`frontend/src/app/router.ts` | 楼中楼路由外壳按 `navigation.pageEntryId` 重建页面：同一路径的多次访问（前进/后退、另一根、另一动态）各存各的快照。 |
| `frontend/scripts/verify-static-delivery.mjs`、`verify-production-delivery.mjs`、`verify-production-deployment.mjs` | 静态路由回退清单补上会话页直达/刷新。 |
| `frontend/tests/unit/conversation-navigation.test.ts`（新） | 7 条浏览器可观察行为用例。 |
| `frontend/tests/e2e-location/conversation.spec.ts` | 真实 API＋隔离 SQLite 生产浏览器补 2 条、扩写 2 条。 |
| `frontend/tests/support/app.ts` | 测试装配的 `thread` 路由改用 `ThreadPage`。 |
| `frontend/tests/e2e/thread.spec.ts` | 既有“前进回到第 1 页”断言改为恢复该次访问的第 3 页（见 §6 行为变化）。 |

## 3. 红 → 绿

按 `.agents/skills/tdd/SKILL.md` 的纵向切片做，一次一条行为：

1. 先写“热度第 2 页进入会话再返回”用例 → 红（返回后显示时间序第 1 页 `9001`，期望热度第 2 页 `9015`）→ 引入快照 + `restored` 初始状态 + `ThreadPage` → 绿。
2. 依次补：通知定位页往返（不重复定位、`locateReply` 仍为 1 次）、正反两面历史各恢复自己的访问（另一根/另一访问不串）、同一地址的新访问仍从第 1 页开始、无来源会话替换为时间序第 1 页、受控迟到响应、失败快照保留内容并重试、**定位读取失败的访问恢复后重试仍按目标身份重新定位**（红：恢复后重试读第 1 页；绿：重试再发一次定位并显示目标页）。
3. 把新用例整体回到改动前的 `src`（`git stash push -- src tests/support/app.ts`）复核红：**5 failed / 2 passed**（定位重试用例在补该语义前单独红过一次）。通过的两条正是“新访问仍是第 1 页”和“无来源替换”这两个本票要求保持不变或只做加固的既有语义。
4. 真实浏览器同样复核过红：`pnpm exec playwright test --config <临时配置> --grep "热度第 2 页进入会话再返回"` 在改动前的 `src` 上失败（返回后显示时间序第 1 页）。

## 4. 自动化结果

| 门槛 | 结果 |
| --- | --- |
| `pnpm check`（typecheck + 单测 + e2e 项目声明守卫） | 通过：**30 个测试文件 / 336 passed**（原 318 + 本票 8 + 03 新增，合并后复验） |
| `pnpm check:dist` | 通过：生产与 mock 构建 + 产物隔离检查（`dist` 无 mock 入口/夹具） |
| `pnpm test:e2e:location`（实际 API + 本次运行独占 SQLite，API 4178 / web 4325） | **13 passed**，其中 `tests/e2e-location/conversation.spec.ts` 6 条（4 条既有 + 2 条新增，另扩写 2 条） |
| `pnpm test:e2e`（生产/mock 装配 + HTTP 替身；临时配置副本 4426/4427/4428，用完删除） | **224 passed / 15 skipped**；定位/楼中楼相关子集在最后的定位重试改动后复跑 **61 passed** |
| `pnpm test:delivery`（本机 Nginx 1.30.6，`NGINX_MIME_TYPES=/etc/nginx/mime.types`，`DELIVERY_PORT=4423`） | 三阶段全绿：mock 产物路由直达/刷新/回退（含会话页）、生产构建 + 实际 API/collector 六路由直达/刷新/401/密钥扫描 |
| `pnpm test:nginx-parity` | 通过（结构与一致性校验） |

本票新增/扩写的浏览器用例：

- **热度第 2 页往返**：切到热度 → 第 2 页 → 滚动 → 从 `960013` 打开会话 → `‹ 会话列表` 返回：列表首条仍是热度第 2 页的 `960015`、排序控件显示“按热度”、分页第 2 页为当前页、滚动位置恢复（±1px），返回后**没有任何回复页码请求**、也没有 `/location` 请求（用 `page.on('request')` 直接核对），读取不触发上游采集、归档不变。
- **通知定位页往返**：`/replies/960020/locate` 定位到时间序第 2 页 → 会话 → 返回：仍是第 2 页与 `data-located`，位置恢复，`/location` 请求仍为 1 次、回复页码请求为 0。
- **受控迟到响应**：真实浏览器里挂起第 3 页响应，进入会话再从会话返回（恢复第 2 页）后才放行；迟到响应到达后列表与分页仍是第 2 页。
- **直达/刷新无来源**：直开会话、刷新后仍只靠 URL 与只读接口读取；返回 `replace` 为 `/dynamics/800300/comments/860001` 的时间序第 1 页（首条 `960001`、分页第 1 页、排序控件显示按时间），随后浏览器后退不会回到会话地址。

单元用例（`tests/unit/conversation-navigation.test.ts`，8 条）与上述一一对应但不依赖真实 API：热度往返、定位往返、正反两面历史各自恢复、同一地址新访问、无来源替换、迟到响应、失败快照保留并可重试（重试重发同一页）、定位失败访问恢复后重试仍重新定位。

## 5. 与相邻票据的边界

- **05**：只在其 `sort=time|hot` 契约之上恢复排序；恢复不重新下发定位，因此不会把时间序定位页码当热度页码。热度第 N 页的快照保存的就是热度内容。
- **06**：会话投影、只读子资源与页面未改；本票只补“回到来源”的快照与导航。会话页仍从第 1 页开始，不含排序控件。
- **03**：列表快照（`ListSnapshot`，含新增的按动态 `comments`）与本票的 `replyVisitSnapshot` 是同一条访问表里的两个独立字段，各自只在对应路径保存/采纳；合入 03 后 `navigation.ts`、`snapshots.ts` 自动合并，未覆盖任一侧语义（列表内评论的 `regionId=list:{动态 ID}` 与本票的 `dynamicId/rootId` 互不影响）。
- **04**：本票只动 `thread`／`conversation` 段落与 `ThreadPage` 外壳；列表与详情正文新标签段落留给 04。

## 6. 行为变化与限制

- **行为变化（有意）**：独立楼中楼页从“没有阅读快照、前进后退都回第 1 页”改为“访问级短期快照”，因此浏览器**前进**回到该访问时恢复该次访问的第 3 页与位置，而不是重读第 1 页；`tests/e2e/thread.spec.ts` 的既有断言按新语义更新并写明理由。直达、刷新与同一地址的新访问仍是第 1 页与页面顶部，这条语义未变。
- 快照只在内存、只在当前标签页；换标签页、刷新、关闭浏览器都不恢复（规格 §9 明确不扩成持久阅读历史）。
- 恢复时不重读，因此归档在该次访问期间发生变化时，返回看到的是离开时的已读内容；再翻页或点重试才取最新结果（与详情/列表快照同策略）。
- 快照的 `error` 状态保留已读内容与重试入口；普通访问重试重发**当前可见页**，不重发离开时那次失败的页码（离开时状态里的页码即当前页）。定位访问若上次没定位成功（`error`／`not-found`／仍在进行），恢复后不会自动重跑，但显式“重试”仍按目标身份重新定位，不拿第 1 页冒充定位结果。
- 未验证：正式视觉基准与黄金图（未更新、未签收）、真机 Chrome/Safari、真实上游、部署与目标机交付；`pnpm test:delivery` 只在本机临时 Nginx 通过，本机交付脚本的重跑不代表目标机验收。

## 7. 静态路由回退增补与取证脚本修复

- 三个回退清单补上会话页（mock 装配用 `90071992547409931/90071992547401001/90071992547401103`，生产部署用 `91001/91002`），锚点是只在会话页出现的 `‹ 会话列表`，因此能区分“SPA 回退返回入口文档”和“服务端 404”。
- 为了让这条覆盖真的可执行，顺带修了两处**与本票无关的陈旧断言**（不改变任何被测行为）：
  - `verify-static-delivery.mjs` 的 `/ups/123` 锚点仍是 01 改文案前的 `UP 123 归档`，改为 `UP 123 动态`。
  - `verify-production-delivery.mjs` 的 401 提示在管理页多个区块各出现一条，严格模式选择器改为 `.first()`（断言仍是“有该提示且没有新增表单”）。
- 环境细节：`pnpm test:e2e` 的临时配置副本必须把 `IMAGE_SERVER_PORT` 同时传给图片夹具服务与 vite 代理，否则图片前缀用例会因端口不一致失败（首轮 6 条失败即此原因，修正后全绿）；主 e2e 端口 4318/4319/4320 本轮由其他票使用，本票一律用 4426/4427/4428，未终止任何既有服务。

## 8. 合并与复验

- 起点：`wt/reading-ui-refresh-07` 切自 `spec/reading-ui-refresh` 的 `c2e4237`（与工作树初始 HEAD 逐字一致）。
- 报告前依次合入集成最新 tip：`94ae4b4`（03，合并提交 `e137a8f`，`navigation.ts`/`snapshots.ts` 两侧字段自动共存）与 `9522c88`（04 领取，合并提交 `fef2464`，仅票据状态）。
- 合并后复验：`pnpm check`（30 文件 / 335 passed）、`pnpm check:dist`、`pnpm test:e2e:location`（13 passed）、`pnpm test:e2e`（224 passed / 15 skipped）、`pnpm test:delivery`（三阶段全绿）、`pnpm test:nginx-parity` 均通过。
- 本票未新增后端代码或迁移，后端测试未在本票重跑（归档 HTTP 契约未改，06/05 的全量结果仍是其证据）。
