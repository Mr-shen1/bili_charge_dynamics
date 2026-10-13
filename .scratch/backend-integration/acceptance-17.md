# 17 楼中楼完整归档与读取：自动化证据

## 范围

交付 [17](issues/17-reply-archive.md) 的 T2/T3 后端和生产 Adapter 读取，不替代 #18 页面展开／历史恢复、#25 周期／计数调度、媒体上传或父票验收。实施前协议见 [计划](reply-protocol-plan.md)，正式接口见 [归档 API](../../docs/backend/api/archive-api.md#17-楼中楼完整归档与读取)，字段来源及限制见 [协议证据](../../docs/backend/evidence/source-protocol-evidence.md#17-楼中楼协议)。

## 已执行的行为验证

`backend/tests/test_replies.py` 27项（含参数化），均经公开 initial 与真实临时 SQLite／HTTP：

- 原始虚构 JSON 必要回复分页，不用内嵌预览；字符串大ID、根／动态／作者／parent、跨页目标与 @ 提及者区别、缺目标、作者／时间／计数未知正确。
- 来源数／完整本地数／逐根尝试／成功数分开；首次回复失败不假成功空，成功零独立。根页或任何必要回复页失败不推进整轮 checkpoint，根成功可先于回复；正文受限和媒体未完成独立。
- 25条完整集合时间升序、null后置、ID BINARY升序；首3、续10/10/2，累计3/13/23/25；内容、目标、计数与顺序冻结，插入和更新时间只进入新读取。
- cursor绑定根／动态／资源／读取上下文，重读原批／重开仍一致，无TTL；普通SQLite锁503原cursor重试，数据库恢复丢失上下文返回CURSOR_INVALID且须显式新首批。
- 中途回复页失败保留成功部分及旧记录，旧成功count不被新观察8冒领；关闭重开无新信号重试，重复初始幂等；停止／删配置／目标／来源失败后旧回复仍可读。
- 网络暂停时另一个HTTP读取／配置写入可完成，公开整轮状态尚未成功；较新generation成功后，旧执行的失败／完成不能覆盖新归档。
- 固定已发布v6输入真实升级至v7，旧根与有效根cursor内容不改写，继续使用旧locator归档回复；既有v5动态cursor兼容测试保留。
- 业务／HTTP拒绝、缺回复列表／计数、错误资源／关系／页码、重复页、count变化／矛盾、瞬时空尾页均留待重试且诊断脱敏。

生产Adapter `tests/archive-reader.test.ts` 28项（含原回归），HTTP仅替换传输：回复DTO／父级、首3续10、取消优先、普通失败原cursor、CURSOR_INVALID、无客户端TTL、独立计数／失败状态和旧Archive兼容。额外T1不能冒充真实来源或浏览器证据。

## 测试过程与命令

- 补充旧零→新未知的RED：错误跳过必要回复页，本地仍0；改为使用本轮原始根回复数判定可否跳页后GREEN，本地5且整轮checkpoint8。
- 首个T3贯通RED：回复HTTP404；最小实现后GREEN。缺parent RED为work.replies pending，修复后GREEN。首次失败状态RED缺replies_last_attempt，增加逐根状态后GREEN。来源count矛盾RED错误推进checkpoint8，修正完整集合核验后GREEN。
- Adapter子代理7个纵切均先失败再通过，临时日志 `/tmp/17-adapter-01-red.log` 至 `07-green.log`；主线程补充可空parent／未知目标／状态与计数，3个预期失败后29项GREEN。过程日志仅本地，不是长期证据。
- `uv run pytest backend/tests/test_replies.py backend/tests/test_root_comments.py backend/tests/test_migrations.py -q`：最终61通过，回复27项。
- `uv run pytest backend/tests/test_initial_archive.py backend/tests/test_scoped_archive.py -q`：60通过。
- `uv run pytest backend/tests -q`：最终208通过，有既有Starlette/AnyIO deprecation warning。
- nvm下 `pnpm exec vitest run tests/archive-reader.test.ts`：审查修正后28通过；`pnpm exec vitest run tests/archive-app.test.tsx`：16通过。
- `pnpm test`：19文件、190测试通过；最终日志 `/tmp/17-final-vitest.log`。
- 多次 `pnpm typecheck`、最终 `pnpm build`通过；`git diff --check`通过。项目无Python静态类型检查器，pytest不冒充类型检查。
- 首次全量暴露2处旧Archive精确DTO未计新增字段，以及1处旧回复stub能力断言。更新旧DTO期望；根评论页面回归改用来源零回复的原始DTO保持根分页seam，不保留已移除stub的假能力断言；随后上述单文件和全量均通过。没有修改页面实现来宣称#18完成。

## 双轴审查

两名 `review` 子代理并行只读审查，固定开工基线 `43f9f3ac83f536117ef3eb01a71d3a291c7e6f66`，WIP命令 `git diff 43f9f3ac83f536117ef3eb01a71d3a291c7e6f66 --`（包括已暂存新增文件）。

### 规范轴（Standards）

无成文硬违规，提出6项判断性smell：仓储提交骨架重复、状态重复赋值／数据组、无用limit参数、借root解析伪造关系、根数据重复解析、测试模块互相导入。已提取共同 `comment_fields/_merge_comment`、移除无用limit和重复赋值、根只解析一次、增加共享 `root_support` 原始来源装配；不引入通用状态框架，保留根／回复各自语义提交与已发布扁平DTO。事务骨架相似与扁平字段组是保留的判断性取舍，不是未处理正确性缺陷。

### 规格轴（Spec）

确认1项范围增加：根Comment.localReplyCount无后端生产者；已移除该字段／解析及对应虚构测试，仅在真实回复批返回来源／本地计数。另1项范围提醒：新Adapter会被现有ReplySection自然调用；本次只交付HTTP／Adapter，不宣称#18的逐根状态呈现、cursor失效恢复及生产历史体验已验收。不改页面实现，原mock回归不代替#18。审查对观察计数比较的证据疑问由generation并发与中途checkpoint公开测试补证；完整性另外用本轮唯一回复数等于稳定来源page.count核验。

汇总：初审规范轴6项判断性发现（最主要为重复解析／合并），规格轴1项确证及1项边界提醒（最主要为无生产者字段）；分别处理，不合并排序。

## 限制

本票未执行Playwright浏览器套件；既有mock回复/历史单元回归不代表#18生产页面验收。无真实Cookie／上游请求／OSS上传，无正式设备、生产部署、持续调度或容量证据。固定第三方结构不证明匿名权限、真实全量、计数口径或长期稳定；来源不是事务快照，未变count的挪动仍可能漏检。持久根／回复快照不设TTL／回收，有存储增长风险，不承诺无限容量。API首期无鉴权风险不变。
