# 02 归档列表与 scope 浏览证据

- 对应票据：[02: 在 Vue 中浏览全部及单 UP 归档](../issues/02-archive-scope-browsing.md)
- 对应规格：[前端重构实施规格](../spec.md) 第 9–15、25、27 条与「必须覆盖的场景」中的读取完整性、竞态、阅读、导航与 scope、响应式及装配条目
- 实现位置：`frontend/src/data/`、`frontend/src/dynamics/`、`frontend/src/pages/ListPage.vue`、`frontend/src/app/session.ts`
- 证据状态：**Linux Chromium 自动化通过；真实 API/SQLite、iPhone Safari 与新版视觉签收未在本票执行。**

## 1. 本票交付

| 区域 | 内容 |
| --- | --- |
| 数据层 | 复用固定代码基线的纯 TypeScript 契约与生产 Adapter（`contracts`、`identifiers`、`guards`、`timestamp`、`checkStatus`、`archiveReader`），由 `pnpm check:data-parity` 守卫与根 `src/data` 不漂移；页面只消费 `Dynamic`/`DynamicBatch`，不解析 DTO、不推导 cursor、不拼 OSS 地址 |
| 会话装配 | `src/app/session.ts` 在应用根部注入唯一 `DynamicReader`；`src/app/reader.ts` 默认创建真实 API Adapter，mock/fault 使用 25 条受控归档与首次失败计划，普通构建由 `check:isolation` 断言不含这些数据；测试用 `createSessionPlugin` 注入独立实例，无 Pinia、请求缓存或跨测试单例 |
| 列表读取 | `useListRead` 按 10 条 cursor 追加；同批请求阻塞、失败保留原批、按 id 去重、结束不再请求；访问结束（卸载/scope 重建）后迟到成功、失败与完成回调一律丢弃 |
| scope | `/` 为全部，`/ups/:upId` 为单 UP；`ListVisit` 以 scope 为 key 重建，导航条读取已保存身份，不按当前监控配置过滤 |
| 页面 | 默认全部动态；UP 选择条可切全部/单 UP；作者与头像（含本地默认头像）、发布时间、来源评论计数、零/未知语义；正文纯文本、6 行实测折叠；Element Plus 按钮承担加载/重试/折叠操作 |
| 错误与空态 | 未知 UP、已知 UP 空归档、读取失败、cursor 失效、追加局部失败分别表达；失败不回显响应内容 |

本票不渲染动态图片（缩略图与预览组合由 04 交付），也不包含详情、评论、回复与管理页面（03、05–11）。纯图动态在本票不伪装“暂无内容”，但暂无缩略图，属于中间状态，不据此宣称完整迁移完成。

## 2. 确定性规则与实现位置

| 规则 | 位置 | 说明 |
| --- | --- | --- |
| 列表批次固定 `limit=10`，cursor 原样传递 | `src/data/archiveReader.ts`、`src/dynamics/useListRead.ts` | `scope=all` 与 `scope=up&uid=` 两种请求；cursor 只由服务端返回 |
| 同批不并发、失败重试同一 cursor | `useListRead.ts` | 请求句柄存在时直接返回；失败只改状态，不清空已加载批次 |
| 去重 | `useListRead.ts` | 以本访问已见 id 过滤，跨批与批内重复都只保留一次 |
| 迟到回调隔离 | `useListRead.ts` + `ListVisit` 的 scope key | 先校验访问存活、请求身份与 `signal.aborted`；卸载后旧回写不触达新访问 |
| cursor 失效 | `archiveReader` 映射 422 `INVALID_INPUT` → `invalid-cursor` | 页面保留旧批，提供“重新开始”；普通 404/422 仍是一般错误 |
| 未知 UP | Adapter 映射单 UP 404 `UNKNOWN_UP` | 页面显示“UP 不存在”，不显示“暂无动态” |
| 停止监控后的归档 | `ArchiveNavigation` 只读 `/api/archive/ups` 身份 | 不按监控配置过滤；`/ups/:upId` 直接读取归档，不要求出现在导航条 |
| 6 行折叠 | `FoldableText.vue` | `scrollHeight > 6 × lineHeight + 1px`；`ResizeObserver` 在宽度变化后重测；不足 6 行不出按钮 |
| 计数与时间 | `display.ts` | 零显示 `0`，未知显示 `—`；时间固定 Asia/Shanghai，非法/缺失显示“时间未知” |
| 安全文本 | Vue 文本插值 + `white-space: pre-wrap; overflow-wrap: anywhere` | 换行、emoji、长 URL、HTML 均按纯文本展示；不渲染编辑时间或归档统计面板 |
| 只读边界 | 页面只调用 `readUps`/`readList` | 无采集、上传或写操作入口 |

## 3. 自动化结果

在 `frontend/` 下执行，环境与 01 证据一致：Linux CachyOS、Node 24.21.0、pnpm 10.34.6、
Vue 3.5.44、Vue Router 4.6.4、Element Plus 2.14.7、Vitest 4.0.18、Playwright 1.58.2（Chromium headless，桌面与 Pixel 7 两个项目）。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（vue-tsc 覆盖 `.vue` 模板与 TS） |
| `pnpm test` | 34 passed：Adapter 契约 7 + 列表页面行为 10 + 既有 17 |
| `pnpm test:e2e` | **78 passed / 10 skipped**（既有壳/预览 66 + 本票列表 12；列表跑生产装配 + HTTP 传输替身，其余跑 mock 装配；跳过项是需要触摸环境的窄屏手势用例） |
| `pnpm test:e2e:production` | 3 passed / 3 skipped（生产六路由、404、无自检入口；fault 装配首次列表失败后重试恢复；无后端时生产列表进入可重试错误态） |
| `pnpm build` / `pnpm build:mock` / `pnpm check:isolation` / `pnpm check:data-parity` | 均通过；隔离检查确认 `dist` 无 mock 入口、图片夹具与 mock 归档标记 |

新增自动化覆盖：

- `tests/unit/archive-reader-list.test.ts`：scope URL 与 cursor 编码、未知 UP/普通失败/失效 cursor、超批量/重复 ID/坏 DTO、取消优先、缺失时间与计数、来源图不冒充归档图、UP 身份去重与失败。
- `tests/unit/list-page.test.ts`：25 条 10/10/5、去重、同批双击只读一次与同 cursor 重试、切换 scope 后迟到成功/失败隔离、cursor 失效与重新开始、未知 UP/空归档/失败、已移除配置的 UP 仍可读、UP 身份列表失败可单独重读、安全文本与计数/时间、卡片链接与选中文字不导航。
- `tests/e2e/list.spec.ts`（desktop + Pixel 7）：10/10/5 与请求 URL、四视口（360/390/768/1280）无页面横溢且 UP 条只在内部横滚、6 行折叠随宽度变化、错误/空/未知与重试、cursor 失效与 scope 切换、键盘 Enter 进入详情、普通读取只发 GET `/api/archive/*`。

浏览器列表测试在独立的生产装配端口（4320）用 Playwright 拦截 `/api/archive/**` 替换 HTTP 传输，仍经过生产 Adapter 的 DTO 映射；mock/fault 装配自带受控归档，不被传输替身绕过。没有为测试新增业务接口。

## 4. 顺带修正：刷新遗留预览标记

全量 E2E 暴露既有预览协调器的一个时序缺陷：刷新后清理损坏标记的 `router.replace` 与初次导航并发，
可能出现主栏为空、`history.state` 仍保留旧标记。已在 `src/preview/useImagePreview.ts` 改为等待 `router.isReady()`
后再清理，并保留“仅当标记仍无效时替换”的复核；`preview-history.spec.ts` 24 项恢复全绿。
该修改属于 01 预览层稳定性修正，不扩大图片行为范围。

## 5. 未验证与边界

- **真实 API + 隔离 SQLite**：本票未启动后端，页面/Adapter 结论来自 HTTP 传输替身与确定性夹具；真实协议贯通仍按规格在后续集成回归执行。
- **iPhone Safari**：列表页只在 Linux Chromium 桌面与 Pixel 7 模拟项目验证；正式设备结论留待 15。
- **新版视觉签收**：列表页面当前样式未由用户确认，不作为视觉回归基准（14）。
- **mock/fault 手工检查**：`pnpm dev:mock` 已有 25 条模拟归档，`pnpm dev:fault` 首次列表失败后可重试；本票以自动化覆盖装配隔离，未做逐视口手工巡检。
- **图片、详情、评论、回复、管理**：分别由 03–11 交付；本票不据此宣称六条页面或统一上线完成。
