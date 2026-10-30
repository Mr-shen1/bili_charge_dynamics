# 动态阅读与管理界面优化：执行计划

Status: resolved（01–13 已收口，最终代码候选 b1dec5c，用户明确确认 10 验收完成；黄金图已授权更新并独立复拍通过，Git 收尾已授权、未部署）

- 正式要求：[需求与设计](../../docs/design/reading-ui-refresh.md)。执行依据：[实施规格](spec.md)，包含44条用户故事、接口兼容与测试边界。
- 用户已确认第四版原型并要求直接生成规格/票据；以下是据此落盘的工程切片与依赖，未另行声称用户逐票签收。
- 本计划最初仅记录文档、原型和规划；目前 01–09、11 及追加整改 12、13 已实现并取证，审查收尾候选为 `344235a`。10 已由用户明确确认验收完成，具体设备版本与 Safari 专项未单独留证的限制保留；黄金图更新、提交整理与合 main/push 已获用户后续授权；部署及真实上游访问未授权。
- 事实依据：[仓库基线与测试边界](evidence/baseline-and-seams.md)；原型范围：[签收及检查记录](evidence/prototype-validation.md)。

## 1. 纵向票据与阻塞边

每票交付一条可演示/验证的用户路径，包含所需查询、契约、Adapter、页面和测试；未涉及的层无需人为制造改动。依赖表示交付行为的真实前提，不把代码修改冲突伪装为产品依赖。

| 票据 | 阻塞于 | 完成后可验证的行为 |
| --- | --- | --- |
| [01 阅读框架与排版](issues/01-reading-shell-and-typography.md) | 无 | 阅读去顶栏、文案统一、紧凑可滑UP条与统一阅读标尺 |
| [02 一级评论排序](issues/02-root-comment-sort-toggle.md) | 无 | 详情一级评论默认时间、单按钮切换，生产读取与定位语义一致 |
| [03 桌面卡片内评论](issues/03-desktop-inline-card-comments.md) | 02 | 多卡片可内联评论，各自排序、分页、展开和历史状态独立 |
| [04 详情标签与手机返回](issues/04-detail-tabs-and-mobile-navigation.md) | 03 | 桌面正文新标签且保留原列表；手机既有入口及来源返回正确 |
| [05 手机回复排序](issues/05-mobile-reply-sort.md)（**resolved**，见[证据](evidence/05-mobile-reply-sort.md)） | 02 | 回复全集合热度分页与时间序切换，旧cursor及通知定位兼容 |
| [06 查看对话](issues/06-conversation-reading.md)（**resolved**，见[证据](evidence/06-conversation-reading.md)） | 无 | 跨页入口资格、完整分支读取、缺失上下文及手机会话页闭环 |
| [07 会话导航与恢复](issues/07-conversation-navigation-restoration.md)（**resolved**，见[证据](evidence/07-conversation-navigation-restoration.md)） | 05、06 | 热度后续页进入会话再返回、直达/刷新与无来源路径正确 |
| [08 管理紧凑布局](issues/08-management-layout-and-controls.md) | 01 | 启停靠右、小按钮、大点击区域、手机输入字号及管理语义保持 |
| [09 组合验证](issues/09-integrated-verification.md)（**resolved**，见[证据](evidence/09-integrated-verification.md)） | 04、07、08 | 同一候选的实际隔离API、浏览器、四宽度、截图及静态交付证据 |
| [10 视觉与真实设备签收](issues/10-visual-and-real-device-acceptance.md) | 09 | 正式候选的用户视觉判断和实际Chrome/Safari证据，明确未验证范围 |
| [11 审查整改与最终候选复验](issues/11-independent-review-fixes.md)（**resolved**，见[证据](evidence/final-independent-review.md)与[二次复核残留闭环](evidence/final-review-residual-closeout.md)） | 09 | 双轴审查逐项处置、环起点与文案/无障碍修复、最终候选复验与仅消息的提交整理；二次复核重开的 4 项残留已闭环 |

01–08 已 `resolved`；09 已组合取证并 `resolved`；11 已完成审查整改、二次复核残留闭环与最终候选复验并 `resolved`（最终候选 `88b692f`，截图 `evidence/final-2-screens/`）；10 已按用户最终确认设为 `resolved`（见[人工记录](evidence/10-visual-and-device-acceptance.md)）；留证限制保留，黄金图已更新，提交整理与合 main/push 已获后续授权，部署未授权。初始可领取前沿曾是 **01、02、06**，其他票按阻塞边推进；完成06只说明内容链路可用，完整会话往返验收还依赖07。
- **09 已 `resolved`**：同一候选（组合回归 `b72d555`、截图 `703f931`）上补了后端组合契约与 location/manage/delivery 组合 e2e，并修复视觉比较脚本的 `magick`、三进程投递的通知闸门初始化与一处交付回退陈旧断言；`pnpm check`／`check:dist`、主/production/manage/location/delivery e2e、全量后端 1255 passed、本机 Nginx 1.28.0 三阶段交付通过，63 张四宽度候选截图已出但黄金图未更新。证据见[09 证据](evidence/09-integrated-verification.md)；视觉人工签收、真机、真实飞书/上游与部署仍未验证。
- **07 已 `resolved`**：独立回复访问的仅内存访问快照让 `‹ 会话列表`、浏览器返回与前进恢复排序/页码/内容/位置，热度第 N 页不被时间序定位覆盖，无来源时替换为所属回复详情的时间序第 1 页；无新接口/表/迁移/索引/采集。证据见[07 证据](evidence/07-conversation-navigation-restoration.md)，`pnpm check`／`check:dist`／`test:e2e`／`test:e2e:location`／`test:delivery` 均通过；视觉、真机、真实上游与目标机部署仍未验证。09 的组合验证仍依赖 04、07、08。
- **06 已 `resolved`**：回复 page／定位的 `conversation` 投影与只读 conversation 子资源、手机会话页与入口、真实 SQLite/HTTP 与浏览器闭环已交付，并同步[归档 API](../../docs/backend/api/archive-api.md#阅读改版-06-增量回复对话投影与只读-conversation-子资源)与[客户端契约](../../docs/backend/api/archive-api-client.md#阅读改版-06-增量对话投影与手机会话页)；05 在该契约上追加 `sort`，07 在其上做往返恢复。证据见[06 证据](evidence/06-conversation-reading.md)，`pnpm check`／`check:dist` 通过，`pnpm test:e2e` 只剩基线已有的 2 个 `app-shell` 链接名断言失败（非本票回归，证据 §4/§7）；视觉、真机与部署仍未验证。

```text
01 ───────────────→ 08 ───────────┐
02 → 03 → 04 ────────────────────┼→ 09 → 10
 └─→ 05 ─┐                       │
06 ──────┴─→ 07 ─────────────────┘
```

## 票 10 首轮反馈追加票（原 01–11 证据保留历史）

- [12 头像裁切与管理对齐](issues/12-avatar-and-management-alignment.md)：首项头像轮廓完整、表单文字垂直居中、输入按钮可见等高（命中 ≥44px、手机输入 16px 不退化）。
- [13 完整会话与入口定位](issues/13-complete-conversation-and-entry-focus.md)：一次请求整段会话无分页、入口定位到视口中央（夹在可滚动范围内、不补留白）且显示“刚才查看”，保留真实关系、时间序与来源返回恢复。
- 12、13 已分别实现并合入，均 `resolved`（仅实现与范围自动化）；双轴审查及其整改收尾候选为 `344235a`，见[组合与最终验证](evidence/10-feedback-round-1-verification.md)，隔离预览供 10 人工复验。需求依据与原图见[首轮反馈](evidence/10-feedback-round-1.md)；新要求替代旧的会话起点首屏/分页方案，不追改旧结果。

## 2. 实施协调

- 没有独立的“先重构所有契约/状态”横向票。02在可观察排序功能内提取可独立挂载的评论区；03在列表路径内扩快照；06在对话读取路径内复用关系计算；07在往返流程内扩导航恢复。
- 05与06都可能修改回复读取契约，01与其他票可能共享主题/壳。即使无功能阻塞，也应串行领取共同修改面或明确单一写入者；不能同时覆盖同一文件并靠最后写入者胜出。
- 根评论普通新访问显式latest；回复hot仅在page模式扩展，时间cursor和时间序定位保持兼容。对话采用只读实时页码与同根资格投影；具体公开URL/字段由承接票与真实契约测试同时定稿。
- 本次检出仓库尚无桌面卡片内评论，03是实际补齐，不以用户使用环境已有该能力为由跳过。已确认的目标优先，不要求用户再解释部署版本。
- 原型里省略的图片/管理功能保留原契约。HTML只回答设计问题，不复制模拟数据、临时状态机或测试工具栏到正式应用。

## 3. 验收归属

下表只分配正式设计的验收编号，不重述规范。09负责组合证据，10负责必要人工部分。

| 正式验收项 | 主要交付票 |
| --- | --- |
| UI-01 文案 | 01；08复核管理 |
| UI-02 顶栏与管理隔离 | 01 |
| UI-03 UP条 | 01 |
| UI-04 手机入口与返回 | 04 |
| UI-05 桌面列表内评论 | 03 |
| UI-06 桌面新标签 | 04 |
| UI-07 内部操作与图片隔离 | 03、04 |
| UI-08 排序 | 02、03、05 |
| UI-09 对话数量与分支 | 06 |
| UI-10 缺失关系与同名 | 06 |
| UI-11 会话阅读与返回 | 06、07 |
| UI-12 排版与触控 | 01、02、05、08 |
| UI-13 管理按钮与语义 | 08 |
| UI-14 输入与真机 | 08自动化；10实机 |
| UI-15 只读、直达与交付 | 04–07各自链路；09组合；10授权范围内实机 |

## 4. 证据与完成口径

- 每张代理票附实际版本、命令、测试数据来源、通过/失败与未验证项；依据符合要求才能转 `resolved`，不能把文档/目录存在当执行结果。
- 运行命令与e2e项目声明以[前端README](../../frontend/README.md#命令)为准；后端使用uv。测试复用真实SQLite/HTTP、生产Adapter浏览器和既有页面测试，不另建平行工具链。
- 09生成候选截图和隔离交付结果，不代替10更新人工签收结论；正式截图确认后才按既有流程更新黄金图。
- 缺少实际设备、真实客户端或外部授权的场景保留“未验证”。不因输入字号变为16px就关闭旧Safari限制，也不因隔离静态交付通过就宣称生产上线。
- Git提交、实现分支、合并与清理由后续实施遵循仓库专用工作流；本次规划阶段未执行这些操作。
