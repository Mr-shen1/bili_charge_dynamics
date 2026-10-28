# 部署与运维指南（本地／云端）

这是本项目**唯一现行的部署与运维主指南**：本地实例与云端实例共用同一套目录形状、同一个 systemd unit 形态、同一份 Nginx 规则与同一条发布／升级路径，差异只在少数参数（包管理器、端口、swap、域名与 HTTPS）上用[差异总表](#1-两环境差异总表)和[参数集中表](#2-目录端口与文件参数集中表)标注。不要为本地或云端各自维护一套步骤。

- 目录布局、数据／配置／凭据边界、systemd 与 Nginx 安装、前端发布、升级与一致性备份、回退边界、只读验收、排障、可选通知／OSS／Cookie 都在本页。
- 云端专属内容（ICP 备案、证书、安全组、SSH 隧道、可选 HTTPS 与 Basic Auth）见[云端专属：SSH 隧道、HTTPS 与 BasicAuth](#9-云端专属ssh-隧道https-与-basicauth)。
- 只保留这一份部署文档：旧的四份部署指南（`static-delivery`、`aliyun-ecs`、`local-live-backend`、`local-live-frontend`）已物理删除，原文只在 Git 历史里（`git show e58271c:docs/deployment/<旧文件名>.md`），本仓库不再保存副本、也不保留兼容页。

## 0. 状态、适用范围与不承诺

| 项 | 当前事实 |
| --- | --- |
| 云端 | 结构已**只读核验**：`/etc/systemd/system/bili-monitor.service`、`/srv/bili-monitor/app`、`/srv/dynamics-viewer/{releases,current}`、`/etc/nginx/conf.d/bili.conf`、`/etc/nginx/snippets/bili-locations.conf` 的路径、unit 指令集与监听端口来自实际读取。配置**路径**也已核验（只取三个路径值，未读任何秘密）：`BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite`、`BILI_COOKIE_FILE=/srv/bili-monitor/credentials/cookie.txt`、`BILI_NOTIFICATION_CONFIG=/srv/bili-monitor/credentials/notifications.json`，且 `BILI_OSS_*` 已配置（仅布尔）。仍未核验：`/etc/bili-monitor/env` 的其余内容与全部值、`credentials/` 内文件是否存在及其属主／权限／内容、数据库内容、备份 cron、OSS 具体项与通知路由内容。 |
| 本地 | 目标形态与机器差异已勘明，**尚未安装**：编写本文时没有任何目录、账号、unit、Nginx 或数据库被创建。入口：`scripts/setup-local-deployment.sh`（默认锚点＝脚本所在受信仓库的 main HEAD，包目录 `/var/tmp/bili-local-deployment/<锚点短 SHA>`；先加 `--check` 只读预检）。**包是否就绪以 `prepare-local-deployment-package.sh` 成功与 `--check` 退出 0 为准**；包目录或本文存在都不等于已安装。交付物与证据见[本机部署交付与证据](../../.scratch/local-cloud-deployment/README.md)。 |
| 结论边界 | 本文是操作说明，**不是验收结果**：不证明本地或云端已部署、不证明真实上游／OSS／飞书可用、不构成容量、真机或持续运行证据。 |
| 授权边界 | 迁移、部署、重启云端服务、读取凭据、修改安全组都不由文档授权；每次执行都需对应的人为授权。 |

已核验的两台机器（写入参数表时不得夸大一致）：云端 **Debian 13.6**、2 vCPU／2 GiB + 手工 2 GiB swap、Nginx **1.26.3**（发行版包）、venv 内 Python 3.12.15；本地 **CachyOS（Arch 系）**、15 GiB 内存与已启用的 swap、Nginx 尚未安装（可用 Arch `extra` 的 1.30.x）、包管理为 `pacman`。**操作系统与 Nginx 版本不同，且本指南不声称它们一致**；配置语法（`listen`／`root`／`proxy_pass`／`include`／`gzip`／`add_header`）在两边相同，但仍须在各自机器上 `nginx -t` 实测。

## 1. 两环境差异总表

差异只允许出现在下表的行里；其余步骤两边一字不差。

| 项 | 云端（实测） | 本地（目标形态） | 影响 |
| --- | --- | --- | --- |
| 发行版／包管理 | Debian 13.6，`apt` | CachyOS（Arch 系），`pacman`（无 `apt`） | 只有「装组件」一行命令不同；`sudo` 本地已装 |
| Nginx | 1.26.3（系统包，`/usr/sbin/nginx`），默认站点在 `sites-enabled` | 未安装，可装 Arch `extra` 的 1.30.x；包自带**激活的** `server { listen 80; }` 且无 `conf.d` include | 版本与包布局不同；本地安装后必须先隔离包默认的 80 站点再启用（见 §3.6），云端只需移除 `sites-enabled/default` |
| Web 监听端口 | `127.0.0.1:4173` | `127.0.0.1:4273` | 只改安装后 `bili.conf` 的一行 `listen`；**避开既有 `~/.ssh/config` 中 Host `bili` 的 `LocalForward 4173`** |
| API 监听端口 | `127.0.0.1:8000` | `127.0.0.1:8000` | 相同；`proxy_pass` 两处不用改 |
| 浏览器入口 | 经 SSH 隧道 `http://127.0.0.1:4173` | 本机直连 `http://127.0.0.1:4273` | 云端必须先建隧道；本地不需要隧道 |
| swap／内存 | 2 GiB 内存，必须手工建 2 GiB swap | 15 GiB 内存 + 已启用 swap | 云端必须做 swap 与 `vm.swappiness`，本地不做；**不为对齐而虚构本地 swap 步骤** |
| 备案／域名／证书／Basic Auth | 大陆节点必须 ICP 备案，可选 HTTPS | 不涉及（仅回环访问，不装 `nginx-ecs-https.conf`） | 见[云端专属](#9-云端专属ssh-隧道https-与-basicauth)；本地不伪造监管步骤 |
| 通知进程 | **已装配**（env 里 `BILI_NOTIFICATION_CONFIG` 存在，路径已核验；路由内容未读） | 不设 `BILI_NOTIFICATION_CONFIG`（两进程） | 启用状态差异，不是位置另搞一套；见[选配：通知进程、OSS 与 Cookie](#8-选配通知进程oss-与-cookie) |
| OSS 媒体归档 | `BILI_OSS_*` 已配置（仅布尔；具体项未读） | 不配（媒体待归档，不作为完成条件） | 启用状态差异；变量名与位置不变，见[选配节](#8-选配通知进程oss-与-cookie) |
| B 站 Cookie | 文件形态 `/srv/bili-monitor/credentials/cookie.txt`（是否存在与内容未读） | 不设（匿名） | 启用状态差异，不另搞位置；日后启用用同一路径 |
| 数据与凭据 | 生产库与真实凭据（内容未读；**不搬运**） | 新空库、无真实凭据 | 本地不复用 live-34 的任何路径／端口／DB／`.venv`；也不复制云端生产库或秘密 |
| 提权 | 维护者终端 | `sudo` 需密码（交互 TTY） | 本地安装必须由管理员在自己终端执行；**不推荐 NOPASSWD，也不要把密码交给代理** |

## 2. 目录、端口与文件：参数集中表

云端实测与本地的目标形态**逐项同路径**（唯一例外是 Web 监听端口）。本页剩余章节只引用这些名字，不再重复路径。

| 名称 | 路径／值 | 属主与权限 | 说明 |
| --- | --- | --- | --- |
| 运行账号 | `bili` / 组 `bili` | — | 本地首次安装时创建；云端已存在 |
| 代码检出 | `/srv/bili-monitor/app` | `bili:bili` 775 | **单 git 检出，无 `releases/`、无 `current`** |
| Python 环境 | `/srv/bili-monitor/app/.venv` | 同上 | 就地 venv，由 `bili` 用 uv 同步；**不复用开发者的仓库 `.venv`** |
| 数据目录 | `/srv/bili-monitor` | `bili:bili` 755 | unit 的 `ReadWritePaths` 只有它 |
| 数据库 | `/srv/bili-monitor/monitor.sqlite` | `bili` 可写 | 三进程必须同一绝对路径；旁生 `.collector.lock`、`.notifier.lock` |
| 备份目录 | `/srv/bili-monitor/backup` | 755 | 一致性备份落这里 |
| 凭据目录 | `/srv/bili-monitor/credentials` | `700 bili:bili` | 云端实测存在；`cookie.txt` 与 `notifications.json` 同目录（内容与文件属性未读）；本地向导预建空目录 |
| 环境文件 | `/etc/bili-monitor/env` | `0600 root:root` | 由 systemd `EnvironmentFile=` 注入；应用不读 `.env` |
| unit | `/etc/systemd/system/bili-monitor.service` | `0644 root:root` | 与仓库模板 `deploy/bili-monitor.service` 指令集一致 |
| 前端发布根 | `/srv/dynamics-viewer` | 两端均 `root:root` 755（云端实测） | 前端由 Nginx 只读提供；发布需 root／sudo 写权限，不归 `bili` |
| 前端版本目录 | `/srv/dynamics-viewer/releases/<UTC>-<commit>/` | 可读 | `rsync` 自 `frontend/dist/`，保留 5 个 |
| 前端当前入口 | `/srv/dynamics-viewer/current` → `releases/…` | 软链 | `ln -sfn` + `mv -Tf` 原子切换 |
| Nginx 站点 | `/etc/nginx/conf.d/bili.conf` | `0644 root:root` | 仅 `listen 127.0.0.1:<WEB_PORT>` |
| Nginx 片段 | `/etc/nginx/snippets/bili-locations.conf` | `0644 root:root` | `root`、缓存、SPA 回退与两处 `proxy_pass` |
| API 监听 | `127.0.0.1:8000` | — | 两端相同，**只回环** |
| Web 监听 | 云端 `127.0.0.1:4173`／本地 `127.0.0.1:4273` | — | **只回环**；不监听 `0.0.0.0` |
| schema | `v27` | — | 由 API lifespan／collector／notifier 的 `Store.migrate` 自动迁移 |
| 前端构建链 | Node `24.21.0`、pnpm `10.34.6` | — | 只在开发机／CI 用；服务器不装 Node |

运行形态：一个 API、一个 collector、可选一个通知进程，由**同一个** unit 托管（`python -m backend.bili_monitor.service`）；没有 `--workers`、`--reload`、`WEB_CONCURRENCY`、Redis、Celery 或额外任务服务。前端由 Nginx 单独托管静态产物。

```
/srv/bili-monitor/
├── app/               单检出 + 就地 .venv（无 releases/current）
├── monitor.sqlite     + .collector.lock / .notifier.lock
├── backup/
└── credentials/       0700（cookie.txt / notifications.json；仅在启用时存在）
/etc/bili-monitor/env  0600 root:root
/srv/dynamics-viewer/
├── releases/<UTC>-<commit>/
└── current -> releases/…
/etc/systemd/system/bili-monitor.service
/etc/nginx/conf.d/bili.conf
/etc/nginx/snippets/bili-locations.conf
```

## 3. 首次部署共用流程

下面的顺序对本地与云端完全一致；只有标注了「云端／本地」的行不同。**本节的命令一次都没有被本仓库的代理执行过**（本地需要管理员 TTY，云端需要单独授权）。

本地优先用下面的安装向导（它机械完成 3.1–3.8，人工仍是唯一能提供 `sudo` 的人）；云端没有向导，按 3.1–3.8 手工执行。两条路径产出同一个形态，向导不引入第二套目录或端口约定。

### 3.0 本地：安装向导（一个入口，一个包）

```bash
# 仓库根目录。先只读预检（不写文件、不调 sudo、可反复跑；退出码 0 = 无阻塞问题）
scripts/setup-local-deployment.sh --check

# 确认后由用户在**自己的终端**执行（7 个阶段，每阶段一个 confirm；sudo 密码只在 TTY 输入）
scripts/setup-local-deployment.sh

# 可选参数：显式包目录（必须与锚点同版本）／显式锚点（仅用于回归旧包）
scripts/setup-local-deployment.sh --package <包目录>
scripts/setup-local-deployment.sh --commit <40 位完整 SHA> --package <旧包目录>
```

- 版本锚点：默认取**正在运行脚本所在的受信仓库的 `HEAD`**（要求 `HEAD == main`、该提交里存在同名脚本且与正在跑的脚本逐字节相同、两个安装脚本无未提交改动），否则向导直接拒绝并提示“先提交后正式安装，或用 `--commit` 回归旧包”。包目录依次取 `--package` → `$BILI_DEPLOY_PACKAGE` → `/var/tmp/bili-local-deployment/<锚点短 SHA>`；**版本不符的目录不会被采用**。
- 打新包（无 sudo，普通用户）：`scripts/prepare-local-deployment-package.sh` 用当前 main HEAD，输出到 `/var/tmp/bili-local-deployment/<HEAD 短 SHA>`；另有 `--output DIR`、`--commit <完整 SHA>`（回归旧提交）与 `--replace`（仅覆盖 MANIFEST 可校验的同提交旧包）。脚本内没有硬编码提交号，也不从旧包反推期望版本。
- **就绪判据**：准备包必须来自已提交的 main；以 `prepare` 成功、包内 MANIFEST/bundle 校验通过与 `--check` 退出 0 为唯一判据。包目录、`VERSION` 或本文存在都**不等于**已安装，也不等于锚点匹配。旧提交的包只配 `--commit` 回归，不代表现行安装版本。
- 向导的阶段：预检（含包与锚点校验）→ 依赖（`pacman -S --needed`，不 `-Syu`，+ uv 到 `/usr/local/bin`）→ 账号与目录 → 从包内 bundle 检出到 `/srv/bili-monitor/app` 并 `uv sync --locked --no-dev` → 系统配置（env／unit／Nginx；其中 Nginx 含[§3.6](#36-nginx-与静态站点) 的包默认 80 站点隔离硬门，`nginx -t` 失败则恢复备份且不启动服务）→ 前端 `rsync` + `mv -Tf` 原子切 `current` → 校验后 `enable --now` 并跑第 4 节那组只读检查。root 写入前会再次确认锚点未变，并用包内锚点提交反向校验 `render/` 的 unit/snippet。
- 向导**不会**以 root 运行整个脚本、不捕获或保存 sudo 密码、不改 sudoers、不改 SSH／swap、不动 live-34。
- 重跑边界（**不承诺“已有数据可随意重跑”**）：只有向导自己创建并在 `/var/lib/bili-local-deployment/state.tsv` 里记录且未被改动的对象才可续跑（写盘成功但登记未落地的 Nginx main 有唯一例外：条件成立且内容与受管写盘预期逐字节相同时只补登记、不重写，见[§3.6](#36-nginx-与静态站点)）；**未识别的已存在对象一律拒绝**（含非本向导创建的 DB／env／unit／Nginx 配置／`current`），此时应人工判清来源，**不要删库、也不要按旧提示去“备份移除”受管文件**。首启由迁移创建的空库属于受管对象：即使第 7 阶段健康检查未全部通过，库也保留，修复问题后重跑可继续而不是重建。
- 状态与权威描述：沙箱测试结果、锚点拒绝矩阵与重跑语义以[交付 README](../../.scratch/local-cloud-deployment/README.md)、`evidence/verification-log.txt` 与脚本 `--help` 为准，本文不另行定义。**本次安装仍需用户在自己的 TTY 确认 `sudo`，不声称已完成**；因此 `nginx -t`、`systemd-analyze verify`、健康检查、重跑与浏览器验收的真机行为仍需执行后才有结论。
- root 侧只留一份状态记录：`/var/lib/bili-local-deployment/state.tsv`（本脚本创建的目录／文件 SHA256／账号／release／软链），不是第二套配置来源。
- **仍未安装**：截至本文编写时向导尚未被用户执行，因此本地依旧没有 `bili` 账号、`/srv/bili-monitor`、Nginx、unit 或数据库；真机结果（`nginx -t`、`systemd-analyze verify`、健康检查、浏览器验收）必须等执行后才能声称。

### 3.1 勘察与系统准备

先看再动，确认端口与目录没有被别的服务占用：

```bash
ss -tlnp | grep -E ':(80|443|4173|4273|8000)\b' || echo 'none occupied'
free -h; df -h /
cat /etc/os-release | head -3
nginx -v 2>&1 || echo 'nginx: not installed'
python3 -V
ls -la /srv/
```

云端还须核对控制台安全组入方向**只剩 22**（见[云端专属](#9-云端专属ssh-隧道https-与-basicauth)）。

安装组件与 uv：

```bash
# 云端（Debian 13.6；最小安装可能没有 sudo，一并装上）
sudo apt update && sudo apt install -y nginx sqlite3 curl git rsync sudo
# 本地（CachyOS/Arch；sudo 已装。包名是 sqlite，不是 Debian 的 sqlite3）
sudo pacman -S --needed nginx sqlite git rsync curl
```

```bash
# uv：装到 bili 可执行的系统路径，不复用开发者个人 uv
curl -LsSf https://astral.sh/uv/install.sh | sh
sudo install -m 0755 ~/.local/bin/uv ~/.local/bin/uvx /usr/local/bin/
```

只有云端需要 swap（2 GiB 内存跑 Python + SQLite + Nginx 会 OOM）：

```bash
# 云端专属；本地内存与 swap 已就绪，跳过整节
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-bili.conf
sudo sysctl -p /etc/sysctl.d/99-bili.conf
```

本地 `/srv` 已有 `ftp/`、`http/` 等无关子项，**不要改动它们**；本地 `/etc/nginx` 在装包前只有 `mime.types`（属 `mailcap`）、没有 `sites-enabled`，所以云端 Debian 的 `rm -f /etc/nginx/sites-enabled/default` 在本地**不适用也不必执行**。但装上 nginx 包后会多出一份含**激活** `listen 80` 默认 server 的 `nginx.conf`，必须在启用前隔离——见[§3.6](#36-nginx-与静态站点) 的硬门。

### 3.2 运行账号与目录

```bash
sudo useradd -m -s /bin/bash bili          # 已存在则跳过
sudo mkdir -p /srv/bili-monitor/backup \
             /srv/dynamics-viewer/releases \
             /etc/bili-monitor /etc/nginx/conf.d /etc/nginx/snippets
# 数据目录归运行用户；前端发布树保持 root:root（与云端实测一致，发布用 sudo）
sudo chown -R bili:bili /srv/bili-monitor
sudo chmod 755 /etc/bili-monitor /srv/dynamics-viewer /srv/dynamics-viewer/releases
```

`credentials/` 只为可选的 Cookie 与通知路由文件而建（目录 `700` 属 `bili`；实测云端两个文件都在这里：`cookie.txt`、`notifications.json`）。本地安装向导会**预建一个空目录**（无假 Cookie／假 webhook），手工安装则可省略，将来启用仍用同一位置，不为本地另定一套路径：

```bash
sudo install -d -m 0700 -o bili -g bili /srv/bili-monitor/credentials   # 选配
```

### 3.3 代码、依赖与虚拟环境

检出到与云端同路径，**单检出、无 `releases/current`**。发布用的版本必须是已提交的 commit，不要把未提交改动带进服务器：

```bash
# 云端：从维护者选定的远端
sudo -u bili git clone <仓库地址> /srv/bili-monitor/app
# 本地：可从本机工作仓库离线检出（同 commit 形态），也可用远端
sudo -u bili git clone /home/kevin/Projects/PI/bili_charge_dynamics /srv/bili-monitor/app

cd /srv/bili-monitor/app
sudo -u bili env HOME=/home/bili /usr/local/bin/uv sync --locked --no-dev
```

要点：

- `HOME=/home/bili` 让 uv 把 CPython 放在 `/home/bili/.local/share/uv/`，`.venv/bin/python` 只是软链到那里——这正是 unit 里 `ProtectHome=read-only`（**不能设 `yes`**）的原因，设 `yes` 会报 `status=203/EXEC`。
- 纯生产用 `--no-dev`；要跑 pytest 需重新 `uv sync --locked` 装 dev 依赖。
- 前端构建不在服务器上做（服务器不装 Node），见[前端发布](#37-前端发布)。

### 3.4 配置与凭据边界

配置入口只有两个，都在仓库外：`/etc/bili-monitor/env`（`0600 root:root`，由 systemd 读取后注入；应用本身**不读 `.env`**）与可选的**通知路由 JSON**（只有设了 `BILI_NOTIFICATION_CONFIG` 才存在，标准位置见下，不进版本库）。除此之外不做任何自动凭据发现。

```bash
sudo install -D -m 0600 -o root -g root \
    /srv/bili-monitor/app/deploy/bili-monitor.env.example \
    /etc/bili-monitor/env
sudoedit /etc/bili-monitor/env      # 只需真的改必填项
```

- 必填只有 `BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite`；模板里的 `PYTHONDONTWRITEBYTECODE=1`、`PYTHONUNBUFFERED=1` 保留。
- **可选变量不要留空值。** OSS 七项、`BILI_COOKIE_FILE`、`BILI_NOTIFICATION_CONFIG` 不用时保持模板里的注释状态；`BILI_OSS_ENDPOINT=` 这类空值会被 systemd 注入成空字符串，既不是「未设置」又会触发 `Incomplete OSS configuration`，`BILI_COOKIE_FILE=` 同理会让启动直接失败。
- 可选文件的两个标准位置（与云端实测一致）：`/srv/bili-monitor/credentials/cookie.txt`（Cookie）与 `/srv/bili-monitor/credentials/notifications.json`（通知路由）。`deploy/bili-monitor.env.example` 的注释示例已统一到这两个路径（仍为注释、不启用；该改动尚未提交，打包脚本只允许注释行差异）。
- 凭据边界：秘密只出现在仓库外的受限文件里（env 的值、`credentials/` 内的 Cookie 与通知路由、OSS AccessKey、飞书 webhook／签名密钥）。**不进版本库、不进构建产物、不进日志、不进命令行参数、不出现在 HTTP／UI／发件箱**。读 env、Cookie、DB 内容都属独立授权动作，本文不提供读取命令。
- 本地本轮是**新空库 + 无真实凭据**：不设 OSS、不设 Cookie、不设通知配置，因此只有 API + collector 两个进程。

### 3.5 systemd 托管

模板与云端实测的 unit 指令集一致，**原样安装**，不要为环境差异改写 unit：

```bash
sudo install -D -m 0644 /srv/bili-monitor/app/deploy/bili-monitor.service \
    /etc/systemd/system/bili-monitor.service
sudo systemctl daemon-reload
sudo systemctl enable bili-monitor        # 首次启动放在 3.8，先确认迁移
```

关键指令（与模板一致，改动前先读模板注释）：

| 指令 | 值 | 为什么 |
| --- | --- | --- |
| `User=` / `Group=` | `bili` / `bili` | 非特权运行；数据目录属主同账号 |
| `WorkingDirectory=` | `/srv/bili-monitor/app` | 单检出，升级只切这个目录里的 commit |
| `EnvironmentFile=` | `/etc/bili-monitor/env` | 唯一配置入口；`Environment=` 留空 |
| `ExecStart=` | `.venv/bin/python -m backend.bili_monitor.service --host 127.0.0.1 --port 8000` | 统一入口托管全部子进程；只回环 |
| `Restart=always` / `RestartSec=5s` | — | 崩溃由 systemd 拉起 |
| `KillSignal=SIGTERM` / `TimeoutStopSec=60s` | — | 给 collector 取消在途任务并清理的时间 |
| `NoNewPrivileges` / `PrivateTmp` / `ProtectSystem=strict` | `yes` | 收紧权限 |
| `ProtectHome=read-only` | `read-only` | **不要设 `yes`**（uv 的 CPython 在 `/home/bili/.local/share/uv/`） |
| `ReadWritePaths=` | `/srv/bili-monitor` | 只允许写数据目录；前端发布目录由发布动作单独写 |

提示：模板 `deploy/bili-monitor.service` 的 `Documentation=` 指向唯一主指南 `docs/deployment/README.md`；云端已部署的 unit 未经授权不改（其 `Documentation` 可能仍指旧路径，不影响运行，改它属云端变更）。unit 其余指令不变，模板与云端实测指令集一致。

### 3.6 Nginx 与静态站点

安装同一份片段与站点配置，**云端原样、本地只改一行 `listen`**：

```bash
sudo install -D -m 0644 /srv/bili-monitor/app/deploy/nginx-locations.conf \
    /etc/nginx/snippets/bili-locations.conf
sudo install -D -m 0644 /srv/bili-monitor/app/deploy/nginx-ecs-tunnel.conf \
    /etc/nginx/conf.d/bili.conf
```

```bash
# 仅本地：把已安装文件里的 listen 改成 4273（其余一字不改）
sudoedit /etc/nginx/conf.d/bili.conf      # listen 127.0.0.1:4173;  ->  listen 127.0.0.1:4273;
```

```bash
# 云端（Debian 的默认站点在 sites-enabled；本项目不开 80，nginx 已在运行，实测 active）
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

**本地（CachyOS/Arch）不能直接 `enable --now`。** 发行版 nginx 包自带的 `/etc/nginx/nginx.conf` 里有一条**激活的**默认 server：`server { listen 80; root /usr/share/nginx/html; … }`（无地址即绑定 `0.0.0.0:80`），而且这份默认文件不含 `conf.d/*.conf` 的 include（`mime.types` 由 `mailcap` 提供）。只"追加 `conf.d` + 软确认"会让本实例在 `0.0.0.0:80` 上对外提供一个默认站点，这不是本项目允许的状态。

本地按下面的定版流程执行，**任一条不满足就停手**（不做"先起来再说"的变通）：

1. **只对本次新装的包默认配置动手。** 触发条件是向导记录的新装标记（`pkg:nginx-fresh-install`）：不是本次新装、或该配置已被人工改过，一律**不动**，交人工判断。
2. **证明盘上文件就是包原文。** `pacman -Q nginx` / `pacman -Qo /etc/nginx/nginx.conf` 取实际版本与归属；从 pacman 缓存取**同版本且唯一**的包（`/var/cache/pacman/pkg/nginx-<该版本>-*.pkg.tar.zst`），`bsdtar -xOf <包> etc/nginx/nginx.conf` 与盘上文件**逐字节比对**。缓存缺失、存在多个候选、内容不符、缺 `mime.types`、或原文里有激活的 `load_module` ⇒ **一律不动并停止**（不改其它站点、不删 `default`／HTML 目录、不用 `--overwrite`）。
3. **root 私有备份。** 备份为 `/var/lib/bili-local-deployment/backups/nginx.conf.<UTC>.orig`（目录 0700、文件 0600），不往 `/etc/nginx` 里制造非包拥有的文件。
4. **规范成受管 main。** 结果里**没有默认 server、没有任何 `listen 80`**；保留原文的 `modules.d`（如原文有）、`mime.types` 与 `include conf.d/*.conf`。**绝不**把默认 server 的 `listen` 改成 `127.0.0.1:80`——那仍是 80 上的默认站点，不符合目标。
5. **`nginx -t` 失败即回滚，且不启动服务。** 恢复原内容与原 mode；不存在"配置没通过但先把服务起来"的路径。
6. **启动前的硬门（无 override）。** 在写配置、复检与 `enable` 之前都用生效配置（`nginx -T`）判定：只要出现任何 `:80` 监听（**含 `127.0.0.1:80`**）就拒绝继续；没有"仍要启用 nginx"之类可以越过此门的确认。
7. **续跑规则。** 受管且安全（无 80）的 main 可续跑；旧受管 main 若仍是 80，不续跑，按第 2–5 步重新规范或交人工。
8. **写盘后尚未登记的断点。** 若 main 已被写成本项目受管内容、但状态登记还没落地（例如中途退出），**只在**可信新装标记与包来源、权限条件均已成立、且当前内容与受管写盘预期**逐字节相同**时**补登记、不重写**；其它任何未知配置仍然拒绝，交人工处理。

未安装 nginx 时，`--check` **只说明计划**（"装后包自带 `listen 80`，会被隔离"），**不等于**已经验证过安装后的 vendor 文件；逐字节确认只发生在安装之后、启用之前。反过来，当 nginx 是**本次由向导新装**、且盘上 `/etc/nginx/nginx.conf` 与同版本缓存包原文逐字节相同时，`--check` 会做同样的比对，并把这条 `listen 80` 记为「Stage 5 将备份隔离」而不阻断；`conf.d/`、`sites-enabled/` 里的 80 监听仍按外来占用硬阻断。

验收只保证**本实例不占任何 `:80`**（生效配置里没有 `listen 80`，`ss` 里该项目只有 `127.0.0.1:8000` 与 `127.0.0.1:4273`）。宿主机上其它程序的 80 **只记录、不停掉**，也不在本项目承诺范围内。

> 证据边界：以上"包自带激活 `listen 80`"是就**同版本号的 Arch 官方包**核验的；本机 CachyOS 优化包本体未取得，因此安装后仍必须按第 2 步用本机缓存包逐字节确认。脚本命令、提示文案与状态键以 `scripts/setup-local-deployment.sh --help` 及当前实现为准；真机 sudo 执行后的表现仍属待用户实测项。

端口与规则约束（**两端相同**）：只监听回环；`/api`、`/api/…` 原样转发 `127.0.0.1:8000`，不拦截其错误；API 200/404/422 或 Nginx 502 都不得成为 SPA 入口；明确资源命名空间（`/assets/`、`/images/`、`/default-avatar*`）缺失返回 `404` + `Cache-Control: no-store`；`access_log off; error_log /dev/null;` 必须保留（见[附录：静态交付与缓存、路由约束](#附录静态交付与缓存路由约束)）。改 API 端口要同步改片段里的两处 `proxy_pass`；模板不会展开 shell 变量。

云端若要动 Nginx，先核对实际生效配置：实测 `/etc/nginx/conf.d/` 下另存在 `bili-readonly.conf`（及 `.bak`）与我们的 `bili.conf` 并存，**其差异未核验**；用 `sudo nginx -T` 看最终生效内容，不要凭文件名判断。

### 3.7 前端发布

构建在开发机或 CI 完成，服务器只接收静态产物。发布语义两端相同：**新 `releases/<UTC>-<commit>/` → `mv -Tf` 原子切换 `current` → 保留最近 5 个版本**；不要在服务器上就地覆盖 `dist/`，也不要发布 `build:mock`／`dist-mock`。

云端用现成脚本（要求工作区干净，构建 + rsync + 原子切换 + 清理）。注意发布树属主是 `root:root`，所以脚本使用的 SSH 登录用户必须能在服务器上建目录并写入 `/srv/dynamics-viewer`（即 root 或具备相应 sudo 的方式）；**不声称该脚本已在云端以非 root 跑过**：

```bash
pnpm install --frozen-lockfile
HOST=<user>@<服务器> scripts/deploy-frontend.sh
```

本地没有可 SSH 的目标，用同一脚本的本地模式（`/srv` 属 root，脚本会调用 sudo）：

```bash
scripts/deploy-frontend.sh --local
```

两端语义完全一致（构建 → 新 `releases/<UTC>-<commit>/` → 原子切换 → 保留 5 个），只有传输方式不同：云端走 `ssh`+`rsync`，本机直接写本地目录。

发布约束（两端相同，来自静态交付的技术规则）：

1. 旧版本哈希资源必须仍可读——切入口时已打开页面还会请求旧脚本／样式；已发布的同 URL 内容不得改写。
2. 回退只切前端：先把新版本 `assets/` 里不冲突的哈希文件补进上一版目录，再原子把 `current` 指回上一版（见[回退边界](#6-回退边界只前进)）。
3. 校验入口返回新 HTML、新哈希资源可读、旧哈希仍可读；不要把 `open_file_cache` 长时间挂在旧链接上。
4. 前后端版本不匹配时前端会按 API 契约拿到错误响应而不会崩溃，但应当同批发布。

### 3.8 首次启动与迁移确认

```bash
sudo systemctl start bili-monitor
sleep 5
systemctl status bili-monitor --no-pager
journalctl -u bili-monitor -n 50 --no-pager
```

迁移由 **API 的 ASGI lifespan** 自动执行（collector 取得锁后、通知进程启动时同样调用 `Store.migrate`），**没有独立迁移 CLI，也没有自动降级**。当前 schema 是 **v27**（旧文档里的 v16／v23 是历史值，不再作为现行判据）。空库创建、旧库按序事务升级、失败回滚、未来版本拒绝启动。

首次启动后**先只做只读核对**（下一节），确认 API 迁移完成并监听、collector 取得锁：

- 本地本轮是空库，API 与 collector 启动**不会产生任何上游请求**；
- 如需先把「迁移 + API 就绪」与「会打上游的进程」分开，可按旧式手动方式**只启动 API**（`uvicorn backend.bili_monitor.app:app`，与统一入口互斥，验证完停掉再交回 systemd）或接受统一入口的内建顺序（API 就绪后才拉起 collector 与通知进程）；collector 与通知进程的首次启动、以及通知路由的接入都需单独授权，不能拿它们当验收手段；
- 升级或重启后 collector 会恢复持久未完成工作，**可能立即产生上游请求**——这是正常运行语义，不要拿「新增 UP」「初始化」「手动探测」当作验收手段，也不为验收主动制造 412／429 或改动风控状态。

## 4. 只读验收清单

只读验收**只用 GET**。会打真实上游或会改变持久状态的入口一律不在验收里使用：`POST /api/manage/ups`、`/api/sync/initial`、目标写入、`POST /api/manage/risk/probe`、以及改变通知三态的 `PUT /api/manage/notifications`。

本地向导的第 7 阶段会自动跑下面这组检查，并拒绝把“非回环监听”或“非 `off` 初始态”当作成功；手工执行时照本节做。

```bash
API=http://127.0.0.1:8000
WEB=http://127.0.0.1:4173       # 本地改成 4273
systemctl is-active bili-monitor
curl -fsS "$API/api/manage/ups" ; echo
curl -fsS "$API/api/manage/notifications" ; echo
curl -fsS "$API/api/manage/risk" ; echo
ss -tlnp | grep -E ':(4173|4273|8000)\b'
```

| 检查 | 期望 | 备注 |
| --- | --- | --- |
| `systemctl is-active bili-monitor` | `active` | 单元托管全部子进程 |
| `GET /api/manage/ups` | 新空库 `{"ups":[]}`；云端返回既有身份与配置 | 不要用新增 UP 验证 |
| `GET /api/manage/notifications` | `state=off`、`pending=0`（新库默认 `off`） | **`off` 是投递开关，不是进程停止**，见[选配节](#8-选配通知进程oss-与-cookie) |
| `GET /api/manage/risk` | 正常态 | 只读；不要为验收改风控状态 |
| `curl -sS "$WEB/"`、`"$WEB/manage"` | `200` | 管理页 200 不等于已鉴权（本地／隧道形态无应用鉴权） |
| `curl -sS -o /dev/null -w '%{http_code}' "$WEB/api/nope"` | `404`，**不是** 200 HTML | 反代语义 |
| `curl -sSI "$WEB/assets/nonexistent.js"` | `404` + `Cache-Control: no-store` | 资源错误不回退入口 |
| `curl -sSI "$WEB/"` | 入口 `200` + `Cache-Control: no-cache`（HEAD 足够，不涉压缩） | 从入口取实际哈希，不要固定旧值 |
| 实际生产 JS/CSS（≥1024 B）的 GET | `200` + `Cache-Control: public, max-age=31536000, immutable` + `Content-Encoding: gzip` | **必须 GET 且声明压缩**；见下方命令 |
| `ss -tlnp` | 只有 `127.0.0.1` 上的 8000 与 Web 端口 | 无 `0.0.0.0` 监听 |
| `sudo nginx -T` 的生效配置 | 只有 `listen 127.0.0.1:<Web 端口>`；**任何 `:80`（含 `127.0.0.1:80`）与 `default_server` 都不允许** | 本实例不占 `:80`；宿主机其它程序的 80 只记录、不停掉 |
| `journalctl -u bili-monitor` | 无 traceback、无迁移失败、无 `future schema`、无锁冲突 | 固定分类日志，不含 URL／正文／凭据 |
| schema 版本（只读） | `user_version = 27` | 见下 |

只读方式确认 schema（不写库）：

```bash
sudo -u bili python3 -c "
import sqlite3
con = sqlite3.connect('file:/srv/bili-monitor/monitor.sqlite?mode=ro', uri=True)
print('user_version', con.execute('PRAGMA user_version').fetchone()[0])
"
```

小于 27 是迁移未执行；大于 27 是库比代码新，旧代码会拒绝启动。**不要改 `user_version`、不要删库、不要用旧版本强开新库。**

确认压缩与缓存头（**和向导第 7 阶段同一条路径**：先从 `/srv/dynamics-viewer/current` 选一个 ≥1024 B 的真实生产 JS/CSS，再对同一个 Web 端口发 GET；`$WEB`／`$API` 沿用本节开头的变量，本地 `WEB` 为 `http://127.0.0.1:4273`）：

```bash
# curl -I/--head 默认不发送 Accept-Encoding，未显式声明可接受压缩时 nginx 的 gzip on 不会压缩，
# 旧手册用裸 HEAD + grep Content-Encoding 去断言 gzip 就是必败的。这里改成真实 GET 并声明 --compressed。
# 取样取“最大的一份 ≥1024 B 生产 JS/CSS”；本文与向导都在同一发布树/同一路径上取，
# 但**不声称两边逐字选中同一个文件**。
asset=$(find /srv/dynamics-viewer/current/assets -maxdepth 1 -type f \
          \( -name '*.js' -o -name '*.css' \) -size +1023c \
          -printf '%s\t%f\n' | sort -rn | head -1 | cut -f2)
test -n "$asset" || echo '未找到 ≥1024B 的 JS/CSS 资源，先确认 current 指向有效发布'
curl -sS --compressed -m 5 -D - -o /dev/null "$WEB/assets/$asset" \
  | grep -iE '^(HTTP/|content-encoding|cache-control)'
```

期望：`HTTP/1.1 200`、`Content-Encoding: gzip`、`Cache-Control: public, max-age=31536000, immutable`。若资源小于 `gzip_min_length 1024`，不压缩属正常，所以取样必须先卡 ≥1024 B；`--compressed` 等价于显式 `-H 'Accept-Encoding: gzip'`，两者择一。

云端的浏览器验收先建隧道（见[云端专属](#9-云端专属ssh-隧道https-与-basicauth)），再打开 `http://127.0.0.1:4173`；本地直接打开 `http://127.0.0.1:4273`。两端都不要靠「加一个 UP 看有没有采集」来证明部署成功。

## 5. 升级与一致性备份

### 5.1 升级（代码／依赖）

本地与云端**同一条流程**：都从已部署代码目录的 `origin` 取新版本，不再区分“bundle 包”与“远端拉取”。唯一的前置差异是 `origin` 是否已存在（见下方一次性步骤）。

**必须先停服务并等真正退出，再切代码**。顺序错了会迁移失败或锁冲突。

```bash
# 0. 开发机：确认目标版本并记下完整 SHA（不要用 main 代替，否则无法复现部署了什么）
git checkout main && git pull
git rev-parse HEAD
```

```bash
# 1–6：本地与云端一字不差
sudo systemctl stop bili-monitor
for i in $(seq 1 30); do systemctl is-active --quiet bili-monitor || break; sleep 1; done
systemctl is-active bili-monitor || echo '已停止'
ss -ltn | grep -q ':8000' && echo '端口仍被占用，先排查' || echo '端口已释放'

sudo -u bili sqlite3 /srv/bili-monitor/monitor.sqlite \
  ".backup /srv/bili-monitor/backup/monitor-$(date +%F-%H%M).sqlite"

cd /srv/bili-monitor/app
sudo -u bili git log --oneline -1          # 记录升级前版本
sudo -u bili git fetch origin
sudo -u bili git checkout <40 位完整 SHA>
sudo -u bili env HOME=/home/bili /usr/local/bin/uv sync --locked --no-dev

sudo systemctl start bili-monitor
sleep 10
systemctl status bili-monitor --no-pager
curl -fsS http://127.0.0.1:8000/api/manage/ups >/dev/null && echo 'API ready'
```

#### 一次性：给已部署实例补 `origin`

仓库是公开的，部署账号用**匿名 HTTPS** 即可，不需要密钥或 token：

```bash
sudo -u bili git -C /srv/bili-monitor/app remote -v        # 先看现状
sudo -u bili git -C /srv/bili-monitor/app remote add origin \
  https://github.com/Mr-shen1/bili_charge_dynamics.git
```

- 由安装向导创建的目录只带 `local-bundle`（离线包来源，指向 `/var/tmp`，会被清理，**不能**用于升级）。安装向导自本版起会在安装时自动配置 `origin`（取自安装包的 `remote_https`），重跑向导也不会删除它。
- 云端若是 `git clone` 而来，`origin` 已存在，跳过这一步。
- 升级只认**完整 SHA**：`git checkout origin/main` 会让“部署了哪个版本”不可复现，也不便于回退时定位。

- 先启动 API 完成迁移并确认 HTTP 就绪，collector 与通知进程才会被统一入口拉起。
- 迁移只前进；不清空归档、媒体、阅读 cursor、未完成工作或已登记的风控状态。
- 前端另按[前端发布](#37-前端发布)同批处理；前后端版本不一致不崩溃，但不应当长期错配。
- **不偷偷改通知三态**：`off` 下作废的待发队列与业务起点不会被升级重放补发；切换状态会让未投递队列按既定语义收敛（见[选配节](#8-选配通知进程oss-与-cookie)）。升级不改变任何投递基线。

### 5.2 一致性备份

项目自身没有备份能力，必须自建。**不要用 `cp`**：服务运行时 `cp` 会拿到不一致快照。

```bash
sudo -u bili crontab -e
# 每天 04:10 在线一致性备份
10 4 * * * /usr/bin/sqlite3 /srv/bili-monitor/monitor.sqlite ".backup /srv/bili-monitor/backup/monitor-$(date +\%F).sqlite"
# 保留 14 天
30 4 * * * find /srv/bili-monitor/backup -name 'monitor-*.sqlite' -mtime +14 -delete
```

- 备份范围：SQLite（`.backup` 一致性快照）、可选的前端 `releases/` 目录清单、以及**不含秘密值**的配置字段清单（变量名，不是值）。
- **秘密不进备份仓库**：`/etc/bili-monitor/env` 的值、`credentials/` 内的 Cookie、OSS AccessKey、飞书 webhook／签名密钥另行离线保管，不复制到版本库、共享目录或工单附件。
- 云端备份 cron 是否已安装**未核验**；本条不声称云端已有备份。
- 用备份恢复是灾难恢复手段（会丢数据），不是 schema 回退（见下节）。恢复前先停全部进程，保留现场副本，再以同一或更新的代码启动。

## 6. 回退边界（只前进）

| 对象 | 可回退 | 做法与边界 |
| --- | --- | --- |
| 前端产物 | **可以，秒级、无中断** | 把新版本 `assets/` 中不冲突的哈希补进上一版目录 → `ln -sfn` + `mv -Tf` 指回上一版。不重启 collector、不回退 SQLite、不删新目录 |
| 后端代码 | 仅「前滚修复」 | 回退到旧 commit **只有在库未被新代码迁移时**才可行；已迁移到更新 schema 时旧代码会拒绝启动 |
| 数据库 schema | **不可回退** | 没有自动降级，也没有降级 CLI。不要改 `user_version`、不要删库、不要用旧版本强开新库、不要手工删通知表 |
| 数据库内容 | 仅灾难恢复 | 用备份覆盖＝丢数据；先停服务、保留现场，再决定 |

因此：升级前自己留一份数据库副本（5.2），把「回退」理解为「前端回退 + 后端前滚修复」，而不是降级。迁移失败时停下排查，不要绕过。

## 7. 排障

| 现象 | 排查 |
| --- | --- |
| 云端隧道连上但浏览器打不开 | 本地端口是否被占（`ExitOnForwardFailure` 会显式报错）；在**服务器上**`curl http://127.0.0.1:4173/` 是否通 |
| 本地 `ssh -N bili` 失败／隧道连上却不是本项目 | 本机 web 端口是 **4273**，不要与 `~/.ssh/config` 里 Host `bili` 的 `LocalForward 4173` 抢 4173；**不改用户的 SSH 配置** |
| 页面 200 但内容空白 | `readlink -f /srv/dynamics-viewer/current` 指向的版本是否有 `index.html` |
| 页面能开但列表为空 | API 与 collector 是否用**同一个** `BILI_DATABASE_PATH`；只起 API 不会采集 |
| `Collector failed` | 是否已有 collector 持锁、`/srv/bili-monitor` 是否可写、`journalctl` 退出原因；**不要删运行中的 `.collector.lock`** |
| API 502 | `systemctl status bili-monitor`；`curl 127.0.0.1:8000`；确认没有设 `WEB_CONCURRENCY` |
| 启动即退出、日志只有 `Application lifecycle failed` | 启动期异常被统一包装，根因要看单项检查：OSS 七项是否配齐、Cookie 文件是否合规（路径仓库外、父目录 `0700`、文件 `0600` 属主运行用户、`nlink=1`、纯 ASCII、最多一个行尾换行）；只打印条数／分类，不打印内容 |
| 迁移失败 | 停服务排查；不改 `user_version`、不删库、不用旧版本强开新库 |
| 内存飙升／被 OOM 杀 | `free -h`、`dmesg \| grep -i oom`；云端确认 swap 已启用（本地不需） |
| 图片不显示 | OSS 七项是否配齐、`BILI_OSS_PUBLIC_BASE_URL` 是否可公开访问（图片不经登录保护，也不走服务器代理） |
| 管理页一直提示身份验证 | 仅云端 HTTPS 形态：确认 `realm`（`bili manage`）在所有受保护 location（`/manage`、`/manage/`、`/api/manage/`、`/api/sync/`）完全一致；先直接打开 `/manage` 触发登录，再回管理页操作 |
| 通知不投递 | 先读 `GET /api/manage/notifications`：`off`／`system_only` 是**开关状态**，进程仍在跑；再确认是否设了 `BILI_NOTIFICATION_CONFIG`、路由配置是否合法（改文件后必须重启才生效） |
| Nginx 起不来 | `sudo nginx -t`；`sudo nginx -T` 看最终生效配置；核对 `mime.types`、`root` 可读、监听端口与权限 |
| 向导提示 80 监听 / 包默认配置无法确认 | **停止**：不要改成 `127.0.0.1:80`、不要强行 `enable`。先按[§3.6](#36-nginx-与静态站点) 确认 `nginx.conf` 是否包默认（同版本可信包逐字节比对）+ 做 root 私有备份，再隔离整个默认 server；`nginx -t` 失败先恢复备份且不启动 |

日志纪律（两端相同）：Nginx 刻意关闭 access 与 server 级 error 日志，**外层代理、托管平台与新增 location 也不得重新开启原始 URI／请求体日志**；排障用 `nginx -t`、HTTP 状态、进程退出状态与 API 的固定脱敏错误，不要为了 debug 打印秘密。

## 8. 选配：通知进程、OSS 与 Cookie

三项都是「配置存在才有」的可选能力，未配置是**受支持的降级**，不是故障。三者只有在获得真实服务（飞书群、OSS 桶、登录 Cookie）授权后才接。

### 8.1 通知进程（第三进程）

- `BILI_NOTIFICATION_CONFIG` 决定**是否启动通知进程**；它是一个指向仓库外 JSON 的路由文件（格式见[通知进程契约](../backend/api/notification-process.md#2-配置)，webhook／签名密钥只在发送时使用）。**位置统一为 `/srv/bili-monitor/credentials/notifications.json`**（云端实测 env 值；路由内容未读，文件名不是另一套约定）。
- 通知总开关是 SQLite 里的持久三态 `all`／`system_only`／`off`，**新库默认 `off`**；它决定**进程发什么**，**不控制进程启停**。`off` 时进程照常持锁轮询，只是不登记、不排队、不补发——不要把它读成「通知进程停了」。
- 本地本轮：新空库、**不设** `BILI_NOTIFICATION_CONFIG` ⇒ 统一入口只托管 API + collector（两进程），且库内开关默认 `off`，双保险。云端 env 里该变量**存在**（已核验路径值），即云端确实装配了第三进程；但路由文件内容、真实群与投递结果均未验证，**不声称云端通知链路可用**。
- 本地与云端的差别只是**启用状态**，不是位置另搞一套：将来本地要接通知时，同样把路由文件放在 `/srv/bili-monitor/credentials/notifications.json` 并把该变量设进 env；不要为本地另造路径。
- 接真实飞书群、修改路由、切换三态都是会改变投递行为的动作：需要单独授权，且**不要为了「验证部署」而切换三态**（切换会让未投递队列按既定语义作废／收敛并移动业务起点，`off` 期间的变化永不补发）。
- 路由修复：编辑仓库外配置文件 → 重启服务（运行中改文件不生效）；记录、阶段与基线保留，已成功目标不重发，历史不补发。

### 8.2 OSS 媒体归档（可选）

不配也能跑：媒体保持「待归档」，且不作为目标完成条件；要显示图片才需要配。配置写在 `/etc/bili-monitor/env`（七行全注释＝停用，或六项非空 + 一起去注释，不能只填一半）。云端 `BILI_OSS_*` **已配置**（只核验到布尔，具体项与值未读）；本地本轮**不设** → 媒体待归档。这是启用状态差异，不改变变量名与位置（都在 env 里）。

| 变量 | 来源 | 约束 |
| --- | --- | --- |
| `BILI_OSS_ENDPOINT` | 桶概览页 | https、无路径／端口／query／fragment，host 以 `.aliyuncs.com` 结尾 |
| `BILI_OSS_REGION` | 同上（如 `cn-shenzhen`） | 匹配 `[a-z0-9-]+` |
| `BILI_OSS_BUCKET` | 桶名 | 3–63 位，首尾 `[a-z0-9]` |
| `BILI_OSS_ACCESS_KEY_ID` / `_SECRET` | RAM 子账号 | **建议专用子账号，只授该桶 `oss:PutObject`** |
| `BILI_OSS_PUBLIC_BASE_URL` | 桶公网前缀 | 无签名、无 query；浏览器直取，**加登录也保护不了图片** |
| `BILI_OSS_SECURITY_TOKEN` | 仅 STS 临时凭据 | 长期 AK 时保持注释 |

填完先预检再重启（脚本只构造上传器、不发网络请求、不打印密钥）：

```bash
sudo install -m 0755 -o root -g root \
    /srv/bili-monitor/app/scripts/check-oss-env.sh /usr/local/sbin/bili-monitor-check-oss
sudo /usr/local/sbin/bili-monitor-check-oss      # 有效 / 未启用 / 配置无效
sudo systemctl restart bili-monitor
```

已卡在 `pending` 的媒体图不需要手工触发：下一次检查会因媒体不满足重新登记，下一轮补传。

### 8.3 B 站登录 Cookie（可选，仅服务端）

默认匿名。启用时 `BILI_COOKIE_FILE` 指向**仓库外的文件**，位置统一为 `/srv/bili-monitor/credentials/cookie.txt`（云端实测 env 值；文件是否存在、属主与内容未读）。本地本轮**不设**该变量（匿名），这只是启用状态差异，不是位置另搞一套。文件要求：父目录 `0700`、文件 `0600` 且属主为运行用户、`nlink=1`、纯 ASCII、`name=value;` 格式，**最多一个行尾换行**。任何一条不满足都只报同一句 `Invalid source Cookie file configuration`（不区分原因），且启动时只读一次——只有重启才会暴露配置错误。

`BILI_COOKIE_FILE` 与 OSS 变量一样，不用时保持**注释状态**，不要写空值。凭据缺失时只认上游业务码 `-101` 才报可信凭据失效告警，不猜测。

## 9. 云端专属：SSH 隧道、HTTPS 与 BasicAuth

云端第一阶段（当前形态）**没有公网 Web 入口**：安全组只放行 22，Nginx 只监听回环，管理面与写 API 的唯一安全边界是 SSH。

### 9.1 SSH 硬化与安全组

```sshconfig
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

```bash
sudo sshd -t                    # 先校验语法
sudo systemctl restart ssh
# 立刻另开终端验证；失败用云控制台 VNC 登录回滚
ssh <user>@<公网IP> 'echo still-ok'
```

安全组入方向只放行 22。**实践顺序**：先跑通部署，最后再收口 SSH；但公网域名开放前必须完成。不要为方便而长期开放 NOPASSWD 或密码登录。

### 9.2 本地建立隧道

`~/.ssh/config`（本地机器）：

```
Host bili
    HostName <公网IP>
    User <user>
    LocalForward 4173 127.0.0.1:4173
    ServerAliveInterval 30
    ServerAliveCountMax 3
    ExitOnForwardFailure yes
```

```bash
ssh -N bili        # 长期保持可用 autossh -M 0 -N bili
```

浏览器打开 `http://127.0.0.1:4173`，管理页 `/manage`。`ExitOnForwardFailure yes` 很重要：本地 4173 被占时立即报错，而不是静默连上一个不转发的连接（否则你看到的可能是别的服务）。**本机自建实例因此用 4273，避免与这条既有转发冲突；不要为了本地部署去改用户的 SSH 配置。**

### 9.3 可选：域名、证书与 Basic Auth（阶段二）

前置条件缺一不可，且**不属于本地部署**：

1. **ICP 备案**（大陆节点强制）：域名实名、备案服务码、初审、短信核验、管局审核；通过后 **30 日内**办[公安联网备案](https://beian.mps.gov.cn/)，首页底部悬挂备案号并链接工信部。**备案期间域名不能对外解析访问**，阶段一的隧道访问不受影响。
2. **证书**：阿里云免费 DV 证书仅 3 个月；推荐 `acme.sh` 的 DNS 方式自动续期（不需要开放 80），安装到 `/etc/nginx/ssl/{privkey,fullchain}.pem` 并挂 `reloadcmd`。
3. **密码文件**：`/etc/nginx/.htpasswd`（`openssl passwd -apr1`），`600`。
4. **切换**：安装 `deploy/nginx-ecs-https.conf` 覆盖 `/etc/nginx/conf.d/bili.conf`，改 `server_name` 与证书路径，`nginx -t` 后 reload；此时才在安全组放行 80／443。

约束：**Basic Auth 只在 HTTPS 之上成立**（凭据是 Base64，明文 HTTP 上等于公开密码）；只锁管理面（`/manage`、`/manage/`、`/api/manage/`、`/api/sync/`），`/api/archive/` 保持公开，公开阅读页才不会失效；`realm` 必须在所有受保护 location 完全一致，否则会重复弹框且单 UP 页可能绕过认证。

保留 `nginx-ecs-tunnel.conf` 作为备用：出证书或配置问题时改回回环监听 + 隧道即可恢复管理能力。以上流程的细节原文（含备案材料注意点与逐条命令）已随旧指南从仓库删除，需要时用 `git show e58271c:docs/deployment/aliyun-ecs.md` 查看；监管步骤不因文档合并而省略或伪造。

### 9.4 公网暴露面（两端共有的安全边界）

- 管理页、写 API、初始化／媒体重试**没有应用层鉴权**（应用不实现登录／角色）。只有云端阶段二的 Nginx Basic Auth 作为代理层保护；**本地与隧道形态没有应用鉴权**，安全性完全依赖回环监听 + SSH。
- 公开 OSS URL 可被直接访问与外链，未来加登录也不会自动保护图片。
- 容量：2 核 2 GiB 只是评估目标，不保证并发或单个节拍内完成同步；不做容量承诺。

## 10. 本地专属说明

- 形态与云端**同路径、同 unit 形态、同端口（API 8000）**，唯一参数差异是 Web 端口 **4273**（避开既有 SSH 转发的 4173）。
- 本机安装需要管理员在自己终端执行：`sudo` 需要密码且没有 NOPASSWD；代理侧无法提权，**不要**为了让代理执行而添加 NOPASSWD 规则，**也不要**把密码交给代理。建议一次性 `sudo -v` 后在同一终端连续执行 3.1–3.8。
- 本机 **不复用** live-34 的任何东西：不用 `~/.config/systemd/user/bili-charge-live-34*.service`、不用 `~/.local/state/bili-charge-dynamics/live-34`、不用 18444／18445、不用仓库里的 `.venv`。新旧实例路径与端口不重叠。
- 本机**不复制**云端生产数据库或秘密；新库为空，通知开关默认 `off`，无真实凭据。
- 本机不需要 swap／`vm.swappiness` 调优，也不执行 Debian 的 `rm sites-enabled/default`；但**装包后必须先隔离包自带的 `listen 80` 默认站点**（见[§3.6](#36-nginx-与静态站点)），本实例只监听 `127.0.0.1:4273`。本地发行版与 Nginx 版本与云端不同，本文不声称一致。
- 配套安装向导已交付：见[§3.0 本地：安装向导](#30-本地安装向导一个入口一个包)，正式命令是 `scripts/setup-local-deployment.sh`（先加 `--check` 只读预检；包目录默认按受信仓库 main HEAD 的短 SHA 解析，`--package`／`--commit` 仅在显式回归旧包时使用）会机械完成目录／账号／env／unit／Nginx／检出／前端与首次启动；本页 3.1–3.8 是它做的事的写法，供审阅与手工回退。交付物、包事实、重跑边界与验证证据见[本机部署交付与证据](../../.scratch/local-cloud-deployment/README.md)。**向导尚未被执行**，所以本文不声称本地已安装。首次部署的具体结果属于任务证据（`.scratch/`），不写进本页。

## 11. 历史指南的去向

本项目只保留这一份部署文档。旧的四份指南（`static-delivery.md`、`aliyun-ecs.md`、`local-live-backend.md`、`local-live-frontend.md`）已**从仓库物理删除**，不再有归档副本，也没有兼容页或历史导航页：

```bash
# 需要看旧原文时（只读，不恢复成文件）：
# e58271c 是原文所在的业务基线提交；它**不是安装包版本的锚点**。
git show e58271c:docs/deployment/static-delivery.md
git show e58271c:docs/deployment/aliyun-ecs.md
git show e58271c:docs/deployment/local-live-backend.md
git show e58271c:docs/deployment/local-live-frontend.md
```

这些旧文里被本页取代、**不要再当现行步骤**的内容：`aliyun-ecs` 与 `local-live-backend` 的旧 schema 版本（v16／v23）、「先手动双进程再交 systemd」的过渡顺序、live-34 的端口与状态目录、裸 `curl -I` 断言 gzip 的验收命令、把静态交付当作独立操作流程的用法。归档原文里的技术规则（缓存命名空间、资源 404 + `no-store`、无原始 query 日志、旧哈希保留与原子切换、隔离验证入口）已收录进本页与[附录](#附录静态交付与缓存路由约束)，校验不变。

历史 `.scratch/` 票据与验收证据**保留且未改写**，只把指向旧部署文件的链接机械改到本页对应章节；它们的验收结论、日期与结果一律维持原样。旧日期的提交正文里的 `Refs` 不改写；引用旧文档路径的地方（包括自动化或脚本注释）可能仍存在纯文本旧路径，不构成坏链接，需要时按上行 `git show` 查原文。

云端部署的旧规格与票据目录（`.scratch/aliyun-deployment/`）已从仓库移除，流程依据以本页为准；需要查当时的规格与票据原文时同样只走 Git 历史：

```bash
git show e58271c:.scratch/aliyun-deployment/spec.md
git show e58271c:.scratch/aliyun-deployment/issues/01-tunnel-deployment.md
```

本页自身也不代替任何执行证据：本地尚未安装，云端只做结构只读核验。

## 附录：静态交付与缓存、路由约束

以下规则来自仓库模板与已删除旧文的同源规则（原文：`git show e58271c:docs/deployment/static-delivery.md`），**当前仍然有效**，改 Nginx 或发布流程前必须遵守：

| 路径类别 | 例子 | 策略 |
| --- | --- | --- |
| 入口与 SPA 页面 | `/`、`/index.html`、`/manage`、`/dynamics/<id>`、`/comments/<rootId>/locate` | `Cache-Control: no-cache`，靠 ETag/Last-Modified 重新验证 |
| 内容哈希资源 | `/assets/index-<hash>.js`、`.css` | 存在时 `public, max-age=31536000, immutable`；该命名空间只放哈希文件 |
| 未版本化自有资源 | `/default-avatar.svg`、`/images/unavailable/placeholder.svg` | `no-cache` 重新验证，不永久缓存 |
| 明确资源命名空间的缺失文件 | `/assets/missing.js`、`/images/missing.svg` | `404` + `no-store`，绝不回退入口 |
| 未知页面 | `/unknown.page`、`/dynamics/id.with.dot` | 返回入口 HTML，由前端表达「未找到」 |

- 资源靠**命名空间**分类；不要加「所有带扩展名的 URL 都是资源」的全局正则，也不要 `error_page 404 /index.html` 掩盖资源错误。新增 `public/` 资源目录要同步补规则与验证。
- 前端「未找到页面」不是服务器 404；未知页面与不存在的动态通常是入口 200 由应用区分。
- SPA 六条路由需直达与刷新可用；API 成功／错误／不可达（502）都不得变成入口 HTML。
- 发布保留旧哈希资源、同一文件系统内原子切换入口、不就地覆盖 `dist/`、不发布 mock／fault 产物；回退只切前端。
- 生产业务图直取给定公开 OSS URL，不加服务器代理；`deploy/nginx.conf`、`nginx-ecs-tunnel.conf`、`nginx-ecs-https.conf` 的 location 规则必须与 `nginx-locations.conf` 保持一致（`pnpm test:nginx-parity` 做一致性校验）。
