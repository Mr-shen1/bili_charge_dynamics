# 08 一级评论图片阅读证据

- 对应票据：[08: 查看一级评论图片且不串组、不丢讨论进度](../issues/08-comment-image-reading.md)
- 对应规格：[前端重构实施规格](../spec.md) 实施决策 17–23、「必须覆盖的场景」中的图片、预览历史、图片请求与导航恢复条目；SRS FR-08/FR-09
- 实现位置：`frontend/src/dynamics/CommentItem.vue`（评论图片接入点）、`frontend/src/preview/`（组连接、缩略栅格、预览协调器、手势）、`frontend/src/mock/archiveReader.ts`（评论图片夹具）、`frontend/tests/unit/comment-images.test.ts`、`frontend/tests/e2e/comment-images.spec.ts`、`frontend/tests/e2e/comments.spec.ts`
- 证据状态：**Linux Chromium 桌面与 Pixel 7 模拟项目自动化通过；真实 API/SQLite、iPhone Safari、新版视觉签收未在本票执行。**

## 1. 本票交付

| 区域 | 内容 |
| --- | --- |
| 渲染接入 | `CommentItem` 在正文之后用 `DynamicImages` 渲染 `comment.images`；复用 01/04 的 `el-image` 缩略图与独立 `el-image-viewer`，没有第二套预览、图库或历史实现 |
| owner 隔离 | 组 ID 仍由 `preview/groups.ts` 统一生成：动态为 `dynamic-<dynamicId>`，根评论为 `comment-<commentId>`；点击缩略图只用该组索引，不按 URL 反查，动态图与不同评论的图不会串位 |
| 完整组可达 | 评论缩略图最多展示 9 张（与列表一致，控制行高），末张带 `共 N 张` 与 `+N`；展示数量只是裁剪，注册给预览的仍是完整组 |
| 顺序与索引 | 组内顺序即归档 `media` 顺序；所点索引与预览计数一致，超过 9 张时第九张仍解析到完整组索引 8 |
| 异常状态 | pending/failed/invalid 使用应用占位并分别提示"图片待归档 / 图片归档失败 / 归档图片地址不可用"；浏览器加载失败走库错误态并局部重试，只重发既有公开地址，不触发采集/上传，不回退 `media_sources` 来源图 |
| 预览历史 | 同 URL 打开只新增一条预览记录，切图只替换索引；按钮/键盘/Escape 关闭与浏览器后退都不会二次回退；有效会话前进恢复所看图片（含排序切换后触发元素已消失的情形） |
| 阅读状态保护 | 打开/切图/关闭预览不重挂载评论区，不重置排序、已加载批次或正文展开；关闭恢复滚动位置与触发缩略图焦点，节点消失时退到 `[data-preview-fallback-focus]` |
| 按需加载 | 冷缓存下评论区缩略图仍按可见性懒加载；打开预览只请求所点原图 |
| 夹具 | mock 归档给 4 条根评论挂图：混合状态组（6）、单张长图（1）、纯图四张（4）、超过九张（12），其余评论保持无图与 `pendingMediaCount` 旧来源待归档提示 |

不渲染回复图片、不在独立楼中楼页渲染根评论图片（`CommentThreadPage` 仍只展示根评论文字：该页不引入图片与折叠，见票据 07）。

## 2. 关键规则与实现位置

| 规则 | 位置 | 说明 |
| --- | --- | --- |
| 每条根评论一组 | `CommentItem.vue` 的 `imageOwner` + `DynamicImages` | owner 为 `{type:'comment', id: comment.id}`；组件内不复用动态组或全局组表 |
| 展示数量不裁剪数据 | `CommentItem.vue` 的 `imageDisplayLimit` + `ThumbnailGrid.vue` | 只把 `displayLimit` 传给缩略栅格，`ImageGroup.images` 始终是完整组 |
| 纯图评论 | `CommentItem.vue` 的 `hasText` / `hasMedia` | 有图时不写"暂无评论内容"；`pendingMediaCount` 仍单独表达来源存在但无当前关联的旧评论 |
| 组注册 | `useImagePreview.registerGroups` | 会话内合并注册：排序切换或历史前进重新挂载评论列表后，已读组仍能解析历史预览标记；已卸载的组不清理（沿用 04 语义），会话内组数量随已读内容单调增加 |
| 关闭恢复 | `useImagePreview.restore` | 顺序为"原节点 → 稳定缩略图 ID → 页面后备焦点"，并恢复记录时的 `scrollY` |
| 状态文案单一来源 | `preview/imageStatus.ts` | 缩略图与预览共用同一套异常文案与"仅浏览器加载失败可重试"规则 |
| 数据映射 | `data/archiveReader.ts` 的 `parseComment` | 根评论 DTO 字段是 `media`（TS 契约是 `Comment.images`）；`media` 缺失时保持 `images: undefined`，`pendingMediaCount = media_sources.length - images.length` |

## 3. 自动化结果

在 `frontend/` 下执行，环境与前序证据一致：Linux CachyOS、Node 24.21.0、pnpm 10.34.6、
Vue 3.5.44、Vue Router 4.6.4、Element Plus 2.14.7、Vitest 4.0.18、Playwright 1.58.2（Chromium headless，desktop + Pixel 7）。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（vue-tsc 覆盖 `.vue` 模板与 TS） |
| `pnpm test` | **143 passed**：新增 `comment-images` 7 + 既有 136（含 `archive-reader-comments` 新增 1 条评论 `media` 映射契约测试） |
| `pnpm test:e2e` | **147 passed / 10 skipped**（新增 `comment-images.spec.ts` 6 例 × 2 项目，`comments.spec.ts` 新增生产装配 1 例 × 2 项目；跳过项仍是需要触摸环境的窄屏手势用例） |
| `pnpm test:e2e:production` | 3 passed / 3 skipped（生产六路由、404、无自检入口、fault 装配） |
| `pnpm check` / `pnpm check:dist` | 均通过；`dist` 无 mock 入口/夹具/归档数据，应用占位资源存在，数据层副本一致 |

新增/改写的自动化覆盖：

- `tests/unit/comment-images.test.ts`（7 例，页面行为接缝）：评论 owner 组 ID/标签、顺序与所点索引；12 张只展示 9 张且末张进入完整组索引 8；动态组与两条评论组互不混入；pending/failed/invalid 占位与不回退来源图；旧评论无 `media` 时不出图只提示待归档数量；打开/切图/关闭预览不重置排序与已加载批次、不新增历史；关闭恢复触发焦点；触发节点被替换（`cloneNode` 模拟，非真实重挂载）后按稳定 ID 找回焦点——真实重挂载路径由浏览器用例覆盖。
- `tests/unit/archive-reader-comments.test.ts`（+1 例，传输映射接缝）：根评论 `media` 按顺序映射为图片、owner 绑定该评论、非 https 地址不冒充成功、其他 owner 与重复 ID 不混入、`pendingMediaCount` 只计尚无当前关联的位置，且整段读取不请求任何来源地址。
- `tests/e2e/comment-images.spec.ts`（desktop + Pixel 7，各 6 例，真实浏览器）：混合状态组（缩略占位、唯一"重试缩略图"、预览内逐项切换、可重试项重发既有地址且成功、异常不阻断关闭、库关闭按钮可关闭、全部请求落在应用自有夹具地址）；纯图/单张长图（1200×6000）/12 图评论组与索引、组 ID 归属；同 URL 打开不重挂载评论区与详情、切图不新增历史、焦点进入预览、底层不滚动、关闭恢复焦点与滚动且不重置排序与展开、后退优先关闭且不多退一级、前进恢复所看图片，排序切换导致缩略图节点真实重建后仍按稳定 ID 找回焦点；排序后原触发缩略图消失时前进恢复预览并以页面后备焦点关闭；四视口无横溢、缩略触控目标 ≥44px、宽屏工具栏可见/窄屏隐藏、四档焦点与滚动恢复；冷缓存下四张全可用组（`comment-quad`）懒加载与只请求所点原图。
- `tests/e2e/comments.spec.ts`（+1 例，生产装配 + HTTP 传输替身）：根评论 `media` 经真实 DTO 映射渲染为 `comment-<id>` 组、5 张全部可达、点击第三张打开 `3 / 5`、不请求 `media_sources` 来源图、打开预览不新增组内其他图片请求、预览期间不重读评论、关闭后排序与已加载批次不变。

## 4. 实施中发现并修正的问题

1. **组注册形成自依赖循环**（真实缺陷）：`registerGroups` 在 `watchEffect` 内先读 `groupsById.value` 再写同一个 ref，等于让注册它的组件依赖自己的写入。只有一个图片组时未暴露，评论区出现多条带图评论（同页三个组）时 jsdom 报 `Maximum recursive updates exceeded in component <DynamicImages>`。改为普通 `Map` 保存已注册组、内容变化时才写一次 `shallowRef`，注册因此不再被自身写入触发；合并注册语义（历史前进仍能解析旧标记）保持不变。
2. **mock 评论图片夹具复用动态夹具工厂**：混合状态组改为按 key 生成（`mixedGroup(key)`），动态与评论各用自己的 key，动态状态、地址与索引不受影响；长图夹具同样参数化，注释状服务器 `long` 前缀约定保留。
3. **评论列表项计数口径**：评论区内包含回复列表项，e2e 用 `data-reading-id^="comment:"` 只统计根评论，避免把回复当评论。

未发现需要按旧描述恢复/删除业务行为的文档或测试冲突。

## 5. 未验证与边界

- **真实 API + 隔离 SQLite**：本票页面与 e2e 使用 mock 受控归档或 HTTP 传输替身（仍经真实 Adapter 映射），未访问真实 API 或当前运行实例；贯通回归留待 13。
- **iPhone Safari**：只在 Linux Chromium 桌面与 Pixel 7 模拟项目验证；正式设备结论留待 15。01 的真机结论不替代本票页面集成。
- **新版视觉签收**：评论图片栅格在评论正文下的间距与占位样式未由用户确认，不作为视觉回归基准（14）。
- **回复图片与独立楼中楼根评论图片**：按票据范围不新增；楼中楼页仍只展示根评论文字与回复分页。
- **生产 Nginx 静态交付**：本票未执行部署或 Nginx 实机检查；交付回归留待 16。
- **生产共用 URL**：缩略与预览共用同一公开地址时，缩略图已加载导致无法从网络区分"所点原图"；本票在 mock 夹具（可区分地址）断言只请求所点原图，生产共用地址只断言打开预览不新增组内其他图片请求，不以缓存命中冒充未请求证据。
