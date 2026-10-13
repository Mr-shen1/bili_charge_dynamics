# #14 多 UP 导航、卡片入口与访问恢复交付记录

## 范围与判定

对应 [#14](issues/14-scope-navigation-cards.md)、[本期规格](spec.md) 故事 2–13、17、28–35、46、62；沿用 #13 的 scope 读取、导航会话与位置恢复。实现与本票自动化回归已交付，正式浏览器真机与人工视觉验收未验证；不据此收口父 #03 或整个后端集成。

#13 的实现与验收证据作为本次底座，原票据状态和记录未修改。`needs-triage` 是待维护者评估，不是功能未实现的断言。

## 实现与公开行为证据

| 本票核验项 | 实现 / 证据 | 结果及边界 |
| --- | --- | --- |
| 全部 + 保存 UP 头像昵称、URL 选中、旧身份入口 | `ArchiveNavigation.tsx` / CSS；`tests/archive-navigation.test.tsx`；`tests/e2e-archive/scoped.spec.ts` | 身份加载、失败局部重读、取消提示、坏头像/未知昵称兜底；真实 SQLite 关闭重开后，从选择条进入已删配置及已停用 UP 的旧归档 |
| 卡片 / 键盘到顶部，气泡到同详情评论区 | `DynamicCard.tsx`、`DynamicContent.tsx`；`tests/archive-app.test.tsx`、`tests/e2e/card-entry.spec.ts` | 独立真实链接与气泡按钮为兄弟元素，无嵌套按钮/链接；移除旧详情按钮；原生留白点击、真实拖选正文、身份、图片、展开及键盘焦点均回归 |
| 实际作者及 UP 标识 | `DetailPage.tsx`、`CommentSection.tsx`、`ReplySection.tsx`；`tests/comments-app.test.tsx` | 动态作者与评论/回复标识以当前动态作者 ID 为真值，同名不同 ID 不误标；生产评论仍显示尚未归档，不实现真实采集 |
| 六行实际折叠、宽度重判、详情全文、字段兜底 | 复用 `FoldableText.tsx`；`continue-reading.spec.ts`、`comments.spec.ts`、`replies.spec.ts`、`archive-app.test.tsx` | 真实浏览器排版、宽度变化、emoji/换行/长词及 URL 安全文本回归；发布时间秒值与独立分钟编辑精度保留 |
| scope / 访问 / cursor / 迟到结果隔离 | `tests/scoped-app.test.tsx`、`discussion-history.test.tsx`、`app.test.tsx` | 生产 Adapter 只替换 HTTP 传输，旧成功/HTTP 失败/拒绝/完成不改变新 scope；受控 Reader 补取消与同动态多访问；连续加载防重、原 cursor 重试 |
| 多批数据、展开、cursor、来源 scope 与位置恢复 | `tests/e2e-archive/scope-navigation.spec.ts`、`continue-reading.spec.ts`、`discussion-history.spec.ts`、`browse.spec.ts` | 生产 Adapter 的 HTTP fixture 验证全部→单 UP 同动态、多批/展开/锚点历史恢复与独立下一批；页面返回和历史前后进、无来源首页、刷新遗留标记回归 |
| 主动入口优先，用户滚动优先 | 既有 `readingPosition.ts` 增加交互取消通知，由详情入口共享；`tests/app.test.tsx` 与既有浏览器恢复测试 | 等待动态或评论时的用户滚动取消迟到评论定位；未引入第二套历史/滚动协调器 |
| 配色、四宽度、触控、焦点 | 全局浅青、白卡、青蓝选中、粉色作者/回复；`card-entry.spec.ts`、`scope-navigation.spec.ts`、`cross-device-acceptance.spec.ts` | 360/390/768/1280px，无页面横向溢出，选择条内部横滑；主要入口约 44px，清晰键盘焦点。以文字 UI 规范和自动化为证据，未宣称像素级复刻或真机验收 |

## 测试边界与 TDD

用户确认 RTL + 生产 Adapter、Playwright、实际归档联测三个边界。按竖切补充失败测试再实现：头像/兜底与导航状态、整卡入口、按动态作者 ID 标识、用户滚动取消迟到评论定位、身份读取取消不误报失败。既有旧按钮测试迁移为新链接操作，保留原阅读、预览及恢复断言。

浏览器中整卡链接的非交互留白可点击，正文位于链接覆盖层上方以允许真实选择；测试不使用强制点击绕过命中。多批 scope 测试在测量锚点时使用 DOM 点击以避免测试框架自动滚动改写来源位置；真实卡片与气泡命中另由 `card-entry.spec.ts` 验证。

## 可复现命令与结果

环境：Node `24.21.0`（nvm）、pnpm `10.34.6`、uv `0.12.23`、Playwright `1.58.2`。浏览器使用配置中的桌面 Chromium 与 Pixel 7 移动 Chromium 模拟；归档联测使用桌面 Chromium、虚构上游、临时真实 SQLite/FastAPI 和生产 Adapter，无真实 Cookie、上游或 OSS。

先运行：

```sh
source ~/.nvm/nvm.sh && nvm use
```

单文件/定向回归曾分别执行 `archive-navigation.test.tsx`、`archive-app.test.tsx`、`comments-app.test.tsx`、`app.test.tsx`、`scoped-app.test.tsx` 及 `card-entry.spec.ts`，均通过。完整回归串行执行：

| 命令 | 最终结果 |
| --- | --- |
| `pnpm test --maxWorkers=2` | 19 文件，163/163 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过，生产构建 |
| `uv run pytest backend/tests -q` | 156/156 通过 |
| `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY pnpm test:e2e` | 104 通过，10 个 Nginx 专项按配置跳过 |
| `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY pnpm test:e2e:manage` | 2/2 通过 |
| `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY pnpm test:e2e:archive` | 4/4 通过（2 个实际 SQLite/API 联测，2 个生产 Adapter HTTP fixture 入口/布局/恢复测试） |
| `git diff --check` | 通过 |

首次定向浏览器回归发现一个测试坐标问题：展开后的卡片高于视口，`scrollIntoViewIfNeeded` 并不保证卡片顶部留白在可见范围内；改为明确滚到卡片顶部后，原生点击断言及完整回归通过。未以强制点击掩盖失败。

## Standards

审查基线为用户确认的 `eff449f`，首轮审查提交 `2e163ce`。确定文档规范违规 0 项，可维护性判断 4 项：

1. `ArchiveNavigation` 与 `Identity` 头像兜底重复：已提取有状态 `UserAvatar` 共享，保留公开页面的坏头像回归。
2. 卡片专用 `data-card-inert` 泄漏到共享身份组件：改为描述内容语义的 `data-display-identity`；卡片仍在唯一入口处决定不导航。
3. `reader` / `dynamicId` / `authorId` 逐层传递形成可能的参数簇：保留显式小参数，不为三个必要依赖再造空上下文或读取框架。
4. 卡片与链接入口的条件判断相似：保留两种语义路径，链接支持原生修饰键/新标签页，卡片正文操作需排除内部交互；共享点击/选择判定，避免将不同导航语义强行合并。

## Spec

首轮确认功能缺陷 0 项；提出证据缺口 1 项及非阻塞判断/整理建议 4 项：

1. 生产 `not-archived` 气泡定位缺真实浏览器证据：已补 `scope-navigation.spec.ts`，验证生产 Adapter 气泡使未归档评论提示可见、卡片重访到顶部，以及等待生产详情时用户滚轮取消迟到定位。
2. `Identity.heading` 无调用者：已移除遗留参数及分支。
3. 全局 Selection 可能抑制其他区域选区遗留后的点击：未确认原生用户流程中会发生（普通点击会清除选区），保留选择保护；真实拖选及独立键盘入口回归通过。
4. 共享身份组件携带卡片语义属性：已按 Standards 的对应建议改为展示身份语义。
5. 选择条“全部归档”与参考文字“全部动态”措辞不同：保留现有可访问名称与归档范围含义，页面标题为“全部动态”；选中、路由和内容范围不变。

两轴分别记录：Standards 4 个非阻塞判断、最主要为已消除的头像重复；Spec 1 个已补齐证据缺口及 4 个非阻塞判断/整理项，无确认功能缺陷。审查后的小范围整理及新增浏览器证据均再次执行类型检查和回归。

## 未验证与后续

- Linux Chrome 与 iPhone Safari 的正式设备/浏览器实测、人工视觉签收未执行，留给 #33；移动模拟不等于真机。
- 本次未运行 Nginx 静态交付专项，未验证真实部署、OSS、持续采集或上游自然变化；普通 E2E 中 10 项配置性跳过不记为通过。
- 真实评论归档、真实媒体接入分别由后续票负责；本票保留真实未同步提示及既有图片回归，不新增独立评论页、转发、真实写回或业务区块。
- 父 #03 须由维护者合并 #13/#14 证据并核对原清单后收口；本票状态表示等待核验，不改写父票验收。
