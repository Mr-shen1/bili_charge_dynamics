# 26 来源计数、本地归档与评论同步状态：实施与自动化证据

## 交付范围

对应 [26 票](issues/26-comment-sync-status.md)、父 [09](issues/09-comment-change-sync.md)、规格故事 15、32、33、43、53–57、60，I4/I6/I8/I10，已确认 T1/T2/T3 seams。扩展已有 API、生产 Adapter、管理状态组件和详情评论区，不增加手工采集按钮、凭据 UI、分析面板或上游策略。

- 管理/详情分开表达来源总数、本地根数、本地回复数；详情另显示当前已加载根数。未知 `—`、真实零 `0`，整数不缩写，不用本地数代填来源。
- 归档详情 `comment_sync` 与管理 checks 共用同一持久状态投影。最近检查、计数读取失败、实际根/回复/整轮成功时间、各分项及脱敏错误独立；检查无变化不推进同步时间。旧归档未知时间返回 null，不补造历史。根/回复页失败保留成功部分、旧内容、可信数和 checkpoint。
- 评论文本完成不等于图片完成；正文受限/网页无权不推断评论不可读。HTTP 成功、成功空批和本地分页终点均不宣称拥有完整来源；生产终页为“本地归档评论已读完”。
- 只读状态刷新 GET detail，不采集、不替换正文、不重读评论、不清排序/展开/已加载范围/cursor/阅读锚点；读取失败保留旧状态，忽略取消的迟到成功/失败不能覆盖新访问。
- 保持 #25 初始化/失败重试/计数变化策略；总数增删抵消、纯评论编辑或分页移动而总数不变可能漏检。UI 明确不保证实时、完整来源或所有受限评论可读。媒体全链路/目标聚合仍归 #30。

接口真值更新于 [collector-api](../../docs/backend/api/collector-api.md#26-评论分项状态与时间)、[archive-api](../../docs/backend/api/archive-api.md#26-评论状态读取增量)、[archive-api-client](../../docs/backend/api/archive-api-client.md#26-增量评论计数与同步状态)。无需新 schema migration：新增分项时间/错误保存于既有归档文档，旧冻结 cursor 不改写/不失效，旧档案和本地评论仍保留。

## T1/T2/T3 核验

| 要求 | 自动化证据 |
| --- | --- |
| API→生产 Adapter→计数/状态/时间/安全文案 | `tests/manage-checks.test.tsx` 13 项；`tests/comment-sync-status.test.tsx` 10 项；原 `archive-reader.test.ts` 32 项回归 |
| 来源大于本地、未知/零、部分失败/成功空、正文受限可读 | `backend/tests/test_comment_sync_status.py` 10 项；#25 count/recovery 专项；实际浏览器同一 SQLite 来源 501/根 45/回复 20→25 |
| 分项成功时间真实且失败/无变化不补造 | 新后端专项在受控 Clock 经 Collector 公开入口观察 HTTP；管理/阅读 RTL 分别检查时间和独立错误 |
| 无新计数重试、重开、冻结旧 cursor 保留 | 新后端专项、旧计数/编辑/迁移/根回复/媒体专项；浏览器 fixture runner 公开执行 Collector，再重开同一 SQLite |
| 状态刷新不采集/不清评论/不换正文、不串访问 | RTL 忽略取消的旧访问成功/失败；真实 API 浏览器保持最新排序、40 根、文字展开、评论 25 的视口锚点，并检查仅 GET、不请求评论分页、不增加上游调用 |
| 排序/分页/局部故障/导航恢复及管理草稿 | 保留全量 Vitest、归档/管理/mock Playwright 回归，旧终页仅改清晰文案，不削弱分页断言 |

实际 API/生产 Adapter 浏览器装配、fixture 路径、控制 socket、红绿过程详见 [浏览器专项](evidence/comment-status-browser-26.md)。Socket 仅测试装配，本机私有，不进入生产 API；原始 HTML/JSON 经生产解析、Collector 和真实 SQLite，不用手工 SQL 编造状态或另一份假 Adapter。

## Red → Green 与回归修正

按垂直切片先测试再实现：详情 `comment_sync` 映射；独立计数/部分失败与图片待处理；保留评论的只读刷新；正文/媒体 running 不冒充已完成评论正在同步；分项时间/错误展示。后端首片因缺根尝试/分项时间 red，再逐片验证失败保留、无信号重试、未知/零、受限正文、在途新观察与旧 cursor。管理按计数映射/严格 DTO、独立进度和分项时间/错误逐片 red→green。

浏览器曾因新增根/回复错误码与客户端封闭集合不一致出现真实读取/刷新 red，统一协议后 green；装配调试（头像 URL、回复批量、HTML JSON 转义）不算产品 red。详细过程见专项记录。

旧后端 whole-Archive 相等断言与新增实时投影冲突：只排除 `comment_sync` 进行持久内容完整比较；旧固定归档显式检查新增 null 时间/错误；旧冻结 cursor 仍保持原样完整比较。真实再次根分页成功可更新根成功时间，失败仍保留旧成功时间，不能通过删保留断言掩盖失败。初次并行全量出现 CLI 启动等待失败，单文件和后续串行全量通过，原 timeout 未放宽。

## 最终命令与结果

Node `24.21.0`，pnpm `10.34.6`，Python `3.12.15`；Node 命令先 `source "$HOME/.nvm/nvm.sh" && nvm use`。本机 HTTP proxy 必须绕过 localhost，未停止无关进程。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck`（开发中多次） | 通过 |
| `pnpm test --maxWorkers=2` | 23 文件，251 passed |
| `uv run pytest backend/tests -q`（修正契约后串行） | 373 passed，3 条依赖弃用警告 |
| `NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= pnpm test:e2e:archive --reporter=line` | 36 passed |
| 同样 proxy 环境 `pnpm test:e2e:manage --reporter=line` | 7 passed |
| 同样 proxy 环境 `pnpm test:e2e --reporter=line` | 104 passed，10 按既有项目配置 skipped |
| `pnpm build` | 通过 |
| `git diff --check` | 通过 |

本机过程日志：`/tmp/26-unit-final.log`、`/tmp/26-backend-regression-full.log`、`/tmp/26-e2e-archive-final.log`、`/tmp/26-e2e-manage-final.log`、`/tmp/26-e2e-mock-final.log`；临时日志不作为跨机器依赖，仓库内测试/fixtures 和本记录可复现。

## 与父 #09、#25 的核对

#25 提供独立计数/可信 observed、计数触发完整根回复分页、失败重试/版本交错/重启；#26 提供这些公开状态到生产 Adapter/管理/阅读 UI，补上父 #09 的可观察计数、同步进度、时间/错误与阅读保留。未重写 #25 触发策略，不加入每日校准、内容比对、旧 ID 截断或全历史回填。评论图片全链路和全分项聚合仍由 #30 收口，不能据此勾选父票全部 AC。

## 审查与未验证

Standards/Spec 双轴审查结果在完成审查后追加。自动化通过不代表人工验收或生产持续运行。

未访问真实 B站、Cookie、仓库外凭据或 OSS；所有秘密标记均虚构。来源独立 count 是否在所有接口/权限下精确包含根＋全部回复仍承接 #25/#34 的待人工证据，不用 501 fixture 或历史 235/501 相等宣称已实测普遍口径。未做真实云上传、Linux Chrome 人工签收、iPhone Safari 真机、部署、实际规模持续节拍或 2GB 容量验收。页面不保证实时、完整来源或所有受限评论可读，父 #09/#12 全部 AC 不自动收口。
