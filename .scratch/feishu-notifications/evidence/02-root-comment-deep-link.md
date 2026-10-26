# 02 一级评论精确链接：实施与验收证据

对应票据：[02 一级评论精确链接](../issues/02-root-comment-deep-link.md)；实施规格 [spec.md](../spec.md)；正式规则 [飞书通知需求与设计](../../../docs/design/feishu-notifications.md)（§5 精确链接、FS-AC-11）；读取契约 [归档 API](../../../docs/backend/api/archive-api.md#飞书通知-02-增量精确一级评论定位读取) 与 [客户端契约](../../../docs/backend/api/archive-api-client.md#飞书通知-02-增量精确一级评论入口)。

结论：**票据范围（一级评论只读定位读取 → 生产前端精确入口 → 浏览器定位/展开/高亮/返回）已实施，自动化与隔离集成证据齐全**。真实飞书客户端内置浏览器、手机实机、目标环境部署未验证，不得据此宣称完整交付；楼中楼回复归 03。

## 1. 范围与环境

- 复用既有归档读取、详情与一级评论阅读，不新建第二套评论阅读器；不涉及飞书投递设施（04 才有消息）。
- 环境：Linux；Python 3.12.15（`uv sync --locked`）；Node 24.21.0 + pnpm 10.34.6（`.nvmrc`；本机设置了 `HTTP(S)_PROXY`，跑 e2e 需 `NO_PROXY=127.0.0.1,localhost`）。
- 隔离：后端用例只用临时 SQLite 与固定虚构上游；浏览器用例的归档响应由 HTTP 替身给出；实际 API 用例用 `backend/tests/live_app` 的虚构上游 + 本次运行独占 SQLite。全部身份、评论、正文均为虚构。
- 不执行：真实 B 站采集、真实飞书投递、部署、推送。

## 2. 命令与结果（合并集成分支 tip `ca6dd45` 后重跑）

```sh
# 后端：本票新增定位契约用例
uv run --no-sync python -m pytest backend/tests/test_root_comment_location.py -q
# 1 passed

# 后端全量回归
uv run --no-sync python -m pytest backend/tests -q
# 870 passed, 3 warnings in 142.81s

# 前端一趟绿灯（typecheck + 单测 + e2e 项目覆盖守卫）
cd frontend && pnpm check
# Tests 263 passed；e2e 项目覆盖与各 spec 声明一致（含 comment-location.spec.ts）

# 生产装配 + 归档 HTTP 替身（桌面与 Pixel 7 两个项目）
pnpm test:e2e
# 185 passed, 10 skipped

# 实际 API + 隔离 SQLite + 生产装配（本票新增入口）
pnpm test:e2e:location
# 2 passed

# 相邻入口回归
pnpm test:e2e:manage     # 7 passed
pnpm test:e2e:production # 3 passed, 3 skipped
pnpm check:dist          # 两次构建 + 产物隔离通过
```

## 3. 红绿过程（TDD）

1. 后端先跑工作树内已有的定位契约用例（票据接手时的未提交红测）：
   `assert 404 == 200 where 404 = <Response [404 Not Found]>`（`test_root_comment_location.py:28`，端点尚不存在）。
2. 实现 `Store.locate_root` / `_root_window` / 无状态续读游标与路由后转绿；随后全量后端回归 826 passed（当时基线），证明既有最热/最新分页、冻结页与回复读取没有被改动。
3. 前端先写 `tests/unit/archive-reader-comments.test.ts` 的 4 条定位用例，红在
   `TypeError: reader.locateComment is not a function`；补 `CommentLocationResult`、`DynamicReader.locateComment`、生产 Adapter 与 mock/fault 装配后转绿（该文件 19 passed）。
4. 再写 `tests/unit/comment-reading.test.ts` 的 5 条页面用例（定位批次、不存在、重试、用户已滚动、切换链接迟到响应），红在模板/装配未接；实现 `useCommentsRead` 锚点读取、`CommentList` 高亮与 not-found 提示、`CommentSection` 目标定位、`navigation.showDetail` 后转绿（该文件 25 passed）。过程中测试纠正了两处写法：滚动取消要用真实的 `wheel` 事件（应用只认滚轮/触摸/指针/阅读键），切换链接前须等首个定位请求真正发出，否则用例验证不到“迟到响应”。
5. 浏览器层：新增 `tests/e2e/comment-location.spec.ts`，桌面与 Pixel 7 两个项目各 6 例通过；随后跑全量 e2e 时被既有 `replies.spec.ts` 挡下——
   我给 `.comment` 加的 `scroll-margin-top: 12px` 让“收起后定位根评论开头 = 0”变成 12px（回归），移除该样式后恢复，说明既有收起定位语义不被高亮样式改写。
6. 实际 API 用例：`tests/e2e-location` 首轮通过，但 `pnpm test:e2e:manage` 随即失败——我在 `live_app` 里选用的动态 `800200` 与管理用例的“无法确认归属”动态撞号，使 `TARGET_UNVERIFIED` 断言失效；把夹具动态改为 `800300` 后两侧全绿（也证明票 02 不改变既有管理/归属校验行为）。

## 4. 契约（供 03、04 复用）

### 4.1 链接（浏览器入口）

| 项 | 契约 |
| --- | --- |
| 路径 | `/dynamics/{dynamicId}/comments/{rootId}/locate`（`frontend/src/app/router.ts:18`，name `comment-locate`，复用 `DetailPage`） |
| 身份 | 动态与目标一级评论都是 URL 路径里的十进制字符串 ID；ID 不转 Number，不含任何凭据或管理参数 |
| 行为 | 直接打开、刷新、宽窄屏、历史返回都走同一条路由；首批直接取含目标的那一批，不先读首批、不渲染全部评论 |
| 定位 | 目标正文默认展开、加 `data-located="true"`/`aria-current` 高亮并定位到该条（`CommentItem.vue:53`、`CommentSection.vue:51`）；用户已滚动后迟到的定位结果只高亮不抢滚动，定位意图一次性消费 |
| 续读 | “加载更多评论”沿用定位批次的 `next_cursor`，不回退首批 cursor；切换排序仍以同一目标为首批锚点 |
| 异常 | 目标不存在/未归档：固定提示 + “返回动态”（替换为对应详情，`navigation.ts:225` `showDetail`）；临时失败：既有读取失败提示 + 局部重试；都不把列表顶部当定位结果 |
| 返回与历史恢复 | 精确入口与普通详情同属详情族访问（`navigation.ts` `detailFamily`）：按访问身份保存详情快照并记楼中楼来源，从精确入口进入独立楼中楼再返回、前进后退与同 URL 图片预览关闭都按快照还原已读批次与位置、不重复主动定位；只有新访问（直开、刷新、同链接新进）才按 URL 主动定位（见 §7） |
| 04 用法 | 消息链接按可信服务端基址拼 `{base}/dynamics/{dynamicId}/comments/{rootId}/locate`；只读、无凭据、保留既有代理鉴权 |

03 复用建议（未实施）：同形状扩展为 `/dynamics/{dynamicId}/comments/{rootId}/replies/{replyId}/locate`，读取端相应新增 `/api/archive/dynamics/{id}/comments/{root_id}/replies/{reply_id}/location`，并复用本票的 `showDetail` 兜底、目标展开与一次性定位语义。

### 4.2 只读读取接口

| 项 | 契约 |
| --- | --- |
| 端点 | `GET /api/archive/dynamics/{id}/comments/{root_id}/location?sort=hot\|latest`（`backend/bili_monitor/app.py:233`） |
| 成功 | `{items: RootComment[≤20], next_cursor: string \| null}`，**`items[0]` 就是目标评论**；排序与 `/comments` 完全一致（置顶 → 最热点赞 → 发表时间 → ID） |
| 续读 | `next_cursor` 可直接用于 `GET .../comments?cursor=...`；绑定动态、排序、批量 20，跨动态/跨排序/摘要不符返回 `422 CURSOR_INVALID` |
| 不存在 | 动态不存在、根评论不属于该动态或尚未归档 → `404 NOT_FOUND`（不泄露其他动态内容） |
| 非法输入 | 非法 `sort`、未知或重复查询参数 → `422 INVALID_INPUT`；`limit` 不是该端点参数 |
| 只读性 | 不访问上游、不写归档、不冻结快照、不创建 `root_comment_pages` 行、不启动采集或通知（`backend/bili_monitor/storage.py:821` `locate_root`、`:840` `_root_window`） |

**取舍（明确记录）**：定位请求零写入，因此其续读游标是**无状态偏移**（`storage.py:73` `_root_offset_cursor`），续读按当前归档重算窗口，不是冻结快照；期间新增/点赞变化可能让窗口边界前移或后移。前端按 ID 去重，所以不会重复展示；评论删除不在本期范围。需要冻结快照的调用方仍应按既有方式读不带 cursor 的首批。

### 4.3 前端接口位置

| 层 | 位置 |
| --- | --- |
| 结果类型 | `CommentLocationResult = ReadResult<CommentBatch> \| {status:'not-found'}`（`frontend/src/data/contracts.ts:122`） |
| 读取契约 | `DynamicReader.locateComment({dynamicId, rootId, sort, signal})`（`contracts.ts:134`） |
| 生产 Adapter | `frontend/src/data/archiveReader.ts:257`：404 → `not-found`，非法身份 → `not-found`（不发请求），异常/非 200/DTO 不符/**窗口里没有目标** → `error`（可重试），取消优先 |
| mock/fault 装配 | `frontend/src/mock/archiveReader.ts:220`（fault 由展开继承） |
| 读取挂载 | `frontend/src/dynamics/useCommentsRead.ts:32`：仅“首批且声明锚点”走定位，续读回到普通分页 |
| 页面状态 | `CommentReadState.status` 增 `not-found`（`frontend/src/app/snapshots.ts`），`CommentList` 自己渲染提示与返回入口，不交给通用读取失败提示 |

## 5. 验收条件 → 证据

| 票据验收条件 | 证据 |
| --- | --- |
| 明确并实现稳定链接与只读归档契约；ID 保持字符串、不依赖旧会话或已加载 DOM | §4 契约；`test_root_comment_location.py`（重启后不提供来源 handler 仍可定位）、`archive-reader-comments.test.ts` 定位 URL/身份校验、e2e “直开定位链接”与 `reload` 后仍定位 |
| 超过 20 条一级评论时直达非首批目标，自动取数、展开折叠正文、定位并高亮 | `comment-location.spec.ts` “直开定位链接”（45 条、目标第 25 条，断言只请求定位批次、`data-located`、`aria-current`、目标贴近视口顶部、`收起评论` 出现即已展开）；`e2e-location` 用实际 API 复证目标不在首批 |
| 不一次渲染全部评论，不破坏既有排序/分页/后续阅读；不把页首当定位结果 | 定位批次固定 20 条；续读断言 `cursor=loc:44`；`comments.spec.ts`/`replies.spec.ts` 全量回归通过；“目标不存在”用例断言 `listitem` 数为 0 且无高亮 |
| 首次打开、直接访问、刷新、宽窄屏正确；定位完成后不持续抢占滚动 | 两个 e2e 项目（桌面 + Pixel 7）同套用例；`scrollY` 在用户滚动后 300ms 内保持不变；`e2e-location` 窄屏 390 宽 `reload` 后仍定位 |
| 普通详情入口、评论区入口、历史返回遵循原有恢复规则，定位后返回不清空来源列表 | `comment-location.spec.ts` “普通详情入口不受影响”（不请求定位端点、无高亮、首批前 20 条）；既有 `comments.spec.ts`（入口定位、排序快照、历史恢复）、`replies.spec.ts`、`thread.spec.ts` 全绿；精确路由与普通详情同属详情族访问，返回/历史恢复按详情快照还原（§7） |
| 身份不匹配/目标不存在有明确提示与返回对应动态入口；临时失败与不存在分开且可重试 | `comment-location.spec.ts` 两个用例（404 → 提示 + 返回动态落到 `/dynamics/1001`；503 → 读取失败 + 重试后成功）；`e2e-location` 用实际 API 复证 404 分支 |
| 快速切换链接或迟到响应不定位/覆盖/高亮另一条评论 | `comment-reading.test.ts` “切换定位链接时另一条访问的迟到响应不覆盖当前目标”“用户已滚动时迟到的定位结果不抢回位置”；`comment-location.spec.ts` “定位期间切换排序” |
| 只读定位仅访问本地归档、上游请求为零；凭据不进 URL、保留代理保护、不新增账号体系 | `test_root_comment_location.py` 断言无来源 handler 时仍成功且数据库字节不变；`e2e-location` 断言读取前后 `/api/test/source-requests` 与归档文档完全相等；链接无 query、无凭据 |
| 生产装配＋归档 HTTP 替身覆盖主要浏览器场景；真实 API＋隔离 SQLite 证明可读取与无采集副作用；证据分别记录 | `tests/e2e/comment-location.spec.ts`（替身）与 `tests/e2e-location/comment-location.spec.ts`（实际 API + 独占 SQLite）分开记录于 §2 |
| 记录链接与读取契约供 03、04 复用；按约定声明新增浏览器测试所属项目；不增加真实飞书前置条件 | §4；`comment-location.spec.ts` 首行 `// @projects desktop-chromium-archive, mobile-chromium-archive` 由 `pnpm check:e2e-projects` 校验；`test:e2e:location` 为独立配置（见 §6 限制） |

## 6. 未覆盖与限制（不得据此宣称完整交付）

- **真实客户端未验证**：飞书内置浏览器、手机实机、代理访问与目标环境运行属票据 11，需另行授权；本票自动化只用 Linux Chromium（桌面与 Pixel 7 视口模拟），不是真机证据。
- 楼中楼回复精确定位归票据 03；一级评论消息模板与投递归票据 04。
- 定位续读游标不冻结快照（§4.2），因此定位后续读的窗口边界可能随归档变化移动；本期不实现评论删除，也不对边界移动做额外承诺。
- `pnpm test:e2e:location` 是独立 Playwright 配置（独立端口与独占 SQLite），其 spec 不受 `check:e2e-projects` 的 `@projects` 守卫覆盖（与管理项目同现状）；启动前仍要求 `NO_PROXY=127.0.0.1,localhost`。
- 未重跑视觉基准（`pnpm visual:baseline`/`visual:compare`）：高亮样式只出现在精确定位入口，普通详情截图不含该状态；若后续需要该状态的视觉基准，应单独补充。
- 本票不改变采集节拍、上游请求范围、通知阶段或迁移；定位读取不产生通知事实（票据 04 才接入）。

## 7. 重开修复：精确入口的返回与历史恢复（2026-10-26）

提前 Spec 审查指出的真实回归：一级评论精确入口没有进入原详情快照与楼中楼来源体系，返回/历史恢复会丢位置并重复主动定位，与 spec §7「主动定位完成后不持续抢占滚动，原返回与历史恢复行为保持」冲突。本节记录重开后的红绿与重跑结果；链接、读取契约、后端与普通详情/楼中楼的既有规则均未改变（回复侧细节见 [03 证据](03-reply-deep-link.md) §8）。

### 7.1 缺陷

`frontend/src/app/navigation.ts` 的详情路径判定只认 `/dynamics/{id}`，两个精确入口被当成“无详情快照、无来源”的页面：

- `saveDetailSnapshot` 对精确页直接返回，精确访问的已读批次、排序、展开与位置全部丢弃；
- `openThread` 不记来源、`returnFromThread` 只认普通详情路径，窄屏精确根页进入独立楼中楼后返回被 `replaceWith('/dynamics/{id}')` 成普通详情顶部；
- 历史回到精确访问时没有快照，`DetailVisit` 重新消费入口定位（`detailTarget`），把用户抢回目标。

### 7.2 修复（复用原导航协调器与快照体系，不新建状态系统）

| 位置 | 改动 |
| --- | --- |
| `frontend/src/app/navigation.ts` | 新增 `detailFamily(path)`：`/dynamics/{id}`、`/comments/{rootId}/locate`、`/replies/{replyId}/locate` 同属详情族；`isDetailPath` 改用其判定（保存快照、`openThread` 记来源）；`returnFromThread` 按动态核对详情族来源 |
| `frontend/src/dynamics/DetailVisit.vue` | `locateOnEntry = !initial`：主动定位只属于新访问 |
| `frontend/src/dynamics/CommentSection.vue` | 入口定位是否仍待执行由 `locateOnEntry` 决定，历史恢复按快照位置还原 |
| `frontend/src/dynamics/ReplySection.vue` | 快照存在即按保存页码实时重读；`activeLocate` 只在 setup 无快照时成立，恢复不重新定位也不抢滚动 |

直达/刷新进入的楼中楼仍无详情来源，返回仍 replace 到对应动态详情；精确入口的“目标不存在 → 返回动态”“临时失败 → 局部重试”语义不变。

### 7.3 红 → 绿（TDD，红测跑在修复前的工作树上）

```sh
# 红：只留新测试、暂存回 src 修复前
cd frontend && pnpm vitest run tests/unit/locate-return.test.ts
# 3 failed | 1 passed
# - expected 'detail' to be 'comment-locate'（精确根页进楼中楼后返回被替换成普通详情）
# - expected [ '9014', '9014' ] to deeply equal [ '9014' ]（回复访问恢复时重复主动定位）
# - expected [ '5025', '5030', '5025' ] to deeply equal [ '5025', '5030' ]（历史返回精确访问时重新定位）

NO_PROXY=127.0.0.1,localhost pnpm playwright test --project=mobile-chromium-archive \
  tests/e2e/locate-return-thread.spec.ts
# 1 failed | 1 passed
# - toHaveURL 期望 /comments/7025/locate$，实际 http://127.0.0.1:4320/dynamics/1001（返回丢精确访问）
# - 刷新重定位用例本就正确，修复前后都通过（作为“新访问仍主动定位”的守卫）

# 绿：装回修复
pnpm vitest run tests/unit/locate-return.test.ts   # 4 passed
NO_PROXY=127.0.0.1,localhost pnpm playwright test --project=mobile-chromium-archive \
  tests/e2e/locate-return-thread.spec.ts           # 2 passed
NO_PROXY=127.0.0.1,localhost pnpm playwright test --project=desktop-chromium-archive \
  tests/e2e/locate-return.spec.ts                  # 3 passed
```

浏览器新增用例在桌面与 Pixel 7 两个归档项目声明（`tests/e2e/locate-return*.spec.ts`，由 `pnpm check:e2e-projects` 校验），覆盖：窄屏精确根页定位后追加并滚动 → 查看楼中楼 → 返回恢复 21 条批次/唯一高亮/同一位置且不再请求定位端点；刷新仍是新访问并重新定位；精确入口打开图片预览再返回时批次、高亮与位置都不退化（桌面）。宽屏回复访问的历史返回与“同一动态两个精确访问互不覆盖”由生产导航协调器的 memory-history 单测覆盖（浏览器里没有应用内 PUSH 到精确入口的入口，见 §7.5）。

### 7.4 重跑结果（合并集成 tip `be8dfa5`（04 通知闭环）后的工作树 `af81252`；其后并入的 `a4c9530` 只改地图/计划/票据文档，代码等价）

```sh
uv run --no-sync python -m pytest backend/tests/test_root_comment_notifications.py \
  backend/tests/test_notification_protocol.py backend/tests/test_notification_migration.py \
  backend/tests/test_reply_location.py backend/tests/test_root_comment_location.py -q
# 51 passed（后端未改动，确认合并后仍绿）

cd frontend && pnpm check        # typecheck + 275 passed + e2e 项目覆盖一致
pnpm test:e2e                    # 203 passed
pnpm test:e2e:location           # 4 passed（实际 API + 独占 SQLite）
pnpm test:e2e:notification       # 2 passed（04 真实投递产物链接，合并后仍直达定位）
pnpm test:e2e:manage             # 7 passed
pnpm test:e2e:production         # 3 passed, 3 skipped
pnpm check:dist                  # 两次构建 + 产物隔离通过
```

合并入集成分支后在合并 tip `894a253`（`--no-ff`，源 `e86ad73`）上只重跑了 `git diff --check`（通过）与 `cd frontend && pnpm check`（typecheck + `275 passed`，`check:e2e-projects` 认到 `locate-return.spec.ts`/`locate-return-thread.spec.ts` 两条声明）；全量 e2e 仍按计划留票据 10 统一执行，上面的分支内结果未被本次合并改写。后端零改动，04 的 schema v18 与 09 的 `:40` 窗口修复在合并 tip 上均已核验存在。

### 7.5 未覆盖与限制

- 宽屏回复精确访问无法在浏览器里经应用内导航产生历史记录（详情页没有指向精确入口的链接，直达只能整页加载，内存快照按刷新语义消失）；其返回恢复由 `tests/unit/locate-return.test.ts` 用真实导航协调器 + memory history 覆盖，浏览器只覆盖真实可达路径。
- 历史恢复的定位意图判定按“setup 时是否有快照”决定：若上次离开时首批读取尚未完成（loading/cancelled），恢复仍会继续读取，但不再把目标抢回视口；这一边界未单独建立浏览器用例。
- 真实飞书客户端、手机实机与目标环境运行仍未验证（归票据 11）。
