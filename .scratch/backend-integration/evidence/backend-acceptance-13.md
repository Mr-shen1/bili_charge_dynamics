# #13 后端实施与验证记录

## 边界与依据

仅交付 #13 的后端读取部分，不宣称整票或父票 #03 收口。先阅读 `docs/README.md` 定位的 SRS、HLD、归档协议、集成 spec、#13 票据及 implementation-plan 共同交付要求；读取 TDD 的 SKILL、tests、mocking。仓库有 `.codegraph/`，先经 MCP gateway 调用 `codegraph_explore` 定位 app／Store／测试，再核验实时文件；未派发嵌套代理。

测试 seam 由本票核验标准明确指定：真实临时文件 SQLite → FastAPI HTTP。归档 fixture 通过既有公开 Store 的身份、目标、领取、观察与完成接口准备，所有业务结果从 HTTP 观察；只替换外部上游传输及过期场景的时钟。旧 v5 文件是固定历史格式的兼容输入，不用新版分页器生成“旧 cursor”。

这是后端专项执行结果，主线程将记录归位至 `.scratch/backend-integration/evidence/`；前端与浏览器证据另见 [13 项目级验收记录](../acceptance-13.md)。

## 关键文件

- `backend/bili_monitor/app.py:138`：只读身份入口及 scope／UID 查询校验，省略 scope 兼容 all。
- `backend/bili_monitor/storage.py:108`：直接读取持久身份，无监控状态过滤或上游请求。
- `backend/bili_monitor/storage.py:194`：单 UP SQL 归属过滤、未知身份判断、scope／UID／资源／limit cursor 绑定；保留全局 resource 和 15 分钟持久整集合快照。数据库仍为 v5，无新增迁移。
- `backend/bili_monitor/contracts.py:40`：`404 UNKNOWN_UP`；详情原 `NOT_FOUND` 未改变。
- `backend/tests/test_scoped_archive.py`：新增 31 项公开 HTTP 回归。
- `docs/backend/api/archive-api.md:21`：身份 DTO、scope、错误、排序、冻结范围、失效及旧 cursor 兼容协议。

## 逐片红绿

每片均运行 `uv run pytest backend/tests/test_scoped_archive.py -q`，新能力先红，再只实现该片需要的行为；已存在能力的新增回归首次绿，不人为破坏实现制造红灯。

| 片段 | 红／初次结果 | 随后结果 |
| --- | --- | --- |
| 持久身份列表 | 1 failed，入口尚不存在，返回 404 | 1 passed |
| scope 输入、未知／已知空 | 20 passed / 1 failed，合法 up 被旧查询白名单拒绝为 422 | 21 passed |
| 两 UP 完整排序分页 | 21 passed / 1 failed，单 UP 误返回全局 10/10/5 | 22 passed |
| cursor scope 隔离 | 22 passed / 1 failed，跨 scope 错误地返回 200 | 23 passed |
| 插入／更新冻结、停用／删除、重开 | 首次 26 passed，复用既有持久快照 | 无额外生产修改 |
| 899／900 秒过期边界 | 首次 29 passed | 无额外生产修改 |
| 详情不存在独立回归 | 首次 30 passed | 无额外生产修改 |
| 已发布 v5 全局 cursor 兼容 | 首次 31 passed | 无额外生产修改 |

最终增强停用／删除后的新首批读取检查后，重新执行：

```sh
uv run pytest backend/tests/test_scoped_archive.py -q
# 31 passed in 0.80s
uv run pytest backend/tests -q
# 156 passed in 4.72s
# 1 warning：Starlette TestClient 使用已弃用的 anyio.abc.BlockingPortal 别名

git diff --check -- backend docs/backend/api/archive-api.md
# 无输出，退出码 0
```

## 已覆盖行为与限制

- 两 UP 共 25 条，时间交错／并列、双方 null 发布时间、`"10"` 在 `"2"` 前的 BINARY 排序；全局 10/10/5，各 UP 独立分页，作者不串 scope。
- 首批之后插入、更新正文和发布时间；旧页内容与顺序冻结、同批重读、跨 scope／UP／资源及更改 limit 拒绝后原 cursor 仍可读。
- 重开保留身份、归档及未过期 cursor；旧 v5 文件 cursor 对省略 scope 和显式 all 均可读。续页不续期，恰满 900 秒及再次重开后均拒绝过期 cursor。
- 身份包含删除／停用监控及已知空身份；未知 UP 404、已知空 200、详情不存在独立 404。停用／删除后初始化处理数为零，旧快照和新首批均仍可读。
- 上游传输记录为空，无真实 Cookie、上游、OSS 或仓库外凭据。原有全部后端回归保留并通过。

这里只证明应用 HTTP 接口与真实 SQLite 的自动化行为；没有 TCP 服务／生产部署、前端 Adapter／路由、浏览器／真机、真实上游或持续运行证据。未增加评论、媒体、调度、鉴权、容量承诺或备份能力。整集合快照仍有既有内存／存储成本；15 分钟之后调用方需显式重读首批。
