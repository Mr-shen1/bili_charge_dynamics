# #22 纯图评论与独立图片组预览：交付证据

## 范围与依赖

依据 [#22](issues/22-comment-image-reading.md)、[规格](spec.md) 已确认 T1/T2、[共同交付要求](implementation-plan.md#所有执行子票的共同交付要求)。实施起点 `74db54699742ba9456be068600b1a9b6f2f5d261`，分支 `backend-integration`。

#16 的生产根评论读取、#20 的完整媒体映射/网格/预览/历史、#21 的评论媒体 HTTP 均已存在并有自动化证据，分别见 [16](acceptance-16.md)、[20](acceptance-20.md)、[21](acceptance-21.md)。依赖的维护者核验状态未收口，本票只消费已实现契约，不修改依赖票或父票状态，不把前置能力缺失隐藏为假设。

仅一级评论图片，不增加回复图、独立评论页、气泡真实缩略图、真实写回、下载、自由缩放或另一套历史协调器。

## 实现契约

- 生产 Adapter 共用动态图映射，按 owner 类型和根评论 ID 过滤关联；保持当前组的服务端顺序及全部图片，12 图不截成九图。不混入 `previous_media`、其他评论、动态或回复。
- 成功图的安全 HTTPS 公开 URL 原样作为缩略和预览；pending/failed 即使有 URL 也不请求。坏地址局部降级；来源/旧组不作生产回退。关联 ID 为不透明字符串，尺寸未知为 null。
- `Comment.images` 可选；旧冻结 DTO 缺 `media` 时保留来源存在性。`pendingMediaCount` 仅表示还没有有效当前关联的位置，逐图上传状态由图片本身表达，不重复误报整组待归档。回复类型排除图片字段。
- 评论图区复用 `ImageGrid`，详情全部缩略可访问，单图保比例、四图两列、其余三列；无图不留空区。纯图（含未上传）无“暂无评论内容”，只有文本和图片存在性都空才兜底。
- 所点图片以 comment owner/根 ID、整组、组内序号及触发元素进入唯一预览/导航协调器；沿用按键/Esc、非循环、长图、触控、滚动锁、焦点和同 URL 历史。
- 浏览器加载失败只局部重试原 URL，不调用 `/api/sync` 或冒充上传重试。缩略懒加载，预览只挂载当前图；公开图仍没有生成尺寸变体，CSS/懒加载/OSS 不等于压缩或性能证明。

正式契约见 [客户端 §22](../../docs/backend/api/archive-api-client.md#22-增量一级评论图片阅读)。

## TDD 与定向验证

| 切片 | RED | GREEN |
| --- | --- | --- |
| 生产 Adapter 评论媒体 | 新测试缺 `images` 且仍把整组计为待归档 | 共用 owner-aware 媒体映射后通过；补12图、非法URL/关联、旧冻结页回归 |
| 生产详情纯图与两评论组 | 纯图错误显示“暂无评论内容” | 接入复用网格/正确兜底后通过；补逐图归档与浏览器坏图语义 |
| 实际评论媒体联测装配 | 原上游评论夹具为空图片组，HTTP `media:[]` | 在真实协议 `content.pictures` 中注入虚构来源后通过；这是测试装配补全，不是服务端实现缺陷 |

首轮页面测试曾过早查询尚为空的评论 `<ul>`，已改为等待公开评论项后取得真正兜底 RED；联测先误从最热首批寻找位于末批的评论44，修正为读取最新首批，不把查询错误记录为产品缺陷。

定向命令均先 `source ~/.nvm/nvm.sh && nvm use`：

```sh
pnpm test tests/archive-reader.test.ts
pnpm test tests/archive-comment-images.test.tsx
pnpm test tests/images.test.tsx
pnpm typecheck
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost pnpm test:e2e:archive comment-media-reading.spec.ts
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost pnpm test:e2e:archive media-live.spec.ts
```

联测开发时用 `/tmp/22-playwright.config.ts` 指向4187避开另一个浏览器进程；最终采用仓库4177配置。过程日志 `/tmp/22-adapter-red.log`、`/tmp/22-adapter-green.log`、`/tmp/22-page-red.log`、`/tmp/22-page-green.log`、`/tmp/22-live-red.log`、`/tmp/22-live-green.log` 不作为长期交付依赖，仓库测试可复现。

## T1/T2 证据边界

T1：`tests/archive-reader.test.ts` 与 `tests/archive-comment-images.test.tsx` 使用真实生产 Adapter，只替换 HTTP 传输；浏览器 `comment-media-reading.spec.ts` 使用同一生产装配及可控公开图片服务。不是用假 Adapter 绕过 DTO 映射。

浏览器新增6场景，专项由子代理重复3轮18/18通过，主线程最终整套再验证：
- 单/四/三/十二图四宽度、44px、长昵称、纯图/文字/空；详情第12张正确，无九格截断。
- 两评论组及相同owner ID/图片ID的动态图组隔离，反复打开、只增一条历史、切图不压栈、后退/前进恢复最后图片、scroll与触发焦点，焦点留在预览内。
- 排序清空触发评论DOM后，前进仍读原组；关闭回main后备，刷新清理失效标记，重复前后退不多退/循环。
- pending/failed无假的浏览器重试；坏图缩略和预览均只重试原URL，可切走/关闭，正文保留，无来源图请求。
- 缩略lazy、预览eager；未看末组无图片请求，打开或切图仅加载当前预览图，不预取整组。
- 慢/缺尺寸长图加载前后外框稳定，四宽度完整/适宽；CDP原生触控纵读不误切/不滚底层，切图归零，首尾不循环、单图无切换。

T2：`media-live.spec.ts` 的评论场景不拦截归档 API。通过公开管理/初始化，真实根 JSON→实际临时 SQLite→Uvicorn/FastAPI→生产 Adapter→浏览器。初始化未配置上传保留四图 pending，重开后独立选择两张同步为 success/failed、剩余 pending，另一根单图及动态图独立成功；页面/预览区分状态、组内前进后退及排序后单图读取。删除监控并断源重开后公开媒体/关联/顺序仍在；浏览器不隐式写 API，虚构秘密不进UI/进程日志。

来源下载/OSS 为受控模拟，公开图由浏览器图片边界替身提供；不代表真实云上传或真实公开对象可用。

## 与 #21 核对父 #07 原清单

| 父票要求 | 证据归属与边界 |
| --- | --- |
| 原始评论JSON→下载/上传→SQLite→HTTP→页面 | #21 T2/T3 + 本票实际 HTTP 浏览器串联，不复制上传实现 |
| owner/顺序/尺寸/状态/关联/幂等/无回复图 | #21 后端独立组证据 + 本票 Adapter/浏览器正确组；回复展示类型排除图片 |
| 纯图、纯文字、空、未上传 | 本票生产页面/浏览器；pending仍存在但不回退来源 |
| 文本/根回复与单图独立、失败恢复/重开/checkpoint | #21；本票仅验证消费逐图状态及断源重开读取，不声称新调度 |
| 正文受限、计数/分页/版本交错不清旧归档 | #21 后端专项；本票沿用现有读取协调，不改采集 |
| 公开URL直取、无代理/回退，归档与加载失败区别 | 本票 T1/T2 + #21 公开URL契约；真实OSS另票 |
| 单/四/多/超九、缩略和预览、位置占位 | 本票详情全部图与适用网格；列表九格由 #20 保留回归，无新评论列表页 |
| 键盘/触控/长图/历史/焦点/排序卸载/刷新 | 本票浏览器与既有预览回归；模拟触控不替代真机 |
| 懒加载/按需、四宽度/长昵称/触控目标 | 本票浏览器；不承诺实际压缩、容量或资源指标 |

此表为分工核对，不自动勾选父 #07 或全期 AC；计数周期自动媒体联动仍由 #25/#30 收口。

## 最终验证与双轴审查

环境：Linux、Node 24.21.0（nvm）、pnpm 10.34.6、Python 3.12.15（uv）、Playwright 1.58.2、Chrome for Testing 145.0.7632.6。生产浏览器采用 Desktop Chrome 配置；触控为Chromium CDP，旧mock含Pixel 7模拟，均非iPhone Safari真机。

```sh
source ~/.nvm/nvm.sh && nvm use
pnpm typecheck
pnpm test --maxWorkers=2
uv run pytest backend/tests -q
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
pnpm test:e2e:archive
pnpm test:e2e:manage
pnpm test:e2e
pnpm test:e2e:preview
pnpm build  # 最后恢复生产产物
uv run --no-sync python -m py_compile tests/e2e-archive/live_app.py
git diff --check
```

| 验证 | 结果 |
| --- | --- |
| Vitest | 21文件、204项通过；Adapter32项、评论图RTL2项、原图片12项定向均通过 |
| 后端全量 | 274项通过、3条既有依赖弃用警告 |
| 生产归档浏览器 | 27项通过，含新增6项评论图T1及1项评论媒体实际HTTP联测；保留原动态图/回复/导航回归 |
| 管理浏览器 | 2项通过 |
| 独立mock开发浏览器 | 104项通过，10条Nginx专项按配置跳过 |
| 独立mock静态preview | 96项通过，同10条Nginx专项跳过 |
| typecheck、生产build、Python编译、diff检查 | 通过 |

最终日志 `/tmp/22-typecheck-final.log`、`/tmp/22-unit-final.log`、`/tmp/22-backend-final.log`、`/tmp/22-archive-browser-final.log`、`/tmp/22-manage-browser-final.log`、`/tmp/22-mock-browser-final.log`、`/tmp/22-preview-final.log`、`/tmp/22-build-final.log`；顺序运行套件避免争用，不更改测试超时掩盖失败。

### 规范轴

两个 `review` 子代理并行独立审查，固定基线 `74db54699742ba9456be068600b1a9b6f2f5d261`，初审提交 `22ce2db`；命令 `git diff 74db54699742ba9456be068600b1a9b6f2f5d261...HEAD`。审查只读、未独立运行测试。

硬违规0，判断项5：
1. 内联owner字段对与既有ImageOwner重复：已把ImageOwner移到共享数据契约，由Adapter/网格/导航/预览共用，不让数据层依赖UI层。
2. 可选images缺省含义可能不同：已明确评论和动态一样，未提供等价空集合；旧来源存在性由pendingMediaCount单独保留，不把undefined当另一种隐式图片状态。
3. pendingMediaCount名称可能误解为全部上传pending：保留既有公开字段兼容 #16/mock，不为本票重命名所有旧调用方；注释与§22明确其只计未关联来源，当前图pending/failed由images表达。
4. 媒体存在性谓词/夹具混合条件可读性：已提取每评论hasText/hasMedia并给长图条件加括号，不引入空模块或另一状态真值。
5. 建议needs-triage改ready-for-human：未采纳。仓库标签原文明定后者“Requires human implementation”，本票已实施完，仅待维护者核验，沿 #20 的收口约定保留needs-triage；不把审查判断当成硬规则。

### 规格轴

确证缺失/错误0、范围扩张0，观察3：
1. §16历史pendingMediaCount与本次增量语义：已在§22显式区分历史全来源计数与现在未关联位置，不重写 #16 交付证据。
2. T2没有同时呈现同ID的两个评论/动态图：同ID/相同媒体ID隔离由生产T1明确覆盖，实际T2贯通两根及动态图的独立公开URL/逐图状态/重开；票据只要求至少一条实际T2，不扩成无关全量矩阵。
3. 混合当前关联及剩余来源会有网格和待归档聚合提示：两者表达不同位置，保留，不把未关联来源误吞或假装都已有当前关联。

分轴汇总：规范轴0硬违规/5判断（主要为共享类型及命名），规格轴0确证缺陷/3观察（主要为历史文档语义）；已补强可操作项，其余有明确保留理由。

审查补强后顺序重跑全部套件：typecheck、评论图单文件2项、前端204项、后端274项、生产归档浏览器27项、管理2项、mock开发104项与静态preview96项、生产build及diff检查再次通过；两个mock浏览器套件各10条Nginx专项仍按配置跳过。没有未修的确证缺陷。复测日志 `/tmp/22-unit-reviewed-final.log`、`/tmp/22-backend-reviewed-final.log`、`/tmp/22-archive-reviewed-final.log`、`/tmp/22-manage-reviewed-final.log`、`/tmp/22-mock-reviewed-final.log`、`/tmp/22-preview-reviewed-final.log`、`/tmp/22-build-reviewed-final.log`；不将静态审查冒充测试执行。

## 未验证

- #33 Linux Chrome/iPhone Safari 正式设备人工证据；Chromium自动化/原生CDP触控不等于iPhone真机。
- #34 真实上游、真实OSS上传/公开读取、自然编辑、持续运行与实际资源规模；没有读取真实凭据或操作云资源。
- 正式Nginx部署、尺寸变体/压缩/CDN、备份/容量治理和长期性能；本票没有新增这些能力。
- 公开图片可外链、管理/API无鉴权等风险不变，不把隐藏入口当作安全保护。
