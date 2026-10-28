# 静态交付与 Nginx 运行说明

> [Vue 3 + Element Plus 重构方案](../design/frontend-migration.md) 已确认，票据 12 已交付仅含 Vue 的候选产物：构建在 `frontend/`、产物为 `frontend/dist/`，Nginx 静态托管与 API 代理规则不变。本页命令已按候选产物更新；票据 16 已在**本机隔离环境**用临时编译的 Nginx 1.28.0 执行静态交付、资源更新与前端回退，结果见[16 交付证据](../../.scratch/frontend-vue-migration/evidence/16-static-delivery-rollback.md)，**未在真实目标机或云环境执行**，不构成上线结论；票据 13–15 覆盖协议、视觉与真机。前端切换不迁移/回退数据库；旧哈希资源保留、原子发布与回退要求见第 3 节。

## 当前范围：后端集成 #31

依据：[SRS](../product/SRS.md) FR-02、NFR-04/05、[HLD](../design/HLD.md#11-构建与部署设计)、[#31](../../.scratch/backend-integration/issues/31-reproducible-deployment.md) 与[执行计划](../../.scratch/backend-integration/implementation-plan.md)。本节是可复用操作说明，不是验收结果；本次执行结果及未验证项另见 [#31 验收记录](../../.scratch/backend-integration/acceptance-31.md)。下方保留历史任务 08 的静态基线；历史 mock、fixture 隔离部署、真实上游/OSS、云部署、真机与持续运行证据不能互相替代。

### 干净检出与固定依赖

从维护者选定的同一版本干净检出，在仓库根目录执行，不依赖 ignored 素材或脚本：

```bash
source ~/.nvm/nvm.sh
nvm install
nvm use
corepack enable
corepack prepare pnpm@10.34.6 --activate
uv sync --locked
( cd frontend && pnpm install --frozen-lockfile && pnpm build )
```

Node.js `24.21.0`（`.nvmrc`）、pnpm `10.34.6`（`frontend/package.json`）、Python `3.12`（`.python-version`）；直接依赖和传递依赖分别由清单及 `frontend/pnpm-lock.yaml` / `uv.lock` 固定。Python 仅固定到 3.12 系列，记录实跑补丁版本及 uv/Nginx 版本，不声称跨补丁环境字节一致。纯生产 Python 环境可用 `uv sync --locked --no-dev`；测试前须重新 `uv sync --locked` 安装 pytest。前端在本地/CI 构建后仅交付 `frontend/dist/`，不用常驻 Node 或 SSR。生产 `pnpm build` 使用归档 Adapter；`build:mock` / `dev:mock` 与 `dev:fault` 仅用于独立回归，输出到 `frontend/dist-mock/`，不得发布。

### 单 API、单 collector、单通知进程：启动、停止、升级

选择**仓库外、持久卷上的同一个绝对 SQLite 文件路径**；以下 `/srv/bili-monitor/monitor.sqlite` 只是示例，目录需运行用户可写，不放在临时目录或发布目录中。默认 `backend/data/monitor.sqlite` 只适合本地开发。API、collector 与通知进程必须使用同一路径和同一代码版本，勿用硬链接别名；运行一个 API、一个 collector、一个通知进程，不设 `--workers`、`--reload` 或 `WEB_CONCURRENCY`，无 Redis/Celery/额外任务服务。

通知路由与本站基址来自仓库外的服务端配置文件（示例见[通知进程契约](../backend/api/notification-process.md#2-配置)，webhook/签名只用虚构占位）：

```bash
export BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite
export BILI_NOTIFICATION_CONFIG=/srv/bili-monitor/notifications.json
exec .venv/bin/python -m backend.bili_monitor.service --host 127.0.0.1 --port 8000
```

统一入口负责三个进程的托管，顺序固定为 **API → collector → 通知进程**：先等 API 完成 `Store.migrate` 并监听成功，再启动独立 collector 与独立通知进程；三者共享同一继承环境与绝对数据库路径。API 与 collector 都不内嵌通知定时器。通知进程仍以数据库旁 `.notifier.lock` 的排他锁保证同一库只有一个投递实例，重复启动会以固定错误退出；托管层不为它做第二套去重。

未设置 `BILI_NOTIFICATION_CONFIG` 时该入口保持原两进程形态（只托管 API＋collector），此时不会投递任何飞书消息；这是兼容旧部署的降级，不是“已接入通知”的证据。

父进程收到 Ctrl-C/TERM 后按 **通知进程 → collector → API** 的顺序停止并逐个等待真正退出：先停止发起外部投递的进程，再让 collector 清理在途工作，最后停 API。任一子进程异常退出都会停止其余进程，并以固定错误（不输出路径、凭据或上游原文）退出，交由 systemd/外部托管处理；不要靠删除锁文件“恢复”。不要与下面的手动方式混用同一数据库。前端仍由 Nginx 单独托管。

如需手动分别托管，各开一个独立终端，均先进入实际仓库根目录。依赖同步完成后直接执行 uv 创建的解释器，`exec` 将该终端 shell 替换成真正的 Python 进程，避免只终止 `uv run` 父进程却留下 Python：

```bash
# 终端 A：单 API；先确认未设置 WEB_CONCURRENCY
unset WEB_CONCURRENCY
export BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite
printf 'API PID=%s\n' "$$"
exec .venv/bin/python -m uvicorn backend.bili_monitor.app:app --host 127.0.0.1 --port 8000 --no-access-log
```

```bash
# 终端 B：待 API 启动成功、下列只读请求为 200 后，再启动单 collector
export BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite
curl --fail --silent --show-error http://127.0.0.1:8000/api/manage/ups || exit 1
printf 'collector PID=%s\n' "$$"
exec .venv/bin/python -m backend.bili_monitor.collector
```

三端的服务端 OSS 环境须一致，配置名与未配置行为见[后端说明](../../backend/README.md#19-oss-服务端配置)；凭据由维护者在仓库外受限环境注入，应用不自动加载 `.env`。勿输出环境、使用命令行传秘密或交给前端构建环境。来源默认匿名；可选 `BILI_COOKIE_FILE` 只指向仓库外、属主为运行用户的 0600 文件及 0700 直属目录，启动时读取一次。API/collector/通知进程启动环境分别配置路径，秘密不放命令参数；当前不新增前端/API 凭据输入。隐藏输入与限制见[后端 Cookie 配置](../../backend/README.md#可选-b站登录-cookie仅服务端)，未配置不变，无效配置拒绝启动。新增配置与手动验证由维护者执行；不自动续期或绕过限制。三个进程的普通来源请求头采用同一套[初始化配置](../../backend/README.md#来源-client-初始化)，不改变代理、跳转或重试策略，启动不新增上游请求。

```bash
# 终端 C：同样在 API 就绪后启动单通知进程；配置必须已在仓库外就绪
export BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite
export BILI_NOTIFICATION_CONFIG=/srv/bili-monitor/notifications.json
printf 'notifier PID=%s\n' "$$"
exec .venv/bin/python -m backend.bili_monitor.notifier
```

停止可在各前台终端 Ctrl-C；或最后一个 Bash 终端按已记录并核实的 Python PID 发 TERM，**先通知进程、再 collector、最后 API，分别等待真正退出**：

```bash
read -r -p 'notifier Python PID: ' notifier_pid
read -r -p 'collector Python PID: ' collector_pid
read -r -p 'API Python PID: ' api_pid
[[ $notifier_pid =~ ^[1-9][0-9]*$ && $collector_pid =~ ^[1-9][0-9]*$ && $api_pid =~ ^[1-9][0-9]*$ ]] || exit 1
ps -p "$notifier_pid,$collector_pid,$api_pid" -o pid=,comm=
# 核实为本次启动的三个 Python 进程后执行：
for pid in "$notifier_pid" "$collector_pid" "$api_pid"; do
  kill -TERM "$pid"
  while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
done
```

控制终端不是进程父级，不能用 `wait PID`；用退出检测并确认三个前台终端已结束。不要在旧进程尚存时重启、删除锁文件或强制复制覆盖数据库。collector 在退出时取消在途任务并等待清理；内核释放数据库旁 `.collector.lock` 的排他锁，持久未完成工作由下次取得锁的正常 collector 恢复；通知进程终止时可能已发出的外部请求不会撤回，租约由下次正常实例按有效期恢复，失效的迟到回写被拒绝；API 启动不恢复 running，也不启动通知定时器。`--once` 仅检查/发现登记或处理一轮到期投递，不执行同步，也不恢复中断工作，不是迁移工具或常驻运行替代品。

`Store.migrate` 在 API 的 ASGI lifespan、collector 启动取得锁后（以及独立通知进程启动时）自动执行，当前 schema 为 v25（v24 只新增跨进程保护状态 `source_risk`，见[采集契约](../backend/api/collector-api.md#跨进程风控暂停03)；v25 只新增根页续采进度 `page_scan_progress`，见[归档契约](../backend/api/archive-api.md)）；空库创建、旧库按序事务升级，失败回滚，未来版本拒绝启动。升级不清空归档、媒体、阅读 cursor、未完成工作或已登记的保护状态；保护状态随库持久，停机不抵扣冷却期限与探测租约，重启后仍拒绝新的 B 站源请求；冷却到期由采集进程执行按接口探测，全部通过才进入 `observing`（见[采集契约](../backend/api/collector-api.md#六档冷却与按接口探测04)）。**升级必须先停三个进程并等退出，再切换到同一新版本、同步锁定依赖，先启动 API 完成迁移并确认 HTTP 就绪，再启动 collector 与通知进程**。普通重启重用原绝对数据库路径；通知阶段、起点、基线、事件队列与逐目标成功状态不因重启重建；已成功归档、检查状态、目标入选与近期窗口在迁移中保留。隔离演练（真实三进程写出的库 → 停机 → 副本上重复迁移）见[票据 10 证据](../../.scratch/feishu-notifications/evidence/10-integrated-delivery-readiness.md)。

升级/回退边界：不做自动降级，也不承诺旧版本打开新 schema 的库；回退只允许“前滚恢复”为同一或更高兼容版本。迁移失败时停止排查，不改 `user_version`、删库、用旧版本强开新库或手工删通知表。没有独立迁移 CLI、自动备份或容量治理；维护者应在升级前按现有备份流程自行保留数据库副本（本仓库不执行备份）。

路由修复流程：通知进程启动时读取配置，**运行中改文件不会生效**。编辑仓库外配置修复缺失/错误目标后，只重启通知进程（或按统一入口整体重启），记录保留、阶段与起点不重设、已成功目标不重发、历史不补发；重启后的第一轮会立即复检等待配置的待投递记录。整份配置不可解析时通知进程按启动错误退出，此时没有告警通道，只能由进程托管与日志发现。

### Nginx、发布和排障

当前 [deploy/nginx.conf](../../deploy/nginx.conf) 放在 `http` 上下文，主配置加载匹配的 `mime.types`；默认 `root /srv/dynamics-viewer/current`、监听 `127.0.0.1:4173`、API 上游 `127.0.0.1:8000`。维护者将 root 改为可读的完整生产发布目录或 `current` 链接；`/`、`/ups/:upId`、`/dynamics/:dynamicId`、`/manage`、`/manage/ups/:upId` 以及飞书消息用到的 `.../comments/:rootId/locate` 与 `.../comments/:rootId/replies/:replyId/locate` 均直达/刷新回入口。`/api`、`/api/…` 原样转发 API，不拦截其错误；API 200/404/422、API 不可达的 Nginx 502 都不得成为 SPA 入口（代理 502 可是 Nginx 错误 HTML，不能是应用入口）。缺失资源 404 + `no-store`；其余缓存与资源命名空间规则见下方第 2 节。

路径/端口不是自动发现：改 API `--port` 须同步改两处 `proxy_pass`；模板不会展开 `BILI_DATABASE_PATH` 或 shell 环境变量。开发 Vite 的 `/api` 代理另见 `vite.config.ts`，不是生产代理。发布按第 3 节保留旧哈希资源，在同一文件系统原子切换入口；不可就地逐个覆盖 `dist/`，或发布 mock/fault 服务。

模板显式 `access_log off; error_log /dev/null;`，禁止记录原始请求。只关 access 日志不够：API 不可达时 Nginx 默认 error 日志也会带原始 query；#31 用 `token=虚构秘密` 的 502 场景发现此泄露并修正。取舍是放弃该 server 的逐请求错误日志，改用 `nginx -t`、HTTP 状态、进程退出和 API 固定脱敏错误定位；**外层代理、托管平台和新增 location 不得重新开启原始 URI/请求体日志**，不要以临时 debug 为由打印秘密。

- `nginx -t -c /absolute/path/to/nginx.conf` 失败：核对配置上下文、mime.types、root 可读性、监听端口及权限；启用/停止独立 Nginx 由维护者按实际主配置执行（前台可用 `nginx -c /absolute/path/to/nginx.conf -g 'daemon off;'`）。不 reload 不属于本次运行的系统服务。
- `/api/manage/ups` 直连 8000 成功而 4173 失败：核对上游端口/地址和生效配置；502 时确认 API 仍在运行及启动是否失败，不用 SPA 回退掩盖。
- HTTP 200 但空归档：核对三个进程的绝对数据库路径、管理启用配置与 checks/discovery 状态；只有 API 不会自动采集。`Collector failed` 时检查是否已有 collector、目录可写、版本及 OSS 配置完整性，勿删除运行中的锁。
- 页面可用但资源 404：核对 root/current、入口所引用哈希与旧资源保留；失败状态只用脱敏错误码排查，不打印环境或上游响应。

**风险边界**：管理页、写 API、初始化/媒体重试均无鉴权，公网可被读取归档或修改配置；隐藏入口不是保护。公开 OSS URL 可被直接访问/外链，未来登录也不会自动保护图片。秘密仅留服务端仓库外，不进版本库、产物、HTTP/UI/日志。本交付不新增鉴权、服务、云采购、备份或容量治理；损坏、误操作和磁盘/OSS 增长可能丢数据或停止写入。2 核 2GB 只是评估目标，不保证容量、并发或单个节拍内同步完成。

### 隔离验证入口与证据边界

```bash
# 仓库根目录；已完成上面的 nvm/pnpm frozen 安装
uv sync --locked
( cd frontend && pnpm exec playwright install chromium )
uv run --no-sync pytest backend/tests/test_deployment_processes.py backend/tests/test_service_processes.py \
  backend/tests/test_three_process_delivery.py -q
cd frontend
# 三进程（实际 API＋独立采集＋独立通知）→ 消息实际链接 → 生产前端装配
pnpm test:e2e:delivery
NGINX_BIN=/absolute/path/to/nginx \
NGINX_MIME_TYPES=/absolute/path/to/mime.types \
pnpm test:delivery
cd ..
```

需要 uv 的 dev 依赖、可执行 Nginx/mime.types、Chromium 及其系统库，且 Nginx `127.0.0.1:4173` 空闲。脚本选择临时空闲 API 端口并仅在临时配置替换上游，不占用维护者的 8000、不修改系统服务；`4173` 已被现有实例或隧道占用时用 `DELIVERY_PORT=<空闲端口>` 换端口，**不要停掉现有实例**。`frontend/scripts/verify-static-delivery.mjs` 托管显式 mock 构建（`frontend/dist-mock`）做阅读/缓存/更新与构建重现/fault 隔离，再通过 `verify-production-deployment.mjs`、`verify-production-delivery.mjs` 启动实际 API/独立 collector 共享临时 SQLite，验证生产六条路由直达/刷新、未知页、只读浏览、API 200/404/422/502、资源 404/cache、入口引用的全部哈希资源、生产构建真实更新与回退、旧哈希保留及 HTTP/UI/产物/日志的虚构秘密扫描。第二个临时 server 只给 `/api/manage/` 加 Basic 保护，用来确认反代 401 不回退 SPA 且前端仍显示固定身份验证提示。生产 `frontend/dist` 不再被 mock 构建覆盖；fault 构建输出到 `dist-mock`，脚本断言它不影响生产产物。给 `test:delivery` 传 Playwright 文件只筛选历史 mock 部分，不跳过生产阶段。

隔离 API 是 `backend.tests.deployment_fixture:create_app --factory`，必须指定 `BILI_DATABASE_PATH`；独立采集入口为 `python -m backend.tests.deployment_fixture --database PATH`，PATH 与 API 相同（均用 uv 环境）。它们复用生产实现，只替换外部来源/下载/上传，不访问真实上游/OSS；上传返回 `https://media.example.invalid/deployment.png`，浏览器仅 route 外部图片传输，不替换 API/Adapter/SQLite。`test_deployment_processes.py` 负责两进程持久化、检查/同步和重启/恢复边界。

三进程组合入口是 `backend.tests.delivery_fixture`：API 为 `create_app --factory`，独立采集为 `python -m backend.tests.delivery_fixture --database PATH`，通知进程仍是生产 `python -m backend.bili_monitor.notifier`，三者共享同一临时 SQLite；受控状态文件可在采集节拍之间切换正文版本、评论/回复集合与分页失败，测试从不直接写归档表。`test_three_process_delivery.py` 覆盖正文/一级评论/后续页回复三链、双 UP 路由、路由修复、阻塞飞书时其他进程写入、真实强杀后的租约恢复与重复实例拒绝；`test_service_processes.py` 覆盖统一入口的启动顺序与收尾。`frontend/tests/e2e-delivery/` 取实际投递消息里的链接，在生产前端装配中验证宽窄屏、刷新、返回、目标不存在与代理语义。实际结果与资源测量见[票据 10 证据](../../.scratch/feishu-notifications/evidence/10-integrated-delivery-readiness.md)；本文不替代执行证据，不把 fixture 文件当真实上游、真实群或真实 OSS 证据。

## 历史任务 08：静态基线与复现说明

> 下方“本期 / 本票”仅指历史模拟前端阶段，不表示当前后端已部署或验收。该阶段是纯静态 SPA：Vite 本地/CI 构建，Nginx 读取 `dist/`，没有 API 代理需求；当前配置已增加上述 API 隔离。任务 09 对最终历史产物的复跑见 [09 验收记录](../../.scratch/dynamics-viewer/acceptance-09.md)，不能继承为 #31 通过。
>
> **本节的命令、路径与素材属于迁移前的 React 实现**：`src/`、`public/demo-images/`、`pnpm test:e2e:preview` 等已随票据 12 删除，命令不再可直接执行，保留原文只为可追溯当时的交付证据。当前可执行命令见上文各节与 [frontend/README.md](../../frontend/README.md)。

## 1. 可复现构建

在仓库根目录执行；Node.js `24.21.0`、pnpm `10.34.6`、直接依赖和 lockfile 已固定。使用 nvm 与 pnpm，不在服务器现场解析新依赖。

```bash
source ~/.nvm/nvm.sh
nvm install
nvm use
corepack enable
corepack prepare pnpm@10.34.6 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:e2e:preview
pnpm build
```

发布目录为 `frontend/dist/`，不提交仓库；默认无 source map。`pnpm build` 使用生产归档 Adapter 并输出到 `dist/`；`pnpm build:mock` 与 `pnpm build:fault` 输出到 `dist-mock/`，因此故障装配不会污染生产产物（交付脚本会断言这一点）。不提供故障控制面板或公开故障 URL 参数；mock 不调用真实上游，生产读取只调用本地归档 API。读取失败与内容不存在由应用分别表达；不得发布故障服务。

`E2E_TARGET=preview pnpm test:e2e` 验证显式 mock 构建，不证明生产归档或 Nginx 的资源错误、缓存规则正确。Nginx 验证入口见第 4 节。

## 2. Nginx 配置与路径契约

示例：[deploy/nginx.conf](../../deploy/nginx.conf)。将它作为 `http` 上下文中的 `server` 配置包含；Nginx 主配置必须已加载 `mime.types`，建议 `default_type application/octet-stream`。修改 `root` 为可读的发布目录或 `current` 链接。示例仅监听 `127.0.0.1:4173`，供本机非特权验证；真实部署的监听地址、域名、TLS 和运维权限由维护者另行配置，本票不操作生产环境。

在应用配置生效前检查语法，再按维护者自己的运维流程启用；验证脚本不会 reload 系统 Nginx。

```bash
# 维护者配置好实际主配置路径后：
nginx -t -c /absolute/path/to/nginx.conf
```

| 路径类别 | 实际产物 / 请求例子 | 策略 |
| --- | --- | --- |
| 入口和 SPA 页面 | `/`、`/index.html`、`/dynamics/90071992547409934` | `Cache-Control: no-cache`，使用 ETag/Last-Modified 重新验证；未变可 304 |
| Vite 内容哈希资源 | `/assets/index-<hash>.js`、`.css` | 存在时 `public, max-age=31536000, immutable`；`/assets/` 仅放内容哈希文件 |
| 未版本化应用资源 | `/default-avatar.svg`、`/images/unavailable/placeholder.svg` | `no-cache`，返回前重新验证；不是一律永久缓存 |
| 明确资源命名空间中的缺失文件 | `/assets/missing.js`、`/assets/no-extension`、`/images/missing.svg`、头像缺失路径 | HTTP 404、`no-store`，不会回退为应用入口，也不会套用成功资源的长期缓存 |
| 未知页面、含点号的动态 ID | `/unknown.page`、`/dynamics/id.with.dot` | 返回入口 HTML，再由前端分别显示“未找到页面”或“动态不存在” |

资源靠**命名空间**分类：`/assets/`、`/images/`、`/default-avatar…` 明确预留给静态资源。不得增加“所有带扩展名的 URL 都是资源”的全局正则，也不得用 `error_page 404 /index.html` 掩盖资源错误。添加新的 `public/` 资源目录时（Vue 应用在 `frontend/public/`），须同步补明确资源规则和验证，而不是让缺失文件进入 SPA 回退。

**SPA 的前端未找到页面不是服务器 HTTP 404。** 未知页面与不存在的动态通常都获得入口 HTTP 200，再由应用区分；读取失败仍有局部错误与重试。这不要求 SSR，也不能用页面显示“未找到”作为资源 404 的证据。

Nginx 默认静态 ETag/Last-Modified 用于重新验证；`no-cache` 不是 `no-store`。长期缓存头只用于成功资源；错误路径单独返回 `no-store`，不要对所有响应无条件添加 immutable。

## 3. 发布更新

1. 在本地/CI 对固定依赖构建并测试，将完整 `dist/` 复制到新发布目录；Nginx 用户只需读取权限。
2. 保留上一版哈希资源：切换入口时，已打开页面仍可能使用旧脚本/样式。可将旧 `assets/` 中不冲突的哈希文件保留在新目录，或使用共享哈希资源目录。已发布同 URL 的内容不得改写；版本化图片也需按仍可访问的旧页面保留。
3. 在同一文件系统用重命名原子切换 `current` 链接，避免逐个覆盖正在提供的入口和资源；不要把 Nginx `open_file_cache` 长时间缓存旧链接（本示例未启用）。核对入口返回新的 HTML、新哈希资源可读、旧哈希资源仍可读。
4. 用旧入口 ETag 重新请求：更新后应得到 200 新入口，而不是旧 304；浏览器刷新有效详情仍可导航和看图。未变化的资源允许继续使用缓存。不要依赖强制刷新绕过缓存来掩盖错误策略。
5. 回退同样只切前端：先把**新**发布目录的 `assets/` 中不冲突的哈希文件补进上一版目录，再原子把 `current` 指回上一版。这样回退前已经打开的页面仍能取到新哈希脚本/样式，旧入口重新请求得到旧 HTML 而不是新入口的 304。不要回退 SQLite、不重启 collector，也不要删除新发布目录——它仍是最新回退前的产物。

本票脚本在临时源码副本中改变入口标题和一个执行标记，再实际构建 B、保留 A 的哈希资源并原子切换，随后把 `current` 指回 A 完成回退；同名脚本在生产构建上重复同一流程，并断言回退前后归档内容、数据库文件 inode 与 collector 进程未变。它不改真实源文件、`dist/` 的发布版本或真实部署目录。此演练验证交付机制，不等于提供自动发布平台或实施生产更新。

## 4. 可执行 Nginx 验证

需要本地可执行的 Nginx、与其匹配的 `mime.types`、Playwright Chromium 和空闲的 `127.0.0.1:4173`（被占用时用 `DELIVERY_PORT`）。当前统一入口还需 `uv sync --locked` 安装 dev 依赖并运行上方 #31 生产阶段；API 使用临时空闲端口。以非 root 用户运行，不需要系统服务、Docker、云账号或凭据。

```bash
source ~/.nvm/nvm.sh
nvm use
pnpm exec playwright install chromium
NGINX_BIN=/absolute/path/to/nginx \
NGINX_MIME_TYPES=/absolute/path/to/mime.types \
pnpm test:delivery

# 4173 已被现有实例/隧道占用时换端口，不停止现有服务：
DELIVERY_PORT=4273 \
NGINX_BIN=/absolute/path/to/nginx \
NGINX_MIME_TYPES=/absolute/path/to/mime.types \
pnpm test:delivery

# 历史 mock 浏览器仅选静态专项；仍包含构建/fault/更新及当前 #31 生产阶段：
NGINX_BIN=/absolute/path/to/nginx \
NGINX_MIME_TYPES=/absolute/path/to/mime.types \
pnpm test:delivery tests/e2e/static-delivery.spec.ts
```

系统已有 Nginx 时也可用 `NGINX_BIN=nginx NGINX_MIME_TYPES=/etc/nginx/mime.types`。脚本先检查端口空闲并构建；生成临时主配置，**直接包含交付示例**，替换 root 和临时 API 上游端口；验证配置、启动独立 Nginx、执行历史 mock 浏览器回归（桌面 Chromium / Pixel 7 模拟视口，不启动 Vite）、再核对相同输入重建和 `--mode fault` 的入口/bundle 字节一致，实际构建更新并验证条件请求、浏览器刷新与回退。Playwright 的 Nginx 分支由脚本传入 `E2E_NGINX_BASE`，换端口不需要改配置。随后执行上方 #31 生产装配阶段。正常结束或测试失败均退出临时进程、删除临时目录并恢复生产构建；若被系统强制终止，需自行清理残留临时进程/目录。

没有现成 Nginx、但已有编译器/make/PCRE2/zlib 时，可按以下方式在用户临时目录复现本票环境；不运行 `make install`，不修改系统设施。源码下载/编译失败应记录为环境限制，不能替换成 Vite 验收。

```bash
scratch=$(mktemp -d)
curl --fail --location --proto '=https' \
  https://nginx.org/download/nginx-1.28.0.tar.gz -o "$scratch/nginx.tar.gz"
tar -xzf "$scratch/nginx.tar.gz" -C "$scratch"
(cd "$scratch/nginx-1.28.0" && ./configure --prefix="$scratch/runtime" && make -j2)
NGINX_BIN="$scratch/nginx-1.28.0/objs/nginx" \
NGINX_MIME_TYPES="$scratch/nginx-1.28.0/conf/mime.types" \
pnpm test:delivery
# 全部测试结束后可删除源码/编译目录：
rm -r "$scratch"
```

专项从 HTTP/浏览器公开边界验证：

- 有效详情直达、刷新、看图和返回；未知页面/含点号 ID 的前端状态与入口 HTTP 200。
- 缺失脚本、样式、版本化/未版本化图片、无扩展名资源均 HTTP 404 + `no-store`，响应不是入口。
- 实际入口引用的 JS/CSS MIME 和缓存；版本图片、未版本化头像/素材目录文件的缓存；入口 ETag/修改时间 304。
- 既有图片测试在正常 Nginx 产物上验证缩略图懒加载、完整图片 URL（含参数）和仅当前预览请求；既有导航/历史回归也在同一产物执行。
- 相同输入重建、故障构建模式仍是正常装配、一次真实构建更新后的新入口/新资源/旧资源和浏览器执行。

手工诊断可在维护者启动的实际站点执行（自动脚本结束后本机 4173 不再提供服务）：

```bash
origin=http://127.0.0.1:4173
curl -i "$origin/dynamics/90071992547409934"
curl -i "$origin/unknown.page"
curl -i "$origin/assets/missing.js"
curl -i "$origin/assets/missing.css"
curl -i "$origin/images/missing.svg"
curl -I "$origin/"
curl -I "$origin/default-avatar.svg"
curl -I "$origin/images/unavailable/placeholder.svg"
# 先从入口取得实际 JS/CSS 路径，再对它们执行 curl -I；不要固定旧哈希。
# 用上一次入口的实际 ETag 替换占位值：
curl -i -H 'If-None-Match: "previous-entry-etag"' "$origin/"
```

记录 Nginx 版本、实际配置、环境和每项结果；环境不可用时保持对应验收项未勾选。执行证据见 [08 验收记录](../../.scratch/dynamics-viewer/acceptance-08.md)。

### 4.1 真实局域网 HTTP 回归与真机续验准备

`127.0.0.1` / `localhost` 属于浏览器可信上下文：上面的本机 Nginx 回归不能证明普通 HTTP 的 Web Crypto 能力。应用站点不以 HTTPS 为启动前提；会话、访问、预览标识优先沿用 `crypto.randomUUID`，不可用时由 `crypto.getRandomValues` 生成 UUID v4，不退化到 `Math.random`，也不作为授权凭证。这不意味着生产 HTTP 安全性与 HTTPS 等价。

在同一可信局域网另起**独立临时 Nginx**，仅监听机器实际的私有 IPv4 和空闲非特权端口，例如 `192.168.8.20:4180`；不要改系统 Nginx、防火墙或开启公网转发。主配置包含匹配的 `mime.types` 与示例 server，替换 `listen`、`root`，可用 `allow 192.168.8.0/24; deny all;` 进一步限制访问。IP/网段必须以实际环境为准。这个历史阅读/图片回归使用重新构建的显式 mock `dist/`，只放在隔离的临时站点；不能发布 `dev:fault`，也不能把 mock 当生产归档证据。

```bash
pnpm build:mock
# 按第3节更新该临时演示站点的发布副本，再启动/检查独立 Nginx。
# 下列 URL 替换为实际监听的私有 IPv4；不能填 localhost 或回环别名。
HTTP_ACCEPTANCE_URL=http://192.168.8.20:4180/ pnpm test:http
```

脚本要求 HTTP、真实私有 IPv4 和 Nginx 响应；通过实际 Chromium 页面断言 `isSecureContext === false`、`randomUUID` 不可用而 `getRandomValues` 可用，检查启动错误、四类标识的 UUID v4 格式、列表追加→详情→预览→关闭/前进/后退→列表恢复和刷新重置。不 mock crypto、不伪造安全上下文，也不使用浏览器安全豁免。它不负责启动或更新外部站点，必须与全量 `test:delivery` 一起执行；两者各自覆盖普通 HTTP 与资源/缓存/构建更新风险，不能互相替代。

历史 mock 自动化通过后可保持该隔离演示站点运行，向验收者提供 URL、构建哈希和独立 Nginx 停止命令，在 Linux Chrome 与 iPhone Safari 上人工检查。2026-10-12 用户已确认本期只验收这两类目标，其他设备/浏览器不再是续验待办；Chromium 模拟不能代替品牌 Chrome 或 iPhone Safari 真机，也不能把移出目标写成通过。临时地址、配置与续验范围见 [09 验收记录](../../.scratch/dynamics-viewer/acceptance-09.md)。

## 5. 素材与范围边界

本期 PNG/SVG 为项目内自绘素材（迁移前 React mock 使用，票据 12 已随旧栈删除，重建脚本不再保留），现由 `frontend/server/imageServer.mjs` 的夹具替代。浏览器按模型给定的 URL 请求，不依赖 B站外链、不改写图片参数。后续 OSS 由浏览器直连给定的 HTTPS URL；域名、CORS、权限、签名有效期和缓存需另行评估，本票不加应用服务器代理，不配置 OSS/CDN/云平台。

2 核 2GB 是静态站点的目标配置，**不是容量保证**；未采购、部署或压测真实服务器。后端、数据库、爬虫和总体资源占用仍需独立评估。TLS、生产权限/安全加固、发布自动化属于后续工作；Linux Chrome / iPhone Safari 的实际兼容检查及收口见任务 09，本票不声称这些已经验证。其他设备/浏览器不在当前本期目标内。

参考：[Nginx location/try_files/ETag](https://nginx.org/en/docs/http/ngx_http_core_module.html)、[缓存头规则](https://nginx.org/en/docs/http/ngx_http_headers_module.html)、[编译选项](https://nginx.org/en/docs/configure.html)。
