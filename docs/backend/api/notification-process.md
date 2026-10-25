# 通知进程与动态变化投递契约

状态：**01 票据已交付**（动态变化通知首条闭环）。本文描述当前代码已实现的服务端契约：进程启动、配置、事件资格、持久状态、投递参数与恢复语义。自动化只使用虚构凭据、临时 SQLite、受控接收端与本地替身；**真实飞书群投递、三进程托管与目标环境运行尚未验证**，见[票据 01 证据](../../../.scratch/feishu-notifications/evidence/01-dynamic-change-notification.md)。

业务规则以[飞书通知需求与设计](../../design/feishu-notifications.md)为准，本文只写实现契约。锁定的模块接口：

| 模块 | 职责 |
| --- | --- |
| `backend/bili_monitor/notifications/config.py` | 读取路由配置与本站基址；`repr`、日志、队列都不复制 webhook |
| `notifications/message.py` | 快照 → 飞书富文本载荷、载荷大小预算、业务响应判定 |
| `notifications/outbox.py` | 事务发件箱：阶段、正文写领取、版本去重、事件、目标投递、领取/回写 |
| `notifications/delivery.py` | 独立投递：短事务领取 → 事务外请求 → 按领取凭证回写 |
| `backend/bili_monitor/notifier.py` | 进程入口、单实例锁、信号退出 |

## 1. 进程

```sh
export BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite
export BILI_NOTIFICATION_CONFIG=/srv/bili-monitor/notifications.json
exec .venv/bin/python -m backend.bili_monitor.notifier
# 只处理一轮到期记录并退出（运维排查用）：
.venv/bin/python -m backend.bili_monitor.notifier --once
```

- 独立进程，与 API、collector 使用同一 SQLite；API 与 collector 不内嵌通知定时器，只读 HTTP 不产生事件。
- 启动时取得数据库旁 `.notifier.lock` 排他锁，重复启动直接失败（`Notifier already running`）；崩溃后锁由内核释放。
- 启动时执行 `Store.migrate`（当前 schema v16），并重新核验“等待配置”的待投递记录，使修复后的配置无需等待复检周期。
- 默认每 **1 秒**领取一轮，单轮有限批量（8）；网络等待、限流与退避都在数据库事务之外。
- 单轮领取/回写失败（如 SQLite 写锁竞争）只记录固定分类并继续下一轮，不停掉投递进程；持续失败告警属票据 08。
- 当前 `backend.bili_monitor.service` 仍只托管 API 与 collector；三进程托管与启停编排属于票据 10。

## 2. 配置

配置文件只存在于服务端仓库外，格式：

```json
{
  "base_url": "https://archive.example.invalid",
  "ups": {"900719925474099312345": {"up": "up-room"}},
  "dynamics": {"123": {"up": "up-room-123"}},
  "destinations": {
    "up-room": {"webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/<fictional-token>"},
    "up-room-123": {"webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/<fictional-token>"}
  }
}
```

- 动态覆盖优先于所属 UP 的默认角色，缺失就进入“等待配置”，**不跨角色补位**（不会把全员群或系统群当 UP 群）。
- `base_url` 只接受无凭据、无查询串的 `http(s)` 地址（服务器配置，不从请求头推导）；链接为 `{base_url}/dynamics/{id}`。
- 目的地只保存引用标识；发件箱、日志、错误与消息快照都不含 webhook。
- 修复流程：编辑配置文件 → 重启通知进程。记录保留、阶段与基线不重设、已成功目标不重发。
- 未来票据补充全员群/系统群与告警节流时沿用同一配置形状，不新增第二套凭据入口。

## 3. 事件资格与去重

- 只有**可信任的新版本正文实际成功归档**（`Store.finish_archive` 的 success 分支内）才登记动态变化事件；计数、定位、聚合 revision、未知/失败/受限信号都不单独产生事件。
- 首次取得正文只建立基线；已有归档首次启用通知时，用已有可信版本作基线，不补发旧版本。
- 正文事件按 `(dynamic_id, 已成功取得的可信版本)` 去重，跨重启、重复扫描与重新入选有效；同一版本重复提交不重复登记。
- 通知阶段是自有身份，**不等于入选令牌**：`refresh_selections(reset=True)` 会轮换全部入选令牌（recent_n/模式变化），持续入选的目标沿用原阶段与原基线。
- 目标真正离开入选时封存阶段；重新入选建立新阶段，以恢复后第一份可信正文重建基线。停用后在途执行仍可保存内容，但因领取时绑定的阶段已封存而不产生事件。
- 消息快照在登记事件时冻结（动态 ID 与标题）；投递与重试不读取最新归档，标题缺失或仅空白回退动态 ID。

## 4. 持久状态

| 表 | 语义 |
| --- | --- |
| `notification_phases` | UP、动态、阶段令牌、开始时间、当前基线版本、是否封存 |
| `notification_body_claims` | 每次正文领取绑定的写代次与阶段，用于提交时核验 |
| `notification_versions` | 已取得的可信版本，事件去重 |
| `notification_events` | 稳定事件身份 `(kind, dynamic_id, version)`、所属 UP、消息快照、生成时间 |
| `notification_deliveries` | 每目标状态 `waiting_config`/`pending`/`inflight`/`sent`、重试时间、领取凭证与租约、脱敏错误、成功时间 |

- 正文、事件与 UP 群投递记录在**同一事务**提交或回滚；正文失败或未知信号只保留待同步状态。
- 投递结果不回写归档成功 checkpoint；已入队记录不随监控配置删除而级联（新表不引用 `monitors`/`targets`）。
- 到期领取走 `(state, due_at)` 索引，过期租约走 `(state, lease_until)` 索引；不扫描评论表推断新增。

## 5. 投递与恢复参数

| 参数 | 当前值 | 说明 |
| --- | --- | --- |
| 轮询间隔 | 1 秒 | 提交后通常在下一轮开始投递，不承诺一秒送达 |
| 单轮批量 | 8 | 有限批量，短事务领取 |
| 租约 | 30 秒 | 过期可被重新领取；失效凭证不能覆盖新领取结果 |
| 重试退避 | 2 秒起，指数增长，上限 300 秒 | 网络异常、超时、HTTP 失败、平台业务失败都保留记录 |
| 限流 | 优先使用 `x-ogw-ratelimit-reset`，否则 60 秒 | 官方自定义机器人 100 次/分、5 次/秒，可能返回 HTTP 429 或 `11232` |
| 请求超时 | 10 秒 | 事务外执行，慢请求不阻塞采集与数据库写入 |
| 等待配置复检 | 60 秒，且进程启动时立即复检 | 缺目标时不做无效 HTTP |

## 6. 飞书协议（已核验官方文档，未做真实投递）

- 载荷：`POST {webhook}`，`{"msg_type": "post", "content": {"post": {"zh_cn": {"content": [[...]]}}}}`；动态变化只有两段文本 + `{"tag": "a", "text": "查看动态", "href": ...}`，不使用 `at`/`img` 标签，来源文本不会变成提及或图片。
- 成功判定：HTTP 200 **且**响应体业务码 `code == 0`（旧版 webhook 兼容 `StatusCode == 0`）；`{"code": 9499}`、非 JSON、HTTP 500 都算失败并保留重试。
- 载荷上限：自定义机器人请求体 20 KB；标题按序列化后的 UTF-8 长度裁剪，链接保持完整。

## 7. 迁移

- 空库与旧库都迁移到 `user_version = 16`；新增表与索引可重入（`IF NOT EXISTS`），已是 v16 的库重复执行不变。
- 旧库保留归档、观察、checkpoint、入选令牌与近期窗口状态；已成功归档的已选目标以现有可信版本作基线，不补发历史。
- 迁移失败整体回滚（含版本号），可修复后重试；未来版本仍拒绝启动。

## 8. 当前未覆盖

- 新增评论（一级/楼中楼）事件与双群路由、告警、心跳、投递管理 UI：票据 04–09。
- 三进程统一托管、真实飞书群投递、飞书内置浏览器/手机链接验证：票据 10、11（另需授权）。
- 秒级送达、跨群同时送达、飞书端绝对一次送达均不承诺；飞书已接收但响应丢失时可能重复。
