# 文字动态浏览

目前仅完成 [任务 01](.scratch/dynamics-viewer/issues/01-browse-text-dynamics.md)：固定虚构 UP 主、首批最多 10 条文字动态、独立完整正文详情、站内返回、详情直达/刷新、加载/空态/错误重试及安全文本展示。

动态追加、正文折叠、阅读位置恢复、评论、内容图片与预览、Nginx 配置均留给 02–09。本工程不调用真实 B站、后端或 OSS，也不需要凭据。

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

- `src/data/contracts.ts`：01 的只读文字模型、首批列表和详情接口，区分成功、取消、错误与动态不存在。后续任务扩展图片/评论以及下一批读取。
- `src/data/mockReader.ts`：统一规范时间、缺失值与计数，按时间倒序、字符串 ID 升序稳定排序。页大小上限 10；本票返回下一批标记，但尚不提供追加操作或下一批读取。
- `src/data/assembly.ts`：25 条虚构文字动态和项目内自行绘制的 SVG 头像；正常评论数为 0。
- `src/app/Navigation.tsx`：稳定的 Context + reducer 会话容器，维护会话 ID、独立页面访问 ID 和可验证的列表来源。只存轻量历史元数据，不使用 localStorage/sessionStorage，不预做阅读快照。
- `src/dynamics/`：页面消费统一读取接口，正文作为文本呈现、保留换行；取消及过期成功/失败不会改写已离开的页面。
- `src/dev/`：确定性开发/测试装配。`pnpm dev:fault` 使列表及各详情首次失败一次，重试恢复，并使用长昵称样例；通过编译配置切换，不提供公开故障 URL 参数或页面控制面板。即使 `pnpm build --mode fault`，也只装配正常数据。

路由采用 BrowserRouter：`/`、`/dynamics/:dynamicId`，其余为前端未找到页面。无有效站内来源时详情返回安全替换为列表首页；刷新后不沿用失效的内存来源。

## 验收记录

详见 [01 验收记录](.scratch/dynamics-viewer/acceptance-01.md)。Vite 的开发/预览回退不代表 Nginx 的回退、资源错误或缓存已经验证；正式静态部署配置与验收留给 08/09。
