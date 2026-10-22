# #34：参考脚本的 client 初始化配置（未经验证）

## 用户范围

用户要求参考 `bili_charge_monitor.py` 的 client 初始化，修改后重启项目，并明确本次“不用做任何验证”。本轮只进行只读对照、代码/说明修改和指定服务的重启命令；不执行测试、语法检查、回归、双轴审查、HTTP/浏览器检查或 B站/OSS 请求。

## 只读对照

Explore 先从文档索引定位来源与后端安全原文，用 CodeGraph 并对照当前源码；ignored 脚本未入图时只做安全本地 AST 提取。脚本定位为 `script_demo/bili_charge_monitor.py`，未执行或导入，不回传凭据、完整 headers、签名 URL 或 Cookie 值。

- 脚本在约 152/201 行创建同步 `requests.Session`，208 行显式设置 User-Agent、Accept、Accept-Language、Referer、Origin；UA 为浏览器身份型，只记录类别，不复制其值。
- 初始化相关 GET 约为 10 秒，feed/评论/回复调用约为 15 秒；没有明确代理、HTTP 版本或连接池参数。源码事实不是运行环境抓包。
- 当前 API/collector 已在生命周期中复用 `httpx.AsyncClient`，来源超时 10 秒、媒体 30 秒；source transport 禁环境代理、不自动重试、媒体与 OSS 分离。

## 本次实际修改

新增 `backend/bili_monitor/source_client.py`，API 与 collector 共用其普通请求头/钩子装配：

- `User-Agent: bili-charge-dynamics`，明确真实应用名，不声称浏览器身份。
- `Accept-Language: zh-CN,zh;q=0.9`。
- 对允许的 HTTPS GET，API host 使用 JSON/文本内容协商，`www.bilibili.com` 使用 HTML 内容协商；不将页面与 JSON 接口混为同一种默认 Accept。
- 普通请求头准备后，继续由原 `source_cookies.py` 执行 Cookie 的精确 host/GET/HTTPS/端口/用户信息限制；不复制或记录 Cookie。
- 继续使用原长生命周期异步 client、10 秒来源超时、PacedSourceTransport、`trust_env=False` 与不跟随重定向。媒体和 OSS 不接入该来源配置。

只参考普通配置原则，**未完整照搬脚本**：不切换为同步 requests，不复制浏览器 UA、Origin/Referer、WBI、额外初始化 GET、代理或通知循环，不导入 ignored 脚本。服务启动不新增来源网络请求。

这项改动并不证明默认 headers 是 412 根因，也不承诺能解除风控。之前的浏览器/HTTPX 差异、私有 HTML 与 748/174 等历史结果均不覆盖本次新配置；没有把这些结果升级为本次验证通过。

## 重启记录

`2026-10-21T17:13:37+08:00` 仅执行：

```bash
systemctl --user restart bili-charge-live-34.service
systemctl --user restart bili-charge-live-34-web.service
```

两条重启命令正常返回。遵用户要求，未再检查服务状态、监听、页面或接口结果，故不宣称就绪检查/功能验证通过；未启动 collector，未操作原验收站。服务启动时正常读取既有私有 Cookie 配置，代理未读取或回显 Cookie 内容。

未暂存或提交，不清理/重置原有 #33 材料和用户未跟踪文件。状态：**代码修改及重启命令已完成，未经验证，真实新增 UP 是否成功/412 是否解除仍由用户自行验证。**
