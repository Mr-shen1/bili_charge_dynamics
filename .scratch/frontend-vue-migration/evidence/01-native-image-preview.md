# 01 原生图片预览与浏览器历史验证证据

- 对应票据：[01: 验证原生图片预览与浏览器历史的组合行为](../issues/01-native-image-preview-validation.md)
- 对应规格：[前端重构实施规格](../spec.md) 第 13–14、16–24 条与「必须覆盖的场景」中的图片、预览历史、图片请求、响应式条目
- 实现位置：`.scratch/frontend-vue-migration/prototype/`（隔离原型，不是应用入口）
- 证据状态：**Linux Chromium 自动化为已执行通过；iPhone Safari 真机未执行。** 因此本票不构成完成，也不解除下游依赖。

## 1. 结论摘要

在最小 Vue 3 应用中跑通打开图片 → 切换 → 关闭 → 浏览器后退/前进的完整路径后，原生组合可满足本次保留底线：

- 缩略图用 `el-image`（不传 `preview-src-list`，无库内建预览），预览用应用协调的独立 `el-image-viewer`；全局只挂载一个预览实例。
- 桌面（>640px）用库原生界面：左右切图箭头、图标工具栏（缩小/放大/适应/旋转）、右上角关闭；**没有文字按钮，也没有单独的“关闭预览”按钮**。
- 窄屏（≤640px）改为手势：左右滑动切图（首尾不相连）、双指缩放当前图片（只缩放图片、不缩放页面）、双击放大到 2.5 倍或从放大状态回到原始比例；未放大时图片固定、单指拖动不移动图片。隐藏库的切图箭头与图标工具栏，只保留右上角关闭与 `n / m` 计数。
- 打开只新增一条**同 URL** 历史记录（含快速重复点击）；切图只改当前记录的 state；Escape/右上角关闭/浏览器后退都经同一关闭入口，只退一步。
- 前进能恢复同一预览与所看图片；刷新与形状损坏的残留标记在加载时被替换清理，不出现空弹层或循环。
- 单张打开只请求当前原图（网络记录里 `full/*` 的地址集合只有被点那一张），缩略图按可见性懒加载；生产共用同一 URL 时同样不为打开而请求整组。
- 浏览器失败可局部重试（只重发该图片地址）；未上传/归档失败用应用自有占位图，不访问来源业务图、不触发采集或上传。
- 预览期间焦点留在预览内、底层不滚动；关闭恢复原滚动位置与触发焦点，触发器被移除时退到页面后备位置，滚动锁完全释放。
- 360/390/768/1280 四宽度无页面横溢；窄屏由手势承担切图与缩放，宽屏保留库控件，右上角关闭按钮 44×44。

iPhone 13 Pro（iOS 16.4，Safari 与系统同号 16.4）真机两轮验证完成：第一轮确认长图可读、滑动切图、双指缩放、关闭、后退/前进，
并发现未放大时图片可被自由拖动；补齐“未放大不可拖动”与“双击放大/还原”后第二轮复验全部通过。本票的保留底线已全部取得真机证据。

## 2. 环境与锁定版本

| 项目 | 取值 |
| --- | --- |
| 操作系统 | CachyOS Linux，内核 7.2.11-1-cachyos |
| Node | v24.21.0（`.nvmrc`，nvm 管理） |
| pnpm | 10.34.6（`packageManager` 锁定） |
| Vue | 3.5.44 |
| Vue Router | 4.6.4 |
| Element Plus | 2.14.7 |
| TypeScript | 5.9.3（`pnpm typecheck` 用 vue-tsc 3.3.13） |
| Vite | 7.3.1（`@vitejs/plugin-vue` 6.0.10） |
| Vitest | 4.0.18（jsdom 28.1.0） |
| Playwright | 1.58.2，Chromium 145.0.7632.6（headless） |
| 仓库基线 | `ba38fc5`（本票工作在其之上，未改动主应用 React 源码） |

版本全部写入 `prototype/package.json` 与 `prototype/pnpm-lock.yaml`；`pnpm list --depth 0` 列出 3 个直接依赖 + 9 个直接开发依赖，
与本表一致。Element Plus 用公开组件按需引入（`base`/`button`/`image`/`image-viewer` 的 style 入口），
生产构建 CSS 33.46 kB（gzip 5.33 kB）、JS 182.60 kB（gzip 69.61 kB）；未引入 Tailwind、第二套 UI 库、Pinia 或请求缓存框架。

## 3. 受控夹具与网络观测

`prototype/server/imageServer.mjs` 只提供本原型自己的确定性 SVG 图片，由 Vite dev/preview 代理到同源 `/images`，不访问真实来源或 OSS：

| 路径 | 行为 |
| --- | --- |
| `/images/thumb/<key>.svg` | 320×200 缩略图 |
| `/images/full/<key>.svg` | 1200×675 预览图；`long-*` 为 1200×6000 |
| `/images/unavailable/<key>.svg` | 应用自有“图片未归档”占位（真实图片，不是来源业务图） |
| `/images/invalid/<key>.svg` | 404（无效公开地址） |
| `/images/broken/<key>.svg` | 恒 503（坏图，重试也不会成功） |
| `/images/flaky/<key>.svg?failures=1` | 首次 503、之后 200（验证局部重试） |
| `/__requests` / `/__reset` | 读取与清空服务端请求记录 |

全部图片响应 `Cache-Control: no-store`，使请求计数不依赖缓存命中；生产缓存策略不由此证据覆盖。
夹具分组：单图、四图、十二图、长图、成功/坏图/未上传/无效地址混合组、缩略与预览共用地址组、全未上传组、
两个不同 owner 评论组。十二图刻意只渲染前 9 张缩略图并显示 “+3”：用于证明“缩略图只显示部分时完整组仍可达”，
是夹具条件，不是要恢复九格上限的产品规则。

## 4. 连接层与公开配置

| 位置 | 内容 |
| --- | --- |
| `src/preview/useImagePreview.ts`（约 165 行） | 唯一导航协调器：`router.push({ force: true, state })` 打开、`router.replace({ force: true, state })` 同步索引、`router.go(-1)` 关闭；`router.afterEach` + `popstate` 同步 `history.state`；同步 `opening` 门闩防重复打开；内存保存触发元素 id 与打开时 `scrollY`；失效标记 `replace` 清理；关闭去重 |
| `src/preview/PreviewHost.vue`（约 245 行） | 单实例 `el-image-viewer`（`:teleported="false"`，渲染在手势容器内）：`url-list`/`initial-index`/`infinite="false"`/`scale`/`hide-on-click-modal="false"`/`close-on-press-escape`；公开 `progress`、`viewer-error` slot（窄屏另有 `toolbar` slot 捕获公开 `reset` 用于清偏移）；窄屏触摸手势：滑动切图、双指缩放、双击放大/还原、未放大时拦截拖动；状态按 `activeIndex` 取 |
| `src/preview/useCompactViewport.ts` | `matchMedia('(max-width: 640px)')` 响应式断点，与规格窄屏阈值一致 |
| `src/preview/ThumbnailGrid.vue`（约 60 行） | `el-image` + `lazy`，点击交给协调器；缩略图失败与重试在 tile 之外，避免按钮嵌套 |
| `src/preview/state.ts`（55 行） | 历史元数据纯函数：`{ sessionId, previewId, groupId, index }`，只有原始值 |
| `src/preview/imageStatus.ts` | 状态文案与“是否可局部重试”单向映射，缩略图与预览共用 |

约束遵守情况：

- **无双重预览**：缩略图不传 `preview-src-list`；预览只由 `PreviewHost` 挂载一次。断言锚点集中在 `tests/e2e/support.ts`
  的 `viewer()`/`viewerImage()` 两个 helper（Element Plus 未给预览根与预览图公开 role/名称），其余断言只用应用自有可访问名、
  公开图片地址与可见文本。
- **不重写库引擎**：缩放、旋转、拖动、焦点陷阱、滚轮缩放仍是库原生；应用只补“滑动切图”“双指缩放”“双击缩放/还原”三种库不提供的手势。
  双指/双击缩放通过公开 `scale` prop 受控写入，不解析库内部 transform；双击还原需要的偏移复位通过公开 `toolbar` slot 的 `reset`（contain↔original）
  同步调用两次完成，模式最终仍为 contain，未触碰库内部方法。
- **未放大时禁止拖动**：窄屏在 capture 阶段对图片上的单指 `touchstart` 调用 `stopPropagation`，库的 pan 不会启动，
  因此单指只用于左右滑动切图；放大后不再拦截，拖动交给库。
- **窄屏隐藏库控件（唯一一处库内部类选择器）**：`@media (max-width: 640px)` 内隐藏 `.el-image-viewer__prev/__next/__actions`，
  让位于手势。这是全仓唯一一处库内部类覆盖，理由、风险与守护方式写在该 CSS 注释里；`preview-gestures.spec.ts`
  的“窄屏隐藏切图箭头与图标工具栏”断言会在覆盖失效时失败。
- **应用不重复锁滚动**：滚动锁只由 `el-image-viewer` 的 `useLockscreen` 提供，保护层不自行设置 `overflow`。
- **关闭 Vue Router 自带滚动处理**：`scrollBehavior: () => false` 与 `history.scrollRestoration = 'manual'`，位置恢复只由协调器负责。
- **遮罩不关闭预览**（`hide-on-click-modal="false"`）：实测库的遮罩层盖在图片之上，双击缩略图时第二次点击会落在遮罩上。
  开启遮罩关闭会“打开后立刻关闭”，长图拖动也更容易误关；遮罩关闭不在本次底线内，关闭来源是右上角 ×、Escape 与浏览器后退。
- **未启用未确认功能**：不展示下载、自动轮播；不实现自由画布缩放；图片只使用夹具的公开地址。

历史元数据形状（实测 `history.state`，`force: true` 的 push 不覆盖 Vue Router 自有字段）：

```json
{"back":"/","current":"/","forward":null,"replaced":false,"position":3,"scroll":null,
 "biliChargeDynamicsPreview":{"sessionId":"…","previewId":"…","groupId":"many","index":2}}
```

切图后 `position` 不变、`replaced: true`、只有 `index` 变化（实测 index 2 → 3）。

## 5. 逐条验收结果

| # | 票据要求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 核实并固定版本，记录构建与验证环境；nvm + pnpm | 通过 | 第 2 节；`package.json`/`pnpm-lock.yaml` |
| 2 | 缩略用 `el-image`、预览用应用协调的独立 ImageViewer，无双预览、无私有实现 | 通过 | `preview-images.spec.ts`「只挂载一个预览实例与一张预览图」；第 4 节 |
| 3 | 打开只新增一条同 URL 历史，切图不新增；按钮/键盘/Escape 关闭与后退不二次回退；前进恢复；刷新与失效标记安全清理 | 通过（Chromium） | `preview-history.spec.ts` 11 项（含快速重复点击、刷新与损坏标记清理） |
| 4 | 唯一导航协调器负责历史与关闭来源；历史只存可序列化轻量元数据，尊重 Router 自有 state | 通过 | `preview-state.test.ts` 14 项；`preview-history.spec.ts` 状态形状与长度断言；第 4 节 |
| 5 | 单图/多图/长图/混合组保持 owner、顺序与所点索引；完整组可达；异常不阻断切换与关闭；浏览器失败可局部重试 | 通过 | `preview-images.spec.ts` 混合组、未上传组、owner 隔离、重试、十二图 9/12→12/12 |
| 6 | 冷缓存、缩略/预览地址可区分时检查实际网络；打开单张不要求整组原图；另验证生产共用 URL；不新增“恰好一个请求”限制 | 通过 | `preview-images.spec.ts`「打开单张只请求所点原图…」「生产共用缩略/预览地址…」；断言用地址**集合**语义 |
| 7 | 预览期间焦点与操作留在预览内、底层不滚动；关闭恢复原位置与触发焦点/合理后备；覆盖触发器消失、重复开关、双重锁定 | 通过（Chromium） | `preview-history.spec.ts`「焦点、滚动与恢复」2 项（含关闭后滚动锁完全释放）与「重复关闭与重复开关…」 |
| 8 | 四宽度工具栏可达、无页面横溢、触控约 44px；Linux Chrome 与 **实际 iPhone Safari** 分别验证长图可读、切换和关闭并记录版本过程 | 通过：四宽度无横溢、宽屏库控件与窄屏手势、右上角关闭 44×44、Linux Chromium 长图/滑动/双指/双击通过；iPhone 13 Pro / iOS 16.4 真机两轮验证通过（含禁拖与双击） | `preview-layout.spec.ts` 4 宽度；`preview-gestures.spec.ts` 10 项；`preview-images.spec.ts`「长图阅读」；第 9 节真机记录 |
| 9 | 不暴露下载、自动轮播、自由画布缩放等；只用公开业务图片地址；不回退来源业务图、不触发采集或上传 | 通过 | 第 4 节配置清单；夹具无来源地址；网络记录只有夹具路径 |
| 10 | 记录公开配置、连接层、结果与可复核证据；设备证据缺失时不得完成本票 | 本文档 + [原型 README](../prototype/README.md)；**设备证据缺失，本票保持未完成** | 本文件；票据 Status |

## 6. 已执行命令与结果

在 `prototype/` 下按顺序执行：

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过（12 个直接依赖，含 3 个运行依赖） |
| `pnpm typecheck`（vue-tsc） | 通过，无错误（覆盖 `.vue` 模板与 TS） |
| `pnpm test`（Vitest） | 14 passed |
| `pnpm build` | 通过；`index.html` 0.42 kB、CSS 33.46 kB（gzip 5.33）、JS 182.60 kB（gzip 69.61） |
| `pnpm test:e2e`（dev 服务器） | **60 passed / 10 skipped**（35 用例 × desktop/mobile；窄屏手势用例在无触摸环境跳过，56 s） |
| `E2E_TARGET=preview pnpm test:e2e`（生产构建） | **60 passed / 10 skipped**（48 s） |

用例清单（desktop + mobile 各 35 条）：

- 历史与关闭来源（11）：打开只新增一条同 URL 记录/切图不新增；快速重复点击只新增一条；Escape 关闭不二次后退；
  后退关闭+前进恢复对应图片；Escape 关闭（重复调用不多退）；遮罩不触发关闭；重复关闭与重复开关不双预览不多退；
  打开/切图/关闭不重挂载底层页面；刷新后失效标记清理；损坏标记清理。
- 焦点、滚动与恢复（2）：焦点留在预览内+底层不滚动+关闭恢复焦点与位置+滚动锁完全释放；触发器消失退到后备焦点。
- 图片组与异常（8）：打开单张只请求所点原图；混合组顺序/索引/切换/关闭；浏览器失败局部重试（只重发该地址）；
  未上传组只用应用占位；owner 隔离且末张不环绕；共用地址组；单实例与单预览图且无文字关闭按钮；9 张缩略图后完整组仍可达。
- 长图（1）：1200×6000 图片可用键盘放大到超过视口高度、可拖动，切到原图模式后高度 > 2×视口。
- 四宽度（4）：360/390/768/1280 无页面横溢、缩略触控 ≥44px、窄屏无切图箭头与图标工具栏、宽屏箭头可见、右上角关闭 44×44、
  预览期间不滚动、关闭不跳位。
- 窄屏手势（10，仅触摸环境执行）：隐藏箭头/工具栏与无文字关闭按钮；左右滑动切图；到头后继续滑不前进不环绕；
  双指放大图片且页面 `visualViewport.scale` 保持 1；双指缩回接近原尺寸；放大后单指拖动不触发切图；
  未放大时拖动不移动图片；双击放大到 2.5 倍、再双击回到原始比例并居中；放大后拖动有效且双击还原清掉偏移；关闭后不残留缩放。

## 7. 关键观察与限制

1. **按需加载成立**：Element Plus 2.14.7 的 `image-viewer` 只渲染当前 url 的单个 `<img>`（`key=currentImg`），
   打开第 5 张时服务端记录到的 `full/*` 只有该张，其它成员未请求；缩略图由 `el-image lazy` 按可见性加载。
2. **同 URL 记录需要 `force: true`**：`router.push/replace` 对相同地址默认判为 duplicated 而不写历史；
   `force: true` 才会新建（push）或改写（replace）记录，并由 Router 自己维护 `back/current/forward/position`。
   每次切图会走一次同地址导航，`afterEach` 会触发；页面组件不因此重新挂载（有专门断言），
   但应用中若存在依赖 `route` 对象身份的 watcher 需按公开行为核对。
3. **marker 同步是异步的**：读的是浏览器 `history.state`，由 `afterEach` / `popstate` 刷新，因此“是否已打开”不能只看 marker；
   协调器额外维护同步 `opening` 门闩，快速双击只产生一条记录（有专门断言）。
4. **刷新不删除历史记录，只清理标记**：`history.state` 里已消费的同 URL 记录无法移除；刷新后标记被替换为 `null`，
   后退先停在同地址（无空弹层），再退到来源页。这与 React 基线“replace 清理”一致。
5. **`history.scrollRestoration` 必须显式设 `manual` 并关掉 Router scrollBehavior**，否则浏览器/路由的异步滚动恢复会与协调器竞争。
6. **滚动锁只有库一层，且移除有 200 ms 延迟**：库给 `body` 加类名 + `overflow: hidden`，随后用 `setTimeout(200)` 移除。
   因此不能给 `html`/`body` 预置 `overflow-x: hidden`——否则根滚动容器不再接受该锁，实测会出现页面滚动渗透（本轮已修正并加断言）。
7. **遮罩层级需要自有定位**：库的 `.el-image-viewer__mask` 是绝对定位元素；`viewer-error` slot 内容默认在其下方，
   重试按钮会被遮罩接住。给应用自有 `.preview-error` 加 `position: relative; z-index: 1` 后恢复可点，未改库内部样式。
8. **库不提供滑动切图与双指缩放**：`image-viewer` 的触摸逻辑只有单指拖动（pan），`touchend` 不判定 swipe；
   也没有 pinch 处理，iOS 上双指默认缩放整个页面。因此这两项由应用在 `:teleported="false"` 的手势容器上补齐：
   `touchstart/touchmove/touchend` 计算水平位移与两指距离，`gesturestart`/`touchmove` 的 `preventDefault` 阻止页面缩放。
9. **双指缩放走公开 `scale` prop 受控**：应用只改 prop，库内部 `watch(scaleClamped)` 写入 transform。
   为避免与库按钮/滚轮抢状态，窄屏隐藏库的图标工具栏，缩放来源唯一（双指）；宽屏不启用 pinch，库控件维持内部状态。
10. **切图复位**：应用切图前把 `scale` 归 1，配合库的 `watch(activeIndex) → reset()`，不会把上一张的倍率带到下一张（有断言）。
11. **首尾不相连**：`infinite="false"` 同时约束键盘、滑动与库箭头；末张继续滑/按不环绕，首张反向同理（有断言）。
12. **长图没有“适宽”**：库只在 contain 与原图（1:1）之间切换（空格键或工具栏图标）；长图靠放大、原图模式 + 单指/鼠标拖动阅读。
13. **重试通过重挂 viewer 实现**：`retryGeneration` 变化会让 `el-image-viewer` 重新挂载并重发当前图片，
    代价是用户已做的缩放/旋转被重置，索引与历史不变（有断言）。
14. **库在未放大时也允许拖动且不回弹**（真机反馈的来源）：解决方式是窄屏 capture 阶段拦掉图片上的单指 `touchstart`，
    库的 pan 不启动；这同时消除了“未达阈值的小位移残留偏移”。放大后仍交给库拖动，保持阅读手感。
15. **库没有公开的 transform 复位**：双击还原既要 scale 归 1，也要清掉拖动产生的 offset。应用通过公开 `toolbar` slot 取得 `reset`
    （contain↔original 切换）并同步调用两次：transform 被复位两次、模式最终仍是 contain，避免了重挂 viewer 造成的图片重新请求与闪烁。
16. **双击放大以图片中心为准**：库未公开 offset 控制，无法按双击点定位放大区域；放大到 2.5 倍后单指拖动到目标位置查看，
    这是本轮接受的限制（若必须“点哪放大哪”，需库提供 offset 能力或用户重新决策）。
17. **宽屏触屏设备**（如 iPad 横屏 ≥641px）仍按桌面分支处理：显示库图标工具栏与箭头，双击缩略图/滚动行为与桌面一致；
    本次只按规格阈值 640px 分流，未按 `pointer: coarse` 单独分支。
18. **typecheck 覆盖 `.vue`**：vue-tsc 3.3.13 + TS 5.9.3 可直接纳入后续 `pnpm typecheck`；`HistoryState` 类型只声明原始值，
    嵌套元数据需在写入处显式收窄（运行期仍是普通可结构化克隆对象）。
19. **触摸目标**：右上角关闭为库原生 44×44（有断言）；宽屏图标工具栏沿用库原生尺寸（约 23px 图标），
    以鼠标精度与键盘（方向键、空格、Escape）兜底；窄屏不依赖这些图标，由手势与 44px 关闭承担。

## 8. 真机验证记录（iPhone 13 Pro / iOS 16.4）

设备：iPhone 13 Pro；系统 iOS 16.4；Safari 版本与系统同号（16.4，WebKit 615.1.26）。访问方式：局域网 `http://192.168.8.20:4318/`（生产构建 + 图片夹具）。
iOS 未在“关于本机”单独列出 Safari 版本，如需 UA 原文可用 Safari 打开 <https://www.whatsmybrowser.org/> 复核。

| 轮次 | 检查项 | 结果 |
| --- | --- | --- |
| 第一轮（滑动/双指版） | 只有右上角关闭与 `n / m`；左右滑动切图；双指只缩放图片；长图可读；Safari 后退/前进；关闭后位置/焦点与重开复位 | 6 项正常 |
| 第一轮 | 未放大时单指拖动 | **问题**：图片可被自由拖动（库原生 pan） |
| 第二轮（禁拖 + 双击版） | 未放大时拖动不移动图片、滑动仍能切图 | 通过 |
| 第二轮 | 双击放大 / 双击还原（含拖动后复位） | 通过 |
| 第二轮 | 双指放大 → 拖动 → 双击还原 | 通过 |

真机反馈的三条体验诉求（边界停靠、未越界不可拖动、跟手切图动画）经核查不在库公开能力内，**已裁决接受现状并记为已知限制**（第 9 节）。

## 9. 库能力边界与已裁决的已知限制

真机验证通过后，用户提出三条交互优化。核查 Element Plus 2.14.7 的公开能力后，结论是这三条都**不在库的公开 API 内**：

| 诉求 | 库现状 | 结论 |
| --- | --- | --- |
| 拖动到图片边界应停住，不能拖出屏幕 | `image-viewer` 的 pan 直接累加 `offsetX/offsetY`，无 clamp；上游 issue [#12473](https://github.com/element-plus/element-plus/issues/12473)（“图片超出屏幕范围”）至今 closed-inactive，未见边界约束 | 无公开 `offset`/`bound` prop，无法在不触库内部的前提下限制 |
| 未达到上下左右边界时不可拖动 | 同上：库不暴露渲染尺寸与 offset，应用只能读 `getBoundingClientRect()` 判断是否越界，但没有写 offset 的入口 | 只能“越界后整回中心”，无法“停在边界” |
| 切图跟手过渡（滑动过程中显示下一张） | 切图是 `setActiveItem` 换 `activeIndex`，canvas 内单个 `<img key=currentImg>` 直接替换，没有位移过渡；touch 只用于 pan（PR [#12550](https://github.com/element-plus/element-plus/pull/12550)），没有 swipe/进度事件 | 跟手需要自建双图轨道与 translate 动画 |

库也没有真正的双指缩放：PR [#3114](https://github.com/element-plus/element-plus/pull/3114) 只阻止浏览器双指缩放，未实现图片 pinch（本轮由应用补层实现）。

因此这三条要落地就必须离开“薄手势层”，进入自研预览渲染（等价于恢复整套自研预览引擎），与当前规格的
“不重写缩放、旋转和手势引擎”“不恢复整套自研预览”直接冲突。

**裁决（用户，真机验证后）：接受现状，记为已知限制，不阻塞本票、后续票据与统一上线门槛。**
这三项是体验优化而非内容底线；若以后确认要改，应单独立“窄屏预览渲染层”票据，一次性完成边界约束、pinch、跟手切换，
并同步修订规格中的手势条款，不在本票与现有票据里零散补丁。

## 10. 未验证事项（不得视为通过）

- **三条新交互诉求**：边界停靠、未越界不可拖、跟手切图动画（第 9 节）已裁决接受现状，作为已知限制记录，不实现、不作为阻断项。
- 真机只覆盖 iPhone 13 Pro / iOS 16.4；其他机型、iPad 横屏（宽屏触屏）与 Android 未验证，自动化 Chromium 与 Pixel 7 模拟不能替代。
- **生产缓存与尺寸变体**：夹具统一 `no-store` 且缩略/预览常为不同地址；真实 OSS 的缓存头、共用 URL 与图片体积未在本票验证。
- **真实内容图片**：只用确定性 SVG 夹具，未使用真实归档图片（表情、超长图、极小图、动图占位等）。
- **视觉基准**：本原型只验证行为；主题变量与一份全局样式表是原型简化（正式页面按规格用 scoped CSS/CSS Modules），
  截图不构成新版视觉基准（后续票据处理）。
- **`/other` 演示页与导航**：仅为“后退不多退一级 / 前进恢复”提供起点页，属测试脚手架，不是产品页面集合。

## 11. 复现与真机操作

```bash
cd .scratch/frontend-vue-migration/prototype
pnpm install
pnpm typecheck && pnpm test && pnpm test:e2e
E2E_TARGET=preview pnpm test:e2e
```

iPhone Safari 步骤见[原型 README](../prototype/README.md#iphone-safari-手工验证尚未执行)：
`pnpm images` + `pnpm build && pnpm serve:lan`，用手机访问 `http://<局域网 IP>:4318/`，记录机型、iOS 与 Safari 版本及每步结果。
