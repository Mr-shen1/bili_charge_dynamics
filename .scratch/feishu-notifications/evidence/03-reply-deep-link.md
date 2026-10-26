# 03 楼中楼回复精确链接：实施与验收证据

对应票据：[03 楼中楼回复精确链接](../issues/03-reply-deep-link.md)；实施规格 [spec.md](../spec.md) §7「本站精确读取与浏览器入口」；正式规则 [飞书通知需求与设计](../../../docs/design/feishu-notifications.md) §5、FS-AC-11；读取契约 [归档 API](../../../docs/backend/api/archive-api.md#飞书通知-03-增量楼中楼回复定位读取) 与 [客户端契约](../../../docs/backend/api/archive-api-client.md#飞书通知-03-增量楼中楼回复精确入口)。

结论：**票据范围（回复只读定位读取 → 生产前端精确入口 → 宽屏展开定位高亮 / 窄屏独立楼中楼直达目标页）已实施，自动化与隔离集成证据齐全**。真实飞书客户端内置浏览器、手机实机、目标环境部署未验证，不得据此宣称完整交付；消息模板与投递归 04。

## 1. 范围与环境

- 复用 02 的只读定位语义、宽屏原 `ReplySection`（3 条预览 + 10/10/5 页内替换）与窄屏原独立楼中楼页；不新建第二套回复阅读器，不改变普通入口、预览、翻页、收起与历史恢复。
- 本票不依赖通知进程，不发送真实飞书消息，不新增采集、账号或图片能力；定位读取只访问本地归档。
- 环境：Linux；Python 3.12.15 + pytest 8.4.2（uv 0.12.23，`uv sync --locked`）；Node 24.21.0 + pnpm 10.34.6（`.nvmrc`）。本机设置了 `HTTP(S)_PROXY`，跑浏览器用例需 `NO_PROXY=127.0.0.1,localhost`。
- 隔离：后端用例只用临时 SQLite 与固定虚构上游；浏览器用例的归档响应由 HTTP 替身给出；实际 API 用例用 `backend/tests/live_app` 的虚构上游 + 本次运行独占 SQLite。全部身份、评论、回复、正文虚构。
- 不执行：真实 B 站采集、真实飞书投递、部署、推送；未读取真实凭据或路由配置。
- 端口：本票沿用既有 Playwright 配置的正式端口（4318/4319/4320、4178/4325），运行前确认空闲，未修改任何正式端口或新增并发专用端口；与 09/04 并行时如需同时跑浏览器用例，应由主线程协调端口占用。

## 2. 命令与结果（合并最新集成 tip `4e3b611` 后重跑；其代码与 `0ba443c` 等价，此后只并入 09 的票据/索引文档改动）

```sh
# 后端：本票新增定位契约用例
uv run --no-sync python -m pytest backend/tests/test_reply_location.py -q
# 1 passed

# 后端全量回归（含 09 告警/心跳与窗口生命周期用例）
uv run --no-sync python -m pytest backend/tests -q
# 885 passed, 3 warnings in 195.90s

# 前端一趟绿灯（typecheck + 单测 + e2e 项目覆盖守卫）
cd frontend && pnpm check
# Tests 271 passed（含本票 8 条新增单测）；e2e 项目覆盖与各 spec 声明一致

# 生产装配 + 归档 HTTP 替身（桌面与 Pixel 7 两个项目）
pnpm test:e2e
# 198 passed, 10 skipped（本票新增 13 例）

# 实际 API + 隔离 SQLite + 生产装配
pnpm test:e2e:location
# 4 passed（含本票 2 例）

# 相邻入口回归
pnpm test:e2e:manage     # 7 passed
pnpm test:e2e:production # 3 passed, 3 skipped
pnpm check:dist          # 两次构建 + 产物隔离通过
```

## 3. 红绿过程（TDD）

1. 后端先写 `backend/tests/test_reply_location.py`（真实归档 HTTP + 隔离 SQLite，仅替换来源 HTTP），红在
   `assert 404 == 200`（端点尚不存在）。实现 `Store.locate_reply` / `_reply_reading` / `_reply_page_document`
   与路由后转绿；随后 `test_replies.py`、`test_comment_sync_status.py`、`test_root_comment_location.py` 43 passed，
   证明把 page 模式抽成共享切片没有改变既有回复读取、冻结页与计数口径。
2. 前端先写三组单测：
   - `tests/unit/archive-reader-replies.test.ts` 2 条，红在 `reader.locateReply is not a function`；
   - `tests/unit/reply-reading.test.ts` 4 条、`tests/unit/thread-reading.test.ts` 2 条，红在
     `ReplyLocatePage.vue` 尚不存在（转换失败）与 `reply-locate` 路由缺失。
   补齐契约、生产 Adapter、mock/fault 装配、`useReplyPage` 定位首读、宽窄屏页面与路由后转绿。
3. 过程中被测试纠正的四处写法：
   - 宽屏精确入口仍要**先**用 02 的一级评论定位读取取含所属根评论的批次（首测未提供 `locateComment`，
     页面正确落到“目标评论不存在”），因此宽屏链接是“两次只读定位”而不是一次；
   - 宽屏断言“目标正文默认展开”不能查折叠按钮：`FoldableText` 按真实行高判定，jsdom 无排版，
     该点改由浏览器用例的“收起回复正文”断言承担；
   - 目标回复不存在时所属根评论仍在（上下文），单测最初误断言一级评论列表为空；
   - 收起后必须重新查询列表元素，Vue 会重建 `<ul>`，捕获旧引用会读到收起前的 5 条。
4. 浏览器层：新增 `tests/e2e/reply-location.spec.ts`（桌面 6 例）与 `tests/e2e/reply-location-thread.spec.ts`
   （Pixel 7 视口 7 例），首轮两处失败暴露的是夹具问题而非实现问题（目标正文写在第 1 页的回复上、
   窄屏根评论夹具 id 传成数字使 DTO 校验失败）；修正夹具后全绿。
5. 真实 API 用例 `tests/e2e-location/reply-location.spec.ts` 首轮失败两处：与 02 用例共享同一隔离数据库
   导致 `POST /api/manage/ups` 409（改为允许已存在），以及末页只有 5 条时目标无法滚到视口顶部
   （改为断言“进入视口且未回到页面顶部”）。`live_app` 的楼中楼分支最初挂在 `/x/v2/reply` 上，
   导致 45 个楼中楼全部 `internal_error`，改挂 `/x/v2/reply/reply` 后转绿。
6. 复核既有行为：`replies.spec.ts`/`thread.spec.ts`/`comments.spec.ts` 全量回归通过，说明收起定位根评论、
   预览 3 条、页码替换、历史恢复与普通楼中楼首屏行为未被本票改写。

## 4. 契约（供 04、05 使用）

### 4.1 稳定链接（浏览器入口）

| 项 | 契约 |
| --- | --- |
| 路径 | `/dynamics/{dynamicId}/comments/{rootId}/replies/{replyId}/locate`（`frontend/src/app/router.ts:23`，name `reply-locate`，组件 `src/pages/ReplyLocatePage.vue`） |
| 身份 | 动态、所属根评论、目标回复都是 URL 路径里的十进制字符串 ID；无 query、无凭据、无管理参数 |
| 分支 | 宽屏（>640px）复用动态详情内的原回复区；窄屏复用原独立楼中楼页。两条分支由同一链接决定 |
| 直开/刷新 | 分段读取：宽屏先取含所属根评论的一级评论批次（02 契约），再取目标所在回复页；窄屏只读一次目标所在页。两者都不先读首批/第 1 页 |
| 定位 | 目标正文默认展开、加 `data-located="true"`/`aria-current` 高亮并定位到该条；分页停在目标页；定位意图一次性消费，用户已滚动后迟到结果只高亮不抢滚动 |
| 异常 | 目标不存在/未归档：固定提示 + “返回动态”（替换为对应详情）；临时失败：既有读取失败提示 + 局部重试（重试重发定位，成功后仍把目标带回视口） |
| 返回与历史恢复 | 精确入口与普通详情同属详情族访问（`navigation.ts` `detailFamily`）：按访问身份保存含所属根批次、回复区展开、保存页码与位置的详情快照并记楼中楼来源；从窄屏精确根页进入独立楼中楼再返回、前进后退回到该访问、同 URL 图片预览关闭都按快照还原，回复区按保存页码实时重读而不重新按目标身份定位；只有新访问才按 URL 主动定位（见 §8） |
| 04 用法 | 消息链接按可信服务端基址拼 `{base}/dynamics/{dynamicId}/comments/{rootId}/replies/{replyId}/locate`；只读、无凭据、保留既有代理鉴权 |
| 05 用法 | 回复事件已带 `(dynamic_id, root_id, reply_id)`，可直接拼上述链接；根/回复任一未就绪时按 04 的等待条件处理，不需要额外参数 |

### 4.2 只读定位读取

| 项 | 契约 |
| --- | --- |
| 端点 | `GET /api/archive/dynamics/{id}/comments/{root_id}/replies/{reply_id}/location`（`backend/bili_monitor/app.py:259`） |
| 成功 | `{items[≤10], next_cursor:null, page, count, root, source_reply_count, local_reply_count, replies_last_attempt, synced_source_reply_count}`；`items` 就是目标所在页，`page` 是目标在所属根完整本地集合中的页码（1 起） |
| 排序 | 与 `GET .../replies?page=` 完全一致（发表时间升序、null 后置、ID BINARY 升序），共用同一份切片与 `reply_to` 解析（`storage.py:1029` `locate_reply`、`:1049` `_reply_reading`、`:1071` `_reply_page_document`） |
| 不存在 | 动态不存在、根评论不属于该动态或未归档、目标不属于该根或未归档 → `404 NOT_FOUND`（不泄露其他楼/动态） |
| 非法输入 | 该端点无查询参数；任何未知或重复 query → `422 INVALID_INPUT` |
| 只读性 | 不访问上游、不写归档、不冻结 `reply_pages`、不启动采集或通知（用例断言数据库字节与冻结页数不变） |

**取舍（明确记录）**：回复定位返回的是“目标所在页 + 页码”，后续翻页仍走既有 page 模式，不新增游标模式；
因此宽屏链接的首次渲染需要两次只读定位（一级评论批次 + 回复页），窄屏一次。两次都在本地归档上完成，
不触发采集、不写库，也不引入冻结快照。定位到的页按当前归档实时读取，期间新增/删除会让页码含义变化，
前端每次进入都重新定位，不缓存上次页码。

### 4.3 前端接口位置

| 层 | 位置 |
| --- | --- |
| 结果类型 | `ReplyLocation = ReplyBatch & {page}`、`ReplyLocationResult = ReadResult<ReplyLocation> \| {status:'not-found'}`（`frontend/src/data/contracts.ts:128`） |
| 读取契约 | `DynamicReader.locateReply({dynamicId, rootId, replyId, signal})`（`contracts.ts:146`） |
| 生产 Adapter | `frontend/src/data/archiveReader.ts:349`：404/非法身份 → `not-found`（非法身份不发请求），异常/非 200/DTO 不符/页码缺失/**目标不在这一页** → `error`（可重试），取消优先 |
| 页映射复用 | `replyPageBatch`（`archiveReader.ts:184`）同时服务 page 模式与定位读取，避免两套页校验分叉 |
| 读取挂载 | `useReplyPage(read, initialPage, locate?)`（`frontend/src/dynamics/useReplyPage.ts:69` `readLocation`）：首个请求走定位，页码由服务端给出；定位失败重试重发定位 |
| 宽屏 | `ReplySection.vue:49`（定位首读）、`:127` `locatePending` 一次性定位、`:150` 目标正文默认展开；根评论上下文经 `CommentSection.vue:40`（回复定位时根评论不抢高亮/滚动）→ `CommentList.vue:103` → `DetailVisit.vue:70` |
| 窄屏 | `CommentThreadPage.vue:31`（定位首读）、`:49` 一次性定位、`:98` 重试重发定位；`:39` 定位模式不再 `scrollTo(0)` |
| 分支页面 | `src/pages/ReplyLocatePage.vue`（按 640px 断点选择详情或独立楼中楼，两者都用访问身份 key 隔离） |

## 5. 验收条件 → 证据

| 票据验收条件 | 证据 |
| --- | --- |
| 明确并实现稳定回复链接及只读定位响应，返回足以显示目标与所属根上下文的数据；校验动态、根、回复归属，不串楼 | §4 契约；`test_reply_location.py` 断言 `root` 与页内条目、跨楼/跨动态/不存在回复全部 404、非法 query 422；`archive-reader-replies.test.ts` 断言 URL、页码与“目标必须在页内” |
| 一根超过 10 条回复、目标不在首屏或首个预览时，宽屏自动展开并显示目标所在页，定位高亮准确 | `reply-location.spec.ts`“直开定位链接”（25 条、目标第 14 条在第 2 页；只请求 2 次定位、10 条页内替换、`data-located`/`aria-current` 只有 1 条、目标贴近视口顶部、分页停在第 2 页）；`e2e-location/reply-location.spec.ts` 用实际 API 复证末页目标 |
| 窄屏独立楼中楼入口直接显示指定回复所在页并高亮，不强制重置为第一页 | `reply-location-thread.spec.ts`（直达只读 1 次定位、10 条、`aria-current`、目标在视口顶部、分页 `aria-current=2`）；`thread-reading.test.ts` 同口径单测 |
| 首次打开、直开、刷新均不依赖旧内存或用户先读过根评论；回复正文在定位时可阅读、不被折叠隐藏 | 两个浏览器用例都含 `reload` 后仍定位；宽屏断言目标正文“收起回复正文”可见（即已展开）与最后一行可见；窄屏楼中楼正文不折叠 |
| 定位不一次渲染全部回复，原页内替换、后续翻页、收起及普通无精确目标的首屏行为保持 | 定位响应固定 10 条；翻页断言 `page=3` 仍替换；收起回到 3 条预览并定位根评论开头；`replies.spec.ts`/`thread.spec.ts`/`comments.spec.ts` 全量回归通过 |
| 正常返回与历史恢复符合原有访问规则；定位完成后不持续拉回目标；迟到响应不污染新的动态或楼层 | “刷新后仍从链接定位，完成后不再抢占滚动”（滚动后 300ms 位置不变）；`reply-reading.test.ts` 切换目标链接的迟到结果不覆盖；`reply-location-thread.spec.ts` 定位在途离开后详情无错误、无高亮；直达/刷新进入的楼中楼仍按无来源规则 replace 为动态详情，而从精确根页进入的楼中楼记有来源、返回回到该精确访问（§8） |
| 目标删除/缺失、归属错误与暂时读取失败有区分；明确提示并提供返回动态入口或局部重试，不静默显示楼层顶部冒充成功 | 单测与浏览器用例各有“不存在 → 提示 + 返回动态”和“503 → 读取失败 + 重试后高亮（并回到目标）”两组；Adapter 层把“窗口里没有目标”判为错误而不是成功 |
| 归档定位不请求 B 站；链接不含凭据，保持代理保护，不增加回复图片采集或额外上游查询 | `test_reply_location.py` 断言重启后不提供来源 handler 仍成功且数据库字节、冻结页数不变；`e2e-location/reply-location.spec.ts` 断言读取前后 `/api/test/source-requests` 与归档文档完全相等；链接无 query/凭据 |
| 生产前端＋HTTP 替身覆盖宽窄屏及后续页，真实 API＋隔离数据库证明任意归档回复可定位；回归 02 的一级评论入口 | `reply-location.spec.ts`（桌面）与 `reply-location-thread.spec.ts`（Pixel 7 视口）为替身证据；`e2e-location/reply-location.spec.ts` 为实际 API + 独占 SQLite（首/末页目标、渲染顺序与定位响应一致、窄屏刷新、404 返回）；`comment-location.spec.ts`、`e2e-location/comment-location.spec.ts` 同批通过 |
| 记录供 05 使用的回复定位契约及结果，真实客户端未验证项单列 | §4（含 04/05 用法）、§6 |

## 6. 未覆盖与限制（不得据此宣称完整交付）

- **真实客户端未验证**：飞书内置浏览器、手机实机、代理访问与目标环境运行属票据 11，需另行授权；本票自动化只用 Linux Chromium（桌面 1280 与 Pixel 7 视口模拟），不是真机证据。
- 宽屏链接的首次渲染是两次只读定位（一级评论批次 + 回复页）；窄屏一次。这是复用既有分页与阅读模型的取舍，未合并成单次接口，也不引入冻结快照。
- 定位到的页按当前归档实时读取：期间新增或删除回复会让页码含义变化，续读/重进都重新定位；本期不实现回复删除提示，也不对页码漂移做额外承诺。
- 高亮与“定位后默认展开”只在精确定位入口出现；普通详情/楼中楼入口、历史恢复与视觉基准不受影响，但**未重跑视觉基准**（`pnpm visual:baseline`/`visual:compare`），若后续要为高亮态建立黄金图需单独补充。
- 消息模板、群路由与真实投递归 04；飞书端绝对一次送达、手机实机、目标环境运行不在本票范围。
- 本票不改变采集节拍、上游请求范围或通知阶段；定位读取不产生通知事实。

## 7. 复现要点（评审者可照做）

```sh
# 只跑本票的定位契约与前端读取契约
uv run --no-sync python -m pytest backend/tests/test_reply_location.py -q
cd frontend && pnpm vitest run tests/unit/archive-reader-replies.test.ts \
  tests/unit/reply-reading.test.ts tests/unit/thread-reading.test.ts
# 只跑本票的浏览器场景（单个项目，自动起服务）
NO_PROXY=127.0.0.1,localhost pnpm playwright test --project=desktop-chromium-archive tests/e2e/reply-location.spec.ts
NO_PROXY=127.0.0.1,localhost pnpm playwright test --project=mobile-chromium-archive tests/e2e/reply-location-thread.spec.ts
# 返回与历史恢复（§8）
pnpm vitest run tests/unit/locate-return.test.ts
NO_PROXY=127.0.0.1,localhost pnpm playwright test --project=desktop-chromium-archive tests/e2e/locate-return.spec.ts
NO_PROXY=127.0.0.1,localhost pnpm playwright test --project=mobile-chromium-archive tests/e2e/locate-return-thread.spec.ts
# 实际 API + 隔离 SQLite
NO_PROXY=127.0.0.1,localhost pnpm test:e2e:location
```

## 8. 重开修复：精确入口的返回与历史恢复（2026-10-26）

提前 Spec 审查发现的真实回归：楼中楼回复精确入口（及同源的一级评论精确入口）没有进入原详情快照与楼中楼来源体系，返回/历史恢复会丢阅读位置、重复主动定位，与 spec §7「主动定位完成后不持续抢占滚动，原返回与历史恢复行为保持」冲突。票据重开后补齐，链接、读取契约与后端行为未改变。

### 8.1 缺陷

- `frontend/src/app/navigation.ts` 的详情路径判定只认 `/dynamics/{id}`：`saveDetailSnapshot` 对精确页直接返回（快照被丢弃）、`openThread` 不记来源、`returnFromThread` 只认普通详情路径。
- 窄屏精确根页 → 查看楼中楼 → 返回因此走 `replaceWith('/dynamics/{id}')`，替换成普通详情顶部，已读批次与滚动丢失。
- 历史回到精确访问时没有快照：`DetailVisit` 重新消费入口定位（`detailTarget`）抢回目标；宽屏回复区在恢复时重新按目标身份定位（多一次定位读取）并强制把目标滚到顶部。

### 8.2 修复（复用原导航协调器与快照体系，不新建状态系统）

| 位置 | 改动 |
| --- | --- |
| `frontend/src/app/navigation.ts` | 新增 `detailFamily(path)` 统一详情族判定（普通详情 + 两个精确入口）；`isDetailPath` 改用其判定；`returnFromThread` 按动态核对详情族来源 |
| `frontend/src/dynamics/DetailVisit.vue` | `locateOnEntry = !initial`：主动定位只属于新访问 |
| `frontend/src/dynamics/CommentSection.vue` | 入口定位是否仍待执行由 `locateOnEntry` 决定，历史恢复按位置还原 |
| `frontend/src/dynamics/ReplySection.vue` | 快照存在即按保存页码实时重读（不再按目标身份定位），`activeLocate` 只在 setup 无快照时成立，恢复不抢滚动 |

直达/刷新进入的楼中楼仍无详情来源，返回仍 replace；目标不存在/临时失败/显式重试的语义不变（用户点重试仍把目标带回视口，不算抢滚动）。

### 8.3 红 → 绿（TDD，红测跑在修复前的工作树上）

```sh
# 红：只留新测试、把 src 修复暂存
cd frontend && pnpm vitest run tests/unit/locate-return.test.ts
# 3 failed | 1 passed
# - expected 'detail' to be 'comment-locate'
# - expected [ '9014', '9014' ] to deeply equal [ '9014' ]（恢复时重新按目标身份定位）
# - expected [ '5025', '5030', '5025' ] to deeply equal [ '5025', '5030' ]（历史返回重新定位）

NO_PROXY=127.0.0.1,localhost pnpm playwright test --project=mobile-chromium-archive \
  tests/e2e/locate-return-thread.spec.ts      # 1 failed | 1 passed
# 红：toHaveURL 期望 /comments/7025/locate$，实际 /dynamics/1001

# 绿
pnpm vitest run tests/unit/locate-return.test.ts                                  # 4 passed
NO_PROXY=… pnpm playwright test --project=mobile-chromium-archive \
  tests/e2e/locate-return-thread.spec.ts                                          # 2 passed
NO_PROXY=… pnpm playwright test --project=desktop-chromium-archive \
  tests/e2e/locate-return.spec.ts                                                 # 3 passed
```

被测试纠正的一处写法：`ReplySection` 不能用 `props.initial === undefined` 判断“是否历史恢复”——本回复区自己的 `update` 回写会让同一个 prop 立刻变成已定义，导致恢复时仍走定位读取（首测红在 `expected [ null ]`）；改为 setup 时一次性判定 `restored`。

### 8.4 浏览器覆盖（生产装配 + 归档 HTTP 替身）

| 用例 | 观察结果 |
| --- | --- |
| `locate-return-thread.spec.ts`（Pixel 7）“定位后继续追加并滚动，进入独立楼中楼再返回” | 返回后 URL 仍是精确访问、21 条已读批次、唯一 `data-located`、`scrollY` 等于离开前，定位端点请求数仍为 1 |
| `locate-return-thread.spec.ts` “刷新精确根入口仍是新访问” | 刷新后重新按 URL 定位：20 条定位批次、目标回到视口顶部、无普通分页请求 |
| `locate-return.spec.ts`（桌面）“精确入口的图片预览打开再返回” | 关闭同 URL 预览后 20 条批次、唯一高亮与 `scrollY` 都不变，没有新的定位或分页请求 |
| `locate-return.spec.ts` “切换排序时根评论定位批次晚到 / 目标回复页晚到” | 受控 600ms 延迟的两个方向都保持目标回复在视口顶部、高亮唯一、分页停在第 2 页 |
| `tests/unit/locate-return.test.ts`（4 条） | 窄屏精确根页进楼中楼返回；历史返回回复精确访问按保存页码（`page=2`）重读且只请求一次；同一动态两个精确访问前进后退各取自己的批次与位置；同链接新访问重新定位 |

### 8.5 未证实风险的验证结论：排序切换时的滚动竞争

“宽屏回复精确入口切换根排序时，`CommentSection` 根锚 `scrollIntoView` 与 `ReplySection` 回复 `scrollIntoView` 可能竞争”在受控延迟下未复现：排序切换会先重建评论列表，回复区的定位读取在列表落地后才挂载并落点，因此两个方向（根批次晚到 600ms、回复页晚到 600ms）都是目标回复最后落点。已补两条浏览器用例作为回归守卫，**未改动**排序定位代码。

### 8.6 重跑结果（合并集成 tip `be8dfa5`（04 通知闭环）后的工作树 `af81252`；其后并入的 `a4c9530` 只改地图/计划/票据文档，代码等价）

```sh
cd frontend && pnpm check        # typecheck + 275 passed + e2e 项目覆盖一致
pnpm test:e2e                    # 203 passed（本票新增 5 例：桌面 3 + Pixel 7 2）
pnpm test:e2e:location           # 4 passed
pnpm test:e2e:notification       # 2 passed（04 投递产物链接在窄屏刷新后仍定位）
pnpm test:e2e:manage             # 7 passed
pnpm test:e2e:production         # 3 passed, 3 skipped
pnpm check:dist                  # 两次构建 + 产物隔离通过
uv run --no-sync python -m pytest backend/tests/test_reply_location.py -q   # 1 passed（后端未改动）
```

合并入集成分支后在合并 tip `894a253`（`--no-ff`，源 `e86ad73`）上只重跑了 `git diff --check`（通过）与 `cd frontend && pnpm check`（typecheck + `275 passed`）；全量 e2e 按计划留票据 10 统一执行，分支内上述结果未被改写。后端零改动（合并 diff 不含后端文件）。

### 8.7 未覆盖与限制

- 宽屏回复精确访问无法在浏览器里经应用内导航产生历史记录（详情页没有指向精确入口的链接；直达只能整页加载，按刷新语义重建内存快照），其返回恢复由 memory-history 单测覆盖；浏览器覆盖真实可达的窄屏“精确根页 → 独立楼中楼 → 返回”。
- 历史恢复时不重新定位的前提是上次离开前首批读取已完成；若上次仍在 loading/cancelled，恢复会继续读取但不抢滚动，这一边界未单独建立浏览器用例。
- 恢复按保存页码重读：期间新增/删除回复会让“页码含义”漂移（与 §4.2 既有取舍一致），本期不承诺页码稳定，也不扩展回复删除提示。
- 未重跑视觉基准；未验证真实飞书客户端、手机实机与目标环境运行（归票据 11）。
