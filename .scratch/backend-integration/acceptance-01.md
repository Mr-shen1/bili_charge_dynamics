# 01：UP 管理与配置持久化验收

功能分支：`feat/up-monitoring-management`；起点：`f9c9323723f32aa2439d697fc7d7da3fce792c3b`。

## 实现范围

- `/manage` 经生产管理 HTTP 映射连接 FastAPI；新增只接受字符串 UID，服务端解析公开 card 资料，再原子写入真实 SQLite。
- 每 UP 独立保存近期 N（默认 10）、互斥 recent/specified 模式及启停。没有 UP 数量/100 目标限额；UID 长度和 N 的 JSON 安全整数边界见 [管理契约](../../docs/management-api.md)。指定目标操作由 02 交付，本票仅保存模式。
- 删除仅移除监控配置，身份继续可读/重新添加。上游失败、数据库写失败或并发重复添加不覆盖已有成功资料。
- 版本 0→1 事务迁移；再次启动保持数据，未来版本拒绝启动。上游网络不持有 SQLite 写事务，API 不启动调度器。
- 管理加载/空态/失败原位重试、逐 UID 请求锁、跨访问迟到响应隔离；未知昵称和默认头像兜底；键盘焦点/四宽度无横向溢出。检查/成功时间为 null，显示“未检查”。
- 凭据不进入浏览器；固定错误码/安全提示，不回显请求或上游异常。页面和运行说明显著声明首期无鉴权的公网读写风险。

## 实际执行结果

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过，实施期间多次运行 |
| `pnpm test tests/manage-api.test.ts tests/manage-page.test.tsx` | 17/17，通过生产映射，仅替换 HTTP 传输 |
| `pnpm test tests/discussion-history.test.tsx` | 18/18 |
| `pnpm test --maxWorkers=2` | 全套 11 文件、110/110 |
| `uv sync --locked --group dev` | 锁文件一致 |
| `uv run pytest backend/tests -q` | 全套 89/89，真实临时 SQLite 与上游 JSON fixtures |
| `pnpm test:e2e:manage` | 2/2，真实 Uvicorn、真实 SQLite、生产前端映射；重启 API 后刷新回读；四宽度/键盘/失败与秘密脱敏 |
| `pnpm test:e2e` | 102 通过，10 项仅 Nginx 条件跳过 |
| `pnpm test:e2e:preview` | 构建通过；94 通过，10 项仅 Nginx 条件跳过 |

浏览器命令均设置 `NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost`。直接运行管理浏览器命令时，环境代理曾使 Playwright 误判本地端口已占用；显式绕过代理后通过，没有终止其他服务。

第一次前端全量测试与浏览器回归同时运行时，已有 `discussion-history` 的历史恢复测试触发 5 秒超时（109 通过、1 超时）。该文件随后独立 18/18，受限并发全套 110/110；未改变原测试断言、代码或超时。上述结果保留这一限制，不宣称初次默认并发运行全部通过。

后端测试在公开 HTTP 边界覆盖输入/重复/资料失败/保留/迁移/并发/锁失败。E2E 使用环境指定临时库，显式关闭 Uvicorn 后用同一路径重启；只替换上游传输，不假造仓储或前端 Mapper。虚构秘密分别注入上游异常、请求字段/查询参数，在响应、UI、TestClient 日志及实际 Uvicorn 进程 stdout/stderr 中验证不泄漏。

## Standards

双轴均使用 `review` 子代理，对起点的暂存 WIP 进行只读审查，先 CodeGraph 后实时源码核验。标准轴：**0 硬性违规，5 类判断性建议**（重复文案、取消检查样板、日志枚举、API 根路径代理、Vite 测试 mode）。已提取重复 UID 错误文案；保留 await 前后取消检查以处理忽略取消的传输/JSON；保留 `/api` 精确代理避免该路径变成 SPA HTML；专用测试 mode 仅影响开发代理。日志枚举和生命周期固定错误保持脱敏策略。无阻断性标准问题。

## Spec

规格轴：**0 实质缺失/范围膨胀，1 低影响契约问题，1 前向兼容判断项**。框架方法错误曾返回 `405 INVALID_INPUT`，与契约 `422 INVALID_INPUT` 不一致；先将 HTTP 契约测试改为期望 422，观察失败，再修复并确认 8/8。时间解析要求带秒和时区；当前服务端恒 null，保留严格校验，不提前引入后续检查协议。审查所述实际服务器日志脱敏证据不足已由真实 Uvicorn E2E 补足。

两轴分别收口：标准无硬违反；规格契约缺陷已修复。最终两轴复核无新实质缺陷或证据假宣称；顺手移除错误响应函数已无调用需要的状态参数，并要求实际进程日志包含启动成功记录，避免空日志让脱敏断言平凡通过。

## 未验证及后续边界

- 无真实 B站请求、真实 Cookie/OSS、授权资料协议核验或容量测试；fixture 保留 card 响应结构并经过生产解析，上游协议仍需有限授权核验。
- 无本票的新 Linux 品牌 Chrome / iPhone Safari 真机验收；Chromium 模拟和四宽度不冒充真机。
- 本环境没有 Nginx binary，因此没有重新执行 `pnpm test:delivery` 或新代理的真实 Nginx 验证；Nginx 示例已加入 API 独立代理，Vite/preview 不当作 Nginx 证据。
- 不含指定目标增删、近期发现、完整归档、周期检查或完整运行状态。已保存身份验证当前删除保留约束，后续票据仍须保证新增归档关系保留。
