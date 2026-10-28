# 固定节拍采集与检查状态（票据 23 / 24 / 25 / 26 / 27 / 28 / 29 / 30）

已确认后续设计：修改 B 站请求发送、分页续采、风控恢复或采集日志时，先读[B 站限流／风控保护与全量归档续采](../../design/bilibili-risk-control.md)。票据 03 已实施其中的「HTTP 412／429 跨进程持久暂停与只读状态查询」（见下文「跨进程风控暂停（03）」），票据 04 已实施「六档冷却与按接口探测」（见下文「六档冷却与按接口探测（04）」），票据 05 已实施「恢复观察期与人工探测」（见下文「恢复观察期与人工探测（05）」）；票据 02／06／07 已把页后 100ms 等待、根页与楼中楼持久续采及按页日志接入本契约；票据 08 已实施全局单路重型、分页公平轮转与跨进程发送／目标租约（见下文「单路重型与公平轮转（08）」）；票据 09 已实施系统告警；票据 10 已完成三进程组合回归与 RC-01—RC-12 台账（见下文「跨进程组合验证（10）」），RC-12 只做一次有界对照，无法证明与原始脚本等价且未达非硬性参考目标，整体性能未验收。

后续范围说明：[飞书通知需求与设计](../../design/feishu-notifications.md)已确认新增归档提交时的事务发件箱与独立通知进程，尚未实现。本文继续描述现有采集接口和检测策略，不因设计确认而声称已产生事件或投递消息；飞书退避不改变本页采集节拍。

## 运行边界

27 在同一节拍增加启用 recent UP 的独立发现阶段，默认最多 2 个同时发现；28 将整轮可信结果接为持久窗口，与指定集合互斥地复用以下检查/同步链。可信发现与本轮错误持久分开；失败保留旧窗口，配置冲突和只读管理 HTTP 见 [近期发现与窗口契约](discovery-api.md)。

单独 Python 进程从同一 SQLite 中按 `enabled=true` 的互斥模式选取目标：`specified` 只取关联 ID，`recent` 只取最后成功发布的可信窗口。API 不启动调度器；浏览器阅读、管理读取不触发同步。启动时为第一个节拍，此后按单调时钟固定节拍触发（生产默认 2.7 秒，±10% 抖动，可用 `BILI_COLLECTOR_CADENCE_SECONDS` 覆盖为固定值）；不是任务完成后再等一个节拍。每个节拍读取评论计数；页面信号（编辑时间、正文/图片版本、受限状态）按独立间隔采样，默认 60 秒 ±2 秒（`BILI_COLLECTOR_PAGE_CHECK_SECONDS` 可覆盖，0 表示每节拍采样），未到期时该目标只读计数，页面与 detail 不重复请求。同目标检查忙时跳过，不叠加、补发或排队。默认最多 4 个同时检查，容量不足的目标跳过当前槽，轮转选择防止长期偏向头部；不承诺每目标在所有负载下都能完成每个节拍。进程停顿错过的槽不追赶。

检查读取普通 opus HTML，复用安全初始化 JSON/AUTHOR 解析登记编辑信号；独立读取 `/x/v2/reply/count` 的 `data.count` 作为评论区来源总数信号。不用网页 STAT、通用 detail、根页 `page.count/acount` 或本地条数代替独立计数。locator 使用带 `policy_version/source` 的策略：旧版本在后续检查重新从已校验动态 ID/作者的 detail 核对；按参考函数优先 basic，再尝试同目标 OPUS/动态ID回退，候选必须通过合法ID和资源一致性校验，空页不确认 fallback。无编辑标记、网页失败／无权或正文受限不阻止独立计数和可读评论初始化；计数缺失、无效、业务／网络失败保留旧可信值与失败状态。两项信号独立合并，不因其中一项失败丢失另一项新观察。计数结构及证据限制见[来源协议](../evidence/source-protocol-evidence.md#25-独立评论计数)。

08 起全局只推进一路重型归档：每个可提交步骤（正文、根页、楼中楼页、单图下载／上传）提交后释放重型回合，在所有可运行 pending 目标间轮转；同目标由 SQLite 目标租约互斥，慢页只阻塞当前回合，其他目标的轻量检查仍按固定节拍进行，并在下一次步骤获得重型机会。公开 `execute_pending` 单次遍历同样按步骤轮转；不承诺任意负载下全部目标每节拍完成。复用 #02/#15/#17/#21 同一正文、根回复与媒体归档链，网络不占长事务。失败留待下一节拍，不即时无限重试。

初始化、失败重试或可信总数变化才执行根＋必要回复完整分页；计数不变、纯正文编辑、评论纯编辑或增删抵消不默认重扫。任一根／回复分项未完成仍走原完整根＋回复重试，不做见旧 ID 截断。评论工作绑定领取计数；正文／detail metadata 不覆盖领取的独立计数。已完成且版本匹配的正文在纯评论工作中不重读；评论成功不等待媒体上传。目标 complete 仍要求实际正文版本与评论 checkpoint 匹配领取观察、全部归档 work 与评论媒体就绪。

**配置了媒体上传器时**，媒体（动态图与根评论图）是完成条件，且 `media_version` 落后于可信观察会重新登记工作以回源头确认。**未配置上传器时媒体不是完成条件**：`media.py` 在无 uploader 时直接返回、从不推进媒体状态，有图的目标永远无法完成，若仍当成条件就会每节拍重领工作空转、`last_succeeded_at` 恒为 null。此时媒体分项与 `public_url` 仍如实保持 pending／null，不冒充已上传；一旦配好上传器，下次检查会因媒体不满足而重新登记工作并实际补传。

目标 revision 在首次登记、可信编辑版本改变、可信评论总数改变或评论资源 oid/type 改变时增加；正文版本和评论计数不拼成同一内容版本。同步期间新观察仍持久登记，旧执行只提交自身处理的版本，不能清除较新 revision；重开恢复与令牌 fencing 沿用 #24。显式 `/api/sync/initial` 不是计数检查入口：尚无独立计数检查记录的目标保持原 #02 初始化协议；已有 `comment_count_status` 的目标绑定最近可信检查计数（未知仍未知），不能再用 STAT/detail 覆盖它。没有每日校准、退避、自适应频率、内容比对或无限并发；27 的近期发现另见独立契约。计数抵消、纯评论编辑和不改变计数的来源分页移动可漏检。

## 分页请求节奏（30）

正式 API／采集进程的 HTTPX feed 与 Requests 评论会话共享同一 `SourcePacer`：feed 每次发送前随机异步等待0.8–1.5秒，根评论每页0.3–0.4秒，包含首页和空尾页确认。楼中楼改为**每次真实分页请求结束后**异步等待至少100ms（`ReplyPagePacer`）：首个请求前不加，失败请求、末页倒序增量、空尾页复查与后续探测（同一 `client.get(REPLIES_URL, ...)` 路径）都一样；发送与页后等待在同一串行段内，多调用者不能交错绕过。楼级0.3–0.4秒只在实际展开楼中楼后保留，来源明确零回复或未发出请求的楼不再缴纳。页级共享锁只覆盖 feed/根评论等待与楼中楼页后等待，不占 SQLite 写事务。HTML/detail/独立计数不排分页队列。每个正式评论尝试单独创建 Requests Session，线程池执行网络，按参考顺序预热首页和UP空间页（每页返回后异步等1–3秒），结束关闭；不再以nav预热，不导入其主循环或飞书逻辑。Requests采用环境代理和受信B站内的GET重定向；HTTPX信号与媒体路径保持原独立策略。

该节奏不改变固定节拍调度或失败重试规则；分页慢不会改成“同步完再等下一节拍”，忙检查仍跳过、不积压。等待和网络均在 SQLite 事务外。08 起 API 与 collector 共享 SQLite `source` 许可，跨进程也不能在楼中楼页后 100ms 内提前发送；仍不保证上游永不限流，真实持续运行需另行验证。测试传输可另行注入外部时间（`PacedSourceTransport(sleep=...)`、`ReplyPagePacer(sleep=..., clock=...)`，后者可从 `create_app(reply_page_pacer=...)`、`open_collector(reply_page_pacer=...)` 传入），见 [后端说明](../../../backend/README.md#30-分页请求间隔)。

## 调度与失败日志

collector 使用独立 INFO 级别的 stderr handler，保持 HTTPX/HTTPCore、OSS 和 access 传输日志禁用，不依赖根 logger 的默认级别。统一托管时 API 与 collector 的输出归同一个 systemd unit，可用 `journalctl --user -u bili-charge-live-34.service -f` 跟随。此前只有启动信息或固定失败状态时，日志不变不能证明未重试。

- `collector_initializing`、`collector_configuration`、`collector_started` 表示初始化、评论引擎/代理策略、媒体上传是否启用、固定节拍/并发配置与恢复完成。`comment_session_started/closed` 表示每轮 Requests 生命周期；`comment_session_warmup` 的 homepage/space 只表示对应 HTTP 返回情况，不代表登录成功。
- 每个固定节拍输出一条 `collector_tick`，记录当前入选 `targets`、`recent_ups`、待处理 `pending`、检查/同步/发现的 `*_in_flight` 和本轮 `*_started` 数量。它是调度快照，不保证任务在该行输出时已完成领取；无目标也输出心跳。
- `sync_started`、`sync_finished` 和来源阶段事件共享进程内 `attempt` 流水号，并带字符串 `uid`／`dynamic_id` 定位目标；`sync_finished` 另带 `text/comments/replies/media` 分项与 `elapsed_ms`。流水号不是目标 ID 或持久领取令牌；重启后重置。`sync_finished complete=false` 不表示成功，后续仍按原 pending/入选规则处理；`sync_skipped reason=not_claimed` 表示未取得有效工作。`check_started/check_finished/check_skipped` 与 `discovery_started/discovery_finished`（含 `dynamic_ids`）同样带业务 ID。
- `root_sync_started/root_sync_finished` 和 `replies_sync_started/replies_sync_finished` 记录整轮阶段；每页另有一条摘要：根页为 `root_page_saved`（`page`、`direction=forward|tail_confirmation`、`fetched`、`comment_ids`、`elapsed_ms`，06 起另带 `new`／`confirmed`／`phase`／`checkpoint`；恢复与重定位记 `root_scan_position resume=start|resume|regenerated|incremental|locator_changed` 与 `root_scan_resumed resume=aligned|inserted|removed|anchor_lost`，含 `anchor_page`、`shift`、下一页），楼中楼为 `reply_page_fetched`（`endpoint_type=replies`、`page`、`direction=forward|reverse`、`fetched`、`reply_ids`、`elapsed_ms`、`wait_ms`）与保存后的 `reply_page_saved`（`page`、`direction`、`fetched`、`new`、`updated`、`reply_ids`、`phase`、`checkpoint=accepted`、`elapsed_ms`、`wait_ms`；07 起提交结果沿用根页的 `checkpoint=accepted`，不再另设 `accepted=true`）。每页的全部已校验 ID 批量记一条，不为每条回复刷 INFO；单行超预算时按同一关联号分块（`ids_part`/`ids_chunks`/`ids_total`），不静默截断。根/回复失败记录固定事件、`stage`、`page`（回复另含本轮 `root_index`）及可得时的 `elapsed_ms`/`wait_ms`，以区分来源请求、分页校验、存储和尾页复查。楼中楼增量另记 `reply_incremental_finished`（`new`、`stopped_by=known_page|first_page|empty_tail|drift`）与整楼完成时的 `reply_root_finished`；处理完的楼记录 `local_source_delta`（本地行数减来源 count），不因此删除旧回复。07 起楼中楼按页持久续采，另记 `reply_scan_position resume=start|resume|regenerated|incremental|locator_changed|direction_changed`、`reply_scan_resumed resume=aligned|inserted|removed|anchor_lost|retargeted`（含 `anchor_page`、`page`、`shift`）、`reply_tail_confirmed` 与代次过期时的 `reply_page_rejected reason=stale_generation`；计数漂移仍只在 `reply_scan_count_grew` 记一次，不逐条刷。并发计数**增长**不判失败，只记 `root_scan_count_grew` / `reply_scan_count_grew`；根扫描失败时楼中楼降级执行记 `replies_sync_degraded roots=`；`replies_sync_finished` 另带 `skipped=` 与 `degraded=`。媒体每轮处理时记 `media_sync_finished processed/succeeded/failed`。
- 失败仅记录固定 `reason` 与经过范围校验的 `http_status`：如 `timeout`、`http_status`、`network_error`、`json_invalid`、`field_missing`、`type_invalid`、`value_invalid`、`source_rejected`、`pagination_changed`、`pagination_not_advancing`、`storage_error`、`login_required`、`credential_rejected`。应用自身的固定校验错误进一步细分为 `comment_page_mismatch`、`pictures_shape_invalid`、`upper_shape_invalid` 等有限原因。根/回复的缺字段只在命中对应阶段的固定字段白名单时记录 `field`，不回显任意键名；JSON 解码异常不输出其文档片段。按正式设计 §6 **有意扩展**：已校验的字符串业务 ID（`uid`、`dynamic_id`、`root_id`、`comment_ids`、`reply_ids`、`dynamic_ids`）可进日志，其余仍禁止：不输出响应正文、异常原文/traceback、URL、评论文本或昵称、Cookie、SDK 凭据或领取令牌；ID 字段只接受 `SourceId`／`SourceIds` 包装的合法数字串，其他字符串仍渲染为 `unknown`。
- `collector_loop_failed/collector_failed` 明确记录调度或启动失败；取消/退出记录 `collector_stopping/collector_stopped`。未改变既有异常处理及失败重试策略，也未在父进程中新增自动重启。
- **凭据相关分类只有两个 token，且只由上游业务码决定**：评论计数/根评论/楼中楼响应体的 `code` 为 `-101`（账号未登录）时，本次启动确实读到来源 Cookie → `credential_rejected`（可信凭据失效）；未配置 Cookie → `login_required`（本地匿名访问，属采集异常）。其余业务码（`-111`/`-352`/`-401`/`-403`/`-412`/`-799` 等）、HTTP 401/403、超时与网络异常一律保持原分类（`source_rejected`/`http_status`/`timeout`/`network_error`），**不得**当作登录失效；不读上游 `message`，也不新增 `nav` 探针或空页启发式来推断登录态。分类只用于诊断日志与系统告警，`check_error` 的既有枚举不变。
- 真实失败事实（检查、同步、近期发现）在写入结果的同一事务里登记系统告警（见[通知进程与投递](notification-process.md#33-系统告警08)）；告警登记失败只留 `alert_registration_failed` 固定分类日志，不影响检查/归档结果提交。

判断方式：`pending>0` 且 `syncs_started>0` 表示本轮安排了待处理执行，随后应看到 `sync_started`；`syncs_in_flight>0` 表示任务仍在跟踪中，不能因本轮没新启动就断言不工作；`targets=0` 表示当前没有入选目标，不能推断为有工作但未重试。需要以实际日志区分，本次按用户要求不做运行验证。

## 跨进程风控暂停（03）

保护状态是唯一一份持久事实，存在同一 SQLite 的 `source_risk` 单行（v24 建立，v26 补观察进度与人工登记列），API 与采集进程共读共写，不按 UP 或动态拆开，也不存在进程内放行开关。

- **触发**：只有真实上游 **HTTP 412／429** 触发。其他 HTTP 状态、业务码（含评论业务码 `-412`／`-352`）、凭据信号、网络与内容受限分类保持原处理，不因名称相似扩大。触发入口覆盖全部源请求：业务接口、首页／空间预热、图片 CDN、API 手动初始化与媒体重试，以及 HTTPX／Requests 跟随跳转后的每一跳。
- **报告点**：结果报告在传输层、业务异常处理之前完成，预热仍 best-effort 不抛异常也照样报告。风控响应被记录后，当前调用链不会拿到该响应，因此不再翻页、重试、重定向或补做预热；已在途返回的数据仍按原版本／令牌规则提交。
- **状态机（03 建立，04 扩展）**：`normal → cooldown`（第 1 档，冷却 60 秒）。状态代次在同一短事务内 +1，并记录进入时间、下次探测时间与触发接口／HTTP 状态；同一代次内迟到的 412／429 只合并，不推进档位、不延长期限/不重复计数。六档到期探测、`probing`／`observing`／`manual` 与 owner 租约由 04 接入同一 `state`／`backoff_step`／`next_probe_at`／`probe_*` 字段（见下一节）；没有“强行清除风控”的入口，观察期清零与人工探测登记见「恢复观察期与人工探测（05）」。
- **拒绝发送**：发送前原子核验状态；保护态或状态不可读写都拒绝，前端与采集侧都拿不到「放行」。状态不可读写返回存储错误（`503 STORAGE_UNAVAILABLE`），不降级放行。
- **采集调度**：暂停时本轮不派发发现、检查或执行，错过的槽不补发；在途单元被保护打断时保留 `pending`／`running` 领取与已提交分片，不写检查失败、`sync_error`、成功时间或告警，进程重启由既有恢复路径归还。
- **日志（脱敏、可关联）**：`source_risk_triggered`（含 `endpoint_type`、`http_status`、`backoff_step`、`risk_state`）、`source_risk_late_response_merged`、`source_risk_blocked`（拒绝原因：状态与档位）、`collector_paused`（每个状态代次一条，不每 2.7 秒重复同一警告）、`source_risk_paused_work_aborted`、`comment_session_warmup_paused`。暂停期间仍每节拍输出 `collector_tick paused=true` 心跳（只含在途数与 0 启动，不查库、不代表有工作）；不含 URL、query、Cookie、正文或领取令牌；采集侧事件共享进程内 `attempt` 流水号。
- **接口类型**：按「主机＋路径模板」固定归类（`comment_count`、`root_comments`、`replies`、`feed`、`detail`、`opus_page`、`profile`、`homepage_warmup`、`space_warmup`，以及 `hdslb.com`／`biliimg.com` 两个受信图片域族 `image_hdslb`／`image_biliimg`；其余白名单内路径归 `source_other`，仍受许可）。不同域族是不同拦截面，后续按类型探测不能互相代替。

`GET /api/manage/risk` → `200`，只读本地 SQLite，不触发采集、探测或任何上游请求；不接受查询参数（非法或重复参数 `422 INVALID_INPUT`）。人工探测登记走 `POST /api/manage/risk/probe`（见「恢复观察期与人工探测（05）」与[管理契约](management-api.md)），登记本身同样不发探测请求。

| 字段 | 含义 |
| --- | --- |
| `state` | `normal`／`cooldown`／`probing`／`observing`／`manual` 之一；`probing` 的 owner 与探测细节见下一节，`manual` 的人工探测登记由 05 落地 |
| `generation` | 状态代次，每次状态转移 +1；迟到响应的合并不推进 |
| `since` | 进入当前状态的时间（带时区 UTC ISO） |
| `backoff_step` | 当前退避档位，正常为 0，第 1 档为 1 |
| `next_probe_at` | 下次到期探测时间，可空；`cooldown` 为未来期限，`probing`／`observing`／`manual` 为 null |
| `observing_since` | 观察期起点；进入 `observing` 时写入，稳定清零或重启重新累计时更新 |
| `last_trigger` | `{"endpoint_type","http_status","at"}`，脱敏触发信息；从未触发为 null |
| `probe` | `{"round","results"}` 最近一轮探测摘要；`results` 每项含 `endpoint_type`、`status`（`pending`／`passed`／`failed`）、`http_status`、`reason`、`elapsed_ms`、`wait_ms` 与可空业务 ID（`uid`／`dynamic_id`／`root_id`） |
| `observation` | `{"since","active_ms","successes","required_ms"}` 观察期进度：已累计的活跃采集毫秒数、其中确有成功业务请求的节拍数、清零所需毫秒数（600000）；不在观察期为 0 与 null |
| `manual` | `{"probe_registered"}` 当前人工态代次是否已登记一轮探测；非人工态恒为 false |

不返回凭据、完整 URL／query、内部 owner 或领取令牌。需要访问来源的管理操作在此状态下返回 `503 SOURCE_RISK_PAUSED`，见[管理契约](management-api.md)；纯本地读取、停用／删除、已下载数据提交与 OSS 上传继续可用。

## 六档冷却与按接口探测（04）

冷却阶梯固定为 **1、2、4、8、15、30 分钟**（`COOLDOWN_STEPS`）。首次在 `normal` 遇到 HTTP 412／429 进入第 1 档；观察期（`observing`）再次遇到时进入当前档的下一档；第 6 档之后再次触发直接转 `manual`。每档**到期都实际执行一轮探测**，一轮失败只推进一档，第 6 档失败转 `manual` 并停止自动探测。合法 `Retry-After` 只把期限推后，不会被更短的本地档位覆盖。

- **状态转换**：`cooldown`（期限到期）→ `probing`（唯一 owner 领取）→ 全部通过 `observing`（保留 `backoff_step`，恢复普通发送；不补发冷却期间错过的检查）／任一轮失败回到 `cooldown`（下一档）或 `manual`。`normal` 与 `observing` 是唯一允许普通发送的状态。
- **探测集合**：每轮冻结「本次触发接口类型 ∪ 当前待执行工作真正需要的类型」。当前实现的判定只看本地事实：有入选目标 → `opus_page`、`comment_count`（位置未知或有待同步工作时再加 `detail`）；有待同步工作且已存 locator → `root_comments`、且只有已知有回复的根才加 `replies`；有启用 recent 监控 → `feed`；有未成功媒体 → 对应图片域族；恢复后首次取评论会话会真的发首页／空间预热时（预热缓存未命中或已过 TTL 且不在重试冷却期，由生产会话工厂的 `WarmupCache` 判定）才加 `homepage_warmup`、`space_warmup`——缓存命中或冷却期不发，因此不强加无关请求。已存身份不等于待办资料请求：`profile` 只在新增／校验 UP 时用到，不因身份表存在而并入。类型按主机＋路径模板归类，不按动态 ID／根 ID／页码扩增；没有工作用到的功能不为凑探测发请求。
- **执行**：按类型串行，触发类型先探测；每类只发一个最小有效 GET 并走原解析校验（计数、根页、楼中楼、detail、opus、feed、资料、首页／空间预热、图片各用对应上游解析；图片只用实际 GET，不用 HEAD）。楼中楼探测与正常分页同一条会话路径，同样缴纳页后 100ms 等待。任一类型未通过立即结束本轮，其余类型不再请求并保持 `pending`。
- **样本与判定**：只用本地已知有效样本（已存 locator、已知有回复的根、已存来源图、已存 UP）；样本失效时不无限在线寻找，记为固定原因 `sample_missing` 并保持暂停。HTTP 200 但业务码或资源校验失败同样不通过；非 412／429 的探测失败只表示“本轮未通过”，沿用原有固定分类，不扩大普通业务错误分类，也不写检查失败或 `sync_error`。
- **无业务副作用**：探测只验证可用性，不提交归档分片、不推进评论 checkpoint／`last_succeeded_at`、不写通知基线，也不生成业务通知；探测不暗中补做首页／空间预热。
- **唯一 owner 租约**：轮次、owner 与租约（300 秒）随状态落库。租约内其他进程不能领取；进程崩溃后只能等租约到期再接管，接管重新确认本轮类型；旧 owner 提交结果或结束新一轮会被拒绝（owner＋轮次 fencing）。探测期间其他 `permit` 一律拒绝。
- **采集调度**：探测由采集进程的固定节拍驱动（API 进程只读状态，不探测）。进入 `observing` 后，采集进程在没有在途任务时把上次被暂停打断的 `running` 领取归还为 `pending` 并从原断点继续，不需要重启进程。
- **日志（脱敏）**：`risk_probe_started`（轮次关联号、类型数、档位）、`risk_probe_finished`（每类：类型、结果、HTTP 状态、固定原因、耗时、等待、业务 ID）、`risk_probe_round_finished`（通过与否、状态、档位、距下次探测秒数）、`risk_probe_skipped`（无可验证类型：`reason=no_required_types`，按状态代次只留一条）、`source_risk_observing`／`source_risk_manual_wait`、`risk_work_resumed`。不含 URL、query、Cookie、正文或 owner／令牌。

## 恢复观察期与人工探测（05）

探测全部通过后仍保留档位，先进入 `observing`：普通发送与等待策略立即恢复，不为观察期额外降速。只有**确有成功业务请求的活跃采集时间连续满 10 分钟**（600 秒）才回到 `normal` 并把 `backoff_step` 清零。这里的“成功”只看业务事实：该请求已通过自己的业务解析与资源校验（正文页确认是目标动态、评论／回复真的取到并入库、图片确为非空 `image/*`），由业务层显式上报；HTTP 2xx／3xx 只是传输状态，`200 + code=-352` 的评论拒绝、`-412` 业务码、无效 JSON、错误页与跳转都不累计，首页／空间预热也不计。

- **活跃时间的边界**：观察进度由采集进程的固定节拍提交，每拍最多计入一个节拍的时长；该区间内没有成功业务请求（空闲、只有普通错误、只有业务拒绝或只有预热）就不累计。API 进程的成功响应不抵扣观察期，稳定只看正常采集。
- **停机与重启**：停机时间不计入；采集进程启动时把观察进度重新累计（`observing_since` 改为启动时刻，`active_ms`／`successes` 归零），档位与人工态保留。
- **观察期再遇风控**：`observing` 遇到 HTTP 412／429 进入当前档的下一档（第 6 档后转 `manual`），观察进度归零，不从第 1 档重来。
- **人工态**：`manual` 只接受管理入口登记一轮探测；登记绑定当前人工态代次，重复登记幂等、不排多轮，采集进程未运行时保持“已登记”，API 自己不探测。采集进程领取后按 04 的同一执行器验证全部必需类型：通过进入同样的观察期，失败回到 `manual`（档位不变、需重新登记），没有“强行恢复发送”的入口。
- **状态查询**：`GET /api/manage/risk` 的 `manual.probe_registered` 表达人工态登记，`observation` 表达观察进度，`generation` 是状态代次（迟到响应与探测租约只认同代次）；`state=normal`＋`backoff_step=0` 即稳定恢复。人工态登记后仍没有任何可验证类型时保持暂停，按代次记一条固定原因 `risk_probe_skipped reason=no_required_types`，不每拍重复日志也不无声空转。
- **日志（脱敏、可关联）**：`source_risk_manual_probe_registered`、`source_risk_observation_restarted`、`source_risk_observation_cleared`、`risk_probe_claimed`、`risk_probe_round_finished`（含 `probe_origin=manual|cooldown`）。状态转移日志统一带 `previous_state`、`risk_state`、`risk_generation`、`backoff_step` 与 `probe_round_id`（数字关联号），不含 owner／租约令牌，也不产生业务通知。

## 单路重型与公平轮转（08）

API 与 collector 共用同一个 SQLite 的 `dispatch_leases`（v27）。租约只有三类，均为 `BEGIN IMMEDIATE` 短事务写入，网络、页后等待、解析和 OSS 上传不持有这些写事务：

- `source`：所有真实 B 站来源发送（HTTPX 的正文／detail／feed／资料／作者校验／图片，以及 Requests 的计数／根页／楼中楼／预热）在 `permit` 前取得，包住发送、报告与楼中楼页后 100ms 等待；因此另一进程无法在等待内提前发送。
- `heavy`：全局唯一的重型回合。一次只推进一个可提交步骤（正文、根页、楼中楼页或单张图片下载／上传），提交后释放；目标之间按步骤轮转。
- `target:<uid>:<dynamic_id>`：同目标互斥。collector 持有整个会话并在每步续期；API 手动初始化用 `api` 类型挡 collector，但并发 API 仍由归档 `generation` fencing 决定旧执行成败。

目标会话只保存进度所需的步骤状态；每步读取持久断点与领取代次，不需要把整条动态／整栋楼放在内存中。collector 的 `execute_pending` 对所有可运行目标轮转一步，慢页只占一个重型回合；固定节拍检查照常进行，忙时仍跳过、不积压、不补发。API 手动初始化按同一组步骤同步推进并保留原 `processed/succeeded/failed` 语义；collector 已持有该目标时直接跳过，不返回“已排队即成功”。新建 UP、目标校验等需要来源的操作仍与正常请求共用 `source` 许可，OSS 上传不取来源许可。

暂停、取消或 lease 失效时：当前步骤不再发下一次上游请求，已提交分片和 `running` 领取保留；租约到期后其他进程只能先接管再发送，旧 owner 的释放不会删除新 owner 的租约。`SourceRiskPaused` 不在调度层改写成失败；恢复后由既有 `recover_check_work` 回到 pending 并从持久断点继续。

调度日志新增 `dispatch_stage`（阶段推进）、`dispatch_turn`（目标、阶段、页、是否完成与让出回合）、`sync_skipped reason=target_busy|target_lease_lost|selection_changed` 与 `source_risk_paused_work_aborted`；不输出 owner 或租约令牌。目标／页／ID 字段沿用既有白名单与分块。

## 风控生命周期系统告警（09）

三个关键生命周期事实会登记系统群告警，**复用**既有事务发件箱、系统群路由、类别／固定原因目录、30 分钟去重节流与通知三态开关，不新增并行投递机制、不改业务通知起点或资格。

| 事实 | 登记点（真实状态转移） | 类别 | 固定原因 |
| --- | --- | --- | --- |
| 首次触发／冷却升级 | `RiskGate._record_trigger` 的 `with write(...)` 事务内（`normal`／`observing` → `cooldown`） | `risk_triggered` | `risk_cooldown` |
| 自动恢复耗尽转人工 | `_finish_probe` 末档失败，或 `_record_trigger` 在观察期第六档之后直接转 `manual` | `risk_manual` | `risk_manual_wait` |
| 稳定恢复 | `_observing_tick` 的 `observing` → `normal`（满 600 秒活跃采集） | `risk_recovered` | `risk_stable` |

- **与状态事实同事务**：告警在同一短事务里登记（`outbox.record_alert`，单条 `SAVEPOINT` 隔离），不读日志、不扫描全表。登记失败只丢该条告警并留 `alert_registration_failed`，风控状态与该次转移照常提交，不把通知故障变成风控旁路。
- **只登记转换**：每档等待、每类探测结果、每页 412、迟到响应合并、owner 接管、人工态重复登记与进程重启都不产生新告警；人工轮失败仍停在人工态，也不是新的生命周期事实。
- **不冒充稳定恢复**：探测刚通过只是 `observing`；满 10 分钟活跃采集后才登记恢复，空闲与停机不抵扣。
- **开关**：`off` 时与其它系统消息一样不登记、不排队、不补发，也不暗中改开关；`system_only` 只投递这类系统消息；`all` 不变。
- **消息边界**：只有固定类别、对象（`source_risk`）、发生时间与固定原因；不带正文、完整 URL／query、Cookie、凭据或 owner／探测轮次令牌。逐接口资源定位信息留在结构化日志。三个类别分别按自己的 30 分钟窗口节流，因此稳定恢复不会被分钟级的触发提醒合并掉。

## 跨进程组合验证（10）

票据 10 用真实 API＋独立采集＋独立通知三个进程共享同一临时 SQLite 做组合回放，外部只替换 B 站来源、图片 CDN、OSS 上传与飞书 HTTP。证据见 [10 多进程组合与性能验收](../../../.scratch/bilibili-risk-control/evidence/10-integrated-performance-verification.md)，样本与结果包括：

- 8 目标、含一万条楼中楼回复的固定来源完整归档；轻量计数贯穿分页，跨进程同一时刻最多一个真实来源发送，楼中楼每页完成后 100ms 内无下一次发送。
- 采集进程触发 412 后另一进程停止全部来源发送；本地归档读取、管理停用／删除、已下载内容提交与 OSS 上传继续可用；新增 UP、目标校验、手动初始化与媒体重试返回固定 503 且无半成品。
- 六档到期探测、触发类型先探测与失败短路、转人工、人工登记幂等、观察 599／600 秒、观察期再触发沿用下一档；强杀并重启后冷却期限、档位、人工态与已确认分页保留，探测 owner 过期后可接管，旧 owner 结果被拒。
- 分页中断续采不重下已确认首页、新计数与新根不被吞、来源缩小不清旧档；定位资源改变后重新读 detail 并重定位。
- 系统群只投递触发／转人工／稳定恢复三类生命周期事实，业务通知资格与起点不变；INFO／WARNING 能串联目标、页、ID、等待与断点，且不含凭据、正文、完整 URL 或内部令牌。

性能：同一样本用受控虚拟时钟对比静态核对重建的隔离参考 Adapter，报告逐类请求数与显式等待；请求集合无法证明等价（项目另有检查＋归档读取、根页确认页与楼中楼探空页），因此**整体性能未验收**，公式仍是非硬性参考目标。真实 B 站／OSS／飞书、部署与压测未验证。

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
| `last_succeeded_at` | 对应观察的实际整轮归档成功时间；检查、建立已有归档基线均不补此时间。正文受限且该版本已确认终态时也属于整轮完成，会推进此时间；`text_last_succeeded_at`／`media_last_succeeded_at` 仍为 null，不冒充实际提交 |
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

自动执行仍沿用同一链路：可信 HTML 编辑变化更新正文和动态图；计数变化更新根、必要回复及一级评论图。评论文本可先完成、图片继续失败重试；较新检查观察不会被旧上传完成吞掉。状态不新增枚举：`check_status` 区分未检查／无变化／检查失败，`work=running` 表示在途，`parts` 的成功与待处理组合及 `sync_error` 区分部分完成、失败和具体未完成项；HTTP 成功不代表采集全项成功。受限正文、无效编辑信号与可读评论独立；受限为已确认终态时整轮算完成（`work=complete`、推进 `last_succeeded_at`），但不伪造正文／媒体分项的成功时间。

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
