# 03：刷新会话的副作用隔离

Status: resolved

**What to build:** 夜间刷新只带来点赞的更新，不带来任何别的变化：已成功的媒体不会被重新下载，来源计数的一致性检查点不会被误推为成功，已归档的评论不会被当成新评论再通知一遍，计数增长也不会让刷新在同一个夜里反复重跑。刷新期间其他目标的新评论检查仍能完成。

**Blocked by:** 01 — 凌晨窗口驱动的根评论点赞刷新。

## 验收标准

- [x] LR-09 媒体不被重下：刷新不触发已成功归档媒体的重新下载或重新上传。
- [x] LR-09 一致性检查点不误推：刷新不会把评论总数一致性检查点误记为已同步；来源侧计数减少时仍按既有规则失败并保留旧内容，增长时只记录不停工。
- [x] LR-04 不删除：来源已缺失的评论在刷新后原样保留，行数与内容不变；不新增任何删除路径。
- [x] LR-09 不重复通知：刷新对已归档的根评论与楼中楼不产生新评论通知（以通知事件与投递记录前后不变断言）。
- [x] LR-09 不逐拍反复全量：刷新期间来源计数增长，断言不会导致连续多拍反复进行全量重扫。
- [x] LR-09 不连坐：根页扫描失败时，楼中楼刷新仍按既有降级语义执行，不整轮跳过。
- [x] LR-08 并发隔离：刷新进行中，其他目标的新评论检查仍能完成，重型许可峰值恒为 1。

## 验证范围

覆盖 LR-04、LR-08、LR-09。本票只加断言与必要的隔离修正，不新增功能路径；若实现发现现有路径确实会产生副作用，修正应落在会话参数与合并语义上，而不是在刷新路径里加特例。

## 依赖说明

本票只直接阻塞于 01。若 02 先合入，本票的断言需同时覆盖楼中楼部分；两票在同一通道上叠加，合入顺序由实施时协调。

## Answer

七条断言全部落在采集进程装配边界上（临时 SQLite＋替身来源＋受控时钟，真实持久层/限速/租约/会话状态机），**未改产品代码**：逐条排查后没有发现真的副作用，三层防护已经存在且未因刷新而失效——媒体靠 `media_step` 的成功跳过与 `claim_media` 栅栏、一致性检查点靠「整轮一致才 success」、通知靠 `discovered` 守卫与逐评论唯一索引。

一处是在票 04 真实备份验收里才暴露的：无图目标的 `comment_media_last_succeeded_at` 会被每次成功根页确认，刷新因而改动了媒体字段。修复落在轮次事实上：`_change_roots` 把「是否重新确认空图片组」交给 `confirm_empty=not like_refresh_round` 决定，正常归档与上传完成语义不变（`test_refresh_does_not_reconfirm_media_of_image_free_targets`）。

证据：`backend/tests/test_like_refresh.py` 中 `test_refresh_does_not_download_or_upload_succeeded_media_again`、`test_refresh_does_not_reconfirm_media_of_image_free_targets`、`test_count_growth_is_only_recorded_and_does_not_stop_the_refresh`、`test_count_decrease_fails_by_existing_rule_and_keeps_the_checkpoint`、`test_failed_replies_do_not_advance_the_comment_checkpoint`、`test_refresh_keeps_comments_the_source_no_longer_returns`、`test_refresh_never_notifies_archived_comments_again`、`test_count_growth_does_not_repeat_the_full_rescan_on_every_tick`、`test_root_scan_failure_does_not_skip_the_reply_refresh`、`test_another_target_still_checks_new_comments_while_a_refresh_runs`。
