# 文字动态浏览

目前完成 [任务 01](.scratch/dynamics-viewer/issues/01-browse-text-dynamics.md)、[任务 02](.scratch/dynamics-viewer/issues/02-continue-reading-dynamics.md) 和 [任务 03](.scratch/dynamics-viewer/issues/03-read-and-sort-comments.md)：固定虚构 UP 主、每批最多 10 条文字动态、独立完整正文详情、站内返回、详情直达/刷新、加载/空态/错误重试及安全文本展示；列表支持显式追加、超过六个渲染行的正文展开/收起，以及会话内返回原列表阅读进度。

详情支持一级评论的最热/最新排序、每批 20 条的显式追加、长评论展开/收起与局部失败重试；列表评论数可直接进入评论区。

楼中楼（含逐条回复数展示）、内容图片与预览、完整详情历史快照、Nginx 配置仍留给 04–09。本工程不调用真实 B站、后端或 OSS，也不需要凭据。

## 环境与运行

使用 nvm 管理固定 Node.js，使用 pnpm 管理依赖；直接依赖版本与 lockfile 已固定。

```bash
source ~/.nvm/nvm.sh
nvm install
nvm use
corepack enable
corepack prepare pnpm@10.34.6 --activate
pnpm install --frozen-lockfile
pnpm dev
```

列表：`http://localhost:5173/`；详情示例：`http://localhost:5173/dynamics/90071992547409931`。

如果环境没有 Corepack，可先按其官方安装说明准备 Corepack/pnpm；不需要将其作为应用依赖。生产只需要构建后的静态文件，不需要 Node.js 服务。

## 检查与测试

```bash
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:e2e:preview
pnpm build
```

- `pnpm test`：Vitest 数据契约与 RTL 公开页面行为，通过读取接口注入可控 Adapter；不直接断言私有组件状态。
- `pnpm test:e2e`：启动正常开发服务器（4173）与专用故障服务器（4174），在桌面 Chromium 和 Pixel 7 模拟视口运行浏览器流程。
- `pnpm test:e2e:preview`：先重新构建，再对 `dist/` 的正常静态产物运行浏览器测试；不使用故障装配。
- 浏览器测试设设备时区为 `America/Los_Angeles`，检查页面仍显示北京时间。四种约定宽度为 360、390、768、1280px。
- Linux 需要 Chromium 可用的系统库；缺库时按 Playwright 官方系统要求安装。模拟视口不是 Android/iOS 真机测试。
- 如环境设置了 HTTP 代理，需使本地测试服务器绕过代理：`NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost pnpm test:e2e`；静态产物测试同理。

## 装配与边界

- `src/data/contracts.ts`：只读动态/一级评论模型、带不透明下一批标记的列表与评论接口，以及详情接口，区分成功、取消、错误与动态不存在。UI 原样传递标记；后续任务扩展图片/回复。
- `src/data/mockReader.ts`：统一规范时间、缺失值与计数，完整集合按时间倒序、字符串 ID 升序稳定排序，再分页。动态页大小上限 10；评论先对完整集合按最热（点赞/时间降序、ID 升序）或最新（时间降序、ID 升序）排序，再每批 20 条分页，空排序值在有效值后。标记绑定 UP 主、资源与排序，错误资源标记返回读取失败。
- `src/data/assembly.ts`：25 条虚构文字动态和项目内自行绘制的 SVG 头像；包含多批长正文、长词、长昵称、emoji 和长 URL，首条动态具备 45 条一级评论，含 UP 主、同名非 UP 主、缺失字段、零值与长评论样例。
- `src/app/Navigation.tsx`：稳定的 Context + reducer 会话容器，维护会话 ID、独立页面访问 ID、可验证的列表来源、详情入口意图（顶部/评论区）与列表快照。快照只存当前会话内存；history.state 仍只有轻量导航元数据，不使用 localStorage/sessionStorage。
- `src/app/readingPosition.ts`：统一保存稳定内容定位点、视口偏移与像素后备；内容/展开状态先还原，再等待最多两个布局帧定位，用户滚动输入中断恢复，不等待读取或图片。
- `src/dynamics/`：页面消费统一读取接口，正文安全呈现并保留换行；列表按实际渲染行数折叠，ResizeObserver 随宽度重判。追加失败不清空内容或推进标记，重复及过期请求不能改写当前访问。详情正文仍完整展示；一级评论同样按真实行数折叠。评论视图按页面访问隔离，切换排序重置分页和评论展开、回到评论区顶部而不重新初始化上方动态。旧成功、错误和完成均受当前请求有效性保护；本票不保存完整详情历史快照。
- `src/dev/`：确定性开发/测试装配。`pnpm dev:fault` 使首批和第二批列表及各详情首次失败一次，重试恢复，并使用长昵称样例；受控读取 Adapter 可按动态及评论排序注入延迟、取消、错误和忽略取消的结果，评论故障/乱序在公开页面测试中驱动。通过编译配置切换，不提供公开故障 URL 参数或页面控制面板。即使 `pnpm build --mode fault`，也只装配正常数据。

路由采用 BrowserRouter：`/`、`/dynamics/:dynamicId`，其余为前端未找到页面。无有效站内来源时详情返回安全替换为列表首页；刷新后不沿用失效的内存来源。

## 验收记录

详见 [01 验收记录](.scratch/dynamics-viewer/acceptance-01.md)、[02 验收记录](.scratch/dynamics-viewer/acceptance-02.md) 与 [03 验收记录](.scratch/dynamics-viewer/acceptance-03.md)。Vite 的开发/预览回退不代表 Nginx 的回退、资源错误或缓存已经验证；正式静态部署配置与验收留给 08/09。
