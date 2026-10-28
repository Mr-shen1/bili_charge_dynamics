# 指定目标、首次归档与归档读取接口（02 / 13 / 15 / 17 / 19 / 21 / 26 / 28 后端；飞书通知 02 增精确定位读取）

02 交付指定目标的首次正文归档和基础读取；13 后端扩展全部／单 UP 读取与持久身份列表；15 增加已有根评论首次归档及最热／最新读取，17 补齐楼中楼来源分页与持久读取。19 增加动态图下载、OSS 上传与独立重试，21 将共用媒体能力接入一级评论；近期窗口与周期检查另见 [采集契约](collector-api.md) 和 [近期发现](discovery-api.md)，前端 Adapter／最小路由契约见 [archive-api-client.md](archive-api-client.md)，具体自动化证据见 [13 验收记录](../../../.scratch/backend-integration/acceptance-13.md)。管理身份及配置契约见 [management-api.md](management-api.md)，来源证据及限制见 [backend-feasibility.md](../evidence/backend-feasibility.md)。

## 公开边界

| 方法与路径 | 请求 | 成功 |
| --- | --- | --- |
| `GET /api/manage/ups/{uid}/targets` | 无 | `{targets: [{id: string}]}` |
| `POST /api/manage/ups/{uid}/targets` | `{id: string}` | `{id: string}`，仅在来源作者确认匹配后关联 |
| `DELETE /api/manage/ups/{uid}/targets/{id}` | 无 | `204`，只解除关联，不删除归档 |
| `POST /api/sync/initial` | `{uid: string}` | `{processed, succeeded, failed}`，仅正文统计；媒体独立保存 |
| `POST /api/sync/media/{id}` | 可选 `media_id` 查询参数 | `{processed, succeeded, failed}`，仅动态图媒体尝试统计，不重读正文 |
| `POST /api/sync/media/{id}/comments/{root_id}` | 可选 `media_id` 查询参数 | `{processed, succeeded, failed}`，仅该根评论媒体尝试统计，不重读根页／正文 |
| `GET /api/archive/ups` | 无 | `{ups: [{id: string, nickname: string \| null, avatar_url: string \| null}]}` |
| `GET /api/archive/dynamics` | `scope=all\|up`、条件必需的 `uid`、`limit`、可选 `cursor` | `{items: Archive[], next_cursor: string \| null}` |
| `GET /api/archive/dynamics/{id}` | 无 | `Archive`；本地不存在时 `404` |
| `GET /api/archive/dynamics/{id}/comments` | `sort=hot\|latest`、`limit`、可选 `cursor` | `{items: RootComment[], next_cursor: string \| null}` |
| `GET /api/archive/dynamics/{id}/comments/{root_id}/location` | `sort=hot\|latest`（默认 hot） | `{items: RootComment[], next_cursor: string \| null}`，首批第一项即目标；不存在为 `404` |
| `GET /api/archive/dynamics/{id}/comments/{root_id}/replies` | cursor 模式首读 `limit=3`/续读 `limit=10`；或互斥的正整数 `page`、`limit=10` | 共用 `items` 与独立计数/状态；cursor 模式返回 `next_cursor`，首批另含 `root`；page 模式每页返回 `root`、本地 `count`、`next_cursor:null` |

UID 和动态 ID 必须是十进制字符串，不经 JavaScript Number 转换。不符返回 `409 TARGET_AUTHOR_MISMATCH`，无法确认返回 `502 TARGET_UNVERIFIED`；都不建立关联。上游请求不在数据库事务内，错误只返回固定脱敏提示，不传递上游响应、URL、请求头或异常文本。

初始化入口面向执行者及测试，不从页面挂载、读取或刷新调用；没有手工采集 UI（#26 的状态重读只是归档 GET）。`succeeded` 仅计正文成功（含成功空），正文受限属于本次未成功而计入 `failed`，具体受限/失败由归档状态区分。28 扩展为只处理当前启用模式的入选集合：`specified` 只取指定关联，`recent` 只取已发布的可信窗口；不在该入口发现目标，不混合两种集合，也不补入作者其他历史动态。停止、删除监控配置或解除目标后，保留身份和历史归档。浏览器 list/detail 只读取 SQLite，即使上游不可用也不触发采集。

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

### 26 评论状态读取增量

归档详情增加 `comment_sync`（目标的最新 checks 投影），与来源数、本地根/回复数和正文归档独立。详情 GET 的检查投影与归档在同一 SQLite 读取上下文中取得，不请求上游；没有检查记录但仍有关联目标时表达未检查；无保留目标/检查记录时可为 null，不补造时间。旧冻结 list cursor 缺此字段仍可读，不使已有分页失效。

Archive/checks 增量的 `root_comments_last_succeeded_at`、`replies_last_succeeded_at`、`comments_last_succeeded_at` 分别记录实际根、回复及整轮评论文本成功时间，失败保留旧值、检查无变化不推进。对应 `root_comments_error`、`replies_error`、`comments_error` 只提供固定脱敏码；旧归档缺字段为 null。字段语义与计数检查限制见 [采集契约](collector-api.md#26-评论分项状态与时间)，前端只读状态刷新见 [客户端契约](archive-api-client.md#26-增量评论计数与同步状态)，证据见 [26 验收](../../../.scratch/backend-integration/acceptance-26.md)。

### 执行一次

先启动 [后端 API](../../../backend/README.md)，在 `/manage` 保存 UP、指定模式和已通过归属校验的目标，再由执行者显式调用：

```sh
# 替换为已保存的字符串 UID；这里只是虚构示例。
UP_UID=202
curl --fail-with-body -X POST http://127.0.0.1:8000/api/sync/initial \
  -H 'Content-Type: application/json' --data "{\"uid\":\"$UP_UID\"}"
```

此命令会使用生产传输读取上游；自动化验收只用专用 fixture 装配，不执行该生产命令。B 站来源处于保护状态（任一源入口收到 HTTP 412／429）时，本入口与两个媒体重试入口都返回 `503 SOURCE_RISK_PAUSED` 固定契约（状态、`backoff_step`、可空 `next_probe_at`，有未来截止时间时带 `Retry-After`），不返回统计、不创建半成品；已提交分片与已成功媒体保留，保护到期也不会自动放行（探测由 04／05 负责）。详见[管理契约](management-api.md#来源保护状态票据-03)与[采集契约](collector-api.md#跨进程风控暂停03)。源站限制会如实保留受限/失败，不绕过权限。来源默认匿名，可选登录态仅按[后端 Cookie 配置](../../../backend/README.md#可选-b站登录-cookie仅服务端)读取仓库外私有文件，不能通过本初始化请求体或前端提交凭据；图片/OSS 不使用来源 Cookie。新配置不会自动执行初始化，也不保证解除 HTTP 412。

## Archive 的信息边界

- `id`、`author.id` 是字符串；实际作者身份不采用固定演示 UP，缺失昵称/头像允许为空。HTML TITLE 模块的 `title` 独立保存并安全显示，不混入正文。
- `published_at` 是独立的绝对北京时间，明确 `+08:00`，精度到秒；未知为 `null`，不使用编辑时间补值。
- `edited_at` 仅来自页面 HTML 的 `__INITIAL_STATE__.detail.modules`，按 `MODULE_TYPE_AUTHOR` 读取“编辑于”日期时间。保存来源时区和分钟精度；没有标记不是“确认未编辑”。`edit_status` 为 `observed`、`unknown` 或 `error`，未知/失败不清除旧可信值。
- `title` 是可空独立标题；`text`、`content_state` 表达成功正文（包括成功空）、受限或失败；`last_attempt` 独立描述最近尝试。失败不覆盖旧成功正文。OPUS 的通用 detail `summary` 不是全文证据；全文来自页面 CONTENT 的有序段落，未取得全文不以摘要冒充成功归档。
- `source_comment_count` 为动态来源总数（含根评论和回复，可未知），`local_comment_count` 为本地已归档根评论数，15 新增 `local_reply_count`（15 阶段为 0；17 起为真实本地回复数）。三者不互相替代；错误不覆盖旧可信值。
- `media_sources` 保存顺序、来源 URL 和可用尺寸；`comment_locator` 保存后续评论定位信息。19 新增 `media`、`previous_media`、独立媒体状态和公开 URL（见下节）；来源业务图不是已归档图片，不作为浏览器回退。
- `observed_version` 与 `synced_version` 分开，`work.text` 仅在对应版本成功时推进。15 的 `work.comments` 仅表示根评论分项，17 的 `work.replies` 表示该轮必要回复分项；`work.media` 独立表达当前媒体版本是否完成。观察成功、正文成功或根评论成功不代表全部归档完成。

## 15 根评论契约

### 同步、定位与来源计数

仍使用 `POST /api/sync/initial`，返回统计保持仅计正文；根评论结果从 Archive 读取：

- `root_comments_last_attempt` 为 `pending`、`success`、`failed` 或 `unconfirmed`；`work.comments` 为 `pending|success`。领取根工作时先持久保存 pending，任一必要页失败仍 pending；关闭重开后再次 initial 可在无新信号时重试。
- `synced_root_comment_count` 只在所有必要根页归档成功后保存本轮开始的动态来源计数（未知仍 null）；失败不推进旧 checkpoint。未知计数不阻断实际可读根页，但根页成功不代表计数观察、回复或媒体成功。generation 条件提交拒绝较旧执行覆盖新记录／完成状态。
- `comment_locator` 保留 `oid/type`，新策略增加 `source/policy_version`。在动态 ID 和作者已校验的 detail item 中，按参考函数优先选择合法 basic locator，再回退 OPUS ID/type11、匹配目标动态ID/type11，来源分别为 `basic/opus_fallback/dynamic_id_fallback`。旧 locator 缺策略版本时在后续检查重新核对，失败保留旧观察而不伪造成功；oid/type 变化会推进工作 revision 并重新同步评论，不只比较总数。fallback 条目必须明确带匹配 oid/type；无条目的空页不能作为 fallback 已确认的证据。
- 正式根评论、楼中楼与独立计数通过按 UP 复用的 Requests Session 执行（Cookie 变化或超过 30 分钟会话 TTL 才重建），普通头/15秒超时/环境代理对照参考脚本；同步 I/O 在线程池运行。预热（B站首页与本 UP 空间 `/dynamic` 页，各 10 秒超时，取得响应后等 1–3 秒，每个 URL 独立忽略异常）按 `(UP, Cookie 指纹)` 缓存 5 分钟，过期后后台刷新、失败冷却 60 秒，命中缓存时本轮不再预热；不再做 nav 评论预热，不因此确认登录。私有文件启动读一次，每轮重新初始化 jar，本轮 Cookie 更新保留，结束关闭。重定向只允许 api/www/space 三个精确B站主机的默认HTTPS GET，避免凭据外泄；不为评论接口加 WBI。正文/detail/feed 保持原 HTTPX 路径，两种客户端共享分页等待锁。显式传输替身仍可拦截全部来源 I/O，不复制一套业务解析。
- `/x/v2/reply` 使用 locator、`sort=0`、`ps=20`、递增 `pn`。普通根页、第一页 `upper.top` 及 `hots` 幂等去重保存，不采条目内嵌回复预览。短页仍读下一页直到明确空页，非首屏的空尾页再读取同页确认；复查非空、失败或计数变化均保留已得内容并留待重试，不提前宣布结束。不由有口径争议的 `page.count` 推算页数。第一页 count 非零却无任何根数据、缺失 replies／分页计数、业务／网络／结构错误、跨页计数**减少**或分页不前进均失败，而不是成功空；计数**增长**（多为楼中楼新增，实测可占总数的 99.4%）不中止根分页，只记 `root_scan_count_grew`，页偏移由重复 ID 检测保证。
- 置顶状态仅取首页明确的 `upper.top`：合法对象确认对应根 ID 置顶，显式 `null` 确认无置顶，缺失字段为未知。`hots` 不代表置顶，普通列表同 ID 副本不会覆盖置顶观察。只有整轮根分页成功后才同事务更新全部根的 `is_pinned`；明确取消置顶只清标记、不删旧评论，扫描失败或字段未知保留旧可信标记。
- 归档 JSON 使用内部 `synced_root_metadata_version` 标记根元信息采集格式，v1 为置顶，v2 为 Requests/定位链路，v3 为「缺 `pictures` 键确认无图」。旧归档缺标记或低于当前版本时，启用且入选的目标在后续检查重新登记工作，补采一次根与必要回复；成功后不会因该标记每节拍重扫。停用目标不补采；失败仍按既有 pending 重试。没有 schema 迁移，也不重写已有 cursor。后续普通同步仍沿用首次/未完成/来源计数变化规则，单独改变置顶但计数不变可能延后反映。
- `module_stat.comment.count`（HTML STAT 可作为独立观察）仍是动态来源总数。`page.count/acount` 仅用于当前接口分页校验，不覆盖动态信号，也不假设跨接口永久相等。只有定位可确认且没有正来源计数冲突时，明确 count=0 的根集合空才可成功；若观察总数为正而整轮没有根，仍视为未确认失败。不会清除历史根记录。来源分页不是事务快照，未引起计数变化的上游挪动可能漏检，真实全量及长期稳定性尚未验证。
- 正文 BLOCKED、网页评论无权提示不阻断评论接口；接口明确拒绝统一记录根分项 failed，不冒充空或承诺绕权。每页独立短事务保存，失败保留已取得内容和旧记录；停止、删除配置／目标、来源消失均不删评论。

### RootComment DTO

`id`、`dynamic_id`、`author.id` 均为字符串（未知作者 ID 为 null）；`author:{id,nickname,avatar_url}` 允许未知信息。`published_at` 为明确 `+08:00` 秒精度时间或 null；`text` 为普通文本或 null（缺失），真实空字符串不补内容。`like_count` 和 `source_reply_count` 分别取 `like/rcount`，非负整数或 null，未知不等于零。后续缺失观察不覆盖已有可信计数、时间、文本或作者资料；`content` 缺失或 null 按未知内容处理，非对象仍失败。`content.pictures` 空/缺失时支持参考脚本的 `picture` 单图对象回退；没有有效回退时按以下规则区分：该接口只在根评论确实带图时下发 `pictures`（实测同一轮响应里带图的根有键、无图则缺键），因此**该根从未观察到图片**时缺键/null 即来源确认无图；**已观察到图片**后缺键只保留旧组，不擦旧媒体也不冒充空组；显式空数组总是确认无图。非空图片集合仍须合法。

`is_pinned` 为布尔置顶标记；旧归档及旧快照缺字段时按未置顶展示，不从 UP 身份推断。`root_id/parent_id` 对根评论为字符串 `"0"`，`comment_locator` 保留回复查询所需资源；`media_sources:[{url,width,height}]` 按 `content.pictures` 顺序保留来源及可用尺寸，不包含 OSS 上传成功承诺，不用于生产业务图回退。17 补齐回复；21 新增下文评论媒体字段与上传；页面图片接入仍由 #22 负责。

### 读取、排序与 cursor 恢复

评论 HTTP 只读 SQLite；父动态不存在返回 `404 NOT_FOUND`。默认 `sort=hot`、`limit=20`，limit 范围 1–20。非法排序、批量、未知／重复 query 返回 `422 INVALID_INPUT`。

完整本地根集合先排序后分页：hot/latest 都先按 `is_pinned=true` 优先，再对同级评论按 hot 的点赞降序、发布时间降序、ID BINARY 字符串升序，或 latest 的发布时间降序、ID BINARY 升序排列。置顶计入每批大小且不重复；旧缺标记等同未置顶。逐字段 null 后置，不把 ID 转数字，不声称实现 B站热度算法。

首批在同一短事务冻结全部根评论**内容、顺序及批量**，后续批保存到 SQLite；插入、更新只影响新首批。cursor 绑定根资源、动态、排序、limit 和该次快照；重读／数据库重开返回原批及同一 next_cursor。结束返回 null，不产生下一批。普通网络／`503 STORAGE_UNAVAILABLE` 失败不推进 cursor，原 cursor 重试同批。

15 的评论快照**不设 TTL**，不沿用动态列表的 15 分钟过期。伪造、格式错误、跨父级／排序／资源、改变批量、数据库恢复后丢失的标记返回 `422 CURSOR_INVALID`（固定提示“评论读取标记无效，请重新开始读取”）；不能重试同标记恢复，须显式不带 cursor 开始新快照并丢弃旧分页视图，不静默拼接新旧批。v5→v6 为旧归档详情／新的列表补齐上述新增根状态，旧冻结的动态分页内容保持原样（可能尚无新增字段）；普通启动及迁移不失效有效的动态 cursor。持久评论快照会持续占用空间，本票无回收、容量或无限存储承诺。

自动化证据见 [15 验收记录](../../../.scratch/backend-integration/acceptance-15.md)，静态协议依据见 [来源协议证据](../evidence/source-protocol-evidence.md#15-根评论协议)。

## 17 楼中楼完整归档与读取

### 来源、逐根及整轮成功

沿用公开 initial 和正文统计口径，在根页成功后遍历本轮根集合；本轮原始根响应明确回复数为零的根无需请求回复页，非零或未知均独立请求（持久旧零不能代替新的未知观察） `/x/v2/reply/reply`（可信 locator 的 oid/type、根 ID、ps=20、递增 pn）。不保存根页内嵌的三条预览，不扫描其他动态或补入历史目标。

响应必须确认根／资源／页码／批量／有效非负 `page.count` 与条目关系；完整读取至明确空页，非首屏空尾页复读确认，短页不提前结束。页间 count 变化、重复页、不前进、结构／业务／HTTP 失败，或唯一回复数**多于**该 count 均为失败；已取得页以独立短事务保留。唯一回复数**少于** count 只记录 `reply_scan_short` 并以已取得内容成功：上游 count 会保留已删除、折叠或对当前账号不可见的回复，不能因此把整根判失败。本轮楼中楼 `page.count` 与根页 `rcount` 允许不同（热帖持续增长、两处口径不同），以本次可分页响应自洽为准；成功时以该 count 覆盖根的 `source_reply_count`。来源页不是事务快照，未引起 count 变化的来源移动仍可能漏检；真实权限和长期全量须另证。`page.count` 仅代表该根来源回复数，不覆盖动态评论观察数。

Archive 新增：

- `replies_last_attempt`：该轮回复分项的 `pending|success|failed|unconfirmed`；根页未成功时回复未确认。
- `comments_last_attempt`：整轮根＋回复状态；任何必要根／回复页失败均不为 success。
- `synced_reply_comment_count`：仅该轮必要回复页全部成功后提交其开始处理的动态来源计数。
- `synced_comment_count`：仅根与回复分项均成功、处理观察版本仍匹配时提交整轮 checkpoint。未知观察成功后仍为 null，不伪造零。

`work.comments` 继续仅证明 #15 根页，根页成功可以先于回复；`work.replies` 在回复失败时 pending。领取根工作先持久标记整轮／回复 pending，失败保留旧 checkpoint 与归档；停止、删除配置／目标不删除数据。逐根尝试与成功来源回复数独立持久保存；单根失败不阻断其他根，HTTP 可携带失败状态。重复 initial 幂等，关闭重开后无新信号也能重试；generation 拒绝旧执行覆盖新记录／成功状态。网络等待不持有 SQLite 事务。

### Reply DTO 与独立计数

`id/dynamic_id/root_id` 必为字符串；`parent_id` 为可用目标条目字符串 ID 或 null。`author:{id,nickname,avatar_url}` 允许缺失，时间为明确 `+08:00` 秒精度或 null；`text/like_count` 区分未知与真实空／零。后续未知不擦除旧可信作者、正文、时间、点赞和 parent；不增加回复图片。

`reply_to` 为同根 parent 对应条目的作者对象，或 null。根与跨页回复目标均从完整本地集合解析；目标不存在／无可确认作者 ID 时不拼伪造作者，`content.members` 只是 @ 提及者，不能作为关系证据。目标作者与内容在 cursor 首读一并冻结；page 模式按每次请求的当前完整本地同根集合解析。

楼中楼按根增量推进（与参考脚本一致）：本轮根页 `rcount` 与上次成功快照相同、且距上次成功不足 `FULL_SCAN_SECONDS`（24 小时）的楼层**不重发** `/x/v2/reply/reply`，只沿用已持久状态；`rcount` 变化、从未成功或超过校准周期的楼层才整楼重扫。逐根成功时记录根页 `rcount`、楼中楼来源数与成功时间（`reply_sync.observed_reply_count` / `synced_source_reply_count` / `synced_at`）；跳过不刷新校准计时，因此每根每 24 小时至少完整校准一次，用于补偿增删抵消。`replies_sync_finished` 携带 `skipped=` 与 `degraded=` 便于观察本轮省下的请求和降级轮次。显式初始化（`POST /api/sync/initial`）始终整楼重扫。

根扫描失败不再连坐楼中楼：`sync_roots` 返回空时按已存根评论及其 `source_reply_count` 降级执行（`replies_sync_degraded`），仍按 `scan_due` 只重扫到期/上次失败的楼，失败楼层照常保存已得页。降级轮不改变一致性语义——根集合未确认，故整轮仍记 `replies_last_attempt=unconfirmed`，`synced_reply_comment_count` 与成功时间不推进，`work.replies` 保持 `pending`。因此失败重试只重扫根分页，不会因 `failed/unconfirmed` 强制 `full=True` 全量重扫全部楼层（否则热帖会陷入「全量重扫 → 期间计数变化 → 再全量重扫」的死循环）。楼中楼分页同样只拒绝计数**减少**，增长只记 `reply_scan_count_grew`。

根评论列表为每条根附带 `up_reply`：作者在该楼中最早的一条回复（`{id, author, published_at, text, like_count, reply_to}`），作者未参与时为 null；`reply_to` 只在回复其他楼时带目标作者，直接回根为 null。手机端只用它渲染楼中楼预览，不替代 Reply 分页。cursor 首批回复另返回 `root`（该楼根评论），cursor 续批不重复；实时 page 模式每一页均返回 `root`，供楼中楼页展示被回复评论。

回复批次独立返回 `source_reply_count`（根来源数，可 null）、`local_reply_count`（完整该根本地数，含保留历史）、`replies_last_attempt`（逐根状态，尚未处理为 pending）、`synced_source_reply_count`（该根最近成功页集合的来源数，可 null）。cursor 模式这些元信息与 items 一并冻结，page 模式每次取得最新根/计数/回复；不以当前页条数替代本地总数，也不因本地为零宣称已成功空归档。`source_reply_count` 大于 `local_reply_count` 时差额表示上游未返回的回复，读取端按“已归档 N/M”提示，不当作归档失败。

### 当前 page 模式：实时回复页码

本节按源码基线 `10319d855c55744b603de1fe65433a5b9f73926d` 补齐已存在的读取能力，不是 Vue 迁移新增 API，也不是运行验收证据。当前正常界面宽屏展开回复和独立楼中楼页使用此模式；宽屏最多 3 条预览仍使用后面的 cursor 首读。

- `page` 为不带前导零的正整数字符串，匹配 `^[1-9][0-9]*$`，不是仅允许 1–9。与 `cursor` 查询参数互斥；`limit` 可省略，提供时必须为 10。未知/重复 query、非法 page、混用 cursor、错误批量返回 `422 INVALID_INPUT`。通用 `limit` 校验限制 1–10，超域或非整数也为 INVALID_INPUT。
- 父动态/根关系不存在返回 `404 NOT_FOUND`。page 越过实际末页不是 404/422：返回空 `items` 及实际本地总数，超长合法页码也安全返回空页，不发生偏移转换溢出。
- 每次在同一短只读事务读取当前根、回复和逐根状态，不创建或使用持久 cursor 页。先按时间升序、null 后置、ID BINARY 升序排列，再取当页最多 10 条。
- 返回 `items`、`next_cursor:null`、`count`、`root` 及既有 `source_reply_count/local_reply_count/replies_last_attempt/synced_source_reply_count`。`count` 与 `local_reply_count` 都表示该根完整本地归档回复量；来源数量独立，可能更多、为零或未知。`root` 每页都有，不仅首页有。
- 每次翻页读当前归档，跨页不构成冻结快照，新增/变化可影响下一次响应。前端发送 `cache:'no-store'`，以本地 count 算总页数；越界时再读有效末页。普通失败只影响当前操作，不改归档、不触发上游采集。

### HTTP、排序与 cursor

以下仅描述继续保留的 cursor 冻结模式，不是当前正常 UI 的累计展开方式。父动态或根不在本地对应关系中为 `404 NOT_FOUND`。首批固定最多 3、续批固定最多 10；`limit` 可省略，分别等价于 3／10，显式值只允许对应批量。首批非法批量、未知／重复 query 返回 `422 INVALID_INPUT`；续批改变批量为 `422 CURSOR_INVALID`（超出 Query 允许域的值仍 INVALID_INPUT）。兼容调用方可累计读到 3/13/23/25，结束为 next_cursor=null；当前正常展开/独立页使用 page，不再以此累计量作为 UI 验收条件。

完整同根集合先按时间升序、时间 null 后置、ID BINARY 字符串升序排序，不转数字或使用语言环境比较。首批短事务冻结全部内容／目标／计数／顺序；更新和插入只对新首批可见，旧 cursor 不重不漏。持久 cursor 绑定回复资源、动态、根、时间正序、固定 3→10 批量和该次读取上下文；重读原批与数据库重开返回相同内容及 next_cursor。

回复快照**不设 TTL**，不沿用动态列表 15 分钟；普通传输／503 STORAGE_UNAVAILABLE 失败保留原 cursor 可重试。格式无效、伪造、跨根／动态／资源、读取上下文因数据库恢复而缺失返回 `422 CURSOR_INVALID`，使用既有固定提示“评论读取标记无效，请重新开始读取”。须显式无 cursor 开始新快照并替换旧分页视图，不静默拼接另一范围。无回收／容量承诺，持久快照有增长风险。

v6→v7 新增回复、逐根状态与回复分页表，旧根记录及有效根／动态 cursor 内容不改写；旧 Archive 补齐 pending 和 null 状态，不能从旧根成功推断整轮成功。#17/#18 阶段 Adapter 与页面最初使用此冻结批次模型；当前页码、窄屏独立页及对应返回行为以本节新增 page 说明和[客户端当前基线](archive-api-client.md#当前代码基线回复分页与独立楼中楼)为准，不修改旧票验收结论。

自动化证据见 [17 验收记录](../../../.scratch/backend-integration/acceptance-17.md)，固定资料见 [来源协议证据](../evidence/source-protocol-evidence.md#17-楼中楼协议)。

## 19 动态媒体归档、独立重试与公开 URL

### 执行与 HTTP 状态

initial 仍只统计正文，媒体下载/上传不使正文成功倒退；可读根回复先独立提交，不等待媒体上传。未配置 OSS 时不发上传请求，图片保持 pending；成功解析的无图正文可确认媒体成功空，正文失败且未取得来源不冒充成功空。首次正文不可用但 detail 已取得可信图片来源时，也可独立归档这些图片。

`POST /api/sync/media/{id}` 仅读取本地当前媒体关联并尝试未成功项，不读取上游正文、评论或编辑信号，也不重宣称正文成功。可指定 `?media_id=<关联 ID>` 只重试一张图；不指定则顺序处理全部未完成项。未知本地动态／当前关联返回 `404 NOT_FOUND`；非法关联 ID（必须 32 位小写十六进制字符串）、未知／重复 query 返回 `422 INVALID_INPUT`。成功项不重新上传，未配置 OSS 或无待处理项返回零。此显式运维入口允许恢复保留归档，不依赖监控配置仍存在；不是页面读取／刷新入口或自动调度器。

保护状态下需要下载新图片的手动重试同样返回 `503 SOURCE_RISK_PAUSED`；已全部成功的媒体只做本地结算，仍返回零处理统计，OSS 上传不受暂停影响。重试统计只计实际领取的媒体：`processed` 为尝试数，`succeeded` 为本次上传并被当前关联接受的完成数，`failed` 包括 I/O 失败和因较新版本／尝试取代而被拒绝的旧提交。归档 GET 成功可携带 pending/failed 图片；HTTP 200 不代表全部同步成功。

### Archive 增量 DTO

- `media`：当前来源组的全部有序关联，不以九格截断。每项含 `id`（不透明字符串）、`owner:{type:"dynamic",id:动态ID}`、从 0 开始的 `position`、`source_url`、可空 `width/height`、可空 `version`、`status:pending|success|failed`、`public_url:string|null`、`error:string|null`。
- `public_url` 仅在已接受的上传成功后保存；失败／未上传为 null。浏览器直接使用该完整 HTTPS URL，不拼桶／域名、不由 API 代理、不签名续期；来源 URL 只为归档元信息，不用于生产业务图回退。错误只保存固定 `MEDIA_DOWNLOAD_FAILED` 或 `MEDIA_UPLOAD_FAILED`，不保存异常、上游响应或凭据。内部尝试令牌不出现在 HTTP。
- `previous_media`：被新来源组替换的**旧成功**关联，保留原 owner、顺序、版本及公开 URL，和当前组明确分开；不会把旧 URL 冒充新来源的上传成功。没有自动删除／回收，不承诺容量或费用治理。
- `media_version`：当前媒体来源组实际处理版本；`synced_media_version`：最近整个来源组成功归档的实际版本，失败保留旧值。null 表示无可信编辑版本，不等于上传未完成，须结合状态判断。
- `media_last_attempt:pending|success|failed` 描述当前来源组尝试；`work.media=success` 仅在当前组全成功（含确认空）且实际版本匹配可信 `observed_version` 时成立，否则 pending。旧组成功可提交其实际 checkpoint，但不能清除新观察工作。

### 来源切换、提交与恢复

仅沿用可信编辑时间变化或正文待重试工作来更新整条正文和媒体来源，不以 URL／图片／字节差异检测编辑；无新信号且正文已成功时忽略新正文／来源差异，只重试已有媒体。实际提交正文后切换当前媒体组；正文失败保留旧成功正文与来源组。初次 detail 来源可在正文失败时独立登记，checkpoint 只绑定实际取得的版本。

新版本即使来源 URL 相同也建立新关联并重新上传，不假设同 URL 字节不可变、不选物理去重。相同版本、相同位置和来源的重复提交复用关联，成功项不重传；单图领取使用 SQLite 持久尝试令牌，提交同时校验当前关联 ID 和令牌。旧版本迟到成功／失败均不能改写新关联或清除新工作；同关联的新重试也会 fencing 旧尝试。每个尝试使用不同对象 key，旧 PUT 不能覆盖已发布的新对象。新上传动态图使用 `bili-charge/dynamics/{dynamic_id}/{media_id}/{attempt_token}.{ext}`，评论图使用 `bili-charge/comments/{dynamic_id}/{root_id}/{media_id}/{attempt_token}.{ext}`；后缀按下载响应的 `Content-Type` 映射（如 JPEG 为 `.jpg`、PNG 为 `.png`、WebP 为 `.webp`），不依赖来源 URL 后缀，也不转换图片字节。不支持的 MIME 类型按下载失败保留待重试。已有成功对象及已保存 URL 不迁移、不重传，旧无后缀地址继续有效。来源切换时删除旧关联的内部尝试令牌，同版本正文重试保留已有图片失败状态直到媒体重新领取。被取代／进程退出可能留下无关联对象；未选择对象回收策略，也不保证外部 I/O 恰好一次。

媒体逐张短事务领取／提交，下载与 SDK 上传在事务外；关闭重开或进程退出留下的 pending 可由显式媒体入口重新领取。initial 不再自动处理实际版本落后于新观察的旧组；显式重试可完成旧组，但新版本工作仍 pending。下载限制为受信 B站图片域 `hdslb.com`／`biliimg.com`、HTTP(S) 默认端口，无跳转／环境代理，响应须是非空 `image/*`；原字节上传，不压缩、不创建尺寸变体。

v7→v8 增加内部媒体尝试表并将旧来源初始化为未上传关联，旧正文、评论／回复及来源不删；不会由旧文本成功推断图片上传成功。有效的动态／评论／回复 cursor 内容不重写：旧动态 cursor 可能没有新字段，新首批和 detail 读取当前媒体状态。媒体更新不改变已冻结页的完整内容、顺序、scope／批量或 15 分钟 TTL。

真实接入采用固定版本 `oss2==2.19.1` 和 V4 签名，服务端环境、公开读前提及安全风险见 [后端 README](../../../backend/README.md#19-oss-服务端配置)。可控 HTTP 下载、模拟 OSS、真实 SDK 签名 PUT、失败／交错／重开和网络暂停读写证据见 [19 验收记录](../../../.scratch/backend-integration/acceptance-19.md)；真实云对象可用性归 #34，页面网格／预览与生产 Adapter 图片映射归 #20，评论 owner 扩展归 #21。

## 21 一级评论媒体归档与独立恢复

### 评论 owner、公开结果与重试

initial 在根评论与必要回复提交后独立处理已保存根评论的媒体，复用 19 的下载器、OSS uploader、公开 URL 校验、固定错误及逐图领取／完成协议。根／回复成功不等待图片；某张图失败不回退评论 checkpoint。正文受限或网页无权提示不阻断可读评论图。不归档真实回复及内嵌回复预览图片。

RootComment 新增 `media`、`previous_media`、`observed_version`、`media_version`、`synced_media_version`、`media_last_attempt` 和 `work:{media:pending|success}`：

- `media` 按来源顺序保存全部关联，每项字段与 19 一致，`owner:{type:"comment",id:根评论ID}`，父动态由根的 `dynamic_id` 给出。评论查找与提交均绑定 `(dynamic_id,root_id)`；即使评论／动态 ID 或来源 URL 相同也不共用图片组。新上传对象 key 使用独立的 `bili-charge/comments/{id}/{root_id}/…` 命名空间，并带有按响应 MIME 映射的图片后缀；已成功归档的旧对象 URL 保持不变。
- 未上传与失败项仍在 `media` 中，`public_url=null`，保留顺序与尺寸；纯图评论的 `text=""` 不表示整条评论无内容。成功项仅返回服务端接受的完整公开 URL，无业务来源 URL 回退、代理、前端拼接或签名续期。
- `previous_media` 只保留被替换组中的旧成功关联及公开 URL，不冒充当前图成功；没有对象回收或物理去重。
- `media_last_attempt` 为当前组的 `pending|success|failed`，`work.media` 只说明该评论媒体是否完成当前可信观察；不使用／改写动态的 `work.media`，也不借用根／回复完成状态。

`POST /api/sync/media/{id}/comments/{root_id}` 仅读本地该评论当前组，按来源顺序重试未成功项；`?media_id=` 只选择该组一张图。已成功项跳过，未配置 uploader 返回零。统计及参数校验沿用 19；未知父动态、根或其他 owner 的媒体 ID 返回 `404 NOT_FOUND`，非法 ID、未知／重复 query 返回 `422 INVALID_INPUT`。不请求上游根页、正文或计数，不依赖监控配置仍存在；停止／删目标／删配置后原评论媒体保留且仍可恢复。此运维／测试入口无鉴权，不从页面读取或刷新调用。

### 实际处理版本与失败保留

评论来源没有可信的编辑时间。评论媒体版本使用本次根同步开始处理的来源动态总数，编码为 `comments:<非负整数>`；未知为 null，不能用本地根数、当前时间或动态正文编辑时间补值。`observed_version` 在可信新计数观察时独立保存，即使根页随后失败；`media_version` 在实际取得该根的 pictures 或确认无图时更新，整个组成功才推进其实际 `synced_media_version`。旧组可被显式重试完成，但版本落后时不能清除新工作；initial 跳过落后于可信观察的媒体组。

计数未知不阻断实际可读图片的独立上传完成；此时媒体可成功但 checkpoint 版本仍为 null，不代表计数观察成功或有精确编辑版本。明确空组的媒体 success 是来源已确认无图，不要求无意义的网络上传；新观察后的 `media_last_attempt` 可保留旧组实际结果，应结合 `work.media` 判断新工作。

这只是来源计数版本的提交协议，不增加周期检查／计数触发器（#25/#30 接续），不比较图片字节／哈希检测编辑。数量抵消、纯编辑且计数不变、同计数同 URL 下字节变化仍可能漏检；计数未知不能证明精确编辑版本。实际根同步取得不同来源／位置时会协调关联，但不将来源差异另作检查信号。

相同版本／位置／来源的重复同步复用关联、顺序及既有成功／失败状态；计数新版本即使 URL 相同也建立新关联并重新上传。明确 `pictures:[]` 总是提交空组。缺失 `pictures` 或 `pictures:null` 时，若该根当前组没有任何图片项则确认为空组（否则每个纯文字根评论都会永久 `work.media=pending`，连带 `checks.py` 的「无 pending 根」谓词让目标永不完成）；若已有图片项则保留旧来源与成功媒体，不擦除也不冒充空组。根分页失败沿用 15 的逐页保留，不删除旧媒体或推进根假成功；已取得页的评论图可独立处理。

领取／完成复用持久尝试令牌，并同时校验动态、根、当前关联及 token。新组或同关联的新尝试拒绝旧成功／旧失败；每次 PUT key 不同，旧请求不能物理覆写已发布的新对象。废弃令牌仅按 owner 清理，动态图来源切换不会删评论的在途令牌。网络下载及 OSS PUT 在短事务外，重开／进程退出后 pending 可重新领取。

### v8→v9 与冻结读取

v9 为媒体尝试表增加根 owner 标识（旧动态图尝试保持空根标识），将已有根评论来源回填为独立 pending 关联，不从评论文本成功推断上传成功。空旧来源无法还原是否缺失 pictures，保守保持未确认空；有图组绑定旧根成功计数 checkpoint，新观察更高／不同则仍 pending。既有正文、根／回复、动态图及成功公开 URL 不改写，不因迁移删除归档。

评论媒体仍经现有根评论 GET 读取。新首批冻结当时完整媒体状态；上传或来源更新只影响新的首批，不改写有效的旧根／回复／动态 cursor 内容、顺序、绑定或有效期。旧冻结根页可能没有新增字段，不据此推断已上传。

自动化证据见 [21 验收记录](../../../.scratch/backend-integration/acceptance-21.md)。本票不交付 #22 图片预览／纯图 UI、#25/#30 自动计数联动、回复图片、真实 OSS 操作、图片变体／CDN或对象回收。

## 飞书通知 02 增量：精确一级评论定位读取

本节为通知消息的一级评论精确入口提供只读归档契约，供票据 03（楼中楼回复）和 04（消息中使用的稳定链接）复用。它不新增采集、通知或账号能力，也不改变既有分页契约。

- `GET /api/archive/dynamics/{id}/comments/{root_id}/location?sort=hot|latest` 返回 `{items, next_cursor, prev_cursor, earlier_count}`，结构与该动态的一级评论批次相同：`items` 最多 20 条，且**第一项就是目标评论**；`next_cursor` 是该排序下定位窗口之后的续读游标，可直接用于 `GET /api/archive/dynamics/{id}/comments?cursor=...`。
- `earlier_count` 是当前窗口**之前**还有多少条评论，`prev_cursor` 是读这些更早评论的游标（目标就是第一条时为 `null`、计数为 `0`）。把 `prev_cursor` 交给 `GET /api/archive/dynamics/{id}/comments?cursor=...` 返回紧邻当前窗口之前的一批，同样带自己的 `prev_cursor`/`earlier_count`，可以一直向读到开头：向前批次以“窗口终点”为坐标，**不会与已读窗口重叠**；它不返回 `next_cursor`（`null`），调用方需要保留自己已有的后向续读点，否则会把已读评论再读一遍。
- 排序与 `/comments` 完全一致（置顶优先、最热按点赞、其后发表时间与 ID 稳定收尾），按目标在该排序中的位置取窗口，不重新排序、不额外渲染全部评论。
- 动态不存在、根评论不属于该动态或尚未归档，一律 `404 NOT_FOUND`（不暴露其他动态的评论）；非法排序、未知或重复查询参数返回 `422 INVALID_INPUT`。`limit` 不是该端点的参数，批量固定 20，与前端一级评论批次一致。
- 定位读取只访问本地 SQLite：不访问上游、不写归档、不冻结快照、不创建 `root_comment_pages` 行，也不启动采集或通知。因此“定位 → 读取”本身没有采集副作用。
- 成本如实记录：定位在该动态的本地根评论集合里按排序定位后切窗口，读取成本随单动态根评论量线性增长（内存与 CPU，不涉及上游）。响应与 DOM 仍只有 20 条，不因此渲染全部评论；本期不为单次定位新增专用索引或容量治理，做长期容量评估时须把这条计入。
- 续读游标绑定动态、排序与批量，格式无效、摘要不符或跨动态／跨排序复用返回 `422 CURSOR_INVALID`。后向游标以起点为坐标（形如 `<offset>-<摘要>`），向前游标以终点为坐标（形如 `p<end>-<摘要>`，前缀不是十六进制字符，两者不会混淆）；两种游标都不含凭据。与其他 cursor 不同，定位游标**不冻结当时快照**：续读按当前归档重新取窗口，因此期间新增或点赞变化可能让窗口边界前移／后移；同一 ID 不会被重复展示（前端按 ID 去重），删除评论不在本期范围。该取舍让定位请求保持零写入；需要冻结快照的调用方仍应先读不带 cursor 的首批。
- 归档读取的既有约束继续适用：只读本地归档、上游不可用不触发采集、错误只返回固定脱敏码、ID 一律字符串。

浏览器入口为 `/dynamics/{dynamicId}/comments/{rootId}/locate`（前端专用路由，见[客户端契约](archive-api-client.md#飞书通知-02-增量精确一级评论入口)）。自动化证据见 [02 证据](../../../.scratch/feishu-notifications/evidence/02-root-comment-deep-link.md)。

## 飞书通知 03 增量：楼中楼回复定位读取

本节为通知消息的楼中楼回复精确入口提供只读归档契约。它复用 02 的一级评论定位与既有回复页码模式，不新增采集、通知或账号能力，也不改变既有分页契约。

- `GET /api/archive/dynamics/{id}/comments/{root_id}/replies/{reply_id}/location` 返回 `{items, next_cursor, page, count, root, source_reply_count, local_reply_count, replies_last_attempt, synced_source_reply_count}`。
- `items` 是**目标所在页**（固定 10 条），排序与 `GET .../replies?page=` 完全一致（发表时间升序、null 后置、ID BINARY 升序）；`page` 是该页在所属根完整本地回复集合中的页码（1 起，末页可能不足 10 条）；`root` 是该根评论，供显示所属楼层上下文；`count` 与 `local_reply_count` 是该根完整本地回复数；`source_reply_count` 与 `replies_last_attempt` 沿用逐根状态口径。
- 定位读取与普通页码读取共用同一份切片和 `reply_to` 解析实现，只是额外返回 `page`。`next_cursor` 恒为 `null`：后续翻页仍走 `GET .../replies?page=N&limit=10`，不为此新增游标模式。
- 动态不存在、根评论不属于该动态或尚未归档、目标回复不属于该根或尚未归档，一律 `404 NOT_FOUND`（不暴露其他楼或其他动态的回复）。
- 该端点不接受查询参数：`sort`、`page`、`limit`、`cursor` 等任何未知或重复 query 均返回 `422 INVALID_INPUT`。
- 只读定位只访问本地 SQLite：不访问上游、不写归档、不冻结 `reply_pages` 行、不启动采集或通知。定位本身没有采集副作用。
- 成本如实记录：该端点会读出该根的全部本地回复后再按页码切出 10 条，读取成本随单根回复量线性增长；响应与 DOM 仍只有 10 条。本期不为此新增索引或容量治理，长期容量评估时须把这条计入。
- 归档读取的既有约束继续适用：ID 一律字符串、错误只返回固定脱敏码、代理鉴权不变。

浏览器入口为 `/dynamics/{dynamicId}/comments/{rootId}/replies/{replyId}/locate`（前端专用路由，见[客户端契约](archive-api-client.md#飞书通知-03-增量楼中楼回复精确入口)）。自动化证据见 [03 证据](../../../.scratch/feishu-notifications/evidence/03-reply-deep-link.md)。

## 安全及证据

初始化 JSON 只用 JSON 解析器，不执行网页 JavaScript、`eval` 或表达式；不固定脚本标签或模块数组下标，不依赖 `opus/detail` JSON 取得编辑信号。固定脱敏 fixture 是协议回归证据，不证明所有上游页面、权限状态或长期运行可用。

接口继承首期无鉴权风险，包含可写管理与初始化入口；隐藏路径不是保护。仅应部署到明确接受该风险的网络环境。本次不增加鉴权、备份、容量治理、周期调度或付费基础设施。原始参考脚本保持 ignored，禁止执行、导入或强制纳入版本。
