# #33 本轮视觉补充证据（不作签收）

## 实际产物

- **完整重跑**：[runs/2026-10-18T12-21-26.119Z/conditions.json](runs/2026-10-18T12-21-26.119Z/conditions.json)。北京时间 2026-10-18 20:21:26–20:21:45；四页面×四宽度的 **16 张完整 PNG** 全部落盘；均 `overflow=false`、字体/图片与主栏量测稳定，未观察到 HTTP、脚本、控制台或图片加载错误。
- 该目录的 `{list,scope,detail,manage}-{360,390,768,1280}.png` 分别对应 `/ups/740` 单卡双图、`/ups/710` 单 UP、`/dynamics/710001` 纯文详情（3 根评论、首根 3 回复预览）及只读 `/manage`。视口高度900，DPR1，缩放100%，Asia/Shanghai；PNG为完整文档，不限高900。
- 独立实现裁区：[根本体596×119](runs/2026-10-18T12-21-26.119Z/root-comment-region.png)、[首条回复516×88](runs/2026-10-18T12-21-26.119Z/single-reply-region.png)、[入口150×44](runs/2026-10-18T12-21-26.119Z/reply-entry-region.png)、[完整当前预览组516×308](runs/2026-10-18T12-21-26.119Z/reply-preview-group-region.png)。根本体从公开根 `li` 顶端裁至回复 `section` 顶端，未包含嵌套回复；DOM 原始矩形与头像/时间/点赞矩形均在条件 JSON。来源裁区与实现元素矩形不共享相同 DOM 外边界，不能凭裁片左／上留白直接判页面缩进；当前实现根／回复头像 x=362／422，相对缩进60 CSS px，需结合完整页面及相对锚点核验。
- [capture.log](capture.log) 与本目录最初16张 PNG、[conditions.json](conditions.json) 保留**首次失败**：完整截图已生成，但独立区域因视口外 clip 报 `Clipped area is either empty or outside the resulting image`，后续处理因缺少回复区域文件中断，未生成对照页。只修一次性脚本为文档坐标 `fullPage + clip`，在新子目录串行重跑，未覆盖首次截图；[capture-retry.log](capture-retry.log) 留存重跑输出。修正首次裁图错误时，未改产品CSS、产品回归断言或测试超时；采集后另新增预期JS名校验，不是放宽原校验。首轮遗留的根裁片只有596×2，是无效区域示例，不能用作比较；完整有效裁区只看重跑目录。采集后 review 仅将来源 `basis` 的“用户已核实”误标改为“代理按本地图定位、非用户签收”，澄清完整三条预览组缺来源的措辞、补充裁区坐标系边界和脚本的预期 JS 名校验；没有更改 PNG、原始 stdout、失败字段、数值或取得时刻。当前脚本不是首次失败时的旧版本。

## 版本与取材边界

生产页面实际加载 `index-DLXpqo1_.js`，SHA-256 `6ff6060d4f85d24e5e9364bacd100bee22c2ba33ccea68aecbbafa3b2a2556be`；产品修复定位 `d2bbeef`，仓库记录时 HEAD `057921bc182626a743a8ea158f97f3482e4a4c70`，二者不混同。自动化 UA 为 HeadlessChrome/145.0.7632.6，不冒充用户 Chrome/155；完整 UA、字体状态、系统字体探测、各主栏 rect、请求方法及实际时刻见条件 JSON。`document.fonts.check` 可经字体回退返回 true，不据此确认来源或实际逐字字体。

只用已知本地图 `docs/assets/ui-reference/current-35/{dynamics-list,dynamic-detail}.png`，尺寸与源 SHA-256 在条件 JSON。先读 `docs/README.md`、UI规范、acceptance32 §5、acceptance33 §9；开始时无 §11，后续已有 §11 亦已读取。未更改这些文档。

详情来源裁区 `(x0,y0,x1,y1)`：根本体 `(110,1210,1320,1390)`；完整回复组 `(110,1410,1320,1670)`；本地读图在空白 y1580 分成完整单条回复与入口两区。全部按 **0.5等比归一是假设基准**（动态作者头像约96→48），不是来源已知DPR；来源字体、CSS视口、缩放未知。归一后根605×90、单回复605×85、入口605×45、组605×130。并排不拉伸实现，只右/下最小补白，保留所有图标和容器，无业务内容遮罩或通过率。

**来源1条完整可见回复＋“共9条回复”入口；实现按SRS预览3条＋“共5条回复”入口。** 单条与整组分别看，不隐藏第2/3条、不搬动入口、不声明整组等高。单条裁片的来源是UP回复，而实现首条是普通读者，昵称颜色／UP徽标不能按同角色直接判差；当前完整预览组第2条才是UP。该角色差异已在临时页标注，不能据不同数据角色宣称风格相同或失败。根头像来源框约97图片px、实现40CSS px仅是候选待核差异，可能含装扮/边框，不自动判定或改CSS。完整三条预览组／展开25条、详情动态图片、评论图片没有完整来源样本，不自造；不妨碍比较已有可见区域。列表来源仅记录哈希，本轮独立并排聚焦评论/回复，不冒称完整列表/详情区域对照已覆盖。

## 临时对照页与责任

- 两设备同可信LAN可打开：**<https://192.168.8.20:18443/visual-assets/visual-check/index.html>**。临时自签证书/站点依赖既有活动服务，不重启、不构建、不改dist。
- 来源原图副本、原尺寸裁片、0.5归一与含来源并排图：`/tmp/bili-device-33-xMpA6LHL/visual-reference/2026-10-18T12-21-26.119Z/`。临时HTML及同目录静态图片位于 `/tmp/bili-device-33-xMpA6LHL/data-7gd100ie/assets/visual-check/`；**均不提交仓库**，不强制纳入 ignored 素材，不复制侧栏或登录账号信息。
- 实现PNG、条件JSON、日志、此说明及 [capture.mjs](capture.mjs) 可跟踪。采集脚本只写本证据目录和上述临时目录；采集子代理未改产品／测试／需求／既有验收MD或旧截图。同期3份验收记录变化属于主线程本次回填，不是他人产品改动；用户两个原有未跟踪Markdown未读写。
- 对照页只用同目录相对链接、原尺寸可横滚大图，无外链；完整预览组保留原位入口。管理仅受控UI初始只读截图，是同规则映射，不冒称有来源管理页。全部页面浏览器网络仅允许当前LAN hostname的GET，其他abort；无API/响应替换、外部B站/OSS访问或凭据读取；未点击任何管理按钮，未改N/目标。
- [首次页面校验](comparison-page-check.json)与[补正文案后校验](comparison-page-check-final.json)是两次独立临时命令，字段形状不同，均只针对当时20张图：360／1280、页面200、原尺寸加载、无外链／脚本错误／整页横溢出，不是产品像素签收。两份历史文件不由采集脚本生成、不覆写。现新增可重跑的 [check-comparison.mjs](check-comparison.mjs)，追加差分后实际[24图校验](checks/2026-10-18T13-02-00.050Z/comparison-page-check.json)通过，并留存自己的时间目录。
- 用户补充Chrome UA/1920×965 DPR1、当前CachyOS及管理/布局两端正常，属于用户自述证据；**仍无真机截图/Safari UA**。本轮自动化不是正式两设备截图或人工像素签收，不自动写通过结论。

## 差异图与旧入口复用边界

按 UI 规范补4张未遮罩原始帧差，沿用 `scripts/capture-visual-35.mjs` 的共同画布、白色右／下补齐、ImageMagick `-compose difference -composite` 算法。当前帧差于2026-10-18T13:01:59Z从已保存PNG后处理派生，不重截图、不改数值；[输入／输出哈希与方法](difference-artifacts.json)留仓库，含源差分PNG只在该元数据指向的 `/tmp`。脚本今后采集时会直接生成同规则差分。帧差左上对齐、没有坐标配准，来源与实现裁区边缘、角色、文字、字体不同都会显差；不计算通过率、不当作布局缺陷或正式像素结论。

旧入口可配主机／输出目录，但固定 `/`、`/ups/720` 等路径、双图选择与管理读取交互，没有本次独立评论／回复裁区和严格GET放行；且顶层启动浏览器、无可安全导入的纯函数。因此本附件保留一次性采集，不复制产品能力或另建通用框架；复用其差分规则，未把有采集副作用的CLI作为库导入。规范不要求必须执行旧CLI，未知来源DPR也不阻止按约定0.5核对已有可见区域。

## 一键重跑（仅既有本地依赖）

在仓库根目录、既有站点仍活动且两张ignored源图仍存在时执行：

```bash
source ~/.nvm/nvm.sh && nvm use 24.21.0 && \
  pnpm exec node .scratch/backend-integration/evidence/device-33/visual/capture.mjs && \
  pnpm exec node .scratch/backend-integration/evidence/device-33/visual/check-comparison.mjs
```

使用既有Playwright及`magick`（与旧视觉入口同一依赖），本轮未安装包。脚本串行执行，不启动/重置服务；发现本目录已有 `conditions.json` 后写入新的 `runs/<实际时间>/`，不覆写实现截图；临时对照页更新为该次输出。`/tmp` 被清理后不保证链接或来源附件仍存在，不将本附件变为产品入口或通用采集框架。
