# 06：真实关系驱动的查看对话与完整分支阅读

Status: resolved
Blocked by: None

依据：[实施规格](../spec.md)。覆盖 UI-09、UI-10、UI-11 的会话展示部分及 UI-15 的只读边界。

## 交付内容

手机从回复条目下的“查看对话”进入独立会话页，读取同一对话的起点及全部分支；入口资格与内容来自完整本地真实关系，不受当前回复页限制。此票贯通存储查询、读取契约、Adapter、入口和页面；热度状态的往返恢复由 07 组合收口。

## 验收条件

> 全部条件已按本票范围实现并取证；合并 01／02 后 `pnpm check`（309 单测）／`check:dist`／`pnpm test:e2e`（221 passed / 10 skipped）／`test:e2e:location`（8 passed）与后端全量 1228 passed 均通过。未验证项（视觉签收／真机／真实上游／部署）见证据 §7；07 的完整往返恢复与 05 的热度排序不在本票内。

- [x] 从已有同根父回复关系计算对话，不新增持久会话表、不触发 B 站或采集；ID 始终为字符串，校验动态/根/回复所属关系。
- [x] 回复 page 响应及携带同类页内容的定位响应为当前页条目提供可空对话投影（起点、关联数量、上下文不完整），通知直达也有正确入口；定位参数和时间序页码语义不变，仅增补可空投影字段。同楼计算复用，无逐条 N+1 请求，不下发整个楼的关系全集。
- [x] 单条无入口；A→B 仅 B 有入口；更长对话除起点外各条都有入口。门槛与当前回复页/排序无关，不用来源总数猜测。
- [x] 独立只读 conversation 子资源读取整段已确认分支，再按时间正序以实时页码每页最多 10 条提供内容及本地总数；最后一页和数量变化按既有末页收敛规则处理。
- [x] 对话包含起点和所有关联分支，排除一级评论、无关同楼回复、跨根/跨动态条目；同名作者与 @ 文本不构成关系证据。
- [x] 父级缺失时仅返回可确认部分并标记不完整；异常环不会无界遍历或产生伪造入口。目标不存在、父级身份不符与暂时读取失败按明确契约区分。
- [x] 手机页面从对话开头阅读，一级评论不重复展示，当前入口回复可见时轻微标记；保持时间正序，无排序控件，跨页不改变对话身份。
- [x] 左上角只有 `‹ 会话列表`，与 `‹ 评论详情` 同样式并可返回所属回复页；桌面不新增会话入口。
- [x] 生产与 mock Reader/Adapter 完整映射新字段和错误，不通过当前页筛选伪造成功；新 URL 与 DTO 在本票定稿并同步契约文档。
- [x] 真 Store/SQLite 与 HTTP 覆盖双条、分支、跨两页、缺失父级、同名、跨父级、缺失排序字段、异常关系及定位响应的对话投影/入口资格；浏览器可从普通回复页与通知定位页真实打开并翻页查看对话。
- [x] 使用万条回复的隔离夹具记录关系读取与分页的耗时、查询次数和响应规模；不虚构性能门槛，不未经依据新增数据库索引或请求真实上游。

## 边界

本票可在现有时间序回复页独立演示。完整的排序/页码/滚动往返恢复、刷新和无来源返回由 07 验收，本票通过不代表 UI-11 全部完成。公共回复/定位DTO与 05 有共同修改面，实施时协调单一写入者，不用虚假的功能依赖替代代码所有权管理。

## Answer

- **结论**：真实父关系驱动的「查看对话」纵向链路已交付并在本分支取证；只读、无新表、无迁移、无采集，05/07 可直接引用本票定稿的 URL 与 DTO。
- **定稿契约**（见[归档 API](../../../docs/backend/api/archive-api.md#阅读改版-06-增量回复对话投影与只读-conversation-子资源)与[客户端契约](../../../docs/backend/api/archive-api-client.md#阅读改版-06-增量对话投影与手机会话页)）：
  - 投影 `items[i].conversation = {start_id, count, incomplete} | null`，仅出现在 `replies?page=` 与 `replies/{reply_id}/location`；`cursor` 预览无该键。
  - 会话 `GET /api/archive/dynamics/{id}/comments/{root_id}/replies/{reply_id}/conversation?page=N&limit=10` →
    `{dynamic_id, root_id, reply_id, start_id, incomplete, count, page, items[≤10], next_cursor:null}`；身份不存在/跨父级 `404`，非法页码或批量 `422`，缺失祖先为 `incomplete:true` 的 200 部分结果，暂时失败沿用既有 5xx 固定码。
  - 浏览器入口 `/dynamics/:dynamicId/comments/:rootId/replies/:replyId/conversation`；客户端 `DynamicReader.readConversation(...)` + `Reply.conversation?`。
- **关系口径**：只认已保存 `parent_id`；等于所属根评论即直接回根（该条为起点）；父级缺失/跨根/未知在断点止步并标 `incomplete`；`parent_id` 成环在环内终止并标 `incomplete`。成员 = 起点 + 沿父链解析到起点的本地回复；一级评论不计入、不在正文重复；同名作者、正文前缀与 @ 文本不参与。
- **实现位置**：`backend/bili_monitor/storage.py`（`_reply_starts`/`_reply_conversation_members`/`_reply_conversations`、`_reply_page_document` 投影、`Store.read_conversation`）、`backend/bili_monitor/app.py`（conversation 路由）、`frontend/src/data/{contracts,archiveReader}.ts`、`frontend/src/mock/archiveReader.ts`、`frontend/src/dynamics/useReplyPage.ts`（泛化批次类型 + `not-found` 页结果）、`frontend/src/dynamics/ReplyPager.vue`（`dismissible`）、`frontend/src/app/{router,navigation}.ts`、`frontend/src/pages/ConversationPage.vue`、`frontend/src/pages/CommentThreadPage.vue`、`frontend/tests/support/{app,reader}.ts`、`backend/tests/live_app.py`（关系夹具）。
- **测试**（合并集成 tip `91db518` 后复验）：后端 `test_conversation_reading.py` 10 例、全量 **1228 passed**；前端 `pnpm check` 通过（typecheck + **309** 单测 + e2e 项目守卫）、`pnpm check:dist` 通过、`pnpm test:e2e` 207 passed / 10 skipped / 2 failed（两个失败是基线已有的 `app-shell.spec.ts` 「UP 列表」链接名子串匹配，`git stash` 收起本票改动后同样失败）；真实 API＋隔离 SQLite 浏览器 `tests/e2e-location/conversation.spec.ts` 4 例，同项目合计 8 passed。
- **成本记录**（1 万条同楼回复夹具，非门槛）：首页读取 7 条 SQL 语句、会话读取 6 条，均不随楼规模增长；`items` 恒为当页最多 10 条。实测 `page_ms≈235`、`conversation_ms≈177`、越界页 `tail_ms≈172`（本机单次观察）。
- **未验证**：视觉基准与真机、真实上游与部署；`test:e2e:production`/`manage`/`delivery` 未在本票单独重跑。基线已有的 `app-shell.spec.ts` 2 个失败留给 01 的壳/文案写入面，本票不改。07/05 的完整行为见各自票据。
- **合并**：报告前依次合入 `spec/reading-ui-refresh` 的 `91db518`（02，合并提交 `273fb30`，唯一冲突是 `map.md` 两条结论、两侧都保留）与 `5d26773`（01，无冲突自动合并）。01 的标尺 token 与“归档→保存”文案保留，本票的会话页与新入口按钮改用同一标尺；合并后 `pnpm check` 309、`test:e2e` 221 passed/10 skipped、`test:e2e:location` 8、后端全量 1228 复验通过。
- **详细证据**：[06 证据](../evidence/06-conversation-reading.md)。

## Comments

- 投影只在 page 与定位响应出现、cursor 预览不出现：cursor 是冻结快照，给它加"当前关系"会让旧快照显示新关系；界面又必须能区分"没有对话"与"这份响应没这项能力"，因此选择"字段不出现"而不是伪造 `null`。
- 会话端点要求 `limit` 省略或等于 10，与现有 page 模式一致；`page` 可省略等价第 1 页（会话只有一个模式，不存在 cursor 分支），越界页沿用"成功空页 + 实际总数"的既有末页收敛规则。
- 环关系按"解析到达环时以当前条目为可确认段起点"处理：只保证不无界遍历、不伪造入口、结果确定且可解释，不为损坏数据发明更深的语义。
- 会话条目里不带 `conversation` 投影、也不下发 `root`：整段身份由响应头部的 `dynamic_id/root_id/reply_id/start_id` 表达，避免同一页重复一级评论与冗余关系。
- 「查看对话」只在窄屏分支渲染（`useCompactViewport`），桌面保持列表内/详情内回复阅读；会话页本身在桌面直接访问仍可读，不做重定向。
- 返回只做「有效来源真实后退／无来源替换为所属回复详情第 1 页」，未保存回复排序/页码/滚动：这是 07 的明确交付，此票不冒充；楼中楼页没有访问快照，所以即使真实后退也回到第 1 页。
- 关系夹具分两处：mock Reader 自带确定性链（A→B、旁支、跨页、缺祖先、互指环）用于装配演示与单测；`backend/tests/live_app.py` 用 `REPLY_PARENTS` 把同一形状的关系交给真实归档链，浏览器用例因此读的是真实 SQLite 关系而不是前端构造。
- 端口与并发：`test:e2e:location` 使用 4178/4325 并独占运行；本机 `HTTP(S)_PROXY` 会让 Playwright 把代理应答误判为"端口已占用"，运行时必须 `NO_PROXY=127.0.0.1,localhost`（已在证据 §8 记录），未改任何配置端口。
