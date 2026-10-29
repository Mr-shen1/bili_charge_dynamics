# 12 证据：头像轮廓裁切与管理表单对齐

本票承接[票 10 首轮人工反馈](10-feedback-round-1.md)的 1、3 两条：UP 条首项头像/选中轮廓被裁、
管理表单同排文字忽高忽低且输入框比旁边按钮高。以下是本次实现与实测结果，**不是**视觉签收、真机验收、
黄金图更新或部署结论；用户视觉复验仍待票 10 收口。正式要求见[需求与设计](../../../docs/design/reading-ui-refresh.md)
（§3.2、§6–§7），工程切片见[实施规格](../spec.md)。

## 1. 实现版本与运行环境

| 项 | 值 |
| --- | --- |
| 分支 | `wt/reading-ui-refresh-12`，基点 `spec/reading-ui-refresh` @ `e9f511b`（领取时即集成 tip，工作树除未跟踪 `.venv` 外无改动）；实现提交 `d81779b`、证据提交 `fb4bfe5`，随后 merge 集成 tip `fdde574`（含 13 会话整段与入口居中）成 `79e080e` 并复验（见 §7） |
| Node / 包管理 | v24.21.0（`.nvmrc`）/ pnpm 10.34.6，依赖与 `.venv` 软链已由主线程就绪 |
| 浏览器 | Playwright 自带 Chromium（Linux 无头），四宽度 `setViewportSize` 360/390/768/1280 × 900，deviceScaleFactor=1 |
| 端口 | 自建候选预览 4340（`pnpm dev`/`preview`）＋隔离夹具 API 4176（`backend/tests/live_app` 虚构上游 + `mktemp` 独占 SQLite）；管理集成 4177/4324（本票独占）；主 e2e 用**临时配置副本** 4340/4341/4342 |
| 未占用 | 未碰 4318/4337/4339/4180/8000/4273，也未碰 13 并行的 4178/4325；仓库内 playwright 配置未改，临时副本提交前已删除 |
| 未触碰 | 会话页面、reader、归档 HTTP 契约、正式设计/spec/docs 索引/README、黄金图目录；未 push、未合 `main`、未部署、未操作真实外部服务 |

只读复现与实验脚本都在 `/tmp`（`t10-layout-repro.mjs` 的改编版 `/tmp/t12/repro.mjs`、`/tmp/t12/experiment*.mjs`），不进入仓库。
管理页实验只切本地草稿（radio 纯前端 state），唯一一次提交请求由 `page.route` 替身 409 拦截，不落库。

## 2. 交付内容

1. **UP 选择条给轮廓留裁剪空间**（`src/dynamics/ArchiveNavigation.vue`）：`.up-strip` 从 `padding: 0`
   改成 `padding: 6px` + `margin: -6px`。横滑容器只裁到 padding box，而选中轮廓外扩 4px（2+2）、
   键盘焦点外扩 5px（3+2）；负外边距把内容位置与整排高度原样抵回，因此头像 48px、昵称换行、
   24px 间隔、“可见昵称→首卡 12px”与条盒尺寸都不变，只有裁剪边界向外挪 6px。
2. **主栏最小留白 6px**（`src/theme/theme.css`）：新增 `--gutter-min: 6px`，`.app-main` 用
   `max-width: calc(var(--column-max) + 2 * var(--gutter-min))` 与 `padding-inline: max(var(--gutter), var(--gutter-min))`。
   这样桌面内容宽仍是 724px、窄屏仍是“视口 − 24px”，而 641–736px 这段主栏贴边的宽度里，上面那 6px
   轮廓空间仍落在视口内、不产生页面横滚。
3. **管理表单对齐与输入可见外框**（`src/manage/manage.css`）：`.manage-add` / `.manage-fields` 的
   `.el-form-item` 加 `align-items: center`（不动标签高度、行高与库变量）；`--manage-action-inset`
   从 `.manage-shell .el-button` 上提到 `.manage-shell`，输入框命中盒保持 44px，可见描边改由
   `::before` 按同一 inset 画出（桌面 32 / 手机 36），并逐态接回默认、`:hover`、`.is-focus`、`.is-disabled`
   四套框色/底色。手机 16px、桌面 14px 字号与 ≥44px 命中盒都不变。

**库内部样式覆盖登记**：本票覆盖 Element Plus 内部类 `.el-input__wrapper` 及其 `:hover` / `.is-focus` /
`.is-disabled`（库用 inset `box-shadow` 表达边框与状态色）。收掉 `box-shadow` 后必须自己接回四态，
否则悬停/聚焦看不出变化、禁用态又会露出整块 44px 底色。与既有 `.el-input__inner` 字号覆盖同一登记口径
（`docs/design/reading-ui-refresh.md` §6–§7），断在 `tests/e2e-visual/layout.spec.ts`（四宽度可见等高、
命中 ≥43、四态框色）与 `tests/e2e/manage.spec.ts`（四宽度可见外框等高）。

## 3. 假设与一变量验证

三条假设各用「只注入一条 CSS」的浏览器实验先证伪/证实，再落到源码。

**H1｜裁切来自横滑容器 padding box**（`clippedBy` 实测只有 `up-strip`）

| 注入 | 选中轮廓裁切 | 焦点轮廓裁切 | 首头像 x | 可见昵称→首卡 | 页面横溢 | 滚动条高 |
| --- | --- | --- | --- | --- | --- | --- |
| 无（现状） | `left 4, top 4` | `left 5, top 5, bottom 5` | 12 / 22 / 278 | 12px | 0 | 0 |
| `padding: 6px; margin: -6px` | 0 | 0 | 12 / 22 / 278（不变） | 12px | 0 | 0 |
| 只 `padding: 6px` | 0 | 0 | 18 / 28（右移 6px） | 12px | 0 | 0 |

采用第一种：轮廓完整且内容不位移。滚到 `scrollLeft = scrollWidth`、并用键盘 Tab 到最后一个选项后，
末项外扩 5px 仍完整（360/390/768/1280 四宽度均为 0）。**副作用与补救**：负外边距让条盒比主栏宽 12px，
在 641–736px（主栏贴住视口）实测多出横滚（641→647、700→706、730→733），因此按第 2 条给主栏加 6px 最小留白；
复测 700px 溢出 0、轮廓完整，并加了一条 700px 回归断言。

**H2｜6px 来自库标签盒在 44px 行里顶对齐**

只给 `.manage-add` / `.manage-fields` 的 `.el-form-item` 注入 `align-items: center`（不改任何高度）：
360px 新增 UP `312 vs 318` → `318 vs 318`；768px 监控配置两行 `366 vs 372` → 0；768px 目标行 `599 vs 605` → 0；
桌面同行文字中心 spread `6.00 → 0.00`。假设成立，落地为一行规则。

**H3｜输入 44 与按钮 32/36 的差异来自“可见框定义不同”**

第一次反驳打在 `.manage-fields { --manage-action-inset: 0 }` 上无效——该变量当时声明在
`.manage-shell .el-button` 自身，行内元素不继承，按钮仍是 32/36。口径修正为“把变量上提到 `.manage-shell`
再置 0”，修后候选实测：768px 基准 `input 32 / button 32`、390px `36 / 36`，把变量置 0 后**两者一起**变 44/44，
命中盒始终 44。说明可见高度确实只由这一处 inset 决定，输入与按钮现在同源。

## 4. 先红后绿（自有候选 4340 ＋ 隔离 API 4176）

新增/改写的浏览器断言在**未改源码**的本分支构建上先红，一次只修一条假设后复跑：

| 顺序 | 红输出（本分支构建） | 对应修复后的结果 |
| --- | --- | --- |
| 1 | `360px 列表选中轮廓 轮廓被 up-strip 裁切：{"left":4,"top":4,"right":0,"bottom":0}` | 通过（H1） |
| 1 | `700px 列表选中轮廓 轮廓被 up-strip 裁切：{"left":4,"top":4,…}` | 通过（H1 + 主栏留白） |
| 2 | `360px 新增 UP「UP UID」标签文字应落在同行控件中心：312 vs 318` | 通过（H2） |
| 3 | `360px 新增 UP 输入可见外框高度：Expected 36, Received 44` | 通过（H3） |

`tests/e2e/list.spec.ts` 的既有守卫（48px 头像、昵称 12/18 与完整换行、隐藏滚动条、
可见昵称至首卡 10–14px、条内横滚、无页面横溢）与 `tests/e2e/detail.spec.ts` 的
“选择条与卡片左右边缘对齐”在改动后仍全绿：后者改成比较**内容盒**边缘（`rect ± padding`），
因为边框盒现在有意比卡片宽 12px 以容纳轮廓，而对齐的语义是头像/昵称的起止点，实测仍严格等于卡片左右边缘。

**38 项红 → 0 项红的复现脚本**（`/tmp/t12/repro.mjs`，脚本唯一改动：输入可见高度与按钮同一口径，
即“盒高 − `::before` 上下内缩”，命中盒仍单独量）：

```bash
# 终端 1（工作树根）：隔离夹具 API
BILI_DATABASE_PATH=$(mktemp -d)/monitor.sqlite uv run --no-sync python -m uvicorn \
  backend.tests.live_app:create_app --factory --host 127.0.0.1 --port 4176
# 终端 2（frontend）：交付候选
pnpm build && API_SERVER=http://127.0.0.1:4176 pnpm preview --host 127.0.0.1 --port 4340 --strictPort
# 终端 3：只为隔离夹具库造 UP 202（写的是临时 SQLite）
curl -s -X POST http://127.0.0.1:4176/api/manage/ups -H 'content-type: application/json' -d '{"uid":"202"}'
# 红/绿循环
T10_BASE=http://127.0.0.1:4340 node /tmp/t12/repro.mjs
```

结果：修前同一脚本 38 项红（选中/焦点轮廓四宽度裁切、三处表单行标签 −6px、三处输入 44 vs 按钮 32/36），
修后 **`==== 汇总：0 项红 ====`，86 条 ok，末行 `写请求（应为空）：无`**（exit=0）。

## 5. 本轮实际跑过的门槛

| 命令（`frontend/`） | 端口 | 结果 |
| --- | --- | --- |
| `pnpm exec playwright test --config <临时副本> tests/e2e-visual/layout.spec.ts` | 4176 / 4340（副本改自 `playwright.visual.config.ts`） | **4 passed**（含新增的贴边宽度与输入三态两条） |
| `pnpm exec playwright test --config <临时副本>`（整套 `tests/e2e`） | 4340 / 4341 / 4342（副本改自 `playwright.config.ts`，图片服务用 `IMAGE_SERVER_PORT` 跟上） | **235 passed** |
| `pnpm test:e2e:manage` | 4177 / 4324（本票独占） | **9 passed** |
| `pnpm check` | 无服务 | 通过（32 个单测文件、e2e 项目覆盖守卫一致） |
| `pnpm check:dist` | 无服务 | 通过（双构建 + 产物隔离） |
| `pnpm typecheck` | 无 | 通过 |

临时 playwright 配置副本只存在于工作树运行期间（未跟踪、提交前删除），仓库配置未改。

## 6. 未做与交接

- **黄金图未更新**，`capture.spec.ts` / `visual:baseline` / `visual:compare` 未跑（本票禁止，等用户签收）。
  管理输入框与选择条的可见像素确实变了，黄金图差异属预期，由主线程在签收后统一处理。
- `pnpm test:e2e:location` 未跑：它与 13 并行共用 4178/4325，且本票不涉及定位链路；`pnpm test:e2e:production`
  六路由冒烟未跑（本次只改版式，未改装配/路由）。
- 641–736px 区间只有 700px 一条断言，没有逐宽度矩阵。
- 真机 / iPhone Safari 未复验；票 15 的输入框聚焦放大（F-15-02）仍是已知限制，本票不改。
- **隔离预览仍是旧产物**：本票不动 4318，等 12、13 两票合入集成分支后由主线程统一更新新预览与候选登记。
- 13 合入后再跑一趟受影响的浏览器门（见 §5 前两行）即可，不需要重做本票的假设验证。

## 7. 合入集成 tip 后复验

`git merge spec/reading-ui-refresh`（`fdde574`，13 的整段会话与入口居中）无冲突，因为 13 未改 UP 条、
管理组件与 `theme.css`；合并后重跑受影响的浏览器门与交付门，仍全绿：

| 命令 | 结果 |
| --- | --- |
| `pnpm check` | 通过（32 个单测文件全绿，e2e 项目覆盖声明一致） |
| `pnpm exec playwright test --config <临时副本> tests/e2e-visual/layout.spec.ts`（4176/4340） | 4 passed |
| `pnpm exec playwright test --config <临时副本> tests/e2e/{list,detail,manage}.spec.ts`（4340/4341/4342） | 64 passed |
| `pnpm test:e2e:manage`（4177/4324） | 9 passed |
| `pnpm check:dist` | 通过 |
| 复现脚本（自建候选 4340 ＋ 隔离 API 4176） | `==== 汇总：0 项红 ====`，86 ok，`写请求（应为空）：无` |

复验期间未使用 4178/4325（13 与 merger 的 location 复验占用中），也未碰 4318/4337/4339/4180/8000/4273。
