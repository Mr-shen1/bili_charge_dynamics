# 01 动态变化通知首条闭环：实施与验收证据

对应票据：[01 动态变化通知首条闭环](../issues/01-dynamic-change-notification.md)；实施规格 [spec.md](../spec.md)；正式规则 [飞书通知需求与设计](../../../docs/design/feishu-notifications.md)；实现契约 [通知进程与投递](../../../docs/backend/api/notification-process.md)。

结论：**票据范围（动态变化 → UP 群 → 本站动态链接）已实施并取得自动化主链、隔离进程与迁移证据**。真实飞书群投递、飞书内置浏览器/手机、三进程统一托管与目标环境运行未验证，也未部署。

## 1. 环境与命令

- 环境：Linux，Python 3.12.15（`.python-version`），依赖经 `uv sync --locked`，Node 未参与本票。
- 隔离：临时 SQLite；B 站 HTML/JSON 为受控字节；飞书为进程内 `httpx.MockTransport` 替身（单测）与**本机 HTTP 服务**（进程级测试）；凭据全部虚构（`fake-up-token`、`https://archive.example.invalid`）。
- 主命令（本票新增测试）：

```sh
uv run --no-sync python -m pytest \
  backend/tests/test_dynamic_notifications.py \
  backend/tests/test_notification_protocol.py \
  backend/tests/test_notification_delivery.py \
  backend/tests/test_notification_migration.py \
  backend/tests/test_notification_process.py -q
# 44 passed
```

- 全量后端回归（含既有采集/归档/评论/媒体/迁移/部署进程用例）：

```sh
uv run --no-sync python -m pytest backend/tests -q
# 869 passed, 3 warnings in 142.38s
```

- 可复现演示（不访问网络、不读真实凭据）：

```sh
demo_dir=$(mktemp -d)
uv run python -m backend.tests.notification_demo --database "$demo_dir/monitor.sqlite"
# {"step": "baseline", "archive_text": "第一版", "delivered": 0}
# {"step": "change", "archive_text": "第二版", "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/fictional-demo",
#  "message": "动态【123】发生变化\n链接：查看动态"}
# {"step": "restart", "dispatched": 0, "delivered": 0, "states": ["sent"]}
# 同一路径再次运行：{"step": "restart", ..., "archive_text": "第二版", "states": ["sent"]}
```

## 2. 红绿过程（TDD）

1. 先写 `backend/tests/notification_support.py` 与主链测试，运行得红：`ImportError: cannot import name 'Dispatcher' from 'backend.bili_monitor.notifications'`（当时工作树仅有未接线的 `config.py`/`outbox.py` 草稿）。
2. 实现 `config.py` → `message.py` → `outbox.py` → `delivery.py` → `notifier.py` 接线后，主链首个用例转绿；随后补齐退避/租约/等待配置/迁移/进程用例，逐组跑红→绿。
3. 过程中被测试纠正的两处实现缺陷：
   - 媒体/评论阻塞用例暴露旧断言依赖“计数变化才能待同步”，改为断言“评论计数观察失败 + 媒体失败时正文仍可通知”；
   - API 显式初始化用例暴露“初始化复用既有观察代次”，测试改为先真实检查出可信新版本、再走 API 归档入口。
4. 迁移用例反向要求建表可重入（既有 `test_inflight_recovery`/`test_migrations` 会把 `user_version` 回退后重放旧迁移），因此通知表与索引改为 `IF NOT EXISTS`，并把本票两个既有断言基线从 15 更新为 16、未来版本拦截基线从 16 更新为 17。

## 3. 验收条件 → 证据

| 票据验收条件 | 证据（用例） |
| --- | --- |
| 采样/检查节拍不变；只有可信版本变化且正文成功归档才登记 | 未改 collector 与页面信号采样；`test_first_body_baseline_and_untrusted_signals_never_notify`（未知/无效信号、计数与聚合代次不产生事件）、`test_body_failure_then_success_notifies_exactly_once`；既有 `test_page_signal_throttle`/`test_collector_cadence` 回归通过 |
| 首次正文只建基线；计数/定位/代次/未知信号/失败/受限不单独通知 | `test_first_body_baseline_and_untrusted_signals_never_notify`、`test_notification_migration.py::test_existing_database_keeps_archive_and_checks_and_reuses_trusted_baseline` |
| 正文与事件、UP 群投递同事务提交或回滚 | `test_rollback_of_event_and_content_leaves_no_partial_notification`（同一事务内向投递表插入失败 → 正文 `synced_version`、文本、事件、投递全部回滚，修复后重试只发一次） |
| 按（动态, 可信版本）去重并保存快照；重启/重复同步不重复 | `test_committed_trusted_change_delivers_only_once_after_restart`、`test_snapshot_is_frozen_when_event_is_generated`、`test_notification_process.py::test_notification_process_delivers_once_and_survives_restart` |
| 提交时核验通知阶段与入选代次；停止后旧在途不新增通知；首次恢复重建基线 | `test_stop_before_body_commit_keeps_content_without_new_notification`、`test_reselection_rebuilds_baseline_and_old_inflight_execution_cannot_notify`、`test_configuration_reset_keeps_phase_and_never_resets_baseline` |
| 正文成功即可投递，不等待评论/图片；通知结果不改归档 checkpoint | `test_body_success_notifies_while_media_and_comments_still_fail`、`test_batch_limit_and_independent_deliveries`（投递前后归档文档相等） |
| 本站基址与 UP 群路由有效；标题缺失/空白回退动态 ID；安全展示 | `test_titled_change_uses_title_and_blank_title_falls_back_to_dynamic_id`、`test_notification_protocol.py` 的载荷/回退/控制字符/超长裁剪用例 |
| 最小配置不暴露凭据；缺目标保留待配置记录 | `test_missing_destination_waits_for_config_then_delivers_after_repair`、`test_notification_process.py::test_process_keeps_message_waiting_for_missing_route_then_delivers`、配置 `repr`/校验/发件箱转储断言 |
| 独立进程 1 秒轮询、有限批量、网络不占事务；API 无定时器 | `test_documented_runtime_defaults_are_finite_and_one_second_polling`、`test_batch_limit_and_independent_deliveries`、`test_feishu_request_does_not_hold_a_database_write_transaction`、`test_explicit_api_initialization_registers_event_without_delivering` |
| 业务成功判定、失败可恢复退避、成功状态持久 | `test_business_success_requires_platform_code`（9 组响应）、`test_business_rejection_is_retried_with_backoff_until_accepted`、`test_rate_limit_uses_platform_suggestion_and_network_errors_retry`、`test_expired_lease_is_recovered_and_stale_completion_is_rejected`、`test_transient_cycle_failure_does_not_stop_the_delivery_loop`（单轮数据库瞬时失败后继续轮询并最终投递） |
| 迁移保留旧归档/观察/同步状态，可重复、失败可恢复 | `test_notification_migration.py` 三例（旧库保留、失败整体回滚后重试、空库） |
| 受控主链证明本站可读、飞书替身收到正确目标与内容、链接有效 | `test_committed_trusted_change_delivers_only_once_after_restart`（发送时通过真实 API 读到“第二版”）、进程级用例（真实 HTTP 接收端收到 `/open-apis/bot/v2/hook/fake-process` 与含 `href` 的载荷） |

## 4. 关键设计决定与依据

- **通知阶段是自有身份，不等于入选令牌**：`refresh_selections(reset=True)` 会为持续入选的目标轮换 `target_selections.token`；若用令牌相等围栏会误杀合法续选，因此阶段以 `notification_phases.token` 自持，入选状态只作“此刻仍入选”的布尔判据。`test_configuration_reset_keeps_phase_and_never_resets_baseline` 用生产 `refresh_selections(reset=True)` 证明令牌轮换后阶段与基线不变、后续变化照常通知。
- **`archives.generation` 只作内容写围栏**：正文领取时把当次 `generation` 与当前阶段写入 `notification_body_claims`，提交时同时校验 `generation` 与“阶段未封存 + 目标仍入选”，避免停止后旧在途借新阶段发通知。
- **飞书业务成功以响应体业务码为准**：官方自定义机器人文档给出的成功响应为 `{"code":0,"msg":"success","StatusCode":0}`，格式错误为 `{"code":9499}`；因此 HTTP 200 + 非零 `code` 记为失败并保留重试。限流依据官方 100 次/分、5 次/秒限制与 `HTTP 429`/`11232`/`x-ogw-ratelimit-reset` 处理。
- **载荷**：官方富文本 `post` 的段落支持 `{"tag":"a","text":...,"href":...}`，`zh_cn.title` 可选，本票输出两段文本（变化提示 + 链接文本）与一个 `a` 节点；不使用 `at`/`img`，来源文本不会变成提及或图片；请求体按序列化后 UTF-8 长度控制在官方 20 KB 内。
- **缺路由不转投**：动态覆盖缺失且 UP 默认角色缺失时进入 `waiting_config`，周期复检（60 秒）且进程启动时立即复检，修复配置后补发而不重设阶段。

## 5. 未覆盖与限制（不得据此宣称完整交付）

- 新增评论（一级/楼中楼）事件、双群路由、逐群故障矩阵：票据 04–07；本票只落地动态变化一种事件与 UP 群一个目标角色。
- 告警、心跳：票据 08、09；通知进程尚未接入系统群。
- 三进程统一托管（`backend.bili_monitor.service` 仍只托管 API＋collector）、真实飞书群投递、飞书内置浏览器/手机链接验证、目标环境运行与资源测量：票据 10、11（11 另需授权）。
- 飞书已接收但响应丢失时仍可能重复（用户已接受）；不承诺一秒送达、跨群同时送达或捕获每个中间编辑版本。
- 通知队列状态机的并发压力（多目标争抢写锁）只在单进程 + 本机 HTTP 下验证；三进程写竞争实测属票据 10。
- 演示与测试中的“飞书成功”均由受控接收端返回，**不构成真实飞书验收**。

## 6. 代码与文档指针

- 实现：`backend/bili_monitor/notifications/{config,message,outbox,delivery,log}.py`、`backend/bili_monitor/notifier.py`；接线点 `backend/bili_monitor/storage.py`（`claim_archive`/`finish_archive` 内同事务登记）、`backend/bili_monitor/selection.py`（阶段开始/封存）。
- 测试装配：`backend/tests/notification_support.py`；演示：`backend/tests/notification_demo.py`。
- 契约文档：[通知进程与动态变化投递](../../../docs/backend/api/notification-process.md)；运行入口见 [backend/README.md](../../../backend/README.md)「飞书通知进程（01）」。
