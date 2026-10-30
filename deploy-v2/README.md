# 部署手册 · 本地与阿里云同一套

一句话：**打一个包 → 预检 → 一条命令装 → 一条命令验收**。本地和云端跑的是同样的命令，区别只是「包怎么送到机器上」。

目录里有什么（全部自包含，不依赖 `scripts/` 或旧向导的任何东西）：

| 文件 | 干什么 |
|---|---|
| `package.sh` | 打安装包（开发机跑；前端构建 + git bundle + 校验和） |
| `deploy.sh` | 唯一入口：`--check` 预检 / `install` 安装 / `upgrade` 升级 / `start` 只启动并验收 / `lan` 切局域网监听 / `env` 渲染环境文件 |
| `verify.sh` | 只读验收，装完自动跑，也可以随时单独跑（内含 env/凭据体检） |
| `doctor.sh` | 部署体检：env、cookie、通知 JSON、OSS 六项，并以运行用户身份试跑真实加载器；服务起不来时先跑它。root / 有 sudo 的账号 / `bili` 自己都能跑，详见[体检一节](#体检doctorsh服务起不来时先跑它) |
| `reset.sh` | 把本项目删干净，回到可以重新安装的状态 |
| `assets/bili-monitor.service` | systemd unit（装的时候直接拷到 `/etc/systemd/system/`） |
| `assets/nginx-locations.conf` | Nginx 站点片段（静态根、缓存、SPA 回退、`/api` 反代） |
| `assets/bili-monitor.env.example` | env 的完整参考（每个选配项的约束都写在注释里） |
| `README.md` | 本文 |

只需记住五个命令：

```bash
bash deploy-v2/package.sh            # 开发机：打包装
bash deploy-v2/deploy.sh --check     # 目标机：看看能不能装
bash deploy-v2/deploy.sh install     # 目标机：装
bash deploy-v2/verify.sh             # 目标机：验收
bash deploy-v2/doctor.sh             # 目标机：起不来时体检（env / 凭据）
```

---

## 第 0 步：先看一眼「谁在哪台机器上做什么」

| 机器 | 做什么 |
|---|---|
| 你的开发机 | 打安装包（要 Node/pnpm，仓库里有） |
| 目标机（本机 CachyOS 或云上 Debian） | 只需 nginx + git + 网络；跑 `deploy.sh` |

目标机上**不需要**装 Node、pnpm、Python。前端产物已经在包里。

---

## 第 1 步：打安装包（只在开发机做）

```bash
cd ~/Projects/PI/bili_charge_dynamics
git status                    # 必须干净；不干净就先提交
git checkout main
deploy-v2/package.sh
```

**成功标志**：最后几行出现

```
==> 安装包就绪
  ✓ 目录：/var/tmp/bili-deploy-pkg/<7位短SHA>
  ✓ 提交：490d6a5...
  ✓ 大小：85M
```

把这个目录记下来，下面叫它「包目录」。

---

## 第 2 步：把包和脚本送到目标机

**本地部署（就在这台机器上）**：什么都不用做，包已经在 `/var/tmp/bili-deploy-pkg/` 里。

**云端部署（阿里云 ECS）**：在开发机上执行

```bash
SHA_SHORT=<上一步的 7 位短SHA>
scp -r /var/tmp/bili-deploy-pkg/$SHA_SHORT root@<ECS公网IP>:/var/tmp/bili-deploy-pkg/
scp -r deploy-v2 root@<ECS公网IP>:/root/deploy-v2
```

> 云端第一次部署前还要做几件跟本项目无关的主机准备（做一次即可，`deploy.sh` 不碰这些）：
>
> ```bash
> # 1) 账号（deploy.sh 也会自动建，但先建好便于你提前配 sudo/SSH）
> useradd -m -s /bin/bash bili
> # 2) 2 GiB swap（2 核 2G 机器必需）
> fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
> grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
> # 3) SSH 只允许密钥登录（先确认你的公钥已写入，再执行）
> sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
> systemctl reload ssh 2>/dev/null || systemctl reload sshd
> # 4) 安全组：只放行 22（控制台操作，命令行无法代劳）
> ```

---

## 第 3 步：预检（不需要 sudo，随便跑）

```bash
bash deploy-v2/deploy.sh --check
```

**成功标志**：一行行 `✓`，最后是

```
✓ 预检结束（未写盘、未调用 sudo）
```

看到这些就去下一步：

| 输出 | 含义 |
|---|---|
| `目标为空（...都不存在）` | 好，可以装 |
| `账号 bili 已存在（将复用）` | 好，不会重复建 |
| `端口 8000 空闲` / `端口 4273 空闲` | 好 |
| `读不到 Nginx 生效配置（需要 sudo）` | 正常，装的时候会校验 |

看到 **`目标已存在`** 就不要装了 —— 那说明这台机器上有旧部署，先看第 6 步的「重装」。

---

## 第 4 步：安装（要 sudo 密码，会在终端里问）

```bash
bash deploy-v2/deploy.sh install
```

本地与云端**命令完全一样**（脚本自己判断系统、自己选端口：本地 4273，云端 4173）。

装到局域网里能访问（比如这台机器，让手机/另一台电脑打开）：

```bash
bash deploy-v2/deploy.sh install --lan
```

如果脚本提示「ufw 处于 active，且没有 4273 规则」，按它给的命令放行一次（只做一次）：

```bash
sudo ufw allow from 192.168.8.0/24 to any port 4273 proto tcp
```

脚本会依次做 7 件事，每件都打印 `✓`：

```
1/7 安装系统依赖          pacman/apt 装 nginx git rsync sqlite curl + uv
2/7 账号与目录            建/复用 bili，建 /srv/bili-monitor 等
3/7 Nginx 底座隔离        确保本项目不占 80 端口，nginx -t 通过
4/7 检出代码并安装依赖    从包内 bundle 检出 + uv sync（首次要下 CPython，几分钟）
5/7 写系统配置            env、systemd unit、Nginx 站点
6/7 发布前端              原子切换 /srv/dynamics-viewer/current
7/7 启动并验收            启服务、等 API 就绪、自动跑 verify.sh
```

**成功标志**：最后是

```
✓ 部署完成：490d6a5，Web 端口 4273
  管理页：http://127.0.0.1:4273/manage
```

然后浏览器打开那个地址就能看到管理页。云端则先建 SSH 隧道（`ssh -N -L 4173:127.0.0.1:4173 bili@<ECS IP>`）再打开 `http://127.0.0.1:4173`。

**失败怎么办**：脚本会停下并打印原因，不会留下半个系统。
修好之后**先跑 `reset.sh` 再重跑 `install`**（第 6 步），不要直接重跑。

---

## 第 5 步：验收（随时可跑，只读）

```bash
bash deploy-v2/verify.sh
```

每一项都是「读一下、对一下」，不改任何东西：

| 检查 | 期望 |
|---|---|
| 服务 | `bili-monitor active` |
| API 直连 | `/api/manage/ups` 200，未知路径 404 |
| 页面 | `/`、`/manage` 都是 200 |
| 路径语义 | `/api/nope` 走 Nginx 也是 404，且带 `no-store` |
| 静态资源 | 哈希 JS 有 `gzip` + `immutable` 缓存 |
| 入口页 | 带 `no-cache` |
| 端口 | Web 端口在听；API 8000 只听回环 |
| 80 端口 | Nginx 生效配置里没有 `listen 80` |
| 进程 | `bili` 名下至少 2 个 python |
| 数据库 | `user_version` 与代码的 `SCHEMA_VERSION` 一致；新库里没有任何 UP |
| 日志 | 近 200 行无 traceback |

最后一行 `全部通过` 就是成功。

> 不要用「加一个 UP 看会不会采集」当验收，也不要觉得「管理页能打开」就等于安全 —— 管理页没有登录。

---

## 第 6 步：重装

```bash
bash deploy-v2/reset.sh --dry-run   # 先看要删什么
bash deploy-v2/reset.sh             # 输入 DELETE，再输 sudo 密码
bash deploy-v2/deploy.sh install    # 重新装
```

`reset.sh` 删的是本项目自己的东西：服务与 unit、`/srv/bili-monitor`（含数据库和凭据）、`/etc/bili-monitor`、Nginx 站点两个文件。

它**不删**：nginx 包、`/etc/nginx/nginx.conf`、`bili` 账号、`/home/bili`、`/usr/local/bin/uv`、前端产物 `/srv/dynamics-viewer`。所以重装很快，也不用碰系统 nginx 配置。

想连前端产物和账号一起清：`bash deploy-v2/reset.sh --all`。

---

## 第 7 步：升级（本地云端同一条）

```bash
# 1. 开发机：打新包，记下完整 40 位 SHA 和新包目录
cd ~/Projects/PI/bili_charge_dynamics
git pull && git rev-parse HEAD
deploy-v2/package.sh

# 2. 目标机：一条命令升级（云端记得先把新包 scp 上去）
bash deploy-v2/deploy.sh upgrade --sha <40位完整SHA> --package <新包目录>
```

脚本按固定顺序做，任何一步失败都会停下来：

```
停服务 → 等真正退出 → 数据库一致性备份 → git fetch origin → checkout <SHA>
→ uv sync --locked --no-dev → 发布前端 → 启动 → 等 API 就绪 → verify.sh
```

升级时**代码优先从 `--package` 里带的 bundle 取**（与安装同源，不需要网络）；只有没给包、或包内没有该提交时才回退 `git fetch origin`，并且带 20 秒低速中断，网络不通会明确报错而不是卡住。操作员 shell 里的 `HTTP(S)_PROXY`/`NO_PROXY` 会透传给 `bili` 身份的子进程（`git`、`uv` 都要出网）。

规则（重要）：

- **只认 40 位完整 SHA**，不要用 `main`，否则说不清装的是哪一版。
- **数据库只前进**：升级不会回退 schema，不要拿旧代码强开新库。
- 前端要回退：直接切 `current` 软链到上一个 `releases/` 目录，不用重启后端。

---

## 第 8 步：选配（需要时才做）

`/etc/bili-monitor/env` 由 `deploy.sh` 渲染，默认路径都写好了、但**保持注释**（注释掉＝未启用）。查看/重写：

```bash
bash deploy-v2/deploy.sh env             # 打印模板
bash deploy-v2/deploy.sh env --write     # 写入（旧文件备份到 /var/lib/bili-deploy/backups/）
sudo systemctl restart bili-monitor
bash deploy-v2/verify.sh                 # 确认重启后仍全绿
```

| 想要 | 怎么做 |
|---|---|
| 飞书通知 | 把 `notifications.json` 放到 `/srv/bili-monitor/credentials/`（属主 bili，≤0640），然后取消注释 `BILI_NOTIFICATION_CONFIG=/srv/bili-monitor/credentials/notifications.json`，重启 |
| 登录 Cookie | 把 `cookie.txt` 放到 `/srv/bili-monitor/credentials/`（0600），取消注释 `BILI_COOKIE_FILE=/srv/bili-monitor/credentials/cookie.txt`，重启 |
| 图片存 OSS | 取消注释 `BILI_OSS_*` 七项并全部填真实值（少一项或留空都会启动失败）；填完先跑 `scripts/check-oss-env.sh` 预检 |
| 局域网访问 | 装的时候加 `--lan`；已经装好忘了加的：`bash deploy-v2/deploy.sh lan`（自动探测本机局域网地址；也可 `deploy.sh lan 192.168.x.y`）。它会备份旧配置、只改 `listen` 一行、`nginx -t` 不过自动回滚、reload 后跑验收，并在 ufw 拦着时给出放行命令 |

> 选配项**要么整行注释掉，要么填完整**。写成 `BILI_COOKIE_FILE=` 这种空值会让服务起不来（空串既不是“未设置”，又算配置不完整）。

改完 env 先体检再重启，比直接重启省一轮排查：

```bash
bash deploy-v2/doctor.sh                 # 逐项检查 env / cookie / 通知 / OSS
sudo systemctl restart bili-monitor
bash deploy-v2/verify.sh
```

---

## 体检：`doctor.sh`（服务起不来时先跑它）

应用的启动失败会被 `backend/bili_monitor/app.py` 用 `RuntimeError(...) from None` 包一层，
日志里只剩 `Application lifecycle failed`，真实原因（cookie 文件权限、通知 JSON、OSS 配置）
看不到。`doctor.sh` 就是补这个洞：它按运行时的真实规则逐项校验，并把每一项的失败原因和
修复命令直接打出来。**只读**，不改文件、不重启服务。

### 什么时候跑

| 时机 | 命令 |
|---|---|
| 改完 `/etc/bili-monitor/env`，重启之前 | `bash deploy-v2/doctor.sh` |
| 服务反复重启、`verify.sh` 报 `not active` | `bash deploy-v2/doctor.sh` |
| `install` / `upgrade` | 脚本会自动跑一次（启动服务之前），不通过就不启动 |

### 它检查什么

| 项 | 规则（与应用运行时一致） |
|---|---|
| env 文件 | `root:root 600`；有效行必须是 `KEY=VALUE`；选配变量**存在但为空**即判错（空串既非「未设置」又算配置不完整） |
| `BILI_DATABASE_PATH` | 绝对路径、目录对运行用户可写、文件头是 SQLite、`user_version` 与代码的 `SCHEMA_VERSION` 一致 |
| Cookie | 目录 `bili` 0700、文件 `bili` 0600、`nlink=1`、非符号链接、纯 ASCII 无控制字符（`source_cookies.py:29-84`） |
| 通知 JSON | 文件存在、权限 ≤0640、属主 `bili` 或 root、JSON 可解析；打印 `base_url` 与 destinations 数量 |
| OSS | 六项必填全非空、`ENDPOINT` 形如 `https://<域名>.aliyuncs.com` 且无路径/端口、`PUBLIC_BASE_URL` 无 query |
| 真实加载器 | 以运行用户身份真跑 `load_source_cookie_pairs()`、`OSSUploader.from_environment()`、`NotificationConfig.load()` |
| 服务 | `is-active`、`NRestarts`，失败时附上日志里 `ERROR/RuntimeError/ValueError` 的尾部 |

凭据一律脱敏输出：`*SECRET*`/`*TOKEN*` 只显示字节数，`*KEY_ID*` 只显示前 4 位；
凭据经 0600 临时文件传给子进程，**不进命令行参数**（避免 `ps` 泄露）。

### env 的三级来源

脚本不需要一定用 root 跑：

1. `/etc/bili-monitor/env` 当前用户可读 → 直接读
2. 当前账号在 `sudo`/`wheel` 组 → 提示一次密码后用 `sudo` 读
3. 以 `bili` 身份运行时 → 读运行中服务进程的 `/proc/<pid>/environ`（systemd 注入的同一份；
   `bili` 本来就在用这些凭据，不扩大可见面）
4. 以上都不可用 → 明确输出「跳过」并以 exit 0 结束，不会误判成失败

### 参数与退出码

| 参数 | 作用 |
|---|---|
| `--quiet` | 每条只输出一行结论（供 `verify.sh` 调用） |
| `--no-prompt` | 只用已缓存的 sudo，不弹密码（供 `verify.sh` 调用） |
| `--ignore-service` | 跳过「服务是否 active」这项（`deploy.sh` 在启动服务之前用） |

退出码 `0` = 通过或无法检查（跳过）；`1` = 有阻塞问题，逐条列出 `✗` 与修复命令。

## 常见问题速查

| 现象 | 处理 |
|---|---|
| 服务反复重启、`verify.sh` 报 `not active` | 先跑 **`bash deploy-v2/doctor.sh`**，它会指出是 cookie 文件、通知 JSON 还是 OSS 配置的问题（应用的 traceback 被 `from None` 吞了，日志里只有 `Application lifecycle failed`） |
| `预检` 说 `目标已存在` | 这台机器上有旧部署：`reset.sh` 后再 `install` |
| `MANIFEST 校验失败` | 包没传完整或被改过，重新 `scp` / 重新打包 |
| `git clone 失败` / 下载 CPython 卡住 | 目标机出网问题；先确认能访问 PyPI，再 `reset.sh` 重装 |
| `端口 8000/4273 被占用` | `ss -lntp \| grep -E ':(8000\|4273)'` 看是谁，停掉它，或 `--port` 换端口 |
| `API 60 秒内未就绪` | 脚本已打印最后 30 行日志；常见是 env 里留了空值，或数据库路径不可写 |
| 升级后页面是旧的 | 升级时没带 `--package`，前端没更新；补跑 `deploy-v2/package.sh` 后带 `--package` 重跑 upgrade，或手工 rsync dist 到 `/srv/dynamics-viewer/releases/` |
| 想彻底不要这个项目 | `reset.sh --all`，再按需 `sudo pacman -Rns nginx`（或 `apt remove nginx`） |

---

## 依赖边界（这套脚本到底靠什么）

**零外部脚本依赖**：以上 4 个脚本 + 2 份模板 + 本文，全部在 `deploy-v2/` 内。不调用、也不读取：

| 旧东西 | 状态 |
|---|---|
| `scripts/setup-local-deployment.sh`（旧向导） | 不用 |
| `scripts/prepare-local-deployment-package.sh`（旧打包器） | 不用，`deploy-v2/package.sh` 独立实现 |
| `scripts/deploy-frontend.sh` | 不用 |
| `/var/lib/bili-local-deployment/state.tsv` | 不读、不写 |
| 旧包里的 `render/`、`verify/`、`PROVENANCE.md` | 不用（env 与 nginx server 由 `deploy.sh` 自己渲染） |
| 仓库 `deploy/` 目录 | 不用（模板以 `deploy-v2/assets/` 为准；只有打包时会提示两边是否漂移） |

安装包需要的只有：`VERSION`、`MANIFEST.sha256`、`repo/*.bundle`、`frontend/dist/`、`uv/uv`、`deploy/*`。装之前 `deploy.sh` 会逐项比对模板与脚本约定：`User=bili`、`EnvironmentFile=/etc/bili-monitor/env`、`ReadWritePaths=/srv/bili-monitor`、`ExecStart=.../app/.venv/bin/python -m backend.bili_monitor.service --port 8000`、snippet 的 `root /srv/dynamics-viewer/current;` 与 `proxy_pass http://127.0.0.1:8000;`。任何一项对不上就停，不会「装完了但服务指向别处」。

## 与旧部署方式的关系

旧的部署方式已**整块从仓库删除**：`docs/deployment/`、`scripts/setup-local-deployment.sh`、`scripts/prepare-local-deployment-package.sh`、`scripts/deploy-frontend.sh`、`deploy/` 目录都不在了。

- 新脚本不读旧向导的 `state.tsv`，也不依赖旧包格式（只认 `VERSION` / `MANIFEST.sha256` / `repo/*.bundle` / `frontend/dist` / `uv/uv` / `deploy/*`）。
- 旧内容需要查原文时：`git show 490d6a5:docs/deployment/README.md`（其余同理）。
- 若某台机器上还留着旧向导装的东西，先跑 `deploy-v2/reset.sh`（它只删项目自己的路径），再 `deploy.sh install`。旧向导遗留的 `/var/lib/bili-local-deployment/state.tsv` 留着无害，新脚本不读。

## 端口与平台对照（脚本自动选，一般不用管）

| | 本地（pacman 系统） | 云端（apt 系统，如 Debian） |
|---|---|---|
| 依赖安装 | `pacman -S --needed` | `apt-get install -y` |
| 发行版默认 80 站点 | 换写成受管 `nginx.conf`（原件备份在 `/var/lib/bili-deploy/backups/`） | 移走 `sites-enabled/default` |
| Web 端口 | 4273 | 4173 |
| API 端口 | 8000 | 8000 |
| 提权 | `sudo` | root 直跑（自动） |
| 代码来源 | 包内 bundle | 同左 |
