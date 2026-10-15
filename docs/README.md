# 文档导航

按用途查找文档；启动命令见[项目 README](../README.md)和[后端 README](../backend/README.md)。需求、接口现状与验收证据各有职责，不能互相代替。

## 需求与设计

| 文档 | 何时阅读 |
| --- | --- |
| [SRS：软件需求规格](product/SRS.md) | 确认产品范围、FR/DR/NFR 和验收条件；这是需求真值 |
| [FSR：可行性研究](product/FSR.md) | 了解方案取舍、资源假设、风险与可行性边界 |
| [HLD：高层设计](design/HLD.md) | 理解模块职责、读取/采集边界、状态及部署设计 |
| [UI 视觉规范](design/ui-reference.md) | 阅读两张参考图的一比一视觉基准、管理同风格规则、功能裁剪及 #35 实施入口 |

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
- [静态交付说明](deployment/static-delivery.md)：Nginx、构建、缓存与验证方法；保留历史静态交付范围，不据此宣称后端集成已通过。

## 任务、计划与验收记录

`.scratch/<feature>/` 保存对应工作的规格、票据和验收证据，编号只在该工作内有效。现有票据路径保持稳定。

| 工作 | 规格与执行 | 验收证据 |
| --- | --- | --- |
| 当前后端集成 | [规格](../.scratch/backend-integration/spec.md) · [执行计划与子票索引](../.scratch/backend-integration/implementation-plan.md) · [票据目录](../.scratch/backend-integration/issues/) | [01 管理](../.scratch/backend-integration/acceptance-01.md) · [02 首次归档](../.scratch/backend-integration/acceptance-02.md) · [02 后端专项证据](../.scratch/backend-integration/evidence/backend-acceptance-02.md) · [13 scope 读取](../.scratch/backend-integration/acceptance-13.md) · [13 后端专项证据](../.scratch/backend-integration/evidence/backend-acceptance-13.md) · [14 导航与卡片](../.scratch/backend-integration/acceptance-14.md) · [15 根评论归档](../.scratch/backend-integration/acceptance-15.md) · [16 评论区阅读](../.scratch/backend-integration/acceptance-16.md) · [17 回复归档](../.scratch/backend-integration/acceptance-17.md) · [18 回复阅读](../.scratch/backend-integration/acceptance-18.md) · [19 动态媒体归档](../.scratch/backend-integration/acceptance-19.md) · [20 动态图阅读](../.scratch/backend-integration/acceptance-20.md) · [21 评论媒体归档](../.scratch/backend-integration/acceptance-21.md) · [22 评论图阅读](../.scratch/backend-integration/acceptance-22.md) · [23 固定节拍检查](../.scratch/backend-integration/acceptance-23.md) · [24 可信编辑与版本正文](../.scratch/backend-integration/acceptance-24.md) · [25 来源计数驱动根回复](../.scratch/backend-integration/acceptance-25.md) · [26 评论计数与同步状态](../.scratch/backend-integration/acceptance-26.md) · [27 近期目标发现](../.scratch/backend-integration/acceptance-27.md) · [28 近期窗口生命周期](../.scratch/backend-integration/acceptance-28.md) · [29 在途生命周期](../.scratch/backend-integration/acceptance-29.md) · [35 视觉改版实现与预览](../.scratch/backend-integration/acceptance-35.md)（[首轮原图基准](../.scratch/backend-integration/visual-35-baseline.md) · [当前B站取材与新基准](../.scratch/backend-integration/visual-35-live-reference.md)） |
| 历史模拟阅读器 | [规格](../.scratch/dynamics-viewer/spec.md) · [票据目录](../.scratch/dynamics-viewer/issues/) | [09 最终集成记录](../.scratch/dynamics-viewer/acceptance-09.md)，各阶段记录位于[同一目录](../.scratch/dynamics-viewer/) |

项目级验收记录与后端专项证据是不同层次，不合并为一份“通过”结论。历史模拟阅读器与当前后端的证据分开，自动化、真机和持续运行证据互不替代；尚未取得的证据仍标为未验证，目录或票据存在不表示已完成。

## 文档放置规则

- `docs/product/`：产品需求与可行性；`docs/design/`：架构和界面设计。
- `docs/backend/api/`：后端/客户端接口契约；`docs/backend/evidence/`：协议来源与可行性证据。
- `docs/deployment/`：可复用的交付运行说明；一次执行的结果放对应 `.scratch/<feature>/`，专项附件放其 `evidence/`。
- 根目录和模块 `README.md` 保留为就近入口；与素材或代码紧密相关的说明留在原目录，如[演示素材说明](../public/demo-images/README.md)。
- `docs/agents/` 保留[工单约定](agents/issue-tracker.md)、[分诊标签](agents/triage-labels.md)和[领域文档约定](agents/domain.md)；代理入口仍为根 [AGENTS.md](../AGENTS.md)，技能和代理配置保持工具要求的位置。
- 新增文档按职责归位并补本页入口；移动文档时同步修复相对链接、图片和正文中的路径引用。保留已有需求和历史证据内容，不为整理目录重写验收结果。
- `docs/assets/ui-reference/` 是 ignored 本地参考素材，当前整理不移动或强制纳入版本；跨机器使用 UI 文字规范，确需图片时另行提供。
