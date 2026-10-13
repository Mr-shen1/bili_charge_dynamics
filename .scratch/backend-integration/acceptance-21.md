# 21 一级评论媒体归档：实施与自动化证据

## 范围与公开契约

对应 [#21](issues/21-comment-media-archive.md)、[规格 I3/I4/I6/I7/I12 与已确认 T2/T3](spec.md)、[共同交付要求](implementation-plan.md#所有执行子票的共同交付要求)。正式契约见 [21 归档 API](../../docs/backend/api/archive-api.md#21-一级评论媒体归档与独立恢复)，运行见 [后端 README](../../backend/README.md#21-一级评论媒体)。

从结构真实、内容虚构的根评论 JSON 解析有序 pictures，真实 SQLite 持久化评论自己的媒体组；共用 #19 下载、上传、URL 校验、错误及尝试令牌机制，不复制 OSS 实现。根／必要回复先提交，媒体独立完成；正文受限／网页无权不阻断实际可读评论图。仅一级评论图，回复及内嵌预览图不采集。

新增 `POST /api/sync/media/{dynamicId}/comments/{rootId}`，可按 `media_id` 独立选择一张图；不会重读正文／根页／计数。RootComment HTTP 保存 `media`、`previous_media`、媒体状态及实际版本／checkpoint；pending 和 failed 仍有媒体存在性与顺序／尺寸，只有已接受的成功项提供完整公开 URL，无 B站业务图回退、代理或前端拼接。动态／根／每图分项状态不混用。

版本绑定本轮根同步开始处理的动态来源计数（`comments:<count>`，未知为 null），不声称有评论编辑时间。新计数观察先持久保存，根页失败不清媒体或推进假成功；旧版本显式完成可推进旧 checkpoint，但不清新工作。相同版本／位置／来源重复同步复用关联；新计数版本即使同 URL 也新建关联，缺失 pictures 保留旧组，明确空数组才确认空。数量抵消、纯编辑及同计数同 URL 下字节变化可能漏检，不增加哈希／差异检测或周期触发器。

## 公开自动化覆盖

`backend/tests/test_comment_media.py` 使用外部来源 HTTP／图片下载 transport 和模拟 OSS，SQLite 与应用真实运行；不用真实 Cookie／上游／OSS，不读取仓库外凭据。测试仅从公开执行入口和 HTTP 观察，不断言内部 SQL／锁／线程数。固定 v8 SQL 是迁移输入，不从当前 Store 导出。

| 要求 | 验证结果 |
| --- | --- |
| JSON→媒体→SQLite→HTTP | 空正文根评论保存全部有序媒体／尺寸／来源／owner／公开 URL，重复同步和重开不重复关联或丢顺序 |
| 跨 owner 隔离 | 动态 ID 和根 ID 相同、两个根共用来源、两个动态下同根 ID 均独立；错误 owner 的媒体选择返回 404 |
| pending 与纯图语义 | 未配置 OSS 保留 null URL 及完整媒体，根／回复已成功但每图仍 pending；12 图不以九格截断，缺尺寸仍 null |
| 单图失败与独立重试 | 下载／上传失败仅影响对应图，固定错误无秘密；其他成功图与评论 checkpoint 保留，无新计数 initial 重试、重开后的单图／整组运维重试均可完成 |
| 实际版本与旧成功保留 | 新计数同 URL 重新上传，旧成功进入 previous_media；新组失败不冒用旧 URL，缺失 pictures 不擦旧组，明确空组成功 |
| 新观察但根页失败 | 旧媒体可完成旧 checkpoint，但 HTTP 新工作仍 pending，根失败保留旧成功计数，不推进假成功 |
| 迟到完成 | 下载／上传暂停，旧成功／失败与新版本／同关联新尝试、新成功／失败交错；旧结果不改新关联／错误／工作，PUT key 不同 |
| 慢 I/O 与分项提交 | 首次评论上传暂停时，正文／根／回复已成功且动态图状态独立；另一应用 SQLite HTTP 读及配置 PATCH 可完成，不检查锁实现或时间阈值 |
| 重开／进程退出 | 在评论 OSS 外部边界终止子进程，重开可读 pending，重新领取完成并保持关联 ID，不暴露内部尝试字段 |
| 回复图排除 | 原始实际回复与内嵌预览均携带图片，未下载／归档，回复文本和完整计数仍可读 |
| 生命周期保留 | 停止、删目标、删配置及重开后评论／动态图与公开 URL 仍在，不继续 initial 领取 |
| 迁移与冻结页 | v8→v9 回填根 pending，不改旧正文／动态图／根内容；旧计数 checkpoint 不冒领新观察，旧根 cursor 在上传与重开后完整不变 |
| 输入与安全 | 只接受该 owner 当前媒体 ID，非法／未知／重复 query 拒绝；虚构下载／OSS 秘密不入 HTTP／日志，未上传无业务来源图回退 |

## TDD 与回归记录

首个 JSON 贯通测试 RED：根 HTTP 缺 `work.media`；owner-aware 的共用媒体协议实现后 GREEN。独立恢复测试 RED：评论媒体路径尚不存在；新增明确 owner 路由后 GREEN。新计数但根页失败测试 RED：根观察停在旧 `comments:7`；改为计数观察独立持久化后 GREEN，旧组完成仍不能清 `comments:8` 工作。后续逐切片验证复用能力、版本／尝试交错、回复排除、关库重开与迁移；旧根精确 DTO 回归补齐新增字段及媒体断言，schema/future 预期更新至 v9/v10，未删除既有断言。

已执行切片命令：

```sh
uv run pytest backend/tests/test_comment_media.py -q
# 29 passed
uv run pytest backend/tests/test_comment_media.py backend/tests/test_root_comments.py backend/tests/test_dynamic_media.py backend/tests/test_migrations.py -q
# 审查补强后 100 passed
pnpm typecheck
# 切片期间多次 passed（Node 经 nvm use）
```

实施完成后全量回归：

```sh
uv run pytest backend/tests -q
# 274 passed
pnpm typecheck
# passed
pnpm test
# 20 files / 200 tests passed
pnpm build
# passed
git diff --check
# passed
```

项目无 Python 专用静态类型检查配置；Python 使用 uv，Node 使用 nvm，前端脚本使用 pnpm。上述前后端全量自动化不包含 Playwright／真机／真实上游／OSS 验证。

## 双轴审查

基线 `9dc370cbb2de5f48791e55bb62dc5874875d4181`，命令 `git diff 9dc370cbb2de5f48791e55bb62dc5874875d4181...HEAD`，初审提交 `ed66141`。两位 `review` 子代理并行分别核验，不合并／跨轴重排。

### Standards

明文硬违规 0，判断项 6：两个 HTTP 重试边界有相似参数校验／委派；评论版本编码与 pending 规则重复；新观察逐根回填增加事务规模；owner 在 API／SQL／DTO 采用不同表示及键形状；旧根 DTO 测试采用字段排除集；动态读取与 owner-aware 读取有一行查询重复。

已统一版本编码与 `_observe_root_media` 规则；新观察只更新观察确实变化的根，避免重复全量 JSON 写回；根 DTO 恢复完整精确断言并验证不透明媒体 ID 格式。保留根观察与动态观察的同一原子事务，不能拆成两次提交引入旧上传误清新工作的窗口；事务中没有外部 I/O，根数相关数据库成本仍不作容量承诺。保留两个明确 HTTP owner 边界的局部校验，它们共享唯一上传协调器，不为两行相似校验增加纯转发 handler。owner 的 None／空根 SQL 标识仅在仓储边界映射，不引入额外类型框架；媒体关联 ID 为独立 UUID，`(dynamic_id,media_id)` 已唯一，root_id 作为归属条件及清理范围，未以来源评论 ID 作媒体主键。一行既有动态读取 SQL 的局部重复不另建空抽象。

二次 Standards 复核范围 `git diff ed66141...HEAD`（补强提交 `934a8d8`）：0 硬问题，确认共享编码／观察规则、只写变化根、原子提交及完整 DTO 已修正。新增 2 个低影响判断：SQL 过滤与 Python 状态规则需保持同一不变量；随机媒体 ID 的精确 DTO 使用响应取样值。已补状态不变量注释；不透明随机 ID 无固定字面量，独立 32 位十六进制格式断言保留，其他字段仍精确断言。本次只读审查未独立重跑测试，运行证据由执行记录提供，不将该限制算作功能缺陷。

### Spec

确证缺陷 0，范围扩张 0；核实实际版本、独立观察／checkpoint、缺失／空来源、版本／尝试 fencing、跨 owner、网络短事务、保留、迁移／冻结页及评论先完成。判断／边界提醒 3：计数未知时媒体可成功但没有可信版本；空组无上传也成功及新观察与旧 media_last_attempt 并置；历史成功关联增长。

正式 API 契约补明：计数未知不阻断实际可读图片归档，媒体成功不代表计数观察成功，checkpoint 保持 null；明确空组是来源确认成功空，不需要网络上传；旧组实际结果须与当前 work.media 一起判断。历史关联增长为已接受的无回收边界，不增加治理范围。

二次 Spec 复核同一补强范围：0 确证缺陷、0 范围扩张，确认观察／协调顺序改变与过滤未变根保持 fencing 和 pending 语义，未知／空组语义及契约澄清准确。提出固化过滤不变量的测试建议；现有无新计数重试、重复同步／缺失 pictures、失败与版本交错均通过公开 HTTP 覆盖该路径，没有新增私有测试 seam。

初审分轴总结：Standards 0 硬问题／6 判断项（主要为重复状态规则和事务规模）；Spec 0 确证问题／3 边界提醒（主要为未知计数与实际媒体成功的区别）。已处理主要规则重复、无变化写回和 DTO 精确断言，其余低影响取舍与风险如上保留。审查补强后专项／根／动态／迁移 100 项及 TypeScript typecheck 通过。最后再次执行后端全量 274 项、前端全量 200 项、typecheck、build 与 diff 检查，全部通过；票据已转 `ready-for-human`，待人工核验。

## 未验证及边界

- 不执行真实 OSS 操作、不读取真实凭据；模拟上传／真实 SQLite 不证明实际对象匿名可读、费用或长期稳定，真实云证据归 #34。
- 不交付 #22 图片 UI／预览／纯图展示、#25/#30 周期计数联动；本票没有 Playwright 或 Linux Chrome／iPhone Safari 真机图片证据。
- 不增加回复图片、对象回收、图片变体／压缩／CDN、物理去重、鉴权、备份或容量治理。历史关联、冻结页及被取代 I/O 的孤立对象可能增长。
- 评论计数不等于编辑版本，未知不补值；真实来源分页全量／权限与持续运行仍须独立证据。
- 重试／管理 API 无鉴权，公开 URL 可外链；隐藏入口不是保护。自动化不自动勾选父票或整个 AC 的全部验收。
