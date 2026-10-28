# 01：统一 B 站请求发送入口

Status: resolved

**What to build:** API 与采集进程的所有 B 站源请求经过统一的发送许可／结果报告 Interface，使后续风控和等待规则能覆盖全部真实发送；本票是保行为预重构，不提前改变正常采集策略。

**Blocked by:** 无（可立即开始）。

## 验收标准

- [x] 通过真实应用和 collector 装配、临时 SQLite 与外部传输替身，验证计数、根评论、楼中楼、feed、detail、动态网页、UP 资料、首页／空间预热和图片下载均经过统一入口。证据：[evidence §2 第 2、6、7 步](../evidence/01-unified-source-entry.md#2-红绿过程tdd纵向切片)（API 装配 `profile/opus_page×2/detail/root_comments×3/replies×3`；采集装配 `feed×3/opus_page/detail/homepage_warmup/space_warmup/comment_count/opus_page/detail/root_comments`）。
- [x] HTTPX、Requests、媒体下载各 Adapter 均能在发送前取得许可、返回后报告状态；受信域内重定向的后续发送也有明确接入位置，不能只观察最外层调用。证据：`GatedAsyncTransport`（HTTPX，逐跳）＋`_SourceSession.send`（Requests，逐跳）＋媒体复用 HTTPX Adapter；用例 `test_httpx_transport_gates_each_redirect_hop`、`test_requests_comment_session_gates_every_page_and_redirect_hop`。
- [x] API 的资料查询、作者校验、手动初始化和媒体重试复用同一 Interface，不另造只供 collector 使用的入口；跨进程持久策略由 03／08 接入，不以进程内共享对象冒充全局保护。证据：`create_app(source_gate=…)` 与 `serve(source_gate=…)`／`open_collector(…)` 同一 Interface；`source_gate.py` 与 README 明确默认实现为进程内一律放行、持久状态留待后续票。
- [x] Cookie、主机白名单、重定向、代理、超时、解析、会话缓存及原有有效等待保持现状，成功结果与其他错误处理不因预重构改变。证据：既有回归 400 passed（`test_source_pacing`／`test_comment_transport`／`test_comment_session`／`test_initial_archive`／`test_management`／三进程用例等）；采集用例锁定「六次等待」不被复制；412 用例显示失败分类未改判。
- [x] OSS 上传、飞书投递和本地归档读取明确不受 B 站来源许可控制；阅读 GET 不产生上游请求。证据：`test_media_download_is_gated_while_upload_and_local_reads_are_not`；`notifications/*` 与 `oss.py` 本次未改。
- [x] 提供可注入的时间／传输 seam，沿用实际应用和 collector 的测试入口，不复制业务解析、不另造假数据库。证据：`create_app(source_gate=…)`、`open_collector(source_gate=…, source_transport=…, media_transport=…, media_uploader=…, comment_client_factory=…, clock=…)`、`serve(source_gate=…)`、`RequestsCommentClientFactory(gate=…)`、`SourcePacer(sleep=…)`；用例使用真实 `Store`＋临时 SQLite。
- [x] 以请求账本证明原有调用覆盖无遗漏、无额外请求及重复等待；既有正常／失败回归通过。证据：发送序列 == 许可序列（API 与采集两处）、每次发送一条报告、六次等待账本、票范围回归 400 passed。
- [x] 本票范围内的运行说明和装配测试同步更新；未新增风控开关、自动恢复、分页持久断点或全局串行策略。证据：[后端 README「统一源请求发送入口」](../../../backend/README.md)＋`create_app` 签名段；`archive_support.archive_client(..., gate=…)`；无环境变量、无迁移、无管理接口、`storage.py`／`contracts.py` 未改。

## 验证范围

为 RC-02、RC-05、RC-09 建立发送入口覆盖先例，不单凭本票宣称这些验收项全部完成。只使用隔离替身；不访问真实 B 站或修改生产环境。

## Answer

新建 `backend/bili_monitor/source_gate.py` 作为唯一的发送许可／结果报告 Interface：`SourceGate.permit(request)` 在发送前取许可、`report(request, report)` 在返回或失败后报告，`SourceRequest` 只带「接口类型＋方法＋主机＋路径」（分类按主机＋路径模板，query 中的资源 ID／页码不产生新类型），非 B 站主机返回 `None` 原样放行。默认实现 `OpenSourceGate` 一律放行且不记录，所以本票上线不改变任何网络行为。

接入点只有两处新代码，均在既有传输 seam 上，业务解析函数一行未改：

- `GatedAsyncTransport`（HTTPX 最内层 `httpx.AsyncBaseTransport`）：覆盖 opus 网页、detail、feed、UP 资料、作者校验与图片下载；跟随重定向时每一跳都会再进这里。生产装配顺序是「外层 `PacedSourceTransport`（既有 0.8–1.5 秒 feed／0.3–0.4 秒根页等待）→ 内层 gate」，注入替身时不额外加等待。
- `comment_client._SourceSession.send`（Requests 逐跳）：覆盖评论计数、根页、楼中楼与首页／空间预热。Requests 自己解析跳转，因此每一跳都重新取许可；用 `ThreadSourceGate` 把异步 `permit`／`report` 桥接进线程池里的同步发送。跟随跳转时最终响应由跟随它的那一跳报告一次，外层不重复计数——412／429 永不被跟随，因此一定在返回它的那次调用里报告一次。

装配注入位（后续 03／04／08 复用，不需要另造入口）：`create_app(..., source_gate=…)`、`collector.serve(..., source_gate=…)`、`collector.open_collector(..., source_gate=…, source_transport=…, media_transport=…, media_uploader=…, comment_client_factory=…, clock=…)`、`RequestsCommentClientFactory(..., gate=…)`。预热仍保持 best-effort 不抛异常（行为不变），但 `report` 发生在吞异常之前，风控不会因预热吞异常而漏记。

明确未做：HTTP 412／429 暂停、六档冷却、按接口探测、观察期与人工态、`GET /api/manage/risk`、`SOURCE_RISK_PAUSED`、楼中楼 100ms 页后等待、分页持久续采、单路重型调度、每页业务 ID 日志与系统告警、性能对照。跨进程持久状态没有用进程内对象冒充，留给 03／08 接同一 SQLite。未访问真实 B 站／OSS／飞书，未部署。

## Comments

- 2026-10-27 领取并按 TDD 纵向切片实施（Status: claimed → 全部证据齐备后置 resolved）。新增 `backend/tests/test_source_gate.py` 9 例；票范围 17 个测试文件回归 400 passed（本票前全量基线 1091 passed in 200.27s，全量复跑由主线在组合阶段执行）。逐片红绿、两次测试自身纠错与一次语义纠正（重定向重复报告）见 [evidence §2](../evidence/01-unified-source-entry.md#2-红绿过程tdd纵向切片)。
- 实施中确认的一处与直觉不同的既有行为：显式初始化链**不**发评论计数请求（`fetch_comment_count` 只由固定检查调用），因此计数覆盖由采集进程用例负责，未改生产分类。
- 遗留风险（不阻塞本票）：Requests 侧许可在线程池中同步等待事件循环，03 的 `permit`／`report` 必须是短事务且不得再取该会话的 pacing 锁，否则会在工作线程里自锁。
