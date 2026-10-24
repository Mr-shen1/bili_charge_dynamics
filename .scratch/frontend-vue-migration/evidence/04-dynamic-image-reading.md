# 04 动态图片阅读证据

- 对应票据：[04: 在动态列表和详情查看完整图片组](../issues/04-dynamic-image-reading.md)
- 对应规格：[前端重构实施规格](../spec.md) 实施决策 27、36 与「必须覆盖的场景」中的图片、导航与恢复条目；SRS FR-08/FR-09
- 实现位置：`frontend/src/preview/`（groups、DynamicImages、ThumbnailGrid、PreviewHost、useImagePreview）、
  `frontend/src/dynamics/`（DynamicContent、ListVisit）、`frontend/src/mock/archiveReader.ts`、`frontend/public/images/unavailable/placeholder.svg`
- 证据状态：**Linux Chromium 桌面与 Pixel 7 模拟项目自动化通过；真实 API/SQLite、iPhone Safari、新版视觉签收未在本票执行。**

## 1. 本票交付

| 区域 | 内容 |
| --- | --- |
| Adapter 边界 | `preview/groups.ts` 把归档读取结果 `DynamicImage[]` 映射为预览组：`dynamic-<id>` / `comment-<id>`、owner、标签、完整顺序；`success` 且有公开地址为 ready，`pending`/`failed` 保留上传状态，成功但无可用公开地址为 invalid，不反查来源 URL |
| 列表图片 | `DynamicContent` 接入 `DynamicImages`；列表只展示前 9 张并在末张显示 `+N`，完整组仍注册给预览；详情不传上限，完整组全部展示 |
| 预览接入 | 复用 01 的 `el-image` + 独立 `el-image-viewer` 与唯一导航协调器；没有第二套预览、图库或历史实现 |
| 组注册 | `registerGroups` 在会话内**合并**而不是整表替换：历史前进导致页面重新挂载时，已读组仍能解析历史预览标记；不新增持久化或跨标签页状态 |
| 关闭恢复 | 关闭/后退恢复触发焦点与滚动位置；触发节点被重建时按稳定缩略图 ID 找回，节点已消失才退到 `[data-preview-fallback-focus]` |
| 异常状态 | pending/failed/invalid 使用应用占位图，预览内 `preview-note` 分别显示“图片待归档 / 图片归档失败 / 归档图片地址不可用”；浏览器加载失败仍由库错误态显示“图片加载失败”并局部重试 |
| 布局 | 单图最大 360px、4:3 框；双图/四图两列；其余三列；≤640px 两列，单图整行。缩略图 `fit=cover` 不拉伸，预览用库原生 contain/zoom |
| 资源与隔离 | 占位地址由 `preview/assets.ts` 统一导出，资源放入 `frontend/public/images/unavailable/placeholder.svg` 随构建发布；`check-isolation` 不再把占位地址当夹具标记，改为断言生产产物含该资源，并把缩略、坏图、无效与可重试失败地址继续作为夹具泄漏标记 |

本票不渲染评论图片（08），不修改 API、后端或部署。

## 2. 关键规则与实现位置

| 规则 | 位置 | 说明 |
| --- | --- | --- |
| 完整组 ≠ 展示数量 | `ThumbnailGrid.vue` / `DynamicImages.vue` | `displayLimit` 只裁剪缩略图，注册给预览的 `ImageGroup.images` 始终是完整组 |
| 点击图片不导航 | `DynamicCard.vue` 的 `button` 排除 + `ThumbnailGrid` 触发按钮 | 缩略图是独立 button；卡片点击保护已有测试，本票新增真实页面 URL 断言 |
| 同 URL 预览不重挂载 | `navigation.openPreview` + `ListPage`/`DetailPage` 的 `pageEntryId` key | 预览 PUSH 复用同一访问标识；列表/详情挂载探针在打开、关闭、切图后仍保留 |
| 切图不新增历史 | `useImagePreview.persist` → `replacePreview` | 只替换同一条记录的 `index`，`previewId` 与 `push` 次数不变 |
| 前进跨重挂载恢复 | `registerGroups` 合并 + 稳定组 ID | 历史前进重新挂载详情后，预览记录仍解析到同一完整组与索引 |
| 失败语义分离 | `groups.ts` 的 `statusOf` + `imageStatus.ts` + `PreviewHost` | 上传状态、无效地址与浏览器加载失败互不冒充；只有 ready/broken 提供重试 |
| 重试只发公开地址 | `ThumbnailGrid.retryThumbnail` / `PreviewHost.preview.retry` | 仅以现有 URL 重挂载组件；不调用采集/上传，不回退 `media_sources` |
| 按需加载 | `ElImage lazy` + viewer 当前图 | 冷缓存下首屏不请求屏幕外整组缩略图；打开预览只请求所点原图 |

## 3. 自动化结果

在 `frontend/` 下执行，环境与 01–03 证据一致：Linux CachyOS、Node 24.21.0、pnpm 10.34.6、
Vue 3.5.44、Vue Router 4.6.4、Element Plus 2.14.7、Vitest 4.0.18、Playwright 1.58.2（Chromium headless，desktop + Pixel 7）。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（vue-tsc 覆盖 `.vue` 模板与 TS） |
| `pnpm test` | **57 passed**：历史元数据 14 + 预览标记 3 + 图片组 Adapter 3 + 详情/阅读恢复 13 + 列表/图片页面 14 + 既有 10 |
| `pnpm test:e2e` | **114 passed / 10 skipped**（新增动态图片 11 条 × 2 项目，共 22；既有壳/预览/列表/详情恢复全部通过；跳过项仍是需要触摸环境的窄屏手势） |
| `pnpm test:e2e:production` | 3 passed / 3 skipped（生产六路由、404、无自检入口；fault 装配） |
| `pnpm build` / `pnpm build:mock` / `pnpm check:isolation` / `pnpm check:data-parity` | 均通过；生产产物含应用占位资源、无 mock 入口/夹具/归档数据 |

新增/改写的自动化覆盖：

- `tests/unit/image-groups.test.ts`：生产 DTO 经真实 Archive Adapter 映射后，组 ID/owner/标签、顺序、ready/pending/failed/invalid、无效公开地址不请求、其他 owner 与重复 ID 不混入；空组不伪造占位。
- `tests/unit/list-page.test.ts`：列表 12 图只显示 9 张与 `+N`、点击第九张从完整组索引 8 打开且不导航；pending/failed/invalid 缩略图文案；同 URL 预览只 PUSH 一次、切图只 replace、后退关闭/前进恢复索引且不重读列表；触发节点重建后按稳定 ID 恢复焦点。
- `tests/unit/detail-reading.test.ts`：详情完整展示 12 张、点击第 11 张索引 10；纯图动态不显示“暂无内容”。
- `tests/e2e/dynamic-images.spec.ts`（desktop + Pixel 7，共 11 条）：4/9/12 图组与 `+N`（末张可访问名称标注“共 N 张”）；详情完整组；关闭恢复焦点/滚动、重复开关、正文展开不重置；后退关闭/前进恢复且不多退一级；pending/failed/invalid/加载失败与预览状态提示、缩略图重试、预览局部重试成功；冷缓存懒加载与只请求所点原图；长图 1200×6000 与纯图；四视口无横溢、触控目标 ≥44px、焦点/滚动恢复、工具栏/关闭可达；带异常图片的详情返回恢复列表锚点；跨详情重新挂载后的历史前进恢复；触发器消失退到后备焦点。Pixel 7 项目的切图/滑动路径由 `nextImage` 走真实触摸滑动，历史与前进恢复断言同时覆盖该路径。
- `tests/e2e/list.spec.ts`（生产装配 + HTTP 传输替身）：归档 DTO 的 `media` 共用公开地址；pending/failed 无地址、invalid 非 https 地址不请求；点击第三张只重发该地址，不预下载同组其他图片，不请求 `media_sources` 来源地址。

## 4. 顺带修正与差异处理

1. **预览组注册语义**：01 的 `setGroups` 是整表替换，夹具页卸载即清空。接入真实页面后，历史前进会重新挂载详情/列表，
   而预览标记的清理逻辑可能先于新页面注册组执行，导致前进记录被当成失效标记清掉。改为会话内合并注册（组 ID 稳定、数量由已读内容限定），
   并在真实浏览器覆盖“后退两次再前进两次”的恢复路径；没有新增第二套状态源。
2. **触发器重建**：关闭时原 `HTMLElement` 引用可能已断开（页面重挂载或重绘）。恢复顺序改为“原节点 → 稳定缩略图 ID → 页面后备焦点”，
   原 01 的“触发器消失退后备焦点”用例继续通过。
3. **生产占位资源**：pending/failed 预览需要 `/images/unavailable/placeholder.svg`，原路径只由夹具服务器提供。
   现作为 `frontend/public/` 资源进入生产构建；`check-isolation` 将 `/images/unavailable/` 从“夹具独有标记”移除，
   新增该资源的存在性断言，并继续用缩略/坏图/无效/可重试失败地址检测夹具泄漏，避免生产异常图片变成坏链又不放宽隔离。
4. **异常状态可见性**：仅用占位图会让 pending/failed/invalid 在预览内无法区分。新增应用自有的 `preview-note` 文案，
   不覆盖库内部结构；浏览器加载失败仍使用库错误槽与局部重试。

未发现需要恢复旧业务行为的文档/测试冲突。

## 5. 未验证与边界

- **真实 API + 隔离 SQLite**：本票使用受控归档读取与生产 Adapter 的 HTTP 传输替身，未访问真实 API 或当前运行实例；贯通回归留待 13。
- **iPhone Safari**：只在 Linux Chromium 桌面与 Pixel 7 模拟项目验证；正式设备结论留待 15。01 的真机结论不替代本票页面集成。
- **新版视觉签收**：图片栅格、占位提示与状态样式未由用户确认，不作为视觉回归基准（14）。
- **评论图片**：一级评论图片仍由 08 交付；本票只注册/展示动态 owner 的组。
- **生产 Nginx 静态交付**：`frontend/public` 资源随 `dist/` 构建，但本票未执行部署或 Nginx 实机检查；交付回归留待 16。
- **触摸手势**：窄屏滑动/双指/双击沿用 01 的薄手势层与已知限制，本票未新增预览引擎或边界停靠能力。
