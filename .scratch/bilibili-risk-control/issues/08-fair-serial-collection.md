# 08：单路重型归档与分页公平轮转

Status: resolved

**What to build:** 不同动态、后台与手动入口共享一路重型归档，每完成一个可提交分页／下载步骤就有机会轮转；轻量检查可穿插，但历史大目标也能持续推进。

**Blocked by:** 03 — 跨进程风控暂停与状态查询；07 — 楼中楼续采与热帖持续追赶。

## 验收标准

- [x] API 与 collector 共用全局发送许可和目标互斥，B 站源请求统一串行排队，不因独立线程、客户端或进程叠加成请求洪峰；OSS 上传与本地处理不占来源许可。证据：v27 `dispatch_leases` 的 `source`／`heavy`／`target:*`；`GatedAsyncTransport` 与 `RequestsCommentClient.get` 包住发送与页后等待；单图下载在来源许可外做 OSS 上传。[evidence §1](../evidence/08-fair-serial-collection.md#1-交付内容)
- [x] 全局只推进一路重型归档，根页、楼中楼页及单图下载均以可安全提交步骤为调度片，不等整栋楼或整条动态结束才允许其他目标推进。证据：`TargetSession.advance()` 一次最多提交一页／一张图；`execute_pending` 按会话轮转，8 目标含 10000 条回复时其他目标根页均早于巨大目标第 2 页（`test_eight_targets_rotate_heavy_steps_and_complete_ten_thousand_replies`）。[evidence §3](../evidence/08-fair-serial-collection.md#3-验证账本)
- [x] 轻量计数、到期网页检查及必要发现可在分页之间穿插；有可运行重型分页时，有限轻量批次后必须让出分页机会，双方均不长期饿死。证据：巨大目标开始翻页后仍可完成另一个目标的 `check_once`；collector 主循环继续按固定节拍派发检查，重型由独立 drain 按步骤让出。
- [x] 原有固定节拍、忙时跳槽、同目标不叠加和错过槽不追赶保持；不得用无限队列保留所有 2.7 秒检查，风控期间和恢复时均不形成待补发洪峰。证据：`test_collector_cadence`、`test_collector`、`test_risk_collector`、`test_source_pacing` 通过；main loop 仍按 deadline 跳过过期槽，不建检查队列。
- [x] 每次轮转复用持久断点及原领取／版本规则；租约或 owner 失效后只能安全接管，不允许 API 手动初始化与后台对同一目标重复执行。证据：步骤机复用 `root_scan_step`／`reply_scan_step` 与 archive `generation`；`test_target_lease_expiry_allows_safe_takeover_and_old_owner_cannot_release`、`test_api_initial_does_not_run_same_target_while_collector_holds_it`、`test_old_claim_cannot_attach_archive_to_another_up_after_config_deletion` 通过。[evidence §2](../evidence/08-fair-serial-collection.md#2-红绿过程tdd纵向切片)
- [x] 同步管理入口保留原完成统计语义，不把已排队误报为同步成功；实际需要网络但被风控阻止仍明确暂不可用，不创建异步校验工作流。证据：`initialize` 仍同步推进并返回 `processed/succeeded/failed`，collector 占用目标时跳过；风控仍由 `SourceRiskPaused`→`503 SOURCE_RISK_PAUSED` 透传，无异步工作流。
- [x] feed、根页等待与楼中楼 100ms 规则在跨目标、跨进程轮转时依然生效，正常解析、会话缓存与其他故障处理不扩改。证据：真实独立 API＋collector 账本断言上一楼中楼 `done` 后下一发送 ≥100ms、无并发 send（`test_api_and_collector_share_one_source_permit_and_page_wait_across_processes`）；既有 `test_reply_page_pacing` 仍绿。
- [x] 任务取消、进程重开和风控触发后不继续下一次发送；已取得内容可以安全提交，归档阅读和已下载图的 OSS 上传不受影响。证据：`source_risk_paused_work_aborted` 与 `SourceRiskPaused` 原样上抛、running 领取与分片保留；`test_risk_collector`、`test_comment_count_recovery`、`test_inflight_recovery`、`test_inflight_lifecycle` 通过；OSS 上传不取 `source` 租约。
- [x] 调度日志能说明当前目标／页、领取或合并／跳过、让出执行权和暂停原因，并可关联后续页与提交，不泄漏内部令牌。证据：新增 `dispatch_stage`／`dispatch_turn`／`sync_skipped reason=target_busy|target_lease_lost|selection_changed`／`source_risk_paused_work_aborted`；`test_flow_logs` 正向断言业务 ID 与页、负向断言无 URL／token／异常正文。
- [x] 至少 8 目标、其中含万条楼中楼回复的真实应用／collector＋临时 SQLite 回放中，证明所有可运行目标持续推进、轻量检查有机会、总归档完整；双进程请求账本证明串行和无旁路，更新运行与调度契约。证据：`test_fair_serial_collection.py` 的 8 目标／10000 回复完整归档；`test_fair_serial_processes.py` 真实 uvicorn API＋独立 collector 子进程、同一临时 SQLite、共享文件账本；契约见 [collector-api.md](../../../docs/backend/api/collector-api.md#单路重型与公平轮转08)。[evidence §3](../evidence/08-fair-serial-collection.md#3-验证账本)

## 验证范围

主要完成 RC-01、RC-02，并复验 RC-03／RC-04／RC-09／RC-10；性能数字及风控完整生命周期的整体验收由 10 收口。

## Answer

新增 `backend/bili_monitor/dispatch.py`：SQLite v27 `dispatch_leases` 分离 `source`（逐次来源发送，包住楼中楼页后 100ms）、`heavy`（全局唯一重型回合）与 `target:<uid>:<id>`（同目标互斥，collector 会话续期、API 用 api 类型挡后台）。`TargetSession` 把正文、根页、楼中楼页、单图下载拆成一次调用只提交一步的状态机，复用 06／07 的持久断点与 generation fencing；collector 的 `execute_pending` 在所有可运行目标间轮转，轻量检查仍在固定节拍主循环并交给同一来源许可排队。API `/api/sync/initial` 同步走同一组步骤并保留原统计；collector 已持有目标时跳过，不伪报排队成功。暂停／取消保留 running 领取与已提交分片，租约到期后只能安全接管，旧 owner 释放不删新租约。

未验证：真实 B 站上游并发阈值、长期稳定性、真实上游分页漂移与热帖速率、真实 OSS／飞书、部署与三进程完整组合；性能公式为非硬性参考目标，本票不做反复调优或宣称达标。见[证据](../evidence/08-fair-serial-collection.md)。

## Comments

- 2026-10-27 领取并按纵向切片实施。完成前按真实祖先合并 `spec/bilibili-risk-control` 的 `5d09582`（05）、`4be7824`（用户性能公式非硬性更新）与 `ec424e8`（09），`git merge-base --is-ancestor spec/bilibili-risk-control HEAD` 成立。05 已占用 v26，本票迁移顺延为 v27，相关版本断言更新为 27／未来 28。
- 调度契约变化（有意，非放宽）：全局重型从多个 `max_syncs` 并发改为一步一轮转；慢页期间其他重型目标等待让出而不是同时同步；API 与 collector 同目标由租约互斥；`source` 许可串行化所有来源发送。对应更新 `test_comment_count_sync`、`test_comment_sync_status`、`test_comment_count_recovery`、`test_management`、`test_risk_probe`、`test_risk_observation_processes` 的旧并发假设，根因与逐条说明见[证据 §3](../evidence/08-fair-serial-collection.md#3-验证账本)。
- 红证据三次：移除 `source`／`heavy` 租约后跨进程账本出现 14ms 间隔与并发发送；截断轮转后其他目标根页落到第 535 次请求之后；禁止到期接管后新 owner 失败。恢复后票范围 427 passed；合并 09 后全量后端 1204 passed。未改校准信号、错误分类、通知资格或前端。
