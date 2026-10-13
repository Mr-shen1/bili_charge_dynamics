# 02 后端实施证据

## 已确认 seams 与安全边界

T2/T3：公开 FastAPI 管理/归档/初始化 HTTP，实际临时 SQLite 与关闭重开，只替换外部 HTTP transport。未访问真实上游、未读取 Cookie、未执行或导入本机 ignored 原脚本。

静态协议字段依据见 [source-protocol-evidence.md](../../../docs/backend/evidence/source-protocol-evidence.md) 与 [dynamic-protocol-fields.md](../../../docs/backend/evidence/dynamic-protocol-fields.md)。第三方快照与固定虚构 fixture 不证明上游长期可用。尤其不能把通用 OPUS/DRAW `summary` 当作全文：成功正文必须从 HTML 的受支持 `MODULE_TYPE_CONTENT` 段落读出；标题独立保存。

## 实现

下列 `bili_monitor/...` 路径相对于仓库的 `backend/`；`app.py` / `contracts.py` 位于 `backend/bili_monitor/`，测试文件名相对于 `backend/tests/`。最终命令仍在仓库根目录执行。

- `bili_monitor/source.py`：安全 JSON 解析 HTML 初始化状态、按 AUTHOR/CONTENT/TITLE/STAT 模块类型定位；校验实际作者、独立解析 +08 发布秒和可信编辑分钟。HTML 正文处理 WORD/RICH 文本节点及有序图片段；未知节点/段落不静默丢弃。detail JSON 只补作者、计数、评论 locator 和有序媒体 metadata；不将 summary 回退为正文。
- `bili_monitor/sync.py`：一次性处理 enabled + specified 集合。正文读取、编辑观察和 detail metadata 解耦；失败保留旧成功内容；可信版本之外不冒领 checkpoint。读取 API 不调用同步。
- `bili_monitor/storage.py`：schema v1–v5 迁移；身份、配置、目标与归档分离；短事务 generation 条件提交；observed/synced 与 text/media/comments work 独立；SQLite 持久列表快照和过期 cursor。
- `app.py`/`contracts.py`：目标校验、移除、显式初始化、真实 archive list/detail HTTP。错误固定脱敏；删除 monitor/target 不删除身份和 archive。
- 固定脱敏 HTML/JSON fixture 及 HTTP 测试位于 `backend/tests/fixtures/`、`test_initial_archive.py`、`test_full_archive.py` 和 `test_migrations.py`。

## Red → Green 与最终结果

- 空目标 GET/幂等删除重开：从 404 Red 到迁移 v2 + targets HTTP Green。
- 目标归属正确、不符、未知/恶意表达式、HTML/JSON ID 错配：验证只有确认后关联；重复提交也重新核验，再由持久层幂等保存。
- 首次初始化由空 HTTP 404 Red 到公开入口 Green；随后用完整 HTML CONTENT 固定夹具验证正文、标题、成功空、受限和失败。
- 针对错误全文来源新增 `test_full_archive.py` 三个回归：首次运行 3 failed，证明 OPUS summary 会被伪装成功/受限会冒充成功；修复为 HTML-only 正文并严格推进 checkpoint 后 3 passed。另验证 TITLE metadata 结构错误不会丢弃有效 CONTENT 正文。
- 原 JSON fixture 测试被改为 HTML 正文 fixture：只有完整 HTML 正文与成功空计入成功；HTML缺失但 OPUS summary 有值仍失败；受限计 failed，状态保持 restricted 与 pending。
- snapshot、旧/新 generation 并发、过期/跨资源 cursor、更新时间/内容、失败重试、数据库重开、删除配置保留等 T2/T3 行为由真实 HTTP 和 SQLite 验证，不测试私有 SQL 作为结果。

最终命令：

| 命令 | 结果 |
| --- | --- |
| `uv run pytest backend/tests/test_management.py -q` | 82 passed |
| `uv run pytest backend/tests/test_migrations.py -q` | 9 passed |
| `uv run pytest backend/tests/test_initial_archive.py -q` | 29 passed |
| `uv run pytest backend/tests/test_full_archive.py -q` | 4 passed |
| `uv run pytest backend/tests -q` | 125 passed |
| `uv run python -m compileall -q backend` | 通过 |
| `git diff --check` | 通过 |

首次将管理与归档 Playwright 同时运行时，两者共用 4176 导致归档 API 收到 `EADDRINUSE`；串行重跑 `pnpm test:e2e:archive` 后，实际 Uvicorn + fixture transport + 真实 SQLite + 生产前端完整穿透 1/1 通过。没有终止其他进程。浏览器命令绕过 localhost 代理，不访问真实上游。

## 对外语义

四类 fixture 返回 `processed=4,succeeded=2,failed=2`：正常正文与成功空为正文成功；受限/读取失败计失败。正文失败保留旧 success；来源计数与本地根评论数分离；媒体/评论工作始终 pending，不冒充全部完成。编辑未知/error 不写当前时间或未编辑标记；来源时间精度不补秒。

全局 list 按时间降序、未知时间最后、字符串 ID 升序，每批最多 10。首批冻结内容/成员/顺序，SQLite cursor 绑定 all-resource、排序和批量，过期 15 分钟；伪造/失效/批量错误等返回 422。读取仅查 SQLite，旧 snapshot 在有效期内不因更新重复或漏项。

## 未验证/范围限制

不含周期调度、近期发现、评论/回复采集、OSS 上传、单 UP scope、I3 旧归档 UP 导航身份集合、全量状态管理；本票仅实现 all-scope 列表与详情。无真实上游权限/长期可用性、部署、Linux Chrome/iPhone Safari 真机、容量或 15 秒运行验证。摘要/模块协议有限且来自第三方文档与脱敏结构，不证明全部页面正文结构；无法解析的结构明确待重试，不假成功。
