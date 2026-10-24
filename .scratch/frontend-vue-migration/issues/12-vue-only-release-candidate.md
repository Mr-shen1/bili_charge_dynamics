# 12: 形成仅含 Vue 的完整候选产物

**What to build:** 完整阅读和管理流程由 Vue 单一前端承载，移除废弃 React 栈和重复实现，交付可追溯且可继续统一验收的候选产物。

**Blocked by:** 06 — 宽屏预览回复并按实时页码阅读；07 — 窄屏通过 UP 回复预览进入独立楼中楼；08 — 查看一级评论图片且不串组、不丢讨论进度；11 — 查看真实检查、发现、窗口与同步状态。

**Status:** done

**差异处理硬规则：既有文档、测试或历史验收描述与现有代码逻辑冲突时，一律以现有代码逻辑为准。** 按已记录源码基线核实后修正文档和测试，不为迎合旧描述恢复、删除或改变现有业务行为；后续发现同类差异也按此处理，无需重复请求裁决。明确授权的 Vue、Element Plus、新视觉及图片放宽属于目标变化，不被旧实现反向覆盖。代码基线不等于已经运行验收通过。

- [x] 六条有效页面路由及完整阅读/管理流程均由 Vue 承载，不保留生产 React/Vue 双入口或要求逐页生产灰度。
- [x] 清理废弃 React、React Router、专用测试适配、旧组件、重复图片实现、无用图标及样式；保留仍有用途的纯 TypeScript、数据契约及历史证据。
- [x] Vue 模板及 TypeScript 类型检查、各行为票交付的测试、有效确定性/契约测试和生产构建通过，命令可复现；不能通过删掉行为保护制造通过。
- [x] 旧 E2E 的累计回复、窄屏内联、回复目标及旧像素断言按固定代码基线和目标变化修正，不用旧测试回退功能。
- [x] 更新测试/构建/交付工具中的旧框架耦合，不再依赖 React Router 内部 history 形状或废弃入口路径；保留导航、资源和可访问行为断言。
- [x] 默认真实 API，独立 mock/fault 装配不混入正常产物，不含故障入口、虚构动态、采集/上传凭据或直调上游逻辑；错误脱敏和代理保护保持。
- [x] 记录候选源码、锁定依赖、构建标识、入口/chunks 及资源体积变化，检查异常全量依赖；不虚构性能预算或删行比例。
- [x] 列明已替换通用组件、已删除自维护实现及保留的业务逻辑，说明具体维护收益；更新实际改变的启动、构建、测试说明。
- [x] 候选版本进入 13–16 的独立验收，不以本票的构建成功宣称视觉、实际设备、静态交付或统一上线已通过。

## 依据与执行边界

依据本工作规格、行为基线差异及已确认迁移方案。清理必须在功能行为票及其伴随测试完成后进行，不能误删有效契约或历史证据。Node 仅用 nvm，依赖/脚本仅用 pnpm，隔离 Python 环境仅用 uv。不修改数据库、重启 collector 或执行部署。

## Comments

已完成并留证：[12 仅 Vue 候选产物证据](../evidence/12-vue-only-release-candidate.md)。
`pnpm typecheck`、`pnpm check`（244 passed + e2e 项目覆盖守卫）、`pnpm test:e2e`（171 passed / 10 skipped）、
`pnpm test:e2e:production`（3 passed / 3 skipped）、`pnpm test:e2e:manage`（7 passed，实际 API + 隔离 SQLite）、
`pnpm check:dist`（两次构建 + 产物隔离）与 `pnpm test:nginx-parity` 通过；后端代码未改动，未重跑 pytest。

实现要点：`frontend/` 成为唯一前端应用，删除根目录 React 源码/测试/配置与 React Router、RTL 依赖（共 181 个文件），
保留 `src/data` 与快照/分页/文本等纯 TS 作为唯一实现并移除 `check:data-parity` 副本守卫；交付脚本迁到
`frontend/scripts/` 并按 Vue 语义改造（mock/fault 构建不再覆盖生产 `dist`、入口注入点为 `src/main.ts`、
预览锚点改为应用自有触发 id、历史元数据改用 `biliChargeDynamicsEntry`/`biliChargeDynamicsPreview`）；
`playwright.config.ts` 新增 `E2E_TARGET=nginx` 与 Vue 版 `static-delivery.spec.ts`，覆盖守卫支持 `@projects nginx:`；
Nginx 配置删除 mock 专用 `/demo-images/`、`/creator-avatar…` 并新增 `/images/` 资源规则；`deploy-frontend.sh`
改为构建/上传 `frontend/dist/`；文档同步根 README、`frontend/README.md`、SRS/FSR/HLD、静态交付与本机部署说明。

未验证（不标通过）：本机无 Nginx，`pnpm test:delivery`、`pnpm test:http` 与真实 Nginx 下的 `static-delivery.spec.ts`
未执行；Linux Chrome 人工检查、iPhone Safari、新版视觉签收与真实上游按票据 13–16 执行。
测试基础设施仅把 Vitest `testTimeout` 放宽到 15s（两个长链路导航用例在并行满载时会超默认 5s），断言未修改。
