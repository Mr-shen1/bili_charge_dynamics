# 前端归档读取与指定目标（02 / 13 / 16 / 17 / 18 / 20 / 22 / 26；飞书通知 02 增精确定位入口）

> Vue 前端重构已由票据 12 形成仅含 Vue 的候选产物，见[重构方案](../../design/frontend-migration.md)。HTTP/DTO、读取/管理语义、生产/mock/fault 装配边界保持不变；图片展示与预览细节以修订后的 SRS 为准。下列分阶段实现、React/RTL/StrictMode 测试及旧网格/预览记录保留其历史范围，不改写为 Vue 实现或新版通过证据；新增验证须单独记录。

下列 02 记录保持原交付边界；13、16、17、18、20、22 增量契约及证据独立列在文末。生产根评论能力以 16 增量为准，02 的全局讨论未归档描述仅为历史交付记录。前端 T1 不能替代后端 SQLite、上游协议、部署或真机验收。

## 当前代码基线：回复分页与独立楼中楼

用户已确认既有文档/测试冲突一律按当前代码逻辑迁移。基线为 `10319d855c55744b603de1fe65433a5b9f73926d`，本节补充当前行为；后文 02/13/16/17/18 等仍保留对应阶段的实现与证据。旧累计追加、窄屏内联或不展示回复目标的文字/测试不再覆盖本节，也不表示当前 Vue 已实现。

### 读取契约

- `readReplies` 输入为 `dynamicId/rootId/limit/signal` 以及可选的 `page/cursor`；`limit` 必填。返回 `items/nextCursor` 与可选 `count/root/sourceReplyCount/localReplyCount/repliesLastAttempt/syncedSourceReplyCount`。
- page 模式要求正的安全整数页码、`limit=10`、`cursor` 为 null/undefined；其他 cursor 值也算混用并在传输前拒绝。请求使用 `page=N&limit=10` 与 `cache:'no-store'`。每页响应必须有合法 root，保留本地 count 供页码计算；`nextCursor=null` 不表示整个回复组只有一页。
- cursor 模式仍要求无 cursor 时 `limit=3`、有 cursor 时 `limit=10`，不解析不透明 cursor。当前宽屏预览使用首读；旧续批能力继续保留，但正常 UI 不再通过“加载更多回复”累计展开。
- page 每次读取当前本地归档，不复用冻结 cursor。`count` 是本地总回复数而非来源数；页码超末页时后端返回空页与 count，前端再读有效末页。来源计数及逐根同步状态独立保留。
- 仅 `422 + CURSOR_INVALID` 映射 `invalid-cursor`；回复 404、422 INVALID_INPUT 及其他传输/DTO 错误都是普通安全 error，不映射成动态详情式 not-found。取消在请求前后均优先；不回显任意响应/异常。
- 动态列表及一级评论仍使用各自 cursor 追加与冻结协议，不为采用分页组件把它们改为 page；回复两种模式的 HTTP 细节见[归档接口](archive-api.md#当前-page-模式实时回复页码)。

### 宽屏回复与动态详情恢复

- 来源数非零或未知时建立宽屏回复区域，先读取最早最多 3 条预览；来源为零不创建。存在后续 cursor/更多预览条目时可展开，文案可使用来源回复数，不能据此推断本地页数。
- 每次展开都实时读取 page 1；翻页替换当前页，同页重读也发请求，busy 时禁用相应控件。页大小为 10，不累计成 3/13/23/25。
- 收起中止在途页请求并回预览，布局后将根评论开头滚回可见；记录收起状态时页码归 1。内部可能保留上次 live state，但再次展开仍重读 page 1，不能把内部保留误写成用户级缓存承诺。
- 动态详情快照保存每根预览 read、expanded、page 与文字展开。历史恢复时成功预览可复用，已展开的回复立即重新读取所保存页码，不复用冻结的页结果。

### 窄屏预览与独立页

- 当前以 `max-width:640px` 判断窄屏，无法判定时用宽屏分支。来源回复数大于零才有预览块/入口，零与未知均不渲染；来源为正但本地为零仍有入口。
- 有合法 `up_reply` 时显示该动态作者在此楼中最早的一条回复及“UP主等人 共N条回复”；无作者回复时只显示“共N条回复”入口。预览不读取最早 3 条，不以本地数量补造来源数。`up_reply` 是后端独立提供的摘要，不是正常回复分页的替代。
- 入口进入 `/dynamics/:dynamicId/comments/:rootId`。独立页每次重新挂载从 page 1 和顶部开始，无自身阅读快照；根评论取当前页响应，为判断 UP 标识另读一次动态详情，该辅助读取失败不阻断主读取。
- 独立页页头数量依次取 sourceReplyCount、count、当前 items 数；分页依次取 count、localReplyCount、items 数。页头显示更多来源回复不表示本地可翻到对应页数。
- 独立页根/回复正文和窄屏 UP 回复预览直接显示文本，不使用 6 行折叠。独立页不渲染根评论图片或回复图片，不新增此页图片预览。
- 有有效内存中的动态详情来源时返回并恢复详情；直达或刷新无来源时 replace 到对应动态详情。分页器“收起”等价返回。重新进入独立页不恢复其旧页码；详情同 URL 图片预览开关保留 pageEntryId，不重挂载详情或重置回复。
- 根缺失的生产读取落为 error + 重试；空 root 的“评论不存在或已不可读”备用分支不是已验证/可依赖的生产 not-found 契约。

### 目标文字与信息裁剪

- 普通 Reply 映射将直接回复根的 parentId 归为 null；其他回复有 parent 且有可用目标昵称时显示“回复 X:”，宽屏另校验 parent 不为 root。窄屏作者预览按 `replyTo.nickname` 显示目标，后端直接回根时该字段为空。
- 渲染期剥离来源正文开头的 `回复 @…:`/全角等对应前缀，存储正文不改，避免目标重复；不要求整段正文删掉普通 @ 文本。
- 阅读页不恢复编辑时间、整块归档统计/同步面板或状态读取按钮。列表保留已加载完毕提示，一级评论/回复不恢复旧结束结语；字段被解析或保留不等于必须渲染。
- 当前部分回复 E2E 的累计数量/按钮/前缀预期已滞后，须按代码同步；本次仅静态核对，未运行测试，也不把现存测试当新版通过证据。

## 装配与边界

- 默认开发、构建和测试的装配指向 `frontend/src/app/reader.ts` 的生产 Archive Adapter，使用真实 `createArchiveReader()`。
- `frontend/src/mock/` 保留独立 mock；显式 `pnpm dev:mock` 或 `pnpm build:mock` 才装配它。
- `pnpm dev:fault` 的开发故障装配保持不变。普通生产构建不包含故障入口或 mock 动态数据（`pnpm check:isolation` 断言）。
- 旧 mock 浏览器回归必须明确使用 mock 模式，不允许为它把默认生产装配改回 mock。本次集成新增独立的生产归档 Playwright 配置，并更新管理回归的 API 进程启动工具。
- 页面仅读取本地归档，不调用 `/api/sync/initial`，没有新增手动刷新/初始化按钮，也不向上游读取正文、评论或业务图片。
- 本票不做多 UP 页面改版；列表标题使用保守身份“归档动态”，卡片仍显示每条档案的真实作者，不展示 mock 作者。

## HTTP 与展示契约

| 操作 | 接口 | 成功映射 |
| --- | --- | --- |
| 列表 | `GET /api/archive/dynamics?limit=10&cursor=...` | `{items,next_cursor}` → `{items,nextCursor}`；cursor 不透明、原样编码传递 |
| 详情 | `GET /api/archive/dynamics/{id}` | Archive → Dynamic；404 为 `not-found`，其他 HTTP/JSON/传输错误为安全 `error` |
| 目标列表 | `GET /api/manage/ups/{uid}/targets` | `{targets:[{id:string}]}` → 目标集合 |
| 添加目标 | `POST /api/manage/ups/{uid}/targets`，`{id:string}` | 仅接受 201 且返回同一字符串 ID；提示归属校验通过 |
| 移除目标 | `DELETE /api/manage/ups/{uid}/targets/{id}` | 仅接受 204；成功后移除当前目标，提示保留已有归档 |
| 通知总开关 | `GET /api/manage/notifications` | `{enabled:boolean,pending:number}` → `{enabled,pending}`；页面顶部开关与待发条数的唯一来源（不读本地记忆） |
| 切换通知总开关 | `PUT /api/manage/notifications`，`{enabled:boolean}` | 仅接受 200 且响应形状合法；成功后以响应里的新状态渲染，失败保留原状态并给固定提示（票据 14）；两个方法都不带查询参数，未知查询参数按 `422` 处理 |

`TARGET_AUTHOR_MISMATCH`/409 映射“动态作者与所选 UP 不符”；`TARGET_UNVERIFIED`/502 映射“无法确认动态归属”。重复目标提交也由服务端重新验证作者，成功后仍是幂等关联；未复核不会显示“归属校验通过”。仅识别状态匹配的白名单错误码，从不回显服务端 `message`、响应正文或异常。UID 与动态 ID 共用无前导零的正整数字符串校验，最多 128 位，不转 Number。

前端接口的增量：

- `Dynamic.archive` 可选，保存独立标题、编辑时间/信号、正文状态、最近尝试、媒体来源、评论定位、本地计数、observed/synced 版本及分项工作。旧 mock Dynamic 无需增加这些字段。
- `Dynamic.commentCount` 继续表示来源评论总数；本地一级评论数使用 `archive.localCommentCount`，分开显示，未知为 `—`，零为 `0`。
- `DynamicReader.discussions = 'not-archived'` 明确本票生产讨论能力；`readComments/readReplies` 返回 `{status:'error',reason:'not-archived'}`（取消则返回 cancelled），不发 HTTP 请求。UI 显示“评论尚未归档；来源计数不代表本地已有评论。”，不虚构成功空讨论，也不显示无作用的排序按钮。
- `ManagementApi` 新增必需的 `listTargets/addTarget/deleteTarget`，没有可选接口或静默降级。旧单元测试使用真实生产管理映射，并修正指定模式的目标读取替身和过期提示断言。

发布时间接受北京时间到秒的 DTO，编辑时间接受北京时间到分钟的 DTO；显示编辑时间不补秒，发布时间缺失不拿编辑时间补值。非法日历时间按未知处理。

02 阶段的 `media_sources` 保留有序 URL/尺寸 metadata（来源允许 HTTP/HTTPS），但不映射到 `Dynamic.images`（20 阶段映射独立的 `media`，见文末）；未上传只显示图片待归档，不产生来源图的 `<img>` 或预览请求。头像单独按现有安全 HTTPS 规则与默认头像兜底。纯来源图没有虚构“暂无内容”；只有正文与图片来源都为空时显示该提示。

正文成功旧内容可以在最近读取失败/受限时继续阅读；正文状态、最后尝试、编辑未知/错误及正文/媒体/评论各自的工作状态分别表达，不把正文保存或观察版本冒充全部完成。成功空正文才显示“暂无内容”；受限/失败状态不与成功空混淆。

目标读取有 AbortController 与请求身份检查；目标写操作沿用按 UID 共享的 management requests 防重锁，并绑定目标组件生命周期。离开、切模式或组件生命周期清理使过期读取/写入结果失效；失败保留输入、旧目标及局部重试。旧 React 阶段包含 StrictMode 清理场景，Vue 重构保留失效保护契约，不沿用该框架专有机制或其历史测试作为新版证据。

列表顺序来自后端完整集合排序后的分页，前端不重排当前页或截断假分页。Adapter 拒绝超过请求批量、重复 ID、错误 cursor 类型等坏响应；分页失败保留已有内容并重试同一 cursor。

## Red → Green 证据

> 下方表格保留迁移前 React 实现的 TDD 过程证据（`tests/*.test.tsx`）；票据 12 已删除该栈及对应路径，
> 当前同等行为的单测在 `frontend/tests/unit/*.test.ts`，命令为 `cd frontend && pnpm test`。原文保留只为可追溯，
> 不再代表现有文件位置。

所有命令均先 `source ~/.nvm/nvm.sh && nvm use`，Node `24.21.0`、pnpm `10.34.6`。每次只执行一个测试文件。

| 片段 | 命令 | Red | Green |
| --- | --- | --- | --- |
| 首个归档映射 | `pnpm test tests/archive-reader.test.ts` | 缺少 archiveReader 模块，文件失败 | 1/1 通过 |
| 讨论能力 | 同上 | `discussions` 为 undefined，1 失败/1 通过 | 2/2 通过 |
| 基础阅读状态 | `pnpm test tests/archive-app.test.tsx` | 找不到分钟编辑提示，1 失败 | 1/1 通过 |
| 生产默认装配 | `pnpm test tests/production-assembly.test.ts` | 返回 mock 动态而非 HTTP 空归档，1 失败 | 1/1 通过 |
| 目标 API | `pnpm test tests/manage-target-api.test.ts` | `api.addTarget is not a function`，1 失败 | 1/1 通过 |
| 归属错误映射 | 同上 | 固定中文与实际通用错误不同，2 失败/1 通过 | 3/3 通过 |
| 目标管理页面 | `pnpm test tests/manage-target-page.test.tsx` | 找不到目标空集合提示，1 失败 | 1/1 通过 |
| 日历时间兜底 | `pnpm test tests/archive-reader.test.ts` | 2 月 30 日被当作有效时间，1 失败/2 通过 | 3/3 通过 |
| 批量上限 | 同上 | 11 条响应被当作十条请求成功，1 失败/3 通过 | 4/4 通过 |
| 来源 HTTP metadata | 同上 | 来源 HTTP 图使正文读取失败，1 失败/6 通过 | 7/7 通过 |

本地过程日志：`/tmp/02-*-red.log`、`/tmp/02-*-green.log`。首次页面测试另修正过 RTL 对换行的空白规范化匹配，再确认真正的编辑提示缺失失败；没有将测试查询错误冒充功能 Red。

## 最终单文件回归

最终完整回归使用 `pnpm test --maxWorkers=2`，16 个文件、137 个测试全部通过；逐文件 TDD 记录如下。历史开发日志在 `/tmp/02-unit-final/`。

| 文件 | 通过数 |
| --- | ---: |
| archive-reader.test.ts | 8 |
| archive-app.test.tsx | 9 |
| production-assembly.test.ts | 1 |
| manage-target-api.test.ts | 4 |
| manage-target-page.test.tsx | 5 |
| manage-api.test.ts | 7 |
| manage-page.test.tsx | 10 |
| data.test.ts | 3 |
| comments-data.test.ts | 3 |
| replies-data.test.ts | 3 |
| image-data.test.ts | 1 |
| app.test.tsx | 19 |
| comments-app.test.tsx | 20 |
| replies-app.test.tsx | 14 |
| discussion-history.test.tsx | 18 |
| images.test.tsx | 12 |

生产 HTTP 替身只替换传输，未替换 DTO Adapter 或生产管理逻辑。新增回归覆盖 10/10/5 分页、原 cursor 重试、站内返回恢复多批、空/404/网络失败、安全文字、旧内容、纯来源图、受限/失败/编辑未知、身份兜底、目标正确/不符/未知、删除失败与防重、跨访问旧成功/错误及 StrictMode 旧目标读取隔离。目标集合跨页面重读由 HTTP 边界替身保留状态，**不是 SQLite 重启证据**。

- 开发过程中 6 次 `pnpm typecheck` 通过；最终类型检查另通过。
- `pnpm build` 通过；生成生产 bundle 有 `/api/archive/dynamics`，mock 正文标记“文字日记/图文日记/长评论”数量为 0。
- `pnpm exec vite build --mode mock --outDir /tmp/02-mock-build` 通过；独立 mock bundle 包含原 mock 夹具。
- 未在 02 前端任务执行 Playwright、真实上游、真实媒体上传、部署或真机测试；不据此声称整票完整验收通过。

## 13 增量：显式 scope 与最小路由

- `DynamicReader.readList` 必须传 `ArchiveScope = {kind:'all'} | {kind:'up',upId:string}`；生产 Adapter 与独立 mock 同契约，不再隐式以 `creator` 选择归档。`creator` 只保留为全部页标题的旧展示约定，各动态仍显示自己的实际 `author`。
- 全部请求 `GET /api/archive/dynamics?limit=10&scope=all`；单 UP 请求 `?limit=10&scope=up&uid=123`；cursor 原样编码。Adapter 检查单 UP 响应的作者 UID，拒绝串 scope 的数据，不共享列表缓存。
- `readUps({signal})` 映射 `GET /api/archive/ups` 的 `{ups:[{id,nickname,avatar_url}]}` 为 `User[]`，不读取监控启用名单；身份可空，未知不伪造。重复或非字符串身份 ID 拒绝为安全错误。
- `404 UNKNOWN_UP` 映射 `{status:'error',reason:'unknown-up'}`，显示“UP 不存在”；已知空成功显示“暂无动态”。详情 `404` 继续独立映射 `not-found`；其他网络/HTTP/DTO 失败显示局部读取失败，未知路由显示“未找到页面”。不回显错误正文。
- 带 cursor 的 `422 INVALID_INPUT` 映射 `invalid-cursor`，保留旧批并提示“分页已失效，请重新开始读取。”；仅显式“重新开始”请求无 cursor 首批，不自动恢复、假空或假结束。普通追加失败保留原 cursor，同批重试。
- 首读冻结完整 scope 的内容/顺序，后续插入/更新只对新首读可见，15 分钟 TTL 不续期；跨 scope/UP/资源及不同 limit 拒绝。完整服务端协议见 [archive-api.md](archive-api.md#分页一致性与-cursor)。
- `/` 和 `/ups/:upId` 均能直接打开、刷新、分页；最小身份链接导航使用持久身份。列表访问按页面访问 ID 与 scope 分隔，旧请求即使忽略取消也不能更新新访问或清掉其加载态。详情返回可追溯的单 UP 来源列表，未知来源仍安全返回首页。
- 这是最小可用路由，不交付 #14 的选择条、卡片重排或完整跨 scope 历史恢复；不触上游、初始化、评论或媒体采集。

13 的 T1/T2、真实 API→页面浏览器测试和可复现命令见 [13 验收记录](../../../.scratch/backend-integration/acceptance-13.md)；它们不代表部署、真实上游或真机通过。

## 16 增量：生产根评论 Adapter

### HTTP 与能力

- `readComments({dynamicId,sort,cursor,signal})` 只发 `GET /api/archive/dynamics/{id}/comments?sort=hot|latest&limit=20`；续页追加原样编码的 `cursor`。ID 保持字符串，不转 Number；非法父 ID、排序或 cursor 类型在传输前拒绝。
- `{items,next_cursor}` 映射为 `CommentBatch`，保持服务端给定顺序与边界，不在 Adapter 重排、预加载或自动拼接。45 条按服务端 20/20/5 读取；`nextCursor:null` 是结束，由调用方停止追加。评论快照不沿用动态列表的 15 分钟 TTL，完整契约见 [archive-api.md](archive-api.md#读取排序与-cursor-恢复)。
- 生产 Reader 不再设置全局 `discussions:'not-archived'`，根评论可读；独立设置 `replies:'not-archived'`。正常 `readReplies` 返回安全 `not-archived`，取消返回 `cancelled`，始终不发 HTTP。本增量不实现 #18 回复读取或 #22 评论图片读取。
- 只识别 HTTP `422` 与 `error.code:'CURSOR_INVALID'` 的组合为 `{status:'error',reason:'invalid-cursor'}`，不返回服务端 message。需由用户显式无 cursor 重读首批，不能自动续接新快照。其他 HTTP（含 404、503）、坏 JSON、DTO 或传输异常返回安全 `error`；普通失败可按原 cursor 重试，Adapter 不推进、缓存或替换标记。
- 已取消请求不发 HTTP；传输忽略取消后返回成功、错误、坏 JSON 或抛异常，仍优先返回 `cancelled`。访问与排序的迟到请求隔离仍是页面读取协调职责。

### DTO、安全与状态

- 一批最多 20 条，重复 ID、错误 cursor 类型、非法评论 ID、串动态的 `dynamic_id`、非根的 `root_id/parent_id`（必须为字符串 `"0"`）以及必需展示字段缺失/类型错误均整批拒绝，不部分成功或静默跳过。
- `author.id` 允许合法十进制字符串或 `null`。现有展示 `User.id` 仍为字符串，未知作者映射为 `''`（非合法来源 ID），绝不借用动态作者或全局 creator；只能以已知 ID 与当前动态作者比较 UP 标识，不按昵称比较。
- 可空 nickname/avatar/text/published_at 必须是字符串或 `null`；空白昵称映射 null。`text:null` 映射展示空字符串，真实空字符串保持为空，不补来源内容。HTML、emoji、换行与 URL 保持普通文本，不执行、不自动链接。
- `published_at` 为明确 `+08:00` 秒精度时间或 null；非法日历字符串安全映射 null，不拿其他时间补值。`like_count/source_reply_count` 必须为非负安全整数或 null，分别映射 `likeCount/replyCount`；未知不伪造零，不以本地回复数替代来源回复数。
- 头像只接受无用户名/密码的绝对 HTTPS URL；HTTP、javascript、data、协议相对地址及带凭据 URL 均映射 null。来源媒体仅检查 DTO 结构并映射 `pendingMediaCount`，不把来源 URL 暴露为图片、链接或预览，不发来源业务图片 HTTP；纯图评论文本仍为空，由 UI 显示图片待归档而非虚构无内容。`comment_locator` 为对象或 null，不用于本票回复请求。
- Archive 新增映射 `localReplyCount` 与 `rootCommentsLastAttempt`，保留 `localCommentCount`、来源 `commentCount` 及 `work.comments` 各自语义。旧冻结动态页可能没有新字段，未知回复数保持 null，未知根尝试状态不猜测。
- 评论 HTTP 成功批次没有归档状态字段：`200 {items:[],next_cursor:null}` 在 Adapter 是成功空读取，不证明完成采集。页面须结合详情根分项状态区分尚未归档与确认成功空，不以来源计数、本地零数或正文受限推断评论权限。正文 `contentState:'restricted'` 不阻断实际可读本地根评论；已有评论也不因最近根采集失败被抹掉。回复 `not-archived` 与正文 `restricted` 是不同能力/内容状态。

### Adapter seam 的 RED → GREEN

本子任务只改生产 Adapter、其传输契约测试及本文。HTTP 替身仅替换传输，不绕过生产 DTO 映射。命令先运行 `source ~/.nvm/nvm.sh && nvm use`；默认测试命令为 `pnpm test tests/archive-reader.test.ts`。

| 片段 | RED | GREEN |
| --- | --- | --- |
| 01 根评论能力与成功空 HTTP | 1 失败 / 7 通过 | 8/8 |
| 02 根评论 DTO 映射 | 1 失败 / 8 通过 | 9/9 |
| 03 nullable 作者/文本/时间/计数 | 1 失败 / 9 通过 | 10/10 |
| 04 hot/latest、20/20/5 与 cursor 编码 | 1 失败 / 10 通过 | 11/11 |
| 05 CURSOR_INVALID 状态匹配 | 1 失败 / 11 通过 | 12/12 |
| 06 必需展示字段严格 DTO | 1 失败 / 12 通过 | 13/13 |
| 07 传输前校验输入 | 1 失败 / 13 通过 | 14/14 |
| 08 独立 replies 能力 | 1 失败 / 13 通过 | 14/14 |
| 09 正文受限与根分项/本地数分离 | 1 失败 / 14 通过 | 15/15 |
| 10 纯图待归档数、安全 URL | 新片段 `-t '纯图根评论'` 1 失败 / 15 跳过 | 完整文件 16/16 |
| 11 媒体/locator DTO 结构 | 1 失败 / 15 通过 | 16/16 |

另外追加两项既有行为回归（普通失败同 cursor 重试、取消优先），直接通过，未虚报新增 RED。最终 `pnpm test tests/archive-reader.test.ts` **18/18 通过**，`pnpm typecheck` 通过；过程日志为 `/tmp/16-adapter-01-red.log` 至 `/tmp/16-adapter-11-green.log`，最终日志为 `/tmp/16-adapter-final-unit.log`、`/tmp/16-adapter-typecheck.log`。

上述仅为 Adapter 单元证据，不声称 RTL、浏览器、实际 SQLite/HTTP→详情、部署、真实上游或真机已经通过；这些由 #16 主票独立验收记录追踪。

## 17 增量：生产回复 Adapter

- `readReplies({dynamicId,rootId,limit,cursor,signal})` 只 GET `/api/archive/dynamics/{id}/comments/{root_id}/replies`，固定首3／续10，ID与 cursor 原样字符串编码；替换16阶段 not-archived stub，不隐式初始化或访问上游。
- 回复 DTO 整批校验父动态／根、字符串 ID、可空 parent、作者／目标、文本、时间、点赞、页大小和重复项，保持服务端顺序。未知目标作者为 replyTo:null，不创造空 ID 的 @ 用户；未知回复作者仍按既有 User 空ID语义，不冒用 UP。
- ReplyBatch 可选保留 sourceReplyCount、localReplyCount、repliesLastAttempt、syncedSourceReplyCount；来源未知／本地零／逐根失败独立。HTTP成功空 items 不证明采集成功，#18 页面须结合这些状态，不以本地零或来源数量推断。
- Archive 增量可选保留 work.replies、整轮／回复尝试及成功计数，旧冻结 DTO 缺字段仍可读。
- 无客户端 TTL；仅 HTTP422＋CURSOR_INVALID 映射 invalid-cursor，须显式重新开始，普通错误重试同批。取消优先，不回显异常秘密，不自动改 cursor、重读或预加载。
- T1 为真实 Adapter＋HTTP传输替身，覆盖3/13/23/25、计数／状态、缺关系、安全校验、取消、错误／原cursor重试。后端 T2/T3 与测试结果见 [17验收](../../../.scratch/backend-integration/acceptance-17.md)。#18 展开／收起／历史恢复、正式浏览器与真实来源仍另票。

## 18 增量：回复阅读与详情访问恢复

- 回复阅读复用原详情访问、讨论请求协调与展开模型；每根首读最多3条、每次追加最多10条，严格采用服务端顺序，不在页面另排或预取。来源零不创建回复读取区域；未知来源数仍允许读取本地归档，不补为零。
- 收起缩小可见范围至最多3条，并由页面在布局更新后将所属一级评论开头滚回可见位置，保留内容、cursor及正文展开；再展开优先复用已加载范围。定位是评论阅读的页面行为，不由 Adapter 请求或修改 cursor。终页不再请求。切根评论排序清空回复阅读状态；同动态每次主动访问都有独立快照，历史返回恢复该次排序、多批、回复/文字展开和cursor，再由既有阅读位置协调恢复锚点与位置。
- ReplyBatch的逐根归档状态和计数随读取状态一起保存，不因追加或历史返回丢弃。来源数、本地完整归档数与当前可见条数独立；未知显示`—`。成功空且归档成功显示“暂无回复”；pending、failed、unconfirmed分别提示未完成、最近失败、未确认，有本地内容仍可读。含计数但缺少尝试状态也按未确认表达；独立旧mock无归档元数据沿用其成功空语义。
- 不把 GET 成功或本地终页当作来源采集完成：回复终页不显示“回复已加载完毕”或“本地归档回复已读完”等结束提示，不再请求下一页；保留归档未完成、失败和空态提示，也不提供会触发采集的假重试入口。
- 普通首次/追加读取失败仅影响该根，追加保留内容和原cursor，重试原批；请求防重与访问/排序/父级身份隔离继续拒绝忽略取消的旧成功、失败和完成回调。`invalid-cursor`单独提示，仅用户显式“重新开始读取”才丢弃该根旧批/展开并无cursor重读3条；其他根及上方动态不重置。
- 回复保持只读、平铺、安全文本、可用回复目标与按动态作者ID标UP；没有新增写回、转发、回复图片或导航。自动化证据及未验证边界见 [18验收](../../../.scratch/backend-integration/acceptance-18.md)。

## 20 增量：动态图读取与预览

- 列表/详情的 `media` 映射到完整有序 `Dynamic.images`，不在 Adapter 截断九张；图片关联 ID 保持不透明字符串，尺寸未知为 null。保留逐图 `archiveStatus:pending|success|failed`，失败/未上传的位置仍能进入组内预览、切走或关闭。
- 成功图的 `public_url` 经绝对 HTTPS、无内嵌凭据校验后原样同时作为 `thumbnailUrl/previewUrl`；不拼域名、桶或处理参数、不代理、不续签。缩略图、原图预览及坏图重试统一使用 `referrerPolicy="no-referrer"`；这不改变 OSS ACL，若桶禁止空 Referer 或匿名读取，仍可能返回 403。未成功图即使意外带 URL 也不展示；无效公开地址局部提示“归档图片地址不可用”，不影响正文。浏览器加载失败独立显示“图片加载失败”，只重试原 URL，不调用媒体同步接口。
- `media_sources` 仍仅作来源元信息，`previous_media` 不混入当前组。仅接收当前动态 owner 的关联；异常关联（错误 owner、重复/缺失 ID 或非法状态）不进入展示组，不使正文读取失败。旧冻结 cursor 缺 `media` 时仍可读，只有来源元信息时保留待归档提示，不推断上传成功或回退来源图。头像外链规则不变。
- 复用现有网格、预览与导航：列表最多九格并提示剩余数，详情及预览可访问整组；缩略懒加载、预览仅挂载当前图。预览会话显式包含 owner 类型/ID、整组、序号、底层访问及触发元素 ID，供 #22 接评论 owner，不实现评论/回复图。
- 同 URL 只新增一条预览历史，切图/长图模式只改内存；后退关闭、前进恢复有效预览，刷新仅替换清理失效标记。沿用焦点约束、滚动锁和有界阅读恢复，不另造导航或自动滚动层。
- 当前公开图没有生成尺寸变体，缩略与预览共用 URL。CSS 缩小、懒加载和 OSS 均不证明压缩或性能达标。T1 生产 Adapter/受控图片与少量 T2 实际 API/SQLite 浏览器证据、父 #06 对照及未验证项见 [20 验收记录](../../../.scratch/backend-integration/acceptance-20.md)。

## 22 增量：一级评论图片阅读

- 根评论 `media` 使用与动态图相同的逐图映射，只接收 `owner.type:'comment'` 且 `owner.id` 等于当前根评论 ID 的关联。保持服务端顺序及完整组，不截断九张、不混入 `previous_media`、动态、其他评论或回复图；回复展示模型不包含 `images`。
- `Comment.images` 可选，逐图保留不透明关联 ID、可用宽高、`archiveStatus` 和安全公开 URL。成功图的 URL 原样用作缩略/预览；pending/failed 即使带地址也不请求，坏公开地址局部降级。浏览器加载失败只重试原 URL，不调用 `/api/sync`，不冒充服务端上传重试。
- 旧冻结 DTO 缺 `media` 仍可读；`pendingMediaCount` 表达尚无可展示关联的来源数量（来源数减去有效当前关联数，最少零），不暴露来源 URL。当前媒体的 pending/failed 由每张图单独表达，不再把整组成功图片误报为待归档。§16 的全来源计数是当时尚无图片映射的历史契约；本增量保留字段兼容旧调用方，但它不再表示当前组逐图上传 pending 的总数。
- 详情评论复用 `ImageGrid`，单图保持比例、四图两列、其他多图三列，全部缩略/预览可访问；无图不创建图片区，纯图不补“暂无评论内容”，连未上传图也保留其有图片的语义。只有正文和当前图/来源存在性都空时才显示空文案。
- 图片入口传递 comment owner、完整组、所点序号及触发元素；沿用 #20 唯一导航/预览协调器、同 URL 历史、长图/手势、滚动锁及焦点后备，不新增评论页、回复图、真实写回、下载或自由缩放。
- T1/T2 证据与父 #07/#21 对照见 [22 验收记录](../../../.scratch/backend-integration/acceptance-22.md)。公开图仍未生成尺寸变体，模拟触控不替代 #33 真机，模拟 OSS 不替代 #34 实际云验证。

## 一级评论置顶

- `RootComment.is_pinned` 映射为 `Comment.isPinned`；旧 DTO 缺字段按未置顶处理，非布尔值拒绝为安全读取错误，不从作者或点赞数推断。
- 最热、最新都由后端先对完整集合做置顶优先排序再分页；生产 Adapter 原样保留服务端顺序，mock 也采用相同优先级。置顶计入每批 20 条，不在客户端单独插入或重复展示。
- 评论作者旁显示“置顶”标识。切换排序、分页及历史恢复沿用原模型；旧 cursor 内容和顺序仍冻结，补采置顶只影响新的首批。已有启用目标会在后续采集补齐元信息，停用目标不会被读取页面隐式采集。
- 本次按用户要求不运行验证；历史评论验收记录不覆盖这一增补。

## 26 增量：评论计数与同步状态

- `ArchiveMetadata.commentSync` 保存归档 DTO 的 `comment_sync` 最新持久 checks 投影；生产归档 Adapter 和管理 Adapter 共用严格解析。旧冻结响应缺失或 null 保留未知；错目标、非法枚举/时间/计数/错误码拒绝为安全读取错误，不回显任意原文。
- 详情评论区仅保留标题评论数、排序及评论内容，不展示来源/本地/当前加载数的汇总面板、同步状态时间及策略说明。标题优先使用已有检查投影中的来源总数，未知 `—`、零 `0`，整数不缩写；不把来源数当作本地已归档条数。
- 移除详情中的“读取评论同步状态”按钮及提示区域，不额外重读详情。分页继续只追加本地读取快照；终页隐藏加载更多按钮，不显示“本地归档评论已读完”或“评论已加载完毕”。排序、cursor、展开和阅读恢复规则不变。
- 保留评论未归档、成功空、读取失败和逐图待归档/失败提示。只有评论文本成功不表示图片归档完成，归档 GET 成功也不表示采集完整；管理页仍可读取完整同步状态。
- Adapter 与后端同步字段保持不变，状态判定及管理诊断仍使用实际 checkpoint，未知成功时间不补造。后端字段契约见 [采集契约](collector-api.md#26-评论分项状态与时间)；[26 验收](../../../.scratch/backend-integration/acceptance-26.md) 为当时界面的历史证据，不覆盖本次精简修改，本次按用户要求未运行验证。

## 飞书通知 03 增量：楼中楼回复精确入口

- 链接：`/dynamics/{dynamicId}/comments/{rootId}/replies/{replyId}/locate`。三个身份都是 URL 路径里的十进制字符串，不含凭据；直开、刷新、宽窄屏与历史返回都走这同一条链接，不依赖旧会话或已加载的 DOM。04 在消息中使用该链接。
- 分支：宽屏在动态详情内复用原回复区（不另建评论阅读器），窄屏复用原独立楼中楼页。两条分支由同一链接决定，页面组件只按既有 640px 断点选择，不改变原有入口行为。
- 读取：`DynamicReader.locateReply({dynamicId, rootId, replyId, signal})` → `GET /api/archive/dynamics/{id}/comments/{root_id}/replies/{reply_id}/location`（无 query）。返回 `{items, nextCursor:null, page, count, root, ...}`，`items` 就是目标所在页，`page` 由服务端按目标位置给出。
- 结果语义：`{status:'not-found'}` 只表示目标回复不存在或未归档（HTTP 404、非法身份）；传输异常、非 200、DTO 不合法、页码缺失或**目标不在这一页**都是 `{status:'error'}`（可重试）；取消优先返回 `cancelled`。绝不把楼层第一页或页首当作定位成功。
- 宽屏行为：先用 02 的一级评论定位读取取“含所属根评论”的批次（因此目标根评论在后续批也能显示），再由该根的回复区以目标身份读一次定位；不先读 3 条预览，也不先读第 1 页。目标正文默认展开，加高亮标记（`data-located`／`aria-current`）并定位到该条；分页停在目标页，后续翻页仍是原页内替换；收起回到 3 条预览首屏（按需补读预览）并把所属根评论定位到开头。所属根评论在回复精确定位时只作上下文，不单独高亮或抢占滚动。
- 窄屏行为：独立楼中楼页的首个读取改为定位，直接显示目标所在页与高亮条目，不再先读第 1 页也不先滚到页面顶部；页头数量、根评论上下文、分页与返回规则不变。
- 返回与历史恢复：与 02 同属详情族访问。宽屏按访问身份保存含所属根批次、回复区展开、保存页码与阅读位置；返回或历史恢复时按该快照还原（回复区按保存页码实时重读，不重新按目标身份定位），只有新访问才重新定位。窄屏精确根入口进入独立楼中楼时该访问即为其详情来源，返回回到原精确访问而不是替换成普通详情顶部；直达/刷新进入的楼中楼仍无来源，返回仍 replace 到对应动态详情。
- 异常：目标不存在显示固定提示与“返回动态”入口（替换为对应详情，不留下不可用地址）；临时失败显示既有读取失败与局部重试（重试重发定位，不猜页码）。用户已滚动或离开后迟到的定位结果不抢滚动、不污染新的目标或详情。
- 证据：前端单元测试 `tests/unit/archive-reader-replies.test.ts`、`tests/unit/reply-reading.test.ts`、`tests/unit/thread-reading.test.ts`、`tests/unit/locate-return.test.ts`；生产装配 + 归档 HTTP 替身 `tests/e2e/reply-location.spec.ts`（桌面）、`tests/e2e/reply-location-thread.spec.ts`（Pixel 7 视口）与 `tests/e2e/locate-return*.spec.ts`（返回/恢复、图片预览返回、排序切换受控延迟）；实际 API + 隔离 SQLite `tests/e2e-location/reply-location.spec.ts`（`pnpm test:e2e:location`）。汇总见 [03 证据](../../../.scratch/feishu-notifications/evidence/03-reply-deep-link.md)。

## 飞书通知 02 增量：精确一级评论入口

- 链接：`/dynamics/{dynamicId}/comments/{rootId}/locate`。动态与目标评论身份都是 URL 路径里的字符串 ID，不含凭据；直接打开、刷新、宽窄屏与历史返回都走这同一条路由，不依赖旧会话或已加载的 DOM。03 将按同一形状扩展为楼中楼回复入口，04 在消息中使用该链接。
- 读取：`DynamicReader.locateComment({dynamicId, rootId, sort, signal})` → `GET /api/archive/dynamics/{id}/comments/{root_id}/location?sort=hot|latest`（批量固定 20，不带 cursor/limit）。返回 `{items, nextCursor, prevCursor, earlierCount}`，第一项必须是目标评论（否则按 `error` 处理）；`prevCursor`/`earlierCount` 缺省视为“没有更早”。
- 结果语义：`{status:'not-found'}` 只表示目标不存在或未归档（HTTP 404、非法身份）；传输异常、非 200 其他状态、DTO 不合法或响应窗口里没有目标都是 `{status:'error'}`（可重试）；取消优先返回 `cancelled`。绝不把页首或邻近评论当作定位成功。
- 页面行为：首批直接使用定位批次（不先读首批、不渲染全部评论），目标正文默认展开、加高亮标记（`data-located`／`aria-current`）并定位到该条；后续“加载更多评论”沿用定位批次的 `next_cursor`。目标之前还有评论时，列表顶部显示“以上还有 N 条更早评论”与“加载更早评论”：点一次读 `prevCursor` 那一批并**插到最前面**，不重开定位、不重读目标；插入后按锚点评论的位移分帧补回滚动位置（原生滚动锚定已补偿时只补差额），连续两帧稳定即结束。向前读只改写 `prevCursor`/`earlierCount`，**不改写** `nextCursor`；读到开头时提示与按钮消失；失败保留已读批次并给可重试提示。目标不存在显示固定提示与“返回动态”入口（替换为对应详情，不留下不可用地址）；临时失败显示既有读取失败与重试。用户已滚动后迟到的定位结果仍高亮目标但不抢滚动，定位意图只消费一次。
- 排序切换仍以同一目标为首批锚点重新定位；普通详情入口与评论区入口行为不变（无锚点时不请求定位端点、不高亮）。
- 返回与历史恢复：精确入口是同一次详情阅读的访问，不是另一种页面。应用导航把 `/dynamics/{id}`、`/comments/{rootId}/locate`、`/replies/{replyId}/locate` 视为同一详情族，按访问身份保存详情快照（已读批次、排序、展开与阅读位置）并记录楼中楼来源；因此从精确入口进入独立楼中楼再返回、前进后退回到该访问、以及同 URL 的图片预览关闭，都沿用原快照还原并保持位置，不再重新执行主动定位。只有直开、刷新与同一链接的新访问没有快照，才按 URL 主动加载、定位并高亮。
- 证据：前端单元测试 `tests/unit/comment-reading.test.ts`、`tests/unit/archive-reader-comments.test.ts`、`tests/unit/locate-return.test.ts`；生产装配 + 归档 HTTP 替身 `tests/e2e/comment-location.spec.ts`（桌面与 Pixel 7）与 `tests/e2e/locate-return*.spec.ts`（返回/历史恢复、图片预览返回）；实际 API + 隔离 SQLite `tests/e2e-location/comment-location.spec.ts`（`pnpm test:e2e:location`）。汇总见 [02 证据](../../../.scratch/feishu-notifications/evidence/02-root-comment-deep-link.md)。
