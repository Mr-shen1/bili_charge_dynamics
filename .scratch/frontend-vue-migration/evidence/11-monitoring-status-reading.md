# 11 查看真实检查、发现、窗口与同步状态

- 对应票据：[11: 查看真实检查、发现、窗口与同步状态](../issues/11-monitoring-status-reading.md)
- 对应规格：[前端重构实施规格](../spec.md) 用户故事 45/46/47/49/53 与测试策略中的“管理”条目；[采集与检查状态契约](../../../docs/backend/api/collector-api.md)、[发现与窗口契约](../../../docs/backend/api/discovery-api.md)、[管理接口契约](../../../docs/backend/api/management-api.md)
- 实现位置：`frontend/src/manage/managementApi.ts`、`discoveryState.ts`、`checkStatusText.ts`、`discoveryText.ts`、`status.ts`、`useStatusRead.ts`、`CheckStatusPanel.vue`、`CheckStatusDetail.vue`、`DiscoveryStatusPanel.vue`、`UpVisit.vue`、`manage.css`、`src/main.ts`（按需样式），以及数据层副本 `frontend/src/data/commentProgress.ts`、`commentSyncErrors.ts`；测试 `frontend/tests/unit/management-api.test.ts`、`manage-status.test.ts`、`frontend/tests/fixtures/management-dto.ts`、`frontend/tests/e2e/manage.spec.ts`、`frontend/tests/e2e-manage/management.spec.ts`；隔离集成 fixture `backend/tests/live_app.py`
- 证据状态：**Linux Chromium 桌面与 Pixel 7 模拟项目自动化通过；实际 API + 隔离 SQLite 通过；真实上游、iPhone Safari 与新版视觉签收未在本票执行。**

## 1. 本票交付

| 区域 | 内容 |
| --- | --- |
| 读取边界 | 两个面板都只在点击按钮后各读一次同一对只读接口（`GET .../checks`、`GET .../discovery`）；打开、刷新、切模式都不会自动读取，也没有轮询、手工采集或同步入口 |
| 检查与归档状态 | 「目标检查与归档状态」先给该 UP 历史目标的最大 `last_checked_at`/`last_succeeded_at`，并注明“不代表全部目标均已成功”；逐目标折叠展开观察态、执行态、分项、计数、八类时间与分项错误 |
| 不合并成笼统成功 | `检查无变化；不代表同步完成。`、`执行：部分完成`、`正文已保存；动态图待处理；评论失败；…`、`实际整轮成功：尚未成功` 分别呈现；观察/正文版本不一致、编辑信号未知/错误、来源计数与评论整轮成功计数不一致各有独立提示 |
| 分项错误 | 动态图/评论图媒体错误、根评论、回复、评论整轮、检查、同步各自一行，全部用封闭错误码的本地文案；不显示来源响应或异常原文 |
| 发现与窗口 | 「近期发现与当前窗口」先给**读取到的已保存**模式与监控开关，再分开呈现本轮累计候选（不代表已发布）、最近可信发现结果（历史）与当前启用近期目标（已发布窗口） |
| 窗口生命周期 | 非启用近期时说明“近期发现当前未启用；历史结果仍可读取”；未完成时“保留已有可信结果与已发布窗口”；可重试时说明下一固定节拍重试且页面重读不会启动发现；窗口就绪时提示内容归档请另读检查状态 |
| 过期数据 | 面板 `key = ${uid}:${mode}:${recentN}:${enabled}`：已保存配置一变就重建，上一份检查/发现状态不会跟着新配置留在页面上；读取失败只影响该面板，不覆盖卡片草稿 |
| 迟到回调 | `useStatusRead` 同时校验组件存活、`AbortSignal`、请求身份，并在卸载时用生命周期 signal 主动取消；迟到成功/失败/取消都不写入状态 |
| 通用控件与焦点 | Element Plus `el-button`/`el-alert`/`el-collapse`/`el-collapse-item`/`el-tag`；读取按钮在读取中不禁用（保住键盘焦点），改用 `aria-busy` + 文字“正在读取…”并由读取守卫忽略重复点击；折叠头是 `role=button` + `tabindex=0` + `aria-expanded` 的键盘可展开控件 |
| 错误脱敏 | 401 沿用 `authenticationRequiredMessage`，其他错误按固定码映射；隔离集成用例断言页面正文不含夹具的秘密串 |

## 2. 关键规则与实现位置

| 规则 | 位置 | 说明 |
| --- | --- | --- |
| Adapter 扩展 | `manage/managementApi.ts` | 新增 `readDiscovery`（`/discovery`，校验 `uid` 一致）与 `listChecks`（`/checks`，`parseCheck` + 去重）；两者进入既有 HTML 401／取消优先／传输异常矩阵 |
| 发现状态契约 | `manage/discoveryState.ts` | `parseDiscovery` 白名单提取 + 一致性校验：模式/N/启用/active 自洽、`current_ids` 必须等于已发布窗口、状态与尝试的完成时间/错误码匹配、`incomplete`/`retryable` 与推导一致；矛盾响应整体判无效 |
| 检查状态契约 | `frontend/src/data/checkStatus.ts`（复用，未改动） | `parseCheck` 的封闭枚举与可空字段保持基线；`frontend/src/data` 仍是根 `src/data` 的逐字节副本（`check:data-parity` 通过） |
| 评论进度与错误文案 | `frontend/src/data/commentProgress.ts`、`commentSyncErrors.ts`（复用的逐字节副本） | 直接复用基线已验证的纯 TS 判定（根成功 + 回复失败 → `partial-failed`，正文/媒体错误不冒充评论失败）与三条评论错误文案；两文件已加入 `check-data-parity.mjs` 清单，漂移会直接红 |
| 状态文案 | `manage/checkStatusText.ts`、`manage/discoveryText.ts`、`manage/status.ts` | 检查徽标/短语/分项/尝试/错误文案、发现状态与错误文案、列表状态各自归位；UP 级时间由 `panelCheckTimes` 从刚读到的记录推导 |
| 一次性读取 | `manage/useStatusRead.ts` | 两个面板共用：`idle/loading/error/ready`、“在途忽略重复读取”、`reportReadError('管理配置', …)` 非生产诊断、卸载取消 |
| 面板生命周期 | `UpVisit.vue` | 面板与身份卡同一分支渲染，但各自 `key` 由 `uid` + 已保存配置签名决定；换 UP 或保存新配置都会重建面板 |
| 读取按钮焦点 | `CheckStatusPanel.vue`、`DiscoveryStatusPanel.vue` | 不设 `disabled`，只标 `aria-busy`；e2e 断言键盘触发后失败重试仍保持焦点 |
| 隔离集成 driver | `backend/tests/live_app.py` | 新增 `/x/v2/reply/count`、近期发现页 `/x/polymer/web-dynamic/v1/feed/space`；并加入**仅测试用**（`include_in_schema=False`，不在生产应用注册）的 `POST /api/test/collect`（驱动一次真实 `Collector` 节拍）与 `POST /api/test/source-failure`（切换固定上游失败） |

## 3. 自动化结果

在 `frontend/` 下执行，环境与前序证据一致：Linux CachyOS、Node 24.21.0、pnpm 10.34.6、
Vue 3.5.44、Vue Router 4.6.4、Element Plus 2.14.7、Vitest 4.0.18、Playwright 1.58.2（Chromium headless，desktop + Pixel 7）。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（vue-tsc 覆盖 `.vue` 模板与 TS） |
| `pnpm check` | 通过：typecheck + **244 passed** + e2e 项目覆盖守卫 |
| `pnpm test` | **244 passed**（10 的 218 → 244）：`management-api` 43→57，新增 `manage-status` 12 例，其余不变 |
| `pnpm test:e2e` | **171 passed / 10 skipped**（`manage.spec.ts` 11→12 例 × desktop/Pixel 7；跳过项仍是需要触摸环境的窄屏手势用例） |
| `pnpm test:e2e:production` | 3 passed / 3 skipped（生产六路由、404、无自检入口、fault 装配） |
| `pnpm test:e2e:manage` | **7 passed**：实际 API（`backend/tests/live_app` 虚构上游）+ 本次运行独占 SQLite |
| `pnpm check:dist` | 通过：两次构建 + 产物隔离 + 数据层副本一致 |
| `uv run --no-sync pytest backend/tests -q` | **809 passed**（含 `test_live_app.py` 的 2 例；本票只扩展测试夹具，生产后端代码未改） |

接缝与覆盖：

- **`tests/unit/management-api.test.ts`（57 例，传输映射接缝）**：发现状态映射已保存模式/本轮尝试/可信窗口；非启用近期不带窗口也不声称可重试；发现失败保留历史可信结果并标记可重试；11 种自相矛盾响应（启用与模式不符、模式与 N 矛盾、已发现却无可信结果、当前窗口与可信结果不一致、未开始却有尝试、进行中却有完成时间、失败却无错误码、可重试/未完成标志与推导不符、可信结果未达 N 却非耗尽、未知错误码）整体判无效；发现响应必须与请求 UID 一致且 UID 本地优先校验；检查列表映射分项/时间/封闭错误码，并拒绝重复 ID、未知检查/执行/分项状态、未知同步与媒体错误码、负数计数；两个新方法的 `404`/`422` 只映射固定文案且不回显 `SECRET_TOKEN`；两个新方法一并进入原有的 HTML 401／取消优先／传输异常矩阵（`Object.keys(createManagementApi())` 与矩阵同表，漏注册会直接红）。
- **`tests/unit/manage-status.test.ts`（12 例，页面行为接缝）**：打开页面不读取、UP 级时间与免责文案；读取后检查短语/执行态/版本不一致/编辑信号未知/分项/计数与计数不一致/评论同步/三类分项错误/八类时间逐项呈现；折叠默认收起、可展开；读取失败原位重试、空结果与“未检查”分开；在途重复点击被忽略且按钮不禁用（焦点不丢）；离开页面后迟到成功不改写新访问；发现状态的三段（本轮/可信/窗口）与“发现不等于归档”；发现失败保留旧窗口并标记可重试；停用或非近期模式的历史可读提示；发现读取失败原位重试与未知时间不补造；面板读取不覆盖未提交的“近期 N”草稿；读取后 UP 级时间改用刚读到的记录（换掉配置读取时的旧值）；已保存配置改变后两个面板都回到未读取。
- **`tests/e2e/manage.spec.ts`（desktop + Pixel 7，各 12 例，生产装配 + HTTP 传输替身）**：新增“状态只由按钮读取”用例（打开页面只有身份读取请求、键盘触发的读取失败保留焦点并可重试、错误不回显 `SECRET_TOKEN`、折叠头 `aria-expanded` 可键盘切换、发现面板渲染保存模式与窗口、全程只发 GET）；四视口用例扩展到读取后的状态面板，断言读取按钮与折叠头高度 ≥44px、页面与展开后的检查详情都不横溢。
- **`tests/e2e-manage/management.spec.ts`（7 例，实际 API + 隔离 SQLite）**：新增端到端链路——202 保存近期 N=1 并启用 → 窗口为空时“尚无目标检查记录” → `POST /api/test/collect` 驱动真实发现 → 读取发现状态看到发布窗口 → 读取检查状态看到“未检查/尚无检查工作” → 首次检查后“已检查，已登记观察。/执行：待同步” → 第二次检查后“检查无变化；不代表同步完成。”且“实际整轮成功：尚未成功” → **根评论来源失败后执行归档：正文已保存、评论待处理、`根评论 ERROR`/`同步：同步未全部完成`、整轮成功仍为空（部分同步/分项失败）** → 来源恢复后重试：五个分项全部已保存、`评论同步：对应评论观察已完成`、整轮成功时间与 UP 级“最近成功”同时出现 → 固定上游发现失败后“本轮发现未完整完成”并保留旧窗口与可重试提示；读取前后 `/checks` 与单 UP 归档列表逐字节一致，证明页面读取不产生检查记录或归档。
- **`backend/tests/test_live_app.py`（2 例）**：新增守卫断言 —— 夹具应用注册了 `/api/test/collect`、`/api/test/source-failure`，而生产 `backend.bili_monitor.app.create_app` 不注册任何 `/api/test/` 路由。

## 4. 实施中发现并按代码基线修正的差异

1. **`frontend/README.md` 结构表存在不存在的文件**：原表列出 `src/app/management.ts`，实际管理 Adapter 在 `src/manage/managementApi.ts` 并由 `src/main.ts` 装配。按差异处理硬规则改为记录实际位置，不再保留指向空文件的条目。
2. **“检查状态待 11”“（11）仍待迁移”两处已过期**：`frontend/README.md` 的 `src/pages` 行与“尚未迁移”段落在本票完成后不再成立，改为记录已迁移并列出剩余票据 12–17。
3. **读取按钮的禁用语义与键盘焦点冲突**：基线（React `CheckStatusPanel`/`DiscoveryStatusPanel`）用 `disabled={loading}`，键盘用户按下按钮后焦点会因 `disabled` 丢失，且本票要求“键盘焦点可用”。按目标变化改为不禁用 + `aria-busy` + 文案“正在读取…”，重复点击由 `useStatusRead` 的在途守卫忽略（`manage-status.test.ts` 断言一次读取且按钮未禁用）。
4. **`pnpm test:e2e:manage` 在本机需绕过代理**：本机环境设置了 `HTTP(S)_PROXY=127.0.0.1:12000`，Playwright 的端口探测会经代理拿到 400 并误判“端口已占用”。这只是本机环境差异，命令已在 `frontend/README.md` 注明 `NO_PROXY=127.0.0.1,localhost` 或清空代理变量。

未发现其他需要按旧文档恢复或删除的业务行为冲突。

## 4.1 两轴代码审查后的收敛（Standards / Spec 子代理）

1. **共享版式重复声明（Standards 硬违规）**：三个 SFC 各自重写 `.manage-state`/`.manage-state-error`/`.manage-read`，与 `manage.css` 的书面约定冲突。
   现统一放进 `manage.css`，各 SFC 只保留本地差异（`UpCard` 的 `margin: 0` 作为显式覆盖并加注释）。
2. **README 数据层职责与实际不符（Standards 硬违规）**：`src/data/` 一行仍写“检查状态守卫”，而新的发现契约在 `manage/`。
   现改为如实描述数据层职责，并在 `manage/` 一行列出各状态模块。
3. **契约跨栈漂移风险（Standards/ Spec 共同发现）**：`manage/checkProgress.ts` 是根 `src/data/commentProgress.ts` 的手抄，且不在副本守卫清单里。
   改为把 `commentProgress.ts`、`commentSyncErrors.ts` 逐字节复制到 `frontend/src/data/` 并加入 `check-data-parity.mjs`，删除手抄实现；漂移由 `pnpm check:dist` 直接拦截。
4. **套接字骨架第三次复制（Standards 判断项）**：两个新读方法重复“abort→json→ok→invalidResponse”。抽 `getJson()` 供两者共用，不重写既有方法。
5. **面板同形标签逻辑（Standards 判断项）**：两个面板各写一份三分支 `readLabel`；移入 `useStatusRead`，以状态名词参数化（`检查状态`／`发现状态`）。
6. **`status.ts` 承担多种变化理由（Divergent Change）**：拆为 `status.ts`（列表状态与用户）、`checkStatusText.ts`（检查/分项/时间）、`discoveryText.ts`（发现/窗口）。
7. **命名（Mysterious Name）**：`ids`→`isIdList`、`errorCode`→`isDiscoveryError`、`checkText`→`checkStatusText`、`checkBadge*`→`checkStatusBadge*`。
8. **原始类型占位（Primitive Obsession）**：`attemptText` 改用 `Exclude<TargetCheck['commentsLastAttempt'], null>`，不再手写同一联合。
9. **同形两写**：`CheckStatusDetail` 的 `at()` 增加 fallback 参数，三处时间行统一走它。
10. **部分同步/分项失败缺真实证据（Spec 主要发现）**：夹具增加 `reply` 失败开关，隔离集成改为在真实 API 上产生“正文成功 + 评论失败 + 整轮未成功”，并在来源恢复后重跑出“整轮成功时间”。
11. **UP 级时间可能与新记录不一致（Spec 判断项）**：原实现沿用身份读取时的 `monitor.lastCheckedAt`，读取后行内已显示新时间而面板头仍是旧值。
    现读取成功后改用刚读到的目标记录推导（`panelCheckTimes`），未读取时才用配置值；后端语义仍是“历史目标记录最大值”，未改变后端行为。
12. **用例名与实现不一致（Spec）**：单元用例原写“可键盘展开”实际用点击；已改名为点击展开，并注明键盘切换由 e2e 覆盖。
13. **仅测试用端点的越界风险（Spec 判断项）**：保留但加结构性保证 —— `backend/tests/test_live_app.py` 断言生产应用不注册任何 `/api/test/` 路由，生产后端代码本票未改。
14. **保留的判断项**：`useStatusRead` 与 `useManagementRead` 仍同形（约 20 行守卫重复）。两者生命周期不同（身份读取自动读一次 + 页面级重试；状态读取手动触发），合并需要为两者引入额外参数与回调，按「不为复用制造抽象」保留现状。

## 5. 未验证与边界

- **真实上游**：隔离集成只使用 `backend/tests/live_app` 的虚构上游（动态页、detail、独立评论计数、空根评论页、近期发现页），未发起真实 B 站请求；真实风控下的发现失败/部分完成表现仍以既有后端专项证据为准。
- **OSS/媒体**：虚构页面不含图片，未触发下载或上传；本票只验证媒体分项状态与错误码的呈现，不验证真实媒体链路。
- **媒体分项失败**：隔离集成的分项失败来自根评论来源失败（`ROOT_COMMENTS_FAILED`），未在真实 API 上构造媒体下载/上传失败；媒体错误码的呈现仍由契约与页面行为用例覆盖。
- **iPhone Safari 真机**：只在 Linux Chromium 桌面与 Pixel 7 模拟项目验证；正式设备结论留待 15。
- **新版视觉签收**：两个面板的版式、折叠与徽标配色未经用户确认，不作为视觉回归基准（14）。
- **生产 Nginx 静态交付**：本票未执行部署或 Nginx 实机检查（16）。
- **仅测试用的采集驱动端点**：`/api/test/collect` 与 `/api/test/source-failure` 只存在于 `backend/tests/live_app.py`，生产 `create_app` 不注册（有守卫用例），也不是产品功能；生产后端业务代码本票未改。
- **已知的既有不稳定用例**：`frontend/tests/unit/thread-reading.test.ts` 的“分页器收起与返回按钮都退回详情”在全量并行负载下偶发失败（连续多次全量运行中出现 1 次，单独运行与重跑均通过）。该用例与板块无关（窄屏楼中楼位置恢复），本票未改动其代码；按仓库约定不把它记为已解决。
