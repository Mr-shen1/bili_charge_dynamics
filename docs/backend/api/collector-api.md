# 固定节拍采集与检查状态（票据 23 / 24 / 25 / 26 / 27 / 28 / 29 / 30）

## 运行边界

27 在同一节拍增加启用 recent UP 的独立发现阶段，默认最多 2 个同时发现；28 将整轮可信结果接为持久窗口，与指定集合互斥地复用以下检查/同步链。可信发现与本轮错误持久分开；失败保留旧窗口，配置冲突和只读管理 HTTP 见 [近期发现与窗口契约](discovery-api.md)。

单独 Python 进程从同一 SQLite 中按 `enabled=true` 的互斥模式选取目标：`specified` 只取关联 ID，`recent` 只取最后成功发布的可信窗口。API 不启动调度器；浏览器阅读、管理读取不触发同步。启动时为第一个节拍，此后按单调时钟固定每 15 秒触发；不是任务完成后再等 15 秒。同目标检查忙时跳过，不叠加、补发或排队。默认最多 4 个同时检查，容量不足的目标跳过当前槽，轮转选择防止长期偏向头部；不承诺每目标在所有负载下都能完成每个节拍。进程停顿错过的槽不追赶。

检查读取普通 opus HTML，复用安全初始化 JSON/AUTHOR 解析登记编辑信号；独立读取 `/x/v2/reply/count` 的 `data.count` 作为评论区来源总数信号。不用网页 STAT、通用 detail、根页 `page.count/acount` 或本地条数代替独立计数。locator 使用带 `policy_version/source` 的策略：旧版本在后续检查重新从已校验动态 ID/作者的 detail 核对；按参考函数优先 basic，再尝试同目标 OPUS/动态ID回退，候选必须通过合法ID和资源一致性校验，空页不确认 fallback。无编辑标记、网页失败／无权或正文受限不阻止独立计数和可读评论初始化；计数缺失、无效、业务／网络失败保留旧可信值与失败状态。两项信号独立合并，不因其中一项失败丢失另一项新观察。计数结构及证据限制见[来源协议](../evidence/source-protocol-evidence.md#25-独立评论计数)。

同进程有独立且有限的执行阶段（默认最多 4 个同时同步）；每个固定节拍轮转选择持久 pending，逐目标重新核验配置并领取。同目标不叠加，慢目标分页不阻止其他目标检查或领取后续工作；不承诺任意负载下全部目标每节拍完成。公开 `execute_pending` 单次遍历也采用有限工作池。复用 #02/#15/#17/#21 同一正文、根回复与媒体归档链，网络不占长事务。失败留待下一节拍，不即时无限重试。

初始化、失败重试或可信总数变化才执行根＋必要回复完整分页；计数不变、纯正文编辑、评论纯编辑或增删抵消不默认重扫。任一根／回复分项未完成仍走原完整根＋回复重试，不做见旧 ID 截断。评论工作绑定领取计数；正文／detail metadata 不覆盖领取的独立计数。已完成且版本匹配的正文在纯评论工作中不重读；评论成功不等待媒体上传。目标 complete 仍要求实际正文版本与评论 checkpoint 匹配领取观察、全部归档 work 与评论媒体成功；未配置 OSS 或保留根媒体待处理时，评论可成功而目标仍 pending。

目标 revision 在首次登记、可信编辑版本改变、可信评论总数改变或评论资源 oid/type 改变时增加；正文版本和评论计数不拼成同一内容版本。同步期间新观察仍持久登记，旧执行只提交自身处理的版本，不能清除较新 revision；重开恢复与令牌 fencing 沿用 #24。显式 `/api/sync/initial` 不是计数检查入口：尚无独立计数检查记录的目标保持原 #02 初始化协议；已有 `comment_count_status` 的目标绑定最近可信检查计数（未知仍未知），不能再用 STAT/detail 覆盖它。没有每日校准、退避、自适应频率、内容比对或无限并发；27 的近期发现另见独立契约。计数抵消、纯评论编辑和不改变计数的来源分页移动可漏检。

## 分页请求节奏（30）

正式 API／采集进程的 HTTPX feed 与 Requests 评论会话共享同一 `SourcePacer`：feed 每次发送前随机异步等待0.8–1.5秒，根/楼中楼每页0.3–0.4秒，包含首页和空尾页确认；锁只覆盖等待，网络与事务均不占锁。HTML/detail/独立计数不排分页队列。每个正式评论尝试单独创建 Requests Session，线程池执行网络，按参考顺序预热首页和UP空间页（每页返回后异步等1–3秒），结束关闭；不再以nav预热，不导入其主循环或飞书逻辑。Requests采用环境代理和受信B站内的GET重定向；HTTPX信号与媒体路径保持原独立策略。

该节奏不改变固定 15 秒调度或失败重试规则；分页慢不会改成“同步完再等 15 秒”，忙检查仍跳过、不积压。等待和网络均在 SQLite 事务外。两个进程各自限速，不保证跨进程突发或上游不再限流；真实持续运行仍需 #34。测试传输可另行注入外部时间，见 [后端说明](../../../backend/README.md#30-分页请求间隔)。

## 调度与失败日志

collector 使用独立 INFO 级别的 stderr handler，保持 HTTPX/HTTPCore、OSS 和 access 传输日志禁用，不依赖根 logger 的默认级别。统一托管时 API 与 collector 的输出归同一个 systemd unit，可用 `journalctl --user -u bili-charge-live-34.service -f` 跟随。此前只有启动信息或固定失败状态时，日志不变不能证明未重试。

- `collector_initializing`、`collector_configuration`、`collector_started` 表示初始化、评论引擎/代理策略、媒体上传是否启用、固定节拍/并发配置与恢复完成。`comment_session_started/closed` 表示每轮 Requests 生命周期；`comment_session_warmup` 的 homepage/space 只表示对应 HTTP 返回情况，不代表登录成功。
- 每个固定节拍输出一条 `collector_tick`，记录当前入选 `targets`、`recent_ups`、待处理 `pending`、检查/同步/发现的 `*_in_flight` 和本轮 `*_started` 数量。它是调度快照，不保证任务在该行输出时已完成领取；无目标也输出心跳。
- `sync_started`、`sync_finished` 和来源阶段事件共享进程内 `attempt` 流水号。流水号不是目标 ID 或持久领取令牌；重启后重置。`sync_finished complete=false` 不表示成功，后续仍按原 pending/入选规则处理；`sync_skipped reason=not_claimed` 表示未取得有效工作。
- `root_sync_started/root_sync_finished` 和 `replies_sync_started/replies_sync_finished` 记录整轮阶段，不为每个成功页输出 INFO。根/回复失败记录固定事件、`stage`、`page`（回复另含本轮 `root_index`），以区分来源请求、分页校验、存储和尾页复查。
- 失败仅记录固定 `reason` 与经过范围校验的 `http_status`：如 `timeout`、`http_status`、`network_error`、`json_invalid`、`field_missing`、`type_invalid`、`value_invalid`、`source_rejected`、`pagination_changed`、`pagination_not_advancing`、`storage_error`。应用自身的固定校验错误进一步细分为 `comment_page_mismatch`、`pictures_shape_invalid`、`upper_shape_invalid` 等有限原因。根/回复的缺字段只在命中对应阶段的固定字段白名单时记录 `field`，不回显任意键名；JSON 解码异常不输出其文档片段。不读取或输出响应正文、异常原文/traceback、URL、身份/动态/评论 ID、Cookie、SDK 凭据或领取令牌。
- `collector_loop_failed/collector_failed` 明确记录调度或启动失败；取消/退出记录 `collector_stopping/collector_stopped`。未改变既有异常处理及失败重试策略，也未在父进程中新增自动重启。

判断方式：`pending>0` 且 `syncs_started>0` 表示本轮安排了待处理执行，随后应看到 `sync_started`；`syncs_in_flight>0` 表示任务仍在跟踪中，不能因本轮没新启动就断言不工作；`targets=0` 表示当前没有入选目标，不能推断为有工作但未重试。需要以实际日志区分，本次按用户要求不做运行验证。

## 状态 HTTP

`GET /api/manage/ups/{uid}/checks` → `200 {"checks":[Check,...]}`。未知身份 `404 NOT_FOUND`；不接受查询参数，非法或重复参数 `422 INVALID_INPUT`。只读 SQLite，无上游请求。ID 按 BINARY 字符串排序。

| 字段 | 含义 |
| --- | --- |
| `id` / `active` | 动态字符串 ID / 当前是否启用且入选当前模式集合 |
| `check_status` | `unchecked` 未检查；`checked` 首次/新可信版本；`unchanged` 未登记新版本；`failed` 任一来源／信号读取失败的检查聚合，不表示编辑和计数同时失败，结合 `check_error` 与 `observed.edit_status/comment_count_status` 判断分项；网页读取失败时编辑观察保留旧值，不冒充本次网页读取成功。可信另一信号仍可更新和登记工作 |
| `last_checked_at` | 最近一次检查完成时间；未检查为 null，不是配置保存时间 |
| `observed` | 最近可信作者、发布时间、编辑版本、来源评论数与 locator；未知／失败不擦旧值。`comment_count_status=observed\|failed` 表示最近独立计数读取结果，未检查／旧记录可缺失；旧可信数与本次失败可同时存在。不含正文或图片 |
| `revision` | 持久观察代次，未检查为 0；可信编辑或总数变化推进，正文差异／相对时间不推进 |
| `work` | `pending` 待处理；`running` 正在执行；`complete` 已完成对应观察工作。未检查的 pending 仅表示尚无初始化，不可领取直到登记检查 |
| `parts` / `synced_version` | 正文、动态图、根评论、回复、评论媒体状态／实际正文成功版本。针对最新检查观察投影：根／回复分别与自己的计数 checkpoint 比较，根成功不冒充回复成功；评论媒体另按根处理版本与实际媒体状态判断 |
| `synced_comment_count` | 实际整轮根＋必要回复全部成功处理的来源总数；未知成功仍为 null，须结合 `comments_last_attempt` 判断 |
| `local_comment_count` / `local_reply_count` | 本地完整保留根／回复数，不是本次加载数或来源总数；尚无归档时为 null |
| `comments_last_attempt` | 实际归档评论整轮的 `pending\|success\|failed\|unconfirmed`；旧成功可与最新观察待处理并存，须结合 `parts` 和 checkpoint |
| `last_succeeded_at` | 对应观察的实际整轮归档成功时间；检查、建立已有归档基线均不补此时间 |
| `check_error` | null、`SOURCE_UNAVAILABLE` 或 `SIGNAL_INVALID`；不回显来源原文 |
| `sync_error` | null 或固定脱敏错误，通常 `SYNC_INCOMPLETE`；成功检查不会清除同步错误 |

计数未知／失败与真实零不同：只有严格非负 JSON 整数（不接受布尔、字符串或小数）可成为新可信计数；无效值不触发假零扫描，也不清除已有工作。checks 与归档 GET 均只读，不调用上游。`unchanged` 不表示全部信号已知或同步成功，必须独立读取 work/错误/分项归档。`observed.edit_status` 表示最近可解析网页的编辑信号可用性；网页读取失败时保留旧编辑观察，须结合本次 `check_error/check_status` 判断。旧可信 `observed_version` 可在 unknown/error 时保留。归档自身的 observed/synced 表示执行阶段处理过的版本；最新检查观察以 checks 为准，待执行时两者可以不同。

管理 UP 的现有 `monitor.last_checked_at`、`last_succeeded_at` 分别为该 UP 持久目标记录的最大检查时间、最大实际成功时间，包含已移除历史；不表示该 UP 所有目标均已成功。时间为带时区 ISO（运行时 UTC）；来源发布时间和分钟编辑时间继续保留 `+08:00` 与原精度。

## 管理页面读取（24）

`/manage` 的每个 UP 提供“读取检查状态／重新读取检查状态”，通过生产 `ManagementApi.listChecks` 消费上述接口。不后台轮询、不调用检查或同步入口；尚未读取与后端未检查是不同状态。停用、近期模式或删除监控配置后仍可读取保留的目标状态。

页面分别显示检查结果、执行状态、正文／动态图／根评论／回复／评论图分项、最近检查及实际整轮成功时间；正文／动态图分项按最新检查观察投影，旧 checkpoint 不冒充当前完成。观察版本不同于正文成功版本时，明确提示版本不一致、当前观察仍待同步确认，不假设观察一定晚于实际取得的正文。未知或错误编辑信号不表示确认未编辑。UP 顶部两项时间只是历史目标记录的最大值，不表示全部目标成功。

读取失败保留此前状态，支持原位重读；取消及迟到响应不会写入新访问。响应结构、ID、枚举、时间和重复目标严格校验，错误只显示固定脱敏提示，不回显任意 HTTP 原文或观察元信息。

## 26 评论分项状态与时间

checks 增量返回 `root_comments_last_succeeded_at`、`replies_last_succeeded_at`、`comments_last_succeeded_at`，分别表示实际根分页、必要回复分页和整轮评论文本的最近成功时间。时间绑定实际完成的分项，不由检查、读取页面或其他分项成功代填；失败保留旧成功时间。旧归档缺字段为 null，不从整轮时间或当前时间补造。

`root_comments_error`、`replies_error`、`comments_error` 为固定脱敏错误或 null；与计数读取失败、正文受限、媒体未完成独立。归档详情的 `comment_sync` 为同一目标的 checks 投影（旧冻结响应可缺失），便于阅读页读取最新观察和状态；归档自身的 checkpoint 仍表示实际处理过的版本，不替换来源数为本地数。归档/管理 GET 仍仅读取 SQLite。

管理页分开显示来源总数、本地一级评论、本地回复、整轮评论成功计数、最近检查及评论分项成功时间。阅读页另外显示当前已加载一级评论数，分页终点只表示本地归档已读完；HTTP 成功和评论文本完成分别不表示来源完整或图片完成。详情提供只读“读取评论同步状态／重新读取评论同步状态”，不触发采集、不重新加载正文/评论，不重置排序、cursor 或访问位置。读取失败保留已有状态，旧访问的迟到响应不能覆盖新访问。

计数变化策略未变：增删抵消或纯评论编辑但总数不变可能漏检，不保证实时、完整来源或所有受限评论可读。#26 自动化证据见 [26 验收](../../../.scratch/backend-integration/acceptance-26.md)，媒体全链路聚合仍由 #30 收口。

## 30 媒体联动与分项成功时间

checks 增量返回 `text_last_succeeded_at`、`media_last_succeeded_at`、`comment_media_last_succeeded_at`（带时区 ISO 或 null），分别记录实际正文提交、动态图整组完成、一级评论图全部完成的最近时间。与既有根／回复／整轮评论时间一起读取；这些时间不表示最新观察已完成，仍须结合 `parts`、`work` 与对应 checkpoint。归档 JSON 持久保存实际取得的时间；归档详情 `comment_sync` 使用同一 checks 投影。旧记录缺字段返回 null，不从整轮成功时间、检查时间或当前时间补造；不新增 SQLite schema。

checks 同时增量返回 `media_errors`、`comment_media_errors`：分别对动态图当前组、所有一级评论图当前组的失败项聚合固定 `MEDIA_DOWNLOAD_FAILED`／`MEDIA_UPLOAD_FAILED`，去重并按字符串升序排列。没有已记录的失败返回 `[]`；空数组不代表已完成，仍须读取分项状态。不包含旧保留 `previous_media` 的结果、来源异常原文、URL 或凭据；较新观察尚未执行时，错误与时间一样反映实际已尝试的归档，不冒充已尝试较新版本。无需新增 schema。

成功正文确认没有动态图时可完成空媒体组；只有实际成功根分页才能确认无根／全空评论媒体组。检查、只读 GET、跳过已完成正文、跳过已上传图片均不推进时间。任一图失败保留旧成功时间、旧成功媒体和文本 checkpoint；同信号重试的最后一张图实际完成后推进媒体时间，不重扫已完成评论文本。有图但旧记录缺上传时间时，同版本根重扫不会补造上传时间。

自动执行仍沿用同一链路：可信 HTML 编辑变化更新正文和动态图；计数变化更新根、必要回复及一级评论图。评论文本可先完成、图片继续失败重试；较新检查观察不会被旧上传完成吞掉。状态不新增枚举：`check_status` 区分未检查／无变化／检查失败，`work=running` 表示在途，`parts` 的成功与待处理组合及 `sync_error` 区分部分完成、失败和具体未完成项；HTTP 成功不代表采集全项成功。受限正文、无效编辑信号与可读评论独立。

后端组合自动化及红绿证据见 [30 后端专项证据](../../../.scratch/backend-integration/evidence/backend-lifecycle-30.md)。该证据不代表前端已消费新增时间字段，也不代表真实上游、OSS、部署或持续运行已验收。

## 持久与停止

schema v10 新增检查、可信 observed、revision、work、独立错误和时间；v11 新增目标领取内部 `claim_token`，同 revision 的重试也以令牌拒绝旧完成／失败，不经 HTTP 返回。完成清令牌，恢复中断领取时清令牌并回 pending。v0–v10 原子迁移到 v11；27 进一步迁移到 v12 新增独立发现状态，保留旧配置/归档和未完成观察，未来版本拒绝。#25 复用已有 observed JSON、评论 checkpoint 和工作表，无新增 schema；旧归档首次登记仅在正文版本、评论计数 checkpoint 及所有实际分项均匹配时建立 complete 基线，不补造成功时间。旧 v11 已有 complete 记录也会在检查时核验实际 checkpoint；若旧完成判断遗漏计数匹配，即使信号不变也恢复 pending，不伪造新 revision 或成功时间。已有归档未检查时读取其旧可信信号，首次登记将其作为保存基线；来源失败/未知不令旧版本从新状态接口消失，也不制造检查/成功时间。网络/媒体 I/O 不持有 SQLite 事务。

Linux/Unix 上使用同一数据库规范路径旁的 `.collector.lock` 文件与内核 flock，只运行一个采集进程；不能删除运行中的锁文件，不能用硬链接别名或多主机共享文件规避锁。退出/崩溃自动释放内核锁，文件可留存。采集运行入口取得锁后将中断 `running` 恢复为 pending；API 启动不恢复、不领取。`--once` 只检查登记，不执行归档或恢复执行工作。

停用、模式切换后不再入选、移出近期窗口、移除指定目标或删监控配置阻止新检查与新领取；已领取工作允许结束，未完成信息和归档保留。检查返回时再次核验关联，停止后的旧检查结果不写入。重新纳入可继续 pending。

### 29 在途配置代次与重纳入

schema v13 原子新增内部 `(uid, dynamic_id)` 入选令牌，并从 v12 当前互斥入选集合回填；身份、配置、归档、observed、checkpoint、pending/running 不重写。影响当前选择的配置变化（启停、模式、近期模式的 N）与该 UP 入选令牌刷新同事务；指定关联增删和可信窗口发布只增删受影响成员的令牌，保留仍入选成员。同配置重复保存、指定模式仅保存暂不生效的 N 或相同成员窗口重复发布不改变令牌。停止后重新纳入、删配置重建生成不同令牌，旧检查不会因“当前又入选”被接纳；令牌不经 HTTP 暴露。

检查从调度快照到信号请求、最终登记均携带入选代次；网页/detail 返回后发现代次失效，不继续请求下一项信号，不写旧观察、错误或检查时间。请求与配置变化间仍可发生竞态：已经开始的外部请求允许返回，最终写事务再核验代次，网络不占配置写事务。待领取快照、同步领取到归档领取的间隙、显式 initial 遍历也核验同一代次，不从旧快照领取重纳入的新工作。

取得归档领取后，**整条同步链允许结束**，包含后续正文、根/回复分页、动态/评论图下载及上传；这些属于已领取工作，不是新的检查或监控轮次。正确 owner/版本的归档结果可以保存，停止不清空内容、不回收媒体。但代次失效的旧执行只释放自身领取并保留 pending，不把新代次标 complete、不更新其整轮成功时间；观察 revision 和执行 claim_token 仍分别阻止吞掉较新观察或较新领取。归档 generation、逐图 attempt token 继续按原规则隔离提交，不能用入选令牌替代内容版本。

停止期间不领取 pending；重新纳入后无需信号再次变化即可续做，已完成分项不重复采集。中断 running 仍只由持锁的正式 run 恢复；只读 HTTP 重开不恢复工作。公开状态/请求记录/完整内容及真实 SQLite 重开矩阵见 [29 验收](../../../.scratch/backend-integration/acceptance-29.md)。

启动、停止和无真实来源演示见 [后端 README](../../../backend/README.md#23-独立采集进程)。本票只有受控节拍/虚构来源与实际本地进程证据，不能证明真实上游长期稳定性。
