# 19 动态媒体归档：实施与自动化证据

## 范围与装配

对应 [#19](issues/19-dynamic-media-archive.md)、[规格 I3/I4/I7/I12 与 T2/T3](spec.md)、[共同交付要求](implementation-plan.md#所有执行子票的共同交付要求)。测试边界已由用户确认：公开同步→真实 SQLite→HTTP、独立媒体重试、可阻塞／失败下载与模拟 OSS。正文成功、媒体成功、评论成功分开。

已交付动态图来源组、全部有序媒体关联、旧成功保留、持久状态／checkpoint、独立单图重试、真实 OSS V4 适配器和 v8 迁移。契约见 [归档 API](../../docs/backend/api/archive-api.md#19-动态媒体归档独立重试与公开-url)，运行与凭据边界见 [后端 README](../../backend/README.md#19-oss-服务端配置)。未改生产 Adapter／页面图片映射（#20）、评论媒体 owner（#21）或周期调度（#23/#24）。

测试使用现有结构真实、内容虚构 HTML/JSON fixtures，图片 CDN URL 仅为协议占位；HTTPX 下载 transport 与 OSS 外部发送替身不访问真实上游。真实 SDK 测试拦截 `requests.Session.send`，使用虚构凭据检查 V4 Authorization、STS、PUT 对象 key 和 Content-Type；成功／拒绝均进入生产适配器与真实 SQLite，**不代表实际云上传证据**。

## 公开行为覆盖

`backend/tests/test_dynamic_media.py` 共 36 项（含参数化）：

| 要求 | 公开验证 |
| --- | --- |
| 来源协议→下载→模拟上传→SQLite→HTTP | initial 从 HTML CONTENT 解析 owner、来源／尺寸／顺序，HTTP 读取完整 URL、状态和实际版本；列表一致、关闭重开一致 |
| 正文与每张图独立 | 正文成功但第二张上传失败，其他图保留；正文不可用但 detail 来源可读时，媒体仍可成功；慢上传时正文与可读评论已提交 |
| 首次 pending 与全部图保存 | 不配置 OSS 保存 12 张有序 pending／null URL，缺尺寸为 null，不把九格当存储上限；之后全部独立恢复 |
| 单图重试、不重宣称正文 | 关闭重开、正文上游不可用后 `POST /api/sync/media/123` 完成剩余图；`media_id` 可只重试一张，另一失败项不改变；成功项重复执行为零 |
| 来源／整条正文版本切换 | 编辑时间变化替换标题、正文和媒体来源；同 URL 的新版本也重新上传；URL／正文变化但信号不变不触发更新；删除全部图片提交成功空并保留旧成功媒体 |
| 旧版本迟到与失败保留 | 下载／上传分别暂停，与新版本正文成功／失败及新图成功／失败交错；旧提交不改新关联、不清新工作，失败保留旧成功公开 URL |
| 同关联并发重试 | 新尝试令牌取代旧尝试；旧成功／失败迟到均不能覆写新结果，每次 PUT 的对象 key 不同，不会物理覆写已发布的新对象 |
| 进程退出恢复 | 在外部上传边界终止子进程，重新打开同一真实 SQLite 经 HTTP 可见 pending；独立入口重新领取并完成，无内部令牌泄漏 |
| 网络不占长事务 | 下载／上传暂停时，另一个应用实例的归档 HTTP 读取和配置 PATCH 可完成；不检查线程数或毫秒阈值 |
| 迁移与读取快照 | 固定已发布 v7 SQL 输入→v8，旧正文／来源保留且媒体 pending；旧 cursor 完整内容不改。当前媒体上传只影响 detail／新首批，不改旧 cursor，重开仍相同 |
| 脱敏与生产回退边界 | 虚构 OSS／下载秘密不进入 API 或诊断；SDK DEBUG 输出过滤；拒绝签名 URL、userinfo 和 B站业务图作为公开 URL；内网来源、空／非图片响应及重定向均失败 |
| 配置错误 | 部分配置、签名基址、含 userinfo 的 endpoint 以固定生命周期错误拒绝启动，不回显虚构凭据 |

正常重复执行不重复关联、不改顺序，已成功项不重传；并发取代／崩溃可能产生孤立对象，不承诺外部 I/O 恰好一次或自动对象回收。`previous_media` 与当前组明确分开，不把旧图当作新图上传成功。网络与 SDK PUT 始终在 SQLite 领取／提交事务之外。

## TDD 与回归

RED→GREEN 纵向切片记录：新增工厂媒体装配参数前，首个协议上传测试失败；初次正文失败但图片来源可读时独立媒体测试失败；旧图片完成错误清除新观察、同 URL 新版本复用旧成功对象、单图选择重试缺失及 pending 令牌暴露均由公开行为失败测试推动修复；真实 OSS 外部发送测试在未配置适配器前失败；慢媒体阻止可读评论完成的失败测试推动分项提交顺序修正。

全量首次暴露旧测试装配只提交部分正文及旧迁移响应精确 DTO 的兼容问题：保留原部分正文提交行为，迁移预期补齐 v8 字段；未改旧 cursor 预期、未删除旧回归。

已执行：

```sh
uv run pytest backend/tests/test_dynamic_media.py -q
# 36 passed
uv run pytest backend/tests/test_dynamic_media.py backend/tests/test_scoped_archive.py backend/tests/test_root_comments.py -q
# 92 passed
uv run pytest backend/tests -q
# 244 passed
pnpm typecheck
# passed
pnpm test
# 20 files / 198 tests passed
pnpm build
# passed
git diff --check
# passed
```

项目无 Python 专用静态类型检查配置；前端 TypeScript typecheck 在切片间多次通过。Python 固定 3.12、依赖使用 uv；Node 使用 nvm 提供的 24.21.0，pnpm 10.34.6。

## 双轴审查

待本次 Standards／Spec 两个 review 子代理审查后补充结果。

## 未验证与风险

- 未购买或使用云资源，未读取真实凭据；没有真实 OSS 对象／匿名公开读／自定义域名／权限／费用或长期稳定证据，归 #34。
- 本票未运行 Playwright，也无 Linux Chrome／iPhone Safari 正式图片真机证据；UI 与生产 Adapter 图片映射归 #20。
- 不交付评论图、周期重试、图片变体、压缩、CDN、物理去重、备份或容量治理；保留历史关联与孤立对象可能增长。
- 下载受信来源域与非空 image Content-Type 校验不能证明实际图像解码／上游长期可用。公开 URL 可外链，管理／同步／媒体重试 API 无鉴权；需部署网络限制，隐藏入口不是保护。
- 本票自动化不自动勾选父票或同号 AC 的全部验收；票据转人工核验。
