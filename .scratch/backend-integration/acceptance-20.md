# #20 动态图阅读交付与自动化证据

## 范围与环境

本票复用 #19 媒体 DTO、现有网格/预览/导航能力，交付生产 Adapter→列表/详情→预览。未实现评论/回复图片、下载、自由缩放、来源业务图回退、图片变体或应用代理。

用户确认的测试边界：生产 Adapter 的公开读取接口，以及经生产 Adapter/受控图片服务的浏览器阅读流程；后者包含少量实际 API 联测。实施起点为 `a34494b1cdf026b85c476d32af0b76ffb232cd27`，当前分支 `backend-integration`。

环境：Linux、Node 24.21.0（nvm）、pnpm 10.34.6、Python 3.12（uv）、Playwright 1.58.2、Google Chrome for Testing 145.0.7632.6。生产归档浏览器用 Desktop Chrome 配置并切换四宽度；触控经 Chromium CDP 原生输入。旧 mock 回归另跑 Desktop/Pixel 7 模拟配置；两者均不是 iPhone Safari 真机或品牌 Chrome 人工验收。

#19 已提供媒体实现和自动化，但仍标为 `ready-for-human`；本次消费其契约，不修改依赖票/父票状态，也不把人工未收口视作已通过。

## 实现契约

- `media` 保持当前整组及服务端顺序，12 张不截成 9 张；上传状态随每张图保留。成功图把安全公开 HTTPS URL 原样作为缩略和预览地址，pending/failed 不产生 `<img>`。地址损坏局部降级，不拖累正文。
- 来源、旧成功组不作当前图回退；错误 owner/关联形状不进入展示组。旧冻结 DTO 缺 `media` 仍可读，来源元信息只表达待归档。头像 HTTPS 外链仍可用。
- 原网格规则、纯图/纯文字兜底、单图列表限高不变；成功归档组不再显示旧的“图片待归档（全部张数）”误报。归档失败、待归档、浏览器加载失败各自提示；浏览器坏图只重试原地址，不触发归档/卡片导航。
- 预览会话明确 owner 类型/ID、整组/序号和触发处；沿用页面访问、同 URL 历史、焦点约束及滚动恢复。新增 owner 为 #22 扩展提供接口，不增加评论 UI。
- 缩略/预览当前共用公开 URL；不生成缩略变体，不通过 CSS、懒加载或 OSS 宣称已压缩或性能达标。

详细读取契约见 [客户端接口](../../docs/backend/api/archive-api-client.md#20-增量动态图读取与预览)，服务端状态见 [#19 接口](../../docs/backend/api/archive-api.md#19-动态媒体归档独立重试与公开-url)。

## TDD 与定向证据

| 纵切/回归 | 红态 | 绿态 |
| --- | --- | --- |
| `tests/archive-reader.test.ts` 全量媒体映射 | 新测试得到 `images:[]`，1 失败/28 通过 | 29 通过；再补 URL/owner/状态安全回归后 30 通过 |
| `tests/e2e-archive/media-reading.spec.ts` 状态提示 | 已成功四图仍显示“图片待归档”，新场景失败 | 修正旧聚合提示后通过 |
| `media-live.spec.ts` 实际同步装配 | 上传装配缺失使公开同步统计未推进 | 注入受控媒体下载/上传后通过 |
| `media-live.spec.ts` 混合状态 | 单图旧夹具没有三图混合状态 | 扩展结构真实的 HTML/JSON 夹具装配后通过 |
| 其余既有能力回归 | 已有行为直接验证，不虚报功能红态 | 生产图片浏览器共 7 场景、实际 API 联测 2 场景通过 |

浏览器测试初次运行遇本地代理使端口可用性检查误报；加 README 已记录的 NO_PROXY 后获得真正功能红态。坏图重试断言曾在请求尚未发起时读取计数，改为等待公开图片请求结果后通过；这不是实现缺陷或功能红态。并行开发期间用临时 4187 配置避开 4177；最终完整回归使用仓库原配置。

### T1 覆盖

- 生产 Adapter：12 张完整组、上传 pending/success/failed、缺尺寸、旧 cursor、列表/详情同映射、URL 原样、安全地址降级、异 owner 隔离；来源/旧组绝不补图。
- HTTP/图片边界：`fixtures/media-http.ts` 提供 25 条 DTO 和可控公开 HTTPS 图；只替换传输，不替换生产 Adapter。观察 URL、资源请求和浏览器布局，不按 CSS class 或组件私有状态断言。
- 单/四/九/十二图；360/390/768/1280px 网格、触控约44px、单图列表高度、纯文字无图区、纯图无空正文。
- 列表九格末图打开正确9/12；详情第12张正确；尚未显示的第10–12张不因打开第9张预取，切到第10张仅加载所需图；后续缩略懒加载，OSS URL 参数保持原样，来源图不请求，头像不误禁。
- 浏览器坏图与归档未上传区分；缩略/预览均能按原URL局部重试、切走、关闭，正文保留且不触发卡片导航。
- 同URL一条历史、切图不压栈、后退关闭、前进恢复最后图片、多批/展开保留、焦点留在预览并恢复触发处；刷新清理无效标记且不循环。
- 长图完整/适宽等比，缺尺寸迟到加载识别长图；横向原生触控非循环，纵向阅读不切图、不滚底层，切图纵向归零。旧预览/触发处后备/损坏标记回归保留。
- 慢图片、缺尺寸、历史跨宽度重排之后，用户滚动优先，迟到解码不覆盖其选择的位置。

### 少量实际 T2 API 联测

`tests/e2e-archive/media-live.spec.ts` 不替换归档 API；启动真实 Uvicorn/FastAPI、临时 SQLite，从公开管理/初始化与独立媒体同步入口穿透。上游 HTML/JSON 保持协议结构，图片下载/上传由 `live_app.py` 测试装配替身控制，浏览器只替换公开图片服务。

1. 无上传配置初始化 pending→关闭重开→独立媒体同步 success→实际 API 提供公开 URL→列表/详情/单图预览直接使用同地址。
2. 三图 success/failed/pending 顺序不变、正文 success；失败/未上传保留原位，预览切换/关闭可用；删除监控后断源重开，SQLite 公开媒体和正文仍可读，浏览器不隐式写 API。

测试以虚构 `FICTIONAL_SECRET` 标记检查 HTTP/UI/进程日志，不读取真实凭据或访问真实云。

## 最终完整回归

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
pnpm build  # 最后恢复生产产物，不发布 mock 构建
uv run --no-sync python -m py_compile tests/e2e-archive/live_app.py
git diff --check
```

| 验证 | 结果 |
| --- | --- |
| Vitest | 20 文件、200 测试通过，含旧预览/焦点回归 |
| 后端 | 245 通过；3 条既有依赖弃用警告 |
| 生产归档 Playwright | 20/20 通过，含 7 条图片 T1 和 2 条实际 API 联测 |
| 管理 Playwright | 2/2 通过 |
| mock 开发 Playwright | 104 通过，10 条仅 Nginx 验证的测试按配置跳过 |
| mock 静态 preview | 96 通过，同样10条 Nginx 专项跳过 |
| typecheck、生产 build、Python 编译、diff 检查 | 通过 |

审查后的并行回归曾与两组浏览器同时运行，5条既有大讨论/跨scope测试超过默认5秒而失败（无功能断言错误）。不修改测试超时或实现；停止跨套件争用后先单跑 `tests/discussion-history.test.tsx` 18/18通过，再 `pnpm test --maxWorkers=2` 完整200/200通过，后端245/245通过。失败日志保留在 `/tmp/20-unit-contention.log`，定向复核在 `/tmp/20-history-recheck.log`；最终浏览器全套亦按上表通过。

过程日志位于 `/tmp/20-browser-red.log`、`/tmp/20-browser-regression.log`、`/tmp/20-media-live-01-red.log`、`/tmp/20-media-live-02-red.log`；最终日志 `/tmp/20-unit-final.log`、`/tmp/20-backend-final.log`、`/tmp/20-archive-browser-final.log`、`/tmp/20-manage-browser-final.log`、`/tmp/20-mock-browser-final.log`、`/tmp/20-preview-final.log`、`/tmp/20-build-final.log`。临时日志不是长期交付依赖，仓库测试及本记录提供复现入口。

## 与 #19 共同核对父 #06

| 父票清单 | 证据归属/结论边界 |
| --- | --- |
| 协议→下载/上传→SQLite→HTTP→Adapter/页面 | #19 T2/T3 + 本票实际 API 浏览器联测；模拟 OSS，不代表真实云 |
| owner/顺序/全部图/状态/版本/独立重试及重开 | #19 存储证据 + 本票整组映射/状态/重开读取 |
| 公开 URL 直取、头像外链、不回退业务图 | 本票 T1/T2；未测真实云可用性 |
| 暂停网络不占SQLite长事务 | #19 37条媒体专项证据，本票未重新扩展该范围 |
| 网格/预览/长图/历史/焦点/坏图/按需请求 | 本票生产浏览器 + 旧 mock 回归 |
| 编辑及实际版本更新、旧/新完成 fencing | #19；本票消费当前组、不把 previous_media 混入；周期联动仍由 #30 |

本表是分工对照，不自动勾选父票 AC 或宣称 #06 完整验收。

## 双轴审查

按实施起点分别派两个 `review` 子代理执行独立审查，初审提交 `e42d66d`，命令 `git diff a34494b1cdf026b85c476d32af0b76ffb232cd27...HEAD`。以下保持分轴，不将判断性启发当作确证缺陷。

### 规范轴

确证硬违规：0。五项判断性提醒及处理：

1. 标签语义：`ready-for-human` 表示人工实施，交付待核验更适合 `needs-triage`；已调整 #20，不改 #19 状态。
2. 媒体存在性条件疑似重复：`hasMedia` 决定纯图是否补空文案，而旧来源组提示只在没有可展示媒体时出现，两者真值/用途不同；保留独立条件，不以错误提取把成功图重新提示待归档。
3. 状态守卫/文案分支疑似重复：已沿现有 Adapter 风格提取具名 `mediaStatus` 类型守卫；数据类型、DTO验证、用户文案各司其职，不引入多态框架。
4. 网格裸 dynamicId（Primitive Obsession/Data Clumps）：已让 `ImageGrid` 直接接 `ImageOwner`，由动态内容声明 owner，导航/预览统一传递，避免 #22 再改网格签名。
5. `unavailable` 命名：已改 `unavailableMessage`，明确其为待归档/归档失败/地址不可用的提示文案。

另在审查阶段复用原 CDP 触控助手，让历史 mock 与生产图测试共用 `tests/e2e-support/touch.ts`，删除重复输入逻辑，并给长图夹具复合条件加括号。全套回归见上表。

### 规格轴

确证缺失/实现缺陷：0。三项非缺陷观察及处理：

1. 四宽度列表溢出断言不足：已在生产列表四宽度循环直接验证 `scrollWidth <= innerWidth`，详情断言保留。
2. 删除监控/断源重开联测可能略超本票列出的 FR：这是共同要求的归档保留/恢复及父 #06/#19 接缝证据，只扩测试、不增产品能力；保留并明确证据归属，不宣称 FR-19 完整收口。
3. owner 当前存入会话而预览 UI 不读取它：当前组由 owner 对应内容入口给出，Adapter 拒绝异 owner，导航保留精确 images/序号/触发处；owner 描述符本身符合 I9 与 #22 接入约定，不要求凭空增加评论 UI 或重复路由校验。已进一步让网格直接接该类型；评论防串组验收仍归 #22。

汇总：规范轴5项判断/0硬违规，规格轴3项观察/0确证缺陷；上述可操作项已处理，其余有明确保留理由，无待修确证问题。

## 未验证与风险

- #33 的 Linux 品牌 Chrome/iPhone Safari 正式设备人工证据；CDP/Pixel模拟不替代真机。
- #34 的真实上游、真实 OSS 上传/公开读取、自然编辑和持续运行；未操作真实凭据/资源。
- 正式 Nginx 部署、资源压缩/变体、实际规模/2GB容量和长期资源指标；本票未执行静态交付专项。
- 评论 owner/UI 归 #21/#22，回复图不在范围；周期编辑/全链路归 #24/#30。
- 公开 OSS URL 可直接访问/外链，API 无鉴权；没有新增权限、备份或容量治理。本文不改变 #19 已记录的孤立对象/历史对象存储风险。
