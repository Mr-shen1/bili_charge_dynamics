# 07 楼中楼续采与热帖持续追赶：实施与验证证据

状态：**本票范围内的实现与隔离验证已完成**；未访问真实 B 站、未部署、未运行生产采集。正式设计仍是策略与参数唯一来源，[Archive 契约](../../../docs/backend/api/archive-api.md#楼中楼续采进度与页锚点07) 与[采集契约](../../../docs/backend/api/collector-api.md#调度与失败日志)已同步本票的落库、续采与日志规则。

依据：父规格 RC-04（保持 RC-03，补充 RC-10 的楼中楼页级日志）、正式设计 §3.2／§3.3／§6、票据 [07](../issues/07-reply-resume-and-hot-targets.md)。基线 `spec/bilibili-risk-control` 的 `c9f3b45`（06 已合入）。

04 的集成经过两次记录，前一次归因有误，这里更正：04 的三次提交（`9d6a26f` feat／`a550b20` refactor／`f7f5755` docs）当时**不是**以 merge 引入，而是以 patch 重放成本分支的 `a8266dd`／`e682efd`／`d9a11b6`（三组 `git patch-id` 与 spec 侧逐一同源），因此 `spec/bilibili-risk-control` 的 tip 从未成为本分支祖先，`git merge --ff-only` 必然失败。交付后补做真正的合并 `05010a3`（第二父 `f7f5755`），`git merge-base --is-ancestor spec/bilibili-risk-control HEAD` 现在成立。该合并只改拓扑：其结果树与合并前的 `f2708c1` 完全相同（`87af72c`），本票业务提交 `e0b4f7f` 与 04 全部内容均未重写。schema 仍是 v25，未动 `risk.py`／`risk_probe.py`，探测保持“只验证、不提交归档、不发通知”。

## 1. 交付内容

楼中楼从「每页一提交、失败即整楼从头正扫」改为**可验证的持久续采**，与 06 共用同一套规则：

- **进度与页数据同一短事务**：复用 `page_scan_progress`（`stage='replies'`、`scope_id=<根 ID>`，SQLite 仍 v25，不新增迁移）。记录目标、`generation`、locator、方向（`forward` 正序全量 / `reverse` 末页倒序增量）、阶段（`pages|guard|tail|complete`）、下一页、页锚点（最后提交页页码＋该页全部已确认回复 ID）、页内计数快照 `counts`（来源 `page.count`＋本尝试已重定位次数）与整轮新增数 `confirmed`。整楼 `reply_sync` 成功记录与最后一页**同一事务**（`save_reply_page(..., complete=True)`），不存在“页已存但楼仍 pending”。
- **方向选择**：有已归档回复即走末页倒序增量，起点由本轮根页 `rcount` 推出（`scan_progress.last_page`）；显式初始化、尚无本地回复或 locator 变化才正序全量。倒序首次取回的 `page.count` 推出的末页与起点不同时先跳到真实末页（`resume=retargeted`），不让沿用的旧 rcount 把新回复留在身后。
- **续采先复核锚点**：恢复/新领取先复读锚点页并校验锚点末 ID 与连续尾部重叠。对齐→按方向继续（正序到 `following_page`，倒序到上一页）；正序整体后移（锚点前插入）→只重读受影响头部页再回到锚点之后；倒序末页比锚点多→先跳到新末页；窗口（锚点页及前后至多两页）内找不到锚点→回到本方向起点按 ID 合并重扫。锚点页这次读取照常入库，不推进整轮 checkpoint。
- **失败楼不再整楼重扫**：失败楼沿用已提交页与同方向断点（`regenerated` 只换写代次，保留锚点与方向）。空尾复查未完成时复读同一页；复查仍非空或计数变化则退回锚点重新定位（正序退回锚点页、倒序跳到新末页），不用同一旧基准原地循环。
- **热帖持续新增**：一次尝试内允许一次末页重定位，第二次再漂移则本轮记失败（`stopped_by=drift`），已提交页与断点保留，下一轮从新末页继续。页内计数只拒绝减少；单页条目数多于该页 `count` 才拒绝（原“唯一回复数多于 count”是跨页累计判定，随逐页续采改为按页，语义不变且更早失败）。
- **旧零不再永久跳过**：本轮新观察到的零回复仍不发请求、直接确认；沿用旧零（06 根页早停留下的深层根 `rcount`）在校准到期后必须真的请求一次。仍只用既有 24 小时周期，不新增检测信号、不改校准参数。
- **`reply_scan_step` 单页可恢复步骤接口**：一次调用最多提交一页（可能先复核锚点或被插入影响的头部页），返回 `status=page|complete|skipped|failed|stale`、`direction`、`page`、`next_page`、`fetched/new/confirmed`、`reason`、该页已校验 `reply_ids`、`expanded` 与 `source_count`。跨调用只依赖 `page_scan_progress`，08 可把“一页”当调度片；`status='stale'` 表示领取代次过期，调用方必须停止该链、不再请求上游。
- **风控透传**：`SourceRiskPaused` 在步骤机里原样抛出——不写楼级失败、不清断点或已提交页，冻结的进度留给恢复后续采（03／04 的行为不放宽）。
- **日志**：新增 `reply_scan_position`（`resume=start|resume|regenerated|incremental|locator_changed|direction_changed`）、`reply_scan_resumed`（`resume=aligned|inserted|removed|anchor_lost|retargeted`＋`anchor_page`／`page`／`shift`）、`reply_tail_confirmed`、`reply_page_rejected`；页级 `reply_page_saved` 补齐 `page`／`direction`／`fetched`／`new`／`updated`／完整本页 `reply_ids`／`phase`／`checkpoint=accepted`／`elapsed_ms`／`wait_ms`。100ms 页后等待仍由 02 的统一协调器在 `client.get` 内完成，本票不新增等待点。

## 2. 红绿过程（TDD 纵向切片）

新增 `backend/tests/test_reply_page_resume.py`（9 例），全部走真实临时 SQLite、真实归档装配／`reply_scan_step`／`Collector` 与真实归档 GET；只替换外部 HTTP 与墙钟。

红证据三次取得，都是先失败后通过：

1. 生产代码尚未提供步骤接口时 `pytest backend/tests/test_reply_page_resume.py`：

```text
ImportError: cannot import name 'reply_scan_step' from 'backend.bili_monitor.replies'
ERROR backend/tests/test_reply_page_resume.py   (1 error during collection)
```

2. 保留全部生产代码，只把 `Store._reply_scan_resume` 改回「每次都从头起步」（等价于 07 之前的行为）后重跑同一文件：

```text
E  assert [1, 2, 3, 4, 4] == [2, 3, 4, 4]        # 前向失败续采
2 failed, 7 passed
```

3. 保留全部生产代码，只把 `observed == 0` 的判定改回「只要旧零就跳过」（去掉校准条件）：

```text
E  assert [] == [1, 2, 2]                          # 旧零校准补采
1 failed, 8 passed
```

实施过程中被测试纠正的五处判断（保留说明，避免后人重踩）：

- `observed=None`（来源未给 rcount）不能被“调用方没给”回落到存储旧值：两者混用会让未知被陈旧零冒充，`test_unknown_new_root_reply_count_does_not_reuse_old_zero_to_skip_required_pages` 因此变红，改为 `UNOBSERVED` 哨兵区分。
- 后续步骤不能重新读根文档的 `source_reply_count`：页提交会把新 `page.count` 写回根文档，后续页会拿“刚写回的值”覆盖本轮观察基准；改为沿用 `position.source_count`。
- 页内计数基准不能跨尝试沿用：失败页可能写过偏大基准，重试会永远判“计数减少”。恢复时以锚点页的新观察值作基线；本次走位还没有提交页时连重定位计数一并重置。
- 一次尝试内最多一次末页重定位：起点校准与漂移重定位必须有界，否则热帖持续新增会让同一尝试无限跳末页；第二次漂移按 `stopped_by=drift` 结束本轮并保留断点。
- 倒序从头两次请求会重复读第 1 页：末页起点改用本轮根页 `rcount` 推出，只在实际 `page.count` 与之不符时重定位一次。

同时更新了因契约变化而确实过期的既有断言（都在本票语义内，不是放宽）：`test_reply_incremental` 的末页倒序页序列与两次漂移用例（改为真实来源增长驱动），`test_reply_page_pacing` 的末页增量等待改为真实归档链驱动，`test_comment_count_sync` 的「失败楼恢复」页序列，`test_flow_logs` 的页提交结果字段名。

## 3. 验证账本

命令均在仓库根执行（`uv run --no-sync`，隔离环境，无网络访问）。拓扑合并 `05010a3` 的结果树与 `f2708c1` 逐字节相同，因此合并前跑出的全量数字对合并后依然成立；表内最后一行是合并后新跑的范围命令。

| 范围 | 结果 |
| --- | --- |
| 本票新增 | `pytest backend/tests/test_reply_page_resume.py -q` → **9 passed** |
| 票范围回归（完成前，04 以 patch 重放并入的 `d9a11b6`） | `test_reply_page_resume test_replies test_reply_incremental test_reply_page_pacing test_root_page_resume test_root_comments test_comment_count_sync test_comment_sync_status test_comment_count_recovery test_inflight_recovery test_inflight_lifecycle test_migrations test_notification_migration test_full_archive test_initial_archive test_integrated_archive_lifecycle test_flow_logs test_risk_pause test_risk_state test_risk_collector test_risk_cooldown test_risk_probe` → **417 passed** |
| 全量后端（04 以 patch 重放之前） | `pytest backend/tests -q` → **1153 passed**（基线 1144＋本票 9 例） |
| 全量后端（04 以 patch 重放之后） | `pytest backend/tests -q` → **1175 passed**（含 04 的 22 例与本票 9 例） |
| 拓扑合并后的最新命令（`05010a3`，第二父 `f7f5755`） | `pytest backend/tests/test_reply_page_resume.py backend/tests/test_reply_incremental.py backend/tests/test_replies.py backend/tests/test_reply_page_pacing.py backend/tests/test_flow_logs.py backend/tests/test_risk_probe.py -q` → **64 passed** |

请求账本与最终 GET（全部来自上述用例的断言，来源替身按 `(root, page)` 记账）：

| 场景 | 用例 | 请求账本 | 最终归档 GET |
| --- | --- | --- | --- |
| 正序失败后重开续采 | `test_failed_full_scan_resumes_from_anchor_after_reopen_without_rescanning_head` | 首轮 `[1,2,3]`（第 3 页失败）→ 重开 `[2,3,4,4]` | 45 条，`replies_last_attempt=success`，进度 `complete`、`confirmed=45` |
| 倒序增量失败后续采 | `test_incremental_tail_resumes_from_committed_pages_after_reopen` | 首轮 `[1,2,3,3]`；增量 `[3,2]`（第 2 页失败）→ 重开 `[3,2,1]` | 50 条，进度 `complete` |
| 页移动 | `test_page_movement_relocates_only_affected_pages_and_keeps_archived_replies` | 删除 5＋新增 10 后 `[3,…]`（≤3 请求） | 历史 45 条 ∪ 新来源全部 |
| locator 变化 | `test_locator_change_rebuilds_progress_without_mixing_resources` | 换资源后 `[1,…]` 正序重建 | 旧资源回复保留，新资源进度 `locator.oid=99124` |
| 单页步骤（08 seam） | `test_single_page_steps_are_restartable_from_the_store` | 每步一页：`page 3 → page 2 → complete`，再调用不发请求 | 50 条；`reply_sync.status=success` |
| 旧代次 fencing | `test_stale_execution_cannot_request_or_overwrite_newer_reply_progress` | 旧代次 0 请求 | 进度行逐字段不变 |
| 风控透传 | `test_risk_pause_mid_chain_keeps_progress_without_fake_failure` | 第 2 个分页请求抛 `SourceRiskPaused` | 已提交 45 条保留，断点 `reverse/pages/anchor=3/next=2`，成功时间不动 |
| 热帖多轮收敛 | `test_hot_root_converges_across_rounds_without_unconditional_full_rescans` | `[[3,2,1],[3,2,1],[5,4,3,2]]`，再删 10／加 5 后 ≤4 请求 | 归档数 `[50,60,90]`，最终 `= 来源 ∪ 已删`，进度 `complete` |
| 旧零校准补采 | `test_stale_zero_deep_root_is_rechecked_by_calibration_instead_of_skipped_forever` | 明确零 `[]`；+1h 旧零 `[]`；+25h 校准到期 `[1,2,2]` | 5 条全部取得 |
| 100ms 页后等待（保持 RC-03） | `test_incremental_tail_pages_share_the_same_wait_and_log_reverse_direction` | `send 2 → done 2 → wait 100ms → send 1 → done 1 → wait 100ms`（`clock.waits == [(0.4,0.1),(0.5,0.1)]`） | `reply_page_fetched direction=reverse`×2 |

样本范围与未验证项：

- 全部数据为虚构 fixture（根页 JSON、楼中楼 JSON、计数），只替换外部 HTTP 与墙钟；**没有真实 B 站请求**，因此真实上游的楼中楼页漂移幅度、热帖新增速率与真实 locator 变化路径未经观测。
- 06 早停的代价仍在：未被重读的深层根沿用旧 `rcount`，其新回复要么等 24 小时校准、要么等下一轮根页真正读到该楼（本票只保证“旧零不会永久跳过”）。本票不引入新的检测信号，也不改每日校准参数。
- 单路重型调度、跨进程分页排他、观察期／人工探测、系统告警、完整组合与性能对照（RC-01／02／06—12）不在本票范围，分别由 05、08、09、10 承担。
- 未部署、未重启任何进程、未跑真实采集。

## 4. 涉及文件

- 修改：`backend/bili_monitor/replies.py`（`reply_scan_step`／`sync_replies` 状态机、方向与重定位、日志）、`backend/bili_monitor/storage.py`（`read_reply_scan`／`resume_reply_scan`／`save_reply_page`／`save_reply_position`、`_change_replies` 同事务写进度与整楼成功）、`backend/bili_monitor/scan_progress.py`（`REPLIES`／`REVERSE`／`last_page`／方向参数）
- 新增：`backend/tests/test_reply_page_resume.py`
- 测试按新契约更新：`backend/tests/test_reply_incremental.py`、`test_reply_page_pacing.py`、`test_comment_count_sync.py`、`test_flow_logs.py`
- 文档：`docs/backend/api/archive-api.md`（楼中楼续采进度与页锚点（07））、`docs/backend/api/collector-api.md`（页级日志字段）、`docs/design/bilibili-risk-control.md`（状态行）、`backend/README.md`、`docs/README.md`

## 5. 给 08 的楼中楼步骤 Interface

```python
# 一次尝试的第一步（开启锚点复核）；同一尝试后续页 resume=False（默认）
step = await reply_scan_step(store, client, dynamic_id, generation, root_id,
                             uid=None, resume=True, full=False, observed=<本轮根页 rcount>,
                             now=None, on_failure=None, seen=None)
# ReplyStep(status="page"|"complete"|"skipped"|"failed"|"stale", root_id, direction,
#           page, next_page, fetched, new, confirmed, reason, reply_ids, expanded, source_count)

store.read_reply_scan(dynamic_id, root_id, generation=None)         # 只读位置，不访问上游
store.resume_reply_scan(dynamic_id, generation, root_id, locator, count, *, direction, full=False)
store.save_reply_page(id, generation, root_id, documents, count, position=None, *,
                      complete=False, observed=None, succeeded_at=None)
store.save_reply_position(id, generation, root_id, position)
```

- 一步 = 最多一页（可能先做一次锚点复核与被插入影响的头部页重读）；`expanded=True` 表示真的请求过上游，调用方据此决定楼级 0.3–0.4 秒等待（`sleep_after_root` 语义不变）。
- `status='stale'`：领取代次过期，停止该链且不发请求；`status='complete'`：该根成功记录已提交，轮级 summary（`replies_last_attempt`）仍由整轮驱动写。
- `observed` 是可选的；不传时用该根文档的 `source_reply_count`，后续步骤沿用 `position.source_count`，调用方不必自己缓存。
- 未实现（属 08）：跨目标的单路轮转、目标级互斥与 API 手动入口的同一许可。
