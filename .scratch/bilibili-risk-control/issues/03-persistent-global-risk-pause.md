# 03：跨进程风控暂停与状态查询

Status: resolved

**What to build:** 任一 B 站源入口收到 HTTP 412／429 后，API 和 collector 统一持久暂停发送；执行者可只读查询状态，需要联网的管理操作明确暂不可用，不依赖源站的工作仍可继续。

**Blocked by:** 01 — 统一 B 站请求发送入口。

## 验收标准

- [x] 仅 HTTP 412／429 触发全局保护；其他 HTTP 状态、业务码、凭据、网络和内容受限的原处理不扩大，尤其不把业务码 -412 当 HTTP 412。证据：`test_only_http_412_and_429_trigger_the_pause`、`test_business_code_and_ordinary_errors_do_not_pause`、`test_profile_diagnostics.py` 的 412／429 保护信号用例；分类只看 `SourceReport.status_code`。
- [x] SQLite 原子保存全局状态、状态代次、首档 1 分钟冷却期限及触发接口；不按 UP 拆开，重启不清零，迟到的一波风控响应不会连跳多档。证据：`test_first_http_412_pauses_with_one_minute_deadline_and_trigger_facts`、`test_late_risk_responses_merge_without_advancing_the_backoff_step`；`source_risk` 单行 v24。
- [x] API 与 collector 的真实独立进程共用保护状态；业务接口、预热、图片下载、手动初始化／媒体重试以及重定向后续请求都不能绕过。证据：`test_risk_processes.py`（真实 uvicorn＋采集子进程、同一临时 SQLite、上游账本）；图片下载见 `test_risk_response_during_image_download_keeps_completed_images`。
- [x] 响应层在上层吞掉异常前报告风控，包括原本忽略错误的预热；触发后不再继续翻页、预热或自动重试。已在途返回的数据只按原版本／令牌规则安全提交。证据：`test_manual_sync_mid_chain_pauses_without_fake_statistics`、`test_warmup_risk_response_pauses_and_stops_the_second_warmup`；`report` 记录后中止调用链；7 个模块共 17 处在 `except Exception` 前显式透传。
- [x] 新增 GET /api/manage/risk，仅读取本地状态，返回状态、进入时间、档位、可空探测时间、脱敏触发信息及可用探测摘要，不触发采集或泄漏内部 owner／令牌。证据：`test_risk_status_is_read_only_and_never_triggers_collection`；字段表见[采集契约](../../../docs/backend/api/collector-api.md#跨进程风控暂停03)。
- [x] 需要源请求的管理及手动同步返回 503 SOURCE_RISK_PAUSED、固定安全提示、状态和可空时间；有未来截止时间时附 Retry-After。原有输入校验／本地冲突仍正常，不创建半成品或返回伪成功统计。证据：`test_http_412_on_one_entry_pauses_every_other_source_entry`、`test_input_validation_and_local_conflicts_still_win_while_paused`、`test_local_reading_management_and_downloaded_media_stay_available_while_paused`。
- [x] 归档阅读、纯本地管理、停用／删除、已下载数据提交及 OSS 上传仍可用；后台保留 pending 和已有错误，不每个节拍新增失败或伪造成功时间。证据：`test_risk_collector.py`（三拍零发送、检查行 pending、`collector_paused` 单条、tick 心跳保留）。
- [x] 状态存取失败时禁止新源请求，返回存储错误；原子迁移保留归档、媒体、阅读 cursor 与未完成工作，不预占后续迁移版本。证据：`test_state_storage_failure_blocks_sends_and_reports_storage_error`、`test_v23_database_gains_protection_state_without_touching_archives`、`test_future_database_refuses_startup_without_downgrading`。
- [x] 记录可关联的首次触发、暂停及被拒绝原因日志并保持脱敏，避免每 2.7 秒重复同一警告；补齐接口契约与必要的既有操作固定错误提示，不新增页面。证据：`managementApi.ts` 只新增一条固定错误映射＋单测；日志事件与脱敏字段见[03 证据](../evidence/03-persistent-global-risk-pause.md)。
- [x] 真实双进程、同一临时 SQLite 与上游账本证明一进程触发后另一进程停止发送；重开保留剩余期限，普通错误对照及本地可用性回归通过。证据：[03 证据](../evidence/03-persistent-global-risk-pause.md)第 2 节第 13 步与第 3 节；票范围 21 passed、16 文件回归 493 passed（另有 1 个开工前即失败的既有用例）。

## 验证范围

主要覆盖 RC-05、RC-09 及持久暂停部分 RC-06。本票到期不自动清除保护，也不添加临时强制解锁入口；定时探测和恢复由 04／05 完成，中间态不用于生产发布。

## Answer

新增 `backend/bili_monitor/risk.py` 作为 01 那个 `SourceGate` 的持久实现：`RiskGate.permit` 在发送前读同一 SQLite 的 `source_risk` 单行（v24），保护态或状态不可读写都拒绝发送；`RiskGate.report` 只在 HTTP **412／429** 时在同一短事务里记录首次触发（`state=cooldown`、`backoff_step=1`、60 秒期限、触发接口与状态、代次 +1），已在保护中的迟到响应只合并、不推进档位，然后抛出 `SourceRiskPaused` 中止当前调用链——所以触发后不再翻页、重试、重定向或补做预热，而预热原本吞异常的路径也不会吞掉风控（报告点在传输层，吞异常在其上）。HTTPX 与 Requests 两个 Adapter 原样复用 01 的逐跳接入，只多了“报告拒绝时先释放响应”。

把“暂停”落到每个既有单元：`verify_author`、`sync_body`（正文页／detail）、`sync_roots`、`sync_replies`、`sync_media`、`check_once`、`discover_once`、`_execute_target`、`comment_client` 预热共 17 处在各自 `except Exception` 之前显式 `except SourceRiskPaused: raise`，避免风控被折叠成 `TARGET_UNVERIFIED`／`body_source_failed`／`root_sync_failed`／`MEDIA_DOWNLOAD_FAILED`／`SYNC_INCOMPLETE` 这类假失败；采集主循环每拍先读只读快照，暂停时不领取、不派发、错过槽不补发，在途单元由 `_settle` 结算（保留 pending／running 与已提交分片，不写失败事实或成功时间），暂停日志按状态代次去重并保留节拍心跳。

公开契约：`GET /api/manage/risk` 只读本地状态（`state`／`generation`／`since`／`backoff_step`／`next_probe_at`／`observing_since`／`last_trigger`／`probe`，不含 owner／租约／令牌，不触发采集）；需要来源的管理与手动同步在保护态返回 `503 SOURCE_RISK_PAUSED`＋固定提示＋状态＋可空时间，有未来截止时间时带 `Retry-After`，且触发那一次也不返回伪成功统计；纯本地读取、停用／删除、已下载数据提交与 OSS 上传照旧。前端只在既有 `httpError` 增加一条固定映射，没有新页面。图片接口类型从 01 的 `media_image` 拆成 `hdslb`／`biliimg` 两个受信域族，供 04 按类型探测。

未做：六档到期探测、`probing`／`observing`／`manual`、按接口探测与 owner 租约接管、观察期、`POST /api/manage/risk/probe`、429 `Retry-After` 抬升本地期限、页后 100ms 等待、分页续采、单路调度、日志 ID 与系统告警。本票到期不自动解除保护，也没有强制解锁入口，中间态不用于生产发布。证据与红绿过程见[03 证据](../evidence/03-persistent-global-risk-pause.md)。

## Comments

- 2026-10-27 领取并按 TDD 纵向切片实施（Status: claimed → resolved）。新增 4 个测试文件＋1 个双进程 fixture（21 例）；票范围 21 passed，16 文件相关回归 493 passed。全量 `1123 passed, 1 failed`——唯一失败 `test_migrations.py::test_unexpected_transport_startup_failure_is_sanitized` 在开工前的 spec tip `1673dfe` 上就已失败（`git stash` 复跑确认），属 01 遗留、本票未修。
- 需要主线／后续票注意的两处跨票影响：① 迁移版本从 23 抬到 24，`test_notification_migration`／`test_inflight_recovery`／`test_three_process_delivery` 的版本断言随之机械更新（06 的并行根进度合并时需再协调版本号）；② `POST /api/manage/ups` 等入口在收到 412／429 时由「502 PROFILE_UNAVAILABLE」变为「503 SOURCE_RISK_PAUSED」，`test_profile_diagnostics.py` 的代表性普通 HTTP 错误因此改用 403／401／418，并新增 412／429 的保护信号用例。
- 环境限制：本工作树无 `.codegraph/` 索引，探索按 `docs/agents/codegraph.md` 回退到源码阅读与 grep。

