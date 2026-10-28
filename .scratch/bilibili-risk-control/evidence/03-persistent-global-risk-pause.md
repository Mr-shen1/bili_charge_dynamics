# 03 跨进程风控暂停与状态查询：实施与验收证据

对应票据：[03 跨进程风控暂停与状态查询](../issues/03-persistent-global-risk-pause.md)；正式规则：[B 站限流／风控保护与全量归档续采](../../../docs/design/bilibili-risk-control.md) §4.1、§4.2（只到第 1 档）、§5；实施与测试决策：[父规格](../spec.md)「实施决策 7—9、13—15」「测试决策」；运行说明：[采集契约](../../../docs/backend/api/collector-api.md#跨进程风控暂停03)、[管理契约](../../../docs/backend/api/management-api.md#来源保护状态票据-03)、[后端 README](../../../backend/README.md#统一源请求发送入口)。

结论：**本票范围（仅 HTTP 412／429 触发的跨进程持久暂停、只读状态查询、保护态管理操作固定暂不可用）已实施并有隔离自动化证据**，包括真实双进程（API＋collector）、同一临时 SQLite 与上游账本。六档到期探测、按接口探测、观察期、人工探测、`POST /api/manage/risk/probe`、页后 100ms 等待、分页续采、单路调度、流程日志 ID 与系统告警**未实施**（属于 04／05／02／06—09）。本票到期不自动清除保护，中间态不用于生产发布。未访问真实 B 站、OSS 或飞书，未部署、未重启任何环境。

## 1. 环境与命令

- 环境：Linux，Python 3.12.15，`uv sync --locked`；pytest 8.4.2、httpx 0.28.1、requests 2.34.2、fastapi 0.115.12（`uv.lock`／`pyproject.toml` 未改）。前端 Node 24.21.0、pnpm 10.34.6，依赖由离线 store 安装（未联网取包）。
- 分支：`wt/bilibili-risk-control-03`，切自 `spec/bilibili-risk-control` 的 `1673dfe`（开工与交付前各确认一次 tip 未前进，无合并动作）。
- 代码定位：本工作树内没有 `.codegraph/` 索引（`docs/agents/codegraph.md` 的跳过条件），`codegraph_explore` 对未索引仓库拒绝服务，因此按约定回退到源码阅读与 grep；入口清单与 `/tmp/bilibili-risk-control-notes.md` 一致。
- 新增用例（4 个文件 + 1 个双进程 fixture）：`backend/tests/test_risk_state.py`（7）、`backend/tests/test_risk_pause.py`（10）、`backend/tests/test_risk_collector.py`（3）、`backend/tests/test_risk_processes.py`（1，真实子进程），以及 `backend/tests/risk_fixture.py`。
- 票范围命令与结果：
  - `uv run --no-sync pytest backend/tests/test_risk_state.py backend/tests/test_risk_pause.py backend/tests/test_risk_collector.py backend/tests/test_risk_processes.py -q` → **21 passed**（双进程用例 10 秒，其余 3 秒）。
  - 相关回归（票范围外沿，16 个文件）：`uv run --no-sync pytest backend/tests/test_source_gate.py backend/tests/test_source_pacing.py backend/tests/test_comment_transport.py backend/tests/test_comment_session.py backend/tests/test_collector.py backend/tests/test_collector_cadence.py backend/tests/test_initial_archive.py backend/tests/test_full_archive.py backend/tests/test_replies.py backend/tests/test_root_comments.py backend/tests/test_dynamic_media.py backend/tests/test_comment_media.py backend/tests/test_management.py backend/tests/test_discovery_source.py backend/tests/test_migrations.py backend/tests/test_profile_diagnostics.py -q` → **493 passed, 1 failed**（该失败即下述既有失败；覆盖迁移 v24、资料诊断新边界）。
  - 全量：`uv run --no-sync pytest backend/tests -q` → **1123 passed, 1 failed in 210.51s**。唯一失败 `test_migrations.py::test_unexpected_transport_startup_failure_is_sanitized` **在本票开工前的 spec tip 上就失败**（用 `git stash` 在干净 tip 复跑确认），与本票无关，未在本票修（01 的 `GatedAsyncTransport` 不转发 `__aenter__`，注入传输启动失败不再中止启动；属 01 遗留，建议后续票据处理）。
  - 前端：`cd frontend && pnpm check` → typecheck＋**294 unit passed**（25 文件）＋e2e 项目守卫通过；`pnpm check:dist` 未跑（本票没有构建产物或交付契约变化，前端只加一条固定错误映射）。

## 2. 红绿过程（TDD，纵向切片）

1. **持久状态与首次触发**（`test_risk_state.py::test_first_http_412_pauses_with_one_minute_deadline_and_trigger_facts`）：先写得红 `ModuleNotFoundError: backend.bili_monitor.risk`。实现 `risk.py`（`RiskGate`、`SourceRiskPaused`、`migrate`、`public_status`、`retry_after_seconds`）＋`storage.migrate` 的 `if version < 24` 与 `PRAGMA user_version = 24`；断言 `state=cooldown`、`backoff_step=1`、`generation=1`、`last_trigger.endpoint_type=replies`、`next_probe_at-since == COOLDOWN_STEPS[0] == 60`。
2. **迟到合并**（同文件 `test_late_risk_responses_merge_without_advancing_the_backoff_step`）：触发后再报告 3 次 429，断言档位、代次与截止时间都不变——一波并发迟到响应只推进同一代次一次。
3. **触发面不扩大**（`test_only_http_412_and_429_trigger_the_pause`）：403／500／502／503／200／无状态与网络异常都不触发；业务码走解析层，不是报告的分类。
4. **许可与拒绝**（`test_permit_refuses_new_requests_only_while_paused`、`test_pause_survives_reopen_and_is_shared_by_independent_store_instances`）：正常态放行；暂停态 `permit` 抛 `SourceRiskPaused` 并带出可公开状态；另一个 `Store`／`RiskGate` 实例读同一文件得到同一剩余期限。
5. **状态不可读**（`test_unreadable_state_forbids_new_requests_instead_of_failing_open`）：删表后 `permit` 抛 `sqlite3.Error`（HTTP 层由既有中间件映射为 `503 STORAGE_UNAVAILABLE`），**不降级放行**。
6. **迁移**（`test_migration_adds_a_single_normal_row_and_preserves_existing_state`、`test_migrations.py::test_v23_database_gains_protection_state_without_touching_archives`、`test_future_database_refuses_startup_without_downgrading`）：v23→v24 只新增 `source_risk` 单行，归档详情、根评论分页、楼中楼分页与 checkpoint 原样保留；重放迁移不重置已登记状态；未来版本 25 仍拒绝启动且不回写版本号。
7. **API 触发与契约**（`test_risk_pause.py::test_http_412_on_one_entry_pauses_every_other_source_entry`）：红在“目标校验仍返回 502 TARGET_UNVERIFIED 且第二个入口照常发请求”。实现分两步：`app.create_app` 默认改用 `RiskGate`＋`SourceRiskPaused` 异常处理器＋`503 SOURCE_RISK_PAUSED`（`contracts.ERRORS`＋`error_response(details, headers)`）；再让 `report` 在记录风控后**抛异常中止当前调用链**（`test_state` 里同步改为“报告即拒绝”）。
8. **吞异常处必须透明**（同批红→绿）：`verify_author`、`sync_body`（正文页／detail）、`sync_roots`、`sync_replies`、`sync_media`、`check_once` 三处、`discover_once`、`_execute_target` 两处的 `except Exception` 之前各加 `except SourceRiskPaused: raise`。这一步是本票最容易漏的地方：不加就等于把风控写成 `TARGET_UNVERIFIED`／`body_source_failed`／`root_sync_failed`／`MEDIA_DOWNLOAD_FAILED`／`SYNC_INCOMPLETE`，而 412 与 429 在 Requests 侧由 `SourceRejected` 包装、在 HTTPX 侧由 `raise_for_status` 包装，单靠“下一次发送会被拒绝”无法避免假失败。
9. **触发后不再翻页／重试／预热**（`test_manual_sync_mid_chain_pauses_without_fake_statistics`、`test_warmup_risk_response_pauses_and_stops_the_second_warmup`、`test_risk_response_during_image_download_keeps_completed_images`）：手动初始化命中根页 412 时返回 503、无 `processed/succeeded/failed`、账本停在 412 那次根页发送且没有 `/x/v2/reply/reply`；已取得的第一张图片仍成功提交并上传，第二张保持 `pending`、`error=null`；预热第一次命中 412 后不再请求空间页。
10. **本地可用性**（`test_local_reading_management_and_downloaded_media_stay_available_while_paused`、`test_input_validation_and_local_conflicts_still_win_while_paused`）：暂停期间归档读取、UP 列表、通知三态写入、删除监控配置与已全部成功的媒体本地结算（`{"processed":0,...}`）都正常且不产生上游请求；非法输入仍 422，已有配置仍 `409 ALREADY_MONITORED`，未知身份仍 404。
11. **普通错误对照**（`test_business_code_and_ordinary_errors_do_not_pause`）：业务码 `-412`（HTTP 200 的 JSON 字段）、500、网络异常都保持原分类与统计，不触发暂停，也不把异常原文带进状态响应。
12. **采集调度**（`test_risk_collector.py`）：`run()` 在受控时钟下第一个节拍检查命中 412 后暂停，随后三拍零发送；检查行仍是 `work=pending`、`last_checked_at/last_succeeded_at=null`、`check_error/sync_error=null`；`collector_paused` 只出现一次（同代次去重），`collector_tick paused=true` 仍每拍心跳。在途执行被暂停时保留 `running` 领取、不写 `SYNC_INCOMPLETE`／成功时间，重启恢复后回到 `pending`。
13. **真实双进程**（`test_risk_processes.py`）：真实 uvicorn API 进程＋真实采集子进程、同一临时 SQLite，来源与上传用本地 fixture（`risk_fixture.py`）。账本先证明采集进程在持续发送（2 秒内增长），API 角色单独触发 412 后账本停止增长 3 秒以上、API 自身也不再发送；另一进程检查行无新增错误。随后停掉两个进程、用同一库重启 API：`state`／`next_probe_at` 不变，`POST /api/sync/initial` 仍 503 且 `Retry-After` 在 1—60 秒；重启的采集进程同样零发送并自己记录 `collector_paused`。

## 3. 验收条件 → 证据

| 票据验收条件 | 证据 |
| --- | --- |
| 仅 HTTP 412／429 触发；其他状态、业务码、凭据、网络与内容受限的原处理不扩大，业务码 `-412` 不当 HTTP 412 | `test_only_http_412_and_429_trigger_the_pause`（403/500/502/503/200/无状态/异常均不触发）、`test_business_code_and_ordinary_errors_do_not_pause`（业务码 `-412`、500、`httpx.ReadError` 保持原 `{processed:1,succeeded:0,failed:1}`／`failed:1` 统计）、`test_profile_diagnostics.py::test_profile_risk_response_is_a_protection_signal_not_a_profile_failure`（412／429 走保护分支，不再写 `profile_lookup_failed`）；分类代码只看 `SourceReport.status_code in {412,429}` |
| SQLite 原子保存状态、代次、1 分钟首档期限与触发接口；不按 UP 拆分；重启不清零；迟到响应不连跳档 | `test_first_http_412_...`（60 秒、`generation=1`、`last_trigger`）、`test_late_risk_responses_...`（3 次迟到 429 不推进）、`test_migration_adds_a_single_normal_row_...`（单行 `singleton=1`）、`test_pause_survives_reopen_...`；`risk.migrate` 在 `Store.migrate` 的 `BEGIN IMMEDIATE` 内完成 |
| API 与 collector 真实独立进程共用状态；业务接口、预热、图片下载、手动初始化／媒体重试、重定向后续请求都不能绕过 | `test_risk_processes.py`（真实双进程＋同一 SQLite＋账本）；HTTPX 逐跳 412 由 `GatedAsyncTransport` 报告（01 用例 `test_httpx_transport_gates_each_redirect_hop` 仍在回归内）；Requests 逐跳在 `_SourceSession.send`（`test_requests_comment_session_gates_every_page_and_redirect_hop`）；图片 `test_risk_response_during_image_download_...`；手动初始化／媒体重试 `test_manual_sync_mid_chain_...`、`test_local_reading_...` |
| 响应层吞异常前报告，含原本忽略错误的预热；触发后不再翻页、预热或自动重试；已在途返回的数据按原版本／令牌规则安全提交 | `test_warmup_risk_response_pauses_and_stops_the_second_warmup`（预热仍不抛异常但状态已暂停，且不再预热第二个 URL）；`report` 记录后抛 `SourceRiskPaused`，`verify_author`（2）／`sync_body`（2）／`sync_roots`（1）／`sync_replies`（1）／`sync_media`（1）／`check_once`（3）／`discover_once`（1）／`_execute_target`（2）／`comment_client` 预热（2）／`run`／`execute_pending` 结算均在 `except Exception` 之前重新抛出（diff 可核）；已提交内容保留见 `test_risk_response_during_image_download_...`（第一张图 success＋已上传）与 `test_manual_sync_mid_chain_...`（正文工作与分页 checkpoint 不被清） |
| `GET /api/manage/risk` 只读本地状态，返回状态、进入时间、档位、可空探测时间、脱敏触发信息与探测摘要，不触发采集、不泄漏 owner／令牌 | `test_risk_status_is_read_only_and_never_triggers_collection`：两次 GET 响应一致、上游账本不变、拒绝 query（422）、写方法不生效（422，沿用既有 HTTP 错误映射）、序列化结果不含 `owner/lease/claim/token/http(s)://`；字段表见契约文档 |
| 需要源请求的管理与手动同步返回 `503 SOURCE_RISK_PAUSED`、固定提示、状态与可空时间，有未来截止时间附 `Retry-After`；原输入校验／本地冲突仍正常，不产生半成品或伪成功统计 | `test_http_412_on_one_entry_pauses_every_other_source_entry`（错误体固定五项＋`1<=Retry-After<=60`＋目标列表仍为空）、`test_manual_sync_mid_chain_pauses_without_fake_statistics`（无统计字段）、`test_input_validation_and_local_conflicts_still_win_while_paused`（422／409／404 优先） |
| 归档阅读、纯本地管理、停用／删除、已下载数据提交与 OSS 上传仍可用；后台保留 pending 与已有错误，不每节拍新增失败或伪造成功时间 | `test_local_reading_management_and_downloaded_media_stay_available_while_paused`（归档 GET、UP 列表、通知 PUT、DELETE 监控、已成功媒体本地结算 `processed=0`，全部零上游请求）；`test_risk_collector.py`（暂停后三拍零发送、检查行 `pending`＋时间 null、`collector_paused` 仅一条、`collector_tick paused=true` 心跳保留） |
| 状态存取失败禁止新源请求并返回存储错误；原子迁移保留归档、媒体、阅读 cursor 与未完成工作，不预占后续版本 | `test_state_storage_failure_blocks_sends_and_reports_storage_error`（删表后 503 `STORAGE_UNAVAILABLE`、零上游发送）、`test_unreadable_state_forbids_...`、`test_v23_database_gains_protection_state_without_touching_archives`（归档／根页／楼中楼分页逐字段相同、`foreign_key_check` 干净、v24 未预占 25）、`test_future_database_refuses_startup_without_downgrading`（25 拒绝且不回写） |
| 记录可关联的首次触发、暂停与被拒绝原因日志且脱敏，避免每 2.7 秒重复同一警告；补齐契约与必要固定错误提示，不新增页面 | 日志事件 `source_risk_triggered`／`source_risk_late_response_merged`／`source_risk_blocked`／`collector_paused`／`source_risk_paused_work_aborted`／`comment_session_warmup_paused`（每个状态代次一条，采集侧带 `attempt` 流水号；字段只有 `endpoint_type`/`http_status`/`backoff_step`/`risk_state`，无 URL、query、Cookie、正文、令牌）；前端只在既有 `httpError` 增加一条固定映射，无新页面；契约同步见 §6 |
| 真实双进程、同一临时 SQLite 与上游账本证明一进程触发后另一进程停止发送；重开保留剩余期限；普通错误对照与本地可用性回归通过 | `test_risk_processes.py`（真实 uvicorn＋采集子进程、账本前后对照、重开后 `next_probe_at` 不变且 `Retry-After` 有效、重启采集仍零发送）；普通错误对照见第 11 步，本地可用性见第 10 步 |

## 4. 关键设计决定

- **一个持久单行、一个 Interface**：`backend/bili_monitor/risk.py` 的 `RiskGate` 实现 01 的 `SourceGate`，`permit` 在发送前读状态、`report` 合并风控结果，状态在 `source_risk`（v24 单行）里：`state`、`generation`、`backoff_step`、`since`、`next_probe_at`、`observing_since`、`trigger_endpoint/status/at`、`probe_round_id/owner/lease_until/results`、`updated_at`。后四组是给 04／05 的 owner 租约与探测摘要预留的**列**，本票不写、不读成行为，也不加第二张表，避免后续迁移再撞版本。
- **记录即拒绝**：`report` 命中 412／429 时先落库，再抛 `SourceRiskPaused`，因此当前调用链拿不到该响应，天然不会继续翻页、重试、补预热；HTTPX 侧先 `await response.aclose()`、Requests 侧先 `response.close()` 再抛，避免连接泄漏。未触发的普通结果照旧返回，不改变既有分类。
- **`except Exception` 前的显式透传**：业务层有 17 处广谱异常处理（7 个模块）会把暂停折叠成既有失败分类。逐一加 `except SourceRiskPaused: raise`（而不是把 `SourceRiskPaused` 做成 `BaseException`），保持异常语义可读、可被 `except sqlite3/httpx` 等既有分支继续区分。
- **调度层两种动作分开**：`run` 每拍先读一次只读快照决定“不派发”，在途单元被打断时由 `_settle` 结算（不写检查结果／`sync_error`／成功时间／告警；`work` 保留 `running`，重启由既有 `recover_check_work`／`recover_discoveries` 归还），既有取消语义不变。暂停日志按**状态代次**去重，节拍心跳保留。
- **`permit`／`report` 是短事务且不取 pacing 锁**：DB 访问全部走 `anyio.to_thread.run_sync` 里的独立连接短事务，不持有 `Store` 长连接、不触碰 `SourcePacer` 的页级锁。01 证据里点名的「Requests 线程桥接时不得再取会话 pacing 锁」风险因此不成立（`ThreadSourceGate` 只桥接许可与报告，`RequestsCommentClient.get` 的锁与等待仍在发送前一步）。
- **失败即关闭**：状态读不出来（缺表、锁失败等 `sqlite3.Error`）时 `permit` 直接抛，HTTP 层沿用既有中间件映射为 `503 STORAGE_UNAVAILABLE`，绝不降级放行；`GET /api/manage/risk` 同样返回存储错误而不是伪造 `normal`。
- **触发接口的分类按域族**：图片类型从 01 的单一 `media_image` 拆成 `image_hdslb` 与 `image_biliimg` 两个受信域族（与设计 §4.4「受信 CDN 按图片域族区分」一致），04 的按类型探测与日志不会把两个拦截面混为一谈；`source_other` 兜底仍受许可。
- **迁移只加一张表**：`risk.migrate(connection)` 沿用 `outbox.migrate_*` 的“缺失才建、可重入”写法，由 `Store.migrate` 在 `BEGIN IMMEDIATE` 内调用；版本守卫从 23 抬到 24，未来版本拒绝启动。06 在并行根进度里用的版本号在合并时统一协调（本票未预占 25）。

## 5. 未覆盖与限制

- 未实现：六档到期探测、`probing`／`observing`／`manual` 状态转移、按接口类型探测与样本选择、观察期 10 分钟清零、`POST /api/manage/risk/probe`、owner 租约接管、`Retry-After`（429 响应头）对本地期限的抬升、页后 100ms 等待、分页持久续采、单路重型调度、每页业务 ID 日志、系统告警（属于 04／05／02／06—09）。
- 本票**到期不自动解除**：`next_probe_at` 过去后状态仍是 `cooldown`，`permit` 继续拒绝，`503` 不再带 `Retry-After`（没有未来截止时间）。这是 04 落地前的已知中间态，不用于生产发布。
- 在途工作被暂停后保留 `running` 领取：同一进程内不会自行归还，需重启走既有恢复。04 的恢复路径需要显式归还（属于 04 的范围，本票不预实现）。
- 页面侧只加了固定错误映射；没有风控面板、按钮或探测入口。`pnpm check:dist` 未跑（无构建产物变化）。
- 未验证：真实 B 站 412／429、真实 OSS／飞书、目标机部署与重启、长期运行下的日志量与 journald 保留、跨进程时钟偏差（持久时间为 UTC ISO，冷却比较用系统时间）。
- 遗留（与本票无关，未修）：`test_migrations.py::test_unexpected_transport_startup_failure_is_sanitized` 在 spec tip `1673dfe` 上即失败——01 的 `GatedAsyncTransport` 不转发 `__aenter__`，注入传输启动失败不再中止启动。建议由后续票据或主线处理。

## 6. 代码与文档指针

- 新增：`backend/bili_monitor/risk.py`；`backend/tests/test_risk_state.py`、`test_risk_pause.py`、`test_risk_collector.py`、`test_risk_processes.py`、`risk_fixture.py`。
- 修改（生产）：`app.py`（默认 `RiskGate`、`GET /api/manage/risk`、`SourceRiskPaused` 处理器）、`collector.py`（`risk` 注入、暂停不派发＋代次去重日志＋心跳、`_settle`、`open_collector` 共用同一 `Store`）、`source_gate.py`（`report` 可拒绝发送的契约说明、图片域族、报告拒绝时释放响应）、`contracts.py`（`SOURCE_RISK_PAUSED`、`error_response(details, headers)`）、`comment_client.py`（预热遇暂停不继续、报告拒绝时释放响应）、`sync.py`／`root_comments.py`／`replies.py`／`media.py`／`source.py`（风控穿透广谱异常）、`storage.py`（v24 迁移）。
- 修改（测试）：`test_migrations.py`（版本 24、未来版本 25、v23→v24 数据保留）、`test_profile_diagnostics.py`（412／429 改走保护分支，代表性普通错误改用 403／401／418，新增保护信号用例）、`test_notification_migration.py`／`test_inflight_recovery.py`／`test_three_process_delivery.py`（版本断言 23→24，机械改动）、`test_source_gate.py`（图片域族）。
- 修改（文档）：`docs/backend/api/collector-api.md`（新增「跨进程风控暂停（03）」含 `GET /api/manage/risk` 字段表）、`management-api.md`（`SOURCE_RISK_PAUSED` 契约、v24 与失败即关闭、不新增风控页面）、`archive-api.md`（手动初始化／媒体重试 503）、`discovery-api.md`（发现与预热同受暂停）、`docs/deployment/static-delivery.md`（schema v24 与保护状态随库持久）、`docs/design/bilibili-risk-control.md`（状态行与 §5“已实施／待实施”边界）、`docs/README.md`（本票证据入口）、`backend/README.md`（生产默认 `RiskGate`、暂停语义与专项命令）。
- 修改（前端）：`frontend/src/manage/managementApi.ts`（`503 SOURCE_RISK_PAUSED` → 固定中文提示，仍只按错误码映射）、`frontend/tests/unit/management-api.test.ts`（同一组固定映射断言）。

## 7. 供 04／05／08 复用的 Interface

- `risk.RiskGate(store)`：`permit(request)`／`report(request, report)`（`SourceGate`，01 既有 seam）；`status()` 只读公开形状；`pause()` 只读快照（`None` 表示 `normal`）。
- `risk.paused_response(status)`：`503 SOURCE_RISK_PAUSED`＋固定提示＋`state`／`backoff_step`／`next_probe_at`＋可空 `Retry-After`；`risk.retry_after_seconds(next_probe_at, now=None)` 供其他入口复用同一算法。
- `risk.COOLDOWN_STEPS`（60／120／240／480／900／1800 秒）与 `risk.migrate(connection)`；`source_risk` 已留 `probe_round_id`／`probe_owner`／`probe_lease_until`／`probe_results`／`observing_since` 列，04／05 只补状态转移与探测执行，不再加表。
- `SourceRequest.endpoint_type` 的固定枚举（含 `image_hdslb`／`image_biliimg`）是 04 按类型探测的类型键；`Collector(..., risk=...)` 与 `open_collector(..., source_gate=...)` 是 08 接入单路调度时复用的装配点。
- 采集侧约定：单元被打断时抛 `SourceRiskPaused`，由 `Collector._settle` 结算；新增执行路径若在内部 `except Exception`，必须先 `except SourceRiskPaused: raise`，否则会被折叠成普通失败。
