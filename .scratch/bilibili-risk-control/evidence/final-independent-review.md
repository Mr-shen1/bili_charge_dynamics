# 最终独立审查整改：逐项处置与验证证据

范围：独立双轴审查（`423402f`…`5aeff28`）提出的 13 项（Spec 轴 4 项、Standards 轴 A1–A3 与 B1–B6）在 `wt/bilibili-risk-control-review` 上的逐条处置。审查原文见审查线程临时文件（`/tmp/bilibili-risk-control-spec-review.md`、`/tmp/bilibili-risk-control-standards-review.md`），本文只记处置、修复点、红绿过程与未验证项。

结论：**13 项全部有明确处置**——8 项修复（Spec1／Spec3／A1／A3／B1／B2／B5／B6）、2 项部分处置（Spec2：补预热，资料不盲目并入；B3：删无调用整轮入口，保留 `replies.sync_replies` 作历史专项回归适配器）、2 项判断性建议保留（Spec4、B4）、1 项判为误报并补文档澄清（A2）。后端全量绿，前端未改。真实上游、OSS、飞书、部署、重启与压测均未执行。

## 1. 现场与接续说明

- 基点：`5aeff28`（`spec/bilibili-risk-control` 当时 tip，与 `wt/bilibili-risk-control-review` 相同）。接手时工作树有 23 个已跟踪文件为 dirty、`backend/bili_monitor/page_resume.py` 未跟踪，**没有任何提交**——上一 implementer 因 provider 连接错误中断，最后一句是「Now the collector cleanup (odor 5 & 6)」。
- 处置原则：保留全部既有未提交改动，不重置、不覆盖重写；逐项审阅已有 diff 后只补未完成与判错的部分。审阅结论：观察期业务成功上报（Spec1）、接口类型常量（B1）、根页／楼中楼锚点共用（B2）、删除无调用整轮同步（B3）、人工态固定原因（Spec3）、探测预热判定（Spec2）的**实现主体已在**，但缺最终收口：`collector.py` 的五处租约清理仍是复制块（`_drop_session` 只写了定义没有调用点）、若干文档未同步、缺红绿证据。
- 代理解析：本工作树无 `.codegraph/` 索引，按 `docs/agents/codegraph.md` 的跳过条件回退到源码阅读与 grep；未起任何子代理。
- 未执行：真实 B 站／OSS／飞书请求、生产库迁移、服务重启或部署、前端命令。

## 2. 13 项逐条处置

| # | 审查项 | 处置 | 修复点（本次提交） | 红绿证据 |
| --- | --- | --- | --- | --- |
| Spec1 | 观察期把 HTTP 200／3xx 当业务成功 | **修复**（核心） | `RiskGate.report` 不再按状态码记账；新增 `note_business_success`（`source_endpoints` helper → `SourceGate` 方法 → `GatedAsyncClient`／`RequestsCommentClient` 转发），业务解析成功后各自上报 | `1681ff3`；红→绿两组见 §3.1 |
| Spec2 | 探测集合漏掉恢复后实际需要的预热 | **部分修复**：预热按「恢复后真会发」并入；`profile` **不加**（判断项，证据保留） | `required_types(facts, *, warmup_due=)` + `WarmupCache.due`／`RequestsCommentClientFactory.warmup_due` + `open_collector` 注入 | `72d1b59`；红→绿见 §3.2 |
| Spec3 | 人工态无类型时静默每拍空转 | **修复** | `RiskGate._refuse_claim("no_required_types")`：按状态代次一条 `risk_probe_skipped`，仍不放行、不改档位与登记 | `72d1b59`；红→绿见 §3.3 |
| Spec4 | 样本失效不换样本（判断项） | **保留不改**：判为“只允许 ≠ 必须重试”的误读，见 §4.1 | 无代码改动 | 无（判断项） |
| A1 | `dispatch.py` 迁移注释写 v26，实际 v27 | **修复** | `dispatch.migrate` docstring → v27 | `d2f9637`；`grep -n v26 backend/bili_monitor/dispatch.py` 无输出 |
| A2 | `.scratch/.../issues/*` 的 `Status: resolved` 违反 triage 标签表 | **误报**，不改票面；只澄清执行状态与 triage 状态的区别 | `docs/agents/issue-tracker.md` 一句话澄清 `claimed`／`resolved` 是 wayfinding 执行状态 | 依据见 §4.2；票未回退、`triage-labels.md` 未加 `resolved` |
| A3 | 设计 §5 的状态字段表缺 `generation`／`observation`／`manual` | **修复** | `docs/design/bilibili-risk-control.md` §5 GET 字段补全三类摘要 | 文档项，无测试；与 `collector-api.md` 对齐 |
| B1 | 接口类型是裸字符串（Primitive Obsession／Shotgun Surgery） | **修复** | `source_endpoints` 集中常量（含图片域族与预热类型）；Gate 分类、页后等待、探测、上报、日志、图片域族判定共用 | `b0a4a1b`；`grep` 生产代码已无裸类型字面量（§3.5） |
| B2 | `root_comments`／`replies` 锚点复核约 70 行重复 | **修复** | 新增 `page_resume.py`（`locate`／`reread_heads`／`resume_reason`），两处只保留自己的保存与事件字段 | `b0a4a1b`；红→绿见 §3.4 |
| B3 | `sync_target` 无调用者、`sync_roots` 仅被它调用、两套 `body_complete` | **部分整改**：无调用的 `sync_target`／`sync_roots` 已删；`replies.sync_replies` 作为历史专项回归适配器**有理由保留**（CodeGraph：6 处引用全在 `test_reply_incremental.py`／`test_reply_page_pacing.py`／`test_reply_page_resume.py`，生产代码无调用者，也不参与生产分派），后续迁移这三个测试时再删。属判断性建议，不是功能阻塞，见 §4.4 | 删除 `sync_target`／`sync_roots` 与相关导入；`sync.py` 只留 `initialize`／`comment_metadata`／`sync_body`，模块说明与 `sync_replies` docstring 按实际范围重写、标注适配器身份；`comment_status.optional_epoch` 笔误「元法解析」改「无法解析」 | `b0a4a1b`；`grep -rn "sync_target\|sync_roots" backend/` 无输出；本文收口提交补文案与适配器注记（行为未改） |
| B4 | 21 处 `except SourceRiskPaused: raise` 易漏写 | **判断保留**：显式透传是完成判定的边界，不改为 `BaseException` 或 magic，见 §4.3 | 无代码改动 | 无（判断项） |
| B5 | `collector.execute_pending` 五份租约清理块，存在重复释放与漏 `attempted` | **修复** | 唯一收单入口 `_drop_session(settled="result"｜"failed"｜None)`：三态各释放一次、出表、记已尝试 | `d2f9637`；红→绿见 §3.6 |
| B6 | 小项：暂停日志字段各拼一处、`_epoch` 两份回退语义不同 | **修复** | `_log_paused` 统一暂停日志；`comment_status.optional_epoch` 收敛解析，风控侧“缺失即关闭”、租约侧在自己的调用点显式回退真实时间（语义不变） | `1681ff3`／`d2f9637`；红绿沿用既有风控／租约用例（行为保持） |

## 3. 红绿过程与命令

红线一律用“把实现改回有缺陷的形态”构造，绿线用 `git checkout -- <file>` 恢复后同一命令复跑。命令都在 `/tmp/bili-risk-control-review` 下执行。

### 3.1 Spec1：观察期只认业务解析成功

- 红：在 `RiskGate.report` 重新加回 `if report.status_code in range(200, 400): self._source_successes += 1`。
  - `uv run --no-sync pytest backend/tests/test_risk_observation.py -q -k http_success_or_redirect` → **1 failed**（`test_http_success_or_redirect_alone_never_advances_the_observation_window`）。
  - `uv run --no-sync pytest backend/tests/test_risk_observation_collector.py -q -k business_rejection` → **1 failed**（`test_business_rejection_on_comment_endpoints_never_counts_as_recovery`）。
- 绿：恢复后同一命令 → **1 passed**／**1 passed**。
- 覆盖面：只发 2xx／3xx（含 204、302）不推进；评论接口连续 `200 + code=-352` 十二分钟不推进、也不登记 `risk_stable` 系统告警；真实成功仍能满十分钟清零（`test_collector_clears_observation_after_ten_active_minutes_of_real_collection`）。

### 3.2 Spec2：探测集合并入“恢复后真会发出”的预热

- 红：把 `required_types` 的预热分支短路成 `if False and warmup_due(...)`。
  - `uv run --no-sync pytest backend/tests/test_risk_probe.py -q -k warmup` → **1 failed**（`test_probe_covers_warmups_only_when_recovery_really_warms_a_session`）。
- 绿：恢复后 → **1 passed**。
- 用例三段：① 冷启动（无预热记录）→ 必需集含两类预热，且**不含** `profile`；② 真实使用会话后 `warmup_due([UID]) is False`，探测轮不出现预热类型、也没有预热 URL 请求（**缓存命不额外 probe**）；③ 时钟越过预热 TTL 再触发 → 预热类型一并探测、两类预热 URL 真的发出。

### 3.3 Spec3：人工态无可验证类型的固定原因

- 红：删掉 `_claim_probe` 里的 `self._refuse_claim("no_required_types")`。
  - `uv run --no-sync pytest backend/tests/test_risk_manual_probe.py -q -k without_verifiable_types` → **1 failed**。
- 绿：恢复后 → **1 passed**。
- 用例同时断言三拍只留一条 `risk_probe_skipped`（`reason=no_required_types`、`risk_state=manual`）、登记幂等、状态与档位不变、仍拒绝领取。

### 3.4 B2：锚点重定位共用实现

- 红：让 `page_resume.locate` 直接 `return None, None`（等于两处续采都退化成“锚点永远找不到”）。
  - `uv run --no-sync pytest backend/tests/test_reply_page_resume.py backend/tests/test_root_page_resume.py -q` → **5 failed**（对齐续采、页移动只重定位受影响页、头部插入、头部删除四类场景）。
- 绿：恢复后 → **17 passed**。

### 3.5 B1：类型常量集中

- `grep -rnE '"(comment_count|root_comments|replies|feed|detail|profile|opus_page|homepage_warmup|space_warmup|image_hdslb|image_biliimg|source_other)"' backend/bili_monitor --include=*.py` → **无输出**（生产代码不再写字面量；测试里保留字面量作为协议断言）。
- `uv run --no-sync pytest backend/tests/test_source_gate.py backend/tests/test_reply_page_pacing.py -q` → 全绿（分类与页后等待仍按同一份类型工作）。

### 3.6 B5：目标会话唯一收单入口

- 红：在 `_drop_session` 的结算路径前多加一次 `await session.target_lease.release()`。
  - `uv run --no-sync pytest backend/tests/test_collector.py -q -k session_exit` → **1 failed**（`test_target_session_exit_settles_or_releases_the_lease_exactly_once`）。
- 绿：恢复后 → **1 passed**。
- 该用例钉住三态：`result`／`failed` 由 `_finish_session` 释放一次、`None` 直接补释放一次；三态都出表并记入本拍已尝试。

## 4. 判断项与误报的证据

### 4.1 Spec4「样本失效只允许从本地选其他样本」→ 保留不改

设计 §4.3-5 的原文是“当前样本失效时**只允许**从本地选择其他已知有效样本，不能在线无限寻找或把 404 当接口恢复”：它约束“允许的来源范围”，不是“必须逐样本重试”。当前实现的 `storage.risk_probe_facts` 每类给一个本地样本，失败按“本轮未通过”结束、下一档再探；这与“一轮失败只推进一档、其余接口不再请求”（§4.3-3）一致。按“必须品尝试下一个样本”整改会扩大探测轮次与请求数，与 §4.3-3 的短路与“不为凑探测发请求”冲突，因此不改；若未来要求“一轮内换样本”，应先改设计条文。

### 4.2 A2「`Status: resolved`」→ 误报

`docs/agents/issue-tracker.md` 的 Wayfinding 段明文规定：wayfinding 子票的 `Status:` 记录 `claimed`／`resolved`，`Resolve` 操作就是“append the answer … set `Status: resolved`”。`triage-labels.md` 的五值是**分流**角色，两者不是同一枚举。本 spec 的票据通过领取、完成与 `Answer` 记录执行状态，实施工作流沿用 `claimed`／`resolved` 收口，不把关闭工单当作分流角色。因此不改票面、也不把 `resolved` 加进 `triage-labels.md`（那会让分流表与执行状态混为一谈）。为避免再次误判，`issue-tracker.md` 的 Conventions 段补一句：同一 `Status:` 行在 wayfinding 领取后写执行状态，`claimed`／`resolved` 不进 triage 表。

### 4.3 B4「21 处 `except SourceRiskPaused: raise`」→ 保留

这些透传点都在“一次尝试的边界”上：暂停必须原样穿出，才能让上层保留 running 领取与已提交分片、只记一条固定日志而不是记成普通失败。改成 `except BaseException: raise` 会顺手吞掉取消与真实崩溃；改成统一判定函数要把整条调用链的异常语义搬到包装层，收益是少写 21 行 `raise`、代价是“哪一层负责透传”变得不可见。当前显式写法把边界写在调用点上，且每个点旁边都有“暂停不是失败”的注释；因此记录为合理边界隔离，不做改动。

### 4.4 B3「保留 `replies.sync_replies`」的理由

无调用者的整轮入口 `sync_target`／`sync_roots` 已删除；`replies.sync_replies` 在生产代码同样无调用者（CodeGraph：6 处引用全部落在 `test_reply_incremental.py`／`test_reply_page_pacing.py`／`test_reply_page_resume.py`），但它是这三个历史专项测试的整轮回归适配器，职责是钉住逐楼逐页、失败／重开／风控后续采与楼级节奏，不参与生产分派。现阶段删除它要连带把三个测试改成 `reply_scan_step` 的单页写法，属于测试迁移而非本次收口范围；保留一份不与生产分派相连的历史入口，只为避免在最后一次文案收口里额外开一轮测试重写。因此把它记为**部分整改＋有理由保留**：后续迁移这三个用例时与 `sync_replies` 一并删除，使“两套完成判定”彻底只剩一套。这是审查建议项，不是功能阻塞。

为避免再次误读为“所有整轮 wrapper 已移除”，`sync.py` 模块说明已改为只声明本模块的事实（`sync_target`／`sync_roots` 已删、只留 `initialize`／`comment_metadata`／`sync_body`），并明写 `replies.sync_replies` 仍作适配器保留；`sync_replies` 的 docstring 也标了同样身份。两处均为注释，不改行为，不迁移用例。

## 5. 命令与结果

| 命令 | 结果 |
| --- | --- |
| `uv run --no-sync pytest backend/tests -q`（收口前，接手现场＋本次代码改动） | **1217 passed**，3 warnings，676.27s |
| `uv run --no-sync pytest backend/tests -q`（四个概念提交后的最终树） | **1217 passed**，3 warnings，681.66s |
| 提交树逐条复验（`git archive <commit> \| tar -x -C /tmp/verify-*`，用同一 `.venv` 的 pytest 跑） | `b0a4a1b`：84 passed；`1681ff3`：35 passed；`72d1b59`：30 passed；`d2f9637`：18 passed |
| `uv run --no-sync pytest backend/tests/test_risk_probe.py backend/tests/test_risk_observation.py backend/tests/test_risk_observation_collector.py backend/tests/test_risk_manual_probe.py backend/tests/test_risk_alerts.py -q` | 34 passed |
| 定向复跑（审查代理记录，非本次新跑） | Spec 轴：50 passed（probe／observation／observation_collector／manual_probe／reply_page_resume／root_page_resume／source_gate）＋22 passed（collector／cadence／risk_collector／fair_serial）；Standards 轴：47 passed（risk_probe／risk_observation／risk_manual_probe／root_page_resume／reply_page_resume／risk_alerts） |
| 本文文案收口后（仅注释与证据改动） | `git diff --check` 干净；`uv run --no-sync python -m py_compile backend/bili_monitor/comment_status.py backend/bili_monitor/sync.py backend/bili_monitor/replies.py` 通过；`pytest test_reply_page_resume test_reply_page_pacing test_reply_incremental test_risk_observation -q` → **34 passed**（适配器与解析函数行为未变） |
| `uv run --no-sync pytest backend/tests/test_reply_page_resume.py backend/tests/test_root_page_resume.py -q` | 17 passed |

前端：`git diff 5aeff28..HEAD --stat -- frontend/` 为空，未改动前端子树 `92502ec`，因此沿用 `/tmp/bilibili-risk-control-frontend-verification.md`（`pnpm check`／`pnpm check:dist` 已在该子树记录），本次不重复执行；后端新增的两类固定提示（`SOURCE_RISK_PAUSED`／`RISK_PROBE_NOT_ALLOWED`）仍走既有错误码映射，未改前端代码。

## 6. 未验证项

- 真实 B 站上游：`200 + code=-352`、HTTP 412／429、真实预热拦截都只用传输替身与 fixture 复现，没有真实网络样本。
- 真实 OSS／飞书、部署、进程重启、生产库迁移与压测均未执行；性能公式仍为非硬性参考，未再优化。
- `WarmupCache.due` 依据的是进程内缓存状态：跨进程（API 预热、collector 探测）不共享该判定，只有在“恢复后由同一采集进程首次取会话”这条路径上有证据。
- B5 的集成侧（真实 `execute_pending` 里五个退出分支）只有 helper 级用例钉住不变量，未逐分支构造上游故障；对应分支的行为改动是“去掉重复释放、补齐 `attempted.add`”，由既有 collector／fair-serial 用例覆盖回归。
- B3 的集成侧不适用（删除型整改）；保留的 `sync_replies` 仍写 `store.finish_replies`，但只被三个历史专项测试触达，生产不经过它。
- Spec4 与 B4 是判断项，未加新测试。

## 7. 提交、合并与全量结果

- 概念提交（`5aeff28` 之后）：`b0a4a1b` 续采锚点与接口类型共用实现、`1681ff3` 观察期只认业务解析成功的请求、`72d1b59` 探测覆盖实际预热与人工态固定原因、`d2f9637` 目标会话收单入口与暂停日志去重，文档同步位于随后的文档提交，具体提交以分支日志为准。
- 合并：`git merge spec/bilibili-risk-control` 输出「已经是最新的」（spec tip 仍为基点 `5aeff28`），`git merge-base --is-ancestor spec/bilibili-risk-control HEAD` 通过。
- 最终全量：`uv run --no-sync pytest backend/tests -q` → **1217 passed**，3 warnings，681.66s（11 分 21 秒），与收口前同数；跑的是四个概念提交后的树（文档改动不影响测试）。

## 8. 独立双轴审查摘要（原文要点与落点）

两轴审查都以 `423402f…5aeff28` 为范围、只读完整 diff 与 spec／设计／10 张票据台账，未跑真实上游；本文的 13 项就是两轴结论的逐条落点。

**Spec 轴（`/tmp/bilibili-risk-control-spec-review.md`）**：总体覆盖度高，提 4 项。

1. 中高——观察期把 HTTP 200 业务拒绝当成功（原文指 `risk.py:359-361` 的 `SUCCESS_STATUSES`），建议由业务解析成功后显式上报 → 本文 Spec1，已按建议改由 `note_business_success` 上报。
2. 中——`required_types` 忽略 identities，预热／资料永不入探测集合（原文指 `risk_probe.py:50-70`），建议待执行评论工作需开新会话时并入预热与资料 → 本文 Spec2：预热按“真会发”并入；资料按“后台无待办”**不并入**。
3. 低——人工态无可探类型时静默空转（原文指 `risk.py:496-501`），建议按代次记一条脱敏固定原因并在状态暴露 → 本文 Spec3：按代次记一条；状态仍用既有 `manual.probe_registered` 表达，未新增字段（设计 §5 允许附加摘要，但此处日志已足够，避免再扩契约面）。
4. 低／判断项——样本失效不换样本 → 本文 §4.1，判为“只允许≠必须重试”，保留不改。
   审查同时确认新增 `observation`／`manual` 摘要与 `generation` 属设计 §5 允许的附加保护摘要，不算扩范围。

**Standards 轴（`/tmp/bilibili-risk-control-standards-review.md`）**：A 类明文偏离 3 项、B 类判断性气味 6 项。

- A1 `dispatch.py:58` 注释 v26 ↔ 实际 v27 → 已改。
- A2 `issues/*` 的 `Status: resolved` 与 `triage-labels.md` 冲突 → 判为误报（`issue-tracker.md` Wayfinding 段明文定义 `claimed`／`resolved`），只补一句澄清，不动票面、不动 triage 表。
- A3 设计 §5 状态字段表缺 `generation`／`observation`／`manual` → 已补。
- B1 接口类型裸字符串（点名 `source_gate.py:29,43`、`risk_probe.py:30,50,197`、`risk.py:47`、`comment_client.py:130`）→ 已集中到 `source_endpoints`。
- B2 `root_comments.py:191` 与 `replies.py:196` 锚点复核约 70 行同形 → 已抽 `page_resume`。
- B3 `sync.py:114 sync_target` 无调用者、`root_comments.py:386 sync_roots` 仅被它调用、两套 `body_complete` → 已删除两者，`sync.py` 只保留 `initialize`／`comment_metadata`／`sync_body`；`replies.sync_replies` 作为三个历史专项测试的回归适配器保留（生产不调用），见 §4.4。
- B4 `except SourceRiskPaused: raise` 21 处（点名 `source.py:142,152`、`sync.py:75,96`、`replies.py:519,591`、`media.py:128`）→ 判断项，保留显式透传，见 §4.3。
- B5 `collector.py:365-430` 租约清理重复 5 次、重复释放 → 已收敛为 `_drop_session`，并补 helper 级回归。
- B6 `source_risk_paused_work_aborted` 两处拼字段、`_epoch` 两份回退语义 → 已抽 `_log_paused` 与 `comment_status.optional_epoch`；租约侧仍保留自己的显式回退。
  审查声明未据旧性能硬门槛判错（RC-12 只记未验收），本次同样不重开性能优化。

## 9. 定向复核的分轴结论（`5aeff28`…`fb017f4`）

**Spec 轴**（`/tmp/bilibili-risk-control-spec-followup.md`）：**无阻塞**。原 3 项成立缺陷（观察期只认业务解析成功、预热并入探测、人工态固定原因）已真修好，共享锚点（`page_resume`）与唯一收单入口（`_drop_session`）未见回归；Spec4「样本失效不换样本」同意保留。剩余边界均为已披露的非阻塞项（`_session_uid` 与 due 判定取源分叉、`open_collector(source_gate=)` 注释路径、真实 `200+code=-352`／412／跨进程重启未验证、性能未验收）。

**Standards 轴**（`/tmp/bilibili-risk-control-standards-followup.md`）：A1／A3／B1／B2／B5／B6 已确认收口；B4 与 A2 按既有裁决不再重开。两条遗留：①B3 残留的 `replies.sync_replies` 已按 §4.4 记录为“有理由保留的历史专项回归适配器”，并把 `sync.py` 的过度声明改成模块内事实，不再声称所有整轮 wrapper 已移除；②本轮引入的 `comment_status.optional_epoch` 笔误「元法解析」已改为「无法解析」。判断项（`risk_probe` 的 uid 取源分叉）记为低、不阻塞，不重开。

复核附带的定向复跑（Spec 轴 50＋22 passed、Standards 轴 47 passed）是审查代理在其只读线程内的记录，不是本文收口新跑的；本次只改注释与证据，未重跑全量、未重新调优性能、未触碰观察期与预热逻辑。
