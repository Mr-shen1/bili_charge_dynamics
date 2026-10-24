# 09 按 UID 新增 UP、查看管理卡片并启停监控

- 对应票据：[09: 按 UID 新增 UP、查看管理卡片并启停监控](../issues/09-up-management-basics.md)
- 对应规格：[前端重构实施规格](../spec.md) 实施决策 4/6/7/8，用户故事 43/44/47/50/53，测试策略中的“管理”条目；[管理接口契约](../../../docs/backend/api/management-api.md)
- 实现位置：`frontend/src/manage/`（`managementApi.ts`、`ManageShell.vue`、`ManageVisit.vue`、`UpVisit.vue`、`UpCard.vue`、`status.ts`、`useManagementRead.ts`、`useManagementRequests.ts`）、`frontend/src/pages/ManagePage.vue`、`frontend/src/pages/ManageUpPage.vue`、`frontend/src/app/session.ts`、`frontend/src/main.ts`
- 证据状态：**Linux Chromium 桌面与 Pixel 7 模拟项目自动化通过；实际 API + 隔离 SQLite 通过；真实上游资料、iPhone Safari 与新版视觉签收未在本票执行。**

## 1. 本票交付

| 区域 | 内容 |
| --- | --- |
| 管理列表 | `/manage` 直达、刷新与返回；按后端返回顺序展示身份（头像/昵称/`UID：`）与监控状态（监控已启用／已停止／配置已删除），卡片只做导航，不新增全局汇总页 |
| 新增 | 仅输入 UID：字符串校验（无前导零、≤128 位、不经数值转换），昵称与头像由后端取得；成功可见并清空输入，失败保留输入并原位重试，阻塞期间重复提交不产生第二个请求 |
| 单 UP 管理 | `/manage/ups/:upId` 直达与刷新；身份卡 + 当前监控状态 + 启停按钮；启停提交该 UP **已保存**配置的完整 `PATCH`，失败保持原状态并给重试入口 |
| 生命周期隔离 | 管理写入按 UID 防重锁，并校验访问是否仍存活；离开页面、跨 UP、传输忽略取消时的迟到成功/失败/完成回调都不改写当前页面，也不清掉新的加载态 |
| 错误边界 | 保留管理 401 固定提示（不解析、不回显代理正文、不自动重试）、固定错误码白名单、响应体不回显；普通归档浏览不触发管理或采集请求 |
| 装配与注入 | 管理接口进入 `AppSession`，与归档读取一起在 `src/main.ts` 根部装配；页面只经注入取得，测试各自创建独立替身，不共享模块级单例 |
| 通用控件 | Element Plus `el-form`/`el-form-item`/`el-input`/`el-button`/`el-alert`，沿用共享主题；键盘可完成新增与启停、焦点可见、四视口无横溢、主要触控区域 ≥44px |

范围外（按票据拆给后续）：监控模式（近期 N／指定）与指定目标、删除配置与重新添加（10）；检查、发现、窗口与同步状态（11）。本票切出的 `managementApi` 只含 `listUps`/`addUp`/`updateMonitor`，后续票按同一模式扩展，未预埋未被使用的目标/状态方法。

## 2. 关键规则与实现位置

| 规则 | 位置 | 说明 |
| --- | --- | --- |
| 生产 Adapter 边界 | `manage/managementApi.ts` | 只替换 HTTP 传输；snake_case→camelCase 映射、UID/头像/时间/近期 N 守卫和固定安全文案都在这里，展示层不读原始 DTO |
| 401 优先级 | `manage/managementApi.ts` 的 `request()` | 取消优先，其次才判断 401；401 时既不 `json()` 也不 `text()`，反代 HTML 正文不会进入页面 |
| 错误码白名单 | `manage/managementApi.ts` 的 `httpError()` | 只按固定 code + 匹配 HTTP 状态给文案；未知 code、状态不符、非 JSON 一律“管理接口响应异常，请重试。”，不读取响应里的 `message` |
| 只提交 UID | `manage/managementApi.ts` 的 `addUp()` | body 固定 `{"uid":"<字符串>"}`，大 UID 不丢精度（`900719925474099312345`） |
| 启停语义 | `manage/UpCard.vue` → `updateMonitor()` | 只发 `{mode, recent_n, enabled: !enabled}`，使用已保存配置；界面没有草稿，因此不存在“启停顺带保存草稿”的旧语义 |
| 防重与迟到回调 | `manage/useManagementRequests.ts` | 同一 UID 同时只有一个请求；除取消外还比对请求身份与组件存活，传输忽略取消时迟到结果被丢弃 |
| 访问级隔离 | `pages/ManagePage.vue`、`pages/ManageUpPage.vue` | 以 `navigation.pageEntryId`（单 UP 再加 `uid`）作 `key`：同一地址的新访问不沿用上一访问的读取态与反馈 |
| 读取重试 | `manage/useManagementRead.ts` | 管理列表与单 UP 共用同一读取状态机：不并发、`重新读取` 原位重试、卸载后迟到结果丢弃；异常经 `reportReadError` 在非生产装配留痕 |
| 单 UP 定位 | `manage/UpVisit.vue` | 沿用基线：读取身份集合后按 UID 定位，未命中给“未找到该 UP”，不做草稿。未改用 `GET /api/manage/ups/{uid}`，因此该分支与 `NOT_FOUND` 文案在本票页面不可达 |
| 状态文案单一来源 | `manage/status.ts` | 列表与身份卡共用同一套“已启用/已停止/配置已删除”与“未知用户”兜底 |
| 共享页头 | `manage/ManageShell.vue` | 两条路由同层级（管理列表 → 单 UP 管理），单 UP 页多一个“UP 列表”返回入口 |

## 3. 自动化结果

在 `frontend/` 下执行，环境与前序证据一致：Linux CachyOS、Node 24.21.0、pnpm 10.34.6、
Vue 3.5.44、Vue Router 4.6.4、Element Plus 2.14.7、Vitest 4.0.18、Playwright 1.58.2（Chromium headless，desktop + Pixel 7）。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（vue-tsc 覆盖 `.vue` 模板与 TS） |
| `pnpm test` | **185 passed**：新增 `management-api` 26 + `manage-page` 9 + `manage-up-page` 7；既有 143 保持通过 |
| `pnpm test:e2e` | **165 passed / 10 skipped**（新增 `manage.spec.ts` 9 例 × 2 项目；`app-shell.spec.ts` 的管理路由断言改为真实页面；跳过项仍是需要触摸环境的窄屏手势用例） |
| `pnpm test:e2e:production` | 3 passed / 3 skipped（生产六路由、404、无自检入口；管理两条路由改为真实页面断言） |
| `pnpm test:e2e:manage` | **5 passed**：实际 API（`backend/tests/live_app` 固定虚构资料）+ 本次运行独占 SQLite |
| `pnpm check` / `pnpm check:dist` | 均通过；e2e 项目覆盖守卫识别 `manage.spec.ts` 为 desktop/mobile archive 项目，`dist` 无 mock 入口/夹具/归档数据，数据层副本一致 |

接缝与覆盖：

- **`tests/unit/management-api.test.ts`（26 例，传输映射接缝）**：列表顺序与 `monitor=null` 映射、大 UID 只提交字符串、启停提交完整已保存配置；本地 UID/近期 N 校验失败不发请求；非 https／带用户信息头像、前导零 UID、未知模式、非安全整数 N、非布尔启停、无时区时间整体判无效；重复 UID 列表判无效；`addUp` 要求 201 + UID 一致 + 带监控配置；错误码白名单与状态不符/未知 code/非 JSON 只给固定提示且不回显正文；三个公开方法在 HTML 401 上不读正文、不带凭据、不重试；已取消不发请求，传输忽略取消时取消优先；传输异常给固定提示。
- **`tests/unit/manage-page.test.ts`（9 例，页面行为接缝）**：读取中状态→按 UID 展示三类状态并点卡片进入 `/manage/ups/123`；读取失败固定提示 + 原位重试；UID 校验（空白/前导零/科学计数/超长）保留输入且不发请求；新增成功清空输入、恶意昵称只作文本、头像空值兜底；新增失败保留输入并原位重试且不显示成功提示；阻塞时重复提交被阻止、迟到失败只落到当前访问；离开再进入后旧读取的迟到成功不改写新访问；401 固定提示且不自动重读；列表页不发写请求、无昵称/头像/凭据编辑入口。
- **`tests/unit/manage-up-page.test.ts`（7 例，页面行为接缝）**：身份/UID/状态展示与启停使用已保存配置（断言 PATCH 入参）；启停失败保持原状态 + 重试标签 + 重复写入只发一次；离开页面后旧启停迟到失败不改写新访问；跨 UP 的迟到成功不改写当前卡片；读取失败原位重试与 UP 不存在回到列表；已删除配置仍展示身份与“已有归档保留”且无启停；401 只显示固定提示且不发写请求。
- **`tests/e2e/manage.spec.ts`（desktop + Pixel 7，各 9 例，生产装配 + HTTP 传输替身）**：列表直达/刷新/进入与返回；键盘回车新增大 UID、恶意昵称不变成元素、空头像兜底；校验失败不发请求、阻塞时重复回车只发一次、502 保留输入并重试成功且不泄漏 `SECRET_TOKEN`；启停失败→重试→状态更新，断言两次 PATCH body 一致；删除配置身份直达；读取失败原位重试；反代 401 只显示固定提示且不重试；UP 不存在回列表；四视口（360/390/768/1280）在**管理列表与单 UP 页**都不横溢，页头链接/卡片/提交按钮/启停按钮高度均 ≥44px；键盘完成新增与启停且焦点轮廓可见。
- **`tests/e2e-manage/management.spec.ts`（5 例，实际 API + 隔离 SQLite）**：新增后列表出现并刷新仍可读（持久化）；启停经实际 API 保存、刷新后仍是最后保存状态；重复添加同 UID 得到后端固定提示并保留输入；上游资料不可用时保留输入且不回显服务端诊断；未知 UP 直达并回到列表。后端使用 `backend/tests/live_app` 的固定虚构 card 上游与每次运行独占的临时 SQLite，不发起真实上游采集或 OSS 上传。

## 4. 实施中发现并修正的问题

1. **隔离 SQLite 不能放在 `test-results/`**（真实踩坑）：Playwright 每次运行开始会清空 `outputDir`，
   在配置求值时创建在该目录下的数据库会被删掉，后端随即返回 `503 STORAGE_UNAVAILABLE`。
   改为 `mkdtempSync(join(tmpdir(), 'bili-manage-e2e-'))`：每次运行独占一个系统临时目录，互不污染，
   且不再受 Playwright 清理影响。
2. **Element Plus 表单的原生提交语义**：新增入口用 `el-form` 的 `<form>` 提交，按钮用 `native-type="submit"`，
   因此鼠标点击与键盘回车走同一条路径；单元测试用 `fireEvent.submit(form)` 覆盖，e2e 用真实回车覆盖。
3. **组件测试的导航时序**：导航协调器会为当前历史记录补写访问标记（`router.replace` 补写），
   紧接其后的 `router.push` 可能被这次替换取消。测试改为每次导航之间等一拍（`settle()`），
   只为稳定驱动历史，不改变产品行为；被测的“离开再进入”语义仍由真实卸载/重挂载覆盖。
4. **`app-shell`/生产装配 e2e 的骨架断言按代码基线同步**：原先断言 `单 UP 管理` 占位标题，
   改为真实页面的 `UP 监控管理` 标题、`UP 列表` 返回入口与“无阶段 3 占位文案”断言。
   按差异处理硬规则修正测试，未为迎合旧描述恢复占位页。

5. **审查后收敛重复实现**：`ManageVisit` 与 `UpVisit` 各自的读取状态机抽为 `useManagementRead`（与既有 `useListRead`/`useDetailRead` 一致），
   两处 `catch` 补 `reportReadError`，非生产装配可见编程错误；`src/app/management.ts` 只做转发的中间层已删除，改为在 `main.ts` 直接装配。

未发现需要按旧文档恢复或删除的其他业务行为冲突。

## 5. 未验证与边界

- **真实上游资料**：实际 API 用例使用测试自带的虚构 card 上游；真实 B 站资料的可用性、`PROFILE_UNAVAILABLE` 分类日志仍以既有后端证据为准，本票未发起真实上游请求。
- **iPhone Safari 真机**：只在 Linux Chromium 桌面与 Pixel 7 模拟项目验证；正式设备结论留待 15。
- **新版视觉签收**：管理卡片与表单的间距、色彩层级未由用户确认，不作为视觉回归基准（14）。
- **监控模式/指定目标/删除配置（10）与检查/发现/窗口/同步状态（11）**：按票据范围未实现，单 UP 页当前只到启停。
- **生产 Nginx 静态交付**：本票未执行部署或 Nginx 实机检查；交付回归留待 16。
- **应用内账号权限**：未新增；管理 401 仍是反代层的防御性提示，不构成应用内鉴权系统。
- **单 UP 页的迟到启停只按 UID 判活**（无读取代次）：当前 ready 态没有重新读取入口，因此该路径不可达；票据 10 加入保存/重读后需补代次校验，本票不预埋。
