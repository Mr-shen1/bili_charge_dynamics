# 17 统一上线就绪汇总

- 对应票据：[17 汇总统一上线就绪结论](../issues/17-release-readiness-summary.md)
- 对应规格：[前端重构实施规格](../spec.md)「用户故事 63」「需求追踪与完成门槛」「测试决策」；[前端重构方案](../../../docs/design/frontend-migration.md)
- 上游证据：[13 协议与跨流程回归](13-integrated-protocol-regression.md)、[14 视觉基准准备与签收](14-visual-baseline-preparation.md)、
  [15 实际设备验收](15-real-device-acceptance.md)、[16 静态交付与回退](16-static-delivery-rollback.md)、[01 原生预览验证](01-native-image-preview.md)
- 需求真值：[SRS §9](../../../docs/product/SRS.md)；文档/代码差异：[行为基线差异](../baseline-differences.md)
- 证据状态：**结论＝可申请统一上线**（附 §7 已裁决的已知限制）。视觉与签收基准在判定口径下**零差异像素**（63/63 判定口径（AE + 1% fuzz）零差异像素，50 张与签收图字节相同、13 张仅抗锯齿级差异），自动化、交付与回退都在同一份候选产物上重跑；
  设备复验与可审计性缺口按用户裁决处理。本文件**不授权部署**，实际上线须另行授权。

## 1. 结论

**判定：可申请统一上线。** 没有未决的证据缺口或阻断回归；三项曾待人工处理的事项已由用户裁决或由回退消除（§7）。

| 判断项 | 结果 |
| --- | --- |
| 候选产物是否唯一、可追溯 | **成立**：本票的产品树（含输入框字号回退）就是最终候选，其余改动只有文档、测试与仓库脚本；产物标识见 §2 |
| 自动化（类型检查/行为/契约/实际 API/构建/交付）是否可复现 | **成立**：本票全量重跑通过，产物可逐字节复现（§5） |
| AC-01–AC-34 台账是否逐项完整 | **成立**：见 §6，逐项区分本次重跑、真机、视觉、隔离交付、未变更后端历史依据与未验证 |
| 新版视觉是否已由用户确认且对应最终候选 | **成立**：回退输入框字号后，最终候选的 63 张受控截图在判定口径（AE + 1% fuzz，阈值 0.02%）下 **0 差异像素**，其中 50 张与签收图字节完全相同、13 张仅抗锯齿级差异（最大 0.00004%），签收直接结转（§4） |
| Linux Chrome 与 iPhone Safari 结果是否齐备且对应最终候选 | **成立（按裁决）**：实测记录见票据 15；最终候选相对被测候选 `32c9510` 的唯一产品差异就是本次回退的输入框字号，复验按用户裁决免做（R2，§7） |
| 是否存在已知阻断回归 | **没有**：前端无回归；后端两例异步时序用例偶发超时在第三次全量跑中 `809 passed`（§5，既有测试稳定性问题） |
| 免责边界 | 未在目标机/云/TLS/公网执行，未访问真实上游或 OSS，未做持续运行与容量验证；部署须另行授权（R5） |

## 2. 候选产物与各票证据的对应关系

### 2.1 产品树的最终状态

最终候选＝本票提交的产品树。相对票据 15/16 实测的 `32c9510`，**唯一的产品改动**是
`frontend/src/theme/theme.css`：删掉把 `.el-input__inner`/`.el-textarea__inner` 强制成 16px 的规则，恢复 Element Plus 默认字号（实测 14px）。
其余改动是文档、测试（`frontend/tests/**`）、仓库脚本（`frontend/scripts/**`）与 `frontend/playwright.config.ts`，都不进产物。
连带证据：`manage.spec.ts` 的四视口字号断言从「≥16px」改为「等于库默认字号，且默认字号仍是 14px」，防止再次漂移；
[设计文档](../../../docs/design/frontend-migration.md)把「库内部类覆盖」从两类收回一类并记录该裁决。

### 2.2 最终候选的产物标识（本票实测）

| 项 | 值 |
| --- | --- |
| 入口 HTML | `index.html` sha256 `6b520cd7…`，455 B |
| 生产入口 | `assets/index-C-E5912O.js`（229.99 kB，gzip 84.60 kB）+ `assets/index-DDIJRK8V.css`（70.76 kB，gzip 10.29 kB） |
| 资源数 | 28 个内容哈希资源（17 JS + 11 CSS，含 6 个路由 chunk），无 SSR、无常驻 Node |
| 产物体积 | `dist` 31 文件 / 467253 B；`dist-mock` 34 文件 / 466899 B（入口 `index-CeKSQI_l.js` + `index-DDIJRK8V.css`，`index.html` sha256 `f127748b…`） |
| 依赖与运行时 | 锁文件 `frontend/pnpm-lock.yaml` sha256 `8b7b0990…` 未变；vue 3.5.44、vue-router 4.6.4、element-plus 2.14.7、vite 7.3.1、Node 24.21.0、pnpm 10.34.6 |
| 值得一提的旁证 | 回退后入口 CSS 文件 `index-DDIJRK8V.css` 与用户签收视觉时的构建（`89d0b49`）同哈希——样式内容已回到签收版本 |
| 复核方式 | `index.html` 的 sha256 与入口引用可用 §10 的 `sha256sum`/`grep` 直接核对；证据提交（`c5a403a` 之后）只改文档与测试，产品面未变 |

### 2.3 各票证据与候选的对应

| 记录 | 绑定候选 | 与本票最终候选的关系 |
| --- | --- | --- |
| 15 设备 `evidence/device-15/candidate.json` | `32c9510`（`index-B7KnNIzH.js` + `index-BT3uA9bJ.css`）；A 节全量实测在更早的 `946ed66`，`32c9510` 只补验 A9/A13/B6 与输入框 | 最终候选相对 `32c9510` 的唯一产品差异是输入框字号回退；受影响项即 F-15-02，复验按用户裁决免做（§7） |
| 16 交付 `evidence/16-delivery-manifest.json` | 同 `32c9510` 产物（`entry_sha256` 与 15 一致） | 交付结论由本票在新候选上重跑（§5），入口演变为 `index-C-E5912O.js` |
| 13 自动化（`7f15cac`）、14 视觉签收（`89d0b49`） | 更早的构建 | 本票在新候选上重跑全部自动化（§5）；视觉由重拍证明 0 差异（§4） |

## 3. 证据更正：票据 15 的 `visual:compare` 曾是自比

票据 15 第二轮登记「`pnpm visual:compare` 通过：63 张仍在阈值内（字号 13→16 的差异低于 0.02%，因此不更新黄金图）」。
本票核对后确认**该结论当时的取证方式不成立**：

- `compare-visual-baseline.mjs` 只比较 `evidence/visual-14/` 里现成的 PNG，不重新截图；
- 逐张核对：签收黄金图 63 张与 `evidence/visual-14/` 的 63 张 **sha256 全部相同**，即那次比较是「同一组文件比自己」；
- `evidence/visual-14/conditions.json` 仍记录 `sourceCommit = 89d0b49`，说明第二轮没有重跑 `visual:baseline`。

本票给截图工具加了输出目录开关（`VISUAL_OUT_DIR`），在真实候选产物上重拍后再比较，补上了这一步（§4）。
票据 15 的原文与其勾选状态保持原义，更正记录追加在该文件末尾；**票据 15 的 7 个勾选项都不依赖这条视觉比较**，其 `done` 状态不变。

## 4. 最终候选的视觉对照（重拍，0 差异）

| 项 | 值 |
| --- | --- |
| 命令 | `VISUAL_OUT_DIR=…/evidence/visual-17 pnpm visual:baseline` 然后 `pnpm visual:compare --current …/evidence/visual-17` |
| 截图条件 | 与签收基准完全一致：Chromium 145.0.7632.6、DPR 1、100% 缩放、视口 360/390/768/1280×900、`Asia/Shanghai`、`zh-CN`、系统字体栈 |
| 产物标识 | `conditions.json`：`sourceStatus` 为空（工作树干净），构建清单 28 项 = 最终候选（`index-C-E5912O.js` / `index-DDIJRK8V.css`） |
| 结果 | **63/63 通过**，判定口径（AE + 1% fuzz）下 **0 差异像素**；`layout.spec.ts` 的 6 条四宽度布局/触控/焦点审计同时通过 |
| 差异明细 | 50 张与签收图 **sha256 完全相同**；13 张为抗锯齿级差异：判定口径下差异像素为 0，不含容差的 AE 权重和最大 **0.14**
（HDRI 构建下可为小数，表示差异远小于 1 个像素；最大占比 0.00004%，远小于 0.02% 阈值）。这与票据 14 记录的非字节级确定性一致，不是布局或样式变化 |
| 入库内容 | `visual-17/` 下的 `conditions.json`、**63 张截图本体**（可逐张校验 sha256）与 `diff-report.json`（逐张记录 `identicalBytes` / `diffPixelsFuzz` / `diffWeightNoFuzz` / `ratioNoFuzz`） |
| 元数据口径 | `conditions.json` 由截图工具生成：`sourceCommit` `c5a403a`（截图时的 HEAD，干净工作树，`sourceStatus` 为空；其后只有本票的证据提交），`build` 的 28 项即 §2.2 的产物；`ticket: "14"`、`scope`/`caveats` 的「未签收」措辞是票据 14 的模板值，本文件的判定与签收依据以本节与 `diff-report.json` 为准 |

过程记录：第一次重拍（16px 版本）有 4 张单 UP 管理截图各差 43 像素，差异都落在「近期 N 条」输入框里的数字，改变区域仅 17×12 像素。
用户裁决该变化不可接受、字号应保持原样（R1），于是回退 16px 覆盖并再次重拍，得到上面的结果。
回退前的对照图与差异记录留在提交历史（`4d2e045` 及其父提交），不在工作树里堆积。

## 5. 本票复跑结果（可复现性）

环境：CachyOS Linux `7.2.11-1-cachyos`、Node 24.21.0（nvm）、pnpm 10.34.6、uv 0.12.23、Python 3.12.15、
Playwright Chromium 145.0.7632.6；因本机设置 `HTTP(S)_PROXY`，前端命令附 `NO_PROXY=127.0.0.1,localhost`。
全部命令输出归档在 `17-logs/`（`check.log`、`check-dist.log`、`e2e.log`、`e2e-production.log`、`e2e-manage.log`、
`nginx-parity.log`、`delivery.log`、`visual-baseline.log`、`visual-compare.log`、三次后端全量 `pytest-full-{1,2,3}.log`）。

| 命令 | 结果 |
| --- | --- |
| `pnpm check` | 通过：`vue-tsc` 无错、**23 文件 / 254 用例**、e2e 项目覆盖守卫（含 `static-delivery.spec.ts [E2E_TARGET=nginx]`） |
| `pnpm test:e2e` | **173 passed / 10 skipped**（3.3m）；跳过项全是桌面项目缺触摸环境的窄屏手势，同一批用例在 `mobile-chromium` 以 CDP 触摸序列执行 |
| `pnpm test:e2e:production` | 3 passed / 3 skipped（六路由、404、无自检入口、fault 装配隔离） |
| `pnpm test:e2e:manage` | **7 passed**（生产 Adapter + `backend/tests/live_app` 虚构上游 + 本次独占临时 SQLite） |
| `pnpm check:dist` | 两次构建 + 产物隔离通过；可复现结果见 §2.2 的哈希 |
| `pnpm test:nginx-parity` | 通过（location/server 指令与 public 命名空间规则一致） |
| `pnpm test:delivery`（临时编译 Nginx 1.28.0，`DELIVERY_PORT=4273`） | 三阶段全 **PASS**：mock 31 资源可达、构建可复现与 fault 隔离、mock 原子更新 `index-CeKSQI_l.js → index-IyFYg4CP.js` 与回退；生产六路由/28 资源/401 提示/`/api` 404·422·502 不回退 SPA、生产更新 `index-C-E5912O.js → index-Pa2PSiv9.js` 与回退；SQLite 未被替换、collector 未重启 |
| `VISUAL_OUT_DIR=… pnpm visual:baseline` + `pnpm visual:compare --current …` | 6 条视觉审计用例通过 + **63/63 零差异**（§4） |
| `uv run --no-sync pytest backend/tests -q` | 三次全量：**809 passed**、808 passed / 1 failed、808 passed / 1 failed；两次失败用例不同，均为用例内 `asyncio.wait_for(…, 3)` 超时，单独重跑与单文件连跑 3 次全绿 |

后端那两次失败按**既有缺陷**记录：`git diff 491a529..HEAD -- backend/` 为空，第三次全量回到 809 passed，与 13 的基线一致；
差异只在机器负载下的时序敏感性。本票未改后端、未放宽任何断言，也不据此宣称后端基线重新验收。

## 6. AC-01–AC-34 台账（最终候选）

证据缩写：**F**＝`frontend/tests/unit/*`（Vitest 页面行为与契约，本次 254 例）；**M**＝mock 装配 Playwright；
**S**＝生产装配 + `/api/archive/**` HTTP 传输替身；**P**＝生产/fault 装配冒烟；**G**＝实际 API + 隔离 SQLite；
**V**＝票据 14 的布局/触控/焦点审计与签收截图（本票重拍为 0 差异）；**N**＝隔离 Nginx 交付（`test:delivery` 与 `static-delivery.spec.ts`）；
**D**＝票据 15 真机清单（A*/B*）；**H**＝后端未改动部分的既有证据（`backend/tests` 809 例基线）。
逐用例行号见[13 §6](13-integrated-protocol-regression.md)（时点 `7f15cac`，此后仅 `manage.spec.ts` 增行，用例名不变）。

**每类证据实测在哪个候选上**：

| 证据族 | 实测候选 | 本票处理 |
| --- | --- | --- |
| F/M/S/P/G、N（自动化与隔离交付） | 最终候选 | **本次重跑**，日志在 `17-logs/` |
| V（视觉签收与布局审计） | 签收截图 `89d0b49`；本票在最终候选上重拍 | **0 差异**，签收直接结转 |
| D（真机清单） | `946ed66` 全量 + `32c9510` 补验 A9/A13/B6/输入框 | 最终候选仅回退了那处输入框字号，复验按用户裁决免做（R2） |
| H（后端基线） | `backend/tests` 809 例基线；本票三次全量 | **本次重跑**（第三次 809 passed） |

| AC | 本次结论 | 依据与缺口 |
| --- | --- | --- |
| AC-01 | **通过** | F/S `list-page`/`list.spec.ts`（含无「查看详情」、关注/点赞、简介占位负向断言）、D A1–A4 |
| AC-02 | **通过** | S/M `detail.spec.ts`、`comments.spec.ts`、`thread.spec.ts`；D A3/A6 |
| AC-03 | **通过** | F/S `list-page`、`detail-reading`、`replies.spec.ts`；V 6 行折叠与详情全文例外实测 |
| AC-04 | **通过** | F `detail-reading`（`TZ=UTC`/`TZ=America/New_York` 复跑）、`comment-reading`、`reply-reading`；D A1–A4 |
| AC-05 | **通过** | F/S 动态 10/10/5、完整集合排序、结束不再请求；D A1/A2 |
| AC-06 | **通过** | F/S 一级评论 20/20/5、最热/最新、来源置顶；D A4 |
| AC-07 | **通过** | F `comment-reading` 切换重置与乱序隔离；D A4 |
| AC-08 | **通过** | F/S 预览 3 条 + 实时 10/10/5、收起定位、保存页重读、越界末页、楼中楼首屏/返回语义、条件化目标；D A5/A6 |
| AC-09 | **通过** | F/M owner 与完整组、所点索引；V 首卡 4 图可达（预览 `1/4` → `2/4`）；D A9 |
| AC-10 | **通过** | M 长图/切换/关闭/异常组；`preview-gestures.spec.ts` 10 例在 `mobile-chromium` 触摸项目执行；D A8/A9/A15（含规格第 36 条已裁决的 4 项库能力限制） |
| AC-11 | **通过** | M `preview-history.spec.ts`（后退先关预览、前进恢复、刷新清理、焦点/滚动）；D A10/A11 |
| AC-12 | **通过** | M/F 多批、展开、同动态多访问与主动入口优先；D A7 |
| AC-13 | **通过** | P/M/S/G 六路由直达与刷新、空/未知/失败、断源保留；**N** 隔离 Nginx 六路由直达/刷新 + 未知地址由前端表达；D A2/A6 |
| AC-14 | **通过** | F 区域级失败/重试、重复点击不重复；V 空态/错误态截图；D A12 |
| AC-15 | **通过** | F 缺字段兜底、纯图/纯文/空态；V 空态与受限正文截图 |
| AC-16 | **通过** | V 四宽度无横溢、UP 条仅内部横滚、触控 ≥43px、键盘焦点可见；D Linux Chrome `155.0.8059.39`（1280 宽）与 iPhone 13 Pro / iOS 16.4 / Safari 16.4，A13 在 `32c9510` 复跑；UA 与逐项附件的缺口由用户裁决接受（R3） |
| AC-17 | **通过（隔离范围）** | S/G：生产 Adapter 真实 DTO 映射、业务图公开 URL 直取、读取不触发采集；**N** 生产阶段只发 GET；真实 OSS 上传与真实上游未验证（属后端历史依据） |
| AC-18 | **通过** | F/P 安全文本、无故障面板、无凭据读取；G 浏览器存储无 token/secret；**N** 产物/HTTP/日志秘密扫描通过 |
| AC-19 | **通过** | 构建逐字节可复现（`check:dist` + 交付脚本临时目录重建）；**N** 六路由、缺资源 404 `no-store`、API 错误不回退 SPA、交付物齐全 |
| AC-20 | **通过** | F/M/S/P/G 全矩阵（本票重跑，§5） |
| AC-21 | **通过** | F/S 全局排序分页、scope/cursor/访问/迟到隔离、选择条不横溢；D A1/A2 |
| AC-22 | **通过（隔离范围）** | G 新增/启停/模式/目标/删除配置与 401 脱敏；D B1–B6（B6 在 `32c9510` 补验通过）；B7–B10 未跑（票面外扩展项，其中检查/发现状态呈现由 F `manage-status` 与 G 覆盖） |
| AC-23 | **未验证（真实来源）** | 近期模式跨页凑 N 属采集侧行为；后端未改，仅有 **H**；G 只驱动受控发现 |
| AC-24 | **部分** | 归属校验与模式/目标隔离：G + D B6 通过；「目标选择不限制采集」是后端行为，依据 **H** |
| AC-25 | **未验证（持续调度）** | 15 秒节拍、忙跳过、checkpoint 属后端；**H** + 后端 pytest（含偶发超时的既有问题），本票未启动长期采集 |
| AC-26 | **未验证（真实来源）** | 编辑时间解析属采集侧；**H**；前端「阅读页不展示编辑块、时区无关的时间格式化」通过（F） |
| AC-27 | **未验证（真实来源）** | 计数变化触发同步属采集侧；**H**；前端来源/本地计数分离呈现通过（F） |
| AC-28 | **未验证（真实来源）** | 正文受限下的评论同步属采集侧；**H**；前端状态呈现通过（F/G） |
| AC-29 | **部分** | 停用/移除目标/删除配置后归档与阅读入口保留：G + 交付阶段只读浏览通过；「不再监控」与上游消失保留属 **H**；D B10 未跑 |
| AC-30 | **通过（隔离范围）** | 动态图与根评论图 owner/顺序/状态/重试分离，回复页不新增图片；真实 OSS 未验证 |
| AC-31 | **通过** | 用户签收 63 张四宽度受控截图（`89d0b49`）；本票在最终候选重拍，判定口径下 **63/63 零差异像素**（50 张字节相同、13 张仅抗锯齿差异），签收直接结转；信息裁剪（无转发/视频/榜单/发布/真实点赞、可有充电标识）由 F/S/截图覆盖 |
| AC-32 | **部分** | 401 固定提示、错误脱敏、秘密不在产物/响应/日志：F/G/P/**N** 通过；公网无鉴权暴露与公开 OSS 直取的风险说明在部署与产品文档；真实部署与真实凭据未验证 |
| AC-33 | **部分** | 架构（单 API + 独立 collector + SQLite，无 Redis/Celery）、工具链（Node nvm+pnpm、Python uv）、Vue 重构验收成立；2 核 2GB 同机资源未实测 |
| AC-34 | **通过（记录类别）** | 本文件与 13 §1/§2/§6 分列历史证据、本期回归、未验证项；未验证项按 R3（已裁决）/R4/R5 如实登记 |

统计：**通过 22 项**（AC-01–16、18–21、31、34）、**通过但限定范围 3 项**（AC-17/22/30：结论只到「隔离」，真实上游/OSS 子项属后端历史依据）、
**部分 4 项**（AC-24/29/32/33）、**未验证 5 项**（AC-23/25/26/27/28）。22 + 3 + 4 + 5 = 34。
「部分/未验证」集中在**后端采集、真实上游、真实 OSS、持续运行与容量**，不在本次纯前端迁移的调用范围内；
其依据是未变更的后端基线（**H**），不冒充本期重跑，也不据此宣称全项目重新验收。

## 7. 已裁决的已知限制与免责

| 项 | 内容 | 来源 |
| --- | --- | --- |
| R1 视觉与输入框字号 | 输入框保持库默认字号（`--el-font-size-base`，实测 14px）；16px 虽能规避 iOS 聚焦放大，但会改变签收过的视觉，用户裁决以视觉一致为先 | 用户 2026-10-25（本票） |
| R2 设备复验 | 最终候选相对被测候选 `32c9510` 只有这条字号回退，用户裁决不重跑真机 A 节 | 用户 2026-10-25（本票） |
| R3 可审计性 | 两台设备的 UA 原文与逐项截图/录屏不补采，按「口头确认 + 现有记录」接受 | 用户 2026-10-25（本票） |
| F-15-02 iOS 聚焦放大 | iOS Safari 对 font-size 小于 16px 的输入框聚焦时放大整页且失焦不还原；本轮**不修**。要恢复修复需把输入框字号改成 16px 并重新签收视觉（会重新产生 43 像素差异） | 本条与 R1 同源 |
| 图片预览库能力限制 | 放大后拖动不限制边界、未达边界仍可拖动、切图无跟手过渡、双击以图片中心为准 | 规格第 36 条 |
| R4 后端测试稳定性 | 两例异步时序用例在全量跑下偶发 3 秒超时（第三次全量 809 passed）；既有缺陷，已立票 [36](../../backend-integration/issues/36-backend-timing-test-flake.md) | 本票 §5 |
| R5 部署与真实来源 | 目标机/云/TLS/公网、真实上游采集、真实 OSS 上传、持续运行与 2 核 2GB 容量均未验证；实际部署须另行授权 | 票据 16 §8、本票 |

## 8. 交付、回退与维护收益（与最终产物一致）

### 8.1 交付与回退

与[静态交付说明](../../../docs/deployment/static-delivery.md)第 3 节一致，本票在最终候选上重跑 `pnpm test:delivery`（§5）：
构建进 `releases/<时间>-<提交>`、同一文件系统内 `symlink + rename` 原子切换、切换/回退前把不冲突旧哈希补给相邻版本、
入口 `no-cache` + ETag（内容变化时条件请求返回 200）、`/assets/` 内容哈希长期 `immutable`、缺失资源 404 `no-store` 且不回退 SPA、
只切前端（SQLite 与 collector 不被替换或重启）。回退演练保留了新旧两版全部入口引用资源，六路由导航无 `/assets/` 4xx。
`deploy/nginx.conf` 与 `nginx-locations.conf` 的规则由 `pnpm test:nginx-parity` 静态校验。

### 8.2 已删除的 React 栈与重复实现（本票复核）

| 核对项 | 结果 |
| --- | --- |
| `frontend/package.json` 依赖 | 无 `react`、`react-dom`、`react-router*`、`@testing-library/react` |
| 仓库内 `.tsx` / React 专用入口 | 无（`find . -name '*.tsx'` 为空）；根目录不再有 `src/`、`tests/`、`public/`、`index.html`、`vite.config.*` |
| `frontend/pnpm-lock.yaml` | 仅剩 `react-is@17.0.2`，是 dev 侧 `pretty-format`（`@testing-library/dom` 链路）的传递依赖，无 React 运行时或构建期依赖 |
| 保留的纯 TS/业务逻辑 | `src/data/`（契约与生产 Adapter）、`src/app/`（访问身份、快照、预览历史、定位、窄屏判定）、`src/dynamics|manage/` 的确定性规则（详见 [12 §4](12-vue-only-release-candidate.md)） |
| 已替换的通用组件 | `el-button`/`el-input`/`el-form`/`el-form-item`/`el-radio-group`/`el-alert`/`el-tag`/`el-collapse`/`el-pagination`/`el-image`/`el-image-viewer` |

维护收益（可核对的清单）：自研图片栅格/预览引擎/表单与状态面板被库组件替代，React Router 的内部 `location.key`/`USR` 适配改为
应用自有命名空间元数据 + Vue Router，35 个 RTL 测试与 10+ 个 React e2e spec 由 Vue 页面对等测试承担（现为 254 个单测用例，
以及 173 条通过 + 10 条跳过（触摸环境）的浏览器用例）。不承诺删行比例或性能指标。

### 8.3 构建资源变化（迁移前 React → 最终候选 Vue）

| 指标 | 迁移前 React（[12 §6](12-vue-only-release-candidate.md) 记录的父提交构建） | 最终候选 Vue（本票实测） |
| --- | --- | --- |
| 入口 HTML | 450 B，`<div id="root">` | 455 B，`<div id="app">` |
| 入口 JS | `index-CIUuNu7I.js` 327.81 kB（gzip 101.18 kB） | `index-C-E5912O.js` 229.99 kB（gzip 84.60 kB） |
| 入口 CSS | `index-C96Z5hHL.css` 24.68 kB（gzip 5.26 kB） | `index-DDIJRK8V.css` 70.76 kB（gzip 10.29 kB，含 Element Plus 按需样式与主题；另有 10 个路由级 CSS chunk） |
| 资源文件数 | 2 个 JS/CSS + 演示图片 | 28 个内容哈希资源（17 JS + 11 CSS，含 6 个路由 chunk）+ 2 个静态 SVG |
| `dist/` 字节数 | 560 KB（含 24 张演示图） | 467253 B；`dist-mock/` 466899 B |
| 入口 gzip 合计 | ~106.4 kB | ~94.9 kB（JS+CSS），路由按需加载 |

Element Plus 未整包引入（`src/main.ts` 按组件路径引样式、SFC 具名导入由 Rollup 摇树）；入口 CSS 增大是库样式与主题的代价，
已在 12 §6 记录，本票未做性能或加载时间承诺。

## 9. 本票的改动与边界

| 文件 | 改动 | 受影响验证 |
| --- | --- | --- |
| `frontend/src/theme/theme.css` | 删掉输入框 16px 覆盖，恢复库默认 14px（R1 裁决）；同步更新「库内部类例外」注释 | **产品变更 → 全部重跑**（§5：check、e2e、production、manage、dist、nginx-parity、delivery、视觉重拍） |
| `frontend/tests/e2e/manage.spec.ts` | 四视口字号断言由「≥16px」改为「等于库默认字号 `--el-font-size-base`」，锁住签收视觉又不在库升级时误报 | `pnpm test:e2e` 重跑通过 |
| `frontend/scripts/visual-diff-report.mjs`、`frontend/scripts/lib/visual-baseline.mjs` | 新增：逐张比较候选截图与签收黄金图，记录 sha256 是否相同、AE@判定 fuzz、不含容差的 AE 权重和，生成 `diff-report.json`；路径、容差、magick 调用与条件校验抽到共享 lib，与 `visual:compare` 同源 | 本票用 `pnpm visual:diff-report` 生成 §4 的报告 |
| `frontend/tests/e2e-visual/support.ts` | 新增 `VISUAL_OUT_DIR` 覆盖截图输出目录（默认仍是 `evidence/visual-14`）。加这一处开关是因为 `visual:baseline` 原本只能写签收目录，重跑会覆盖 14 的记录 | `pnpm check`、`visual:baseline` 重跑通过 |
| `frontend/tests/e2e-visual/capture.spec.ts` | `sourceStatus` 过滤改为按实际输出目录名排除；`sourceNote` 不再写死票据 14 的路径 | 同上 |
| `docs/design/frontend-migration.md` | 库内部类覆盖由两类收回一类，记录输入框字号裁决 | — |
| `.scratch/frontend-vue-migration/evidence/visual-17/` | 新增：`conditions.json`、`diff-report.json`（63 张全 0 差异） | — |
| `.scratch/frontend-vue-migration/evidence/17-logs/` | 新增：本票全部命令输出 | — |
| `.scratch/frontend-vue-migration/evidence/15-real-device-acceptance.md` | 追加 §13 更正记录（自比更正 + F-15-02 回退 + 候选差异） | — |
| `frontend/README.md`、`docs/README.md` | 「已交付」表补 17 行（15 行上一轮已补）、修正 15 行里 F-15-02 的表述；索引补 17 证据与结论 | — |

边界：未改后端、部署脚本与数据库；未执行部署、未操作当前运行实例、未重启 collector；未访问真实 B 站上游或 OSS；
未修改父规格状态，也未把任何历史验收改写成新版通过。R1/R2/R3 是用户裁决，本文件按裁决记录，不代为放宽其他要求。

## 10. 复核命令

```bash
# 仓库根
source ~/.nvm/nvm.sh && nvm use          # Node 24.21.0
uv sync --locked && uv run --no-sync pytest backend/tests -q

# 前端
cd frontend
pnpm install --frozen-lockfile
NO_PROXY=127.0.0.1,localhost pnpm check
NO_PROXY=127.0.0.1,localhost pnpm check:dist            # 产物标识见 §2.2
NO_PROXY=127.0.0.1,localhost pnpm test:e2e
NO_PROXY=127.0.0.1,localhost pnpm test:e2e:production
NO_PROXY=127.0.0.1,localhost pnpm test:e2e:manage
pnpm test:nginx-parity
DELIVERY_PORT=4273 \
  NGINX_BIN=/tmp/nginx-16/nginx-1.28.0/objs/nginx \
  NGINX_MIME_TYPES=/tmp/nginx-16/nginx-1.28.0/conf/mime.types \
  pnpm test:delivery

# 视觉：在最终候选上重拍并与签收黄金图比较（不覆盖 14 的签收目录）
VISUAL_OUT_DIR=$PWD/../.scratch/frontend-vue-migration/evidence/visual-17 pnpm visual:baseline
pnpm visual:compare --current $PWD/../.scratch/frontend-vue-migration/evidence/visual-17
pnpm visual:diff-report --current $PWD/../.scratch/frontend-vue-migration/evidence/visual-17

# 产物身份核对（应输出 6b520cd7…、index-C-E5912O.js 与 index-DDIJRK8V.css）
sha256sum dist/index.html && grep -o '/assets/[^"]*' dist/index.html
```
