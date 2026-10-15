# 30 前端／浏览器组合回归证据

本记录保留首轮前端分工的过程，不替代后端专项、部署、真实上游、实际 OSS、持续运行或真机证据；后续整合见文末及总验收。

## 已确认入口与装配

沿用规格已确认 T1/T2/T3，不重新访谈：浏览器通过真实生产管理接口保存 UID／模式／目标；测试进程私有 Unix socket 调用公开 `Collector.check_once`／`execute_pending`；真实临时 SQLite 经生产 HTTP／Adapter 回到阅读和管理页面。

- `tests/e2e-archive/archive-lifecycle.spec.ts:48`：浏览器新增 UID、保存指定模式、校验关联目标，不用 API 请求代替这些用户操作。
- `tests/e2e-archive/archive-lifecycle.spec.ts:67`：停用后从选择条进入单 UP，列表展开→详情→根评论／回复→评论图预览与焦点→返回原 scope／展开；删目标和配置，断源重开真实 SQLite 后，再从全部页选择条进入旧归档，读取两类媒体／根回复，并验证阅读不写 API、不请求上游。
- `tests/e2e-archive/archive-lifecycle.spec.ts:141`：管理页未检查→已登记观察→完成→同步中→媒体部分失败→无变化但仍部分完成→重启后的无新信号重试完成；来源总数与本地数分离，评论成功不冒充整轮成功。固定时钟使最近检查、根／回复／评论成功、实际整轮成功时间可独立核验。
- `tests/e2e-archive/lifecycle_live_app.py:48`：复用原始 HTML／JSON、根回复夹具的传输装配；可信 HTML 编辑时间从 13:01 改为 13:02，发布时间不变；独立来源计数从 501 改为 502，增加根评论／回复与动态图／评论图来源。
- `tests/e2e-archive/lifecycle_live_app.py:31`：模拟 OSS 上传阻塞、固定虚构秘密异常及恢复；失败不阻止正文和评论文本成功，重开后重试媒体不重扫已经完成的根回复。
- `tests/e2e-archive/lifecycle_live_app.py:125`：生产 FastAPI／SQLite／Collector，不 mock 仓储、不直接写数据库、不伪造归档 API 响应。控制入口只在测试 Unix socket，不新增产品 HTTP 路由。
- `tests/e2e-archive/archive-lifecycle.spec.ts:38`：浏览器仅将公开测试图片 URL 替换为受控 SVG，其余外部 HTTPS 请求终止；后端上游／下载全部是 `httpx.MockTransport`，显式注入模拟 uploader，不使用真实网络或 OSS 凭据。

未修改 `src`、后端生产代码或已有浏览器测试文件。

## 单测试红→最小绿记录

每次命令均先执行：

```bash
source ~/.nvm/nvm.sh && nvm use
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
```

当前环境设置了 HTTP 代理；未设置本地绕过时，Playwright 曾误报 4177 已占用，但 `ss` 无监听，原生 Node 请求为 `ECONNREFUSED`。该环境阻塞不算有效红灯，也未停止未知进程。

### 第一条：管理至保留阅读

```bash
pnpm test:e2e:archive archive-lifecycle.spec.ts --grep '浏览器管理'
```

- 红：1 failed，`Could not import module "lifecycle_live_app"`。先写组合测试，再补测试专用传输／执行装配。
- 补齐最小装配后，修正测试对既有 UI 的两处误认：新增配置默认已启用，不需要再点“启用监控”；折叠按钮名称是“展开正文／收起正文”，不是“展开动态／收起动态”。没有为这些误认修改生产代码。
- 绿：1 passed。
- 本机过程输出：`/tmp/30-browser-red1.log`、`/tmp/30-browser-green1.log`；临时日志不作为跨机器交付物。

### 第二条：编辑／计数／分项状态与失败恢复

```bash
pnpm test:e2e:archive archive-lifecycle.spec.ts --grep '管理分项状态'
```

- 红：1 failed；已有装配使用系统时钟，管理页实际整轮成功时间不等于固定夹具时间 `2026-10-09 13:10:00`。
- 最小绿：在测试外部时钟边界注入固定时间，补原始协议的第二版本、模拟 OSS 阻塞失败与恢复、私有执行控制及第二版本重开。生产实现不变。
- 绿：1 passed；失败期间正文／评论成功、动态图／评论图未完成、旧整轮成功时间与新评论成功时间分离；重开后同 revision、同观察、无新信号也能完成媒体。
- 本机过程输出：`/tmp/30-browser-red2.log`、`/tmp/30-browser-green2.log`。

## 最终核验

以下均单文件运行，未并发争用固定 API／Vite 端口：

| 命令 | 本轮结果 |
| --- | --- |
| `pnpm test:e2e:archive archive-lifecycle.spec.ts` | 2 passed；整文件运行两次均通过 |
| `pnpm test:e2e:archive comment-status.spec.ts` | 2 passed |
| `pnpm test:e2e:archive scoped.spec.ts` | 1 passed |
| `pnpm test:e2e:archive media-live.spec.ts` | 3 passed |
| `pnpm typecheck` | 通过，实际执行 `tsc --noEmit` |

最终四个单文件共 8 passed；上述旧文件作为复用回归执行，并非本轮重写或新增矩阵。`tsc` 生成的未跟踪 `tsconfig.tsbuildinfo` 已清理。

## 未验证与交接

- 新增两例仅选指定模式的组合穿透；近期发现／模式切换／窗口移出的完整矩阵、旧新观察在途交错，由前置与并行后端专项承担，本记录不声称新增浏览器穷举。
- 新例覆盖同步错误导致的部分完成，未在浏览器逐一穷举所有来源计数失败、正文受限、根／回复分页失败或无任何成功分项的纯失败聚合；已有 `comment-status.spec.ts` 的回复失败／未知／零及状态恢复，本轮已重跑通过，但不等于全部管理失败分支已验证。
- 未运行全部 Vitest／全部浏览器测试／后端全量测试；这些由主线程汇总。未做 Nginx、Linux Chrome 版本专项、iPhone Safari 真机、真实 OSS／上游、持续 15 秒调度与资源容量验证。
- 首轮未新增或修改产品接口／生产实现；主线程合并后端证据后统一审查与提交。

## 后续整合补记

后端新增实际正文／动态图／评论图成功时间与媒体错误数组后，生产 `parseCheck`、管理面板和三条 RTL 契约回归已补齐：旧 DTO 缺字段回退 null／空数组，错误只认固定下载／上传码，非法时间／数组拒绝不回显。`archive-lifecycle.spec.ts` 已增加真实时间和错误断言，重跑 **2 passed**。

最终主线程运行 Vitest **268 passed**、归档浏览器全量 **38 passed**、管理 **7 passed**、原 mock／故障 **104 passed/10 skipped**；typecheck／生产 build 通过。完整命令、并行负载超时记录、父 #11 对照和审查见 [总验收](../acceptance-30.md)。
