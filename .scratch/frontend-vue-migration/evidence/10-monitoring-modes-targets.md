# 10 维护互斥监控模式及指定目标

- 对应票据：[10: 维护互斥监控模式及指定目标](../issues/10-monitoring-modes-targets.md)
- 对应规格：[前端重构实施规格](../spec.md) 实施决策 4/6/7/8/9/12/25，用户故事 45/46/47/49/53，测试策略中的“管理”条目；[管理接口契约](../../../docs/backend/api/management-api.md)、[指定目标接口](../../../docs/backend/api/archive-api.md)
- 实现位置：`frontend/src/manage/managementApi.ts`、`UpCard.vue`、`UpVisit.vue`、`ManageTargets.vue`、`manage.css`、`useManagementRequests.ts`；测试 `frontend/tests/unit/management-api.test.ts`、`manage-up-page.test.ts`、`frontend/tests/e2e/manage.spec.ts`、`frontend/tests/e2e-manage/management.spec.ts`；隔离集成 fixture `backend/tests/live_app.py`
- 证据状态：**Linux Chromium 桌面与 Pixel 7 模拟项目自动化通过；实际 API + 隔离 SQLite 通过；真实上游、iPhone Safari 与新版视觉签收未在本票执行。**

## 1. 本票交付

| 区域 | 内容 |
| --- | --- |
| 互斥模式 | 单 UP 页以一组互斥单选维护“近期 N 条／指定动态 ID”，只显示当前模式需要的字段；默认值来自后端配置，新增 UP 时仍是 `recent` + `10` + 停用 |
| 草稿与保存 | 模式与近期 N 是独立草稿，只由“保存配置”提交完整 `{mode, recent_n, enabled}`；启停仍提交**已保存**配置，不把草稿当成配置；保存成功后“已保存模式”摘要更新，失败保留草稿并原位重试 |
| 近期 N 校验 | 沿用基线：`^[1-9][0-9]*$` + `Number.isSafeInteger`，失败给固定文案且不发请求、不清空输入 |
| 删除配置 | `DELETE /api/manage/ups/{uid}/monitor`：只删配置，身份和归档保留；卡片转为“配置已删除 / 监控：无配置”，隐藏保存、启停与删除，改给“重新添加监控”（走既有 `POST /api/manage/ups`） |
| 指定目标 | 仅当**草稿模式**为指定且存在配置时挂载目标区：读取 `GET .../targets`、添加 `POST .../targets`、移除 `DELETE .../targets/{id}`；近期模式下只给一行切换提示，不发目标请求 |
| 归属校验反馈 | 成功“归属校验通过，目标关联已保存。”、作者不符“动态作者与所选 UP 不符。”、无法确认“无法确认动态归属。”三种结果分开；动态 ID 走与 UID 相同的字符串校验，失败保留输入 |
| 移除目标 | 只解除关联，反馈“目标已移除；已有归档保留。”，列表移除该项 |
| 隔离 | 切换 UP 或模式时重建卡片/目标区：草稿、输入、反馈与读取身份都不沿用；同一 UP 的写入（启停／保存／删除／目标增删）共用一把防重锁，在途时其他写入与重复提交被阻止 |
| 归档保留 | 隔离 SQLite 上验证：停用、移除目标、删除配置之后 `GET /api/archive/dynamics/{id}` 与单 UP scope 列表仍返回原归档；删除配置后可重新添加 |
| 通用控件 | Element Plus `el-radio-group`/`el-radio`/`el-form`/`el-form-item`/`el-input`/`el-button`/`el-alert`；键盘可切换模式保存、四视口无横溢、主要触控区域 ≥44px（含单选标签与目标按钮） |

范围外（按票据留给 11）：检查记录、发现/窗口与同步状态。未新增采集模式、频率策略、手动初始化或业务 API，也未把管理删除改成内容删除。

## 2. 关键规则与实现位置

| 规则 | 位置 | 说明 |
| --- | --- | --- |
| Adapter 扩展 | `manage/managementApi.ts` | 新增 `ManagedTarget`、`invalidTargetMessage`、`isValidTargetId`、`deleteMonitor`、`listTargets`、`addTarget`、`deleteTarget`；错误码白名单增加 `TARGET_AUTHOR_MISMATCH`(409)／`TARGET_UNVERIFIED`(502) |
| 目标请求形状 | `managementApi.ts` 的 `targetRequest()` | GET 无 body；POST 只提交 `{"id":"<字符串>"}`；DELETE 走路径参数且只有 `204` 算成功；非 204 仍解析固定错误码，不静默成功 |
| 删除配置 | `managementApi.ts` 的 `deleteMonitor()` | 只有 `204` 成功；其他状态按固定码映射，`200` 判为响应异常 |
| 草稿语义 | `UpCard.vue` | `mode`/`recentN` 从已保存配置初始化；`保存配置` 用草稿 + 已保存 `enabled`；启停只用已保存 monitor；模式切换清空当前反馈 |
| 草稿重置 | `UpVisit.vue` | 卡片 `key = ${uid}:${monitor !== null}`，与基线 React `key` 等价：换 UP 或配置增删都会重建草稿与反馈 |
| 目标区生命周期 | `ManageTargets.vue` | 目标区随草稿模式挂载/卸载，因此切换模式即隔离输入与反馈；读取用组件级 `AbortController` + 请求身份校验，卸载后迟到结果丢弃 |
| 写入防重 | `useManagementRequests.ts` | 按 UID 的锁在启停、保存、删除、目标增删之间共享；除取消外还比对请求身份与组件存活 |
| 目标列表顺序 | `ManageTargets.vue` | 读取按后端顺序展示；新增项去重后按字符串升序插入（与基线一致），移除按 ID 过滤 |
| 归档保留文案 | `UpCard.vue`、`ManageTargets.vue` | 脚注“仅删除配置，保留身份和已有归档。”、删除后“监控配置已删除；身份和已有归档保留。”、移除后“目标已移除；已有归档保留。” |

## 3. 自动化结果

在 `frontend/` 下执行，环境与前序证据一致：Linux CachyOS、Node 24.21.0、pnpm 10.34.6、
Vue 3.5.44、Vue Router 4.6.4、Element Plus 2.14.7、Vitest 4.0.18、Playwright 1.58.2（Chromium headless，desktop + Pixel 7）。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（vue-tsc 覆盖 `.vue` 模板与 TS） |
| `pnpm check` | 通过：typecheck + **218 passed** + e2e 项目覆盖守卫 |
| `pnpm test` | **218 passed**（09 的 185 → 218）：`management-api` 26→43，`manage-up-page` 7→23，其余不变 |
| `pnpm test:e2e` | **169 passed / 10 skipped**（`manage.spec.ts` 9→11 例 × desktop/Pixel 7；跳过项仍是需要触摸环境的窄屏手势用例） |
| `pnpm test:e2e:production` | 3 passed / 3 skipped（生产六路由、404、无自检入口、fault 装配） |
| `pnpm test:e2e:manage` | **6 passed**：实际 API（`backend/tests/live_app` 虚构上游）+ 本次运行独占 SQLite |
| `pnpm check:dist` | 通过：两次构建 + 产物隔离 + 数据层副本一致 |

接缝与覆盖：

- **`tests/unit/management-api.test.ts`（43 例，传输映射接缝）**：目标列表字符串 ID 映射与非法/重复响应整体判无效；添加只提交 `{"id":...}`、响应 ID 必须一致、作者不符与无法确认分别给固定文案且不回显 `SECRET_TOKEN`；非 GET 目标请求在本地校验 UID/ID 且不发请求；移除目标 `204` 成功、`404` 固定文案、`200` 判异常；删除配置 `204` 成功、`404` 固定文案、`200` 判异常；新增的 4 个方法一并进入原有的 HTML 401／取消优先／传输异常矩阵。
- **`tests/unit/manage-up-page.test.ts`（23 例，页面行为接缝）**：模式与 N 按已保存值展示、保存提交完整配置并保留启停；近期 N 多种非法输入不发请求且保留草稿、可原位重试；切到指定模式隐藏 N 且保存提交指定模式；保存失败草稿与已保存模式并存；换 UP 与往返模式后不沿用草稿/反馈；删除配置只删配置并可重新添加回默认配置；删除失败原位重试；目标读取与三种添加结果（成功/不符/未知）保留输入、字符串校验失败不发请求；移除目标反馈；目标读取失败只影响该区域；同一 UP 写入串行（在途时保存/启停/删除/重复提交被阻止）；切换模式卸载目标区后旧添加迟到成功不改写当前页面；移除失败只影响移除本身（添加按钮不变成重试添加、同一按钮可重试移除）；切换模式会取消在途目标写入（断言传出的 `signal` 已 abort）。
- **`tests/e2e/manage.spec.ts`（desktop + Pixel 7，各 11 例，生产装配 + HTTP 传输替身）**：新增“草稿只由保存提交，指定模式才读取与写入关联目标”（断言近期模式不发目标请求、切模式才读、PATCH body 为草稿值、三种添加结果、移除反馈、往返模式隔离输入与反馈、重新进入重新读取目标）；新增“模式控件可用键盘操作，校验失败的 N 不发请求”；四视口用例扩展到指定模式，断言单选标签与目标按钮高度 ≥44px、页面与卡片不横溢；删除配置用例按基线改为**保留重新添加入口、无启停/删除入口**。
- **`tests/e2e-manage/management.spec.ts`（6 例，实际 API + 隔离 SQLite）**：新增端到端链路——新增 UP 707 → 默认 `recent/10` → 切指定模式保存 → 启用 → 作者不符与无法确认两种失败 → 关联 900707 → 显式 `POST /api/sync/initial` 归档 → 停用 / 移除目标 / 删除配置后 `GET /api/archive/dynamics/900707` 与 `scope=up&uid=707` 仍返回原归档 → 重新添加后仍是默认 `recent/10` → 列表页刷新仍显示身份与状态。
- **`backend/tests/live_app.py`**：从“只有虚构 card 上游”扩展为同时提供虚构动态页（`/opus/{id}`）、detail JSON 与空根评论页，并固定 `800100`（属于其他作者）与未列出 ID（无法确认）两种目标校验结果；仍只替换外部 HTTP，走生产解析、持久化与归档读取。

## 4. 实施中发现并按代码基线修正的差异

1. **09 的页面测试与基线冲突**：`manage-up-page.test.ts` 原断言“配置已删除时没有名字以‘监控’结尾的按钮”，但基线 React `UpCard` 在 `monitor=null` 时提供“重新添加监控”。
   按差异处理硬规则改为断言“无停止/启用、无删除，但有重新添加”，并在 `tests/e2e/manage.spec.ts` 同步同一预期。
2. **删除后提示去重**：基线在目标区写“配置已删除，不再监控目标；已有归档保留。”，脚注又写“监控配置已删除；身份和已有归档保留。”，同一卡片重复两次“已有归档保留”。
   本票保留脚注的保留说明，目标区改为“配置已删除，不再监控目标。”——只收敛重复文案，不加不减行为。
3. **模式控件由原生 `select` 换成 Element Plus 互斥单选**：两个互斥模式在库单选组里同时可见、键盘可达，语义与基线一致（同一时刻只有一个 `mode`，`recent_n` 只在近期模式提交为非默认值语义）；属于已授权的通用控件与视觉替换范围。
4. **`el-radio` 触控高度**：Element Plus 默认单选标签低于 44px，补 `min-height: var(--touch)`，并由四视口 e2e 断言。

未发现其他需要按旧文档恢复或删除的业务行为冲突。

## 4.1 两轴代码审查后的收敛（Standards / Spec 子代理）

1. **反馈动作未区分（Spec 确认缺陷）**：`ManageTargets` 的反馈原先只记 `error`，移除目标失败会让添加按钮变成“重试添加目标”。
   改为反馈带 `action: 'add' | 'remove'`：添加失败才显示“重试添加目标”，移除失败保持“移除目标”并使用同一按钮重试；补两条单元用例锁定。
2. **卸载不取消在途目标写入（Spec 判断题，已按基线修正）**：基线 `TargetManager.tsx` 用 `AbortSignal.any([signal, visit.signal])`，
   Vue 版原先只传防重锁的 signal，切换模式后旧写入会继续占用该 UP 的写入锁。
   现在目标区持有自己的 `lifetime` controller，卸载时 abort 并与 `requests` 的 signal 合并；用例断言切换模式后传出的 signal 已 abort。
3. **重复的读取守卫与漏掉的诊断**：目标读取原先自行复制一份读取状态机且没有 `reportReadError`；补 `reportReadError('管理配置', cause)`，
   与非生产装配的其余读取保持一致（未把 `useManagementRead` 强行泛化到两种返回结构，避免为复用制造抽象）。
4. **重复的写入/标签逻辑**：`UpCard` 的四个写入函数与四个标签 computed 收成 `write(action, operation, succeed, successText)` + `labelFor(...)`，行为与文案不变。
5. **重复的删除请求分支**：`deleteMonitor` 与目标 DELETE 合并为 `deleteRequest()`（204 成功、其他状态按固定码映射），目标请求改用 `isValidTargetId`。
6. **重复的样式声明**：新增 `src/manage/manage.css`（由 `ManageShell.vue` 引入）承载 `.manage-muted`/`.manage-feedback`/`.manage-notice`/`.manage-section`/`.manage-fields` 的共享声明，
   各 SFC 只保留本地差异；四视口 e2e 复跑确认无横溢且触控高度不变。
7. **命名**：`ManageTargets` 的 `id` → `draftTargetId`，动作令牌与人手输入的动态 ID 不再混装在同一字段。

## 5. 未验证与边界

- **真实上游**：隔离集成只使用 `backend/tests/live_app` 的虚构上游，未发起真实 B 站动态页/detail/评论请求，也不代表 `TARGET_UNVERIFIED` 在真实风控下的表现。
- **OSS/媒体**：归档用例的虚构页面不含图片，未触发下载或上传；媒体链路证据仍以既有专项为准。
- **iPhone Safari 真机**：只在 Linux Chromium 桌面与 Pixel 7 模拟项目验证；正式设备结论留待 15。
- **新版视觉签收**：单 UP 页新增的配置区与目标区间距、色彩层级未经用户确认，不作为视觉回归基准（14）。
- **检查/发现/窗口与同步状态（11）**：按范围未实现；单 UP 页当前没有检查记录、发现窗口或同步状态区块。
- **初始化入口**：`POST /api/sync/initial` 只由测试执行者显式调用，页面挂载、刷新与读取都不触发；未新增手工采集 UI。
- **生产 Nginx 静态交付**：本票未执行部署或 Nginx 实机检查（16）。
