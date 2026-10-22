# 评论采集对照：定位、参数与分页语义

## 范围

根据 Explore 子代理对当前工作树及参考脚本相关函数的静态对照整理。未运行测试、构建、真实请求、日志或数据库查询；未读取或记录 Cookie、OSS 或脚本凭据。原文行号对应本次调查时的工作树。

## 1. locator 来源不同，不能只看参数名称

参考脚本 `get_comment_target` 只优先读取 `basic.comment_id_str`，没有 `basic.comment_id` 分支。`cid = basic.get("comment_id_str", "")`、`ct = basic.get("comment_type", 11)`，仅当 cid 为 truthy 时返回；否则依次回退 OPUS 的 `major.opus.id/type=11`、动态 `item.id_str/type=11`。显式 null 不等同键缺失：truthy cid 配 null type 会原样返回，脚本不做当前项目的严格类型校验。见 `script_demo/bili_charge_monitor.py:305-316`。

参考输入来自 WBI 签名后的 feed，见脚本 `:220-253`。当前指定模式从 `/x/polymer/web-dynamic/v1/detail` 获取 item，先检查动态 ID 与作者，再只取 `basic.comment_id_str/comment_type` 生成合法 locator，不猜 OPUS 或动态 ID。见 `backend/bili_monitor/source.py:207-245`。管理阶段只验证作者，不保存 locator；检查会复用已存格式有效的 locator，缺失才取 detail。见 `app.py:131-140`、`source.py:121-136`、`collector.py:125-145`。

`valid_locator` 只证明格式合法；`oid != dynamicId` 既不证明错误，也不证明定位正确。只有实际条目带 oid/type 时才有进一步资源核验；异常空页没有条目可核验。见 `root_comments.py:23-34`。当前尚未控制同目标 feed/detail 输入来比较二者实际选出的 locator。

## 2. endpoint 和主要参数一致

根评论都使用 GET `/x/v2/reply`，参数 oid/type/pn/ps=20/sort=0；楼中楼都使用 GET `/x/v2/reply/reply`，另传 root、不传 sort。见 `root_comments.py:90-94`、`replies.py:25-29`、脚本 `:330-379`。参数名称和值形状一致不证明定位值或会话一致。

## 3. 最关键的解析差异：全零页

当前 parser 要求 page.num 精确等于请求页码、size 精确等于20、count 为非负 JSON 整数；acount 可缺失，但存在时不能为 null。给定首页 num=0,size=0,count=0,acount=0,replies=null，会在第一个页码校验处失败，尚未保存首页条目。见 `root_comments.py:99-115`、`collector_logging.py:21-43`。

参考 `_page_info` 不检查 num；size 缺失/null/0 回退 PAGE_SIZE，不读取 acount。`module_stat.comment.count=541` 与根页 count=0 的差异只 warning，不据此失败。首屏 total_snapshot=0 且普通回复为空时直接结束，不做尾页复查；之后仍处理第一页 top/hots，若也为空则不会处理任何根。已有进度对 audit/最终持久化的影响另依状态，不能推断。见脚本 `:502-512,526-631,744-754,798-834`。

所以：**参考脚本在同一全零响应上不报 page mismatch，不等于它抓到了评论。放宽当前校验只能让零页被接受，不能让上游产生根数据。** 当前若 num/size 匹配而 count=0、top/hots 也为空，仍可能走成功空页，故不应继续放宽成假成功。见 `root_comments.py:133-143,168-206`、`storage.py:676-687`。

## 4. 条目去重与容错不同

- 当前 top/hots/replies 页内按 ID 去重，后出现的正文副本覆盖前面的内容；置顶观察独立保存，仅整轮成功后提交。参考先处理 top，再处理 hots/replies，先遇到的副本保留。见 `root_comments.py:116-143`、`storage.py:676-682`、脚本 `:643-655,818-831`。
- 参考跳过没有 truthy rpid 的条目，缺失/null content 当作空内容，并支持 picture 单图回退。当前要求合法根关系、content 对象与 ID；单条结构错误可导致整页失败；pictures=null 现按未知保留旧媒体，没有 picture 单图回退。见脚本 `:382-408`、`root_comments.py:28-69`。
- 对当前 replies=null 的页级返回，还没有执行条目解析，因此上述容错差异不能解释这一次全零页。

## 5. WBI 与权限的边界

脚本对 feed 签名，不对根评论和楼中楼签名；当前 feed 尚未签，但指定目标检查链不走 discovery，不能据此解释当前根首页。见脚本 `:220-253,330-379`、`discovery.py:69-80`、`collector.py:105-145`。

正文 restricted 与根评论读取相互独立：当前同步仍在正文后尝试根/回复。见 `source.py:246-250`、`sync.py:88-97`。nav HTTP200 但 isLogin 缺失，不证明已登录或未登录；预热代码并不阻断后续采集。见 `source_client.py:60-79`。

## 结论与下一步

根本原因尚未证明。需优先区分：①同目标在当前会话/来源条件下是否返回有效根数据；②detail locator 与参考 feed 实际定位是否相同。严格页码校验是已确定的失败触发点，不是上游返回全零的原因。

本次不改 parser、不发请求。后续受控对照应使用相同目标、相同凭据和定位输入，区分“脚本一般可用”与“脚本在这个确切场景成功”，不输出凭据或来源内容，也不把零页改成假成功。
