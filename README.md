# 图文动态浏览

文档入口：[文档导航](docs/README.md) · [后端集成执行计划](.scratch/backend-integration/implementation-plan.md) · [后端运行说明](backend/README.md)。需求、设计、接口和各阶段验收记录按职责从导航页进入。

## 当前交付入口（后端集成 #31）

[双进程与 Nginx 运行说明](docs/deployment/static-delivery.md#当前范围后端集成-31)覆盖干净检出、固定 nvm/pnpm/uv 依赖、仓库外共享 SQLite、单 API + 单 collector 的前台启停/迁移/重启、静态发布与排障。生产读取归档 API，业务图直取公开 OSS URL；独立 mock 仅供历史回归。隔离验证不访问真实上游/OSS，不代表云部署、真机、持续运行或 2 核 2GB 容量保证；本次结果见 [#31 验收记录](.scratch/backend-integration/acceptance-31.md)，不继承下方历史通过结论。

## 当前功能与历史范围

目前完成 [任务 01](.scratch/dynamics-viewer/issues/01-browse-text-dynamics.md)、[任务 02](.scratch/dynamics-viewer/issues/02-continue-reading-dynamics.md)、[任务 03](.scratch/dynamics-viewer/issues/03-read-and-sort-comments.md)、[任务 04](.scratch/dynamics-viewer/issues/04-expand-comment-replies.md)、[任务 05](.scratch/dynamics-viewer/issues/05-preview-dynamic-images.md)、[任务 06](.scratch/dynamics-viewer/issues/06-mobile-image-history.md)、[任务 07](.scratch/dynamics-viewer/issues/07-restore-discussion-history.md)、[任务 08](.scratch/dynamics-viewer/issues/08-static-delivery.md) 和 [任务 09](.scratch/dynamics-viewer/issues/09-cross-device-acceptance.md)：固定虚构 UP 主、每批最多 10 条图文动态、独立完整正文详情、站内返回、详情直达/刷新、加载/空态/错误重试及安全文本展示；列表支持显式追加、超过六个渲染行的正文展开/收起，以及会话内返回原列表阅读进度。

详情支持一级评论的最热/最新排序、每批 20 条的显式追加、长评论展开/收起与局部失败重试；列表评论数可直接进入评论区。

一级评论显示完整回复总数；楼中楼按时间正序预览最多 3 条，每次显式追加最多 10 条，支持收起至预览及再次展开恢复已加载内容。回复目标、UP 主身份、长回复正文折叠和单条回复区失败重试均已支持。

列表和详情支持单图、多图缩略网格及基础图片预览；列表最多九格，四图两列、其他多图三列，超出数量有提示，详情与预览可访问全部图片。按钮、方向键、Esc 和基础历史后退可操作；关闭恢复底层位置与触发焦点。缩略图使用真正的小尺寸素材并懒加载，预览只请求当前图片，坏图支持原地址重试。

长图默认完整显示，可通过“适应宽度”按钮纵向阅读，再切回“完整显示”；按钮支持键盘。高宽比至少 2:1 提供长图模式，尺寸缺失时按加载后的自然尺寸识别。手机横向滑动切图，首尾不循环、单图不切换；纵向阅读不切图，切换图片后预览纵向位置归零。显示模式和最后查看图片保留于当前预览会话，关闭后浏览器前进可恢复；预览中刷新则替换清理失效标记并显示底层页面，不自动连续后退。

详情历史返回按独立页面访问恢复评论排序、分页范围、回复及文字展开和阅读位置；同一动态的不同访问互不覆盖。未完成的读取返回后从原批次继续，看图不取消底层有效请求。数据与展开范围先恢复，再按稳定动态/评论/回复标识定位；用户主动滚动优先，刷新可重置，不写本地或会话存储。08 已提供 Nginx 静态交付配置；09 已对最终集成产物重新完成全量自动化回归和本机真实 Nginx 验证，补齐四宽度完整流程、列表图片几何、时区与逆序竞态证据。2026-10-12 用户明确将本期兼容目标收窄为 Linux Chrome 与 iPhone Safari，并补充实际版本及桌面键盘/焦点、iPhone 切图/长图滚动/返回隔离检查通过的反馈；结合已有自动化与交付证据，09 及本期已按这两目标完成验收。其他设备/浏览器不在本期兼容保证内，人工、模拟与自动化证据来源见 09 记录第 13 节。上述是历史 mock 阅读演示（迁移前的 React 实现）的验收，不代表新后端或 Vue 候选版本验收；当前候选版本见 [12 仅 Vue 候选产物](.scratch/frontend-vue-migration/evidence/12-vue-only-release-candidate.md)。当前默认 `/`、`/ups/:upId` 和详情使用真实归档 API；`/manage` 使用 FastAPI/SQLite 保存 UP 配置与指定目标、校验来源作者。02 增加公开一次初始化入口，保存指定集合的正文和独立时间；后续已补齐评论/回复与媒体能力，23 新增独立固定节拍采集进程，不能将检查或正文成功冒充全部归档完成。

## 环境与运行

前端应用在 `frontend/`（仓库根不再有第二套前端入口）；后端在 `backend/`。Node 只用 nvm 管理，依赖与脚本只用 pnpm，
直接依赖版本与 lockfile 固定在 `frontend/pnpm-lock.yaml`。

```bash
cd frontend
source ~/.nvm/nvm.sh
nvm install
nvm use
corepack enable
corepack prepare pnpm@10.34.6 --activate
pnpm install --frozen-lockfile
pnpm dev
```

默认列表：`http://localhost:5173/`，需要下面的 Python API；新数据库显示成功空归档。单 UP 列表使用 `/ups/:upId`，最小范围导航来自持久身份，停用或删除监控不隐藏旧归档。独立虚构演示使用 `pnpm dev:mock`，示例详情 `/dynamics/90071992547409931`；故障装配用 `pnpm dev:fault`。构建产物为 `frontend/dist/`（生产）与 `frontend/dist-mock/`（自检），命令、结构、装配隔离与 e2e 约定见 [frontend/README.md](frontend/README.md)；
迁移规格与票据见 [实施规格](.scratch/frontend-vue-migration/spec.md)，候选证据见
[12 仅 Vue 候选产物](.scratch/frontend-vue-migration/evidence/12-vue-only-release-candidate.md)。

如果环境没有 Corepack，可先按其官方安装说明准备 Corepack/pnpm；不需要将其作为应用依赖。生产前端只需要构建后的静态文件，不需要 Node.js 服务；管理功能另外运行 Python API。

### #35 隔离视觉预览（虚构数据）

```bash
cd frontend && pnpm build && cd ..
uv run python -m scripts.visual_preview --frontend-dir frontend/dist
```

访问 `https://127.0.0.1:18443/`，管理为 `/manage`；浏览器首次需确认本次临时自签开发证书，图片与页面使用同一 HTTPS 来源。服务只监听回环地址，每次新建临时数据库、正常退出删除，不读取真实凭据，不访问真实 B站／OSS、不启动周期采集。三个虚构 UP、正文、评论／回复、两类图片和管理操作使用生产 Adapter／API；这些演示不是真实归档验收。说明与样例 ID 见 `/visual-preview`。

受控截图及原图并排／差异证据：运行 `node frontend/scripts/capture-visual-35.mjs`（服务须保持运行）。默认使用用户最新两张PNG `docs/assets/ui-reference/current-35/{dynamics-list,dynamic-detail}.png`，按48px头像参照等比归一0.5（不宣称来源DPR已知），输出至 `.scratch/backend-integration/evidence/visual-35-current/`。需要本地 Playwright Chromium、ImageMagick、fontconfig；ignored素材不随干净检出分发，他机可用 `UI_REFERENCE_DIR=/path/to/originals UI_REFERENCE_SCALE=0.5` 指定目录／比例，未指定自定义比例默认1。首轮证据与[当前B站安全取材记录](.scratch/backend-integration/visual-35-live-reference.md)分开保存；授权网页查看不成为预览依赖。素材缺失必须暂停对照、申请补图并将票据标为 `needs-info`，不得使用当前截图自建基线。参考基准、差异限制及未验证项见 [#35 验收记录](.scratch/backend-integration/acceptance-35.md)。这不是正式部署入口；真实运行仍按下节启动。

## UP 管理与 Python API

真实监控推荐使用统一入口，避免漏启采集进程。准备好 uv 环境并停止旧 API/collector 后，在专用终端运行：

```bash
export BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite
exec .venv/bin/python -m backend.bili_monitor.service --host 127.0.0.1 --port 8000
```

它等待 API 迁移并监听后启动独立 collector，共享数据库及服务端 Cookie/OSS 环境，任一进程退出会停止另一进程；Ctrl-C/TERM 按 collector、API 顺序退出。不要同时使用该入口和下方手动双进程方式。添加监控后由 collector 的固定节拍发现并归档，不承诺即时完成；仅启动 API 不会采集。详情见[后端统一启动说明](backend/README.md#api-与采集统一启动)。

Python 环境和依赖只使用 uv。首次启动会事务迁移数据库；身份与监控配置分离，停止/删除配置保留身份，重启读取原数据库。

```bash
# 专用 API 终端，仓库根目录；纯生产可 uv sync --locked --no-dev
uv sync --locked
unset WEB_CONCURRENCY
export BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite
printf 'API PID=%s\n' "$$"
exec .venv/bin/python -m uvicorn backend.bili_monitor.app:app --host 127.0.0.1 --port 8000 --no-access-log
```

另一终端先按上节 nvm/pnpm 步骤准备，再 `pnpm dev`，访问 `http://localhost:5173/manage`。Vite 开发服务器将 `/api` 代理到 8000；正式部署沿用静态构建和 [Nginx 示例](deploy/nginx.conf)，另外启动仅监听回环的 FastAPI。示例 SQLite 路径须改为实际仓库外持久绝对路径，API 与独立 collector 使用同一文件；默认 `backend/data/monitor.sqlite` 仅用于本地开发。不要使用多 workers/reload；升级先停两个 Python 进程并等退出，再切版本/同步依赖，API lifespan 自动迁移就绪后再启动 collector。`exec` 直接运行 uv 环境的 Python，避免仅终止 uv 父进程遗留服务；TERM 与等待/重启步骤见交付说明。服务端公开资料传输有超时，上游拒绝或缺字段会明确失败，不制造成功身份。UID 为字符串，页面不能编辑昵称、头像或凭据。

[管理契约](docs/backend/api/management-api.md) 明确输入、错误、模式、默认值和迁移。每 UP 默认近期 10 条，可独立保存近期 N、切换指定模式、启停或删除。指定目标可添加/移除，服务端确认作者匹配才保存；不符或无法读取分别提示，不伪造校验成功。近期模式沿原规则跨页凑 N，并将整轮可信结果发布为当前窗口，复用指定模式同一检查/归档链；失败保留旧可信窗口和全部归档。管理页“近期发现与当前窗口”分区可手动读取已保存 N、候选/可信/当前目标及发现未完成/错误，不触发上游扫描，发现就绪不代表归档成功。固定 15 秒检查需单独启动 Python 采集进程，API 不内嵌定时器。启动/停止与隔离演示见 [后端运行说明](backend/README.md#23-独立采集进程)，检查状态 HTTP 见 [采集契约](docs/backend/api/collector-api.md)，检查/成功时间不混用。默认阅读经生产 Adapter 只查本地归档；来源不可用、停止或删除配置/目标不删除旧归档。首次初始化执行见 [归档契约](docs/backend/api/archive-api.md) 和 [后端说明](backend/README.md)，不由浏览器自动触发，也没有手动采集 UI；状态重读仅查询本地数据库。

**安全风险：首期无鉴权。公网管理页/API 可被第三方读取和修改；隐藏入口不构成保护。请自行限制暴露范围。** 本票不增加登录前置要求，不提供凭据编辑。没有备份/容量治理可能导致丢失或停止写入。

## 检查与测试

前端命令在 `frontend/` 执行，后端 pytest 在仓库根执行。

```bash
cd frontend
pnpm check               # typecheck + 单测 + e2e 项目覆盖守卫
pnpm check:dist          # 生产/自检两次构建 + 产物隔离
pnpm exec playwright install chromium
pnpm test:e2e
E2E_TARGET=preview pnpm test:e2e
pnpm test:e2e:production
pnpm test:e2e:manage
pnpm test:nginx-parity
cd ..
uv run pytest backend/tests
```

- `pnpm check`：`vue-tsc` 类型检查（覆盖 `.vue` 模板）、Vitest 单元/页面行为与 e2e 项目覆盖守卫，一次跑完。
- `pnpm test`：Vitest 数据契约与 `@testing-library/vue` 公开页面行为，通过读取接口注入可控 Adapter；不直接断言私有组件状态。
- `pnpm test:e2e`：起 mock 装配（4318）、图片夹具（4319）与生产装配（4320，HTTP 传输按用例替换），在桌面 Chromium 和 Pixel 7 模拟视口运行浏览器流程。
- `uv run pytest backend/tests`：真实 FastAPI HTTP、隔离临时 SQLite、模拟上游 HTTP transport，覆盖迁移、身份和配置重开、失败保留及秘密脱敏。
- `pnpm test:e2e:production`：生产装配（六路由/404/无自检入口）与 fault 装配冒烟。
- `pnpm test:e2e:manage`：自起真实受测 Uvicorn API（4177，`backend.tests.live_app` 虚构上游）与 Vite（4324），数据库为本次运行独占的临时 SQLite；只替换上游传输，不 mock 数据库或生产管理映射。浏览器保存配置后关闭并重启 API，刷新验证同一临时数据库。`backend.tests.live_app` 不是生产启动入口，不需要真实凭据。
- `E2E_TARGET=preview pnpm test:e2e`：先 `build:mock`，再对显式 mock 静态产物（`frontend/dist-mock`）运行历史阅读回归；不使用故障装配，不代替生产 Adapter 或 Nginx 验收。发布使用 `pnpm build`，不要发布 mock 产物。
- `NGINX_BIN=/absolute/path/to/nginx NGINX_MIME_TYPES=/absolute/path/to/mime.types pnpm test:delivery`：在 `frontend/` 执行，需先 `uv sync --locked`（含 dev）、安装 Chromium，4173 空闲。临时真实 Nginx 保留显式 mock 历史阅读/缓存/更新与构建重现/fault 隔离，再启动实际 API + 独立 collector 共享临时 SQLite，使用生产 Adapter 验证六条路由/刷新、API 200/404/422/502、资源错误/cache、生产构建更新及 HTTP/UI/日志/产物虚构秘密扫描。API 选临时空闲端口，不配置系统服务，不访问真实上游/OSS；准备步骤见交付说明。本机未安装 Nginx 时该步无法执行，须在具备 Nginx 的环境补跑。
- `pnpm test:nginx-parity`：只做 `deploy/nginx*.conf` 的 location/server 指令一致性校验，不需要 Nginx 二进制。
- `uv run --no-sync pytest backend/tests/test_deployment_processes.py -q`：#31 两进程持久化、检查/同步和重启/恢复专项；fixture API/collector 入口见后端 README，与生产运行入口分开。
- `HTTP_ACCEPTANCE_URL=http://192.168.8.20:4180/ pnpm test:http`（在 `frontend/` 执行）：对已启动的可信局域网 Nginx 显式 `build:mock` 产物验证真实非 localhost HTTP 的启动、UUID v4、详情/预览历史与刷新；先重新构建并更新站点副本，地址替换为实际私有 IPv4。与 `test:delivery` 配合执行，详见静态交付说明；不等于真机验收。
- 浏览器测试设设备时区为 `America/Los_Angeles`，检查页面仍显示北京时间。四种约定宽度为 360、390、768、1280px。
- Linux 需要 Chromium 可用的系统库；缺库时按 Playwright 官方系统要求安装。模拟视口不能代替 Linux 品牌 Chrome 或 iPhone Safari 真机检查；既有 Pixel 7 参数保留作自动化视口/触摸配置，不意味着 Android 是本期兼容目标。
- 如环境设置了 HTTP 代理，需使本地测试服务器绕过代理：`NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost pnpm test:e2e`；静态产物测试同理。

## 静态交付

参见 [交付运行说明](docs/deployment/static-delivery.md) 和 [Nginx 示例](deploy/nginx.conf)：域名根路径部署，默认 root 为 `/srv/dynamics-viewer/current`、本机监听 4173、API 上游 8000；路径与端口修改须同步配置。六条页面地址直达/刷新与未知页面回退入口；API 成功/错误和明确资源路径缺失不得回退入口，资源缺失 HTTP 404 + `no-store`。入口重新验证，哈希 JS/CSS 长期缓存；未版本化的应用自有资源（`default-avatar.svg`、`/images/`）不永久缓存。前端“未找到页面”不等于服务器 HTTP 404。

发布保留旧哈希资源并原子切换入口；生产业务图直取给定公开 OSS URL，不加服务器代理；mock 图片只由夹具服务器提供，不进生产产物。模板关闭 access 和该 server 的 error 日志，防止 API 不可达时原始 query 泄露；排障用 `nginx -t`、HTTP 状态、退出状态及脱敏错误，外层代理也不能重开原始 URI 日志。秘密只留服务端仓库外；无鉴权管理/API 可被读取或修改、公开图可外链，无备份/容量治理可能丢数据或停止写入，不新增鉴权或服务。2 核 2GB 仅是评估目标，不是容量保证，不宣称已实施云部署或容量压测。

历史任务 09 的自动化与本机静态交付结果已汇总，其兼容目标仅为 Linux Chrome 与 iPhone Safari；用户已补齐当时的实际版本与人工专项结果，09 按这两目标完成收口（见 09 记录第 13 节）。这些历史 mock 结果不证明当前后端或生产浏览器验收完成。

## 装配与边界

前端的模块划分、数据契约、装配隔离与测试分层以 [frontend/README.md](frontend/README.md) 为单一来源，这里不再复述实现细节。
仍须知道的边界：

- 读取装配默认是真实归档 API（`/api/archive/*`）；`pnpm dev:mock` / `build:mock` 才装配虚构归档，`dev:fault` 另有受控故障计划。
  普通构建不含自检路由、夹具地址或 mock 归档数据，由 `pnpm check:isolation` 断言。
- 浏览器不持有采集/上传凭据、不直调上游采集接口；业务图使用后端给定的公开 URL，UI 不拼接也不回退来源图。
- 六条页面地址为 `/`、`/ups/:upId`、`/dynamics/:dynamicId`、`/dynamics/:dynamicId/comments/:rootId`、`/manage`、`/manage/ups/:upId`，
  其余为前端“页面不存在”。无有效站内来源时详情返回安全替换为列表首页；刷新后不沿用失效的内存来源。

## 验收记录

当前后端集成 #13 的 scope 读取协议、T1/T2 与实际 API→最小页面证据见 [13 验收记录](.scratch/backend-integration/acceptance-13.md)；它不代替下面的历史 mock 验收，也不表示 #14 导航改版、部署或真机完成。

详见 [01 验收记录](.scratch/dynamics-viewer/acceptance-01.md)、[02 验收记录](.scratch/dynamics-viewer/acceptance-02.md)、[03 验收记录](.scratch/dynamics-viewer/acceptance-03.md)、[04 验收记录](.scratch/dynamics-viewer/acceptance-04.md)、[05 验收记录](.scratch/dynamics-viewer/acceptance-05.md)、[06 验收记录](.scratch/dynamics-viewer/acceptance-06.md)、[07 验收记录](.scratch/dynamics-viewer/acceptance-07.md)、[08 验收记录](.scratch/dynamics-viewer/acceptance-08.md) 与 [09 最终集成验收记录](.scratch/dynamics-viewer/acceptance-09.md)。06 手势使用 Chromium CDP 触摸输入和 Pixel 7 模拟视口验证，不代表真实 Android/iOS 触控验收。Vite 的开发/预览回退不代表 Nginx 验收；08 使用临时编译的 Nginx 1.28.0 实测，未操作生产环境。09 已实际复跑最终集成产物：Vitest 93/93、开发浏览器 102 通过（10 项仅 Nginx 跳过）、preview 94 通过（同样跳过 10 项）、真实 Nginx 104/104，以及构建重现/故障装配隔离/更新演练；Vite 不替代 Nginx。09 表内逐项记录通过及未验证；Linux Chrome / iPhone Safari 的实际版本、人工专项通过结果及最终验收收口见第 13 节，第 1–12 节保留历史过程。其他设备/浏览器已移出本期目标，不能据此宣称这些目标也通过。
