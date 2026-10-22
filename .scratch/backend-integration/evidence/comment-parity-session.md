# 评论采集对照：会话、Cookie 与真实发送路径

## 范围

由 Explore 子代理按当前工作树、参考脚本相关函数及已安装库的实现做静态对照，主线程整理落盘。没有读取凭据或配置内容，没有检查环境变量值，没有发请求或运行测试。以下行号对应调查时工作树。

## 1. Cookie 输入与初始化

参考脚本从 `BILI_COOKIE` 环境键取得原始字符串，见 `script_demo/bili_charge_monitor.py:68`。按分号拆分、首个等号分割，分别对名称和值 strip，再 `s.cookies.set(k, v, domain=".bilibili.com")`，没有 quote/unquote；见 `:199-208`。Requests 的 create_cookie 默认 path=/、secure=False、expires=None，使用标准库 Cookie。相同名称、域、path 后写覆盖前写。

当前读取 `BILI_COOKIE_FILE` 指向的私有文件，校验 ASCII、名称和控制字符，按原值放入 httpx.Cookies，域为 .bilibili.com、path=/，也不 URL 编解码。见 `source_cookies.py:61-75,89-101`。HTTPX 0.28.1 同样使用标准库 Cookie，默认 secure=False/expires=None。因此 jar 元数据大体相同，不能笼统声称 CookieJar 实现必然不同或必然相同。

仍有细节差异：参考对值单独 strip，当前仅整体 strip pair，`name= value` 等输入可能不同。没有读取文件/环境值，不能确认两边是同一凭据或凭据有效。

当前有 HTTPX 内置 jar 和闭包私有 jar 两份；请求 hook 删除内置 Cookie 头，再由私有 jar 生成，故最终发送不是合并两份头。私有 jar 接受允许来源的 Set-Cookie，同名域/path 更新或过期可改变初始文件值，不要求响应 HTTP 成功。见 `source_cookies.py:103-114`。

参考每轮 `create_session()` 新建 Session，从原环境输入重置；当前 API、collector 各有一个长期客户端，文件启动读一次。见脚本 `:2292-2293`、`app.py:53-60`、`collector.py:303-313`。这是明确的生命周期差异，而非“都是 Session 所以一致”。

## 2. 重要纠正：真正预热的是首页和空间页

参考 `create_session` 先装载 Cookie 和普通头，再依次 GET B站首页与 UP 空间页；成功取得响应后随机等待，不检查 HTTP/业务状态，异常吞掉。见脚本 `:199-215`。**这里没有 nav。**

nav 由独立的 BiliWbi 在第一次 enc_wbi 获取密钥时调用，并检查 JSON code；用于 feed，不是评论 create_session 预热。见脚本 `:148-194,220-254`。参考根评论与回复 GET 不签 WBI，见 `:330-378`。

调查时当前实现却在首次评论/独立计数请求前惰性 GET nav，失败不在该客户端重试，也不解析登录状态。见 `source_client.py:60-79`。检查顺序是先页面、必要时 detail，再 count/评论预热，见 `collector.py:117,133,141`、`root_comments.py:72-79`。所以此前把 nav 说成参考脚本的预热是错误的，且当前并未复现首页/空间页预热。

当前生产代码不检查 isLogin，不因缺失而阻断采集；最近一次诊断因该字段缺失而提前停止，是诊断范围限制，不能误写成生产行为。nav HTTP200、isLogin 缺失和根评论异常空分页均不足以单独证明登录成功、未登录或权限不足。

## 3. 代理、TLS 与重定向

参考直接 requests.Session，没有显式 trust_env/proxies/verify/adapter 配置；默认 trust_env=True、TLS 校验启用、默认 adapter 网络重试为0。是否实际采用环境代理、netrc 或 CA 配置取决于运行环境，未查询。见脚本 `:201`。

当前 PacedSourceTransport 包装显式 `httpx.AsyncHTTPTransport(trust_env=False)`，客户端本身也 trust_env=False/follow_redirects=False。见 `source_transport.py:23-36`、`collector.py:307-310`。因此代理/出口可能与参考不同；只改 AsyncClient.trust_env 不能保证已封装的底层 transport 使用代理，需要在实际发送层配置。Requests 默认跟随 GET 重定向，当前明确禁止。

两者默认 HTTP/1.1，不能凭客户端名称猜测为 HTTP/2 差异。均验证 TLS，但使用不同传输栈。代理变量是否存在、两者实际出口是否相同，本次未知。

## 4. 普通头与自动头

参考普通 HEADERS 包括 UA、JSON Accept、语言、单一 UP Referer 与 Origin，见脚本 `:132-138`。当前 UA/语言/Origin 及评论 API Accept 已对齐，Referer 按当前 UP 生成；见 `source_client.py:22-47`。但 www 请求的 Accept 会被 hook 改为 HTML，而参考 session 的全局 Accept 是 JSON；参考首页/空间页预热也未被复现。

两者均未在业务代码显式给 Accept-Encoding，其实际值取决于库版本和可用解码器，不能静态认定线上字节相同或不同。当前 HTTPX 固定0.28.1，见 `pyproject.toml:7`、`uv.lock:427-428`；用户运行参考脚本时的实际 Requests 版本未确认。

## 5. 优先排查顺序与边界

1. 实际出口/代理：确定存在默认策略差异，但是否启用代理未知。
2. Cookie 来源、解析和生命周期：当前与参考未控制为同一输入；不能用“配置了Cookie”代替登录和可见性证据。
3. 预热 URL、顺序与重定向：明确没有对齐，应纠正此前错误结论。
4. 最终自动头、jar 更新及底层传输：需要在发送边界做脱敏受控比较，不只看 headers 字典。

尚未执行 A/B。若后续获授权，应固定同一目标 oid/type、Cookie 输入、普通头、Accept-Encoding、TLS、超时、重定向和出口，分别使用参考 Requests Session 与当前 HTTPX。只记录参数/头的相等性、状态、业务分类和分页结构；不输出 Cookie 值/摘要，不重试或更换账号，不把当前未知项写成根因。
