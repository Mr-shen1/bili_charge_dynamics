# 16 验证静态交付、资源更新与前端回退

- 对应票据：[16: 验证静态交付、资源更新与前端回退](../issues/16-static-delivery-rollback.md)
- 对应规格：[前端重构实施规格](../spec.md)、[静态交付与 Nginx 运行说明](../../../docs/deployment/static-delivery.md)、[行为基线差异](../baseline-differences.md)
- 证据状态：**在本机隔离环境用临时编译的 Nginx 1.28.0 实际执行 `pnpm test:delivery` 全流程通过**（mock 静态交付、构建复现与故障隔离、生产构建 + 实际 API/collector、原子更新与前端回退）。未在目标机、云环境、真实上游/OSS 或公网执行；本记录不构成本期正式上线或云部署完成。

## 1. 结论

| 票据要求 | 结果 | 证据位置 |
| --- | --- | --- |
| 固定候选源码 + 锁定依赖构建静态产物，记录入口与引用 chunks，无 SSR/常驻 Node | 通过 | §2、§3、manifest |
| 隔离 Nginx 六路由直达/刷新、未知地址；API 错误与缺失资源不回退 SPA；代理保护与 401 提示保留 | 通过 | §4.1、§4.3 |
| 入口重新验证、哈希资源缓存、全部引用资源可达、新增拆包资源 | 通过 | §4.2、§4.3 |
| 默认生产装配与 mock/fault 隔离，普通产物无故障入口/虚构动态/秘密；修正废弃路径与资源探测耦合 | 通过 | §3.2、§5 |
| 原子切换、旧哈希保留、旧产物回退，新旧已打开页面资源可达 | 通过 | §6 |
| 只切前端：不回退 SQLite、不因前端重启 collector，保留旧产物与源码/依赖信息 | 通过 | §6.3、§7 |
| 构建/交付/回退说明与实际一致，记录环境、命令、版本、资源检查与结果 | 通过 | 本文件 + [static-delivery.md](../../../docs/deployment/static-delivery.md) 第 3 节 |
| 隔离 Nginx 证据与开发预览、mock、实际 API 集成分别记录 | 通过 | §4 分阶段记录 |
| 候选变化时补验，证据与统一候选版本一致 | 记为约束 | §8 |

## 2. 环境与候选

| 项 | 值 |
| --- | --- |
| 候选源码 | 本票交付提交（分支 `feat/backend-integration` 上标题为 `test(frontend): 隔离 Nginx 验证静态交付、资源更新与前端回退` 的提交；具体哈希见 `16-delivery-manifest.json` 的 `source.commit`，该清单在随后的记录提交中加入并按本提交源码与 lockfile 重建） |
| 前端根 | `frontend/`（唯一前端应用） |
| 锁定依赖 | `frontend/pnpm-lock.yaml` sha256 `8b7b09908c334a72895d0da69ec33375e830a863bca987b47978e1314fe2811a`；`uv.lock` sha256 `c55b8767d7908e009f4ebcd8b319d1ddf7c4fcb836fc3e406326c5079726b538` |
| 运行时 | Node `24.21.0`（nvm，仓库根 `.nvmrc`）、pnpm `10.34.6`、uv `0.12.23`、Python `3.12.15`（`.venv`，`.python-version` 3.12） |
| 直接依赖 | `vue` 3.5.44、`vue-router` 4.6.4、`element-plus` 2.14.7；构建/测试：`vite` 7.3.1、`vue-tsc` 3.3.13、`vitest` 4.0.18、`@playwright/test` 1.58.2 |
| 浏览器 | Playwright Chromium `145.0.7632.6`（桌面 1280×900 与 Pixel 7 视口） |
| OS / 内核 | CachyOS Linux / `7.2.11-1-cachyos` x86_64 |
| Nginx | 本机无系统 Nginx；按文档在临时目录源码编译 `nginx/1.28.0`（gcc 16.2.1，`./configure --prefix=/tmp/nginx-16/runtime`），`mime.types` 取自同源码包 |
| 端口 | 交付示例端口 `127.0.0.1:4173` 已被本机既有 ssh 隧道占用（现有实例未操作），本次用 `DELIVERY_PORT=4273`；API 与鉴权探针端口由脚本临时申请 |
| 后端 | 未修改；使用 `backend/tests/deployment_fixture.py`（生产 API/collector/SQLite 实现，仅替换外部 I/O） |

候选产物清单（入口、全部哈希资源、sha256）见同目录 [`16-delivery-manifest.json`](16-delivery-manifest.json)。

## 3. 构建与产物

### 3.1 构建命令

```bash
source ~/.nvm/nvm.sh && nvm use          # Node 24.21.0
uv sync --locked
cd frontend
pnpm install --frozen-lockfile
pnpm check:dist                          # build + build:mock + check:isolation
```

- `pnpm build` → `frontend/dist/`（28 个哈希资源，含 6 个路由 chunk + 共享 chunk/CSS）；入口 `index.html` 只引用 `assets/index-<hash>.js` 与 `assets/index-<hash>.css`，未配置 modulepreload。
- `pnpm build:mock` → `frontend/dist-mock/`（31 个哈希资源，多两个自检页 chunk）；`pnpm build:fault` 也写入 `dist-mock`，不触碰 `dist/`。
- 无 SSR、无常驻 Node：Nginx 只托管静态目录。

### 3.2 交付脚本内实际验证的构建事实

| 检查 | 结果 |
| --- | --- |
| 相同输入在独立临时目录重建生产产物 | 入口与全部 assets 逐字节一致 |
| 相同输入重建 mock 产物 | 与 release A 逐字节一致 |
| `build:fault` 输出 | 只写 `dist-mock`，生产 `dist/index.html` 未变；fault 入口与生产入口不同 |
| `check:isolation` | `dist` 无 mock 自检 chunk、夹具地址、mock 归档标记；`dist-mock` 有；入口引用的每个 `/assets/` 文件都存在；`/assets/` 全部为内容哈希文件；路由级 chunk ≥ 6 |
| 秘密扫描 | 产物、HTTP 响应、UI、API/collector 日志均不含虚构秘密 `FAKE_DEPLOYMENT_SECRET_31_NEVER_REAL` |

## 4. 隔离 Nginx 结果（分阶段）

一次性执行：

```bash
cd frontend
DELIVERY_PORT=4273 \
NGINX_BIN=/tmp/nginx-16/nginx-1.28.0/objs/nginx \
NGINX_MIME_TYPES=/tmp/nginx-16/nginx-1.28.0/conf/mime.types \
pnpm test:delivery
```

脚本行为：先 `nginx -t` 校验临时主配置，前台启动独立 Nginx（不 reload 系统服务），`current` 指向临时发布目录；结束后退出进程、删除临时目录并恢复生产构建。临时主配置**直接包含** `deploy/nginx.conf`，只替换 root 与 API 上游端口；另加一个仅 `/api/manage/` 受 Basic 保护的临时 server，用于 401 证据。Playwright 的 Nginx 分支由脚本传入 `E2E_NGINX_BASE`，所以换端口不需要改配置。

### 4.1 阶段一：显式 mock 产物（隔离 Nginx，不启动 Vite）

`E2E_TARGET=nginx` 的 `static-delivery.spec.ts`（桌面 + Pixel 7 视口）**10 passed**：

- `/`、`/index.html`、`/ups/202`、`/manage`、`/manage/ups/202`、`/dynamics/90071992547409934`、`/dynamics/.../comments/root-1`、`/dynamics/id.with.dot`、`/unknown.page` 均 200 + `text/html` + `no-cache`，返回入口 HTML；未知页与含点号 ID 由前端表达。
- 入口 ETag / `If-Modified-Since` 重新验证返回 304 + `no-cache`。
- 入口引用的 JS/CSS 200 + `public, max-age=31536000, immutable` + 正确 MIME；`/default-avatar.svg`、`/images/unavailable/placeholder.svg` 为 `no-cache`。
- `/assets/missing.js`、`/assets/missing.css`、`/assets/no-extension`、`/images/missing.svg`、`/images/unavailable/missing.svg`、`/default-avatar-missing.svg` 均 404 + `no-store`，正文不含 `<div id="app">`。
- 正常产物深链接刷新后可开图预览、返回列表、未知页/不存在动态由前端表达。
- 脚本额外逐个探测 mock 产物 **31 个哈希资源**（含两个自检页 chunk）全部 200 + immutable。

### 4.2 阶段二：mock 产物更新与回退

- 在同一临时源码副本中改入口标题并追加执行标记，真实 `pnpm build:mock` 得到 release B（不是手改 dist）。
- 原子切换后：旧入口 ETag 条件请求返回 **200 新 HTML**（不是旧 304），新入口 `no-cache`；新旧入口引用的 JS/CSS（含旧 `index-04TF_EoI.js`、新 `index-BAwDpWvZ.js`）全部 200 + immutable；浏览器刷新执行 release B 标记。
- 回退到 release A 后：入口条件请求返回旧 HTML、`no-cache`；旧/新 3 个入口引用资源仍可达；六路由逐条等到自身锚点，导航无 `/assets/` 4xx；刷新后标题回到旧入口标题。

### 4.3 阶段三：生产构建 + 实际 API/collector（同一隔离 Nginx）

实际启动 `backend.tests.deployment_fixture` 的 API 与独立 collector，共享本次运行独占的临时 SQLite（生产实现，仅替换上游/OSS I/O）：

| 检查 | 结果 |
| --- | --- |
| 六条正式路由逐条直达 + 刷新 | `/`、`/ups/202`、`/dynamics/91001`、`/dynamics/91001/comments/91002`、`/manage`、`/manage/ups/202` 均 200 + `no-cache`，各自锚点可见，无 UI 秘密 |
| 生产 Adapter 读取 | 只发 GET；业务图片走公开 URL（`https://media.example.invalid/deployment.png`，用例内仅替换该外链传输）；浏览器不请求 B 站域 |
| 拆包资源 | 生产 `frontend/dist` **28 个哈希资源**逐个 200 + immutable（路由 chunk、共享 chunk、全部 CSS，不只入口脚本） |
| API 错误不落 SPA | `/api`、`/api/no-such-route`、`/api/archive/dynamics/99999` 404；`?limit=0` 422；停掉 API 后 `/api/archive/ups` 502；均 `no-store`、JSON/错误正文，非入口 HTML |
| 缺失静态资源 | `/assets/missing.js`、`/assets/no-extension` 404 + `no-store`，非入口 HTML |
| 代理保护 + 401 提示 | 受保护反代的 `/api/manage/ups` 返回 401 + `WWW-Authenticate: Basic` + `no-store`，正文不是入口；页面壳 `/manage` 仍 200，前端显示固定“管理访问需要身份验证”提示与“重新读取”，不出现新增表单 |
| 未知页 | `/unknown.page` 入口 200，前端“页面不存在” |
| 生产更新 | 重新构建生产产物并原子切换：`index-B7KnNIzH.js → index-CRj90T7m.js`，新旧资源可达、刷新执行新标记 |
| 生产回退 | `current` 指回上一版：旧入口 200 旧 HTML（条件请求非新 304）、旧/新资源可达、六路由导航无 4xx、刷新回旧产物 |

受保护 server 只模拟“管理 API 需要 Basic 认证、页面可加载”这一 401 场景；`deploy/nginx-ecs-https.conf` 对 `/manage` 页面本身的保护由 `pnpm test:nginx-parity` 的静态断言覆盖，本票未在目标机执行真实 Basic 登录。

## 5. 交付工具与探测耦合修正

| 文件 | 改动 |
| --- | --- |
| `frontend/scripts/verify-entry-update.mjs` | 从入口 HTML 解析**全部** `/assets/` 引用（src/href，兼容 modulepreload），不再只抓第一个脚本；新增 `assertEveryBuiltAsset` 逐个探测构建产物资源与路由 chunk、拒绝未哈希文件；新增 `rollbackAndVerify` 回退演练（保留新哈希、条件请求、六路由无 4xx、刷新回旧产物） |
| `frontend/scripts/verify-production-delivery.mjs` | 生产阶段扩为六条路由直达/刷新；逐个探测 28 个产物资源；接入受保护反代的 401 与前端提示断言 |
| `frontend/scripts/verify-production-deployment.mjs` | 生产更新后追加回退；断言回退前后归档稳定字段不变、SQLite 文件 inode 不变、collector 启动日志仍为 1 次且进程存活；collector 首次同步等待单独放宽到 60s（生产固定 15s 节拍，原 15s 上限过紧），API 启动等待保持原上限 |
| `frontend/scripts/lib/build-assets.mjs` | 新增共享判定：哈希文件命名、路由 chunk 与最小路由数；`check-isolation` 与交付脚本用同一规则，避免两处放宽/收紧不一致 |
| `frontend/scripts/verify-static-delivery.mjs` | 支持 `DELIVERY_PORT`（4173 被占用时不碰现有实例）；修正 mock 更新两侧装配不一致（B 必须是 `build:mock` 产物）；生成受保护临时 server、输出三阶段分隔；mock 产物也逐个探测资源 |
| `frontend/scripts/check-isolation.mjs` | 入口完整性改为解析 `index.html` 引用并要求文件存在；断言 `/assets/` 全为内容哈希文件、路由 chunk ≥ 6，替换过宽的 `index-*.js` 名字匹配 |
| `frontend/scripts/verify-nginx-parity.mjs` | 新增 `frontend/public/` 命名空间 ↔ `location` 规则的一致性断言，新增未版本化资源目录时不会静默落进 SPA 回退 |
| `frontend/playwright.config.ts` | `E2E_TARGET=nginx` 的 baseURL 可用 `E2E_NGINX_BASE` 覆盖，配合非默认交付端口 |
| `frontend/tests/e2e/static-delivery.spec.ts` | 六路由覆盖补上 `/manage/ups/202` |
| `docs/deployment/static-delivery.md` | 第 3 节补回退步骤与边界；第 4 节补 `DELIVERY_PORT`、占用端口说明、401 探针与全部资源探测；头部状态改为“本机隔离已执行，未在目标机/云执行” |
| `docs/backend/api/archive-api-client.md` | 为迁移前 React 测试路径的过程证据加注：票据 12 已删除该栈，现行单测在 `frontend/tests/unit/*.test.ts` |

`frontend/scripts/` 中已无旧 React 入口、旧 `dist` 路径或 `test:e2e:preview` 之类失效命令的引用。

## 6. 更新与回退演练细节

### 6.1 原子切换

1. 同一文件系统内把 release B 目录 `symlink` 成临时名，再 `rename` 覆盖 `current`（不逐个覆盖正在提供的文件）。
2. 切换前把旧 `assets/` 中不冲突的哈希文件补给新目录；切换后旧页面仍能取到旧脚本/样式/chunk。
3. 入口 `no-cache` + ETag：内容变化时条件请求必须 200 新入口，未变化的资源继续走长期缓存。

### 6.2 回退

1. 先把**新**发布目录 `assets/` 中不冲突的哈希文件补给上一版目录（回退前已打开的页面仍在用新资源）。
2. 原子把 `current` 指回上一版；旧入口条件请求返回旧 HTML，而不是新入口的 304。
3. 旧/新全部入口引用资源可达；六路由导航期间没有 `/assets/` 4xx，且每条路由等到自身锚点；刷新后标题回到旧入口标题“充电动态归档”，正面确认加载的是旧产物而不是加载失败。
4. 新发布目录保留，不删除，便于再次前滚。

### 6.3 只切前端

| 断言 | 结果 |
| --- | --- |
| 归档稳定字段（ID、正文、媒体 ID/URL）回退前后一致 | 通过 |
| SQLite 文件 inode 未变（未被替换/回退） | 通过 |
| collector 启动日志仍为 1 次且进程存活（未重启） | 通过 |
| 回退期间前端仍可经真实 API 读取归档 | 通过 |
| API 不可达时 Nginx 502 + `no-store`，诊断不泄露虚构秘密 | 通过 |

## 7. 旧产物与源码/依赖留存

- 演练发布目录位于系统临时目录，结束时按脚本清理；**产物身份**以同目录 `16-delivery-manifest.json` 留存：候选提交、lockfile sha256、入口与全部 assets 的 sha256、mock 产物清单、Nginx/运行时版本。
- 生产发布时旧目录与源码/依赖信息的保留方式见 [static-delivery.md](../../../docs/deployment/static-delivery.md) 第 3 节和 [local-live-frontend.md](../../../docs/deployment/local-live-frontend.md)（`releases/<时间>-<提交>` 轮转）。
- 本票不归档二进制产物本体，避免把构建输出提交进仓库；需要逐字节复核时按同一提交与 lockfile 重建。

## 8. 未验证与边界

- 未在目标机（阿里云 ECS）、云负载均衡、TLS、公网域名下执行；未做真实 Basic 登录（只看 401 响应与前端提示）。
- 未访问真实 B 站上游或真实 OSS；API 回归使用 `backend/tests/deployment_fixture.py`，图片外链只替换传输。
- 未做持续运行、容量、并发、备份或磁盘增长验证；2 核 2GB 只是评估目标。
- 交付端口用 `4273` 而非示例 `4173`：仅端口不同，配置内容与规则一致；`4173` 上的既有隧道未被操作。
- 后续候选产物变化时须重跑本票受影响的交付项（构建、六路由、资源清单、更新/回退），并更新 manifest 的候选提交；本文件结论只对登记的候选提交有效。
- 真机、视觉签收属票据 14/15；上线就绪汇总属票据 17。本票不把隔离 Nginx 通过写成正式上线或云部署完成。

## 9. 复核命令

```bash
source ~/.nvm/nvm.sh && nvm use
uv sync --locked
cd frontend
pnpm install --frozen-lockfile
pnpm check && pnpm check:dist && pnpm test:nginx-parity
DELIVERY_PORT=4273 \
NGINX_BIN=/tmp/nginx-16/nginx-1.28.0/objs/nginx \
NGINX_MIME_TYPES=/tmp/nginx-16/nginx-1.28.0/conf/mime.types \
pnpm test:delivery
```

本次附带的回归：`pnpm check`（typecheck + 254 单测 + e2e 项目守卫）、`pnpm test:e2e`（173 passed）、`pnpm test:e2e:production`（3 passed）、`pnpm test:e2e:manage`（7 passed）、`pnpm check:dist`、`pnpm test:nginx-parity` 全绿。
