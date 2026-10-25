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
| 普通详情入口、评论区入口、历史返回遵循原有恢复规则，定位后返回不清空来源列表 | `comment-location.spec.ts` “普通详情入口不受影响”（不请求定位端点、无高亮、首批前 20 条）；既有 `comments.spec.ts`（入口定位、排序快照、历史恢复）、`replies.spec.ts`、`thread.spec.ts` 全绿；定位路由不写详情快照，返回按既有规则 |
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
