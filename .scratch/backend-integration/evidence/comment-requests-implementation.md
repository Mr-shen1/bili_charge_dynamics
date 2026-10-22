# 参考脚本式 Requests 评论链路变更

## 授权与范围

用户批准按完整对照结果修改现有实现。实现前的静态差异见 [完整对照](comment-parity-comparison.md)、[定位/分页](comment-parity-parameters.md)、[会话/传输](comment-parity-session.md)；这些记录描述修改前状态，不能当作新实现的验证。

本次只修改和重启后端，不运行测试、编译检查、代码审核、日志/数据库验证或额外真实请求。正常运行的 collector 会按新流程发起已启用目标的采集请求。没有清库、删归档、改监控启停、改OSS配置、重建前端或读取/记录实际凭据。

## 实现

- `backend/bili_monitor/comment_client.py`：每次正式独立计数检查或根＋回复采集尝试建立一个 Requests Session，使用线程池执行同步 I/O，同一 Session 串行使用，finally 关闭。构造工厂不触网。
- 按参考 `create_session` 依次 GET `https://www.bilibili.com/`、`https://space.bilibili.com/{uid}/dynamic`，各10秒，取得响应后异步等待1–3秒，每个URL独立忽略异常。采用普通参考头、15秒评论超时、标准Requests CookieJar和环境代理；nav不再作为评论预热，也不从HTTP200推断登录状态。
- Requests 的 `send` 在实际发送和重定向阶段校验：只允许 api/www/space 三个精确B站域的默认HTTPS端口GET，不允许URL用户信息。越界请求在发送前剔除Cookie并拒绝；与脚本无限制跳转有意不同，避免凭据外泄。TLS验证保留，环境代理实际是否配置本次未检查。
- `source_cookies.py`：仍从受限私有文件启动读一次，名称和值分别strip，不URL编解码；该不可变输入供每轮Session重新初始化，不直接使用参考脚本中的BILI_COOKIE或任何秘密。HTTPX信号客户端与各个Requests尝试的可变jar不共享。
- `source_client.py`：移除惰性nav预热与其全局缓存。普通HTTPX正文/detail/feed仍用原发送范围及代理策略；评论头和Referer在Requests自身会话中配置，不再被HTTPX网页Accept hook改写。
- `source_transport.py`：抽取共享SourcePacer，正式入口将相同pacer注入HTTPX transport与Requests工厂。feed等待0.8–1.5秒，根/楼中楼等待0.3–0.4秒；包括首页与空尾页。等待在事件循环，Requests网络在线程池；网络和数据库均不持有分页等待锁。独立计数和首页/空间预热不加入分页队列。
- `app.py`、`collector.py`、`sync.py`：正式入口显式注入评论工厂，计数/根/回复使用新会话，正文与媒体路径不变。根＋必要回复共用本次同一个Session。显式profile_transport注入且未提供评论工厂时仍走其HTTPX替身；直接Collector默认也使用传入client，不会静默绕过MockTransport出真网。只有I/O Adapter不同，协议解析与持久化不分叉。
- `pyproject.toml`/`uv.lock`：把已锁定的requests 2.34.2从OSS传递依赖补为显式直接依赖，不改变现有包版本或哈希，不执行依赖同步/安装。

## 定位、完整性与旧归档

- `source.py`：先验证目标动态ID和作者，再按参考选择合法basic.comment_id_str/comment_type；basic不可用时尝试同目标OPUS.id/type11，再动态ID/type11，保留合法ID/type校验。locator增加source和policy_version=1。
- `collector.py`：旧locator即使格式合法，缺当前策略版本也会在后续检查重读已校验detail核对；请求失败不伪造更新。`checks.py`对实际oid/type变化登记新revision/work，归档完成判断也核对资源身份，避免仅比较计数后漏掉定位变化。
- `sync.py`：资源身份改变后即使总数不变、旧评论成功，也重新扫描根/必要回复。`ROOT_METADATA_VERSION`从1升为2，使旧启用归档补采一次新链路，成功后不因版本差异每节拍重扫；停用目标不补采。没有数据库schema迁移，不改冻结cursor内容和顺序。
- fallback来源的根/回复条目必须明确带有匹配的oid/type，不能仅从count响应确认候选定位；fallback空集合不推进成功。观察总数为正但整轮扫描无根也保持未确认失败，不把541条来源对应的全零页放宽成成功空。
- 保留页码/大小、计数稳定、尾页复查、generation/claim/selection fencing。根content缺失/null兼容未知；空pictures支持参考picture单图对象回退。楼中楼已知根rcount时要求页count一致，变化留待新一轮重试。
- 日志新增comment_session_started、comment_session_warmup、comment_session_closed与locator刷新来源，保留固定失败分类，不记录Cookie、URL、账号/动态/评论ID、响应正文或异常原文。

## 未验证与保留差异

没有运行本地或真实回归，不能宣称已解决全零分页、权限或风控。Requests的环境代理/CA等标准行为与原HTTPX不同，实际网络出口未知。没有复制参考脚本的凭据、通知、原主循环、每日校准或feed WBI；feed签名遗漏仍是单独事项。默认独立计数仍是本项目额外读取，并未改成参考脚本的feed计数来源。部分协议校验有意严于参考脚本，尤其不把异常空页当成功。
