# 02: 一级评论精确链接

**What to build:** 打开本站链接即可看到指定一级评论，即使它在后续批次，也会自动加载、展开、定位并高亮；直接访问、刷新和返回均可用。

**Blocked by:** 无（可立即开始）。

**Status:** resolved

## 上下文与范围

依据：[实施规格](../spec.md)、[正式需求与设计](../../../docs/design/feishu-notifications.md)、[领域词汇](../../../GLOSSARY.md)。对应用户故事 45、47–50、57；验收关联 FS-AC-11。

本票贯通归档读取契约、生产前端 Adapter 与阅读入口，不依赖飞书投递设施。复用现有详情和一级评论阅读，不另建独立完整评论阅读器；后续 03 扩展到回复，04 在消息中使用本票的稳定链接契约。

## 验收条件

- [x] 明确并实现以动态和目标评论身份定位的稳定链接与只读归档契约，必要的上下文可可靠取得；ID 保持字符串，不依赖旧会话或已加载 DOM。
- [x] 超过 20 条一级评论的样本中，可直达非首批目标；自动取得所需数据、展开被折叠的目标正文、定位并高亮。
- [x] 读取与定位不要求一次渲染全部评论，不破坏既有排序、分页及后续正常阅读；不把页首当作精确定位结果。
- [x] 首次打开、直接访问、刷新、宽屏与窄屏均正确；明确的主动入口定位完成后不持续抢占用户滚动。
- [x] 普通详情入口、评论区入口和历史返回继续遵循原有恢复规则；定位后的返回不会无故清空来源列表或跨访问污染。
- [x] 动态与评论身份不匹配或目标不存在时给出明确提示与返回对应动态入口；临时加载失败与不存在分开，可重试。
- [x] 快速切换链接或迟到响应不会定位、覆盖或高亮另一条访问中的评论。
- [x] 只读定位仅访问本地归档，上游请求计数为零；凭据不进入 URL，保留代理访问保护，不新增应用账号体系。
- [x] 生产装配＋归档 HTTP 替身覆盖主要浏览器场景，补真实 API＋隔离 SQLite 场景证明目标可读取和无采集副作用；各类证据分别记录。
- [x] 记录链接和读取契约供 03、04 复用，并按项目约定声明新增浏览器测试所属项目；不增加真实飞书验证前置条件。

## 验证方式

复用已有评论 20/20/5 批次、生产 Adapter、窄屏和历史恢复测试模式。使用实际前端路由与阅读逻辑；HTTP 替身只负责归档响应，不替代定位行为。真实 API 场景使用独占临时数据库，禁止对现有运行实例注入样本。

## 完成与后续

交付可通过浏览器直开演示的一级评论链接及契约证据。楼中楼具体回复由 03 完成，真实飞书内置浏览器及手机实机由 11 验证；本票自动化不冒充真实客户端通过。

## Answer

已交付一级评论精确链接的完整纵向切片：只读定位读取契约 + 生产前端入口 `/dynamics/{dynamicId}/comments/{rootId}/locate`。直达时不先读首批，而是按动态与目标身份取“以目标开头”的 20 条批次，展开折叠正文、定位到该条并高亮；续读沿用定位窗口的游标，目标不存在给固定提示与返回动态入口，临时失败可局部重试，用户已滚动后迟到结果不再抢占。定位读取不访问上游、不写归档、不冻结快照；链接只含字符串身份，无凭据。

- 读取契约：`GET /api/archive/dynamics/{id}/comments/{root_id}/location?sort=hot|latest` → `{items[≤20], next_cursor}`（首项即目标；404 不存在、422 非法输入）。实现 `backend/bili_monitor/app.py:233`、`backend/bili_monitor/storage.py:821`。
- 前端契约：`DynamicReader.locateComment`（`frontend/src/data/contracts.ts:134`、`frontend/src/data/archiveReader.ts:257`）、路由 `frontend/src/app/router.ts:18`、读取挂载 `frontend/src/dynamics/useCommentsRead.ts:32`、高亮 `frontend/src/dynamics/CommentItem.vue:53`、目标定位 `frontend/src/dynamics/CommentSection.vue:51`、返回兜底 `frontend/src/app/navigation.ts:225`。
- 正式契约文档：[归档 API](../../../docs/backend/api/archive-api.md#飞书通知-02-增量精确一级评论定位读取) · [客户端契约](../../../docs/backend/api/archive-api-client.md#飞书通知-02-增量精确一级评论入口)。
- 测试与证据：[02 证据](../evidence/02-root-comment-deep-link.md)（后端定位用例 1 passed、后端全量 870 passed、`pnpm check` 263 passed、`pnpm test:e2e` 185 passed、`pnpm test:e2e:location` 2 passed、`test:e2e:manage` 7 passed、`test:e2e:production` 3 passed、`pnpm check:dist` 通过）。

## Comments

- 链接形状用独立路径而不是详情页 query 参数：应用的历史/快照身份只按 `route.path` 建立，同路径不同 query 会被当成同一次访问，快速切换消息链接就会复用旧访问题、既不重读也不重新定位。独立路径天然得到新访问、重新挂载与重新定位，也不需要改导航身份模型。03 建议沿用同形状扩展为 `.../replies/{replyId}/locate`。
- 续读游标的取舍：定位请求要求零写入（后端用例断言数据库字节不变），所以定位窗口的 `next_cursor` 用绑定动态/排序/批量的无状态偏移，而不是既有 `root_comment_pages` 冻结页。代价是续读按当前归档重算窗口，期间新增或点赞变化可能移动窗口边界；前端本就按 ID 去重，因此不会重复展示，本期也不涉及评论删除。需要冻结快照的调用方仍读不带 cursor 的首批。
- 结果语义按“不存在 ≠ 暂时失败”拆分：404 与非法身份 → `{status:'not-found'}`（不发请求或固定提示 + 返回动态）；异常、非 200、DTO 不符、**响应窗口里没有目标** → 可重试 `error`。最后一条是防止后端回归时把页首当成定位成功。
- 定位意图一次性消费，且与既有入口/排序定位共用 `canLocate`：用户滚轮/触摸/指针/阅读键后，迟到的定位批次只高亮不滚动。切换排序时仍以同一目标作首批锚点，避免“切换排序就退回普通首批”。
- 被既有测试纠正的回归：给 `.comment` 加 `scroll-margin-top` 会让宽屏回复“收起后定位根评论开头 = 0”偏移 12px；已移除，说明高亮样式不得改写既有定位语义。另：`live_app` 的新夹具动态最初占用管理用例的未归属动态 `800200`，改为 `800300` 后两侧全绿。
- 测试项目声明：`tests/e2e/comment-location.spec.ts` 首行声明 `desktop-chromium-archive, mobile-chromium-archive` 并登记进 `archiveSpecs`，由 `pnpm check:e2e-projects` 校验；实际 API 场景另建 `playwright.location.config.ts` + `tests/e2e-location`（独立端口与独占 SQLite，`pnpm test:e2e:location`），这是本票新增的唯一浏览器项目。
- 未覆盖（不属本票或未授权）：楼中楼回复精确定位（03）、一级评论消息模板与投递（04）；真实飞书内置浏览器/手机实机/目标环境运行（11，需授权）。本票自动化只代表 Linux Chromium 桌面与 Pixel 7 视口模拟。
