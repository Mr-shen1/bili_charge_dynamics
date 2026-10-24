# 11: 查看真实检查、发现、窗口与同步状态

**What to build:** 用户可在单 UP 管理中重读并理解当前检查、发现、窗口和同步结果，不将 HTTP 成功、检查无变化或部分完成误认为全部同步成功。

**Blocked by:** 10 — 维护互斥监控模式及指定目标。

**Status:** done

**差异处理硬规则：既有文档、测试或历史验收描述与现有代码逻辑冲突时，一律以现有代码逻辑为准。** 按已记录源码基线核实后修正文档和测试，不为迎合旧描述恢复、删除或改变现有业务行为；后续发现同类差异也按此处理，无需重复请求裁决。明确授权的 Vue、Element Plus、新视觉及图片放宽属于目标变化，不被旧实现反向覆盖。代码基线不等于已经运行验收通过。

- [x] 按当前代码语义呈现检查、发现、窗口、成功同步及分项错误，保留观察/执行状态和各自时间含义，不把不同状态合并成笼统成功。
- [x] 模式切换后的呈现与当前配置对应；读取失败、过期数据和迟到成功/失败/完成回调不能冒充当前最新状态。
- [x] 现有管理重读和局部错误处理可用；草稿与读取反馈相互隔离，不因状态读取覆盖未提交输入。
- [x] 普通归档浏览不触发采集或上传；管理重读保持既有读取边界，不新增诊断面板或要求展示全部后端 metadata。
- [x] 页面行为与契约测试覆盖检查无变化、发现失败、窗口生命周期、部分同步和分项失败；使用实际 API 与隔离 SQLite 验证代表状态，不触发真实上游采集或 OSS 上传。
- [x] 统一控件、状态文案、键盘焦点及四视口可用性，并保留管理 401 固定提示与错误脱敏。

## 依据与执行边界

依据本工作规格、行为基线差异及已确认迁移方案。保留当前单 API/单 collector、调度及归档生命周期；前端只消费现有状态，不改后端业务或部署。

## Comments

已完成并留证：[11 检查与发现状态证据](../evidence/11-monitoring-status-reading.md)。
`pnpm check`（typecheck + `pnpm test` 244 + e2e 项目覆盖守卫）、`pnpm test:e2e`（171 passed / 10 skipped）、
`pnpm test:e2e:production`（3 passed / 3 skipped）、`pnpm test:e2e:manage`（7 passed，实际 API + 隔离 SQLite）、
`pnpm check:dist` 与 `uv run --no-sync pytest backend/tests -q`（809 passed）均通过。

实现要点：`managementApi` 补齐 `readDiscovery`/`listChecks`（含 `discoveryState.ts` 的一致性校验），
单 UP 页新增 `CheckStatusPanel`（逐目标折叠、观察/执行/分项/计数/八类时间）与 `DiscoveryStatusPanel`
（保存模式、本轮候选、历史可信结果、已发布窗口）；状态只在点击按钮后读取，`useStatusRead` 统一处理取消、
卸载与迟到回调；面板随已保存配置签名重建，因此换模式后旧状态不会冒充当前配置。
隔离 SQLite 上通过 `backend/tests/live_app.py` 新增的**仅测试用**采集驱动端点产生真实状态：发现发布窗口、
检查无变化、根评论失败的分项失败、来源恢复后的整轮成功、上游失败后保留旧窗口；页面读取前后 checks/archive
记录一致，证明读取不触发采集。生产应用不注册任何 `/api/test/` 路由，由 `backend/tests/test_live_app.py` 守卫。

两轴审查后收敛：共享版式移入 `manage.css`、评论进度与错误文案改为逐字节复用并加入副本守卫、
新增 `getJson`/`readLabel`/`panelCheckTimes` 去掉同形复制、状态文案按检查/发现/列表拆分、
UP 级时间在读取后改用刚读到的记录、夹具补 `reply` 失败开关把部分同步与整轮成功搬进真实 API 用例。
详见证据第 4.1 节。

范围外：真实上游、iPhone Safari、新版视觉签收与 Nginx 交付分别留待后续票据；本票不以自动化结果冒充。
