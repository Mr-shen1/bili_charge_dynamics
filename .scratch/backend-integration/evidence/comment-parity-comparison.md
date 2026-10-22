# 评论采集与参考脚本的完整调用链对照

> 本文是实施前静态快照。随后已按用户授权修改评论 I/O、预热和 locator 策略，见[Requests 实施记录](comment-requests-implementation.md)；下面“当前实现”指调查时版本，不应视为修改后的现状或验证结果。

## 范围

本次以用户提供且已在线上正常运行的 `script_demo/bili_charge_monitor.py` 为行为基线，比较当前根评论、楼中楼采集的参数定位、会话及传输配置、分页与保存语义。不读取或记录凭据，不运行测试、构建、额外真实请求或数据库写入。

“脚本在用户环境可用”与“相同目标、相同 Cookie、相同网络条件下两个客户端返回相同结果”不是同一个证据；本次不将前者冒充受控对照结果。

## 已有真实证据（本次未重放）

- collector 的固定节拍日志持续安排工作，`sync_started` 和新的 attempt 表明任务确实被领取；不是已确认的“不重试”。
- 首次真实根评论首页请求返回 HTTP 200，但 `page.num/size/count/acount` 都为 0、`replies` 为 null；当时解析器在页码/页大小校验处失败。
- 请求配置对齐后的日志仍报告 `comment_page_mismatch`。这证明失败位置，不等于证明上游返回全零的根因。
- 最近一次独立 nav 请求 HTTP 200，但未取得明确的 `data.isLogin` 布尔值，也未确认业务成功；登录状态仍未知。HTTP 200 或预热日志 `succeeded=true` 不能被解释为已登录。
- 正文受限与根评论返回异常是独立结果，不能仅凭前者断定评论没有权限，也不能承诺有 Cookie 就一定可读。

## 逐项对照

完整原文引用与条件分支分别记录在：

- [定位、参数、分页与数据语义](comment-parity-parameters.md)
- [Cookie、请求头、初始化与传输栈](comment-parity-session.md)

| 层级 | 参考脚本 | 当前实现 | 判定 |
| --- | --- | --- | --- |
| 根/回复 endpoint 与分页参数 | x/v2/reply、x/v2/reply/reply；pn、ps=20、sort/root | 相同路径及主要参数形状 | 不能据此推断实际 locator/会话相同 |
| 评论 locator | 从 WBI feed item 的 basic 获取，缺失按 OPUS/动态ID回退 | 从已校验 detail item 的 basic 获取，无猜测回退，复用已存 locator | 输入来源和回退不同；同目标的实际值尚未比较 |
| Cookie 输入 | BILI_COOKIE 环境字符串，名称和值分别 strip | 私有文件，严格校验，pair strip但值未单独strip | 凭据本身未读取，无法确认同输入 |
| jar 域/path/编码 | .bilibili.com、默认/、不URL编解码 | .bilibili.com、/、不URL编解码 | 大体对齐，不宜把所有问题归于 CookieJar 库不同 |
| 会话生命周期 | 每轮 create_session 重建 | 每进程长期复用、启动读文件一次 | 未对齐，来源 Set-Cookie 更新/删除后行为可不同 |
| 会话预热 | 首页与 UP 空间页 | 惰性 nav | 明确未对齐；之前把 nav 称为脚本预热是错误 |
| nav 的角色 | BiliWbi 首次签 feed 时取密钥 | 当前作为评论链的 HTTP best-effort 预热 | 角色混淆，HTTP200不代表登录成功 |
| 普通请求头 | 全局 JSON Accept、UA/语言/Origin/UP Referer | 评论头大体相同，但 www Accept 被改写为HTML | 预热及最终发送头仍不同 |
| 网络与代理 | Requests Session 默认 trust_env=True、GET跟随重定向 | 显式 HTTPX transport 与client均禁用环境配置、不跟随重定向 | 明确策略差异；实际代理/出口未知 |
| 根分页 num/size/acount | 不校验num；size为0回退20；不读acount | num/size严格匹配；acount存在时严格校验 | 当前失败的直接触发点，但不解释上游为何全零 |
| 全零首页 | count=0时可结束，来源总数差异只warning | num=0,size=0时报错 | 脚本未报错不等于同一目标实际抓到评论，不应以假成功空“修复” |
| 条目容错与去重 | top/hots先到优先，跳无rpid条目，支持单图picture | 页内后到内容覆盖，条目校验严格，无单图picture回退 | 当前空页尚未走到这些分支，不是已证实本次原因 |

## 已纠正的前序结论

1. 参考 create_session 不是 nav 预热，而是首页/空间页。此前据不完整函数摘要做出的 nav 对齐不正确。
2. get_comment_target 没有 basic.comment_id 数值字段分支，只有 comment_id_str 及 OPUS/动态ID回退；不能把未存在的分支写成脚本行为。
3. 参考脚本对来源总数与首根页 count 不同只 warning；不能声称它会仅因541对0而拒绝。同一零响应也可能结束为0条，需控制实际目标才能验证用户所说的可用场景。
4. 最近 nav 诊断提前停止不是生产代码行为；当前生产仍会继续尝试根页。

## 优先结论

本次没有证明全零响应的根因。最重要的剩余差异是实际会话输入/生命周期、错误的预热路径、代理/出口，以及 feed/detail locator 来源；源码中明确相同的 endpoint 和普通头不足以排除这些差异。

若要真正复刻参考行为，应先以其实际 Requests Session 初始化和请求链为基线，明确 Cookie 私有输入与多UP适配，再决定沿用 Requests 还是适配 HTTPX。不要继续仅追加几项头就宣布完全一致；也不要直接打开未知代理、猜 oid 或放宽为假成功。下方 A/B 设计仅作为待授权的受限诊断方案，本轮没有执行。

## 下一步受控对照设计（尚未执行）

如果静态差异不能直接解释问题，应只针对同一目标做有限的客户端对照，而不是继续全量重试或只比较 HTTP 状态：

1. 两边共用同一已授权私有 Cookie 输入、同一 UP Referer 和同一 `oid/type/pn/ps/sort`，不换账号、不猜 locator；Cookie 内容不显示、不落入证据。
2. 一边复刻参考的 Requests Session 请求路径，另一边使用当前 HTTPX 路径。明确记录是否采用环境代理、重定向及会话预热，不把“URL 一样”当作网络上下文相同。
3. 只比较 HTTP 状态、业务成功/失败分类、分页数字和结构类型。若需检查 Cookie 序列化，只在内存中比较是否一致，不输出值或摘要。
4. nav 的 HTTP 成功与登录状态分开记录；参考生产流程忽略预热失败，不能把上次诊断的提前停止误写成生产行为。来源明确拒绝后不循环或换账号重试。
5. 如果两个客户端均返回异常空页，应优先核对目标/账号可见性和定位信息；如果只有某一边失败，再逐一隔离网络栈和会话差异。两类结果都不能预先宣称已发生。

## 结论边界

在没有控制目标、定位信息、会话和网络变量之前，不把 WBI、严格分页校验、Cookie 过期、访问权限或 HTTP 客户端差异中的任何一项宣称为已证实的根因；尤其不能将全零分页直接放宽成归档成功空。
