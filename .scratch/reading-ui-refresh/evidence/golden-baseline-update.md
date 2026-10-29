# 已验收阅读改版：黄金图更新

## 授权与范围

用户已明确“已经验收完成了”，另行授权合入 `main` 并 push，随后以“更”确认更新黄金图。本次只更新测试基准和验收证据，不部署、不恢复已按用户要求关闭的 4318 预览。

- 最后业务代码候选：`b1dec5c`；截图来源提交：`445465ca0dfd08d8fbb9c81af5fe9ee2f646b807`（之后仅验收收口文档变化，截图时 `sourceStatus=[]`）。
- 本轮截图：[accepted-screens/](accepted-screens/)，63 张，宽度 360/390/768/1280，含 `conditions.json`。历史 `09-screens`、`final-screens`、`final-2-screens` 与预览截图均保留，不追改。
- 黄金图：`frontend/tests/visual-baseline/`，基准版本 **2**。原版本 1、候选 `89d0b49` 的签收记录保存在 `manifest.json` 的 `signedOffHistory`，本次理由进入 `updates`。
- 新签收范围按用户整体界面验收映射到 63 张受控截图，不宣称用户逐张查看了截图。

## 已执行验证

| 阶段 | 结果 |
| --- | --- |
| `VISUAL_OUT_DIR=…/accepted-screens pnpm visual:baseline` | 正式构建通过；视觉截图与布局套件 8 passed，生成 63 张 |
| 对旧基准 `visual:compare` | 63/63 存在改版预期差异；未调整阈值、容差或业务实现以抹平差异 |
| `visual:golden -- --current …/accepted-screens --reason …` | 黄金图更新为版本 2，逐张与本轮截图字节相同 |
| 对新基准 `visual:compare` | 63/63 通过 |
| 独立 `/tmp/reading-ui-refresh-recheck` 重新拍摄 | 视觉套件再次 8 passed；63 张对新黄金图再次比较，63/63 通过 |

比较口径不变：AE、fuzz 1%、最大差异比例 0.02%。浏览器、字体、时区、语言、设备比例等条件与原基准一致；sourceCommit 与构建资源指纹如实更新。详细条件在 `accepted-screens/conditions.json` 与黄金图 manifest。

## 边界

- 仅生成图片与基准元数据，未改业务代码、CSS 或比较脚本。
- 4178/4325 仅供两轮临时隔离视觉环境，结束后已释放；4318 未启动，其他既有服务未操作。
- 真机版本与 Safari 专项未单独留证的限制继续保留，不因黄金图更新补造设备结果。
- Git 提交整理、合并与 push 按后续授权流程处理；黄金图更新不表示部署。

执行代理原报告：`/tmp/reading-ui-refresh-golden-update-report.md`（临时日志路径；永久结论及条件保存在本记录、截图和 manifest）。
