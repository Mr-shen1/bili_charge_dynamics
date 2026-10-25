# Vue 前端

技术栈：Vue 3 + TypeScript + Vite + Vue Router + Element Plus，继续静态 SPA 交付。票据 12 已把完整阅读与管理流程收敛到本应用，
并删除废弃 React 栈（含 React Router、RTL 适配、旧组件、旧夹具素材与专用构建配置）；仓库里只剩这一套前端实现。
**已交付范围以本文件「已交付」一节为单一来源**，其他文档只保留指针与证据链接。
票据 14–17 已完成：视觉签收、真机验收、隔离静态交付与上线就绪汇总。17 的结论是**可申请统一上线**，
但部署须另行授权；其中输入框字号按用户裁决保持库默认 14px，iOS 聚焦放大（F-15-02）作为已知限制记录。13 的协议回归只证明自动化与隔离集成。

## 已交付

| 票据 | 交付内容 |
| --- | --- |
| 02 | 全部/单 UP 归档列表读取：scope 切换、10 条 cursor 追加、折叠、错误/空态与 Element Plus 控件 |
| 03 | 动态详情与阅读恢复：主动入口定位、按历史访问恢复批次/展开/位置，同一动态多访问互不覆盖 |
| 04 | 动态图片阅读：完整图片组、缩略懒加载、原生预览、异常状态与历史恢复 |
| 05 | 一级评论阅读：默认最热、20 条 cursor 追加、排序切换重置与定位、讨论快照恢复、状态区分与折叠 |
| 06 | 宽屏回复：3 条 cursor 预览、展开后每页 10 条实时页码、收起定位与页码/文字快照恢复 |
| 07 | 窄屏 UP 回复预览入口与独立楼中楼：正来源数才给入口、每页 10 条实时页码、返回详情/无来源 replace、重挂载回首屏 |
| 08 | 一级评论图片阅读：每条根评论独立图片组、完整组可达、异常状态与重试、预览历史与阅读状态保护 |
| 09 | 管理列表与单 UP 启停：仅 UID 新增（字符串精度与防重）、身份/监控状态卡片、启停失败原位重试、401 与错误脱敏、访问级迟到回调隔离 |
| 10 | 监控模式与指定目标：近期 N／指定动态互斥草稿与保存、删除配置后可重新添加、目标读取/归属校验/移除反馈、按 UP/模式隔离草稿与反馈、停用/移除目标/删除配置后归档仍可读 |
| 11 | 检查/发现/窗口/同步状态：手动读取已保存记录、观察态与执行态及分项时间分开呈现、分项错误与部分同步、发现失败保留旧窗口、面板读取不覆盖草稿、已保存配置改变后重建面板 |
| 12 | 仅含 Vue 的候选产物：六条路由与完整阅读/管理流程均由 Vue 承载、删除 React 栈与重复实现、交付工具去掉框架耦合、默认真实 API 与 mock/fault 隔离保持 |
| 13 | 协议与跨流程回归：mock、生产 Adapter/HTTP 替身、实际 API＋隔离 SQLite 分开取证，六路由/分页排序/恢复/图片/管理/竞态逐项回归，建立 AC-01–AC-34 台账 |
| 14 | 新版视觉签收：63 张四宽度受控截图（含空态/错误态）、布局/触控/焦点审计、用户两轮反馈修正、黄金图与 `visual:compare` 基准 |
| 15 | 实际设备验收：Linux Chrome `155.0.8059.39`（1280 宽）与 iPhone 13 Pro / iOS 16.4 / Safari 16.4 人工实测；真机暴露 F-15-01（写锁卡死，已修复）与 F-15-02（输入框自动放大，**按票据 17 裁决回退为已知限制**）；被测候选 `32c9510`；无逐项截图/录屏、UA 未采集、B7–B10 未跑均如实记录 |
| 16 | 隔离 Nginx 静态交付：本机临时编译 Nginx 1.28.0 下六路由直达/刷新、入口与全部哈希资源可达、管理 401 提示、生产/mock 原子切换与前端回退、SQLite 与 collector 不受影响 |
| 17 | 统一上线就绪汇总：结论**可申请统一上线**——候选产物唯一（视觉重拍 63/63 判定口径（AE + 1% fuzz）零差异像素，50 张与签收图字节相同、13 张仅抗锯齿级差异）、自动化/交付/回退在新候选上重跑通过、AC-01–AC-34 台账完整；设备复验与可审计性缺口按用户裁决记录，已知限制见证据 §7，不授权部署 |

飞书通知票据 02 在同一应用里新增一级评论精确入口（`/dynamics/{id}/comments/{rootId}/locate`）：
直开／刷新直接取含目标的那一批、展开并高亮该条，目标不存在时提示并可返回对应动态。
行为与测试入口见 [前端读取契约](../docs/backend/api/archive-api-client.md#飞书通知-02-增量精确一级评论入口)；
该票不属于上表 02–17 的迁移范围，也不改变其验收结论。

对应规格与票据：[实施规格](../.scratch/frontend-vue-migration/spec.md) · [票据目录](../.scratch/frontend-vue-migration/issues/) ·
[图片预览验证证据](../.scratch/frontend-vue-migration/evidence/01-native-image-preview.md) ·
[02 归档列表证据](../.scratch/frontend-vue-migration/evidence/02-archive-scope-browsing.md) ·
[03 详情与阅读恢复证据](../.scratch/frontend-vue-migration/evidence/03-detail-reading-restoration.md) ·
[04 动态图片阅读证据](../.scratch/frontend-vue-migration/evidence/04-dynamic-image-reading.md) ·
[05 一级评论阅读证据](../.scratch/frontend-vue-migration/evidence/05-root-comment-reading.md) ·
[06 宽屏回复证据](../.scratch/frontend-vue-migration/evidence/06-wide-screen-live-replies.md) ·
[07 窄屏楼中楼证据](../.scratch/frontend-vue-migration/evidence/07-compact-comment-thread.md) ·
[08 评论图片阅读证据](../.scratch/frontend-vue-migration/evidence/08-comment-image-reading.md) ·
[09 管理列表与启停证据](../.scratch/frontend-vue-migration/evidence/09-up-management-basics.md) ·
[10 监控模式与指定目标证据](../.scratch/frontend-vue-migration/evidence/10-monitoring-modes-targets.md) ·
[11 检查与发现状态证据](../.scratch/frontend-vue-migration/evidence/11-monitoring-status-reading.md) ·
[12 仅 Vue 候选产物证据](../.scratch/frontend-vue-migration/evidence/12-vue-only-release-candidate.md) ·
[13 协议与跨流程回归证据](../.scratch/frontend-vue-migration/evidence/13-integrated-protocol-regression.md) ·
[16 静态交付与回退证据](../.scratch/frontend-vue-migration/evidence/16-static-delivery-rollback.md)。
仓库根目录不再有第二套前端入口：`frontend/` 是唯一前端应用，`dist/`、`dist-mock/` 都相对本目录。

## 命令

Node 用 nvm（仓库根 `.nvmrc` 为 24.21.0，在本目录 `nvm use` 会向上读取），依赖与脚本只用 pnpm。

```bash
pnpm install
pnpm dev                 # 生产装配（默认真实 API，/api 代理到 127.0.0.1:8000）
pnpm dev:mock            # mock 装配：额外注册 /__preview-fixtures 与 /__preview-other
pnpm dev:fault           # 开发故障装配（与 mock 同样注册自检路由）
pnpm check               # 一趟绿灯：typecheck + 单测 + e2e 项目覆盖守卫（本机约 25–30s，不含构建）
pnpm check:dist          # 交付前：两次构建 + 产物隔离
pnpm typecheck           # vue-tsc，覆盖 .vue 模板与 TS
pnpm test                # Vitest：历史元数据、装配选择、归档 Adapter/图片组、列表与详情/恢复/图片页面行为
pnpm test:e2e            # Playwright（mock 预览/壳/详情恢复 + 生产装配列表 + 图片夹具，自动起 4318/4319/4320）
E2E_TARGET=preview pnpm test:e2e   # 同一批用例跑 mock 装配的构建产物
pnpm test:e2e:production # 生产装配（六路由/404/无自检入口）与 fault 装配冒烟
pnpm test:e2e:manage    # 管理页 + 实际 API（backend/tests/live_app 虚构上游）+ 本次运行独占 SQLite
                       # 只用本机回环地址；如设置了 HTTP(S)_PROXY，需用 NO_PROXY=127.0.0.1,localhost 或清空代理变量
pnpm test:e2e:location  # 一级评论精确入口 + 实际归档 API（同一虚构上游，另建独占 SQLite 与端口）
                       # 同样的代理变量要求；与 test:e2e-manage 分开，避免跨文件顺序依赖
pnpm visual:baseline     # 票据 14：pnpm build + 四宽度受控截图 + 布局/触控/焦点审计
                       # 输出到 ../.scratch/frontend-vue-migration/evidence/visual-14/
                       # 想复核另一份候选而不覆盖签收记录：VISUAL_OUT_DIR=<其他目录> pnpm visual:baseline
                       # 配置自动补 NO_PROXY=127.0.0.1,localhost，无需手工设置
pnpm visual:compare      # 与 tests/visual-baseline/ 的用户签收黄金图逐张比较（AE，fuzz 1%，阈值 0.02%）
                       # 比较指定目录：pnpm visual:compare --current <截图目录>（本命令只比较现成 PNG，不重新截图）
pnpm visual:diff-report --current <截图目录>
                       # 逐张写出 sha256 是否相同、AE@fuzz 与不含容差的 AE 权重和 → diff-report.json
                       # 与 visual:compare 共用比较口径和条件校验，用于证据文档引用
pnpm visual:golden -- --reason "为什么是预期变化"
                       # 仅在确认视觉变化是预期的之后更新黄金图；必须写原因并进提交
pnpm test:nginx-parity   # 只比对 deploy/nginx*.conf 的 location/server 指令一致性，无需 nginx 二进制
pnpm test:delivery      # 临时真实 Nginx 交付演练（生产/mock/fault 构建、缓存/404、发布切换与回退、实际 API）需
                       # NGINX_BIN、NGINX_MIME_TYPES、uv 环境与 Chromium；4173 被占用时用 DELIVERY_PORT 换端口
pnpm test:http          # 对已上线的局域网 mock 产物验证真实非 localhost HTTP：HTTP_ACCEPTANCE_URL=... 提供地址
pnpm build               # 生产构建 → dist/（不含 mock 页面与夹具）
pnpm build:mock          # 自检构建 → dist-mock/（回归与真机自检用）
pnpm check:isolation     # 断言 dist 无 mock 入口/夹具/归档数据、dist-mock 有
pnpm images              # 单独起图片夹具服务器
pnpm serve:lan           # 按局域网暴露 dist-mock（真机自检用）
```

两个构建目录分开：`dist/` 只由 `pnpm build` 产生（Nginx 托管它），`dist-mock/` 只由 `build:mock`/`build:fault` 产生，
所以不存在“先跑 mock 构建再跑生产构建”的顺序陷阱。

只跑一个 e2e 文件或一个项目：

```bash
pnpm playwright test --project=desktop-chromium-archive tests/e2e/replies.spec.ts
```

每个 `tests/e2e/*.spec.ts` 首行必须声明 `// @projects <逗号分隔的 project 名>`；只在静态交付环境跑的
`static-delivery.spec.ts` 用 `// @projects nginx: desktop-chromium, mobile-chromium`，由
`E2E_TARGET=nginx` 的 `--list` 结果核对。`pnpm check:e2e-projects` 用 Playwright 自己的 `--list` 结果
对照声明，新增 spec 忘记改 `testMatch`/`testIgnore` 会直接失败并打印实测矩阵。
用例失败时先看 `test-results/<用例目录>/error-context.md` 的页面快照与 locator 日志，再决定是否开 trace。

## 结构

| 路径 | 职责 |
| --- | --- |
| `src/main.ts` | 入口：Element Plus 按需样式、`history.scrollRestoration='manual'`、装配路由与默认真实 API 会话 |
| `src/app/session.ts` | 应用会话：根部注入 `DynamicReader` 与管理接口；测试可创建独立实例，不使用模块级单例 |
| `src/app/navigation.ts` | 唯一导航协调器：访问身份、主动入口/历史返回（含楼中楼进入与退回）、快照保存、预览与位置恢复的历史写入 |
| `src/app/historyState.ts` | 应用自有的轻量历史元数据：访问/预览两个命名空间一起写入，不改 Vue Router 自有字段 |
| `src/app/snapshots.ts` / `readingPosition.ts` / `useVisitPosition.ts` | 列表/详情（含一级评论排序、cursor 批次与展开，以及按根评论保存的回复预览/展开/页码/文字）快照类型、稳定锚点定位与访问级位置保存（两个布局帧内完成，用户操作优先） |
| `src/app/useCompactViewport.ts` | 窄屏判定（640px，无法判定按宽屏）：图片预览手势与宽屏内联回复/窄屏回复入口的分支 |
| `src/data/` | 与框架无关的读取契约：生产 Archive Adapter、ID/时间/检查状态守卫，以及评论进度判定与评论错误文案（唯一的实现，不再有副本） |
| `src/dynamics/` | 归档读取行为：scope 导航条、cursor/page 读取、卡片/详情、`CommentSection`/`CommentList`/`CommentItem` 与 `useCommentsRead`、`ReplySection`/`ReplyPager` 与 `useReplyPreview`/`useReplyPage`、窄屏 `ReplyPreview` 与 `useThreadAuthor`、折叠/状态提示与展示格式化 |
| `src/app/assembly.ts` | 装配隔离：`production` / `mock` / `fault`；自检路由只在后两者注册 |
| `src/app/reader.ts` | 读取装配：生产用真实 API Adapter；mock/fault 用受控归档读取，普通构建摇掉 |
| `src/app/router.ts` | 六条基线路由 + 一级评论精确入口 `/dynamics/:dynamicId/comments/:rootId/locate` + 404；`scrollBehavior: () => false`（位置恢复由导航协调器负责） |
| `src/app/App.vue` | 应用壳：导航、主栏、唯一 `PreviewHost`、非生产装配标识 |
| `src/theme/theme.css` | Element Plus 主题变量 + 基础布局/图片栅格/预览层样式 |
| `src/preview/` | 票据 01/04/08 验证过的图片层：图片组与手势、`el-image` 缩略图、独立 `el-image-viewer`、归档图片组连接（动态与各根评论 owner 隔离，历史写入委托导航协调器） |
| `src/manage/` | 管理行为：生产管理 Adapter（`main.ts` 装配，含 `listUps`/`addUp`/`updateMonitor`/`deleteMonitor`/目标增删读/`readDiscovery`/`listChecks`）、共享页头、列表访问、身份卡（启停、模式与近期 N 草稿、删除配置与重新添加）、`ManageTargets` 指定目标区、`CheckStatusPanel`/`CheckStatusDetail` 检查与归档进度、`DiscoveryStatusPanel` 发现与窗口、`discoveryState.ts` 发现契约、`checkStatusText.ts`/`discoveryText.ts`/`status.ts` 状态文案、`useStatusRead` 一次性读取、`manage.css` 共享版式、按 UID 的防重锁与访问存活校验 |
| `src/pages/` | 六条基线路由页面（另有一级评论精确入口复用详情页）；`ListPage.vue`/`DetailPage.vue`/`CommentThreadPage.vue` 已接真实读取，`ManagePage.vue`/`ManageUpPage.vue` 已接真实管理接口（含检查与发现状态），`NotFoundPage.vue` 为不存在页 |
| `src/mock/` | 受控图片夹具、25 条模拟归档（含 4/9/12 图、长图与异常状态）与 45 条一级评论（含混合状态/长图/纯图/超量评论图片组）及 fault 读取计划，只在 mock/fault 装配加载 |
| `public/images/unavailable/` | 应用自有的异常图片占位，随生产构建发布；不是来源业务图 |
| `server/imageServer.mjs` | 图片夹具服务器：缩略/预览不同地址、坏图、无效地址、可重试失败、请求记录 |
| `scripts/check-isolation.mjs` | 构建产物隔离检查（生产无 mock/fault/归档数据，自检构建有） |
| `scripts/check-e2e-projects.mjs` | e2e 项目覆盖守卫：各 spec 的 `@projects` 声明与 Playwright 实测矩阵一致（含 nginx 交付矩阵） |
| `scripts/verify-static-delivery.mjs` 等 | 交付工具：临时 Nginx 静态交付演练、生产 API + collector 验收、入口原子更新、nginx 配置一致性、LAN HTTP 历史恢复（仓库根的 `deploy/`、`backend/` 由脚本向上定位） |
| `tests/unit` | 历史元数据、装配选择、归档 Adapter（列表、一级评论含 UP 摘要、评论图片与回复）/图片组契约、管理 Adapter（映射、错误白名单、401、取消）契约、检查/发现状态 DTO 守卫与自相矛盾响应拒绝、回复分页与目标文案、列表/详情/一级评论（含评论图片）/窄屏入口/楼中楼/回复/图片预览/管理列表、单 UP 启停与模式/目标/检查与发现状态页面行为 |
| `tests/fixtures` / `tests/support` | 生产 DTO 夹具、可注入读取与管理接口替身、预览探针、窄屏视口桩与 jsdom 排版/滚动替身 |
| `tests/e2e` | 骨架冒烟/预览/详情恢复/动态图片/评论图片（mock 装配）+ 列表、一级评论（含根评论 `media` 映射）、管理列表/启停/模式与目标、宽屏回复、窄屏楼中楼与图片读取（生产装配，HTTP 传输按用例替换）+ `static-delivery`（真实 Nginx 缓存/404/深链接，`E2E_TARGET=nginx` 单独跑） |
| `tests/e2e-location` | 一级评论精确入口 + 实际归档 API（`backend/tests/live_app` 虚构上游，仅测试用的 45 条虚构根评论夹具）+ 本次运行独占 SQLite：后续批目标直开定位、窄屏刷新、目标不存在提示，读取不触发上游采集 |
| `tests/e2e-manage` | 管理页 + 实际 API（`backend/tests/live_app` 虚构上游，含动态页/detail/空根评论/独立评论计数/近期发现页 + **仅测试用**的 `POST /api/test/collect`、`/api/test/source-failure` 采集驱动端点）+ 本次运行独占 SQLite；覆盖模式保存、目标归属校验与停用/移除目标/删配置后的归档保留、检查无变化、根评论失败的分项失败与整轮成功、发现失败保留旧窗口、读取不触发采集 |
| `tests/e2e-production` | 生产装配六路由/404/无自检入口 + fault 装配冒烟 |
| `tests/e2e-visual` | 票据 14 视觉取证：受控归档 DTO/固定 SVG 图片替身、四宽度截图与布局审计 |
| `tests/visual-baseline` | 用户签收的视觉黄金图（63 张）+ `manifest.json`（签收范围、候选提交、条件、比较阈值、更新原因） |
| `scripts/compare-visual-baseline.mjs` | 黄金图比较/更新：AE + 1% fuzz + 0.02% 阈值，环境条件不一致时拒绝比较 |
| `playwright.manage.config.ts` | 隔离集成入口：自起 API 与 dev server，数据库在系统临时目录，不触发真实上游或 OSS |
| `playwright.location.config.ts` | 精确评论入口的隔离集成：独立端口与临时 SQLite，其余同上 |
| `playwright.visual.config.ts` | 视觉基准入口：生产构建 + 实际管理 API + 临时 SQLite，自动绕过本机代理 |

## 装配隔离（确定性检查）

- `import.meta.env.MODE` 在构建期被替换为字面量，`previewFixturesEnabled` 必须保持**字面量比较**才能被 Rollup 摇掉
  （`src/app/assembly.ts` 有注释说明：改成 `includes()`/数组查表/从 assembly 派生都会让自检页面重新进入生产包）。
- `pnpm build` → `dist/` 不含 `PreviewFixturesPage`/`PreviewOtherPage`、图片夹具或 mock 归档数据；`pnpm build:mock` → `dist-mock/` 才包含。
- 断言方式：`pnpm check:isolation`（先各跑一次构建）。它同时检查 chunk 名、图片夹具地址与 mock 归档标记，任一不符即非零退出；
  生产占位图是应用自有资源，单独断言 `dist/images/unavailable/placeholder.svg` 存在，不再当作夹具标记。
  这正是 `pnpm test:e2e` 前置的隔离保证，替代人工 `grep`。
- 生产装配的六条路由、404 与“没有自检入口”由 `pnpm test:e2e:production` 覆盖；fault 装配在同一次运行里断言 `badge=fault`。

## 验收剩余（票据 15–17）

票据 12 已交付仅含 Vue 的候选产物，React 栈、React Router 依赖、RTL 测试适配、旧组件/夹具素材与
`check:data-parity` 副本守卫一并移除。票据 13 已完成候选版本的协议与跨流程回归：mock、生产 Adapter/HTTP 替身、
实际 API＋隔离 SQLite 三类证据分开，覆盖六路由、分页/排序、阅读恢复、图片归属与历史、管理与竞态，并建立
AC-01–AC-34 台账。阅读与管理行为本身没有新增或删减：窄屏（≤640px）仍在详情内用
该动态作者的最早回复做预览入口，回复正文在独立楼中楼页按每页 10 条实时读取；一级评论图片由 08 接入，
回复图片与独立楼中楼根评论图片按范围不新增；生产装配默认连真实 API，mock/fault 装配的受控归档只在显式
mode 与自检构建中出现。

票据 14 已完成：用户逐轮确认了全部四宽度截图（含空态/错误态），黄金图与比较基准落在
`tests/visual-baseline/`（63 张 + `manifest.json`），签收范围与两轮反馈见
[14 视觉基准准备证据](../.scratch/frontend-vue-migration/evidence/14-visual-baseline-preparation.md)。
后续视觉变更先跑 `pnpm visual:compare`；只有确认变化符合预期，才用 `pnpm visual:golden -- --reason "..."`
更新黄金图并提交原因，不能用重跑截图掩盖退化。

17 的上线就绪汇总已完成，结论为**可申请统一上线**：视觉重拍与签收黄金图在判定口径下没有差异像素（63/63 判定口径（AE + 1% fuzz）零差异像素，50 张与签收图字节相同、13 张仅抗锯齿级差异），自动化、隔离 Nginx 交付与回退都在最终候选上重跑；
设备复验与可审计性缺口、以及输入框字号与 iOS 聚焦放大等已知限制见
[17 上线就绪汇总证据 §7](../.scratch/frontend-vue-migration/evidence/17-release-readiness.md)。13 只证明自动化与隔离集成；
14 只证明 Linux Chromium 下的视觉基准；15 只证明两类真机目标；16 只在本机隔离 Nginx 下验证静态交付、资源更新与前端回退，
不代表目标机、云部署、持续运行或正式上线通过。

票据 15 已完成真机验收（Linux Chrome 155.0.8059.39 与 iPhone 13 Pro / iOS 16.4），记录见
[15 实际设备验收证据](../.scratch/frontend-vue-migration/evidence/15-real-device-acceptance.md)：候选登记与产物校验
（`evidence/device-15/candidate.json`）、局域网启动脚本、环境 A/B 两份逐条清单与结论。真机暴露并已修复两处 iOS 缺陷：
`AbortSignal.any` 在 iOS 16.4 缺失导致管理写锁卡死（F-15-01，已修复，`tests/unit/browser-baseline.test.ts` 会挡住 iOS 16.4 缺失的 Web API 重新混进源码），
以及输入框字号小于 16px 时聚焦整页放大（F-15-02）。F-15-02 的 16px 修复会改动用户签收过的视觉，
票据 17 按裁决**回退为已知限制**（`manage.spec.ts` 断言输入框字号等于库默认字号），详见
[17 上线就绪汇总证据 §7](../.scratch/frontend-vue-migration/evidence/17-release-readiness.md)。

票据 16 已完成（见[交付与回退证据](../.scratch/frontend-vue-migration/evidence/16-static-delivery-rollback.md)）：
本机无系统 Nginx，按文档在临时目录编译 Nginx 1.28.0，用 `DELIVERY_PORT=4273` 避开已占用的 4173（现有实例未受影响）。
`pnpm test:delivery` 三个阶段全绿：mock 产物阅读/缓存/404/构建复现与回退；生产构建六路由直达/刷新、
产物内 28 个哈希资源逐个可达、受保护反代 401 只显示固定提示、原子更新与回退，且 SQLite 文件与 collector 未变。
`check:isolation` 现在从入口 HTML 解析引用并要求 `/assets/` 全部为内容哈希文件、路由 chunk 不少于六个。

## iPhone 真机验证

```bash
# 票据 15 的受控环境（推荐）：先校验产物属于登记的验收候选，再发布到局域网
../.scratch/frontend-vue-migration/evidence/device-15/serve-env-a.sh

# 手工起法（与上面等价）
pnpm images                                   # 终端 1：夹具服务器 4319
pnpm build:mock && pnpm serve:lan             # 终端 2：自检产物 4318
```

手机与电脑同网段，Safari 打开脚本打印的 `http://<电脑局域网 IP>:4318/`。验收按
[15 证据文档第 5 节](../.scratch/frontend-vue-migration/evidence/15-real-device-acceptance.md)逐条进行——
那是按当前代码核过的完整清单（阅读/管理/图片/历史/触控）；01 证据文档第 8 节只记录早期原型的手势结论，
手势项（滑动切图、双指/双击缩放、未放大禁拖）仍有效，但页面入口与夹具名称以 15 的清单为准。
真机结论不能用桌面自动化替代。
