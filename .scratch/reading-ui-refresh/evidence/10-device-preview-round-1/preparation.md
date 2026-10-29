# 票 10 第二轮隔离局域网预览：准备记录

**这是准备记录，不是人工视觉验收，也不是真机结果。** 票据仍是 `ready-for-human`，验收条件未因本轮变绿；没有更新黄金图、没有跑 `visual:baseline`/`visual:capture`/`visual:golden`、没有合入 `main`、没有部署、没有提交、没有建分支。所有数据都是虚构夹具，未访问真实 B 站、飞书或 OSS，未启动 collector/notifier。本轮资料只写入本目录（新目录），旧目录 [10-device-preview](../10-device-preview/) 一字未改。

机器可读版本见同目录 [manifest.json](manifest.json)；HTTP 明细 [smoke-http.json](smoke-http.json)；浏览器明细 [smoke-browser.json](smoke-browser.json)；seed [seed.log](seed.log)；收尾核对 [final-check.txt](final-check.txt)；sourceStatus 原文 [source-status.txt](source-status.txt)；冻结产物逐文件哈希 [artifacts.sha256](artifacts.sha256)；完整产品树清单 [product-tree.txt](product-tree.txt)；候选截图在 [screens/](screens/)。

## 1. 候选与源码状态

| 项 | 值 |
| --- | --- |
| 固定候选（sourceCommit） | `344235a88b418dc07b644aef578487d0693e65d9`（`spec/reading-ui-refresh`，12 头像/管理对齐 + 13 完整会话/入口居中 + 首轮审查整改的组合候选） |
| 门槛产物来源 | `/tmp/reading-ui-refresh-round1-final-merge/build-ready.json`（`status=ready`，`builtAt=2026-10-29T05:09:25.618Z`，`check=pass(351)`、`checkDist=pass`） |
| 准备时 HEAD | `16dc3b64075a504c853c78a1a3a8b9a945d5e54c`（候选之后主线程只改证据措辞的**文档提交**） |
| frontend 树 | `79f45fd947bbe46b7ed8d63f4f4a45dabcb9160e`（`344235a:frontend` == `HEAD:frontend`） |
| backend 树 | `b33aa187c2055a901cd568908679ff448c71f37e`（`344235a:backend` == `HEAD:backend`） |
| `git diff 344235a -- frontend backend` | 无输出（受跟踪产品文件零差异）；`product-tree.txt` 两段 `ls-tree -r` 逐行相同 |
| 工作区（sourceStatus） | **不是整树干净**：准备时 `?? .scratch/reading-ui-refresh/evidence/10-device-preview-round-1/`（本目录）与 `?? frontend/playwright.tmp-final.config.ts`（merger 跑门槛用的未跟踪临时 e2e 配置，不参与构建、不在冻结 dist 内、不在 `344235a` 产品树里）。13:19 复核时该临时配置已被 merger 清理，当前只剩本准备目录未跟踪；`source-status.txt` 同时保留准备时快照与这条后续观察 |
| 工具版本 | Node `v24.21.0`（nvm）、pnpm `10.34.6`、uv `0.12.23`、Playwright `1.58.2`（自带 Chromium） |

**为什么 HEAD 可以不是 344235a：** 本轮之后主线程还会提交证据/状态文档，产品代码树不变。因此重启校验以**冻结产物哈希 + `frontend`/`backend` 产品树**为准（见 §11），manifest 仍固定 `sourceCommit=344235a`。可以确认的是：产品树没变，冻结产物来自 `344235a` 的 `check:dist`，本轮**没有自行构建**。

`frontend/dist`、`frontend/dist-mock` 是 merger 在 `344235a` 上跑 `check:dist` 的产物（`index.html` mtime 13:09:05 / 13:09:16），本轮只复制、不重建。

## 2. 冻结产物（`/tmp` 副本）

复制发生在 `build-ready.json` 出现 `status=ready` 且产品树与候选一致之后。此后即使仓库再构建，也不影响这两套验收副本：两个 `vite preview` 都用**绝对 `--outDir`** 指向副本。

| 环境 | 副本 | 来源 | `index.html` SHA-256 | 文件数 |
| --- | --- | --- | --- | --- |
| A | `/tmp/bili-ticket10-round1-zogc/dist-a` | `frontend/dist` | `1a558c6ca9eb0cece45161b3d4773875eb4b92b75ca42348af95bd64f52c9e54` | 34 |
| B | `/tmp/bili-ticket10-round1-zogc/dist-b` | `frontend/dist-mock` | `b336d12eb9df969189b4dcee6540ea2494f5df4ee5f1afeede1011bbdad7bee8` | 39 |
| 图片夹具 | `/tmp/bili-ticket10-round1-zogc/server/imageServer.mjs` | `frontend/server/imageServer.mjs` | `eb12c161c93de5d5a0196ac2a5411f5831a0314d2582f978d92c8b685af99eba` | 1 |

- 逐文件哈希清单：`artifacts.sha256`（74 行，SHA-256 `460514e5…`），启动脚本用 `sha256sum -c` 校验，不符直接拒绝启动。
- 完整性：`diff -r frontend/dist /tmp/…/dist-a` 与 `diff -r frontend/dist-mock /tmp/…/dist-b` 均无差异。
- 两个 `index.html` 指纹与 `build-ready.json` 的记录值逐字节相同。

## 3. 运行目录（`/tmp`，可随时丢弃）

```
/tmp/bili-ticket10-round1-zogc/      # mktemp -d /tmp/bili-ticket10-round1-XXXX
├── dist-a/            # 环境 A 冻结产物（正式装配）
├── dist-b/            # 环境 B 冻结产物（mock 自检装配）
├── server/imageServer.mjs
├── artifacts.sha256   # 74 个冻结文件的逐文件哈希
├── monitor.sqlite     # 独立新隔离库（483328 bytes，26 张表；通知状态 off）
├── logs/              # api/images/web-a/web-b/seed/smoke/browser-smoke/final-check
└── run/               # <name>.pid 与 <name>.pgid
```

旧运行目录 `/tmp/bili-ticket10-iOV2nX`（含旧 `monitor.sqlite` 1552384 bytes）**原样保留、未覆盖**。另有一个上一轮尝试遗留的 `/tmp/bili-ticket10-round1-jU4G`（12:48 创建，只有 dist 副本、`logs/` 与 `run/` 为空，未启动；其 `index.html` 哈希 `5878619…`/`eed8e8c…` 与本轮候选不同）——未使用、未删除。

## 4. 四个进程（当前正在运行）

| 名称 | 用途 | PID / PGID / SID | 进程组成员 | 监听 | 关键环境 |
| --- | --- | --- | --- | --- | --- |
| `api` | live_app（固定虚构上游）写隔离库 | 707470 / 707470 / 707470 | 707470(uv), 707475(uvicorn) | `127.0.0.1:4180` | `BILI_DATABASE_PATH=/tmp/…/monitor.sqlite` |
| `images` | 受控图片夹具 | 707509 / 707509 / 707509 | 707509 | `127.0.0.1:4339` | `IMAGE_SERVER_PORT=4339` |
| `web-a` | 环境 A 预览 | 707526 / 707526 / 707526 | 707526(pnpm), 707560(vite), 707573 | `0.0.0.0:4318` | `API_SERVER=http://127.0.0.1:4180`、`IMAGE_SERVER_PORT=4339` |
| `web-b` | 环境 B 预览 | 707591 / 707591 / 707591 | 707591(pnpm), 707611(vite), 707624 | `0.0.0.0:4337` | `API_SERVER=http://127.0.0.1:4180`、`IMAGE_SERVER_PORT=4339` |

- 每个进程 `setsid` 成新会话/进程组组长（`sid == pgid == pid`），PPID 重挂到 `systemd --user`（pid 2005）——不随启动它的一次性 shell 退出回收，停机按进程组精确回收。
- 四个进程的 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`FTP_PROXY`（大小写）全部为空，只设 `NO_PROXY=no_proxy=127.0.0.1,localhost,::1`——只对这批新进程清空，未改主机环境。
- 只有 2 个 python 相关进程（`uv` 与其 `uvicorn` 子进程），**没有 collector、没有 notifier**（`ps` 里唯一的 notifier 命中是 PyCharm 的 `fsnotifier`，与本项目无关）。
- 既有 `127.0.0.1:8000` 与 `192.168.8.20:4273` 启动前后监听不变，本轮未请求、未重启、未改动。

## 5. 访问地址（同一局域网，手机与桌面都可开）

环境 A（正式候选 + 真实 API 路径，虚构上游）：

- 列表：<http://192.168.8.20:4318/>
- 单 UP：<http://192.168.8.20:4318/ups/808>、<http://192.168.8.20:4318/ups/202>
- 动态详情：<http://192.168.8.20:4318/dynamics/800300>
- 会话（11 条整段，入口 960013）：<http://192.168.8.20:4318/dynamics/800300/comments/860001/replies/960013/conversation>
- 管理：<http://192.168.8.20:4318/manage>、<http://192.168.8.20:4318/manage/ups/808>、<http://192.168.8.20:4318/manage/ups/202>

环境 B（mock 自检装配 + 受控图片）：

- 夹具页：<http://192.168.8.20:4337/__preview-fixtures>
- 首页：<http://192.168.8.20:4337/>

回环直连（只在本机可用）：API <http://127.0.0.1:4180/api/manage/ups>，图片 <http://127.0.0.1:4339/__requests>。

## 6. `/api` 确实指向 4180 的取证

`frontend/vite.config.ts:5-14` 的默认值是 `API_SERVER ?? http://127.0.0.1:8000`、`IMAGE_SERVER_PORT ?? 4319`，preview 复用同一 proxy，所以必须显式赋值。四重独立证据：

1. 两个 vite 进程环境：`API_SERVER=http://127.0.0.1:4180`、`IMAGE_SERVER_PORT=4339`（A 也显式给图片端口）。
2. `4318/api/manage/ups` 与 `4337/api/manage/ups` 的响应与 `127.0.0.1:4180` 直连**逐字节相同**。
3. `4318` 与 `4337` 的 `/api/test/source-requests` 都是 200——该路由只在 `backend/tests/live_app.py` 注册，若代理落到 8000 的生产 API 会 404。
4. 4180 返回的三个 UP（808/202/707）来自本轮新建的 `/tmp/…/monitor.sqlite`（26 张表），不是旧库、不是 8000。

因此 A/B 两个环境的 `/api` 走的都是本轮 live_app + 新隔离库。环境 B 的 `/images/*` 走 4339（`thumb` 返回 200 `image/svg+xml`，未知路径由夹具返回 404）。

## 7. 样例数据（[seed 脚本](seed-fixtures.sh)，日志 [seed.log](seed.log)）

| 内容 | 值 |
| --- | --- |
| UP | `808 虚构楼阁`、`202 虚构晨光`、`707 虚构晚风`（均 `specified` + `recent_n=10` + 启用，仅本隔离库） |
| `800300` | 45 条根评论（分页 20/20/5）+ 根 `860001` 的 25 条回复（首批 3 条时间序快照 → 续批 10/10/2）+ 会话入口 `960013` 的整段 11 条（`960002…960020`） |
| `9007199254740993123` | 12 条根评论（用不同条数证明卡片之间不共用状态） |
| `900707` | 45 条根评论 + 第二页楼 `860030` 的 25 条回复 |
| 初始化归档 | 三个 UP 均 `processed=1 succeeded=1 failed=0` |
| 检查/发现面板 | 用 `/api/test/collect` 各驱动一次（`check` 1 条、`discover` 1 条记录），仍是 `MockTransport`，无真实请求 |
| 通知 | `GET /api/manage/notifications` → `state=off`；未启动通知进程 |
| 虚构上游计数 | `total=37 reply=23 count=1`（本进程累计；读取归档不触发采集） |

## 8. 准备冒烟（不是验收通过）

`smoke-check.sh` + `browser-smoke.mjs` 只回答"环境搭对了没有、目标区域在不在"：

- **HTTP 层 44/44 PASS**（[smoke-http.json](smoke-http.json)，`2026-10-29T13:14:06+08:00`）：A/B 首页与深链（含会话深链、`/manage`、`/manage/ups/202`、`/__preview-fixtures`）全部 200 + `id="app"`；A/B `assets` 200；A/B `/api` 代理取证如上；B 图片 200 + 未知路径 404；管理读接口可读；45 评/25 回复/12 评/`media_sources` 全空；**会话整段契约**：入口 960013 一次读取 `count=11`、`items=11`、**无 `page` 键**、`next_cursor=null`、首条 960002/末条 960020，仅 `limit` 与非法页码仍 422，旧 `?page=2&limit=10` 仅返回 1 条且与整段 `items[10:]` 相同。
- **浏览器层 42/42 PASS**（[smoke-browser.json](smoke-browser.json)，headless Chromium，`2026-10-29T05:14:51Z`）：8 个页面全部 200、`#app` 有渲染节点、控制台/页面错误 0、意外资源失败 0；每页再探 `/api/test/source-requests` 均 200（代理指向 4180）。
  - 390×844 会话（A）：只发 **1 次** `/api/.../conversation` 且 **query 为空**；`对话内容` **11 条**；`共 11 条` 1 处；`回复分页`/`下一页` **0 个**；`刚才查看` **1 处**；唯一 `data-conversation-entry=true` 是 `reply:860001:960013`；入口垂直中心偏差 **0.5px**、`scrollY=141`（真的居中而不是回顶）。
  - 环境 A 无归档图片：`/images` 请求 **0 次**；`img` 全部回落 `/default-avatar.svg`（`naturalWidth>0`）；失败请求只有 `https://example.invalid/*`（虚构头像主机，预期不可达），无其它意外失败。
  - 环境 B：首页 `/images/thumb/*.svg` 4 张均 200 且 `naturalWidth>0`；B 是 mock 自检装配，**不能把 B 的阅读/图片结论记成 A 的真实 API 结论**。

这些绿色只说明环境可用与目标区域存在，**不能写成"视觉通过""真机通过"**，也不替代主线程的人工台账；本轮未重跑任何大套件（`pnpm check`/`check:dist` 是 merger 的门槛，见 §1）。

## 9. 本轮待签收候选截图（不是签收，未跑黄金图）

目录 [screens/](screens/)，索引 [screens/index.json](screens/index.json)，全部是 A（正式 dist）真实页面、**视口截图**（非整页）、`animations=disabled`、`caret=hide`：

| 文件 | 宽度 | 页面 | SHA-256（前 12） |
| --- | --- | --- | --- |
| `344235a-1280-list.png` | 1280 | 列表 `/` | `24d6b27d5611` |
| `344235a-1280-manage.png` | 1280 | 管理列表 `/manage` | `729e741ed3c1` |
| `344235a-1280-manage-202.png` | 1280 | 管理 UP 202 `/manage/ups/202` | `cfe5053af5f4` |
| `344235a-390-list.png` | 390 | 列表 `/` | `6b93a1c2740d` |
| `344235a-390-manage.png` | 390 | 管理列表 `/manage` | `9a8ebc534a2a` |
| `344235a-390-manage-202.png` | 390 | 管理 UP 202 `/manage/ups/202` | `f2224b942bcd` |
| `344235a-390-conversation-960013.png` | 390 | 会话入口 960013 | `e821f3a4143a` |

- 文件名带候选短 SHA 与宽度；`index.json` 记录候选、URL、viewport、字节数与完整 SHA-256，并注明 `round-1-candidate-screens-not-accepted`。
- 会话截图的拍摄前置断言：11 条、唯一"刚才查看"、入口居中偏差 ≤2px（实测 0.5px）——不满足就拒绝出图。
- `screens/index.json` 的会话条目已拆分 `documentNavigations` / `apiReads`：旧 `conversationRequests=["",""]` 是「1 次整页文档导航 + 1 次只读 API 读取」混记，**不是两次访问**；截图阶段没有 reload、重新导航或额外探活，smoke 只统计 `/api/` 的 fetch 所以是 1 次（13:21 用一次性只读探针复核：document 1 + fetch 1）。`capture-screens.mjs` 已按 `/api/` 前缀区分，未重跑截图。
- **明确未运行**：`pnpm visual:baseline`、`tests/e2e-visual/capture.spec.ts`、`pnpm visual:golden`、任何黄金图比较/更新。截图只是待用户复验的候选材料。

## 10. 旧预览为什么没了（如实登记）

- 本轮开始前 `4318/4337/4180/4339` 均无监听；旧 pidfile 目录为空，旧 4 个 PID（`626555/626574/626587/626634`）都不存在。
- 旧 `/tmp/bili-ticket10-iOV2nX/logs/api.log` 尾部是 `INFO: Waiting for application shutdown` → `Application shutdown complete` → `Finished server process [626560]`，时间约 **12:48:53**，随后 pidfile 被移除——与 `stop-previews.sh` 的 TERM 回收表现一致。
- 但当时没有保留停止输出，触发者与原因**未记录 ⇒ 按"原因未确认"登记**，不推断为产品故障，也不宣称"正常关闭"。
- 旧 runtime 与 DB **保留**（`monitor.sqlite` 1552384 bytes，mtime 11:58），旧证据目录未改。12:48 还有一个上一轮尝试遗留的 `/tmp/bili-ticket10-round1-jU4G`（见 §3），未使用、未删除。

## 11. 停止与重启

```bash
# 停止：只按本轮 pidfile 精确 TERM 进程组；不扫端口、不按端口杀、不删 DB
RUNTIME=/tmp/bili-ticket10-round1-zogc bash \
  .scratch/reading-ui-refresh/evidence/10-device-preview-round-1/stop-previews.sh

# 重启（沿用同一 DB 与样例）；启动前会做端口预检、冻结产物逐文件校验与产品树校验
RUNTIME=/tmp/bili-ticket10-round1-zogc bash \
  .scratch/reading-ui-refresh/evidence/10-device-preview-round-1/start-previews.sh

# 丢弃全部运行产物（确认不再需要预览后）
# rm -rf /tmp/bili-ticket10-round1-zogc
```

- **重启校验契约**：以「`artifacts.sha256` 逐文件哈希 + `frontend`/`backend` 产品树 == `344235a` 的树」为准，**不要求 HEAD 等于 `344235a`**（之后主线程还会提交证据/状态文档，产品树不变）。未跟踪文件只记录不拒绝（cherry-pick 说明：`frontend/playwright.tmp-final.config.ts` 是 merger 的临时配置，不在构建里）。
- `stop-previews.sh` 逐个校验 pidfile 里的 PID 仍存活、命令行匹配（`live_app:create_app` / `imageServer.mjs` / `dist-a` / `dist-b`）、且 `pgid == pid`；不匹配就拒绝并跳过（不会误杀复用 PID 的其它服务）；10 秒未退出只报告，不做 `kill -9`；从不按端口匹配，因此不会误杀 8000/4273。
- 重启前必须先 stop（4 个端口占用时启动脚本会直接 REFUSE，不复用、不接管）。

## 12. 限制（写进人工记录时按此记）

1. **环境 A 没有归档图片**：live_app 上游不含图片、媒体交付地址只放行 https 公网地址，http 局域网预览拿不到成功归档图片；图片与异常态只能看环境 B。
2. **环境 B 是 mock 自检装配**：构建同候选、数据不走真实 API 路径。B 的阅读结论不能记成 A 的 API 结论。
3. **未起 collector / notifier**：通知投递、真实客户端、OSS 上传均未验证；`off` 只是默认值。
4. **无 TLS**：手机走 `http://`（非安全上下文，App 有随机 ID 兜底）；真机 UA、视口、方向、输入法缩放与键盘遮挡仍需用户采集。
5. **外部场景未执行**：真实 B 站、飞书客户端、OSS、生产服务一律未连；既有 8000/4273 未触碰。
6. **工作树不是整树干净**：本目录未提交 + merger 的未跟踪临时 e2e 配置；受跟踪的 `frontend`/`backend` 与 `344235a` 相同，冻结产物哈希固定。
7. **截图不是签收**：未跑/未更新黄金图；桌面自动化与本准备冒烟都不等于人工签收。
8. Seed 不是幂等的：重复 `POST /api/manage/ups` 会 409，重复 `initial` 归档会追加；需要干净数据请另建 `mktemp` 目录并重跑 seed。

## 13. 收尾核对（本记录完成时的实际状态）

- `4318`（0.0.0.0）、`4337`（0.0.0.0）、`4180`（127.0.0.1）、`4339`（127.0.0.1）**四个服务仍在监听**；明细 [final-check.txt](final-check.txt)。
- LAN 两个入口 curl 成功：`http://192.168.8.20:4318/`、`http://192.168.8.20:4337/`、`http://192.168.8.20:4318/manage`、`http://192.168.8.20:4337/__preview-fixtures` 均 200 `text/html`。
- 既有 `127.0.0.1:8000`、`192.168.8.20:4273` 监听未变。
- **准备成功不代表人工/真机通过**：真机与桌面人工检查、触屏横滑、iOS Safari 输入、原生返回、排序与会话定位、管理操作仍需用户完成并记入人工台账。
- 若 merger 或 Spec 复核发现**新产品问题**，须由主线程另行通知重建预览；不能静默把本轮 `sourceCommit` 换掉或把旧产物说成新候选。视觉签收与黄金图更新需另行授权。
