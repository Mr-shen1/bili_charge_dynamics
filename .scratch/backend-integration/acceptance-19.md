# 19 动态媒体归档：实施与自动化证据

## 范围与装配

对应 [#19](issues/19-dynamic-media-archive.md)、[规格 I3/I4/I7/I12 与 T2/T3](spec.md)、[共同交付要求](implementation-plan.md#所有执行子票的共同交付要求)。测试边界已由用户确认：公开同步→真实 SQLite→HTTP、独立媒体重试、可阻塞／失败下载与模拟 OSS。正文成功、媒体成功、评论成功分开。

已交付动态图来源组、全部有序媒体关联、旧成功保留、持久状态／checkpoint、独立单图重试、真实 OSS V4 适配器和 v8 迁移。契约见 [归档 API](../../docs/backend/api/archive-api.md#19-动态媒体归档独立重试与公开-url)，运行与凭据边界见 [后端 README](../../backend/README.md#19-oss-服务端配置)。未改生产 Adapter／页面图片映射（#20）、评论媒体 owner（#21）或周期调度（#23/#24）。

测试使用现有结构真实、内容虚构 HTML/JSON fixtures，图片 CDN URL 仅为协议占位；HTTPX 下载 transport 与 OSS 外部发送替身不访问真实上游。真实 SDK 测试拦截 `requests.Session.send`，使用虚构凭据检查 V4 Authorization、STS、PUT 对象 key 和 Content-Type；成功／拒绝均进入生产适配器与真实 SQLite，**不代表实际云上传证据**。

## 公开行为覆盖

`backend/tests/test_dynamic_media.py` 共 37 项（含参数化）：

| 要求 | 公开验证 |
| --- | --- |
| 来源协议→下载→模拟上传→SQLite→HTTP | initial 从 HTML CONTENT 解析 owner、来源／尺寸／顺序，HTTP 读取完整 URL、状态和实际版本；列表一致、关闭重开一致 |
| 正文与每张图独立 | 正文成功但第二张上传失败，其他图保留；正文不可用但 detail 来源可读时，媒体仍可成功；慢上传时正文与可读评论已提交 |
| 首次 pending 与全部图保存 | 不配置 OSS 保存 12 张有序 pending／null URL，缺尺寸为 null，不把九格当存储上限；之后全部独立恢复 |
| 单图重试、不重宣称正文 | 关闭重开、正文上游不可用后 `POST /api/sync/media/123` 完成剩余图；`media_id` 可只重试一张，另一失败项不改变；成功项重复执行为零 |
| 来源／整条正文版本切换 | 编辑时间变化替换标题、正文和媒体来源；同 URL 的新版本也重新上传；URL／正文变化但信号不变不触发更新；删除全部图片提交成功空并保留旧成功媒体 |
| 旧版本迟到与失败保留 | 下载／上传分别暂停，与新版本正文成功／失败及新图成功／失败交错；旧提交不改新关联、不清新工作，失败保留旧成功公开 URL |
| 同关联并发重试 | 新尝试令牌取代旧尝试；旧成功／失败迟到均不能覆写新结果，直接比较两次 PUT key 不同及发布 URL 指向新对象，不会物理覆写已发布的新对象 |
| 正文重试不覆盖媒体失败 | 初次正文／媒体均失败后，同版本正文重试成功；在媒体重新领取前经 HTTP 仍可见原图片失败和脱敏错误，不被正文提交改成 pending |
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
# 37 passed
uv run pytest backend/tests/test_dynamic_media.py backend/tests/test_scoped_archive.py backend/tests/test_root_comments.py -q
# 93 passed
uv run pytest backend/tests -q
# 245 passed
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

初审由两个 `review` 子代理并行执行，基线 `b830ce90901f909b27ddfd424594a9156fc3664d`，命令 `git diff b830ce90901f909b27ddfd424594a9156fc3664d...HEAD`，初审提交 `bd71f52`。两个轴不合并或跨轴重排；以下分别记录原发现及处理。

### Standards

硬违规 0；判断性发现 7：媒体聚合规则重复／散落；受信域重复；公开 URL 谓词命名不够精确；裸状态与布尔参数；边界广泛异常捕获；SDK 传输测试可能耦合；重复输入长度／pattern 校验。

已统一 `refresh_media_progress` 的完成／失败聚合规则（新观察登记 pending 与网络开始 pending 仍有各自明确语义），迁移复用同一规则；提取受信图片域判断并将 URL 谓词改名为 `is_archive_delivery_url`，明确它不证明实际匿名可读。其余低影响判断项保留：字符串状态沿用仓库 DTO，不引入额外框架；两个实际调用场景需要自动来源版本过滤与单图选择；I/O 边界统一捕获并固定错误以避免秘密／traceback 外泄，存储异常仍在边界外；SDK `requests.Session.send` 是已确认的外部 HTTP seam，用于真实适配器的签名协议验证，不 mock 内部协调；长度与格式限制共同防御输入。未发现网络进入长事务、凭据泄漏或 SDK 正常生命周期违规。

### Spec

确证功能性违规 0、范围扩张 0；评论图 owner 明确保留给 #21，不计本票缺失。3 个边界／证据提醒：同版本正文重试可能抹掉媒体聚合 failed；两次 PUT key 不同缺直接断言；已淘汰内部尝试行无清理。

已以失败测试修复第一项，保证同版本正文重试保留失败聚合状态直到媒体领取；新增外部 key 不同／新 URL 指向新对象的直接断言；来源切换在同一短事务中删除废弃关联令牌，保留当前 pending 的重开恢复语义。没有选择云对象自动回收策略，孤立对象风险继续明确保留。

初审总结：Standards 0 硬违规／7 判断项（主要为聚合规则散落）；Spec 0 确证违规／3 提醒（主要为正文覆盖媒体失败聚合）。二次复核针对 `bd71f52...HEAD`（补强提交 `9ef1fb5`）继续由两个 `review` 子代理并行执行：Standards 硬问题仍为 0，原聚合／域／命名主要判断项已解决；新增 3 个低影响判断项（域匹配表达式仍有相似形状、聚合函数缺 docstring、嵌套条件表达式），已补 docstring，另外两项保留局部简单表达式，不为一行域判断新增空抽象。Spec 3 个提醒全部关闭，无新增需求缺失／范围扩张／确证错误；专项 37、重开／迁移／迟到定向 12 通过。JSON1 依赖与内部令牌清理不通过 SQL 断言，分别沿用已存在 SQLite JSON 能力和已确认公开 seam 的测试约束，不构成新增违规。

最终分轴总结：Standards 0 硬问题，剩余低影响判断为已说明的现有风格／边界及简单局部表达式；Spec 0 确证问题，初审 3 个提醒均已处理。未将两个轴合并排序，也未把自动化当作真实云／真机证据。

## 未验证与风险

- 未购买或使用云资源，未读取真实凭据；没有真实 OSS 对象／匿名公开读／自定义域名／权限／费用或长期稳定证据，归 #34。
- 本票未运行 Playwright，也无 Linux Chrome／iPhone Safari 正式图片真机证据；UI 与生产 Adapter 图片映射归 #20。
- 不交付评论图、周期重试、图片变体、压缩、CDN、物理去重、备份或容量治理；保留历史关联与孤立对象可能增长。
- 下载受信来源域与非空 image Content-Type 校验不能证明实际图像解码／上游长期可用。公开 URL 可外链，管理／同步／媒体重试 API 无鉴权；需部署网络限制，隐藏入口不是保护。
- 本票自动化不自动勾选父票或同号 AC 的全部验收；票据转人工核验。
