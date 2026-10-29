# 04 桌面正文新标签与手机详情返回：实现与验证

Status: resolved（实现与自动化取证完成；视觉、真机、部署与三进程 delivery 链未验证）

依据：[实施规格](../spec.md)与[正式设计 §3.1](../../../docs/design/reading-ui-refresh.md)。本票覆盖 UI-04、UI-06、UI-07 的内部操作隔离，以及 UI-15 的详情直达与精确入口部分。客户端契约见[归档 API 客户端阅读改版 04 增量](../../../docs/backend/api/archive-api-client.md#阅读改版-04-增量桌面正文新标签与详情页头)。

## 1. 结论

- **桌面正文入口真实开新标签**：宽屏（>640px）点击卡片正文或卡片阅读链接，由浏览器在新标签页打开 `/dynamics/{id}`；`rel="noopener"` + `window.open('_blank','noopener,noreferrer')` 让新标签拿不到 `window.opener`。原列表的 URL、滚动位置、卡片内联评论的展开/排序/已读批次、楼中楼页码都留在原标签，**不做任何导航**，所以既不需要也不复制原标签内存。
- **新标签只靠地址与只读接口**：标签标题由路由身份设置（`动态详情`），刷新、复制地址、直接打开都得到同一标题与同一动态；不依赖 opener、不依赖原标签的访问快照。
- **原生链接语义**：链接本身带 `target="_blank"` / `rel="noopener"`，普通点击由浏览器开标签；组合键（Ctrl/Cmd/Shift/Alt）与中键**完全交给浏览器**（应用不再调用 `window.open`），因此不会出现“应用再开一次”的第二扇窗，也不会把本标签带走。
- **正常详情不再重复页头**：宽屏详情没有“动态详情”标题、没有“返回列表”/`‹ 动态列表`；窄屏只保留一个 `‹ 动态列表`（14/22、常规字重、点击区 ≥44px）。两端都保留视觉隐藏的 `h1`（页面结构/读屏层级），它不是可见页头。
- **错误与无效地址仍可恢复**：`error`／`cancelled`／`not-found` 时两端都出现 `‹ 动态列表`，失败仍可用既有“重试”；删除的是正常阅读的重复页头，不是把用户困在没有内容的页面。
- **手机入口不变**：正文进详情顶部、评论按钮定位一级评论区；有有效列表来源时 `‹ 动态列表` 真实后退并恢复来源 scope 与位置；直达/刷新没有来源时 `replace` 到全部动态（`/`），不离站、不构成返回循环。
- **内部操作保持隔离**：图片预览、作者展示、正文折叠、评论入口、评论正文/分页与文字选择都不触发正文导航（宽屏不弹新标签、窄屏不跳详情）。
- **精确链接意图未被重写**：根评论精确入口仍是同一张详情页（标题同为“动态详情”，按 URL 定位并高亮目标）；回复精确入口与会话页各有自己的标题（“回复详情”“会话列表”）；通知直达仍走既有时间序定位，本票只改“标题怎么来”，不改“定位怎么算”。

## 2. 实现位置

| 位置 | 内容 |
| --- | --- |
| `frontend/src/app/newTab.ts`（新） | `openInNewTab(url)`：`window.open(url,'_blank','noopener,noreferrer')`，仍返回引用时再置 `opener = null`。 |
| `frontend/src/app/documentTitle.ts`（新） | 路由 → 标签标题的单一映射（`detail`/`comment-locate` = 动态详情，`reply-locate`/`thread` = 回复详情，`conversation` = 会话列表，管理 = 监控管理，其余沿用入口静态标题）；`useDocumentTitle()` 跟随路由，参数变化不改标题。 |
| `frontend/src/app/App.vue` | 装配 `useDocumentTitle()`：标题由路由决定，直达/刷新/新标签一致，页面不再各自维护。 |
| `frontend/src/dynamics/DynamicCard.vue` | 新增 `tabbed` 通道：宽屏链接带 `target`/`rel`，正文点击 `openInNewTab`；窄屏仍走 `navigation.openDetail`。组合键/中键直接返回；选中文字不导航；`[data-comment-region]` 等内部目标继续被忽略。 |
| `frontend/src/dynamics/ListVisit.vue` | 把“宽屏”判定作为 `tabbed` 传给卡片；卡片评论按钮的宽窄屏分支（内联展开 / 站内定位）未改。 |
| `frontend/src/dynamics/DetailVisit.vue` | 去掉可见页头，改为 `showBack = 窄屏 || 读取失败/已取消/不存在`；保留视觉隐藏 `h1`；`‹ 动态列表` 仍走 `navigation.returnToList()`（来源验证与无来源 `replace('/')` 语义未改）。 |
| `frontend/tests/support/app.ts` | `showApp()` 新增可选 `exposeNavigation`：需要“按应用入口离开列表”的用例直接取唯一导航协调器，不再依赖某次点击的开窗方式。 |
| `frontend/tests/e2e/detail-entry-tab.spec.ts`（新） | 真实标签页、opener、标题、刷新、四宽度页头、精确入口标题、手机往返与无来源回全部动态。 |
| `frontend/tests/unit/detail-tab-entry.test.ts`、`tests/unit/document-title.test.ts`（新） | 页面级决策与标题映射。 |

未改：`navigation.ts`（本票不新增导航方法；07 的 `replyVisitSnapshot`/`openConversation` 段落原样保留）、`router.ts`、读取契约/Adapter、后端、通知、`CommentSection`/`useCommentsRead`/`useReplyPage`。

## 3. 红 → 绿

按 `.agents/skills/tdd/SKILL.md` 的纵向切片推进，一次一条行为：

1. 宽屏正文入口 → 先写“点正文后原列表 URL 与内联评论状态不变、只发起一次 `window.open(href,'_blank','noopener…')`” → 红（旧实现走 SPA `push`）→ 加 `tabbed` + `openInNewTab` → 绿。
2. 组合键/中键与文字选择 → 红（旧实现把修饰键之外的点击都当导航）→ 让修饰键与选中文字直接返回 → 绿。
3. 内部操作不误导航 → 复用既有 `closest(...)` 判定，补断言（图片按钮、作者、评论入口、评论正文）→ 绿。
4. 详情页头 → 红（旧实现恒有“动态详情”+“返回列表”）→ 改为窄屏/失败才显示 `‹ 动态列表` → 绿；同时补“失败/不存在仍可退出与重试”。
5. 标题映射 → 纯函数单测 + 浏览器 `toHaveTitle` 一起红→绿（旧实现无路由标题，刷新后回落到入口静态标题）。
6. 既有用例随行为变化更新（见 §5），其中：
   - 需要“站内往返”的旧用例改按窄屏语义跑（宽屏已不再在站内进入详情）；
   - 宽屏详情区自己的历史恢复用例改由“窄屏入口进入 → 换宽屏断言”或直接地址进入，保留原有断言含义；
   - `tests/e2e/list-comments.spec.ts` 里原来的“桌面离开列表再返回恢复卡片状态”改成“开新标签后原状态不动”，并把路由替身改为 context 级（新标签页也要命中替身）。

## 4. 命令与结果（本工作树，基于集成 tip `01716b2`）

实施基线 `9522c88`，收口前合并 `spec/reading-ui-refresh` 最新 tip `01716b2`（07 已集成），冲突为零；合并后 `navigation.ts` 两侧段落都在（07 的 `replyVisitSnapshot`/`openConversation`/`returnFromConversation` 与我未改的 `openDetail`/`returnToList`/`saveDetailSnapshot`），`tests/support/app.ts` 同时保留 07 的 `ThreadPage` 路由与我的 `exposeNavigation`。

| 命令 | 结果 |
| --- | --- |
| `cd frontend && pnpm check` | 通过：`vue-tsc` 无错；vitest 32 文件 / 346 passed；e2e 项目声明守卫一致（新增 `detail-entry-tab.spec.ts` = `desktop-chromium, mobile-chromium`） |
| `cd frontend && pnpm check:dist` | 通过：生产与 mock 两次构建 + `check:isolation` |
| `NO_PROXY=127.0.0.1,localhost pnpm test:e2e`（主 e2e，独占 4318/4319/4320） | 235 passed、18 skipped、0 failed（4.4 分钟，合并 01716b2 后复跑） |
| `pnpm exec playwright test tests/e2e/detail-entry-tab.spec.ts` | 桌面 3 条 + 窄屏 3 条 + 四宽度 1 条（每项目）通过；移动项目按设计跳过 3 条桌面新标签用例 |
| `pnpm exec playwright test tests/e2e/list-comments.spec.ts` | 3 passed / 3 skipped（项目分支） |
| `pnpm exec playwright test tests/e2e/detail.spec.ts` / `dynamic-images.spec.ts` / `/ comments.spec.ts replies.spec.ts` / `list.spec.ts` | 均全绿（合并后随主 e2e 复跑） |
| `NO_PROXY=127.0.0.1,localhost pnpm test:e2e:manage`（4177/4324） | 8 passed（合并后复跑） |
| `pnpm test:e2e:delivery`（4181/4328，另用 4402/4403 复核） | **失败且与本票无关**：`beforeAll` 卡在“三链实际投递消息”。同一命令在主仓 `01716b2`（不含本票改动）上以同样方式失败，见 §7 |
| `pnpm build && pnpm exec playwright test --config playwright.visual.config.ts tests/e2e-visual/capture.spec.ts tests/e2e-visual/layout.spec.ts`（VISUAL_OUT_DIR=/tmp/04-visual，4178/4325） | 6 passed（含四宽度阅读布局/触控/焦点与四宽度截图采集）；截图只写临时目录，**未**比较或更新黄金图 |

端口窗口：主 e2e 用硬编码 4318/4319/4320，每次开跑前用 `ss -ltn` 现查；manage 4177/4324、delivery 4181/4328（含 4402/4403 复核）均先探测后串行运行；`test:e2e:location` 的 4178/4325 属 07 的证据窗口，本票未占用；全程未触碰 8000/4273，也未停止任何他人服务。

## 5. 验收条件逐项

| 票据条件 | 证据 |
| --- | --- |
| 桌面普通正文入口实际打开新标签、页面对应正确动态、标签标题“动态详情”、来源列表 URL/滚动/评论排序/回复页码不改变 | `tests/e2e/detail-entry-tab.spec.ts`“桌面正文入口打开新标签…”：真实 `page.waitForEvent('popup')`，断言 `toHaveURL`/`toHaveTitle('动态详情')`/`dynamic:{id}` 可见；开标签期间原标签 URL、`scrollY`、`‹ 热点排序` 标签、一级评论 20 条与卡片锚点偏移不变。评论排序与楼中楼页码的“开标签后不动”另由 `tests/e2e/list-comments.spec.ts`（生产 Adapter + 路由替身）断言：热度排序、回复第 2 页 `aria-current`、列表请求数不变 |
| 新标签有可直接访问的详情 URL，刷新/复制仍可读取；不依赖 opener 内存，正确设置 opener 隔离，组合键/中键不重复开窗 | 同上：popup 内 `reload()` 后正文仍在、标题仍是动态详情；`window.opener === null`；“组合键与中键交给浏览器原生语义”用例记录应用侧 `window.open` 调用数为 0、popup 数 ≤1、本标签 URL 不变；单元 `tests/unit/detail-tab-entry.test.ts` 断言宽屏链接 `target="_blank"`/`rel="noopener"` 且原路由不动 |
| 正常桌面详情没有“动态详情”页头和“返回列表”按钮；必要的错误/无效地址恢复操作仍存在 | e2e：`popup.locator('.detail-title')` 为 0、`返回列表`/`‹ 动态列表` 为 0、`.detail-card` 顶部 <40px；四宽度用例逐宽度断言；失败/不存在用例（单元 `读取失败与地址无效仍保留重试和退出入口`、`tests/e2e/detail-entry-tab.spec.ts` 手机直达用例）断言 `‹ 动态列表` 与“重试”存在 |
| 手机正文进详情顶部、评论按钮定位一级评论区；正常详情只保留 `‹ 动态列表`，不再重复旧按钮和标题 | `手机正文进入详情顶部…`（`scrollY` 回 0、`.detail-title` 为 0、`‹ 动态列表` 恰 1 个、`返回列表` 为 0）；`手机单 UP 来源与评论按钮…`（评论按钮后评论区距视口顶 <200px） |
| 手机有有效来源时返回正确 scope 并恢复列表状态；直达或刷新失去来源时返回全部动态，不意外离开本站 | 同上：单 UP 返回 `/ups/123` 且 `纸飞机` 仍 `aria-current`；`浏览器后退/位置` 与详情 e2e 的加批次/折叠/滚动恢复继续通过；直达刷新用例断言回 `/{base}` 并显示全部动态；单元另有 `/ups/123` 位置 700 恢复与 `/dynamics/1002` 无来源 `replace('/')` |
| 图片、头像展示、文字选择、正文展开及其他内部控件保持现有事件隔离和键盘焦点语义 | 单元“图片、作者展示与评论入口都不抢正文导航”“组合键、中键与文字选择都不重复开窗”；既有 `dynamic-images`/`preview-*`/`list-comments`（评论正文、分页、焦点回入口）全绿 |
| 根/回复通知精确链接与普通详情分别设置正确标题和定位，不因新标签规则重写精确链接意图 | `精确入口与普通详情的标题、定位各按自身意图…`：`detail`/`comment-locate` = 动态详情且目标 `[data-located="true"]` 恰 1 个、无返回列表；`reply-locate` = 回复详情；`conversation` = 会话列表；既有一级评论/回复精确入口浏览器套件（`comments.spec.ts`、`reply-location*.spec.ts`、`locate-return*.spec.ts`）全绿 |
| 浏览器测试实际观察新页面、opener 隔离和原列表状态保留；模拟浏览器历史及四宽度检查通过，不以调用 open 的 spy 代替用户结果 | 主证据是真实 popup 页面（标题、`opener === null`、刷新后内容、原标签状态）；`spy` 只出现在单元层防止 jsdom 崩溃，且同时断言“原路由不变、状态不重置”。四宽度：`四宽度正常详情页头正确且不横向溢出`（360/390/768/1280，`scrollWidth <= innerWidth`、窄屏返回控件高度 ≥44、宽屏正文贴顶） |

## 6. 共享接口要点（给 07／09）

- **正文入口判定只看视口**：`ListVisit` 把 `!compact` 作为 `tabbed` 传给 `DynamicCard`；宽屏不再调用 `navigation.openDetail`，所以桌面不再产生“列表 → 详情”的来源关系；桌面要回到列表请用浏览器后退（或直接地址），不要再依赖 `‹ 动态列表`。
- `DetailVisit` 的返回控件条件改为 `compact || 读取失败/已取消/不存在`；`returnToList()` 的来源校验与无来源 `replace('/')` 未改。
- 标签标题统一由 `documentTitle.ts` 决定：新增阅读路由请在该映射里加名字，不要在页面里各自设 `document.title`（否则直达/刷新会回落到入口静态标题）。
- `showApp(reader, path, exposePreview, management, exposeNavigation)`：需要按应用入口离开列表的用例用第 5 个参数取导航协调器。
- 09 组合回归需要覆盖：真实 popup + 原列表快照、四宽度详情页头、手机来源/无来源返回、精确入口标题与定位；黄金图与四宽度截图仍由 09/10 负责。

## 7. 已知限制与未验证

- **三进程 delivery 链失败（与本票无关，未扩范围）**：`pnpm test:e2e:delivery` 在 `beforeAll` 停在“等待三链实际投递消息”。把同一条命令放在**主仓 `01716b2`（不含本票任何改动）**上运行，结果相同（`waitFor` 超时、`notifier_started destinations=5` 后没有任何投递）。与通知默认闸门为 `off`（票据 15：关闭即不登记、不排队）的现象一致，判定为既有的 delivery 夹具/用例未随闸门默认值更新，**未在本票修复**。因此 `tests/e2e-delivery/three-process-links.spec.ts` 里本票的一行改动（动态链接用例改为窄屏返回）**未获得运行时验证**。
- **静态交付（Nginx）用例未本机执行**：`tests/e2e/static-delivery.spec.ts` 的返回控件分支改动（窄屏点 `‹ 动态列表`、宽屏断言无返回控件）需要 `E2E_TARGET=nginx` 与 `pnpm test:delivery`，属 09 的交付证据范围，本票未运行。
- **视觉签收与黄金图未做**：视觉用例本身通过（截图采集 + 四宽度布局/触控/焦点断言），候选截图只写到 `/tmp/04-visual`；详情页头删除必然改变黄金图，按规格与 09/10 约定本票**未**运行 `pnpm visual:golden`、未更新 `tests/visual-baseline/`，也没有人工签收。真机（iPhone Safari）与部署均未验证。
- **浏览器组合键/中键的原生开窗未在 headless 中观测**：Playwright 的 Chromium 对 Ctrl+点击/中键不派发 popup 事件，因此这两条只断言“应用没有再开一次、本标签没被带走、popup ≤1”，原生标签页行为未做像素级观察。
- **宽屏不再有站内详情入口**：这是设计的直接后果（桌面正文开新标签、正常详情无返回按钮）。因此“详情 → 列表”的站内往返在桌面不存在，相关既有用例已按窄屏语义改写，而不是保留桌面返回能力。
