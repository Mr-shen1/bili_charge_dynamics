# 06 一级评论分页持久续采：实施与验证证据

状态：**本票范围内的实现与隔离验证已完成**；未访问真实 B 站、未部署、未运行生产采集。正式设计仍是策略与参数唯一来源，[Archive 根评论契约](../../../docs/backend/api/archive-api.md#续采进度与页锚点06) 已同步本票的落库与续采规则。

依据：父规格 RC-04、正式设计 §3.3（持久续采与完成语义）与 §6（结构化日志）、票据 [06](../issues/06-root-page-resume.md)。基线 `spec/bilibili-risk-control` 的 `1673dfe`；完成前已 rebase 到集成 tip `d65b56c`（含 01 启动生命周期修复、02 楼中楼页等待与流程日志、03 跨进程风控暂停），迁移顺延为 v25（03 占 v24）并合并 `storage.migrate` 分派、既有版本断言、`SourceRiskPaused` 透传与 02 的 `source_refs`／`source_ids` 日志格式。

## 1. 交付内容

根页从「每页一提交、失败即从头重扫」改为**可验证的持久续采**：

- **进度与页数据同一短事务**（`page_scan_progress`，SQLite v25）：目标动态、归档领取代次 `generation`、locator（`oid/type/source`）、方向 `forward`、阶段（`pages|guard|tail|complete`）、`next_page`、页锚点（最后提交页页码＋该页全部已确认根 ID）、待校验锚点页 `overlap_page`、页内计数快照、本轮新增根数 `confirmed`、开始时的动态来源计数、置顶观察与 `full`（是否全量扫描）。不复用归档阅读 cursor（`root_comment_pages`／`root-comments:*` 仍只服务读取端冻结快照）。
- **续采先复核锚点**：恢复/新领取时重读锚点页，校验锚点末 ID 与连续尾部重叠；对齐→读下一页；整体后移（锚点前插入）→只重读被插入影响的头部页，再回到锚点之后；整体前移（删除）→按锚点末项的新页位置续读；有界窗口（锚点页及前后至多两页）内找不到锚点→回首屏按 ID 合并重扫。锚点页这次读取照常入库，不推进整轮 checkpoint。
- **整页已确认即提前收束**：某页根 ID 全部已归档时只前进到 `guard` 阶段，再看紧邻一页；两页都已确认才 `complete`。显式初始化与根元信息格式升级（`synced_root_metadata_version` 落后）置 `full=1`，不做提前收束。
- **失败保留断点**：`finish_roots(failed)` 只改归档分项状态，进度行保留锚点与下一页；旧 checkpoint、历史根与成功时间不动。非首屏空页进入 `tail` 复读确认，复读页非空或计数变化则退回锚点重新定位（不再用同一旧基准无限反复），复查页已取得文档照常保存。
- **单页可恢复步骤接口**：`root_comments.root_scan_step(...)` 一次调用提交一页（或复核锚点、确认空尾），返回 `status/page/next_page/fetched/new/confirmed`，跨调用只依赖存储里的进度行；`storage.Store.read_root_scan/resume_root_scan/save_root_page/save_root_position/known_root_count/root_reply_counts` 是同一组持久能力，供 07／08 把「一页」当调度片。
- **日志**：复用 02 的 `source_refs(uid, dynamic_id)`／`source_ids(ids)`（已合入的 ID 白名单与超长分块），`root_page_saved` 记录页码、方向（`forward`／`tail_confirmation`）、本页完整 `comment_ids`、`fetched/new/confirmed`、阶段、`elapsed_ms`、`checkpoint=accepted`；恢复与重定位另记 `root_scan_position resume=start|resume|regenerated|incremental|locator_changed` 与 `root_scan_resumed resume=aligned|inserted|removed|anchor_lost`（锚点页、位移、下一页），空尾确认记 `root_tail_confirmed`，代次过期记 `root_page_rejected`。本票不再自造 ID 白名单（02 的 `SourceId`／`SourceIds` 已是唯一入口），其余形状仍记 `unknown`。

## 2. 红绿过程（TDD 纵向切片）

新增 `backend/tests/test_root_page_resume.py`（8 例），全部走真实临时 SQLite、真实 `Collector`／`root_scan_step` 与真实归档 GET；只替换外部 HTTP（分页 fixture 可注入页失败、头部插入、头部删除、locator 变化与页面信号失败）。

| 切片 | 用例 | 红（先失败） | 绿 |
| --- | --- | --- | --- |
| 迁移＋进度行 | `test_v25_migration_preserves_archive_progress_media_and_reading_cursor` | 无 `page_scan_progress`，`read_root_scan` 不存在 | v25 只新增一表，旧库升级后进度重建、归档／媒体／阅读 cursor 保持；再次迁移不清空已有进度 |
| 失败后续采 | `test_failed_page_resumes_from_anchor_after_reopen_without_rescanning_head` | 旧行为 `[1,2,3,4,4]`（第 3 页失败后从头重扫）；关库重开读不到断点 | `[2,3,4,4]`：新进程重核第 2 页锚点后继续；进度行 `phase=complete`、`confirmed=45`；归档 GET 45 条 |
| 头部插入重定位 | `test_head_insertion_relocates_only_affected_pages` | 旧行为 `[1,2,3,4,4]`，且新根与已读位置无法区分 | `[2,3,1,3,4,4]`：锚点页探测→命中第 3 页→只重读第 1 页（新根）→回到锚点之后；50 条根全部归档 |
| 头部删除重定位 | `test_head_deletion_relocates_without_losing_archived_roots` | 旧行为从第 1 页整轮重扫且无位移计算 | `[2,2,3,4,4]`：内容前移后重读锚点所在页再续；历史根（含被删 3 条）仍可读 |
| locator 变化隔离 | `test_locator_change_invalidates_progress_and_never_mixes_resources` | 旧行为按旧 oid 继续读，把另一资源的数据拼进同一动态 | `[1,2,3,4,4]` 从头重建；进度行 locator 变 `99124`，历史根保留 |
| 计数增长只登记 | `test_completed_scan_only_registers_growth_and_stops_at_known_page` | 旧行为整轮重读 45 页 | `[1,2,3]`：首页含新根→第 2 页整页已确认→守卫页 3→收束；`confirmed=1` |
| 单页步骤接口 | `test_single_page_steps_are_restartable_from_the_store` | 无步骤接口；分页循环只能整轮存活 | 每步只提交一页，步骤间从新 `Store` 读回位置；序列 `page 1/2/3/4 → complete` |
| 旧代次隔离 | `test_stale_execution_cannot_write_progress_after_newer_claim` | 无 generation-fenced 进度写 | 旧代次返回 `stale`、不发一次上游请求、不改写新进度行 |

红证据两次取得，都是先失败后通过：

1. 移除生产改动后 `pytest backend/tests/test_root_page_resume.py`：`ImportError: cannot import name 'root_scan_step'`（接口尚不存在）。
2. 保留全部生产代码，只把 `Store.resume_root_scan` 改回「每次都从第 1 页起步」（等价于 06 之前的行为）后重跑同一文件：

```text
E  assert [1, 2, 3, 4, 4] == [2, 3, 4, 4]      # 失败后续采
E  assert [1, 2, 3, 4, 4] == [2, 3, 1, 3, 4, 4]  # 头部插入重定位
E  assert [1, 2, 3, 4, 4] == [2, 2, 3, 4, 4]      # 头部删除重定位
3 failed, 5 passed
```

实施过程中被测试纠正的三处判断（保留说明，避免后人重踩）：

- 续采的下一位置不能只按「锚点末项所在页」推：短页末项等于整页读完，必须进到下一页，否则会重读同页并被「分页未前进」判失败。
- 早停不是「读到整页已确认就停」：要保留一次 `guard` 页复核，否则无法解释偏移是否把新根甩到了后面。
- 空尾复查失败不能保留旧基准原地重试：否则瞬时空尾会让同一目标每轮都以同一原因失败（livelock）；改为退回锚点重新定位。

同时修正了两处因契约变化而确实过期的既有断言（都在本票语义内，不是放宽）：`test_comment_count_sync.py` 的根页请求序列（失败轮续采、已确认集合只读到守卫页），以及迁移版本断言（合并 03 后当前版本 25、未来版本 26）。

## 3. 给 07／08 的根进度 Interface

```python
# 一次尝试的第一步（开启锚点复核）；同一尝试后续页用 resume=False
step = await root_scan_step(store, client, dynamic_id, generation, *, uid=None, resume=False, full=False)
# RootStep(status="page"|"complete"|"stale", page, next_page, fetched, new, confirmed, reason, root_ids, reply_counts)
#   root_ids 是已校验的字符串 ID 元组，日志用 source_ids() 渲染；reply_counts 是本页的来源 rcount

store.read_root_scan(dynamic_id, generation=None)          # 只读位置（不含 query、不访问上游）
store.resume_root_scan(dynamic_id, generation, locator, observed_count, full=False)
store.save_root_page(dynamic_id, generation, documents, observed_count, position)
store.save_root_position(dynamic_id, generation, position)
store.known_root_count(dynamic_id, ids)                    # 整页已确认判定，单次查询
store.root_reply_counts(dynamic_id)                        # 整轮根集合的 rcount 基准
```

- 步骤语义：一次调用最多提交一页数据（可能先做一次锚点复核与受影响头部页重读）。`status='stale'` 表示领取代次已过期，调用方必须停止该链、不要再请求上游。
- 表结构按 `(dynamic_id, stage, scope_id)` 建主键，`stage='roots'`、`scope_id=''` 是本票用法；07 的楼中楼步骤可用 `stage='replies'`＋`scope_id=root_id` 沿用同一套「定位＋代次＋方向＋阶段＋锚点＋下一页＋计数」规则，不需要另立一套字段。
- 本票**没有**实现楼中楼持久续采、全局公平调度、单路重型归档、100ms 页后等待或冷却探测；这些分别属于 07、08、02、03／04。

## 4. 严格保留的既有规则

- 作者／资源校验（locator 回显、fallback 必须带匹配 oid/type）、置顶与热门去重、首屏非空校验、显式空尾确认、可信未知（不补零）、失败不删历史根、`page.count/acount` 只用于页内校验且只拒绝减少：均未改动；新增的只是「从哪里继续读」。
- 归档 `generation`、检查领取令牌／revision、入选集合令牌的旧执行隔离未改；进度行同样按 `generation` fencing，旧执行不写任何行。
- 只有整轮成功才推进 `synced_root_comment_count`、置顶标记、`root_comments_last_succeeded_at` 与 `work.comments`；失败保留旧 checkpoint（用例断言 `synced_root_comment_count is None`、旧成功时间不变）。
- 02 的页节奏不动：根页仍只有发送前 0.3–0.4 秒等待（本票只测读取耗时，不新增页后等待，也不碰 `reply_pacing`）；03 的 `SourceRiskPaused` 在步骤机里原样透传——暂停不记 `root_sync_failed`、不写 failed checkpoint，进度行留给恢复后续采（03 的 `test_manual_sync_mid_chain_pauses_without_fake_statistics` 仍通过）。
- 网络、等待与解析都在 SQLite 事务外；每页一次 `BEGIN IMMEDIATE` 短事务。既有并发用例 `test_slow_old_scan_does_not_hold_database_or_overwrite_new_root_completion` 仍通过，证明慢页请求期间数据库可读、旧代次不能覆盖新完成。
- 迁移原子、未来版本拒绝、归档／媒体／有效阅读 cursor／未完成工作保留的既有迁移用例全部通过（合并 03 后版本断言为 25，未来版本 26）。

## 5. 验证账本

命令均在仓库根执行（`uv run --no-sync`，隔离环境，无网络访问）：

| 范围 | 结果 |
| --- | --- |
| 本票新增 | `pytest backend/tests/test_root_page_resume.py -q` → **8 passed** |
| 票范围回归（合入 02／03 后） | `pytest backend/tests/test_root_page_resume.py test_root_comments.py test_comment_count_sync.py test_comment_sync_status.py test_comment_count_recovery.py test_replies.py test_inflight_recovery.py test_inflight_lifecycle.py test_migrations.py test_notification_migration.py test_risk_pause.py test_risk_state.py test_risk_collector.py test_full_archive.py test_initial_archive.py test_integrated_archive_lifecycle.py -q` → **377 passed**（全绿） |
| 全量后端（合入 02／03 后） | `pytest backend/tests -q` → **1144 passed**（全绿；含本票 8 例） |

基线遗留的 `test_migrations.py::test_unexpected_transport_startup_failure_is_sanitized`（01 的 `GatedAsyncTransport` 未转发 `__aenter__`）已由 01／02 在集成 tip `d65b56c` 修复；本票 rebase 后全量 1144 passed、0 failed，票范围内不再有已知红点。

样本范围与未验证项：

- 全部数据为虚构 fixture（根页 JSON、detail、计数），只替换外部 HTTP；没有真实 B 站请求，因此**真实上游的分页漂移幅度、头部插入频率、删除比例、真实 locator 变化路径未经观测**。
- 早停只收束根页读取：未重读的深层根沿用上次归档的 `rcount`，其新回复要等 07 的逐根增量或 24 小时校准或一次显式初始化才会展开。这是「不无条件重读全部已确认根页」的直接代价，已写进 Archive 契约；本票不改回复规则。
- 100ms 页后等待、全局冷却、探测、单路调度、系统告警、性能对照（RC-03、RC-06—RC-12）均未在本票实现或验证。
- 本票原用 v24 实现，合入 03 后按集成顺序顺延为 **v25**：`storage.migrate` 现在先跑 03 的 `risk.migrate`（v24）再跑本票的 `scan_progress.migrate`（v25），版本上限与未来版本拒绝同步到 25／26；两个迁移都是 `CREATE TABLE IF NOT EXISTS`，可重入。
- 未部署、未重启任何进程、未跑真实采集。

## 6. 涉及文件

- 新增：`backend/bili_monitor/scan_progress.py`（进度结构与锚点/位移纯函数）、`backend/tests/test_root_page_resume.py`
- 修改：`backend/bili_monitor/root_comments.py`（`root_scan_step`／`sync_roots` 状态机）、`backend/bili_monitor/storage.py`（v25 迁移与进度读写、事务内合并，与 03 的 v24 分派并列）、`backend/bili_monitor/sync.py`（`full` 全量／增量选择）、`backend/README.md`、`docs/backend/api/archive-api.md`、`docs/backend/api/collector-api.md`、`docs/README.md`
