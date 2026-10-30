# 02：楼中楼整楼点赞刷新

Status: resolved

**What to build:** 同一次夜间刷新里，每个楼的楼中楼也从头正序翻到空尾页，把新的点赞数合并进档案。读者打开楼中楼「最热」时，深层老回复的点赞不再停留在归档当天的数字。楼中楼分页响应里本来就带着所属根评论的点赞，顺带写回根评论文档，不额外发请求。

**Blocked by:** 01 — 凌晨窗口驱动的根评论点赞刷新。

## 验收标准

- [x] LR-02 整楼正序：刷新会话对楼中楼执行整楼正序翻页，每个楼从第 1 页翻到空尾页，不走末页倒序增量。
- [x] LR-03 只改计数类字段：刷新后楼中楼点赞数更新，其余字段逐字段不变；根评论的置顶标记与来源回复数语义不变。
- [x] LR-05 缺失不擦除：楼中楼来源返回空点赞时旧值保留；返回真实 0 时写入 0。
- [x] 零成本旁路：楼中楼分页响应携带的根评论点赞被写回根评论文档，且不增加任何额外请求（以请求账本断言请求数不变）。
- [x] LR-07 续采：中断后重新进入同一轮刷新仍是整楼全量，已提交分页不重扫（窗口内；窗口外按 01 的口径退回增量）。

## 验证范围

覆盖 LR-02、LR-03、LR-05、LR-07 的楼中楼部分。与 01 共用同一装配；本票不新增配置项，也不改变根页行为。刷新期间的副作用隔离在 03 验证。

## Answer

刷新轮次里 `TargetSession.full_replies` 为真，整楼从第 1 页正序翻到空尾页（方向只由 `full` 决定，`replies.py` 的末页倒序分支不参与）；不设「遇到已知回复就收束」的裁剪。中断后续采仍按持久进度续页，且「整楼全量是否延续」只在窗口内成立——窗口外退回既有参数，是评审后收紧的口径。

零成本旁路：`replies.fetch_reply_page` 把楼页响应里本来就带的所属根评论对象上抛，`storage.save_reply_page` 与页数据同事务经 `_merge_counts` 只合并计数类字段（点赞、置顶、来源回复数）写回根文档；`test_reply_page_root_like_is_written_back_without_extra_requests` 用请求账本断言请求数不变。

证据：`backend/tests/test_like_refresh.py` 的 `test_refresh_scans_every_building_forward_to_the_empty_tail`、`test_interrupted_reply_refresh_stays_full_forward_and_keeps_committed_pages`、`test_reply_refresh_only_changes_count_fields`、`test_missing_reply_like_keeps_old_value_and_real_zero_is_written`、`test_reply_page_root_like_is_written_back_without_extra_requests`。真实备份上的全量验证见票 04。
