# 10 多进程组合与性能验收：实施与证据

对应票据：[10 多进程组合与性能验收](../issues/10-integrated-performance-verification.md)；策略唯一来源：[B 站限流／风控保护与全量归档续采](../../../docs/design/bilibili-risk-control.md)（§3—§7、RC-01—RC-12）；实施范围与测试决策：[父规格](../spec.md)；运行契约：[采集契约](../../../docs/backend/api/collector-api.md)、[管理契约](../../../docs/backend/api/management-api.md)、[归档契约](../../../docs/backend/api/archive-api.md)、[发现契约](../../../docs/backend/api/discovery-api.md)、[通知契约](../../../docs/backend/api/notification-process.md)。

结论：**本票范围内的隔离组合验证已完成**——真实 API＋独立采集＋独立通知三个进程共享同一临时 SQLite，外部只替换 B 站来源、图片 CDN、OSS 上传与飞书 HTTP；8 目标（含 1 万条楼中楼回复）完整归档、跨进程单路与页后 100ms、412 跨进程暂停与本地可用性、六档探测／人工／观察期、进程终止与 owner 接管、分页与定位续采、日志与告警均已覆盖。**整体性能未验收**：参考 Adapter 只能按静态核对重建，无法证明与原始脚本完整等价；性能公式是非硬性参考目标，本次一次有界对照未达标（见 §6），不阻塞本票与交付。真实 B 站／OSS／飞书、生产数据库、部署、重启与压测仍未验证且未执行。

## 1. 环境、基线与命令

| 项 | 值 |
| --- | --- |
| 工作树 | `/tmp/bili-risk-control-10`，分支 `wt/bilibili-risk-control-10` |
| 基点 | `spec/bilibili-risk-control@32c1064`（08 已合入；09 在其祖先） |
| 运行时 | Linux，Python 3.12.15（`uv sync --locked`），pytest 8.4.2、httpx 0.28.1、fastapi 0.115.12 |
| 代码定位 | 工作树无 `.codegraph/` 索引，按 `docs/agents/codegraph.md` 跳过条件回退到源码阅读与 grep |
| 前端子树 | `92502ec70610793f1aa286e5ae37f048a5ecda11`（未改动，沿用 `/tmp/bilibili-risk-control-frontend-verification.md` 的 `pnpm check`／`pnpm check:dist` 通过记录） |
| 迁移 | schema **v27**；`test_migrations.py` 验证未来版本 28 拒绝启动且不改写版本 |

命令均在仓库根执行（隔离环境，无真实网络访问）：

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| 本票新增 | `uv run --no-sync pytest backend/tests/test_integrated_risk_control.py backend/tests/test_integrated_performance.py -q` | **8 passed**（约 150s；修正 owner 日志与预算断言后由票范围／全量再次覆盖） |
| 票范围回归（36 个文件） | 与下方全量同一组文件的票面子集（`test_integrated_*`、08／07／06／03／04／05／09、通知告警／三进程、迁移、归档生命周期等） | **437 passed**（340.90s） |
| 全量后端 | `uv run --no-sync pytest backend/tests -q` | **1212 passed**（670.52s，3 条既有弃用警告；最终提交树） |

## 2. 组合装配与被替换边界

新增 `backend/tests/integrated_fixture.py`：

- **真实进程**：API 用 `uvicorn backend.tests.integrated_fixture:create_app --factory`，采集进程用 `python -m backend.tests.integrated_fixture --database …`（生产锁、节拍、信号与 `open_collector` 装配），通知进程用生产入口 `python -m backend.bili_monitor.notifier`。
- **真实路径**：检查、单路重型步骤机、`dispatch_leases` 发送／重型／目标租约、`RiskGate` 状态机、`RiskProber`、根页／楼中楼持久续采、归档短事务、事务发件箱与投递调度全部为生产实现；HTTPX 与 Requests 两条真实发送路径都经过统一许可与页后等待。
- **只替换外部边界**：受控虚构来源（HTTPX transport 与 `requests.Session.send` 两处）、图片 CDN 字节、OSS 上传替身（校验内容并返回公开地址）、飞书 HTTP 接收端（`FeishuStub`）。控制文件 `state.json`（文档版本、根／回复集合、媒体、受控失败页、locator）、`clock.txt`（跨进程受控时间）、`ledger.txt`（角色／接口／页码／send|done／时间／oid，跨进程 `flock`）、`risk.arm`（`[角色:]类型` 返回 412）、`probe.fail`、`hold.<类型>.<页>`、`upload.hold`。
- **不使用** FakeProcess、假 Store、进程内共享字典或只罗列独立单元数代替组合证据。
- **明确预算**：每个组合回放都在 `Stack.wait(..., timeout=…)` 上设等待上限，并在关键节点调用 `check_budget()`（来源请求 ≤ 6000、墙钟 ≤ 300s）失败即止；性能对照另设请求 ≤ 700、虚拟等待 ≤ 120s、墙钟 ≤ 120s，失效时不会无限等待或靠重复请求继续放大预算。

新增 8 个用例，覆盖组合场景；逐项证据映射见 §3，既有票已证明的细节直接引用其专项文件，不重复伪造。

## 3. RC-01—RC-12 台账

| 条目 | 命令／可重复场景 | 结果与样本 | 未验证项 |
| --- | --- | --- | --- |
| RC-01 全量与公平推进 | `test_three_processes_archive_eight_targets_and_ten_thousand_replies` | 8 目标、巨大目标 10,000 条楼中楼；巨大目标 `source_comment_count=10001`、`local_reply_count=10000`、四项 work success；7 个小目标正文／评论／回复 success；其他目标的正文请求都早于巨大目标第 2 页回复请求；轻量计数请求贯穿 | 真实上游规模与速率未验证；未跑真实 8 目标 |
| RC-02 统一许可与串行 | 同上；账本 `send/done` 并发度断言 | 跨进程账本角色同时含 `api` 与 `collector`，任一时刻最多 1 个未完成来源请求；API 手动初始化受同一许可 | 真实平台并发阈值未验证 |
| RC-03 楼中楼 100ms | 同上；`reply_windows()` 逐页配对 | 500+ 次真实楼中楼请求；每次 `done` 后下一个来源发送（含另一进程）均 ≥ 0.095s；日志 `wait_ms=100`。增量、失败重试、空尾确认、探测等待由既有 `test_reply_page_pacing.py`、`test_risk_probe.py::test_reply_probe_goes_through_the_production_comment_session_for_one_hundred_ms` 覆盖并纳入本票回归 | 真实墙钟抖动未验证（断言按 0.095 留时钟粒度） |
| RC-04 可验证续采 | `test_killed_pagination_resumes_confirmed_pages_and_keeps_new_observation`、`test_locator_change_after_kill_regenerates_without_mixing_resources` | 强行 kill 后重启：第 1 页已确认不重下；在途页与重叠页安全重读；新计数 80→100 完整补齐；插入新根（页移动）后根集合 3 完整；来源缩小到 40／2 不清除本地 100／3，也不无限重扫。locator 由 basic 切到动态 ID 兜底时重新读 detail、重定位并完整归档 40 条，不拼接旧资源 | 真实上游页漂移速率未验证；分页删除／移动的更多组合沿用 06／07 证据 |
| RC-05 全入口触发与暂停 | `test_one_process_412_pauses_every_source_but_keeps_local_commit_and_upload` | 采集进程计数接口 412 → 状态 `cooldown` 第 1 档；另一进程与采集进程此后 0 条来源发送；新增 UP／目标校验返回 `503 SOURCE_RISK_PAUSED`＋`Retry-After`；归档读取、管理停用／删除仍可用；手动初始化与媒体重试在租约释放后 503；未创建半成品身份／目标 | 预热与图片专用入口未单独诱发真实 412（同一 gate／测试覆盖由 01／03 提供）；真实 412 未复现 |
| RC-06 六档、重启与接管 | `test_six_step_ladder_manual_probe_observation_and_business_notifications`、`test_cooldown_deadline_probe_lease_and_observation_survive_kills`、`test_observing_retrigger_reuses_the_next_step_and_sixth_goes_manual` | 6 档 60/120/240/480/900/1800 逐档到期由真实采集进程探测；每轮失败只推进一档，触发类型先探测且其余类型保持 `pending`（短路）；第 6 档失败转 `manual`。冷却期强杀后重启期限与档位原样保留；探测租约未过期不能接管，过期后采集进程接管并重新确认本轮；旧 owner 的迟到 `finish` 被拒（`None`），状态与轮次不被覆盖。观察期重启保留档位、观察时间重新累计 | 真实时间墙钟边界未验证（受控 `clock.txt`）；Retry-After 抬升由既有 `test_risk_cooldown.py` 覆盖并纳入回归 |
| RC-07 按接口探测 | 同上两个风控用例；`test_risk_probe.py`、`test_risk_probe_processes.py` | 探测类型按触发 ∪ 待执行工作取并集；一类失败立即结束本轮，其余不请求；无本地样本保持暂停（既有 04 证据）；探测窗口内采集进程处于 `probing`／`cooldown`，不发送业务请求；探测不提交归档成功时间或业务通知 | 真实各接口拦截差异未验证 |
| RC-08 观察与人工恢复 | 六档用例与观察重触发用例 | 人工态 `POST /api/manage/risk/probe` 只登记、重复登记幂等（采集未运行）；采集领取后全部类型通过进入 `observing`；599,000ms 仍观察、600,000ms 才回 `normal` 并清零档位；观察期再触发沿用下一档，第 6 档后再次触发直接 `manual`。空闲／停机不抵扣由既有 `test_risk_observation.py` 覆盖并纳入回归 | 真实 10 分钟墙钟未等待（受控时钟）；真实人工操作未验证 |
| RC-09 管理反馈与本地可用 | `test_one_process_412_...` | 保护态新增 UP／目标校验／手动初始化／媒体重试明确 503 且无半成品；本地归档 GET、一级评论 GET、管理停用／删除 204 正常；已下载图片在保护态完成 OSS 上传与归档提交（`media` success），上传记录与公开地址正确 | 真实 OSS 未验证 |
| RC-10 流程日志与脱敏 | 8 目标用例读取采集进程真实 stdout 日志 | 能串起 `sync_started`／`body_sync_finished`／`root_page_saved`／`reply_page_saved`（每页 `reply_ids`、`wait_ms=100`、`checkpoint`）／`dispatch_turn`／`media_sync_finished`；业务 ID 为字符串；无 `http://`／`https://`／`Cookie`／`FAKE_`；owner 字段值脱敏为 `unknown`，无 `lease` 令牌。既有负向断言（`test_flow_logs.py`、`test_profile_diagnostics.py`）纳入回归 | 真实 journald 保留期与平台日志量未验证 |
| RC-11 系统告警与通知隔离 | 六档用例＋暂停用例；`test_risk_alerts.py` 回归 | 触发与转人工恰各一条系统群消息，逐档等待／每类结果不刷群；人工探测通过不产生恢复告警；稳定恢复后一条恢复消息；风控期间与探测不产生业务消息；恢复后新一级评论仍按既有资格进 UP／全员群，系统群不混入评论正文；`off`／`system_only` 行为由 09／15 证据与回归覆盖 | 真实飞书群与平台限流未验证 |
| RC-12 性能与请求预算 | `test_bounded_performance_comparison_reports_truthfully` | 见 §6：同一样本、虚拟时钟、结果集合完整；请求数与显式等待逐类报告；参考 Adapter 为静态重建，请求集合不等价，**整体性能未验收**；公式未达标但为**非硬性**目标，不阻塞本票 | 真实网络延迟、真实平台吞吐、原始脚本实测均未验证 |
| 既有行为回归 | 票范围 437 passed；全量后端见 §8 | 来源未知／受限、停止／重纳入、媒体交错、冻结阅读分页、迁移、只读 GET 不触发上游等保持 | — |

## 4. 红绿过程与发现的真实缺陷

1. **注入时钟下探测崩溃（真实缺陷，已修复）**：`open_collector` 把 `clock` 对象直接传给 `RiskProber(clock=...)`，而该参数约定是“返回单调秒的可调用”。生产默认 `clock=None` 时不暴露；任何注入受控时钟的装配（运维临时时钟、本票跨进程测试）在到期探测时抛 `TypeError`，采集主循环以 `collector_loop_failed reason=type_invalid` 退出，冷却恢复永久卡住。
   - 修复：`backend/bili_monitor/collector.py` 传 `clock.monotonic`（`None` 时保持默认）。
   - 红线复现：临时改回 `clock=clock` 后运行
     `pytest backend/tests/test_integrated_risk_control.py::test_cooldown_deadline_probe_lease_and_observation_survive_kills -q`
     → **1 failed**（9.52s）；恢复后同一命令 **1 passed**（9.16s）。
2. **内部 owner 令牌泄漏进日志（真实缺陷，已修复）**：`dispatch_turn` 直接记录 `self.scheduler.owner`（`uuid4().hex`）。日志白名单允许 `[a-z][a-z0-9_]{0,63}`，因此当 32 位十六进制以 `a`—`f` 开头时会原样输出内部令牌；以数字开头时才被脱敏成 `unknown`，形成随机泄漏。全量运行恰逢字母开头，`owner=e046bf...` 被抓到。
   - 修复：改为只记录 `heavy_held=true|false`，不输出任何 owner／租约值。
   - 红线复现：恢复旧字段后 `test_three_processes_archive_eight_targets_and_ten_thousand_replies` 失败于 `assert "owner=" not in log`；修复后同一用例通过。
3. **测试全局发送补丁泄漏（测试缺陷，已修复）**：性能用例最初直接赋值 `requests.Session.send`，泄漏到同进程后续用例，导致 `test_risk_pause`／`test_source_gate` 4 例失败。改为通过 `monkeypatch.setattr` 注入后，相关 22 例全部通过；正式组合装配仍在子进程内安装补丁，不污染父测试进程。
4. **既有最终一致等待在组合负载下偶发超时（测试装配，已收敛）**：票范围一次运行中 `test_collector.py::test_fixed_ticks_skip_busy_check_without_blocking_other_targets` 在重负载后超过 `eventually` 的 3s 上限；单跑立即通过，断言逻辑与生产调度未变。只把测试辅助的最终一致等待上限放宽到 10s，不改变断言语义或产品行为；随后票范围 437 passed。

## 5. 组合场景的请求／行为样本

- **8 目标全量回归**（`test_three_processes_...`）账本（一次运行）：`replies` 502 次、`root_comments` 24 次、`opus_page` 24 次、`detail` 16 次、`comment_count` 276 次、`image_hdslb` 8 次、`profile` 1 次、首页／空间预热各 1 次；角色同时包含 `api` 与 `collector`；`dispatch_leases` 无并发重型；`reply_page_saved ... wait_ms=100`。
- **暂停回归**：采集进程在第 1 档冷却后，账本长度在 0.6s 内不变；API 的 `POST /api/manage/ups` → 503＋`Retry-After`，`POST /api/sync/initial`（目标租约释放后）→ 503；`DELETE` 目标 → 204；保护态上传完成（`uploads.txt` 记录 + 归档 `media` success）。
- **续采**：强杀后第 1 页仅发送 1 次；重启后增量方向为 reverse，末页 5 新增 20 条，向前重叠校验到已知页 2；新根插入后根数 3、回复 100 保留；来源缩小后本地仍 100／3。
- **定位变化**：页面信号不可用时重新读 detail，`comment_locator` 变为 `oid=91001,type=11`；旧断点不作为新资源续采，最终 40 条回复 ID 集合完整。
- **告警**：六档 + 人工 + 观察用例中系统群风控消息恰为 `来源触发风控保护...`、`自动恢复耗尽...`、`连续正常采集后已稳定恢复...`；业务群在风控与探测期间为 0，恢复后新评论按既有资格投递。

## 6. RC-12 一次有界对照与开销报告

命令：`uv run --no-sync pytest backend/tests/test_integrated_performance.py -q -s`。两侧使用同一固定样本（8 目标、巨大目标 10,000 条回复、无媒体、无故障）、虚拟时钟（显式等待可加总）、固定随机（区间中点）、真实临时 SQLite；参考侧按 `script_demo` 静态核对规则在测试内重建请求序列（不执行、不导入原脚本），关闭 inline 预览复用（A1），为协议确认页补 1 次请求（A2，方向是让参考侧多做）。

```text
targets=8 replies=10000
project_requests  = {comment_count: 8, detail: 16, opus_page: 16, replies: 502, root_comments: 24}
reference_requests= {comment_count: 8, detail: 8,  opus_page: 8,  profile: 1, replies: 501, root_comments: 16}
T_new(virtual)=58.95s   T_reference(virtual)=5.95s   P_replies=501
budget = 1.2*T_reference + 0.1*P_replies = 57.24s
meets_non_hard_goal = false    equivalent = false
project_only_costs = {sqlite_page_transactions: 566, notification/oss/warmup: 单列未计入}
```

结论与边界：

- **整体性能未验收**。请求集合无法逐条等价：项目侧检查＋归档对页面／详情各多读一次，根页有额外的空尾页与确认页（24 vs 16），楼中楼比 `P_replies` 多 1 个探空页；这些不能无损等量加到参考侧，也没有用重复请求扩大预算。
- 结果完整性是硬要求且已满足：10,000 条回复 ID 集合与 8 个根集合完整、`work` 成功。
- 公式为非硬性参考目标；本次一次对照未达（58.95s > 57.24s），如实披露，**不为达标反复调参或阻塞本票**。可比链路（请求数与显式等待）之外的 SQLite 页事务、通知进程、OSS 上传与会话预热只能单列，未混入比值。

## 7. 迁移与文档同步

- 迁移保持 v27：`test_migrations.py` 断言 v27、未来 v28 拒绝启动且不改写版本；三进程写出的库在停机后重复迁移保留归档、配置、检查与通知队列（既有票 10 证据与本次回归）。
- 正式文档已同步：`docs/README.md`（工作行与 10 证据）、`docs/design/bilibili-risk-control.md`（实施状态与 §7／§8）、`docs/product/SRS.md`（FR-16 实施状态与 AC-25 风控例外限定）、`docs/design/HLD.md`（模块职责与固定节拍例外）、`docs/backend/api/collector-api.md`（10 组合验证与状态）、`management-api.md`（迁移版本与保护态边界）、`archive-api.md`（保护态读取与手动操作）、`discovery-api.md`（暂停与不补发）、`notification-process.md`（10 组合与告警边界）、`backend/README.md`、`docs/deployment/static-delivery.md`（组合证据指针）。

## 8. 未验证与边界

- 未访问真实 B 站／OSS／飞书，未触发真实 412／429，未部署、未重启任何现有服务或生产数据库；真实平台并发阈值、长期稳定性、真实页漂移与真实群表现均未验证。
- 所有时间边界用受控 `clock.txt` 与虚拟时钟验证，未真实等待 10 分钟或等待档位墙钟。
- 未采集真实 journald 保留期、真实资源占用与目标机三进程容量。
- 全量最终运行（提交后同一棵树）：`uv run --no-sync pytest backend/tests -q` → **1212 passed**（670.52s）；票范围最终 **437 passed**（352.99s）。两者均在两项真实缺陷修复与最终一致等待上限收敛之后执行；组合回放均带等待超时与请求／墙钟预算，性能对照带请求、虚拟等待与墙钟三重预算。
- 前端未改动，沿用 `92502ec` 子树对应的 `/tmp` 门禁证据；本票未新增页面、面板或采集按钮。
- 性能结论只覆盖一次受控回放，不构成生产吞吐、容量或 B 站安全频率承诺。
