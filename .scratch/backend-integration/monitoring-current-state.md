# 当前监控流程梳理

本记录基于当前源码、项目契约及本机运行观察，区分“已实现能力”与“此刻正在运行”。不启动采集、不访问真实 B站／OSS、不读取凭据。代码基线包含 `f47472f`。

## 1. 当前实际运行状态

2026-10-15 16:57（+08:00）本机核验：

| 项目 | 观察结果 |
| --- | --- |
| 前端 | Vite 开发服务器，127.0.0.1:5173，使用生产 API Reader 装配，不是已部署的正式静态 bundle |
| API | 单 worker Uvicorn，127.0.0.1:8000 |
| 正式采集进程 | 没有发现 collector 进程 |
| 已保存 UP／监控配置 | `/api/manage/ups` 返回空集合 |
| 已保存归档身份 | `/api/archive/ups` 返回空集合 |
| 动态归档 | 本机动态列表首批返回空集合 |

因此当前只是阅读／管理服务已启动，没有自动发现、15 秒检查或后台归档正在运行。没有目标记录可报告最近检查、pending 或 complete，不能把无配置当作“全部完成”。启动 API 不启动 collector。[app.py:45-70](../../backend/bili_monitor/app.py)、[collector.py:250-291](../../backend/bili_monitor/collector.py)。

核验使用 ss／ps 的监听和命令参数，以及本机 GET；没有调用管理写接口或同步入口。归档列表 GET 可能维护／创建分页快照，因此“阅读不触发上游采集”不等于该接口对 SQLite 完全零写入。[storage.py:366-400](../../backend/bili_monitor/storage.py)。

## 2. 系统分工

```text
浏览器 ──管理／归档 HTTP──> API ──> SQLite
   │                                  ↑
   └──公开业务图片 URL──> OSS          │
                                      │
独立 collector ──> B站信号／内容／分页 ┘
       └────────> 图片下载、OSS 上传
```

API 负责身份／配置管理、归档读取、显式运维同步入口，不含定时器。collector 负责目标发现、固定节拍检查、领取持久待处理工作和上传。生产页面读取 SQLite 归档，不因打开列表／详情而请求 B站同步；检查状态及发现状态由管理者手动重读，不自动轮询。[productionAssembly.ts:1-3](../../src/data/productionAssembly.ts)、[archiveReader.ts:151-246](../../src/data/archiveReader.ts)、[CheckStatusPanel.tsx:68-103](../../src/manage/CheckStatusPanel.tsx)、[DiscoveryStatusPanel.tsx:21-44](../../src/manage/DiscoveryStatusPanel.tsx)。

## 3. 配置与目标集合

### 新增 UP 和指定目标

新增 UP 不只是本地保存 UID：先请求公开资料接口取得昵称／头像，再保存身份和监控配置。默认配置是启用、近期模式、N=10。指定动态新增时读取来源校验作者；作者不符或无法确认不能强制关联。保存配置、启停和删除本身不启动 collector，也不自动完成首次归档。[app.py:95-158](../../backend/bili_monitor/app.py)、[profiles.py:10-41](../../backend/bili_monitor/profiles.py)、[management-api.md](../../docs/backend/api/management-api.md)。

身份、监控配置、目标集合和归档独立；配置不是归档的生命周期根。[storage.py:256-299](../../backend/bili_monitor/storage.py)、[selection.py:6-35](../../backend/bili_monitor/selection.py)。

### 近期模式

读取 UP feed，按来源 offset 翻页。合格规则沿用示例的 OR：作者徽章恰为“充电专属”，或 major 类型为 `MAJOR_TYPE_BLOCKED`。普通项／重复项不占 N，按来源顺序凑 N 个唯一合格 ID，或读到可信耗尽；不按前 N 条原始候选截断，不擅加图片／正文条件，不自动回填 UP 全历史。[discovery.py:26-122](../../backend/bili_monitor/discovery.py)。

只有整轮成功且配置／领取仍有效才发布新可信窗口；部分候选不是成功结果。失败保留旧窗口，改 N 后也先沿用旧窗口直到新发现成功。成功空窗口会移出旧成员。停用／切指定模式后保留旧可信发现，但近期成员不再入选；发现成功不等于内容已归档。[discovery_state.py:19-82](../../backend/bili_monitor/discovery_state.py)、[discovery-api.md](../../docs/backend/api/discovery-api.md)。

### 指定模式

仅选手工关联且校验通过的 ID，不附带近期发现集合。两种模式仅决定处理哪些动态，不缩减正文、评论、回复、动态图和一级评论图能力。[selection.py:6-32](../../backend/bili_monitor/selection.py)、[archive-api.md](../../docs/backend/api/archive-api.md)。

## 4. 固定节拍与并发

collector 先取得同数据库旁的 flock 锁，再迁移并恢复中断工作；进入循环立即有首轮，其后按单调时钟固定每 15 秒触发。不是“同步结束再等待 15 秒”；进程错过的槽不追赶。[collector.py:28-55,182-247](../../backend/bili_monitor/collector.py)。

独立默认并发上限：检查 4、归档同步 4、近期发现 2。发现按 UID、检查／同步按目标轮转，减少头部偏置。同目标上一检查未退出则跳过本槽；容量不足也跳过，不积压检查。同步运行不等于检查忙：两者可重叠，慢评论／上传不占检查池。[collector.py:58-70,194-236](../../backend/bili_monitor/collector.py)。

发现新成员后，还需后续检查登记观察，再由执行阶段领取，不由发现任务直接归档。不保证新目标立即处理或每目标每槽都完成，15 秒不是全量完成时限。[collector.py:98-180,216-236](../../backend/bili_monitor/collector.py)。

`--once` 仅逐个检查现有启用目标、再逐个发现近期 UP，不执行 pending 归档、不启动循环。[collector.py:250-265](../../backend/bili_monitor/collector.py)。

## 5. 检查只看什么

每个目标先核验当前入选资格，然后：

1. GET 普通 opus HTML；安全 JSON 解析 `__INITIAL_STATE__`，按 AUTHOR 模块校验动态／作者并取编辑信号，不执行 JS。
2. 有可解析的“编辑于”时间才是可信编辑版本，保留来源分钟精度和时区；无标记为 unknown，无效日期／格式为 error，均不等于确认未编辑。不用 pub_ts 或正文／图片差异判断编辑。
3. 复用持久 `comment_locator`；缺失时用通用 detail 校验作者并取 `basic.comment_id_str/comment_type`，不猜评论 oid。
4. GET 独立 `/x/v2/reply/count`，严格接受非负 JSON 整数，不接受 bool／字符串／小数。网页 STAT、detail、根页 count/acount、本地条数不能代替该观察。
5. 再核验入选资格，持久合并可信观察、错误、时间及待处理状态。

依据：[collector.py:98-140](../../backend/bili_monitor/collector.py)、[source.py:34-119,222-245](../../backend/bili_monitor/source.py)、[root_comments.py:10-24,65-79](../../backend/bili_monitor/root_comments.py)。

编辑和计数分别成功／失败：一路失败不会清掉另一路新可信值，也不覆盖旧可信值。检查聚合可 failed，同时仍登记另一路变化。首次观察建立 revision；可信编辑版本或独立评论总数改变才推进 revision，普通相对时间自然变化不推进。[checks.py:12-42,112-160](../../backend/bili_monitor/checks.py)。

## 6. 什么时候同步什么

| 条件 | 自动执行行为 |
| --- | --- |
| 首次纳入 | 初始化实际可读正文、根回复、两类媒体；无编辑标记也不跳过 |
| 可信编辑版本变化 | 正文与动态图；已完成评论不因正文编辑默认重扫 |
| 可信来源总数变化 | 根评论、必要回复及一级评论图；匹配版本的已成功正文可跳过 |
| 信号不变且全部完成 | 只检查，不反复全量抓内容 |
| 信号不变但存在失败／未完成 | 继续处理持久 pending，无需再次产生变化 |
| 只剩图片未完成 | 跳过已完成正文和评论文本，只处理未成功媒体 |
| 正文受限／编辑信号未知 | 仍可处理实际可读评论；不承诺绕过任何权限 |

自动执行领取 revision、观察快照、claim token、入选代次，再领取归档 generation。实际顺序为正文 → 根评论 → 必要楼中楼 → 动态图 → 逐根评论图；每部分独立短事务提交，不是等全部图片成功才提交文本。正文与 HTML／detail 元数据可独立保留，detail 的摘要不冒充全文。[collector.py:142-180](../../backend/bili_monitor/collector.py)、[sync.py:36-92](../../backend/bili_monitor/sync.py)、[storage.py:409-528](../../backend/bili_monitor/storage.py)。

显式 `/api/sync/initial` 是运维／测试入口，不从页面挂载或刷新调用；其策略与自动 pending 跳过规则不同，不能把它当生产页面自动采集按钮。[app.py:160-178](../../backend/bili_monitor/app.py)、[archive-api.md](../../docs/backend/api/archive-api.md)。

## 7. 根评论和楼中楼分页

根评论按可信 locator 请求 `/x/v2/reply`，ps=20、pn 递增；包含首屏置顶／热评去重，不拿内嵌三条回复当完整楼中楼。短页也不直接终止，读至明确空页；非首屏候选空尾页复查一次。页计数变化、重复／不前进、字段或请求失败均不宣布成功；逐页已取得内容保留。[root_comments.py:82-163](../../backend/bili_monitor/root_comments.py)。

逐根楼中楼请求 `/x/v2/reply/reply`，同样 ps=20。只有本轮根响应明确回复数为零才跳过，旧零／未知不能冒充本轮零。回复也读到空尾并复查，需满足本轮唯一回复数与该根 count 一致；一根失败不阻断其他根，但整项回复不能宣布完成。[replies.py:53-100](../../backend/bili_monitor/replies.py)。

根、回复各自 checkpoint 成功不互相代替，整轮必要根回复完成后才推进 synced_comment_count。来源总数、本地根数、本地回复数及页面已加载条数不同，不要求强行相等。未知不是零，失败不清旧内容。来源分页不是事务快照，计数不变的移动仍可能漏检。[storage.py:635-800](../../backend/bili_monitor/storage.py)、[archive-api.md](../../docs/backend/api/archive-api.md)。

## 8. 图片如何处理

归档动态图和一级评论图，不扩展回复图。按各自 owner／来源顺序／尺寸登记来源，下载后上传 OSS，只有成功并通过 URL 校验才发布 public_url。媒体失败不使正文、评论文本 checkpoint 倒退。[media.py:14-28,92-126](../../backend/bili_monitor/media.py)、[storage.py:533-605](../../backend/bili_monitor/storage.py)。

新组替换旧组时，旧成功媒体保留在 previous_media，不冒充新组上传完成；相同版本关联可复用，成功项不重传，新版本即使 URL 相同也建立新关联。每次上传有独立 attempt token 和对象 key，拒绝旧尝试覆盖新组／新尝试。[media.py:49-69](../../backend/bili_monitor/media.py)、[storage.py:559-605](../../backend/bili_monitor/storage.py)。

无 uploader 的有图目标不尝试上传，媒体保持 pending。明确无图可成功空；评论 pictures 缺字段不等于确认无图，明确空数组才是确认。浏览器直接读取完整公开 OSS URL，未上传不回退 B站业务图；头像与业务图区别对待。[media.py:92-109](../../backend/bili_monitor/media.py)、[root_comments.py:53-62](../../backend/bili_monitor/root_comments.py)、[archive-api.md](../../docs/backend/api/archive-api.md)。

## 9. sleep 的准确作用范围

| 请求 | 每次发送前等待 |
| --- | --- |
| 动态 feed 首页／后续页 | 随机 0.8–1.5 秒 |
| 根评论首页／后续页／空尾复查 | 随机 0.3–0.4 秒 |
| 楼中楼首页／后续页／空尾复查 | 随机 0.3–0.4 秒 |

同一 PacedSourceTransport 实例共用 asyncio.Lock，只包发送前的异步 sleep；网络调用在锁外。避免并发任务各自同时 sleep 后同时发出请求，不串行化整段网络响应。[source_transport.py:11-36](../../backend/bili_monitor/source_transport.py)、[source_endpoints.py](../../backend/bili_monitor/source_endpoints.py)。

它不是全部请求的全局限速器：HTML、detail、独立计数、资料请求不在分页等待表，图片下载用独立客户端。API 与 collector 各自有 transport／锁，不跨进程协调。不会自动退避，不保证不被限流，不接飞书。[app.py:53-60](../../backend/bili_monitor/app.py)、[collector.py:250-257](../../backend/bili_monitor/collector.py)、[collector-api.md](../../docs/backend/api/collector-api.md)。

## 10. 失败、新旧观察与重启

观察成功不等于归档成功。observed 保存最近可信信号；revision 表达观察代次；synced checkpoint 只表达实际成功处理版本；归档 generation 防旧正文／根回复写回；claim token 区分同 revision 重试；入选 token 防停用后重纳入时旧资格复活；媒体 attempt token 单独隔离逐图提交。[checks.py:236-279](../../backend/bili_monitor/checks.py)、[storage.py:409-605](../../backend/bili_monitor/storage.py)、[selection.py:15-35](../../backend/bili_monitor/selection.py)。

例如处理版本 A 时检查到 B：B 的观察／pending 仍保留，A 完成只能确认 A 的实际结果，不能吞掉 B。正文实际拿到的版本也不能套用领取时较旧版本。[sync.py:36-92](../../backend/bili_monitor/sync.py)、[checks.py:259-279](../../backend/bili_monitor/checks.py)。

停用、删配置／指定目标、切模式不再入选及窗口移出：阻止新检查／新领取，保留身份、归档、媒体和未完成工作。失效检查不登记旧结果；已领取归档允许整条链结束并保存正确内容，但旧资格不能标记新资格 complete。重新纳入可续做。[collector-api.md](../../docs/backend/api/collector-api.md)「29 在途配置代次与重纳入」。

只有持锁的正式 collector 重启会把残留 running 恢复 pending 并重新领取；API 重开或状态 GET 不恢复／执行任务。网络、下载、上传都不放在 SQLite 长事务中。[collector.py:42-56,182-193](../../backend/bili_monitor/collector.py)、[checks.py:259-279](../../backend/bili_monitor/checks.py)。

## 11. 管理状态如何阅读

检查层与同步层分开：unchecked 未检查；checked 新观察已登记；unchanged 未登记新版本而非归档完成；failed 至少一路信号读取失败。同步层 running 为正在执行，complete 为对应观察工作完成，pending 可是尚未处理、部分成功或失败待重试，结合五个 parts 和错误判断。[CheckStatusPanel.tsx:8-65](../../src/manage/CheckStatusPanel.tsx)、[collector-api.md](../../docs/backend/api/collector-api.md)。

最近检查与实际整轮成功时间独立；正文、动态图、根、回复、评论文本整轮、评论图也有各自实际成功时间。失败／新 pending 可以与旧成功时间并存，旧缺字段不补造。UP 卡片两项时间为历史目标记录的最大值，不代表 UP 所有目标完成。媒体错误只展示固定下载／上传失败码，HTTP 200、发现成功、正文成功都不能冒充整轮完成。[CheckStatusPanel.tsx:43-65,88-95](../../src/manage/CheckStatusPanel.tsx)、[storage.py:215-247,488-624](../../backend/bili_monitor/storage.py)。

complete 仍不是“保证拥有来源全部历史评论”：它表示这次可处理观察下按既定分页协议完成了工作，来源计数口径、权限与并发分页限制仍在。[archive-api.md](../../docs/backend/api/archive-api.md)。

## 12. 当前能力边界与下一步

- 生产 B站接入当前为公开 HTTPX 页面／接口请求，没有 Cookie／SESSDATA／账号登录态或 WBI 签名注入。不能把示例脚本的登录能力视为已接入；需要登录权限的内容不保证可读，sleep 不解决身份／签名／权限问题。[profiles.py:10-41](../../backend/bili_monitor/profiles.py)、[source.py:63-66,222-236](../../backend/bili_monitor/source.py)、[backend/README.md](../../backend/README.md)。
- OSS 支持服务端 BILI_OSS_* 配置与 V4／STS 上传签名；全部缺失允许启动但不上传，必需项配置不完整则拒绝启动。本次未读环境值，不能判断本机是否已配置或凭据有效。[oss.py:14-53](../../backend/bili_monitor/oss.py)。
- 管理／API 无鉴权；当前只监听回环。若以后开放公网，不能把页面隐藏或本次本机运行当成访问保护。[management-api.md](../../docs/backend/api/management-api.md)。
- 可信编辑仅分钟精度；评论总数不变的纯编辑／增删抵消可漏检。没有全历史自动回填、每日校准、内容／图片哈希比较、自动退避或跨进程全局限速。[collector-api.md](../../docs/backend/api/collector-api.md)。
- 自动化及有限历史样本不代表当前真实匿名访问、全权限、自然编辑、OSS 可用或长期稳定；真实部署／真机／持续运行仍归 #31–#34。[acceptance-30.md](acceptance-30.md)、[backend-feasibility.md](../../docs/backend/evidence/backend-feasibility.md)。

真正开始自动监控还需要先保存 UID／模式／目标，再启动指向 API 同一 SQLite 的 collector；如需完整图片归档，还要有可用的服务端 OSS 配置和实际可访问来源。本轮仅梳理，没有替用户执行这些操作。
