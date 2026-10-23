# 01: 受限终态计入整轮成功

**What to build:** 正文受限且该版本已确认终态时，整轮完成应推进目标级 `last_succeeded_at`，而不是永久留 null。

**Status:** done

## 依据

`collector.py:219-221` 的 `record_success` 一直要求 `archive["work"]["text"] == "success"`：

```python
record_success=(archive is not None and archive["work"]["text"] == "success")
```

`finish_check_work`（`checks.py:291-298`）只有在 `complete and record_success` 时才写 `last_succeeded_at`。

但 `collector.py:203-215` 的 `succeeded` 判定早已把受限当终态：`restricted_current` 成立时 `work=complete`、`sync_error=null`。于是出现自相矛盾的状态：**整轮已 complete，却没有成功时间**。

真机实测（live-34，修复根评论媒体之后）：

| 目标 | `work` | `sync_error` | `last_succeeded_at` |
|---|---|---|---|
| `1214018075872985176` | complete | null | NULL |
| `1220432497848877059` | complete | null | NULL |

三个目标的正文都是 `restricted`，UI 因此永远拿不到成功时间。

### 为什么可以安全地当成功

`work.text = "restricted"` 由 `storage.py:544-549` 写入，同时记录 `restricted_version = observed_version`；一旦出现新观察版本，`storage.py:493-496` 的 `restricted_current` 判定会把它打回 `pending`。所以读到 `work.text == "restricted"` 时它就是**该版本的确认终态**，不是残留。

且 `complete` 本身已要求 `succeeded`，而 `succeeded` 内含 `restricted_current`（`restricted_version == version` 且 `content_visible is not True`）。因此放宽 `record_success` 不会让未确认的受限记录冒充成功。

## 改动

`collector.py:221`：

```python
record_success=(archive is not None
                and archive["work"]["text"] in ("success", "restricted"))
```

正文／媒体分项的时间仍不伪造：`text_last_succeeded_at`、`media_last_succeeded_at` 保持 null，因为并没有真的提交过正文或上传过图。

## 核验标准

- [x] 受限终态整轮完成时 `last_succeeded_at` 推进（`test_restricted_observation_settles_without_inventing_success_or_rescanning`）
- [x] `html` 不可用但 detail 给出有效元数据时同样推进（`test_blocked_detail_is_valid_metadata_when_html_is_unavailable`）
- [x] 受限不阻塞评论成功，且不再留 null（`test_restricted_body_does_not_block_comment_success_unknown_is_not_zero`）
- [x] 部分成功后受限收敛同样推进（`test_restricted_body_and_invalid_edit_do_not_block_comment_recovery_or_invent_success_times`）
- [x] `text_last_succeeded_at`／`media_last_succeeded_at`／`comment_media_last_succeeded_at` 仍为 null
- [x] 检查失败轮次的时间仍全部为 null（`test_integrated_archive_lifecycle.py:254-256` 保持绿）
- [x] `uv run pytest backend/tests` 全量通过（807 passed）

## Comments

2026-10-23：一行实现 + 4 处断言按新契约更新。真机重启后三个目标均出现 `last_succeeded_at`。

**未验证**：正文从受限恢复为可见时 `last_succeeded_at` 与 `text_last_succeeded_at` 的相对先后（由 `test_restricted_body_recovers_when_visible_without_edit_version_change` 覆盖时间不为 null，但未覆盖两次推进的顺序语义）。
