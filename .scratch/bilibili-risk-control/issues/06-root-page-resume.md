# 06：一级评论分页持久续采

Status: resolved

**What to build:** 一级评论逐页保存可验证进度，中断、失败或重启后从有效断点继续；热帖新增只登记后续工作，不因计数变化无条件重复读取全部已确认根页。

**Blocked by:** 01 — 统一 B 站请求发送入口。

## 验收标准

- [x] 每页根评论和对应上游处理进度在同一短事务提交，包含目标／locator、处理代次、阶段、方向、页锚点、已确认 ID、下一位置及必要计数；不复用归档阅读 cursor。证据：`page_scan_progress`（v25）与页文档同一 `_change_roots` 短事务；字段含 locator／`generation`／`phase`／`direction`／`anchor_page`＋`anchor_ids`（已确认 ID）／`next_page`／`counts`；读取端 `root_comment_pages` 未复用。[evidence §1](../evidence/06-root-page-resume.md#1-交付内容)
- [x] 通过真实初始化／待处理执行链驱动中途失败、关闭重开及新进程接续，证明已得内容保留、进度可复用，不默认从第一页完整重扫；必要头页／重叠页校验须在账本中解释。证据：`test_failed_page_resumes_from_anchor_after_reopen_without_rescanning_head`——第 3 页失败后关库重开，请求序列 `[2,3,4,4]`（先复核第 2 页锚点），归档 GET 45 条；锚点复核理由见 [evidence §2](../evidence/06-root-page-resume.md#2-红绿过程tdd纵向切片)。
- [x] 续采验证定位资源与页锚点；新增、插入、删除或移动页时重定位受影响区段，不能只保存 pn+1 就盲跳，也不以重复 ID 假装推进。证据：`test_head_insertion_relocates_only_affected_pages`（`[2,3,1,3,4,4]`，只重读受影响的头部页）、`test_head_deletion_relocates_without_losing_archived_roots`（`[2,2,3,4,4]`）；`alignment` 只接受连续尾部重叠，整页重复仍判 `pagination_not_advancing`。
- [x] 采集中可信计数／revision 增长只登记后续待处理工作，不撤销有效分片；旧领取不能覆盖新观察、清除新工作或伪造最新 complete。证据：`test_completed_scan_only_registers_growth_and_stops_at_known_page`（增长后只读 `[1,2,3]`、进度不被清空、`confirmed=1`）、`test_stale_execution_cannot_write_progress_after_newer_claim`（旧代次 `stale`、零请求、不改写新行）；页内计数只拒绝减少，增长只记 `root_scan_count_grew`。
- [x] 保留根页现有作者／资源校验、置顶与热门去重、明确空尾确认、可信未知／失败和来源数口径；只有根集合确认后才推进根 checkpoint 及相应元信息，失败不删历史根。证据：`fetch_root_page`／`root_document` 未改；置顶仅整轮成功后发布；空尾复读确认保留（复读不稳定改为退回锚点重定位，仍有界收敛）；失败不推进 `synced_root_comment_count`、旧成功时间与历史根不动。
- [x] 新增进度结构能供后续楼中楼步骤沿用一致的分片／版本规则，但不提前实现楼中楼持久续采、全局公平调度或放宽 revision 校验。证据：主键 `(dynamic_id, stage, scope_id)` 与 `root_scan_step` 步骤返回面向 07／08 复用；本票未实现楼中楼续采、单路调度与 revision 放宽，见 [evidence §3](../evidence/06-root-page-resume.md#3-给-0708-的根进度-interface)。
- [x] 原子迁移保留旧归档、有效阅读 cursor、媒体及未完成工作；网络和等待不占写事务，旧 generation／领取／入选代次隔离回归不退化。证据：`test_v25_migration_preserves_archive_progress_media_and_reading_cursor`＋既有 `test_migrations`／`test_notification_migration`（合并 03 后版本 25、未来版本 26 拒绝）；既有并发用例证明慢页不占写事务、旧代次不能覆盖新完成。
- [x] 日志可定位动态、页码、完整本页根 ID、续采／重定位原因及 checkpoint 是否被接受；遵守父规格的字段／脱敏规则，不能输出内部令牌或正文。证据：复用 02 的 `source_refs`／`source_ids`，`root_page_saved`／`root_scan_position`／`root_scan_resumed`／`root_tail_confirmed`／`root_page_rejected`；用例正向断言 `uid=`／`dynamic_id="123"`／完整 `comment_ids=[…]`／`checkpoint=accepted`／`elapsed_ms=`，负向断言凭据、URL、`token` 与正文不出现。
- [x] 用真实临时 SQLite、上游分页 fixture 与归档 GET 验证最终集合完整、重复读有界、来源计数变化不导致每轮清空进度，更新根分页与续采契约。证据：新增 8 例全部走真实临时 SQLite＋真实 Collector／`root_scan_step`＋归档 GET；重复读有界（重定位＋守卫页合计不超过数页）；契约已更新 [archive-api.md](../../../docs/backend/api/archive-api.md#续采进度与页锚点06) 与 [collector-api.md](../../../docs/backend/api/collector-api.md#调度与失败日志)。

## 验证范围

覆盖根评论部分 RC-04；风控后自动恢复的跨链验证放在 10，不为制造独立验证而绕过 03／04 的保护规则。

## Answer

根页改为「逐页提交数据＋上游进度」，进度落在新的 `page_scan_progress`（SQLite v25），与页数据同一短事务、按归档 `generation` fencing：定位（`oid/type/source`）、方向、阶段（`pages|guard|tail|complete`）、页锚点（最后提交页页码＋该页全部已确认根 ID）、下一位置、页内计数快照与置顶观察。

续采不再「保存 `pn + 1` 后盲跳」：恢复/新领取先重读锚点页并校验锚点末 ID 与连续尾部重叠，对齐则继页、整体后移时只重读被插入影响的头部页再回到锚点之后、整体前移时按锚点末项的新页位置续读，有界窗口内找不到锚点才回首屏按 ID 合并重扫。上一轮已确认的根集合遇到仅计数增长时，读到「整页已确认＋紧邻守卫页」即收束，不再无条件重读全部已确认根页；显式初始化与根元信息格式升级仍走全量。

新增 `root_comments.root_scan_step(...)` 作为单页可恢复步骤接口（一次调用提交一页，跨调用只依赖存储里的进度行），连同 `Store.read_root_scan／resume_root_scan／save_root_page／save_root_position／known_root_count／root_reply_counts` 供 07／08 复用；楼中楼续采、100ms 页后等待、单路调度、冷却探测与性能对照不在本票范围。日志新增 `root_page_saved`（完整本页根 ID）、`root_scan_position`、`root_scan_resumed`、`root_tail_confirmed`，只放行已校验业务 ID，其余形状仍脱敏。

未验证：真实上游的漂移幅度／插入频率与真实 locator 变化路径；早停后深层根 `rcount` 的刷新由 07 的逐根增量或 24 小时校准承担（已写入契约）。迁移版本原用 v24，合入 03 后按集成顺序顺延为 v25（`storage.migrate` 先 03 的 `risk.migrate` 再本票的 `scan_progress.migrate`）。未部署、未跑真实采集。

## Comments

- 2026-10-27 领取并按 TDD 纵向切片实施（Status: claimed → 证据齐备后置 resolved）。完成前两次 rebase 到集成 tip：先 `3a72c4a`（03 风控暂停，迁移顺延 v24→v25），再 `d65b56c`（01 启动生命周期修复＋02 页等待与流程日志），合并 `storage.migrate` 分派、既有版本断言、`SourceRiskPaused` 透传与 02 的 `source_refs`／`source_ids` 日志格式；合入后全量 1144 passed。新增 `backend/tests/test_root_page_resume.py` 8 例；票范围 345 passed，全量后端 1099 passed。逐片红绿、两次红证据与三处被测试纠正的判断见 [evidence](../evidence/06-root-page-resume.md#2-红绿过程tdd纵向切片)。
- 基线遗留的 startup 脱敏回归（01 的 `GatedAsyncTransport` 未转发 `__aenter__`）由 01／02 在 `d65b56c` 修复；本票未改 `source_gate.py`，合入后票范围与全量均绿。
- 契约变化（有意，非放宽）：根页失败重试从「第 1 页整轮重扫」改为锚点续采；已确认根集合在仅计数增长时只读到守卫页。`test_comment_count_sync.py` 的两处根页请求序列断言按新契约更新；迁移版本断言按集成顺序为 25、未来版本 26。
