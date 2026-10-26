# 双轴审查整改实施证据（feat/feishu-review-fixes）

状态：**整改完成，自动化门槛在本候选上全绿**。本文件只覆盖 `.scratch/feishu-notifications/evidence/code-review.md` 的维护性问题、判断项、Spec 观察项与跨进程时序风险；不把 01–10 的隔离证据升级为真实验收，不勾 11 的真项，不关闭父规格。

- 工作树/分支：`/tmp/feishu-worktrees/review-fixes`、`feat/feishu-review-fixes`（独立 worktree，未操作主工作树）。
- 集成基线：`306356c`（基于 `feat/feishu-notifications`，合并时已是最新 tip，无需再合）。
- 被审代码：`2d408c3`（审查对象，未改写）。
- **被测代码提交：`10f41db8bb5da82d2fd1fe44910be58eb2941004`**（`refactor(feishu): 集中整改双轴审查的重复实现与时间敏感观测`）。本文件所在提交为文档/证据提交，指向上述代码提交，不要求自引用。
- 收口前已把 `feat/feishu-notifications` 最新 tip `29aa479`（仅新增独立基线回归证据文档）合入本分支，合并提交 `e53dfb4`；`git diff 10f41db e53dfb4 -- backend frontend docs` 为空，即代码与文档内容与上表门槛所测候选逐字节相同，合并未改变被测代码。
- 合并后复核：`test_notification_protocol.py`、`test_notification_recovery_processes.py`、`test_notification_lifecycle_processes.py`、`test_three_process_delivery.py` 合计 46 passed。
- 未推送、未部署、未读写真实通知配置或凭据、未访问真实 B 站/飞书/OSS、未启动或停止既有 live 实例（18445）、未触碰 4173 ssh 隧道、未修改 `.pi/`。

## 1. 环境

| 项 | 实测值 |
| --- | --- |
| Python / uv | 3.12.15 / 0.12.23（`uv sync --locked` 同步依赖，未改锁定版本） |
| pytest | 8.4.2（`uv run --no-sync pytest`） |
| Node / pnpm | v24.21.0（`nvm use`，仓库 `.nvmrc`）/ 10.34.6（`pnpm install --frozen-lockfile`） |
| Playwright | 1.58.2 |
| Nginx | `/tmp/nginx-16/nginx-1.28.0/objs/nginx`，mime types 同目录 `conf/mime.types`（`test:delivery` 用 4273 端口） |
| SQLite schema | v21（未改动） |

CodeGraph 说明：本工作树与主工作树均无 `.codegraph/` 索引，故按仓库 AGENTS.md 的降级条款改用源码工具（grep/read）定位；未因此改写任何结论。

## 2. 逐项处置摘要

完整逐项结论（接受修复／证据驳回／成本观察记录）写在 `code-review.md` 文末「处置（整改实施记录）」。一句话版本：

- Standards 1–6：5 项接受修复（定位推导、一次性定位滚动、零引用导出、短事务样板、ISO→epoch），1 项部分接受（测试时钟：重复的采集适配器与投递时钟合并，语义不同的 `Clock` 保留）。判断项：告警命名三元组、config 路由单次解析接受修复；kind 级联明确记录**不做**多态。
- Spec：0 项确认违背维持；定位 O(N) 读取与 `expire_overdue` 缺索引记为**成本观察**并写入长期契约文档；重试用当前基址按既有契约**证据驳回**；跨进程时序风险按测试 seam 整改（不删用例、不放宽断言）。

## 3. 跨进程时序风险的复核与整改（只改观测与时间 seam）

10 的证据记录了首次全量 4 个跨进程失败但未留断言/stderr。主线程独立复跑被审基线 `306356c`：**1029 passed, 3 warnings, 191.05s，首轮即绿**（完整输出 `/tmp/feishu-independent-backend-before-fixes.log`，本次未复现，故不虚构根因）。同时按审查线索逐条核验并消除不必要的墙钟依赖：

这三个文件里的跨进程用例是**本功能（06/07/10）新增**的过程测试，其偶发失败按本轮问题处置，不当作“既有历史风险”豁免；同时也没有为了让它们变绿而删除用例、调大超时或放宽实质断言。

### 3.1 写锁断言：墙钟 1 秒 → busy 预算内写成功

`test_notification_recovery_processes.py::test_slow_feishu_request_never_holds_the_write_lock_for_another_process` 原断言另一进程的写耗时 `< 1.0` 秒（SQLite `timeout=1.0`）。负载下即使锁是自由的也可能超时，属纯墙钟断言。

改为：写脚本用 3 秒 busy 预算，测试断言 `returncode == 0`（等到预算耗尽即 `OperationalError`），并补两条实质断言——写完成时业务目标仍是 `inflight`、`attempts == 0`（回写没有在网络期间发生）。

**反向验证（刻意构造红）**：另起进程持有 `BEGIN IMMEDIATE`（模拟“网络等待期间仍占写事务”），跑同一个写脚本：

```
returncode: 1 elapsed: 3.02
stderr tail: sqlite3.OperationalError: database is locked
```

即该断言仍能抓到“事务内做网络”的真实缺陷，只是不再依赖“写得多快”。

### 3.2 强杀恢复：`(0, 2.5]` 秒租约窗口 → 30 秒预算的结构断言 + 受控过期

`test_killed_process_recovers_lease_and_keeps_the_successful_target` 原来用 `BILI_NOTIFIER_LEASE_SECONDS=2` 并断言 `0 < lease_until - now <= 2.5`：从强杀到测量若因负载跨越 2 秒，**必然假失败**。

改为：租约用默认 30 秒，断言 `now < lease_until <= now + 30`（仍在未来 ⇒ 恢复只能来自过期；不超过配置值 ⇒ 租约就是领取时刻 + 配置），随后把该行 `lease_until` 推到过去（等价于时间流逝，其余记录不动）再重启，断言“只补发被杀目标、已成功目标不重发、`attempts/failures` 语义不变”。

**反向验证（刻意构造红）**：去掉“推到过去”这一步，恢复只能等真实 30 秒过期 → 用例在 20 秒等待预算处失败（`1 failed, 2 deselected ... in 21.23s`），证明恢复断言确实绑定租约过期而不是碰巧重启。

### 3.3 新增发现：合法心跳使进程级用例在“北京时间第 40 分钟”必然假失败

排查中发现一处墙钟相关的观测缺陷（不是产品缺陷）：真通知进程用生产 `SystemClock`，会在**真实北京时间 `:40:00`–`:40:59`** 生成当日该小时的心跳（合法系统事件；系统群未配置时落 `waiting_config`）。而进程级用例（`states()`/`events()`）按**整张投递表/事件表**断言，于是：

- `test_notification_recovery_processes.py` 三个用例的 `states(path) == {...}`；
- `test_notification_lifecycle_processes.py` 的事件条数断言；
- `test_three_process_delivery.py` 的 `assert stub.requests == []` 与 `len(events(...))` 前后对比；

都会在这一分钟内多出 `system` 角色/心跳事件而失败。这与“一次运行里多个跨进程用例同时失败”的现象一致，但**仅为机制性解释，不作为 10 首轮失败的确证根因**（那份失败未留断言）。

处置（不加生产测试时钟开关，符合“不改生产 clock”要求）：

- `tests/notification_process_support.py` 新增 `business_deliveries(path)`/`business_events(path)`：只取 `dynamic_changed`/`root_comment`/`reply_comment` 三类业务事件。
- 上述四个进程级用例文件改用它们观察业务结果；三进程链里“首次正文静默”改为“业务群没有收到消息”（心跳只发系统群）。

**红绿验证**（临时实验，实验代码未提交）：把真进程在 `:40` 会写下的心跳直接写进测试库（`outbox.record_heartbeat` + 固定时段），再跑原观测：

```
旧观测：AssertionError: assert {'system': 'w...': 'inflight'} == {'up': 'inflight'}
        Left contains 1 more item: {'system': 'waiting_config'}
        1 failed, 2 deselected
新观测：3 passed  ← 同一注入下
```

即：改前的观测确实会因合法心跳假失败，改后在同样注入下仍绿，业务断言（inflight/sent/attempts/快照）一条未放宽。移除注入后 `test_notification_recovery_processes.py`、`test_notification_lifecycle_processes.py`、`test_notification_process.py` 合计 7 passed；`test_three_process_delivery.py` 4 passed。

### 3.4 未改动的观察窗口（如实记录）

`test_notification_lifecycle_processes.py` 的两处 `time.sleep(2.5)` 与 `test_three_process_delivery.py` 的 `time.sleep(1.5/3)` 是**“没有新请求”的观察窗口**（断言的是缺席，不是截止时间）；负载只会让窗口更长，不会假失败。本次只补了 `assert restarted.running`，确认观察窗口覆盖的是活着的进程。真正有假失败风险的是上文 3.1/3.2 的墙钟截止断言，已按上法处理。

## 4. 门槛命令与结果（固定候选 `10f41db`）

后端（仓库根）：

```bash
uv sync --locked
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
  uv run --no-sync pytest backend/tests -q
# 1030 passed, 3 warnings in 187.36s
```

> 计数比基线 1029 多 1，来自新增的 `test_notification_protocol.py::test_one_route_resolution_covers_error_address_and_secret_without_repring_them`。

定向入口（本轮直接相关）：

```bash
uv run --no-sync pytest backend/tests/test_notification_protocol.py \
  backend/tests/test_notification_delivery.py backend/tests/test_notification_recovery.py \
  backend/tests/test_notification_alerts.py backend/tests/test_notification_heartbeat.py \
  backend/tests/test_notification_combinations.py backend/tests/test_notification_lifecycle.py -q
# 132 passed
uv run --no-sync pytest backend/tests/test_notification_recovery_processes.py \
  backend/tests/test_notification_lifecycle_processes.py backend/tests/test_notification_process.py -q
# 7 passed
uv run --no-sync pytest backend/tests/test_three_process_delivery.py -q   # 4 passed
```

前端（`frontend/`）：

```bash
pnpm check          # typecheck + 275 单测（24 文件）+ e2e 项目覆盖守卫：exit 0
pnpm check:dist     # 两次构建 + 产物隔离：exit 0
pnpm test:e2e                 # 203 passed, 10 skipped (3.8m)
pnpm test:e2e:production      # 3 passed, 3 skipped
pnpm test:e2e:manage          # 7 passed
pnpm test:e2e:location        # 4 passed
pnpm test:e2e:notification    # 4 passed
pnpm test:e2e:delivery        # 5 passed (27.7s)
DELIVERY_PORT=4273 \
NGINX_BIN=/tmp/nginx-16/nginx-1.28.0/objs/nginx \
NGINX_MIME_TYPES=/tmp/nginx-16/nginx-1.28.0/conf/mime.types \
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
pnpm test:delivery            # exit 0；9 条 PASS（mock/生产/更新/回退/401/502/秘密扫描）
```

运行留痕（首次输出均保留，未删掉再复跑）：

| 输出 | 内容 |
| --- | --- |
| `/tmp/review-fixes-backend-full-1.log` | 整改中期全量：1030 passed（代码尚未定稿） |
| `/tmp/review-fixes-backend-full-2.log` | 定稿前全量：1030 passed, 187.65s |
| `/tmp/review-fixes-backend-full-final.log` | **候选 `10f41db` 全量：1030 passed, 3 warnings, 187.36s** |
| `/tmp/frontend-{check,check-dist,e2e,e2e-*}-final.log`、`/tmp/frontend-test-delivery-final.log` | 候选 `10f41db` 的前端全部门槛 |
| `/tmp/feishu-independent-backend-before-fixes.log` | 主线程对被审基线 `306356c` 的独立全量：1029 passed, 191.05s（首轮即绿，补证） |

本轮所有门槛**首次运行即绿**，没有出现需要复跑取绿的偶发失败；唯一出现的红是 §3 里两条刻意构造的反向验证，以及 §3.3 的心跳注入实验。

## 5. 与 10 证据的关系

- 10 §12 记录的首次全量 4 例失败（`test_notification_lifecycle_processes`、`test_notification_recovery_processes`）保留原样，不追改为“已定位根因”。本文件提供的是**机制性复核**（§3.3）、**可验证的墙钟依赖消除**（§3.1/3.2）与**独立首轮全绿补证**。
- 10 §4/§5/§8/§9 的三进程链、资源实测、浏览器入口与 FS-AC 隔离结论保持有效；本轮没有放宽它们的断言或改它们的观测口径（三进程链只把“首次消息静默”限定到业务群，避免系统心跳噪声）。
- 10 的“真实飞书/真机/目标环境未验证”边界不变；本次也未做任何真实投递。

## 6. 未验证与限制

- 真实飞书投递、真实群路由/签名/限流、飞书内置浏览器与手机、目标机三进程与迁移演练仍未验证（属票据 11 的人工授权门槛）。
- 定位读取的 O(N) 本地成本、`expire_overdue` 的扫描成本只做了契约记录与量级说明，没有做容量压测；未新增索引或容量治理。
- 反向验证是本地一次性实验（未提交实验代码）；它证明断言“能失败”，不构成对真实生产负载的证明。
- 心跳假失败的解释基于机制复现（等价注入 + 同样失败形态）；10 首轮那 4 条失败没有留下断言，不能据此宣称根因已确证。
- SQLite 写锁竞争、进程调度与 CI 负载仍可能让其它**未涉及本轮**的用例偶发失败；本轮只处理了已核查出的墙钟截止断言，没有为了“更稳”而普遍放宽断言或加长超时。


## 7. 收尾（最新只读复核后）

- 两轴最终只读复核：**Standards 硬性 0、Spec 确认 0**；主线程对合并点 `166d706` 独立首次全量 **1030 passed, 3 warnings, 194.04s**（`/tmp/feishu-independent-backend-final.log`）。
- 本分支合入主集成 `166d706`（普通 merge，提交见分支日志）后只做三处精确小改：删除 `useLocateTarget` 未用的 `pending` getter；把 `notification-process.md` 的事务样板说明限定到本轮实际覆盖范围（归档/发现的既有 inline 事务不变、未合并）；把 `epoch_from_iso` 注释改为“不规定错误策略、调用方决定”。
- 记录不改的受控变化：`config.secret()` 在无效 webhook 时返回 `None`，而 `resolve()` 的错误码在发送前挡住该组合，凭据不可达路径不变。
- 墙钟剩余风险继续明示：极端负载下 `wait_for` 预算仍可能在与被测行为无关的环节耗尽，不复跑取绿、不放宽断言。
- 收尾验证（无后端语义变化，故未重跑后端全量/全部 e2e）：`pnpm check` exit 0（275 单测 + typecheck + e2e 项目守卫）；`test:e2e:location` 4 passed；`test:e2e:notification` 4 passed；后端定向 `test_collector.py`+`test_notification_protocol.py` 48 passed。
