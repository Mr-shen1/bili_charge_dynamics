# 31: 可复现双进程与 Nginx 交付

**What to build:** 维护者可按说明构建并在隔离环境运行单 API、单采集、SQLite 和 Nginx 静态前端，深链接与 API/资源错误隔离有实际验证。

**Parent:** [12](12-delivery-acceptance.md)

**Blocked by:** [30](30-integrated-archive-lifecycle.md)

**Status:** ready-for-human

## 依据与交付边界

- [规格](../spec.md)：故事 59–61、64–67；I1、I7、I12；T1–T3 与部署验证。
- [SRS](../../../docs/product/SRS.md)：FR-02、DR-03、DR-05、NFR-04、NFR-05；AC-13、AC-17–AC-19、AC-32、AC-33 的交付部分。
- 遵守[共同交付要求](../implementation-plan.md#所有执行子票的共同交付要求)。沿用已有 deploy/backend 文档和配置，补完整双进程运行/迁移/停止/重启方法；不自动采购或部署到真实云环境。
- 本票需要实际 Nginx 或可复现隔离 Nginx 装配，不可用 Vite preview 替代；环境无法运行时记录阻塞/未验证，不能仅写配置后勾选通过。

## 核验标准

- [x] 真实服务、迁移、采集、生产前端、独立 mock 和测试随版本交付；Python 仅 uv、Node 仅 nvm、前端仅 pnpm，依赖核对并固定，干净环境能按说明复现。不依赖 ignored 脚本/截图或真实秘密。
- [x] 实际启动一个 FastAPI API 进程和一个独立采集进程共享 SQLite；API 无定时器/多 worker，采集检查/同步分离，无 Redis/Celery、常驻 Node、SSR 或新增服务承诺。
- [x] 隔离 fixture 运行验证配置写读、检查/同步、模拟上传和重开恢复，实际 SQLite 两进程协调可用；暂停来源/上传时 API 仍可读，生产浏览不隐式采集，业务图公开 URL 直取。
- [x] 实际 Nginx 验证 `/`、`/ups/:upId`、`/dynamics/:dynamicId`、`/manage` 直接打开/刷新及未知页面；API 成功/错误、缺失静态资源均不回退入口 HTML，正常产物使用生产 Adapter。
- [x] 入口重新验证、哈希资源可长期缓存，构建更新引用新资源；独立 mock/故障装配可跑且不混入生产 UI/产物，记录端口、环境变量、路径及故障定位方法但不写真实凭据。
- [x] 用虚构秘密扫描产物/HTTP/UI/日志/诊断；明确无鉴权管理/API、公开图外链、无备份/容量治理风险，不宣称隐藏入口有保护、不强制 2 核 2GB 或保证容量。

## 测试与完成证据

提供构建、迁移、双进程和 Nginx 命令、版本/环境、HTTP 状态及缓存验证记录；明确隔离部署不等于云部署。#32 汇入自动化/部署证据，#33/#34 在维护者提供环境和授权后独立实测。

## Comments

### 2026-10-16 实现与隔离验收

- 已交付双进程 fixture、6 项真实进程 HTTP/SQLite 专项、生产 Nginx 四类页面/刷新/API/资源错误/缓存/更新回归及完整启停迁移说明。修正 API 不可达时 Nginx 默认 error 日志泄露 query 的问题，先 red 后 green；关闭原始请求日志并记录诊断取舍。
- `pnpm typecheck` 通过；`pnpm test --maxWorkers=2` 268 passed；后端全量 669 passed（3 个既有 SDK 弃用警告）；开发浏览器 104 passed/10 skipped、manage 7、archive 38、mock preview 96/10 skipped；实际 Nginx 历史正常浏览器 106 passed，另生产部署、生产更新及秘密扫描均通过。干净临时副本重新锁定安装并构建，生产 dist 字节一致。
- 命令、版本、HTTP/缓存观察及首轮环境问题见 [#31 验收](../acceptance-31.md)与[部署专项证据](../evidence/deployment-31.md)；可复用说明见 [交付运行说明](../../../docs/deployment/README.md)。仅用虚构秘密，不依赖真实上游/OSS/ignored 文件。
- Standards/Spec 两个 `review` 代理已并行审查及复核：硬性规范违规 0、确认规格缺陷 0；已按判断性去重建议提取共享发布更新验证，补版本化干净副本命令，完整 Nginx 重跑通过。其余字面量/参数建议的保留理由见验收记录。
- 所勾选范围仅为本票的隔离交付，不代替 #30 人工签收、#32 总台账、#33 真机或 #34 真实上游/OSS/持续调度/资源验收。无鉴权/公开图/无备份容量治理风险保持。状态转 `ready-for-human` 等待维护者核验，不宣称整个产品已验收。
