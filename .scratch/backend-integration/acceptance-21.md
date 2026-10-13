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
uv run pytest backend/tests/test_comment_media.py backend/tests/test_root_comments.py backend/tests/test_migrations.py backend/tests/test_dynamic_media.py -q
# 补强新失败交错前 92 passed
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

审查基线为 `9dc370cbb2de5f48791e55bb62dc5874875d4181`，将通过两位 `review` 子代理分别核验 Standards 与 Spec，结果及处理将在交付前补齐。

## 未验证及边界

- 不执行真实 OSS 操作、不读取真实凭据；模拟上传／真实 SQLite 不证明实际对象匿名可读、费用或长期稳定，真实云证据归 #34。
- 不交付 #22 图片 UI／预览／纯图展示、#25/#30 周期计数联动；本票没有 Playwright 或 Linux Chrome／iPhone Safari 真机图片证据。
- 不增加回复图片、对象回收、图片变体／压缩／CDN、物理去重、鉴权、备份或容量治理。历史关联、冻结页及被取代 I/O 的孤立对象可能增长。
- 评论计数不等于编辑版本，未知不补值；真实来源分页全量／权限与持续运行仍须独立证据。
- 重试／管理 API 无鉴权，公开 URL 可外链；隐藏入口不是保护。自动化不自动勾选父票或整个 AC 的全部验收。
