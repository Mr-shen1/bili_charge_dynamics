# #34：补充上游错误消息日志

后续用户授权保留失败正文，已在一次新的私有取样中静态匹配到平台风控拒绝说明，见[正文保留与审阅](private-response-capture-2026-10-21.md)。这不是本实现自动从 HTML 输出的 `upstream_message`；应用对 HTML 仍记为 html/null，未为该次取样修改仓库业务源码。

## 需求与安全边界

用户指出日志不能只记录 HTTP 412，还应打印上游 error message。本增补沿用已经确认的测试 seam：真实管理 POST 与服务端运维日志，临时 SQLite，仅测试中的外部 HTTP 替身；不修改运行服务的 transport，不重新请求真实 B站/OSS。

安全约束不变：不记录完整上游响应、UID、URL/query、请求/响应 headers、个人资料、Cookie、认证头、异常文本或 traceback。任意未知字符串无法仅凭截断/正则保证无秘密，因此只允许完全匹配已审核固定安全目录的上游消息进入日志；**不承诺未知原文一定打印**，也不伪称已经保存未知消息。

编码审查基线仍为 `057921bc182626a743a8ea158f97f3482e4a4c70`，只审本轮诊断生产文件、公开测试及对应正式说明/本记录；原有 #33、用户未跟踪文件及其他任务不纳入。

## 行为

- HTTP 非成功与业务拒绝在原单条 WARNING 后追加 `message_state`、`upstream_message`。
- 只读取 JSON 顶层 `message`；其缺失、null 或空白时尝试 `msg`。不搜索 `data.card` 或其他个人资料，不因 HTTP 4xx 中 `code=0` 而保存身份。
- 仅解析已缓冲且至多 8192 字节的响应正文；这不是网络响应大小硬限。候选非空消息原长至多 200 字符，去首尾空白后须完全匹配生产代码的固定安全目录。
- `allowed` 才输出对应 JSON 引号消息；其他状态为 `missing`、`invalid_type`、`too_long`、`not_allowlisted`、`html`、`non_json`、`invalid_payload`、`body_too_large`、`empty_body`、`unreadable`，消息值均为 null。
- 安全目录只批准打印固定公共短语，不证明 B站实际上使用它们。未知消息没有原样或截断输出；HTML 不打印标题/页面片段。
- HTTP `502 PROFILE_UNAVAILABLE`、前端固定文案、失败不保存及重新添加失败保留旧身份不变；无重试、权限绕过、Cookie、WBI 或新配置入口。
- 本增补不能恢复此前已被丢弃的真实响应体；之前两条 412 日志不因此获得 message。

## TDD 与回归

所有请求均仅在测试中使用虚构外部传输，经过真实 app/profile parser/临时 SQLite：

1. HTTP 消息分类与安全输出先红：26 failed，37 passed（原状态测试更新新后缀，加上新消息用例均缺字段）；最小实现后 63 passed。
2. 业务拒绝消息先红：5 failed，60 passed（无消息后缀）；给业务拒绝接入同一解析后 65 passed。
3. 加入 UTF-8/嵌套无效 JSON、message/msg 优先级、不可读 body、HTTP 412 携完整成功 card、旧身份保留等回归。曾将合法深嵌套数组误写为必定解析失败的断言，发现后改为确定无效 JSON，避免依赖 Python 递归上限。
4. MIME 参数含 `html` 不应误判 HTML：先观察 1 failed、26 passed、51 deselected；改用精确媒体类型判断后管理/诊断合计 160 passed。
5. 审查指出诊断 helper 不应覆盖已确定的 502。通过外部 HTTPX 错误响应构造正文读取异常，先观察 1 failed、78 deselected（实际误回 500）；仅在诊断旁路加入安全降级后，管理/诊断合计 161 passed。原请求阶段非预期异常的 500 行为仍保持。

当前诊断测试文件共 79 个用例（此前 46，本增补新增 33），含虚构秘密、URL、请求 UID、个人昵称、控制字符及恶意状态值的拒绝输出断言。

```bash
uv run --offline --no-sync pytest backend/tests/test_profile_diagnostics.py backend/tests/test_management.py -q
# 初轮 160 passed；审查修正后 161 passed, 1 warning
```

初轮全后端回归为 747 passed、3 个既有弃用警告、129.20s；审查修正后再次执行 `uv run --offline --no-sync pytest backend/tests -q`，为 **748 passed、3 个既有弃用警告、128.32s**。警告仍为 Starlette/AnyIO alias 与 OSS SDK `datetime.utcnow()`，不是新增失败。已通过的自动化不等于真实上游拒绝已解决或真实 message 已取得。

## 双轴审查

### Standards

初审无硬违规。判断项：诊断自身异常可能覆盖原错误、README 的目录指向、用例计数措辞，以及与旧管理测试部分断言重复、logger 名称耦合。前三项已修正并补红—绿回归；后两项保留：不为本轮诊断改动既有通用测试，运维日志 seam 及名称已在原测试边界确认。

### Spec

初审无硬性缺陷；“打印任意 error message”仅部分满足且明确披露：只允许安全目录内的固定原消息，未知原文不输出。判断项为诊断失败降级、正文大小/HTML 分类优先级、ASCII 日志环境的中文输出风险。前两项已修正/澄清，历史真实 412 的 body 类型与消息仍未知，不采用“很可能是 HTML”的猜测。中文日志交付属于后续部署验证边界，不用 caplog 结果替代真实日志证据。

两路 `review` 再次独立复核，Standards 与 Spec 均未发现硬性缺陷，确认诊断异常降级、正式契约和 79/161 用例计数一致。未扩大实际采集范围，未知消息仍只输出明确状态，不能把白名单限制包装成取得任意真实原文。

保留权衡：诊断旁路自身的编程异常也会被安全降级，避免覆盖原资料失败；本轮不另加原始 debug 日志或读取异常信息。logger 名称和部分既有测试断言重复属于已确认 seam 的维护成本。实际中文上游消息经 journal 的交付未重放验证，后述 UTF-8 配置只降低编码风险。

## 部署与真实证据

2026-10-21T13:02:35+08:00 完成隔离 API 更新：只重启 `bili-charge-live-34.service`，新进程为 active；前端 `bili-charge-live-34-web.service` 保持 active，PID 未变。`18444/docs`、`18445/manage`、代理管理 GET 的本地只读检查均返回 200，未访问原验收站。

仓库外 `run-api.sh` 显式设置 `PYTHONIOENCODING=utf-8:backslashreplace`，不改变数据库路径、OSS 禁用、单 worker 或 localhost 监听。脚本语法通过；用相同配置的独立本地解释器确认 stderr 为 UTF-8/backslashreplace，但不把它说成真实上游中文 message 的 journal 实证。

上述编码与部署阶段没有新 POST/真实 B站或 OSS 请求，没有初始化、collector 或自动重放。API 新代码已加载；只有之后新产生的错误才有消息字段，旧日志不会补录。

随后用户另行明确授权 1 次真实资料查询，`2026-10-21T13:12:12+08:00` 得到本地 502、上游 412、`message_state=html`、`upstream_message=null`，已停止。新增字段在这条真实 journal 中可见，但没有观察到非空上游中文消息；详见[新消息诊断实测](real-profile-message-check-2026-10-21.md)。该样本仍失败，不能写成资料读取已修复，后续真实请求仍需明确确认。

此前真实请求的唯一已确认结果仍见 [2026-10-21 实测](real-profile-check-2026-10-21.md)：上游 HTTP 412；其原始 body 未保留，无法推测其中一定存在 JSON error message。
