# 票据 01–02 后端

提供 UP 身份/配置管理、指定动态关联、显式一次初始化及 SQLite 归档读取。没有周期调度、近期目标发现、评论采集或 OSS 上传；不宣称全部归档完成。管理基础契约见 `docs/backend/api/management-api.md`，02 测试证据见 [backend-acceptance-02.md](../.scratch/backend-integration/evidence/backend-acceptance-02.md)，字段依据见 [source-protocol-evidence.md](../docs/backend/evidence/source-protocol-evidence.md)。

## 运行

在仓库根目录执行：

```sh
uv sync --locked
BILI_DATABASE_PATH=/absolute/path/monitor.sqlite uv run uvicorn backend.bili_monitor.app:app --host 127.0.0.1 --port 8000
```

Python 使用 `.python-version` 固定的 3.12；FastAPI、HTTPX、Uvicorn 和 pytest 版本固定于 `uv.lock`。默认数据库为 `backend/data/monitor.sqlite`，启动时创建目录并迁移；仅启动一个 API worker。没有 API 内嵌定时器或常驻 Node.js，也没有本票采集守护进程。

**首期无鉴权**：管理、初始化及归档接口均可被访问者调用，可能暴露内容或被修改配置。请通过监听地址、防火墙或反向代理限制暴露；隐藏入口不是保护。本期没有备份或容量治理。

## 应用工厂与传输边界

```python
from backend.bili_monitor.app import create_app

app = create_app(database_path, profile_transport=None)
```

工厂不打开数据库，ASGI lifespan 启动时迁移。`profile_transport` 是唯一可替换的外部 HTTP transport，覆盖 card、detail 和 `/opus/{id}` 页面；测试使用 `httpx.MockTransport`，不替换解析、同步或存储。使用包含 lifespan 的服务器或 `with TestClient(app)`。

生产请求公开 card、通用动态 detail 与普通 opus HTML；超时 10 秒，不跟随重定向、不使用环境代理，无 Cookie/凭据输入。不会绕过受限正文，不依赖 `opus/detail` JSON 或 ignored 原脚本。

## 02 HTTP 合同

- `GET /api/manage/ups/{uid}/targets` → `{targets:[{id:string}]}`。
- `POST /api/manage/ups/{uid}/targets`，body `{id}` → `201 {id}`。每次请求（包括重复关联）都重新校验作者；确认后关联写入幂等，来源无法确认时仍返回 `502 TARGET_UNVERIFIED`。优先用 HTML AUTHOR 校验；页面无法验证时使用严格 code/id_str 的 detail JSON。可信作者不符返回 `409 TARGET_AUTHOR_MISMATCH`，不强行关联。
- `DELETE /api/manage/ups/{uid}/targets/{id}` → `204`，幂等、不删归档。
- `POST /api/sync/initial`，body `{uid}` → `{processed,succeeded,failed}`。仅处理该 UP 当前 enabled、specified 的关联集合，recent/停用/删配置返回零；未知 UID 返回 404。这是运维/测试一次执行入口，**不是前端阅读或刷新入口**，无定时任务和自动后台重试。
- `GET /api/archive/dynamics?limit=10&cursor=…` → `{items:Archive[],next_cursor:string|null}`。本票只支持 all scope。
- `GET /api/archive/dynamics/{id}` → `Archive`，未知本地 ID 返回 404。以上归档读取只读 SQLite，不请求上游。

Archive 字段保持前端约定：`id`、`author:{id,nickname,avatar_url}`、独立 `title`、`published_at`、`edited_at`、`edit_status`、`text`、`content_state`、`last_attempt`、`source_comment_count`、`local_comment_count`、`media_sources`、`comment_locator`、`observed_version`、`synced_version`、`work`。ID 全为字符串；发布时间为明确 `+08:00` 秒精度 ISO，编辑时间为 `+08:00` 分钟精度 ISO。未知为 null，不补当前时间，也不以编辑时间补发布。`local_comment_count` 固定 0，绝不代替来源数。

### 初始化、正文和版本

- `succeeded` 仅计文本正文成功且其可信 observed version 已提交 checkpoint。四类端到端 fixture（HTML 正文、成功空、BLOCKED、读取失败）返回 `processed=4,succeeded=2,failed=2`；受限计失败，`content_state/last_attempt=restricted`、text pending、synced 不推进。
- 完整正文必须由 HTML `MODULE_TYPE_CONTENT` 的完整受支持段落解析确认；独立 `MODULE_TYPE_TITLE` 保存标题。通用 detail 的 OPUS/DRAW summary 不保证全文，不能用作成功正文或回退。JSON detail 只补身份、发布时间、来源计数、comment locator 和有序媒体 metadata；未知/缺失的 HTML 内容保持失败。BLOCKED hint 不是正文。
- HTML 与 JSON 分别解析，某一路失败不丢另一路已解析的正文或 metadata。有效 JSON 身份/发布时间/计数优先，缺字段保留可信 HTML/已有身份；仅 HTML AUTHOR 的“编辑于”作为编辑信号，JSON 显示文案不作为编辑版本。
- 首次无编辑信号仍保存正文（observed/synced 可均为 null）。普通相对文案、空白或正文/图片差异不触发更新；可信编辑分钟变化或待重试工作才替换正文。不做正文哈希或图片差异检测。
- 未知/error 编辑信号保留旧可信 edited_at/observed。正文失败/受限保留旧成功正文、内容状态及媒体；有效零计数可保存，无效计数不覆盖旧可信值。
- observed 在网络完成前独立持久化，synced 仅绑定本次实际成功处理的 HTML 编辑版本；未知版本不能冒领旧 pending。每次执行用 SQLite generation 条件提交，旧执行不能覆盖较新观察/正文，也不能清掉较新 pending。
- 正文失败保留 pending；关闭重开后再次 initial，即使编辑信号没变也可重试。媒体、评论始终 pending，无上传或采集成功冒充。
- 停止、删目标、删配置只阻止后续领取，不取消已领取请求；身份及归档保留。

### 排序、快照与 cursor

完整 all 归档集合按发布时间降序，缺失最后；相同发布时间按 ID **BINARY 字符串升序**，不转整数。每批 1–10，默认 10。

首批在 SQLite 短事务内冻结集合、完整响应内容和顺序，后续页持久保存到 SQLite。cursor 是不可推导的随机令牌，绑定 `dynamics/all/发布时间降序+ID BINARY/批量/该次快照`。插入、发布时间更新和正文修改只影响新的首批；旧 cursor 在有效期内重读、重开均返回原批，范围内不重不漏。detail 始终读当前归档，不绑定 list 快照。

快照从首次读取开始固定 **15 分钟** 有效，不续期；启动及每次 list 回收过期页，不用长期进程内缓存。结束返回 null。归档列表请求中的伪造、过期、跨资源 cursor、批量不符、未知 query 参数及重复 query 参数均返回 `422 INVALID_INPUT`，不静默另开快照。过期应重新从无 cursor 的首批开始，不将新首批拼入旧阅读快照。本票没有单 UP scope；后续 03 须显式扩展资源绑定。

## SQLite 与安全

schema 顺序：v1 身份/配置、v2 targets、v3 archives/generation、v4 持久分页、v5 cursor 资源/过期/索引。v0–v4 短事务迁移到 v5，冲突回滚、未来版本拒绝启动；旧 v4 无限期 cursor 被失效，但归档不删。每次操作独立连接并启用外键，等待锁最多 2 秒；数据库操作在线程池执行，网络不进事务。删除配置只 cascade 指定关联，绝不 cascade 身份或归档。

错误响应使用固定错误码与提示，不记录请求体、上游原文或异常秘密。HTTPX/HTTPCore 传输日志及 Uvicorn access 日志禁用，部署代理也应避免记录敏感查询。本票测试不读取真实 Cookie、不执行/导入参考脚本、不请求真实上游。

## 测试与 E2E 装配

```sh
uv run pytest backend/tests/test_initial_archive.py -q
uv run pytest backend/tests/test_full_archive.py -q
uv run pytest backend/tests/test_migrations.py -q
uv run pytest backend/tests/test_management.py -q
uv run pytest backend/tests -q
```

公开 HTTP、真实临时 SQLite/关闭重开、固定虚构 HTML/JSON，仅外部 transport 被替换。迁移测试另构造固定旧版本数据库文件作为输入，观察结果仍走 HTTP；不全 mock 数据库。

管理 E2E 的独立装配（不进入生产应用）：

```sh
BILI_DATABASE_PATH=/tmp/bili-management-e2e.sqlite uv run uvicorn backend.tests.live_app:create_app --factory --host 127.0.0.1 --port 8765
```

要求显式环境数据库路径，不预填身份。固定虚构 UID 为 `900719925474099312345`（虚构星海）、`202`（虚构晨光）；头像 `example.invalid`。每次新验收使用新临时路径；同一路径验证重启持久化。归档页面穿透装配由主线程维护在 `tests/e2e-archive/`；本票新增该测试入口及 fixtures，与管理 E2E 装配分离。

## 限制

有限结构证据和虚构 fixture 不证明上游长期可用或完整全文覆盖。分钟编辑精度漏检已接受；本票无周期/近期/评论/上传，无持续调度或 2GB 容量结论。分页冻结全量响应会有临时内存/SQLite 写入成本，15 分钟窗口内频繁新访问会放大磁盘与写竞争；过期删除不保证文件缩小，不宣称容量治理。服务器墙钟回拨可能延长过期判断，生产时钟需正常同步。
