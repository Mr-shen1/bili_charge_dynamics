# 38: 页面信号改为每 60 秒 ±2 秒采样，计数仍走主节拍

**What to build:** 把「取动态页 HTML / detail」从每个检查节拍里拆出来，改成独立的低频采样（默认 60 秒 ±2 秒抖动），主节拍只读评论计数。目标是让 3 个目标 2.7 秒一轮的请求量和参考脚本对齐。

**Parent:** [12](12-delivery-acceptance.md)

**Blocked by:** [37](37-collector-cadence-session-reuse.md)（节拍与会话复用已落地）

**Status:** ready-for-agent

## 依据

- 用户判断：动态页不需要每 2.7 秒检测一次；参考脚本 `bili_charge_target_monitor.py` 只在启动时解析一次动态详情，之后每轮只查评论计数。
- 37 号票落地后单次 check 仍需「页面 GET + 计数 GET」，3 目标 2.7 秒节拍约 133 次/分；拆开后常态降到「3 个计数 / 2.7 秒 ≈ 67 次/分 + 每目标每 60 秒一次页面」，与参考脚本同量级。

## 决策

1. **计数每节拍**：`/x/v2/reply/count` 仍按主节拍（2.7 秒 ±10%）读取，保留「新评论最快一个节拍内被发现」。
2. **页面信号低频采样**：`fetch_page`（HTML 编辑时间/正文/图片）与 `fetch_detail`（定位兜底）按 `PAGE_CHECK_SECONDS = 60`、`PAGE_CHECK_JITTER_SECONDS = 2` 采样，即 58–62 秒随机；`BILI_COLLECTOR_PAGE_CHECK_SECONDS` 可覆盖为固定值，`0` 表示每节拍采样（测试用）。
3. **到期判定持久化**：`target_checks` 新增 `page_checked_at`（迁移到 schema 15）；只在真正采样页面那一轮写入，其余轮次保持原值。
4. **未到期的行为**：页面/detail 不请求；若该目标已有有效评论定位，只更新计数与检查时间（`page_signal=False`，不清旧信号、不算失败）；若没有有效定位，本轮跳过并记 `check_skipped reason=page_interval`，不写失败记录。
5. **失败节流**：页面失败也写入 `page_checked_at`，因此 412/风控不会每节拍重试；带 detail 兜底时同轮最多一次 detail。

## 验收条件

- [x] `PAGE_CHECK_SECONDS=60`、`PAGE_CHECK_JITTER_SECONDS=2`（58–62 秒），环境变量可覆盖为固定值，0 表示每节拍
- [x] `target_checks` 迁移到 schema 15 并新增 `page_checked_at`；旧库可升级
- [x] 间隔内：页面只请求一次、计数每次都请求
- [x] 间隔外：重新采样页面
- [x] 页面失败：同轮最多一次 detail 兜底，之后按间隔等待，不每节拍重试
- [x] 页面与 detail 都失败：不再发没有定位的计数请求，也不写失败记录
- [x] 只读计数的一轮保持上一次 `observed_version`，`check_status` 不为 `failed`、`check_error` 为空
- [x] 单测：`backend/tests/test_page_signal_throttle.py`（5 例）；迁移与既有回归全绿（824 passed）
- [x] 文档同步：SRS（FR-16、AC-25）、collector-api、HLD、FSR、backend README

## 请求量

| 场景 | 请求量（3 目标） |
| --- | --- |
| 参考脚本常态 | ≈ 60–75 次/分（只查计数） |
| 本票之后 | ≈ 67 次/分计数 + 每目标每 60 秒 1 次页面 ≈ **70–72 次/分** |
| 37 号票之后、本票之前 | ≈ 133 次/分 |
| 初始（15 秒节拍） | ≈ 48 次/分，但单次 check 4–12 秒 |
