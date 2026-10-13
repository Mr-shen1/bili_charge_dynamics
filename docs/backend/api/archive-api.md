# 指定目标与首次归档接口（02）

本票只交付指定目标的首次正文归档和基础读取，不包含近期目标选择、周期检查、评论采集或媒体上传。管理身份及配置契约见 [management-api.md](management-api.md)，来源证据及限制见 [backend-feasibility.md](../evidence/backend-feasibility.md)。

## 公开边界

| 方法与路径 | 请求 | 成功 |
| --- | --- | --- |
| `GET /api/manage/ups/{uid}/targets` | 无 | `{targets: [{id: string}]}` |
| `POST /api/manage/ups/{uid}/targets` | `{id: string}` | `{id: string}`，仅在来源作者确认匹配后关联 |
| `DELETE /api/manage/ups/{uid}/targets/{id}` | 无 | `204`，只解除关联，不删除归档 |
| `POST /api/sync/initial` | `{uid: string}` | `{processed, succeeded, failed}`，各值为实际处理数 |
| `GET /api/archive/dynamics` | `limit`、可选 `cursor` | `{items: Archive[], next_cursor: string \| null}` |
| `GET /api/archive/dynamics/{id}` | 无 | `Archive`；本地不存在时 `404` |

UID 和动态 ID 必须是十进制字符串，不经 JavaScript Number 转换。不符返回 `409 TARGET_AUTHOR_MISMATCH`，无法确认返回 `502 TARGET_UNVERIFIED`；都不建立关联。上游请求不在数据库事务内，错误只返回固定脱敏提示，不传递上游响应、URL、请求头或异常文本。

初始化入口面向执行者及测试，不从页面挂载、读取或刷新调用；没有手动刷新 UI。`succeeded` 仅计正文成功（含成功空），正文受限属于本次未成功而计入 `failed`，具体受限/失败由归档状态区分。只处理已启用且已保存为 `specified` 的关联集合，不补入近期或作者的其他动态。停止、删除监控配置或解除目标后，保留身份和历史归档。浏览器 list/detail 只读取 SQLite，即使上游不可用也不触发采集。

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
