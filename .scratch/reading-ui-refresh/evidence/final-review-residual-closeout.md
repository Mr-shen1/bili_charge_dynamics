# 11 二次复核残留闭环（最终补充证据）

本轮由独立复核重开的残留补齐，不改写任何历史记录：[最终双轴独立审查](final-independent-review.md)与其“处置与最终验证”保持原文，只在其后追加指针；本文件记录第二次复核的 4 项残留、完整扫描、最终候选与验证结果。

- 基点校验：工作树 HEAD 与集成 `spec/reading-ui-refresh` 同为 `4c6fe48b6186dc47fd3d589b2803948a72aaf8ac`（`git rev-parse` 与 `git log --oneline -2` 双查），开工时工作树干净。
- 复核原文：[Standards 只读复核](/tmp/reading-ui-refresh-standards-final-review.md) 与 [Spec 只读复核](/tmp/reading-ui-refresh-spec-final-review.md)（两轴独立记录，结论分别为“S3 残留＋1 项判断项”“S3/S2 未收口＋配对返回控件判断项”）。
- 本轮新提交（概念提交，未改写历史）：`f8fee65`、`1fe56a7`、`88b692f`；最终代码候选 `88b692facc0c0e39ea527fbe87895c4544be5291`（干净工作树，`sourceStatus=[]`）。

## 1 Standards S3 残留：两处 `var(--brand-soft, #e6f6f7)`

**复核指认**：`CommentItem.vue:123`、`:156` 仍带 `, #e6f6f7` fallback；`6d01f04` 只改了 5 处，而原证据 S3 行写“共 7 处去掉 `, #e6f6f7` fallback”。该结论成立：首次处置的代码只落了 5 处，证据措辞与实际不符。

**本轮处置**：两处改为 `var(--brand-soft)`（token 已在 `theme/theme.css:12` 声明），颜色计算值不变。`grep -rn '#e6f6f7' frontend/src` 现在只剩 `theme.css` 的 token 声明本身。

**如实记录**：本次为二次复核发现后的补修，**不回填**首次证据的“7 处”表述，也不改 `6d01f04` 的历史；视为“首次处置不完全、二次复核补齐”。

## 2 Spec2/Standards S2 残留：阅读组件字号/行高硬写

**复核指认**：`theme/theme.css:44-47` 规定“组件只引用 token，不各写一套数值”，而 `CommentThreadPage.vue:295-296`（12/20）、`CommentItem.vue:158`、`ReplyPreview.vue:88`、`ReplySection.vue:319`、`ReadOnlyLike.vue:25`、`ReplyPager.vue:60,67` 仍硬写；证据 `:52`“28 个 token 都有实际引用”只证明引用非零。该结论成立。

**完整扫描方法**：先用 MCP 网关的 `codegraph_explore` 定位阅读/回复/会话/分页组件，再 `grep -rn 'font-size\|line-height' frontend/src`（排除 `var(--…)`）复核活代码，逐条判定角色。

**本轮改引 token（计算值不变）**

| 位置 | 原值 | 角色判定 | 现引用 |
| --- | --- | --- | --- |
| `pages/CommentThreadPage.vue` `.thread-badge` | 12/20 | 徽标/UP 主标识 | `--font-badge`/`--line-badge` |
| `dynamics/CommentItem.vue` `.comment__badge` | 12/20 | 徽标 | `--font-badge`/`--line-badge` |
| `dynamics/ReplyPreview.vue` `.reply-preview__badge` | 12/20 | 徽标 | `--font-badge`/`--line-badge` |
| `dynamics/ReplySection.vue` `.reply__badge` | 12/20 | 徽标 | `--font-badge`/`--line-badge` |
| `dynamics/CommentItem.vue` `.comment__pending` | 13/20 | 状态提示（时间/计数辅助层） | `--font-meta`/`--line-meta` |
| `dynamics/CommentItem.vue` `.comment__reply-notice` | 13/20 | 同上 | `--font-meta`/`--line-meta` |
| `dynamics/ReadOnlyLike.vue` 点赞计数 | 13px | 计数 | `--font-meta` |
| `dynamics/ReplyPager.vue` `.reply-pager__total` | 13px | 计数 | `--font-meta` |
| `dynamics/ReplyPager.vue` `.reply-pager__action/__page` | 13px | 分页文字（计数层） | `--font-meta` |

计算字号/行高与修改前逐项相同，`tests/e2e/detail.spec.ts`（含 badge 12/20 断言）与 `tests/e2e/comments.spec.ts`（13/14 层级断言）未改断言即通过。

**明确登记的有意例外（不引用标尺、不为消除字面量而泛化）**

| 位置 | 值 | 为什么不改 | 依据 |
| --- | --- | --- | --- |
| `dynamics/ReadOnlyLike.vue`、`dynamics/ReplyPager.vue` `.reply-pager__total` | `line-height: 24px` | 不是文本行高：`min-height:24px` 命中盒与相邻分页按钮行盒的对齐值，标尺的 13px 角色行高是 20px | 设计 §6 只给 13/20；“响应式命中盒”属布局尺寸 |
| `theme/theme.css` `.app-badge` | 12px | 非生产装配标识（仅 mock/fault 显示），不属阅读文本层级 | 设计 §1/§8 的装配隔离，生产产物无此元素 |
| `theme/theme.css` `.page__group h2` | 16px | 只被 mock 夹具页 `PreviewFixturesPage.vue` 使用，不是正式产品界面 | 同上 |
| `theme/theme.css` `.image-grid__placeholder`、`.image-grid__remaining`、`.preview-counter`、`.preview-note`、`.preview-error p` | 12/13/15px | 图片预览器浮层与占位/角标（深色遮罩上的图形覆盖层），标尺不定义预览层角色；借用 `--font-badge`/`--font-meta` 会用错角色 | 设计 §6 的标尺只覆盖阅读与管理正文层级 |
| `manage/manage.css` `.el-input__inner` | 桌面 14px／手机 16px | 设计 §6 单列的“管理输入类控件”角色，标尺无对应 token；文件内已写明为什么不改 `--el-font-size-base` | 设计 §6、验收 UI-14 |
| `dynamics/CommentSection.vue`、`dynamics/CommentList.vue` 状态/空态行 | `line-height: 1.7` | 无字号声明（继承），是比例行高而不是标尺成对声明；改成绝对 token 会改变空态/错误态视觉，且不属本轮复核指认项 | 首次证据未列此项，本轮如实登记为“未收口但有意保留” |

## 3 Spec 判断项：配对返回控件 `aria-label` 不含可见标签

**复核指认**：`CommentThreadPage.vue:185` 显示 `‹ 评论详情`，`aria-label="返回评论"`，不含可见标签；会话页在 Spec2 已改成“会话列表，返回评论详情”，两控件现在共用 `theme/reading.css` 同一标尺。成立。

**本轮处置（先红后绿）**：
1. **red**：`tests/unit/thread-reading.test.ts` 新增公开 seam 用例“返回控件可访问名包含可见标签‘评论详情’，并说明返回的是动态详情”，首跑失败（`Unable to find role="button" name="评论详情，返回动态详情"`），其余 11 例通过。
2. **修复**：`aria-label` 改为“评论详情，返回动态详情”——包含可见标签并解释返回目标是动态详情（`returnFromThread` 有来源时真实后退到详情访问，无来源时 replace 到对应动态详情，两种路径目标一致）。
3. **green**：新用例与 `thread-reading.test.ts` 全绿；`tests/unit/locate-return.test.ts` 与 9 个浏览器用例中定位该按钮的旧名同步更新为新名。
4. 既有返回行为、会话返回排序/页码/位置恢复断言未改，location 与 delivery 组合用例全部通过。

## 4 判断项：`replyReadState()` 恒等复制

**核实**：`useReplyPage` 的 `state` 是 `shallowRef`，所有读取路径（`loadPage`/`readLocation`/错误与取消分支）都赋值新对象，从不原地修改字段；`ReplyPageState` 字段全为 `readonly`。因此快照直接持有 `state.value` 不会被后续读取改写，不需要复制。

**处置**：删除 `replyReadState()` 与调用点（卸载保存快照改为 `read: state.value`）。`ReplyVisitReadState` 仍保留为快照字段的语义别名，注释从“只保留恢复需要的四项”改为“与 `ReplyPageState` 同一份定义 + 为什么可以直接持有引用”。快照形状与恢复行为不变，`comment-region-snapshot` 等单测未改断言即通过。

## 最终候选验证

候选 `88b692facc0c0e39ea527fbe87895c4544be5291`，工作树干净（`git status --porcelain` 为空，临时环境已清理）。Node v24.21.0 / pnpm 10.34.6；Python 用主树 `.venv`（`UV_PROJECT_ENVIRONMENT` + `--no-sync`）；Chromium 145.0.7632.6 / Playwright 1.58.2。`HTTP(S)_PROXY` 指向本机代理，全部 e2e 以 `NO_PROXY=127.0.0.1,localhost` 运行。

| 命令 | 结果 |
| --- | --- |
| `pnpm check` | 通过：`vue-tsc`＋32 个 Vitest 文件 / **348 例**（父候选 347＋新增 Label-in-Name 回归 1）＋e2e 项目覆盖守卫 |
| `pnpm check:dist` | 通过：生产与 mock 两次构建＋产物隔离 |
| `pnpm test:e2e` | **235 passed / 18 skipped**（4.6m；与父候选同数，含更新的返回控件名断言） |
| `pnpm test:e2e:production` | 3 passed / 3 skipped（`assemblies.spec.ts` 的 aria 断言已改） |
| `pnpm test:e2e:manage` | 9 passed（实际隔离 API＋SQLite；管理页无改动，按影响复跑） |
| `pnpm test:e2e:location` | 16 passed（实际隔离 API＋SQLite，含 integrated-reading 与 conversation 的返回名断言） |
| `DELIVERY_E2E_API_PORT=4402 DELIVERY_E2E_WEB_PORT=4403 pnpm test:e2e:delivery` | 6 passed（API＋采集＋通知三进程） |
| 后端定向：`pytest backend/tests/test_reading_ui_integration.py test_reply_sort.py test_conversation_reading.py -q` | **38 passed**（真实 HTTP＋临时 SQLite） |

**后端全量不重复跑的依据**：本轮未改 `backend/`，`git diff 4c6fe48 -- backend` 为空，且 `HEAD:backend` 与 `4c6fe48:backend` 的 tree 同为 `c25b57d95fafa7cd8d3f20e33975c2dabf4f5372`；父候选 `9bfdbaf`（同树 `2e1d001`）已取得全量 1256 passed，子树完全相同故沿用，只跑上述 38 项定向。

**未重跑项**：隔离 Nginx 静态交付三阶段（`NGINX_BIN=… pnpm test:delivery`）本轮未重跑——本轮改动只有 CSS 值等价替换、`aria-label` 与客户端快照引用，交付脚本与产物路由未变；`check:dist` 与 production e2e 覆盖了产物构建与装配，四宽度截图覆盖渲染。该未重跑项如实记录，不写成“已通过”。

## 四宽度截图（同候选重拍）

- 新目录 `evidence/final-2-screens/`（63 张 PNG＋`conditions.json`），`sourceCommit=88b692f`、`sourceStatus=[]`；首次 `evidence/final-screens/`（`sourceCommit=9bfdbaf`）保留为历史，黄金图未更新。截图条件（浏览器/字体/宽度/时区/语言/缩放）与首次逐键相同。
- 逐张对照（ImageMagick AE，1% fuzz 与无容差权重和，脚本结果见 [对照数值](final-screens-compare-2.json)）：**56/63 张字节完全相同**；其余 7 张 AE@1% fuzz 为 0，无容差权重和 ≤0.144 像素（比例 0.000000），全部属字体/抗锯齿级渲染抖动；**可见差异 0 张**。
  - `list-360`、`list-768`、`list-1280`、`manage-360`、`manage-768`、`comments-1280`、`comments-error-1280` 共 7 张不是逐字节相同，但 1% fuzz 判定为零差异像素，且这些场景的声明值本轮未变（管理页完全未改），与首次对照 09 历史截图时同样的抗锯齿现象一致。
  - 结论：token 引用、`--brand-soft` fallback 删除、`aria-label` 文案与快照引用删除都没有改变受控视觉；`aria-label` 不进入截图，符合预期。
- 10 票指针更新为 `88b692f` + `final-2-screens`（见 [issue 10](../issues/10-visual-and-real-device-acceptance.md)）。

## 未验证（不代签）

人工视觉签收、iPhone Safari/实际 Chrome 设备、真实飞书/上游/OSS、目标机部署与持续运行均未验证；本轮未操作生产、未访问真实上游、未 push、未合 main、未重排旧历史。人工视觉与设备验收仍由 10（`ready-for-human`）处理。
