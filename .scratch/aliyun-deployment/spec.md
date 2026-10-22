# 规格：阿里云 ECS 部署

**目标：** 在维护者已有的阿里云 ECS（华南1 深圳，2 vCPU / 2 GiB，Debian 13，40 GiB 系统盘，3 Mbps 固定带宽，包年包月）上运行本项目，分两阶段交付访问方式：先以 SSH 隧道上线，备案完成后切换域名 + HTTPS + Basic Auth。

**状态：** 产物已写，尚未在目标机执行。所有验证项均为 `ready-for-human`。

## 1. 现状约束

部署方案必须服从下列既有事实，不能假定可以修改：

| 约束 | 来源 |
| --- | --- |
| 应用层完全没有鉴权：`/api/manage/ups*`、`/api/sync/*` 无任何身份校验 | `backend/bili_monitor/app.py:107-185` |
| 前端 `/manage` 只是没有站内入口，URL 直输可访问 | `src/app/App.tsx:17`、`src/manage/ManagePage.tsx:59` |
| 单 API、单 collector、单 SQLite 文件；无 Redis/Celery/常驻 Node | `docs/deployment/static-delivery.md:30-60` |
| 升级必须先停两个进程再切版本；`Store.migrate` 在 API lifespan 执行 | 同上 |
| 前端本地/CI 构建，服务器只交付 `dist/`，不需要 Node | `docs/deployment/static-delivery.md:24` |
| `deploy/nginx.conf` 仅监听 `127.0.0.1:4173`，假定外层还有代理 | `docs/deployment/static-delivery.md:135` |
| 媒体走阿里云 OSS，OSS 未配置时保持待归档、不占本地磁盘 | `backend/bili_monitor/oss.py:36-45` |
| `service.py` 统一入口「本次按用户要求未运行验证」 | `docs/deployment/static-delivery.md:36` |

目标机规格带来的额外约束：

- **2 GiB 内存**：控制台自身提示 ≤4 GiB 易 OOM；必须加 swap。
- **3 Mbps 固定带宽**：约 375 KB/s，文本资源必须 gzip，图片必须走 OSS 绕开 ECS 出口。
- **40 GiB 系统盘**：只存元数据，够用但需容量告警。
- **无备案域名、出口 IP 不固定**：排除「安全组 IP 白名单 + 明文 Basic Auth」这一路线。

## 2. 决策记录

### D1：分两阶段，不在应用层实现登录

**决策：** 不修改 `backend/` 或 `src/` 中的任何代码来加鉴权。

**理由：**

1. 项目在 `README.md:78`、`docs/deployment/static-delivery.md:88`、`ManagePage.tsx:59` 三处明确把「不新增鉴权」记为范围边界。本期目标是部署，不是扩展功能。
2. 应用层鉴权一旦引入，必须同时处理会话存储、CSRF、凭据配置注入、前端登录态、既有测试（`tests/management-auth.test.tsx` 现仅验证 401 映射）——这是一个独立功能票，会和部署工作纠缠。
3. 阶段一（SSH 隧道）没有公网 Web 入口，问题不存在；阶段二用 Nginx Basic Auth 在边缘解决，前端和 API 零改动。两者的攻击面都比自研登录小。

**代价与边界：**

- Basic Auth 是共享口令，没有账号体系、没有审计、没有吊销单设备能力。
- 浏览器原生对话框不可定制样式，用户体验受限于浏览器。
- **OSS 图片是公开 URL，加登录不会保护图片**，可直接外链。

以上视为可接受，且完整记录在案。

### D2：阶段一用 SSH 本地端口转发

**决策：** 安全组只放行 22；Nginx 保持 `listen 127.0.0.1:4173`；维护者本地 `ssh -N -L` 转发访问。

**理由：**

- `deploy/nginx.conf` 本来就是回环监听，天然适配。
- 无公网暴露 → 无需鉴权、无需备案、无需证书，当天可用。
- 顺带解决出口 IP 不固定：IP 变化只需改 SSH 连接目标。

**代价：**

- 只能维护者本人访问，无法分享。
- 每次访问需要建立隧道；手机端体验差（Termius 端口转发受限，替代方案见 D3）。
- **不提升带宽**，流量仍受 3 Mbps 限制。
- 安全边界全部转移到 SSH：必须禁用密码登录与 root 登录。

### D3：手机访问用 Tailscale，而非公网暴露

**决策：** 需要在手机上随时访问时，服务器与手机各装 Tailscale，走 `100.x` 私网地址访问 `:4173`，不新开公网端口。

**理由：** 相比把 80/443 开出来再补明文 Basic Auth，WireGuard 组网不需要备案、不需要证书，且不增加公网攻击面。代价是引入一个第三方依赖。

**边界：** 该方案不写入交付脚本，属于维护者自选项。若采用，安全组的 22 端口可进一步收敛到 Tailscale 网段。

### D4：阶段二只锁管理面，不锁全站

**决策：** `auth_basic` 只加在 `/manage`、`/api/manage/`、`/api/sync/`；`/api/archive/*` 与阅读页保持公开。

**理由：**

- 阅读页（`/`、`/ups/:upId`、`/dynamics/:dynamicId`）只调用 `/api/archive/*`，内容是公开归档。
- 全站加锁会让阅读功能对外不可用，且没有任何收益。
- 管理面拆分依据是真实路由表：只读归档在 `app.py:194-230`，写操作在 `:171-185` 与管理前缀下。

**实现约束：**

- realm 字符串三处必须完全一致（`"bili manage"`），否则浏览器按不同保护空间缓存凭据，登录 `/manage` 后 `/api/manage/*` 的 fetch 不会自动携带凭据。
- `/api/sync/` 容易被漏掉：它是管理页触发的写操作，必须与 `/api/manage/` 同级保护。

### D5：前端发布与后端升级分离

**决策：** `scripts/deploy-frontend.sh` 只做构建、上传、原子切换软链、清理旧版本，**不重启 Python 进程**；后端升级按 `static-delivery.md` 的停进程流程单独执行。

**理由：** 前端是纯静态产物，切换软链即可生效，无需中断采集。后端升级涉及 schema 迁移，必须停进程并等 collector 释放锁，两者的风险等级和操作窗口完全不同，混在一个脚本里容易误操作。

**约束：** 必须保留旧版本目录（默认 5 个）。就地覆盖 `dist/` 会让已缓存的旧页面请求到不存在的哈希资源。

## 3. 交付物

| 文件 | 用途 |
| --- | --- |
| `deploy/nginx-locations.conf` | 共用片段：静态根、缓存、资源命名空间、SPA 回退、`/api` 反代 |
| `deploy/nginx-ecs-tunnel.conf` | 阶段一 server：回环监听 + gzip |
| `deploy/nginx-ecs-https.conf` | 阶段二 server：80 跳转、443 TLS、管理面 Basic Auth |
| `deploy/bili-monitor.service` | systemd unit，托管统一入口 |
| `deploy/bili-monitor.env.example` | 环境文件模板（数据库、OSS、Cookie） |
| `scripts/deploy-frontend.sh` | 前端构建 + 发布 + 原子切换 + 清理 |
| `scripts/verify-nginx-parity.mjs` | 校验部署配置与 `deploy/nginx.conf` 基准不漂移（`pnpm test:nginx-parity`） |
| `docs/deployment/aliyun-ecs.md` | 首次部署、运维、升级、回滚、排障（可复用运行说明） |

`deploy/nginx.conf` **保持不动**：它是 `scripts/verify-static-delivery.mjs:67` 的隔离验证基准。新增片段与它规则同源；`pnpm test:nginx-parity` 会逐块比对两者，不通过即表示需要同步。

## 4. 未验证事项

以下为部署过程中识别的风险点及验证状态；阶段一范围内已实测的项目标为完成，其余不得当作已通过：

- [x] 统一入口 `backend.bili_monitor.service` 的实际运行——2026-10-23 在目标机实测通过（HTTP 200、API 迁移完成、collector `cadence_seconds=15`）。上游文档原声明该入口未验证。
- [x] systemd unit 在 `ProtectSystem=strict` + `ReadWritePaths` 下能否正常写 SQLite 与 `.collector.lock`——实测通过；期间修正了 `ProtectHome=yes` 导致 `203/EXEC` 的缺陷（改为 `read-only`）。
- [x] Debian 13 上 `uv sync --locked --no-dev` 与 CPython 3.12 的获取——实测得到 CPython 3.12.15，`fastapi`/`oss2`/`uvicorn` 导入正常。
- [x] 三份新增 Nginx 配置的 `nginx -t` 与实际 HTTP 行为——`nginx-ecs-tunnel.conf` 已在目标机 nginx/1.26.3 上通过 `nginx -t` 并验通全部 HTTP 行为；`nginx-ecs-https.conf` 因缺域名与证书仍未验。
- [x] `scripts/deploy-frontend.sh` 的 rsync、`mv -Tf` 原子切换与旧版本清理——已实际发布并验通。
- [ ] Basic Auth 登录后管理页 fetch 是否自动携带凭据（realm 一致性）
- [ ] 2 GiB 内存 + 加 swap 后 collector 长时间运行的稳定性（短时运行与内存峰值 113 MB 已观察，无 OOM；持续曲线仍待观察）
- [x] 端到端采集链路与登录态——维护者通过隧道在页面确认充电专属内容可读，说明 cookie 被上游接受且账号有权限。
- [ ] OSS 媒体上传（本工作未配置，媒体保持待归档）
- [ ] 备案流程与证书签发

## 5. 风险边界

- 首次部署顺序错误（先起 collector 后起 API、或用不同数据库路径）会导致空归档或迁移失败。
- 没有备份能力：维护者必须自行配置定时 `sqlite3 .backup`，且在服务运行时不要 `cp` 数据库文件。
- `error_log /dev/null` 是刻意的：防止 API 不可达时 Nginx 默认错误日志记录原始 query。代价是运行期几乎无日志，排障依赖 `nginx -t`、HTTP 状态码、进程退出状态和 API 脱敏错误码。
- 磁盘或 OSS 增长可能停止写入，本项目不提供容量治理。
