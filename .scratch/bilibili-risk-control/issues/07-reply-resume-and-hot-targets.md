# 07：楼中楼续采与热帖持续追赶

Status: resolved

**What to build:** 楼中楼正序全量与末页倒序增量都能复用持久分片进度；单页失败、重启或热帖持续新增时继续推进，不反复整楼重抓，也不把旧观察的完成误当最新全量完成。

**Blocked by:** 02 — 楼中楼分页等待与基础流程日志；06 — 一级评论分页持久续采。

## 验收标准

- [x] 沿用根分页建立的分片／定位／代次规则，逐楼、逐页原子保存回复数据与进度；保留既有楼级成功记录和未变化楼的跳过优化。证据：复用 `page_scan_progress`（`stage='replies'`、`scope_id=<根 ID>`，v25 无新迁移），页数据、页锚点、方向、阶段、下一页与整楼 `reply_sync` 成功记录同一 `_change_replies` 短事务（`save_reply_page(..., complete=True)`）；`scan_due` 跳过语义与 `replies_sync_finished skipped=` 未改。见 [evidence §1](../evidence/07-reply-resume-and-hot-targets.md#1-交付内容)
- [x] 正序首次采集、失败重试、末页倒序增量、命中已知页后的必要重叠、空尾确认均能恢复，并保留每次真实请求后的 100ms 等待。证据：`test_failed_full_scan_resumes_from_anchor_after_reopen_without_rescanning_head`（`[1,2,3]`→`[2,3,4,4]`）、`test_incremental_tail_resumes_from_committed_pages_after_reopen`（`[3,2]`→`[3,2,1]`）、`test_page_movement_relocates_only_affected_pages_and_keeps_archived_replies`（`[3,…]` 命中已知页再重叠一页）、`test_incremental_tail_pages_share_the_same_wait_and_log_reverse_direction`（每页 `wait 100ms`，账本见 [evidence §3](../evidence/07-reply-resume-and-hot-targets.md#3-验证账本)）
- [x] 请求中断、关闭重开、新进程接续后复用已验证回复页，不默认将失败楼从头全扫；必要复查请求有明确原因且不能静默漏页。证据：失败楼沿用同方向断点（`resume=regenerated`），复查原因分别记 `reply_scan_resumed resume=aligned|inserted|removed|anchor_lost|retargeted` 与 `reply_page_saved resume=tail_confirmation`；正常测试断言的请求账本里失败轮之后不再出现第 1 页整轮重扫
- [x] 根元信息／回复数变化时保留可验证进度并登记后续工作；locator 或分页锚点失效时仅重定位必要区段，不能沿用错误资源或通过放宽版本判断假完成。证据：`test_locator_change_rebuilds_progress_without_mixing_resources`（换资源后从首屏正序重建、旧回复保留）；计数增长只记 `reply_scan_count_grew` 并跳到新末页一次，`test_first_count_drift_retargets_tail_without_losing_confirmed_pages`、`test_second_drift_aborts_checkpoint_and_next_round_can_retry`；版本判定仍按 `generation` fencing（见下条）
- [x] 根页集合、必要楼中楼及最新观察分别表达完成，失败或较新待处理工作仍为 pending／部分完成；不因本地数小于来源数就无限追赶或删除旧回复。证据：`work.replies`／`replies_last_attempt`／`synced_reply_comment_count` 语义未改（失败或降级仍 pending／unconfirmed），差额只记 `local_source_delta` 与既有口径日志，不删历史回复（`test_page_movement_…` 断言被删回复仍可读）
- [x] 保留根 rcount 与楼中楼来源数的既有口径容忍、不可见回复处理、独立根／回复成功时间及已有增量语义，不引入新校准策略。证据：`scan_due`／`FULL_SCAN_SECONDS` 未改；`reply_scan_short` 口径由 `local_source_delta` 承载；`replies_last_succeeded_at` 仍独立；旧零补采只用既有 24 小时校准（`test_stale_zero_deep_root_is_rechecked_by_calibration_instead_of_skipped_forever`），无新增检测信号
- [x] 旧领取、旧 generation、停止后重纳入及迟到响应不能覆盖新状态或吞掉新工作；媒体与业务通知仍走原真实提交及资格校验，不由恢复断点伪造成功。证据：`test_stale_execution_cannot_request_or_overwrite_newer_reply_progress`（旧代次 0 请求、进度行逐字段不变）；`save_reply_page` 仍走 `outbox.record_reply`／`_merge_comment`，未新增提交路径；`SourceRiskPaused` 透传不写失败（`test_risk_pause_mid_chain_keeps_progress_without_fake_failure`）
- [x] 页级日志包含动态／根 ID、全部已校验回复 ID、方向、等待、重叠／漂移／续采原因及提交结果，不逐条刷 INFO 或泄漏敏感数据。证据：`reply_page_saved` 带 `page`／`direction`／`fetched`／`new`／`updated`／`reply_ids`／`phase`／`checkpoint=accepted`／`elapsed_ms`／`wait_ms`，另有 `reply_scan_position`／`reply_scan_resumed`／`reply_tail_confirmed`／`reply_page_rejected`；用例正向断言 `dynamic_id="123"`／`root_id="…"`／完整 `reply_ids=[…]`，负向断言 `FICTIONAL_SECRET`／`https://`／`token`／正文不出现
- [x] 固定热帖样本在多轮新增和页移动下最终取得全部可获取回复；以真实临时数据库重开、请求账本、状态与归档 GET 证明持续推进、重复读有界、无无条件全目标重扫，更新楼中楼续采契约。证据：`test_hot_root_converges_across_rounds_without_unconditional_full_rescans`（多轮新增 `[[3,2,1],[3,2,1],[5,4,3,2]]`、删 10／增 5 后 ≤4 请求，最终归档 `= 来源 ∪ 已删`）；契约已更新 [archive-api.md](../../../docs/backend/api/archive-api.md#楼中楼续采进度与页锚点07) 与 [collector-api.md](../../../docs/backend/api/collector-api.md#调度与失败日志)

## 验证范围

完成楼中楼与热帖部分 RC-04，保持 RC-03，并补充相关 RC-10；多目标公平性及跨进程完整组合由 08／10 验证。

## Answer

楼中楼与 06 共用 `page_scan_progress`：`stage='replies'`、`scope_id=<根 ID>`，逐页回复与页进度（方向、阶段、下一页、页锚点、页内计数快照、本轮新增数）同一短事务，整楼 `reply_sync` 成功记录与最后一页同一事务。方向由本轮根页 `rcount` 决定：有已归档回复即走末页倒序增量（起点由 `rcount` 推出，实际 `page.count` 不同时先重定位一次），首次、显式 initial、无本地回复与 locator 变化才正序全量。

续采先复读锚点页并校验尾部连续重叠：正序对齐后继续下一页、整体后移只重读被插入的头部页、整体前移按新页位置续读；倒序对齐后继续上一页、末页后移则先跳到新末页；窗口内找不到锚点回到本方向起点按 ID 合并重扫。失败楼沿用已提交页与同方向断点，不再退回整楼正扫；空尾复查未完成时复读同一页，复查仍不稳定则退回锚点重新定位。热帖持续新增只登记后续工作，一次尝试最多一次末页重定位，第二次漂移记 `stopped_by=drift` 并保留断点，下一轮从新末页继续。旧零不再永久跳过：本轮明确零不请求，沿用 06 早停留下的旧零在校准到期后必须请求一次，仍只用既有 24 小时周期。

`reply_scan_step` 作为单页可恢复步骤接口（`status=page|complete|skipped|failed|stale`＋`direction/page/next_page/fetched/new/confirmed/reason/reply_ids/expanded/source_count`）连同 `Store.read_reply_scan／resume_reply_scan／save_reply_page／save_reply_position` 供 08 把「一页」当调度片；`stale` 表示领取代次过期，调用方停止该链且不再请求上游。100ms 页后等待仍由 02 的统一协调器在 `client.get` 内执行，本票不新增等待点。

未验证：真实上游的楼中楼页漂移幅度、热帖新增速率与真实 locator 变化路径；未部署、未跑真实采集。单路调度、跨进程排他、观察期、告警与性能对照由 05／08／09／10 承担。

## Comments

- 2026-10-27 领取并按 TDD 纵向切片实施（Status: claimed → 证据齐备后置 resolved）。基线 `spec/bilibili-risk-control@c9f3b45`（06 已合入）；04（六档探测）先以 patch 重放成 `a8266dd`／`e682efd`／`d9a11b6` 并入，当时无冲突、schema 仍 v25，未改 `risk.py`／`risk_probe.py`，探测保持只验证不提交。当时票范围 417 passed、全量后端 1175 passed（基线 1144＋04 的 22 例＋本票 9 例）。红证据三次（缺接口、去掉锚点续采、去掉校准补采）与五处被测试纠正的判断见 [evidence](../evidence/07-reply-resume-and-hot-targets.md#2-红绿过程tdd纵向切片)。
- 2026-10-27 更正集成归因并补真正的合并：上条说的「合并集成 tip」实际是 patch 重放，`spec/bilibili-risk-control` 的 tip `f7f5755` 从来不是本分支祖先，`git merge --ff-only` 因此必然失败。已用 `git merge spec/bilibili-risk-control`（非 rebase、不改历史）补出 `05010a3`，第二父即 `f7f5755`，`git merge-base --is-ancestor spec/bilibili-risk-control HEAD` 成立；本票业务提交 `e0b4f7f` 与 04 全部内容保留。合并冲突只在三处「已实施范围」状态行（`docs/README.md`、`docs/backend/api/collector-api.md`、`docs/design/bilibili-risk-control.md`），一律取本分支侧，因为本分支文本已推进到「04、02、06、07 已实施，05／08／09／10 待实施」，spec 侧仍停在「只有 04 已实施」，取新侧才能同时保住 04 与 07 的证据入口。合并结果树与 `f2708c1` 逐字节相同（`87af72c`），即纯拓扑改动。合并后重跑 `test_reply_page_resume test_reply_incremental test_replies test_reply_page_pacing test_flow_logs test_risk_probe` → 64 passed。
- 契约变化（有意，非放宽）：① 失败楼从“整楼正序全扫”改为同方向断点续采；② 末页倒序起点改用本轮 `rcount` 推出的末页，不再先探第 1 页；③ 页内计数由“跨页累计”改为“单页条目不多于该页 count”；④ 页提交结果日志统一为 `checkpoint=accepted`（去掉另设的 `accepted=true`）。四处都在本票语义内，`test_reply_incremental`／`test_reply_page_pacing`／`test_comment_count_sync`／`test_flow_logs` 的相关断言按新契约更新。
