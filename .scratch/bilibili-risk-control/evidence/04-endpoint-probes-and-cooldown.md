# 04 六档冷却与分接口探测：实施与验收证据

对应票据：[04 六档冷却与分接口探测](../issues/04-endpoint-probes-and-cooldown.md)；正式规则：[B 站限流／风控保护与全量归档续采](../../../docs/design/bilibili-risk-control.md) §4.2、§4.3、§4.4（另含 §4.1 的状态机与 §6 日志字段）；实施与测试决策：[父规格](../spec.md)「实施决策 8—11」「测试决策」；运行契约：[采集契约](../../../docs/backend/api/collector-api.md#六档冷却与按接口探测04)、[管理契约](../../../docs/backend/api/management-api.md#来源保护状态票据-03)。

结论：**本票范围（六档到期探测、按接口类型探测、唯一 owner 租约、失败短路、无样本保持暂停、全部通过进入 observing 并恢复原断点）已实施并有隔离自动化证据**，包括真实双进程（API＋采集）与真实独立领取／提交进程、同一临时 SQLite、共享文件时钟与传输账本。观察期 10 分钟清零、`POST /api/manage/risk/probe` 人工登记仍属 05；页后 100ms 等待的完整覆盖（增量／重试／尾页）属 02／07，本票只在楼中楼探测上复用同一路径与等待。未访问真实 B 站、OSS 或飞书，未部署、未重启任何环境。

## 1. 环境与命令

- 环境：Linux，Python 3.12.15，`uv sync --locked`；pytest 8.4.2、httpx 0.28.1、requests 2.34.2、fastapi 0.115.12（`uv.lock`／`pyproject.toml` 未改）。
- 分支：`wt/bilibili-risk-control-04`，切自 `spec/bilibili-risk-control` 的 `d65b56c`，交付前合入 06 的 `c9f3b45`（页进度独立迁移 v25，风险仍为 v24 `source_risk` 字段，未改表）；合并无冲突，06 的根步骤机 `SourceRiskPaused` 透传与 `page_scan_progress` checkpoint 原样保留。
- 代码定位：本工作树无 `.codegraph/` 索引（按 `docs/agents/codegraph.md` 的跳过条件），回退到源码阅读与 grep，入口清单与 `/tmp/bilibili-risk-control-notes.md` 一致（该文件在本机已不存在，实际以仓库源码为准）。
- 新增用例：`backend/tests/test_risk_cooldown.py`（13）、`backend/tests/test_risk_probe.py`（6）、`backend/tests/test_risk_probe_processes.py`（2，真实多进程）＋共享 fixture `backend/tests/risk_probe_fixture.py`；`backend/tests/test_comment_session.py` 增 1 例（探测取会话不预热）。
- 票范围命令与结果：
  - `uv run --no-sync pytest backend/tests/test_risk_cooldown.py backend/tests/test_risk_probe.py backend/tests/test_risk_probe_processes.py -q` → **21 passed**（含 2 个真实进程用例，约 11 秒）。
  - 风控与相关回归（23 个文件，含 03 四文件、06 根续采、迁移、传输、分页节奏、资料诊断）：**536 passed**。
  - 全量：`uv run --no-sync pytest backend/tests -q` → **1166 passed**（合并 `c9f3b45` 后；03 证据记录的票前既有失败已由 01 的后续提交修复）。
- 前端：本票没有新增错误码，也没有页面／交互改动（`GET /api/manage/risk` 仍未被前端消费，`503 SOURCE_RISK_PAUSED` 映射已在 03 落地），因此未改 `frontend/`，未跑 `pnpm check`（工作树无 `node_modules`，安装需联网）。

## 2. 红绿过程（TDD，纵向切片）

1. **持久状态机**（`test_risk_cooldown.py`）：先写「六档各等满时长、恰到期才领取、失败只推进一档、第六档转 manual」的失败用例，再在 `risk.py` 实现
   `claim_probe`／`record_probe`／`finish_probe`，并让 `permit` 只在 `normal`／`observing` 放行、`report` 在 `observing` 再次触发时推进一档、第 6 档后再触发转 `manual`。
2. **Retry-After**（同文件）：`parse_retry_after` 接受 delta-seconds 与 HTTP-date，非法值返回 `None`；`_deadline` 取「本地档位」与「服务端要求」的更晚者。红在「429 带 600 秒仍只等 60 秒」。
3. **异常时钟与重启**：`next_probe_at`／`probe_lease_until` 不可解析时按“未到期／无有效租约”处理——期限损坏不提前探测也不放行，租约缺失允许唯一接管但仍要探测通过；重开库保留剩余期限，启动本身不探测。
4. **唯一 owner 与 fencing**：租约内二次领取返回 `None`；租约过期后新 owner 新轮次重新冻结类型；旧 owner 的 `record_probe` 返回 `False`、`finish_probe` 返回 `None`，状态仍属新 owner。
5. **探测执行器**（`risk_probe.py`）：先写「真实 Collector 运行 + 传输账本」用例再实现
   `required_types`／`ordered_types`／`RiskProber.probe_if_due`／`_probe`。红在「冷却后没有探测、类型集合拍脑袋、失败后继续请求」。
6. **类型集合只跟当前工作**：`Store.risk_probe_facts` 用一个只读快照给出已存 locator、已知有回复的根、受信图片来源、启用 recent 与 pending 工作；`required_types` 据此推导，测试锁定「有 pending 工作才有根页／楼中楼，已知有回复的根才有楼中楼，未成功媒体才有对应图片族」。
7. **样本缺失与业务失败**：`ProbeSampleMissing` → `failed` + `reason=sample_missing` + 零请求；HTTP 200 但业务码拒绝 → `failed` + `reason=source_rejected`；412／429 → `reason=source_risk`；三种情况都不写检查失败／`sync_error`，也不扩大普通错误分类。
8. **失败短路**：`replies` 失败后 `detail`／`opus_page` 保持 `pending` 且账本里没有这两个请求；整轮只推进一档。
9. **楼中楼同路径探测**：`_reply_page` 在生产 `RequestsCommentClient` 上直接调用（该客户端的 `get()` 已覆盖“发送＋完成＋100ms”），只读取 `last_reply_page` 作为诊断；测试用真实 `_SourceSession` 语义的薄替身断言“只等待一次 0.1 秒”，不会双层等待。
10. **不预热**：`RequestsCommentClientFactory.client(uid)` 取会话但不触发首页／空间预热；探测只用它，用例断言会话上没有预热请求。
11. **真实多进程**（`test_risk_probe_processes.py`）：一次性进程负责触发／领取／提交，父进程只写共享 `clock.txt`，证明跨进程唯一领取、到期接管与旧 owner fencing；第二个用例启动真实 API 与真实采集进程，冷却期间零发送、到期自动探测、进入 `observing` 后把在途 `running` 领取归还并继续到完成。

## 3. 验收条件 → 证据

| 票据验收条件 | 证据 |
| --- | --- |
| 六档 1／2／4／8／15／30 每档到期实际探测；任一类型未通过立即结束整轮并只推进一档；第六档失败进 manual，不采用旧三次失败方案 | `test_every_step_waits_its_full_duration_then_probes_once`（逐档校验恰到期前 `None`、恰到期领取、失败后 `backoff_step+1`、末档 `manual` 且此后不再领取）、`test_round_with_every_type_passed_enters_observing_and_keeps_the_step`、`test_trigger_during_observation_advances_one_step_and_sixth_goes_manual`；真实进程 `test_probe_owner_is_unique_across_processes_and_takeover_fences_the_old_owner` |
| 合法 Retry-After 不被更短本地期限覆盖；受控时间验证恰到期／未到期、重启剩余期限和异常时钟，不能以启动或时间异常绕过暂停 | `test_legal_retry_after_is_never_shortened_by_the_local_step`（触发 600 秒、探测失败 3600 秒）、`test_invalid_retry_after_values_are_ignored`、`test_retry_after_header_from_the_transport_extends_the_deadline`（HTTPX）、`test_comment_request_session_forwards_retry_after_before_rejecting`（Requests 逐跳）、`test_remaining_deadline_survives_reopen_without_probing_on_startup`、`test_abnormal_clock_and_missing_lease_never_bypass_the_pause` |
| 每轮冻结「触发接口类型 ∪ 当前待执行任务所需类型」，按主机／路径模板划分，不按动态 ID／根 ID／页码；图片按受信域族归类 | `test_required_types_only_covers_work_that_is_actually_pending`（有 pending 工作才含根页／楼中楼；无工作为空集）、`test_probe_round_covers_every_needed_type_with_minimal_gets`（账本逐类型恰好一次，同类多 ID 不扩增）、`risk_probe_fixture` 真实进程账本 `['root_comments','comment_count','detail','opus_page','image_hdslb']` |
| 计数、根页、楼中楼、feed、detail、网页、UP 资料、首页／空间预热及图片类型分别有最小有效 GET 和对应原解析校验；不以 count／资料成功替代其他类型；图片不用 HEAD | `RiskProber._run` 直接调用生产的 `fetch_comment_count`／`fetch_root_page`／`fetch_reply_page`／`discover_recent(pages=1)`／`fetch_detail`／`fetch_page`／`fetch_profile`／`download`；`test_probe_round_covers_every_needed_type_with_minimal_gets` 断言五类各自的请求与 `status=passed`、`http_status=200`；真实进程用例断言探测方法集合为 `{"GET"}`（fixture 对非 GET 直接失败）；`test_missing_local_sample_is_unconfirmed_not_a_fake_pass` 证明没有样本时零请求 |
| 使用正式凭据、代理及统一发送／等待规则；楼中楼探测同样等待 100ms；不暗中预热、不无限找样本；没有已知有效样本记未确认恢复 | `test_reply_probe_goes_through_the_production_comment_session_for_one_hundred_ms`（真实 `RequestsCommentClient.get` 路径、只等待一次 0.1 秒、`wait_ms=100`、会话上无预热请求）、`test_probe_client_reuses_the_session_without_warming_up`、`test_missing_local_sample_is_unconfirmed_not_a_fake_pass`（`sample_missing` + 下一档）；`open_collector` 的探测装配复用同一 cookie／event hooks／`SourcePacer`／`ReplyPagePacer` |
| HTTP 200 但业务／资源校验失败仍不放行；非 412／429 的探测失败只表示本轮未通过、不扩大普通错误分类；一个失败后不再请求其余类型 | `test_invalid_200_or_risk_response_short_circuits_and_advances_exactly_one_step`（业务码 `-412` 的 200 → `source_rejected`；429 → `source_risk`；两者都只剩前三类请求、`detail`／`opus_page` 为 `pending`）、`test_probe_round_covers_every_needed_type_with_minimal_gets` 的 `snapshot(store)` 前后相等（归档、检查、通知、媒体都未变） |
| SQLite 持久保存轮次、结果与唯一 owner 租约；真实多进程不能同时领取；崩溃后租约到期才可接管，旧 owner 不能提交，接管重新确认类型 | `test_probe_owner_lease_fences_the_old_owner_and_allows_takeover`；真实进程 `test_probe_owner_is_unique_across_processes_and_takeover_fences_the_old_owner`（两次 `claim` → 第二次 `None`；`clock+301` 后新 owner／新轮次／新类型；旧 owner `finish` 返回 `null`，状态仍属新 owner） |
| 探测只验证可用性，不推进归档 checkpoint／成功时间／通知基线，不生成业务通知；全部通过进入 observing 并允许正常调度，不补发错过的检查 | `test_probe_round_covers_every_needed_type_with_minimal_gets` 与失败用例的 `snapshot` 全等；`Collector.run` 的错槽跳过逻辑未改（`collector_ticks_skipped` 语义保留）；`test_collector_run_probes_at_each_deadline_and_resumes_abandoned_work`（observing 后按原断点继续到 `work=complete`）；真实进程用例断言 `sync_error` 仍为 null、归档最终 `comments/replies=success` |
| 状态查询能区分本轮待探测、通过、失败及下一档时间；记录类型、轮次、耗时、等待、失败原因与可用业务 ID，保持脱敏 | `test_public_status_is_distinguishable_and_never_leaks_owner_or_lease`、`test_status_endpoint_reveals_probe_round_without_triggering_any_probe`（HTTP `GET /api/manage/risk` 显示 `probing`、`failed`／`pending`、拒绝 query、响应不含 owner／lease／URL）；结果项含 `endpoint_type/status/http_status/reason/elapsed_ms/wait_ms/uid/dynamic_id/root_id` |
| 用实际 API／collector、真实临时 SQLite、受控时钟和传输账本验证完整阶梯、类型覆盖、失败短路、跨进程重启及无业务副作用，更新恢复与状态契约 | 上述新用例全部走真实装配（`create_app`／`Collector.run`／真实 Store／真实子进程，只替换传输与时钟）；契约更新见 §6 |

## 4. 关键设计决定

- **状态机只在持久状态层**：`risk.RiskGate` 仍是 01 的 `SourceGate` 实现；新增 `claim_probe`／`record_probe`／`finish_probe` 三个短事务，网络与解析都在事务外。`normal`／`observing` 放行普通发送，`cooldown`／`probing`／`manual` 拒绝；一次状态转移只 +1 代次，迟到合并仍不推进。
- **复用 03 的 v24 列，不加表**：轮次、owner、租约、冻结类型与逐类结果都写 `source_risk.probe_*`，`probe_results` 从“最近摘要”变成“本轮逐类型 `pending|passed|failed`”，因此 `GET /api/manage/risk` 天然能区分三种状态与下一档时间。06 的 v25 迁移独立，未与本票字段冲突。
- **轮次是纯数字关联号**：`probe_round_id` 用随机大整数（可进日志白名单），owner 用 uuid hex 且不对外暴露；这样既能记 `probe_round_id` 又不会把内部领取令牌写进日志。
- **探测走真实解析，不走第二条业务链**：探测直接调用生产 `fetch_*`／`discover_recent`／`ImageDownloader.download`，因此业务码、资源校验、主机白名单与超时都一致；只有“是否取发送许可”不同——探测期间许可本来就拒绝普通请求，唯一性改由 owner 租约保证。
- **探测客户端的装配**：`open_collector` 另建一套不受许可的客户端（同一 `source_transport`／`media_transport`／cookie hooks／`SourcePacer`／`ReplyPagePacer`），并获得 `RequestsCommentClientFactory` 的**不预热**会话入口，避免探测暗补首页／空间预热；探测客户端不随普通 traffic 共用连接池，也不进入 OSS／通知。
- **类型集合由本地事实推导而不是写死清单**：`Store.risk_probe_facts` 只读一次快照，`required_types` 用“当前工作真正需要”的谓词；没有工作用到的功能（例如没有 recent 监控时的 feed）不探测，避免把探测本身变成额外流量。
- **失败即关闭 + 样本不足保持暂停**：期限／租约不可解析都按保守方向处理；没有样本直接记 `sample_missing` 并推进一档，不用 404／HEAD／匿名请求凑“通过”。
- **采集进程驱动、进程内不需要重启**：`Collector.run` 每拍先读完整状态；`cooldown`／`probing` 到期就调用 `probe_if_due()`。进入 `observing` 后在没有在途任务时调用既有 `recover_check_work`／`recover_discoveries`，把上次被暂停打断的 `running` 领取归还为 `pending`。这修掉了 03 留下的“需重启才能继续”的中间态，但没有引入第二套恢复机制。
- **节拍与错槽语义不变**：暂停期间仍不派发、错过的节拍不补发；探测在一次节拍内同步完成（可能跨多次真实 I/O），期间不派发业务工作。

## 5. 未覆盖与限制

- 未实现（属 05／02／06—09）：观察期“连续正常采集 10 分钟才清零档位”、`POST /api/manage/risk/probe` 人工登记与 `409 RISK_PROBE_NOT_ALLOWED`、系统告警生命周期、页后 100ms 的增量／重试／尾页全覆盖验证、单路重型调度、分页续采的日志 ID 全覆盖。
- **样本来源只有本地已存事实**：触发接口本身不记录业务 ID（03 只存接口类型与 HTTP 状态），所以如果触发资源尚未成功归档（例如首次目标校验就被拦），对应类型可能没有样本，本轮会按“未确认恢复”推进一档并最终转人工。这是有意的 fail-closed 取舍，不是遗漏；人工恢复入口由 05 提供。
- **观察期的迟到响应**：`report` 在 `observing` 遇到真实 412／429 会按设计推进一档；如果这是暂停前发出的极迟到响应，也会被当成一次新触发（只会推进一档，不会连跳）。当前没有把发送时代次带进报告，属已知保守行为。
- **探测类型的判定是本票的实现选择**：`required_types` 以“当前实现真正会请求的接口”为准（例如有 pending 工作才要求根页／楼中楼）；后续若 06／07 改变分页路径或 08 改变调度，需要同步复核该谓词，避免多探测或少探测。
- 未验证：真实 B 站 412／429 与 Retry-After、真实代理行为、真实 OSS／飞书、目标机部署与重启、长期运行下探测日志量与 journald 保留、跨机器时钟偏差。
- 前端未改：无新增错误码与页面；`GET /api/manage/risk` 的新 `probe.results` 结构尚未被前端消费（本票不新增风控页面）。

## 6. 代码与文档指针

- 新增（生产）：`backend/bili_monitor/risk_probe.py`（类型集合、样本选择、串行探测执行与短路）。
- 修改（生产）：`risk.py`（六档奖励／Retry-After／`probing`／`observing`／`manual` 转移、owner 租约与 fencing、`parse_retry_after`、`paused_response(now=)`）；`collector.py`（`probe` 注入、到期探测驱动、observing 恢复在途中止领取、探测客户端装配）；`comment_client.py`（`SourceReport.retry_after` 转发、`RequestsCommentClientFactory.client` 不预热入口）；`source_gate.py`（`SourceReport.retry_after`、HTTPX 逐跳转发响应头）；`storage.py`（`risk_probe_facts` 只读快照）；`discovery.py`（`discover_recent(pages=)`，探测只取首批）；`collector_logging.py`（`correlation_id`）；`app.py`（`risk_clock` 注入、`Retry-After` 用同一时钟）。
- 新增（测试）：`backend/tests/test_risk_cooldown.py`、`test_risk_probe.py`、`test_risk_probe_processes.py`、`risk_probe_fixture.py`；`test_comment_session.py` ＋1。
- 文档：`docs/backend/api/collector-api.md`（新增「六档冷却与按接口探测（04）」与状态字段更新）、`docs/backend/api/management-api.md`（保护态 `state`／`next_probe_at` 语义）、`docs/backend/api/archive-api.md`、`docs/backend/api/discovery-api.md`、`docs/design/bilibili-risk-control.md`（状态行与 §5 已实施边界）、`docs/deployment/static-delivery.md`（schema v25 与探测租约）、`backend/README.md`、`docs/README.md`。

## 7. 供 05／08 复用的 Interface

- `risk.RiskGate.claim_probe(endpoint_types)` → `{"round","owner","types"}`／`None`；`record_probe(claim, result)`；`finish_probe(claim, passed, retry_after=None)`。05 的人工探测只需在 `manual` 下把“已登记一轮”持久化，然后复用同一 `claim_probe`（当前实现对 `manual` 返回 `None`，05 按登记事实放开即可），不需要第二套探测执行器。
- `risk.RiskGate.snapshot()` 返回完整公开状态；`status()` 同义只读；`risk.paused_response(status, now=None)` 供其他入口复用同一 `Retry-After` 算法。
- `risk.COOLDOWN_STEPS`、`risk.PROBE_LEASE_SECONDS`、`risk.BLOCKED_STATES`、`risk.ACTIVE_STATES`、`risk.parse_retry_after`：05 的稳定清零／人工态判断与 09 的告警分类直接复用这些常量。
- `risk_probe.RiskProber(store, gate, client, *, comments=None, downloader=None, clock=None, reply_page_pacer=None)` 与 `risk_probe.required_types`／`ordered_types`：08 若改变调度，只需复核 `required_types`；探测执行本身不改。
- `Collector(..., probe=...)` 与 `open_collector(..., risk_clock=..., probe=...)`：采集侧的接线点；`_resume_abandoned` 是 05 观察期结束后可复用的“归还在途领取”动作。
- 观察期实现建议：05 在 `observing` 下用 `store` 的 `last_succeeded_at` 与成功业务请求计数判断 10 分钟，满足后把 `state` 写回 `normal` 并清零 `backoff_step`；`generation` 递增即可让采集进程的 `_resumed_generation` 守卫自然重新评估。
