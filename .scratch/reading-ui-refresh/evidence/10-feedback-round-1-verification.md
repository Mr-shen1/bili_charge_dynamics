# 票 10 首轮反馈整改：组合验证台账

## 版本与口径

- 整改前产品候选：`88b692f`。用户三项反馈见 [首轮反馈与原图](10-feedback-round-1.md)。
- 12（头像裁切/管理对齐）与 13（完整会话/居中/标记）合入后组合候选：`093b40d0b8aca9219f410fa3884fd441288d03ee`，后续 `16f5c35` 只同步文档状态。
- 此组合的 `frontend` 树为 `ddb63535013298fc3c565ababf9429dcf0a9241a`，`backend` 树为 `b33aa187c2055a901cd568908679ff448c71f37e`；主 e2e 运行期间 HEAD 文档前移，但产品树未变。
- 独立审查收尾另有修复，最终候选与收尾复验在下面单列；不将组合候选测试冒充后续候选所有套件再次执行。
- **只代表实现、自动化与隔离准备，不代表人工视觉或真机签收。** 黄金图未更新，未合 `main`、未部署、未调用真实 B 站/飞书/OSS。

## 12、13 原始实现与合入复验

| 边界 | 来源与准确结果 |
| --- | --- |
| 布局精确复现 | [12 证据](12-avatar-and-management-alignment.md)：头像选中轮廓裁 4px、表单标签高 6px、输入外框 44px 与按钮 32/36px 不同高；逐项先红后绿，最终 86 ok / 0 红，浏览器写请求为 0 |
| 会话单次整段/居中/标记 | [13 证据](13-complete-conversation-and-entry-focus.md)：整段响应无 page、条数完整；无分页控件；入口唯一“刚才查看”；末条/短会话居中 ≤2px；来源恢复与会话历史位置/留白恢复 |
| 前端门槛 | 两票实现者与 merger 在组合 `093b40d` 执行 `pnpm check`：32 文件 / 350 单测、类型检查、项目守卫通过；`pnpm check:dist` 双构建与产物隔离通过 |
| 真实 HTTP 定向 | merger 在 `093b40d` 重跑 `test_conversation_reading.py`、`test_reading_ui_integration.py`、`test_reply_sort.py`：38 passed |
| 真实隔离 API/SQLite 浏览器 | merger 在 `093b40d` 重跑 location：17 passed，API 4178 / Web 4325；不是传输替身或真实上游 |
| 布局浏览器 | merger 在 `093b40d` 跑 visual 的 `layout.spec.ts`：4 passed；360/390/768/1280 加 700px 边界与 390px 输入状态检查，未跑 capture/黄金图更新 |
| 管理语义 | 12 实现者：manage 9 passed；受影响 list/detail/manage 主 e2e 64 passed，临时端口 4340/4341/4342，不复用旧验收产物 |
| 主 e2e 组合补证 | 独立验证者在 `093b40d` / 同产品树 `16f5c35` 跑：235 passed / 18 skipped / 0 failed；临时配置 4330/4331/4332，18 skip 为原有项目/触摸/宽窄屏互斥守卫，未改写为 pass |
| production / fault | 同组合产品树：3 passed / 3 skipped（装配互斥），0 failed |
| delivery 三进程隔离链 | 同组合产品树：6 passed，实际测试 API/collector/notifier、独立临时 SQLite 与本机飞书接收替身；不是授权真实通知发送 |
| 后端全量 | 13 实现者在本票后端改动后执行全量：1256 passed。12、组合候选及文档提交后端树均同为 `b33aa187…`，据此沿用，不宣称 merger 又重跑全量 |

## 双轴独立审查

固定比较：`git diff 7ebf5aa...093b40d`；需求以更新后的设计/规格与票 12、13 为准，不按旧“会话分页/起点首屏”要求审查。

- **规范轴**：确认 1 项注释编码损坏，0 项硬规范违反；另有 8 项非阻断判断（重复交互清理/死选项与字段/类型与测试辅助重复/注释措辞/状态同步/未显示内容的访问保存/历史提交正文）。
- **规格轴**：确认 2 项文档缺陷（其中编码损坏与规范轴为同一项；另一项是前端 README 漏改旧分页描述），功能确认缺陷 0；另有未读完访问保存与文档状态判断、状态样式可选建议。
- 唯一审查整改代理逐项处置，新增真实红绿覆盖验证首屏未显示就离开的边界；准确处置见[审查整改证据](10-feedback-round-1-review.md)。历史提交不因非阻断文风判断而重写。
- [独立收尾复核](10-feedback-round-1/final-spec-review.md)：代码/测试/需求新引入确认缺陷 0；仅指出证据误称“全仓替换字符 0”的文档问题，已在 `16dc3b6` 改为实际检查范围 `frontend/src` 与 `frontend/tests`，不删除故障原文或修范围外脚本。

## 收尾候选与复验

代码候选：`344235a88b418dc07b644aef578487d0693e65d9`。文档 tip `16dc3b6` 及后续本记录提交只改证据/需求状态，产品树相同：

- `frontend`：`79f45fd947bbe46b7ed8d63f4f4a45dabcb9160e`。
- `backend`：`b33aa187c2055a901cd568908679ff448c71f37e`（与 13 已跑后端全量 1256 passed 的树一致）。

merger 在该最终产品树重跑并通过：

| 命令 | 结果 |
| --- | --- |
| `pnpm check` | 类型检查、32 文件 / 351 单测、e2e 项目声明守卫通过 |
| `pnpm check:dist` | 生产/mock 双构建与隔离通过 |
| `pnpm test:e2e:location` | 真实隔离 API/SQLite 17 passed |
| 主 e2e（临时配置 4330/4331/4332，显式图片端口环境） | 235 passed / 18 skipped / 0 failed / 0 flaky |

production 3 passed / 3 skipped、delivery 6 passed、布局 4 passed 与 manage 9 passed 的来源仍为前述组合阶段，不宣称收尾又重跑。最后一轮新增的变更主要为阅读定位公共 helper 与未显示内容的访问保存；主 e2e 和 location 已在最终树完整重跑。后端树不变，沿用 1256 passed 来源。

最终生产入口 `index.html` SHA-256：`1a558c6ca9eb0cece45161b3d4773875eb4b92b75ca42348af95bd64f52c9e54`；mock 入口：`b336d12eb9df969189b4dcee6540ea2494f5df4ee5f1afeede1011bbdad7bee8`。隔离预览使用只读复制的冻结副本；[本轮预览记录](10-device-preview-round-1/preparation.md)单列地址、运行目录与待签收截图。

12、13 与 review 的工作树及 `wt/` 分支已逐票正常清理；仅主工作树保留。票 10 继续 `ready-for-human`，正式视觉与真机仍待用户复验。

## 环境偏差与未验证

1. 主 e2e 临时配置初次只改端口常量，未同步 `IMAGE_SERVER_PORT`，导致启动探活超时；补临时 webServer 环境变量后整套通过，未改产品或放宽断言。
2. 浏览器补证期间旧验收四端口退出；主线程随后确认 4318/4337/4180/4339 均未监听，原因未归因，不能说仍在提供旧页面。现有 8000/4273 仍监听且未操作。新候选验收服务需重新启动并登记运行目录。
3. Linux 无头 Chromium 的排版/触控盒证据不代表真实 Chrome 使用体验或 iPhone Safari 聚焦/失焦、缩放、键盘遮挡通过。设备型号/系统/浏览器版本尚待用户反馈。
4. 原 63 张 `final-2-screens/` 为旧候选历史，不能视为新布局/会话签收图；本轮不更新黄金图。
5. 新前端会话整段读取要求同版后端；旧显式 page HTTP 兼容路径保留，原回复详情分页不变。

## 临时日志来源

- `/tmp/t12-merge/{check.log,check-dist.log,layout.log}`，`/tmp/reading-ui-refresh-12-merge-report.md`。
- `/tmp/merge-13-logs/{pnpm-check.log,backend-targeted.log,e2e-location.log}`，`/tmp/merge-13-report.md`。
- `/tmp/reading-ui-refresh-round1-verification/{report.md,e2e-main.log,e2e-production.log,e2e-delivery.log,head-drift.txt}`。
- 双轴原报告在 [反馈附件目录](10-feedback-round-1/) 有原文副本；独立收尾复核见同目录 `final-spec-review.md`。
- 最终 merger：`/tmp/reading-ui-refresh-round1-final-merge/{report.md,check.log,check-dist.log,e2e-location.log,e2e-main.log,build-ready.json}`。
- 本文件与各票证据保留结论，临时日志不当作跨机器永久路径。
