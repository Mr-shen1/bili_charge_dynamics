# 01: 阿里云 ECS 阶段一 · SSH 隧道上线

**What to build:** 在目标 ECS 上跑起单 API + 单 collector + Nginx 静态前端，安全组只放行 22，维护者通过 SSH 本地端口转发访问，管理页与写 API 无公网暴露面。

**Parent:** [spec.md](../spec.md) 决策 D1、D2

**Blocked by:** 无

**Status:** ready-for-human

## 依据与交付边界

- [spec.md](../spec.md)：D1（不在应用层加鉴权）、D2（SSH 隧道）、D5（前后端发布分离）。
- [运维手册](../../../docs/deployment/aliyun-ecs.md)：第 0–8 节。
- 沿用 [交付运行说明](../../../docs/deployment/static-delivery.md) 的双进程/SQLite/Nginx 约束，不新增服务、不改应用代码。
- 本票不新增鉴权、不涉及域名与备案、不修改 `deploy/nginx.conf`（隔离验证基准）。

## 核验标准

- [ ] 动手前完成勘察：`ss -tlnp` 确认 4173/8000 未被占用，记录目标机 Debian/nginx/Python 版本与 `df -h /` 基线。
- [ ] 已启用 2 GiB swap 与 `vm.swappiness=10`，`free -h` 可见；服务 24 小时运行后 `dmesg` 无 OOM 记录。
- [ ] SSH 已禁用 `PasswordAuthentication` 与 `PermitRootLogin`；改配置前已验证密钥登录，重启后仍可登录。
- [ ] 安全组入方向只放行 22；`ss -tlnp` 中 4173 仅监听 `127.0.0.1`，无 `0.0.0.0` 绑定。
- [ ] `bili-monitor.service` 启动后 API 与 collector 同时存活；`BILI_DATABASE_PATH` 为 `/srv/bili-monitor/` 下的绝对路径，`monitor.sqlite` 与 `.collector.lock` 出现在该目录。
- [ ] 前端经 `scripts/deploy-frontend.sh` 发布，`current` 为指向 `releases/<时间戳>-<commit>` 的软链；重复执行不报错且旧版本被清理。
- [ ] `curl` 在服务器本机验证：`/` 与 `/manage` 返回 200；`/api/nope` 返回 404 而非 200 HTML；`/assets/<不存在>.js` 返回 404 且带 `Cache-Control: no-store`。
- [ ] 哈希资源响应含 `Content-Encoding: gzip`；`/assets/` 带 `immutable` 长缓存。
- [ ] 本地 `ssh -N <别名>` 后浏览器可打开 `http://127.0.0.1:4173/` 与 `/manage`；添加一个 UP 后 1 分钟内 checks 出现记录。
- [ ] 定时 `sqlite3 .backup` 已配置并验证产出可读的备份文件。

## 测试与完成证据

按运维手册各节执行，把实际观察记录在下方 Comments：目标机版本、端口与安全组截图描述、`curl` 状态码、gzip/缓存响应头、系统运行时长与内存曲线、遇到的偏差及修正。

**本票不验证：** 域名、HTTPS、Basic Auth、备案、证书、长时间持续运行（>1 周）、真实上游限流表现。这些属于 #02 或未列入本工作。

## Comments

### 2026-10-23 目标机勘察（runbook 第 0 节）

实测目标机，端口全空闲，**可以直接部署，无需改端口或 root 路径**：

| 项 | 实测 |
| --- | --- |
| 80 / 443 / 4173 / 8000 | `ss -tlnp` 无匹配，全部空闲 |
| 内存 | total 1.7 GiB；加 swap 前 available 1.2 GiB，装完 nginx 后 1.1 GiB |
| Swap | 加前 0B → 加后 2.0 GiB，`vm.swappiness=10` |
| 磁盘 | `/dev/vda3` 40G，用 3.7G（10%），可用 34G |
| 系统 | Debian 13.6；系统 Python 3.13.5（项目用 uv 独立 3.12，不受影响） |
| nginx | 装前未安装 → 装后 1.26.3 |
| uv | 0.13.5 |
| 运行中服务 | 仅系统服务 + `aliyun.service`，无第三方应用占用资源 |
| OOM 历史 | 0 |

结论：无端口冲突、无资源竞争，`deploy/nginx-ecs-*.conf` 的监听端口与 `root` 路径可直接沿用模板值。

待观察风险：available 1.1 GiB 对单 API + 单 collector 预计占用 300–400 MiB 而言足够，但余量不大；swap 已启用，仍需在第 7 节验证后观察持续运行的内存曲线，确认无爬升。

### 2026-10-23 统一入口首次实际运行（runbook 第 3 节，手动形态）

上游 `docs/deployment/static-delivery.md:36` 声明 `backend.bili_monitor.service` 「本次按用户要求未运行验证」。本次在目标机实际启动，正常可用：

```
INFO:     Application startup complete.
INFO:     Uvicorn running on http://127.0.0.1:8000
INFO collector_started cadence_seconds=15 max_checks=4 max_syncs=4
     max_discoveries=2 recovery=complete
INFO collector_configuration media_upload=disabled
```

- `GET /api/manage/ups` → **HTTP 200**
- 迁移完成，固定节拍每 15 秒输出一次 `collector_tick`，`targets=0`（尚未配置 UP）
- `media_upload=disabled` 符合预期：OSS 未配置，媒体保持待归档

环境：Debian 13.6，uv 提供的 CPython 3.12.15，命令为 runbook 第 3 节的手动形态（未启用 systemd）。

**尚未验证**：systemd 托管形态，尤其是 `ProtectSystem=strict` + `ReadWritePaths=/srv/bili-monitor` 下能否正常写入 SQLite 与 `.collector.lock`。

### 2026-10-23 修复环境模板可选变量空值

首次配置环境文件前发现模板缺陷：`BILI_OSS_*= ` 与 `BILI_COOKIE_FILE=` 的空值形式会让 systemd 注入空字符串，触发 `oss.py:39-45` 的
`ValueError: Incomplete OSS configuration` 与 `source_cookies.py:91-103` 的配置错误，服务启动即退出。已在模板中改为全注释并在运行手册记录原因（提交 `cd94860`）。

该缺陷属于「配置未在目标环境验证」的典型代价，已在本票核验标准之外额外记录。
