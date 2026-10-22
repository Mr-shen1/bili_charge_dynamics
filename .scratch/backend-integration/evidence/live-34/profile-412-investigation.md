# #34：资料卡 HTTP 412 调查与修复阻塞

本文的客户端参数事实记录调查时版本；后续按用户要求参考 Session 初始化，新增了真实应用 UA、语言与内容协商配置，见[初始化改动记录](reference-client-initialization.md)。该后续修改仅重启、未经验证，不倒推本调查样本的 412 原因或声称已修复。

后续独立授权的私有取样已保留一份新的真实 HTML，页面明确声明“由于触发哔哩哔哩安全风控策略，该次访问请求被拒绝。”，见[私有正文保留与审阅](private-response-capture-2026-10-21.md)。这只确认该新样本的拒绝类型，不明确具体触发规则，也不追溯证明此前各次 412 的正文。下文保留取样前的调查边界；真实新增 UP 仍未修复。

## 收敛结论

**真实新增 UP 仍未修复。** 最新获准的单次生产查询仍为本地 502、上游 412，错误消息被分类为 HTML。当前证据不足以认定本地哪个协议步骤存在缺陷，也不足以提出一个可验证且不绕过限制的兼容补丁。没有通过忽略状态、填默认身份或伪造 fixture 200 将其记成修复。

本次获准请求预算已用完，停止对该接口或替代接口发请求。业务代码没有因本次调查再改动；先前日志改动只改善诊断，不解决来源拒绝。748 项自动化通过不是资料来源可用的证明。

## 已证实：生产请求与反馈回路

- 新增 UP 先调用 `fetch_profile`，GET 固定公开 card 路径，仅传 `mid`；先检查 HTTP 状态，再解析 JSON/资料字段。失败统一为 `502 PROFILE_UNAVAILABLE`，不保存身份。[生产资料解析](../../../../backend/bili_monitor/profiles.py#L69-L140) · [管理路由](../../../../backend/bili_monitor/app.py#L95-L102)
- `AsyncClient` 使用 `timeout=10`、`trust_env=False`，没有显式覆盖请求 headers。生产 transport 为真实 `AsyncHTTPTransport(trust_env=False)`，未启用重试；仅对 feed/根评论/回复添加发送间隔，资料卡不在延迟表。[客户端](../../../../backend/bili_monitor/app.py#L53-L58) · [transport](../../../../backend/bili_monitor/source_transport.py#L8-L36)
- 锁定 HTTPX 为 0.28.1。该版本默认 User-Agent 为 `python-httpx/0.28.1`，Accept 为 `*/*`，transport 默认 retries=0；这是默认实现事实，不是本次网络抓包，也不能据此认定其为 412 根因。[项目依赖](../../../../pyproject.toml#L5-L10) · [HTTPX 0.28.1 客户端](https://github.com/encode/httpx/blob/0.28.1/httpx/_client.py) · [transport 文档](https://github.com/encode/httpx/blob/0.28.1/docs/advanced/transports.md) · [超时文档](https://github.com/encode/httpx/blob/0.28.1/docs/advanced/timeouts.md)
- 用户本次明确允许的一次查询于 `2026-10-21T13:12:12+08:00` 执行：本地 502、上游 412、本地总耗时 0.171707 秒，单条日志为 `message_state=html upstream_message=null`；脚本预期 201，实际返回非零红信号，已停止。[完整脱敏实测](real-profile-message-check-2026-10-21.md)
- HTML 分类可来自媒体类型或正文前缀。未保存原始 body，不判断页面具体内容、具体拒绝机制或是否有可读错误文本；没有取得可输出的 JSON `message/msg`。[消息分类实现](../../../../backend/bili_monitor/profiles.py#L30-L66)
- 第一次受控资料查询也为 412，但当时没有 body 类型证据，不能从后续样本追溯改写该次结论。[初次受控查询](real-profile-check-2026-10-21.md)

## 测试与真实来源的区别

- 管理测试使用虚构资料和 `httpx.MockTransport`，经真实应用/SQLite 验证解析、API、保存；不证明当前匿名访问成功。[共享测试边界](../../../../backend/tests/management_support.py#L21-L45) · [管理测试](../../../../backend/tests/test_management.py#L19-L31)
- 诊断测试合成 HTTP/JSON/HTML 等错误输入，证明安全分类、消息目录、固定错误、失败不保存等行为；不能据此判断网络、授权或真实错误正文。[诊断测试](../../../../backend/tests/test_profile_diagnostics.py)
- [消息日志记录](profile-error-message.md)的 748 passed 是已执行的编码回归，不是本调查重新运行，也不是本次真实请求通过。不能写一个固定返回 200 的替身测试，便将当前真实 412 认定为修复。
- 可行性文档此前的 412 属于其他 `/opus/detail` 请求，不是当前 card 协议的验证。[原可行性记录](../../../../docs/backend/evidence/backend-feasibility.md#L38-L50)

## 公开资料：能证明与不能证明的边界

### 社区协议文档

固定快照 `cfc5fddcc8a94b74d91970bb5b4eaeb349addc47` 将 `x/web-interface/card` 记为 GET，`mid` 必需、`photo` 可选；响应含 `data.card.mid/name/face`。同文档标记为旧版的是 `x/space/acc/info`，不能据此断言 card 已正式废弃。

来源：[社区镜像固定 commit](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/user/info.md#L518-L585)。这是社区逆向资料，不是 B站官方契约、授权或当前可用性保证。

### 开源 SDK

`bpi-rs` 0.3.1，快照 `5faa7641007fd050b33cca3eef7799c5beb45143`，实现了同一资料卡 endpoint，模型含 `mid/name/face`。其 fixture 声称匿名 profile 并列出 User-Agent/Referer/Origin 约定；README 说明非官方、Web 接口可能变化或受限。

来源：[客户端实现](https://github.com/yuelioi/bpi-rs/blob/5faa7641007fd050b33cca3eef7799c5beb45143/src/user/client.rs#L17-L130) · [模型](https://github.com/yuelioi/bpi-rs/blob/5faa7641007fd050b33cca3eef7799c5beb45143/src/user/model.rs#L7-L48) · [fixture](https://github.com/yuelioi/bpi-rs/blob/5faa7641007fd050b33cca3eef7799c5beb45143/tests/contracts/user/public-read/card/contract.json#L1-L94) · [非官方声明](https://github.com/yuelioi/bpi-rs/blob/5faa7641007fd050b33cca3eef7799c5beb45143/README.md#L1-L17)。

这些只证明 SDK 的实现/测试约定，不证明当前来源可用，更不是授权依据。没有把 SDK 的浏览器 headers 复制成所谓“已验证修复”，也没有伪装浏览器、借用 Cookie、轮换 IP、绕过验证码或伪造签名。

### 官方授权入口线索

Exa 搜索索引命中 B站开放平台 `USER_INFO` 和 OAuth 文档：索引内容称需要申请接口权限、用户授权和 token；用户资料字段为 name/face/openid，未证实可输入任意 mid。调研没有直接请求该站点，页面无固定版本，**仅作待正式核验的入口线索**。

来源：[USER_INFO 文档](https://open.bilibili.com/doc/4/feb66f99-7d87-c206-00e7-d84164cd701c) · [OAuth 文档](https://open.bilibili.com/doc/4/eaf0e2b5-bde9-b9a0-9be1-019bb455701c)。不能把它直接替换成当前任意 UID 匿名查询，也不能在权限/产品 UID 映射未确认时写兼容代码。

本次核对资料中没有找到正式宣布 card 变更或废弃的官方通知；这不证明不存在。平台当前访问契约及本次 412 的具体拒绝原因仍未知。

## 为什么本次不能直接改为“成功”

1. 真实反馈停在 HTTP 拒绝阶段，未到 JSON/profile 解析；没有证据支持改字段名、放宽资料校验或默认昵称可修复拒绝。
2. SDK 请求设置差异只是假说线索，不是当前失败的可验证根因；不得为避开拒绝而自动伪装身份、换来源/目标或循环探测。
3. 官方授权入口的访问资格与 UID 映射未确认；没有可直接采用的受支持替代协议。
4. 本次真实预算只允许一次且已用完，不能为凑绿色验证继续请求。没有新的正常协议/访问授权证据前，不做未经实证的业务补丁，不声称修复完成。

后续若继续，需要先确定平台允许的资料获取入口/访问条件及其对产品任意 UID 需求的适用性，再另行确认最小验证范围、编写对应协议回归和做真实验证。凭据仍只留服务器，不要求在聊天提供 Cookie、密码或密钥。

执行约束：[管理契约](../../../../docs/backend/api/management-api.md) · [#34 授权与停止要求](../../issues/34-live-source-runtime-evidence.md#L11-L16)。

## 调研执行说明

调研由 Explore 只读完成，使用 CodeGraph 并核对实时源码，公开 Git 来源和库文档独立于真实请求；未运行第三方脚本、测试或 B站/OSS 请求。Explore 无写权限，主线程聚合后保存本文件，并修正同目录证据链接。真实单次请求由主线程在明确许可后执行，范围与失败已另记。
