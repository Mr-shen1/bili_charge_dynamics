# 29 配置变化与在途生命周期验收

## 实施前语义决策

测试边界已经用户确认：采集公开入口＋受控来源/OSS；真实 SQLite 重开＋管理/归档 HTTP。不以内部取消标志或数据库私有字段代替公开结果。

- **入选代次**：按 `(uid, dynamic_id)` 保存内部唯一令牌。影响当前选择的配置变化（启停、模式、近期模式的 N）刷新该 UP 当前入选代次；指定关联增删、可信近期窗口发布只改变受影响成员的代次。同配置重复保存、指定模式仅保存暂不生效的 N、同成员窗口重复发布不推进代次。停止/移除使令牌失效，重新纳入生成新令牌，跨删配置重建、数据库重开亦不能 ABA。
- **工作归属**：入选代次只界定检查和新工作领取的资格；观察 `revision` 界定实际编辑/评论数；执行 `claim_token` 界定一次领取；归档 `generation` 与媒体 attempt token 继续隔离归档和上传尝试，不能相互替代。
- **允许提交**：旧代次检查不能登记 observed、错误或时间；每次来源信号请求前复核资格，已经发出的请求可返回但不再引发后续检查请求。待领取快照在领取时原子复核代次。同步领取与归档领取之间再次复核，避免间隙把旧工作接到重建配置。
- **已领取同步**：沿用既有 collector 契约，已取得归档领取的完整同步链（正文、根、回复、动态/评论图及上传）允许结束，包括后续分项 I/O；它不是新一轮监控。正确 owner/版本的已取得结果可保存，停止不回收或清空归档。若入选代次改变，旧执行不能更新新代次的整轮成功时间或清掉 pending；较新 observed revision 同样不能被旧完成清除。
- **恢复**：停止期间不检查、不领取；保留 observed、checkpoint、错误与待处理。重新纳入后继续 pending，复用已完成分项。进程中断的 running 只由取得采集锁的正式 run 恢复；API 重开不恢复、不采集。成功归档可一直读取；未知/失败不冒充零。
- **迁移**：原子升级 v12 → v13，回填当前入选令牌，不改写身份、配置、归档、观察或未完成工作。网络、下载和上传均不进入 SQLite 事务。

## 配置操作 × 工作阶段矩阵

下表均覆盖停用 UP、删配置、删指定目标、指定→近期、窗口移出；前 3 行分别验证旧 I/O 返回前重纳入和返回后重纳入，重启/失败行验证先移除后恢复。模式切换有额外近期→指定、ID 重合的检查/同步用例。

| 阶段 | 组合数 | 允许提交／恢复的公开结果 |
| --- | ---: | --- |
| 检查网页／locator detail／独立计数阻塞 | 30 | 旧观察、错误、时间不登记；返回后不再请求下一信号。保持移除时不检查；重纳入后新检查得到可信计数 7 |
| pending 快照已读、工作尚待领取 | 10 | 单槽执行池阻塞前一个目标，旧快照不得领取移除/重纳入的后一个目标；后者仍 pending、没有来源请求或归档，下一批恢复 |
| 已领取正文／根分页／回复分页／动态图下载／评论图下载／动态图上传／评论图上传 | 70 | 已领取链可结束，保存全部正文/根回复/图片 owner、顺序、尺寸、来源与公开 URL；旧完成不得更新新代次成功时间或标 complete。停止时无新检查/领取；重纳入续 pending，复用已完成分项且重复执行幂等 |
| 上述正文／根／回复／动态上传／评论上传中断，正式 run 持锁重启 | 25 | API 重开不改 running；正式 run 恢复 pending、保留 observed/revision/checkpoint/内容，旧目标不复活；重纳入后完成正确分项 |
| 旧成功后新编辑/计数已登记，正文与根来源 403／404／503，期间改变配置 | 15 | 失败不是零；保留来源数 8、旧成功 checkpoint 7、正文/根回复/成功媒体，固定错误不含虚构秘密；重纳入无需再次变化即重试完成 |

其他 12 项：首个检查 ABA 回归、整链旧完成回归、显式 initial 旧快照、两种模式幂等配置/同窗口、近期→指定重合 ID 的两个阶段、上传期间较新观察、两种模式 v12 数据保留迁移、v12 迁移失败回滚重试、删配置后同 ID 另关联其他 UP 的 owner 隔离。共新增 **162 项**。

### 可复现入口

- `backend/tests/test_inflight_lifecycle.py`：118 项；公开 Collector/initial 入口，真实临时 SQLite/HTTP，阻塞外部 HTML/JSON、下载与模拟 OSS。上传返回前/后及整链完成后的配置变化分别验证 pending→complete 与幂等续做。
- `backend/tests/test_inflight_recovery.py`：44 项；真实 SQLite 关闭重开、正式 run 取得进程锁后恢复、失败保留与脱敏。仅迁移前旧 schema 输入及 schema 版本断言使用 SQLite 直接装配，业务结果仍经公开 HTTP。
- 复用 `RecentContentSource`、`RecordingOSS` 和 `assert_complete_content`；从原始 HTML、feed/detail/独立计数/根/回复 JSON 穿透生产解析与同步链。配置变动与部分归档 HTTP 在 I/O 仍阻塞时即完成，证明不占网络长事务。
- 原有 `test_recent_window_lifecycle.py` 的受控 15 秒忙检查跳过、`test_comment_count_recovery.py` 的双同步槽与持续新检查、`test_versioned_edit_sync.py` 和媒体测试的旧令牌/旧版本提交继续回归。固定节拍、动态/评论图 owner 和版本隔离没有新增第二套实现。

## 执行结果

- TDD：旧检查 ABA、旧同步误标重纳入 complete、旧 pending 快照冒领，分别先新增回归复现失败，再最小修改后通过。扩展矩阵在同一公开边界验证。
- 扩展回归发现旧并发测试在指定模式只修改暂不生效的 N；修正入选语义为此操作不失效当前工作，保留原并发契约。v9/v10/v11 旧 schema 装配同步移除 v13 表，继续核验各自迁移输入，不绕过迁移失败。
- `uv run pytest backend/tests/test_comment_count_recovery.py backend/tests/test_versioned_edit_sync.py backend/tests/test_inflight_lifecycle.py backend/tests/test_inflight_recovery.py -q --tb=short`：阶段性 192 项通过（随后增加两个反向模式用例）。
- `uv run pytest backend/tests -q --tb=short`：首轮 **648 项通过**，审查补充证据后最终 **654 项通过**。保留 Starlette/AnyIO 及 OSS SDK 原有弃用警告，无失败。
- `source "$HOME/.nvm/nvm.sh" && nvm use && pnpm typecheck && pnpm test --maxWorkers=2 && pnpm build`：类型检查通过、**25 文件／265 项前端测试通过**、生产构建通过。
- 多轮 `uv run python -m compileall -q backend/bili_monitor` 与 `pnpm typecheck`；Python 未配置独立静态类型检查器，语法编译不冒充类型检查。
- 首轮双轴 code-review 均无确认缺陷。Standards 提出守卫重复、兼容参数/测试脚手架等判断性建议；提取 `selection_matches` 统一四处资格守卫，补充 Store 默认形状和 `selection=None` 的兼容边界注释，明确 `reset` 并加括号。保留既有 Store API 形状，不为消除测试局部阻塞装配而引入泛化控制框架。
- Spec 指出 404 消失、跨 UP 同 ID 的证据限制；补五个 404 配置组合及一个同 ID 来源作者改变后尝试另关联 UP 的用例。实际旧归档 owner 不变、新 UP 不读到或完成旧归档、旧领取不复活配置。审查后专项 `uv run pytest backend/tests/test_inflight_lifecycle.py backend/tests/test_inflight_recovery.py -q --tb=short`：**162 项通过**；增量双轴复核均无确认缺陷；进一步按建议让 Collector 的领取快照必须含 `selection`，缺失即报错而不降级兼容路径，并明示 finish 的 None 跳过语义与其他入口不同。全量后端复跑 654 项通过，review 后统一提交。

## 边界与未验证项

本票证据是本地真实 SQLite/HTTP、受控来源、模拟 OSS、受控时钟与进程内重启入口；不等于真实云上传、真实上游长期稳定性、OS 强杀/断电、容量/持续运行或浏览器设备签收。本次未重跑 Playwright，无 UI 变更；#30 的阅读导航与全分项页面聚合、#31–#34 的部署/设备/持续运行不随本票宣称完成。父 #11/产品 AC 不自动勾选。未新增鉴权、媒体回收或全历史动态回填。
