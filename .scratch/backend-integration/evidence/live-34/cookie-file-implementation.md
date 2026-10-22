# #34：仓库外 Cookie 文件接入（未经验证）

后续另按用户要求调整来源 client 的普通初始化请求头并执行重启，Cookie 文件规则未改；新配置与未验证边界见[参考初始化记录](reference-client-initialization.md)。本页保留 Cookie 接入阶段的范围与失败反馈，不把后续修改说成此前已验证。

## 用户最新范围

用户同意仓库外 Cookie 文件方案，明确“先改代码，你不做验证，我来验证”，随后又明确“本地测试、回归和双轴审查也不需要你做”。本轮按最新要求只修改实现与说明：

- 未运行本地测试、语法检查、回归、浏览器/HTTP 验证或双轴审查。
- 未读取真实 Cookie、浏览器存储或完整环境，未创建真实凭据文件。
- 编码阶段未重启/部署当前 API 或前端，未改仓库外 `run-api.sh`；后续用户另行要求重启的动作见本文末尾。
- 未请求 B站/OSS，未启动 collector、初始化或自动重放。
- 既有 748 项后端通过、此前 174 项临时工具回归均不覆盖本次 Cookie 改动，不能用于宣称本增补已验证或 412 已修复。

## 实现意图与文件

- `backend/bili_monitor/source_cookies.py`：新增 `BILI_COOKIE_FILE`，默认不配置时匿名；仅启动读取一次。要求仓库外绝对路径、直属目录属主匹配且 0700、普通文件属主匹配且 0600、不跟随符号链接、拒绝额外硬链接。Cookie 为最多 16 KiB ASCII 的 Cookie 请求头值，不含 `Cookie:` 前缀；允许一个行尾，拒绝其他 CR/LF/控制字符和非法 Cookie 名。配置无效固定错误退出，不静默退回匿名。
- 同模块提供 `--write ABSOLUTE_PATH` 本机交互式隐藏输入入口，只写私有文件；不读取浏览器、不联网、不启动服务、不覆盖旧文件。需要轮换时写新文件名。模块使用原子、不覆盖的文件发布；此为代码描述，未在本轮执行验证。
- `backend/bili_monitor/app.py` / `collector.py`：分别在启动时为来源 HTTPX 客户端装配同一套 request hook，明确不跟随重定向。只对 GET、HTTPS、标准 443、精确 `api.bilibili.com` / `www.bilibili.com`、无 URL 用户信息附加 Cookie；其他请求剔除 Cookie，包括 Cookie jar 或重定向带来的值。未配置时不安装该钩子，保留原匿名行为。
- 媒体下载仍是独立 HTTPX 客户端，OSS 使用独立 SDK，不接入来源 Cookie。没有前端/API 凭据输入、没有日志/数据库凭据字段，不改 UA、代理、WBI、重试或账户权限。
- `backend/tests/conftest.py`：只新增运维环境变量隔离，避免后续 pytest 误读真实 `BILI_COOKIE_FILE`；没有新增或执行 Cookie 验证用例。非 pytest 的 fixture 服务仍须维护者自行清除此变量。
- 更新后端 README、管理/归档/发现契约和部署说明，区分历史匿名证据与新的可选服务端登录态。没有改写历史采集/视觉验收结果。

## 用户自行配置

以下为用户在运行 API 的同一 OS 用户终端自行配置的流程；编码阶段代理没有运行。用户随后确认已放好 Cookie 并请求重启，代理仅补上路径配置和重启服务，见末尾记录。不要把 Cookie 发到聊天、命令参数、URL、Git、前端或完整请求/HAR 中。

1. 在仓库根目录执行隐藏输入入口，仅输入自己有权使用的 Cookie 请求头值：

```bash
uv run --offline --no-sync python -m backend.bili_monitor.source_cookies \
  --write "$HOME/.local/state/bili-charge-dynamics/credentials/bilibili-cookie.txt"
```

2. 在仓库外 `/home/kevin/.local/state/bili-charge-dynamics/live-34/run-api.sh` 的 `exec` 前，加入**文件路径**，不是 Cookie 内容：

```bash
export BILI_COOKIE_FILE="$HOME/.local/state/bili-charge-dynamics/credentials/bilibili-cookie.txt"
```

不要修改原 `192.168.8.20:18443` 验收站的启动配置。另一终端中单独 export 不会自动影响已运行的 systemd unit。

3. 由用户自行加载新代码与配置：

```bash
systemctl --user restart bili-charge-live-34.service
```

不需要重建前端，不启动 collector。API 启动仅加载配置；用户准备好后，再在 `http://127.0.0.1:18445/manage` 手动验证本次授权 UID 的资料添加。失败/受限时停止，不连点循环重试、不扩大目标。Cookie 登录态并不保证解除平台风控或获得付费内容权限。

4. 用户自行核验正文、评论、回复、图片等后续阶段时仍按原一次初始化范围执行；本次代码改动不自动执行这些阶段，也不把资料添加成功记成整体归档成功。未配 OSS 的媒体继续待归档。

## 风险与撤销

Cookie 仅在来源客户端内存持有，文件改动不热加载，也不自动续期/刷新；停用时移除启动配置并由用户重启持有该会话的进程。登录凭据应来自本人合法授权，不借此绕过拒绝或切换账号反复试探。

管理/API 仍无鉴权，能访问服务的人可能使用服务端账号的来源读取权限；保持本机监听或受限网络。不会把 Cookie 返回前端，不代表已归档内容有访问控制或 OSS 图片私有。

## 用户要求后的启动更新

2026-10-21T14:40:29+08:00，用户说明 Cookie 已放好并要求重启项目。代理只检查文件元信息：仓库外既定文件存在、普通文件、属主匹配、0600，直属目录属主匹配且 0700；未读取或回显文件内容。

当时 `run-api.sh` 尚无 `BILI_COOKIE_FILE`，因此仅在该仓库外启动脚本补上既定文件路径，再重启 `bili-charge-live-34.service` 与 `bili-charge-live-34-web.service`。API/前端均为 active/running，PID 为 `121018`/`121030`，仅监听 `127.0.0.1:18444/18445`。只核对进程和监听状态，没有调用 HTTP/业务 API、测试 Cookie 有效性、请求 B站/OSS、执行初始化或启动 collector，也未操作原验收站。

## 用户重试后的失败反馈

用户随后反馈仍显示“未取得 UP 资料，请重试”。只读已有 journal，最新 `2026-10-21T14:43:35+08:00` 事件仍为 `reason=http_status http_status=412 message_state=html upstream_message=null`。没有为排查再次提交业务请求，不能拿此前其他样本的 HTML 说明冒充这次 body。

进一步仅核对非敏感运行配置：API 进程有 `BILI_COOKIE_FILE` 且等于既定路径；文件普通、0600、属主匹配、单硬链接，修改时间早于当前 API 启动。未读取或回显 Cookie 文件内容，未打印其他环境项。这排除了明显的路径缺失/文件在重启后更新的问题，**不证明 Cookie 已在该次出站请求实际装配，也不证明其完整或有效**。

下一步先向用户确认取得 Cookie 的方式（成功 card 请求的完整 Cookie 头值、仅某项令牌或 document.cookie 等），不索要值、请求头全文或 HAR，不自动重试/切换请求身份。当前尚不能将 412 具体归因于 Cookie、UA、IP 或其他条件。

状态：**代码未经本地测试、回归或双轴审查；用户配置后的真实资料尝试仍失败。** #34 仍未完成，未声称真实报错已修复。
