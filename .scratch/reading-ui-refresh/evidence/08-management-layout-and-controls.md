# 08 证据：管理排版、右侧启停与紧凑按钮

本票覆盖正式设计 UI-01 的管理复核、UI-12 的管理部分、UI-13、UI-14 的自动化部分。以下是本次实现
与实际运行的验证结果，不是视觉签收、真机验收或部署结论。正式要求见
[需求与设计](../../../docs/design/reading-ui-refresh.md)（§6–§7），工程切片见[实施规格](../spec.md)，
界面事实见[基线与测试边界](baseline-and-seams.md)。

## 1. 实现版本与运行环境

| 项 | 值 |
| --- | --- |
| 分支 | `wt/reading-ui-refresh-08`，实现提交 `8044350`，随后 merge 集成 tip（`dd81f4d`，含 06 会话读取与 05 领取）成 `e061ea7` 后复验 |
| 基点 | `spec/reading-ui-refresh` @ `870c7c1`（领取时即集成 tip） |
| Node / 包管理 | v24.21.0（`.nvmrc`）/ pnpm 10.34.6，`pnpm install --offline --frozen-lockfile` 离线命中 store |
| 浏览器 | Playwright 1.58.2 自带 Chromium（Linux 无头）；`Desktop Chrome` 与 `Pixel 7` 两套 project，四宽度用手工 `setViewportSize` 360/390/768/1280 |
| 端口 | 管理页实际 API 4177/4324（本票独占）；主 e2e 用**自配独占端口** 4408/4409/4410（不改仓库配置）；视觉审计与候选截图用自配独占 4405/4406。未占用 4318/4319/4320（03）、4178/4325（05），未触碰 8000/4273 |
| 后端 | `UV_PROJECT_ENVIRONMENT=<主工作树>/.venv uv run --no-sync`，只读 `backend/tests/live_app` 虚构上游＋本次运行独占临时 SQLite |
| 未触碰 | 未改后端、未改 01/02/03/05/06 主责文件（`theme.css` 仅更新一条已失效的注释）；未 push、未合 `main`、未部署、未更新黄金图 |

自配端口做法：把 `playwright.config.ts` / `playwright.visual.config.ts` 复制成 untracked 副本改端口运行，
提交前已删除；仓库配置未改。

## 2. 交付内容

**排版标尺（UI-12 管理部分）**：管理两级页面改用 01 在 `theme.css` 交付的 token，不再各写数值。
页标题 18/26（手机）、20/28（桌面）600；区块标题 16/24 600（`--font-manage-section`）；
状态、说明、表单标签 14/22（`--font-manage-text`）；操作按钮 13/20（`--font-manage-action`）；
昵称 16/24 600；徽标 12/20。卡片内距取 `--card-padding`（手机 16、桌面 24），列表间距取
`--card-gap`，管理分区间距手机 20px、桌面 24px。长中文说明不再是 13px 低对比淡字。

**启停靠右与紧凑按钮（UI-13）**：单 UP 控制行改成状态在左、操作在右，按钮贴住卡片内容盒右边缘；
手机不再占满整行，按钮按文字自然增宽，长昵称/UID/反馈仍可换行。启停、重新添加、保存配置、
删除配置、新增 UP、目标增删与各类重试按钮统一为：文字 13px，可见高度桌面 32px、手机 36px，
四字按钮约 76px，实际点击区仍为 44px。做法与第四版原型签收的收尾层一致：按钮本体保持 44px 命中盒，
用 `::before` 的上下 inset（桌面 6px、手机 4px）画可见描边与底色，`pointer-events: none`，
因此视觉缩小不等于可点击区缩小，也不会与相邻操作重叠。悬停/按下/禁用态一并接到同一视觉块。

**手机输入字号（UI-14 自动化部分）**：手机 16px、桌面 14px，输入控件高 44px。覆盖只落在管理页
输入行的 Element Plus 内部类 `.el-input__inner`，`--el-font-size-base` 仍是 14px，普通按钮不跟着放大。

## 3. 关键取舍

1. **视觉与点击区分离用 `::before`，不用缩小按钮本体**：把按钮本体缩到 32/36px 再靠伪元素外扩命中区，
   会让 `getBoundingClientRect()` 只有 32px，既有“控件高度 ≥44px”的守卫就得改成更弱的间接断言；
   现在的写法让点击区继续用真实矩形量，视觉大小单独量，两件事都留得住。副作用是悬停底色原本画在
   44px 本体上，因此显式把 `:hover/:focus/:active` 的填充接到同一视觉块。
2. **输入字号只做局部覆盖并登记原因**：库把输入字号挂在 `--el-font-size-base`；改这个变量会连按钮一起
   放大，违反“局部配置不把普通按钮字号一起放大”。因此按规格允许的方式覆盖内部类，并同步三条外部断言：
   手机 16、桌面 14、基础字号仍 14（按钮 13）。实际 iPhone Safari 聚焦/失焦仍待 10 实机验证，
   `theme.css` 原已知限制没有关闭，只把已失效的注释改成当前事实。
3. **手机按钮改为自然宽度右对齐，不再整行宽**：`.manage-add` / `.manage-fields` 在窄屏是列方向，
   直接删掉 `width: 100%` 只会得到整行拉伸的左对齐按钮，所以用 `align-self: flex-end`；
   控制行用 `margin-inline-start: auto`，换行后仍靠右。删除按钮仍留在独立 footer 分区，不挪进日常启停。
4. **不动管理业务语义**：只改布局与外观。启停仍提交已保存配置、保存只提交草稿、重新添加与删除分组、
   防重锁、过期回调隔离、失败保留草稿与反馈文案均未改；新增一例实际 API 用例把“启停只用已保存配置、
   保存草稿不隐式启停”钉住。

## 4. 验证

| 命令 | 结果 |
| --- | --- |
| `pnpm check`（typecheck + vitest + e2e 项目守卫） | 通过：27 个测试文件 309 例（含 merge 进来的 06 单测），项目声明矩阵一致 |
| `pnpm check:dist`（生产与 mock 两次构建 + 产物隔离） | 通过：`dist` 无 mock 入口/夹具/归档数据 |
| `pnpm exec playwright test --config <自配端口副本> tests/e2e/manage.spec.ts`（mock 装配 + HTTP 替身，桌面与 Pixel 7） | 30 passed |
| `pnpm exec playwright test --config playwright.manage.config.ts`（实际 API 4177/4324＋隔离 SQLite） | 8 passed |
| `pnpm exec playwright test --config <自配端口副本> tests/e2e-visual/`（生产构建 + 实际管理 API，四宽度） | 6 passed（`layout.spec.ts` 阅读与管理两块、`capture.spec.ts` 四块） |
| `pnpm visual:diff-report --current /tmp/reading-ui-refresh-08-visual` | 63 张全部存在且条件一致；字节相同 0 张、有像素差 63 张、最大差异比例 11.16%（预期：黄金图早于 01/02/06/08 的排版改动，未更新） |

### 4.1 四宽度实测（合并集成 tip 后重跑）

来自 `tests/e2e-visual/layout.spec.ts` 的同一组断言，另以一次性测量脚本读数（脚本未入库）：

| 宽度 | 按钮字号 | 按钮视觉/点击 | 四字按钮宽 | 右边缘差 | 状态左边缘差 | 输入字号/控件高 | 卡片内距 | 分区间距 | 说明/区块标题/页标题 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 360 | 13px | 36 / 44px | 76px | 0 | 0 | 16px / 44px | 16px | 20px | 14 / 16 / 18px |
| 390 | 13px | 36 / 44px | 76px | 0 | 0 | 16px / 44px | 16px | 20px | 14 / 16 / 18px |
| 768 | 13px | 32 / 44px | 76px | 0 | 0 | 14px / 44px | 24px | 24px | 14 / 16 / 20px |
| 1280 | 13px | 32 / 44px | 76px | 0 | 0 | 14px / 44px | 24px | 24px | 14 / 16 / 20px |

“右边缘差/状态左边缘差”已扣除卡片 1px 边框；“控件高”指 `.el-input__wrapper`（内层 `input` 为 42px，
两者相差边框）。点击区验证不只读矩形：视觉块上方 2px 处 `elementFromPoint` 仍命中同一按钮；
360px 下再用真实 `mouse.click()` 落在视觉块之外、点击盒之内的位置，仍只提交一次
`PATCH /api/manage/ups/{uid}/monitor`，请求体是已保存配置。

### 4.2 候选截图与已知差异

候选截图（生产构建 + 实际管理 API + 隔离 SQLite，四宽度，63 张 + `conditions.json`）写入
`/tmp/reading-ui-refresh-08-visual`（临时目录，不覆盖票据 14 的签收目录与黄金图）。
本票相关图片的无容差差异比例：`manage-360` 7.03%、`manage-390` 6.52%、`manage-768` 3.35%、
`manage-1280` 2.14%、`up-360` 7.67%、`up-390` 7.72%、`up-768` 4.84%、`up-1280` 3.03%、
`up-specified-390` 10.10%、`up-specified-1280` 2.96%、`manage-empty`/`manage-error`/
`manage-unauthorized`/`up-not-found` 1.0–5.2%。这些差异来自本票与管理页标尺变更，且黄金图本身早于
01/02/06，属预期；`frontend/tests/visual-baseline/` 未更新，留给 10 人工确认后按流程处理。

## 5. 覆盖与未验证

- 语义回归：启停只用已保存配置（草稿不静默生效）、保存草稿不隐式启停、重新添加、删除独立分区、
  重复提交防重、UID 校验、模式/数量/指定目标、检查与发现状态、通知三态、错误与重试、401 固定提示、
  删除后身份与已保存动态保留——既有用例全部通过，未删除或弱化任何一条。
- 键盘：控制按钮与保存按钮仍可 Tab 到达且焦点样式可见（`layout.spec.ts`、`manage.spec.ts`）。
- 未验证：真实 iPhone Safari 的输入聚焦/失焦与页面缩放（本票只到自动化；原已知限制仍未关闭）、
  用户视觉签收、真机与目标环境部署、以及 4318/4319/4320 上的完整主 e2e（03 正在使用，本票按受影响
  子集在自配端口跑 `manage.spec.ts`）。黄金图未更新、未 push、未合 `main`。
