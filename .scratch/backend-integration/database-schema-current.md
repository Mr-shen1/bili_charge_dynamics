# 当前 SQLite 数据字典（v13）

## 核验口径

核验对象：`backend/data/monitor.sqlite`。通过 SQLite URI `mode=ro` 查询 `sqlite_master` 与 PRAGMA 元数据，未读取业务行、未运行迁移、未读取凭据。

当前 `PRAGMA user_version = 13`，共 **14 张用户表、59 个列定义**，全部为非 STRICT 表。迁移定义见 [storage.py:87–209](../../backend/bili_monitor/storage.py#L87-L209)。本文件描述现状，不代表重新设计或已经修改数据库。

### 类型和长度

- `TEXT`：所有 TEXT 列均未声明列级最大长度，也没有 `length(...)` CHECK；下表长度统一写“未设上限”，意为未设字段级约束，不代表不受 SQLite／资源上限限制。
- `INTEGER`：SQLite 有符号 64 位整数值域；“长度”不是字符长度，也不是 MySQL 的显示宽度。磁盘编码占用可以变化，不应将所有 INTEGER 简单描述为固定 8 字节。
- 当前没有 VARCHAR、BLOB、原生 JSON、DATETIME 或 BOOLEAN 列。JSON 与时间均保存在 TEXT／JSON 文档里；业务布尔值使用 INTEGER。
- 接口文档中的 UID 1–128 位、媒体关联 ID 32 位小写十六进制等规则，不是当前 SQL 列的长度约束；不能据此把 `TEXT` 写成 `VARCHAR(128)`。不假设所有领取 token 都有相同长度规则。
- 下表“可空”依据实际 PRAGMA `notnull`，不是根据业务含义推断。特别是普通 SQLite rowid 表的单列 `TEXT PRIMARY KEY` 未显式 NOT NULL 时，实测 `notnull=0`；不要把 PK 自动记为数据库 NOT NULL。
- 所有未注明默认值的列均无显式 DEFAULT；“—”不是默认空字符串。

## 1. identities：UP 身份

| 字段 | 类型 | 长度 | 可空 | 默认值 | 约束／用途 |
| --- | --- | --- | --- | --- | --- |
| uid | TEXT | 未设上限 | 是¹ | — | 主键，UP UID |
| name | TEXT | 未设上限 | 是 | — | 来源昵称 |
| avatar_url | TEXT | 未设上限 | 是 | — | 来源头像 URL |

身份与监控配置分开；删除配置不删除身份。

## 2. monitors：UP 监控配置

| 字段 | 类型 | 长度 | 可空 | 默认值 | 约束／用途 |
| --- | --- | --- | --- | --- | --- |
| uid | TEXT | 未设上限 | 是¹ | — | 主键；外键 → identities.uid |
| mode | TEXT | 未设上限 | 否 | 'recent' | 业务模式 recent／specified；DDL 没有枚举 CHECK |
| recent_n | INTEGER | 64 位整数值域 | 否 | 10 | 近期目标数量；DDL 没有正数 CHECK |
| enabled | INTEGER | 64 位整数值域 | 否 | 1 | 业务启停值 0／1；DDL 没有 0／1 CHECK |

合法模式、正整数 N 和布尔输入由应用／API 约束，不是本表 CHECK。实库建表 SQL 与迁移一致。

## 3. targets：指定动态关联

| 字段 | 类型 | 长度 | 可空 | 默认值 | 约束／用途 |
| --- | --- | --- | --- | --- | --- |
| uid | TEXT | 未设上限 | 否 | — | 联合主键第 1 列；外键 → monitors.uid，ON DELETE CASCADE |
| id | TEXT | 未设上限 | 否 | — | 联合主键第 2 列；指定动态 ID |

主键 `(uid, id)`。删配置级联删除的是指定关联，不是动态归档。

## 4. target_selections：当前入选资格

| 字段 | 类型 | 长度 | 可空 | 默认值 | 约束／用途 |
| --- | --- | --- | --- | --- | --- |
| uid | TEXT | 未设上限 | 否 | — | 联合主键第 1 列；外键 → identities.uid |
| id | TEXT | 未设上限 | 否 | — | 联合主键第 2 列；当前入选动态 ID |
| token | TEXT | 未设上限 | 否 | — | 监控资格代次令牌，防停止／重纳入后旧任务复活 |

主键 `(uid, id)`。它不是指定目标清单，也不是内容版本表；由互斥模式、启停和可信近期窗口协调维护。

## 5. recent_discoveries：近期发现状态

| 字段 | 类型 | 长度 | 可空 | 默认值 | 约束／用途 |
| --- | --- | --- | --- | --- | --- |
| uid | TEXT | 未设上限 | 是¹ | — | 主键；外键 → identities.uid |
| status | TEXT | 未设上限 | 否 | — | CHECK：running／discovered／failed |
| attempt | TEXT | 未设上限 | 否 | — | JSON：本轮发现过程、候选、配置与错误等 |
| trusted_result | TEXT | 未设上限 | 是 | — | JSON：最近成功发现的可信结果，含目标 ids |
| claim_token | TEXT | 未设上限 | 是 | — | 本轮发现领取令牌 |

本轮失败不把旧 trusted_result 清掉。界面“未发现”可以由没有本表记录投影而来，不是本表 status 的一个枚举值。

## 6. target_checks：目标检查与同步工作

| 字段 | 类型 | 长度 | 可空 | 默认值 | 约束／用途 |
| --- | --- | --- | --- | --- | --- |
| uid | TEXT | 未设上限 | 否 | — | 联合主键第 1 列；外键 → identities.uid |
| id | TEXT | 未设上限 | 否 | — | 联合主键第 2 列；动态 ID |
| last_checked_at | TEXT | 未设上限 | 是 | — | 最近检查时间 |
| last_succeeded_at | TEXT | 未设上限 | 是 | — | 实际整轮成功时间 |
| check_status | TEXT | 未设上限 | 否 | — | CHECK：checked／unchanged／failed |
| observed | TEXT | 未设上限 | 否 | — | JSON：最近可信观察，包括编辑版本、来源评论数、locator 等 |
| revision | INTEGER | 64 位整数值域 | 否 | — | 观察代次 |
| work | TEXT | 未设上限 | 否 | — | CHECK：pending／running／complete |
| check_error | TEXT | 未设上限 | 是 | — | CHECK：SOURCE_UNAVAILABLE／SIGNAL_INVALID |
| sync_error | TEXT | 未设上限 | 是 | — | CHECK：SOURCE_UNAVAILABLE／SIGNAL_INVALID／SYNC_INCOMPLETE |
| claim_token | TEXT | 未设上限 | 是 | — | 同步领取令牌，用于拒绝旧完成／失败 |

主键 `(uid, id)`。界面 unchecked 由无检查记录等情况投影，不是数据库 check_status 允许存储的枚举。观察成功和实际归档成功分开，分项 checkpoint 主要位于归档 JSON。

## 7. archives：动态归档

| 字段 | 类型 | 长度 | 可空 | 默认值 | 约束／用途 |
| --- | --- | --- | --- | --- | --- |
| id | TEXT | 未设上限 | 是¹ | — | 主键，动态 ID |
| uid | TEXT | 未设上限 | 否 | — | 外键 → identities.uid，归属 UP |
| document | TEXT | 未设上限 | 否 | — | JSON 动态归档文档 |
| generation | INTEGER | 64 位整数值域 | 否 | 0 | 归档领取代次，阻止旧执行覆盖新执行 |

`document` 承载正文、作者展示资料、发布／编辑时间、评论来源／本地计数、locator、observed/synced 版本、work、媒体来源与关联、旧成功媒体、分项成功时间／错误等；这些不是独立 SQL 列。

## 8. root_comments：一级评论归档

| 字段 | 类型 | 长度 | 可空 | 默认值 | 约束／用途 |
| --- | --- | --- | --- | --- | --- |
| dynamic_id | TEXT | 未设上限 | 否 | — | 联合主键第 1 列；外键 → archives.id |
| id | TEXT | 未设上限 | 否 | — | 联合主键第 2 列；根评论 ID |
| document | TEXT | 未设上限 | 否 | — | JSON：作者、文本、时间、点赞、来源回复数、评论图片及其归档状态等 |

主键 `(dynamic_id, id)`。评论图片保存在该 owner 的 JSON 中，不是回复图片。

## 9. replies：楼中楼回复归档

| 字段 | 类型 | 长度 | 可空 | 默认值 | 约束／用途 |
| --- | --- | --- | --- | --- | --- |
| dynamic_id | TEXT | 未设上限 | 否 | — | 联合主键第 1 列 |
| root_id | TEXT | 未设上限 | 否 | — | 联合主键第 2 列 |
| id | TEXT | 未设上限 | 否 | — | 联合主键第 3 列；回复 ID |
| document | TEXT | 未设上限 | 否 | — | JSON：作者、文本、时间、点赞、parent／回复关系等 |

主键 `(dynamic_id, root_id, id)`；复合外键 `(dynamic_id, root_id)` → `root_comments(dynamic_id, id)`。不增加回复图片。

## 10. reply_sync：逐根楼中楼同步状态

| 字段 | 类型 | 长度 | 可空 | 默认值 | 约束／用途 |
| --- | --- | --- | --- | --- | --- |
| dynamic_id | TEXT | 未设上限 | 否 | — | 联合主键第 1 列 |
| root_id | TEXT | 未设上限 | 否 | — | 联合主键第 2 列 |
| status | TEXT | 未设上限 | 否 | — | 逐根回复尝试状态；DDL 没有枚举 CHECK |
| synced_source_reply_count | INTEGER | 64 位整数值域 | 是 | — | 该根最近成功处理的来源回复数，未知可为 NULL |

主键 `(dynamic_id, root_id)`；复合外键 `(dynamic_id, root_id)` → `root_comments(dynamic_id, id)`。

## 11. media_attempts：图片在途尝试令牌

| 字段 | 类型 | 长度 | 可空 | 默认值 | 约束／用途 |
| --- | --- | --- | --- | --- | --- |
| dynamic_id | TEXT | 未设上限 | 否 | — | 联合主键第 1 列；外键 → archives.id |
| media_id | TEXT | 未设上限 | 否 | — | 联合主键第 2 列；媒体关联 ID |
| token | TEXT | 未设上限 | 否 | — | 逐图尝试令牌，拒绝被新尝试取代的迟到提交 |
| root_id | TEXT | 未设上限 | 否 | '' | 动态图用空字符串；评论图使用根评论 ID |

主键是 `(dynamic_id, media_id)`，**不包含 root_id**。本表只存尝试协调信息，不存图片二进制，也不是完整媒体资产表。媒体来源、尺寸、顺序、公开 URL、状态等位于动态／根评论 document。

## 12. archive_pages：动态列表分页快照

| 字段 | 类型 | 长度 | 可空 | 默认值 | 约束／用途 |
| --- | --- | --- | --- | --- | --- |
| token | TEXT | 未设上限 | 是¹ | — | 主键，不透明分页标记 |
| batch_limit | INTEGER | 64 位整数值域 | 否 | — | 批量大小 |
| document | TEXT | 未设上限 | 否 | — | JSON 冻结分页内容 |
| expires_at | INTEGER | 64 位整数值域 | 否 | 0 | 到期时间，用于回收动态列表快照 |
| resource | TEXT | 未设上限 | 否 | 'dynamics:all:published-desc:id-binary:v1' | 资源／scope／排序等读取上下文标识 |

显式索引：`archive_pages_expiry(expires_at)`。动态快照当前契约为首批创建起 15 分钟有效，不随续页延长；它不是业务归档的过期时间。

## 13. root_comment_pages：一级评论分页快照

| 字段 | 类型 | 长度 | 可空 | 默认值 | 约束／用途 |
| --- | --- | --- | --- | --- | --- |
| token | TEXT | 未设上限 | 是¹ | — | 主键，不透明分页标记 |
| resource | TEXT | 未设上限 | 否 | — | 动态／排序等读取上下文标识 |
| batch_limit | INTEGER | 64 位整数值域 | 否 | — | 批量大小 |
| document | TEXT | 未设上限 | 否 | — | JSON 冻结根评论分页内容 |

没有 expires_at 字段；当前契约不设 TTL。

## 14. reply_pages：楼中楼分页快照

| 字段 | 类型 | 长度 | 可空 | 默认值 | 约束／用途 |
| --- | --- | --- | --- | --- | --- |
| token | TEXT | 未设上限 | 是¹ | — | 主键，不透明分页标记 |
| resource | TEXT | 未设上限 | 否 | — | 动态／根评论／读取协议等上下文标识 |
| document | TEXT | 未设上限 | 否 | — | JSON 冻结回复分页内容及对应元数据 |

没有 expires_at 字段；当前契约不设 TTL。

## 外键、索引与删除关系汇总

- 每张表有主键对应的自动唯一索引；只有一个额外显式索引：`archive_pages_expiry(expires_at)`。除主键外，没有其他显式 UNIQUE 约束。
- 全部外键删除行为为 `NO ACTION`，唯一例外是 `targets.uid → monitors.uid ON DELETE CASCADE`。未另声明更新级联。
- `monitors` 删除只级联删除指定关联；`archives` 引用身份而非配置，因此配置删除不会级联清空归档。入选集合由应用协调维护，不依赖配置外键级联。
- 根评论引用动态；回复和逐根回复状态引用根评论；媒体尝试引用动态。部分更细 owner／版本关系由应用和 JSON 校验，不是每个 JSON 关联都有 SQL 外键。
- 没有独立迁移版本表；本次版本由 PRAGMA user_version 核验为 13。

¹ 这些单列 TEXT 主键的 PRAGMA notnull 实测为 0：identities.uid、monitors.uid、recent_discoveries.uid、archives.id、archive_pages.token、root_comment_pages.token、reply_pages.token。这不是说业务 API 接受 NULL；只是如实区分应用校验和数据库声明。

## SQL 列与 JSON 逻辑字段的边界

当前采用“关系定位／约束列 + TEXT JSON 文档”，不是把所有业务属性拆成关系列：

| JSON 所在位置 | 主要承载内容 |
| --- | --- |
| archives.document | 动态正文、来源元信息、版本、计数、分项进度、两类媒体聚合时间等 |
| root_comments.document | 根评论内容、作者、回复数、评论媒体来源／关联／上传状态 |
| replies.document | 回复内容、作者、parent 与回复关系 |
| target_checks.observed | 最近可信编辑／计数／locator 等观察信号，不是完整正文 |
| recent_discoveries.attempt | 本轮发现过程与错误、部分候选 |
| recent_discoveries.trusted_result | 最近可信发现结果，含 ids |
| 三类 pages.document | 当次读取的冻结分页响应／元数据，不是最新业务真值 |

因此 `published_at`、`edited_at`、`text`、`public_url`、图片宽高等虽然是逻辑字段，但不能在数据库字典中误写成实际 SQL 列。本次没有读取业务 JSON 行，也没有把凭据值或实际内容写入本记录。

## 依据

- [数据库迁移与建表](../../backend/bili_monitor/storage.py#L87-L209)
- [入选集合](../../backend/bili_monitor/selection.py)
- [检查／观察](../../backend/bili_monitor/checks.py)
- [归档接口、JSON 与分页契约](../../docs/backend/api/archive-api.md)
- [监控配置接口](../../docs/backend/api/management-api.md)
- [采集与成功时间契约](../../docs/backend/api/collector-api.md)
