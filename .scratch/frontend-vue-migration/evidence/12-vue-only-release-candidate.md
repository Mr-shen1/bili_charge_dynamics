# 12 形成仅含 Vue 的完整候选产物

- 对应票据：[12: 形成仅含 Vue 的完整候选产物](../issues/12-vue-only-release-candidate.md)
- 对应规格：[前端重构实施规格](../spec.md) 用户故事 51–64、实施决策 28–31 与测试策略；[前端重构方案](../../../docs/design/frontend-migration.md) 第 6.3/7/8 节
- 证据状态：**类型检查、单元/页面行为测试、三类 e2e、两次构建与产物隔离通过；真实 Nginx 交付脚本（`test:delivery`）、LAN HTTP 回归（`test:http`）、Linux Chrome 人工检查、iPhone Safari、新版视觉签收与真实上游均未在本票执行。**

## 1. 候选源码与依赖

| 项 | 值 |
| --- | --- |
| 候选源码 | 父提交 `b0d40ed`；候选代码提交 `7f15cac refactor(frontend): 收敛为仅含 Vue 的候选产物并清理 React 栈`（本文件在随后的仅文档提交中补齐该标识，不改动代码或产物） |
| 前端根 | `frontend/`（唯一前端应用；仓库根不再有 `src/`、`tests/`、`public/`、`index.html`、`vite.config.ts`） |
| 锁定依赖 | `frontend/pnpm-lock.yaml`，sha256 `8b7b09908c334a72895d0da69ec33375e830a863bca987b47978e1314fe2811a` |
| 运行时 | Node 24.21.0（仓库根 `.nvmrc`）、pnpm 10.34.6 |
| 直接依赖 | `vue` 3.5.44、`vue-router` 4.6.4、`element-plus` 2.14.7（dev：`vitest` 4.0.18、`@playwright/test` 1.58.2、`vue-tsc` 3.3.13、`vite` 7.3.1、`@testing-library/vue` 8.1.0、`@vue/test-utils` 2.5.1、`jsdom` 28.1.0、`typescript` 5.9.3） |
| 后端 | 未改动（本票不动 API/DTO、数据库、采集与部署步骤） |

## 2. 单入口：Vue 承载全部六条路由

- 路由与页面：`frontend/src/app/router.ts` 的 `/`、`/ups/:upId`、`/dynamics/:dynamicId`、`/dynamics/:dynamicId/comments/:rootId`、`/manage`、`/manage/ups/:upId` + 404，全部是 Vue 页面并接真实读取/管理装配（票据 02–11 已逐票交付）。
- 入口：`frontend/index.html` → `src/main.ts`（`#app`）；标题改为“充电动态归档”，补 `theme-color`，不再自称“迁移骨架”。
- 生产装配默认真实 API（`src/app/reader.ts`、`src/manage/managementApi.ts`）；mock/fault 只在显式 mode 装配并分别输出到 `dist-mock/`。没有生产 React/Vue 双入口，也没有逐页灰度。

## 3. 删除清单（181 个文件）

| 类别 | 数量 | 内容 |
| --- | --- | --- |
| 根 `src/` | 59 | React 入口与全部 `.tsx` 组件（`app/Navigation.tsx`、`dynamics/*`、`images/*`、`manage/*`）、React 专用 CSS modules 与 `styles.css`、React 版 `data/*`（与 Vue 副本逐字节相同，属重复实现） |
| 根 `tests/` | 81 | 35 个 RTL 单元/页面测试、`tests/e2e/`（10 个 React e2e spec，含 `static-delivery`/`fault`）、`tests/e2e-archive/`（32 个文件：17 个 spec、TS 传输替身、4 个 Python 生命周期夹具与 json/html 夹具）、`tests/e2e-manage/`、`tests/e2e-support/`、`tests/fixtures/` |
| 根 `public/` | 27 | React mock 专用的 `demo-images/`（24 PNG + README）、`creator-avatar.v1.svg`、根副本 `default-avatar.svg` |
| 构建/配置 | 14 | 根 `index.html`、`package.json`、`pnpm-lock.yaml`、`tsconfig.json`、`vite.config.ts`、`playwright{,.archive,.detail-layout,.manage,.visual}.config.ts`、`scripts/generate-demo-images.mjs`、`frontend/scripts/check-data-parity.mjs` |

依赖清理：`react`、`react-dom`、`react-router`、`@types/react`、`@types/react-dom`、`@vitejs/plugin-react`、`@testing-library/react`、`@testing-library/jest-dom`、`@testing-library/user-event` 全部移出 `frontend/package.json` 与 lockfile 的导入图。
lockfile 里仍能看到 `react-is` 之类传递依赖（Element Plus 内部依赖链），那不是我方直接依赖，也不进入构建产物。

删除理由与边界：

- 这些是**框架相关实现与专用测试适配**，不是有效契约：数据契约、DTO 映射、分页/排序/去重规则、历史元数据与快照逻辑已在 `frontend/src/{data,app,dynamics}` 中以 Vue 版复用并由测试覆盖。
- `public/demo-images/` 只被 React mock 装配与旧素材说明引用；Vue mock 使用 `frontend/server/imageServer.mjs` 的夹具地址，生产产物只用 `public/default-avatar.svg` 与 `public/images/unavailable/placeholder.svg`。
- `tests/e2e-archive/` 的 Python 夹具曾被我暂存，确认票据 13 正文未点名依赖任何路径后按清理要求删除；真实 API 回归的可复用入口是 `backend/tests/live_app.py`（09–11 票已验证：`pnpm test:e2e:manage`）。
- 删除时漏掉一处真实依赖：`backend/tests/deployment_fixture.py` 仍从 `tests/e2e-archive/fixtures/` 读 `normal.json` 与 `edited.html`。已把这两个夹具移到 `backend/tests/fixtures/deployment/` 并改夹具常量（`deployment_fixture.py`），`uv run --no-sync pytest backend/tests -q` 复跑 **809 passed**；`test:delivery` 用的正是这个夹具进程，因此该断链在票据 16 前已修复。
- Git 历史与 `.scratch/**` 历史验收记录保留原义，未改写为 Vue 证据。旧证据里对 `tests/e2e-archive/...:行号` 的引用保持原路径不动：它们描述当时的树，按规格“保留历史证据原义”的要求不改写；对应代码已删除，这一点在本文件登记，不另行回填旧记录。

## 4. 保留清单与维护收益

| 保留 | 说明 |
| --- | --- |
| `frontend/src/data/` | 框架无关的读取契约与生产 Adapter（DTO 映射、ID/时间/状态守卫、评论进度与评论错误文案）。现在是唯一实现，`check:data-parity` 副本守卫随之删除 |
| `frontend/src/app/{navigation,historyState,snapshots,readingPosition,useVisitPosition,useCompactViewport}.ts` | 访问身份、快照与定位、预览历史、窄屏判定；纯 TS，可独立测试 |
| `frontend/src/dynamics/{replyText,replyPaging,display,readStatus}.ts`、`manage/{discoveryState,checkStatusText,discoveryText,status}.ts` | 文本/分页/状态文案的确定性规则 |
| 业务行为 | 动态 10 条 cursor、一级评论 20 条 cursor、宽屏回复 3 条预览 + 每页 10 条实时页码、窄屏楼中楼首屏例外、排序重置、scope 隔离、管理写防重与草稿隔离、检查/发现状态只读呈现——本票未新增、未删除也未放宽 |

已替换的通用组件（Element Plus）：`el-button`/`el-input`/`el-form`/`el-form-item`/`el-radio-group`/`el-alert`/`el-tag`/`el-collapse`/`el-collapse-item`/`el-pagination`/`el-image`/`el-image-viewer`。

已删除的自维护实现（对应维护收益）：

| 删除 | 原来要自己维护的东西 |
| --- | --- |
| `images/ImageGrid.tsx`、`ContentImage.tsx`、`Images.module.css` | 缩略图加载/失败/重试、比例占位、九格栅格与自定义图片框 |
| `images/ImagePreview.tsx`（自研预览引擎） | 缩放/旋转/拖动/键盘/焦点/滚动锁实现与长图适宽模式；改为 `el-image-viewer` + 只保留移动端滑动/双指/双击薄手势 |
| `manage/UpCard.tsx`、`TargetManager.tsx`、`CheckStatusPanel.tsx`、`DiscoveryStatusPanel.tsx`、`management 表单` | 手写输入框、按钮、单选框、折叠区与提示样式；改为库组件 + `manage.css` 仅做版式 |
| `dynamics/ArchiveNavigation.tsx`、`ReadNotice.tsx`、`FoldableText.tsx`、`ReplyPager.tsx` 等 | 自建控件与样式；改为库组件 + scoped CSS |
| React Router 适配与 `Navigation.tsx` 的 context/reducer | 依赖 React Router 内部 `location.key`/`USR` 的历史协调；改为应用自有命名空间元数据 + Vue Router |
| 35 个 RTL 测试与 10+ 个 React e2e spec | React 内部状态断言与旧交互（累计追加、内联窄屏回复、旧像素断言）；行为保护由 Vue 页面对等测试承担 |

## 5. 交付与被删耦合的改造

| 工具 | 改动 |
| --- | --- |
| `frontend/playwright.config.ts` | 新增 `E2E_TARGET=nginx` 分支（不再自起服务，由交付脚本托管 Nginx，4173）；`static-delivery.spec.ts` 只在 mock/fault 项目之外 |
| `frontend/tests/e2e/static-delivery.spec.ts` | 新增 Vue 版静态交付用例：六条路由深链接/带点号路径、ETag/Last-Modified 304、哈希资源 immutable、`/default-avatar.svg` 与 `/images/` 重新验证、缺失资源 404 + `no-store`、深链接刷新看图与返回、404 页面与不存在动态 |
| `frontend/scripts/check-e2e-projects.mjs` | 支持 `// @projects nginx: …` 声明：用 `E2E_TARGET=nginx` 的 `--list` 核对第二套矩阵，同时断言该 spec 不出现在普通矩阵里；普通矩阵自身不继承调用者的 `E2E_TARGET` |
| `frontend/scripts/verify-static-delivery.mjs` | 生产构建仍到 `dist/`、mock/fault 构建到 `dist-mock/`（不再覆盖生产产物）；fault 断言改为“单独输出且不改动生产 dist”；入口注入点 `src/main.ts`；预览锚点改为 `#preview-trigger-dynamic-…` 与 `.el-image-viewer__wrapper`；脚本内区分 app 根与仓库根 |
| `frontend/scripts/verify-production-delivery.mjs` | `#app` 入口断言、`页面不存在`、动态图预览锚点、mock/fault 产物标记改为 Vue 的 `mock-archive:` 与夹具地址 |
| `frontend/scripts/verify-production-deployment.mjs` | 502 响应不再是 `#app` 入口 HTML |
| `frontend/scripts/verify-http-navigation.mjs` | 不再读 React Router 的 `history.state.usr`，改用应用命名空间 `biliChargeDynamicsEntry`/`biliChargeDynamicsPreview`；按 Vue 语义核对“后退关预览、前进恢复、按钮关闭只 replace、返回列表恢复 20 条、刷新重开会话” |
| `frontend/scripts/verify-nginx-parity.mjs`、`verify-entry-update.mjs` | 仅调整脚本所在层级（`frontend/scripts` → 仓库根），断言逻辑不变 |
| `deploy/nginx.conf`、`deploy/nginx-locations.conf` | 删除 React mock 专用的 `/demo-images/`、`/creator-avatar…` 规则；新增 `^~ /images/`（存在则 `no-cache`，缺失 404 `no-store`，不回退 SPA）；`/default-avatar` 保留 |
| `scripts/deploy-frontend.sh` | 在 `frontend/` 构建与取产物（`frontend/dist/`），仓库根只做 git 干净检查与上传/软链 |
| `scripts/{visual_preview.py,check-oss-env.sh,clear_database.py}` | 保留；`visual_preview.py --frontend-dir frontend/dist` 直接可用 |
| `frontend/scripts/capture-visual-35.mjs` | 管理页等待锚点改为「目标检查与归档状态」，卡片图片按钮改为 `预览动态图片…` |

未改动的隔离保证：`check:isolation` 仍断言 `dist` 无 mock 页面 chunk、夹具地址与 mock 归档数据（`mock-archive:`），并检查 `dist/images/unavailable/placeholder.svg` 存在、入口 chunk 存在。

## 6. 构建产物与体积变化

命令：`cd frontend && pnpm build`（生产）与 `pnpm build:mock`（自检）。产物文件名由内容哈希决定，因此上表的入口/chunk 名就是构建标识，可直接与任何一次重建比对。两次结果可复现（交付脚本仍会在临时目录重建并逐字节比对，本票未执行该步）。

| 指标 | 迁移前 React（父提交构建） | 候选 Vue（本票） |
| --- | --- | --- |
| 入口 | `index.html` 450 B，`<div id="root">` | `index.html` 0.46 kB，`<div id="app">` |
| 入口 JS | `assets/index-CIUuNu7I.js` 327.81 kB（gzip 101.18 kB） | `assets/index-DJntLqAG.js` 229.99 kB（gzip 84.60 kB） |
| 入口 CSS | `assets/index-C96Z5hHL.css` 24.68 kB（gzip 5.26 kB） | `assets/index-C99fQE1x.css` 67.52 kB（gzip 9.90 kB，含 Element Plus 按需样式 + 主题；路由级 CSS 另有 10 个 chunk，合计约 16.9 kB） |
| 资源文件数 | 2（`assets/` 内 JS/CSS）+ 演示图片 | 28（`assets/` 内 17 JS + 11 CSS）+ `default-avatar.svg` + `images/unavailable/placeholder.svg` |
| 最大路由 chunk | 无（单包） | `ManageShell` 46.58 kB（gzip 16.49）、`ManageUpPage` 34.63 kB、`DetailPage` 18.02 kB，其余 ≤ 12 kB |
| 产物大小 | `dist/` 560 KB（含 24 张演示图） | `dist/` 532 KB；`dist-mock/` 540 KB |
| gzip 入口总量 | ~106.4 kB（JS+CSS） | ~94.5 kB（JS+CSS 入口）+ 路由按需加载 |

Element Plus 未整包引入：`src/main.ts` 只按组件路径引入所需样式（13 条 `element-plus/es/components/*/style/css`），组件由 SFC 具名导入并由 Rollup 摇树。未发现异常全量依赖；本票不声明性能预算、加载时间或内存指标，只记录实际产物。

## 7. 自动化结果

在 `frontend/` 执行；环境：Linux CachyOS、Node 24.21.0、pnpm 10.34.6、Chromium（Playwright 1.58.2 headless，desktop + Pixel 7 模拟）。因本机设置了 `HTTP(S)_PROXY`，e2e 均附加 `NO_PROXY=127.0.0.1,localhost`。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（vue-tsc 覆盖 `.vue` 模板与 TS） |
| `pnpm check` | 通过：typecheck + **244 passed**（21 个测试文件）+ e2e 项目覆盖守卫（含新增 `static-delivery.spec.ts [E2E_TARGET=nginx]`） |
| `pnpm test:e2e` | **171 passed / 10 skipped**（与票据 11 同数；跳过项仍是需要触摸环境的窄屏手势用例） |
| `pnpm test:e2e:production` | 3 passed / 3 skipped |
| `pnpm test:e2e:manage` | **7 passed**（实际 API + 本次运行独占 SQLite） |
| `pnpm check:dist` | 通过：`pnpm build` + `pnpm build:mock` + `check:isolation`（生产无 mock 入口/夹具/归档数据，自检构建有） |
| `pnpm test:nginx-parity` | 通过：8 个 location 块与 4 条 server 指令在两份配置间一致 |
| `uv run --no-sync pytest backend/tests -q`（仓库根） | **809 passed**（含 `test_deployment_processes.py` 6 例；后者在本票移动夹具后复跑） |
| `pnpm exec playwright test --list`（由覆盖守卫触发） | 通过：各 spec 的 `@projects` 与实际项目矩阵一致 |

本票未执行的验证（如实记录，不标通过）：

| 未执行 | 原因与去向 |
| --- | --- |
| `pnpm test:delivery`（真实 Nginx 静态交付演练） | 本机未安装 `nginx`（`NGINX_BIN`/`NGINX_MIME_TYPES` 不可用）；需在具备 Nginx 的环境重跑，票据 16 负责交付验收 |
| `pnpm test:http`（LAN HTTP 历史/预览回归） | 需要已上线的可信局域网 Nginx 与显式 mock 产物地址；本票未搭建 |
| 真实 Nginx 下的 `static-delivery.spec.ts` | 同上，随 `test:delivery` 执行 |
| Linux Chrome（品牌浏览器）人工检查、iPhone Safari 真机 | 票据 14/15 |
| 新版视觉签收、四视口受控截图 | 票据 14 |
| 真实上游/B 站请求、OSS 上传 | 本票只做本地构建与夹具，未发起任何真实上游请求 |
| 后端生产代码 | 未改动；`backend/tests/deployment_fixture.py` 仅改夹具目录常量并移动两个夹具，`uv run --no-sync pytest backend/tests -q` 复跑 809 passed |

交付脚本与预览探针一律只用应用自有锚点（`#preview-trigger-…`、`.preview-counter`、`Escape`、`page.keyboard`），不再新增对 Element Plus 私有 DOM 的依赖；`tests/e2e/support.ts` 里既有的库根 class helper 仍是票据 01 已登记的例外，本票未扩大其用途。

一处测试基础设施调整：两个长链路导航用例（`thread-reading` 的“分页器收起与返回按钮都退回详情”、`comment-reading` 的“同一动态的多次访问各自保留排序与批次”）在并行满载时会超过 Vitest 默认 5s 上限而偶发超时（单跑分别 1.8s/4.2s 通过）。`vite.config.ts` 把 `testTimeout` 放宽到 15s，**断言未被修改或删除**；放宽后连续两次全量 `pnpm test` 均 244 passed。

## 8. 启动/构建/测试说明的实际变化

| 场景 | 迁移前 | 现在 |
| --- | --- | --- |
| 安装/开发 | 仓库根 `pnpm install`、`pnpm dev`、`pnpm dev --mode mock` | `cd frontend` 后 `pnpm install`、`pnpm dev`、`pnpm dev:mock` |
| 类型检查 | 根 `tsc --noEmit` | `frontend` 内 `vue-tsc --noEmit`（覆盖模板） |
| 构建 | 根 `pnpm build` → 根 `dist/` | `frontend` 内 `pnpm build` → `frontend/dist/`；`build:mock`/`build:fault` → `frontend/dist-mock/` |
| e2e | `pnpm test:e2e` / `:preview` / `:archive` / `:manage`（根配置） | `pnpm test:e2e` / `E2E_TARGET=preview` / `:production` / `:manage`；新增 `E2E_TARGET=nginx`（交付脚本专用） |
| 交付 | 根 `scripts/verify-*.mjs` + `pnpm test:delivery` | `frontend/scripts/verify-*.mjs` + `frontend` 内 `pnpm test:delivery`/`test:http`/`test:nginx-parity` |
| 发布脚本 | `scripts/deploy-frontend.sh` 上传根 `dist/` | 同一脚本上传 `frontend/dist/` |
| 文档 | `frontend/README.md` 记为“迁移骨架” | 同一文件改为前端应用说明（已交付/命令/结构/验收剩余）；根 `README.md`、`docs/README.md`、SRS/FSR/HLD、交付说明同步 |

## 9. 与后续票据的边界

本票只证明“只剩 Vue 的候选产物可以构建、类型检查与既有自动化全绿，且旧栈与重复实现已清理”，**不宣称**视觉、实际设备、静态交付或统一上线已通过。票据 13–17 仍需分别执行协议与跨流程回归、视觉签收、真机验收、静态交付与回退演练，以及上线就绪汇总；其中 `test:delivery`、`test:http` 与真实 Nginx 下的 `static-delivery.spec.ts` 是本票留下、必须在具备 Nginx 的环境补跑的证据缺口。
