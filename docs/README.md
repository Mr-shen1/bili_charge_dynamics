# 文档导航

按用途查找文档；启动命令见[项目 README](../README.md)和[后端 README](../backend/README.md)。需求、接口现状与验收证据各有职责，不能互相代替。

## 需求与设计

| 文档 | 何时阅读 |
| --- | --- |
| [SRS：软件需求规格](product/SRS.md) | 确认产品范围、FR/DR/NFR 和验收条件；Vue 迁移的既有行为冲突按已确认代码基线同步 |
| [FSR：可行性研究](product/FSR.md) | 了解方案取舍、资源假设、风险与可行性边界 |
| [HLD：高层设计](design/HLD.md) | 理解模块职责、读取/采集边界、状态及部署设计 |
| [UI 视觉规范](design/ui-reference.md) | Vue 新版视觉基准与功能裁剪；旧参考图、像素量测和 #35 记录保留为历史 |
| [前端重构：Vue 3 + Element Plus](design/frontend-migration.md) | 已确认的目标技术栈、UI/图片替换边界、分阶段实施与统一上线门槛；已交付范围与命令以 [前端 README](../frontend/README.md) 为单一来源（票据 12 已形成仅含 Vue 的候选产物，13 已完成协议与跨流程回归，其余为 14–17 验收） |

## 后端接口与协议证据

接口文档描述对应阶段已交付的契约，不代表 SRS 的全部功能已实现。证据文档须连同来源、样本范围和未验证事项一起阅读。

| 文档 | 职责 |
| --- | --- |
| [监控管理接口](backend/api/management-api.md) | UID、配置、模式、错误与持久化契约 |
| [固定节拍采集与检查状态](backend/api/collector-api.md) | 独立采集进程、固定节拍、观察/执行状态与重启边界 |
| [近期目标发现与窗口](backend/api/discovery-api.md) | 原识别规则、跨页凑 N、可信发布/失败保留、模式互斥、窗口生命周期与只读管理 HTTP |
| [指定目标与首次归档接口](backend/api/archive-api.md) | 目标校验、一次初始化、归档读取及信息边界 |
| [归档 API 客户端](backend/api/archive-api-client.md) | 前端生产 Adapter 的读取与映射约定 |
| [后端可行性样本](backend/evidence/backend-feasibility.md) | 有限真实上游请求的观察与限制 |
| [动态协议字段](backend/evidence/dynamic-protocol-fields.md) | 固定第三方源码快照的字段核验，区别于实时上游证据 |
| [本地来源协议证据](backend/evidence/source-protocol-evidence.md) | 本地参考脚本与 HTML 样本的证据边界 |

## 运行与交付

- [项目 README](../README.md)：前端、API 启动与测试入口。
- [后端 README](../backend/README.md)：后端运行、配置及初始化说明。
- [交付运行说明](deployment/static-delivery.md)：当前双进程/SQLite/Nginx 的构建、迁移、启停与隔离验证；历史静态基线单列，部署回归不等于云部署或全项目验收。
- [阿里云 ECS 运维手册](deployment/aliyun-ecs.md)：目标机的系统准备、SSH 硬化、systemd/Nginx 安装、备份、升级回滚与备案切换；尚未在目标机执行，不代替验收。
- [本机 live-34 前端重新部署](deployment/local-live-frontend.md)：本机隔离实例（18444／18445）的前端构建、产物轮转、unit 重启、验证与回滚；只发前端，不代替生产或云部署。
- [本机 live-34 后端重新部署](deployment/local-live-backend.md)：同一实例的 API＋collector 停启、依赖同步、迁移与只读验证、前滚式回滚边界；不触发上游采集。

## 任务、计划与验收记录

`.scratch/<feature>/` 保存对应工作的规格、票据和验收证据，编号只在该工作内有效。现有票据路径保持稳定。

| 工作 | 规格与执行 | 验收证据 |
| --- | --- | --- |
| Vue 前端重构 | [实施规格](../.scratch/frontend-vue-migration/spec.md)（`ready-for-agent`） · [代码基线与文档差异](../.scratch/frontend-vue-migration/baseline-differences.md) · [票据目录](../.scratch/frontend-vue-migration/issues/) · [前端应用与已交付范围](../frontend/README.md#已交付) | [01 原生图片预览与历史](../.scratch/frontend-vue-migration/evidence/01-native-image-preview.md)（Linux Chromium 通过；含窄屏滑动/双指/双击手势，iPhone 13 Pro / iOS 16.4 真机通过） · [02 归档列表与 scope](../.scratch/frontend-vue-migration/evidence/02-archive-scope-browsing.md)（Linux Chromium 通过；真实 API/设备/视觉未验证） · [03 详情与阅读恢复](../.scratch/frontend-vue-migration/evidence/03-detail-reading-restoration.md)（Linux Chromium 通过；真实 API/设备/视觉未验证） · [04 动态图片阅读](../.scratch/frontend-vue-migration/evidence/04-dynamic-image-reading.md)（Linux Chromium 桌面与 Pixel 7 通过；真实 API/设备/视觉未验证） · [05 一级评论阅读](../.scratch/frontend-vue-migration/evidence/05-root-comment-reading.md)（Linux Chromium 桌面与 Pixel 7 通过；真实 API/设备/视觉未验证） · [06 宽屏回复](../.scratch/frontend-vue-migration/evidence/06-wide-screen-live-replies.md)（Linux Chromium 桌面通过；真实 API/设备/视觉未验证） · [07 窄屏楼中楼](../.scratch/frontend-vue-migration/evidence/07-compact-comment-thread.md)（Linux Chromium Pixel 7 通过；真实 API/设备/视觉未验证） · [08 评论图片阅读](../.scratch/frontend-vue-migration/evidence/08-comment-image-reading.md)（Linux Chromium 桌面与 Pixel 7 通过；真实 API/设备/视觉未验证） · [09 管理列表与启停](../.scratch/frontend-vue-migration/evidence/09-up-management-basics.md)（Linux Chromium 桌面与 Pixel 7 通过；实际 API + 隔离 SQLite 通过；真实上游/设备/视觉未验证） · [10 监控模式与指定目标](../.scratch/frontend-vue-migration/evidence/10-monitoring-modes-targets.md)（Linux Chromium 桌面与 Pixel 7 通过；实际 API + 隔离 SQLite 验证归档保留；真实上游/设备/视觉未验证） · [11 检查与发现状态](../.scratch/frontend-vue-migration/evidence/11-monitoring-status-reading.md)（Linux Chromium 桌面与 Pixel 7 通过；实际 API + 隔离 SQLite 验证检查无变化与发现失败保留旧窗口；真实上游/设备/视觉未验证） · [12 仅 Vue 候选产物](../.scratch/frontend-vue-migration/evidence/12-vue-only-release-candidate.md)（类型检查/单测/三类 e2e/构建与隔离通过；Nginx 交付脚本本机无 nginx 未执行；真机/视觉未验证） · [13 协议与跨流程回归](../.scratch/frontend-vue-migration/evidence/13-integrated-protocol-regression.md)（三类证据分开；单测/mock/生产 Adapter 替身/实际 API＋隔离 SQLite/构建与后端基线通过；视觉、真机、Nginx 与真实上游未验证） |
| 当前后端集成 | [规格](../.scratch/backend-integration/spec.md) · [执行计划与子票索引](../.scratch/backend-integration/implementation-plan.md) · [票据目录](../.scratch/backend-integration/issues/) | [01 管理](../.scratch/backend-integration/acceptance-01.md) · [02 首次归档](../.scratch/backend-integration/acceptance-02.md) · [02 后端专项证据](../.scratch/backend-integration/evidence/backend-acceptance-02.md) · [13 scope 读取](../.scratch/backend-integration/acceptance-13.md) · [13 后端专项证据](../.scratch/backend-integration/evidence/backend-acceptance-13.md) · [14 导航与卡片](../.scratch/backend-integration/acceptance-14.md) · [15 根评论归档](../.scratch/backend-integration/acceptance-15.md) · [16 评论区阅读](../.scratch/backend-integration/acceptance-16.md) · [17 回复归档](../.scratch/backend-integration/acceptance-17.md) · [18 回复阅读](../.scratch/backend-integration/acceptance-18.md) · [19 动态媒体归档](../.scratch/backend-integration/acceptance-19.md) · [20 动态图阅读](../.scratch/backend-integration/acceptance-20.md) · [21 评论媒体归档](../.scratch/backend-integration/acceptance-21.md) · [22 评论图阅读](../.scratch/backend-integration/acceptance-22.md) · [23 固定节拍检查](../.scratch/backend-integration/acceptance-23.md) · [24 可信编辑与版本正文](../.scratch/backend-integration/acceptance-24.md) · [25 来源计数驱动根回复](../.scratch/backend-integration/acceptance-25.md) · [26 评论计数与同步状态](../.scratch/backend-integration/acceptance-26.md) · [27 近期目标发现](../.scratch/backend-integration/acceptance-27.md) · [28 近期窗口生命周期](../.scratch/backend-integration/acceptance-28.md) · [29 在途生命周期](../.scratch/backend-integration/acceptance-29.md) · [30 全链路与聚合状态](../.scratch/backend-integration/acceptance-30.md) · [30 后端专项证据](../.scratch/backend-integration/evidence/backend-lifecycle-30.md) · [30 浏览器专项证据](../.scratch/backend-integration/evidence/frontend-lifecycle-30.md) · [31 双进程与 Nginx](../.scratch/backend-integration/acceptance-31.md) · [31 部署专项证据](../.scratch/backend-integration/evidence/deployment-31.md) · [32 本期自动化与 AC-01–AC-34 台账](../.scratch/backend-integration/acceptance-32.md) · [33 正式设备验收（进行中）](../.scratch/backend-integration/acceptance-33.md) · [35 视觉改版实现与预览](../.scratch/backend-integration/acceptance-35.md)（[首轮原图基准](../.scratch/backend-integration/visual-35-baseline.md) · [当前B站取材与新基准](../.scratch/backend-integration/visual-35-live-reference.md)） |
| 历史模拟阅读器 | [规格](../.scratch/dynamics-viewer/spec.md) · [票据目录](../.scratch/dynamics-viewer/issues/) | [09 最终集成记录](../.scratch/dynamics-viewer/acceptance-09.md)，各阶段记录位于[同一目录](../.scratch/dynamics-viewer/) |

评论链路专项：参考脚本的[完整静态对照](../.scratch/backend-integration/evidence/comment-parity-comparison.md)与[Requests 实施记录](../.scratch/backend-integration/evidence/comment-requests-implementation.md)。实施记录只说明代码改动与未验证范围，不是已解决真实来源问题的验收结论。

项目级验收记录与后端专项证据是不同层次，不合并为一份“通过”结论。历史模拟阅读器与当前后端的证据分开，自动化、真机和持续运行证据互不替代；尚未取得的证据仍标为未验证，目录或票据存在不表示已完成。

## 文档放置规则

- `docs/product/`：产品需求与可行性；`docs/design/`：架构和界面设计。
- `docs/backend/api/`：后端/客户端接口契约；`docs/backend/evidence/`：协议来源与可行性证据。
- `docs/deployment/`：可复用的交付运行说明；一次执行的结果放对应 `.scratch/<feature>/`，专项附件放其 `evidence/`。
- 根目录和模块 `README.md` 保留为就近入口（前端命令与结构见 [frontend/README.md](../frontend/README.md)）；与素材或代码紧密相关的说明留在原目录。
- `docs/agents/` 保留[工单约定](agents/issue-tracker.md)、[分诊标签](agents/triage-labels.md)和[领域文档约定](agents/domain.md)；代理入口仍为根 [AGENTS.md](../AGENTS.md)，技能和代理配置保持工具要求的位置。
- 新增文档按职责归位并补本页入口；移动文档时同步修复相对链接、图片和正文中的路径引用。保留已有需求和历史证据内容，不为整理目录重写验收结果。
- `docs/assets/ui-reference/` 是 ignored 本地参考素材，当前整理不移动或强制纳入版本；跨机器使用 UI 文字规范，确需图片时另行提供。
