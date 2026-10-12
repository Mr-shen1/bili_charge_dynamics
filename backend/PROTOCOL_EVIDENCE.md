# 02 协议静态依据（虚构 fixture 的结构边界）

本次只静态读取本机 ignored 参考的无敏感函数局部；未读取 Cookie、密钥或通知配置，未执行/导入原脚本，未访问网络。原参考不作为运行依赖，以下无敏感字段和 tracked fixture 才是可复现依据。既有实际请求证据见 [backend-feasibility](../docs/backend-feasibility.md)，不能将 fixture 当作真实上游可用性证明。

## 指定动态

`GET https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=…`，读取 `code`、`data.item`，要求 `item.id_str` 匹配请求。`modules.module_author.mid` 用于确认归属。指定脚本要求有效的 `basic.comment_id_str` 和正整数 `basic.comment_type`，未知定位保持未知，不凭空猜测。依据：本机 `script_demo/bili_charge_target_monitor.py:63-114`（ignored）。

## 正文与媒体

本机 `script_demo/bili_charge_monitor.py:265-302`（ignored）提供：

- `module_dynamic.major.type == MAJOR_TYPE_OPUS`：`opus.title`、`opus.summary.rich_text_nodes[].text`、有序 `opus.pics[].url`。
- `MAJOR_TYPE_DRAW`：`draw.summary.rich_text_nodes[].text`、有序 `draw.items[].src`。
- `MAJOR_TYPE_BLOCKED`：明确受限，`blocked.hint_message` 不是正文；不推断隐藏内容。其他不识别结构不能当成功空。
- `MAJOR_TYPE_ARCHIVE` 是视频，本票不扩展视频能力。
- `modules.module_stat.comment.count` 是来源计数，不是本地采集数量。

上述 OPUS `summary` 仅是摘要，不能当全文。后续核对公开固定快照的 CONTENT/TITLE 模块结构，完整正文只由安全页面初始化数据中受支持的有序段落确认，缺失或未知段落保持失败/待处理；具体 WORD/RICH/PIC 路径及引用见 [dynamic-protocol-fields.md](../docs/dynamic-protocol-fields.md#页面全文与标题结构)。

原参考上述局部未确认作者昵称、头像及图片尺寸映射。随后通过公开 Git 固定快照核对 `module_author.name/face`、OPUS `pics[].width/height` 和 DRAW `items[].width/height`，具体引用与证据边界见 [dynamic-protocol-fields.md](../docs/dynamic-protocol-fields.md)。缺字段仍保持未知，不能把虚构数据补齐当作真实字段保证。

## HTML 编辑信号

原脚本没有 HTML 编辑时间解析；依据仅来自 `docs/backend-feasibility.md:69-97` 记录的一次 `/opus/{id}` 页面样本。初始化数据结构是 `__INITIAL_STATE__.detail.id_str`，`detail.modules[]` 按 `module_type == MODULE_TYPE_AUTHOR` 找作者的 `module_author.mid/pub_time/pub_ts`，按 `MODULE_TYPE_STAT` 找 `module_stat.comment.count`。编辑文案示例“编辑于 2026年10月09日 13:01”，普通详情同一 `pub_ts` 的普通时间为“2026年10月09日 10:38”。

安全提取 JSON，不执行脚本，不固定 script 标签或数组下标。缺标记是未知，不是未编辑；无效日期/非 JSON 是错误，不覆盖旧可信值。发布时间与编辑时间独立。`opus/detail` JSON 曾返回412，不依赖该接口。

## 验证范围

fixture 所有身份、内容、媒体 URL、错误秘密均虚构；结构保持不代表覆盖全部上游变体。`BLOCKED` 仅限制正文，不能据此跳过将来的独立评论读取。本票不采评论、不上传媒体、不访问真实来源，不宣称长期稳定或全部归档完成。
