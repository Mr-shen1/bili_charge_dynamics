# 最终独立复核与交付状态

## 版本与范围

- 集成分支：`spec/reading-ui-refresh`。
- 被最终复核的集成 tip：`52cad4681c16aabad030f3bc6171b92593cbcd22`；实现候选：`88b692f`。两者 `frontend` / `backend` 零差异；此记录落盘只增加文档。
- 固定审查基点：`0c77c720112cdf151f6e812bc2512e7985ca5660`。外部并行推进的 `main=e7c73f2` 部署升级流程未混入、未修改。
- [初次双轴审查与处置](final-independent-review.md)、[二次复核残留闭环](final-review-residual-closeout.md)、[仅消息整理的同树映射](commit-message-rewrite.json)共同保留完整过程，不把初次报告中未实际收口的内容追改为当时已通过。

## Standards 最终针对性独立复核

**确认缺陷 0。** 两个独立 `review` 子代理只读核验代码与证据，不重新启动全量测试。

- S3 fallback：`CommentItem.vue:123/156` 已为 `var(--brand-soft)`；`#e6f6f7` 仅剩 token 声明。证据如实记“首次只落 5 处、二次补齐”，未回填历史。
- 字号/行高：徽标 12/20 引用 badge token；状态/计数 13(20) 引用 meta token，计算值不变。剩余硬写与登记表相符。
- 已登记例外的实际角色成立：非生产装配/夹具、设计单列的管理输入、命中盒行高、比例行高及预览图形层；不把图形尺寸和第三方输入泛化为普通正文字号。
- `replyReadState()` 已删除，无残留引用。`read: state.value` 安全：`shallowRef` 全路径整对象替换，字段 readonly，无原地字段赋值；已有 `ReplySection` 同类先例。
- 未新增“scope 只能顶层目录”或“map 必须粗体模板”等无原文依据的规则。

保留的措辞判断（非缺陷，基线值未改）：ReadOnlyLike 注释称“24px 图标”实际为 16px SVG＋24px 命中盒；ReplyPager 注释称对齐相邻按钮行盒，实际由 flex 居中；图片占位是亮底，深色遮罩仅适用其余预览层。它们不影响计算值或本次行为，不升级为阻断项。

## Spec 最终针对性独立复核

**0 项新引入缺陷。**

- `‹ 评论详情` 的 `aria-label="评论详情，返回动态详情"` 包含可见标签；两条返回路径都落动态详情，目标解释正确。新增用例精确核验角色名、可见文本与标签包含关系，未降低要求。
- 快照直接持有读取结果不会被后续请求原地污染：读取状态全为整对象替换，字段 readonly；`reason: undefined` 没有按键存在性消费。
- meta 13/20 与 badge 12/20 符合正式设计；普通文字替换后计算值不变，两处 24px 布局行高已登记为既有例外。
- 本轮源码增量仅 CSS 等价替换、无障碍名与快照引用，后端零差异；最终候选与集成 tip 只差文档/证据/截图。
- 先前独立复核已确认异常环的起点、条数和不完整标记与 time/hot/page/locate/conversation 一致；真实 HTTP＋临时 SQLite 回归已通过。

## 验证来源与结果

| 边界 | 结果与来源 |
| --- | --- |
| 集成后前端门槛 | merger 在 `52cad46` 重跑 `pnpm check`：32 文件 / 348 单测、类型检查与 e2e 项目覆盖守卫通过；`pnpm check:dist` 双构建和产物隔离通过 |
| 最终代码候选浏览器 | 实现者在 `88b692f` 执行：主 e2e 235 passed / 18 skipped；production 3、manage 9、location 16、delivery 6 passed。location/delivery 为实际隔离 API／SQLite 及三进程链，不是真实外部服务 |
| 后端 | 本轮定向 38 passed；`backend` 子树仍为 `c25b57d95fafa7cd8d3f20e33975c2dabf4f5372`，与已执行全量 1256 passed 的父候选相同，因此沿用该后端全量证据，不声称本轮又重跑了 11 分钟全量 |
| 截图 | [final-2-screens](final-2-screens/) 63 张，360/390/768/1280，`sourceCommit=88b692f`、`sourceStatus=[]`；与首次 final-screens 对照 56 张字节相同，7 张仅抗锯齿级，0 张可见变化；黄金图未更新 |
| 隔离静态交付 | 首次整改候选执行本机 Nginx 三阶段通过；最后一轮未改交付脚本/路由、未重跑三阶段。不把先前隔离交付冒充最终候选已全量重验，更不代表生产部署 |
| 视觉、设备与外部环境 | 用户正式视觉签收、iPhone Safari 聚焦/缩放、真实设备、真实飞书/上游/OSS、目标机部署与持续运行仍未验证 |

原型签收、mock、HTTP 替身、实际隔离 API、静态交付与人工设备证据互不替代；自动化中的 skip 未改写为 pass。

## 票据与清理

- 01–09 与审查整改 11 均 `resolved`；10 保持 `ready-for-human`，规格整体保持 `claimed`，不能宣称全部验收完成。
- [10 人工验收票](../issues/10-visual-and-real-device-acceptance.md)已指向最终代码候选及截图，黄金图只能在人工确认后按既有流程更新。
- 实现工作树与 `wt/` 分支已逐票删除；最终只剩主工作树，工作区在本记录落盘前干净。
- 未 push、未开 PR、未合 main、未部署，未修改外部并行工作。后续集成 main 时需单独处理其部署分支推进，不暗中混入本轮审查范围。
