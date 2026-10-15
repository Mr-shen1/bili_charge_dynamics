# 30：保留归档、自动媒体联动与全分项状态验收

## 范围与决定

依据 [#30](issues/30-integrated-archive-lifecycle.md)、[集成规格](spec.md) 的已确认 T1/T2/T3，以及 [父 #11](issues/11-monitoring-lifecycle.md) 原清单。沿用原管理、检查、同步、媒体、读取与导航能力，只补组合契约和实际缺口；不增加产品采集按钮、回复图、全历史回填、内容比较、退避或飞书。

- 正文、动态图、评论图的实际成功时间补齐到持久归档和 checks／详情 `comment_sync`；根、回复、评论整轮时间沿用原实现。时间由真实完成事件推进，检查、读取、旧缺字段不补造，失败保留旧值。媒体当前失败码去重排序后仅返回白名单，管理页展示各分项和固定错误。无 schema 变更，旧冻结 cursor 和旧 DTO 缺字段仍可读。
- 正式 API 与采集进程默认装配分页等待：动态 feed 每次请求前 0.8–1.5 秒，根评论／楼中楼每次请求前 0.3–0.4 秒，包括首页和空尾页确认。同一来源客户端共享异步等待，网络不占等待锁、SQLite 不占事务，轻量信号请求不排分页队列；固定 15 秒、忙即跳过与独立同步保持不变。跨进程不共享限速，也不保证不触发上游限制。
- 等待区间仅静态参考 ignored 示例的无敏感函数，未导入、执行原脚本或读取飞书／凭据配置；可复现生产逻辑和虚构协议夹具均已纳入版本。

## 核验清单与父 #11 对照

| #30 核验项 | 本轮及复用证据 | 结果／边界 |
| --- | --- | --- |
| 管理→采集→SQLite→HTTP／生产 Adapter→阅读→返回 | `tests/e2e-archive/archive-lifecycle.spec.ts` 两例，浏览器保存 UID／指定模式／目标，私有测试 socket 调公开 Collector；真实 Uvicorn／临时 SQLite，生产 Reader，根回复、两类图片、预览焦点和返回展开恢复 | 通过；外部上游／OSS 模拟，图片请求由受控服务响应，不替换归档 API |
| 停止／删除后旧归档入口与完整内容 | 新浏览器链停止、删目标、删配置、断源重开后从全部／单 UP 选择条重新找到归档；复用 `scoped.spec.ts` 的跨 UP／分页和历史、`test_inflight_lifecycle.py` 的模式／窗口／重新纳入矩阵、`test_recent_window_content.py` | 通过；不只依靠旧详情 URL，不声称新浏览器用例穷举后端矩阵 |
| 可信编辑→正文与动态图、失败恢复 | `test_integrated_archive_lifecycle.py` 编辑链及浏览器第二例：相同 pub_ts、可信分钟编辑变化、来源组更新、旧成功保留、部分失败、关闭重开且无新编辑仍重试；信号不变时内容／来源变化不另触发 | 通过；模拟 OSS，不回退 B站业务图，不声称自然编辑与真实云可用 |
| 来源总数→根回复与一级评论图 | 后端计数／媒体交错链和浏览器第二例：必要分页、评论文本先完成、图片失败不退 checkpoint、纯图与不同 owner、重开仅重试媒体，回复无图片 | 通过；来源与本地数量分开，不假定根＋回复实际总数永久恒等 |
| 管理状态及实际分项时间／错误 | checks 新 DTO、`tests/manage-checks.test.tsx` 生产管理 Adapter→UI，浏览器未检查／运行／部分完成／无变化仍未完成／完成；时间分别核验，错误固定白名单且非法字段拒绝 | 通过；历史分项成功时间不代表当前观察完成，HTTP 成功／发现成功也不代表完整归档 |
| 受限／未知／失败／交错／重试／重启与原回归 | 后端三例覆盖正文受限、无效编辑、根／回复失败、媒体重试期间新计数；复用 #24–#29 版本 fencing、来源故障和在途矩阵；原 Vitest 与 mock／真实 API 浏览器套件全量回归 | 通过；既有永久计数抵消／纯编辑漏检限制保留 |

父 #11 原清单的配置操作×在途阶段／代次 fencing／停止后不新领取／重纳入恢复／迁移，仍由 [#29 验收](acceptance-29.md) 承担，本轮后端全量重跑。父清单的全类型入口、编辑→动态图、计数→评论图、聚合可见状态与浏览器穿透由上表收口；不自动勾选父票或产品 AC，不替代后续交付验收。

## 红→绿与专项材料

- [后端专项](evidence/backend-lifecycle-30.md)：三条公开 Collector／真实 SQLite／HTTP 组合测试，实际成功时间和媒体错误缺口的逐轮红绿。
- [浏览器专项](evidence/frontend-lifecycle-30.md)：两条穿透测试、原始 HTML／JSON、模拟 OSS 阻塞／失败、重开、只读请求及焦点证据。
- `backend/tests/test_source_pacing.py`：最初模块缺失，补最小等待传输后首例通过；正式 API 默认装配测试先失败（6 个 page 请求没有 wait），接入默认 transport 后通过。最终 6 例涵盖 Collector 发现、显式初始化根回复和尾页复查、API／采集正式装配、并发不串行网络、信号检查不受分页等待阻塞、取消后不发送并释放后续请求。时间与网络仅在外部边界替换。
- `tests/manage-checks.test.tsx`：新增三轮红绿，分别捕捉新时间／错误映射缺失、非法媒体错误数组被接受、页面展示缺失。旧 DTO 缺字段回退 null／空数组；非法时间、任意错误文本不显示。新增浏览器断言核验真实后端的正文／动态图／评论图时间及错误恢复。

## 最终可复现命令与结果

Node 命令先执行 `source ~/.nvm/nvm.sh && nvm use`；浏览器在本机代理环境另设 `export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost`。

| 命令 | 结果 |
| --- | --- |
| `uv run pytest backend/tests -q --tb=short` | **663 passed** |
| `uv run pytest backend/tests/test_source_pacing.py -q` | **6 passed** |
| `pnpm test --maxWorkers=1` | **268 passed**，25 文件 |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过，生产 API Adapter 产物 |
| `pnpm test:e2e:archive` | **38 passed**；新增字段完成后另跑 `archive-lifecycle.spec.ts` **2 passed** |
| `pnpm test:e2e:manage` | **7 passed** |
| `pnpm test:e2e` | **104 passed、10 skipped**；跳过项仅限 Nginx 专用静态交付场景 |
| `git diff --check` | 通过 |

初次默认并行 Vitest 出现 6 个 5 秒超时，限制为 2 workers 后剩 1 个；该单文件独跑 23 项通过。未修改超时或生产逻辑，最终单 worker 全量通过；并行负载下的时限不作性能保证。

后端初始基线和中途全量出现既有 `test_three_targets_obey_two_sync_slots_without_stalling_checks[run]` 偶发超时。最小诊断发现数据库已写入不等于检查 coroutine 已退出，测试要求每目标每槽时间戳精确等于虚拟当前时刻，与允许 busy-skip 的规则冲突。修测试为在慢同步仍阻塞时观察真实计数请求持续进展，保留并发槽／revision／无重复采集／读写协调断言，不改调度规则、不放宽超时。recovery 文件 13 项及双参数连续 30 次重跑通过，最终后端全量 663 项通过。

## 审查与交付边界

本轮按开始时 `561b1e2ef47ce123be82794b57aae4440478f490` 审查暂存变更（含新增文件），Standards 与 Spec 分派独立 review 代理；用户要求 review 后统一提交当前分支。

- **Standards**：无明文规范硬违规；指出分页 URL 散落、评论 owner 无关时间字段、验收索引遗漏及数组 index key 等判断项。共享 `source_endpoints.py` 供分页读取和等待策略引用；限定动态图时间只写动态 owner；补总验收／浏览器专项索引；媒体错误按固定码去重并用稳定 key。`trust_env=False` 在 transport／client 分层明确禁环境代理，保留而不误删。
- **Spec**：无漏项、越界或阻断缺陷；同样发现评论文档的无意义动态图时间。先在公开评论 HTTP 测试加不应出现该字段的断言，实跑失败，再限定 owner 后通过。专项表中的数字明确为“起始行号”，不误称函数行数；busy-skip 修测保留为明示判断项。
- 审查修正后节流／组合／评论媒体专项 **38 passed**；两个独立 review 增量复核均无确认问题（Standards 0 个遗留硬违规、Spec 0 个遗留缺陷／漏项）。最终再次执行后端全量 **663 passed**、Vitest 单 worker 全量 **268 passed**、类型检查／生产构建通过、新组合浏览器 **2 passed**；不把判断性 smell 当作明文违规。

- 未运行 Nginx／云部署、真实 B站请求或 OSS，未读取真实 Cookie／密钥；不宣称自然编辑、权限、精确计数口径或持续 15 秒运行已验证。
- Chromium 移动模拟不等于 iPhone Safari 真机，当前自动化不代替 Linux Chrome／Safari 正式设备签收。
- 本票不完成 #31–#34，不宣称整个后端集成或父 #11 已完整验收；转交维护者复核和后续部署。
