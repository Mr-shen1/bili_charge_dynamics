# UP 管理接口（票据 01）

> 本文保留 01 契约的边界。02 新增指定目标、初始化、归档读取及后续迁移，见 [archive-api.md](archive-api.md) 与 [backend/README.md](../../../backend/README.md)；指定模式不再只是占位控件。

本契约细化 `.scratch/backend-integration/issues/01-up-monitoring-management.md`，仅涉及身份和监控配置，不含采集、指定动态目标操作或调度。测试入口沿用父规格已确认的 T1/T2。

## HTTP 与输入

所有接口为同源 `/api/manage/ups`，JSON 字段使用 snake_case。

- `GET /api/manage/ups` → `200 {"ups": [UP, ...]}`：包括已删除监控配置的身份，按 UID 字符串稳定排序。
- `GET /api/manage/ups/{uid}` → `200 UP`：删除配置后仍可读身份；未知身份 `404 NOT_FOUND`。
- `POST /api/manage/ups`，仅 `{"uid":"123"}` → `201 UP`。UID 必须是无前导零的 ASCII 正整数字符串，不去空格、不经 JavaScript 大整数转换；拒绝数字类型、符号、小数、零和额外字段。为限定请求大小，UID 最长 128 字符，这不是 UP 数量限额。
- 已有监控配置的 UID 返回 `409 ALREADY_MONITORED`，不请求上游、不覆盖已有资料。已删除配置的 UID 可重新添加：重新取得完整资料后再原子保存，失败保留此前身份。
- `PATCH /api/manage/ups/{uid}/monitor`，完整配置 `{"mode":"recent","recent_n":10,"enabled":true}` → `200 UP`。mode 仅 `recent` / `specified`；recent_n 为正的 JSON 安全整数（最大 9007199254740991，跨语言精度边界，不是 100 目标产品限额）；enabled 严格布尔。禁止额外字段。没有监控配置时 `404 NOT_FOUND`。
- `DELETE /api/manage/ups/{uid}/monitor` → `204`，仅删除配置。对已有身份但已删除的配置幂等；未知身份 `404 NOT_FOUND`。

UP 结构：`{"uid":"123","name":"示例","avatar_url":"https://example.invalid/avatar.png","monitor":{"mode":"recent","recent_n":10,"enabled":true,"last_checked_at":null,"last_succeeded_at":null}}`。删除后 monitor 为 null。身份的 name/avatar_url 可空，以兼容旧资料；前端昵称空时显示“未知用户”，头像空或加载失败时使用 `/default-avatar.svg`。01 阶段检查时间始终 null；23 后由持久目标检查/实际成功时间的最大值提供，未检查/未成功仍为 null，不把配置保存时间当成检查时间，详见 [采集与状态契约](collector-api.md)。默认 recent、10、enabled=false：新增 UP 只保存身份与默认配置并停在“监控已停止”，需用户显式启用后才进入发现与检查；无 UP 数量限额。

错误统一为 `{"error":{"code":"INVALID_INPUT","message":"固定安全提示"}}`。校验 `422 INVALID_INPUT`，上游网络异常、拒绝、身份不符或资料不足 `502 PROFILE_UNAVAILABLE`，存储失败 `503 STORAGE_UNAVAILABLE`，非预期异常 `500 INTERNAL_ERROR`，B 站来源处于保护状态 `503 SOURCE_RISK_PAUSED`（见下文「来源保护状态」），人工探测登记在当前状态不适用时 `409 RISK_PROBE_NOT_ALLOWED`（见下文「人工探测登记」）。响应及日志不回显请求体、完整上游响应、URL 查询参数或异常文本；服务端消息日志只允许下述审核通过的固定文本；前端只以固定错误码映射提示，不显示来自 HTTP 的任意错误文字。失败不产生身份或配置、不覆盖已有成功资料。

### 来源保护状态（票据 03）

只要操作**实际需要访问 B 站**，在保护状态下返回固定契约：

- `503 {"error":{"code":"SOURCE_RISK_PAUSED","message":"B 站来源保护中，需要访问来源的操作暂不可用","state":"cooldown","backoff_step":1,"next_probe_at":"<ISO 或 null>"}}`。`message` 是固定安全提示，前端只按错误码映射，不回显该字段。`state` 可能是 `cooldown`／`probing`／`manual`；只有 `cooldown` 带未来 `next_probe_at`，后两者为 null。
- 有未来截止时间时附 `Retry-After`（剩余秒数，向上取整）；`next_probe_at` 已过期或为空则不带该头。冷却到期只表示“该执行一轮按接口探测”，探测全部通过前仍不放行，因此不承诺重试一定成功；六档阶梯、探测类型与唯一 owner 见[采集契约](collector-api.md#六档冷却与按接口探测04)。
- 触发保护的那一次请求同样返回该错误：它没有完成，也不返回 `processed/succeeded/failed` 之类的统计，避免伪成功；已提交的分片与已下载内容保留，不产生半成品身份或目标。
- 覆盖：新增 UP（资料查询）、目标校验（作者核对）、`POST /api/sync/initial`、`POST /api/sync/media/{id}`、`.../comments/{root_id}`。不覆盖纯本地读取、配置保存／启停／删除、通知开关、归档阅读与 OSS 上传；也不需要来源时（例如当前没有可运行目标）仍按原语义返回。
- 原有输入校验与本地冲突优先：非法输入仍 `422`，已有监控配置仍 `409 ALREADY_MONITORED`，未知身份仍 `404`。
- 状态本身由只读 `GET /api/manage/risk` 提供（字段与脱敏边界见[采集与状态契约](collector-api.md)），同一份 SQLite 事实；本契约不另建风控页面或面板。

### 人工探测登记（票据 05）

`POST /api/manage/risk/probe` → `202`，沿用现有管理入口的部署保护（反向代理 Basic Auth），不新增页面或鉴权体系：

- 只在 `manual` 登记一轮探测，`202` **仅表示已登记**，不代表探测成功、接口恢复或已清零档位；探测由正式采集进程领取执行，API 不直接发起请求。
- 同一人工态代次的重复登记幂等，不排多轮；采集进程未运行时保持“已登记”。登记绑定当前人工态代次，一轮执行后需重新登记。
- 冷却未到期、正在探测及普通／观察态都不适用，返回固定 `409 {"error":{"code":"RISK_PROBE_NOT_ALLOWED","message":"当前保护状态不允许登记人工探测"}}`，不附带状态字段以外的可写信息。
- 不接受 query 参数（非法或重复 `422 INVALID_INPUT`），也不接受任何可写状态字段：请求体只允许空对象或缺省，`state`／`backoff_step`／`next_probe_at` 之类字段一律 `422 INVALID_INPUT`，不能借请求体清零档位、修改截止时间或绕过检查。
- 返回体是该时刻的只读[保护状态](collector-api.md#跨进程风控暂停03)（含 `manual.probe_registered=true`），不含 owner、租约或内部令牌。

### 服务端资料失败诊断

`PROFILE_UNAVAILABLE` 的 HTTP 状态和响应结构不变；分类只写服务端 WARNING 日志，不增加前端字段或展示上游原文。每次预期的资料失败只产生一条固定格式事件：

```text
profile_lookup_failed reason=<分类> http_status=<状态>
```

HTTP 非成功或严格整数业务码非零时，同一条事件追加 `message_state=<分类> upstream_message=<JSON 字符串或 null>`。它会检查错误响应的顶层 `message`，仅在缺失、null 或空白时尝试 `msg`；不递归查个人资料，不把 HTTP 4xx 中的 `code=0` 当作成功。

只解析已缓冲且不超过 8192 字节的响应正文；这不是网络读取总量上限。先检查正文大小，超限 HTML 也记为 `body_too_large`，不再检查其内容。非空候选消息原长最多 200 字符，去首尾空白后必须完全匹配 `profiles.py` 的 `_SAFE_UPSTREAM_MESSAGES` 固定安全目录，才将该文本用 JSON 引号输出。目录仅批准文本可记日志，不代表 B站当前实际返回这些短语。未知消息不能仅靠截断或正则保证不含秘密，因此不记录未知原文或片段。

`message_state` 为 `allowed`、`missing`、`invalid_type`、`too_long`、`not_allowlisted`、`html`、`non_json`、`invalid_payload`、`body_too_large`、`empty_body` 或 `unreadable`。仅 `allowed` 的 `upstream_message` 非 null。HTML（含 XHTML）、非 JSON、未知/过长消息只记录上述原因；没有响应的超时/传输错误等仍用原 `reason`，不追加消息字段。已丢弃的历史响应无法补录；此前实测 HTTP 412 的 body 未保留，不能确认当时是 JSON、HTML 或存在何种 message。

以下仅为格式示例，不是本次真实 B站响应证据：

```text
profile_lookup_failed reason=http_status http_status=412 message_state=allowed upstream_message="请求被拦截"
```

`reason` 为 `timeout`（HTTPX 超时）、`network_error`（其他 HTTPX 传输/协议错误）、`http_status`（上游 HTTP 非成功）、`upstream_rejected`（严格整数业务码非零）、`payload_invalid`（JSON、业务码类型或资料结构无效）、`uid_mismatch`（返回身份类型无效或与请求不符）、`profile_invalid`（昵称/头像缺失或不符合公开资料约束）。只有 `http_status` 分类记录严格整数且范围为 100–599 的状态，否则为 `unknown`；其他分类该字段为 `none`，不表示上游未返回响应。

分类边界：`data.card` 缺失/无效或 `mid` 键缺失属于 `payload_invalid`；`mid` 存在但类型或值不符属于 `uid_mismatch`；身份匹配后 `name`/`face` 键缺失或值不符属于 `profile_invalid`，不是前述结构分类。

日志不含请求 UID、URL、查询参数、headers、完整 body、昵称/头像、原始业务码、未经审核的上游 message、异常文本或 traceback。非零业务码只分类为拒绝，不能据此区分具体权限/风控原因；诊断分类本身也不是自动修复或新增重试授权。资料请求/原解析的捕获集合（HTTPX HTTPError、ValueError、KeyError、TypeError）不变；该阶段未落入集合的非预期异常仍遵循原 `500 INTERNAL_ERROR` 与安全处理。错误消息诊断是尽力而为的旁路，其自身异常只降级为 `unreadable`/null，不把已经确定的资料失败 502 改成 500，也不记录异常原文。失败依旧不创建/覆盖身份，不重试、不绕过拒绝。

## 上游资料边界

服务端通过有超时的 HTTP transport 读取 `https://api.bilibili.com/x/web-interface/card?mid=<uid>` 的公开资料响应：code=0，data.card.mid 与 UID 相符，name 为非空字符串、face 为不带用户信息的 HTTPS URL。缺失或无效时明确失败，不以默认名字头像制造成功资料。只替换 HTTP transport 即可使用虚构上游 JSON fixtures 测试生产解析。浏览器不访问此接口，不接收或编辑凭据；不绕过拒绝，不实现 WBI/付费内容采集。未来上游协议变化需单独核验。

来源默认匿名，普通初始化请求头使用真实应用名 User-Agent、中文语言偏好，并按 API/页面 host 分别协商 JSON/HTML，见[来源 client 初始化](../../../backend/README.md#来源-client-初始化)。不复制浏览器身份、Origin/Referer 或参考脚本的初始化网络请求，也不因此保证消除 HTTP 412。

可选 `BILI_COOKIE_FILE` 仅指向仓库外私有文件，启动时读取一次；内容不经前端/API 输入，不返回身份 DTO，也不写入 SQLite/日志。只附加到 GET、HTTPS、标准 443、精确 `api.bilibili.com` / `www.bilibili.com`、无 URL 用户信息的来源请求；其他请求清除 Cookie。媒体客户端和 OSS 不接入。未配置保持原行为，配置无效拒绝启动，不静默退回匿名。安全文件约束及隐藏输入命令见[后端 Cookie 配置](../../../backend/README.md#可选-b站登录-cookie仅服务端)。不自动续期、不增加 WBI 或权限/风控绕过；启用登录态也不能保证资料查询成功。本次增补按用户要求未执行测试、回归、审查或真实验证。

## SQLite 与迁移

身份和监控配置分离；配置的外键引用身份，删除配置不删除身份。首次数据库使用事务创建版本 1；再次启动不改写已保存字段。未知未来 schema 版本拒绝启动，不默默降级。票据 03 新增 v24（`source_risk` 单行保护状态），票据 06 新增 v25（根页／楼中楼续采进度 `page_scan_progress`），票据 05 在 v26 复用同一单行补观察进度与人工探测登记列（`observing_active_ms`／`observing_successes`／`probe_request_generation`／`probe_origin`），票据 08 新增 v27（跨进程发送／重型／目标租约 `dispatch_leases`），评论图片版本改用 `comment:<rpid>` 新增 v28，迁移在 `BEGIN IMMEDIATE` 内原子完成，保留归档、媒体、阅读 cursor、未完成工作与已登记的保护状态，也不预占后续版本；当前 schema 为 v28，未来版本 29 拒绝启动；保护状态读不出来时拒绝新源请求（`503 STORAGE_UNAVAILABLE`），不降级放行。迁移测试通过真实旧/新临时数据库及公开 HTTP 结果验证，不绑定内部表名。上游资料网络请求期间不持有 SQLite 写事务；写入身份和默认配置在短事务内原子完成。API 不含周期调度。

## 通知状态（票据 14 引入，票据 15 改为三态）

只决定“发哪一类消息”，不控制进程启停（进程启停仍由 `BILI_NOTIFICATION_CONFIG` 决定）。同源 `/api/manage/notifications`，JSON 字段 snake_case。状态持久在 SQLite（v23 迁移 `notification_gate`，三态，**默认 `off`**；缺行也按 `off`），随库走，重启服务、重新部署与机器重启都保持。

- `GET /api/manage/notifications` → `200 {"state": "off", "pending": 0}`：`state` 是 `all`／`system_only`／`off` 之一；`pending` 为待发条数（只读聚合，`state = 'pending'` 的投递记录数）。不返回路由、webhook、密钥或任何消息正文。
- `PUT /api/manage/notifications`，完整体 `{"state": "all"}` → `200 {"state": "all", "pending": N}`：`state` 必须是三个字面量之一（大小写、空白、非字符串、未知值一律 `422`），禁止额外字段；写入在同一事务内完成，写失败 `503 STORAGE_UNAVAILABLE`，不回写一半。
- 状态切换语义：进入 `off` 作废全部未投递记录，进入 `system_only` 只作废业务角色的未投递记录；切回 `all` 时把业务起点前移到切换时刻，关闭或仅系统期间的内容**不补发**。语义与边界见[通知进程契约](notification-process.md#11-发送状态管理页三态票据-14-起票据-15-改造)。
- 幂等：重复写入同一状态返回同样的 `200` 与新状态，不额外产生日志噪声，也不重复收敛队列。
- 两个方法都不接受查询参数：出现未知查询参数按 `422 INVALID_INPUT` 拒绝，不静默忽略。
- 无需新增鉴权：`/api/manage/*` 已由部署侧 `auth_basic "bili manage"` 保护（BasicAuth 属于云端反向代理形态，由运维自行配置；`deploy-v2` 渲染的站点只在 `/api` 上做反代，不含代理鉴权，见[部署手册](../../../deploy-v2/README.md)），本文沿用。
- 日志：切换成功只在状态真的变化时记一条 `notifier_event`（`notification_switch_changed state=<all|system_only|off>`）；幂等重复写不产生日志。日志字段只有固定分类与枚举值，不含 webhook、密钥或 URL。
- 页面行为：管理页顶部的“飞书通知”是一个原生下拉框（选项“全部通知／仅心跳与告警／全部关闭”），初始状态**必须**来自 `GET`（不读本地记忆）；切换失败保留原状态并给出固定提示；状态切换后刷新页面应与真实状态一致；窄屏可用。状态行是“飞书通知：<状态名>，待发 N 条。”，成功文案为“飞书通知已切换为「<状态名>」，待发 N 条。”。读取失败只显示固定提示与“重新读取通知状态”按钮，不自动重试。
- 与其它开关的关系（避免概念混淆）：`BILI_NOTIFICATION_CONFIG` 缺失 → 通知进程不启动，页面状态无意义；配置存在但状态为 `off` → 进程运行、一条都不发（含心跳与告警）；`system_only` → 只发心跳与告警。

## UI 行为与安全边界

01 的管理页契约支持加载/空态/读取失败重试、新增、逐 UP 编辑保存、独立启停、删除和原位操作重试。02 已补充真实指定目标列表、归属校验、增加/移除及反馈，见 [archive-api.md](archive-api.md)；删除配置仍保留身份与归档。控件使用原生标签、按钮、焦点样式；不提供昵称、头像或凭据编辑。

**不新增风控页面**：保护状态只通过上述固定错误提示与只读 `GET /api/manage/risk` 暴露，管理页不新增风控面板、采集按钮或强制解锁入口。**应用与部署保护分开**：01 阶段未实现应用内账号/权限；当前部署模板已有针对管理路径的反向代理 Basic Auth，客户端也会将管理响应 401 映射为固定的身份验证提示，不回显代理正文。这不是应用新增登录/角色系统，也不证明所有环境都已启用保护。Vue 迁移按当前代码保留这些边界，不根据旧“无鉴权”描述删除代理保护或 401 处理；反代配置及限制由运维在云端反向代理上自行设置（`deploy-v2` 渲染的站点不含代理鉴权），见[部署手册](../../../deploy-v2/README.md)。未受保护或可绕过代理的管理入口仍有被第三方读取/修改的风险，隐藏入口不是保护。此前静态阅读装配仍不作为管理成功证据。
