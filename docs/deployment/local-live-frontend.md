# 本机 live-34 前端重新部署

本机长期运行的隔离实例（API `127.0.0.1:18444`、前端 `127.0.0.1:18445`）的前端发布步骤。它是本机临时运行环境，不是正式部署入口；真实验收证据见 [live-34 人工验证记录](../../.scratch/backend-integration/evidence/live-34/manual-validation.md)，生产/云部署按[静态交付说明](static-delivery.md)与[阿里云 ECS 运维手册](aliyun-ecs.md)执行。

> [Vue 前端重构](../design/frontend-migration.md) 票据 12 已形成仅含 Vue 的候选产物，前端构建目录为 `frontend/`、产物为 `frontend/dist/`。本页命令已按该布局更新，但本机实例仍是迁移前的产物，重新发布前须重新核实构建命令、入口及全部引用资源（包含新增的路由级 chunks），不能仅凭 `index-*.js` 哈希变化判定交付通过；本页不是新版发布证据。只发布前端的边界不变。

## 1. 组成与边界

| 项 | 值 |
| --- | --- |
| 前端 unit | `bili-charge-live-34-web.service`（transient user unit） |
| 前端进程 | `vite preview`，root 为仓库、`outDir` 指向仓库外 `web-dist`，代理 `/api`、`/docs`、`/openapi.json` 到 API |
| 前端目录 | `~/.local/state/bili-charge-dynamics/live-34/web-dist` |
| 历史产物 | 同目录下 `web-dist.previous-<YYYYmmdd-HHMMSS>` |
| 启动脚本（仓库外） | `~/.local/state/bili-charge-dynamics/live-34/run-web.sh`、`run-api.sh`、`serve-web.mjs` |
| API unit | `bili-charge-live-34.service`（`backend.bili_monitor.service`，API + 独立 collector） |
| SQLite | `~/.local/state/bili-charge-dynamics/live-34/archive.sqlite3`（仓库外、`600`） |

要点：

- 前端产物与业务代码分离：仓库只负责构建，`web-dist` 在仓库外轮转，避免就地覆盖导致已缓存页面请求到不存在的哈希资源。
- 本流程**只发前端**。后端代码变更见[本机 live-34 后端重新部署](local-live-backend.md)；只改前端时不要重启 API。
- 不发布 `build:mock` / `dev --mode mock` / `dev:fault` 产物，也不复用来源不明的既有 `dist`。

## 2. 重新部署步骤

任一操作前确认工作区状态；生产产物应来自已提交的代码，避免把未提交改动混入发布：

```bash
cd /home/kevin/Projects/PI/bili_charge_dynamics
git status --short && git log --oneline -1
```

### 2.1 构建并暂存

```bash
STATE=~/.local/state/bili-charge-dynamics/live-34
( cd frontend && pnpm build )
mkdir -p "$STATE/web-dist.next"
rsync -a --delete frontend/dist/ "$STATE/web-dist.next/"
```

### 2.2 轮转产物

```bash
cd "$STATE"
STAMP=$(date +%Y%m%d-%H%M%S)
mv web-dist "web-dist.previous-$STAMP"
mv web-dist.next web-dist
ls -1d web-dist*
```

保留最近若干个 `web-dist.previous-*` 作为回滚点（按需手工清理；不要删除当前 `web-dist`）。

### 2.3 重启前端 unit

```bash
systemctl --user restart bili-charge-live-34-web.service
systemctl --user is-active bili-charge-live-34-web.service bili-charge-live-34.service
```

`vite preview` 的 `root` 是 `frontend/`（配置与 `index.html` 所在目录），重启只重新读取 `web-dist` 与仓库外的 `serve-web.mjs`；unit 不会因为 `frontend/dist/` 变化而自动重载。

### 2.4 验证

```bash
for p in / /manage /manage/ups/1 /api/manage/ups /docs; do
  printf '%s -> %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:18445$p")"
done
curl -s http://127.0.0.1:18445/ | grep -o 'assets/index-[^"]*'
```

期望：`/`、`/manage`、`/manage/ups/<任意 uid>` 均为 `200`（SPA 回退），`/api/manage/ups` 返回真实数据，`/docs` 为 `200`；入口引用的 `assets/index-*.js|css` 与本次构建输出的哈希一致；未知 UID 的 `/api/manage/ups/<uid>` 返回 `404 NOT_FOUND` 属正常。

浏览器只读检查（可用 Playwright 或手工）：

- `/manage` 列出 UP 卡片（身份 + `UID：…` + 监控状态徽标），点卡片进入 `/manage/ups/<uid>`；
- 单 UP 页分区为「昵称、监控配置、指定动态目标、近期发现与当前窗口、目标检查与归档状态」；
- 页面无 `pageerror`；头像等外部图片按上游实际可达性加载，图片失败不视为部署失败。

## 3. 回滚

把 `web-dist` 指回上一个产物并重启前端：

```bash
cd ~/.local/state/bili-charge-dynamics/live-34
ls -1d web-dist.previous-*        # 选目标版本
mv web-dist "web-dist.failed-$(date +%Y%m%d-%H%M%S)"
mv web-dist.previous-<目标时间戳> web-dist
systemctl --user restart bili-charge-live-34-web.service
```

回滚只切前端，不涉及 SQLite 与 API；数据库变更不由本流程回退。

## 4. unit 被回收后重建

transient unit 在本机重启或停止后可能被回收。确认端口占用与进程已停止后按原参数重建（前端示例）：

```bash
systemd-run --user --unit=bili-charge-live-34-web \
  --description='Bili #34 real frontend local preview; isolated API proxy' \
  --property=Type=exec \
  --property=WorkingDirectory=/home/kevin/Projects/PI/bili_charge_dynamics \
  --property=UMask=0077 --property=Restart=no --property=TimeoutStopSec=5 \
  /home/kevin/.local/state/bili-charge-dynamics/live-34/run-web.sh
```

API 的重建方式见 live-34 人工验证记录的 systemd-run 段；两者都不要改成监听 `0.0.0.0`，跨机访问用 SSH 隧道。

## 5. 未覆盖

- 本机实例只做本地只读检查，不发起上游采集、不触发初始化、不访问 OSS。
- 不是云部署、真机验收或持续运行证据；容量、备份与 Nginx 生产路径仍以[静态交付说明](static-delivery.md)与[阿里云 ECS 运维手册](aliyun-ecs.md)为准。
