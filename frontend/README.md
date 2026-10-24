# Vue 前端（迁移进行中）

目标栈：Vue 3 + TypeScript + Vite + Vue Router + Element Plus。阶段 2 应用基础已就位；阶段 3 按票据 02–11 迁移业务页面，
票据 12/17 才切换统一发布。当前已交付**票据 02 的全部/单 UP 归档列表读取**（scope 切换、cursor 追加、折叠、
错误/空态与 Element Plus 控件），其余页面仍是占位骨架。

对应规格与票据：[实施规格](../.scratch/frontend-vue-migration/spec.md) · [票据目录](../.scratch/frontend-vue-migration/issues/) ·
[图片预览验证证据](../.scratch/frontend-vue-migration/evidence/01-native-image-preview.md) ·
[02 归档列表证据](../.scratch/frontend-vue-migration/evidence/02-archive-scope-browsing.md)。
仓库根目录的 React 应用仍是当前可运行实现，两者在迁移完成前并存，生产上不并行发布。

## 命令

Node 用 nvm（`.nvmrc` 为 24.21.0），依赖与脚本只用 pnpm。

```bash
pnpm install
pnpm dev                 # 生产装配（默认真实 API，/api 代理到 127.0.0.1:8000）
pnpm dev:mock            # mock 装配：额外注册 /__preview-fixtures 与 /__preview-other
pnpm dev:fault           # 开发故障装配（与 mock 同样注册自检路由）
pnpm typecheck           # vue-tsc，覆盖 .vue 模板与 TS
pnpm test                # Vitest：历史元数据、装配选择、归档 Adapter 与列表页面行为
pnpm test:e2e            # Playwright（mock 预览/壳 + 生产装配列表 + 图片夹具，自动起 4318/4319/4320）
E2E_TARGET=preview pnpm test:e2e   # 同一批用例跑 mock 装配的构建产物
pnpm test:e2e:production # 生产装配（六路由/404/无自检入口）与 fault 装配冒烟
pnpm build               # 生产构建 → dist/（不含 mock 页面与夹具）
pnpm build:mock          # 自检构建 → dist-mock/（回归与真机自检用）
pnpm check:isolation     # 断言 dist 无 mock 入口/夹具/归档数据、dist-mock 有
pnpm check:data-parity   # 断言 frontend/src/data 与根 src/data 临时副本逐字节一致
pnpm images              # 单独起图片夹具服务器
pnpm serve:lan           # 按局域网暴露 dist-mock（真机自检用）
```

两个构建目录分开：`dist/` 只由 `pnpm build` 产生（Nginx 托管它），`dist-mock/` 只由 `build:mock`/`build:fault` 产生，
所以不存在“先跑 mock 构建再跑生产构建”的顺序陷阱。

## 结构

| 路径 | 职责 |
| --- | --- |
| `src/main.ts` | 入口：Element Plus 按需样式、`history.scrollRestoration='manual'`、装配路由与默认真实 API 会话 |
| `src/app/session.ts` | 应用会话：根部注入 `DynamicReader`；测试可创建独立实例，不使用模块级单例 |
| `src/data/` | 与框架无关的读取契约、生产 Archive Adapter、ID/时间/检查状态守卫（迁移期从 React 栈复用） |
| `src/dynamics/` | 归档列表行为：scope 导航条、cursor 读取、卡片/身份/折叠/状态提示与展示格式化 |
| `src/app/assembly.ts` | 装配隔离：`production` / `mock` / `fault`；自检路由只在后两者注册 |
| `src/app/reader.ts` | 读取装配：生产用真实 API Adapter；mock/fault 用受控归档读取，普通构建摇掉 |
| `src/app/router.ts` | 六条正式路由 + 404；`scrollBehavior: () => false`（位置恢复由预览协调器负责） |
| `src/app/App.vue` | 应用壳：导航、主栏、唯一 `PreviewHost`、非生产装配标识 |
| `src/theme/theme.css` | Element Plus 主题变量 + 基础布局/图片栅格/预览层样式 |
| `src/preview/` | 票据 01 验证过的图片层：导航协调器、`el-image` 缩略图、独立 `el-image-viewer`、手势、状态映射 |
| `src/pages/` | 六条路由页面；`ListPage.vue` 已接真实读取，其余为阶段 3 占位骨架 |
| `src/mock/` | 受控图片夹具、25 条模拟归档与 fault 读取计划，只在 mock/fault 装配加载 |
| `server/imageServer.mjs` | 图片夹具服务器：缩略/预览不同地址、坏图、无效地址、可重试失败、请求记录 |
| `scripts/check-isolation.mjs` | 构建产物隔离检查（生产无 mock/fault/归档数据，自检构建有） |
| `scripts/check-data-parity.mjs` | 迁移期数据层副本守卫：`frontend/src/data` 与根 `src/data` 必须一致 |
| `tests/unit` | 历史元数据、装配选择、归档 Adapter 契约与列表页面行为 |
| `tests/fixtures` / `tests/support` | 生产 DTO 夹具与可注入读取替身 |
| `tests/e2e` | 骨架冒烟/预览（mock 装配）+ 列表读取（生产装配，HTTP 传输按用例替换） |
| `tests/e2e-production` | 生产装配六路由/404/无自检入口 + fault 装配冒烟 |

## 装配隔离（确定性检查）

- `import.meta.env.MODE` 在构建期被替换为字面量，`previewFixturesEnabled` 必须保持**字面量比较**才能被 Rollup 摇掉
  （`src/app/assembly.ts` 有注释说明：改成 `includes()`/数组查表/从 assembly 派生都会让自检页面重新进入生产包）。
- `pnpm build` → `dist/` 不含 `PreviewFixturesPage`/`PreviewOtherPage`、图片夹具或 mock 归档数据；`pnpm build:mock` → `dist-mock/` 才包含。
- 断言方式：`pnpm check:isolation`（先各跑一次构建）。它同时检查 chunk 名、图片夹具地址与 mock 归档标记，任一不符即非零退出；
  这正是 `pnpm test:e2e` 前置的隔离保证，替代人工 `grep`。
- 生产装配的六条路由、404 与“没有自检入口”由 `pnpm test:e2e:production` 覆盖；fault 装配在同一次运行里断言 `badge=fault`。

## 尚未迁移（阶段 3 剩余）

票据 02 已交付全部/单 UP 列表读取；详情与列表阅读恢复（03）、列表/详情图片（04）、
评论与回复（05–08）、管理页面（09–11）仍待迁移。动态图片在本阶段尚未接入真实列表，
纯图动态不会显示缩略图；不是最终形态，04 才交付图片读取。
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
