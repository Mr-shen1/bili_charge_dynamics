# 动态作者与媒体字段依据

本次只查公开 Git 文档，未请求真实上游、未读取 Cookie。通过 searchcode 核对第三方镜像 `alittlehuaji/bilibili-api-collect-mirror` 的固定快照 `cfc5fddcc8a94b74d91970bb5b4eaeb349addc47`。这些字段表和响应示例不是 B站官方稳定保证，与 [backend-feasibility.md](backend-feasibility.md) 的有限实测分开。

| 信息 | 字段路径 | 固定快照依据 |
| --- | --- | --- |
| 作者昵称、头像 | `data.item.modules.module_author.name`、`.face` | [detail 示例 L150–180](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/dynamic/detail.md#L150-L180)、[作者表 L71–100](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/opus/features.md#L71-L100) |
| OPUS 有序媒体 | `module_dynamic.major.opus.pics[]` 的 `url`、数值型 `width`、`height` | [space 示例 L247–281](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/dynamic/space.md#L247-L281)，尺寸来自样例，字段表只定义 pics 数组 |
| DRAW 有序媒体 | `module_dynamic.major.draw.items[]` 的 `src`、数值型 `width`、`height` | [字段表 L386–405](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/dynamic/all.md#L386-L405)、[detail 示例 L195–230](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/dynamic/detail.md#L195-L230) |
| OPUS 摘要 | `opus.summary.text` 字符串、`opus.summary.rich_text_nodes` 数组；节点含 `orig_text`、`text`、`type` | [字段表 L527–542](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/dynamic/all.md#L527-L542)、[节点类型 L1–70](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/opus/rich_text_nodes.md#L1-L70) |

已知字段缺失或类型无效应保持未知/失败，不把未知主体当成功空，不臆造尺寸或地址。附加未知字段可忽略；昵称/头像允许缺失并使用页面身份兜底。媒体来源只是后续上传工作 metadata，不作为本票生产业务图 URL。

## 页面全文与标题结构

- [CONTENT 字段表 L648–697](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/opus/features.md#L648-L697) 支持 `MODULE_TYPE_CONTENT.module_content.paragraphs[]`：`para_type=1` 文本，`text.nodes[]` 的 WORD 节点读取 `word.words`，RICH 节点读取 `rich.text`（[示例 L955–971](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/opus/features.md#L955-L971)）；`para_type=2` 图片，`pic.pics[]` 含 `url/width/height`（[字段表 L733–748](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/opus/features.md#L733-L748)）。尺寸可能为 null。
- [TITLE 字段表 L35–48](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/opus/features.md#L35-L48) 支持 `MODULE_TYPE_TITLE.module_title.text`，与 CONTENT 独立。
- 段落还列有类型 3–7，未支持的段落/节点不能静默丢失后标记全文成功。
- `major.opus.summary` 明确是独立摘要对象；文档没有保证它等于全文。HTML 全文缺失/不支持时，不得用摘要回退并推进正文成功 checkpoint。

这些公开文档描述 opus/detail JSON 的模块结构，不是当前 SSR HTML 的官方契约；仅佐证已记录 HTML 样本所用的结构，不访问该曾返回412的接口，也不证明所有网页提供完整内容。

编辑信号依据仍只来自普通页面 HTML，见 [source-protocol-evidence.md](source-protocol-evidence.md)，不改用通用 detail 的显示时间，也不依赖曾返回412的 opus/detail JSON。
