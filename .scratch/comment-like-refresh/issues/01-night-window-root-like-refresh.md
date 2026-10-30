# 01：凌晨窗口驱动的根评论点赞刷新

Status: resolved

**What to build:** 一条归档已完成、超过 24 小时没刷新的动态，在凌晨窗口内被采集进程重新领取，完整重翻根评论所有页并把新的点赞数合并进档案。窗口外不做任何事；成功后 24 小时内不再重复。读者第二天打开评论列表时，「最热」用的是新的点赞。

**Blocked by:** 无。

## 验收标准

- [x] LR-01 窗口与到期：窗口判定是纯函数，按北京时间；窗口前一分钟、起点、窗口内、结束后四个边界行为正确；锚点为空或满 24 小时为到期；间隔配 0 时永不登记。
- [x] LR-01 登记：采集进程限频扫描到期目标，把它从「同步完成」置回「待办」；置位写点只在检查状态模块内，API 进程不调用；已归档完成的目标在窗口内确实被重新领取，窗口外不登记。
- [x] LR-02 归档完成的目标确实被重跑：以已归档完成的状态起步，断言会话被领取且请求序列是「完整根页」而不是尾页增量；根页不使用任何「遇到已知评论就提前收束」的裁剪。
- [x] LR-03 只改计数类字段：刷新后根评论点赞数更新，其余字段逐字段不变。
- [x] LR-05 缺失不擦除：来源返回空点赞时旧值保留；返回真实 0 时写入 0。
- [x] LR-06 锚点推进与失败重试：本轮根页扫描成功即推进时间锚点，不等整条动态的所有分项都标记成功；失败不推进，窗口内下一拍仍会重试、窗口外不再重试；成功后 24 小时内不重复登记。
- [x] LR-08 频率上界：请求账本断言相邻请求间隔不小于既有配置值，重型许可峰值恒为 1。
- [x] 迁移：数据库版本前进一版，新增「上次点赞刷新成功时间」列；旧库可迁移，缺列才加、可重入；「未来版本拒绝」与既有版本断言同步更新。
- [x] 配置：刷新间隔（默认 86400 秒，0 关闭）与凌晨窗口（默认 02:00–05:00）存在且有默认值，非法值退回默认并可观测。证据：`like_refresh_configuration()` 与 `test_refresh_configuration_defaults_and_invalid_values_fall_back`。

## 验证范围

覆盖 LR-01、LR-02、LR-06、LR-08 的根评论部分。楼中楼整楼刷新在 02，副作用隔离在 03，真实备份基线在 04。使用临时 SQLite＋替身来源传输＋替身评论客户端工厂＋受控时钟，其余真实（含逐请求限速与租约）。

## Answer

时间锚点落在目标检查行 `target_checks.like_refresh_succeeded_at`，与票 05 共用数据库版本 29（`storage.py` 的 `if version < 29` 段内两段列各自「缺列才加」，回填与索引幂等）。

窗口与到期是两个纯函数：`collector.like_refresh_window_open`（按北京时间整分钟窗口，默认 02:00–05:00）与 `collector.like_refresh_due`（锚点为空或距上次成功 ≥ 间隔，默认 86400 秒）；配置由 `like_refresh_configuration()` 从 `BILI_COLLECTOR_LIKE_REFRESH_SECONDS` / `BILI_COLLECTOR_LIKE_REFRESH_WINDOW` 读取，非法值退回默认并写 `collector_event` 留痕，间隔 0 直接关闭通道。

登记只在采集进程内发生：主循环每 `LIKE_REFRESH_SCAN_SECONDS`（60 秒）调 `_register_like_refresh`，窗口内只对「已完成且到期」的目标调 `CheckStore.like_refresh_targets` / `reopen_check_work` 把 `work` 从 `complete` 置回 `pending`；写点全部留在检查状态模块，API 进程不调用。

领取时 `collector` 用同一对纯函数重判 `TargetSession.like_refresh`，于是全量根页翻到底、不走「遇到已知评论就收束」的守卫，其余参数完全照旧；锚点只在**刷新轮次**的根页扫描成功时于 `_change_roots` 内与页数据同事务推进，失败不推进。评审后修正了口径：窗口外既不再续采全量、也不推进锚点，被放弃的刷新退化为普通增量检查（`test_failure_inside_window_falls_back_to_incremental_outside_it`）。

证据：`backend/tests/test_like_refresh.py`（LR-01 窗口四边界与到期、LR-02 完整根页序列、LR-03 逐字段差异、LR-05 缺失/真实 0、LR-06 推进与窗口内外重试、LR-08 请求间隔与重型峰值）。
