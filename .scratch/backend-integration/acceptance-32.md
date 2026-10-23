# #32 本期自动化回归与 AC 验收台账

执行日期：2026-10-16；票据：[32](issues/32-automated-acceptance.md)。需求真值：[SRS §9](../../docs/product/SRS.md#9-验收场景与需求追踪)、[本期规格／已确认 T1–T3](spec.md#测试决定)、[执行分工](implementation-plan.md)。

**结论：本票的自动化执行与台账已交付，等待维护者复核；不能宣称完整验收。** #33 正式 Linux Chrome／iPhone Safari 的完整证据、#34 授权上游／实际 OSS／持续运行及资源证据仍未取得；AC-31 没有正式一比一视觉签收。2026-10-18 补入 [#33 人工记录](acceptance-33.md)：iPhone Safari 两轮十项、Linux Chrome C1–C6 六项经用户反馈通过；随后续验 M2 两端报告收起未回所属根评论（F-33-01，原失败保留，修复后已取得两环境正常的用户反馈），其余本轮操作正常，见独立记录 §8。以下相关行仍为未验证，不将本次补证冒称为 #32 自动化基线的新增实测。首次视觉专项失败及随后复测均保留，不以测试文件存在、历史同号 AC 或本记录完成代替功能通过。不勾选父 #12。

## 1. 本次版本、环境与安全边界

- 代码基线：`769da3d79250a0e748e8b0a539ca7082bc42879b`（`feat/backend-integration`，#31 交付之后，包含 #35）。本次仅新增验收记录／运行助手／产物并更新票据及索引，没有改变产品、测试断言、数据库或部署实现。日志逐命令记录该 source commit、起止时间及退出码。
- Linux `7.2.9-2-cachyos x86_64`；nvm Node `24.21.0`、pnpm `10.34.6`、uv `0.12.23`、Python `3.12.15`；FastAPI `0.115.12`、pytest `8.4.2`；Playwright `1.58.2`／Chromium `145.0.7632.6`；临时编译 Nginx `1.28.0`。版本、lockfile 和生产产物 SHA-256 见 [environment.log](evidence/automated-32/environment.log)。本机不是 2 核 2GB 的资源验收环境。
- 测试命令通过 [run.sh](evidence/automated-32/run.sh) 的 `env -i` 白名单执行，只保留 HOME／PATH／固定语言时区／回环 NO_PROXY／显式 Nginx 路径；不继承 BILI／OSS／数据库／代理／开发 fixture 环境配置，不加载 `.env`，不读取仓库外凭据。未安装新依赖、下载工具、采购或操作真实部署。
- T2/T3 和浏览器穿透使用生产 FastAPI／Collector／临时真实 SQLite／生产 Adapter，外部来源、媒体下载及 OSS 上传是固定虚构传输；HTTP DTO 替身布局测试与实际本地 API 穿透另列。没有真实 B站／OSS 请求或持续采集。两份用户原有未跟踪 Markdown 未读取、修改或纳入交付。
- #31 隔离双进程与 Nginx 已交付，票面 `ready-for-human`；#35 已有实现、用户预览认可及提交，但票面仍为 `ready-for-agent`。本票基于当前已提交交付物执行，不代维护者修改 #35 状态或签收依赖。正式设备／像素签收不由预览认可推定。

## 2. 实际执行结果与复现

所有测试原始输出在 [automated-32/](evidence/automated-32/)，[results.tsv](evidence/automated-32/results.tsv) 保留运行助手执行的每条测试／构建命令及每次重试，不只留最后成功。独立采集的环境／来源哈希与文档校验不计入该测试结果表，另在 E/K 中链接。日志只规范化运行器生成的 `command=` 元数据行末空格，实际测试 stdout/stderr 不改。以下次数存在跨命令重复，不能相加当作独立覆盖率。

| 证据 | 实际命令／方法 | 本次结果 |
| --- | --- | --- |
| Q | `pnpm typecheck`；`pnpm build` | 均退出 0；[类型](evidence/automated-32/typecheck.log)／[构建](evidence/automated-32/build.log) |
| B | `uv run --no-sync pytest backend/tests -q` | **669 passed，3 warnings**，125.65s；[全量输出](evidence/automated-32/backend-full.log)。警告为 Starlette/AnyIO alias 和 OSS SDK `utcnow` 弃用，不是真实 OSS 上传 |
| F | `pnpm test --maxWorkers=2` | **25 文件、268 passed**；[全量输出](evidence/automated-32/frontend-full.log)。沿 #31 限制并行，不修改断言或超时 |
| L | `uv run --no-sync pytest backend/tests/test_integrated_archive_lifecycle.py backend/tests/test_inflight_lifecycle.py backend/tests/test_versioned_edit_sync.py backend/tests/test_comment_count_sync.py -q` | **169 passed**；[生命周期专项](evidence/automated-32/targeted-backend.log) |
| P | `uv run --no-sync pytest backend/tests/test_deployment_processes.py -q` | **6 passed**；[双进程专项](evidence/automated-32/targeted-processes.log)，亦包含在 B 中 |
| M | `pnpm test:e2e` | **104 passed、10 skipped**；[mock／独立故障装配](evidence/automated-32/e2e-mock.log)。10 个是 Nginx-only，不记为通过，由 D 实际运行 |
| G | `pnpm test:e2e:manage` | **7 passed**；[实际本地 API 管理穿透／四宽度规则与键盘](evidence/automated-32/e2e-manage.log) |
| A | `pnpm test:e2e:archive` | **38 passed**；[生产 Adapter／DTO 替身及实际本地 API 穿透](evidence/automated-32/e2e-archive.log)，两类装配由用例名称和下表区分 |
| S | `pnpm test:e2e:preview` | **96 passed、10 skipped**；[显式 mock 构建／Vite preview](evidence/automated-32/e2e-preview.log)，不是生产 Nginx 或归档证据 |
| V | `pnpm exec playwright test --config playwright.visual.config.ts` | 首次 **1 failed、2 passed**；[失败原文](evidence/automated-32/visual.log)。串行同命令 **3 passed**；[复测](evidence/automated-32/visual-20261016T122828.log)。详情见 §5 |
| D | `NGINX_BIN=… NGINX_MIME_TYPES=… pnpm test:delivery` | **106 passed**，构建重现／fault 隔离／mock 更新／生产 API+Collector+SQLite／生产更新／脱敏扫描均通过；[完整输出](evidence/automated-32/delivery.log) |
| C | `bash .scratch/backend-integration/evidence/automated-32/capture.sh`（用 run.sh 调用） | 实际生产构建＋本地 API，**16 张四宽度全页图＋2 张区域图＋4 张对照／差异图**；[执行](evidence/automated-32/capture.log)／[截图条件](evidence/automated-32/visual/conditions.json)，无整图像素通过阈值 |
| Q2 | 全量测试后 `pnpm typecheck` | 退出 0；[类型检查](evidence/automated-32/typecheck-final.log) |
| Q3 | 12:39 再执行 `quality`（`pnpm typecheck`／`pnpm build`） | 均退出 0；[类型](evidence/automated-32/typecheck-20261016T123949.log)／[构建](evidence/automated-32/build-20261016T123952.log)。用于验证运行助手的本阶段退出码与落盘逻辑，无产品改动；D 已在 12:32 恢复生产构建，不是靠此轮补救 |
| E | 环境版本／锁文件与构建、参考 PNG 的 SHA-256；`git diff` 产品路径核对 | [环境](evidence/automated-32/environment.log)／[来源与恢复后构建哈希](evidence/automated-32/provenance.log)；代码差异为空；本次 Nginx 的实际可执行路径见复现命令 |
| K | `uv run --no-sync python` 文档结构／本地链接检查 | [首次校验](evidence/automated-32/validation.log)：34 行与 113 链接；[review 后复核](evidence/automated-32/validation-final.log)：AC 顺序唯一完整、全部本地链接及 17 个运行结果与日志一致、22 PNG 留存（不含锚点语义校验） |

实际首次 targeted 与 quality 均于 12:23:14 启动，后端 pytest 与 tsc/Vite build 并行；首次 M 与 V 也曾并行，失败见 §5。随后浏览器／构建套件按顺序执行。下面是**建议的安全复测顺序**，不冒称首次执行已经全串行；实际调度以各日志时间戳为准。

复现前按[正式交付说明](../../docs/deployment/static-delivery.md)准备锁定依赖、Chromium、Nginx/mime.types；本次依赖已在本地，`uv --no-sync` 不同步依赖。运行助手不负责安装。**各阶段顺序运行**，不要让不同 Vite 模式、构建或 Playwright 输出目录并发；管理与归档测试 API 都会用 4176。已有端口占用时记录环境失败，不停止他人服务。

```bash
# 仓库根目录
source ~/.nvm/nvm.sh
nvm use
runner=.scratch/backend-integration/evidence/automated-32/run.sh
bash "$runner" targeted
bash "$runner" quality
bash "$runner" browsers
bash "$runner" visual
bash "$runner" preview
# 本次复用 #31 用户临时编译产物；其他机器按正式文档准备，不依赖 /tmp 永久存在
NGINX_BIN=/tmp/bili-31-nginx/nginx-1.28.0/objs/nginx \
NGINX_MIME_TYPES=/tmp/bili-31-nginx/nginx-1.28.0/conf/mime.types \
bash "$runner" delivery
# D 结束恢复生产 dist；若 D 失败，先重新执行 quality，不能截 mock 产物
bash "$runner" capture
bash "$runner" full
```

每个阶段即使有命令失败也继续记录同阶段其余命令，最后以该阶段失败状态退出；重跑日志另加时间戳，旧失败不删除。`capture` 需要维护者另行提供 ignored 的两张当前参考 PNG（默认 `docs/assets/ui-reference/current-35/`）；缺图应按原截图脚本的 `needs-info` 失败，不用实现截图自建基准。原图不强制纳入 Git。临时预览仅回环 19080／19443，全新临时库／自签证书，无周期任务；[服务日志](evidence/automated-32/preview-server.log)确认两监听均正常关闭。接受自签证书只限本地 fixture，不是生产 TLS 策略。

## 3. T1／T2／T3 与全流程覆盖

以下是运行结果的定位，不是另一套产品 AC。测试路径均相对仓库根目录。

| 行为／已确认入口 | 实际观察方法与执行证据 |
| --- | --- |
| 全部／单 UP → 卡片顶部／气泡评论 → 详情 → 动态图／评论图 → 排序 → 回复 → 返回 | T1：M 的 `cross-device-acceptance.spec.ts` 在 360/390/768/1280 全流程；A 的 `scope-navigation`、`media-reading`、`comment-media-reading`、`root-comments`、`replies` 使用生产 Adapter。A 的 `scoped.spec.ts`、`archive.spec.ts`、`media-live.spec.ts`、`archive-lifecycle.spec.ts` 是实际本地 API＋临时 SQLite 穿透；不把其他 DTO 替身用例称作真实归档 |
| UID 身份、默认／独立 N、互斥模式、指定归属、启停／删除、窗口、独立草稿 | T1/T2：G 的真实 API 重启／删除保留、键盘失败重试；F 的 `manage-{api,page,target,discovery,checks}`；B 的 `test_management.py`、`test_recent_discovery.py`、`test_recent_window_lifecycle.py`。传输虚构且真实持久化，不是 UID 上游可用性实测 |
| 编辑 → 动态图；计数 → 根回复与评论图；正文受限／分项失败／无新信号重试 | T2/T3：L 的原始 HTML/JSON 经实际执行入口；A 的 `archive-lifecycle.spec.ts:141`、`comment-status.spec.ts`、`media-live.spec.ts` 经 Collector／SQLite／HTTP／Adapter 观察，不以评论成功当整轮成功 |
| 固定 15 秒、忙跳过、慢同步不阻检查、版本交错／checkpoint、重启／在途配置变化 | T3：B/L 的 `test_collector.py`、`test_inflight_lifecycle.py`、`test_versioned_edit_sync.py`、`test_comment_count_sync.py`；P 真实独立 API／Collector 共享库，包含阻塞、第二采集拒绝、API 重启不领取 running、采集 SIGKILL 后恢复。秒级受控时钟与有限进程测试不是长期运行证据 |
| 字符串 ID、scope/cursor／迟到结果隔离、完整集合排序与分页 | F 的 reader／RTL，B 的 `test_scoped_archive.py`、`test_root_comments.py`、`test_replies.py`；A 的真实 SQLite/HTTP 测试验证动态 10/10/5、根评论 20/20/5、回复累计 3/13/23/25，数据库重开及局部原批重试 |
| 四宽度、触控约 44px、可见键盘焦点、六行／详情全文、绝对时间／分钟精度 | M/A/V/G 的真实浏览器排版、键盘、图像历史和手势模拟；G `manage-visual.spec.ts` 四宽度＋Enter／独立草稿。M `cross-device-acceptance.spec.ts:120` 改 UTC 仍显示北京时间秒值；B `test_versioned_edit_sync.py`、F reader／checks 验证分钟编辑精度不伪造秒。阅读页已按 #35 用户反馈移除归档信息块，不能宣称其中编辑时间仍可见 |
| 禁止旧入口、转发／独立评论页／真实写回；图片按需与 owner／原 URL | M/A 的卡片内操作隔离、同页评论 tab、预览及 URL／归属／无来源回退；D 的生产读取仅 GET、无上游调用；F 生产装配与安全文本测试。没有新增真实点赞／发布／购买能力 |

## 4. AC-01–AC-34 台账

**状态规则：** 每行“通过”只针对该 AC 明确所需且本次已取得的证据，不推定其他行／环境通过。有一项必需类别缺失，整体即“未验证”；实际失败另保留为“失败”，复测不抹掉首次记录。自动化成功不证明上游稳定、云交付或真机兼容。AC-20 主责是自动化回归；AC-34 主责是如实分层记录，二者通过也不表示 #33/#34 已完成。

类别：**自**＝本次 T1/T2/T3 自动化；**部**＝隔离双进程／Nginx 部署；**机**＝#33 正式浏览器／真机；**源**＝#34 授权上游／真实 OSS；**续**＝#34 实际规模持续运行／资源；**视**＝#35 基准与正式人工视觉签收。没有列出的类别不由本行新增要求；正式兼容统一还受 AC-16/31 约束。证据字母对应 §2 的可点击原始输出；执行票编号按 [implementation-plan](implementation-plan.md#子票索引)定位。

| AC／需求简述 | 需求编号；执行票 | 分类结果、整体状态及原因／证据 |
| --- | --- | --- |
| AC-01 信息／选择条／作者 ID 的 UP 标识，无真实写回 | FR-01、DR-01、NFR-04；#13/#14/#16/#18/#35 | **通过**：自通过。F、A 的 scoped/root-comments/replies，M；无简介／关注等新增功能 |
| AC-02 整卡／键盘到顶部、气泡到同页评论，内操作隔离，无查看详情 | FR-01/02/10、NFR-02；#14/#16/#18/#20/#22/#35 | **通过**：自通过。M card-entry、A scope-navigation/detail-layout、F；正式兼容仍受 AC-16 约束 |
| AC-03 实际六行折叠、详情全文、安全长词与换行 | FR-03、NFR-01；#14/#16/#18/#35 | **通过**：自通过。M continue-reading、A root-comments/replies/detail-layout，含宽度改变重测 |
| AC-04 北京时间／编辑分钟精度／独立计数、未知不等于零 | FR-04/12、DR-01/05；#24/#26/#30/#35/#34 | **未验证**：自通过（F/B/L/M/A）；源未验证，不同页面编辑字段与总数口径待 #34。#35 已取消阅读归档文字，分钟精度证据来自解析／API／管理，不冒称阅读页编辑时间展示已签收 |
| AC-05 scope 全集排序后动态 10/10/5 | FR-05、DR-02；#13/#14 | **通过**：自通过。F scoped-reader/archive-app、B scoped archive、A scoped；结束不再请求 |
| AC-06 根评论全集两排序及 20/20/5 | FR-06、DR-01/02；#15/#16 | **通过**：自通过。B root comments、F archive reader/app、A root-comments:45 |
| AC-07 切换重置，乱序不污染，失败原位重试 | FR-06/11；#16/#18 | **通过**：自通过。F comments/discussion-history、M fault/comments、A root-comments |
| AC-08 回复正序累计 3/13/23/25，收起定位根评论并复用 | FR-07；#17/#18/#33 | **通过（本次操作范围）**：读取／缓存／累计顺序由自动化证据支持；F-33-01 的4项浏览器回归先红后绿，修复 `d2bbeef` 后，本轮人工仅对给定的两设备／两排序定位复测说明范围整体反馈“正常了”（[#33 §10](acceptance-33.md#10-f-33-01-修复后人工复测正常)）。原失败保留，不冒称逐动作独立观察或整个 #33 通过 |
| AC-09 单／四／其他／超九图，全部图片可达 | FR-08；#19/#20/#21/#22/#35 | **通过**：自布局／功能通过。M 四宽度、A media-reading/comment-media-reading/image-layout；像素对齐另见 AC-31 |
| AC-10 正确图片组／序号、长图、键盘／手机滑动及边界 | FR-09、NFR-02；#20/#22/#33 | **未验证**：自通过（M/A）；[#33 I-06–I-09](acceptance-33.md#3-人工操作记录第二轮图片与手势) 补入 iPhone 图序／横向滑动／单张长图等用户反馈通过。[Chrome C2–C4](acceptance-33.md#4-人工操作记录linux-chrome-c1c6) 的键盘、图组及长图整项反馈通过（非逐动作独立观察）；续验 M4（两端混合图组）、M6（iPhone 评论图指定序号／历史）已反馈正常，整体仍未完整签收 |
| AC-11 手机返回先关预览，位置／焦点／底层滚动 | FR-09/10、NFR-02；#20/#22/#33 | **未验证**：自通过（M mobile-image-history、A 两类媒体）；[#33 I-07–I-09](acceptance-33.md#3-人工操作记录第二轮图片与手势) 补入 iPhone 动态图后退先关／前进恢复、评论图关闭回位置、单张长图关闭后底层位置保持的用户反馈；[Chrome C2–C4](acceptance-33.md#4-人工操作记录linux-chrome-c1c6) 作为桌面补充，按 C2–C4 整项反馈记录焦点、图组／历史及关闭回位置，不替代手机验收；续验 M6 的 iPhone 评论图独立历史也反馈正常；[#33 Q4](acceptance-33.md#11-linux-环境补齐与管理可见布局反馈) 又补入手机长图打开期间整页不跟随的整体体验反馈，非滚动坐标独立测量；iPhone 关闭焦点等尚未完整签收 |
| AC-12 多批／展开／访问历史恢复，主动入口优先 | FR-10；#14/#16/#18/#20/#22/#33 | **未验证**：自通过（F discussion-history、M/A）；机部分补证见 [#33 I-03、I-05](acceptance-33.md#2-人工操作记录第一轮基本导航与评论) 仅记录 iPhone 来源位置返回及单次回复展开的用户反馈，不等于访问状态完整恢复签收；[Chrome C1、C6](acceptance-33.md#4-人工操作记录linux-chrome-c1c6) 补入来源返回、小数据重复访问／刷新／主动滚动整项反馈通过；续验 M1／M3／M5 的两端多批／历史／刷新反馈正常；M2 报告两端收起定位问题 F-33-01；新增预期已确认、代码及专项自动化已修复，用户修复后复测正常见 [#33 §10](acceptance-33.md#10-f-33-01-修复后人工复测正常)，最终设备归档／签收仍在进行 |
| AC-13 四类深链、来源返回、空／未知／失败、断源保留 | FR-02/13/19、NFR-05；#13/#14/#30/#31/#33 | **未验证**：自／部通过（A/P/D）；[#33 I-03](acceptance-33.md#2-人工操作记录第一轮基本导航与评论) 补入 iPhone 在局域网 fixture 站点来源返回通过的用户反馈；[Chrome C1、C6](acceptance-33.md#4-人工操作记录linux-chrome-c1c6) 补入来源返回及详情刷新通过的反馈；两环境四类直达、空／未知／失败等尚未完整实测，不替代 Nginx 部署证据 |
| AC-14 区域级状态与重试、不重复，坏图不阻断 | FR-11、DR-02；#15–#22/#26 | **通过**：自通过。F、B、M fault、A comment-media-reading/comment-status 等；不依赖真实故障服务 |
| AC-15 缺字段兜底／纯图／纯文／真空态 | FR-12、DR-01；#14/#16/#18/#20/#22 | **通过**：自通过。F data/archive-reader/app/comment-images、A 两类媒体；无 undefined 泄漏 |
| AC-16 四宽度、44px／焦点，正式 Chrome/Safari 环境 | NFR-01/02；#35/#33 | **未验证**：自通过（M/A/G/V 复测、C 四宽度）；[#33](acceptance-33.md) 已登记 iPhone 13 Pro／iOS 16.4 和 Chrome 155.0.8059.39；iPhone 两轮十项及 Chrome C1–C6 六项操作反馈通过；后续功能轮反馈见独立记录，不把 M2 定位作为本行通过依据；桌面键盘焦点已有 C2 整体反馈，iPhone 关闭预览焦点未独立观察；[#33 §11](acceptance-33.md#11-linux-环境补齐与管理可见布局反馈) 已补齐当前 CachyOS／Linux 7.2.9-2-cachyos、Chrome1920×965／DPR1，并有两设备管理／可见布局的整体正常反馈；Safari 元数据、真机截图及正式布局签收仍未齐 |
| AC-17 mock 独立、真实 API Adapter／给定 OSS URL，只读按需 | DR-02/03、NFR-03；#13/#19–#22/#30/#31/#34 | **未验证**：自／部通过（F/M/S/A/P/D）；源的实际 OSS 上传／公开直取未验证。模拟上传不替代 #34 |
| AC-18 安全文本、无故障面板／浏览器凭据或采集，mock 无真实依赖 | FR-03、NFR-04；#02/#19/#21/#31/#32 | **通过**：自／部通过。F 安全文本与生产装配、B/P、D fault 隔离和 HTTP/UI/bundle/日志虚构秘密扫描；未检查真实秘密 |
| AC-19 可复现构建／Nginx 深链／API 与资源错误隔离 | FR-02、NFR-05；#31/#32 | **通过**：部通过（D）。实际 Nginx 106 项，生产和 mock 重建、真实 release B 更新／旧 hash 保留；不是云部署结论 |
| AC-20 本期阅读／失败／scope／管理／媒体／采集状态端到端自动化 | FR-02/05/06/07/09/10/11/14/15/16/17/18/19/20、DR-02/05；#13–#32 | **通过（自动化类别）**：F/B/L/P/M/G/A/S/D 完整输出及 §3 覆盖。V 首次失败和复测见 §5；不把本行转换成真机／上游／持续运行通过 |
| AC-21 全部全局排序分页、scope/cursor／访问／迟到隔离 | FR-01/02/05/10、DR-01/02、NFR-01；#13/#14/#30 | **通过**：自通过。F scoped-*、B scoped archive、A scope-navigation/scoped；选择条内部横滑不撑页面 |
| AC-22 UID 获取身份、独立配置／目标／状态持久化、无凭据 UI | FR-14、DR-04/05；#01/#23–#30/#35 | **通过（隔离功能）**：自通过（F/B/G/A）；资料仅虚构上游，证明成功／拒绝语义与真实存储，不声明真实 UID 服务可用。[#33 Q2／Q3](acceptance-33.md#11-linux-环境补齐与管理可见布局反馈) 已有给定配置、目标和状态操作的两设备正常反馈，不扩大为全部管理能力人机通过；正式管理视觉仍归 AC-31 |
| AC-23 原规则跨页凑 N／耗尽，无样本硬上限 | FR-15、DR-04；#27/#28/#34 | **未验证**：自通过（B discovery source/recent discovery/window、F manage discovery）；源的真实 feed 多页可用性未验证，交 #34，不从匿名历史样本推定 |
| AC-24 指定 ID 归属正确／不符／未知、模式不裁剪已有根回复 | FR-15/18；#01/#02/#15/#17/#21/#27/#28 | **通过（隔离功能）**：自通过（B management/window/root/replies/media、F targets、A archive）；真实权限／来源可用性另受 AC-28/34 约束 |
| AC-25 固定 15 秒／忙跳过／同步分离／重试重启／版本 checkpoint | FR-16、DR-05、NFR-05；#23/#24/#25/#29/#30/#31/#34 | **未验证**：自／部通过（B/L/P）；续未验证。有限受控节拍与进程恢复不能证明实际规模长期调度或 15 秒内全部同步 |
| AC-26 HTML 安全 JSON／AUTHOR 编辑时间、可信变化、未知保留 | FR-17/04、DR-05；#02/#24/#30/#34 | **未验证**：自通过（B/L）；源未验证，待不同页面和多次自然编辑；同分钟漏检是已接受限制，不加正文 diff |
| AC-27 来源计数变化才同步根回复、来源与本地分离、漏检限制 | FR-18、DR-01/05；#25/#26/#30/#34 | **未验证**：自通过（B/L/F/A）；源未验证，来源 count 是否根＋全部回复须 #34 核验。纯编辑／数量抵消漏检不宣称解决 |
| AC-28 正文受限不挡评论、失败不归零／清档／提前推进，分项恢复 | FR-16/17/18/20、DR-05；#15/#17/#19/#21/#23–#30/#34 | **未验证**：自通过（B/L/A）；源的真实权限／分页／媒体场景未验证。不能从一例 BLOCKED 首屏推断全量可读 |
| AC-29 停止／删除／切模式／出窗口／断源后保留，不再监控 | FR-19、DR-04；#13/#28/#29/#30 | **通过**：自通过（B/L、A archive-lifecycle:67/scoped、G），真实 SQLite 关闭重开；不是持续运行证据 |
| AC-30 动态／根评论图 owner、顺序／状态／重试／公开 OSS，无回退代理 | FR-08/09/12/20、DR-03/04；#19–#22/#30/#34 | **未验证**：自通过（B/F/A），部通过（D）；源的实际 OSS 未验证，mock URL 只证明边界和直取语义，不含回复图 |
| AC-31 阅读一比一基准／管理规则映射／裁剪与必要差异 | FR-01/02/03/04/14、NFR-02；#35/#32/#33 | **未验证**：自 V 首次失败→串行通过，A/G 几何／操作通过；视有 #35 基准＋C 当前对照，**未正式像素签收**；新增当前构建四宽度与可见评论／单回复区域材料见 [#33 §12](acceptance-33.md#12-当前构建四宽度截图与可见区域对照未正式签收)，两设备只有可见布局整体反馈、无真机截图或正式来源比对结论。详见 §5，不用功能通过代替视觉对齐 |
| AC-32 无鉴权／公开图风险、秘密服务端仓库外与脱敏，无虚构保护承诺 | NFR-04/05、DR-03/05；#19/#21/#30/#31/#32/#34 | **未验证（真实环境）**：自／部的虚构秘密与风险说明通过（B/P/D、§6）；源／实际部署凭据隔离与公开 OSS 风险核验待 #34。不能凭未读真实秘密宣称真实环境全安全 |
| AC-33 单 API＋独立采集＋SQLite、限定工具链、记录资源环境 | NFR-05；#31/#32/#34 | **未验证（资源）**：部通过（P/D），工具链见环境日志；续的实际起始规模及 2 核 2GB 评估未验证，交 #34，无容量承诺或 Redis/Celery/多 worker |
| AC-34 历史／样本／本期自动化／持续运行与资源分别记账 | FR-16/17、NFR-05；#32 主责，#33/#34 补证 | **通过（证据核验类别）**：本记录与 §6/7 分开标明已得／缺失／失败。源／机／续仍未验证；“记录通过”不是相应能力通过 |

以上“未验证”的 AC 待相应责任人补齐后才能整行改为通过。补证必须增加版本／日期／环境／方法／结果／证据链接并保留旧失败；若代码改动，复跑相关自动化及全量，不跨版本复制结论。

## 5. #35 基准、当前视觉材料及失败保留

- 正式规则：[UI 参考 §6](../../docs/design/ui-reference.md#6-当前页面量测与最新布局决定)；取材：[visual-35-live-reference](visual-35-live-reference.md)；实现及用户预览认可：[acceptance-35](acceptance-35.md)。首轮旧图基准保留为历史，不能取代最新两张图。当前列表主栏 724、详情 708／桌面内距 56，作者头像 48，根评论 40／回复 24；来源截图 DPR／缩放未知，按作者头像推定 0.5 等比归一，不冒称来源 DPR 已知。
- C 在本次生产构建上重新截取全部／单 UP／详情／管理，四宽度 360/390/768/1280，DPR1、缩放 100%、高度900、Asia/Shanghai；字体探测、主栏矩形和 16 处 `overflow=false` 见 [conditions.json](evidence/automated-32/visual/conditions.json)。图像及文案为虚构数据，业务内容不照抄来源账号。
- 当前对照：[列表并排](evidence/automated-32/visual/list-side-by-side.png)／[绝对差异](evidence/automated-32/visual/list-difference.png)、[详情并排](evidence/automated-32/visual/detail-side-by-side.png)／[绝对差异](evidence/automated-32/visual/detail-difference.png)。列表选择同类双图卡，保留两侧全部区域，仅右／底补白，不以实现较短高度裁掉来源结构；没有遮罩容器／图标／业务内容，没有自建黄金截图或全图像素“通过率”。
- 四宽度完整图：`visual/{list,scope,detail,manage}-{360,390,768,1280}.png`；例如 [390 列表](evidence/automated-32/visual/list-390.png)、[1280 详情](evidence/automated-32/visual/detail-1280.png)、[390 管理](evidence/automated-32/visual/manage-390.png)、[1280 管理](evidence/automated-32/visual/manage-1280.png)。**详情完整图包含根评论和首根的三条预览回复**（1280图已读图核对），但区域对照按来源图高度截取，仅有列表／详情两组差异图，**没有评论／回复各自独立、完整的来源保留区域对照样本**；不能声称评论／回复一比一视觉已覆盖签收。由 #35/#33 补区域对照和人工核验，AC-31 继续未验证。这些是 #32 当次对照材料而非正式视觉签收。2026-10-18 [#33 §12](acceptance-33.md#12-当前构建四宽度截图与可见区域对照未正式签收) 已为修复后的实际生产产物补16张四宽度截图，以及现有来源中可见根本体／单条回复／入口的独立区域对照（来源裁片及并排衍生品留本机临时目录）。已有可见区域的材料缺口据此部分补齐；来源只有1条可见回复而项目预览3条，未出现的三条组／展开25条不是必须自造的基准，也不据缺少这些样本否认单条区域可比。待核差异、字体／归一假设和真机截图／正式签收仍如实保留。
- 管理是**同风格规则映射**而非来源管理页像素复刻：浅青背景／居中主栏／白卡，身份头像昵称头部，表单→目标→检查／同步→操作的平面分区，cyan 当前项／pink 作者／浅分隔，页面不常驻风险横幅，独立草稿、约 44px 控件、可见焦点及 Enter 操作。C 保留管理完整截图并手动读取实际虚构 API 检查状态；G 的四宽度与键盘／重启／删除回归通过。不能仅凭颜色相似给 AC-31 通过。
- 必要业务差异：绝对北京时间而非截图相对时间；详情正文完整而不折叠；实际来源／本地数与未知状态不伪造相等；pending/failed 图不回源；本站 UID／目标／错误管理不复制 B站后台；正文／头像／图片／数字及未知来源字体使整图差值天然存在。按 #35 最新用户反馈，列表／详情归档文字块已全部移除，不新增替代提示；管理和接口保留状态。无转发槽、视频／推荐榜单、真实评论发布／点赞／付费能力。

**首次失败与复测：** 12:24:56 的 V 与 M 同时启动，`visual-replica.spec.ts:9` 等待 `纯文字 1006` 超过 5 秒；其余两项通过。同场景在 38 项 A 中通过；12:28:28 串行原命令 V 又 3/3 通过。失败原文和退出码 1 仍在 `visual.log`／`results.tsv`。初次 Playwright trace 位于共享 ignored `test-results/`，已被后续套件清理，**不冒称该 trace 已归档**；可复核材料为原始失败日志。并发装配／共享 Vite 缓存只是待证假设，不能据一次复测宣称根因已确定或产品已修复。运行助手后来明确要求串行，未修改产品或测试断言。若维护者再次复现，按 §7 的 F-01 继续定位。

运行助手首版按共享 `results.tsv` 判断整个阶段退出码，导致 M/G/A 虽各命令退出0，外层 browsers 阶段被并行 V 的失败返回1。已修为仅汇总本阶段失败；原始各命令日志不变。这是记录助手的退出码问题，不归为产品缺陷。助手后来还增加重跑产物留存、落盘失败检查、Nginx 路径元数据与预览进程就绪归属检查；日志反映实际各次执行，不冒称首次已使用最终助手。助手仅是本次证据的复跑附件，与日志同目录便于移交，不是新建通用运行框架；重跑追加文件，已提交的 Git 版本冻结原次证据。日志中的本机绝对路径及 PID 属非敏感环境定位信息，保留原始输出，不把这种路径保留误称为已审查真实凭据。

## 6. 汇入的部署、人机、上游与运行边界

| 类别／责任 | 已得证据 | 缺失与不可替代项 |
| --- | --- | --- |
| #31 双进程／部署 | [31验收](acceptance-31.md)／[专项证据](evidence/deployment-31.md)；本次 P/D 在当前基线重跑通过。生产 JS `index-BTVOgYMH.js`，实际更新至 `index-C7nDeOSd.js`；API 200/404/422/不可达502、资源404/no-store、入口no-cache/304、hash immutable、旧hash保留、读取仅GET、构建重现与fault隔离均实际断言 | 不是云部署或容量评测；#31 版本化干净副本安装/build 证据保留为 #31 当次记录，本票没有冒称再次执行干净依赖安装 |
| #31/#32 安全与运行风险 | P/D 仅用 `FAKE_DEPLOYMENT_SECRET_31_NEVER_REAL` 注入异常／query，扫描 HTTP、UI、产物及进程/Nginx诊断；虚构样本签名／凭据非真实秘密。模板关闭 access/error 原始请求日志，防502携带query泄漏 | 代价是丢失逐请求错误细节；外层代理／托管平台不得重新记录原始URI或body。公网管理/API无鉴权，可读归档／改配置；隐藏入口非保护；公开OSS可直取／外链；未来登录也不自动保护图片。无备份／清理／容量治理／容灾保证 |
| #33 正式环境 | #32 当次只有 Playwright Chromium 与虚构截图；后续两环境功能轮、M2 原失败／修复和用户正常反馈统一见 [33人工记录](acceptance-33.md)，不在此重复展开 | **整体未验证**：Linux 元数据和管理／可见布局／手机长图体验反馈已补入 §11；Safari 信息、真机截图、正式视觉及 iPhone 预览关闭焦点独立观察等未齐。当前人工证据为对话操作记录，不将部分反馈或模拟触控扩展为完整真机通过 |
| #34 授权上游／实际OSS | [34执行清单](issues/34-live-source-runtime-evidence.md)；[13 GET历史记录](../../docs/backend/evidence/backend-feasibility.md)仅当时有限只读样本 | **未验证**：所有相关页面编辑时间可用性、多次自然编辑、来源计数根＋全部回复口径、权限／全量分页、实际上传／公开URL。13 GET = 11 API成功＋1 opus/detail 412后停止＋1网页200；不是完整采集，亦不继承 #35 普通授权网页视觉查看为业务归档证据 |
| #34 持续运行／资源 | B/L/P 的受控时钟与有限真实进程恢复；本机工具版本已记录 | **未验证**：授权实际规模持续15秒触发／忙跳过／积压／完成耗时／恢复、CPU／内存／SQLite／存储、2核2GB。未启动长期采集，不预设持续时长、容量阈值或SLA；由维护者先确认计划与停止条件 |
| 历史09 | [旧acceptance-09](../dynamics-viewer/acceptance-09.md)保留为历史mock单UP阶段 | 不迁移任何旧同号AC通过结论。当前M/S即使复用了旧用例，也只计本次命令实际观察的模拟边界 |

## 7. 剩余失败／未验证、责任与复测步骤

| 编号／状态 | 关联 AC／责任 | 继续执行的方法与停止条件 |
| --- | --- | --- |
| F-01 首次视觉失败；串行复测通过但根因未证实 | AC-31 的自动化记录；#32 维护者，若确认产品缺陷交 #35 修复 | 从当前基线顺序执行 browsers→visual；如再次失败，先将当次 `test-results/` trace复制到独立脱敏证据目录，再运行下一套件。对照纯文字1006实际DOM／API数据、viewport和Vite模式，固定一个变量复测；不改等待时长／断言掩盖。失败时相关验收保持失败，不以已有复测通过覆盖新失败 |
| U-01 正式浏览器／真机及像素签收未验证 | AC-10–13/16/31；#33（视觉基准由#35提供） | 维护者提供当前版本可访问部署、Linux Chrome、iPhone Safari；#35/#33 先补齐评论／回复独立保留区域的来源对照与差异材料（完整详情截图已有，但不等于该区域对照已齐），再按#33分别记录版本和两类图预览／手势／历史／焦点／坏图／主动滚动、四宽度和管理规则签收。发现视觉或行为差异交执行票修复，带构建版本复测；未取得设备不得勾选 |
| U-02 不同页面／自然编辑／计数／权限／feed分页未验证 | AC-04/23/26/27/28/34；#34 | 先确认目标／权限／允许操作／时段／停止条件，仅授权样本核验，不绕过拒绝；保存结构保留的脱敏材料。没有自然事件就继续未验证，不靠pub_ts或正文diff伪造编辑信号 |
| U-03 实际OSS上传与公开读取／真实环境隔离未验证 | AC-17/30/32；#34 | 维护者配置仓库外凭据和已有授权OSS，分别验证动态图／根评论图owner、顺序、上传失败恢复及浏览器公开URL直取；检查产物／HTTP／UI／日志脱敏，不提交真实秘密或原始响应，不增加变体/CDN/采购 |
| U-04 实际规模持续调度／资源未验证 | AC-25/33/34；#34 | 维护者明确持续时长、实际起始目标规模、硬件和停止条件，再记录节拍与同步完成分开、忙跳过、积压／错误／恢复及CPU/内存/SQLite/存储。只有实跑2核2GB才能给该环境结论，不声称每15秒全量完成或长期稳定 |
| U-05 交付复核及父票收口 | #32维护者／父#12；#31/#35票据状态由维护者核验 | 对照本票原始输出、当前基线与34行台账，补#33/#34独立记录再更新对应分类；依赖已有交付不等于父票完成，不擅自改历史记录／AC编号 |

#32 可以完成“记录与自动化”的交付；上述必需证据未齐时，父 #12 和整个产品**不能宣称完整验收**。更新时保留本次尝试历史，不把人工待测、历史样本或模拟云当通过。

## 8. 双轴 review

按开工基线 `769da3d79250a0e748e8b0a539ca7082bc42879b` 审查 `git diff --cached 769da3d… --` 完整暂存工作区差异，尚无新提交；按用户要求 review 后才统一提交。Standards 与 Spec 分别由 `review` 子代理独立审查。

### Standards

硬性规范违规 0；4 项判断性意见：视觉失败跨摘要／台账重复、助手与证据同目录、quality 重跑检索、`safe` 命名／Nginx 路径元数据。已补 Q3 重跑用途与链接，将助手函数改名 `run_isolated`，后续 delivery 日志明确记录 Nginx 路径。保留每行 AC 必要结论及专节／待办的不同阅读入口，不为消除文字重复破坏逐项可复核性；助手保留为一次性交付的可复跑附件，不上升为通用产品脚本。本机非敏感路径保留原始输出并明确其性质。

### Spec

未发现确认的产品性规格违背；1 项视觉部分覆盖（完整详情图有评论／回复，但无两区域各自完整来源对照），2 项低危记录问题（E/K 检索缺失、首次并行与建议串行措辞混淆）。均已明确补记：AC-31 继续未验证并将补区域对照交 #35/#33；E/K/Q3 纳入结果索引；首次真实并行时间与后续安全复测顺序分开，不改既有执行历史。

修正后两轴独立复核均确认无新增阻断；Standards 保留判断性意见为非阻塞，Spec 确认原三项已诚实记录闭环，未将缺失视觉证据改为通过。提交前再对当前文档／索引核对全部本地链接、34 个 AC、17 条执行结果及22张图片；产品代码未改变，不将记录修正冒称产品修复。
