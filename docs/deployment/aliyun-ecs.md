# 运维手册：阿里云 ECS

目标机：阿里云 ECS，华南1（深圳），`ecs.e-c1m1.large`（2 vCPU / 2 GiB），Debian 13.6，40 GiB ESSD Entry 系统盘，3 Mbps 固定带宽，包年包月。

本文是**可复用操作说明，不是验收结果**：所有步骤均未在目标机执行，执行后需在 [阶段一票据](../../.scratch/aliyun-deployment/issues/01-tunnel-deployment.md) 或 [阶段二票据](../../.scratch/aliyun-deployment/issues/02-https-basic-auth.md) 记录实际观察。方案取舍与决策理由见[部署规格](../../.scratch/aliyun-deployment/spec.md)。

## 0. 动手前先勘察

服务器可能已有服务占用端口。**先看，再动。**

```bash
# 端口占用（80/443/4173/8000 是本项目关心的全部）
ss -tlnp | grep -E ':(80|443|4173|8000)\b' || echo 'none occupied'

# 内存与磁盘
free -h
df -h /

# 已装组件
cat /etc/debian_version
nginx -v 2>&1 || echo 'nginx: not installed'
python3 -V
ls -la /srv/ 2>/dev/null
```

同时核对控制台：安全组入方向是否只剩 22。

## 1. 系统准备

```bash
# swap：2 GiB 内存跑 Python + SQLite + Nginx 会 OOM，这是必须项
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-bili.conf
sudo sysctl -p /etc/sysctl.d/99-bili.conf

# 组件（Debian 最小安装可能没有 sudo，一并装上）
sudo apt update
sudo apt install -y nginx sqlite3 curl git rsync sudo

# uv（用官方安装脚本，不使用 pip）；装到系统路径供 bili 用户使用
curl -LsSf https://astral.sh/uv/install.sh | sh
sudo mv /root/.local/bin/uv /root/.local/bin/uvx /usr/local/bin/

# 运行用户与目录
sudo useradd -m -s /bin/bash bili
sudo mkdir -p /srv/bili-monitor /srv/dynamics-viewer/releases /etc/bili-monitor
sudo chown -R bili:bili /srv/bili-monitor /srv/dynamics-viewer
sudo chmod 755 /etc/bili-monitor
```

## 2. SSH 硬化（阶段一的唯一安全边界）

阶段一没有公网 Web 入口，安全性完全由 SSH 承担。

**实践顺序：** 本节可在第 7 节全部验证通过后**最后执行**。部署期间需频繁切换用户、装软件、调端口，中途改 SSH 有把自己锁在门外的风险（云控制台 VNC 是唯一兜底）。先跑通再收口，但**在域名开放公网之前必须完成**。

```bash
# 1) 先在本地生成并上传公钥（如果还没有）
ssh-keygen -t ed25519 -C bili-monitor        # 本地执行
ssh-copy-id <user>@<公网IP>                   # 本地执行

# 2) 确认密钥登录可用，再改配置
ssh <user>@<公网IP> 'echo key-login-ok'

# 3) 服务器上编辑 /etc/ssh/sshd_config
```

```sshconfig
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

```bash
sudo sshd -t                       # 先校验配置语法
sudo systemctl restart ssh
# 立刻在另一个终端验证；失败则用云控制台 VNC 登录回滚
ssh <user>@<公网IP> 'echo still-ok'
```

安全组同时确认：入方向只放行 22。

## 3. 首次部署后端

```bash
sudo -u bili git clone <仓库地址> /srv/bili-monitor/app
cd /srv/bili-monitor/app
sudo -u bili env HOME=/home/bili /home/bili/.local/bin/uv sync --locked --no-dev
```

环境文件：

```bash
sudo install -D -m 0600 -o root -g root \
    /srv/bili-monitor/app/deploy/bili-monitor.env.example \
    /etc/bili-monitor/env
sudo editor /etc/bili-monitor/env
```

必填项只有一个：`BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite`。

**先手动跑一次，确认能起来再交给 systemd**（统一入口在上游文档里声明未验证）：

```bash
sudo -u bili env HOME=/home/bili \
    BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite \
    /srv/bili-monitor/app/.venv/bin/python -m backend.bili_monitor.service \
        --host 127.0.0.1 --port 8000
```

另开一个终端确认 API 就绪，然后 Ctrl-C 退出：

```bash
curl --fail --silent --show-error http://127.0.0.1:8000/api/manage/ups && echo OK
ls -la /srv/bili-monitor/          # 应看到 monitor.sqlite 与 .collector.lock
```

**如果统一入口失败**，退回到手动双进程（`static-delivery.md:41-56` 的已验证路径），并在此记录失败现象。手动方式下需要两个 unit 或两个 `tmux` 会话。

交给 systemd：

```bash
sudo install -D -m 0644 /srv/bili-monitor/app/deploy/bili-monitor.service \
    /etc/systemd/system/bili-monitor.service
sudo systemctl daemon-reload
sudo systemctl enable --now bili-monitor
systemctl status bili-monitor --no-pager
journalctl -u bili-monitor -n 50 --no-pager
```

## 4. 首次发布前端

**不需要在服务器上装 Node。** 前端在本地构建后上传：

```bash
# 本地仓库根目录
pnpm install --frozen-lockfile
HOST=<user>@<公网IP> scripts/deploy-frontend.sh
```

脚本会检查工作区干净、执行 `pnpm build`、rsync 到 `releases/<时间戳>-<commit>`、用 `mv -Tf` 原子切换 `current`、清理超过 5 个的旧版本。

## 5. 安装 Nginx（阶段一）

```bash
sudo install -D -m 0644 /srv/bili-monitor/app/deploy/nginx-locations.conf \
    /etc/nginx/snippets/bili-locations.conf
sudo install -D -m 0644 /srv/bili-monitor/app/deploy/nginx-ecs-tunnel.conf \
    /etc/nginx/conf.d/bili.conf

# Debian 默认站点监听 80；阶段一不开 80，移除避免误解
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t
sudo systemctl reload nginx
```

校验：

```bash
ss -tlnp | grep 4173                      # 应只在 127.0.0.1:4173
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4173/
curl -sSI http://127.0.0.1:4173/assets/$(ls /srv/dynamics-viewer/current/assets | grep '\.js$' | head -1) \
    | grep -i 'content-encoding\|cache-control'   # 应看到 gzip 与 immutable
```

## 6. 本地建立隧道

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
ssh -N bili
```

浏览器打开 `http://127.0.0.1:4173`。管理页 `http://127.0.0.1:4173/manage`。

`ExitOnForwardFailure yes` 很重要：本地 4173 被占用（例如 `pnpm test:e2e` 正在跑）时会立即报错，而不是静默连上一个不转发的连接——否则你看到的其实是本地另一个服务。

断开后重连即可。需要长期保持用 `autossh -M 0 -N bili`。

## 7. 上线检查清单

- [ ] `systemctl is-active bili-monitor` 为 `active`
- [ ] `curl http://127.0.0.1:8000/api/manage/ups` 返回 `200`
- [ ] `curl http://127.0.0.1:4173/` 返回 `200`，`/manage` 返回 `200`
- [ ] `curl http://127.0.0.1:4173/api/nope` 返回 HTTP 404（**不是** 200 HTML）
- [ ] `curl http://127.0.0.1:4173/assets/nonexistent.js` 返回 404 + `Cache-Control: no-store`
- [ ] 安全组 80/443 关闭；`ss -tlnp` 无 `0.0.0.0:4173`
- [ ] 通过隧道打开 `/manage`，添加一个 UP，1 分钟内 `checks` 分区出现检查记录
- [ ] `journalctl -u bili-monitor` 无 traceback

## 8. 日常运维

**备份**（项目自身没有备份能力，必须自建）：

```bash
sudo -u bili crontab -e
# 每天 04:10 在线备份；不要用 cp，服务运行时 cp 会拿到不一致快照
10 4 * * * sqlite3 /srv/bili-monitor/monitor.sqlite ".backup /srv/bili-monitor/backup/monitor-$(date +\%F).sqlite"
```

配合清理：`find /srv/bili-monitor/backup -name 'monitor-*.sqlite' -mtime +14 -delete`。

**容量**：`df -h /` 使用率超过 80% 时检查 `/srv/bili-monitor`。OSS 未配置时媒体保持待归档，不占本地磁盘；配置后本地只留元数据。

**日志**：Nginx 刻意不记日志（见 spec 风险边界）。排障用：

```bash
systemctl status bili-monitor --no-pager
journalctl -u bili-monitor --since '30 min ago' --no-pager
sudo nginx -t
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/manage/ups
```

## 9. 后端升级

**必须先停服务、等退出，再切代码。** 顺序错了会导致迁移失败或锁冲突。

```bash
sudo systemctl stop bili-monitor

cd /srv/bili-monitor/app
sudo -u bili git fetch --all
sudo -u bili git checkout <目标版本>
sudo -u bili env HOME=/home/bili /home/bili/.local/bin/uv sync --locked --no-dev

sudo systemctl start bili-monitor
# 等 API 完成迁移并监听后，再确认 collector 正常
sleep 10
systemctl status bili-monitor --no-pager
curl --fail --silent --show-error http://127.0.0.1:8000/api/manage/ups >/dev/null && echo 'API ready'
```

前端同步发布见第 4 节。前后端版本不匹配时，前端会按 API 契约拿到错误响应，不会崩溃，但应当同批发布。

`schema` 版本在 API lifespan 自动迁移（当前 v13）。**没有独立迁移 CLI、没有自动降级。** 迁移失败时停下排查，不要改 `user_version`、不要删库、不要用旧版本强开新库。

## 10. 回滚

**前端**（秒级，无中断）：

```bash
ssh <user>@<公网IP>
ls -1dt /srv/dynamics-viewer/releases/*
cd /srv/dynamics-viewer
ln -sfn releases/<旧版本> current.tmp && mv -Tf current.tmp current
```

**后端**（需停进程）：

```bash
sudo systemctl stop bili-monitor
cd /srv/bili-monitor/app && sudo -u bili git checkout <旧版本>
sudo -u bili env HOME=/home/bili /home/bili/.local/bin/uv sync --locked --no-dev
sudo systemctl start bili-monitor
```

⚠️ **数据库 schema 只前进不后退。** 若新版本已迁移到 v13，回滚到旧代码可能因「未来版本拒绝启动」而失败。回滚前先备份数据库，并接受旧代码读新 schema 的风险。

## 11. 备案与阶段二切换

### 备案（与阶段一并行推进）

1. 买域名（推荐 `.cn`：首年 38 元，续费 42 元/年），立刻做**实名认证**，持有者必须与备案人一致。
2. 阿里云控制台 → ICP 代备案，个人主体。需要一个备案服务码（每台 ECS 提供 5 个免费码）。
3. 阿里云初审 1~2 工作日（来电 95187，注意接听）→ 工信部短信核验（24 小时内）→ 管局审核 1~20 工作日。
4. 备案通过后，**30 日内**还需办[公安联网备案](https://beian.mps.gov.cn/)。
5. 首页底部必须悬挂备案号并链接到工信部。

**备案期间域名不能对外解析访问**，阶段一的隧道访问不受影响。

控制台显示「自动续费：手动续费」。备案材料要求 ECS 为包年包月，稳妥起见在控制台开通自动续费，避免被驳回。

### 证书

阿里云免费 DV 证书有效期仅 3 个月，一年要手动续 4 次。推荐用 `acme.sh` 自动续期：

```bash
curl https://get.acme.sh | sh -s email=<你的邮箱>
# 用 DNS 方式签发（不需要 80 端口对外）
~/.acme.sh/acme.sh --issue --dns dns_ali -d <域名>
sudo mkdir -p /etc/nginx/ssl
~/.acme.sh/acme.sh --install-cert -d <域名> \
    --key-file /etc/nginx/ssl/privkey.pem \
    --fullchain-file /etc/nginx/ssl/fullchain.pem \
    --reloadcmd "systemctl reload nginx"
```

### 生成密码文件

```bash
sudo sh -c 'printf "youruser:" > /etc/nginx/.htpasswd'
sudo sh -c 'openssl passwd -apr1 "你的密码" >> /etc/nginx/.htpasswd'
sudo chmod 600 /etc/nginx/.htpasswd
```

### 切换

```bash
sudo install -D -m 0644 /srv/bili-monitor/app/deploy/nginx-ecs-https.conf \
    /etc/nginx/conf.d/bili.conf
# 改 server_name 与 ssl_certificate 路径
sudo nginx -t && sudo systemctl reload nginx
```

安全组此时才放行 80/443。

**保留 `nginx-ecs-tunnel.conf` 的内容作为备用**：出证书或配置问题时，改回回环监听 + SSH 隧道即可立即恢复管理能力，不需要依赖公网。

## 12. 排障

| 现象 | 排查 |
| --- | --- |
| 隧道连上但浏览器打不开 | 本地端口是否被占用（去掉 `ExitOnForwardFailure` 的静默失败）；`curl http://127.0.0.1:4173` 在**服务器上**是否通 |
| 页面 200 但内容空 | 前端产物是否发布到 `current` 指向的版本；`readlink -f /srv/dynamics-viewer/current` |
| 页面能开但列表为空 | API 与 collector 是否用**同一个** `BILI_DATABASE_PATH`；只起 API 不会采集 |
| `Collector failed` | 是否已有 collector 持锁；目录是否可写；`journalctl` 查退出原因；**不要删运行中的 `.collector.lock`** |
| API 502 | `systemctl status bili-monitor`；`curl 127.0.0.1:8000`；确认没有设 `WEB_CONCURRENCY` |
| 迁移失败 | 停服务排查，不要改 `user_version`、不要删库、不要用旧版本强开新库 |
| 内存飙升 / 服务被 OOM 杀 | `free -h`、`dmesg \| grep -i oom`；确认 swap 已启用 |
| 图片不显示 | OSS 七项是否配齐；`BILI_OSS_PUBLIC_BASE_URL` 是否可公开访问 |
| 管理页一直提示需要身份验证 | 阶段二下确认 realm 三处一致；先直接打开 `/manage` 触发登录，再回管理页操作 |
