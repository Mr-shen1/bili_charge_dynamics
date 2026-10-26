# 票据 01–02 / 13 / 15 / 17 / 19 / 21 / 23–28 后端

提供 UP 身份/配置管理、指定动态关联、显式一次初始化及 SQLite 归档读取。支持根评论采集、最热／最新归档分页、完整楼中楼归档读取，以及动态图／一级评论图共用下载、OSS 上传和独立重试；23 新增独立进程的固定节拍检查；27 增加原规则近期分页发现与持久状态，28 将可信结果发布为当前窗口，并复用既有检查/初始化/根回复/媒体链；发现成功不宣称全部归档完成。管理基础契约见 `docs/backend/api/management-api.md`，02 测试证据见 [backend-acceptance-02.md](../.scratch/backend-integration/evidence/backend-acceptance-02.md)，字段依据见 [source-protocol-evidence.md](../docs/backend/evidence/source-protocol-evidence.md)。

## 运行

完整干净检出、nvm/pnpm frozen 构建、双进程启停/升级及 Nginx 排障见[当前 #31 运行说明](../docs/deployment/static-delivery.md#当前范围后端集成-31)。在仓库根目录准备依赖，再在专用终端前台运行 API：

```sh
uv sync --locked
# 纯生产可改用 uv sync --locked --no-dev；测试需要 dev 依赖
unset WEB_CONCURRENCY
export BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite
printf 'API PID=%s\n' "$$"
exec .venv/bin/python -m uvicorn backend.bili_monitor.app:app --host 127.0.0.1 --port 8000 --no-access-log
```

Python 使用 `.python-version` 的 3.12 系列（记录实际补丁版本）；FastAPI、HTTPX、Uvicorn、OSS SDK 和测试依赖由清单/`uv.lock` 固定。上述路径是示例，须选择**仓库外持久、可写的绝对 SQLite 路径**，与 collector 完全相同，不随发布目录切换；默认 `backend/data/monitor.sqlite` 仅适合本地开发。依赖经 uv 同步后直接 `exec` 其解释器，打印的 shell PID 随即成为 Python PID，不会只杀掉 uv 父进程而留下子进程。仅一个 API，不加 `--workers` / `--reload`；没有内嵌定时器或常驻 Node.js，collector 另起终端。

API 的 ASGI lifespan、取得锁的 collector 与独立通知进程启动都调用 `Store.migrate`（当前 v16）。升级先 TERM/Ctrl-C 停两个进程、等退出，再切换同一代码版本并 `uv sync --locked`；先启动 API 完成迁移并确认 `GET /api/manage/ups` 为 200，再启动 collector。未来 schema 拒绝启动，失败事务回滚；无独立迁移 CLI、自动降级或备份，勿删库、改版本号或让旧进程与新迁移并行。

**首期无鉴权**：管理、初始化及归档接口均可被访问者调用，可能暴露内容或被修改配置。请通过监听地址、防火墙或反向代理限制暴露；隐藏入口不是保护。本期没有备份或容量治理。

## API 与采集统一启动

推荐在准备好 uv 环境后，使用统一入口，避免只启动 API 导致添加监控后始终没有动态：

```sh
export BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite
exec .venv/bin/python -m backend.bili_monitor.service --host 127.0.0.1 --port 8000
```

该入口托管一个 API 子进程和一个独立 collector 子进程，不在 API 内运行定时器。等待 API 完成迁移和监听后才启动 collector；两者继承同一绝对数据库路径、可选 `BILI_COOKIE_FILE` 与 OSS 环境。任一子进程退出时会停止另一进程并报固定错误，便于外部服务托管发现故障；Ctrl-C/TERM 先等待 collector 退出，再停止 API。不要与下节的手动双进程入口同时使用，也不要在已有 collector 运行时重复启动。

当前本机 `live-34/run-api.sh` 已改用该入口，仍保留原端口、数据库和 Cookie 文件路径；需要维护者重启原服务才会生效。它仍清除 OSS 配置，因此有图目标的媒体会保持待归档，不能把文本完成视为全项完成。本次未启动、重启服务，也未做测试或运行验证。

## 飞书通知进程（01、04、05、06、08、09、13）

动态可信新版本正文成功归档后登记通知事件，由独立进程按索引领取并投递到 UP 群；首次正文只建立基线，通知失败不回写归档成功状态。一级评论在根评论写事务里、楼中楼回复在回复写事务里与内容同事务登记：作者等于该动态所属 UP 时同时发 UP 群和全员群，其他人只发全员群，身份/时间不全时留候选等补齐，评论起点之前的评论静默；单条就绪即投递，不等整轮分页或媒体。回复消息链接直达该条回复（`/dynamics/{id}/comments/{rootId}/replies/{replyId}/locate`），根不可定位或身份不全时不伪造字段（详情见契约）。阶段有效性按领取时绑定的阶段核验，停用后重新启用的旧在途执行不能借新阶段发通知。

逐目标投递相互隔离：某个群缺路由、目的地写错、超时、限流或业务失败只让该目标保留待发并退避重试，其他群照常发送；修复配置的方式是**编辑配置文件后重启通知进程**，记录、阶段与基线保留，已成功目标不重发、不补历史。发送前还会按目的地做**主动限速**（票据 13：每个群 5 次/秒、100 次/分钟，对应飞书自定义机器人官方额度；系统群角色独立额度且领取优先）：超预算不等待也不计失败，只把 `due_at` 顺延约 1 秒，记录留在 `pending` 由下一轮重领。真实失败次数记在 `notification_deliveries.failures`/`last_failed_at`（`attempts` 含等待配置复检，不能当失败次数用）。同一进程每轮轮询还负责北京时间每小时第 40 分钟的系统群心跳（仅在 `:40:00`–`:40:59` 窗口内生成，同小时只生成一次、过期不投递、停机错过与 `:41` 之后首次启动都不补发，已生成待发的仍可在有效期前重试），状态文本只报告本地已记录的采集事实。系统群同时接收**运行告警**：可信凭据失效（只认上游业务码 `-101` 且本次确实配置了来源凭据）、采集异常、主循环捕获异常、飞书持续投递失败（同一业务目标真实失败 ≥3 次且仍在待投递）与路由缺失/错误；同一对象同一类别首次立即提醒，此后每 30 分钟最多一次（节流状态存在 `notification_alerts`，跨重启保留，未投递的同类提醒合并），系统群自身失败不递归告警，也不发故障恢复消息。启动与配置见[通知进程与投递契约](../docs/backend/api/notification-process.md)：

```sh
export BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite
export BILI_NOTIFICATION_CONFIG=/srv/bili-monitor/notifications.json
# 可选：调大租约（秒），仅在外部网络比默认 30 秒还慢时需要；必须大于请求超时 10 秒。
# export BILI_NOTIFIER_LEASE_SECONDS=60
# 可选：主动限速额度，默认 5 次/秒、100 次/分钟；只能调小（写大不会放宽），用于隔离测试或保守运维。
# export BILI_NOTIFIER_SENDS_PER_SECOND=2
# export BILI_NOTIFIER_SENDS_PER_MINUTE=30
exec .venv/bin/python -m backend.bili_monitor.notifier
```

通知进程与 API/collector 使用同一 SQLite，但有独立 `.notifier.lock`，同一库只能运行一个投递实例。主动限速的窗口状态在进程内存里，重启会重新计数；它降低但不消除 429，被动退避（`x-ogw-ratelimit-reset`）保留。统一托管入口 `python -m backend.bili_monitor.service` 已支持三进程：设置 `BILI_NOTIFICATION_CONFIG` 时先等 API 完成迁移并监听，再启动 collector 与通知进程；未设置时保持两进程形态（不投递）。启动顺序、启停、迁移与路由修复见[静态交付运行说明](../docs/deployment/static-delivery.md#单-api单-collector单通知进程启动停止升级)与[三进程集成证据](../.scratch/feishu-notifications/evidence/10-integrated-delivery-readiness.md)；真实飞书群与目标环境仍未验证。配置与凭据只在服务端文件，不进入浏览器、日志或发件箱；可选签名密钥也只用于发送时组装 `timestamp`/`sign`。最小隔离演示（不访问网络、不读取真实凭据）：

```sh
demo_dir=$(mktemp -d)
uv run python -m backend.tests.notification_demo --database "$demo_dir/monitor.sqlite"
```

## 23 独立采集进程

也可按原方式让 API 和采集进程使用同一 SQLite 路径、分别启动，不能增加多个采集进程。处理持久启用的指定集合或近期可信窗口的检查/同步，以及近期 UP 发现，默认最多 4 个同时检查、4 个独立目标同步、2 个独立 UP 发现；同目标不叠加，慢分页期间其他目标仍可检查／同步。固定节拍检查（生产默认 2.7 秒 ±10%，可用 `BILI_COLLECTOR_CADENCE_SECONDS` 覆盖）与慢同步分离：评论计数每节拍读取，页面信号（编辑时间/正文与图片版本/受限状态）默认每 60 秒 ±2 秒采样一次（`BILI_COLLECTOR_PAGE_CHECK_SECONDS` 可覆盖，0 表示每节拍），状态从 `GET /api/manage/ups/{uid}/checks` 读取；完整节拍、重启与状态语义见 [采集契约](../docs/backend/api/collector-api.md)。API 不内嵌定时器。

```sh
# 独立终端、仓库根目录；使用与 API 相同的持久路径和服务端 OSS 环境
export BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite
printf 'collector PID=%s\n' "$$"
exec .venv/bin/python -m backend.bili_monitor.collector
```

Ctrl-C 或从第三终端向已记录的**实际 Python PID** 发 TERM，先停 collector 再停 API，并等两者退出再重启；非父终端不能用 `wait PID`，完整退出检测命令见上述 #31 说明。collector 取得数据库旁排他锁后恢复持久未完成工作，API 不恢复 running；正常重启复用原路径，运行时不能删除锁文件。一次检查/发现仅用于登记，既不执行同步，也不恢复中断执行，不是迁移命令：

```sh
uv run --no-sync python -m backend.bili_monitor.collector --database /srv/bili-monitor/monitor.sqlite --once
```

先通过管理 HTTP 配置启用的指定目标（mode 值为 `specified`）或近期 UP（默认 recent、N=10）。近期发现独立调度，`GET /api/manage/ups/{uid}/discovery` 只读查看本轮进度/错误、最近可信结果与 `current_ids` 当前启用窗口；N 改动后新发现成功前保留旧窗口，停用/指定模式/删配置时近期目标不再入选。不会把候选当成成功归档或混入指定 targets。完整契约见 [近期发现](../docs/backend/api/discovery-api.md)。配置、观察和待处理都持久化，退出时正在执行的工作保留，正常运行重启后恢复为待处理。锁文件位于数据库旁，运行时不要删除或使用硬链接别名。

最小隔离演示（**仅测试装配，不访问真实上游、不读取 OSS 环境、不使用默认生产数据库**）：

```sh
demo_dir=$(mktemp -d)
uv run python -m backend.tests.collector_demo --database "$demo_dir/monitor.sqlite"
# 同一路径再次运行，验证重启保留观察和成功时间
uv run python -m backend.tests.collector_demo --database "$demo_dir/monitor.sqlite"
```

独立 Python 进程输出 0/15/30/45 四个受控节拍的公开 HTTP 状态；首次检查 pending，随后实际无图/零评论归档完成，后续无变化检查只更新检查时间。时间替身只替换外部时钟，真实 SQLite、HTML/JSON 解析、归档及 HTTP 均执行。受控 45 秒不是实际等待 45 秒，也不证明长期运行稳定性。

## collector 日志

当前本机统一服务同时托管 API 与 collector，查看最近日志或持续跟随：

```sh
journalctl --user -u bili-charge-live-34.service -n 100 --no-pager
journalctl --user -u bili-charge-live-34.service -f
```

每个节拍的 `collector_tick` 会显示入选目标、待处理数、在途数和本轮新调度数；真正领取后输出 `sync_started`，完成时输出 `sync_finished`。同一同步尝试通过进程内 `attempt` 关联根评论、回复、正文和媒体阶段；失败包含固定分类、页号及 HTTP 状态（如有），不含 URL、业务 ID、来源原文或凭据。详细字段及如何区分空闲、在途、失败重试和进程退出见[采集日志契约](../docs/backend/api/collector-api.md#调度与失败日志)。正常失败仍按原固定节拍重试，日志本身不触发额外采集。本次日志增补按用户要求未经测试或运行验证。

## 24 编辑同步与版本提交

沿用普通 HTML 的安全 JSON/AUTHOR 解析和同一归档执行链，不新增来源采集器。检查的 `observed`/`revision`、实际正文 HTML 版本及各分项 checkpoint 分开保存：

- 正文 checkpoint 绑定执行时实际读取的可信 HTML 编辑版本，不把领取时的版本套给重新获取的正文。两者不匹配时本轮目标仍 pending，后续固定检查确认版本后可继续。旧执行期间的新检查保持最新观察；管理 `parts.text/media` 针对最新检查版本，不能用旧归档成功冒充新工作完成。归档自身的 observed 仍表示执行阶段实际处理的观察。
- 编辑仅更新正文/动态图来源；collector 不重扫已完成整轮（根评论和回复均 success）的评论。根或回复任一未完成时，沿用既有完整根＋回复失败重试链；即使根已完成但回复失败，也会重新读取根页。不是纯正文编辑新增重扫策略。显式 initial 保留既有完整初始化/重试能力，计数变化的周期登记见下节 #25。
- 编辑未知/error 保留旧可信值；已有正文在新版本失败后的无可信版本重试不得替换旧成功正文、媒体来源或 checkpoint。首次无编辑标记仍可初始化，分钟精度不补秒，发布时间不由编辑时间补齐。
- 每次目标领取新增持久、内部、不经 HTTP 返回的 `claim_token`；完成需同时匹配该领取令牌。观察 revision 不替代领取 fencing；同版本重开重新领取、旧迟到完成/失败和重复完成均不能清新任务。归档内容继续由 generation fencing，媒体继续由已有逐图令牌 fencing。API 启动不恢复 running，只有取得采集进程锁后才恢复。
- 正文成功不表示评论/媒体成功；未配置 OSS 的有图目标仍 pending。无新编辑信号时仍可恢复失败分项；重复 execute 对 complete 目标不再次请求来源。

专项测试：`uv run pytest backend/tests/test_versioned_edit_sync.py -q`。原始虚构 HTML 在 `tests/fixtures/versioned_edit/`，覆盖同 pub_ts 不同编辑时间、脚本/模块换序、分钟/空白、相对文案、无效日期/无日期、恶意非 JSON、发布时间缺失、正文/图片改变但信号相同。通过公开 collector、真实 SQLite 关闭重开和 HTTP 验证新旧交错、同/不同观察代次的恢复 fencing、观察后/页面读取中/详情等待/正文提交后中断以及分项失败恢复；不 mock 内部模块。

逐片 red→green 已复现并修复四项：编辑重扫评论令 complete 变 pending；旧版本完成后管理分项仍是假 success；旧领取迟到把新 running 清成 pending；新正文失败后未知版本重试将旧正文替换。其他新增安全解析/恢复场景首跑已通过，属于既有行为回归，不计为修复 red。补充通过 sqlite3 外部连接工厂在真实归档观察事务 commit 前失败／commit 后 ACK 丢失，以及外部 Clock 在全部分项提交后、目标 finish 前中断；重开恢复不需要新信号、不重复已完成评论请求。该 commit 故障不是正文 checkpoint 事务故障，ACK 丢失／控制流中断不冒称硬断电；真实自然多次编辑、同分钟漏检、实际编辑→OSS 联动及持续运行仍未验证。

## 25 独立计数与根回复同步

每次检查保留 `/x/v2/reply/count` 独立读取，使用已校验归属的评论 oid/type；首次缺少 locator 时从 detail 获取，之后复用可信持久定位。严格解析 `data.count`，网页／根页／本地计数不冒充独立结果。计数缺失、无效、业务拒绝或网络失败保留旧值和失败状态，不归零。协议来源、尚未实测证明的根＋回复精确包含口径见 [来源证据](../docs/backend/evidence/source-protocol-evidence.md#25-独立评论计数)。

初始化、失败重试或可信总数变化才沿用原完整根＋必要回复分页；已有 ID 仍更新，不截断旧 ID，不自动回填全部动态。计数不变、纯正文／评论编辑和增删抵消不重扫；这些是已知漏检，不增每日校准或内容比对。网页失败／正文受限不阻断实际可读评论，实际接口拒绝如实 failed。评论工作绑定领取计数，旧完成保留其实际 checkpoint，不能清除同步期间登记的新计数工作；关闭重开无新信号可重试。

checks HTTP 增量返回 `observed.comment_count_status`、`synced_comment_count`、`local_comment_count/local_reply_count`、`comments_last_attempt`；无归档的本地数为 null，不伪造零。`parts` 针对最新检查观察投影，旧评论成功不冒充新计数完成。计数与正文版本分开，成功正文不为纯评论工作重读；检查 `failed` 是任一信号失败的聚合，编辑和计数状态仍可分别判断，计数失败不阻止可信正文编辑。显式 initial 不是计数检查：无独立检查记录时保持 #02 协议，有记录时绑定最近可信独立计数，不允许 STAT/detail 覆盖；媒体仍独立，评论 checkpoint 成功不等于目标 complete。复用 #21 媒体待处理／上传，不另建 OSS。没有新增 schema，旧 v11 配置、归档、cursor 和工作原样保留。

专项：`uv run pytest backend/tests/test_comment_count_sync.py -q`。真实 SQLite／HTTP、原始虚构 JSON、受控时钟验证独立计数、完整 45 根／25 回复分页、未知／零、增减／不变、故障重试、新旧计数交错，以及慢分页期间其他目标新工作仍推进。精确根＋回复口径、真实匿名权限、持续节拍、OSS 和正式设备仍未验证；不把 fixture 或历史样本当作真实全量证明。实现与测试结果见 [25 记录](../.scratch/backend-integration/acceptance-25.md)。

## 26 评论状态与成功时间

归档详情返回同一 SQLite 只读快照中的 `comment_sync` 最新 checks 投影，供管理/阅读页区分来源总数、本地根/回复数与实际同步进度；页面只读重读不会检查/同步上游。根、回复、整轮评论文本分别持久 `*_last_succeeded_at` 与固定脱敏错误，检查无变化不更新时间，失败保留旧成功时间，旧缺字段为 null，不造历史。原文档存储支持增量字段，无 schema 迁移或旧 cursor 失效。

专项：`uv run pytest backend/tests/test_comment_sync_status.py -q`。真实 SQLite、原始虚构协议、受控 Clock、Collector 与 HTTP 覆盖部分失败、无新信号重试、未知/零、受限正文、在途观察、成功时间及冻结旧页。状态/客户端契约见 [采集契约](../docs/backend/api/collector-api.md#26-评论分项状态与时间)，自动化和实际 API 页面穿透证据见 [26 记录](../.scratch/backend-integration/acceptance-26.md)。不宣称普遍来源计数口径、实时/完整来源、真实权限、OSS 或正式设备已验证；全媒体与聚合由 #30 收口。

## 30 分页请求间隔

API 的显式同步和正式采集进程使用共享 `PacedSourceTransport`：每次动态 feed 请求前异步等待随机 **0.8–1.5 秒**，每次根评论／楼中楼页请求前等待 **0.3–0.4 秒**，包括首页、翻页和空尾页复查。范围参考 ignored 示例脚本，但运行不导入该脚本，也不接入飞书。

同一来源客户端的分页共享等待锁，避免多 UP／目标同时突发；仅串行化发送前的等待，不锁网络响应或 SQLite。独立 HTML／detail／评论计数等信号请求不排这个队，固定节拍调度、busy-skip 与有限并发规则不变；它不是自动退避、重试策略或不再限流的保证。API 和采集进程各有独立节奏，不提供跨进程／跨主机限速保证，手工写接口与采集进程并行使用仍可能触发上游限制。

测试注入的 transport 由调用方管理时间；可用 `PacedSourceTransport(httpx.MockTransport(...), sleep=...)` 保留节奏逻辑并替换外部时间，不让现有 fixture 等待真实秒数。专项验证包括正式 API／采集入口装配、完整分页与空尾页复查、并发信号读取及取消：`uv run pytest backend/tests/test_source_pacing.py -q`。这只是无凭据自动化，不证明真实上游长期可用。

## 应用工厂与传输边界

```python
from backend.bili_monitor.app import create_app

app = create_app(database_path, profile_transport=None, media_transport=None, media_uploader=None,
                 comment_client_factory=None)
```

工厂不打开数据库，ASGI lifespan 启动时迁移。默认生产的评论计数、根评论和楼中楼通过 `comment_client_factory` 创建每次尝试独立的 Requests 会话；正文/detail/feed 仍使用 HTTPX。显式注入 `profile_transport` 且未指定评论工厂时，全部来源请求继续经过该 transport，保留既有 `httpx.MockTransport` seam，不会静默绕过替身出真网。也可显式注入提供异步上下文管理器的评论工厂；两种 I/O 共用同一套协议解析、同步和存储。`media_transport` 只替换独立图片下载 HTTP，`media_uploader` 是异步 `upload(key, content, content_type) -> 完整公开URL` 的外部 OSS 边界，测试替身不替换媒体协调或数据库。未注入 uploader 时从服务端环境装配真实 OSS，全部配置缺失则保持待上传。使用包含 lifespan 的服务器或 `with TestClient(app)`。

生产请求 card、通用动态 detail、普通 opus HTML、独立评论计数及根／回复页码接口。HTTPX 信号/正文请求默认超时 10 秒、不跟随重定向、不使用环境代理；评论 Requests 会话采用下节的参考脚本式初始化、15 秒超时及环境代理策略。默认匿名；可选登录 Cookie 仅从服务端私有文件加载，没有前端/API 凭据输入。不绕过受限正文，不依赖 `opus/detail` JSON，不导入或执行 ignored 原脚本。

## 来源 client 初始化

API 与 collector 的来源 `AsyncClient` 共用 `source_client.py` 中的普通请求配置：

- 按用户要求采用参考脚本中相同的固定普通 `User-Agent`，不复制脚本的 Cookie 或其他凭据；这不是接口可用或访问权限的保证。
- `Accept-Language: zh-CN,zh;q=0.9,en;q=0.8`；API 的 `Accept: application/json, text/plain, */*`，`Origin: https://space.bilibili.com`。普通页面仍使用 HTML 内容协商。
- 根评论、楼中楼及独立计数请求逐次设置 `Referer: https://space.bilibili.com/{uid}/dynamic`，UID 由本轮归档/检查的 UP 传递，不把脚本的单一 UP 固定到共享客户端。
- 正式评论链路使用 `RequestsCommentClientFactory`：会话按 UP 复用（Cookie 变化或超过 30 分钟会话 TTL 才重建），预热（B站首页 + 该 UP 空间页）按 `(UP, Cookie 指纹)` 缓存 5 分钟、过期后后台刷新、失败冷却 60 秒，命中缓存时本轮零预热请求。同步网络 I/O 在线程池执行，同一 Session 串行使用，不阻塞固定调度时钟。endpoint、主要参数和 15 秒超时对照参考脚本，解析逻辑不分叉。
- 每个 Session 按 `create_session` 顺序预热 `https://www.bilibili.com/`、`https://space.bilibili.com/{uid}/dynamic`，各自 timeout 10 秒、成功取得响应后异步等 1–3 秒；每个 URL 独立 best-effort，异常不阻止下一个 URL。预热只记录 HTTP 成功，不宣称已登录；不再用 nav 预热。工厂创建时不发请求，空闲 API 启动不访问来源。
- 私有 Cookie 文件每个进程启动读一次；名称和值分别 strip、不 URL 编解码。每轮从该不可变输入重建 Session CookieJar，域 `.bilibili.com`、path `/`；仅本轮保留正常来源 `Set-Cookie` 更新/删除。API、collector、不同尝试和媒体/OSS 不共享可变 jar。
- Requests 使用环境代理、TLS 验证和默认 GET 重定向行为；实际发送（包括跳转）只允许 HTTPS 默认端口的 `api.bilibili.com`、`www.bilibili.com`、`space.bilibili.com`，其他域/明文/非 GET 在发送前拒绝。此范围约束有意严于参考脚本，Cookie 不会随任意跳转泄露。HTTPX 正文/detail/feed 和独立媒体仍保持各自原有代理策略。
- 同一进程的 Requests 与 HTTPX 共用 `SourcePacer` 等待锁：feed 0.8–1.5 秒、根/回复0.3–0.4秒；网络不持锁，独立计数不加入分页队列。不新增来源请求即时重试。
- locator 按参考脚本优先取合法 basic，再尝试同一已校验目标的 OPUS ID/type11、动态 ID/type11；记录 `source/policy_version`。旧策略下一次检查重新取已校验作者的 detail 核对一次；资源 oid/type 变化会登记新工作，即使计数不变也重扫根/回复。fallback 条目必须携带一致 oid/type，空页不算确认 fallback 成功；正来源计数却整轮无根也不推进成功。

静态对照 ignored `script_demo/bili_charge_monitor.py`，不导入/执行脚本、不读取或复制其凭据。根评论和楼中楼按脚本不额外加 WBI；feed 的 WBI 不属于此次修改。Requests 显式固定为已有锁内的 `2.34.2`，不改变依赖包版本。根元信息版本升到 v2，旧启用归档补采一次，停用目标不采，不重写旧 cursor。修改不证明此前全零分页或 HTTP 412 已解决，不绕过来源权限。本次仅修改并重启后端，不运行测试、审查或额外诊断请求；正常采集会执行上述预热。实现记录见[Requests 评论链路变更](../.scratch/backend-integration/evidence/comment-requests-implementation.md)。

## 可选 B站登录 Cookie（仅服务端）

新增环境变量 `BILI_COOKIE_FILE` 只保存**仓库外绝对文件路径**，不要把 Cookie 内容放入环境变量、命令参数、前端构建、HTTP 请求体或聊天。未设置保持匿名；设置但为空、文件不可读或无效时启动失败，不静默退回匿名，也不回显原路径/内容。该配置不会自动加载 `.env` 或读取浏览器存储。

文件必须为运行进程用户所有的普通文件、权限 `0600`、无符号/硬链接；直属目录为该用户所有的普通目录、权限 `0700`。路径解析后不能位于仓库内。内容为一行 Cookie 请求头的**值**，不含 `Cookie:` 前缀，最多 16 KiB ASCII；可有一个末尾换行，其余 CR/LF/控制字符或无效 Cookie 名拒绝启动。

可由维护者在**交互式服务器终端**、以运行 API 的同一用户执行以下写入入口（本轮没有执行）：

```bash
uv run --offline --no-sync python -m backend.bili_monitor.source_cookies \
  --write "$HOME/.local/state/bili-charge-dynamics/credentials/bilibili-cookie.txt"
```

入口创建私有目录并隐藏输入，原子保存且拒绝覆盖已有文件，不启动服务、不发网络请求。仅在自己的已登录浏览器中本地查看 Cookie；不要导出 HAR、Copy as cURL 或把值发到聊天。轮换时先写到一个新的私有文件名，再更新配置路径并重启；工具不会覆盖用户原文件。

在实际启动 API 的环境中增加路径后，由维护者自行重启加载：

```bash
export BILI_COOKIE_FILE="$HOME/.local/state/bili-charge-dynamics/credentials/bilibili-cookie.txt"
```

**现有 systemd 服务不会继承另一个终端刚 export 的变量。** 本机会话的启动脚本是仓库外 `/home/kevin/.local/state/bili-charge-dynamics/live-34/run-api.sh`，现已改用上节的 API＋独立 collector 统一入口；它的 `exec` 前配置 `BILI_COOKIE_FILE` 后，两子进程会继承同一路径，仍须维护者自行重启 `bili-charge-live-34.service` 才会加载。此前实例证据见 [#34 Cookie 接入记录](../.scratch/backend-integration/evidence/live-34/cookie-file-implementation.md)，不代表本次修改已经运行。若改用手动双进程方式，须分别配置同一路径；本次未启动或重启服务。

API 和 collector 分别在启动时读取私有文件一次，修改文件不会热加载；不自动登录、调用续期接口或轮换账号。HTTPX 信号客户端使用独立 jar，请求前先移除已有 Cookie，只有 GET＋HTTPS＋默认443＋精确 `api.bilibili.com`/`www.bilibili.com`＋无 URL 用户信息时才重新附加，并仅接受相同范围的响应更新。Requests 评论客户端每次尝试从启动时的 Cookie 输入重建 Session，本轮允许 `api.bilibili.com`、`www.bilibili.com`、`space.bilibili.com` 的 HTTPS GET 和响应 Cookie，跳出此范围的请求（包括重定向）在发送前拒绝；完成后关闭。每轮重建是对照参考脚本的生命周期，不是刷新或续期账号。未配置文件时两种路径仍遵守发送范围约束。媒体下载使用独立客户端，OSS 不接入来源凭据；其他代理、头和预热规则见上一节。

凭据不写数据库、API 响应或日志。过期/无权/风控拒绝仍如实失败，不轮换账号或绕过限制。停用需移除 `BILI_COOKIE_FILE` 并由维护者重启持有该会话的进程；应按平台方式撤销不再使用的会话。

**启用后仍无管理/API 鉴权**：能访问服务的人可能使用该账号的来源读取权限并读取归档，应继续仅监听本机或使用受限网络。Cookie 不向前端公开并不等于归档内容受访问控制；未配置 OSS 的媒体仍待归档。

测试、E2E、演示或 fixture 装配不得读取真实 Cookie。`backend/tests/conftest.py` 会在 pytest 用例开始时清除 `BILI_COOKIE_FILE`；Cookie 专项测试须显式使用虚构临时文件。非 pytest 的测试服务/演示入口需由执行者先清除该变量，不把真实凭据注入 MockTransport。此前仓库外临时取样工具也不会继承此配置，不能把它的匿名结果当作已登录验证。

**本增补未经验证**：按用户要求不运行本地测试、回归、双轴审查或真实请求；此前 748 项结果不覆盖本次 Cookie 变更。配置和真实验证由维护者自行执行，不承诺能解决 HTTP 412。

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

仅在**仓库外的受限服务环境**提供下列配置，勿将真实值写入仓库、前端、命令记录或本 README；应用不读取 ignored 参考脚本／配置，也不自动加载 OSS 凭据文件；可选 B站 Cookie 仅通过显式 `BILI_COOKIE_FILE` 读取，与 OSS 无关：

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

完整 owner、来源缺失／空组、版本提交、迁移和冻结 cursor 契约见 [21 归档契约](../docs/backend/api/archive-api.md#21-一级评论媒体归档与独立恢复)，自动化证据见 [21 验收](../.scratch/backend-integration/acceptance-21.md)。图片 UI／预览归 #22，周期计数触发已由 #25 接入，最终媒体联动归 #30；没有对象回收、图片变体或 CDN。本入口继承无鉴权和公开 OSS URL 风险。

## SQLite 与安全

schema 顺序：v1 身份/配置、v2 targets、v3 archives/generation、v4 持久分页、v5 cursor 资源/过期/索引、v6 根评论及独立持久评论页、v7 回复／逐根同步状态／回复持久页、v8 媒体尝试令牌及归档文档媒体字段、v9 评论 owner 尝试标识与旧根来源 pending 回填、v10 持久目标检查/观察/工作/时间/独立错误、v11 目标领取 fencing 令牌、v12 按 UP 发现尝试/可信结果/领取令牌、v13 当前入选目标令牌、v14 回复同步时间与观察计数、v15 页面信号采样时间、v16 通知阶段/基线/写领取/事件/目标投递。v0–v15 短事务迁移到 v16，冲突回滚、未来版本拒绝启动；旧 v4 无限期 cursor 被失效，但归档不删。每次操作独立连接并启用外键，等待锁最多 2 秒；数据库操作在线程池执行，网络不进事务。删除配置只 cascade 指定关联，绝不 cascade 身份或归档。

错误响应使用固定错误码与提示，不记录请求体、完整上游响应或异常秘密；错误消息只允许管理接口诊断约定所引用的固定安全目录。HTTPX/HTTPCore、OSS SDK、Requests/urllib3 传输日志及 Uvicorn access 日志禁用。Nginx 模板显式 `access_log off; error_log /dev/null;`：默认 error 日志在 API 不可达时也会泄露 query，所以不用原始请求日志诊断，改查 `nginx -t`、HTTP 状态、进程退出及固定脱敏 API 错误；外层代理也不得重新记录原始 URI/请求体。本票测试不读取真实 Cookie、不执行/导入参考脚本、不请求真实上游。

公开资料失败另写应用自身的固定 WARNING 事件 `profile_lookup_failed reason=... http_status=...`，不启用传输日志。分类、状态限界与回退、资料字段边界统一见[管理接口诊断约定](../docs/backend/api/management-api.md#服务端资料失败诊断)。HTTP 非成功/业务拒绝会解析有限大小的错误响应，追加 `message_state` 和 `upstream_message`；只有完全匹配固定安全目录的 `message/msg` 才输出，未知原文、HTML、过长消息等只记分类及 null。没有 UID、URL、完整响应原文、业务原码或 traceback，HTTP `502 PROFILE_UNAVAILABLE` 及前端文案不变。这只改进定位能力，不证明来源可用，不触发或授权自动重试。

## 测试与 E2E 装配

#31 双进程专项：`uv sync --locked` 后执行 `uv run --no-sync pytest backend/tests/test_deployment_processes.py -q`。API fixture 为 `backend.tests.deployment_fixture:create_app --factory`，要求显式 `BILI_DATABASE_PATH`；独立采集入口 `uv run --no-sync python -m backend.tests.deployment_fixture --database PATH` 使用同一路径。它们仅替换外部 I/O，运行真实 API/collector/SQLite，不访问真实上游或 OSS；模拟上传返回 `https://media.example.invalid/deployment.png`。Nginx/生产构建/浏览器一并验证用 `pnpm test:delivery`（需 dev 依赖、Nginx/mime.types、Chromium，4173 空闲，API 使用临时空闲端口），浏览器仅 route 外部图片。命令与范围见[交付说明](../docs/deployment/static-delivery.md#隔离验证入口与证据边界)，结果见 [#31 验收记录](../.scratch/backend-integration/acceptance-31.md)；不据此宣称真实 OSS、云部署、真机或持续运行已验证。

```sh
uv run pytest backend/tests/test_discovery_source.py backend/tests/test_recent_discovery.py -q
uv run pytest backend/tests/test_comment_count_sync.py -q
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

要求显式环境数据库路径，不预填身份。固定虚构 UID 为 `900719925474099312345`（虚构星海）、`202`（虚构晨光）；头像 `example.invalid`。每次新验收使用新临时路径；同一路径验证重启持久化。归档页面穿透装配（生产 Store/Collector + 虚构上游 HTML/JSON）在迁移前的 React e2e 中维护于 `tests/e2e-archive/`，该目录已随票据 12 删除；需要归档真实 API 回归时按 `backend.tests.live_app` 的模式另建，不复用已删路径。

## 限制

有限结构证据和虚构 fixture 不证明上游长期可用或完整全文覆盖。分钟编辑精度漏检已接受；本阶段已交付独立固定节拍进程，已用虚构 fixture 验证近期发现与窗口生命周期，但无真实云上传、长期实际稳定性或 2GB 容量结论。分页冻结全量响应会有临时内存/SQLite 写入成本，15 分钟窗口内频繁新访问会放大磁盘与写竞争；过期删除不保证文件缩小，不宣称容量治理。服务器墙钟回拨可能延长过期判断，生产时钟需正常同步。
