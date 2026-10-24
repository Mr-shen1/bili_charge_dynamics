# 13 候选版本的真实协议与跨流程回归

- 对应票据：[13: 完成候选版本的真实协议与跨流程回归](../issues/13-integrated-protocol-regression.md)
- 对应规格：[前端重构实施规格](../spec.md) 用户故事 34–42、47–50、63 与测试策略“必须覆盖的场景”“需求追踪与完成门槛”；[前端重构方案](../../../docs/design/frontend-migration.md) 第 6.3/7/8 节
- 行为基线：[行为基线与文档差异](../baseline-differences.md)；需求真值：[SRS §9](../../../docs/product/SRS.md#9-验收场景与需求追踪)
- 证据状态：**类型检查、单元/页面行为、独立 mock 装配、生产 Adapter/HTTP 替身、实际 API＋隔离 SQLite、生产/fault 装配冒烟、两次构建与产物隔离、后端基线重跑均通过；新版视觉签收（14）、Linux Chrome/iPhone Safari 真机（15）、真实 Nginx 静态交付与回退（16）、真实上游采集/OSS 上传与持续运行不在本票执行。**

## 1. 候选源码、依赖、构建与测试环境

| 项 | 值 |
| --- | --- |
| 候选产品代码 | `7f15cac refactor(frontend): 收敛为仅含 Vue 的候选产物并清理 React 栈`（票据 12 的候选产物，本次未改动产品代码） |
| 验证基线提交 | `ea245f33fe69479d5828f1af3bfd05a71d95531e`（仅在 12 之后补 12 的证据文档） |
| 本票改动 | 只改测试与文档：`frontend/tests/e2e/list.spec.ts`、`frontend/tests/e2e-manage/management.spec.ts`、本证据及索引；`git diff --stat` 无 `frontend/src`、backend、部署脚本改动 |
| 前端锁文件 | `frontend/pnpm-lock.yaml` sha256 `8b7b09908c334a72895d0da69ec33375e830a863bca987b47978e1314fe2811a`（与 12 相同） |
| 运行时 | Linux `7.2.11-1-cachyos`；Docker 无关；Node 24.21.0（`.nvmrc`）、pnpm 10.34.6、uv 0.12.23、Python 3.12.15 |
| 浏览器 | Playwright 1.58.2，Chromium `145.0.7632.6`（desktop Chrome 与 Pixel 7 模拟项目，headless） |
| 前端直接依赖 | `vue` 3.5.44、`vue-router` 4.6.4、`element-plus` 2.14.7；dev：`vitest` 4.0.18、`@playwright/test` 1.58.2、`vue-tsc` 3.3.13、`vite` 7.3.1、`@testing-library/vue` 8.1.0、`@vue/test-utils` 2.5.1、`jsdom` 28.1.0、`typescript` 5.9.3 |
| 后端 | 未改动；`uv run --no-sync pytest backend/tests -q` 本票复跑 **809 passed**（见 §5），与 12 的基线一致 |
| 构建标识 | `pnpm check:dist` 通过：`dist/index.html` 455 B、入口 `assets/index-DJntLqAG.js` 224.6 KB、`assets/index-C99fQE1x.css` 65.9 KB；`dist/` 532 KB、`dist-mock/` 540 KB；产物隔离检查通过。入口文件名与 12 记录一致，说明候选产品构建未因本票变化 |
| 网络边界 | 本轮所有 e2e 只访问 `127.0.0.1`；因本机设置 `HTTP(S)_PROXY`，命令附加 `NO_PROXY=127.0.0.1,localhost`。未访问真实 B站/OSS，未启动采集或上传 |

候选版本验证的是**同一产品代码**：本票只补测试与台账，不重新定义构建内容。若产品代码后续变化，受影响验证必须重跑并更新本文件的版本关联（§9）。

## 2. 三类证据分开记录（不混用）

| 证据轨道 | 装配/替身 | 覆盖内容 | 本票结果 |
| --- | --- | --- | --- |
| 独立 mock 装配 | `pnpm test:e2e` 的 `desktop-chromium` / `mobile-chromium` 项目：`pnpm dev:mock` + 图片夹具服务器（4318/4319），受控归档与 fixture 图片 | 六路由骨架、未知地址、详情/阅读恢复、动态图与评论图、预览历史与手势、生产装配之外的 mock 自检边界 | 通过（含在 §5 的 173 passed 内） |
| 生产 Adapter/HTTP 替身 | 同一命令的 `desktop-chromium-archive` / `mobile-chromium-archive` 项目：`pnpm dev` 生产装配（4320）+ Playwright 只替换 `/api/archive/**` 的 HTTP 传输 | 真实 `archiveReader` DTO 映射、列表、一级评论、宽屏回复、窄屏楼中楼、管理页与 401；请求次数、cursor、排序可直接观察 | 通过（含在 §5 的 173 passed 内） |
| 实际 API + 隔离 SQLite | `pnpm test:e2e:manage`：`backend/tests/live_app.py` 固定虚构上游 + 本次运行独占临时 SQLite（4177/4324），页面走生产装配与 Vite `/api` 代理 | 管理列表/新增/启停/模式/目标/删除配置、检查/发现/窗口分项状态；删除配置后**阅读入口**仍能打开已有归档（列表与详情，含刷新）；读取不触发采集；错误脱敏与浏览器存储无凭据 | **7 passed** |

三条轨道各自回答不同问题：mock 证明受控装配与独立回归；HTTP 替身证明生产 Adapter 映射与页面读取；实际 API＋SQLite 证明前后端契约、持久化与跨页面流程。任一条通过都不替代另外两条，也不代表真实上游、真机或 Nginx 交付。

后端未改部分不重新冒充全项目验收：`backend/tests` 809 passed 只说明本候选所用后端基线未回归，后端采集/上游行为仍依据历史证据（§7）。

## 3. 本票补强的回归用例

本票先按票据清单做覆盖核对，发现三处取证缺口；只在既有替换点补测试，**未新增业务测试 API、未改产品代码**。

| 缺口 | 补强 | 位置 |
| --- | --- | --- |
| `/` 与 `/ups/:upId` 只有整文档 `goto`，没有显式刷新取证；六路由的直达/刷新口径不一致 | 新增“列表两个入口直达与刷新都按当前 scope 重新读取，不混入其他范围”：刷新后重新读首批、切换单 UP 后刷新仍只含该 UP，断言实际请求 query | `frontend/tests/e2e/list.spec.ts:208` |
| 删除监控配置后的“归档保留”只用 `page.request` 打 API，没有页面级阅读入口；管理错误脱敏也没有浏览器存储断言 | 在真实 API＋隔离 SQLite 用例中补：删除配置后 `goto('/ups/707')`、刷新、键盘进入详情并刷新均显示已归档正文；断言 `localStorage`/`sessionStorage`/Cookie 不含 token/secret/credential/authorization | `frontend/tests/e2e-manage/management.spec.ts:88`（阅读段 161–180） |
| AC-01/AC-02 要求卡片没有关注、简介占位或真实点赞，且“完全没有查看详情按钮”，此前只有正向入口断言 | 在卡片入口用例补负向断言：页面不出现“查看详情”文字与按钮、关注/点赞按钮、简介占位 | `frontend/tests/e2e/list.spec.ts:238` |

其余清单项在核对后已有用例覆盖，未为“看起来更全”重复造测试；引用见 §4 与 §6。

存储断言的边界：只能证明脚本可见的 `localStorage`/`sessionStorage`/非 HttpOnly Cookie 没有凭据；HttpOnly Cookie 与响应头由后端/部署证据覆盖，本票不据此宣称完整凭据隔离。

## 4. 票据逐项核对

缩写：**F**＝`frontend/tests/unit/*`（Vitest/jsdom 页面行为与契约）；**M**＝mock 装配 Playwright；**S**＝生产装配＋HTTP 传输替身；**P**＝生产/fault 装配冒烟；**G**＝实际 API＋隔离 SQLite；**B**＝后端 pytest（本次复跑）。行号指测试声明所在行，随文件演进而变。

| 票据清单 | 覆盖用例 | 结果 |
| --- | --- | --- |
| 固定源码、依赖、构建与测试环境；三类证据分开 | §1、§2、§5 | **通过**：候选提交与锁文件哈希固定，三次测试轨道分别记录 |
| 六路由直达/刷新；未知地址；未知 UP/动态；已知 UP 空归档；请求失败 | P `assemblies.spec.ts:4`；M `app-shell.spec.ts:6/48`；S `list.spec.ts:149/208`、`thread.spec.ts:243`、`manage.spec.ts:54`；M `detail.spec.ts:170`；G `management.spec.ts:80/88`；F `list-page.test.ts:203/248`、`detail-reading.test.ts:178/190` | **通过（自动化/隔离）**：Nginx 下的深链接刷新仍属票据 16 |
| 独立楼中楼缺失根仍是普通可重试读取错误 | F `archive-reader-replies.test.ts:72/86`（404、缺根/根不符 → 普通错误）；`thread-reading.test.ts:271/340`（仅 CURSOR_INVALID 特殊，成功空不伪造 not-found） | **通过**：未新增详情式 not-found 契约 |
| scope 隔离；动态 10/10/5；一级评论 20/20/5；完整集合排序与来源置顶 | F `list-page.test.ts:69/92/117/151/178`、`archive-reader-list.test.ts:9/30`、`archive-reader-comments.test.ts:10/50`、`comment-reading.test.ts:21/46/114/152/171/506`；S `list.spec.ts:73/176`、`comments.spec.ts:125/160/195/253` | **通过**：两种排序都读完 20/20/5，服务端顺序与置顶不被客户端重排 |
| 回复预览 3 条与实时 page 10/10/5 分开；重复读页；数量变化；末页回退 | F `archive-reader-replies.test.ts:12/29/60/86`、`reply-reading.test.ts:55/78/243/408`、`reply-paging.test.ts:4/8`；S `replies.spec.ts:141/182`；F `thread-reading.test.ts:122/162`、S `thread.spec.ts:171` | **通过**：预览走 `limit=3` cursor，展开走 `page+limit=10` 实时页码；越界重读有效末页 |
| 全部/单 UP 返回；同动态多访问；主动入口优先；讨论展开恢复；展开回复按保存页实时重读 | M `detail.spec.ts:22/56/73/112`；S `comments.spec.ts:195/235`、`replies.spec.ts:182`；F `detail-reading.test.ts:43/72/89/122/160`、`comment-reading.test.ts:214/261/287`、`reply-reading.test.ts:187` | **通过**：恢复已读批次不重读，展开回复重读保存页而非复用冻结结果 |
| 楼中楼重新挂载回首屏 vs 返回详情恢复详情状态 | S `thread.spec.ts:171/243/263`；F `thread-reading.test.ts:196/257/360` | **通过**：进入楼中楼每次 `page=1` 且滚到顶部；返回详情恢复已读批次、展开与 500px 位置且不重读 |
| 动态/评论图片 owner、完整组、混合状态、按需请求、历史与阅读恢复组合；同 URL 预览不重挂载 | F `image-groups.test.ts:21/50/65`、`comment-images.test.ts:24/52/70/106/133/182`、`list-page.test.ts:319/345/364/413`；M `preview-images.spec.ts:9/24/50/65/83/103/124/139`、`dynamic-images.spec.ts:22/45/65/106/136/200/232/295/312/338`、`comment-images.spec.ts:24/80/121/191/220/253`、`preview-history.spec.ts:9/34/48/71/97/118/135/149/180/216` | **通过（自动化）**：同 URL 预览不重建底层页面；真实的手机触摸手势与 iPhone Safari 属票据 15 |
| 管理配置/模式/目标、分项状态、删除配置后阅读入口、401 与安全隔离 | G `management.spec.ts:15/34/58/68/80/88/197`；S `manage.spec.ts:54/83/111/145/175/204/377/459/486`；F `management-api.test.ts`、`manage-page.test.ts:142/152`、`manage-up-page.test.ts:131/144/279/321/385/400`、`manage-status.test.ts:39/132/192/213/269/283` | **通过（隔离功能）**：删除配置后列表/详情仍可读；401 固定提示；错误不回显；不新增凭据 UI 或浏览器存储 |
| 竞态：忽略取消、乱序成功/失败/完成、重复读写、离开未完成请求再返回 | F `archive-reader-list.test.ts:72`、`archive-reader-comments.test.ts:103`、`archive-reader-replies.test.ts:129`、`management-api.test.ts:474`、`comment-reading.test.ts:171/525`、`detail-reading.test.ts:256/293`、`reply-reading.test.ts:438/479/581`、`thread-reading.test.ts:360`、`list-page.test.ts:117/151`、`manage-up-page.test.ts:400/426/493`、`manage-status.test.ts:146/166`；S `comments.spec.ts:253`、`detail.spec.ts:145`、`thread.spec.ts:263` | **通过**：旧结果不改写新访问、不清新加载态、不遗留永久 loading；列表/评论/详情/回复/楼中楼均有离开返回用例 |
| AC-01–AC-34 影响与结果台账 | §6 | **已建立**：逐项区分本次重跑、未变更后端历史依据与未验证项 |
| 只用现有 Adapter/传输替换点；实际集成用隔离 SQLite 与受控来源；不新增业务测试 API、不发起真实上游/OSS | §2、§3；`backend/tests/live_app.py` 未改动，`/api/test/collect`、`/api/test/source-failure` 是 09–11 已登记的仅测试夹具端点 | **通过**：本票新增测试只使用 `page.route` 与 live_app 既有端点 |

## 5. 实际命令与结果

在 `frontend/` 执行（后端命令在仓库根执行）；全部附加 `NO_PROXY=127.0.0.1,localhost`。

| 命令 | 结果 |
| --- | --- |
| `pnpm check` | 通过：`vue-tsc` 类型检查 + **244 passed（21 文件）** + e2e 项目覆盖守卫（含 `static-delivery.spec.ts [E2E_TARGET=nginx]` 声明核对） |
| `pnpm test:e2e` | **173 passed / 10 skipped**（4.1m）。10 skipped 全是 `preview-gestures.spec.ts` 需要触摸环境的窄屏手势用例，不计为通过；其余 mock 与生产 Adapter/HTTP 替身项目全绿 |
| `pnpm test:e2e:production` | **3 passed / 3 skipped**（生产装配六路由/404/无自检入口；fault 装配独立） |
| `pnpm test:e2e:manage` | **7 passed**（实际 API + 本次运行独占 SQLite；含新增的删除配置后阅读入口与存储断言） |
| `pnpm check:dist` | 通过：`pnpm build` + `pnpm build:mock` + `check:isolation`（生产产物无 mock 入口/夹具/归档数据；自检构建有） |
| `uv run --no-sync pytest backend/tests -q`（仓库根） | **809 passed，3 warnings**（146s，exit 0）；后端代码未改动，作为“未变更后端基线”的本次复跑依据 |
| `TZ=UTC pnpm vitest run tests/unit/detail-reading.test.ts` / `TZ=America/New_York …` | 各 **13 passed**：发布时间格式化固定 `Asia/Shanghai`，换进程时区后仍显示绝对北京时间与秒 |

命令顺序：先单测/类型检查，再 mock 与生产 e2e（同一 Playwright 配置、串行 1 worker），然后真实 API 集成，最后两次构建；后端 pytest 与本票测试独立执行。测试输出中的本机绝对路径/PID 属非敏感环境信息。

## 6. AC-01–AC-34 影响与结果台账

状态规则：**通过**只表示该行在本票指定证据类别（自动化/隔离功能）内成立；有一项必需类别缺失即标**未验证**或**部分**。本次未发现迁移回归，也未复现新的既有缺陷；未验证项不由历史同号通过继承。**历史依据**指后端未改动部分的既有证据，仅用于说明前端未改变的契约，不冒充本期重跑。

| AC | 本次分类与结果 | 证据 |
| --- | --- | --- |
| AC-01 信息、全部/单 UP 选择、作者 ID 判 UP、无真实写回 | **通过（本次重跑，自动化）**；真机/视觉未验证 | F `list-page.test.ts:267`、`comment-reading.test.ts:438`、`manage-up-page.test.ts:17`；S `list.spec.ts:73/238`、`comments.spec.ts:125`；`ReadOnlyLike.vue` 仅 `role=group`；列表页负向断言“查看详情”、关注/点赞按钮与简介占位均不存在，见 `list.spec.ts:238` |
| AC-02 整卡/键盘到顶部、气泡进同页评论、内嵌操作隔离、无查看详情 | **通过（自动化）** | S `list.spec.ts:238`、`comments.spec.ts:125/160`、`thread.spec.ts:171/243`；M `detail.spec.ts:22`；F `list-page.test.ts:296`、`compact-comment-preview.test.ts:55` |
| AC-03 实际 6 行折叠、详情全文、安全长文本 | **通过（自动化）** | S `list.spec.ts:121`、`comments.spec.ts:160`、`replies.spec.ts:218`；F `list-page.test.ts:267`、`detail-reading.test.ts:233` |
| AC-04 绝对北京时间与秒、编辑时间不回到阅读页、计数来源/本地/零/缺失 | **通过（本次重跑，自动化）**；真实来源时间可用性未验证 | F `detail-reading.test.ts:233`（TZ=UTC/NY 复跑）、`comment-reading.test.ts:438`、`thread-reading.test.ts:122`、`reply-reading.test.ts:555`；后端编辑/计数解析见 AC-26/27 历史依据 |
| AC-05 动态 10/10/5、完整集合排序、结束不再请求 | **通过（自动化）** | F `list-page.test.ts:69/92/117/178`、`archive-reader-list.test.ts:9`；S `list.spec.ts:73/176/208` |
| AC-06 一级评论 20/20/5、最热/最新、置顶 | **通过（自动化）** | F `archive-reader-comments.test.ts:10/50`、`comment-reading.test.ts:21/46/114`；S `comments.spec.ts:125/195` |
| AC-07 切换重置、乱序不污染、失败重试 | **通过（自动化）** | F `comment-reading.test.ts:114/152/171/394`；S `comments.spec.ts:160/253` |
| AC-08 预览 3 条、展开 10/10/5、收起定位、按保存页重读、越界末页、楼中楼语义、条件化目标 | **通过（迁移目标模型）** | F `reply-reading.test.ts:55/78/137/187/243/280/315/340/377/408/438/479/526/555/581`、`archive-reader-replies.test.ts:12/29/60/72/86`；S `replies.spec.ts:141/182`、`thread.spec.ts:171/243/263`；F `thread-reading.test.ts:74/122/162/196/257/271/340/360` |
| AC-09 图片不变形、完整组可达、所点索引与 owner 正确 | **通过（自动化/布局）**；像素视觉未验证 | F `image-groups.test.ts:21/50/65`、`comment-images.test.ts:24/52/70`、`list-page.test.ts:319`；M `preview-images.spec.ts:9/24/83/124`、`dynamic-images.spec.ts:22/45`、`comment-images.spec.ts:80` |
| AC-10 原生预览、长图、切换/关闭、手机手势 | **部分**：桌面/长图/异常组通过；窄屏手势 10 例跳过（需触摸环境），iPhone Safari 属票据 15 | M `preview-images.spec.ts:139`、`preview-history.spec.ts`、`dynamic-images.spec.ts:232`；`preview-gestures.spec.ts:16–125` 跳过；票据 01 历史真机证据 |
| AC-11 返回先关预览、位置/焦点恢复、底层不滚动 | **通过（自动化）**；真机焦点/滚动属票据 15 | M `preview-history.spec.ts:9/34/48/71/97/135/149/180/216`、`dynamic-images.spec.ts:65/106/295/312/338`、`comment-images.spec.ts:121/191`；F `list-page.test.ts:364/413`、`comment-images.test.ts:133/182` |
| AC-12 多批/展开/访问历史恢复、主动入口优先 | **通过（自动化）** | M `detail.spec.ts:22/56/73/112/145`、`comments.spec.ts:195/235`；F `detail-reading.test.ts:43/72/89/122/160`、`comment-reading.test.ts:214/261/287` |
| AC-13 六路由直达/刷新、来源返回、空/未知/失败、断源保留 | **通过（自动化/隔离）**；Nginx 深链刷新属票据 16 | P `assemblies.spec.ts:4`；M `app-shell.spec.ts:6/48`；S `list.spec.ts:149/208`、`thread.spec.ts:243`、`manage.spec.ts:54`；M `detail.spec.ts:170`；G `management.spec.ts:80/88` |
| AC-14 区域级状态/失败/重试、不重复 | **通过（自动化）** | F `list-page.test.ts:117/178/203`、`comment-reading.test.ts:79/369/394`、`reply-reading.test.ts:280/340/581`、`thread-reading.test.ts:271`；M `dynamic-images.spec.ts:136`、`comment-images.spec.ts:24` |
| AC-15 缺字段兜底、纯图/纯文/真空态 | **通过（自动化）** | F `list-page.test.ts:267/345`、`detail-reading.test.ts:355`、`comment-reading.test.ts:493`、`archive-reader-list.test.ts:89`；M `preview-images.spec.ts:65`、`dynamic-images.spec.ts:136` |
| AC-16 四宽度、44px、焦点；正式设备 | **部分**：四宽度/触控尺寸/键盘自动化通过；Linux Chrome、iPhone Safari 真机属票据 15 | S `list.spec.ts:96`、`manage.spec.ts:222/340`、`comments.spec.ts:336`、`thread.spec.ts:285`；M `preview-layout.spec.ts:9`、`dynamic-images.spec.ts:256`、`comment-images.spec.ts:220` |
| AC-17 mock 独立、真实 API Adapter、给定公开图 URL、只读按需 | **通过（隔离/只读）**；真实 OSS 上传与生产环境未验证 | M `preview-images.spec.ts:9/103`、`dynamic-images.spec.ts:200`、`comment-images.spec.ts:253`；S `list.spec.ts:238`；P `assemblies.spec.ts:35`；G 全流程 |
| AC-18 安全文本、无故障面板、无凭据/采集调用、mock 无真实依赖 | **通过（自动化）** | F `list-page.test.ts:267`、`comment-reading.test.ts:438/493`、`assembly.test.ts:5/11/16`、`management-api.test.ts:452`；P `assemblies.spec.ts:35/50`；G `management.spec.ts:88` 存储断言 |
| AC-19 可复现构建、Nginx 深链接、API/资源错误隔离 | **部分**：构建与产物隔离通过；真实 Nginx 交付属票据 16 | `pnpm check:dist`；`static-delivery.spec.ts:10/21/35/59/72` 本次未执行（本机无 nginx） |
| AC-20 阅读/失败/scope/管理/状态端到端自动化 | **通过（自动化类别）** | 本文件 §4/§5 的 F/M/S/P/G/B 全部命令 |
| AC-21 全部全局排序分页、scope/cursor/访问/迟到隔离、选择条不横溢 | **通过（自动化）** | F `list-page.test.ts:69/151/234`、`archive-reader-list.test.ts:9/105`；S `list.spec.ts:96/176/208` |
| AC-22 UID 取身份、独立配置/目标/状态持久化、无凭据 UI | **通过（隔离功能）**；真实 UID 上游未验证 | G `management.spec.ts:15/34/58/68/88/197`；F `management-api.test.ts`、`manage-page.test.ts`、`manage-up-page.test.ts` |
| AC-23 原规则跨页凑 N、耗尽 | **未验证（真实来源）**；未变更后端历史依据 | B 809（`test_recent_discovery.py` 等）；G `management.spec.ts:197` 只驱动受控发现；F `manage-status.test.ts:192/213` |
| AC-24 指定 ID 归属、不符/未知、模式不裁剪已有归档 | **部分**：归属校验与模式/目标隔离功能通过；采集不受目标选择限制属未变更后端历史依据 | G `management.spec.ts:88`；B 809（管理/目标历史用例） |
| AC-25 固定 15 秒、忙跳过、同步分离、checkpoint | **未验证（持续调度）**；未变更后端历史依据 | B 809（`test_collector.py`、`test_deployment_processes.py` 等）；本票未启动长期采集 |
| AC-26 HTML 安全 JSON、AUTHOR 编辑时间、未知保留 | **未验证（真实来源）**；未变更后端历史依据 | B 809（`test_versioned_edit_sync.py` 等）；阅读页不展示编辑块见 F `detail-reading.test.ts:233` |
| AC-27 计数变化触发同步、来源/本地分离、漏检限制 | **未验证（真实来源）**；未变更后端历史依据 | B 809（`test_comment_count_sync.py` 等）；F `reply-reading.test.ts:555`、`thread-reading.test.ts:122` 只证明前端呈现 |
| AC-28 正文受限不挡评论、失败不清档、分项恢复 | **未验证（真实来源）**；未变更后端历史依据 | B 809（`test_restricted_terminal.py` 等）；G `management.spec.ts:197` 与 F `manage-status.test.ts:39/132` 只证明状态呈现 |
| AC-29 停止/删除/切模式/出窗口后保留、不再监控 | **部分**：归档保留与阅读入口通过；"不再监控"的调度行为属未变更后端历史依据 | G `management.spec.ts:88`（停用、移除目标、删除配置后归档与阅读入口均保留）；B 809（生命周期历史用例） |
| AC-30 动态/根评论图 owner、顺序/状态/重试、公开 OSS 直取 | **通过（隔离/自动化）**；真实 OSS 未验证 | F/M 的图片组与异常状态用例（同 AC-09/10）；G 不涉及 OSS |
| AC-31 新版视觉基准、受控截图与签收 | **未验证**：属票据 14 | 本票未截图、未做视觉比对；不把功能通过当作视觉通过 |
| AC-32 无鉴权/公开图风险说明、秘密服务端、错误脱敏 | **部分**：自动化隔离与脱敏通过；真实部署/真实凭据未验证 | P `assemblies.spec.ts:35`、F `management-api.test.ts:452`、G `management.spec.ts:68/88`；历史部署证据见票据 16 |
| AC-33 单 API＋独立采集＋SQLite、限定工具链、资源环境 | **部分**：工具链已记录；2 核 2GB/持续资源未验证 | §1 环境；后端 809；未启动 Redis/Celery 或多 worker |
| AC-34 历史/样本/本期自动化/持续运行与资源分别记账 | **通过（记录类别）** | 本文件 §1/§2/§6/§7/§9 |

“未验证”不等于失败：本票只把候选版本的协议与跨流程回归做到可复核；视觉、真机、静态交付与真实上游/持续运行由 14–16 及后续运行证据补齐。

## 7. 未验证项与边界（不标通过）

| 未验证 | 原因与去向 |
| --- | --- |
| 新版视觉签收、四视口受控截图 | 票据 14；本票不生成新基准，也不以功能通过代替视觉 |
| Linux Chrome、iPhone Safari 真机；窄屏触摸手势 | 票据 15；`preview-gestures.spec.ts` 的 10 例在无触摸环境跳过，票据 01 的 iPhone 13 Pro / iOS 16.4 记录只对当时版本有效 |
| 真实 Nginx 静态交付、深链接/缓存/404、前端回退 | 票据 16；本机无 nginx，`pnpm test:delivery`、`test:http`、`static-delivery.spec.ts` 的 nginx 项目未执行 |
| 真实上游采集、B站页面/评论权限、实际 OSS 上传与公开直取 | 不在本票范围；本票只用受控虚构来源与隔离 SQLite |
| 持续 15 秒调度、2 核 2GB 资源、长期运行 | 历史/后续运行证据；809 passed 的受控时钟与有限进程不能替代 |
| 后端编辑时间、计数、受限正文等真实来源行为 | 未变更后端历史依据；本票复跑只证明基线未回归 |

后端未改并不是“全项目重新验收”：AC-23–28、33 的采集与来源部分仍依赖历史证据或后续运行；AC-31、16、19、32 的正式环境部分由 14–16 补齐。

## 8. 复现步骤

```bash
# 仓库根：后端基线（可选，但本票已执行）
uv run --no-sync pytest backend/tests -q

# 前端
cd frontend
pnpm install                # 锁文件固定；本票未新增依赖
NO_PROXY=127.0.0.1,localhost pnpm check
NO_PROXY=127.0.0.1,localhost pnpm test:e2e
NO_PROXY=127.0.0.1,localhost pnpm test:e2e:production
NO_PROXY=127.0.0.1,localhost pnpm test:e2e:manage
NO_PROXY=127.0.0.1,localhost pnpm check:dist
```

单跑本票新增/改动的用例：

```bash
cd frontend
NO_PROXY=127.0.0.1,localhost pnpm exec playwright test \
  --project=desktop-chromium-archive --project=mobile-chromium-archive tests/e2e/list.spec.ts
NO_PROXY=127.0.0.1,localhost pnpm test:e2e:manage
TZ=America/New_York pnpm vitest run tests/unit/detail-reading.test.ts
```

`test:e2e:manage` 每次启动都会新建系统临时 SQLite，只监听回环地址；若端口 4177/4324 被占用，应先记录环境失败，不停止他人服务。

## 9. 版本关联与后续变更

- 本文件对应产品代码 `7f15cac` + 本票测试/文档提交；构建入口 `index-DJntLqAG.js` / `index-C99fQE1x.css` 与 12 一致。
- 若候选版本后续改动产品代码、依赖锁文件或构建配置：重跑受影响轨道的命令（至少 `pnpm check` 与相关 e2e；涉及装配/构建时加 `pnpm check:dist`），在本文件追加新版本行并保留本版本结论，不把旧候选证据直接移植到新版本。
- 若只改测试/文档：可保留产品版本标识，但必须记录新增/修改的用例与命令结果；本票即按此处理。
- 视觉、真机、Nginx 与真实上游证据分别由票据 14–16 及后续运行补充，不能引用本文件的自动化结论冒充。
