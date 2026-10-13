# 票据 01–02 / 13 / 15 / 17 / 19 / 21 / 23–24 后端

提供 UP 身份/配置管理、指定动态关联、显式一次初始化及 SQLite 归档读取。支持根评论采集、最热／最新归档分页、完整楼中楼归档读取，以及动态图／一级评论图共用下载、OSS 上传和独立重试；23 新增独立进程的固定节拍检查；没有近期目标发现，不宣称全部归档完成。管理基础契约见 `docs/backend/api/management-api.md`，02 测试证据见 [backend-acceptance-02.md](../.scratch/backend-integration/evidence/backend-acceptance-02.md)，字段依据见 [source-protocol-evidence.md](../docs/backend/evidence/source-protocol-evidence.md)。

## 运行

在仓库根目录执行：

```sh
uv sync --locked
BILI_DATABASE_PATH=/absolute/path/monitor.sqlite uv run uvicorn backend.bili_monitor.app:app --host 127.0.0.1 --port 8000
```

Python 使用 `.python-version` 固定的 3.12；FastAPI、HTTPX、Uvicorn 和 pytest 版本固定于 `uv.lock`。默认数据库为 `backend/data/monitor.sqlite`，启动时创建目录并迁移；仅启动一个 API worker。没有 API 内嵌定时器或常驻 Node.js；23 的采集进程需单独启动（见下节）。

**首期无鉴权**：管理、初始化及归档接口均可被访问者调用，可能暴露内容或被修改配置。请通过监听地址、防火墙或反向代理限制暴露；隐藏入口不是保护。本期没有备份或容量治理。

## 23 独立采集进程

API 和采集进程使用同一 SQLite 路径，分别启动，不能增加多个采集进程。仅处理持久启用的指定目标，默认 4 个检查并发、一个独立串行归档阶段。固定 15 秒检查与慢同步分离，状态从 `GET /api/manage/ups/{uid}/checks` 读取；完整节拍、重启与状态语义见 [采集契约](../docs/backend/api/collector-api.md)。API 不内嵌定时器。

```sh
# 前台运行；Ctrl-C 停止（也支持 kill -TERM <pid>）
BILI_DATABASE_PATH=/absolute/path/monitor.sqlite uv run python -m backend.bili_monitor.collector
# 一次检查并登记，既不执行同步，也不恢复中断执行
uv run python -m backend.bili_monitor.collector --database /absolute/path/monitor.sqlite --once
```

先通过管理 HTTP 配置启用的指定目标（mode 值为 `specified`）；默认 recent 没有发现实现，不会发起检查。配置、观察和待处理都持久化，退出时正在执行的工作保留，正常运行重启后恢复为待处理。锁文件位于数据库旁，运行时不要删除或使用硬链接别名。

最小隔离演示（**仅测试装配，不访问真实上游、不读取 OSS 环境、不使用默认生产数据库**）：

```sh
demo_dir=$(mktemp -d)
uv run python -m backend.tests.collector_demo --database "$demo_dir/monitor.sqlite"
# 同一路径再次运行，验证重启保留观察和成功时间
uv run python -m backend.tests.collector_demo --database "$demo_dir/monitor.sqlite"
```

独立 Python 进程输出 0/15/30/45 四个受控节拍的公开 HTTP 状态；首次检查 pending，随后实际无图/零评论归档完成，后续无变化检查只更新检查时间。时间替身只替换外部时钟，真实 SQLite、HTML/JSON 解析、归档及 HTTP 均执行。受控 45 秒不是实际等待 45 秒，也不证明长期运行稳定性。

## 24 编辑同步与版本提交

沿用普通 HTML 的安全 JSON/AUTHOR 解析和同一归档执行链，不新增来源采集器。检查的 `observed`/`revision`、实际正文 HTML 版本及各分项 checkpoint 分开保存：

- 正文 checkpoint 绑定执行时实际读取的可信 HTML 编辑版本，不把领取时的版本套给重新获取的正文。两者不匹配时本轮目标仍 pending，后续固定检查确认版本后可继续。旧执行期间的新检查保持最新观察；管理 `parts.text/media` 针对最新检查版本，不能用旧归档成功冒充新工作完成。归档自身的 observed 仍表示执行阶段实际处理的观察。
- 编辑仅更新正文/动态图来源；collector 不重扫已完成的根评论/回复，只处理初始化和未完成评论重试。显式 initial 保留既有完整初始化/重试能力，计数变化的周期登记由 #25 接续。
- 编辑未知/error 保留旧可信值；已有正文在新版本失败后的无可信版本重试不得替换旧成功正文、媒体来源或 checkpoint。首次无编辑标记仍可初始化，分钟精度不补秒，发布时间不由编辑时间补齐。
- 每次目标领取新增持久、内部、不经 HTTP 返回的 `claim_token`；完成需同时匹配该领取令牌。观察 revision 不替代领取 fencing；同版本重开重新领取、旧迟到完成/失败和重复完成均不能清新任务。归档内容继续由 generation fencing，媒体继续由已有逐图令牌 fencing。API 启动不恢复 running，只有取得采集进程锁后才恢复。
- 正文成功不表示评论/媒体成功；未配置 OSS 的有图目标仍 pending。无新编辑信号时仍可恢复失败分项；重复 execute 对 complete 目标不再次请求来源。

专项测试：`uv run pytest backend/tests/test_versioned_edit_sync.py -q`。原始虚构 HTML 在 `tests/fixtures/versioned_edit/`，覆盖同 pub_ts 不同编辑时间、脚本/模块换序、分钟/空白、相对文案、无效日期/无日期、恶意非 JSON、发布时间缺失、正文/图片改变但信号相同。通过公开 collector、真实 SQLite 关闭重开和 HTTP 验证新旧交错、同/不同观察代次的恢复 fencing、观察后/页面读取中/详情等待/正文提交后中断以及分项失败恢复；不 mock 内部模块。

逐片 red→green 已复现并修复四项：编辑重扫评论令 complete 变 pending；旧版本完成后管理分项仍是假 success；旧领取迟到把新 running 清成 pending；新正文失败后未知版本重试将旧正文替换。其他新增安全解析/恢复场景首跑已通过，属于既有行为回归，不计为修复 red。补充通过 sqlite3 外部连接工厂在真实归档观察事务 commit 前失败／commit 后 ACK 丢失，以及外部 Clock 在全部分项提交后、目标 finish 前中断；重开恢复不需要新信号、不重复已完成评论请求。该 commit 故障不是正文 checkpoint 事务故障，ACK 丢失／控制流中断不冒称硬断电；真实自然多次编辑、同分钟漏检、实际编辑→OSS 联动及持续运行仍未验证。

## 应用工厂与传输边界

```python
from backend.bili_monitor.app import create_app

app = create_app(database_path, profile_transport=None, media_transport=None, media_uploader=None)
```

工厂不打开数据库，ASGI lifespan 启动时迁移。`profile_transport` 是来源协议的外部 HTTP transport，覆盖 card、detail、`/opus/{id}` 页面、`/x/v2/reply` 根评论页及 `/x/v2/reply/reply` 楼中楼页；测试使用 `httpx.MockTransport`，不替换解析、同步或存储。`media_transport` 只替换独立图片下载 HTTP，`media_uploader` 是异步 `upload(key, content, content_type) -> 完整公开URL` 的外部 OSS 边界，测试替身不替换媒体协调或数据库。未注入 uploader 时从服务端环境装配真实 OSS，全部配置缺失则保持待上传。使用包含 lifespan 的服务器或 `with TestClient(app)`。

生产请求公开 card、通用动态 detail、普通 opus HTML 及根评论页码接口；超时 10 秒，不跟随重定向、不使用环境代理，无 Cookie/凭据输入。不会绕过受限正文，不依赖 `opus/detail` JSON 或 ignored 原脚本。

## 02 HTTP 合同

- `GET /api/manage/ups/{uid}/targets` → `{targets:[{id:string}]}`。
- `POST /api/manage/ups/{uid}/targets`，body `{id}` → `201 {id}`。每次请求（包括重复关联）都重新校验作者；确认后关联写入幂等，来源无法确认时仍返回 `502 TARGET_UNVERIFIED`。优先用 HTML AUTHOR 校验；页面无法验证时使用严格 code/id_str 的 detail JSON。可信作者不符返回 `409 TARGET_AUTHOR_MISMATCH`，不强行关联。
- `DELETE /api/manage/ups/{uid}/targets/{id}` → `204`，幂等、不删归档。
- `POST /api/sync/initial`，body `{uid}` → `{processed,succeeded,failed}`。仅处理该 UP 当前 enabled、specified 的关联集合，recent/停用/删配置返回零；未知 UID 返回 404。这是运维/测试一次执行入口，**不是前端阅读或刷新入口**，无定时任务和自动后台重试。
- `GET /api/archive/dynamics?limit=10&cursor=…` → `{items:Archive[],next_cursor:string|null}`。02 原范围只支持 all；13 新增显式 `scope=all|up`，单 UP 必须带 `uid`，省略 scope 兼容 all。
- `GET /api/archive/ups` → `{ups:[{id,nickname,avatar_url}]}`，包含停用／删除配置后的持久身份及已知空身份，不依赖启用名单。
- `GET /api/archive/dynamics?scope=up&uid=202` → 仅该 UP 完整归档的独立分页；未知身份 `404 UNKNOWN_UP`，已知空为成功空列表。
- `GET /api/archive/dynamics/{id}` → `Archive`，未知本地 ID 返回 404。以上归档读取只读 SQLite，不请求上游。

Archive 字段保持前端约定：`id`、`author:{id,nickname,avatar_url}`、独立 `title`、`published_at`、`edited_at`、`edit_status`、`text`、`content_state`、`last_attempt`、`source_comment_count`、`local_comment_count`、`media_sources`、`comment_locator`、`observed_version`、`synced_version`、`work`。ID 全为字符串；发布时间为明确 `+08:00` 秒精度 ISO，编辑时间为 `+08:00` 分钟精度 ISO。未知为 null，不补当前时间，也不以编辑时间补发布。15 的 `local_comment_count` 为真实本地根数，17 的 `local_reply_count` 为真实本地回复数，绝不代替来源数。根分项状态见下节。

### 初始化、正文和版本

- `succeeded` 仅计文本正文成功且其可信 observed version 已提交 checkpoint。四类端到端 fixture（HTML 正文、成功空、BLOCKED、读取失败）返回 `processed=4,succeeded=2,failed=2`；受限计失败，`content_state/last_attempt=restricted`、text pending、synced 不推进。
- 完整正文必须由 HTML `MODULE_TYPE_CONTENT` 的完整受支持段落解析确认；独立 `MODULE_TYPE_TITLE` 保存标题。通用 detail 的 OPUS/DRAW summary 不保证全文，不能用作成功正文或回退。JSON detail 只补身份、发布时间、来源计数、comment locator 和有序媒体 metadata；未知/缺失的 HTML 内容保持失败。BLOCKED hint 不是正文。
- HTML 与 JSON 分别解析，某一路失败不丢另一路已解析的正文或 metadata。有效 JSON 身份/发布时间/计数优先，缺字段保留可信 HTML/已有身份；仅 HTML AUTHOR 的“编辑于”作为编辑信号，JSON 显示文案不作为编辑版本。
- 首次无编辑信号仍保存正文（observed/synced 可均为 null）。普通相对文案、空白或正文/图片差异不触发更新；可信编辑分钟变化或待重试工作才替换正文。不做正文哈希或图片差异检测。
- 未知/error 编辑信号保留旧可信 edited_at/observed。正文失败/受限保留旧成功正文、内容状态及媒体；有效零计数可保存，无效计数不覆盖旧可信值。
- observed 在网络完成前独立持久化，synced 仅绑定本次实际成功处理的 HTML 编辑版本；未知版本不能冒领旧 pending。每次执行用 SQLite generation 条件提交，旧执行不能覆盖较新观察/正文，也不能清掉较新 pending。
- 正文失败保留 pending；关闭重开后再次 initial，即使编辑信号没变也可重试。15 独立读取根评论，17 补齐回复分页，19 独立提交媒体状态；根成功不冒充整轮成功，正文成功也不冒充上传成功。
- 停止、删目标、删配置只阻止后续领取，不取消已领取请求；身份及归档保留。

### 排序、快照与 cursor

完整 all 归档集合按发布时间降序，缺失最后；相同发布时间按 ID **BINARY 字符串升序**，不转整数。每批 1–10，默认 10。

首批在 SQLite 短事务内冻结集合、完整响应内容和顺序，后续页持久保存到 SQLite。cursor 是不可推导的随机令牌，绑定 `dynamics/all/发布时间降序+ID BINARY/批量/该次快照`。插入、发布时间更新和正文修改只影响新的首批；旧 cursor 在有效期内重读、重开均返回原批，范围内不重不漏。detail 始终读当前归档，不绑定 list 快照。

快照从首次读取开始固定 **15 分钟** 有效，不续期；启动及每次 list 回收过期页，不用长期进程内缓存。结束返回 null。归档列表请求中的伪造、过期、跨资源 cursor、批量不符、未知 query 参数及重复 query 参数均返回 `422 INVALID_INPUT`，不静默另开快照。过期应重新从无 cursor 的首批开始，不将新首批拼入旧阅读快照。13 已扩展单 UP scope：cursor 额外绑定 UID，跨 all/up 或不同 UP 明确拒绝；不改变 v5 schema 或仍有效的旧全局 cursor。详见 [scope 协议](../docs/backend/api/archive-api.md) 与 [13 验收](../.scratch/backend-integration/acceptance-13.md)。

## 15 根评论

`POST /api/sync/initial` 同时归档目标已有可读根评论；统计仍只计正文。根评论接口和网页正文／评论无权提示独立；缺失 locator 时 `root_comments_last_attempt=unconfirmed`，必要页失败为 failed，旧内容及成功 checkpoint 保留且 `work.comments=pending`。重开后再次调用可重试；不启用定时器。

`GET /api/archive/dynamics/{id}/comments?sort=hot|latest&limit=20&cursor=…` 只读取 SQLite，默认最热，每批 1–20。按完整根集合排序后冻结内容和顺序；后续 cursor 绑定动态／排序／批量／快照，更新及重开不改旧批。评论快照不设 TTL，普通读取失败重试原批；`422 CURSOR_INVALID` 须显式重读首批且丢弃旧视图。结束 next_cursor=null。当前无快照回收及容量承诺。

新增 Archive 字段 `local_reply_count`、`root_comments_last_attempt`、`synced_root_comment_count`，以及独立 `work.replies`。`work.comments=success` 只证明根分页成功，不代表回复／媒体／来源计数观察成功。DTO、计数映射、错误和分页限制见 [归档契约](../docs/backend/api/archive-api.md#15-根评论契约)；自动化证据见 [15 验收](../.scratch/backend-integration/acceptance-15.md)。

## 17 楼中楼

initial 在本轮根页成功后同步非零／未知回复数的根，完整来源分页不使用内嵌预览。逐根失败保留成功部分及旧归档；无新信号时可再次 initial 重试。`work.comments` 仅根页，`work.replies` 为回复页，整轮成功由 `comments_last_attempt/synced_comment_count` 表达；正文和媒体独立。

`GET /api/archive/dynamics/{id}/comments/{root_id}/replies` 首批最多 3、续批最多 10（可省略 limit，显式仅分别允许3／10）。完整同根集合按时间正序、null 后置、ID BINARY 字符串升序，冻结内容、顺序、目标和来源／本地计数。cursor 绑定动态／根／回复资源／固定批量／上下文，不设 TTL，重开仍可重读；失效须显式重开首批，普通读取失败可重试原 cursor，不静默混合新旧范围。

逐根读取同时返回来源回复数、本地完整数、最近尝试及成功数；首次失败空本地数不冒充成功空。目标作者只由同根 parent 对应归档解析；找不到则 null，不以 @ 提及者伪造。完整 DTO、错误与证据见 [归档契约](../docs/backend/api/archive-api.md#17-楼中楼完整归档与读取) 与 [17 验收](../.scratch/backend-integration/acceptance-17.md)。不交付 #18 页面展开/历史恢复。

## 19 OSS 服务端配置

动态图按照完整来源顺序下载，原字节上传；每张图保存状态、脱敏错误和完整公开 URL。`POST /api/sync/media/{dynamicId}` 独立恢复未完成图片，可加 `?media_id=<当前关联ID>` 只重试一张；不会请求正文、评论或重新宣称正文成功。已成功项跳过；未配置 uploader 返回零，图片保持 pending。完整 DTO、来源切换、旧成功保留和版本／尝试 fencing 见 [19 契约](../docs/backend/api/archive-api.md#19-动态媒体归档独立重试与公开-url)，证据见 [acceptance-19.md](../.scratch/backend-integration/acceptance-19.md)。

仅在**仓库外的受限服务环境**提供下列配置，勿将真实值写入仓库、前端、命令记录或本 README；应用不读取 ignored 参考脚本／配置，也不自动加载凭据文件：

| 环境变量 | 用途 |
| --- | --- |
| `BILI_OSS_ENDPOINT` | 桶所在区域 HTTPS OSS endpoint，例如 `https://oss-cn-hangzhou.aliyuncs.com` |
| `BILI_OSS_REGION` | 区域，例如 `cn-hangzhou`，用于 V4 签名 |
| `BILI_OSS_BUCKET` | 已存在桶名；应用不创建桶或改变 ACL |
| `BILI_OSS_ACCESS_KEY_ID` / `BILI_OSS_ACCESS_KEY_SECRET` | 服务端上传凭据，建议最小 PutObject 权限 |
| `BILI_OSS_SECURITY_TOKEN` | 可选 STS token；有值时使用 V4 STS 认证，不实现自动续期 |
| `BILI_OSS_PUBLIC_BASE_URL` | 已配置匿名公开读取的完整 HTTPS 基址，可带固定路径前缀，不带 query／签名／fragment／用户凭据 |

全部缺失时允许启动但不上传；部分缺失／非法配置以固定 `Application lifecycle failed` 拒绝启动，不回显原值。凭据对象不进入数据库／API。固定 `oss2==2.19.1` SDK 使用 V4、30 秒网络超时，阻塞 PUT 在线程池运行；下载 HTTP 独立于来源 HTTP，关闭客户端及 SDK session，不使用环境代理。图片下载只允许 `hdslb.com`／`biliimg.com` 受信图片域、默认端口的 HTTP(S)，不跟随跳转，非图片／空响应记录失败。

公开匿名 URL 的桶／自定义域配置由维护者提供；上传成功不能证明实际匿名访问、浏览器兼容或长期可用，真实云证据归 #34。本票不购买资源、不读真实凭据、不开放 ACL、不选 CDN／压缩／尺寸变体／物理去重。对象 key 每次尝试不同，旧 PUT 不覆盖新结果；被取代／崩溃可能留下孤立对象，尚无回收、备份、容量或费用治理。旧成功关联保存在 `previous_media`，与新组分开，不冒充新图成功。

媒体重试同其他写入口一样无鉴权，须通过网络部署限制暴露；公开图可直接访问及外链，未来站点登录也不会自动保护。页面／生产 Adapter 图映射归 #20，评论媒体归 #21，周期重试归后续调度票。

## 21 一级评论媒体

initial 在根／回复独立提交后处理评论图；正文受限不阻断实际可读评论图，评论文本成功不等待每图上传。RootComment 返回全部有序 `media`、旧成功 `previous_media`、独立状态／实际计数版本／checkpoint；纯图评论保留空正文及未上传图片，不回退业务来源 URL。评论 owner 与动态图隔离，不增加回复图片。

`POST /api/sync/media/{dynamicId}/comments/{rootId}` 可独立恢复该根未完成媒体，`?media_id=<当前关联ID>` 只重试一张。无需重新读取正文／根页或新计数信号，停止／删除配置后仍可恢复保留归档；不从页面读取触发。共用本页的 OSS 服务端配置，不复制上传器，不执行真实云操作。版本由根同步实际处理的动态来源计数给出，未知不补值；新观察、实际来源组和已成功组分别保存。旧版本完成及较旧尝试不能清新工作或替换关联，同计数同 URL 下字节编辑仍可能漏检。

完整 owner、来源缺失／空组、版本提交、迁移和冻结 cursor 契约见 [21 归档契约](../docs/backend/api/archive-api.md#21-一级评论媒体归档与独立恢复)，自动化证据见 [21 验收](../.scratch/backend-integration/acceptance-21.md)。图片 UI／预览归 #22，周期计数联动归 #25/#30；没有对象回收、图片变体或 CDN。本入口继承无鉴权和公开 OSS URL 风险。

## SQLite 与安全

schema 顺序：v1 身份/配置、v2 targets、v3 archives/generation、v4 持久分页、v5 cursor 资源/过期/索引、v6 根评论及独立持久评论页、v7 回复／逐根同步状态／回复持久页、v8 媒体尝试令牌及归档文档媒体字段、v9 评论 owner 尝试标识与旧根来源 pending 回填、v10 持久目标检查/观察/工作/时间/独立错误、v11 目标领取 fencing 令牌。v0–v10 短事务迁移到 v11，冲突回滚、未来版本拒绝启动；旧 v4 无限期 cursor 被失效，但归档不删。每次操作独立连接并启用外键，等待锁最多 2 秒；数据库操作在线程池执行，网络不进事务。删除配置只 cascade 指定关联，绝不 cascade 身份或归档。

错误响应使用固定错误码与提示，不记录请求体、上游原文或异常秘密。HTTPX/HTTPCore、OSS SDK、Requests/urllib3 传输日志及 Uvicorn access 日志禁用，部署代理也应避免记录敏感查询。本票测试不读取真实 Cookie、不执行/导入参考脚本、不请求真实上游。

## 测试与 E2E 装配

```sh
uv run pytest backend/tests/test_collector.py -q
uv run pytest backend/tests/test_comment_media.py -q
uv run pytest backend/tests/test_dynamic_media.py -q
uv run pytest backend/tests/test_replies.py -q
uv run pytest backend/tests/test_root_comments.py -q
uv run pytest backend/tests/test_scoped_archive.py -q
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

有限结构证据和虚构 fixture 不证明上游长期可用或完整全文覆盖。分钟编辑精度漏检已接受；本阶段已交付独立固定节拍进程，但无近期发现、真实云上传、长期实际稳定性或 2GB 容量结论。分页冻结全量响应会有临时内存/SQLite 写入成本，15 分钟窗口内频繁新访问会放大磁盘与写竞争；过期删除不保证文件缩小，不宣称容量治理。服务器墙钟回拨可能延长过期判断，生产时钟需正常同步。
