# Vue 前端（迁移进行中）

目标栈：Vue 3 + TypeScript + Vite + Vue Router + Element Plus。阶段 2 应用基础已就位；阶段 3 按票据 08–11 迁移剩余业务页面，
票据 12/17 才切换统一发布。**已交付范围以本文件「已交付」一节为单一来源**，其他文档只保留指针与证据链接。

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

对应规格与票据：[实施规格](../.scratch/frontend-vue-migration/spec.md) · [票据目录](../.scratch/frontend-vue-migration/issues/) ·
[图片预览验证证据](../.scratch/frontend-vue-migration/evidence/01-native-image-preview.md) ·
[02 归档列表证据](../.scratch/frontend-vue-migration/evidence/02-archive-scope-browsing.md) ·
[03 详情与阅读恢复证据](../.scratch/frontend-vue-migration/evidence/03-detail-reading-restoration.md) ·
[04 动态图片阅读证据](../.scratch/frontend-vue-migration/evidence/04-dynamic-image-reading.md) ·
[05 一级评论阅读证据](../.scratch/frontend-vue-migration/evidence/05-root-comment-reading.md) ·
[06 宽屏回复证据](../.scratch/frontend-vue-migration/evidence/06-wide-screen-live-replies.md) ·
[07 窄屏楼中楼证据](../.scratch/frontend-vue-migration/evidence/07-compact-comment-thread.md) ·
[08 评论图片阅读证据](../.scratch/frontend-vue-migration/evidence/08-comment-image-reading.md) ·
[09 管理列表与启停证据](../.scratch/frontend-vue-migration/evidence/09-up-management-basics.md)。
仓库根目录的 React 应用仍是当前可运行实现，两者在迁移完成前并存，生产上不并行发布。

## 命令

Node 用 nvm（`.nvmrc` 为 24.21.0），依赖与脚本只用 pnpm。

```bash
pnpm install
pnpm dev                 # 生产装配（默认真实 API，/api 代理到 127.0.0.1:8000）
pnpm dev:mock            # mock 装配：额外注册 /__preview-fixtures 与 /__preview-other
pnpm dev:fault           # 开发故障装配（与 mock 同样注册自检路由）
pnpm check               # 一趟绿灯：typecheck + 单测 + e2e 项目覆盖守卫（约 15s，不含构建）
pnpm check:dist          # 交付前：两次构建 + 产物隔离 + 数据层副本
pnpm typecheck           # vue-tsc，覆盖 .vue 模板与 TS
pnpm test                # Vitest：历史元数据、装配选择、归档 Adapter/图片组、列表与详情/恢复/图片页面行为
pnpm test:e2e            # Playwright（mock 预览/壳/详情恢复 + 生产装配列表 + 图片夹具，自动起 4318/4319/4320）
E2E_TARGET=preview pnpm test:e2e   # 同一批用例跑 mock 装配的构建产物
pnpm test:e2e:production # 生产装配（六路由/404/无自检入口）与 fault 装配冒烟
pnpm test:e2e:manage    # 管理页 + 实际 API（backend/tests/live_app 虚构上游）+ 本次运行独占 SQLite
pnpm build               # 生产构建 → dist/（不含 mock 页面与夹具）
pnpm build:mock          # 自检构建 → dist-mock/（回归与真机自检用）
pnpm check:isolation     # 断言 dist 无 mock 入口/夹具/归档数据、dist-mock 有
pnpm check:data-parity   # 断言 frontend/src/data 与根 src/data 临时副本逐字节一致
pnpm images              # 单独起图片夹具服务器
pnpm serve:lan           # 按局域网暴露 dist-mock（真机自检用）
```

两个构建目录分开：`dist/` 只由 `pnpm build` 产生（Nginx 托管它），`dist-mock/` 只由 `build:mock`/`build:fault` 产生，
所以不存在“先跑 mock 构建再跑生产构建”的顺序陷阱。

只跑一个 e2e 文件或一个项目：

```bash
pnpm playwright test --project=desktop-chromium-archive tests/e2e/replies.spec.ts
```

每个 `tests/e2e/*.spec.ts` 首行必须声明 `// @projects <逗号分隔的 project 名>`；`pnpm check:e2e-projects`
用 Playwright 自己的 `--list` 结果对照声明，新增 spec 忘记改 `testMatch`/`testIgnore` 会直接失败并打印实测矩阵。
用例失败时先看 `test-results/<用例目录>/error-context.md` 的页面快照与 locator 日志，再决定是否开 trace。

## 结构

| 路径 | 职责 |
| --- | --- |
| `src/main.ts` | 入口：Element Plus 按需样式、`history.scrollRestoration='manual'`、装配路由与默认真实 API 会话 |
| `src/app/session.ts` | 应用会话：根部注入 `DynamicReader` 与管理接口；测试可创建独立实例，不使用模块级单例 |
| `src/app/management.ts` | 管理接口装配：默认真实同源 API；mock/fault 只替换归档读取，不伪造管理成功 |
| `src/app/navigation.ts` | 唯一导航协调器：访问身份、主动入口/历史返回（含楼中楼进入与退回）、快照保存、预览与位置恢复的历史写入 |
| `src/app/historyState.ts` | 应用自有的轻量历史元数据：访问/预览两个命名空间一起写入，不改 Vue Router 自有字段 |
| `src/app/snapshots.ts` / `readingPosition.ts` / `useVisitPosition.ts` | 列表/详情（含一级评论排序、cursor 批次与展开，以及按根评论保存的回复预览/展开/页码/文字）快照类型、稳定锚点定位与访问级位置保存（两个布局帧内完成，用户操作优先） |
| `src/app/useCompactViewport.ts` | 窄屏判定（640px，无法判定按宽屏）：图片预览手势与宽屏内联回复/窄屏回复入口的分支 |
| `src/data/` | 与框架无关的读取契约、生产 Archive Adapter、ID/时间/检查状态守卫（迁移期从 React 栈复用） |
| `src/dynamics/` | 归档读取行为：scope 导航条、cursor/page 读取、卡片/详情、`CommentSection`/`CommentList`/`CommentItem` 与 `useCommentsRead`、`ReplySection`/`ReplyPager` 与 `useReplyPreview`/`useReplyPage`、窄屏 `ReplyPreview` 与 `useThreadAuthor`、折叠/状态提示与展示格式化 |
| `src/app/assembly.ts` | 装配隔离：`production` / `mock` / `fault`；自检路由只在后两者注册 |
| `src/app/reader.ts` | 读取装配：生产用真实 API Adapter；mock/fault 用受控归档读取，普通构建摇掉 |
| `src/app/router.ts` | 六条正式路由 + 404；`scrollBehavior: () => false`（位置恢复由导航协调器负责） |
| `src/app/App.vue` | 应用壳：导航、主栏、唯一 `PreviewHost`、非生产装配标识 |
| `src/theme/theme.css` | Element Plus 主题变量 + 基础布局/图片栅格/预览层样式 |
| `src/preview/` | 票据 01/04/08 验证过的图片层：图片组与手势、`el-image` 缩略图、独立 `el-image-viewer`、归档图片组连接（动态与各根评论 owner 隔离，历史写入委托导航协调器） |
| `src/manage/` | 管理行为：生产管理 Adapter（`listUps`/`addUp`/`updateMonitor`）、共享页头、列表访问与单 UP 访问、启停身份卡、按 UID 的防重锁与访问存活校验 |
| `src/pages/` | 六条路由页面；`ListPage.vue`/`DetailPage.vue`/`CommentThreadPage.vue` 已接真实读取，`ManagePage.vue`/`ManageUpPage.vue` 已接真实管理接口（模式/目标与检查状态待 10/11），`NotFoundPage.vue` 为不存在页 |
| `src/mock/` | 受控图片夹具、25 条模拟归档（含 4/9/12 图、长图与异常状态）与 45 条一级评论（含混合状态/长图/纯图/超量评论图片组）及 fault 读取计划，只在 mock/fault 装配加载 |
| `public/images/unavailable/` | 应用自有的异常图片占位，随生产构建发布；不是来源业务图 |
| `server/imageServer.mjs` | 图片夹具服务器：缩略/预览不同地址、坏图、无效地址、可重试失败、请求记录 |
| `scripts/check-isolation.mjs` | 构建产物隔离检查（生产无 mock/fault/归档数据，自检构建有） |
| `scripts/check-data-parity.mjs` | 迁移期数据层副本守卫：`frontend/src/data` 与根 `src/data` 必须一致 |
| `tests/unit` | 历史元数据、装配选择、归档 Adapter（列表、一级评论含 UP 摘要、评论图片与回复）/图片组契约、管理 Adapter（映射、错误白名单、401、取消）契约、回复分页与目标文案、列表/详情/一级评论（含评论图片）/窄屏入口/楼中楼/回复/图片预览/管理列表与单 UP 启停页面行为 |
| `tests/fixtures` / `tests/support` | 生产 DTO 夹具、可注入读取与管理接口替身、预览探针、窄屏视口桩与 jsdom 排版/滚动替身 |
| `tests/e2e` | 骨架冒烟/预览/详情恢复/动态图片/评论图片（mock 装配）+ 列表、一级评论（含根评论 `media` 映射）、管理列表与启停、宽屏回复、窄屏楼中楼与图片读取（生产装配，HTTP 传输按用例替换） |
| `tests/e2e-manage` | 管理页 + 实际 API（`backend/tests/live_app` 虚构上游）+ 本次运行独占 SQLite |
| `tests/e2e-production` | 生产装配六路由/404/无自检入口 + fault 装配冒烟 |
| `playwright.manage.config.ts` | 隔离集成入口：自起 API 与 dev server，数据库在系统临时目录，不触发真实上游或 OSS |

## 装配隔离（确定性检查）

- `import.meta.env.MODE` 在构建期被替换为字面量，`previewFixturesEnabled` 必须保持**字面量比较**才能被 Rollup 摇掉
  （`src/app/assembly.ts` 有注释说明：改成 `includes()`/数组查表/从 assembly 派生都会让自检页面重新进入生产包）。
- `pnpm build` → `dist/` 不含 `PreviewFixturesPage`/`PreviewOtherPage`、图片夹具或 mock 归档数据；`pnpm build:mock` → `dist-mock/` 才包含。
- 断言方式：`pnpm check:isolation`（先各跑一次构建）。它同时检查 chunk 名、图片夹具地址与 mock 归档标记，任一不符即非零退出；
  生产占位图是应用自有资源，单独断言 `dist/images/unavailable/placeholder.svg` 存在，不再当作夹具标记。
  这正是 `pnpm test:e2e` 前置的隔离保证，替代人工 `grep`。
- 生产装配的六条路由、404 与“没有自检入口”由 `pnpm test:e2e:production` 覆盖；fault 装配在同一次运行里断言 `badge=fault`。

## 尚未迁移（阶段 3 剩余）

已交付范围见上文「已交付」；单 UP 管理的监控模式与指定目标（10）、检查/发现/窗口与同步状态（11）仍待迁移。窄屏（≤640px）已在详情内用该动态作者的最早回复做预览入口，
回复正文在独立楼中楼页按每页 10 条实时读取；一级评论图片已由 08 接入，回复图片与独立楼中楼根评论图片按范围不新增。
生产装配默认连真实 API，不携带假数据；mock/fault 装配的受控归档只在显式 mode 与自检构建中出现。
`frontend/src/data` 是根 `src/data` 的临时副本，由 `pnpm check:data-parity` 防止漂移，
票据 12/17 清理 React 栈时一并移除。

## iPhone 真机验证

```bash
pnpm images                                   # 终端 1：夹具服务器 4319
pnpm build:mock && pnpm serve:lan             # 终端 2：自检产物 4318
```

手机与电脑同网段，Safari 打开 `http://<电脑局域网 IP>:4318/__preview-fixtures`，按 01 证据文档第 8 节的清单核对
（滑动切图、双指/双击缩放、未放大禁拖、长图可读、关闭与后退/前进）。真机结论不能用桌面自动化替代。
