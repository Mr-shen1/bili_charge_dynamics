# 39: 空图根评论在计数回落时自行结算媒体状态

**What to build:** 修掉「根评论本来没有图片，但计数回落让 `observed_version` 落后 `media_version`」时 `work.media` 永远 pending、整个目标无法完成的死锁。

**Parent:** [12](12-delivery-acceptance.md)

**Status:** done

## 现象（2026-10-26 线上观察）

动态 `1214018075872985176` 的 `work=pending`、`sync_error=SYNC_INCOMPLETE`，每 2.7 秒节拍都领一次同步、55ms 空转完事（无上游 I/O），永远不 complete。

```
root 311534011120: observed_version=comments:205  media_version=comments:206
                   media=[]（无图）  work.media=pending
```

根因链：

1. 根评论的 `observed_version` 是 `comments:<动态来源评论总数>`，计数变化会推走所有根的观察版本；
2. `sync_media(current_only=True)` 的第一道守卫是「`media_version != observed_version` 就返回」，版本分离后永远提前返回；
3. `refresh_media_progress` 只在实际写入时调用，没有机会把空组标回 success；
4. `archive_complete` 要求所有根 `work.media = success` → 目标永远未完成 → 每个节拍重新领取（`collector_tick … pending=1`）。

## 修复

- `media.py`：根评论组「无图片项 + 无 media_sources + **media_version 反而领先 observed_version**」时，按当前 `observed_version` 结算为 success。
  只在版本**倒退**（计数回落）时结算；观察版本更新、媒体尚未跟上的情况保持 pending，避免用未成功的观察推进媒体。
- `storage.py`：新增 `settle_empty_media(id, root_id, version)`，事务内校验仍是空组才写入，并刷新 `comment_media_last_succeeded_at`。

## 验收

- [x] 新增回归：`test_stale_empty_comment_media_settles_instead_of_blocking_completion`（计数回落 → 空组自动 success、版本对齐）
- [x] 既有「源失败不得推进媒体版本」的用例保持通过（`test_inflight_recovery` 全绿）
- [x] 后端全量 824 passed（另 1 例为 36 号票记录的已知偶发超时，单独重跑通过）
