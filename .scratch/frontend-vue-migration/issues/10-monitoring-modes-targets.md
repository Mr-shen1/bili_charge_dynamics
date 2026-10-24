# 10: 维护互斥监控模式及指定目标

**What to build:** 用户可为各 UP 配置近期 N 或指定动态模式，添加/移除目标及删除配置，同时保持已有归档不受影响。

**Blocked by:** 09 — 按 UID 新增 UP、查看管理卡片并启停监控。

**Status:** done

**差异处理硬规则：既有文档、测试或历史验收描述与现有代码逻辑冲突时，一律以现有代码逻辑为准。** 按已记录源码基线核实后修正文档和测试，不为迎合旧描述恢复、删除或改变现有业务行为；后续发现同类差异也按此处理，无需重复请求裁决。明确授权的 Vue、Element Plus、新视觉及图片放宽属于目标变化，不被旧实现反向覆盖。代码基线不等于已经运行验收通过。

- [x] 两种模式互斥，默认 N=10，校验及默认语义保持基线；各 UP 配置和草稿独立，不因换库改变后端协议。
- [x] 指定动态 ID 使用字符串校验；添加目标通过现有接口校验作者归属，明确区分正确、不符与未知，移除目标反馈正确。
- [x] 切换 UP 或模式时隔离草稿、请求身份与反馈；失败保留输入，重复写入被阻止，忽略取消的旧成功/失败/完成回调不改写新页面。
- [x] 停用、移除目标及删除配置均不删除已归档内容；通过实际 API 与隔离 SQLite 验证归档仍可读取，不要求另一阅读票先实现页面。
- [x] 使用 Element Plus 通用控件，键盘、焦点、四视口布局和主要触控区域可用；错误提示不泄露秘密或原始内部错误。
- [x] 随本票交付页面操作、Adapter 映射和隔离集成测试，不以 mock 成功替代持久化/归档保留证据；不发起真实上游或 OSS 请求。

## 依据与执行边界

依据本工作规格、行为基线差异及已确认迁移方案。不新增采集模式、频率策略、手动初始化或业务 API，不把管理删除改为内容删除，不执行部署或操作当前运行实例。

## Comments

已完成并留证：[10 监控模式与指定目标证据](../evidence/10-monitoring-modes-targets.md)。
`pnpm check`（typecheck + `pnpm test` 218 + e2e 项目覆盖守卫）、`pnpm test:e2e`（169 passed / 10 skipped）、
`pnpm test:e2e:production`（3 passed / 3 skipped）、`pnpm test:e2e:manage`（6 passed，实际 API + 隔离 SQLite）
与 `pnpm check:dist` 均通过。

实现要点：`managementApi` 补齐 `deleteMonitor`/`listTargets`/`addTarget`/`deleteTarget` 与
`TARGET_AUTHOR_MISMATCH`/`TARGET_UNVERIFIED` 固定文案；`UpCard.vue` 维护模式与近期 N 草稿（保存才提交完整配置，
启停仍用已保存配置），`ManageTargets.vue` 随草稿模式挂载，因而切换模式即隔离输入与反馈；
`UpVisit.vue` 以 `${uid}:${monitor !== null}` 作卡片 key，换 UP 或配置增删都重建草稿。
归档保留用 `backend/tests/live_app.py` 扩展的虚构上游（动态页/detail/空根评论）在隔离 SQLite 上验证，
`POST /api/sync/initial` 只由测试显式调用。

两轴审查后收敛：目标反馈区分添加/移除动作（移除失败不再把添加按钮改成“重试添加”）、
切换模式卸载目标区时 abort 在途写入（与基线 `AbortSignal.any` 一致）、补 `reportReadError`、
`UpCard` 写入与标签逻辑收敛为单一 `write()`/`labelFor()`、删除请求合并为 `deleteRequest()`、
共享版式抽到 `manage.css`。详见证据第 4.1 节。

范围外：检查、发现、窗口与同步状态（11）。真实上游、iPhone Safari、新版视觉签收与 Nginx 交付分别留待后续票据；
本票不以自动化结果冒充。
