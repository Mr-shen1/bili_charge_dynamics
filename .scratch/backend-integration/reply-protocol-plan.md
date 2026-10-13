# 17 回复归档实施契约

依据 [票据](issues/17-reply-archive.md)、[规格 I6/I8 与已确认 T2/T3](spec.md)；正式交付契约最终归入 `docs/backend/api/archive-api.md`。本文件记录实施前的决定，不作为验收通过证据。

## 来源

使用可信 comment_locator 的 oid/type，针对已读取根请求 `/x/v2/reply/reply?oid=…&type=…&root=…&pn=…&ps=20`，不使用内嵌三条预览作为完整归档。页码、根关系、来源 count 与结构必须校验；计数变化、重复页、必要页失败均留待重试，不清除已存数据。来源分页读至明确耗尽，不宣称上游并发更新下的事务快照。

回复 `rpid_str`、`root_str`、`parent_str` 优先，ID 全程字符串。回复目标只由 parent 对应的同根归档条目作者解析；跨页目标在读取时从完整本地集合解析。找不到目标作者则未知，不能用 `content.members` 的 @ 用户冒充回复对象。

固定第三方资料：commit `cfc5fddcc8a94b74d91970bb5b4eaeb349addc47` 的 [list.md:1559–1637](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/comment/list.md#L1559-L1637)、[readme.md:47–90](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/comment/readme.md#L47-L90)。仅固定文档结构依据，不证明匿名来源、全部权限、真实分页和长期稳定；不访问真实来源或凭据。

## 成功状态

保留 #15 根评论分项的成功语义，另保存回复分项及整轮根/回复成功 checkpoint。根页或任一必要回复页失败都不得推进整轮成功；成功页独立短事务提交。正文、根、回复与媒体成功相互独立，重开后无新信号也能继续重试，重复初始化幂等。不重写根页采集，不引入 #25 周期/计数调度。

## 读取一致性

`GET /api/archive/dynamics/{id}/comments/{root_id}/replies` 只读本地归档。完整同根集合先按时间升序、缺时间后置、ID BINARY 字符串升序，再分页。默认首批最多 3 条，后续每批最多 10 条。

首批短事务冻结整根回复的内容、顺序及回复目标作者。后续 cursor 绑定回复资源、动态、根及该次读取上下文。更新和插入不进入旧快照；相同 cursor 重读原批、相同 next_cursor，关闭重开仍有效。结束为 next_cursor=null。

回复快照不设 TTL，普通传输或 STORAGE_UNAVAILABLE 失败可重试原批；失效、伪造及跨父级/资源 cursor 返回 CURSOR_INVALID，须显式无 cursor 请求首批并替换旧视图，不能静默开启新范围。无回收和容量承诺，保留持久快照增长风险。

## 测试边界

沿用已获确认的 T3 原始虚构 JSON → 公开首次同步与 T2 临时真实 SQLite/HTTP/关闭重开；每个行为切片先失败测试再最小实现。覆盖完整分页、部分失败/重试、公开 checkpoint、25 条累计 3/13/23/25、排序缺值和大 ID、读取中更新、父级与 cursor 错误、原批失败重试、关系与生命周期保留、网络等待期间读写可用。媒体上传、前端展开/恢复、周期调度与真实来源另票验证。
