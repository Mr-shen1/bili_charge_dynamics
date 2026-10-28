# 02：楼中楼分页等待与基础流程日志

Status: resolved

**What to build:** 每次真实楼中楼分页请求结束后等待至少 0.1 秒，并在正常发现、检查和归档流程中提供可定位到动态、楼层和每页评论／回复的结构化日志。

**Blocked by:** 01 — 统一 B 站请求发送入口。

## 验收标准

- [x] 首次全量、末页倒序增量、失败重试、空尾复查及其他实际楼中楼 GET 都执行请求结束后的至少 100ms 异步等待；第一请求前不额外添加该等待，最后一页后仍执行。证据：[evidence §2 第 1—2、5 步](../evidence/02-reply-pacing-and-flow-logs.md#2-红绿过程tdd纵向切片)（`test_every_real_reply_page_waits_after_response_through_real_archive_chain` 账本 `send 1→done 1→wait 0.1→send 2→…→send 2→wait 0.1`；`test_failed_reply_request_still_pays_the_page_wait`；`test_incremental_tail_pages_share_the_same_wait_and_log_reverse_direction`）。
- [x] 等待通过统一协调执行，以多调用者的发送／完成时间账本证明不能交错绕过；为 04 的探测复用同一路径，而不是预留另一条无等待的请求路径。证据：`ReplyPagePacer.page()` 在同一锁内包住发送→完成→等待；`test_two_callers_cannot_interleave_past_the_page_wait`（两客户端共享 pacer，虚拟时钟 0.0／0.1／0.2，相邻 `start >= complete + 0.1`）；探测只需复用 `client.get(REPLIES_URL, …)`（[evidence §5](../evidence/02-reply-pacing-and-flow-logs.md#5-给-0407-的-interface-边界)）。
- [x] 整楼跳过和未真实展开楼中楼的根不额外等待；实际展开后的楼级等待对齐参考策略，feed 和根页原有等待不重复增加。证据：`replies.sync_replies` 用局部 `fetch_page()` 记录是否展开，`finally` 只在展开后 `sleep_after_root`；`test_zero_reply_root_pays_no_page_or_per_root_wait`；`test_source_pacing.py` 全绿（feed／根页区间与六次等待账本不变）。
- [x] 时间可注入，现有仅针对楼级 0.3—0.4 秒的测试替身不误吞、误约束新增页后等待；网络与等待不占 SQLite 写事务。证据：`ReplyPagePacer(sleep=…, clock=…, delay=…)`＋`create_app(reply_page_pacer=…)`／`open_collector(reply_page_pacer=…)`；`tests/conftest.py` 仍只替换 `sleep_after_root`；`test_reply_page_wait_holds_no_sqlite_write_transaction`（等待期间另一连接 `BEGIN IMMEDIATE` 成功）。
- [x] INFO 日志能够串起已有正常发现、检查、领取／跳过、正文、根页、楼中楼页、媒体及整轮结果；后续票负责增加其新行为对应的断点／风控／调度事件。证据：`test_initial_archive_logs_business_ids_pages_and_waits`（`body_sync_finished`／`root_page_saved`／`reply_page_fetched`／`reply_page_saved`／`media_sync_finished`）＋`test_collector_logs_uid_claims_and_round_result`（`discovery_started/finished`、`check_started/finished`、`sync_started`、`sync_finished` 分项）；`sync_skipped`／`check_skipped` 同路径带 ID。
- [x] 阶段可得时记录字符串 UID、dynamic_id、root_id、独立关联号、页码、方向、接口类型、数量、结果、耗时与等待；每页全部已校验评论／回复 ID 批量输出，超长按关联号分块而非静默截断。证据：`reply_page_fetched` 字段断言（`uid`／`dynamic_id`／`root_id`／`page`／`direction`／`endpoint_type=replies`／`fetched`／`reply_ids`／`elapsed_ms`／`wait_ms`）；`test_long_reply_page_splits_ids_into_chunks_without_dropping_any`（`ids_part`/`ids_chunks`/`ids_total`，ID 合集相等）。
- [x] 不为每条回复单独刷 INFO；成功、失败和跳过均可定位，不将旧领取令牌当关联号，不泄漏 Cookie、密钥、正文、完整 URL、任意异常原文或内部令牌。证据：每页一条（分块时 N 行）＋`reply_page_saved`；失败 `reply_sync_failed` 带 `reason`／`stage`／`page`／`root_index`／`wait_ms`；`attempt` 仍是进程内流水号（非领取令牌）；两个日志用例都断言 `http://`／`https://`／`token=`／`FICTIONAL`／正文片段缺席，`SourceId` 只接受合法数字串、其他字符串仍 `unknown`。
- [x] 日志继续使用现有标准输出／错误输出链路，不增加独立日志文件、轮转器或固定保留天数；原始传输调试日志保持关闭。证据：`collector_logging.configure_collector_logging()` 仍只有 `StreamHandler()`；`safety.configure_safe_logging()` 与传输日志禁用未改；无配置／部署文件改动。
- [x] 用真实归档链、受控时间和日志捕获同时验证等待及 ID 正向出现、秘密负向缺席；同步日志规则和分页节奏契约。证据：上述真实 API／collector 装配用例；契约已同步 `docs/backend/api/collector-api.md`「分页请求节奏（30）」「调度与失败日志」、`backend/README.md`「collector 日志」「30 分页请求间隔」与 `docs/README.md` 证据索引。

## 验证范围

主要覆盖 RC-03 与正常流程的 RC-10。04 接入真实探测后须补齐探测用例，08／10 须复验多进程与统一调度下仍不可绕过；本票不把后续场景标为已验收。

## Answer

新建 `backend/bili_monitor/reply_pacing.py`：`ReplyPagePacer.page()` 在**同一个锁**里包住「发送 → 完成 → 等待」，因此真实楼中楼分页请求结束后至少等待 100ms（`REPLY_PAGE_DELAY_SECONDS`），首请求前不等待、失败与最后一页后仍等待，多调用者不能靠交错发送绕过。`PageTiming` 分开记 `elapsed_ms` 与 `wait_ms`。接入点在 `RequestsCommentClient.get`：按 `source_request(...).endpoint_type == "replies"` 分类，探测与归档走同一条 `client.get(REPLIES_URL, …)` 路径，没有预留旁路；耗时／等待写在 `client.last_reply_page` 供日志使用。注入点为 `ReplyPagePacer(sleep=…, clock=…, delay=…)`，经 `create_app(reply_page_pacer=…)`、`open_collector(reply_page_pacer=…)`、`RequestsCommentClientFactory`／`RequestsCommentClient` 传入。

`replies.sync_replies` 只加两处行为：用局部 `fetch_page()` 记录「本楼是否真的发出过请求」，楼级 0.3–0.4 秒等待只在展开后缴纳（零回复、未到期跳过的楼不再等待）；每页一条 `reply_page_fetched`（ID、页码、方向、数量、耗时、等待）与保存后的 `reply_page_saved`（`new`/`updated`/`accepted`）。分页与续采结构、存储语义未改，`storage.py`／迁移未动，`root_comments.py` 只加日志行。

日志层 `collector_logging.py` 有意扩展正式设计 §6 的 ID 规则：新增 `SourceId`／`SourceIds`／`source_refs()`，只放行 `is_valid_id` 的字符串（整数原样转字符串），其他字符串仍渲染 `unknown`；`SourceIds` 超 `ID_FIELD_CHARS=300` 时按同一事件分块输出 `ids_part`/`ids_chunks`/`ids_total`。正文、根页、楼中楼页、媒体、检查、发现、领取／跳过与整轮结果事件都带字符串 UID／动态 ID／根评论 ID；`attempt` 仍是进程内流水号，领取令牌从不进日志；未新增日志文件、轮转器或保留天数。

明确未做：HTTP 412／429 暂停、六档冷却、按接口探测、观察期与人工态、风控管理接口、分页持久断点、单路重型调度、系统告警与性能对照（03—10）。跨进程不可绕过与探测实际等待要由 04／08／10 复验。未访问真实 B 站／OSS／飞书，未部署。

## Comments

- 2026-10-27 领取并按 TDD 纵向切片实施（Status: claimed → 全部证据齐备后置 resolved）。新增 `backend/tests/test_reply_page_pacing.py`（6 例）与 `backend/tests/test_flow_logs.py`（4 例）；票范围回归 27 个文件 664 passed／1 failed，全量 1107 passed／1 failed。逐片红绿、四次测试自身纠错见 [evidence §2](../evidence/02-reply-pacing-and-flow-logs.md#2-红绿过程tdd纵向切片)。
- 同日收口更正：那 1 个失败 `test_unexpected_transport_startup_failure_is_sanitized` **不是票前既有失败**。实施当日的「`1673dfe` 上 stash 复核仍红」只证明它在集成 tip 上已经红；用只读 worktree 在 `4c47264`（实施前基线 1091 passed）下复跑同一用例是绿的，根因是 01 的 `86f6149` 把注入 transport 包进 `GatedAsyncTransport` 时没有转发 `__aenter__`／`__aexit__`，`httpx` 客户端只进入最外层 transport，被包装 transport 的启动钩子因此不再执行——启动期失败被当成可服务状态。修复提交 `d4833c7`（转发生命周期，脱敏路径与门禁不变），并补 `test_gated_transport_forwards_inner_lifecycle_and_closes_it_once`（内层进入一次、退出恰好关闭一次；去掉转发即红）与 `test_gate_report_rejection_propagates_instead_of_being_swallowed` 两条防护用例。修复后全量 1110 passed。见 [evidence §2 第 11 步](../evidence/02-reply-pacing-and-flow-logs.md#2-红绿过程tdd纵向切片)。
- 同日并入 03 的集成 tip `3a72c4a`（`672f948` 跨进程风控暂停、`3a72c4a` 前端保护态提示），解 `app.py`／`comment_client.py`／`media.py`／`replies.py`／`root_comments.py`／`docs/README.md` 冲突：默认 gate 换成 03 的 `RiskGate`，本票的 `reply_page_pacer` 注入与页后等待保留；`SourceRiskPaused` 仍在预热与各业务 `except Exception` 之前被识别，`GatedAsyncTransport` 报告拒绝时先 `response.aclose()` 再抛出，暂停不会被吞。合并后相关范围 141 passed，全量 **1136 passed, 0 failed**。见 [evidence §2 第 12 步与 §4](../evidence/02-reply-pacing-and-flow-logs.md#4-回归范围与结果)。
- 交付前复查 `spec/bilibili-risk-control` tip：已由 `1673dfe` 推进到 `3a72c4a`（03 合入），本分支已在 `1008b1b` merge 该 tip；合并后重跑全量 1136 passed。
