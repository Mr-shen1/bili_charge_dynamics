# 规格：根评论「无图」确认，解除媒体永久 pending

## 0. 背景

活跃动态评论同步已收敛（见 [active-thread-comment-sync](../active-thread-comment-sync/spec.md)），但本机 live 实例三个目标的 `target_checks.work` 仍是 `pending`、`last_succeeded_at` 恒为 `NULL`、UI 永久显示「运行中」。

根因不在评论，而在根评论媒体的「确认无图」判定。

### 0.1 实测证据（本机 `live-34`，2026-10-23）

| 目标 | 根评论 total | `media_sources` 非空 | `work.media` |
|---|---|---|---|
| `1214018075872985176` | 55 | **2** | 2 success / 53 pending |
| `1219141791464292387` | 79 | **0** | 79 pending |
| `1220432497848877059` | 28 | **0** | 28 pending |

- 带图的两条根评论拿到真实 B站 图床 URL（`i0.hdslb.com/bfs/new_dyn/*.png`），且 `media_version == synced_media_version == observed_version == comments:206`、`work.media = success`
- 其余 160 条根评论的 `media_sources` 恒为 `[]`、`media_version` 冻结（最老停在 `comments:12915`，而计数已 13758）、`work.media` 恒为 `pending`
- **同一条动态、同一轮响应**里既有带图（键存在）也有无图（键缺失）的根评论

结论：`/x/v2/reply` 的 `content.pictures` **键存在 ⇔ 该根评论确有图片**。缺失不是「我们没读到」，而是「来源没有图片」。

## 1. 问题

`root_comments.py:73` 把「`pictures` 键缺失」解析成 `media_sources = None`（未知）。`storage.py:47-53` 的 `_reconcile_root_media` 对 `sources is None` 的处理是：

```python
elif "media" not in document:
    reconcile_media(document, [], version, empty_confirmed=False, owner_type="comment")
```

`empty_confirmed=False` 让 `media.py:46` 的 `complete = (bool(items) or empty_confirmed) and all(...)` 恒为 `False`；且该分支只在**首次插入**时执行，之后 `media` 已在文档里，`media_version` 永久冻结。同时 `_observe_root_media` 每轮把 `observed_version` 推到新计数，`media.py:48` 的第二道版本闸也不放行。

结果：`work.media` 永久 `pending`。

### 1.1 为什么这个 pending 会让整个目标永不完成

- `checks.py:108-110` 的「已完成」谓词含 `AND NOT EXISTS (root_comments WHERE work.media IS NOT 'success')` → 有任一 pending 根，work 每 tick 被重新登记
- `collector.py:215-216` 要求每个根的 `work.media == "success"` 才判 `succeeded`，否则 `SYNC_INCOMPLETE`

于是一个纯文字根评论就能让目标永久 incomplete、每 15 秒重领一次。

## 2. 方案

把不变量从「缺键永远不确认空」收窄为：

> **缺键时：若该根从未观察到任何图片，则确认为空组；若已观察到图片，则保留已知组，不冒充空组、不擦除。**

两条改动：

| # | 改动 | 位置 |
|---|---|---|
| F1 | `_reconcile_root_media` 的未知分支判据由「首次插入」改为「当前组没有任何图片项」，并允许确认空 | `storage.py:52-53` |
| F2 | `ROOT_METADATA_VERSION` 2 → 3，触发存量归档一次性补采根分页，让已卡住的根自愈 | `comment_status.py:7` |

### 2.1 F1 为什么安全

- **不擦旧媒体**：判据 `not document.get("media")` 只在「当前组无任何图片项」时成立；已有图片项的根走原路径（什么都不做），`media`／`previous_media`／`media_sources` 原样保留
- **显式 `pictures: []` 语义不变**：`sources == []` 仍走 `reconcile_media(..., empty_confirmed=True)`，会擦除当前组并把旧成功项移入 `previous_media`
- **可自愈**：若某轮真的下发了图片线索，`sources` 非空 → 重建媒体组、推进版本，覆盖之前的空组结论
- **`content` 整体缺失仍为未知**：`root_document` 的解析不变，`media_sources=None` 的语义保留；只是存储层不再把它当成永久未知

### 2.2 为什么需要 F2

存量 160 条的 `work.comments == "success"`，`sync.py:100-104` 的评论闸门不会为它们打开，所以修完 F1 也不会回扫——它们会继续 pending，目标继续 incomplete。`synced_root_metadata_version < ROOT_METADATA_VERSION` 是既有的「格式变更后补采一次」机制（`archive-api.md:84`、`checks.py:111`），正是为这种解释变更设计的。

## 3. 验证标准

- [ ] `pictures` 缺键且该根从未有图片 → `work.media == "success"`、`media_last_attempt == "success"`、`media == []`
- [ ] 同上场景下 `parts.comment_media == "success"`，目标 `work == "complete"`
- [ ] 已有图片项、后续缺键 → `media`／`media_sources`／`previous_media` 三项与上一轮完全相同（不擦除）
- [ ] 显式 `pictures: []` 仍擦除当前组并保留 `previous_media`
- [ ] 缺键但 `content` 整体缺失时不冒充「有图」，也不报 `restricted`
- [ ] 旧 `synced_root_metadata_version` 的归档在下一轮补采一次根分页，之后不再重复
- [ ] `uv run pytest backend/tests` 全量通过（仓库根运行）

## 4. 边界与已知限制

- 本工作**不**改变 `content.pictures` 与 `content.picture` 的解析规则，也不改 `media_sources` 的 `None`／`[]` 字段语义
- 已知限制：某根此轮上报过图片、下一轮缺键时仍保守保持 `pending`（不擦除也不确认）。实测同轮响应中带图评论稳定下发键，该分支预期不可达；若出现，症状是单个根 `media_version` 冻结，可据此定位
- 不引入图片字节／哈希比对来检测编辑（沿用 `archive-api.md` 既有范围边界）
- F2 会让所有启用目标各多一次根分页重扫，属于设计内的一次性成本
