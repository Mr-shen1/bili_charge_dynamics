# 24 可信编辑与版本正文验收记录

## 范围与契约

接续 [23](acceptance-23.md) 的独立固定节拍底座，沿用 #02 安全 HTML 初始化 JSON 解析、归档提交及分项媒体协议，不另造采集服务。检查 observed 是最近可信观察；归档正文／媒体 checkpoint 绑定实际取得的版本；检查 revision、执行工作与分项归档结果独立。无变化检查不推进归档成功，正文成功不表示评论或图片完成。

管理 `/manage` 每个 UP 提供只读“读取检查状态／重新读取检查状态”，不自动轮询、不调用检查或同步入口。尚未读取不冒充未检查；停用、近期模式及已删监控配置的身份仍可查看保留状态。检查与执行结果、分项、观察／正文成功版本不一致提示、实际成功时间和错误分别展示。生产映射验证响应结构、枚举、字符串 ID、日期及重复目标；不回显任意来源／HTTP 错误原文。见 [状态接口](../../docs/backend/api/collector-api.md)。

## 测试入口

沿用规格已确认的 T1/T2/T3：生产 Adapter + 页面交互、真实 SQLite + 公开 HTTP + 重开、原始 HTML + 公开检查／执行入口。只替换外部 HTTP、时钟或故障边界，不使用真实 Cookie／上游／OSS。

### T1 管理及正文

`tests/manage-checks.test.tsx`：

- 大字符串 ID、observed 与实际正文版本分离，检查无变化不表示同步完成。
- 正文／动态图分项针对最新检查观察，版本不一致时提示仍待同步确认；正文成功／媒体 pending 的部分完成与 running 分开。
- 未检查、未知／错误信号、停用保留记录、实际整轮成功时间不混淆；UP 最大时间不表示全体目标完成。
- 状态读取失败保留此前结果、原位重读；忽略取消的迟到结果不污染新管理访问。
- 非法结构、重复目标、无效日期及未知错误码拒绝；虚构 `SECRET_TOKEN` 不出现在 UI 或映射错误。

`tests/archive-app.test.tsx`：生产归档 reader 展示旧可信分钟编辑时间与 unknown/error 同时存在；旧成功正文可读，重新访问显示实际提交的新正文；媒体和评论仍可待处理。只发生 `/api/archive/` GET，不触发检查或同步；分钟时间不补秒。既有阅读、媒体、根回复状态作为回归。

红→绿证据：先添加公开 `listChecks` 测试，因接口不存在失败；添加页面交互测试，因状态区域不存在失败；非法日期用例暴露 `Date.parse` 把 2 月 30 日滚动为有效日期，补回转校验后通过；“最近成功”未取得时误称“未检查”的文案测试先失败后修正。既有正文行为新增回归用例初跑即通过，不将其冒称新增实现的红→绿。

### T2/T3 版本与恢复

`backend/tests/test_versioned_edit_sync.py` 通过公开 `Collector.check_once/execute_pending/run`、真实临时 SQLite 每次重开及归档／管理 HTTP 验证：

- 同 pub_ts 的两个可信分钟编辑版本更新正文；不重扫已完成评论。
- 正文先取得旧 HTML、执行中登记新观察，旧完成只提交实际旧版本，当前正文／媒体分项仍待处理；重开后新版本可继续执行。
- 领取与重新获取 HTML 版本不相同时，正文 checkpoint 记录实际版本，目标不冒领整轮成功。
- 同／不同 revision 的恢复重新领取均以 v11 内部持久 token fencing 旧成功／失败，HTTP 不返回 token；归档继续复用 generation fencing。
- 相对文案／空白／脚本及模块换序／内容和图片变化而信号不变都不触发编辑；无标记首次可初始化。恶意非 JSON、模块缺失、无日期及无效日期不执行脚本、不擦旧归档、可信观察或 checkpoint。
- 未知版本在新正文失败后的重试不能替换旧成功正文、媒体来源或 checkpoint。发布时间独立，编辑分钟不补秒。
- 观察登记后、HTML 读取中、detail 等待中以及正文成功后评论网络中断恢复；无新信号可继续执行，完成后重复执行不请求来源。
- 正文成功、评论失败和未配置 OSS 的媒体 pending 独立保留；评论恢复不把媒体冒充完成。
- 真实 v10→v11 迁移保留归档、可信观察和未完成版本，可继续执行；既有迁移失败／旧归档测试回归。

四项修复均先 red 后 green：编辑重扫已完成评论、管理分项冒称旧版本为新成功、旧领取迟到清新 running、未知版本重试覆盖旧正文。安全解析／部分恢复回归首跑已通过，不冒称新增修复红测。追加三片恢复证据首跑均绿：sqlite3 外部连接工厂对真实归档观察事务注入 commit 前失败／commit 后 ACK 丢失；外部 Clock 在全部分项提交后、目标 finish 前抛 BaseException。重开后保留旧正文与 checkpoint、继续 pending 或恢复 running，不需要新编辑信号，也不重复已完成评论来源请求。故障未按内部表名或私有方法选择；ACK 丢失与控制流中断不等于硬断电，尚未直接注入正文 checkpoint 事务的 commit 故障。

## 验证结果

- `pnpm test tests/manage-checks.test.tsx`：6 passed。
- `pnpm test tests/archive-app.test.tsx tests/archive-reader.test.ts --maxWorkers=2`：50 passed。
- `pnpm test --maxWorkers=2`：22 文件、212 tests passed。
- `pnpm typecheck`：通过（多次）。
- `pnpm build`：通过，生产 Vite 构建成功。
- `pnpm test:e2e:manage`（命令进程禁用代理、NO_PROXY 指向 localhost）：2 passed。真实 API／SQLite 重启、页面刷新及删除配置后读取 checks 空记录；没有把空记录链路冒称版本编辑浏览器全链路。
- `pnpm test:e2e:archive`（同上禁用代理）：27 passed。覆盖实际 SQLite／HTTP→生产阅读 Adapter、断源重开、正文／评论／媒体既有链路回归；移动 Chromium 模拟不等于 Safari 真机。
- 管理浏览器首次两次启动因本地 URL 被判已占用而停止，`ss` 未见监听；本次命令禁用代理后通过，不修改仓库代理设置或停止其他进程。
- 后端最终 `uv run pytest backend/tests/test_versioned_edit_sync.py -q`：25 passed；全量 `uv run pytest backend/tests -q --tb=short`：326 passed。
- 后端中间一次既有受控节拍测试超时，随后专项和全量复跑通过；未改测试超时，不推定失败根因。仓库未配置 Python 静态类型检查器，不将 pytest 冒称类型检查。

## 与父 #08 的责任核对

逐项对照父 [#08](issues/08-periodic-edit-sync.md)，不把本票结果扩大为父票自动验收：

| 父清单项 | 执行归属／证据入口 |
| --- | --- |
| 1 固定 15 秒、忙检查跳过 | #23 `test_collector.py` 受控节拍 |
| 2 独立进程、检查／同步分离 | #23 阻塞 I/O、独立子进程演示 |
| 3 observed／首次初始化与公开同步 | #23 首次登记 + #24 版本工作测试 |
| 4 HTML／AUTHOR／安全 JSON | 复用 #02 解析 + #24 原始 HTML fixtures |
| 5 唯一可信编辑触发 | #24 同 pub_ts／信号不变回归 |
| 6 错误保留、分钟精度与独立发布时间 | #24 原始 fixture／HTTP + T1 分钟时间 |
| 7 可信观察与分项 checkpoint 持久化 | #23 SQLite 状态 + #24 实际版本提交 |
| 8 注入失败／无新信号重试／幂等恢复 | #23 中断恢复 + #24 SQLite 重开与重复执行 |
| 9 旧执行／新观察交错 | #23 检查继续 + #24 旧提交保留新工作 |
| 10 停用／移除保留 | #23 受控节拍停止 + #24 管理历史记录可读 |
| 11 真实状态 API／UI、读取不触发 | #23 checks HTTP + #24 生产管理及阅读映射 |
| 12 原始 fixtures／SQLite／Adapter 穿透 | #24 T2/T3 与 T1；#23 慢 I/O 期间实际读写 |

完整模式／媒体在途及真实编辑→OSS 由 #29/#30 组合核验，持续运行与自然编辑归 #34。父票仍等待维护者依据两票证据收口。

## 未验证事项

实际自然多次编辑、分钟精度同分钟漏检、真实来源兼容性及长期持续运行归 #34；实际编辑→OSS 全链路归 #30。没有真实 OSS、生产部署或 Linux Chrome／iPhone Safari 正式真机证据。本次不新增评论计数触发、正文编辑重扫评论、近期发现、每日校准、退避或自适应节拍。
