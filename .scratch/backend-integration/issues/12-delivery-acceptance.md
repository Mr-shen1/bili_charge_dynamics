# 12: 双进程交付与整体验收

**What to build:** 维护者得到可复现构建/运行的单 API、单采集、SQLite 与静态前端交付；通过 Nginx 打开四类页面及真实归档、多 UP 管理和媒体，并取得逐项可复核验收记录，明确区分自动化通过与尚未授权/实测的上游、持续运行及真机项目。

**Blocked by:** [31: 双进程与 Nginx](31-reproducible-deployment.md)、[32: 自动化与台账](32-automated-acceptance.md)、[33: 正式浏览器验收](33-browser-device-acceptance.md)、[34: 上游与持续运行](34-live-source-runtime-evidence.md)

**Status:** needs-triage

**票据角色:** 汇总（等待维护者根据子票证据核验收口，不直接派工实施）

## 执行拆分（汇总票，不直接派工）

原业务前置 [11](11-monitoring-lifecycle.md) 由 #29/#30 交付，以下四票区分代理可执行工作与必须维护者参与的实测。统一规则见[执行计划](../implementation-plan.md)，本票分诊标签不代表人工验收已完成。

- [31](31-reproducible-deployment.md)：可复现单 API/单采集/SQLite、实际隔离 Nginx、缓存和安全运行说明；依赖 #30。
- [32](32-automated-acceptance.md)：本期自动化/穿透回归和 AC-01–AC-34 证据台账；依赖 #31，不等待人工票才能整理台账。
- [33](33-browser-device-acceptance.md)：Linux Chrome 与 iPhone Safari 正式环境操作证据；依赖 #31，`ready-for-human`。
- [34](34-live-source-runtime-evidence.md)：授权上游、真实媒体、持续调度和资源实测；依赖 #31，`ready-for-human`。

四票共同覆盖下列原清单。#32 完成但 #33/#34 必需项未验证时，本汇总票和整个功能都不能宣称完整验收；环境缺失须明确记录，不把写完步骤当成通过。

## 依据

- [父规格](../spec.md)：故事 1–68；I1–I12；T1–T3、穿透与证据核验。
- [SRS](../../../docs/product/SRS.md)：FR-01–FR-20、DR-01–DR-05、NFR-01–NFR-05；AC-01–AC-34 全量回归，交付主责 AC-16、AC-19、AC-20、AC-32、AC-33、AC-34。
- [HLD](../../../docs/design/HLD.md)：第 10–15 节；[FSR](../../../docs/product/FSR.md)、[有限上游证据](../../../docs/backend/evidence/backend-feasibility.md)、[UI 文字规范](../../../docs/design/ui-reference.md)、[历史静态交付](../../../docs/deployment/static-delivery.md)。

## 核验标准

- [ ] 交付真实服务、数据库迁移、采集、生产前端、独立 mock、测试及可复现构建/运行说明；Python 环境/依赖只用 uv，Node 只用 nvm，前端依赖/脚本只用 pnpm，实施核对并固定依赖版本而非在票中预选。
- [ ] 实际运行一个 FastAPI API 进程、一个独立 Python 采集进程与 SQLite；API 无重复定时器/多 worker，采集检查与同步分离，无 Redis/Celery/微服务、常驻 Node 或 SSR 承诺，不强制 2 核 2GB 同机。
- [ ] 在隔离环境复现双进程配置写读、fixture 检查/同步、重开恢复及媒体模拟上传，观察实际 SQLite 读写协调和归档 HTTP；生产浏览不隐式采集，OSS 直取公开 URL，无应用图片代理或 B站业务图回退。
- [ ] 经实际 Nginx 或可复现隔离 Nginx 装配验证 `/`、`/ups/:upId`、`/dynamics/:dynamicId`、`/manage` 深链接/刷新与未知页面；API 成功/错误及缺失静态资源不回退入口 HTML，不能只用 Vite preview 冒充部署。
- [ ] 入口重新验证、带哈希资源长期缓存，构建更新后入口引用新资源；API、SPA 和静态资源错误隔离正确，正常产物可用，不把本地/隔离验证写成云部署已经完成。
- [ ] 正常生产装配只用真实 API Adapter，独立 mock 与可控故障装配分别可跑，正常 UI 无故障控制面板；契约替身替换传输而不绕过生产映射，保留少量实际 API/浏览器穿透。
- [ ] 按下方责任映射逐项回归全部 FR/DR/NFR 与 AC-01–AC-34，记录本期通过/失败/未验证及原因、环境和可复核证据；不得继承旧同号 AC 的通过结果或把前序票/规格文字当作实现证明。
- [ ] 全流程覆盖“全部/单 UP → 卡片或气泡 → 详情 → 动态图/评论图 → 排序 → 回复 → 返回恢复”，加 UID/模式/目标/启停/删除/窗口、编辑图更新、评论变化图更新及错误/重启/新旧版本交错；原身份、读取、导航和焦点测试不丢。
- [ ] 核验浅青背景、白卡、青蓝选中、粉色作者及评论回复层级；四宽度 360/390/768/1280px 无页面横向溢出，仅选择条内部可横滑，约 44px 触控目标、键盘焦点、详情全文/绝对发布时间及分钟编辑精度正确，无查看详情/转发/独立评论页/真实写回。
- [ ] Linux Chrome 与 iPhone Safari 正式兼容分别记录版本、设备和方法；移动 Chromium 模拟、桌面自动化或模拟器不作为 iPhone 真机通过。维护者未提供真机及授权时记录未验证，必需项未验证不能宣称完整验收。
- [ ] 持续固定 15 秒调度、实际资源、来源计数映射、不同页面编辑时间及自然多次编辑逐项保留待验证边界；实际起始近期约 10 条、指定 1 UP 的 2 条不是容量硬限，13 GET/一次成功不证明稳定。无授权环境时只提供维护者执行步骤和采样记录要求，不自动采购、部署、读凭据或请求真实上游。
- [ ] 用虚构秘密验证仓库交付物、产物、UI/API/日志/诊断不泄漏；凭据只在服务端仓库外、无凭据 UI。公开无鉴权管理/API、公开 OSS 外链、无首期备份/容量治理风险明确，不宣称隐藏入口能保护，不自加鉴权前置或容灾/容量/中间件能力。

## 全量验收责任映射

下表仅划分前序实现责任，不表示完成；本票对所有项整体验证。AC-16 的正式真机、AC-19 的 Nginx 交付、AC-20 的全链路、AC-32 的交付风险说明、AC-33 的双进程运行、AC-34 的证据区分由本票主责，前序票同时负责其适用范围。

| 当前 SRS 验收 | 主要前序责任 |
| --- | --- |
| AC-01、AC-02、AC-05、AC-21、AC-31 | [03](03-multi-up-reading.md)；评论/回复身份及气泡由 [04](04-root-comments.md)、[05](05-replies.md) 接入 |
| AC-03、AC-04、AC-13、AC-15、AC-17、AC-18 | [02](02-target-initial-archive.md)、[03](03-multi-up-reading.md) 建立正文/读取/导航；[04](04-root-comments.md)、[05](05-replies.md)、[06](06-dynamic-images.md)、[07](07-comment-images.md)、[08](08-periodic-edit-sync.md) 扩展对应评论/媒体/时间范围 |
| AC-06、AC-07 | [04](04-root-comments.md) |
| AC-08 | [05](05-replies.md) |
| AC-09、AC-10、AC-11、AC-30 | [06](06-dynamic-images.md)、[07](07-comment-images.md)，[11](11-monitoring-lifecycle.md) 验证编辑/评论变化联动 |
| AC-12、AC-14 | [03](03-multi-up-reading.md)、[04](04-root-comments.md)、[05](05-replies.md)、[06](06-dynamic-images.md)、[07](07-comment-images.md) 各自阅读恢复/局部态 |
| AC-22 | [01](01-up-monitoring-management.md)、[02](02-target-initial-archive.md)、[08](08-periodic-edit-sync.md)、[11](11-monitoring-lifecycle.md) |
| AC-23 | [10](10-recent-window.md) |
| AC-24 | [02](02-target-initial-archive.md)、[04](04-root-comments.md)、[05](05-replies.md)、[09](09-comment-change-sync.md)、[10](10-recent-window.md) |
| AC-25、AC-26 | [08](08-periodic-edit-sync.md)，[02](02-target-initial-archive.md) 提供安全首次解析，[11](11-monitoring-lifecycle.md) 验证组合恢复 |
| AC-27 | [09](09-comment-change-sync.md) |
| AC-28 | [02](02-target-initial-archive.md)、[04](04-root-comments.md)、[05](05-replies.md)、[06](06-dynamic-images.md)、[07](07-comment-images.md)、[08](08-periodic-edit-sync.md)、[09](09-comment-change-sync.md) 各自分项；[11](11-monitoring-lifecycle.md) 整合 |
| AC-29 | [01](01-up-monitoring-management.md) 至 [10](10-recent-window.md) 各自数据保留，[11](11-monitoring-lifecycle.md) 验证全类型与在途生命周期 |

## 拆分后的执行责任

上表保留原 #01–#12 的范围追踪；实际派工使用下表及子票 `Blocked by`，不是再派一次父票。各行 AC 仅指相应子范围，不免除上表其他责任。

| 执行票 | 主要证据责任 |
| --- | --- |
| [13](13-scoped-archive-reading.md)、[14](14-scope-navigation-cards.md) | scope/排序/导航/卡片/恢复：AC-01–AC-05、AC-12–AC-18、AC-21、AC-29、AC-31 |
| [15](15-root-comment-archive.md)、[16](16-root-comment-reading.md) | 根评论协议/分页/排序及 UI：AC-01–AC-04、AC-06、AC-07、AC-12、AC-14、AC-15、AC-18、AC-24、AC-28、AC-31 |
| [17](17-reply-archive.md)、[18](18-reply-reading.md) | 回复归档/关系/展开/恢复：AC-01、AC-03、AC-04、AC-07、AC-08、AC-12、AC-14、AC-15、AC-18、AC-24、AC-28 |
| [19](19-dynamic-media-archive.md)、[20](20-dynamic-image-reading.md)、[21](21-comment-media-archive.md)、[22](22-comment-image-reading.md) | 两类媒体/独立失败/预览：AC-09–AC-12、AC-14–AC-18、AC-28–AC-30、AC-32 |
| [23](23-fixed-cadence-checks.md)、[24](24-versioned-edit-sync.md) | 固定节拍/编辑/版本恢复：AC-04、AC-22、AC-25、AC-26、AC-28、AC-33、AC-34 的受控证据 |
| [25](25-comment-count-sync.md)、[26](26-comment-sync-status.md) | 评论计数触发/状态：AC-04、AC-14、AC-22、AC-24、AC-25、AC-27–AC-29 |
| [27](27-recent-target-discovery.md)、[28](28-recent-window-lifecycle.md) | 原规则发现/窗口：AC-22–AC-25、AC-29、AC-33 |
| [29](29-inflight-monitoring-lifecycle.md)、[30](30-integrated-archive-lifecycle.md) | 在途生命周期/自动媒体联动/聚合：AC-13、AC-17、AC-20–AC-30、AC-32、AC-33 |
| [31](31-reproducible-deployment.md) | AC-19 Nginx/构建、AC-33 双进程、AC-32 风险及脱敏，兼顾 AC-13/17/18 |
| [32](32-automated-acceptance.md) | AC-01–AC-34 本期台账及可自动化项回归，AC-20 穿透和 AC-34 证据区分；人工证据由 #33/#34 分别回填 |
| [33](33-browser-device-acceptance.md) | AC-16 正式浏览器/真机主责，以及 AC-10–AC-13、AC-20、AC-31、AC-34 的设备证据 |
| [34](34-live-source-runtime-evidence.md) | AC-25–AC-28、AC-30、AC-32–AC-34 的授权上游/OSS/持续运行/资源证据 |

## 测试与证据边界

T1–T3 的自动化使用虚构/脱敏 HTML/JSON、受控时钟、模拟 OSS 和实际临时 SQLite，测试公开 HTTP、状态及用户行为，不读取真实 Cookie。业务全图保存但无全历史动态补扫；来源 count 与 synced 分开，受限/失败不归零覆盖，可信编辑检测仅 HTML 作者模块时间，不靠 pubts 或内容比对。

历史验收、13 GET、本期自动化、隔离 Nginx、云运行/资源及真机各有独立证据栏。所需云/账号/真机环境由维护者提供并另行授权步骤；本票不授权自动采购部署、持续采集或真实 OSS。ignored 原脚本/截图不是跨机器交付依赖，缺失时请提供脱敏参考，必要无敏感逻辑/fixtures 随实现版本化，不 force add；tracked UI 文字规范可用。未测项如实记录，不用模拟器、一次成功或写完说明代替验收。
