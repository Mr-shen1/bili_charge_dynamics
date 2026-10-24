# Vue 前端（迁移骨架）

目标栈：Vue 3 + TypeScript + Vite + Vue Router + Element Plus。本目录当前处于**阶段 2（应用基础）**：
入口、六条正式路由、主题、装配隔离、类型检查、测试基础与已验证的图片预览层已就位；业务页面是占位骨架，
由票据 02–11 逐步迁移，票据 12/17 才切换统一发布。

对应规格与票据：[实施规格](../.scratch/frontend-vue-migration/spec.md) · [票据目录](../.scratch/frontend-vue-migration/issues/) ·
[图片预览验证证据](../.scratch/frontend-vue-migration/evidence/01-native-image-preview.md)。
仓库根目录的 React 应用仍是当前可运行实现，两者在迁移完成前并存，生产上不并行发布。

## 命令

Node 用 nvm（`.nvmrc` 为 24.21.0），依赖与脚本只用 pnpm。

```bash
pnpm install
pnpm dev                 # 生产装配（默认真实 API，/api 代理到 127.0.0.1:8000）
pnpm dev:mock            # mock 装配：额外注册 /__preview-fixtures 与 /__preview-other
pnpm dev:fault           # 开发故障装配（与 mock 同样注册自检路由）
pnpm typecheck           # vue-tsc，覆盖 .vue 模板与 TS
pnpm test                # Vitest：历史元数据与装配选择
pnpm test:e2e            # Playwright（mock 装配 + 图片夹具，自动起 4319/4318）
E2E_TARGET=preview pnpm test:e2e   # 同一批用例跑 mock 装配的构建产物
pnpm test:e2e:production # 生产装配（六路由/404/无自检入口）与 fault 装配冒烟
pnpm build               # 生产构建 → dist/（不含 mock 页面与夹具）
pnpm build:mock          # 自检构建 → dist-mock/（回归与真机自检用）
pnpm check:isolation     # 断言 dist 无 mock 入口/夹具、dist-mock 有
pnpm images              # 单独起图片夹具服务器
pnpm serve:lan           # 按局域网暴露 dist-mock（真机自检用）
```

两个构建目录分开：`dist/` 只由 `pnpm build` 产生（Nginx 托管它），`dist-mock/` 只由 `build:mock`/`build:fault` 产生，
所以不存在“先跑 mock 构建再跑生产构建”的顺序陷阱。

## 结构

| 路径 | 职责 |
| --- | --- |
| `src/main.ts` | 入口：Element Plus 按需样式、`history.scrollRestoration='manual'`、装配路由 |
| `src/app/assembly.ts` | 装配隔离：`production` / `mock` / `fault`；自检路由只在后两者注册 |
| `src/app/router.ts` | 六条正式路由 + 404；`scrollBehavior: () => false`（位置恢复由预览协调器负责） |
| `src/app/App.vue` | 应用壳：导航、主栏、唯一 `PreviewHost`、非生产装配标识 |
| `src/theme/theme.css` | Element Plus 主题变量 + 基础布局/图片栅格/预览层样式 |
| `src/preview/` | 票据 01 验证过的图片层：导航协调器、`el-image` 缩略图、独立 `el-image-viewer`、手势、状态映射 |
| `src/pages/` | 六条路由的占位骨架（阶段 3 迁移目标写在各自页面里） |
| `src/mock/` | 受控图片夹具与自检页面，只在 mock/fault 装配加载 |
| `server/imageServer.mjs` | 图片夹具服务器：缩略/预览不同地址、坏图、无效地址、可重试失败、请求记录 |
| `scripts/check-isolation.mjs` | 构建产物隔离检查（生产无 mock/fault，自检构建有） |
| `tests/unit` | 纯 TS：历史元数据、装配选择 |
| `tests/e2e` | 骨架冒烟 + 图片预览/历史/手势（mock 装配） |
| `tests/e2e-production` | 生产装配六路由/404/无自检入口 + fault 装配冒烟 |

## 装配隔离（确定性检查）

- `import.meta.env.MODE` 在构建期被替换为字面量，`previewFixturesEnabled` 必须保持**字面量比较**才能被 Rollup 摇掉
  （`src/app/assembly.ts` 有注释说明：改成 `includes()`/数组查表/从 assembly 派生都会让自检页面重新进入生产包）。
- `pnpm build` → `dist/` 不含 `PreviewFixturesPage`/`PreviewOtherPage` 与夹具；`pnpm build:mock` → `dist-mock/` 才包含。
- 断言方式：`pnpm check:isolation`（先各跑一次构建）。它同时检查 chunk 名与夹具地址标记，任一不符即非零退出；
  这正是 `pnpm test:e2e` 前置的隔离保证，替代人工 `grep`。
- 生产装配的六条路由、404 与“没有自检入口”由 `pnpm test:e2e:production` 覆盖；fault 装配在同一次运行里断言 `badge=fault`。

## 尚未迁移（阶段 3）

六条页面的读取/管理逻辑、纯 TS 契约与 Adapter 复用、阅读快照与恢复、E2E 迁移，按票据 02–11 进行；
本骨架不提供假数据，占位页只说明目标与票据编号。

## iPhone 真机验证

```bash
pnpm images                                   # 终端 1：夹具服务器 4319
pnpm build:mock && pnpm serve:lan             # 终端 2：自检产物 4318
```

手机与电脑同网段，Safari 打开 `http://<电脑局域网 IP>:4318/__preview-fixtures`，按 01 证据文档第 8 节的清单核对
（滑动切图、双指/双击缩放、未放大禁拖、长图可读、关闭与后退/前进）。真机结论不能用桌面自动化替代。
