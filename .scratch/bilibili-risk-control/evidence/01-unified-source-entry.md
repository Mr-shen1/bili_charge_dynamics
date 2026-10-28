# 01 统一 B 站源请求发送入口：实施与验收证据

对应票据：[01 统一 B 站请求发送入口](../issues/01-unified-source-entry.md)；正式规则：[B 站限流／风控保护与全量归档续采](../../../docs/design/bilibili-risk-control.md) §3.1、§4.4、§5；实施范围与测试决策：[父规格](../spec.md)「实施决策 1」「测试决策」；运行说明：[后端 README](../../../backend/README.md)「统一源请求发送入口」。

结论：**本票范围（保行为的统一发送许可／结果报告入口）已实施并有隔离自动化证据**：API 与采集进程的全部 B 站源请求——计数、根页、楼中楼、feed、detail、动态网页、UP 资料、首页／空间预热、图片下载——都在发送前取许可、返回或失败后报告状态；HTTPX 与 Requests 两个 Adapter 各自在逐跳位置接入，媒体下载复用 HTTPX Adapter。默认真实实现在当时一律放行，因此**没有**新增风控暂停、探测、跨进程状态、100ms 页后等待、分页续采、单路调度、流程日志或告警；这些属于 02—09。未访问真实 B 站、未部署、未改动生产数据。

## 1. 环境与命令

- 环境：Linux，Python 3.12.15，uv；pytest 8.4.2，httpx 0.28.1，requests 2.34.2，fastapi 0.115.12（`uv.lock` 未改）。
- 分支：`wt/bilibili-risk-control-01`，起点为 `spec/bilibili-risk-control` 的 `4c47264`；交付前再次确认 spec 分支 tip 未前进（见 §2 第 7 步）。
- 隔离：临时 SQLite 真实文件；B 站响应为受控 fixture／固定字节；HTTPX 用 `httpx.AsyncBaseTransport` 替身或 monkeypatch `AsyncHTTPTransport.handle_async_request`；Requests 用 monkeypatch `HTTPAdapter.send`；时间用 `asyncio.sleep` 替身与 `ControlledClock`。没有真实 B 站、OSS 或飞书流量。
- 代码定位：本工作树内没有 `.codegraph/` 索引（见 `docs/agents/codegraph.md` 的跳过条件），`codegraph_explore` 明确拒绝未索引项目，因此按约定回退到源码阅读与 grep；结论与共享探索笔记 `/tmp/bilibili-risk-control-notes.md` 的入口清单一致。
- 本票前基线（同一环境、`spec/` tip）：`uv run pytest backend/tests -q` → **1091 passed in 200.27s**。
- 新增用例：`backend/tests/test_source_gate.py`（9 例）。
- 票范围回归（17 个相关文件）：`uv run pytest backend/tests/test_source_gate.py backend/tests/test_source_pacing.py backend/tests/test_comment_transport.py backend/tests/test_comment_session.py backend/tests/test_collector.py backend/tests/test_collector_cadence.py backend/tests/test_initial_archive.py backend/tests/test_full_archive.py backend/tests/test_replies.py backend/tests/test_root_comments.py backend/tests/test_dynamic_media.py backend/tests/test_comment_media.py backend/tests/test_management.py backend/tests/test_discovery_source.py backend/tests/test_deployment_processes.py backend/tests/test_service_processes.py backend/tests/test_three_process_delivery.py -q` → **400 passed in 101.45s**。
- 全量由主线在组合阶段统一执行；本证据不宣称全量新结果。

## 2. 红绿过程（TDD，纵向切片）

1. **UP 资料查询经入口**（`test_up_profile_request_goes_through_unified_entry`）：先写测试，红 `TypeError: create_app() got an unexpected keyword argument 'source_gate'`。实现 `source_gate.py`（`SourceRequest`／`SourceReport`／`SourceGate.permit`／`report`＋默认 `OpenSourceGate`）、`GatedAsyncTransport`，并让 `create_app` 接收 `source_gate` 后转绿；断言恰好一次 `("permit", "profile")` 与一次 `("report", "profile", 200)`。
2. **初始化全链账本**（`test_initial_archive_sends_every_source_request_through_gate`）：以最内层 `LedgerTransport` 记录真实发送、用 `LedgerGate` 记录许可与报告，断言两者序列完全一致。首次运行得红：期望里写了 `comment_count`，实际没有——核对后确认评论计数属于固定检查而不在显式初始化链上（`root_comments.fetch_comment_count` 只由 `Collector.check_once` 调用），**修正的是测试的期望，不是生产的分类**；计数覆盖由采集进程用例负责。
3. **Requests 逐跳接入**（`test_requests_comment_session_gates_every_page_and_redirect_hop`）：红 `TypeError: RequestsCommentClient.__init__() got an unexpected keyword argument 'gate'`。实现 `ThreadSourceGate`（`asyncio.run_coroutine_threadsafe` 桥接协程侧许可与线程内发送）＋`_SourceSession.send` 内逐跳 `permit`／`report`，并把 Cookie 主机白名单改为复用 `source_gate.SOURCE_HOSTS`。
   该片被测试纠正两次：先是替身缺 `history`／`request` 字段（Requests 自己解析跳转要用），随后是**语义纠正**——初版外层又报告一次最终响应，导致同一次发送出现两条报告；改为「跟随跳转时最终响应由它自己那一跳报告，外层不重复计数」，并把断言收紧为 `permitted == ["root_comments", "replies"]`、`reported == [("replies", 200)]`、既有分页等待仍只有 1 次。
4. **预热吞异常仍报告**（`test_warmup_swallow_still_reports_result_to_gate`）：预热返回 412 时 `prepare()` 仍按原样 best-effort 不抛异常（行为不变），但账本记录到两次 412——报告发生在 `_get` 之前的 `send` 内，早于 `prepare` 的 `except Exception` 与 `WarmupCache._run` 的吞异常，后续风控不会因为预热吞异常而失明。该片在切片 3 的生产代码上直接转绿，属**只补覆盖、不改生产**。
5. **HTTP 错误先报告再交给原业务处理**（`test_http_error_response_is_reported_before_business_error_handling`）：根页返回 412，`POST /api/sync/initial` 仍是原来的 `{"processed": 1, "succeeded": 0, "failed": 1}`（失败分类与统计口径不变），同时账本里有 `("root_comments", 412)`。同为只补覆盖的切片。
6. **采集进程真实装配**（`test_collector_assembly_sends_every_source_request_through_gate`）：要把 gate 注入采集进程的真实装配，先写测试得红 `ImportError: cannot import name 'open_collector'`。把 `collector.serve` 的装配抽成 `@asynccontextmanager open_collector`（同一 transport／pacer／会话工厂／媒体 client 装配，只多出可注入的 gate、传输与时钟），`serve` 改为使用它。随后两次红都是测试自身问题：传输替身写成同步函数（`TypeError: object Response can't be used in 'await' expression`）；等待断言把 1–3 秒预热区间与 0.8–1.5 秒 feed 区间混在一个过滤条件里（得 `5 != 3`）。改为按顺序断言六次等待（feed×3、预热×2、根页×1）后转绿，同时保住「既有等待没有被复制」这一断言。
7. **媒体与不受控边界**（`test_media_download_is_gated_while_upload_and_local_reads_are_not`、`test_httpx_transport_gates_each_redirect_hop`、`test_source_endpoint_types_follow_host_and_path_template`）：图片下载（含失败后手动重试 `POST /api/sync/media/{id}`）各留一次 `media_image` 许可与报告；OSS 上传（替身）没有产生任何许可；`GET /api/archive/dynamics/{id}` 前后账本长度不变（阅读 GET 无上游请求）；HTTPX 跟随重定向时两跳各取一次许可。三个用例在切片 1—6 的生产代码上直接转绿，属只补覆盖。
8. **合并与最终回归**：交付前确认 `spec/bilibili-risk-control` tip 仍是 `4c47264`，本分支已包含该 tip；随后按 §1 的 17 个文件跑票范围回归得 400 passed。

## 3. 验收条件 → 证据

| 票据验收条件 | 证据 |
| --- | --- |
| 真实应用与 collector 装配、临时 SQLite、外部传输替身下，计数／根页／楼中楼／feed／detail／网页／资料／预热／图片下载都经统一入口 | API 装配：`test_initial_archive_sends_every_source_request_through_gate`（`profile, opus_page×2, detail, root_comments×3, replies×3`）、`test_media_download_is_gated_...`（`media_image`）；采集装配：`test_collector_assembly_sends_every_source_request_through_gate`（`feed×3, opus_page, detail, homepage_warmup, space_warmup, comment_count, opus_page, detail, root_comments`）。两处断言都是「传输层发送序列 == 许可序列」，因此同时证明无遗漏与无额外发送 |
| HTTPX、Requests、媒体下载 Adapter 均发送前取许可、返回后报告；受信域重定向的后续发送也有接入位置 | HTTPX：`test_httpx_transport_gates_each_redirect_hop`（两跳两许可，`reported == [("root_comments", 302), ("replies", 200)]`）；Requests：`test_requests_comment_session_gates_every_page_and_redirect_hop`（`permitted == ["root_comments", "replies"]`）；媒体：`test_media_download_is_gated_...`（`("media_image", 200)` 与失败重试各一次）；实现位置 `source_gate.GatedAsyncTransport`、`comment_client._SourceSession.send`、README 表格 |
| API 的资料查询、作者校验、手动初始化、媒体重试复用同一 Interface，不另造 collector 专用入口 | `test_up_profile_request_goes_through_unified_entry`（`POST /api/manage/ups` → `profile`）、`test_initial_archive_sends_every_source_request_through_gate`（`POST /api/manage/ups/{uid}/targets` 的 `verify_author` → `opus_page`；`POST /api/sync/initial` 全链）、`test_media_download_is_gated_...`（`POST /api/sync/media/{id}`）。两进程入口分别是 `create_app(source_gate=...)` 与 `serve(source_gate=...)`／`open_collector(...)`，同一 `SourceGate` Interface；跨进程持久策略未实现，代码注释与 README 明确由 03／08 接入同一 SQLite，不用进程内对象冒充 |
| Cookie、主机白名单、重定向、代理、超时、解析、会话缓存及既有有效等待保持现状；成功结果与其他错误处理不变 | 既有回归全绿：`test_source_pacing.py`（等待区间与顺序、取消、共享锁）、`test_comment_transport.py`（解压／头处理）、`test_comment_session.py`（会话复用、预热 TTL）、`test_collector.py`、`test_initial_archive.py`、`test_replies.py`、`test_management.py`、`test_deployment_processes.py`、`test_service_processes.py`、`test_three_process_delivery.py`；采集用例的六次等待账本证明等待未被新增入口复制；412 用例证明失败分类不改判 |
| OSS 上传、飞书投递、本地归档读取明确不受源站许可控制；阅读 GET 不产生上游请求 | `test_media_download_is_gated_...`：OSS 上传替身被调用一次而账本无对应许可报告；阅读 GET 前后账本长度相同。飞书投递位于独立通知进程（`notifications/delivery.py` 本次未改），不在本票任何 source client 内，diff 可核 |
| 可注入的时间／传输 seam，沿用实际应用与 collector 测试入口，不复制业务解析、不造假数据库 | 注入点：`create_app(source_gate=...)`、`open_collector(source_gate=..., source_transport=..., media_transport=..., media_uploader=..., comment_client_factory=..., clock=...)`、`serve(source_gate=...)`、`RequestsCommentClientFactory(gate=...)`、`SourcePacer(sleep=...)`、`GatedAsyncTransport(transport, gate)`；用例全部使用真实 `Store`＋临时 SQLite 与真实解析／同步／提交链，只替换外部传输与时间 |
| 以请求账本证明覆盖无遗漏、无额外请求及重复等待；既有正常／失败回归通过 | §2 第 2、6、7 步的发送序列与许可序列断言、六次等待账本、412 用例；400 passed 范围回归 |
| 运行说明与装配测试同步更新；未新增风控开关、自动恢复、分页持久断点或全局串行策略 | `backend/README.md` 新增「统一源请求发送入口」并更新 `create_app` 签名段；`archive_support.archive_client(..., gate=...)` 作为共享装配 seam。本票没有新增环境变量、迁移、管理接口或调度改动（`storage.py`、`contracts.py` 未改） |

## 4. 关键设计决定

- **一个模块承载 Interface**：`backend/bili_monitor/source_gate.py` 定义 `SourceRequest`（`endpoint_type`＋方法、主机、路径，不含 query）、`SourceReport`（状态码或异常）、`SourceGate.permit/report` 与默认 `OpenSourceGate`。分类函数 `endpoint_type(host, path)` 按主机＋路径模板固定归类，query 中的资源 ID／页码不产生新类型——这是 04 按类型探测可以直接复用的形状；白名单内没有模板的路径归 `source_other`，仍要过许可，避免静默放行。
- **Adapter 只在确有不同传输实现处新建**：HTTPX 侧一个 `GatedAsyncTransport`（Sender 是 `httpx.AsyncBaseTransport`），媒体下载复用它（不同 client、不同类型），Requests 侧在既有 `_SourceSession.send` 内逐跳接入（Requests 自己解析跳转，每一跳都会再进 `send`）。业务函数（`fetch_page`／`fetch_detail`／`fetch_comment_count`／`fetch_root_page`／`fetch_reply_page`／`ImageDownloader.download`）一行未改，避免把闸门塞进错误分类各不相同、client 类型也不一致的业务层。
- **顺序**：生产装配为「外层 `PacedSourceTransport`（既有 feed 0.8–1.5 秒、根页 0.3–0.4 秒等待）→ 内层 `GatedAsyncTransport`（许可紧贴发送）」。注入 `profile_transport`／`media_transport` 时只包 gate、不加等待，保持既有「测试替身只替换外部 HTTP」的语义，既有用例的等待断言不变。
- **每跳许可、单次报告**：Requests 跟随跳转时，最终响应由跟随它的那一跳报告一次，外层不重复计数；中间 3xx 不作为独立结果。412／429 永远不是被跟随的跳转，因此一定在返回它的那次调用里报告一次——这既满足「不能只观察最外层调用」，也避免 03 收到同一次发送的两条触发。
- **报告点在吞异常之前**：预热仍是 best-effort（`prepare`／`WarmupCache` 的 `except Exception` 原样保留，行为不变），但 `report` 发生在传输层，风控状态不会因为上层吞异常而漏记。
- **不把等待塞进 gate**：本票 gate 只做许可与报告，不持 pacer、不引入等待；02 的页后 100ms 与 03 的暂停都接同一 Interface，避免本票顺手改掉正常节奏。
- **跨进程边界明示**：`OpenSourceGate` 是进程内默认实现，docstring 与 README 都写明持久状态由 03／08 用同一 SQLite 接入，禁止用进程内共享对象冒充全局保护。

## 5. 未覆盖与限制

- 未实现任何风控行为：HTTP 412／429 只被记录（`SourceReport`），不触发暂停；没有六档冷却、按接口探测、观察期、人工态、`GET /api/manage/risk`、`SOURCE_RISK_PAUSED`。
- 未实现楼中楼 100ms 页后等待（02）、分页持久续采（06／07）、单路重型调度（08）、流程日志与业务 ID 批量输出（02 及各票）、系统告警（09）、性能对照（10）。本票不改 pacing 参数。
- 真实上游、OSS、飞书与目标环境全部未验证；未做长时间运行或压测。
- Requests 侧的许可在线程池里通过 `asyncio.run_coroutine_threadsafe(...).result()` 同步等待事件循环。当前的默认实现是空操作，代价可忽略；03 接入持久核验后必须保证 `permit`／`report` 是短事务、且不得再获取该会话的 pacing 锁，否则会在工作线程里自锁。
- HTTPX 侧生产仍是 `follow_redirects=False`（与改造前一致）。逐跳接入由独立用例覆盖；如果将来为 HTTPX 打开重定向，`GatedAsyncTransport` 已经在正确的 seam 上，但没有真实跳转样本。
- 分类表是静态的：上游新增接口或路径变化时要同步 `_API_ENDPOINTS`／模板，否则会落到 `source_other`（仍受许可，但类型不精确）。
- 日志仍沿用既有保密约束，本票没有新增日志字段或事件，因此 RC-10 的「每页业务 ID」不在本票证据内。

## 6. 代码与文档指针

- 新增：`backend/bili_monitor/source_gate.py`、`backend/tests/test_source_gate.py`。
- 修改：`backend/bili_monitor/app.py`（`source_gate` 参数、业务／媒体 client 装配）、`backend/bili_monitor/collector.py`（`open_collector` 装配、`serve(source_gate=...)`）、`backend/bili_monitor/comment_client.py`（`_SourceSession` 逐跳接入、`ThreadSourceGate` 桥接、gate 透传到工厂）、`backend/tests/archive_support.py`（`archive_client(..., gate=...)`）、`backend/README.md`（「统一源请求发送入口」＋`create_app` 签名）。
- 未改：`storage.py`（无迁移）、`contracts.py`（无新错误码）、`profiles.py`／`source.py`／`root_comments.py`／`replies.py`／`media.py`／`sync.py`（业务解析与同步不变）、`notifications/*`、`oss.py`。
