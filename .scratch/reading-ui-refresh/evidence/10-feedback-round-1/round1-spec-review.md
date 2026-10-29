# reading-ui-refresh 首轮反馈整改：Spec 轴复核（只读）

比较区间：`git diff 7ebf5aa527f9d47928e7e1cef42aab955a96ba6c...093b40d0b8aca9219f410fa3884fd441288d03ee`
（提交 e9f511b 需求、c930fed 整段 API/adapter、ab158d8 会话呈现居中、fdde574 证据、
d81779b 头像与管理布局、fb4bfe5/093b40d 证据；HEAD 未随漂移，源码均按 `git show 093b40d:path` 验证）
规格来源：spec.md 决定 8–11、issues/12、13、docs/design/reading-ui-refresh.md §3.2/§5/§6–7/§9。
未运行任何测试套件、未改任何文件、未触碰预览服务/黄金图/main/部署。

## 逐项核对（用户三项最新目标）

### A. 头像/选中焦点边框完整不裁切（12、设计 §3.2）
- `frontend/src/dynamics/ArchiveNavigation.vue:143-160`：`.up-strip` 由 `margin/padding: 0` 改为
  `margin: -6px; padding: 6px`，裁剪边界外移 6px 而头像/昵称位置与行高不变（选中 2+2、焦点 3+2 需 ≥5px）。
- `frontend/src/theme/theme.css:56-63,117-123`：新增 `--gutter-min: 6px`，
  `.app-main` `max-width: calc(724px + 12px)`、`padding: 16px max(--gutter,--gutter-min) 40px`，
  使 641–736px 贴边区间负外边距落回视口内；桌面内容宽仍 724px（`frontend/tests/e2e/detail.spec.ts:221-243`
  改为比对 **内容盒** 与卡片边缘）。旧断言（边框盒对齐）已同步改写，未静默放宽。
- 覆盖：`frontend/tests/e2e-visual/layout.spec.ts:39-86,263-285`（选中轮廓、`:focus-visible` 轮廓、
  横滑到末端后的最后一项空间，四宽度 360/390/768/1280）与新增 700px 贴边回归
  `layout.spec.ts:410-423`（含 `expectNoPageOverflow`）。→ **符合，无缺陷**。

### B. 管理文字居中、输入按钮同可见高、44 命中、手机 16 字（12、设计 §6–7）
- `frontend/src/manage/manage.css:3-9,76-81`：`--manage-action-inset` 由 `.el-button` 上移到
  `.manage-shell`（桌面 6px／手机 4px），按钮与输入共用同一内缩。
- `manage.css:102-152`：`.el-input__wrapper` 保留库的 44px 盒（`theme.css:74` `--el-component-size: var(--touch)`），
  可见描边改由 `::before` 内缩画出，并显式接回默认/`:hover`/`.is-focus`/`.is-disabled` 四态；
  与库对比：Element Plus 2.14.7 用 `box-shadow` inset 表达边框（`node_modules/element-plus/theme-chalk/src/input.scss:225-259,385-397`），
  `.is-error`（(0,4,0)）仍高于新规则（(0,2,0)），不会被吞；某态选择器特异性也逐一高于库规则。
- `manage.css:247-262`：`.manage-add/.manage-fields .el-form-item { align-items: center }`（库标签盒 32px 在 44px 行内交叉轴居中）。
- 字号未动：`manage.css:92-100`（桌面 14px／手机 16px），未改 `--el-font-size-base`/`--el-component-size`。
- 覆盖：`layout.spec.ts:88-170,346-407`（可见高度 32/36、`hit ≥ 43`、输入与按钮等高、标签/单选/输入/按钮同排文字中心 ≤1px、
  字号 16/14）＋既有 `frontend/tests/e2e/manage.spec.ts:477-506`。→ **符合，无缺陷**。

### C. 会话单次整段、居中“刚才查看”、恢复（13、设计 §5.2–5.3、spec 决定 8–9）
- HTTP：`backend/bili_monitor/app.py:344-358` 缺省 `page` 即整段；只给 `limit`、非法页码、未知/重复参数仍 422；
  显式 `?page&limit=10` 旧兼容保留（`storage.py:1612-1640`，整段无 `page` 键、有 page 才切片），
  与 `docs/backend/api/archive-api.md:297-300` 一致；`?sort` 仍 422；404 身份、503/500 沿用。
- Adapter：`frontend/src/data/archiveReader.ts:229-250,419-432` 无查询串、`cache:'no-store'`、
  出现 `page` 键或 `items.length !== count` 一律 `error`（旧后端不静默只给 10 条）。
- 页面：`frontend/src/pages/ConversationPage.vue:31-36` 单次读取、`:106-140` 无分页控件、`:127` 唯一“刚才查看”、
  `:121-122` `data-conversation-entry`/`aria-current`；`:147-166` 入口底色与 12/22 标记；
  `:38-66` 新进入居中/已访问恢复；`:109-114` 留白作用于列表。
- 居中工具：`frontend/src/app/readingPosition.ts:95-175`（双 rAF、一次性、`wheel/touchmove/pointerdown/翻页键` 立即让位、
  首尾按“未夹紧内容底边”补最小留白、最多两轮收敛），与 `restoreReadingPosition:45-81` 同语义。
- 历史恢复：`navigation.ts:365-370`（`conversationRead` 只存位置+留白、只对 conversation 路径生效）、
  `snapshots.ts:108-121`；`ConversationPage.vue:59-63` 先还原留白再落点。
- 覆盖：`frontend/tests/unit/conversation-reading.test.ts:143-231`（14 条整段、无分页控件、标记唯一、居中 146/首条补 162 停 8/用户滚动后不抢）、
  `frontend/tests/unit/conversation-navigation.test.ts:485-575`（同访问恢复 600、短会话留白 222 随历史还原）、
  `frontend/tests/e2e-location/conversation.spec.ts:102-135,140-260,283-306,241-241`（真实 HTTP + 隔离 SQLite：11 条整段、
  无 `page` 键、`?page=2&limit=10` 兼容切片、只读、末尾居中 ≤2px、刷新/直达再次居中、单次请求无查询串）。
- 旧起点首屏/会话分页已按反馈移除（`ConversationPage.vue` 删除 `ReplyPager` 与页状态），符合“旧方案不是新要求”。
  → **功能符合**。

## 确认缺陷（2 项，均文档级，无功能性缺陷）

1. **`frontend/README.md:45-46` 仍写旧的分页契约**：原文
   “新只读资源 `GET .../replies/{reply_id}/conversation?page&limit=10` 提供整段可确认对话”，
   与 `archiveReader.ts:419-429`（无查询串）、`archive-api.md:297-301`（缺省整段、无 `page` 键、显式 page 仅旧兼容）、
   `archive-api-client.md:282` 全部冲突。票 13 交付与验收明确写“本票负责……相关 API 文档/前端 README/测试与证据”，
   本次只更新了 README 的结构/测试表（`:168-181`），漏了这处契约段 → **需求项缺失（13 交付清单）**。

2. **`frontend/tests/e2e-visual/layout.spec.ts:428` 提交了编码损坏的注释**：
   `只看“可见那块”的框色/底色：有 \`::before\` 看它，没有���退回 wrapper 自身的底色。`
   （hexdump 确认 `ef bf bd ef bf bd ef bf bd` 三个 U+FFFD，原字应为“否则”）。不影响运行，
   但属可复现的提交内容损坏，建议还原。

## 判断项（2 项，需主线程裁决，不代签）

3. **失败/空访问也被记成“已居中过”**：`ConversationPage.vue:69-77` 无条件在卸载时
   `saveConversationRead(...)`，即使 `state.data === null`（首屏失败或取消，见 `:100-105` 的错误分支）。
   之后按历史回到同一访问时 `restored`（`:29`）为真，`:56-66` 会走“恢复位置”而不是居中，
   于是整段虽读取成功却不会把入口回复居中、也看不到“刚才查看”在视口内。设计 §5.2 说“同一访问的历史位置恢复继续有效”，
   而这次访问并没有产生可用阅读位置；是否应“仅在 `settled`/有内容时保存”属语义选择，未被任何测试覆盖。

4. **文档状态与票据状态不同步**：`docs/design/reading-ui-refresh.md:3` 仍写“12、13，待实施/复验”，
   `docs/README.md:48` 仍写“12/13 整改中”，而 `issues/12`、`issues/13` 已 `Status: resolved` 且有证据
   （`evidence/12-*.md`、`evidence/13-*.md`），`map.md:19` 已登记 12 resolved。
   按“不追改旧证据”的前提这不含伪造，但台账口径不一致，与规格决定 44（分别记录交付状态）有轻微冲突。

## 可选建议（2 项）

5. `frontend/src/manage/manage.css:111-112` 注释称“外部行为断言：tests/e2e-visual/layout.spec.ts（四宽度可见等高、
   命中 ≥43、四态框色）”，但四态框色只在 390px 跑一次（`layout.spec.ts:431-433,448-475`），
   建议把注释写成“四宽度等高/命中 + 390px 四态”，避免夸大覆盖。

6. 潜在（当前不可达）状态缺口：库的 `.el-form-item.is-error .el-form-item__content .el-input__wrapper`
   （特异性 (0,4,0)、44px inset 危险色）未被 `::before` 接管；现有管理表单无 `:rules`/`validate`（已 grep 确认），
   故不触发。若将来加校验，错误态会出现 44px 可见框，破坏“输入与按钮可见等高”。

## 明确未发现问题（0 项确认缺陷的领域）

- 整段 API 的身份/异常/只读语义、旧显式分页兼容、`?limit` 单独出现 422：与文档、后端测试
  （`backend/tests/test_conversation_reading.py:177-215,249-256,396-437`）一致，未发现实现错误。
- 641–736px 中间宽度：`theme.css` 与 700px e2e 回归闭合，无页面横溢与轮廓裁切。
- hover/focus/disabled 语义：输入四态、按钮既有四态均未丢失；上行特异性核对通过。
- 未要求的增量：`--gutter-min` 全局主栏留白（641–747px 内容窄 12px、桌面内容宽不变）属 12 的必要配套，
  有注释与 700px 断言，未视为越界；无其它无关功能扩张。
- 旧证据未被追改；未更新黄金图；未代签人工或真机。

## 限制

- 未运行 `pnpm check` / `check:dist` / e2e / pytest（任务要求不跑大套件），
  类型与断言结论来自源码与既有测试文件比对；真机 Safari 输入字号仍为未关闭项（票 10）。
