# 31: 可复现双进程与 Nginx 交付

**What to build:** 维护者可按说明构建并在隔离环境运行单 API、单采集、SQLite 和 Nginx 静态前端，深链接与 API/资源错误隔离有实际验证。

**Parent:** [12](12-delivery-acceptance.md)

**Blocked by:** [30](30-integrated-archive-lifecycle.md)

**Status:** ready-for-agent

## 依据与交付边界

- [规格](../spec.md)：故事 59–61、64–67；I1、I7、I12；T1–T3 与部署验证。
- [SRS](../../../docs/product/SRS.md)：FR-02、DR-03、DR-05、NFR-04、NFR-05；AC-13、AC-17–AC-19、AC-32、AC-33 的交付部分。
- 遵守[共同交付要求](../implementation-plan.md#所有执行子票的共同交付要求)。沿用已有 deploy/backend 文档和配置，补完整双进程运行/迁移/停止/重启方法；不自动采购或部署到真实云环境。
- 本票需要实际 Nginx 或可复现隔离 Nginx 装配，不可用 Vite preview 替代；环境无法运行时记录阻塞/未验证，不能仅写配置后勾选通过。

## 核验标准

- [ ] 真实服务、迁移、采集、生产前端、独立 mock 和测试随版本交付；Python 仅 uv、Node 仅 nvm、前端仅 pnpm，依赖核对并固定，干净环境能按说明复现。不依赖 ignored 脚本/截图或真实秘密。
- [ ] 实际启动一个 FastAPI API 进程和一个独立采集进程共享 SQLite；API 无定时器/多 worker，采集检查/同步分离，无 Redis/Celery、常驻 Node、SSR 或新增服务承诺。
- [ ] 隔离 fixture 运行验证配置写读、检查/同步、模拟上传和重开恢复，实际 SQLite 两进程协调可用；暂停来源/上传时 API 仍可读，生产浏览不隐式采集，业务图公开 URL 直取。
- [ ] 实际 Nginx 验证 `/`、`/ups/:upId`、`/dynamics/:dynamicId`、`/manage` 直接打开/刷新及未知页面；API 成功/错误、缺失静态资源均不回退入口 HTML，正常产物使用生产 Adapter。
- [ ] 入口重新验证、哈希资源可长期缓存，构建更新引用新资源；独立 mock/故障装配可跑且不混入生产 UI/产物，记录端口、环境变量、路径及故障定位方法但不写真实凭据。
- [ ] 用虚构秘密扫描产物/HTTP/UI/日志/诊断；明确无鉴权管理/API、公开图外链、无备份/容量治理风险，不宣称隐藏入口有保护、不强制 2 核 2GB 或保证容量。

## 测试与完成证据

提供构建、迁移、双进程和 Nginx 命令、版本/环境、HTTP 状态及缓存验证记录；明确隔离部署不等于云部署。#32 汇入自动化/部署证据，#33/#34 在维护者提供环境和授权后独立实测。

## Comments
