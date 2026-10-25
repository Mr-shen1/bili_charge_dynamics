# 14 新版视觉基准准备与布局审计（未签收）

- 对应票据：[14 确认新版视觉与四视口操作基准](../issues/14-visual-baseline-approval.md)
- 对应规格：[实施规格 §视觉、兼容与交付](../spec.md)、[UI 视觉规范 §5](../../../docs/design/ui-reference.md)、[SRS FR-53/FR-26](../../../docs/product/SRS.md)
- 证据状态：**用户已签收全部 63 张四宽度受控截图；黄金图与差异比较基准已建立（Linux Chromium）。**
  本票完成；未执行部署，也不代替票据 15（真机）、16（静态交付）的验证。

## 1. 版本关联

| 项 | 值 |
| --- | --- |
| 候选源码 | `89d0b49e213861badcecfe667de4f9330f134d22`（第 2 轮复审后的产品提交，父提交 `ecafaff`）；同轮前一候选 `4b42497739a95cfd1ee844f5ee943b7ae058446c`，第 1 轮候选 `7785602d88ef2618110fc5c43134969430873d04`。`conditions.json` 的 `artifacts.sourceCommit` 记录生成截图时的 HEAD（`89d0b49`），`sourceStatus` 为空，不含 `.pi/` 与截图目录自身 |
| 截图/审计产物 | 同一提交的 `frontend/dist`：`assets/index-oS_sEkuk.js`（229.99 kB）、`assets/index-DDIJRK8V.css`（67.5 kB）；全部 28 个 JS/CSS 的字节数与 sha256 记在 `conditions.json` |
| 构建命令 | `pnpm build`（`vue-tsc --noEmit && vite build`）；截图由 `pnpm visual:baseline` 构建后以 `vite preview` 提供，不拍 dev server |
| 依赖 | `pnpm-lock.yaml` 未改；Element Plus 2.14.7、Vue 3.5.44、Vite 7.3.1、Playwright 1.58.2 |
| 运行时 | Node v24.21.0、pnpm 10.34.6、Chromium 145.0.7632.6（Playwright 自带） |
| 黄金图 | `frontend/tests/visual-baseline/`：63 张 PNG + `manifest.json`（版本 1，签收候选 `89d0b49`）；比较 AE + 1% fuzz，阈值 0.02% 像素 |

截图与布局审计都跑这份候选产物；管理读取经 vite 代理到 `backend/tests/live_app` 的虚构上游，数据库是
本次运行独占的临时 SQLite，不访问真实来源，也不上传 OSS。

## 2. 受控内容与截图清单

截图目录 `.scratch/frontend-vue-migration/evidence/visual-14/`（63 张），`conditions.json` 记录每张图的
URL、视口宽度、滚动位置、字节数与 sha256。

| 场景 | 内容条件 | 宽度 | 文件 |
| --- | --- | --- | --- |
| 列表 | 10 条首批 + 10 个 UP 身份；长正文折叠、纯图、受限正文、混合图片状态 | 360/390/768/1280 | `list-<w>.png` |
| 单 UP 列表 | `夜航岛` 选中态，2 条同作者归档 | 360/390/768/1280 | `list-scope-<w>.png` |
| 详情 | 正文全文（不折叠）+ 4 图完整图片组 | 360/390/768/1280 | `detail-<w>.png` |
| 一级评论 | 来源评论 45、最热选中、9 行正文折叠为 6 行、6 行边界不折叠、UP 主/置顶、评论 4 图、回复入口 | 360/390/768/1280 | `comments-<w>.png` |
| 宽屏回复 | 预览 3 条 → 展开后第 1 页 10 条 + 实时页码 | 768/1280 | `replies-<w>.png` |
| 窄屏独立楼中楼 | 根评论全文、25 条回复第 1 页 10 条、回复目标与 UP 标识 | 360/390 | `thread-<w>.png` |
| 图片预览 | 库原生查看器 + `1 / 4` 应用计数 | 360/390/768/1280 | `preview-<w>.png` |
| 预览错误态 | 浏览器加载失败 → “图片加载失败 / 重试” | 390/1280 | `preview-error-<w>.png` |
| 列表空态 / 读取失败 / UP 条读取失败 | 空 `items`、列表 503、`ups` 503 | 390/1280 | `list-empty-*`、`list-error-*`、`up-strip-error-*` |
| 未知 UP / 详情不存在 / 详情失败 | 404 `UNKNOWN_UP`、404、503 | 390/1280 | `up-unknown-*`、`detail-not-found-*`、`detail-error-*` |
| 评论空态 / 未归档 / 读取失败 | 归档确认成功空、`root_comments_last_attempt=pending`、评论 503 | 390/1280 | `comments-empty-*`、`comments-pending-*`、`comments-error-*` |
| 回复空态 / 读取失败 | 根评论无回复、回复 503 | 390 | `replies-empty-390`、`replies-error-390` |
| 管理列表 | 3 个 UP：启停两态、长 UID | 360/390/768/1280 | `manage-<w>.png` |
| 单 UP 管理 | 近期 N 配置 + 已启用 + 读取检查/发现状态（空记录） | 360/390/768/1280 | `up-<w>.png` |
| 指定模式 | 指定动态 ID + 已关联目标 | 390/1280 | `up-specified-<w>.png` |
| 管理空态 / 存储失败 / 反代 401 / UP 不存在 | `ups: []`、503、HTML 401、404 | 390/1280（401 仅 1280） | `manage-empty-*`、`manage-error-*`、`manage-unauthorized-1280`、`up-not-found-*` |

受控资料的实现：`frontend/tests/e2e-visual/fixtures.ts` 提供生产 Adapter 所需 DTO，`support.ts` 的
`stubArchive` 按 URL 返回成功/空/失败，`stubImages` 返回固定 SVG（含 1200×6000 长图与 503 坏图）。
不使用 mock 装配，因此截图里没有 `mock` 标识或自检入口，与交付产物一致。

## 3. 条件记录

| 项 | 值 |
| --- | --- |
| 浏览器 | Chromium 145.0.7632.6（Playwright 1.58.2 自带，Linux） |
| 视口 | 宽 360/390/768/1280，高 900 CSS px |
| 缩放 / DPR | 100% 浏览器缩放，DPR 1，未注入 `zoom` 或 CSS transform |
| 时区 / locale | `Asia/Shanghai` / `zh-CN` |
| 字体 | `system-ui, -apple-system, 'Noto Sans SC', sans-serif`；解析结果由 `fc-match system-ui` 写入 `conditions.json` |
| 动效 | 截图时 `animations=disabled`、`caret=hide`；`prefers-reduced-motion` 未开启 |
| 截图方式 | Playwright `page.screenshot` 视口截图（非整页），固定内容与滚动位置 |
| 重复运行 | 非字节级确定：两次运行有 9–12 张图在少量像素上差异 ≤1 个色阶（抗锯齿），其余相同。后续黄金图比较必须使用小额逐像素容差并记录阈值，不能要求字节相等，也不能用“重跑一次”掩盖变化 |
| 内容 | 归档 DTO 由 `page.route` 提供；管理读取走实际只读接口 + 隔离 SQLite；不访问真实上游或图片服务器 |

## 4. 四宽度布局与可操作性审计

自动化用例：`frontend/tests/e2e-visual/layout.spec.ts`（`pnpm visual:baseline` 共 6 例：截图 4 例 + 本节 2 例，全部通过）。
空态与错误态截图在 `capture.spec.ts` 中同样断言四宽度无页面横溢。

| 票据要求 | 断言 | 位置 |
| --- | --- | --- |
| 360/390/768/1280 无页面横溢 | 列表、单 UP、详情、评论、楼中楼、管理列表、单 UP 管理及全部空/错态截图的 `scrollWidth ≤ clientWidth`，且卡片/评论/管理卡内容不溢出 | `layout.spec.ts:87,119,125,134,155,177,184`；`capture.spec.ts:163`；helper `support.ts` `layoutMetrics` |
| UP 条仅内部横滚 | 10 个身份（含“全部归档”共 11 项）在四个宽度下 `strip.scrollWidth > strip.clientWidth`，页面本身仍不横溢 | `layout.spec.ts:61` |
| 主要触控区域约 44px | `.app-brand`、导航、UP 选项、评论入口、折叠按钮、图片缩略图、评论排序（44px label，可见 32px）、管理链接/启停/读取/保存/radio/输入框/按钮高度 ≥43px（1px 取整容差） | `layout.spec.ts:18-26,90,140,160,178,184` |
| 语义与键盘焦点 | 键盘 Tab 可达卡片链接、UP 选项、图片缩略图、评论排序、管理卡链接、保存按钮；`:focus-visible` 的 outline / box-shadow 实际可见 | `layout.spec.ts:67-76,103-104,114,144-150,179,201`（helper `tabTo`/`focusStyle`） |
| 实际 6 行折叠 | 列表长正文高度在 140–160px（25px×6）并带 `collapsed`；“展开正文”后变高 | `layout.spec.ts:93-100` |
| 折叠不是一刀切 | 恰好 6 行的卡片、评论没有折叠入口 | `layout.spec.ts:101,138` |
| 全文例外 | 详情正文不折叠、无折叠按钮；楼中楼根评论 `scrollHeight == clientHeight`（未被裁剪） | `layout.spec.ts:127,156-158` |
| 内容可达 / 无裁剪 | 首卡 4 张图全部可达，预览 `1 / 4` → 键盘切到 `2 / 4`；评论区同样检查评论图片 | `layout.spec.ts:107-113` |
| 管理配置不撑高 | ≤640px 时监控配置项高度 < 120px（修正前为 200px+） | `layout.spec.ts:188-196` |
| 管理页头不错位 | 管理列表与单 UP 管理在四个宽度下，面包屑各项容器 `top` 相同、**文字矩形 `top` 差 ≤ 1px**（当前页标签不得高于链接）、页头高度 < 60px、面包屑高度 ≤ 44px | `layout.spec.ts:39-65,179,186` |

## 5. 新版设计选择（用于视觉签收对照）

| 项 | 实际值 | 位置 |
| --- | --- | --- |
| 页面背景 / 卡片 | `#eefafa` / `#ffffff` | `src/theme/theme.css:3-4` |
| 品牌青蓝 / 深青 | `#12a3ae` / `#0b7f88` | `theme.css:5-6` |
| 选中底色 / 文本 | `--el-color-primary-light-9` `#e9f7f7` + `--brand-strong` | `theme.css:19`；UP 选项 `ArchiveNavigation.vue:121-125` |
| 评论排序 | 可见分段 32px 高、13px 字；44px 的 label 承担点击 | `CommentSection.vue:173-186` |
| 回复入口 | 正文行 36px，浅青背景条约 44px | `ReplyPreview.vue:74,101-106` |
| 管理页头 | 标题与“返回阅读 / UP 列表 / 监控管理”同一行、右对齐、13px；三个入口不折行，链接与当前页标签同为 44px 盒且文字垂直居中 | `ManageShell.vue:47-66` |
| 作者粉色 | `#e05a94` | `theme.css:7` |
| 正文 / 次要 / 分隔线 | `#2f3238` / `#6b7280` / `#d8eceb` | `theme.css:8-10` |
| 圆角 | 容器 12px，基础控件 10px | `theme.css:11,20` |
| 阅读主栏 | `max-width: 900px` 居中；详情/单 UP 内容列 724px | `theme.css:88-95`、`DetailVisit.vue`、`ManageShell.vue:26-30` |
| 字体与行高 | 系统字体栈；正文 16/25、评论 15/24、时间与计数 13/24 | `theme.css:38`、`FoldableText.vue:64` |
| 触控尺寸 | `--touch: 44px`；输入框等表单控件经 `--el-component-size` 取 44px，按钮由各自 `min-height` 兜底 | `theme.css:12,23` |
| 折叠 | 6 行 × 25px，按实际行数测量，宽度变化重测 | `FoldableText.vue:6-33,57,69-70` |

## 6. 本轮修正的视觉缺陷

| # | 现象 | 原因 | 修正 | 复验 |
| --- | --- | --- | --- | --- |
| 1 | 评论“最热/最新”只显示两个 16px 圆点，文字被裁，无法判断排序 | `main.ts` 只引入了 `radio-group` 样式，漏掉 `radio-button` | `src/main.ts:14` 增加 `radio-button/style/css` | `comments-*` 截图；`layout.spec.ts:101-110` 触控与焦点 |
| 2 | ≤640px 时“UP UID”“监控模式”“近期 N 条”表单项被撑到约 200px 高 | 列方向下 `flex: 1 1 220px` 的 basis 被当作高度 | `manage.css:96-108` 在窄屏改为 `flex: none; width: 100%`，新增表单与配置表单共用同一条规则 | `up-*`、`manage-*` 截图；`layout.spec.ts:158-166` |
| 3 | 站点标题链接仅 24px 高，输入框 32px 高，低于触控基准 | 只给部分控件设了 `min-height: 44px`；Element Plus 输入框默认 32px | `theme.css:23` 设 `--el-component-size: 44px`（输入框等表单控件）；`theme.css:56-61` 让 `.app-brand` 与导航共用 44px 触控高度 | `layout.spec.ts:62,150,156` |
| 4 | 根评论昵称在 40px 头像列里逐字换行（如“青柠汽/水”），UP 主/置顶标记挤压 | 昵称与标记放在头像列 | `CommentItem.vue:52-56,119-135` 把昵称与标记移到正文上方一行，头像列只放头像 | `comments-*` 截图；`comments.spec.ts` 全部通过 |
| 5 | 窄屏管理页头“UP 监控管理”和“返回阅读 / UP 列表 / 监控管理”挤在同一行，当前页标签贴住栏边 | 页头与导航同一行、`margin-left: auto` | `ManageShell.vue:66-77` 在 ≤640px 让导航独占一行 | `manage-*`、`up-*` 截图 |
| 6 | “评论 45”数字与文字贴在一起 | 文本节点空白被压缩 | `CommentSection.vue:166-169` 给计数加 2px 间距 | `comments-*` 截图 |

### 第 2 轮：用户首轮反馈（2026-10-25）

用户对其余场景确认通过，提出两项修改（均已修正并纳入审计）：

| # | 反馈 | 修正 | 复验 |
| --- | --- | --- | --- |
| 7 | 一级评论“最热/最新”和“共 N 条回复”视觉过大 | 排序可见分段由 44px 收到 32px、文字 13px，44px 的 label 仍承担点击；回复入口正文行收到 36px，浅青条约 44px | `comments-*` 截图；`layout.spec.ts:131`（排序触控） |
| 8 | 管理列表、单 UP、指定模式、空态/存储失败/反代 401 的“返回阅读 / UP 列表 / 监控管理”必须同一行、不得错位 | 撤销窄屏换行，面包屑 `flex-wrap: nowrap`、13px、右对齐；复审发现当前页标签比链接高，进一步统一为同一 44px 盒模型并垂直居中文字 | `manage-*`、`up-*`、`manage-empty-*`、`manage-error-*`、`manage-unauthorized-1280`、`up-not-found-*` 截图；`layout.spec.ts:39-65,179,186` |

第 1 项同时暴露一处测试与实现不一致：`comments.spec.ts` / `comment-images.spec.ts` 原来直接点击被
Element Plus 隐藏的原生 radio，样式修好后该点击会被可见的 label 拦截。按票据的差异处理硬规则，
测试改为点击真实用户路径（可见分段标签，`sortOption` helper），不恢复缺失样式。

## 7. 候选变化后的重跑

视觉修正改动了 `src`（构建产物变化），因此重跑受影响验证：

| 命令 | 结果 |
| --- | --- |
| `pnpm check` | typecheck 通过；Vitest 21 文件 244 例通过；e2e 项目覆盖守卫通过 |
| `NO_PROXY=127.0.0.1,localhost pnpm test:e2e` | 173 通过，10 跳过（nginx 专用与 desktop/mobile 分支跳过） |
| `NO_PROXY=127.0.0.1,localhost pnpm test:e2e:production` | 3 通过，3 跳过 |
| `NO_PROXY=127.0.0.1,localhost pnpm test:e2e:manage` | 7 通过（实际 API + 隔离 SQLite） |
| `pnpm check:dist` | 两次构建 + 产物隔离检查通过（dist 无 mock 入口/夹具） |
| `pnpm visual:baseline` | 6 例通过，生成 63 张截图与 `conditions.json`（含 `zoom`/`resolvedFont`/截图条件）；第 2 轮反馈后重跑同样 6 例通过 |

`pnpm test:e2e` 的 `NO_PROXY`：本机设置了 `HTTP(S)_PROXY`，回环地址需要绕过代理；视觉配置已在
`playwright.visual.config.ts:20-30` 自动补齐 `NO_PROXY`，不需要额外环境变量。

## 8. 未验证与边界

- 黄金图绑定 Linux Chromium 145 + 本机字体（`Noto Sans CJK KR` 回退）。换机器、换字体或换 DPR 时比较器会因条件不一致拒绝比较；那不是“视觉回归失败”，需要在对应环境另行取证。
- Linux Chromium 以外的浏览器、iPhone Safari、真实触摸手势与真机字体由票据 15 执行；本目录不代替。
- Nginx 静态交付、资源更新与回退由票据 16 执行。
- 图片为固定 SVG 夹具（含长图与坏图），不是来源业务图；来源图片的构图、色彩与真实加载耗时不在本证据范围。
- 截图为视口截图，不含整页拼接、hover、拖拽与过渡中间帧；`prefers-reduced-motion` 未覆盖。
- 管理状态面板只覆盖“未读取/空记录”与读取失败，不覆盖真实检查/发现记录的完整字段组合（已有 13 与 09/11 证据）。
- 第 2 轮仅调整尺寸与对齐，未新增行为；最终视觉签收仍待用户复审。

## 9. 复现

```bash
cd frontend
pnpm visual:baseline    # pnpm build + 61 张截图 + 四宽度布局审计 → ../.scratch/frontend-vue-migration/evidence/visual-14/

# 只跑布局审计
pnpm playwright test --config playwright.visual.config.ts tests/e2e-visual/layout.spec.ts

# 只跑截图
pnpm playwright test --config playwright.visual.config.ts tests/e2e-visual/capture.spec.ts

# 与用户签收的黄金图比较；不一致时退出并输出差异图到 test-results/visual-diff/
pnpm visual:compare

# 只在确认视觉变化是预期的之后更新黄金图，必须写原因
pnpm visual:golden -- --reason "例如：按复审把排序分段从 44px 收到 32px"
```

`visual:baseline` 每次运行会清空 `visual-14/` 并重写截图与 `conditions.json`；`visual:compare` 与
黄金图（`tests/visual-baseline/`）才是回归判断依据。不能仅通过重跑截图掩盖意外变化。

比较口径：ImageMagick `compare -metric AE`，`-fuzz 1%` 吸收抗锯齿差异（实测重复运行差异为 0），
超过 0.02% 像素即失败；环境条件（浏览器、DPR、宽度、时区、locale、字体）与 `manifest.json` 不一致时
拒绝比较。更新黄金图会递增 `baselineVersion` 并把日期、候选提交与原因写入 `manifest.json`。

## 10. 用户确认范围与签收记录

需要用户明确确认的内容（缺一不可）：

1. **范围**：§2 表中列表、单 UP 列表、详情、一级评论、宽屏回复、窄屏独立楼中楼、图片预览、预览错误态、
   管理列表、单 UP 管理、指定模式，以及各空态/错误态截图；四个宽度 360/390/768/1280。
2. **版本**：本文件 §1 的候选提交与构建产物（`index-BiTupAMh.js` / `index-DaVfnnZ6.css`）。
3. **结论**：逐场景“通过 / 需修改”，以及需要修改的具体点；对图片尺寸、间距、字号、配色的例外也需写明。
4. **基准建立**：只有用户明确确认后，才把本目录（或指定的子集）登记为视觉黄金图与差异回归基准；
   后续视觉变更需说明原因，不能只更新黄金图。

签收前状态：**待确认（未签收）**。用户确认后在此补记：

| 项 | 记录 |
| --- | --- |
| 确认日期 | 2026-10-25 |
| 确认人 | 用户（对话中确认“这下可以了”） |
| 候选提交 / 构建 | `89d0b49e213861badcecfe667de4f9330f134d22`；`assets/index-*.js` 与 28 个产物哈希见 `conditions.json` |
| 确认范围 | 全部 63 张受控截图（360/390/768/1280，含列表、单 UP、详情、一级评论、宽屏回复、窄屏楼中楼、图片预览、预览错误态、管理列表、单 UP 管理、指定模式及各空态/错误态） |
| 结论与反馈 | 通过。首轮：除排序/回复入口尺寸、管理页面包屑对齐外全部通过；第 1 点改后通过；第 2 点经“当前页标签高于链接”二次修正后通过 |
| 黄金图位置 | `frontend/tests/visual-baseline/`（63 张 + `manifest.json` 版本 1，签收候选 `89d0b49`） |
| 比较基准 | `pnpm visual:compare`：AE + 1% fuzz + 0.02% 像素阈值；条件不一致拒绝比较；更新需 `--reason` |
