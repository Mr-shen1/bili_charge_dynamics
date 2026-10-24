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
pnpm build               # 生产构建：不含 mock 页面与夹具
pnpm build:mock          # 含自检页面的构建（仅回归用）
pnpm images              # 单独起图片夹具服务器
pnpm serve:lan           # 生产/自检产物按局域网暴露（真机验证用）
```

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
| `tests/unit` | 纯 TS：历史元数据、装配选择 |
| `tests/e2e` | 骨架冒烟 + 图片预览/历史/手势（mock 装配） |

## 装配隔离（已可验证）

- `import.meta.env.MODE` 在构建期被替换为字面量，`previewFixturesEnabled` 因此是编译期常量。
- `pnpm build` 产物**不含** `PreviewFixturesPage` / `PreviewOtherPage` 与夹具数据；`pnpm build:mock` 才包含。
- 自检依据：`pnpm build && ls dist/assets | grep -i preview` 无输出；`grep -rl 'images/full/many' dist` 为空。

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
