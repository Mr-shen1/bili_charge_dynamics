# 37: 检查节拍改为 2.7 秒 ±10%，评论会话按 UP 复用

**What to build:** 把采集进程的固定检查节拍从 15 秒改为 2.7 秒（±10% 抖动，可用环境变量覆盖），并消除每次检查/每次同步重开评论会话带来的预热开销，使单次检查回到「一次页面请求 + 一次计数请求」的量级。

**Parent:** [12](12-delivery-acceptance.md)

**Status:** ready-for-agent

## 依据

- 参考脚本 `script_demo/bili_charge_target_monitor.py` 在线上稳定运行：`get_target_round_interval_range()` 对 3 个目标给 `max(1.0, 0.8×N) ~ max(1.0, 1.0×N)` = 2.4–3.0 秒周期，且 `create_target_session()` **不预热 UP 空间**、每轮只建一个会话、动态详情只在启动时解析一次，常态只有 3 个评论计数请求/轮。
- 我们的现状（改动前实测 654 个样本）：单次 check 4–12 秒（中位 6 秒），节拍 15 秒，`ticks_skipped` 为 0；根因是 `RequestsCommentClient.prepare()` 每个 URL 后 `sleep(1–3s)`，而 `collector.check_once` / `sync_target` 每次尝试都新开评论会话。

## 决策

1. **节拍**：`CADENCE_SECONDS = 2.7`，`CADENCE_JITTER = 0.10`（±10%），`BILI_COLLECTOR_CADENCE_SECONDS` 可覆盖为固定值（测试与临时运维）；跳过逻辑按当轮节拍计算，仍是「忙即跳过、不补发」。
2. **会话复用**：`RequestsCommentClientFactory` 按 UP 缓存会话，Cookie 变化或超过 `SESSION_TTL_SECONDS`（30 分钟）才重建；`aclose()` 统一关闭（collector 退出、API lifespan 结束）。
3. **预热缓存**：`WarmupCache` 以 `(UP, Cookie 指纹)` 为键缓存 `prepare()` 结果，`WARMUP_TTL_SECONDS`（5 分钟）内命中即零预热请求；过期后**后台刷新**，失败按 `WARMUP_RETRY_SECONDS`（60 秒）冷却，避免 2.7 秒节拍下风暴。
4. **兼容**：默认节拍只在生产入口生效；测试通过 `backend/tests/conftest.py` 固定 `BILI_COLLECTOR_CADENCE_SECONDS=15` 保持既有受控时钟语义。

## 实测效果

- 同一 UP 连续打开会话：第 1 次 4.30 秒（预热），第 2、3 次 **0.00 秒**（缓存命中）。
- 单次 check 的剩余成本 = 页面请求 + 计数请求，实测 0.16–0.53 秒（探针目标为受限动态，页面 412，计数被跳过，所以只反映页面路径）。
- 请求量估算：3 目标 × (1 页面 + 1 计数) / 2.7 秒 ≈ 133 次/分；预热每 UP 每 5 分钟 2 次。参考脚本常态约 60–75 次/分（只查计数），因此我们仍高约一倍，**这是需要观察的部分**。

## 验收条件

- [ ] `CADENCE_SECONDS=2.7`、`CADENCE_JITTER=0.10`，环境变量覆盖为固定值；`collector_started` 日志带基数与抖动
- [ ] 跳过逻辑按当轮节拍推进，进程停顿仍不补发积压
- [ ] 同一 UP 在会话 TTL 内复用同一会话、预热只发生一次；不同 UP 各自一个会话
- [ ] Cookie 变化或会话 TTL 到期重建会话并重新预热；预热失败按冷却窗口重试
- [ ] `aclose()` 关闭全部会话并取消后台预热任务
- [ ] 单测：节拍范围/覆盖/默认回退、tick 使用注入节拍、会话复用、预热 TTL 后台刷新、Cookie 变化、会话轮换、失败冷却、关闭清理
- [ ] 文档同步：SRS（FR-16、AC-25、AC-34 等）、collector-api、HLD、FSR、backend README、archive-api、discovery-api、delivery/协议证据中的「15 秒」口径
- [ ] 后端全量测试保持通过（819 passed）

## 风险与观察项

- 上游风控：2.7 秒节拍下我们比参考脚本多一倍请求（页面 HTML + 计数）。若出现 412 或计数失败率上升，先用 `BILI_COLLECTOR_CADENCE_SECONDS` 降频，不直接改代码。
- 会话长期复用与既有「每次尝试独立会话」的文档口径相反，已按本票改写；若出现会话级异常（如 -352 持续），可把 `SESSION_TTL_SECONDS` 调小让它更快轮换。
