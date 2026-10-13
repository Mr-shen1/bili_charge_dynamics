# 指定目标、首次归档与 scope 读取接口（02 / 13 后端）

02 交付指定目标的首次正文归档和基础读取；13 后端扩展全部／单 UP 读取与持久身份列表。不包含近期目标选择、周期检查、评论采集或媒体上传，前端 Adapter／最小路由契约见 [archive-api-client.md](archive-api-client.md)，具体自动化证据见 [13 验收记录](../../../.scratch/backend-integration/acceptance-13.md)。管理身份及配置契约见 [management-api.md](management-api.md)，来源证据及限制见 [backend-feasibility.md](../evidence/backend-feasibility.md)。

## 公开边界

| 方法与路径 | 请求 | 成功 |
| --- | --- | --- |
| `GET /api/manage/ups/{uid}/targets` | 无 | `{targets: [{id: string}]}` |
| `POST /api/manage/ups/{uid}/targets` | `{id: string}` | `{id: string}`，仅在来源作者确认匹配后关联 |
| `DELETE /api/manage/ups/{uid}/targets/{id}` | 无 | `204`，只解除关联，不删除归档 |
| `POST /api/sync/initial` | `{uid: string}` | `{processed, succeeded, failed}`，各值为实际处理数 |
| `GET /api/archive/ups` | 无 | `{ups: [{id: string, nickname: string \| null, avatar_url: string \| null}]}` |
| `GET /api/archive/dynamics` | `scope=all\|up`、条件必需的 `uid`、`limit`、可选 `cursor` | `{items: Archive[], next_cursor: string \| null}` |
| `GET /api/archive/dynamics/{id}` | 无 | `Archive`；本地不存在时 `404` |

UID 和动态 ID 必须是十进制字符串，不经 JavaScript Number 转换。不符返回 `409 TARGET_AUTHOR_MISMATCH`，无法确认返回 `502 TARGET_UNVERIFIED`；都不建立关联。上游请求不在数据库事务内，错误只返回固定脱敏提示，不传递上游响应、URL、请求头或异常文本。

初始化入口面向执行者及测试，不从页面挂载、读取或刷新调用；没有手动刷新 UI。`succeeded` 仅计正文成功（含成功空），正文受限属于本次未成功而计入 `failed`，具体受限/失败由归档状态区分。只处理已启用且已保存为 `specified` 的关联集合，不补入近期或作者的其他动态。停止、删除监控配置或解除目标后，保留身份和历史归档。浏览器 list/detail 只读取 SQLite，即使上游不可用也不触发采集。

### 归档读取 scope、身份与错误

- `GET /api/archive/dynamics?scope=all` 对全部保留归档排序分页；旧请求省略 `scope` 等价于 `all`。`all` 禁止携带 `uid`（包括空值），不按监控状态筛选。
- `GET /api/archive/dynamics?scope=up&uid=202` 只读取该 UP 的完整保留归档，按数据库归属 UID 过滤。`up` 必须携带合法 UID 字符串：1–128 位 ASCII 十进制数字，首位 1–9，不接受前导零、符号、空白、科学计数法或 Number 转换。
- 未持久保存的合法 UID 返回 `404 UNKNOWN_UP`；已知身份即使没有归档，也返回 `200 {items: [], next_cursor: null}`。本地详情不存在仍独立返回 `404 NOT_FOUND`，上游不可用不会让已有详情变成不存在。
- `GET /api/archive/ups` 返回全部持久身份，包括停用、删除监控配置及已知空身份；按 ID 的 BINARY 字符串升序排列。DTO 只含 `id`、`nickname`、`avatar_url`，不含监控配置，也不请求上游刷新资料；可空昵称／头像原样保留。
- `limit` 默认 10，范围 1–10。非法 scope／UID／limit、未知或重复查询参数返回 `422 INVALID_INPUT`。身份列表及详情均不接受查询参数。

### 分页一致性与 cursor

动态在完整 scope 集合内按 `published_at DESC`（`null` 后置）、`id COLLATE BINARY ASC` 排序，ID 不转数字，编辑时间不参与排序。全部集合跨 UP 排序后分页，不能将各 UP 的页面拼接为全局页面。

首批读取在同一 SQLite 短事务内冻结当时该 scope 的**全部顺序与完整 Archive 内容**，后续页持久保存。之后插入、更新时间或正文不会加入／改写旧快照；重新请求不带 cursor 的首批才能看到最新归档。cursor 重读返回同一批及相同的 `next_cursor`，应用／数据库关闭重开不使未过期 cursor 失效。最后一批 `next_cursor` 为 `null`，调用方不再追加请求；失败不推进 cursor，可按原 cursor 重试。

cursor 是不透明标记，绑定动态资源、scope（单 UP 包含 UID）、固定排序及首批 `limit`。全局旧 cursor 与显式 `scope=all` 完全互通；不能在全部／单 UP 或不同 UP 之间复用，也不能用于身份、详情、目标或评论资源。格式无效、伪造、跨 scope／资源、改变 limit 均明确返回 `422 INVALID_INPUT`，不静默开启新快照。

快照从首批创建起有效 **15 分钟**，续页不延长期限；到期时（包括恰满 900 秒）返回 `422 INVALID_INPUT`，过期页由启动或列表读取回收，归档本身不删除。调用方需显式重读首批，不把失效视为成功空或结束。此增量沿用现有 v5 持久页结构，不迁移或作废仍有效的旧全局 cursor；不承诺大集合内存／存储容量或长期阅读快照。

### 执行一次

先启动 [后端 API](../../../backend/README.md)，在 `/manage` 保存 UP、指定模式和已通过归属校验的目标，再由执行者显式调用：

```sh
# 替换为已保存的字符串 UID；这里只是虚构示例。
UP_UID=202
curl --fail-with-body -X POST http://127.0.0.1:8000/api/sync/initial \
  -H 'Content-Type: application/json' --data "{\"uid\":\"$UP_UID\"}"
```

此命令会使用生产传输读取上游；自动化验收只用专用 fixture 装配，不执行该生产命令。源站限制会如实保留受限/失败，不配置凭据或绕过权限。

## Archive 的信息边界

- `id`、`author.id` 是字符串；实际作者身份不采用固定演示 UP，缺失昵称/头像允许为空。HTML TITLE 模块的 `title` 独立保存并安全显示，不混入正文。
- `published_at` 是独立的绝对北京时间，明确 `+08:00`，精度到秒；未知为 `null`，不使用编辑时间补值。
- `edited_at` 仅来自页面 HTML 的 `__INITIAL_STATE__.detail.modules`，按 `MODULE_TYPE_AUTHOR` 读取“编辑于”日期时间。保存来源时区和分钟精度；没有标记不是“确认未编辑”。`edit_status` 为 `observed`、`unknown` 或 `error`，未知/失败不清除旧可信值。
- `title` 是可空独立标题；`text`、`content_state` 表达成功正文（包括成功空）、受限或失败；`last_attempt` 独立描述最近尝试。失败不覆盖旧成功正文。OPUS 的通用 detail `summary` 不是全文证据；全文来自页面 CONTENT 的有序段落，未取得全文不以摘要冒充成功归档。
- `source_comment_count` 为来源总数（可未知），`local_comment_count` 为本地已归档根评论数。本票未采评论，不把来源总数或零当作采集成功。
- `media_sources` 保存顺序、来源 URL 和可用尺寸；`comment_locator` 保存后续评论定位信息。本票不上传媒体，浏览器不把来源业务图当作已归档图片。
- `observed_version` 与 `synced_version` 分开，`work.text` 仅在对应版本成功时推进，`work.media`、`work.comments` 保持待处理。观察成功、正文成功不代表全部归档完成。

## 安全及证据

初始化 JSON 只用 JSON 解析器，不执行网页 JavaScript、`eval` 或表达式；不固定脚本标签或模块数组下标，不依赖 `opus/detail` JSON 取得编辑信号。固定脱敏 fixture 是协议回归证据，不证明所有上游页面、权限状态或长期运行可用。

接口继承首期无鉴权风险，包含可写管理与初始化入口；隐藏路径不是保护。仅应部署到明确接受该风险的网络环境。本次不增加鉴权、备份、容量治理、周期调度或付费基础设施。原始参考脚本保持 ignored，禁止执行、导入或强制纳入版本。
