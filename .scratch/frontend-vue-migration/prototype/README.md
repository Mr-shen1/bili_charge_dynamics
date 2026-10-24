# 原生图片预览与浏览器历史验证原型

本目录是 Vue 3 + Element Plus 迁移的前置验证原型，只服务票据
[01: 验证原生图片预览与浏览器历史的组合行为](../issues/01-native-image-preview-validation.md)。
它证明（或证伪）`el-image` + 应用协调的 `el-image-viewer` 能满足图片底线、历史语义、焦点/滚动与资源请求要求，
不连接真实 API、OSS 或上游采集，也不是 Vue 应用骨架。

执行证据见 [01 原生图片预览验证证据](../evidence/01-native-image-preview.md)。

## 结构

| 路径 | 职责 |
| --- | --- |
| `src/preview/state.ts` | 纯函数：历史元数据读取、写入、有效性校验 |
| `src/preview/useImagePreview.ts` | 唯一导航协调器：打开/切图/关闭、历史 state、焦点与滚动恢复 |
| `src/preview/PreviewHost.vue` | 应用装配的独立 `el-image-viewer`；用公开 slot 提供工具栏、计数和错误重试 |
| `src/preview/ThumbnailGrid.vue` | `el-image` 缩略图（不启用库内建预览），显示上限 + 剩余数 |
| `src/demo/fixtures.ts` | 单图/四图/十二图/长图/混合异常/共用地址/多 owner 夹具 |
| `server/imageServer.mjs` | 受控图片服务器：缩略/预览不同地址、坏图、无效地址、可重试失败、请求记录 |

## 命令

Node 用 nvm（`.nvmrc` 为 24.21.0），依赖与脚本只用 pnpm。

```bash
pnpm install                 # 已提交 lockfile
pnpm typecheck               # vue-tsc，覆盖 .vue 模板与 TS
pnpm test                    # Vitest：历史元数据纯函数
pnpm test:e2e                # Playwright：先起图片服务器 + Vite dev
E2E_TARGET=preview pnpm test:e2e   # 同一批用例跑生产构建产物
pnpm build                   # 生产构建
```

Playwright 会自动启动 `server/imageServer.mjs`（4319）和 Vite（4318）。
两个项目：`desktop-chromium`（1280×720）与 `mobile-chromium`（Pixel 7 模拟，412×915）。

## iPhone Safari 手工验证（尚未执行）

自动化 Chromium 与模拟手机不能替代真机结论，需人工在 iPhone 上完成：

```bash
# 1. 起图片夹具服务器（保持前台）
pnpm images

# 2. 另开终端：生产构建并按局域网地址暴露
pnpm build
pnpm serve:lan            # http://0.0.0.0:4318
```

手机与电脑同一局域网，用 iPhone Safari 打开 `http://<电脑局域网 IP>:4318/`，逐项确认：

1. 点缩略图打开预览：只有右上角关闭与 `n / m` 计数，**没有**切图箭头、图标工具栏和文字按钮。
2. 左右滑动切图；滑到第 1 张/第 12 张后继续滑不会环绕。
3. 双指缩放：只放大/缩小图片，页面本身不放大（可用两指捏合后再松手观察地址栏是否被放大）；放大后单指拖动阅读。
4. 未放大时单指左右拖动不会移动图片，只会切图；双击图片放大到 2.5 倍，再次双击回到完整居中显示（拖动过的偏移一并复位）。
5. 长图（“长图”分组）：双指或双击放大到能读清文字，拖动查看整张。
6. 用 Safari 后退按钮关闭预览：底层页面保持原位、不多退一级；再用前进恢复同一张图。
7. 关闭预览后回到触发位置与焦点，页面不跳动；重新打开该图回到完整显示（缩放不残留）。
8. 记录 iPhone 型号、iOS 版本、Safari 版本与结果（含失败项）到证据文档。

## 已知的原型边界

- 只验证预览与历史的组合行为；视觉基准、列表/详情/管理页迁移属于后续票据。
- 图片服务器对全部图片响应 `no-store`，让网络证据不依赖缓存命中；生产缓存策略另行验证。
- 未启用库的图片下载、自动轮播与自由画布缩放；库的缩放/旋转/拖动引擎保持原生，应用只在窄屏补“滑动切图 + 双指缩放”两种库不提供的手势。
- 窄屏隐藏库的切图箭头与图标工具栏是**全仓唯一一处库内部类覆盖**（见 `src/styles.css` 注释），由 `preview-gestures.spec.ts` 守护。
