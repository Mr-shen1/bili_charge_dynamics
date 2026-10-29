# 05 手机回复详情按时间/热度排序：实施证据

票据：[05 手机回复详情按时间/热度排序闭环](../issues/05-mobile-reply-sort.md)。依据：[实施规格](../spec.md)、[正式设计](../../../docs/design/reading-ui-refresh.md)（UI-08 回复部分、UI-12 数量/排序层级、UI-15 定位兼容）、[领域词汇](../../../GLOSSARY.md)。

- 实施工作树：`/tmp/reading-ui-refresh-worktrees/05`，分支 `wt/reading-ui-refresh-05`。
- 开工基线：`spec/reading-ui-refresh` tip `dd81f4d`（与工作树 HEAD 相同，`git log HEAD..spec/reading-ui-refresh` 为空）。
- 报告前合并集成 tip：`b4a4714`（08 管理紧凑布局与手机输入字号）。见 §8。
- 环境：Node `v24.21.0`（nvm）+ pnpm `10.34.6`；Python 3.12 + uv（复用主工作树 `.venv`，`UV_PROJECT_ENVIRONMENT` + `--no-sync`）。
- 本票只在 06 定稿的回复读取链上追加 `sort`：没有重写对话投影、会话子资源、`conversation` 语义、cursor 资源标识或数据库结构。

## 1. 交付内容

| 层 | 交付 |
| --- | --- |
| 读取契约 | `GET .../replies?page=N&limit=10&sort=time\|hot`：`sort` 可选，省略等价 `time`；`sort` 只在实时 page 模式有效，首批与 cursor 续批带任何 `sort` 都 `422 INVALID_INPUT` |
| 排序实现 | `storage.py` 的 `_reply_order(sort)`：`time` 为发布时间升序、null 后置、ID BINARY 升序（不变）；`hot` 为点赞降序（null 后置、不当作 0）、发布时间降序（null 后置）、ID BINARY 升序；对完整本地同根集合排序后切页，每页最多 10 条 |
| 兼容 | cursor 资源标识 `replies:<动态>:<根>:time-asc:id-binary:3-10:v1` 与旧 token 不变，不新增热度 cursor 行、不迁移；热度页码读取是纯 SELECT（不写 `reply_pages`、不改归档、不访问上游） |
| 定位/会话 | `.../replies/{reply_id}/location` 参数不变（`sort` 返回 422），仍是时间序页码；会话子资源固定时间序，不受热度读取影响 |
| 生产 Adapter | `contracts.ts` 增 `ReplySort`，`readReplies` 增可选 `sort`；`archiveReader.ts` 只在 page 模式下发 `sort`，省略时不带该参数，cursor 模式或未声明排序值在传输前拒绝 |
| mock Reader | `createMockArchiveReader` 的 page 模式按同一口径排序；cursor 预览不带 `sort`、也不接受 |
| 页面与状态机 | `CommentThreadPage.vue` 头部改为「相关回复共 N 条 + 单按钮 `☰ 按时间/按热度`」，`useReplyPage.loadPage(page, {clear})` 让排序切换丢弃旧排序内容；切换即回第 1 页、作废该次定位意图 |
| 正式文档 | [归档 API 增量](../../../docs/backend/api/archive-api.md#阅读改版-05-增量回复页码的时间热度排序)与[客户端契约增量](../../../docs/backend/api/archive-api-client.md#阅读改版-05-增量回复时间热度排序)，并在 page 模式/cursor 段补指针 |

### 定稿契约（供 07 引用）

- 参数：`sort` 取值 `time`（默认）或 `hot`；只与 `page` 同时使用。`page` 模式省略 `sort` 与 `sort=time` 等价。
- 错误：非法/未知排序值、`sort` 配 cursor 或首批、未知/重复参数、page 模式批量≠10 都是 `422 INVALID_INPUT`；越界页仍是成功空页加实际 `count`。
- 响应字段与时间序相同：`items`（≤10）、`next_cursor:null`、`count`、`root`、`source_reply_count/local_reply_count/replies_last_attempt/synced_source_reply_count`、每条可空 `conversation` 投影。
- 前端：`ReplySort = 'time' | 'hot'`；`readReplies({..., sort?})` 仅 page 模式有效。

## 2. 真实 SQLite / HTTP 证据（后端）

`backend/tests/test_reply_sort.py`（21 例）：临时 SQLite 直插 25 条同根回复，时间每分钟一条、第 25 条无时间、第 22 条点赞最高（时间序第 3 页）、第 3/4/6/7 条同赞 7、第 6/7 条同一时间、第 9 条缺少点赞、第 2 条父级是第 1 条；`TestClient` 走真实 `create_app`，并在 fixture 里禁止凭据与上游请求。

| 用例 | 覆盖 |
| --- | --- |
| `test_hot_page_sorts_the_complete_local_set_before_slicing` | 三页时间序与三页热度序各自确定；点赞最高的回复从时间序第 3 页升到热度第 1 页首条；`count/local_reply_count/source_reply_count/root/next_cursor/状态` 与排序无关 |
| `test_hot_ties_use_published_time_desc_then_id_binary` | 同赞 7 的四条按发布时间降序，同一时间按 ID 升序（`910006` 先于 `910007`） |
| `test_missing_like_and_missing_time_stay_deterministic` | 缺点赞整组后置、不当作 0；同组内缺时间条目后置；时间序的缺失后置不变 |
| `test_omitted_and_explicit_time_sort_are_the_same_page` | 第 1/3/9 页省略与 `sort=time` 响应逐字段相同；越界热度页是空 `items` + 实际 `count` |
| `test_time_cursor_resources_and_tokens_survive_hot_reads` | 预览 → cursor 冻结批在三次热度页码读取后逐字段不变；`reply_pages` 的 token 与资源标识不变、仍只有 `time-asc` |
| `test_unknown_sort_values_are_invalid_input` | `latest/HOT/Time/空/hot,time/1` 等取值 422 INVALID_INPUT |
| `test_sort_is_only_valid_with_the_live_page_mode` | `limit=3&sort=*`、cursor+`sort=hot`、重复 `sort`、`sort`+`limit=3`、未知参数 422 |
| `test_location_and_conversation_keep_time_semantics_and_reject_sort` | 定位仍是时间序页码（目标 910022 → 第 3 页，页内容等于时间序第 3 页）；定位与会话带 `sort` 均 422；热度读取后会话仍逐字段相同 |
| `test_hot_page_reads_do_not_write_the_archive_or_reach_upstream` | 归档、根评论、回复文档不变，`reply_pages` 为 0 行，重复读取相同 |

运行：`uv run --no-sync python -m pytest backend/tests/test_reply_sort.py -q` → **21 passed**；受影响既有文件（`test_reply_live_pages`、`test_reply_location`、`test_conversation_reading`、`test_replies`、`test_reply_incremental`、`test_comment_session`、`test_live_app`）→ **99 passed**；全量后端 **1249 passed**。

## 3. 前端单元与生产 Adapter

- `tests/unit/archive-reader-replies.test.ts`：page + `sort=hot` 只发一条 `?page=1&limit=10&sort=hot` 且 `cache:'no-store'`；省略排序时 URL 与旧版逐字节相同；cursor 预览带 `sort`、非法排序值都在传输前 `{status:'error'}` 且零请求。
- `tests/unit/reply-sort.test.ts`（6 例）：默认显式下发 `sort=time`、控件文字与可访问名；从第 3 页切到热度回到第 1 页并显示时间序第 3 页尾部的高赞回复；快速切换时旧排序迟到的成功/失败都不提交、标签期间不显示旧条目；目标排序失败仍是自己的失败且“重试”重发 `sort=hot&page=1`；通知定位页仍是时间序、切到热度不再标该次定位（`data-located` 消失）；mock 装配按点赞降序且缺失点赞后置。
- `tests/unit/thread-reading.test.ts`：页码请求断言补上 `sort:'time'`；宽屏内联楼中楼不出现排序控件（`queryByRole('button', {name:/^当前按/})` 为 null），页码读取仍显式声明时间序。

`pnpm check`：typecheck + **28 files / 318 passed** + e2e 项目声明守卫一致。

## 4. 真实 API＋隔离 SQLite 浏览器

`frontend/tests/e2e-location/reply-sort.spec.ts`（3 例，端口 4178/4325 本次独占，`NO_PROXY=127.0.0.1,localhost`）：

1. **真实 HTTP 契约**：省略与 `sort=time` 同页；热度第 1 页 = 时间序第 3 页尾部（`960025…960016`，点赞 24…15），第 3 页 = `960005…960001`，越界页空 `items` + `count=25`；非法排序/只有 cursor 的模式带 sort/重复参数 8 组全部 422；旧 token 冻结批在两次热度读取后逐字段不变且带 `sort` 仍 422；定位 `960022` 仍是第 3 页且与时间序第 3 页相同、定位与会话带 `sort` 422；会话成员与顺序不因热度读取改变；上游请求计数与归档文档不变。
2. **手机普通回复页**：390px 下按钮显示 `☰ 按时间`（可访问名 `当前按时间，点击切换为按热度`）、控件与「相关回复共25条」计算字号均为 13px、按钮盒高 ≥44px；时间序第 1 页首条 `960001` 且最高赞回复不在本页；点击后回第 1 页、首条 `960025`、热度页 1 的条目序列与真实 API 一致、分页 `aria-current` 回 1、「共3页」；热度第 2 页首条 `960015`；再点一次回到时间序第 1 页首条 `960001`；上游请求与归档不变。
3. **通知定位页**：`/replies/960022/locate` 窄屏直达仍是时间序第 3 页、目标 `data-located=true`、分页停在第 3 页、控件显示“按时间”；读取不触发上游。

同一项目合计 **11 passed**（02/03/06 的既有定位与会话用例同时通过）。

## 5. 生产浏览器门禁

`pnpm test:e2e`（mock 装配 + 图片夹具 + 生产装配 + 管理项目，端口 4318/4319/4320）在独占窗口内跑完：**223 passed / 10 skipped / 0 failed**（08 合入后比 06 记录的 221 多出 2 个管理用例）。

首跑曾出现 35 个失败，全部落在图片预览/评论图片类 spec，原因是并行工作树（03/08）用同一组硬编码端口跑 e2e，先失败的 `/__requests already used` 与后来的“图片服务器互相顶替”是同一问题的两次表现；在无其他 Playwright 进程、三端口空闲的独占窗口重跑即全绿，本票改动与这些用例无交集，未修改任何图片/预览代码或断言。该现象与[09 环境记录](../../../.scratch/reading-ui-refresh/evidence/baseline-and-seams.md)中“端口硬编码必须串行”的结论一致，本票不为此改配置。

## 6. 与相邻票据的边界

- **06（已 resolved）**：本票不改对话投影、会话子资源、`useReplyPage` 的批次泛型与 not-found 语义，也不改 `conversation` 字段；只在 `readReplies` 追加 `sort`。
- **07**：本票的排序切换会作废“本次定位”意图（`data-located` 消失、重试不再重发定位），但不保存/恢复回复排序、页码与滚动；从会话返回原热度页由 07 在其访问快照里收口。
- **02**：沿用同一单按钮形状与可访问名模式（`当前按X，点击切换为按Y`），但使用独立的 `ReplySort` 类型与独立状态，不共用一级评论的 `CommentSnapshot`、`emptyCommentSnapshot` 默认值或 `sort=latest` 语义（一级评论 latest 是新到旧，回复 time 是旧到新）。
- **03/08**：未改 `ListVisit`/卡片/列表快照与管理页；08 合入后只影响 `theme.css` 注释与管理页局部样式，本票页面只引用既有排版 token。

## 7. 未验证与限制

- 视觉黄金图未更新、未运行 `pnpm visual:*`：本票新增的是楼中楼页头部控件与数量字号，黄金图差异属预期，签收归 10；候选截图未产出。
- 真机（iPhone Safari）、真实上游与部署未验证；管理/通知/投递项目未在本票单独重跑。
- 排序语义只在本地已保存回复上成立：来源新增/点赞变化影响下一次读取，不承诺跨请求事务快照；这也是既有 page 模式语义。
- 桌面独立楼中楼页仍可通过 URL 直达，但按设计与验收范围不提供排序控件（宽屏内联楼中楼保持原时间序与分页）；因此“桌面也能切热度”不是本票交付。
- `hot` 不代表 B 站真实热度算法，只是点赞降序 + 确定性次级规则。

## 8. 合并集成 tip 与复验

报告前合入 `spec/reading-ui-refresh` tip `b4a4714`（08 管理紧凑布局、手机输入字号、四宽度实测与限制），为 fast-forward，无冲突；合入后 `theme.css` 只改注释、管理页样式集中在 `manage.css`，本票文件集不受影响。合入后重跑：后端全量 **1249 passed**、`pnpm check` **318 passed**、`pnpm check:dist` 通过、`pnpm test:e2e:location` **11 passed**、`pnpm test:e2e` **223 passed / 10 skipped**。

端口与并发：`test:e2e:location` 用 4178/4325，`test:e2e` 用 4318/4319/4320；两者都硬编码，本票按“独占窗口 + 开跑前探测”运行，未改任何 Playwright 配置端口，未触碰 `8000`/`4273` 等既有实例。
