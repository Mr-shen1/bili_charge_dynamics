# reading-ui-refresh 首轮整改：独立收尾复核（Spec 轴，只读）

范围：`git diff 093b40d0b8aca9219f410fa3884fd441288d03ee...344235a`（含 `c85d35b` 定位收敛、
`64a6e28` 未显示内容不记账、`a6d5c09` 注释/乱码/README、`c04ff76` 合入集成 tip、`344235a` 证据；
主线程正式状态同步 `16f5c35`/`e233fcf` 已在区间内）。未跑套件、未改文件、未碰服务/产品/黄金图/main。

结论：**新引入确认缺陷 1 项（文档级、非阻断）；代码/测试/需求层面新引入缺陷 0 项。**

## 1. 确认缺陷（1 项，文档级）

### F1 `10-feedback-round-1-review.md:29` 的“全仓替换字符 0 处”不成立
原文：`验证：修复后 \`grep -rl $'\xef\xbf\xbd' frontend/src frontend/tests\` 无命中，全仓替换字符 0 处。`

- 前半句正确：344235a 的 `frontend/src`、`frontend/tests` 无 U+FFFD（本复核实测无命中），
  `frontend/tests/e2e-visual/layout.spec.ts:428` 已还原为“没有 \`::before\` 时退回 wrapper 自身的底色”。
- 后半句不成立，344235a 实测仍有 3 处：
  1. `.scratch/reading-ui-refresh/evidence/10-feedback-round-1/round1-spec-review.md:63`（本轮新增的原文副本，
     故意保留被替换字符的原始行）；
  2. `.scratch/reading-ui-refresh/evidence/10-feedback-round-1/round1-standards-review.md:11`（同上）；
  3. `scripts/prepare-local-deployment-package.sh:157`（`构建`→`构<U+FFFD>建`，093b40d 既存，不在本区间）。
- 建议改成“frontend/src 与 frontend/tests 无命中（原文副本与既有历史脚本另有替换字符，本轮不追改）”。
  不影响断言、运行或需求，不要求改写历史或副本内容。

## 2. 重点核实 1：`settled && state.data` 保存门（J7、64a6e28）

代码：`frontend/src/pages/ConversationPage.vue:75` `if (!settled || !state.value.data) return;`
（`settled` 在 `:59` 于成功首屏渲染后置位，`centerReadingAnchor` 在 `:66` 才调用；保存体 `:76-80`）。

- **防空访问快照：成立。** `useReplyPage` 的 not-found/error/cancelled 都把 `data` 置空
  （`frontend/src/dynamics/useReplyPage.ts:83-87`），loading 本就 `data: null`，从未成功则 `settled` 为假，
  三种未显示状态都被拦下，不再写入无锚点位置；`navigation.ts:365-370` 与 `navigation.ts:29`
  注释“只有已经显示过（并居中或恢复过位置）的访问才有”终于与实现一致。
- **不丢用户取消自动居中后的真实位置：成立。** 用户滚动/触摸/按下/翻页键只置 helper 内部 `stopped`
  （`frontend/src/app/readingPosition.ts:108-109,144-164`），不回写 `settled`；卸载时 `:71-73` 仅注销监听、不滚动，
  故 `:76-77` 的 `captureReadingPosition` 取到的是用户最终停下的真实位置，已补的留白也随 `:79` 一起保存。
- **不覆盖既有好记录：成立。** 已保存过的访问再次前进时若读取失败（`data` 为空）直接返回，旧 `conversationRead`
  不被空记录覆盖，下一次成功前进仍按原位置恢复。
- 覆盖：`frontend/tests/unit/conversation-navigation.test.ts:533-597` 用真实入口进入、分别停在“加载中”
  与“读取失败”（`:553`）、滚到 300 后离开、`router.go(1)` 前进并断言重新居中到 146（`:595`）；
  既有“同访问恢复 600”（`:513`）与“短会话留白 222/位置 120”未改。
- 覆盖边界（判断，非缺陷）：没有单测专门构造“居中尚未落点即被用户打断后离开”，该路径按上面代码走保存；
  既有用例覆盖的是落点后离开。可留待日后按需补，不构成本轮缺陷。

## 3. 重点核实 2：共用交互 helper 未改恢复/排序语义

- 新 helper `frontend/src/app/readingPosition.ts:27-41` 的事件集与回调与 093b40d 两处原实现逐事件一致
  （wheel/touchmove/pointerdown → 停止 (+`onUserInteraction`)；keydown 仅 `readingKeys`）；
  接入点 `:74`（`restoreReadingPosition`）与 `:109`（`centerReadingAnchor`），清理改为 `release()`（`:88-91,166-169`）。
- `onUserScroll`（`:48-59`）函数体未改，仅上方注释增一行说明“比一次性阅读定位窄一档”；
  它的三处调用（`useLocateTarget`、`ListVisit`、`CommentSection` 排序让位）语义因此不变。
- `centerReadingAnchor` 的 `{ gap }` 删除：唯一调用点 `frontend/src/pages/ConversationPage.vue:66` 是三参调用，
  常量 8px 与原默认同值；`measure` 不再返回 `maximum`：093b40d 的 `locate` 从未读取该字段
  （`measure` 内仍用局部 `maximum` 算 `tail`，`readingPosition.ts:135-137`）。→ 行为中性。
- `CenterPadding` 移至 `frontend/src/app/snapshots.ts:49-53`，`ConversationPage.vue:5,41` 与
  `readingPosition.ts:1` 单向引用；`snapshots.ts` 不 import `readingPosition`，无环。
- 恢复/排序回归面：`restoreReadingPosition` 的取锚点/像素后备/夹紧（`:75-87`）逐行未变。

## 4. 重点核实 3：README 与乱码闭环

- `frontend/README.md:45-47` 已改为“不带查询参数、一次读完整个本地可确认集合”，并写明显式
  `?page=N&limit=10` 仅为冻结旧预览产物保留兼容、本轮 UI 不使用；与 `archive-api.md:297-300`、
  `archive-api-client.md:282`、`archiveReader.ts:419-429` 口径一致，票 13“前端 README”缺口闭合。
- `frontend/tests/e2e-visual/layout.spec.ts:428` 乱码已还原（纯注释，diff 仅 1 行）。
- `frontend/src/manage/manage.css:108-112` 注释改为“四宽度可见等高、命中 ≥43；390px 四态框色”，与
  `layout.spec.ts:431-475` 的实际覆盖相符（原判断项已闭环）。

## 5. 逐项处置证据与状态同步核对

- `.scratch/reading-ui-refresh/evidence/10-feedback-round-1-review.md` 编号与两轴报告一致
  （S1、J1–J8、Spec 1–6）；两份原文副本与审查报告逐字相同（本复核对 `round1-spec-review.md` 与
  上一轮 `/tmp/reading-ui-refresh-round1-spec-review.md` 做 `diff -u`：完全一致，未被改写）。
- J6 交由主线程：`docs/design/reading-ui-refresh.md:3`、`.scratch/reading-ui-refresh/spec.md:3`、
  `docs/README.md:48`、`.scratch/reading-ui-refresh/implementation-plan.md:3,44`、
  `.scratch/reading-ui-refresh/issues/10-visual-and-real-device-acceptance.md:24` 均改为
  “12/13 已实现并 resolved（实现与范围自动化）…人工待复验”，未宣称人工签收/黄金图/部署，未追改旧证据。
- 范围完整性：`git diff e233fcf...344235a` 只涉及本分支 10 个文件，未回退集成 tip；
  正式设计/spec/索引的改动均来自 `16f5c35`/`e233fcf`，与证据 §0/J6 自述一致。
- 明确保留项（is-error 预埋、测试几何辅助重复）本轮未要求整改，本复核不再提起。
- 状态措辞“组合候选 093b40d 审查中”在本分支合入前属正常过渡（`10-feedback-round-1-verification.md:37`
  声明“待审查整改合入后补充”），由 merger 在最终候选处更新，不计为缺陷。

## 6. 未验证/限制

未运行 `pnpm check`/`check:dist`/e2e/pytest（按任务要求）；上述结论基于源码与新增测试的逐行核对，
以及既有证据记录的绿结果。真机、iPhone Safari 输入聚焦/缩放、视觉签收、黄金图、部署仍为未验证项，
本复核不代签。
