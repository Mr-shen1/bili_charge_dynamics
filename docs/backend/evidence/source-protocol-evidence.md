# 02 协议静态依据（虚构 fixture 的结构边界）

> 下文按票据保留当时的协议/fixture证据，不代表后续实现仍完全相同。当前 Requests 评论链路对照 `bili_charge_monitor.py:199-215,305-316,330-379`：每轮会话、首页/空间页预热、环境代理与私有Cookie输入；定位增加basic→OPUS→动态ID的带来源/策略版本回退，fallback需资源校验。当前契约以[归档接口](../api/archive-api.md#15-根评论契约)和[后端说明](../../../backend/README.md#来源-client-初始化)为准；对照与未验证范围见[本次变更记录](../../../.scratch/backend-integration/evidence/comment-requests-implementation.md)。本轮未执行参考脚本、测试或额外真实请求，旧“不加凭据/不猜定位”等表述仅说明当时实现，不能当作本次验证结论。

本次只静态读取本机 ignored 参考的无敏感函数局部；未读取 Cookie、密钥或通知配置，未执行/导入原脚本，未访问网络。原参考不作为运行依赖，以下无敏感字段和 tracked fixture 才是可复现依据。既有实际请求证据见 [backend-feasibility](backend-feasibility.md)，不能将 fixture 当作真实上游可用性证明。

## 指定动态

`GET https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=…`，读取 `code`、`data.item`，要求 `item.id_str` 匹配请求。`modules.module_author.mid` 用于确认归属。指定脚本要求有效的 `basic.comment_id_str` 和正整数 `basic.comment_type`，未知定位保持未知，不凭空猜测。依据：本机 `script_demo/bili_charge_target_monitor.py:63-114`（ignored）。

## 正文与媒体

本机 `script_demo/bili_charge_monitor.py:265-302`（ignored）提供：

- `module_dynamic.major.type == MAJOR_TYPE_OPUS`：`opus.title`、`opus.summary.rich_text_nodes[].text`、有序 `opus.pics[].url`。
- `MAJOR_TYPE_DRAW`：`draw.summary.rich_text_nodes[].text`、有序 `draw.items[].src`。
- `MAJOR_TYPE_BLOCKED`：明确受限，`blocked.hint_message` 不是正文；不推断隐藏内容。其他不识别结构不能当成功空。
- `MAJOR_TYPE_ARCHIVE` 是视频，本票不扩展视频能力。
- `modules.module_stat.comment.count` 是来源计数，不是本地采集数量。

上述 OPUS `summary` 仅是摘要，不能当全文。后续核对公开固定快照的 CONTENT/TITLE 模块结构，完整正文只由安全页面初始化数据中受支持的有序段落确认，缺失或未知段落保持失败/待处理；具体 WORD/RICH/PIC 路径及引用见 [dynamic-protocol-fields.md](dynamic-protocol-fields.md#页面全文与标题结构)。

原参考上述局部未确认作者昵称、头像及图片尺寸映射。随后通过公开 Git 固定快照核对 `module_author.name/face`、OPUS `pics[].width/height` 和 DRAW `items[].width/height`，具体引用与证据边界见 [dynamic-protocol-fields.md](dynamic-protocol-fields.md)。缺字段仍保持未知，不能把虚构数据补齐当作真实字段保证。

## HTML 编辑信号

原脚本没有 HTML 编辑时间解析；依据仅来自 `docs/backend/evidence/backend-feasibility.md:69-97` 记录的一次 `/opus/{id}` 页面样本。初始化数据结构是 `__INITIAL_STATE__.detail.id_str`，`detail.modules[]` 按 `module_type == MODULE_TYPE_AUTHOR` 找作者的 `module_author.mid/pub_time/pub_ts`，按 `MODULE_TYPE_STAT` 找 `module_stat.comment.count`。编辑文案示例“编辑于 2026年10月09日 13:01”，普通详情同一 `pub_ts` 的普通时间为“2026年10月09日 10:38”。

安全提取 JSON，不执行脚本，不固定 script 标签或数组下标。缺标记是未知，不是未编辑；无效日期/非 JSON 是错误，不覆盖旧可信值。发布时间与编辑时间独立。`opus/detail` JSON 曾返回412，不依赖该接口。

## 15 根评论协议

新增实现仍只使用虚构 JSON 和外部 transport 替身，不请求真实上游、不读取凭据、不执行 ignored 脚本。静态依据：

- ignored `script_demo/bili_charge_monitor.py:330–347,382–407,536–631,817–831`：旧 `/x/v2/reply` 页码参数、条目／图片映射、动态计数口径 caveat、置顶和热评；指定定位沿用 `bili_charge_target_monitor.py:99–114`。
- 公开第三方固定快照 `cfc5fddcc8a94b74d91970bb5b4eaeb349addc47`：[list.md](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/comment/list.md#L5-L62) 列出 `/x/v2/reply`、oid/type/pn/ps/sort 和 `page.count/acount`；[readme.md](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/comment/readme.md#L42-L90) 定义字符串 ID、关系、ctime/like/rcount/member；[图片字段](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/comment/readme.md#L220-L231) 为 content.pictures 的 img_src/img_width/img_height。
- 同快照 [list.md:859–966](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/comment/list.md#L859-L966) 将裸 `/reply/main` 标为旧地址，替代 `/reply/wbi/main` 使用签名及游标；本票不臆造裸 main 的当前游标保证、不增加 WBI／凭据配置。

文档把旧 `page.count` 定义为根数、`acount` 为总数，但 ignored 脚本指出动态场景口径可能不同；有限实际样本也未证明跨接口恒等。实现不以 count 推根页数，不把 acount 或本地数覆盖动态 module_stat 总数；要求有效分页响应，逐页直到空页（非首屏的候选空尾页再读同页确认）并检测计数变化／重复页。该终止协议只能描述当轮接口读至耗尽，不保证并发来源更新下完整快照。

`backend/tests/fixtures/root-comments.json` 是结构真实、身份／内容虚构的原始输入：动态 123 的定位 oid=99123/type=17，两个根、总数 7、回复数 5、置顶／热评结构及有序图片；测试基于该原始协议结构构造多页、空、拒绝、缺失及 45 根排序样例。不是抓取真实响应，也不是匿名可用性证据。固定文档提到 Cookie／APP 认证，本票生产传输不添加凭据；匿名可用性、各类型计数、真实全量及长期可用性仍未验证。

## 17 楼中楼协议

通过 searchcode 核对公开镜像快照 SHA 与既有 commit `cfc5fddcc8a94b74d91970bb5b4eaeb349addc47` 一致。固定 [list.md:1559–1637](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/comment/list.md#L1559-L1637) 定义 `/x/v2/reply/reply` 的 oid/type/root、pn、ps 和 data.page/root/replies；page.count 是该根二级评论数，不是页数。ps 请求20，每页最多20，按必要分页遍历，不用根页三条预览替代。

同快照 [readme.md:47–90](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/comment/readme.md#L47-L90) 定义 rpid_str/root_str/parent_str、ctime/like/member；[readme.md:220–234](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/comment/readme.md#L220-L234) 的 content.members 是 @ 提及者，不是 parent 作者。目标仅通过同根 parent 关联条目 member 解析，跨页在本地完整集合关联，缺失则未知。

`backend/tests/fixtures/replies.json` 为结构真实且身份／内容虚构的固定输入，含大字符串 ID、直接回复根、回复另一回复、目标缺失和 @ 提及者。公开 initial 经生产解析写入真实 SQLite，测试构造25条、多页失败和重开读取。生产传输不增加 Cookie、APP 认证或绕权；第三方文档标注认证方式不证明匿名可用性。来源扫描不是并发事务快照，真实全量、计数口径和长期可用性未验证。

## 25 独立评论计数

固定第三方镜像快照 `cfc5fddcc8a94b74d91970bb5b4eaeb349addc47` 的 [list.md:3667–3719](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/comment/list.md#L3667-L3719) 定义 `GET /x/v2/reply/count`、必填 `oid/type`，成功响应 `{code:0,message,ttl,data:{count}}`，标题为“评论区评论总数”。本次经 searchcode 核对固定快照；没有独立 `docs/comment/count.md`。沿用已经过作者校验的 `basic.comment_id_str/comment_type` 定位，不将动态 ID 当评论 oid，不根据未验证类型表增加白名单。

实现保留独立请求，以 `data.count` 保存来源评论区总数信号；只接受 code 严格整数 0、count 严格非负整数。业务拒绝、网络／HTTP／JSON／字段失败不归零，也不回退到网页 STAT 或根页 count/acount 伪装读取成功。来源、本地根数、本地回复数与成功处理计数分别保存；原有根／回复分页继续各自校验，不假定它们与独立总数永久相等。

`backend/tests/fixtures/comment-count.json` 是结构保持、内容虚构的独立响应（count=7）；配合既有两根／五回复原始 JSON 经 T3→SQLite→HTTP 核验字段映射与版本提交，另以来源总数大于实际可读集合验证部分归档。fixture 不计算或从分页条数生成来源信号，不把人为一致的数字当成真实上游口径证据。

**证据限制：**第三方 count 字段说明只写“评论条数”，未明确枚举“根＋全部回复”；静态示例与列表示例也不是同一时点的事务快照。历史 235/501 样本只证明当次跨接口数字一致，不能证明精确包含范围、所有类型／权限下的等价、当前匿名可用性或真实全量。因此本票实现来源总数信号的结构映射和调度协议，不宣称已实测验证普遍根＋回复口径，不省略独立计数读取；精确计数口径与持续真实来源证据仍由 #34 限定授权核验。未请求真实 B站、未运行参考脚本、未读取任何凭据。

## 27 近期 feed 发现

开工时实际可读的 ignored 参考为 `script_demo/bili_charge_monitor.py:220–262`，本次仅静态核验必要函数，未执行/导入通知脚本、未读取凭据/配置。`fetch_dynamics` 使用 `/x/polymer/web-dynamic/v1/feed/space`、host_mid 与 offset，读取 data.items/has_more/offset；has_more 为真且无 items 或 offset 报分页不完整。原函数按原始候选数 max_items 截断，不能直接当作“凑 N 条合格目标”。

原 `is_charge` 的两条 OR 规则为 `module_author.icon_badge.text == "充电专属"` 或 `module_dynamic.major.type == "MAJOR_TYPE_BLOCKED"`；没有正文关键词、OPUS/DRAW 类型、图片存在等条件。原 `1942–1949` 按数字 ID 升序处理已筛候选，是旧通知处理次序，未定义近期窗口算法；本票按来源顺序取首次出现的合格项，达到 N 停止，不新增 ID/时间排序或类型过滤。带标记的未知内容类型仍可成为候选，归档读取支持与候选资格不混同。

公开第三方固定快照的空间动态字段链接及有限首屏证据见 [backend-feasibility.md](backend-feasibility.md)：历史只读到首屏、没有请求第二页，不能据此证明实时跨页行为。新增 tracked `backend/tests/fixtures/recent-feed*.json` 保留 code/data/items/modules/has_more/offset 结构、两种标记、可选字段、重复候选、普通项和大字符串 ID；身份、文字、游标均虚构。公共发现读取及 Collector→SQLite→HTTP 用这些协议输入验证累计和失败，不依赖本地 ignored 材料运行。

原脚本通过 WBI 签名请求；本票沿用当前生产无凭据 HTTP transport，仅发送公开协议参数，不增加 WBI、Cookie、风控绕过或解锁逻辑。请求被拒绝如实失败，不替代识别、不伪耗尽。来源次序可能含置顶，扫描不是上游事务快照，不宣称按发布时间排序、并发更新下不漏项、真实匿名多页或长期可用；这些需要 #34 限定授权证据。完整错误与分页终止语义见 [近期发现契约](../api/discovery-api.md)。

## 30 分页等待参考

仅静态读取 ignored `script_demo/bili_charge_monitor.py:220–253,542–655,802–834` 的无敏感函数片段，未执行或导入。动态 feed 后续页前 `random.uniform(0.8, 1.5)`；根页翻页、空尾页复查及置顶／普通楼层读取回复后的等待为 `random.uniform(0.3, 0.4)`。飞书通知等待不采纳。

生产采用同区间的异步发送前等待，保守扩展到首页及每个楼中楼请求，并在同一来源客户端内共享等待机会，避免并发分页各自 sleep 后仍同时突发；不改原识别或分页终止规则。真实网络 I/O 和 SQLite 事务均不持有等待锁，轻量编辑／计数检查不排分页队列。两进程之间不共享限速，也不承诺不会被限流。固定节拍调度、失败保留与下一节拍重试语义不变，不接入原通知主循环、退避或每日校准。

`backend/tests/test_source_pacing.py` 使用原始虚构 feed／根回复 JSON，经公开发现／初始化／正式采集入口验证等待和归档；外部 sleep 与网络替身令测试无需真实等待。它不是实时上游限流阈值或持续运行证据。

## 验证范围

fixture 所有身份、内容、媒体 URL、错误秘密均虚构；结构保持不代表覆盖全部上游变体。`BLOCKED` 仅限制正文，不能据此跳过独立评论读取。02 阶段未采评论；15 增加根采集，17 增加必要回复分页；仍不上传媒体、不访问真实来源，不宣称长期稳定或全部归档完成。
