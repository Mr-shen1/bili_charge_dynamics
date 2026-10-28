# 02 楼中楼分页等待与基础流程日志：实施与验收证据

对应票据：[02 楼中楼分页等待与基础流程日志](../issues/02-reply-pacing-and-flow-logs.md)；正式规则：[B 站限流／风控保护与全量归档续采](../../../docs/design/bilibili-risk-control.md) §3.2、§6、RC-03／RC-10；实施范围与测试决策：[父规格](../spec.md)「实施决策 3、16、17」「测试决策」；运行契约：[采集契约](../../../docs/backend/api/collector-api.md#分页请求节奏-30)、[后端 README](../../../backend/README.md#30-分页请求间隔)。

结论：**本票范围（楼中楼每页请求后 ≥100ms 等待 + 正常流程结构化日志）已实施并有隔离自动化证据**，且已合入 03 的集成 tip（`3a72c4a`）；交付前还修掉了 01 引入的启动生命周期回归（注入 transport 的 `__aenter__` 不再被执行，导致启动失败被当成可服务状态），全量后端 **1136 passed、0 failed**。真实归档链上的每一次楼中楼分页请求（首次全量、末页倒序增量、失败、空尾页复查、以及未来探测复用的同一条 `client.get(REPLIES_URL, …)` 路径）结束后都等待至少 100ms，发送与等待在同一串行段内、多调用者不能交错绕过；第一个请求前不加等待、最后一页后仍执行；来源零回复或未展开的楼不再缴纳楼级等待。INFO 日志能仅凭日志串起发现、检查、领取／跳过、正文、根页、楼中楼页、媒体与整轮结果，并带字符串 UID／动态 ID／根评论 ID／每页全部已校验回复 ID、页码、方向、数量、耗时与等待；超长 ID 列表按同一关联号分块。未访问真实 B 站、未部署、未改 `storage.py`、未新增迁移、未接 03／04／06 的行为。

## 1. 环境与命令

- 环境：Linux，Python 3.12.15（`uv run`），uv；pytest 8.4.2，httpx 0.28.1，requests 2.34.2，fastapi 0.115.12（`uv.lock`／`pyproject.toml` 未改）。
- 分支：`wt/bilibili-risk-control-02`，本票实施起点为 `spec/bilibili-risk-control` tip `1673dfe`；交付前该 tip 已推进到 **`3a72c4a`（03 合入）并 merge 进本分支**（冲突解析见 §2 第 11—12 步），合并后全量重跑绿灯。
- 隔离：真实 `Store`＋临时 SQLite 文件；B 站响应为仓库内虚构 fixture；HTTPX 用 `httpx.AsyncBaseTransport` 替身或 monkeypatch `AsyncHTTPTransport.handle_async_request`；Requests 用 monkeypatch `Session.get`（保留生产 `_SourceSession` 发送、Cookies、解析与提交链路）；时间用 `ReplyPagePacer(sleep=…, clock=…)` 与 `ControlledClock`。没有真实 B 站、OSS 或飞书流量。
- 代码定位：本工作树没有 `.codegraph/` 索引（`docs/agents/codegraph.md` 的跳过条件），按约定回退到源码阅读与 grep。上下文指针 `/tmp/bilibili-risk-control-notes.md`、`/tmp/bilibili-risk-control-review-context.md` 在本机不存在，改用仓库内 spec／design／01 证据。
- 新增用例：`backend/tests/test_reply_page_pacing.py`（6 例）、`backend/tests/test_flow_logs.py`（4 例）。
- 新增与改动生产代码：`backend/bili_monitor/reply_pacing.py`（新）、`comment_client.py`、`app.py`、`collector.py`、`replies.py`、`root_comments.py`（仅日志）、`sync.py`、`media.py`、`collector_logging.py`。`storage.py`、`contracts.py`、迁移与通知代码未改。
- 票范围回归（27 个文件，见 §4）：`uv run pytest backend/tests/test_reply_page_pacing.py backend/tests/test_flow_logs.py backend/tests/test_source_pacing.py backend/tests/test_source_gate.py backend/tests/test_replies.py backend/tests/test_reply_incremental.py backend/tests/test_root_comments.py backend/tests/test_comment_sync_status.py backend/tests/test_collector.py backend/tests/test_collector_cadence.py backend/tests/test_comment_count_sync.py backend/tests/test_comment_count_recovery.py backend/tests/test_initial_archive.py backend/tests/test_full_archive.py backend/tests/test_inflight_lifecycle.py backend/tests/test_inflight_recovery.py backend/tests/test_integrated_archive_lifecycle.py backend/tests/test_comment_transport.py backend/tests/test_comment_session.py backend/tests/test_dynamic_media.py backend/tests/test_comment_media.py backend/tests/test_management.py backend/tests/test_discovery_source.py backend/tests/test_deployment_processes.py backend/tests/test_service_processes.py backend/tests/test_three_process_delivery.py backend/tests/test_migrations.py -q` → 实施当时 **664 passed, 1 failed**（唯一失败即下文回归，现已修复）。
- 该失败 `test_unexpected_transport_startup_failure_is_sanitized`（`test_migrations.py`）**不是票前既有失败，而是 01 在 `86f6149` 引入的回归**：01 把 `GatedAsyncTransport` 插到 `AsyncClient` 与注入 transport 之间时没有转发 `__aenter__`／`__aexit__`，而 `httpx` 客户端进入时只进入最外层 transport，被包装 transport 的启动钩子因此不再执行。实施当日的「在 `1673dfe` 上 stash 复核仍失败」只证明它在集成 tip 上已经红，不能证明它早于 01；`4c47264`（实施前基线 1091 passed）下该用例实际是绿的（复现见 §2 第 11 步）。修复提交 `d4833c7`，防护用例见 §2 第 11 步。
- 全量：实施中 `uv run pytest backend/tests -q` → **1107 passed, 1 failed**（即上述回归）；修复后 **1110 passed**；合入 03（`3a72c4a`）并解冲突后 **1136 passed, 0 failed, 3 warnings in 252.96s**（见 §4）。

## 2. 红绿过程（TDD，纵向切片）

1. **每页真实请求后 ≥100ms（真实归档链）**：先写 `test_every_real_reply_page_waits_after_response_through_real_archive_chain`，红 `ModuleNotFoundError: No module named 'backend.bili_monitor.reply_pacing'`。新增 `reply_pacing.py`（`ReplyPagePacer.page()` 在同一个锁里包住「发送 → 完成 → 等待」，`PageTiming` 分开记 `elapsed_ms`／`wait_ms`），在 `RequestsCommentClient.get` 里按 `source_request(...).endpoint_type == "replies"` 包住真实发送，并把 pacer 从 `create_app(reply_page_pacer=…)`／`open_collector(reply_page_pacer=…)`／`RequestsCommentClientFactory` 一路注入。转绿后账本恰为 `send 1 → done 1 → wait 0.1 → send 2 → done 2 → wait 0.1 → send 2 → done 2 → wait 0.1`：首请求前没有等待，空尾页复查（第三次请求）之后仍等待。
2. **失败也等待**：`test_failed_reply_request_still_pays_the_page_wait` 断言失败页之后紧跟 `("wait", 0.1)`；上一片的生产代码直接转绿（`finally` 里等待），属于补覆盖。
3. **跨调用不可交错**：`test_two_callers_cannot_interleave_past_the_page_wait` 用两个 `RequestsCommentClient` 共享同一个 `ReplyPagePacer` 与虚拟时钟，断言 `send[1] >= done[0] + 0.1`、`send[2] >= done[1] + 0.1`（虚拟时间下即 0.0／0.1／0.2）。同一片还覆盖了「第一个请求前不额外等待」。
4. **楼级等待只在实际展开后**：`test_zero_reply_root_pays_no_page_or_per_root_wait` 在固件里第二栋楼来源 `rcount=0`，首轮先红 `assert 2 == 1`（两栋楼都缴了 0.3–0.4 秒）。改 `replies.sync_replies`：用一个局部 `fetch_page()` 包装记录「本楼是否真的发出过请求」，`finally` 里只在 `expanded` 为真时 `sleep_after_root`；跳过楼（`scan_due` 不满足）与零回复楼都不再等待，实际展开后仍是 0.3–0.4 秒。
5. **末页倒序增量与探测同路径**：`test_incremental_tail_pages_share_the_same_wait_and_log_reverse_direction` 直接驱动生产 `fetch_reply_tail`＋生产 Requests 客户端（25 条回复 → 请求第 1、2 页），断言发送时刻 0.0／0.1 且两条日志 `direction=reverse`；这证明探测只要复用同一 `client.get(REPLIES_URL, …)` 就自动获得等待，不存在「另一条无等待的请求路径」。
6. **等待不占 SQLite 写事务**：`test_reply_page_wait_holds_no_sqlite_write_transaction` 在页后等待内部另开连接做 `BEGIN IMMEDIATE`＋`UPDATE`（`timeout=0.1`），三次等待全部成功；若同步还持有写事务会立刻 `database is locked`。
7. **日志业务 ID 与页摘要**：先写 `test_initial_archive_logs_business_ids_pages_and_waits`，红在 `'uid="900719925474099312345"' in 'body_sync_finished outcome=success accepted=true'`（旧 `_safe_value` 只放行枚举字符串，业务 ID 一律退化成 `unknown`）。扩展 `collector_logging.py`：新增 `SourceId`／`SourceIds`（只接受 `is_valid_id` 的字符串，整数原样转字符串）与 `source_refs()`，`SourceIds` 超 `ID_FIELD_CHARS=300` 时按同一事件拆多行并带 `ids_part`/`ids_chunks`/`ids_total`；其他字符串仍渲染 `unknown`，保密过滤没有被放宽。随后给正文、根页、楼中楼页、保存、媒体与整轮事件补字段：`body_sync_finished`（`uid`/`dynamic_id`）、`root_page_saved`（`page`/`direction`/`fetched`/`comment_ids`/`elapsed_ms`）、`reply_page_fetched`（`endpoint_type=replies`/`page`/`direction`/`fetched`/`reply_ids`/`elapsed_ms`/`wait_ms`）、`reply_page_saved`（`new`/`updated`/`accepted`）、`media_sync_finished`（`processed`/`succeeded`/`failed`）、`reply_sync_failed`（另加 `elapsed_ms`/`wait_ms`）。
8. **长页 ID 分块而非截断**：`test_long_reply_page_splits_ids_into_chunks_without_dropping_any` 首轮红 `assert 0 == 2`（没有分块事件）；实现分块后一页 20 条长 ID 输出 2 行，两行解析出的 ID 合集与全集完全相等。
9. **采集进程链路**：`test_collector_logs_uid_claims_and_round_result` 走真实 `open_collector` 装配（发现 → 检查 → 领取 → 同步 → 整轮结果），红在 `discovery_started` 缺 `uid`；补 `collector.py` 的 `discovery_started/finished`（含 `dynamic_ids`）、`check_started/finished/skipped`、`sync_started/skipped/finished` 业务 ID 后转绿，并追加「无 URL／无 `token=`／无 `FICTIONAL`」负向断言。
10. **测试自身纠错（生产分类未因此改动）**：① 首版装配替身把根页返回成空 body，导致 `root_sync_failed reason=json_invalid`／`reply_sync_failed reason=internal_error`——核对后是替身漏了根页，改为非预热路径统一转发虚构来源；② 根评论固件带一张 `example.invalid` 评论图，媒体会因不可信域失败，按「只验证动态图片链路」清掉评论图片；③ SQLite 写锁用例最初写 `UPDATE ups`，核对迁移后发现表名是 `identities`；④ 分块用例解析需要 ID 对象可比较，给 `SourceId` 补 `__eq__`/`__hash__`/`__repr__`。

11. **收口：修复 01 引入的启动生命周期回归（`d4833c7`）**。全量红灯不允许交付，先按真实公开入口复现：`uv run pytest backend/tests/test_migrations.py::test_unexpected_transport_startup_failure_is_sanitized -q` → 红在 `Failed: A failed transport must not serve requests`——注入 `BrokenStartup` 后应用照常启动并对外服务。根因用只读 worktree 定位：`git worktree add --detach … 4c47264` 下同一用例 **1 passed**（基线绿），`86f6149` 把注入 transport 改为 `GatedAsyncTransport(profile_transport, gate=gate)`，而该包装只实现 `handle_async_request`／`aclose`，继承的 `AsyncBaseTransport.__aenter__` 只 `return self`；`AsyncClient.__aenter__` 只进入最外层 transport，内层 `__aenter__` 永不执行，启动期失败随之消失。修复是让包装层把 `__aenter__`／`__aexit__` 原样转交内层（`raise RuntimeError("Application lifecycle failed") from None` 与 `except Exception` 的脱敏路径原样保留，未知启动异常仍拒绝启动、不进消息与日志），发送许可与分页等待未改。补两条防护用例把行为钉住：`test_gated_transport_forwards_inner_lifecycle_and_closes_it_once`（内层进入一次、退出时恰好关闭一次；去掉转发即红——进入事件为空，证明它测的是转发而不是「顺带发送」）、`test_gate_report_rejection_propagates_instead_of_being_swallowed`（gate 在报告 412 时拒绝，保护异常必须穿过接入层）。
12. **收口：合入 03 集成 tip（`3a72c4a`）并解冲突**。`app.py` 冲突只在 docstring（两边分别写了 `RiskGate` 默认 gate 与 `reply_page_pacer`，取并集）；`comment_client.py`／`media.py`／`replies.py`／`root_comments.py` 的冲突是导入与单行事件（导入取并集，`reply_root_finished` 同时保留 02 的业务 ID 与 03 的 `except SourceRiskPaused: raise`）；`docs/README.md` 证据行合并 02／03 两段并修正「尚未实施」清单。合并后核对两条不许丢的边界：预热仍 best-effort，但 `SourceRiskPaused` 先于 `except Exception` 被识别（`comment_client.prepare`／`WarmupCache._run`）；`GatedAsyncTransport` 保留 03 的「报告拒绝时先 `response.aclose()` 再抛出」，`RiskGate.report` 抛出的暂停不会被接入层吞成普通响应。冲突解析后相关范围 `141 passed`（03 四个风控文件＋gate／pacing／logs／迁移／评论／回复）。

## 3. 验收条件 → 证据

| 票据验收条件 | 证据 |
| --- | --- |
| 首次全量、末页倒序增量、失败重试、空尾复查及其他实际楼中楼 GET 都执行请求结束后至少 100ms 等待；第一请求前不加，最后一页后仍执行 | `test_every_real_reply_page_waits_after_response_through_real_archive_chain`（账本 `send/done/wait` 交替，首请求前无等待、末页后仍等待）、`test_failed_reply_request_still_pays_the_page_wait`、`test_incremental_tail_pages_share_the_same_wait_and_log_reverse_direction`（末页倒序）。实现在 `reply_pacing.ReplyPagePacer.page()`，由 `RequestsCommentClient.get` 按接口类型接入，失败路径在 `finally` 中等待 |
| 等待通过统一协调执行，多调用者发送／完成时间账本证明不能交错绕过；04 的探测复用同一路径 | `test_two_callers_cannot_interleave_past_the_page_wait`（两客户端共享 pacer，虚拟时钟账本 0.0／0.1／0.2，相邻 `start >= complete + 0.1`）；探测只需 `client.get(REPLIES_URL, …)`／`replies.fetch_reply_page`——等待在客户端层，不需要新入口（见 §5） |
| 整楼跳过与未真实展开的根不额外等待；实际展开后的楼级等待对齐参考策略；feed 与根页原有等待不重复增加 | `test_zero_reply_root_pays_no_page_or_per_root_wait`（零回复楼 `root_waits == []` 场景中仅展开楼缴 1 次 0.3–0.4 秒，页后等待恰 3 次）；`test_source_pacing.py` 全绿（feed 0.8–1.5、根页 0.3–0.4、六次等待账本不变） |
| 时间可注入；既有仅覆盖楼级 0.3–0.4 秒的替身不误吞、误约束新增等待；网络与等待不占 SQLite 写事务 | 注入点 `ReplyPagePacer(sleep=…, clock=…, delay=…)`、`create_app(reply_page_pacer=…)`、`open_collector(reply_page_pacer=…)`、`RequestsCommentClient(reply_page_pacer=…)`；`tests/conftest.py` 仍只替换 `replies.sleep_after_root`（断言 0.3–0.4 秒），新增等待在独立模块里被单独断言，未被吞掉或误约束；`test_reply_page_wait_holds_no_sqlite_write_transaction` |
| INFO 日志能串起正常发现、检查、领取／跳过、正文、根页、楼中楼页、媒体及整轮结果 | `test_initial_archive_logs_business_ids_pages_and_waits`（`body_sync_finished`／`root_page_saved`／`reply_page_fetched`／`reply_page_saved`／`media_sync_finished`）、`test_collector_logs_uid_claims_and_round_result`（`discovery_started/finished`、`check_started/finished`、`sync_started`、`sync_finished` 分项）。`sync_skipped`／`check_skipped`／`replies_sync_skipped` 同样带业务 ID（代码路径 + 同文件断言风格） |
| 记录字符串 UID、dynamic_id、root_id、独立关联号、页码、方向、接口类型、数量、结果、耗时与等待；每页全部已校验 ID 批量输出，超长按关联号分块 | `reply_page_fetched` 断言 `uid`／`dynamic_id`／`root_id`／`page`／`direction`／`endpoint_type=replies`／`fetched`／`reply_ids`／`elapsed_ms`／`wait_ms`；`attempt` 仍是进程内流水号（独立关联号，非领取令牌）；`test_long_reply_page_splits_ids_into_chunks_without_dropping_any`（`ids_part`/`ids_chunks`/`ids_total`，ID 合集相等） |
| 不为每条回复单独刷 INFO；成功、失败与跳过均可定位；不把旧领取令牌当关联号；不泄漏 Cookie、密钥、正文、完整 URL、任意异常原文或内部令牌 | 日志每页一条（分块时 N 行）；失败用 `reply_sync_failed`＋`reason`/`stage`/`page`/`root_index`/`wait_ms`；跳过用 `sync_skipped`/`check_skipped`/`replies_sync_skipped`；`attempt` 是进程内自增流水号，领取令牌从不进日志；两文件都断言 `http://`/`https://`/`token=`/`FICTIONAL`/正文片段缺席；`SourceId` 只接受合法数字串，其他字符串仍 `unknown` |
| 继续使用现有标准输出／错误输出链路，不新增独立日志文件、轮转器或固定保留天数；原始传输调试日志保持关闭 | `collector_logging.configure_collector_logging()` 仍只加 `StreamHandler()`（stderr），未新增文件 handler；`safety.configure_safe_logging()` 与传输日志禁用未改；`pyproject.toml`／部署文件未改 |
| 用真实归档链、受控时间和日志捕获同时验证等待及 ID 正向出现、秘密负向缺席；同步日志规则和分页节奏契约 | §3 前七行；契约同步：`docs/backend/api/collector-api.md`「分页请求节奏（30）」与「调度与失败日志」、`backend/README.md`「collector 日志」「30 分页请求间隔」、`docs/README.md` 证据索引行 |

## 4. 回归范围与结果

本票实施阶段的票范围回归（27 个文件，命令见 §1）为 664 passed／1 failed；那 1 个失败已按 §2 第 11 步定位为 01 引入的回归并修复，修复后同范围与新增防护用例全绿。

交付前的确切绿灯命令与结果（本工作树、合并 `3a72c4a` 之后）：

- 回归与防护点：`uv run --locked pytest backend/tests/test_migrations.py::test_unexpected_transport_startup_failure_is_sanitized backend/tests/test_source_gate.py backend/tests/test_source_pacing.py backend/tests/test_reply_page_pacing.py backend/tests/test_flow_logs.py -q`（gate／pacing／logs／启动脱敏＋两条新防护用例）。
- 合并冲突解析后相关范围：`uv run --locked pytest backend/tests/test_risk_state.py backend/tests/test_risk_pause.py backend/tests/test_risk_collector.py backend/tests/test_risk_processes.py backend/tests/test_source_gate.py backend/tests/test_source_pacing.py backend/tests/test_reply_page_pacing.py backend/tests/test_flow_logs.py backend/tests/test_migrations.py backend/tests/test_replies.py backend/tests/test_reply_incremental.py backend/tests/test_root_comments.py -q` → **141 passed in 62.94s**（03 四个风控文件＋本票 pacing／log／gate／迁移／评论／回复）。
- 全量：`uv run --locked pytest backend/tests -q` → **1136 passed, 3 warnings in 252.96s (0:04:12)**，无失败、无跳过。3 条警告仍是既有依赖弃用（`starlette` `BlockingPortal` 别名与两条 `oss2` 的 `utcnow()`），与本次改动无关。
- 未跑前端：本票不改 `frontend/`；03 合入的前端改动由其自身证据覆盖。

## 5. 给 04／07 的 Interface 边界

- **等待**：`reply_pacing.ReplyPagePacer.page()` 是唯一页后等待实现；业务代码**不需要**手动 sleep。探测实现只要像现有归档一样用评论客户端发 `https://api.bilibili.com/x/v2/reply/reply`（`replies.fetch_reply_page`／`client.get(REPLIES_URL, …)`），就自动获得「真实请求结束后 ≥100ms」并共享同一协调器；不要绕过客户端直接发 HTTPX，否则会形成另一条无等待路径。`elapsed_ms`／`wait_ms` 由客户端写在 `client.last_reply_page`，可供 04 的探测日志复用。
- **装配注入**：`create_app(..., source_gate=…, reply_page_pacer=…)`、`open_collector(..., source_gate=…, reply_page_pacer=…, comment_client_factory=…)`；03／08 的持久风控状态接入同一 `SourceGate`，不需要触碰 `ReplyPagePacer`。
- **07（楼中楼续采）**：本票在 `replies.sync_replies` 里只加了「是否真的展开过」的局部变量、每页日志与 `fetch_page()` 包装；分页/续采结构、`fetch_reply_tail` 返回值与存储语义未变。07 改动分页落盘时保留 `expanded` 判定与 `fetch_page()` 包装即可继续满足「零回复楼不等待」。
- **06（根页持久续采）**：`root_comments.py` 只加了日志行（`root_sync_started` 带 ID、`root_page_saved`、失败与完成带 ID、空尾确认耗时），未改分页、锚点或提交结构；06 可自由重构该循环，只保留「每页一条 `root_page_saved`」这条可观察契约。
- **与 03 的边界（合并后）**：默认 `source_gate` 现在是 03 的持久 `RiskGate`，`SourceRiskPaused` 的优先级高于一切业务失败——评论客户端里它先于 `except Exception` 被识别，预热遇到它不再做第二次预热、也不写成预热失败；`GatedAsyncTransport` 在报告阶段被拒绝时先释放响应再抛出，因此本票的页后等待只会看到「调用被中止」并照常在 `finally` 里结算 `wait_ms`，不会把暂停吞成普通失败。
- **未纳入本票**：HTTP 412／429 暂停、六档冷却、探测、观察期、`GET /api/manage/risk`、`SOURCE_RISK_PAUSED`、分页持久断点、单路重型调度、系统告警、性能对照；也未改 `storage.py`／迁移／通知资格。

## 6. 未验证与限制

- 未访问真实 B 站、OSS、飞书；未部署、未重启任何服务，未读取真实 Cookie。
- 跨进程不可绕过、多进程统一调度、探测路径的实际等待要等 04／08／10 复验；本票只证明单进程内多调用者不可交错，且探测未来走同一条路径而非预留旁路。
- 真实上游的分页耗时分布、100ms 等待对整体初始化耗时的影响（RC-12 门槛）未测；`0.1s × P_replies` 的预算核对留给 10。
- 未跑前端测试（本票不涉及前端）；未补性能基准与真实长跑观察。
