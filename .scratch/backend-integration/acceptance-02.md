# 02：指定动态首次归档与阅读验收

分支：`backend-integration`；实施起点：`eedd86dcff726e8834f064ab6090e2be86f397ad`。

## 范围与测试入口

本票 T1/T2/T3 沿用父规格已确认的公开 seams：生产 ArchiveReader/页面、管理与归档 HTTP、显式首次初始化入口，真实临时 SQLite（含关闭重开），仅替换上游传输。不触发真实 B站请求、不读取 Cookie、不执行/导入参考脚本。

- 指定字符串 ID 校验实际作者，正确才关联；重复目标也重新校验；不符或未知不建立关联、不提示本次校验成功。
- 初始化只选启用的 specified 集合；不回填作者其他动态。停止/删除配置或目标不删除身份与归档。
- 正文成功空、受限、失败独立；失败保留旧成功内容。发布时间与页面可信编辑时间独立，编辑分钟精度不伪造秒。
- HTML 只安全 JSON 解析 `__INITIAL_STATE__.detail.modules`，按 AUTHOR 模块定位；未知/错误不冒充未编辑。来源计数、评论定位、有序媒体来源与尺寸持久保存，未上传不把来源业务图回退给浏览器。
- 生产读取只请求归档 API，不请求采集；默认装配与显式 mock/fault 回归分开。

## 协议依据

无敏感参考结构与有限页面样本边界见 [PROTOCOL_EVIDENCE.md](../../backend/PROTOCOL_EVIDENCE.md)；作者、媒体尺寸公共 Git 固定快照依据见 [dynamic-protocol-fields.md](../../docs/dynamic-protocol-fields.md)。fixture 全部虚构，不能作为实际上游权限或长期可用性证据。接口细化见 [archive-api.md](../../docs/archive-api.md)。

## 实施证据

- 后端逐片 Red → Green 记录见 [backend/acceptance-02.md](../../backend/acceptance-02.md)。
- T1/T2/T3 穿透浏览器测试先因缺少 fixture API 工厂失败；增加实际工厂后能完成目标校验，并在正文同步尚未实现时失败（返回全部 failed）。此为观察到的 Red，不将骨架能力当完成。
- 根据公开模块结构补充标题独立安全展示：`pnpm test tests/archive-app.test.tsx` Red 1 failed/7 passed（标题未映射），增加可选标题 metadata 映射后 Green 8/8；不把标题混为正文段落，不执行标签。
- `pnpm typecheck` 多次通过；`pnpm test tests/production-assembly.test.ts tests/archive-reader.test.ts --maxWorkers=2`：7/7。
- `pnpm test:e2e:manage`：2/2，复用实际 API 进程/临时库启动工具后仍通过。
- `pnpm test:e2e:archive`：1/1。实际页面添加目标并分别观察正确/不符/未知；四目标同步得到正常全文、成功空、受限、失败。受限不计正文成功。经生产归档 API/Adapter 读列表和详情，恶意标签只作文本，图片来源不作为已上传图展示；断源后重开、删除目标/配置后重开仍可读旧全文。404、成功空与网络失败分别验证；受限/失败不显示“暂无内容”；进程日志/UI不泄漏虚构秘密。
- `pnpm build` 与 `pnpm build --mode fault` 通过；当前两者资源 hash 一致，fault 构建不混开发装配。

### 全量回归

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm test --maxWorkers=2` | 最终 16 文件，137/137 |
| `pnpm test:e2e` | 显式 mock/fault：102 通过，10 项仅 Nginx 条件跳过 |
| `pnpm test:e2e:preview` | 显式 mock 构建：94 通过，10 项仅 Nginx 条件跳过 |
| `pnpm test:e2e:manage` | 2/2 通过，实际 Uvicorn/SQLite 重开后验证管理读取 |
| `pnpm test:e2e:archive` | 1/1 通过，生产 Adapter + fixture 上游 + 实际临时 SQLite 穿透 |
| `uv run pytest backend/tests -q` | 125 通过；`compileall` 通过 |
| `pnpm build` | 通过；preview 回归后重新构建生产 dist |

浏览器命令显式设置 `NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost`。首次将 manage 与 archive e2e 并行运行时两者都占用 4176，archive 收到 `EADDRINUSE`；串行重跑后通过，未终止任何其他服务。环境代理也可能影响本地浏览器测试，命令均绕过本地代理。

## Standards

最终 Standards 复审对基线 `eedd86dc` 至 staged diff 未发现硬违规。首轮发现的重复目标绕过作者复核、失败/受限误显示成功空提示及共享 ID、文案、证据说明问题均已修正；最终复审发现的测试模块耦合和重复 `record` guard 也已分别抽至 `backend/tests/*_support.py` 与 `src/data/guards.ts`。`sync.py` 页面读取失败记 `edit_status=error` 属允许状态，不覆盖旧可信编辑值，UI 明确为读取/解析失败。管理与归档 E2E 共用端口 4176，已记录须串行执行；本环境复跑通过。

## Spec

最终 Spec 复审无阻断项。T1/T2/T3 与本票核验标准一致；额外修正了可选 TITLE 模块结构异常会误使有效 CONTENT 正文失败的问题，并以 HTTP/SQLite 回归覆盖。父规格 I3 的旧归档 UP 导航身份集合、I8 的单 UP scope 读取未在本票实现；本票仅提供 all-scope 列表与详情。`backend/README.md` 明确单 UP scope 未实现，I3 导航身份集合亦在 backend acceptance 与本记录列为范围限制，留待后续票。固定 fixture 证明解析和安全边界，不证明当前真实上游兼容；未访问真实上游、Cookie 或 ignored 脚本。

## 未验证与边界

- 01 已有实现与自动化验收记录，但票据仍等待人工复核；本次不代替其人工闭环。
- 不含近期发现、评论/回复采集、媒体上传、周期检查、完整聚合状态或多 UP 卡片改版；父规格 I3 的旧归档 UP 导航身份集合与 I8 的单 UP scope 读取也未交付，后续票处理。待处理媒体/评论不是完成。
- 无真实上游/Cookie/OSS、自然多次编辑、长期运行、容量或部署验证。
- 无本票 Linux 品牌 Chrome / iPhone Safari 真机验收；Chromium 自动化不能代替真机。
- 本环境没有 Nginx binary，暂未重跑实际 Nginx 静态交付；脚本装配调整不当作部署证据。
