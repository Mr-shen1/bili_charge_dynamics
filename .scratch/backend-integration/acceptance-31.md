# #31 可复现双进程与 Nginx 交付

执行日期：2026-10-16。基线：`f47472f7805555febe364cabf99f7a94abb3875f`，当前分支 `feat/backend-integration`。范围为隔离部署及自动化，不是云部署或全项目验收；#30 已交付实现作为本次运行底座，不替其人工签收。

## 交付与边界

- 沿用生产 FastAPI、Collector、真实 SQLite 和前端生产 Adapter；新增 `backend/tests/deployment_fixture.py` 仅替换外部来源 HTTP、图片下载、上传。原始虚构 HTML/JSON 复用已跟踪 fixtures，不依赖 ignored 素材、真实服务或秘密。
- `backend/tests/test_deployment_processes.py` 启动真实单 API 与独立采集进程，通过公开 HTTP 验证配置、检查、归档、模拟上传、来源/上传门闩期间读取及配置可用、API 重启不领取 running、SIGKILL 后采集重启恢复、失败无新信号重试、第二采集进程被拒绝、脱敏和只读浏览。
- `pnpm test:delivery` 保留显式 mock 历史回归，另外启动生产 API/采集共享临时 SQLite，由实际 Nginx 提供正常生产构建。浏览器只替换外部公开图片传输，不拦截归档 API；桌面 1280 与手机 390 宽验证四类页面直接访问和刷新、未知页、图片预览、浏览只 GET、不访问上游。
- API 成功/错误和缺资源隔离、入口重新验证、哈希资源长期缓存、mock/fault 隔离、相同输入重建及生产/mock 两次真实构建更新均实际执行。生产更新：`index-BTVOgYMH.js` → `index-C7nDeOSd.js`，保留旧哈希并刷新执行新版本。
- 可复用运行/迁移/启停/升级/排障见 [交付运行说明](../../docs/deployment/README.md)及[后端 README](../../backend/README.md)。一次执行细节见[专项证据](evidence/deployment-31.md)。

## 测试结果

| 命令/入口 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile`、`uv sync --locked --group dev` | 成功，无依赖变更 |
| `pnpm typecheck`、`git diff --check` | 通过 |
| `uv run --no-sync pytest backend/tests/test_deployment_processes.py -q` | 6 passed；同时纳入后端全量 |
| `uv run --no-sync pytest backend/tests -q` | 669 passed，3 个既有 OSS SDK 弃用警告 |
| `pnpm test --maxWorkers=2` | 25 文件、268 passed |
| `NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost pnpm test:e2e` | 104 passed，10 个 Nginx 专项按设计 skipped |
| 同环境 `pnpm test:e2e:manage` | 7 passed |
| 同环境 `pnpm test:e2e:archive` | 38 passed |
| 同环境 `pnpm test:e2e:preview` | 96 passed，10 个 Nginx 专项按设计 skipped |
| `NGINX_BIN=… NGINX_MIME_TYPES=… pnpm test:delivery tests/e2e/static-delivery.spec.ts` | 历史静态专项 10 passed，加生产部署/更新阶段通过 |
| `NGINX_BIN=… NGINX_MIME_TYPES=… pnpm test:delivery` | 历史正常浏览器 106 passed，加构建重现、fault 隔离、mock 更新、生产部署与生产更新/秘密扫描均通过；最终恢复生产 `dist/` |
| 仅版本化文件与本次新增文件的临时副本：全新依赖目录锁定安装并 `pnpm build` | 成功；完整 `dist/` 与工作区生产构建字节一致；副本双进程专项 6 passed，不包含两个用户已有未跟踪文件 |

首轮默认并行 `pnpm test` 的两个既有 discussion-history 测试超过 5 秒，单文件重跑 18 passed；不改断言或超时，限制 2 workers 全量 268 passed。首次浏览器启动未设置 NO_PROXY，探测误报 4173 已占用；实际端口空闲，按已有文档绕过本地代理后全部通过。首轮生产集成发生在 fixture CLI 尚未完成时，采集进程退出，补齐后专项与全量通过；不把这些装配失败冒称产品缺陷。

## TDD 与安全修正

已获用户确认两个测试边界：实际 API/独立采集，以及实际 Nginx/生产前端。后端测试逐片添加装配；生产采集/恢复是已有行为回归，不虚构为本票修复。

实际发现一项交付缺陷：Nginx 在 API 不可达返回 502 时，默认 error 日志包含 query 中的虚构秘密。先运行公开 HTTP/进程 stderr 断言得到 `Process diagnostics leaked the fixture secret`，再在交付 server 显式关闭 access/error 原始请求日志，重跑通过。最终部署脚本持续保留 API 不可达和缺资源秘密 query 的扫描，API/采集日志与 HTTP/UI/构建同时扫描。仅使用 `FAKE_DEPLOYMENT_SECRET_31_NEVER_REAL`，没有读取真实凭据。

关闭该 server 的请求日志意味着请求级错误细节不保留；使用配置检查、HTTP 状态、进程退出和固定脱敏 API 错误排障，外层代理也不得记录原始 URI/请求体。未提供日志平台或新的安全服务。

## 未验证与风险

- 无真实云部署、匿名 OSS 读取/上传、真实上游自然编辑、持续 15 秒调度或实际规模资源证据；交由 #34。
- Chromium 及手机宽度不等于 Linux 品牌 Chrome/iPhone Safari 本期人工验收；交由 #33。本次不是 #35 的原图视觉验收。
- 公网管理/API 无鉴权，第三方可能读取归档或修改配置；隐藏入口不是保护。公开 OSS URL 可直接访问及外链，未来登录也不会保护图片。
- 无备份、容量治理、自动清理或容灾；数据损坏/误操作/磁盘与 OSS 增长可能丢数据或停止写入。不强制 2 核 2GB 同机、不保证容量、并发或完成时限。
- 本记录供 #32 汇总，不勾选父票或整个产品全部 AC。

## 双轴 review

开工 HEAD 固定为上述基线；按用户要求不先提交，两个 `review` 代理并行审查完整暂存 diff。

### Standards

硬性规范违规 0；判断性异味 4：发布更新验证重复、跨语言 fixture 字面量重复、部署位置参数成组、测试 ID 原始值。已提取 `scripts/verify-entry-update.mjs`，mock 与生产共用同一原子切换/缓存/浏览器更新验证。其余不改：测试保留独立字面量期望，避免直接复用实现常量导致同改同错；跨语言不为少量 fixture 值增加配置服务；部署位置已经是单个命名参数对象，不另加无行为的 context 包装。修正复核确认无新增阻断或行为遗漏。

### Spec

确认的规格缺陷 0。建议补版本化的干净副本 frozen install/build 命令，已写入专项证据，并实跑新副本依赖安装、字节对比与 6 项双进程测试。云、真机、容量及原始日志关闭的取舍均保持明确边界。修正复核确认缺陷仍为 0；提取后完整 Nginx 再跑 106 passed，生产部署与两次更新阶段通过，`pnpm typecheck` 与脚本语法检查通过。
