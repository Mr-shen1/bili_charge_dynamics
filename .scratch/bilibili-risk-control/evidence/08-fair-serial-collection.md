# 08 单路重型与分页公平轮转：实施与验证证据

状态：**本票范围内的实现与隔离验证已完成**；未访问真实 B 站、OSS、飞书，未部署、未重启生产进程。正式设计仍是策略与参数唯一来源；性能公式已由用户改为非硬性参考目标，本票不以反复调优换取数字，只保留一次有界的 8 目标回放与请求账本。

依据：父规格 RC-01／RC-02（复验 RC-03／RC-04／RC-09／RC-10）、正式设计 §3.1／§3.2／§3.3、票据 [08](../issues/08-fair-serial-collection.md)。基线为 `spec/bilibili-risk-control@851ea71`；实施期间按真实祖先合并 `5d09582`（05）、`4be7824`（用户性能公式非硬性更新）与 `ec424e8`（09），`git merge-base --is-ancestor spec/bilibili-risk-control HEAD` 成立。SQLite 在 05 的 v26 之后顺延为 **v27**（只新增 `dispatch_leases`），未来版本拒绝同步到 28。

## 1. 交付内容

- **跨进程发送许可**：新增 `dispatch_leases`（v27），`source` 租约覆盖 HTTPX 的正文／detail／feed／资料／作者校验／图片下载与 Requests 的计数／根页／楼中楼／预热。`GatedAsyncTransport` 在 `permit→发送→report` 外包住租约；`RequestsCommentClient.get` 在发送与楼中楼页后 100ms 等待外再包住同一租约。另一进程或另一任务不能在等待内提前发送。
- **全局单路重型**：`heavy` 租约一次只允许一个可提交步骤。正文、根页、楼中楼页、单张图片下载／上传均为一个步骤；步骤提交后释放，collector 的 `execute_pending` 在所有可运行目标间轮转，某一目标有万条回复也不会把整条动态或整栋楼锁到结束。
- **目标互斥**：`target:<uid>:<dynamic_id>` 租约由 collector 会话持有并在每步续期；API 手动初始化用 `api` 类型挡 collector，并发 API 仍由归档 `generation` fencing 决定旧执行成败。collector 已持有目标时 API 直接跳过，返回原 `processed/succeeded/failed` 口径而不是“已排队即成功”。
- **步骤机**：`TargetSession` 按 body→roots→replies→media 推进，复用 `root_scan_step`／`reply_scan_step` 的持久断点、锚点复核、方向与代次；每个 `advance()` 最多提交一页或一张图。`media_step` 把单图下载与 OSS 上传拆成可调度步骤，OSS 不取来源许可。
- **暂停与恢复**：`SourceRiskPaused` 在步骤机内原样上抛；`execute_pending` 停止本轮派发并保留 `running` 领取与已提交分片，不写假失败。租约到期后其他进程只能先接管再发送；旧 owner 的释放按 owner 令牌匹配，不能删除新 owner 的租约。
- **既有节拍**：固定节拍、忙时跳过、同目标不叠加、错过槽不补发保持；轻量检查仍由主循环按节拍派发，在与重型步骤竞争时由 `source` 许可串行，不会形成请求洪峰。
- **日志**：新增 `dispatch_stage`（阶段推进）、`dispatch_turn`（目标／阶段／页／是否完成／让出重型）、`sync_skipped reason=target_busy|target_lease_lost|selection_changed`、`source_risk_paused_work_aborted`；不输出 owner 或租约令牌。
- **迁移**：`storage.migrate` 先跑 v26 的 `risk.migrate_observation`，再跑 v27 的 `dispatch.migrate`；两个迁移均可重入，未来版本 28 拒绝启动，归档／媒体／阅读 cursor／未完成工作／保护状态保留。

## 2. 红绿过程（TDD 纵向切片）

新增 `backend/tests/test_fair_serial_collection.py`（3 例）与 `backend/tests/test_fair_serial_processes.py`（1 例，真实 API＋collector 子进程、同一临时 SQLite）。三段红证据都是先临时移除本票机制、跑出失败，再恢复代码跑绿：

1. **跨进程许可红**：把 `DispatchLeases.source_slot` 与 `heavy_slot` 临时改为无租约，重跑 `test_api_and_collector_share_one_source_permit_and_page_wait_across_processes`：

```text
E  AssertionError: (1793120310.508151, 1793120310.522811)
E  assert 1793120310.522811 >= (1793120310.508151 + 0.095)
```

   说明上一页楼中楼完成后 14ms 就出现下一发送，跨进程 100ms 与串行都被绕过。恢复后同一用例 1 passed。

2. **公平轮转红**：把 `execute_pending` 的活动目标截成只处理第一个会话，重跑 `test_eight_targets_rotate_heavy_steps_and_complete_ten_thousand_replies`：

```text
E  assert 535 < 31
```

   即其他目标的根页机会被巨大目标拖到第 535 次请求之后。恢复轮转后 8 目标（含 10000 条回复）完整归档通过。

3. **租约接管红**：把 `_try_acquire` 改成只要租约行存在就永远拒绝，重跑 `test_target_lease_expiry_allows_safe_takeover_and_old_owner_cannot_release`：

```text
E  assert taken is not None
E  assert None is not None
```

   恢复到期判断后，新 owner 可安全接管，旧 owner 的释放不会删除新租约。

实施过程中被测试纠正的判断：

- 会话不能一次性 `claim_archive` 所有目标：否则配置删除后未开始的目标仍会请求正文。改为首次步骤前重新核验入选资格再领取，已开始的领取继续完成自身 generation，由 `finish_check_work` 保留 pending。
- 巨型目标重开续采后不能只用本轮读到的页 rcount，否则未重读的第 1 页根（含新增回复）会被漏掉。改为“归档整集合 + 本轮实际页覆盖”。
- API 显式初始化的 `succeeded` 仍只表示正文（含受限判定）成功，不能因为评论／媒体分项未完成改报失败；collector 的完成判定仍要求全部分项。
- 单图失败不能在同一会话无限重试同一张图；每个会话记录已尝试媒体 ID，失败留待下一轮。
- `ReplyPagePacer` 的 sleep 必须经模块引用调用，测试替换 `replies.sleep_after_root` 才能生效；直接导入函数会让替身失效。

## 3. 验证账本

命令均在仓库根执行（`uv run --no-sync`，隔离环境，无网络访问）：

| 范围 | 结果 |
| --- | --- |
| 本票新增 | `pytest backend/tests/test_fair_serial_collection.py backend/tests/test_fair_serial_processes.py -q` → **4 passed** |
| 票范围回归 | `pytest backend/tests/test_fair_serial_collection.py test_fair_serial_processes.py test_root_page_resume.py test_reply_page_resume.py test_reply_page_pacing.py test_source_gate.py test_flow_logs.py test_risk_pause.py test_risk_collector.py test_risk_probe.py test_risk_observation_collector.py test_risk_observation_processes.py test_collector.py test_collector_cadence.py test_inflight_lifecycle.py test_inflight_recovery.py test_comment_count_sync.py test_comment_sync_status.py test_comment_count_recovery.py test_migrations.py test_notification_migration.py test_management.py -q` → **427 passed**（146.71s） |
| 全量后端（合并 09 后） | `pytest backend/tests -q` → **1204 passed**（516.93s，含本票 4 例与既有全部回归） |

请求账本与回放：

- **8 目标／10000 条楼中楼回复**：`test_eight_targets_rotate_heavy_steps_and_complete_ten_thousand_replies`，真实临时 SQLite、真实 `Collector` 步骤机与归档 GET。巨大目标 `synced_reply_comment_count == local_reply_count == 10000`，7 个小目标 `synced_comment_count == 0`、评论／回复分项 success；其他目标的根页请求索引均小于巨大目标第 2 页回复请求，证明先轮转而非整条动态串行。巨大目标开始翻页后仍可完成另一个目标的轻量检查。
- **真实双进程**：`test_api_and_collector_share_one_source_permit_and_page_wait_across_processes` 启动真实 uvicorn API 与独立 collector 进程，共享同一临时 SQLite、真实 API 初始化与 collector `execute_pending`；外部来源由两进程各自的 `MockTransport`／Requests 替身接到同一文件账本。账本显示：
  - 角色同时包含 `api` 与 `collector`，两者都发送楼中楼页；
  - 任一时刻只有一个 `send` 未配对 `done`；
  - 每条楼中楼 `done` 之后的下一发送均 ≥ 100ms（断言 0.095 留时钟粒度）；
  - collector 不处理 API 的目标 `92001`，API 不处理 collector 的目标 `92002`；最终两个归档均为 `synced_comment_count == synced_reply_comment_count == local_reply_count == 600`、四项 work success。
- **目标互斥**：`test_api_initial_does_not_run_same_target_while_collector_holds_it` 持有 collector 类型目标租约时，API 初始化为 `{"processed":0,"succeeded":0,"failed":0}` 且零来源请求，不伪报排队成功。
- **租约接管**：`test_target_lease_expiry_allows_safe_takeover_and_old_owner_cannot_release` 覆盖未到期拒绝、到期安全接管、旧 owner 释放不删新租约。
- **既有 100ms／续采／暂停回归**：`test_reply_page_pacing`、`test_reply_page_resume`、`test_root_page_resume`、`test_risk_pause`、`test_risk_collector`、`test_inflight_*`、`test_comment_count_recovery` 均通过；风控注入后停止后续发送、保留 running 与断点。

为适配 08 契约而更新的既有测试（均为调度语义变化，不是放宽实现）：

| 用例 | 原假设 | 08 后 |
| --- | --- | --- |
| `test_slow_comment_pages_do_not_block_fixed_checks_and_other_heavy_resumes` | 慢页期间另一个目标可同时完成重型同步 | 单路重型下另一目标等待让出；固定检查继续，释放后下一节拍重启重型并完成 |
| `test_archive_cursor_freezes_...` | 两个目标的根页同时阻塞 | 只等第一个目标的根页进入阻塞；第二个目标的冻结 cursor 断言不变 |
| `test_three_targets_rotate_single_heavy_step_without_stalling_checks` | 两个同步槽并发、`peak == 2` | 全局一个重型回合、`peak == 1`，三个目标按步骤依次获得根页机会 |
| `test_management.py::test_simultaneous_duplicate_add...` | 两个资料请求同时到达外部边界 | 来源许可串行化，两个 API 请求仍并发进入，持久状态保证一个 201、一个 409 |
| `test_risk_probe.py::test_collector_run_probes_at_each_deadline...` | 触发前最后一行业务日志必须是 root_comments | 已获许可的轻量检查可在步骤间收尾，探测序列从第一项探测请求起核对 |
| `test_risk_observation_processes.py::...ten_minutes` | 重启后在第一个节拍前推进时钟 | 等重启后的首个 `collector_tick` 建立观察基线再推进 |

## 4. 未验证与边界

- 全部为虚构 fixture，只替换外部 HTTP、外部时钟与 OSS 上传；**没有真实 B 站请求**，因此真实平台并发阈值、长期运行稳定性、真实上游页漂移与热帖速率未观测。
- 未配置真实 OSS／飞书，未部署、未重启任何生产进程；票 10 的三进程完整组合、RC-11 真实通知与 RC-12 性能对照仍未完成。性能公式已改为非硬性参考目标，本票不宣称达标或未达标。
- 目标租约默认 300 秒、无心跳续约；正常步骤每步续期，进程硬停后最多等租约到期才能被接管。该等待是安全接管代价，不在本票压测范围内。
- API 与 collector 各自持有独立的 `DispatchLeases` 实例，但都读写同一 SQLite；没有进程内共享字典冒充跨进程保护。

## 5. 涉及文件

- 新增：`backend/bili_monitor/dispatch.py`（`dispatch_leases`、`DispatchLeases`、`TargetLease`、`TargetSession` 步骤机）、`backend/tests/test_fair_serial_collection.py`、`backend/tests/test_fair_serial_processes.py`、`backend/tests/fair_serial_fixture.py`。
- 修改：`backend/bili_monitor/collector.py`（单 drain 轮转、目标会话、租约续期与暂停结算）、`backend/bili_monitor/sync.py`（API 初始化走步骤机与 api 目标租约）、`backend/bili_monitor/source_gate.py`（`GatedAsyncTransport` 接入发送租约）、`backend/bili_monitor/comment_client.py`（Requests 发送与页后等待接入发送租约）、`backend/bili_monitor/media.py`（`media_step` 单图步骤）、`backend/bili_monitor/storage.py`（v27 迁移）、`backend/tests/*`（上述契约调整），文档 `docs/backend/api/collector-api.md`、`docs/design/bilibili-risk-control.md`、`docs/deployment/static-delivery.md`、`backend/README.md`、`docs/README.md`。

## 6. 给票 10 的回放 seam

票 10 可以直接复用本票留下的外部 seam，不需要读内部表或伪造进程：

- `Collector(..., scheduler=DispatchLeases(store, clock=...))` 与 `open_collector(..., scheduler=...)`：注入受控时钟、传输、媒体上传和租约实例；默认生产装配已创建同一 SQLite 的租约。
- `DispatchLeases.snapshot()`：只读列出 `name/workload/kind/lease_until`，不返回 owner 令牌；可用于断言无并发重型／目标互斥，不触发网络。
- `backend/tests/fair_serial_fixture.py`：真实 uvicorn API 与独立 collector 子进程的外部传输／共享文件账本／`start.gate` 已可复用到 10 的多进程组合；账本行是 `角色 类型 页 send|done 时间 oid`，可直接扩展为 8 目标与探测接口。
- `backend/tests/test_fair_serial_collection.py::HugeSource`：8 目标、10000 条回复的固定分页源，可直接作为 10 的全量回放样本；`first_huge_reply` 事件可用于在巨大目标翻页期间插入轻量检查。
- `ReplyPagePacer(sleep=..., clock=...)`、`PacedSourceTransport(sleep=...)`、`ControlledClock`、`FileClock`（04 fixture）：统一控制页后 100ms、feed／根页等待与风控时间，不需要真实等待。
- `SourceRiskPaused` 与 `dispatch_leases` 到期：10 可在步骤中杀进程／重开，验证 running 恢复、目标租约接管与旧 owner fencing；不需要新增生产接口。
