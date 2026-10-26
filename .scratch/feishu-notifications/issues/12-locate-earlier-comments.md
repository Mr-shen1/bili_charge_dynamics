# 12: 定位视图补齐目标之前的评论

**What to build:** 让「一级评论/楼中楼精确定位」入口在直达并高亮目标之外，仍能读到目标**之前**的评论——不再出现「打开定位链接后，目标之前的评论消失」的观感。具体交互形态待用户在三选一中裁决（见下）。

**Blocked by:** 无（11 的真机验收暴露该缺口，但实现不依赖 11 的其余结论）。

**Status:** resolved

**裁决：** 方案 A（按需向前分页），由用户选定。

**来源：** 票据 [11](11-real-feishu-device-acceptance.md) 真机验收。用户在 iPhone 13 Pro / iOS 16.4 / 飞书内置浏览器上打开 `http://192.168.8.20:4291/dynamics/123/comments/860030/locate`（45 条中的第 30 条），定位与高亮正确，但**目标之前的评论不在页面上**。用户判定「不能接受」，B2（详情页不显示动态标题）已接受。

## 现状与依据（已核对，不是猜测）

- 后端定位窗口从目标索引开始，响应只有 `items` 与后向 `next_cursor`，没有前向游标：`backend/bili_monitor/storage.py:848-874`；契约 `docs/backend/api/archive-api.md:229-233`。
- 前端定位只取这一批（`frontend/src/data/archiveReader.ts:288-306`、`frontend/src/dynamics/useCommentsRead.ts:31-37`），追加交互只有单向「加载更多评论」（`frontend/src/dynamics/CommentList.vue:126`），全仓无「加载更早」入口。
- 既有 e2e 把「定位后恰好 20 条」写成了断言：`frontend/tests/e2e/comment-location.spec.ts:59,134`、`frontend/tests/e2e-location/comment-location.spec.ts:57-74`。改行为必须同步改这些断言，并说明新契约。
- 相关既有约束：`docs/backend/api/archive-api-client.md:256-258`、`.scratch/feishu-notifications/spec.md:158`（「不能为一次定位渲染全部评论」）。

## 待用户裁决的三种交互形态

| 方案 | 行为 | 代价 / 风险 |
| --- | --- | --- |
| **A（推荐）按需向前分页** | 定位视图顶部显示「以上还有 N 条更早评论」+「加载更早评论」；点击后读目标之前的一批，插入到列表头部且**不改变当前滚动位置** | 后端 location 增加前向游标/`before` 参数；前端要处理插入时的滚动锚定与高度补偿；与「不一次渲染全部评论」完全兼容 |
| **B 一次读到目标页** | 定位时同时读第 1 页到目标页，目标之前的评论立即可见 | 实现最直观；定位一次要多读 N 批；大动态（数百条以上）退化，且与 spec.md:158 的既有约束直接冲突，需要用户明确放宽 |
| **C 只给入口与提示** | 显示「以上还有 N 条更早评论」+「从头读起」；点击后回到未定位状态、从第 1 页读起 | 改动最小；但用户仍需自己滚回目标，定位的“一步到位”被削弱 |

## 验收条件（按选定方案细化后定稿）

- [ ] 打开非首批一级评论的定位链接后，仍**先**定位并高亮目标（现有 FS-AC-11 行为不回退）。
- [ ] 目标之前的评论可以通过界面读到，且不依赖回到列表重进。
- [ ] 前向加载不改变当前视口位置（不会因为插入内容把用户甩走）。
- [ ] 目标不存在、接口 404/422/502、迟到响应的既有行为不变。
- [ ] 楼中楼定位入口行为与一级评论对称（若方案对两者一致）。
- [ ] 单测 + e2e 覆盖新契约，原「恰好 20 条」断言按新行为改写而不是删除。
- [ ] 真机复测：在 iPhone 13 Pro / iOS 16.4 / 飞书内置浏览器上重开同一定位链接确认。
- [ ] 文档同步：`docs/backend/api/archive-api.md`、`docs/backend/api/archive-api-client.md`、必要时 `docs/design/feishu-notifications.md`。

## 复测方式（不需要重发飞书消息）

定位链接是静态路由，复测只需手机重新打开同一地址；不需要新增或重发任何群消息，因此不触及票据 11 的 11 条上限。

## Acceptance 结果（实现与证据）

已按方案 A 交付：

- 后端：`_root_window` 增返 `prev_cursor`（以窗口**终点**为坐标的向前游标，前缀 `p`，与后向游标不混淆）与 `earlier_count`；新增 `_root_back_window`（向前窗口 `[max(0, end-limit), end)`，不与已读窗口重叠，不返回后向游标）。读取仍只访本地 SQLite、不冻结快照、零写入。
- 前端：`CommentBatch` 增可选 `prevCursor`/`earlierCount`（缺省 `null`/`0`，普通分页不受影响）；`useCommentsRead` 增 `loadEarlier()`（独立请求，只改写向前状态，**不改写** `nextCursor`，失败保留已读批次）；`CommentList` 顶部显示「以上还有 N 条更早评论」+「加载更早评论」，插入后按锚点评论的位移分帧收敛滚动位置（原生锚定已补偿时只补差额，连续两帧稳定即结束）。

验收条件逐条：

- [x] 非首批一级评论链接仍先定位并高亮目标（原有 FS-AC-11 行为未回退）：`tests/e2e/comment-location.spec.ts` 原用例继续通过。
- [x] 目标之前的评论可通过界面读到，不需回列表重进：新用例 `定位后可以向前读目标之前的评论：提示更早条数、插入后视口不跳动`。
- [x] 前向加载不改变当前视口位置：该用例断言点击前后目标视口位置差 ≤ 4px（桌面 + Pixel 7 两个项目）。
- [x] 目标不存在、404/422/503、迟到响应行为不变：既有用例全部继续通过。
- [x] 楼中楼：**本轮未改**。它仍是页码式分页（每页 10 条 + 页码），不存在“目标之前不可读”的同一缺口；用户已知悉，若要求同样形态另开票据。
- [x] 单测 + e2e 覆盖新契约，原「恰好 20 条」断言保留（首次仍 20 条）并新增插入后 40/44/45 的断言，不是删除。
- [x] 真机复测：iPhone 13 Pro / iOS 16.4 / 飞书 `V8.1.15-882880079` 内置浏览器，用户回报「通过」。
- [x] 文档同步：`docs/backend/api/archive-api.md`、`docs/backend/api/archive-api-client.md`。

全门槛（本轮实测）：

```
backend:           1031 passed（uv run --no-sync pytest backend/tests -q）
frontend pnpm check:      278 passed / 24 文件，e2e 项目守卫通过
test:e2e:          205 passed / 10 skipped
test:e2e:location: 4 passed（实际 API + 隔离 SQLite）
check:dist:        exit 0（生产/mock 两次构建 + 产物隔离）
```

真机复测的现场数据（已随票据 11 一起清理）：动态 `123` 共 45 条、目标为第 30 条；定位窗口 16 条 `860030–860045`、`earlier_count=29`；向前两批分别为 `860010–860029`（20 条）与 `860001–860009`（9 条），`earlier_count` 依次 9 → 0，合计 45 条全部可达。

## Comments

- 由票 11 真机验收派生，记作 F-11-01；票 11 在本项被接受前不会宣称完整验收。
- 2026-10-26 用户选定方案 A；实现与上述证据完成后，用户真机复测回报「通过」。
