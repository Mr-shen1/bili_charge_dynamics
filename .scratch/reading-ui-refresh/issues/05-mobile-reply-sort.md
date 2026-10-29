# 05：手机回复详情按时间/热度排序闭环

Status: resolved
Blocked by: 02

依据：[实施规格](../spec.md)。覆盖 UI-08 的回复部分、UI-12 的数量/排序层级与 UI-15 的旧定位兼容。

## 交付内容

手机回复详情默认按时间从早到晚，使用与一级评论一致的单按钮切换到热度；从完整本地集合排序后读页，保留既有通知回复定位、桌面预览和时间 cursor 兼容。

## 验收条件

> 全部条件已按本票范围实现并取证：后端全量 **1249 passed**（新增 `test_reply_sort.py` 21 例），`pnpm check` **318 passed**、`pnpm check:dist` 通过、`pnpm test:e2e:location` **11 passed**、`pnpm test:e2e` **223 passed / 10 skipped**。未验证项（黄金图与视觉签收、真机、真实上游、部署）见证据 §7。

- [x] 真实回复 page 读取接受可选 time/hot 排序，省略时保持原时间序；hot 仅扩展 page 模式，既有 limit/page/cursor/未知参数校验按新契约明确区分。
- [x] 热度按点赞降序、发布时间降序、ID BINARY 字符串升序；时间序保持旧到新、缺失后置与 ID 次级顺序；对完整同根本地集合排序后每页最多 10 条。
- [x] 原时间 cursor 资源及有效 token 保持兼容，不为热度引入持久 cursor 记录或数据库迁移；桌面最多 3 条预览与页码读取仍可省略新参数。
- [x] 生产 DTO/Adapter、mock、页码读取与重试共用一致排序语义，不能只修改界面排列。
- [x] 手机首次显示 `☰ 按时间`；点击切换当前状态并回第 1 页，回复数量与控件均为13px；独立于一级评论排序。
- [x] 回复定位端点参数与时间序页码语义不变；响应允许06新增可空 conversation 投影，旧字段保持兼容，不用旧响应键全集断言阻止加字段。通知主动直达显示时间序，不能用该页码冒充热度页；已存在热度访问的历史恢复不重新主动定位。
- [x] 快速切换、分页、失败与重试隔离请求代次，只有当前排序数据可提交；来源/本地计数区别和有效末页收敛保留。
- [x] 真实临时 SQLite/HTTP 覆盖高赞回复原在后续页、同赞同时间、缺失值、旧 token、排序参数错误及定位；定位断言锁定所属身份与时间序页码，兼容可空对话投影。生产浏览器验证控件到内容的完整闭环。
- [x] 在本票完成时同步新增读取契约与实际测试证据，不把 API 定义延后到综合票。

## 边界

本票只追加回复排序：不改 06 的对话投影、conversation 子资源与会话语义，不改 03 的列表/卡片快照与 08 的管理页。排序/页码/滚动的位置恢复由 07 在 06 的会话页上收口；本票通过不代表 UI-11 完成。

## Answer

- **结论**：手机回复详情的时间/热度排序纵向链路已交付并取证；只读本地、无新表、无迁移、无新索引、无采集/通知副作用，07 可直接引用本票定稿的 `sort` 契约。
- **定稿契约**（见[归档 API](../../../docs/backend/api/archive-api.md#阅读改版-05-增量回复页码的时间热度排序)与[客户端契约](../../../docs/backend/api/archive-api-client.md#阅读改版-05-增量回复时间热度排序)）：
  - `GET /api/archive/dynamics/{id}/comments/{root_id}/replies?page=N&limit=10&sort=time|hot`；`sort` 可选，省略等价 `time`，只在实时 page 模式有效；首批与 cursor 续批带任何 `sort` 均 `422 INVALID_INPUT`，未知/重复参数与非法取值同为 422。
  - 排序：`time` = 发布时间升序、null 后置、ID BINARY 升序（不变）；`hot` = 点赞降序（null 后置、不当作 0）、发布时间降序（null 后置）、ID BINARY 升序；完整本地同根集合排序后每页最多 10 条。
  - 兼容：cursor 资源标识与旧 token 不变、不新增热度快照行；定位端点参数不变且始终时间序；会话固定时间序。客户端 `ReplySort = 'time' | 'hot'`，`readReplies({..., sort?})` 只用于 page 模式。
- **实现位置**：`backend/bili_monitor/storage.py`（`REPLY_SORTS`、`_reply_order`、`_reply_reading(sort)`、`list_replies(sort)`）、`backend/bili_monitor/app.py`（replies handler 的 `sort` 与模式区分）、`frontend/src/data/{contracts,archiveReader}.ts`、`frontend/src/mock/archiveReader.ts`、`frontend/src/dynamics/useReplyPage.ts`（`loadPage(page,{clear})` 与失败基线）、`frontend/src/pages/CommentThreadPage.vue`（单按钮控件、13px 数量/排序、切换回第 1 页并作废该次定位）。
- **测试**：后端 `test_reply_sort.py` 21 例 + 全量 1249 passed；前端单元 `reply-sort.test.ts` 6 例与 `archive-reader-replies.test.ts` 3 例、`thread-reading.test.ts` 断言同步；真实 API＋隔离 SQLite 浏览器 `tests/e2e-location/reply-sort.spec.ts` 3 例（同项目合计 11 passed）；生产浏览器 `pnpm test:e2e` 223 passed / 10 skipped。
- **合并**：报告前以 fast-forward 合入集成 tip `b4a4714`（08），无冲突；合入后全部门槛重跑通过。
- **未验证**：视觉基准/黄金图（02 起的字号与控件改动仍待 10 统一签收）、真机与真实上游、部署；`hot` 不是 B 站真实热度算法。
- **详细证据**：[05 证据](../evidence/05-mobile-reply-sort.md)。

## Comments

- `sort` 只在 page 模式接受：cursor 预览是时间序冻结快照，给它加“当前排序”会让旧快照按新规则解释；因此首批/续批带 `sort`（含 `sort=time`）直接 422，而不是静默忽略。省略 `sort` 的请求与旧版逐字节相同，`test:e2e` 里既有调用方不需要改。
- 排序在 SQL 层做（`_reply_order`），一次 `ORDER BY` 后切片，保证“完整的本地集合排序后再分页”，也让 `count` 与热度无关；没有引入缓存或索引。
- 热度缺失点赞整组后置，不当作 0：点赞未知与零点赞是不同事实，混在一起会让热门页把未知项排到零赞前面。
- 页面切换排序时清空旧排序内容（`loadPage(page,{clear:true})`），失败基线也落在清空后的状态：带“按热度”标签显示时间序第 1 页是这一票要避免的错误，因此宁可先显示加载中。
- 通知直达的定位意图只在本次排序选择内有效：切到热度后 `data-located` 消失、重试不再重发定位，避免把时间序定位页伪装成热度页；从热度页返回时的恢复交给 07。
- 排序控件只在 ≤640px 渲染：设计 §4 只给手机回复详情、桌面内联楼中楼保持原时间序与分页；桌面直接打开独立楼中楼页仍可读，只是没有控件。
