# #34：隔离服务准备与人工单次验证

最新进展：2026-10-21 另行授权的一次真实资料查询被上游 HTTP 412 拒绝，见[独立实测记录](real-profile-check-2026-10-21.md)。该次验证只恢复 API；随后用户明确要求“都启动起来”，已恢复前端。两 unit 均为 `active`，本机 `18444/docs`、`18445/manage`、`18445/docs` 与代理管理 GET 均返回 `200`，仅监听 `127.0.0.1`。本次启服务只做本地只读检查，不重试 B站、不启动 collector、不访问 OSS；之前的上游 HTTP 412 未因此解决。

之后用户另行授权的一次新诊断查询仍为 412，分类为 HTML；真实新增 UP **仍未修复**。见[新消息诊断实测](real-profile-message-check-2026-10-21.md)及[协议调查](profile-412-investigation.md)。不要将下方人工步骤当作继续重试或已完成初始化的证据。

## 服务准备时快照（2026-10-19，不是当前实采结论）

- 准备时间：2026-10-19，时区 `+08:00`；代码基线 `057921b`，工作区包含原有 #32/#33 未提交材料。
- 用户当前授权仅为准备服务、提供流程，由用户自行执行真实验证。尚未登记 UID、核验动态归属或调用初始化。
- 生产入口：`backend.bili_monitor.app:app`，单 worker，仅监听 `127.0.0.1:18444`。没有使用预览入口、测试 fixture、MockTransport 或 mockReader。
- API 启动只执行本地迁移、创建客户端，不启动 collector。没有运行 `collector --once`，也不安排长期监控。
- 后端不托管前端。后续按用户要求，从当前正常业务源码重新构建到仓库外 `web-dist`，未复用来源不明的既有 `dist`。页面入口：<http://127.0.0.1:18445/manage>；同源 `/api`、`/docs`、`/openapi.json` 代理到隔离 API `18444`。它是本轮本机临时前端服务，不宣称为长期生产静态服务器。
- 前端 unit 为 `bili-charge-live-34-web.service`；启动脚本在仓库外 `run-web.sh`，使用 nvm Node `24.21.0` 和现有 Vite `7.3.1`。已执行 `pnpm exec tsc --noEmit` 和全新 Vite 生产构建，没有安装依赖或改业务代码。前端首页、管理页、代理 API、文档与 OpenAPI 的本地 HTTP 检查均为 `200`。
- 同源 API 文档：<http://127.0.0.1:18445/docs>。Swagger 页面可能需要浏览器能加载外部文档 UI 静态资源。
- SQLite：`/home/kevin/.local/state/bili-charge-dynamics/live-34/archive.sqlite3`，准备时权限 `600`；运行目录权限 `700`，数据库不在仓库内。
- 仓库外启动脚本：`/home/kevin/.local/state/bili-charge-dynamics/live-34/run-api.sh`。它显式移除全部 OSS 配置，且仅启动 API。当前版本没有 B站 Cookie 配置入口，来源请求使用现有公开 reader；不保证指定内容可读，不绕过权限。
- 服务使用独立 transient user unit `bili-charge-live-34.service`，`Restart=no`、`TimeoutStopSec=5`，不启用开机自启。
- 原 `192.168.8.20:18443` 验收站未访问、未停止、未修改，未复用其数据库。

脱敏准备快照见 [`preparation.json`](preparation.json)。本地检查结果：`GET /docs` 为 `200`；`GET /openapi.json` 可读；管理 UP、归档 UP 均为空；归档动态为 `{"items":[],"next_cursor":null}`。SQLite 的 15 张业务表均为 0 行。这里只证明隔离服务启动与本地空库读取正常。

| 验证项 | 当前状态 |
| --- | --- |
| 目标归属、真实正文、根评论、回复、归档内容一致性 | 未执行、未验证 |
| 图片下载、真实 OSS 上传、公开 URL 读取 | 未执行、未验证；本轮不配 OSS |
| 持续稳定、实际规模调度、资源验收、自然编辑行为 | 未执行、未验证，不属于本轮范围 |

## 执行前确认与边界

1. 只使用本次已授权的一个 UID 和一个动态 ID；下方从终端输入，不把真实响应或身份材料提交 Git。
2. **创建 UP 和添加指定动态就会访问 B站，不只是初始化才访问。** 准备服务没有执行这些步骤；以下写操作由用户自行决定执行。
3. 预期请求类别：新增 UP 的公开资料读取、指定动态的归属核验、初始化时的正文/详情与根评论/回复分页。现有根评论、回复来源分页无硬页数上限，不能预报固定总请求数或总时长。transport 不自动重试失败请求，但正文失败后仍可能读取 detail metadata，分页也可能复读空尾页确认完整性；不能将一次初始化等同一次上游请求。
4. 不配 OSS 时 uploader 为 `None`，媒体同步直接返回，不发图片下载或 OSS 请求。若初始化识别出图片，预期保留待归档；源数据未读取成功时，图片是否存在也仍未验证。
5. 每步只执行一次，确认成功再做下一步。出现拒绝、风控、权限不足、超时、失败或归属不符时先停止后续人工操作，保存本地结果；不循环重试、不扩大目标、不绕过权限。**当前初始化不是遇首个失败即全停**：正文失败仍会继续评论等阶段，单根回复失败仍可继续其他根。如需立即终止整轮，应停止独立服务，不能只等待某个失败状态自行中止。
6. 初始化同步等待。关闭浏览器、断开 curl 或设置客户端超时都**不能保证中止服务端处理**。需要最终中止时停止下面的独立服务；已经发出的请求不可撤回，数据库可能保留部分进度。

### 服务管理（不会启动 collector）

在运行服务的主机上查看状态：

```bash
systemctl --user is-active bili-charge-live-34.service
```

**只有需要停止时**才运行：

```bash
systemctl --user stop bili-charge-live-34.service
```

停止时最多等待约 5 秒后可能强制结束进程。停止不等于撤销已完成的写入，不应把部分结果记成完整成功。

如需恢复 API，先确认服务已停止，再运行：

```bash
systemctl --user start bili-charge-live-34.service
```

transient unit 可能在停止后或主机重启后被回收；若提示 unit 不存在，先确认端口没有其他服务，再重新创建同一个独立 unit（不要另起前台进程）：

```bash
systemd-run --user --unit=bili-charge-live-34 \
  --description='Bili #34 isolated local API; no collector or OSS' \
  --property=Type=exec \
  --property=WorkingDirectory=/home/kevin/Projects/PI/bili_charge_dynamics \
  --property=UMask=0077 --property=Restart=no --property=TimeoutStopSec=5 \
  /home/kevin/.local/state/bili-charge-dynamics/live-34/run-api.sh
```

如果从另一台电脑操作，不把监听地址改成 `0.0.0.0`，使用 SSH 隧道：

```bash
ssh -N -L 18444:127.0.0.1:18444 'kevin@运行此服务的主机地址'
```

## 页面操作流程（首选）

用户已确认需要页面操作；下方命令行仅保留为备用，不作为必须步骤。

1. 打开 <http://127.0.0.1:18445/manage>。只打开页面是本地读取，不会自动初始化。
2. 输入本次授权 UID，点击“添加监控”。**这一步会访问 B站公开资料。** 若显示“未取得 UP 资料，请重试。”，先停止，不连点重试；保留浏览器已有请求的 HTTP 状态和脱敏错误 JSON。该提示不等于已定位反爬、账号权限或网络根因。
3. UP 卡片出现后，选择“指定动态 ID”，点击“保存配置”。新增默认配置原为近期模式，但本服务不开 collector，因此不会自动执行近期采集；仍必须先改为指定模式。
4. 输入本次唯一动态 ID，点击“校验并添加目标”。**这一步也会访问 B站校验归属。** 不符、无法确认或失败时停止。
5. 核对只有一个 UP、一个目标，模式为指定。当前正常管理页**没有手动初始化按钮**，不把它说成已经具备。若前四步均成功，打开 <http://127.0.0.1:18445/docs>，展开 `POST /api/sync/initial`，点击 `Try it out`，将请求体设为 `{"uid":"本次授权UID"}`，替换为真实 UID 字符串后只点击一次 `Execute`。这同样是页面操作，无需执行终端命令；它会发起真实初始化。
6. 等待返回，记录 `{processed,succeeded,failed}`，但不要仅凭 `succeeded` 判断全部完成。回到 <http://127.0.0.1:18445/>，打开本次动态，分别查看正文、评论区状态、最热/最新、更多评论，以及各根下展开/更多回复。评论计数入口也可定位评论区；“读取评论同步状态”只读本地，不启动采集。
7. 当前不配 OSS；动态图、根评论图可能显示“图片待归档”，不应记为上传成功。正文失败、受限和评论可读可以同时存在；逐项记录。没有回复时先核对来源/本地计数和分项状态，而不是将空列表当作全量成功。
8. 如需直接核对字段，可在同一个文档页执行对应 Archive/管理 **GET**，这些接口只读本地。`check_status:"unchecked"` 是未运行 collector 的检查投影，不代表手动初始化一定未执行。

当前新增 UP 失败观察另见 [`manual-observation.md`](manual-observation.md)。不要为获取诊断材料擅自重试上游或更换目标。

## 命令行备用流程

以下命令在**运行服务的主机**上、同一个 Bash 终端逐步运行；SSH 隧道用于另一台电脑访问文档页。**不要整段批量执行写请求，也不要失败后继续粘贴下一步。** 每步的原始响应仅保存在仓库外，分享前另做脱敏。动态 ID 必须保留为字符串，避免大整数精度丢失。

保存的 JSON 可用文本编辑器本地查看，或使用已有解释器格式化（只读文件，不访问上游），例如：

```bash
/home/kevin/Projects/PI/bili_charge_dynamics/.venv/bin/python -m json.tool "$OUT/01-add-up.json"
```

此查看命令应在下面第 0 步创建 `OUT`、第 1 步保存响应之后执行。

### 0. 输入本次目标，准备仓库外结果目录

```bash
BASE=http://127.0.0.1:18444
read -r -p '本次已授权 UID: ' TARGET_UID
read -r -p '本次唯一动态 ID: ' TARGET_DYNAMIC_ID
umask 077
OUT=$(mktemp -d /home/kevin/.local/state/bili-charge-dynamics/live-34/manual-XXXXXX)
printf '本地结果目录：%s\n' "$OUT"
```

### 1. 新增 UP（首次真实上游访问）

```bash
curl --noproxy '*' --fail-with-body --silent --show-error \
  -X POST "$BASE/api/manage/ups" -H 'Content-Type: application/json' \
  --data "{\"uid\":\"$TARGET_UID\"}" \
  --output "$OUT/01-add-up.json"
printf '退出码：%s\n' "$?"
```

本地查看响应确认成功。失败则停止，不改用其他 UID，不自行循环重试。

### 2. 先切换指定模式（本地配置，不执行初始化）

```bash
curl --noproxy '*' --fail-with-body --silent --show-error \
  -X PATCH "$BASE/api/manage/ups/$TARGET_UID/monitor" \
  -H 'Content-Type: application/json' \
  --data '{"mode":"specified","recent_n":10,"enabled":true}' \
  --output "$OUT/02-monitor.json"
printf '退出码：%s\n' "$?"
```

`recent_n` 是契约要求字段；本轮使用 `specified`，不执行近期目标策略。`enabled=true` 不会在只有 API、没有 collector 的环境中自行开始调度。

### 3. 只添加一条指定动态（再次真实上游访问）

```bash
curl --noproxy '*' --fail-with-body --silent --show-error \
  -X POST "$BASE/api/manage/ups/$TARGET_UID/targets" \
  -H 'Content-Type: application/json' \
  --data "{\"id\":\"$TARGET_DYNAMIC_ID\"}" \
  --output "$OUT/03-target.json"
printf '退出码：%s\n' "$?"
```

此步骤请求上游验证归属，验证通过后才保存关联。`409 TARGET_AUTHOR_MISMATCH` 或 `502 TARGET_UNVERIFIED` 都应停止，不绕过校验。

### 4. 初始化前复核配置（只读本地）

```bash
curl --noproxy '*' --fail-with-body --silent --show-error \
  "$BASE/api/manage/ups" --output "$OUT/04-ups.json"
curl --noproxy '*' --fail-with-body --silent --show-error \
  "$BASE/api/manage/ups/$TARGET_UID" --output "$OUT/04-up.json"
curl --noproxy '*' --fail-with-body --silent --show-error \
  "$BASE/api/manage/ups/$TARGET_UID/targets" --output "$OUT/04-targets.json"
```

逐一检查输出：只有本次一个 UP、模式为 `specified`、只选中本次一个动态。发现已有其他目标或配置不符，停止，不执行初始化。

### 5. 显式初始化一次（真实上游访问，可能较久）

```bash
curl --noproxy '*' --fail-with-body --silent --show-error \
  -X POST "$BASE/api/sync/initial" -H 'Content-Type: application/json' \
  --data "{\"uid\":\"$TARGET_UID\"}" \
  --output "$OUT/05-initial.json"
printf '退出码：%s\n' "$?"
```

只执行一次。不要同时运行 collector 或再次点击初始化；不要因客户端断开就再提交一次。返回结构仅为 `{processed,succeeded,failed}`，没有 `partial` 字段。核对本次单目标的 `processed` 是否为 1；`succeeded` 只统计正文成功（含成功空），正文受限/失败计入 `failed`，不代表评论和媒体成功。任何 `succeeded` 结果都不能代替下方分项核验。

### 6. 分别读取归档结果（这些 GET 只读本地）

```bash
curl --noproxy '*' --fail-with-body --silent --show-error \
  "$BASE/api/manage/ups/$TARGET_UID/checks" --output "$OUT/06-checks.json"
curl --noproxy '*' --fail-with-body --silent --show-error \
  --get "$BASE/api/archive/dynamics" \
  --data-urlencode 'scope=up' --data-urlencode "uid=$TARGET_UID" \
  --output "$OUT/06-list.json"
curl --noproxy '*' --fail-with-body --silent --show-error \
  "$BASE/api/archive/dynamics/$TARGET_DYNAMIC_ID" --output "$OUT/06-detail.json"
curl --noproxy '*' --fail-with-body --silent --show-error \
  --get "$BASE/api/archive/dynamics/$TARGET_DYNAMIC_ID/comments" \
  --data-urlencode 'sort=hot' --data-urlencode 'limit=20' \
  --output "$OUT/06-comments-hot.json"
curl --noproxy '*' --fail-with-body --silent --show-error \
  --get "$BASE/api/archive/dynamics/$TARGET_DYNAMIC_ID/comments" \
  --data-urlencode 'sort=latest' --data-urlencode 'limit=20' \
  --output "$OUT/06-comments-latest.json"
```

根评论若返回非空 `next_cursor`，在同一查询上通过 `--data-urlencode "cursor=<返回的游标>"` 翻页，直至 `next_cursor` 为空；这是读取本地归档，不是继续采集上游。不要据第一页就判断全量完成。

从根评论中选出真实根评论 ID，再读取该根下回复；不能把动态 ID 当成根评论 ID：

```bash
read -r -p '要核验的根评论 ID: ' ROOT_ID
curl --noproxy '*' --fail-with-body --silent --show-error \
  --get "$BASE/api/archive/dynamics/$TARGET_DYNAMIC_ID/comments/$ROOT_ID/replies" \
  --data-urlencode 'limit=10' \
  --output "$OUT/06-replies.json"
```

回复同样按 `next_cursor` 翻完本地分页。没有根评论、没有回复和读取失败必须分开记录，不能将空数组一律算作采集成功。

### 7. 分项记录，不扩大结论

- 正文：详情中核对 `id`、`author`、`content_state`、`last_attempt`、`title/text`。来源拒绝或无法确认时，明确记为受限、失败或未验证；匿名上游不保证能读受限动态。
- 根评论：分页返回 `{items,next_cursor}`，根项的 `id` 才是下一步所用 `ROOT_ID`。分页响应本身没有根同步失败状态；另看详情的 `root_comments_last_attempt`、`comments_last_attempt`、分项错误及 `work.comments`。结合 `source_comment_count/local_comment_count` 和实际分页判断，不能只看计数或空列表，也不能假定来源计数与本地口径完全一致。
- 回复：分别检查有回复的根。回复页另有 `source_reply_count`、`local_reply_count`、`replies_last_attempt`、`synced_source_reply_count`；详情还有 `replies_last_attempt` 和 `work.replies`。单根成功不能代表所有根完整；根扫描失败后回复可能为未确认。
- 图片：本轮不配 OSS，不做媒体重试、不打开来源图片地址补采。查看详情或根评论的 `media.status/error`、`media_last_attempt`、`work.media`；有媒体但仍待归档就如实记录，不能写成图片上传或浏览器直取通过。
- 归档读取：记录上述本地 GET 的实际 HTTP 状态及对应正文/评论/回复结果，区别于初始化请求自身的状态。HTTP 200 也可能返回受限、旧快照或分项失败状态。
- 检查记录：手动 initial 不写 collector 的 `target_checks` 记录。关联目标后，`/checks` 可合成 `check_status:"unchecked"`、检查时间 null 的投影，并附带归档 `parts`；这不是执行过检查。详情 `comment_sync` 也可能是该投影，不能据此判定初始化没运行，或把投影当成持续调度证据。完全无目标时才是空列表。
- 部分完成：初始化响应没有统一 `partial` 字段。按上述分项分别记录正文成功/受限/失败、根评论和回复完成程度、图片待归档，以及未验证内容。
- 所有原始响应、数据库及真实图片留在仓库外。向本目录补充材料前应移除 Cookie、凭据、认证头、签名 URL、真实个人资料和原始内容；只保留必要的脱敏结构、计数、状态、时间与限制。
- 本轮无论结果如何，都不代表持续稳定、2 核 2GB 资源验收、真实 OSS 成功或全项目通过。#34 保持未完成；#33 的 Safari、真机截图及正式视觉签收缺口不因此消失。

## 依据

- `backend/README.md:152–169`：OSS 服务端配置与公开 URL 契约。
- `backend/bili_monitor/app.py:35–70,95–137,159–162,232`：生产入口、本地迁移、管理写接口与初始化。
- `backend/bili_monitor/storage.py:78–84`：数据库路径与父目录创建。
- `backend/bili_monitor/contracts.py:20–34`：字符串 ID 与指定模式请求体。
- `backend/bili_monitor/source.py:121–136`：目标归属核验。
- `backend/bili_monitor/media.py:92–126`、`sync.py:73–92`：无 uploader 时跳过媒体归档。
- `docs/backend/api/archive-api.md:76–156`、`backend/bili_monitor/sync.py:11–92`：初始化正文计数与评论/媒体分项状态。
- `backend/bili_monitor/checks.py:112–234`：未运行 collector 时的检查状态投影。
- `backend/bili_monitor/source_transport.py:14–20`：transport 不自动重试。
- 根评论与回复分页无来源硬上限，见 `root_comments.py:82–162`、`replies.py:23–99`。

本文件是本次任务的准备快照和人工操作流程，不替代正式接口契约；启动时通过本机 `/openapi.json` 核对过方法、路径、请求模型及本地读取参数。
