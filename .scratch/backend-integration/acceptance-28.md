# 28：近期窗口纳入、移出与重新初始化

## 范围与决定

- 对应 [票据 28](issues/28-recent-window-lifecycle.md)，开工基线 `75d5ad462c9a1197598fc5922d2484aaa998920a`。沿用规格已确认 T1/T2/T3，不新增私有测试 seam。
- 将 #27 的 v12 `trusted_result` 直接作为最后成功发布窗口，发布与可信结果在同一短事务提交；不新增重复窗口表或 schema。已有 v12 可信结果升级后可直接入选，所有既有迁移与归档保留测试继续适用。
- 当前目标按启用配置互斥选择：指定关联或近期可信窗口，不将近期 ID 写入指定 `targets`。检查、工作领取与显式 initial 共用同一选择规则，再沿用 #02/#24 正文、根回复、媒体归档链；发现不执行耗时归档。
- N 改动后保留上次可信窗口，直到新 N 的完整结果成功发布；管理分别显示期望 N 与可信结果 N。停用/指定模式/删除立即停止新的近期检查和领取；历史窗口、归档与 pending 保留。再次启用 recent 可恢复保留的可信窗口，旧发现令牌不复活。
- 本票不宣称 #29 的全部在途分项收口、#30 的完整组合验收，或父 #10 的人工收口。

## 自动化证据

### T1：生产管理 Adapter 与页面

- `tests/manage-discovery-api.test.ts`、`tests/manage-discovery-page.test.tsx`：严格解析 GET discovery、配置/状态/ID/时间/错误、取消和迟到响应；本轮候选、旧可信结果、当前入选集合分别展示。保存配置使旧读取失效，失败保留已有状态；页面不轮询、不扫描上游，不把发现成功当归档成功。
- 新测试纳入默认 Vitest 目录，不另建专用执行配置。
- `tests/e2e-manage/management.spec.ts`：实际 Python HTTP/SQLite 服务经生产 Adapter 显示近期 N=23、未发现与空当前窗口；服务重启和管理操作仍可用。四宽度管理规则测试补入新分区标题，不修改既有尺寸/颜色阈值。

### T2/T3：真实 SQLite、原始协议与采集公开入口

- `backend/tests/test_recent_window_lifecycle.py`：feed JSON 经 `discover_once` 发布；无编辑标记也经 `check_once → execute_pending` 完成初始化。重复发现不重置 revision、不重复执行完成工作；指定关联不会混入近期集合。
- 新增/移出/重纳入、失败保留旧窗口、关闭重开、持久 pending 无新信号恢复、正文成功部分不删除重建；N/模式/停用/删除期间旧发现迟到不能替换窗口，指定模式只检查指定 ID。
- 受控 0/15/30/45/60 秒节拍：忙检查跳过、移出后的旧检查观察被拒绝，重新纳入恢复后续检查，不改变节拍或积压。
- 显式 `/api/sync/initial` 使用同一入选集合；归档、身份、基础列表和详情读取不调用上游。
- `backend/tests/test_recent_window_content.py`：原始 feed/HTML/detail/计数/根回复 JSON 穿透共用链，实际保留 2 根、5 回复、2 动态图和 1 评论图；移出、停用、删除、重纳入后仍完整读取、不重复上传成功媒体。上传中断后 API 重开不恢复 running，持锁 `Collector.run` 才恢复 pending 并完成领取；网络等待中配置写入不阻塞。
- #27 原始多页 fixtures/独立 N/失败与配置 fencing 测试继续回归；本票不改原识别规则、来源顺序或分页停止条件。

### 执行记录

- 首个测试先失败于 discovery 缺少 `current_ids`（`KeyError`），再实现共享入选集合与公开投影，专项转绿。
- 当前专项命令：`uv run pytest backend/tests/test_recent_window_lifecycle.py backend/tests/test_recent_discovery.py backend/tests/test_versioned_edit_sync.py backend/tests/test_initial_archive.py backend/tests/test_collector.py backend/tests/test_migrations.py -q --tb=short`：118 通过。
- `pnpm test tests/manage-discovery-api.test.ts tests/manage-discovery-page.test.tsx --maxWorkers=2`：13 通过；`pnpm typecheck`、Python compileall 与 `git diff --check` 通过。
- 管理浏览器首次运行受当前环境 HTTP 代理影响，将 `NO_PROXY=127.0.0.1,localhost` 加入测试命令后可启动；发现四宽度标题清单需要新增窗口分区，已修正。最终管理 E2E 7 通过，归档 E2E 36 通过。
- 主线程最终 `pnpm typecheck && pnpm test --maxWorkers=2 && pnpm build`：类型检查与构建通过，25 文件 / 265 项全部通过。
- 默认 mock E2E 并行全量首次 103 通过、1 个移动滚轮时序断言失败、10 个静态交付场景按配置跳过；未改无关阅读代码或提高超时。该场景单 worker 连续三次通过；`NO_PROXY=127.0.0.1,localhost pnpm test:e2e --workers=1` 完整复跑 104 通过、10 跳过。跳过不表示静态交付已验收。
- 内容/媒体/重启专项连续三次各 2 通过；主线程最终 `uv run pytest backend/tests -q --tb=short`：492 通过。首次全量 491 通过、旧回复测试重复 initial 跨秒时将真实成功时间变化误判为内容不幂等：用替换外部 datetime 的递增时钟稳定复现旧断言失败，再修测试，允许三项实际成功时间单调推进并核对 checks 投影，其他内容完整比较；重开比较最新完整快照。仅修测试，不改生产同步行为。回复专项 27 通过，递增时钟回放通过。

## Standards（规范轴）

- 以开工基线比较全部未提交差异（新增文件以 intent-to-add 纳入），按用户要求不先制造中间 commit。由 `review` 子代理独立执行，未发现文档标准硬违规或确认级缺陷。
- 4 项判断建议：根 README 陈旧描述、手动读取脚手架重复、选择投影多处包装、前端 current_ids 交叉校验不足。已同步根 README；为窗口一致性先加失败测试，再补 current_ids 与可信结果的长度/顺序/存在性校验。
- 未引入建议的通用手动读取 hook/泛型 GET 框架：当前与检查面板沿用相同小型异步隔离惯例，避免本票扩为跨面板重构。入选 SQL 已单一维护于 `SELECTED_TARGETS`，各读取入口保留自己的返回形状、查询范围与事务上下文；简单 HTTP 投影与 SQL 行选择不同，不另增转发抽象。

## Spec（需求轴）

- 由另一 `review` 子代理并行独立审查：0 项确认缺陷、0 项遗漏/越界；核验模式互斥、整轮可信发布、配置 fencing、N 变更保留、共享初始化与管理只读语义。
- 审查是静态/只读核对，不能代替上述测试或未验证项。在途已领取同步沿用既有规则，#29 的额外边界没有冒充为本票已完整验证。

- 审查后增量再由两个 `review` 子代理并行复核 README、窗口 DTO 交叉校验和旧回复测试时间修正，两轴均无新增确认缺陷。规范轴另提示时间投影一致性断言同源、证据力有限；本项只作为公开 API 投影一致性回归，不将其冒充独立上游时间证据。

两轴汇总：规范 0 确认缺陷 / 原 4 判断建议（2 已处理，2 保留既有局部结构），需求 0 确认缺陷；各轴均无阻断项。

## 父 #10 原清单对应

- 原识别/跨页凑 N/独立 N/失败可信结果由 #27 提供，本票保留其协议与回归。
- 目标模式互斥、无编辑标记初始化、固定窗口检查、归档与 pending 保留、重新纳入、管理当前窗口由 #28 的公开行为测试覆盖。
- 不引入仅评论开关、全历史动态补扫、每日校准、目标数量硬限或容量承诺。更多虚构 fixture 只是边界样本。

## 未验证

真实匿名多页与权限可用性、真实 OSS、自然编辑/长期节拍、生产部署和设备人工签收仍未验证；模拟传输/OSS、受控时钟与 Chromium 自动化不替代这些证据。
