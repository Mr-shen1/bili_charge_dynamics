# 票据 01 后端

仅提供 UP 身份和监控配置管理，不包含采集、指定目标操作或调度。HTTP 契约见 `docs/management-api.md`。

## 运行

在仓库根目录执行：

```sh
uv sync --locked
BILI_DATABASE_PATH=/absolute/path/monitor.sqlite uv run uvicorn backend.bili_monitor.app:app --host 127.0.0.1 --port 8000
```

Python 使用 `.python-version` 固定的 3.12；FastAPI、HTTPX、Uvicorn 和 pytest 使用固定稳定版本，完整解析结果在 `uv.lock`。未设置 `BILI_DATABASE_PATH` 时数据库默认为 `backend/data/monitor.sqlite`。目录在启动时创建。只启动一个 API worker；不需要 Node.js、Redis 或采集进程。

**首期无鉴权**：所有管理接口都可读写。请通过监听地址、防火墙或反向代理限制暴露范围；隐藏页面入口不是保护。当前不提供备份或容量治理。

## 应用工厂

```python
from backend.bili_monitor.app import create_app

app = create_app(database_path, profile_transport=None)
```

`database_path` 为文件数据库路径（字符串或 Path）；工厂不打开数据库，ASGI lifespan 启动时执行迁移。`profile_transport` 为可选 `httpx.AsyncBaseTransport`；`httpx.MockTransport` 同时实现该边界，测试仍执行生产 card 协议解析。请使用包含 lifespan 的服务器或 `with TestClient(app)`。

生产只请求公开 `/x/web-interface/card`，HTTP 超时为 10 秒，不跟随拒绝或重定向、不使用环境代理、无凭据输入。身份资料必须完整并匹配 UID，才短事务写入身份和默认配置。

## SQLite

- 版本 0 表示尚未安装管理 schema 的文件数据库，包括首次创建的数据库；在一个真实 SQLite 事务内创建身份表、独立配置表和版本 1。
- 已存在的无关旧表不会被删除；冲突 schema 使迁移失败并回滚，不能假装成功。
- 版本 1 再次启动不改写资料或配置；未知未来版本拒绝启动。
- 每个连接启用外键，SQLite 等待锁最多 2 秒；数据库操作在线程池执行，不阻塞事件循环。
- 上游网络期间不保留数据库连接或写事务。提交时再次检查重复 UID，保证并发添加仅一方成功且失败不覆盖资料。
- 删除只影响配置；身份及其他引用身份的数据仍保留。检查时间始终为 null。

错误响应使用固定错误码和提示，不记录请求体、上游原文或异常文本。HTTPX/HTTPCore 传输日志及 Uvicorn access 日志被禁用，避免 debug 日志或 URL 查询参数泄漏。部署层应同样避免记录敏感查询参数；此应用不控制外部代理日志。

## 测试与 E2E 装配

```sh
uv run pytest backend/tests/test_management.py -q
uv run pytest backend/tests/test_migrations.py -q
uv run pytest backend/tests/test_live_app.py -q
uv run pytest backend/tests -q
```

测试使用公开 HTTP、真实临时 SQLite、真实事务/锁及虚构上游 JSON；只替换外部 transport，不替换仓储或解析。SQLite 故障夹具通过元数据定位关系，仅用于构造故障；最终结果由 HTTP 验证。迁移另核验公开 schema 版本。

供前端 E2E 调用的独立装配：

```sh
BILI_DATABASE_PATH=/tmp/bili-management-e2e.sqlite uv run uvicorn backend.tests.live_app:create_app --factory --host 127.0.0.1 --port 8765
```

装配要求显式设置环境数据库路径，不预填身份；新增仍由生产管理接口保存。固定虚构资料为 UID `900719925474099312345`（虚构星海）、`202`（虚构晨光），头像使用 `example.invalid`。其他合法 UID 返回资料不可用，可用于失败/重试操作。每次全新验收使用新的临时路径；同一路径用于验证重启持久化。该装配不进入普通应用，无管理故障控制接口。
