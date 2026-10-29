# 票 10 隔离局域网预览：准备记录

**这是准备记录，不是人工视觉验收，也不是真机结果。** 票据仍是 `ready-for-human`，验收条件一条未勾选；没有更新黄金图、没有合入 `main`、没有部署、没有提交、没有建分支。所有数据都是虚构夹具，未访问真实 B 站、飞书或 OSS。

机器可读版本见同目录 [manifest.json](manifest.json)，HTTP 冒烟明细见 [smoke-http.json](smoke-http.json)，浏览器冒烟明细见 [smoke-browser.json](smoke-browser.json)。

## 候选与源码状态

| 项目 | 值 |
| --- | --- |
| 分支 / HEAD | `spec/reading-ui-refresh` / `7c2410a447b84099c6257c8e8b2ebdb7e5479aea` |
| 固定实现候选 | `88b692facc0c0e39ea527fbe87895c4544be5291` |
| `git diff --exit-code 88b692f -- frontend backend` | 退出码 0，零差异（准备结束时复核一次，仍为 0） |
| 工作区改动 | 仅 `.scratch/` 文档：主线程的人工记录两份（本准备未编辑）+ 本目录；另有无害的 `__pycache__`（被忽略） |
| 工具版本 | Node `v24.21.0`（nvm）、pnpm `10.34.6` |

`frontend/dist`、`frontend/dist-mock` 是主线程已跑通的 `pnpm check:dist` 产物（mtime 2026-10-29 11:17），本轮**未重建**。

## 冻结产物（本次新增做法）

为避免后续构建影响正在进行的验收，两套产物已复制到本轮运行目录，`vite preview` 用**绝对 `--outDir`** 指向副本：

| 环境 | 副本 | 来源 | `index.html` SHA-256 | 文件数 |
| --- | --- | --- | --- | --- |
| A | `/tmp/bili-ticket10-iOV2nX/dist-a` | `frontend/dist` | `e578cdca2abb7ecec9e928f16b90e1590821017fed0e4119cb320ff1245ccc99` | 34 |
| B | `/tmp/bili-ticket10-iOV2nX/dist-b` | `frontend/dist-mock` | `8e3676cdbd93fdfef385cae51602a065458372d3fa03584e3b3a158094505f16` | 39 |

图片夹具 `frontend/server/imageServer.mjs`（SHA-256 `eb12c161c93de5d5a0196ac2a5411f5831a0314d2582f978d92c8b685af99eba`）也复制到 `/tmp/.../server/` 运行。仓库内 `frontend/`、`backend/` 保持只读，没有修改任何源码或产物。

唯一的仓库内写入是 Python 运行时字节码缓存 `backend/tests/__pycache__/`（`.gitignore:11` 忽略，`git status` 不可见），属于启动 live_app 的副产物，不是源码改动。

启动脚本会先校验这两个 `index.html` 指纹，指纹不符直接拒绝启动——即"产物被重建/复制不完整"不会被静默当成同一候选。

## 运行目录（`/tmp`，可随时丢弃）

```
/tmp/bili-ticket10-iOV2nX/
├── dist-a/            # 环境 A 冻结产物（正式装配）
├── dist-b/            # 环境 B 冻结产物（mock 自检装配）
├── server/imageServer.mjs
├── monitor.sqlite     # 隔离库（636 KB，26 张表；通知状态 off）
├── logs/              # api/images/web-a/web-b/seed/smoke 日志
└── run/               # api/images/web-a/web-b 的 pidfile
```

## 四个进程（当前正在运行）

| 名称 | 用途 | PID / PGID | 监听 | 命令行要点 |
| --- | --- | --- | --- | --- |
| `api` | live_app（固定虚构上游）写隔离库 | 626555 / 626555（组内 python 626560） | `127.0.0.1:4180` | `uv run --no-sync python -m uvicorn backend.tests.live_app:create_app --factory --host 127.0.0.1 --port 4180` |
| `images` | 受控图片夹具 | 626574 / 626574 | `127.0.0.1:4339` | `node /tmp/.../server/imageServer.mjs`（脚本内硬编码只 bind 回环） |
| `web-a` | 环境 A 预览 | 626587 / 626587（组内 vite 626604 监听） | `0.0.0.0:4318` | `pnpm --dir frontend exec vite preview --outDir /tmp/.../dist-a --host 0.0.0.0 --port 4318 --strictPort` |
| `web-b` | 环境 B 预览 | 626634 / 626634（组内 vite 626651 监听） | `0.0.0.0:4337` | 同上，`--outDir /tmp/.../dist-b --port 4337` |

一致性证据：

- 每个进程都是 `setsid` 新会话/进程组组长（`pgid == pid`），停机按进程组精确回收。
- 四个进程的 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`（大小写）均为空，只设 `NO_PROXY=127.0.0.1,localhost,::1`——代理变量只对这批新进程清空，未改动主机环境。
- 只有 2 个 python 进程（`uv` 与其 `python` 子进程），**没有 collector、没有 notifier**。
- 既有 `127.0.0.1:8000` 与 `192.168.8.20:4273` 启动前后监听不变，本轮未请求、未重启、未改动。

## 访问地址（同一局域网，手机与桌面都可开）

环境 A（生产候选 + 真实 API 路径）：

- 列表：<http://192.168.8.20:4318/>
- 单 UP：<http://192.168.8.20:4318/ups/808>
- 动态详情：<http://192.168.8.20:4318/dynamics/800300>
- 会话（11 条）：<http://192.168.8.20:4318/dynamics/800300/comments/860001/replies/960013/conversation>
- 管理：<http://192.168.8.20:4318/manage>、<http://192.168.8.20:4318/manage/ups/808>

环境 B（mock 自检装配 + 受控图片）：

- 夹具页：<http://192.168.8.20:4337/__preview-fixtures>
- 首页：<http://192.168.8.20:4337/>

回环直连（只在本机可用）：API <http://127.0.0.1:4180/api/manage/ups>，图片 <http://127.0.0.1:4339/__requests>。

## `/api` 代理确实指向 4180 的取证

`frontend/vite.config.ts:5-14` 的默认值是 `API_SERVER ?? http://127.0.0.1:8000`、`IMAGE_SERVER_PORT ?? 4319`，preview 复用同一 proxy，所以必须显式赋值。三个独立证据：

1. 两个 vite 进程环境：`API_SERVER=http://127.0.0.1:4180`、`IMAGE_SERVER_PORT=4339`（A 也显式给了图片端口，避免 `/images` 落到别的服务）。
2. `4318/api/manage/ups` 与 `4337/api/manage/ups` 的响应与 `127.0.0.1:4180` 直连**逐字节相同**。
3. `4318/api/test/source-requests`、`4337/api/test/source-requests` 都是 200——该路由只在 `backend/tests/live_app.py` 注册，若代理落到 8000 的生产 API 会 404。

因此两个环境的 `/api` 走的都是本轮 live_app + `/tmp/.../monitor.sqlite`，不是 8000，也不是任何其它服务。环境 B 的 `/images/*` 同样走 4339（`thumb` 返回 200 `image/svg+xml`，未知路径由夹具返回 404）。

## 样例数据（seed 脚本 [seed-fixtures.sh](seed-fixtures.sh)，日志 [seed.log](seed.log)）

| 内容 | 值 |
| --- | --- |
| UP | `808 虚构楼阁`、`202 虚构晨光`、`707 虚构晚风`（均为 `specified` + `recent_n=10` + 启用，仅本隔离库） |
| `800300` | 45 条根评论（分页 20/20/5）+ 根 `860001` 的 25 条回复（首批 3 条时间序快照 → 续批 10/10/2）+ 会话入口 `960013` 共 11 条 |
| `9007199254740993123` | 12 条根评论（用不同条数证明卡片之间不共用状态） |
| `900707` | 45 条根评论 + 第二页楼 `860030` 的 25 条回复 |
| 初始化归档 | 三个 UP 均 `processed=1 succeeded=1 failed=0` |
| 检查/发现面板 | 用 `/api/test/collect` 各驱动一次（`check` 1 条、`discover` 1 条记录），仍是 `MockTransport`，无真实请求 |
| 通知 | `GET /api/manage/notifications` → `{"state":"off","pending":0}` |
| 虚构上游计数 | `total=37 reply=23 count=1`（本进程累计，读取归档不触发采集） |

## 准备冒烟（不是验收通过）

`smoke-check.sh` + `browser-smoke.mjs` 只回答"环境搭对了没有"：

- HTTP 层：A/B 首页与深链（`/dynamics/800300`、会话深链、`/manage`、`/manage/ups/808`、`/__preview-fixtures`）全部 200 + `id="app"`；A/B `assets` 200；存档图片 URL 与 `__requests` 就位；管理读接口可读。全部 PASS（明细 [smoke-http.json](smoke-http.json)）。
- 浏览器层（headless Chromium，1280×900）：7 个页面全部 200、`#app` 有渲染节点、无 page error、无预期外资源失败；A 的三次失败请求全是 `https://example.invalid/*`（虚构主机，预期不可解析）；B 首页 `/images/thumb/*.svg` 4 张均 200（明细 [smoke-browser.json](smoke-browser.json)）。

这些绿色只说明环境可用，**不能写成"视觉通过""真机通过"**，也不替代主线程的人工台账。未重跑任何大套件。

## 限制（写进人工记录时按此记）

1. **环境 A 没有归档图片**：live_app 上游不含图片，媒体交付地址只放行 https 公网地址（`backend/bili_monitor/media.py:35-42`、`:128-129`），http 局域网预览拿不到成功图片。图片与异常态只能看环境 B。
2. **环境 B 是 mock 自检装配**：构建同候选、数据不走真实 API 路径。B 的阅读结论不能记成 A 的 API 结论。
3. **未起 collector / notifier**：通知投递、真实客户端、OSS 上传均未验证；`off` 状态只是默认值。
4. **无 TLS**：手机走 `http://`（非安全上下文，App 有随机 ID 兜底）；真机 UA、视口、方向、输入法缩放与键盘遮挡仍需用户采集。
5. **外部场景未执行**：真实 B 站、飞书客户端、OSS、生产服务一律未连。
6. 未重拍/未更新黄金图；桌面自动化与本准备冒烟都不等于人工签收。
7. Seed 不是幂等的：重复 `POST /api/manage/ups` 会 409，重复 `initial` 归档会追加。需要干净数据请另建 `mktemp` 目录并重跑 seed。

## 停止与重启

```bash
# 停止：只按本轮 pidfile 精确 TERM 进程组；不扫端口、不按端口杀、不删 DB
RUNTIME=/tmp/bili-ticket10-iOV2nX bash \
  .scratch/reading-ui-refresh/evidence/10-device-preview/stop-previews.sh

# 重启（沿用同一 DB 与样例）
RUNTIME=/tmp/bili-ticket10-iOV2nX bash \
  .scratch/reading-ui-refresh/evidence/10-device-preview/start-previews.sh

# 丢弃全部运行产物（确认不再需要预览后）
# rm -rf /tmp/bili-ticket10-iOV2nX
```

`stop-previews.sh` 会逐个校验 pidfile 里的 PID 仍存活、命令行匹配（`live_app:create_app` / `imageServer.mjs` / `dist-a` / `dist-b`）、且 `pgid == pid`，不匹配就拒绝并跳过；10 秒未退出只报告，不做 `kill -9`。它从不按端口匹配，因此不会误杀 8000/4273。

## 待主线程/用户完成的部分

- 真机与桌面人工检查（四宽度、触屏横滑、iOS Safari 输入、原生返回、排序与会话定位、管理操作），结果记在人工记录里。
- 视觉签收与黄金图更新需另行授权，本轮明确未做。
- 失败项回对应功能票整改后再验。
