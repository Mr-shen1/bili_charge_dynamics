# 02 票：前端归档读取与指定目标

本说明仅记录前端实现与 T1 证据，不代表后端 SQLite、上游协议、部署或真机验收通过。

## 装配与边界

- 默认开发、构建和测试的 `#assembly` 指向 `src/data/productionAssembly.ts`，使用真实 `createArchiveReader()`。
- `src/data/assembly.ts` 保留独立 mock；显式 `pnpm dev --mode mock` 或 `pnpm build:mock` 才装配它。
- `pnpm dev:fault` 的开发故障装配保持不变。普通生产构建不包含故障入口或 mock 动态数据。
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

`TARGET_AUTHOR_MISMATCH`/409 映射“动态作者与所选 UP 不符”；`TARGET_UNVERIFIED`/502 映射“无法确认动态归属”。重复目标提交也由服务端重新验证作者，成功后仍是幂等关联；未复核不会显示“归属校验通过”。仅识别状态匹配的白名单错误码，从不回显服务端 `message`、响应正文或异常。UID 与动态 ID 共用无前导零的正整数字符串校验，最多 128 位，不转 Number。

前端接口的增量：

- `Dynamic.archive` 可选，保存独立标题、编辑时间/信号、正文状态、最近尝试、媒体来源、评论定位、本地计数、observed/synced 版本及分项工作。旧 mock Dynamic 无需增加这些字段。
- `Dynamic.commentCount` 继续表示来源评论总数；本地一级评论数使用 `archive.localCommentCount`，分开显示，未知为 `—`，零为 `0`。
- `DynamicReader.discussions = 'not-archived'` 明确本票生产讨论能力；`readComments/readReplies` 返回 `{status:'error',reason:'not-archived'}`（取消则返回 cancelled），不发 HTTP 请求。UI 显示“评论尚未归档；来源计数不代表本地已有评论。”，不虚构成功空讨论，也不显示无作用的排序按钮。
- `ManagementApi` 新增必需的 `listTargets/addTarget/deleteTarget`，没有可选接口或静默降级。旧单元测试使用真实生产管理映射，并修正指定模式的目标读取替身和过期提示断言。

发布时间接受北京时间到秒的 DTO，编辑时间接受北京时间到分钟的 DTO；显示编辑时间不补秒，发布时间缺失不拿编辑时间补值。非法日历时间按未知处理。

`media_sources` 保留有序 URL/尺寸 metadata（来源允许 HTTP/HTTPS），但不映射到 `Dynamic.images`；未上传只显示图片待归档，不产生来源图的 `<img>` 或预览请求。头像单独按现有安全 HTTPS 规则与默认头像兜底。纯来源图没有虚构“暂无内容”；只有正文与图片来源都为空时显示该提示。

正文成功旧内容可以在最近读取失败/受限时继续阅读；正文状态、最后尝试、编辑未知/错误及正文/媒体/评论各自的工作状态分别表达，不把正文保存或观察版本冒充全部完成。成功空正文才显示“暂无内容”；受限/失败状态不与成功空混淆。

目标读取有 AbortController 与请求身份检查；目标写操作沿用按 UID 共享的 management requests 防重锁，并绑定目标组件生命周期。离开、切模式或 StrictMode 清理使过期读取/写入结果失效；失败保留输入、旧目标及局部重试。

列表顺序来自后端完整集合排序后的分页，前端不重排当前页或截断假分页。Adapter 拒绝超过请求批量、重复 ID、错误 cursor 类型等坏响应；分页失败保留已有内容并重试同一 cursor。

## Red → Green 证据

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
- 未在本任务执行 Playwright、真实上游、真实媒体上传、部署或真机测试；不据此声称整票完整验收通过。
