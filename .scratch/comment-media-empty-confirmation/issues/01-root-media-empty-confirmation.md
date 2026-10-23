# 01: 根评论确认无图，解除媒体永久 pending

**What to build:** 纯文字根评论（上游缺 `content.pictures` 键）不再永久卡在 `work.media=pending`；已有图片的根不被擦除。

**Parent:** [spec.md](../spec.md)

**Blocked by:** 无

**Status:** done

## 依据与交付边界

- [spec.md](../spec.md)：实测证据与方案 F1/F2。
- 遵守 `archive-api.md` 既有边界：不做图片字节／哈希编辑检测，`media_sources` 的 `None`／`[]` 字段语义不变。
- 不引入退避或自适应频率。

## 核验标准

- [x] `pictures` 缺键且该根从未有图片 → `work.media == media_last_attempt == "success"`、`media == []`、`media_version` 推进到当前观察（`storage.py:52-55`）
- [x] 已有图片项后缺键 → `media`／`media_sources`／`previous_media` 三项不变（`test_comment_media.py:190`、`test_root_comments.py:409` 保持绿）
- [x] 显式 `pictures: []` → 擦除当前组、旧成功项进 `previous_media`（`test_comment_media.py:221-227` 保持绿）
- [x] 缺键场景 `parts.comment_media == "success"`，整目标 `work == "complete"`
- [x] 旧 `synced_root_metadata_version` 的归档下一轮补采一次根分页，无新信号后不再重复
- [x] `uv run pytest backend/tests` 全量通过（807 passed）

## 测试与完成证据

**新增测试**：

| 测试 | 验证 |
|---|---|
| `test_comment_media.py::test_absent_pictures_confirm_empty_media_only_when_no_image_was_ever_observed` | 从未有图 + 缺键 → 确认空，`media_version == observed_version == synced_media_version` |
| `test_comment_sync_status.py::test_text_only_root_comments_confirm_empty_media_and_complete_target` | collector 级：`parts.comment_media == success`、`work == complete`，且之后不再重扇根页 |
| `test_comment_sync_status.py::test_stale_root_metadata_version_rescans_roots_once_and_heals_absent_pictures` | 元信息版本 2 的旧归档补采一次自愈，之后不再重复 |

**按行为变更改写**（原断言编码的是被收窄的旧不变量）：

| 测试 | 变更 |
|---|---|
| `test_comment_media.py::test_unknown_count_and_absent_pictures_are_not_confirmed_empty_media` | 缺键分支由 `pending` 改为 `success`；删除「改为显式 `[]` 才成功」的后半段（不再需要） |
| `test_restricted_terminal.py::test_missing_comment_picture_list_confirms_empty_not_restricted` | 由「保持 unknown」改为「确认空且不借用正文的 restricted」 |

**实现**：

1. `storage.py:52-55` 未知分支的判据由「首次插入」改为「当前组没有任何图片项」，并允许确认空（`empty_confirmed` 取默认 `True`）
2. `comment_status.py:7` `ROOT_METADATA_VERSION` 2 → 3，靠既有「格式变更后补采一次」机制让存量自愈

**真机验证**（live-34，重启后）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 根评论 `media` 非 success | **160 / 162** | **0** |
| 安静目标 `target_checks.work` | `pending`（每 15 秒重领） | **`complete` 稳定** |
| `sync_finished` | `succeeded=false complete=false` | **`succeeded=true complete=true`** |

热门动态 `1219141791464292387` 随新评论在 `pending↔complete` 间翻转属预期：评论计数是媒体组版本号，计数一变整组回到 pending 等下次根页确认（无图片网络开销）。

**观察到的残留（与本次无关）**：`last_succeeded_at` 仍为 NULL，因为 `collector.py:219-221` 的 `record_success` 要求 `work.text == "success"`，而三条目标正文都是 `restricted`。这是受限正文的既有语义。

## Comments

2026-10-23：两块实现完成，票据核验标准全部满足。

**未验证**：真实上游长期是否始终对带图根评论下发 `pictures`（当前证据是同轮响应内 2 条有键、53 条缺键）；`content` 整体缺失（已删除根）在真实来源下的表现；某轮上报图片后又缺键的保守 `pending` 分支实际是否会触发。
