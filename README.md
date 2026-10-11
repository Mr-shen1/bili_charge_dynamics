# 图文动态浏览

目前完成 [任务 01](.scratch/dynamics-viewer/issues/01-browse-text-dynamics.md)、[任务 02](.scratch/dynamics-viewer/issues/02-continue-reading-dynamics.md)、[任务 03](.scratch/dynamics-viewer/issues/03-read-and-sort-comments.md)、[任务 04](.scratch/dynamics-viewer/issues/04-expand-comment-replies.md) 和 [任务 05](.scratch/dynamics-viewer/issues/05-preview-dynamic-images.md)：固定虚构 UP 主、每批最多 10 条图文动态、独立完整正文详情、站内返回、详情直达/刷新、加载/空态/错误重试及安全文本展示；列表支持显式追加、超过六个渲染行的正文展开/收起，以及会话内返回原列表阅读进度。

详情支持一级评论的最热/最新排序、每批 20 条的显式追加、长评论展开/收起与局部失败重试；列表评论数可直接进入评论区。

一级评论显示完整回复总数；楼中楼按时间正序预览最多 3 条，每次显式追加最多 10 条，支持收起至预览及再次展开恢复已加载内容。回复目标、UP 主身份、长回复正文折叠和单条回复区失败重试均已支持。

列表和详情支持单图、多图缩略网格及基础图片预览；列表最多九格，四图两列、其他多图三列，超出数量有提示，详情与预览可访问全部图片。按钮、方向键、Esc 和基础历史后退可操作；关闭恢复底层位置与触发焦点。缩略图使用真正的小尺寸素材并懒加载，预览只请求当前图片，坏图支持原地址重试。

长图适应宽度、手机切图手势、完整预览历史组合、完整详情历史快照和 Nginx 配置仍留给 06–09。本工程不调用真实 B站、后端或 OSS，也不需要凭据。

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

- `src/data/contracts.ts`：只读动态/一级评论/回复模型、完整回复数与可缺失的回复目标、带不透明下一批标记的列表/评论/回复接口，以及详情接口，区分成功、取消、错误与动态不存在。UI 原样传递标记；动态图片以稳定 ID、有序数组、缩略/预览 URL 和可缺失尺寸表达，不改写签名参数。
- `src/data/mockReader.ts`：统一规范时间、缺失值与计数，完整集合按时间倒序、字符串 ID 升序稳定排序，再分页。动态页大小上限 10；评论先对完整集合按最热（点赞/时间降序、ID 升序）或最新（时间降序、ID 升序）排序，再每批 20 条分页，空排序值在有效值后。回复始终对完整集合按时间正序、ID 升序排序，首批最多 3 条、追加最多 10 条；标记绑定 UP 主、动态及根评论。错误资源标记返回读取失败，空值在有效值之后。
- `src/data/assembly.ts`：25 条虚构图文动态、项目内自行绘制的 SVG 头像与几何风景 PNG；包括无正文单图、4/9/12 图、未知尺寸与高纵横比图片。素材来源、实际缩略尺寸和重建方式见 `public/demo-images/README.md`；包含多批长正文、长词、长昵称、emoji 和长 URL，首条动态具备 45 条一级评论，`comment-44` 下有 25 条回复，总评论数为 70；含 UP 主、同名非 UP 主、缺失字段、零值、长评论/回复及长目标昵称样例，完整计数不随加载范围变化。
- `src/app/Navigation.tsx`：稳定的 Context + reducer 会话容器，维护会话 ID、独立页面访问 ID、可验证的列表来源、详情入口意图（顶部/评论区）与列表快照。快照只存当前会话内存；history.state 仍只有轻量导航元数据，不使用 localStorage/sessionStorage。基础预览由导航统一 PUSH 同 URL 记录，预览 ID 与底层页面访问 ID 独立，切图不改历史；关闭只撤销当前有效记录，重复关闭不二次后退。底层页面在预览期间保持挂载，不取消仍有效的读取。
- `src/app/readingPosition.ts`：统一保存稳定内容定位点、视口偏移与像素后备；内容/展开状态先还原，再等待最多两个布局帧定位，用户滚动输入中断恢复，不等待读取或图片。
- `src/dynamics/`：页面消费统一读取接口，正文安全呈现并保留换行；列表按实际渲染行数折叠，ResizeObserver 随宽度重判。追加失败不清空内容或推进标记，重复及过期请求不能改写当前访问。详情正文仍完整展示；一级评论同样按真实行数折叠。评论视图按页面访问隔离，切换排序重置分页和评论展开、回到评论区顶部而不重新初始化上方动态。旧成功、错误和完成均受当前请求有效性保护；一级评论与回复复用讨论批次协调器，回复区按根评论独立持有请求和错误；只为当前已展示且回复数非零/未知的评论读取预览，不预取全部回复。收起只改变可见范围，保留数据和下一批标记；排序/访问重置使旧评论及回复成功、错误和完成失效，不保存完整详情历史快照。
- `src/images/`：图片网格与单图比例占位、单张加载/失败/原 URL 重试、按需预览、焦点约束和底层滚动锁。未知尺寸先稳定占位，加载后在框内使用实际比例，避免迟到加载移动阅读位置；会话只保存触发元素 ID，不保留失效 DOM 引用。关闭先解锁、恢复位置，再在底层解除 inert 后以 `preventScroll` 恢复焦点。仅实现 05 的基础预览，切图后的最后位置历史恢复、长图模式及手机手势留给 06。
- `src/dev/`：确定性开发/测试装配。`pnpm dev:fault` 使首批和第二批列表及各详情首次失败一次，重试恢复，并使用长昵称样例；受控读取 Adapter 可按动态/评论排序及动态/根评论注入延迟、取消、错误和忽略取消的结果；评论与回复的局部故障/乱序在公开页面测试中驱动，互不消费计划或取消请求。通过编译配置切换，不提供公开故障 URL 参数或页面控制面板。即使 `pnpm build --mode fault`，也只装配正常数据。

路由采用 BrowserRouter：`/`、`/dynamics/:dynamicId`，其余为前端未找到页面。无有效站内来源时详情返回安全替换为列表首页；刷新后不沿用失效的内存来源。

## 验收记录

详见 [01 验收记录](.scratch/dynamics-viewer/acceptance-01.md)、[02 验收记录](.scratch/dynamics-viewer/acceptance-02.md)、[03 验收记录](.scratch/dynamics-viewer/acceptance-03.md)、[04 验收记录](.scratch/dynamics-viewer/acceptance-04.md) 与 [05 验收记录](.scratch/dynamics-viewer/acceptance-05.md)。Vite 的开发/预览回退不代表 Nginx 的回退、资源错误或缓存已经验证；正式静态部署配置与验收留给 08/09。
