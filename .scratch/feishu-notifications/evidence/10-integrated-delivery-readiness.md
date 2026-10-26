# 10 三进程集成与交付准备：证据

状态：**隔离交付准备完成，可申请真实验收**。本票只完成自动化与隔离部分；真实飞书群、飞书内置浏览器/手机、目标环境三进程与真实容量均未验证，留给票据 11（另需人工授权）。不关闭父规格，不继承历史 AC-01–AC-34 的通过结论，不宣称上线。

- 工作树/分支：`/tmp/feishu-worktrees/10`、`feat/feishu-10`
- 集成基线：`b6cef2c`（`feat/feishu-notifications` 当时的 tip；已确认为 HEAD，无需再合并）
- 被测代码提交：`f5692ec`（`feat(feishu): 三进程集成装配与交付准备`）
- 文档/证据提交：本文件所在提交（指向上述被测代码，不要求自引用）
- 未读取真实通知配置/凭据，未向真实飞书发送，未访问真实 B 站/OSS，未启动/停止既有 live 实例（18445）或占用 4173 的 ssh 隧道，未部署，未操作主工作树。

## 1. 方法与证据边界

三个已确认测试入口在本票的组合方式：

| 入口 | 本票如何组合 | 只替换什么 |
| --- | --- | --- |
| 归档到飞书投递主链 | 实际 API＋独立 collector＋生产通知进程共享一个临时 SQLite；受控来源归档正文/根评论/后续页回复；通知进程 HTTP 打到本机接收端 | B 站页面/detail/评论页、媒体下载与上传、飞书 HTTP、时间（仅组合用例受控） |
| 本站深链接到浏览器定位 | 取**真实投递消息里的链接**，在生产前端装配（`/api` 代理到实际后端）里打开 | 外部图片传输；不替换 API/Adapter/SQLite/路由 |
| 少量真实进程与迁移 | 真实子进程启动/强杀/重启、租约恢复、统一托管入口、库副本重复迁移 | 本地受控接收端与故障注入 |

不使用进程内 `MockTransport` 充当跨进程飞书；`deployment_fixture`（单动态零评论）与 `live_app`（进程内通知替身）没有被拿来冒充三进程完整链。

## 2. 环境与版本

| 项 | 实测值 | 说明 |
| --- | --- | --- |
| Python | 3.12.15 | `uv run --no-sync python -V`；`uv sync --locked` 同步依赖 |
| uv | 0.12.23 | 本工作树为干净检出，先做环境同步；未改变锁定版本 |
| pytest | 8.4.2 | `uv run --no-sync pytest` |
| Node / pnpm | v24.21.0 / 10.34.6 | `nvm use`（仓库 `.nvmrc`）、`pnpm install --frozen-lockfile` |
| Playwright | 1.58.2（chromium-1208） | `@playwright/test` 锁定版本 |
| Nginx | 1.28.0 | `/tmp/nginx-16/nginx-1.28.0/objs/nginx`，mime.types 同目录 `conf/mime.types`；`-v` 复核通过 |
| SQLite schema | v21 | 迁移到 v21；`test_three_process_delivery` 重复迁移断言 `user_version=21` |
| 系统 | Linux，8 逻辑核 | 代理变量显式 `NO_PROXY=127.0.0.1,localhost` |

## 3. TDD 修正：05 纯图补丁的回复图片回归

**缺陷**：`replies.reply_pictures` 用与根评论相同的严格 `media_sources` 校验解析回复图片。来源 `content.pictures` 非 list、条目缺 `img_src`、条目不是对象或 URL 非法时抛 `ValueError`/`KeyError`/`TypeError`，`fetch_reply_page` 整页失败，同页合法文字回复既不归档也不通知，违反“保留既有归档/媒体行为、回复图片采集范围外、未知不能当无图”。

**红**（修复前，`f5692ec^`）：

```bash
uv run --no-sync pytest backend/tests/test_reply_notifications.py \
  -k "unreadable_reply_picture or unknown_reply_picture_metadata_keeps or root_comment_picture_validation"
# 5 failed, 1 passed
# [missing-img-src]/[not-a-list]/[invalid-url]/[non-object-entry] 与“未知不抹已知”均失败；
# 根评论严格校验用例在修复前即通过
```

**绿**（修复后）：同一命令 5 passed；`backend/tests/test_reply_notifications.py`＋`test_replies.py` 合计 51 passed。

**修正语义**：

- 图片元信息无法可靠解释 → `has_pictures=None`（未知），不否决整页合法回复；只要列表里有一个可可靠解释的图片条目即已知 `True`，空列表仍为已知 `False`。
- 未知不覆盖既有已知值（沿用 `_merge_known`：`None` 不覆盖）。
- 根评论 `root_document` 的严格图片校验**不变**（`test_root_comment_picture_validation_stays_strict` 锁定）。
- 没有放宽身份/root/资源一致性校验，也没有新增上游请求或保存回复图片 URL。

**同轮核验的其他审查点**（未发现需要改代码的缺陷）：

- 告警 `SAVEPOINT` 写失败只丢该告警并留固定日志；持久失败事实（`failures`/`state`/`error`）仍在，下一轮扫描可重建提醒——`test_alert_registration_failure_leaves_only_a_sanitized_log`、`test_delivery_failure_threshold_alerts_only_persistent_business_failures`。
- 消息快照业务字段在事件登记时冻结，重试不读最新归档——`test_snapshot_is_frozen_when_event_is_generated` 与 05 的冻结用例；三进程链中同一事件重试链接不变。
- 主循环异常在数据库可写时用独立连接短事务登记；数据库不可写/进程被强杀/整机离线时只留脱敏日志，属已声明边界，不作为本票缺陷。

## 4. 三进程组合链（`backend/tests/test_three_process_delivery.py`）

装配：`uvicorn backend.tests.delivery_fixture:create_app --factory`（实际 API）＋`python -m backend.tests.delivery_fixture --database <同一路径>`（真实 Collector 锁/节拍/信号）＋`python -m backend.bili_monitor.notifier`（生产入口，`.notifier.lock`）＋本机 `ThreadingHTTPServer` 接收端；受控来源状态文件在节拍之间切换，测试从不直接写归档/事件表。

覆盖与结果（4 passed，20.55s）：

1. **三链与路由**：两个 UP（202/707）；本人一级评论与本人回复 → UP 群＋全员群；另一位受监控 UP 串门、纯图、超长、普通评论 → 只进全员群；动态变化只进 UP 群；系统群无业务正文。标题缺失的 124 回退动态 ID。北京时间到秒、换行与 emoji、“回复 @”上下文保留、纯图占位、超长截断提示与链接保留。
2. **部分失败**：第 2 页首次失败时第 1 页已提交评论照常投递；修复后第 2 页评论与第 3 页回复才通知，`root_comments_error` 如实记录，不宣称整轮完整。
3. **消息链接可读**：从接收端载荷取 href，按源码路径读取实际 API：`/api/archive/dynamics/123`、`.../comments/860030/location`（第 2 批）、`.../comments/860001/replies/960022/location`（第 3 页）；链接形状与 02/03 精确入口一致。
4. **只读不采集**：上述读取前后 API 进程上游请求数不变（采集进程请求单独记账，避免把固定节拍采样混入断言）。
5. **重启语义**：停止并重启真实 collector，通知阶段 token/起点/评论起点/封存状态不变，事件数与已发消息数不变（不重复事件、不重建基线、不改成功目标）。
6. **路由修复**：缺 `all` 目标时 UP 群成功、全员群 `waiting_config`；修文件并重启通知进程后只补发全员群，UP 群计数仍为 1，阶段与快照逐字节不变，历史不补发。
7. **单实例/强杀恢复**：同库第二个通知进程被 flock 拒绝（`Notifier already running`）；飞书阻塞期间 SIGKILL 后重启（租约 2s）恢复 inflight 目标，已成功目标保持 `sent` 且不重发；被杀那次请求已到达接收端，重投意味着外部可能重复（如实断言）。
8. **迁移演练**：真实三进程写出的库停机后复制副本，重复迁移两次；归档正文、监控配置、检查时间、通知阶段与投递记录保持不变，`user_version=21`。

## 5. 资源与写竞争实测（一次隔离运行，不构成容量承诺）

`test_blocked_feishu_keeps_other_processes_writing_and_recovers_after_kill` 在飞书请求阻塞期间记录（`DELIVERY-METRICS`）：

| 指标 | 实测值 |
| --- | --- |
| API `VmRSS` / CPU（累计） | 72 240 KB / 0.61 s |
| collector `VmRSS` / CPU | 69 960 KB / 0.42 s |
| notifier `VmRSS` / CPU | 50 844 KB / 0.22 s |
| SQLite 文件＋WAL/SHM | 217 088 B |
| 飞书阻塞期间的 20 次真实 API 写 | 全部 200，合计 0.056 s |
| 期间事件/投递记录 | 2 / 3 |
| 上游请求（API 进程 / collector 进程） | 2（目标归属校验）/ 16（固定节拍采样） |

结论仅限本次隔离运行：飞书阻塞不持有 SQLite 写事务，采集与 API 写仍可完成。**不声称 2 核 2 GB 容量、并发上限或长期资源稳定性**。

## 6. 告警、心跳、阶段与失败队列组合

`backend/tests/test_notification_combinations.py`（1 passed）在同一临时库组合验证：

- 业务 UP 目标持续失败 ≥3 次 → 只登记一条 `delivery` 告警；同一对象 30 分钟内重复失败合并，不新增同类事件。
- 同一小时心跳与告警共存；告警节流不读写 `notification_heartbeats`，不抑制心跳。
- 系统群自身失败只重试原任务，不产生对象以 `system:` 开头的递归告警（08 的“不递归”在组合场景仍成立）。
- 越过心跳有效期后只有心跳转 `expired`；业务 `pending` 与告警 `pending` 的 `expires_at` 仍为空、不被连带淘汰。
- 阶段切换与候选：封存阶段的候选补齐后不生成跨阶段通知；内容照常归档；告警节流与心跳状态不被阶段切换清除。
- 系统群恢复后只补发已登记的那一条提醒，不因系统失败补出新告警。

## 7. 统一托管入口（第三个通知进程）

`backend/bili_monitor/service.py`：

- 三个子进程：API →（API 完成迁移并监听）→ collector → 通知进程；`BILI_NOTIFICATION_CONFIG` 未设置时保持两进程兼容形态（不投递），设置时通知进程仍走生产入口与 `.notifier.lock`。
- 任一子进程退出 → 停止其余进程并以固定错误退出，供 systemd 重启；TERM 按通知 → 采集 → API 反向顺序逐个等待退出。
- API 仍不内嵌通知定时器（既有 `test_api_and_collector_never_start_the_notification_process` 继续通过）。
- `backend/tests/test_service_processes.py`（5 passed）用可控进程替身验证启动顺序、反向收尾、任一子进程退出联动、无通知配置时两进程形态、API 未就绪不启动 worker、通知入口仍用生产模块与真实配置加载。
- `deploy/bili-monitor.service`、`deploy/bili-monitor.env.example` 同步第三进程、`BILI_NOTIFICATION_CONFIG`、启停/迁移/路由修复说明。

## 8. 浏览器入口与静态交付

### 8.1 `pnpm test:e2e:delivery`（新增，5 passed）

用例自起 API/collector/生产通知进程与本机接收端，共享临时 SQLite；只打开真实投递消息里的链接，页面走生产装配与真实 `/api` 代理：

- 动态链接打开后可见第二版正文，刷新仍可读，返回列表可用。
- 后续批一级评论（第 30 条，不在首批 20 条）直开/刷新/窄屏均定位到目标本身且不横溢。
- 后续页回复（第 3 页第 22 条）宽屏内联展开定位、窄屏独立楼中楼页定位、刷新后仍定位。
- 不存在的目标给出“目标评论/回复不存在或未归档”提示并保留返回动态入口；API 404/422 保持 JSON、不回退 `<div id="app">`。
- 路由矩阵从实际载荷断言（动态只在 UP 群、串门/纯图/超长只在全员群、本人评论双群、124 标题回退）；读取消息链接前后 API 上游请求数不变。

### 8.2 `pnpm test:delivery`（隔离 Nginx 1.28.0，`DELIVERY_PORT=4273`）

- 新增两条精确入口深链接（`.../comments/:rootId/locate`、`.../replies/:replyId/locate`）直达/刷新返回入口与 `no-cache`；浏览器验证目标不存在的明确提示与返回动态。
- 生产反代断言新增 `/api/archive/dynamics/91001/comments/999999/location` → 404 JSON、`no-store`、不含应用入口；既有 `/api/manage/` Basic 401 不回退 SPA 仍通过。
- 全脚本 PASS：mock 产物 33 个哈希资源、生产六路由/30 个哈希资源、构建更新与回退、API 502/401/秘密扫描、SQLite 与 collector 未替换。

## 9. FS-AC-01–14 台账

图例：**隔离通过**=自动化/隔离证据通过；**真实未验证**=留给 11 的真实飞书/设备/目标环境部分。没有任何一项被标为“正式验收通过”。

| 条件 | 本票状态 | 隔离证据（自动化） | 真实未验证（11） |
| --- | --- | --- | --- |
| FS-AC-01 模板/回退/时间/换行/纯图/恶意文本/超长载荷 | 隔离通过 | `test_notification_protocol.py`、`test_root_comment_notifications.py`、`test_reply_notifications.py`、三进程链内容断言；超长按 20 KB UTF-8 预算截断并保留链接 | 真实飞书渲染、真实载荷上限、签名 |
| FS-AC-02 双 UP 路由矩阵 | 隔离通过 | 一级/回复通知路由用例、三进程链（本人双群、串门只全员、纯图/超长/普通只全员、动态只 UP） | 真实双群/系统群、同名异 UID 真身份 |
| FS-AC-03 58–62 秒信号与正文资格 | 隔离通过 | `test_dynamic_notifications.py`、`test_page_signal_throttle.py`、`test_deployment_processes.py`（固定节拍）；首次正文静默、失败/未知信号不发送 | 真实上游编辑漏检与网络行为 |
| FS-AC-04 评论事件与部分失败 | 隔离通过 | 根/回复通知用例、`test_comment_count_recovery.py`；三进程第 2 页失败仍投第 1 页 | 真实分页、删除/折叠与计数口径 |
| FS-AC-05 起点/基线边界 | 隔离通过 | 04/05 的 09:59/10:01、同秒、已有归档、缺字段补齐用例 | 真实发布时间精度与时区 |
| FS-AC-06 停用/移出/删除/模式/重纳入 | 隔离通过 | `test_notification_lifecycle.py`、`test_notification_lifecycle_processes.py`、`test_inflight_lifecycle.py`；三进程 collector 重启不重建阶段 | 目标环境生命周期操作 |
| FS-AC-07 事务/崩溃/候选/去重 | 隔离通过 | 正文/根/回复各自的回滚与提交后中断用例、候选原子转换用例；三进程 SIGKILL 恢复与 collector 重启不重复事件 | 真实进程崩溃窗口与外部重复 |
| FS-AC-08 领取/索引/租约/慢请求 | 隔离通过 | `test_notification_delivery.py`（索引与租约）、`test_notification_recovery_processes.py`（阻塞请求不占写锁、强杀恢复）、三进程阻塞/竞争实测 | 真实飞书延迟/限流、目标机资源 |
| FS-AC-09 逐目标独立结果 | 隔离通过 | `test_notification_delivery.py`（一群成功一群失败、422/429/丢响应）、三进程路由修复只补失败目标 | 真实平台业务码与限流 |
| FS-AC-10 默认/覆盖/修复/脱敏 | 隔离通过 | 动态覆盖与缺失目标用例、修复后不重发成功目标；三进程修复前后阶段与快照逐字节不变；队列/日志无凭据断言 | 真实配置与真实代理 |
| FS-AC-11 精确链接与分页 | 隔离通过 | `test:e2e:location`（4）、`test:e2e:notification`（4）、`test:e2e:delivery`（5）、`test:delivery` 深链接；宽窄屏/刷新/返回/不存在/代理 | 飞书内置浏览器、手机实机、真实代理鉴权 |
| FS-AC-12 系统告警 | 隔离通过 | `test_notification_alerts.py`、组合用例；五类故障、30 分钟节流跨重启、系统群失败不递归 | 真实凭据失效、真实系统群 |
| FS-AC-13 小时心跳 | 隔离通过 | `test_notification_heartbeat.py`、组合用例；北京 13:40 窗口、同小时去重、错过不补、过期只影响心跳 | 真实系统群、目标机时钟/时区 |
| FS-AC-14 迁移/无 API 定时器/托管/真实 | 隔离部分通过 | `test_notification_migration.py`（含失败回滚重试）、三进程库副本重复迁移、`test_service_processes.py`、`test_api_and_collector_never_start_the_notification_process` | **真实飞书投递、实际客户端/手机、代理访问、目标环境第三进程运行与迁移演练** |

## 10. 全门槛命令与结果（固定候选 `f5692ec`）

后端（仓库根）：

```bash
uv sync --locked
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
  uv run --no-sync pytest backend/tests -q
# 1029 passed, 3 warnings in 189.47s（第二次全量；见 §12 首轮偶发）
```

本票新增/重跑的定向入口：

```bash
uv run --no-sync pytest backend/tests/test_three_process_delivery.py -q
# 4 passed in 20.55s（-s 时输出 DELIVERY-METRICS）
uv run --no-sync pytest backend/tests/test_service_processes.py -q       # 5 passed
uv run --no-sync pytest backend/tests/test_notification_combinations.py -q  # 1 passed
uv run --no-sync pytest backend/tests/test_reply_notifications.py \
  backend/tests/test_replies.py -q                                      # 51 passed
```

前端（`frontend/`）：

```bash
pnpm install --frozen-lockfile
pnpm check          # typecheck + 单测 + e2e 项目覆盖守卫：通过
pnpm check:dist     # 两次构建 + 产物隔离：通过
pnpm test:e2e                 # 203 passed, 10 skipped (3.9m)
pnpm test:e2e:production      # 3 passed, 3 skipped
pnpm test:e2e:manage          # 7 passed
pnpm test:e2e:location        # 4 passed
pnpm test:e2e:notification    # 4 passed
pnpm test:e2e:delivery        # 5 passed (28.0s；复跑 39.9s)
DELIVERY_PORT=4273 \
NGINX_BIN=/tmp/nginx-16/nginx-1.28.0/objs/nginx \
NGINX_MIME_TYPES=/tmp/nginx-16/nginx-1.28.0/conf/mime.types \
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
pnpm test:delivery            # exit 0；mock/生产/更新/回退/401/502/秘密扫描全部 PASS
```

端口与安全：`test:delivery` 用 4273（4173 是既有 ssh 隧道，未触碰）；`test:e2e:delivery` 用 4181/4328；API/接收端均用临时空闲回环端口；未启动/停止 18445 live 实例、未操作主工作树、未推送/部署。`.pi/subagents-lite.json` 全程未暂存/未提交，工作树结束时只有本票文件变更。

## 11. 08 记录的 3 秒墙钟偶发复核

08 记录 `test_comment_count_recovery.py::test_three_targets_obey_two_sync_slots_without_stalling_checks[run]` 在全量运行中偶发失败，原因是用 `asyncio.wait_for(..., 3)` 的墙钟等待门闩。本票复核：

- 空闲连跑 10 次：10/10 通过（每次约 0.9s，两个参数合计）。
- 8 个 CPU 忙循环加压下再跑 3 次：3/3 通过（合计 1.4–2.0s）。
- 未删除用例、未放宽任何断言；`test_comment_count_recovery.py` 无改动。
- 结论：本候选上未复现；该用例仍以 3 秒墙钟为唯一时间假设，属既有节拍敏感用例，如未来在更慢环境失败应作为独立问题处理，不能以延长超时掩盖。

## 12. 首轮全量运行的偶发失败（如实记录）

在固定候选上第一次 `pytest backend/tests -q` 出现 4 个既有跨进程用例失败（均有 5–20s 等待预算）：

- `test_notification_lifecycle_processes.py::test_restart_is_not_reentry_and_real_reentry_only_notifies_content_after_the_new_start`
- `test_notification_recovery_processes.py::test_slow_feishu_request_never_holds_the_write_lock_for_another_process`
- `test_notification_recovery_processes.py::test_killed_process_recovers_lease_and_keeps_the_successful_target`
- 同文件另 1 个（同一轮 4 failed / 1025 passed）

处置：这两个文件单独复跑 5 passed；随后第二次全量运行 1029 passed。未修改这些用例或断言，未把它们转交 11；记录为环境/时序敏感的既有跨进程用例，本票新增代码不涉及其等待路径。最终门槛取第二次全绿结果（§10）。

## 13. 未验证与限制

- **真实飞书**：未发送任何消息；真实群路由、签名、限流、业务码与载荷上限未实测。
- **真实客户端/设备**：未在飞书内置浏览器或手机上打开链接；未验证真实代理鉴权与局域网可达性。
- **目标环境**：未部署三进程、未在目标机执行迁移演练；本文资源数字不构成 2 核 2 GB 或长期运行承诺。
- **可信凭据失效**：`-101` 仍属“可判定但难触发”（上游只读端点未列出），未用真实凭据验证。
- **整份配置非法**时通知进程按启动错误退出，没有告警通道，只能靠托管与日志发现（已有边界）。
- **主循环异常且数据库不可写**、进程被强杀、整机离线时只留脱敏日志，不承诺外发。
- 飞书已接收但响应丢失时可能重复（用户已接受）；不承诺跨群同时/一秒送达。
- 服务器时区非 `+08:00` 的心跳窗口、跨日/跨月边界仅有受控时钟自动化，未在真实目标机时区跑过。
- 首轮全量运行的 4 个跨进程偶发失败未能定位到确定根因（§12），只记录了复跑结果。

## 14. 票据 11 移交清单（准备，不执行）

**授权事项**

1. 两个真实业务群＋一个系统群的通知路由授权，以及允许的有限消息数量/内容（建议：1 条动态变化、2 条一级评论、2 条回复、1 条心跳或 1 条测试告警，总计上限明确写出）。
2. 真实本站基址（群成员可达、与代理/Basic 鉴权一致）与测试动态/评论身份（1–2 条，避免历史评论补发）。
3. 仓库外通知配置文件与凭据的安全注入方式（0600/属主、不打印、不进提交/日志/截图），签名密钥只在服务端。
4. 真实执行窗口、可停止的进程边界与回滚责任人。

**凭据/地址/设备/进程操作边界**

- 只启动本次授权的独立实例与本次新建的临时/演练数据库；不读写生产库，不停止既有 live 实例或 ssh 隧道（含 18445、4173），不修改系统服务、不部署、不推送。
- 设备信息需记录：手机型号/系统/飞书版本、内置浏览器版本、网络（Wi‑Fi/蜂窝）、代理与 401 表现。
- 真实消息数量与内容先书面确认；不在真实群发送测试正文以外的来源内容。

**预期结果**

- 动态/一级评论/回复消息模板、时间、标题回退、纯图占位、超长截断与链接正确；点击链接在宽屏、窄屏、首次打开与刷新时定位并高亮目标；返回/历史恢复不被抢占；目标不存在有明确提示与返回入口。
- 路由矩阵正确（本人双群、他人全员、动态只 UP、系统群无业务正文）；缺配置时保留消息，修复后只补发失败目标、不重发成功目标、不补历史。
- 系统群告警首次提醒、30 分钟内不重复、系统群失败不递归；心跳只报告可观察事实、同小时不重复、过期不投递。
- 迁移前后旧归档、检查状态、配置与阅读入口可用；失败时只回滚、不删库、不用旧版本强开新库。

**不得做**：关闭父规格、改写历史 AC-01–AC-34、把真实部分未验证写成已通过、在真实群做故障注入或大量试发。

## 15. 变更文件

代码/测试：

- 新增 `backend/tests/delivery_fixture.py`、`backend/tests/test_three_process_delivery.py`、`backend/tests/test_service_processes.py`、`backend/tests/test_notification_combinations.py`
- 修改 `backend/bili_monitor/replies.py`（TDD 修复）、`backend/bili_monitor/service.py`（第三进程托管）、`backend/tests/test_reply_notifications.py`（回归用例）
- 新增 `frontend/playwright.delivery.config.ts`、`frontend/tests/e2e-delivery/three-process-links.spec.ts`；修改 `frontend/package.json`、`frontend/tests/e2e/static-delivery.spec.ts`、`frontend/scripts/verify-production-delivery.mjs`
- 修改 `deploy/bili-monitor.service`、`deploy/bili-monitor.env.example`

文档：

- `docs/deployment/static-delivery.md`（三进程启停/迁移顺序/单实例/TERM/路由修复/升级回退边界/隔离入口）
- `docs/backend/api/notification-process.md`（托管入口、迁移演练与降级边界）
- `docs/deployment/aliyun-ecs.md`（当前 schema 与三进程注记，保留目标机历史记录）
- `docs/README.md`、`docs/design/feishu-notifications.md`、`backend/README.md`、`frontend/README.md`
- 本票据 `issues/10-integrated-delivery-readiness.md`（`resolved`）与本文；未编辑 `map.md` / `implementation-plan.md`
