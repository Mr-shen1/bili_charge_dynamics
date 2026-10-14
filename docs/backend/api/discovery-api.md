# 近期目标发现（票据 27）

## 边界与顺序

近期模式沿用原 `is_charge` 的两条 OR 规则：`modules.module_author.icon_badge.text == "充电专属"`，或 `modules.module_dynamic.major.type == "MAJOR_TYPE_BLOCKED"`。不增加正文关键词、图片存在、OPUS/DRAW 类型等条件；规则来源与虚构协议输入见[来源证据](../evidence/source-protocol-evidence.md#27-近期-feed-发现)。发现候选不表示已取得正文，更不表示归档完成。

通过 `/x/polymer/web-dynamic/v1/feed/space`，从首屏沿返回的 `offset` 读取。按 feed 来源顺序保留首次出现的合格字符串 ID；不合格或重复候选不占 N。凑满 N 立即停止，不继续回填历史；不足 N 时只有严格有效的 `has_more=false/0` 才表示耗尽。原通知流程的数字 ID 升序是后续处理次序，不是近期窗口截断算法；本票不新增 ID 或时间排序。来源可能包含置顶，结果保持来源次序，不宣称为发布时间排序或事务快照；源在分页期间移动可能漏项，真实一致性另需证据。

缺失/无效字段、业务拒绝、HTTP/JSON/网络失败、需要翻页但缺少 items/offset、重复或循环 offset 均失败，不当作耗尽。允许不同 offset 下的重复页/候选，去重后继续读取；没有未经确认的页数、UP 数或 100 目标截断。成功空集合与首次失败无可信结果不同。`exhausted=false` 表示已到 N 而不再扫描，不保证历史是否还有合格项。

## 只读管理 HTTP

`GET /api/manage/ups/{uid}/discovery` 返回下列字段。未知身份 `404 NOT_FOUND`，非法 UID、未知或重复查询参数 `422 INVALID_INPUT`。不接受查询参数，不发上游请求；删配置后的持久身份仍可读取历史结果。

| 字段 | 含义 |
| --- | --- |
| `uid` | 字符串 UP ID |
| `mode / recent_n / enabled` | 当前配置；删配置后 mode/N 为 null、enabled=false |
| `active` | 当前启用且为 recent；指定模式不进行发现 |
| `status` | `undiscovered` 未发现、`running` 本轮进行中、`discovered` 本轮发现成功、`failed` 本轮未完整完成；均不是归档状态 |
| `attempt` | 未开始为 null；否则 `{recent_n, started_at, finished_at, ids, error}`，保存本轮累计候选和错误，失败时也可有部分候选；running 的 finished_at=null |
| `trusted_result` | 尚无完整成功结果为 null；否则 `{recent_n, ids, exhausted, discovered_at}`。仅整轮成功可替换。进行中或失败的部分结果不会覆盖此值；ids=[] 且 exhausted=true 可表示可信成功空 |
| `retryable` | 当前 active，且非 running，本轮失败/未发现或旧成功 N 与配置不同；下一固定节拍可以重试。成功状态也继续按节拍刷新，这个字段不是调度开关 |
| `incomplete` | 本轮未成功、无可信结果或旧成功 N 与当前不同。与 `active` 一起解释；discovered 只表示发现完成，内容仍未归档 |

时间使用 UTC、带时区 ISO 字符串。`attempt.error` 为 null 或固定脱敏码：`SOURCE_UNAVAILABLE`（请求/HTTP/业务拒绝）、`SIGNAL_INVALID`（JSON/响应包/候选字段无效）、`PAGINATION_INVALID`（分页不完整/循环）、`DISCOVERY_STOPPED`（在途配置改变）、`DISCOVERY_INTERRUPTED`（采集进程重开恢复中断）。不保存或回显来源 message、offset、请求参数、异常原文和凭据；仅持久字符串 ID 及固定状态。

## 调度、持久化与停止

独立采集进程在原固定 15 秒节拍中增加按 UP 的发现阶段；默认最多 2 个同时发现，按 UID 轮转，不与指定目标的 4 个检查或 4 个归档执行共用名额。上一轮该 UP 未结束即跳过，无积压/退避。慢发现不会等待其他检查或 HTTP 归档读取完成；不承诺任意负载下所有 UP 每个节拍都能发现完成。API 不含定时器，也不提供浏览器触发发现/归档的写接口。

公开 `Collector.discover_once(uid)` 用当前启用 recent 配置尝试一次；停用、指定模式、删配置或同 UP 忙时不开始。每次新分页请求前复核领取与配置；配置改变在同一短事务内使旧令牌失效，已有 I/O 可返回但不得再翻页、更新进度或发布旧结果。失败留待后续固定节拍从首屏重试。只在取得采集进程锁后将残留 running 恢复为 failed/`DISCOVERY_INTERRUPTED`；API 重开不擅自恢复在途任务。`--once` 一次登记指定检查及近期发现，不执行归档，不恢复中断领取。

schema v12 新增按持久身份关联的发现尝试、可信结果及内部领取令牌（令牌不经 HTTP 返回）。v0–v11 原子迁移，保留旧配置、检查、正文、评论、回复、媒体与 cursor；未来版本拒绝。删监控不 cascade 发现历史；网络读取不占 SQLite 长事务。SQLite 操作不可用时沿用采集进程的固定安全错误退出，未实现数据库故障的自动自愈；恢复存储后重启采集进程，再恢复残留 running。本票不写指定 targets、不修改当前近期窗口、不创建归档，#28 才负责结果→当前窗口与初始化/移出。

## 证据限制

测试仅使用结构保持的虚构 JSON、受控外部时钟/传输、真实 SQLite 和 HTTP。生产不增加 Cookie/WBI、解锁或风控绕过；匿名请求拒绝如实失败。原脚本使用 WBI，但本票不运行/导入其通知主循环，也不依赖 ignored 文件。有限历史首屏和静态协议不足以证明真实多页、当前匿名可用性或长期稳定；这些仍由 #34 限定授权验证。
