# 13 证据：完整会话一次读取、入口居中与“刚才查看”

票：[13-complete-conversation-and-entry-focus](../issues/13-complete-conversation-and-entry-focus.md)
依据：[正式设计](../../../docs/design/reading-ui-refresh.md) §5.2–§5.3；[实施规格](../spec.md) 决定 8–9；
[票 10 首轮反馈](10-feedback-round-1.md)。基线：集成 `spec/reading-ui-refresh` = `e9f511b`。

工作树 `/tmp/reading-ui-refresh-worktrees/13`（`wt/reading-ui-refresh-13`）。本票只实现读取契约、会话页、
导航位置与测试/文档；正式设计与规格由主线程维护，未改动。

## 1. 交付形状

| 层 | 变更 |
| --- | --- |
| HTTP | `GET .../replies/{reply_id}/conversation` 省略 `page` → 整段：`{dynamic_id, root_id, reply_id, start_id, incomplete, count, items[全部], next_cursor:null}`，**没有 `page` 键**；显式 `?page=N&limit=10` 保留旧分页字节级行为（每页 ≤10、回显 `page`）。只给 `limit`、非法页码、未知/重复参数仍 `422 INVALID_INPUT` |
| Store | `read_conversation(..., page=None)`：缺省返回整段成员，显式页码走原切片；成员与顺序沿用 `_reply_conversation_segments` + 既有时间序，查询次数不变 |
| Adapter | `ConversationBatch` 去掉 `page`；`readConversation({dynamicId, rootId, replyId, signal})` 无查询串、`cache:'no-store'`；响应出现 `page` 键或 `items.length !== count` 一律 `error`（旧后端/服务端截断不会静默只显示 10 条） |
| mock | 同一语义：一次返回该起点全部成员，无页码、无每页 10 条 |
| 会话页 | 删除分页控件与页状态；一次读取整段；入口回复高亮 + 昵称旁唯一“刚才查看”；新进入/直达/刷新一次性居中；首尾按需补最小留白（内容不足一屏也补够）；同访问历史恢复优先位置 |
| 导航 | `PageEntry.conversationRead = {position, padding}`（仅内存访问表，不扩持久化、不缓存内容）：卸载保存、返回/前进恢复，新进入才居中 |
| 位置工具 | 复用 `readingPosition.ts`：新增 `centerReadingAnchor`（一次性、双 rAF、用户滚动/触摸/按键立即让位）与 `restoreReadingPosition` 同一交互语义；未新增并行机制或全局缓存 |

样式只在 `ConversationPage.vue` scoped 内（入口底色/左侧细条、“刚才查看”12/20 品牌色），未改
`theme/`、UP 条与管理样式（票 12 范围）。

## 2. 红 → 绿

先改测试、确认失败，再实现；关键节点逐条记录：

| 边界 | 红 | 绿 |
| --- | --- | --- |
| 后端整段契约 | `test_conversation_reading.py` / `test_reading_ui_integration.py` 4 个用例失败：`assert 'page' not in {...}`、11 条只回 10 条、`limit=10` 未 422 | `uv run --no-sync pytest -q backend/tests/test_conversation_reading.py backend/tests/test_reading_ui_integration.py backend/tests/test_reply_sort.py` → 38 passed |
| Adapter 整段校验 | `archive-reader-replies.test.ts` 2 个会话用例失败（仍按 `page/limit` 发请求） | 整段请求无查询串；`page` 键/截断/重复 ID → `error` |
| 会话页整段 + 无分页 + 唯一标记 | 临时回退旧 `ConversationPage.vue` 后：`expected <nav …> to be null`（分页控件仍在） | 14 条一次呈现、`共 14 条`、无分页控件、“刚才查看”恰好 1 处 |
| 入口居中 | 同上回退后：`expected +0 to be 146`（旧页面无条件回顶部） | 第 2 条 → `scrollY=146`；首条 → 补 162px 顶部留白后停在 8；用户先滚动后不再抢回 |
| 同访问历史恢复（不重复居中） | 去掉 `restored` 分支：`expected 146 to be 600`（重新居中） | 返回/前进恢复 600 且不补留白 |
| **居中留白随历史恢复**（本轮补充边界） | 去掉 `padding.value = restored.padding`：`expected '0px' to be '222px'`（留白丢失，末条位置会被夹回） | 留白与位置一起还原；短会话（未夹紧范围 −68px）也能恢复 |
| 真实浏览器短会话 | 首次实现只补 `gap`：`Expected <= 2, Received 8.5`（文档被布局撑到视口高、留白不足以撑开范围） | 改为按“内容底边（未夹紧）”推算留白后，条目垂直中心与视口中心差 ≤2px |

## 3. 通过的验证

- `frontend`：`pnpm check` → typecheck + **350 passed**（32 files）+ e2e 项目覆盖守卫。
- `frontend`：`pnpm check:dist` → 两次构建 + `check:isolation` 通过（dist 无 mock 入口/夹具/归档数据）。
- 真实 HTTP + 本次运行独占 SQLite + 生产装配浏览器（`pnpm test:e2e:location`，API 4178 / web 4325）：
  **17 passed**。其中本票新增/改写：
  - 契约：省略 `page` → 11 条整段、无 `page` 键；`?page=2&limit=10` 兼容仍 1 条且与整段 `items[10:]` 相同；`?limit=10`/`?limit=3`/`?page=0` → 422；只读（上游请求与归档不变）。
  - 手机普通回复页：11 条一次呈现、`共 11 条`、会话页无 `回复分页`/`下一页`；`刚才查看` 恰好 1 处且落在入口 `960020`；入口在**整段末尾**仍垂直居中（≤2px）；`/conversation` 只请求 1 次且无查询串。
  - 短会话（2 条、内容不足一屏）：末条居中靠按需留白撑开范围；返回来源后 `goForward` 回同一访问，留白与滚动位置一起还原且仍居中。
  - 通知定位页 → 整段对话 → 返回原定位访问（页码/标记/位置不变、不重复定位）；缺祖先与异常环仍 2 条。
  - 直达/刷新：11 条整段、刷新后再次居中；无来源返回替换为所属回复详情时间序第 1 页。
  - 热度第 2 页往返、受控迟到第 3 页响应：来源侧恢复不变。
  - `integrated-reading.spec.ts` 组合流程（列表→详情→楼中楼热度后续页→跨页对话→原访问恢复→回列表）在整段会话下重跑通过。
- 后端定向：`test_conversation_reading.py` + `test_reading_ui_integration.py` + `test_reply_sort.py` → 38 passed；
  10k 条夹具仍记录查询次数恒定（≤8）与整段响应字节，只记录、不设门槛。
- 后端全量 `uv run --no-sync pytest -q backend/tests` 在本票后端改动后跑过一次：**1256 passed**（约 12 分钟）。

## 4. 未在本票内验证（交主线程）

- 主 `pnpm test:e2e`（默认 4318 被正式预览占用）未运行；`tests/e2e/*` 里与会话相关的 `detail-entry-tab.spec.ts`、
  `thread.spec.ts`、`three-process-links.spec.ts`（整段 2 条，无需改）留给主线程统一跑。
- 视觉黄金图、真机、隔离静态交付预览未重跑/未更新；票 10 候选预览需在新候选上重建后由用户复验。
- 票 12 仍在进行，本票未改 UP 条/管理样式与 `theme/`；两票合入后统一出预览。

## 5. 边界与已知取舍

- 整段响应随对话条数线性增长（不截断），查询次数不随楼规模增长；不新增索引、不建持久会话表。
- 新前端 + 旧后端（按页回包）会被 Adapter 判为 `error`，不会静默只显示 10 条；部署须前后端同版本。
- 历史恢复的留白是“离开时那一份”：窗口尺寸变化后沿用同一份留白（与像素后备同一取舍），不重新居中。
