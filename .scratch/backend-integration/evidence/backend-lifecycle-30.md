# #30 后端媒体联动与分项状态专项证据

## 范围与入口

沿用已确认 T2/T3：管理 HTTP 配置 → 原始 HTML/JSON 经 `httpx.MockTransport` → 公开 `Collector.check_once`／`execute_pending` → 临时真实 SQLite → 关闭重开后的管理／归档 HTTP。仅下载、上传、上游传输和时钟替换；不 mock Store、不查询 SQL 私有状态，不增加测试专用接口。不重复 #29 停止／重纳入矩阵。

新增组合测试位于 [`backend/tests/test_integrated_archive_lifecycle.py`](../../../backend/tests/test_integrated_archive_lifecycle.py)：

| 测试入口 | 验证结果 |
| --- | --- |
| `test_trusted_edit_updates_body_and_media_with_actual_part_times_and_retries_after_reopen`（起始行号 35） | 未检查时间为 null；可信编辑自动更新正文、图片来源和上传；单图上传失败保留旧成功图片及成功时间；正文时间独立推进；同信号重开重试仅处理媒体；相同编辑信号下正文／图片变化不额外触发；检查时间不冒充成功时间；HTTP、日志无虚构秘密 |
| `test_count_change_media_retry_and_new_observation_keep_independent_checkpoints_and_times`（起始行号 110） | 计数变化自动根／回复／一级评论图；回复尾页失败保留整轮 checkpoint；根成功与回复成功独立；失败重试可接受该轮实际根图片；评论文本成功不等图片；纯图评论和 owner、公开 URL、保留旧成功图片、回复不扩图；媒体重试期间新计数仍登记，旧完成只保存其实际成功时间／checkpoint，不清新工作；重开继续完成较新观察 |
| `test_restricted_body_and_invalid_edit_do_not_block_comment_recovery_or_invent_success_times`（起始行号 233） | 正文受限、无效编辑、根分页失败均不伪造成功；同信号重试可保存实际可读根／回复；正文／动态图时间仍 null；正文恢复后真实确认空动态图组，正文与媒体成功时间独立于评论时间 |

复用现有 `CommentSource`、`readable_html`／`author_html`、`configured`、`snapshot`、`ControlledClock`、`read_all`、`RecordingOSS`。失败／部分完成／运行／无变化／未检查仍由原有 `check_status`、`work`、`parts`、错误与 checkpoint 组合表达，没有新增重叠聚合枚举。

## 红 → 绿

每次先执行失败断言，再增加实现，不先横向铺完全部测试：

1. 首条编辑链：`uv run pytest backend/tests/test_integrated_archive_lifecycle.py -q --tb=short` 首次失败 `KeyError: 'text_last_succeeded_at'`；在真实归档提交／媒体完成处持久时间并接 checks 投影后 **1 passed**。
2. 新增计数／媒体／交错链：同命令 **1 passed, 1 failed**，期望实际评论图完成时间 `2030-01-01T00:01:30+00:00`，错误保留了先前 `00:00:30`。修正同计数失败重试的实际上传完成事件聚合后 **2 passed**。
3. 新增受限恢复链：同命令 **2 passed, 1 failed**；空动态图组已实际确认成功，但 `media_last_succeeded_at` 仍 null。将成功正文提交对空组的实际确认计时后 **3 passed**。
4. 媒体错误聚合增量：`uv run pytest backend/tests/test_integrated_archive_lifecycle.py -k trusted_edit -q --tb=short` 首先 `KeyError: 'media_errors'`；增量只读 SQL 聚合后组合文件 **3 passed**。既有 `test_comment_media.py` 的下载／上传失败参数用例补断言，验证不同固定码、文本 checkpoint 不倒退及成功重试清错误。

## 实现与增量 DTO

- `backend/bili_monitor/storage.py:488`：正文实际提交保存 `text_last_succeeded_at`；成功空动态图组保存 `media_last_succeeded_at`，跳过已完成正文不改时间。
- `backend/bili_monitor/storage.py:586`：实际图片组成功保存媒体时间；失败保留旧值，逐图令牌和版本 fencing 不变。
- `backend/bili_monitor/storage.py:610`：只有真实根分页确认空媒体组或最后上传完成才推进 `comment_media_last_succeeded_at`；有图的同版本重扫不补造旧上传时间；兼容旧归档缺 comments work。
- `backend/bili_monitor/sync.py:36`、`backend/bili_monitor/media.py:92`：向实际完成提交传递 Collector 外部时钟；显式初始化／媒体重试仍可用运行时 UTC。
- `backend/bili_monitor/checks.py:179`：checks／归档详情 `comment_sync` 增量返回 `text_last_succeeded_at`、`media_last_succeeded_at`、`comment_media_last_succeeded_at`（ISO/null），旧缺字段不补造时间。
- `backend/bili_monitor/checks.py:182`：`media_errors`、`comment_media_errors` 为当前组失败的 `MEDIA_DOWNLOAD_FAILED`／`MEDIA_UPLOAD_FAILED` 去重升序数组；不含 previous_media、URL、上游异常或凭据；无已记录失败为 `[]`，不代表完成。
- 契约见 [`collector-api.md`](../../../docs/backend/api/collector-api.md#30-媒体联动与分项成功时间)。无 schema 变更；不改变既有 parts 枚举／文案。前端需由主线程消费新增字段，本代理未改前端或 e2e。

旧精确契约断言在 `test_migrations.py`、`test_initial_archive.py`、`test_comment_media.py` 最小补新字段／时间验证。`test_versioned_edit_sync.py` 的外部时钟中断 fixture 因新增正文完成计时，把目标 finish 的第 4 次 now 对应更新为第 5 次；保留“所有归档已提交、目标未 finish”的原中断窗口与全部行为断言，未改超时。

## 测试记录

最终共享工作区（包含主线程 source pacing 的 5 条测试）执行：

```text
uv run pytest backend/tests -q --tb=short
662 passed, 3 warnings in 78.10s
```

此前专项媒体／计数／编辑回归（新增错误数组之前）：

```text
uv run pytest backend/tests/test_integrated_archive_lifecycle.py \
  backend/tests/test_dynamic_media.py backend/tests/test_comment_media.py \
  backend/tests/test_comment_sync_status.py backend/tests/test_versioned_edit_sync.py \
  backend/tests/test_comment_count_sync.py backend/tests/test_comment_count_recovery.py -q --tb=short
139 passed, 3 warnings
```

`git diff --check` 通过。`pyproject.toml` 未配置类型检查工具；未擅自引入类型／lint 工具。警告为既有 Starlette BlockingPortal 与 oss2 UTC API 弃用提示。

### 既有 run 调度测试偶发 timeout 调查

一次全量复现原已知 `test_three_targets_obey_two_sync_slots_without_stalling_checks[run]` timeout；双参数单跑 **2 passed**，完整 recovery 文件 **13 passed**，run 单用例连续 **30 次通过**。未放宽 timeout、未改调度器和该用例。

通过仓库外临时 pytest 诊断插件仅在失败时取状态／任务栈，另一次全量捕获：虚拟时钟 `15`、等待 deadline `[15,30]`；目标 `123/125` 的检查时间已是 `00:00:15`，`124` 仍为 `00:00:00`；任务只剩两个阻塞中的同步、睡眠中的 run 和测试自身，已无检查任务。说明不是同步长期阻塞全局检查；与前一检查写入但 coroutine 未完成时，下一虚拟节拍依既定 busy-skip 规则跳过该目标的竞态相符。尚未把这一时序推断当成已修复；最终普通全量虽通过，不能宣称偶发性已消除。临时诊断插件未写入仓库、未随产品交付。

## 未验证及责任边界

- 没有真实上游、Cookie、OSS 或持续 15 秒运行证据；不宣称生产容量、自然编辑或云交付完成。
- 浏览器穿透由另一代理负责；本文件不把后端全绿冒充浏览器、Linux Chrome／iPhone Safari 真机验收。
- 新 DTO 已向主线程同步；前端新增时间／媒体错误的解析、显示尚由主线程补齐，不宣称已在 UI 显示。
- 未修改主线程拥有的 profile／root_comments／replies／transport 或上游节流逻辑；本专项由主线程统一审查提交。

## 主线程最终整合补记

前端已完成新增时间／媒体错误的生产 Adapter 校验、管理展示和浏览器真实 DTO 断言；节流专项最终增为 6 项。原虚拟节拍测试改为外部计数请求进展而非强求每槽精确检查时间（busy-skip 允许跳过），不改生产调度或放宽超时。recovery 13 项及双参数连续 30 次通过；最终全量 **663 passed**。最终命令、父票对照、审查及统一提交见 [总验收](../acceptance-30.md)。
