# #34：新消息诊断的一次真实验证（仍失败）

本页记录的是 13:12 的样本，该次正文未保留。后续用户又独立授权保留一份新失败响应，已在另起的私有诊断实例取得明示安全风控拒绝的 HTML，见[后续取样](private-response-capture-2026-10-21.md)。不可把后续原件当作本次或原 18444 进程的 body。

## 授权与请求范围

用户要求修复真实资料读取失败，并在执行前明确回答“允许”：再对原授权 UID 做 1 次生产资料查询，最多 1 次上游请求，不换接口/目标、不初始化、不访问 OSS，失败立即停止。此处不记录真实 UID。

- 开始时间：`2026-10-21T13:12:12+08:00`。
- API/前端在执行前均为 active；原持久 SQLite 的身份、监控、目标、归档、检查表为 0 行。
- 通过运行中的真实 `POST /api/manage/ups` 执行，生产 transport/reader 不替换，不使用 MockTransport、fixture、visual_preview 或 mockReader。
- 只提交 1 次本地 POST，生产路径只发起 1 次原公开 card GET。无失败重试、其他来源接口或目标，没有动态归属核验、初始化或 collector。

## 结果

- curl 传输退出码：`0`，正常收到本地 HTTP `502`。
- 本地请求总耗时：`0.171707` 秒；不是独立测得的上游耗时或资源指标。
- 本地错误：`PROFILE_UNAVAILABLE`，固定提示不变。
- 本次 journal 中安全筛选到 1 条新诊断：

```text
profile_lookup_failed reason=http_status http_status=412 message_state=html upstream_message=null
```

因此确认：本次来源 HTTP 为 **412**，消息诊断分类为 **html**。按代码，`html` 可由 Content-Type 的 HTML/XHTML 媒体类型或正文 HTML 前缀触发；未保存原始 body，**不能从该分类断言页面中的具体拒绝原因、完整正文格式、是否含可读错误文本，也不能说上游绝对没有 error message**。本次未提取到可输出的 JSON `message/msg`。

验收脚本以预期 HTTP 201 为成功信号，实际 502 后主动返回非零：

```text
PROFILE_VALIDATION_FAILED: expected HTTP 201; stopped without retry.
```

这是本次真实反馈回路的红信号，不是采集成功，也不表示 API 进程崩溃；前后端验证后仍为 active。

## 停止与数据边界

验证后只读 SQLite：`identities`、`monitors`、`targets`、`archives`、`target_checks`、`root_comments`、`replies`、`media_attempts` 均为 0。未保存 UP，正文/根评论/回复/图片及初始化后归档仍未验证。

私有目录为 `/home/kevin/.local/state/bili-charge-dynamics/live-34/real-profile-message-20261021T051212Z-OUqu57/`，仅存本地响应、开始时间、HTTP 状态/耗时及安全日志摘录。没有存上游原始 body、headers、Cookie 或认证资料；没有复制真实数据库、图片或凭据入 Git。

到此停止真实请求，不扩大样本、不换接口、不伪造浏览器身份或绕过限制。继续修复必须先有可核验的正常协议/授权依据，不能用忽略 412、默认身份或伪造 200 fixture 宣称已修好。任何新真实请求都须重新明确范围。随后完成[协议调查](profile-412-investigation.md)，尚未取得可验证的业务补丁依据；当前状态为未修复／来源拒绝原因未明，不以更多模拟测试替代真实修复。

## 与编码和既有证据的区别

[消息日志增补](profile-error-message.md)的 748 项后端回归只证明本地实现和安全边界；本次真实结果仍失败，不把自动化通过升级为来源可用。此前[第一次受控资料查询](real-profile-check-2026-10-21.md)只留下 HTTP 412；本次不追溯改变此前样本的正文/原因结论。
