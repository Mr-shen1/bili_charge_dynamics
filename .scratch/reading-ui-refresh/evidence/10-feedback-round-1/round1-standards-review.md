# code-review Standards 轴：7ebf5aa...093b40d（票 12+13 组合候选）

基点 7ebf5aa527f9d47928e7e1cef42aab955a96ba6c → 目标 093b40d0b8aca9219f410fa3884fd441288d03ee
（e9f511b 需求同步 / c930fed 整段契约 / ab158d8 会话居中 / fdde574 证据 / d81779b 布局 / fb4bfe5、093b40d 布局证据，merge 79e080e）
规范来源：AGENTS.md、~/.pi/agent/AGENTS.md、frontend/README.md、docs/agents/{codegraph,domain,implement-spec}.md、
docs/design/{reading-ui-refresh,frontend-migration,ui-reference}.md；无 CONTRIBUTING/CODING_STANDARDS。

## 确认缺陷（1 项，低危但确实损坏）

S1 `frontend/tests/e2e-visual/layout.spec.ts:428` 中文注释含 3 个 U+FFFD：
`* 只看“可见那块”的框色/底色：有 ::before 看它，没有���退回 wrapper 自身的底色。`
证据：`git show 093b40d:frontend/tests/e2e-visual/layout.spec.ts | sed -n 428p | hexdump -C` →
`e6 b2 a1 e6 9c 89 ef bf bd ef bf bd ef bf bd e9 80 80`（“没有”与“退回”之间被替换字符占据）。
由 d81779b 引入；全 diff 仅此 1 处（`git diff 7ebf5aa...093b40d | grep -c $'\xef\xbf\xbd'` = 1）。
影响：注释不可读，说明该次编辑有编码丢失；不涉运行逻辑。建议改为“没有 ::before 时退回 wrapper 自身的底色”。

## 判断项（非阻断，按 smell baseline）

J1 Duplicated Code：`frontend/src/app/readingPosition.ts:45-81`（restoreReadingPosition）与 `95-175`
（centerReadingAnchor）复制同一套“用户交互即停止”：wheel/touchmove/pointerdown/keydown 四监听 + cancelAnimationFrame
+ 相同注销清单；同文件 `27-38` 的 onUserScroll 已是第三份近似形状。建议在本文件内提取一个 `onReadingInterrupt(stop)`
（不加模块层），centerReadingAnchor 直接复用。

J2 Speculative Generality（两处无需求抽象）：
- `readingPosition.ts:99` `options: { readonly gap?: number } = {}`，唯一调用方 `pages/ConversationPage.vue:65` 只传 3 参，
  全仓库无 `centerReadingAnchor(..., { gap })`。
- `readingPosition.ts:139` `measure()` 返回 `{top, lead, tail, maximum}`，`maximum` 只在函数内用于算 tail，
  `locate`（146-166）只读 top/lead/tail；返回类型里的该字段是死字段。

J3 Data Clumps / 重复类型形状：`{lead, tail}` 三处各自声明：
`readingPosition.ts:84-87 CenterPadding`、`snapshots.ts:119`（ConversationRead.padding 内联匿名类型）、
`ConversationPage.vue:40`（`ref({ lead: 0, tail: 0 })`）。建议让 `ConversationRead.padding` 复用同一类型；
注意 readingPosition.ts:1 已 `import type { ReadingPosition } from './snapshots'`，反向 import 会成环，
把 `CenterPadding` 移到 snapshots.ts（或 readingPosition 侧的本地类型改由 snapshots 导出）即可，不需新文件。

J4 测试辅助重复：可见块内缩量算法（`::before` 的 content/top/bottom 推算 visible 高度）在
`tests/e2e-visual/layout.spec.ts`（formFrames/frame，约 90-150 行）与 `tests/e2e/manage.spec.ts:482-500`
（visibleHeight）各写一份；`tests/support/` 已是共享层（同 diff 刚扩了 layout.ts），可下沉。

J5 注释与实现不完全对应：`manage.css:111` 称“外部行为断言：layout.spec.ts（四宽度可见等高、命中 ≥43、四态框色）”，
实际“四态框色”只在 390px 单宽度一条用例（`layout.spec.ts:431`），四宽度只覆盖可见等高与命中盒。
另 `manage.css:105`“把图的可见描边”疑为“把框的”笔误。

J6 文档状态不一致（非硬违反）：`docs/design/reading-ui-refresh.md:3`（e9f511b 写入）仍写
“票 10 人工反馈新增整改（12、13，待实施/复验）”；`.scratch/reading-ui-refresh/implementation-plan.md:3`
仍写“12、13 整改中”。而两票实现（ab158d8/d81779b）与复验证据（fdde574/fb4bfe5）已落，
issues/12、13 均 `Status: resolved`，docs/README.md 已改为“整改中”。设计文档自称“交付状态与证据以项目文档导航为准”，
故不判硬违反，但“待实施”与 resolved 证据互相矛盾，合入前应统一措辞。

J7 接口注释与行为不一致：`navigation.ts:29` 注释“只有已经显示过（并居中或恢复过位置）的访问才有”，
但 `ConversationPage.vue:69-77` 在 onBeforeUnmount 无条件保存——loading、error、not-found 时也会写入一份
（anchorId=null、pixelY 为当前滚动）。此后同一访问再回来既不再居中、恢复的也是无内容时的位置。
边界很窄（快速进出或首屏失败），但注释声明的不变式不成立。

J8 提交正文接近“堆测试清单”：`docs/agents/implement-spec.md`“测试是验证的家，正文不堆测试日志或命令清单”，
而 fb4bfe5/d81779b 正文列了 `pnpm check`、`check:dist`、235、9、38 项等门槛与计数。判断项，可精简。

## 已核验为合规（避免误报）

- 库内部类覆盖登记：`manage.css:103-158` 新增 `.el-input__wrapper` 及其 :hover/.is-focus/.is-disabled 覆盖，
  已在 `.scratch/reading-ui-refresh/evidence/12-avatar-and-management-alignment.md:38-42` 登记，
  并有自动化断言（layout.spec.ts:431 四态框色、manage.spec.ts:502-508 四宽度可见等高/命中≥43），
  符合 `docs/design/frontend-migration.md:112`“新增例外必须同时补自动化断言并在实现证据中登记”。
- `docs/design/reading-ui-refresh.md:150` 对“覆盖库内部输入类”另要求“实际 iPhone 聚焦/失焦验证”；
  evidence/12 §6 明确“真机 / iPhone Safari 未复验”。该行原文绑定 16px 目标，票据 17 R1 已回退字号为库默认 14px，
  故不判硬违反，但本次新增的聚焦描边确实只经 Linux Chromium 取证——记录为已知限度。
- token 登记：`theme.css:63 --gutter-min` 带原因注释并在 evidence/12 §2 登记；
  `--manage-action-inset` 由 `.manage-shell .el-button` 上提到 `.manage-shell`（manage.css:8/79）是收敛重复而非加层，
  输入与按钮共用同一内缩量，符合“不要为提炼而加层”。未见无主/无登记的新 token。
- 后端契约：`app.py:350-360` 缺省 page 即整段、单独 limit 判 INVALID_INPUT；`page` 由
  `Query(pattern=r"^[1-9][0-9]*$")` 校验（`?page=` 不会走到 `_reply_offset`），`storage.py:1612-1638`
  两种返回形状共用 body，契约文档 archive-api.md / archive-api-client.md 同步一致。
- 前端契约守卫：`archiveReader.ts:236-249` 拒绝 `'page' in raw` 与 `items.length !== count`，并有单测
  （archive-reader-replies.test.ts:389/394/397）；mock 同步；无“静默只显示前 10 条”的隐患。
- 提交格式：`type(scope): 中文描述`、跨范围 `feat(backend,frontend)` 并列，符合 implement-spec.md。
- 导航新增 `conversationRead` 与既有 `listSnapshot`/`detailSnapshot`/`replyVisitSnapshot` 同形（含 path 守卫），
  `isConversationPath` 复用既有正则风格，未引入平行抽象。

## 结论

确认缺陷 1 项（S1，编码损坏，注释级）；其余 8 项为判断/一致性项，均不阻断合入。
未发现命名、分层、CSS 覆盖登记或 token 登记上的硬违反。
