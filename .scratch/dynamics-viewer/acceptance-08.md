# 08 验收记录：静态产物直接访问与资源交付

范围：[任务 08](issues/08-static-delivery.md)，参考[实施规格](spec.md)、[SRS](../../docs/product/SRS.md)、[HLD](../../docs/design/HLD.md)、README 和 acceptance-01 至 acceptance-07。只补静态交付机制，不重做 01–07、不提前实施 09。

## 基线与环境

- 当前分支 `feat/dynamics-viewer`；开始 HEAD / 双轴审查固定基线 `174cded5c22071dc538116272400fcac59a47184`。开始工作区干净，无未知修改；未创建新分支或 worktree，不推送。
- nvm Node.js `24.21.0`、pnpm `10.34.6`、Vite `7.3.1`、Playwright `1.58.2`；冻结安装通过，依赖版本和 lockfile 未变。
- Linux x86_64；桌面 Chromium、Pixel 7 模拟视口，时区 `America/Los_Angeles`。既有浏览器测试含 360/390/768/1280px、键盘、CDP 触摸、列表/评论/回复/图片/历史导航。
- 环境初始没有 Nginx、Docker、Podman。已有 GCC `16.2.1`、make、PCRE2/zlib，故从 `https://nginx.org/download/nginx-1.28.0.tar.gz` 下载并在 `/tmp/dynamics-nginx.5kb6zf/` 编译 **Nginx 1.28.0**，默认 configure，直接运行 `objs/nginx`，使用同源码 `conf/mime.types`。下载包 SHA-256 实测 `c6b5c6b086c0df9d3ca3ff5e084c1d0ef909e6038279c71c1c3e985f576ff76a`（本地记录，不声称做了签名验真）。没有 `make install`、sudo、系统服务或生产设施变更。
- 实际验收 Nginx 仅监听 `127.0.0.1:4173`；静态产物、主配置及发布更新副本在独立临时目录。直接包含 `deploy/nginx.conf` 的内容，仅替换 root；主配置提供 MIME、默认类型、日志和进程设置。测试结束退出临时 Nginx并清理发布目录；编译源码临时目录可由维护者清理。

## 交付内容

- `deploy/nginx.conf`：入口重新验证、明确资源命名空间、哈希与版本图片长期缓存、未版本化资源重新验证、缺失资源 404 + no-store；SPA 页面回退不按扩展名分类。
- `docs/deployment/static-delivery.md`：固定工具构建流程、Nginx 使用/验证步骤、缓存与素材路径契约、保留旧资源和原子发布切换、本期素材与后续 OSS/容量边界。README 已链接说明及验收记录。
- `scripts/verify-static-delivery.mjs` / `pnpm test:delivery`：非特权独立 Nginx 上运行正常产物回归；临时同输入重建与 fault 构建模式隔离检查；实际构建更新及浏览器刷新演练。不添加新应用接口或运行时服务，不自动配置真实部署。
- `tests/e2e/static-delivery.spec.ts`：沿用 HTTP/浏览器公开入口验证交付；只在 Nginx 目标运行，不把 Vite 行为充当 Nginx 证据。`playwright.config.ts` 增加外部 Nginx 目标，排除独立开发故障测试，不启动 Vite。

## 条件追踪

| 08 条件 / 关联 AC | 结果 | 实际证据 |
| --- | --- | --- |
| 固定工具/依赖，可复现构建及维护说明（AC-19） | 通过 | frozen-lockfile 安装；类型/测试/构建入口；临时副本相同输入的 index 和 JS/CSS 名称、字节一致 |
| 正常装配隔离，无真实服务或凭据（AC-17/19） | 通过 | 正常 Nginx 产物执行全部非 fault 浏览器流程；`?fault=1` 不改变正常详情；临时 `build --mode fault` 的 index 和 bundle 与正常产物字节一致；正常装配沿用既有虚构数据 |
| 有效详情直达、刷新、未知页和状态分离（AC-13/19） | 通过（模拟浏览器） | Nginx `/dynamics/90071992547409934` 可看图、刷新、返回；`/unknown.page` HTTP200+“未找到页面”，`/dynamics/id.with.dot` HTTP200+“动态不存在”；普通读取失败由既有 Adapter/独立 fault 回归验证，不给正常产物加故障开关 |
| 缺失脚本/样式/图片为资源错误，不回退入口或成功缓存（AC-18/19） | 通过 | `/assets/missing.js`、`.css`、无扩展名文件；素材目录版本/未版本/无扩展名文件；缺失头像路径均404、no-store，响应不含应用root |
| 缓存分类与实际产物一致（AC-19） | 通过 | 从实际入口提取JS/CSS地址：200、正确MIME、immutable一年；版本PNG与头像同策略；default-avatar.svg与素材目录README为no-cache；入口no-cache且ETag/修改时间条件请求304 |
| 明确资源路径，不以页面扩展名推断（AC-13/19） | 通过 | 带点号ID、`/unknown.page`仍获入口；`/assets/no-extension`和`/demo-images/no-extension`仍404 |
| 素材版本/适当缓存，按URL请求，不外链/代理（AC-17/19） | 通过 | 现有.v1.png/SVG，版本文件不得改同URL内容；既有图片测试在Nginx下检查含参数的完整URL、真实小缩略图、按需预览，无B站/OSS代理 |
| 执行详情/刷新/未知页/缺失资源/缓存/构建更新（AC-19） | 通过 | 专项10/10；真实构建B并切换current，旧ETag获得200新入口，新旧哈希脚本均200，浏览器刷新执行B并能看图 |
| SPA前端未找到与HTTP404分开，不加SSR（AC-13/19） | 通过 | 页面未找到和内容不存在为入口200；资源错误单独404；无应用服务器 |
| 正常产物图片懒加载、按需预览、核心导航及已有回归 | 通过 | 真实Nginx正常产物92/92（既有82+新增10），含图片request观察及导航/历史/讨论组合；独立类型检查、Vitest、开发fault回归、preview及build均通过 |
| 记录真实Nginx环境和验证结果，不冒充 | 通过 | Nginx1.28.0配置检查及独立运行，见环境和执行记录；Vite结果单列 |
| 本期素材/未来OSS与2核2GB边界 | 通过（说明交付） | 部署文档明确浏览器OSS直连、无代理；容量仅目标，后端/数据库/爬虫另行评估，不声称云部署或压测完成 |

## TDD 与执行记录

接缝沿用已确认的 `DynamicReader`、公开页面和 Playwright URL/浏览器边界；HTTP 头与状态是本票部署验证，不新增应用测试接口，不断言私有组件/Hook。

- 先用临时通用SPA配置运行新专项：4个HTTP用例在桌面失败（无缓存头、缺失JS错误返回200入口）；说明验证确实能识别交付问题。页面用例初次因预期文案“页面未找到”与现有“未找到页面”不同失败，修正测试文案，不改前置功能。
- 交付配置接入后HTTP回退/缓存通过；首次额外失败是将素材README默认MIME误预期为octet-stream；该文件不承诺MIME，改为只验证未版本化策略。类型检查同时发现header/正则匹配和元组的可选值类型，补公开响应检查和明确元组类型后通过。
- 专项单文件最终 **10/10**，并通过相同输入重建、fault模式隔离和真实构建更新。发布A脚本 `/assets/index-DP_Yysth.js`，更新演练B脚本 `/assets/index-BHtFncjl.js`；B只存在于临时源码/产物，真实源码未加执行标记。

提交前完整执行：

```bash
pnpm typecheck
node --check scripts/verify-static-delivery.mjs
pnpm test
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost pnpm test:e2e
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost pnpm test:e2e:preview
NGINX_BIN=/tmp/dynamics-nginx.5kb6zf/nginx-1.28.0/objs/nginx \
NGINX_MIME_TYPES=/tmp/dynamics-nginx.5kb6zf/nginx-1.28.0/conf/mime.types \
pnpm test:delivery
pnpm build
git diff --check
```

结果：

- 类型检查、脚本语法检查通过；Vitest **89/89，9文件**。
- 开发浏览器 **90通过、10按目标跳过**；正常/故障装配的既有90项全部通过。跳过的是仅限真实Nginx的新增10项，不是隐藏失败。
- 正常Vite preview **82通过、10按目标跳过**，不作为Nginx证据。
- 真实Nginx正常产物 **92/92通过，无跳过**；专项10项在此实际执行，已有正常82项全部回归。独立构建、同输入重建、fault模式产物字节检查、真实更新后条件请求与Chromium刷新执行检查通过。
- `git diff --check` 通过。未改应用源码或前置验收记录，未实现09。

## 双轴审查

审查基线固定为开始HEAD `174cded5c22071dc538116272400fcac59a47184`。提交前使用包括新增文件的完整暂存差异 `git diff --cached 174cded5c22071dc538116272400fcac59a47184`；尚未提交时三点HEAD差异为空，因此不制造临时提交，以暂存差异分别派发只读 Standards/Spec 两名 `review` 代理。两名只读review代理并行审查；代理未运行测试，执行证据来自主线程实际命令。

### Standards

首轮0书面标准硬违规、4项启发式判断：同输入/fault产物检查重复、logs目录可能无用、server字符串命名含混、测试[path, cache, mime]三元组可能Data Clumps。已抽出 `assertSameBuild` 统一检查，并重命名为 `serverBlock`；小型测试元组保留，不为固定表格增加抽象。logs目录删除后实测Nginx在解析 `error_log stderr` 前仍尝试打开默认 `logs/error.log`，虽然用例10/10及更新演练通过，但启动出现alert；恢复该目录并加说明，因此不是死代码。README两处标点前空格已清理。标准轴最主要的重复检查已处理，没有确认硬违规。

### Spec

首轮0确认缺陷、0缺失要求、0越界产品能力。代理确认路径/点号页面、缓存/错误响应、真实构建更新与正常装配隔离、文档和勾选均符合08；另有2项非缺陷说明：示例监听本机端口已明确需由维护者调整生产监听；重复构建校验只比较入口和assets字节，不宣称对public素材做跨平台字节证明。Spec轴无最严重缺陷，09最终复验明确未完成。

首轮汇总：**Standards 0硬违规、4启发式（2修复、1实测说明保留、1弱判断保留）；Spec 0确认缺陷、2非缺陷说明。** 两轴独立，不合并排名。审查修改后重新运行专项10/10、类型检查及更新演练，并再次完整执行本文命令：**Vitest89/89、开发90通过+10目标跳过、preview82通过+10目标跳过、真实Nginx92/92、重建/fault隔离/更新演练/类型检查/构建全部通过**；Nginx恢复启动日志目录后无alert。

二轮Standards确认首轮修复，0硬违规，新增3项非阻断判断：缓存头在配置/脚本/测试跨语言重复、Nginx各location显式no-cache重复、注释“警告”应精确为alert。前两项保留：配置必须自包含，测试期待值须独立，不让测试读取配置重算预期；Nginx显式location规则比新增map更直接。第三项已仅改注释为alert，不改变执行逻辑。二轮Spec仍0确认缺陷、0缺失、0越界，提示2个已文档化边界：未声明的未来资源命名空间可能走SPA兜底，新增public路径须补规则与验证；本机监听示例不等于生产监听配置。资源命名空间以当前实际产物为依据，不以扩展名猜测所有未来路径。

最终分别结论：**Standards 0硬违规，剩余非阻断启发式已说明；Spec 0确认缺陷，已声明资源契约和环境边界。** 无未处理阻断问题；最后只回填本文和调整注释，不修改已复验的运行逻辑。

## 未验证与边界

- 已实际验证本机Nginx，不是Vite替代；没有配置阿里云/生产Nginx、域名/TLS、OSS/CDN、CI或自动发布，没有评估真实服务器并发、流量、内存与容量。2核2GB不是容量保证。
- 桌面/Pixel7为Chromium模拟，不是Android/iOS真机或Safari/Edge。09须对最终集成产物完成自己的跨设备和静态交付复验，不用本记录宣称09或全部AC-20完成。
- 示例面向域名根路径；子路径部署、额外资源命名空间、未来OSS权限/CORS/签名过期需另行设计与验证。未穷举任意HTTP方法、异常网络或所有缓存代理组合。
- 更新演练验证一个真实构建变化和浏览器刷新，不等于生产发布、回滚平台或无限旧资源保留策略；线上清理窗口由维护者按已打开页面/缓存期限评估。
- 普通读取失败由公开Adapter和专用开发故障装配回归验证；正常静态产物不提供注入故障的控制面板/参数。图片坏图的局部应用行为沿用既有网络边界测试；缺失静态资源的服务器404与缓存另有真实HTTP证据。
- 编译/执行只用用户临时目录；无系统服务或生产基础设施安装/变更。当前分支提交，暂不推送。
