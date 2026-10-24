# 03 动态详情与阅读恢复证据

- 对应票据：[03: 进入动态详情并恢复列表与详情阅读位置](../issues/03-detail-reading-restoration.md)
- 对应规格：[前端重构实施规格](../spec.md) 实施决策 5、9–15、25 与「必须覆盖的场景」中的导航与恢复、阅读条目
- 实现位置：`frontend/src/app/`（historyState、navigation、snapshots、readingPosition、useVisitPosition）、`frontend/src/dynamics/`（DetailVisit、useDetailRead、ListVisit、useListRead、DynamicCard）、`frontend/src/pages/`（ListPage、DetailPage）、`frontend/src/preview/`（useImagePreview、marker）
- 证据状态：**Linux Chromium 自动化通过；真实 API/SQLite、iPhone Safari、新版视觉签收未在本票执行。**

## 1. 本票交付

| 区域 | 内容 |
| --- | --- |
| 唯一导航协调器 | `src/app/navigation.ts` 在应用根部创建（`App.vue` provide），持有会话标识、访问表、主动入口、历史返回、快照保存，以及预览与访记的历史写入；页面只通过注入使用，不自行读写历史 |
| 历史元数据 | `src/app/historyState.ts` 定义两个应用自有命名空间（访问 `biliChargeDynamicsEntry`、预览 `biliChargeDynamicsPreview`），一次写入两者，不覆盖 Vue Router 自有的 back/current/forward/position；原 `preview/state.ts` 合并至此，测试改用新路径 |
| 访问身份 | 每条浏览器历史记录对应一次页面访问（`pageEntryId`）；首屏/刷新/外来导航按地址同步得到新访问并在导航前补写标记，同一动态或同一路径的多次访问各有快照 |
| 列表恢复 | `ListVisit` 以访问标识为 key；恢复已加载批次、正文展开与稳定锚点位置；离开时仍在读取的批次按“已取消”保存，返回后从原 cursor 继续，不遗留永久加载态 |
| 详情页 | `DetailVisit`/`useDetailRead` 读取 `readDetail`，展示作者、北京时间、完整正文（不折叠、不带评论入口）与来源计数；详情直达/刷新重新读取，历史恢复已有成功内容不重复请求；不存在与请求失败分别表达；无有效列表来源时替换为首页 |
| 位置恢复 | `src/app/useVisitPosition.ts` + `src/app/readingPosition.ts` 先还原内容与展开，再按 `[data-reading-id]` 稳定锚点定位，最多等待两个布局帧；缺失锚点立即走有界像素后备；用户滚轮/触摸/按键后立即停止纠正 |
| 卡片入口 | `DynamicCard` 普通点击、键盘 Enter 经协调器进入详情顶部；组合键/中键保留浏览器原生新标签页语义；选中文字、折叠按钮、身份区与内嵌操作不误触导航 |
| 预览协作 | `useImagePreview` 只保留图片组、索引与手势；不再自行同步 `popstate`/写 state，打开预览前等待底层访问标记落盘，避免同地址预览记录丢掉底层访问身份 |

本票不渲染动态图片与评论区（04/05 交付），不新增楼中楼快照、不修改后端、不执行部署。

## 2. 关键规则与实现位置

| 规则 | 位置 | 说明 |
| --- | --- | --- |
| 访问 ≠ 内容 ≠ 请求运行态 | `snapshots.ts`、`useListRead`、`useDetailRead` | 内容实体由 Reader 提供；快照只保存已呈现结果、展开与位置；进行中的请求留在页面实例内 |
| 主动进入顶部 | `navigation.openDetail` + `DetailVisit` 无快照时定位 0 | 新访问没有阅读快照，旧位置不会被当作主动入口的目标 |
| 返回来源列表 | `navigation.returnToList` | 仅当登记的来源访问仍是列表路径时 `router.back()`，否则 `replace` 到首页，绝不盲目离站 |
| 同一动态多访问 | 访问表按 `pageEntryId` 索引 | 不以动态 ID 或路径作为快照键；`/` 主题链接形成的新列表访问会保留原详情访问 |
| 先内容后位置 | `ListVisit`/`DetailVisit` 的 `onMounted` | 快照批次与展开状态同步渲染后再定位；恢复只等两个 rAF，不轮询图片或布局 |
| 用户优先 | `restoreReadingPosition` 的 wheel/touchmove/pointerdown/keydown 监听 | 用户一操作即停止纠正并撤销待执行帧 |
| 不重复请求已恢复详情 | `useDetailRead` 的 `cached` | 历史恢复以快照内容为初始成功态，只有显式重试才重读；列表恢复则复用已加载批次 |
| 迟到回调隔离 | `useListRead`/`useDetailRead`/`ListVisit`/`DetailVisit` | 先校验访问存活、请求身份与 `signal.aborted`；旧成功/失败/完成不触达新访问 |
| 导航前补写访问标记 | `navigation.persist` + `afterPersist` | 初次加载/刷新的记录没有应用标记；打开详情或预览前先完成 `router.replace`，否则返回时访问身份与快照会丢失 |
| 单一滚动责任方 | `router.scrollBehavior: () => false` + `history.scrollRestoration='manual'` + 协调器 | 路由与浏览器都不自动恢复；预览关闭仍由预览层恢复触发焦点与位置，两者不重复纠正 |

## 3. 自动化结果

在 `frontend/` 下执行，环境与 01/02 证据一致：Linux CachyOS、Node 24.21.0、pnpm 10.34.6、
Vue 3.5.44、Vue Router 4.6.4、Element Plus 2.14.7、Vitest 4.0.18、Playwright 1.58.2（Chromium headless，桌面与 Pixel 7 两个项目）。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（vue-tsc 覆盖 `.vue` 模板与 TS） |
| `pnpm test` | **48 passed**：历史元数据 14 + 预览标记有效性 3 + 详情/阅读恢复 11 + 既有 20 |
| `pnpm test:e2e` | **90 passed / 10 skipped**（既有壳/预览/列表 78 + 本票详情恢复 12；详情恢复跑 mock 装配的真实浏览器，跳过项是需要触摸环境的窄屏手势用例） |
| `pnpm test:e2e:production` | 3 passed / 3 skipped（生产六路由、404、无自检入口；fault 装配首次列表失败后重试恢复） |
| `pnpm build` / `pnpm build:mock` / `pnpm check:isolation` / `pnpm check:data-parity` | 均通过；`dist` 无 mock 入口、图片夹具与归档数据，数据层副本与根 `src/data` 一致 |

新增/改写的自动化覆盖：

- `tests/unit/history-state.test.ts`（原 `preview-state.test.ts`）：两个命名空间的读取/清理、损坏标记、访问标记缺字段、共同写入不互相覆盖。
- `tests/unit/preview-marker.test.ts`：预览标记的会话、组与索引校验（从通用历史模块拆出，跟随预览语义）。
- `tests/unit/detail-reading.test.ts`：卡片进入详情顶部且正文全文、返回恢复批次与稳定锚点位置（模拟返回后布局位移 40px，期望 `scrollY` 900→940）；单 UP 来源返回同一 scope；同一动态多访问后退/前进各恢复 600/300；同地址新列表访问不继承旧批次/位置且不覆盖旧快照；主动再次进入从 0 开始；直达与无来源返回首页；不存在/失败/取消分别表达；安全文本、北京时间与来源计数，不显示编辑时间；离开未完成追加读取后从原 cursor 继续；旧访问迟到详情不覆盖新访问。
- `tests/e2e/detail.spec.ts`（desktop + Pixel 7，mock 装配真实浏览器）：来源列表批次/展开/锚点在视口 1280→360 变化后恢复；单 UP 来源返回 `/ups/123`；浏览器后退同样恢复；主题入口的新访问 10 条且置顶并继续后退回到旧访问 20 条与原偏移；主动再次进入从顶部开始；同一动态两次访问后退/前进恢复 256/128；恢复未执行时用户滚轮优先且迟到帧不拉回；详情直达与刷新重新读取、不存在与无重试按钮、返回首页。
- `tests/support/layout.ts`：jsdom 无排版/滚动，只给 `[data-reading-id]` 合成确定位置并替身 `scrollTo`/`scrollHeight`，不改变其他元素断言。

## 4. 顺带修正：历史元数据统一与会话身份补写

1. **两个协调器互相覆盖 state**：原预览协调器用 `router.push({ state: { preview… } })` 写整条 state，会清掉访问标记。现在两个命名空间由 `appHistoryState` 一次写入，预览层不再直接写历史。
2. **启动导航取消清理/补写**：清理损坏标记与补写访问标记都等待 `router.isReady()`，避免启动导航取消 replace 后把损坏标记留在记录上（`preview-history.spec.ts` 全绿）。
3. **导航前未落盘**：首屏或刷新的历史记录没有应用标记，用户立即打开预览/详情时，返回的目标记录仍无身份，快照不可恢复。现在主动入口与预览打开都先等待当前访问标记补写完成，再执行 PUSH；返回/替换也等待仍在进行的补写，避免补写的 `replace` 取消紧接着的导航。
4. **同路径新记录复用旧访问**：未登记记录的兜底访问原先只按路径缓存，从详情经主题入口 PUSH 同地址首页时会沿用旧列表的批次、展开与位置，并把同一访问标识写进两条记录。现在兜底访问按“路径 + 导航代次”区分记录；新增“回到首页的新访问不继承旧列表”页面用例（旧访问仍 20 条与 700px 位置），真实浏览器用例同时断言新访问 10 条且置顶、继续后退回到最早访问的 20 条与原锚点偏移，并补“等待在途补写后再返回/替换”的防御。

## 5. 未验证与边界

- **真实 API + 隔离 SQLite**：详情与列表结论来自 HTTP 传输替身/受控归档读取；真实协议贯通仍按规格在后续集成回归执行。
- **iPhone Safari**：只在 Linux Chromium 桌面与 Pixel 7 模拟项目验证；正式设备结论留待 15。
- **新版视觉签收**：详情页样式未由用户确认，不作为视觉回归基准（14）。
- **评论、图片、楼中楼**：详情评论区与评论入口定位由 05–07 交付；动态图片由 04 交付；本票不新增楼中楼快照或跨标签页同步。
- **慢布局与缺失锚点**：浏览器用例覆盖用户滚动优先与视口变化；极端慢图/迟到布局仅有“最多两个布局帧 + 像素后备”的实现约束，未构造专门的长图慢加载场景（随 04 图片接入再验证组合）。
