# 本机 live-34 后端重新部署

本机长期运行的隔离实例（API＋独立 collector，`127.0.0.1:18444`）的后端发布步骤。它与[本机 live-34 前端重新部署](local-live-frontend.md)分开：前端只换 `web-dist`，后端要停进程、同步依赖、启动并验证迁移。真实验收证据见 [live-34 人工验证记录](../../.scratch/backend-integration/evidence/live-34/manual-validation.md)；生产与云部署按[静态交付说明](static-delivery.md)与[阿里云 ECS 运维手册](aliyun-ecs.md)。

## 1. 组成与边界

| 项 | 值 |
| --- | --- |
| 后端 unit | `bili-charge-live-34.service`（transient user unit，`Type=exec`、`Restart=no`、`TimeoutStopUSec=5s`） |
| 启动脚本（仓库外） | `~/.local/state/bili-charge-dynamics/live-34/run-api.sh`（`700`） |
| 入口 | `.venv/bin/python -m backend.bili_monitor.service --host 127.0.0.1 --port 18444` |
| 进程形态 | 一个 API 子进程 + 一个独立 collector 子进程；API 内不内嵌定时器 |
| SQLite | `~/.local/state/bili-charge-dynamics/live-34/archive.sqlite3`（仓库外、`600`） |
| 采集锁 | 同目录 `archive.sqlite3.collector.lock`；运行中不得删除、不得用硬链接别名绕过 |
| 服务端配置 | `BILI_DATABASE_PATH`、可选 `BILI_COOKIE_FILE`（仓库外 `0600` 文件）与 `credentials/oss.env`（存在时由 `run-api.sh` 载入） |

要点：

- 统一入口负责进程托管：等 API 完成迁移并监听后才启动 collector；父进程收到 TERM 先等 collector 退出再停 API，任一子进程异常退出会停掉另一个。
- 不要加 `--workers`、`--reload` 或 `WEB_CONCURRENCY`；不要同时再起第二个 collector，也不要与手动双进程入口并用。
- **重启会恢复持久未完成工作**：collector 取得锁后会继续未完成的检查/同步，可能立即产生上游请求。发布前的验证不要靠新增 UP 或初始化来“确认可用”，那会访问上游。
- 只改前端时不要重启后端；只改后端时不要动前端 unit。

## 2. 重新部署步骤

后端产物来自已提交代码，工作区状态先记录：

```bash
cd /home/kevin/Projects/PI/bili_charge_dynamics
git status --short && git log --oneline -1
```

### 2.1 停止 unit 并等待真正退出

```bash
systemctl --user stop bili-charge-live-34.service
for i in $(seq 1 10); do
  systemctl --user is-active --quiet bili-charge-live-34.service || break
  sleep 1
done
systemctl --user is-active bili-charge-live-34.service || echo '已停止'
```

`TimeoutStopUSec=5s` 表示最多等约 5 秒，之后可能被强制结束；强制结束等于中断一次采集，不可当作干净停机。确认 18444 无监听再继续：

```bash
ss -ltn | grep -q ':18444' && echo '端口仍被占用，先排查' || echo '端口已释放'
```

### 2.2 同步依赖

代码内的 `pyproject.toml` / `uv.lock` 变了才需要；未变时执行也安全：

```bash
uv sync --locked
```

不安装测试依赖到生产环境时可用 `uv sync --locked --no-dev`，之后若要跑 pytest 需重新 `uv sync --locked`。

### 2.3 重启 unit

```bash
systemctl --user start bili-charge-live-34.service
systemctl --user is-active bili-charge-live-34.service
```

`run-api.sh` 与数据库路径都固定在仓库外，重启只重新读取当前工作树代码与 `.venv`；**切换代码版本要在启动前完成**，不要在新旧进程并存时让两者共用同一数据库。

### 2.4 验证

```bash
for p in /docs /openapi.json /api/manage/ups; do
  printf '%s -> %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:18444$p")"
done
journalctl --user -u bili-charge-live-34.service -n 60 --no-pager
```

期望：

- 三个请求均为 `200`；`/api/manage/ups` 返回现有身份与配置，不需要也不应该通过新增 UP 验证。
- 日志里有 API 启动完成监听与 collector 启动的记录，没有迁移失败、锁冲突或 `future schema` 拒绝启动。
- schema 版本可直接读库确认（只读方式，不写库）：

```bash
python3 -c "
import sqlite3, os
path = os.path.expanduser('~/.local/state/bili-charge-dynamics/live-34/archive.sqlite3')
c = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
print('user_version', c.execute('PRAGMA user_version').fetchone()[0])
"
```

当前代码 `Store.migrate` 迁移到 `user_version = 14`；升级后应等于它。小于它是迁移未执行，大于它是库比代码新（旧代码会拒绝启动）。

- 采集状态用只读 HTTP 核对（不触发检查）：`GET /api/manage/ups/{uid}/checks`、`/discovery`。
- 前端仍由 `bili-charge-live-34-web.service` 提供，`http://127.0.0.1:18445/manage` 应照常可用；前端未发版时无需重启它。

## 3. 回滚

迁移只前进、不回退：`Store.migrate` 遇到未来版本会拒绝启动，也没有降级或备份流程。因此回滚顺序是：

1. `systemctl --user stop bili-charge-live-34.service` 并等退出；
2. 切回上一版本的代码（`git checkout <上一提交>` 或等价操作）；
3. `uv sync --locked`；
4. `systemctl --user start bili-charge-live-34.service`，按 2.4 复核。

如果本次升级已经把数据库迁到更高版本，旧代码将拒绝启动。此时不要删库、不要手改 `user_version`、不要用备份覆盖唯一数据库；先保留现场（复制一份 `.sqlite3` 到私有目录）再决定是前滚修复还是单独评估恢复方式。

## 4. unit 被回收后重建

按原参数重建，保持同一端口、同一数据库、同一脚本：

```bash
systemd-run --user --unit=bili-charge-live-34 \
  --description='Bili #34 isolated local API; no collector or OSS' \
  --property=Type=exec \
  --property=WorkingDirectory=/home/kevin/Projects/PI/bili_charge_dynamics \
  --property=UMask=0077 --property=Restart=no --property=TimeoutStopSec=5 \
  /home/kevin/.local/state/bili-charge-dynamics/live-34/run-api.sh
```

重建前确认 18444 与锁文件状态；锁文件存在本身是正常现象，只有在确认没有任何 collector 进程时才需要处理。

## 5. 未覆盖

- 本流程只做本地只读验证，不发起上游采集、不执行初始化、不上传 OSS、不改凭据。
- 不构成云部署、真机验收、容量或持续运行证据；Nginx/Basic Auth、systemd 常驻、备份与升级回滚的生产口径见[静态交付说明](static-delivery.md)、[阿里云 ECS 运维手册](aliyun-ecs.md)与 `deploy/nginx-ecs-https.conf`。
