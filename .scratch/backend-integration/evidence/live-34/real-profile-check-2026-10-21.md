# #34：一次真实公开资料验证（上游 HTTP 412）

## 授权与范围

- 用户在同意更新隔离 API 后明确要求“直接使用真实b站环境验证”。执行前已说明：仅对本次授权 UID 做一次真实 UP 资料查询；不添加动态、不执行初始化、不下载图片、不访问 OSS、不自动重试。
- 目标仅为此前用户给定 UID，本文不记录原值，不自行选择或替换目标。
- 时间：`2026-10-21T12:28:04+08:00`。只记录本次受控验证，不推断此前用户点击次数。

## 环境与入口

- 本地预检发现旧 transient API/前端 unit 已停止，18444/18445 均无监听。核对仓库外启动脚本和现有诊断代码后，只恢复独立 `bili-charge-live-34.service`。
- 使用真实生产 ASGI `backend.bili_monitor.app:app`，监听 `127.0.0.1:18444`，单 worker、`Restart=no`、`TimeoutStopSec=5`。
- `BILI_DATABASE_PATH` 指向仓库外持久 SQLite；启动脚本显式移除 OSS 配置，不启动 collector。未使用 visual_preview、测试 fixture、MockTransport 或 mockReader。
- `app.py`、`source_transport.py`、`safety.py` 相对基线没有改动。生产 transport 使用真实 HTTPX HTTPS，`trust_env=False`，不自动重试。
- 本地 `/docs` 返回 `200`。业务预检表计数为 0，没有已有目标或重复身份。
- 本次未恢复或修改前端 unit，未访问或操作原 `192.168.8.20:18443` 验收站。

## 请求范围与实测

本次只提交 1 条本地 `POST /api/manage/ups`，生产代码对授权 UID 发起 1 条公开 card GET（路径 `/x/web-interface/card`；不记录 query、UID 或 headers）。没有后续目标/初始化写请求，没有失败重试。

本地 curl 正常收到响应（退出码 `0`），HTTP 为 `502`：

```json
{"error":{"code":"PROFILE_UNAVAILABLE","message":"无法取得完整公开资料"}}
```

本次 API invocation 的 journal 中取得恰好 1 条白名单诊断：

```text
profile_lookup_failed reason=http_status http_status=412
```

因此可以确认：**本次真实公开资料 GET 收到上游 HTTP 412，映射成本地 502；没有进入 JSON/资料字段校验。** 这不是用 fixture 推断的结果。诊断从生产 reader 到 Uvicorn stderr/journal 的交付，在本次失败样本中已观察到。

仅凭 412 不能确认具体拒绝机制、反爬规则、凭据要求、持续时长或修复方法，也不能追溯证明先前用户截图必然同为 412。不绕过、不更换目标、不循环重试。

## 分项结果与停止

| 核验项 | 结果 |
| --- | --- |
| 真实公开资料读取 | 失败／上游 HTTP 412，已停止 |
| 服务端脱敏诊断 | 本次样本可见，1 条固定事件；未泄露目标、响应原文、URL/headers 或凭据 |
| UP 保存 | 未保存；验证后 identities、monitors 均为 0 |
| 指定模式、指定动态关联及归属校验 | 未执行 |
| 正文、根评论、回复、初始化后归档读取 | 未执行、未验证 |
| 图片下载、真实 OSS 上传、公开图片读取 | 未执行、未验证 |
| 持续稳定、资源验收、其他协议/错误类别 | 未验证 |

验证后只读检查：`targets`、`archives`、`target_checks`、`root_comments`、`replies`、`media_attempts` 均为 0。API 保持运行但没有 collector 或长期监控任务；停止的是本次验证流程，不是假称停止整个服务。请求耗时/资源未测量。

## 数据与证据存放

原始本地响应、开始时间及安全日志摘录仅存放在仓库外私有运行目录 `real-profile-20261021T042804Z-Lr5ctw/`（位于 `/home/kevin/.local/state/bili-charge-dynamics/live-34/` 下）。没有收集上游原始 body、认证头、Cookie 或签名 URL；数据库、原图和凭据不入 Git。

本次没有业务代码改动、没有新增自动重试，也未暂存或提交。原暂存区摘要保持一致。编码阶段的 715 项后端测试与双轴审查见 [profile-diagnostics.md](profile-diagnostics.md)；这些自动化结果不替代本次失败结果，更不构成 #34 或全项目通过。
