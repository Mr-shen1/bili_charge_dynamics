# 04：六档冷却与分接口探测

Status: resolved

**What to build:** 冷却每次到期后自动串行验证各必需接口，全部通过才恢复采集；未通过按六档延长等待，最后仍失败转人工，进程崩溃后也不会重复探测或错误放行。

**Blocked by:** 02 — 楼中楼分页等待与基础流程日志；03 — 跨进程风控暂停与状态查询。

## 验收标准

- [x] 六档按 1、2、4、8、15、30 分钟等待，每档到期都实际执行一轮探测；任一类型未通过立即结束整轮并只推进一档，第六档失败进入 manual，不采用旧三次失败方案。证据：`test_every_step_waits_its_full_duration_then_probes_once`、`test_trigger_during_observation_advances_one_step_and_sixth_goes_manual`；真实进程 `test_probe_owner_is_unique_across_processes_and_takeover_fences_the_old_owner`。
- [x] 合法 Retry-After 不被更短本地期限覆盖；受控时间验证恰到期／未到期、重启剩余期限和异常时钟，不能以启动或时间异常绕过暂停。证据：`test_legal_retry_after_is_never_shortened_by_the_local_step`、`test_invalid_retry_after_values_are_ignored`、`test_retry_after_header_from_the_transport_extends_the_deadline`、`test_comment_request_session_forwards_retry_after_before_rejecting`、`test_remaining_deadline_survives_reopen_without_probing_on_startup`、`test_abnormal_clock_and_missing_lease_never_bypass_the_pause`。
- [x] 每轮冻结“触发接口类型与当前待执行任务所需类型的并集”，以主机和路径模板划分，不按动态 ID／根 ID／页码逐一探测；图片分片域按受信图片域族归类。证据：`test_required_types_only_covers_work_that_is_actually_pending`、`test_probe_round_covers_every_needed_type_with_minimal_gets`、`Store.risk_probe_facts`；真实进程账本逐类型恰好一次。
- [x] 真实需要的计数、根页、楼中楼、feed、detail、动态网页、UP 资料、首页／空间预热及图片类型分别有最小有效 GET 和对应原解析校验；不以 count 或资料成功替代其他类型，也不用 HEAD 代替图片 GET。证据：`RiskProber._run` 直接调用生产 `fetch_*`／`discover_recent(pages=1)`／`ImageDownloader.download`；`test_probe_round_covers_every_needed_type_with_minimal_gets` 与真实进程用例断言探测方法集合为 `{"GET"}`、五类各自 `passed`。
- [x] 使用正式凭据、代理及统一发送／等待规则；楼中楼探测同样等待 100ms。探测不暗中补做预热，不无限寻找样本，没有已知有效样本时记录未确认恢复而非假通过。证据：`test_reply_probe_goes_through_the_production_comment_session_for_one_hundred_ms`（只等待一次 0.1 秒、`wait_ms=100`）、`test_probe_client_reuses_the_session_without_warming_up`、`test_missing_local_sample_is_unconfirmed_not_a_fake_pass`。
- [x] HTTP 200 但业务／资源校验失败仍不放行；非 412／429 的探测失败只表示本轮未通过，不扩大普通业务的错误分类。一个失败后其余类型不继续请求。证据：`test_invalid_200_or_risk_response_short_circuits_and_advances_exactly_one_step`（`source_rejected`／`source_risk`、其余类型保持 `pending`、无失败事实）。
- [x] SQLite 持久保存探测轮次、结果及唯一 owner 租约，真实多进程验证不能同时领取；崩溃后租约到期方可接管，旧 owner 不能提交结果，接管重新确认本轮类型。证据：`test_probe_owner_lease_fences_the_old_owner_and_allows_takeover`；真实进程 `test_probe_owner_is_unique_across_processes_and_takeover_fences_the_old_owner`（`claim` 二次 `None`、`clock+301` 接管换 owner／轮次／类型、旧 owner `finish` 返回 `null`）。
- [x] 探测只验证可用性，不推进归档 checkpoint、目标成功时间或通知基线，不生成业务通知；各类型全部通过后进入 observing 并允许正常调度，不补发冷却错过的检查。证据：`test_probe_round_covers_every_needed_type_with_minimal_gets` 的 `snapshot(store)` 前后全等；`test_collector_run_probes_at_each_deadline_and_resumes_abandoned_work`（observing 后按原断点继续，错槽不补发）。
- [x] 状态查询能区分本轮待探测、通过、失败及下一档时间；记录接口类型、轮次、耗时、等待、失败原因及可用业务 ID，保持脱敏。证据：`test_public_status_is_distinguishable_and_never_leaks_owner_or_lease`、`test_status_endpoint_reveals_probe_round_without_triggering_any_probe`；字段表见[采集契约](../../../docs/backend/api/collector-api.md#六档冷却与按接口探测04)。
- [x] 用实际 API／collector、真实临时 SQLite、受控时钟和传输账本验证完整阶梯、类型覆盖、失败短路、跨进程重启及无业务副作用，更新恢复与状态契约。证据：3 个新测试文件＋`risk_probe_fixture.py`（票范围 21 passed、相关回归 536 passed、全量 1166 passed），契约同步见[04 证据](../evidence/04-endpoint-probes-and-cooldown.md)§6。

## 验证范围

主要覆盖 RC-06、RC-07 及探测相关 RC-03／RC-10。全部通过后的观察窗口清零和人工探测写入口由 05 完成；本票不在探测成功时提前重置档位。

## Answer

`risk.py` 把 03 的「第 1 档暂停」扩成完整状态机：`cooldown` 按 `COOLDOWN_STEPS`（60／120／240／480／900／1800 秒）逐档等待，期限到期由采集进程的固定节拍调用 `claim_probe` 领取唯一轮次（写入新轮次、owner、300 秒租约与冻结类型并进入 `probing`），`RiskProber` 串行执行每类探测并逐类 `record_probe`，最后 `finish_probe`：全通过进 `observing`（保留档位、恢复普通发送），任一失败只推进一档，第六档失败转 `manual`。`permit` 只在 `normal`／`observing` 放行，`report` 在 `observing` 再次触发时推进一档、第 6 档之后直接转人工；迟到响应仍只合并。`parse_retry_after` 支持 delta-seconds 与 HTTP-date，`_deadline` 取本地档位与服务端要求的更晚者，HTTPX `GatedAsyncTransport` 与 Requests `_SourceSession` 都转发原始头；期限或租约不可解析时按“未到期／无有效租约”保守处理，重启只读回剩余期限，启动本身不探测。

探测集合由 `Store.risk_probe_facts` 的只读快照推导：触发类型 ∪ 当前待执行工作真正需要的类型（有入选目标才有网页／计数，有必要时才加 detail；有 pending 工作且已存 locator 才有根页，只有已知有回复的根才有楼中楼；有 recent 监控才有 feed；未成功媒体才有对应图片域族），按主机＋路径模板归类，不按 ID／页码扩增。`RiskProber` 只用本地已知有效样本、触发类型先探测、每类一个最小 GET 并走生产解析（计数／根页／楼中楼／detail／opus／feed／资料／预热／图片；图片实际 GET），楼中楼走生产 `RequestsCommentClient.get` 因而同样缴纳页后 100ms；没有样本记 `sample_missing`，业务或资源校验失败记固定原因，任一失败即短路、其余类型保持 `pending`，不写检查失败／`sync_error`、不提交归档分片、不推进成功时间或通知基线、不补做预热。`open_collector` 另建不受许可的探测装配（同一 source/media transport、cookie hooks、`SourcePacer`、`ReplyPagePacer`，以及不预热的 `RequestsCommentClientFactory.client`）。

唯一 owner 与结果都复用 03 预留的 v24 `source_risk` 列（`probe_round_id`／`probe_owner`／`probe_lease_until`／`probe_results`），不新增 schema；租约内其他进程不能领取，崩溃后租约到期才可接管并重新冻结本轮类型，旧 owner 的提交与结束被 owner＋轮次 fencing 拒绝。`GET /api/manage/risk` 的 `probe.results` 现在逐类型返回 `pending|passed|failed`、HTTP 状态、固定原因、耗时、等待与可空业务 ID，仍不暴露 owner／租约／令牌。采集进程进入 `observing` 后，在没有在途任务时把被暂停打断的 `running` 领取归还为 `pending` 并从原断点继续，不再需要重启进程。

未做：观察期 10 分钟清零、`POST /api/manage/risk/probe`、`409 RISK_PROBE_NOT_ALLOWED`、系统告警（属 05／09）；页后 100ms 的增量／重试／尾页全覆盖（属 02／07）；单路调度与日志 ID 全覆盖（属 08）。前端未改（无新增错误码与页面）。真实 B 站／OSS／飞书、部署与重启未验证。交付前已合入 06 的 `c9f3b45`（页进度独立 v25，风险 v24 字段不变），无冲突。证据与红绿过程见[04 证据](../evidence/04-endpoint-probes-and-cooldown.md)。

## Comments

- 2026-10-30 领取并按 TDD 纵向切片实施（Status: claimed → resolved）。新增 3 个测试文件＋1 个多进程 fixture（21 例）与 1 例会话入口用例；票范围 21 passed、相关回归 536 passed、全量 1166 passed（合并 06 `c9f3b45` 后）。前端无改动，未跑 `pnpm check`（工作树无 `node_modules`）。
- 跨票影响：① 探测类型集合依赖本地事实，06／07 若改变分页路径或 08 改变调度，需要同步复核 `risk_probe.required_types`；② `Collector`／`open_collector` 新增 `probe=` 与 `risk_clock=` 注入点，08 接入单路调度时应沿用；③ 03 遗留的“暂停后需重启恢复”已由 `Collector._resume_abandoned` 修掉，05 的观察期清零只需把状态写回 `normal` 并递增代次。
- 环境限制：本工作树无 `.codegraph/` 索引，探索按 `docs/agents/codegraph.md` 回退到源码阅读与 grep。
