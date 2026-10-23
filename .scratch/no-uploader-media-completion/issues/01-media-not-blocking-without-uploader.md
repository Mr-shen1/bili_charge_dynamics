# 01: 未配置媒体上传器时媒体不参与完成判定

**What to build:** 没有 OSS 上传器的部署里，有图的目标不应被永久判定未完成并每节拍空转。

**Status:** done

## 依据

`media.py:111`：`uploader is None` 时直接 `return result`，完全不碰媒体状态。因此有图的动态（正文图或根评论图）`work.media` 恒为 `pending`。

而完成判定两处都要求媒体成功：

- `collector.py:203-216` 的 `succeeded`：`all(value in ("success","restricted") ...)` 含 `media`，且逐个根评论要求 `work.media == "success"`
- `checks.py:87-112` 的 `archive_complete`：含 `work.media = success AND media_version IS version` 与「无根评论非 success」子句

只改其中一处无效：`succeeded` 放行后 `work` 记为 `complete`，但下一个 tick 的检查会用 `archive_complete` 把它打回 `pending`，空转照旧。

ECS 实测（OSS 七个变量全部注释）：

| 指标 | 修复前 |
|---|---|
| 根评论 `media` | 53 success / **2 pending**（确有图片，无上传器无法完成） |
| `target_checks.work` | `pending`，每 ~14 秒重领一次 |
| `last_succeeded_at` | `NULL` |

## 改动

1. `collector.py`：无 uploader 时把 `media` 排除出 `all(...)`、跳过 `media == "restricted"` 子句、跳过逐根媒体循环
2. `checks.py`：`archive_complete(..., media_upload=)` 与 `record_check(..., media_upload=)`，无 uploader 时去掉媒体与根媒体子句
3. `Collector.check_once` 传 `media_upload=self.uploader is not None`

## 诚实性

`work.media`、`parts.comment_media`、`media[].public_url` 仍如实保持 `pending`／`null`，不冒充已上传。文档同步声明该契约（`collector-api.md:13`）。

**自愈路径**：配好 uploader 后，`archive_complete` 带媒体子句返回 false，`record_check` 的 `work == "complete"` 分支会把它重新登记为 `pending`，下一轮实际补传。该路径由 `test_v12_migration_keeps_archive_observations_and_pending_and_seeds_current_selection` 覆盖（改为生产同序：先 `check_once` 再 `execute_pending`）。

## 核验标准

- [x] 无 uploader + 有根评论图 → `work == "complete"`、`last_succeeded_at` 推进（`test_missing_media_uploader_does_not_block_target_completion`）
- [x] 同时 `parts.comment_media == "pending"`、`public_url is None`
- [x] 无新信号不再重领工作（不再每 tick 扇根页）
- [x] 配置了 uploader 但上传失败 → 仍必须阻塞（`test_media_version_repair_requires_real_source_confirmation` 改用桩上传器、「partial archive」用例改由真实评论失败制造）
- [x] 真机：ECS `work=complete`、`last_succeeded_at=09:09:25`、70 秒内仅启动那 1 轮同步，`syncs_started=0`
- [x] `uv run pytest backend/tests` 全量通过（808 passed）

## Comments

2026-10-23：实现 + ECS 部署验证完成。

**未验证**：配好 uploader 后 ECS 上的实际补传（当前 ECS 不打算启用 OSS）。
