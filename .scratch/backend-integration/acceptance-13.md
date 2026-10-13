# 13：全部／单 UP 归档读取链路验收记录

## 交付边界

来源：[13 票据](issues/13-scoped-archive-reading.md)、[集成规格](spec.md)、[执行计划共同要求](implementation-plan.md#所有执行子票的共同交付要求)、SRS 与 HLD。复用 #02 的归档写入、身份、持久分页及生产 Reader，交付 HTTP→Adapter→`/` / `/ups/:upId` 最小页面，不宣称父 #03 或 #14 的完整选择条、卡片改版、跨 scope 历史恢复完成。

测试边界由票据明确指定：真实 SQLite→HTTP（T2）、生产 Reader 传输契约及公开路由（T1）、实际 API→生产 Reader→浏览器。优先经 MCP CodeGraph 定位并核验实时文件，调研用 Explore，后端实现独立委派。未操作真实 Cookie、上游、OSS 或部署。

## 协议与实现

- [API 协议](../../docs/backend/api/archive-api.md)：显式 `scope=all|up`，up 必须带合法字符串 `uid`，旧省略 scope 请求兼容 all；身份 `/api/archive/ups` 来自全部持久身份，包括已知空身份及停用／删配置的 UP。未知 UP `404 UNKNOWN_UP`，详情本地不存在仍是独立 `404 NOT_FOUND`。
- 全局完整集合及单 UP 集合分别按发布时间降序、字符串 ID BINARY 升序分页，null 时间后置，编辑时间不补发布；身份/动态 ID 是必需字段，不存在合法的“缺失 ID”记录。两 UP 25 条真实 SQLite fixture 验证全局 10/10/5、并列 `"10" < "2"`、双方 null 时间、各 UP 独立顺序。
- 首批短事务冻结完整 scope 的内容与顺序；期间插入、更新时间/正文只在新首批可见。cursor 持久、绑定资源/scope/UID/固定排序/limit，首批起 15 分钟不续期；重读及重开同批，跨 scope/资源或过期明确 422。沿用 v5 schema，固定旧 v5 文件验证全局旧 cursor 兼容。
- [客户端契约](../../docs/backend/api/archive-api-client.md#13-增量显式-scope-与最小路由)：生产和独立 mock 的 `readList` 都必需 scope；单 UP 响应校验 author，不共享列表缓存。分页失败保留原 cursor，显式失效提示和重新开始；结束无追加按钮。页面访问 ID + scope 隔离请求与数据，受控 Reader 忽略取消的旧成功/失败/异常/完成不能污染新访问或清空其加载态。
- 最小持久身份链接导航、全部/单 UP/详情直达和刷新、详情返回可追溯来源列表均可用；网络错误、未知 UP、已知空、本地详情不存在与未知路由分别表达。卡片继续使用实际 author；来源/本地计数、未知/零、编辑/发布时间不混同。生产评论仍明确未归档，媒体不把来源图冒充本地图片。

## TDD 与定向回归

先 `source ~/.nvm/nvm.sh && nvm use`（Node 24.21.0、pnpm 10.34.6），Python 仅 uv。新能力按逐片红绿推进；既有正确行为只加回归，不人为破坏实现制造 Red。

| 片段 | Red | Green / 回归 |
| --- | --- | --- |
| `tests/scoped-reader.test.ts` 生产 scope/身份 | 缺少 `readUps` | 通过 |
| 同文件独立 mock scope/cursor | 缺少 mock `readUps` | 通过 |
| 同文件错误区分 | 未返回 `unknown-up` reason | 通过 |
| 审查后 mock 身份顺序/输入语义 | 身份仍按插入顺序返回 | 4/4 通过；生产和 mock 非法 UID/limit 均为普通安全 error |
| `tests/scoped-app.test.tsx` 最小路由 | `/ups/123` 未找到页面 | 通过 |
| 同文件未知 UP | 页面只显示通用错误 | 通过；未知路由查询文案另修正，未将查询错误冒充产品 Red |
| 同文件 cursor 失效 | 缺少失效提示/重新开始 | 通过 |
| 同文件旧请求竞态、单 UP 原批重试 | 首次绿，复用请求身份保护 | 8/8 通过 |
| 实际 API→页面 | `UNKNOWN_UP` 与 Adapter 原错误码不一致 | 修正白名单后归档 E2E 2/2 通过 |
| 旧 mock 浏览器键盘流程 | 新增导航链接改变首控件，原测试焦点假设失败 | 更新为先验证导航 Tab 顺序再验证展开/详情，全量 102 通过 |

后端逐片红绿、31 项新增 T2 及限制见 [后端专项证据](evidence/backend-acceptance-13.md)。前端定向反复执行 `pnpm test tests/scoped-reader.test.ts`、`tests/scoped-app.test.tsx`、`tests/archive-reader.test.ts`、`tests/archive-app.test.tsx`、`tests/data.test.ts`、`tests/app.test.tsx`，期间定期 `pnpm typecheck`。首次类型检查揭示旧 readList 调用缺少必需 scope，已迁移并保留原断言。

## 最终完整回归

| 可复现命令 | 结果 |
| --- | --- |
| `pnpm test --maxWorkers=2` | 18 文件，149/149 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过，生产装配保持真实 ArchiveReader |
| `uv run pytest backend/tests -q` | 156/156 通过；Starlette/anyio 弃用 warning 1 项 |
| `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY pnpm test:e2e:archive` | 2/2 通过，含 #02 独立详情不存在回归 |
| `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY pnpm test:e2e:manage` | 2/2 通过，保留管理/真实 SQLite 回归 |
| `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY pnpm test:e2e` | 102 通过，10 项仅 Nginx 的历史测试按配置跳过 |

一次将完整 Vitest 与多套浏览器回归并发执行时，既有 discussion-history 的单项超过默认 5000ms 超时（148 通过、1 超时）；未修改测试或放宽超时，停止并发后单文件 18/18 与完整 149/149 均通过。建议完整回归串行执行。

本机代理会让 Playwright 本地服务探测误报 4177 被占用，以上移除代理后执行；未杀用户进程或复用未知服务器。临时过程日志在 `/tmp/13-*`，不是持久证据的唯一来源；行为与预期已保存在测试文件，命令可重现。

真实归档浏览器装配 `tests/e2e-archive/scoped_live_app.py` 通过生产 Store 写入 25 条有限虚构正文到临时 SQLite，上游 transport 明确禁止访问，运行真实 Uvicorn、生产 API、生产 DTO Adapter 和页面。覆盖两 UP 共 25 条全局 10/10/5、单 UP 10/3、全局/单 UP/详情刷新、详情返回来源、未知/空/详情404/路由不存在/网络失败、停用/删配置后 API 重开及身份导航；不是拦截 API 的 UI mock。另保留 #02 结构真实的 HTML/JSON 初始化 fixture 回归。

## 未验证与限制

没有真实上游、媒体/评论采集、周期调度、生产 Nginx 部署、Linux 品牌 Chrome/iPhone Safari 真机、2GB 容量或长期运行证据。移动 Chromium 仅模拟；Nginx 专属测试的跳过不等于通过。整集合持久快照保留既有内存/写竞争成本及墙钟同步假设。#14 完整 UI 和历史恢复仍是后续工作，#03/#12 不自动收口。

## 双轴审查

基点为开工前 `d5ca4e9d59a79558718c87a91cd0b96c6193adfc`，两轴均使用 `review` 子代理并行审查。尚未提交时采用 `git diff --cached <基点>` 覆盖全部暂存 WIP（提交列表为空），不是仅审查 tracked 的局部差异。

### Standards

未发现硬性规范违反。报告 2 项 mock/生产差异观察和 5 项判断性启发式：mock 不模拟传输错误、由作者补身份；列表路径两处维护、传输 URL/顺序断言、generic fetcher 替身、setter 命名、后端测试断言粒度。

处理：对齐 mock 的列表输入校验，并将 `retry` setter 改名 `setAttempt`。mock 的安全 error 联合本来可表达普通失败，独立静态 mock 不必虚构网络故障；归档外键保证每条生产作者有持久身份，fixture 作者补入身份符合该约束。URL/批次重试断言正是票据指定的公开传输 seam；未为启发式大规模改造既有 Adapter 或拆散真实多步 HTTP 场景，路由与来源识别沿用现有会话结构。

### Spec

未发现能力缺失或范围外增加。提出 2 项低风险语义建议：非法 UID 不应归为 `unknown-up`，mock 身份应按 ID BINARY 升序。均以新增公开 Reader 回归先红后绿修正，同时对齐 mock/生产列表批量输入校验；修正后定向 4/4、完整 149/149、全部浏览器回归与类型/构建均通过。

总结：Standards 0 硬性违反、7 项观察/判断（命名已修，其余按边界处理）；Spec 2 项建议已修，0 项未解决交付缺陷。
