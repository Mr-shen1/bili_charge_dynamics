# 15 一级评论首次归档与分页读取：自动化证据

## 范围与契约

完成票据 [15](issues/15-root-comment-archive.md) 的 T2/T3 后端公开链路，不表示父票 #04、回复、评论图上传、页面或周期触发已交付。契约先明确于 [归档 API](../../docs/backend/api/archive-api.md#15-根评论契约)，静态来源与限制见 [协议证据](../../docs/backend/evidence/source-protocol-evidence.md#15-根评论协议)。

- 公开首次同步仍为 `POST /api/sync/initial`；返回统计保持正文口径。根评论、回复和媒体状态独立，失败及未知计数不清空旧内容或推进成功 checkpoint。
- 使用持久保存的 locator，虚构动态 ID=123 与 oid=99123/type=17 不同。旧 v5 归档迁移、detail 失败及无效新定位均测试复用旧 locator；定位未知明确 unconfirmed。
- `/x/v2/reply` 原始 JSON 经 production 解析进入真实 SQLite；不执行 ignored 脚本、不请求真实来源。根页遍历直到明确空页，非首屏候选空尾页再读同页确认，包括已有根、置顶／热评去重，不把内嵌回复预览当已归档回复。
- v6 新增根记录与独立持久根分页，不改旧动态快照的资源及有效期；旧 v5 已有效 cursor 升级后仍可读。
- 45 根完整集合按两种规则先排序，再 20/20/5 冻结分页；更新、插入、重开和同批重读不改变旧快照。评论 cursor 无 TTL，绑定动态、排序、批量及快照，失效／误用为 CURSOR_INVALID，须显式新首批，普通存储错误原 cursor 重试。

## 自动化覆盖

`backend/tests/test_root_comments.py` 共 25 个测试（含参数化）：

1. 受限正文及网页无权提示不阻断可读根接口，字符串大 ID、作者／动态关系、北京时间、纯文本、来源回复数、有序图片 metadata 和分项状态正确。
2. 中途必要页失败保留本轮新根及旧根、不推进 checkpoint；数据库重开且无新信号可重试，重复处理幂等；停止／删除后可继续读取。
3. 缺失／无效定位、业务拒绝、HTTP 拒绝、缺失 replies、无效 page.count/acount、错 oid、非根关系、分页不前进以及非零计数但首批空不伪装成功。
4. 45 根最热／最新完整排序、字符串并列、逐字段缺失后置、20/20/5；冻结内容与顺序抵抗来源后续更新，跨排序／批量／父级／资源和伪造 cursor 拒绝。
5. 真实 SQLite 暂不可读返回固定 503，释放后重试相同 cursor 读取原批；来源网络暂停期间 HTTP／管理可用，旧 generation 完成不能覆盖新根／状态。
6. v5 固定数据库输入经真实迁移和重开后 locator、旧动态 cursor 和根评论均可读；可空观察不擦除旧可信 metadata 或缺失图片字段对应的已有元信息，迁移补齐旧归档根分项状态但不改旧分页快照；瞬时空尾页复查非空留待重试。首次未知动态数仍 null，不等于本地根数或零。

## 本次执行结果

所有命令在仓库根目录执行，Node 使用 nvm，依赖管理使用 pnpm／uv：

| 命令 | 结果 |
| --- | --- |
| `uv run pytest backend/tests/test_root_comments.py -q` | 25 通过 |
| `uv run pytest backend/tests/test_initial_archive.py backend/tests/test_migrations.py -q` | 38 通过（实现阶段） |
| `uv run pytest backend/tests/test_initial_archive.py backend/tests/test_scoped_archive.py backend/tests/test_full_archive.py -q` | 64 通过 |
| `uv run pytest backend/tests -q` | 181 通过（审查修正后最终重跑） |
| `pnpm typecheck` | 通过；后端未配置独立静态类型检查器，不把 pytest 冒充 Python typecheck |
| `pnpm test` | 19 文件、163 测试通过 |
| `pnpm build` | 生产构建通过 |
| `pnpm test:e2e:manage` | 2 通过，真实测试 API／SQLite，虚构来源 |
| `pnpm test:e2e:archive` | 4 通过，既有生产 Adapter 回归；不代表 #16 评论页面已接入 |
| `pnpm test:e2e` | 环境阻塞：4173 已被现有服务占用，配置禁止复用且无端口 override；未停止已有服务，默认 mock/fault 浏览器套件未运行 |
| `git diff --check` | 通过 |

E2E 管理和归档串行执行，清除代理环境并设置 localhost NO_PROXY；不操作占用 4173 的用户服务。全量后端存在既有 Starlette/AnyIO deprecation warning，不影响通过结果。

## 双轴代码审查

以开工基线 `24b9b8545c9115b65da3a4b07704f959a983cf5f` 为固定点，两名 `review` 子代理并行审查。

### Standards

初审提出 6 项：3 处可确证重复及 3 个判断性 smell（没有成文编码标准将这些视为硬违规）。已提取共享分页冻结、非空作者合并及图片映射，改善 allow_zero 命名。保留语义明确的 begin/save/finish 仓储操作，避免调用方暴露通用私有状态函数；简单分页结果元组暂不引入额外类型。原轴最主要问题为分页复制，已收敛。

### Spec

初审提出 4 项：缺失 pictures 可能擦除旧图元信息（确证）、空尾页确认／旧 DTO 默认字段／来源计数保护三项判断。已用失败测试先证明并修正图片保留、复查非首屏空尾页、迁移补齐旧详情根状态；旧动态冻结分页原内容仍兼容。保留成功提交的来源观察一致性条件，依据规格 I4/DR-05 防止清除较新观察工作，不改变根与回复独立语义。原轴最主要缺陷为图片元信息丢失，已修复。

汇总：初审 Standards 6 项、Spec 4 项，两个轴分别处理，不合并排序。审查后的行为修正均经公开入口和真实 SQLite 回归。

## 未验证及限制

未验证匿名上游是否可用、真实必要页全量、跨类型计数口径、长期请求／并发来源更新、实际容量或正式设备兼容。固定第三方资料及本地静态参考只证明实现采用的结构边界，不证明权限或来源稳定。动态 `module_stat.comment.count` 与根分页 `page.count/acount` 不假设永久恒等；来源分页变化被检测时留待重试，未改变计数的来源挪动仍可能漏检。

评论冻结分页无 TTL／回收，会占用内存与持久存储，不宣称容量治理；未知作者／时间／点赞／回复计数允许 null。业务图片只有来源 metadata，未上传 OSS，不作为生产展示回退。首期 API 无鉴权风险不变。#16、#17、#21、#25 及正式真实来源／持续运行证据另行交付。
