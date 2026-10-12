# UP 管理接口（票据 01）

> 本文保留 01 契约的边界。02 新增指定目标、初始化、归档读取及后续迁移，见 [archive-api.md](archive-api.md) 与 [backend/README.md](../backend/README.md)；指定模式不再只是占位控件。

本契约细化 `.scratch/backend-integration/issues/01-up-monitoring-management.md`，仅涉及身份和监控配置，不含采集、指定动态目标操作或调度。测试入口沿用父规格已确认的 T1/T2。

## HTTP 与输入

所有接口为同源 `/api/manage/ups`，JSON 字段使用 snake_case。

- `GET /api/manage/ups` → `200 {"ups": [UP, ...]}`：包括已删除监控配置的身份，按 UID 字符串稳定排序。
- `GET /api/manage/ups/{uid}` → `200 UP`：删除配置后仍可读身份；未知身份 `404 NOT_FOUND`。
- `POST /api/manage/ups`，仅 `{"uid":"123"}` → `201 UP`。UID 必须是无前导零的 ASCII 正整数字符串，不去空格、不经 JavaScript 大整数转换；拒绝数字类型、符号、小数、零和额外字段。为限定请求大小，UID 最长 128 字符，这不是 UP 数量限额。
- 已有监控配置的 UID 返回 `409 ALREADY_MONITORED`，不请求上游、不覆盖已有资料。已删除配置的 UID 可重新添加：重新取得完整资料后再原子保存，失败保留此前身份。
- `PATCH /api/manage/ups/{uid}/monitor`，完整配置 `{"mode":"recent","recent_n":10,"enabled":true}` → `200 UP`。mode 仅 `recent` / `specified`；recent_n 为正的 JSON 安全整数（最大 9007199254740991，跨语言精度边界，不是 100 目标产品限额）；enabled 严格布尔。禁止额外字段。没有监控配置时 `404 NOT_FOUND`。
- `DELETE /api/manage/ups/{uid}/monitor` → `204`，仅删除配置。对已有身份但已删除的配置幂等；未知身份 `404 NOT_FOUND`。

UP 结构：`{"uid":"123","name":"示例","avatar_url":"https://example.invalid/avatar.png","monitor":{"mode":"recent","recent_n":10,"enabled":true,"last_checked_at":null,"last_succeeded_at":null}}`。删除后 monitor 为 null。身份的 name/avatar_url 可空，以兼容旧资料；前端昵称空时显示“未知用户”，头像空或加载失败时使用 `/default-avatar.svg`。当前检查时间始终 null，不把配置保存时间当成检查时间。默认 recent、10、enabled=true，无 UP 数量限额。

错误统一为 `{"error":{"code":"INVALID_INPUT","message":"固定安全提示"}}`。校验 `422 INVALID_INPUT`，上游网络异常、拒绝、身份不符或资料不足 `502 PROFILE_UNAVAILABLE`，存储失败 `503 STORAGE_UNAVAILABLE`，非预期异常 `500 INTERNAL_ERROR`。响应及日志不回显请求体、上游原文、URL 查询参数或异常文本；前端只以固定错误码映射提示，不显示来自 HTTP 的任意错误文字。失败不产生身份或配置、不覆盖已有成功资料。

## 上游资料边界

服务端通过有超时的 HTTP transport 读取 `https://api.bilibili.com/x/web-interface/card?mid=<uid>` 的公开资料响应：code=0，data.card.mid 与 UID 相符，name 为非空字符串、face 为不带用户信息的 HTTPS URL。缺失或无效时明确失败，不以默认名字头像制造成功资料。只替换 HTTP transport 即可使用虚构上游 JSON fixtures 测试生产解析。浏览器不访问此接口，不接收或编辑凭据；不绕过拒绝，不实现 WBI/付费内容采集。未来上游协议变化需单独核验。

## SQLite 与迁移

身份和监控配置分离；配置的外键引用身份，删除配置不删除身份。首次数据库使用事务创建版本 1；再次启动不改写已保存字段。未知未来 schema 版本拒绝启动，不默默降级。迁移测试通过真实旧/新临时数据库及公开 HTTP 结果验证，不绑定内部表名。上游资料网络请求期间不持有 SQLite 写事务；写入身份和默认配置在短事务内原子完成。API 不含周期调度。

## UI 行为与安全边界

01 的管理页契约支持加载/空态/读取失败重试、新增、逐 UP 编辑保存、独立启停、删除和原位操作重试。02 已补充真实指定目标列表、归属校验、增加/移除及反馈，见 [archive-api.md](archive-api.md)；删除配置仍保留身份与归档。控件使用原生标签、按钮、焦点样式；不提供昵称、头像或凭据编辑。

**首期无鉴权**：公网管理页/API 可被第三方读取和修改；隐藏入口不构成保护。部署时自行限制暴露范围，本票不新增登录前置要求。运行步骤见 README。此前静态阅读装配仍只供阅读，不作为管理成功证据。
