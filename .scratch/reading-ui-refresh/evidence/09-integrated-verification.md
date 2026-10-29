# 09 组合回归、候选截图与隔离交付验证

本票把 01–08 的实现放在**同一个候选**上组合执行：真实隔离 API＋临时 SQLite＋生产 Adapter、
生产前端装配的浏览器用例、四宽度受控截图、本机隔离 Nginx 静态交付，以及必要的组合契约测试。
结论只覆盖已执行的部分：**视觉人工签收、真机（iPhone Safari／真实 Chrome 设备）、真实飞书深链接、
目标机／云部署均未验证**，全部留给票 10 与另行授权。

## 0. 一句话结论

- 同一候选上，阅读与管理的新行为可以组合成立：桌面多卡片内联评论/正文新标签、手机详情→热度后续页→
  跨页分支对话→恢复、通知定位锚点/后续页→对话→原访问恢复、直达/刷新/无来源、管理草稿/启停/删除隔离、
  scope 切换、只读边界都由真实隔离 API＋SQLite 与生产装配浏览器用例共同证明。
- `pnpm check`、`pnpm check:dist`、主 e2e、production、manage、location、delivery 与全量后端 pytest 在
  本候选上通过；本机隔离 Nginx 1.28.0 下三阶段静态交付（含旧路径、会话直达/刷新、资源、生产/mock 隔离、
  API 错误边界、发布与回退）通过。
- 四宽度（360/390/768/1280）候选截图 63 张已产出，与用户签收黄金图**全部存在预期差异**，黄金图未更新；
  `visual:compare` 现在会如实报告差异并写出差异图，不再因未定义的 `magick` 崩溃。
- 两处已知缺陷已按最小概念修复并取证：视觉比较脚本的 `magick`、三进程投递用例因通知闸门默认 `off`
  在 `beforeAll` 恒超时；另在交付演练中修掉一处被 04 标签标题变更暴露的陈旧回退断言（见 §1.3）。

## 1. 候选与基点

| 项 | 值 |
| --- | --- |
| 工作树 / 分支 | `/tmp/reading-ui-refresh-worktrees/09` · `wt/reading-ui-refresh-09` |
| 集成分支基点 | `spec/reading-ui-refresh` = `1d071c4`（实施前核对，与目标一致；期间上游无新提交） |
| 组合回归代码提交 | `b72d555`（后端组合契约＋测试夹具、前端三条组合 e2e） |
| 候选截图提交 | `703f931`（63 张 PNG + `conditions.json` + `diff-report.json`） |
| 截图记录的候选 | `sourceCommit = b72d555`，`sourceStatus` 为空（干净工作树） |

后续候选：11 的审查整改在整理前 `9bfdbaf` 上重跑了同一套门槛并更换了截图目录（`evidence/final-screens/`），结论见[最终双轴独立审查](final-independent-review.md)。本票的候选、截图与结论保持原样，作为历史取证；黄金图仍未更新。
| 环境 | Node v24.21.0 / pnpm 10.34.6；Python 复用主树 `.venv`（`UV_PROJECT_ENVIRONMENT` + `--no-sync`）；Chromium 145.0.7632.6（Playwright 1.58.2） |
| 端口 | 每个入口先现查再跑，串行独占；未触碰既有 `127.0.0.1:8000` 与 `192.168.8.20:4273`。Nginx 演练用 `DELIVERY_PORT=4401`，三进程 e2e 用 `DELIVERY_E2E_API_PORT=4402` / `DELIVERY_E2E_WEB_PORT=4403` |

### 1.1 三处修复（red → green）

| 缺陷 | red 复现 | 修复 | green 复现 |
| --- | --- | --- | --- |
| `frontend/scripts/compare-visual-baseline.mjs:151` 引用未定义的 `magick` | `pnpm visual:compare --current ../.scratch/reading-ui-refresh/evidence/09-screens` → `ReferenceError: magick is not defined`（预期差异时崩溃） | 差异图写入收进 `scripts/lib/visual-baseline.mjs#writeDiffImage`，与比较口径共用同一 ImageMagick 入口；`compare` 差异退出码 1 但文件已写好，允许非零退出，工具不可用仍报错 | 同一命令输出 63 张逐张差异（如 `up-specified-390.png` 10.098%），差异图写入 `test-results/visual-diff/`，退出码 1 表示“预期差异”，不是崩溃；黄金图、阈值、容差未改 |
| `frontend/tests/e2e-delivery` 因通知闸门默认 `off` 在 `beforeAll` 恒超时（04 已在 `01716b2` 基线复现） | 修复前运行：`INFO delivery_skipped reason=switch_off`，`等待超时：三链实际投递消息` | 只在测试初始化里改这台临时库：先断言 `GET /api/manage/notifications` 仍是生产默认 `{state: 'off'}`，再 `PUT {state:'all'}` 开启本链路所需发送；生产默认与通知语义未动 | 6/6 通过；`delivery_skipped` 不再出现，四项实际投递链接照常建立 |
| `frontend/scripts/verify-entry-update.mjs` 回退演练用入口静态标题比对 `document.title` | `pnpm test:delivery` 阶段 2 `page.waitForFunction: Timeout 30000ms`（04 起标题按路由决定，最后停在管理路由） | 改为与发布步骤同一判据：release B 的构建标记消失＋应用真的挂载；入口 HTML 仍按字节与旧产物比较，资源可达性断言不变 | `pnpm test:delivery` 三阶段全通过（§5） |

第三处修复是执行 09 才暴露的：它不属于本票“已知两项”，但不修就无法产出隔离交付证据，故以最小改动修复并在此登记。

### 1.2 组合测试（新增，未替代任何单票证据）

| 位置 | 装配 | 覆盖的组合 |
| --- | --- | --- |
| `backend/tests/test_reading_ui_integration.py` | 真实 FastAPI＋临时 SQLite，来源 HTTP 换成记账替身 | 排序先于分页（一级评论与回复）、入口资格跨页、关系不串父级/根/动态、旧时间 cursor 与定位兼容、读取零上游请求与零归档写入 |
| `frontend/tests/e2e-location/integrated-reading.spec.ts` | 生产装配＋实际归档 API＋本次运行独占 SQLite（虚构上游） | 桌面两卡独立排序/追加/回复页码→正文新标签（`opener === null`）→原列表不动→scope 切换；受控迟到的后续批不覆盖最后一次选择；手机列表评论入口→详情→楼中楼热度后续页→跨页分支对话→返回/前进恢复→回详情→回列表还原 scope 与滚动；一级评论批次锚点与回复第 3 页的通知定位→楼中楼/会话→原访问恢复；直达/刷新/无来源 |
| `frontend/tests/e2e-manage/management.spec.ts`（新增一条组合用例） | 生产装配＋实际管理/归档 API＋独占 SQLite | 阅读页无管理入口而独立地址可用；草稿不静默生效、保存不隐式启停、删除配置后归档与 scope 阅读仍在；通知总开关仍为生产默认 `off`；读取不触发采集 |
| `frontend/tests/e2e-delivery/three-process-links.spec.ts`（闸门初始化＋新增一条组合用例） | 实际 API＋独立采集＋独立通知三进程共享临时 SQLite，页面为生产装配 | 实际投递的回复链接→定位后续页→查看对话（上下文不完整的安全止步）→返回恢复原定位访问→刷新；并校正两处陈旧断言（见 §1.3） |

沿用既有 location / manage / delivery 装配，不新建平行测试框架；新增 spec 只落在既有项目目录内。

### 1.3 投递链里被闸门修复暴露的两处陈旧断言

通知闸门默认改 `off` 之后，delivery 用例从未再跑过，里面有两处与当前夹具/装配不一致的断言：

1. 一级评论链接目标 `860030` 在夹具里是“另一 UP 刚发表的评论”（`fresh_other`）。按时间序它是首批，
   原断言“目标不在首批（20 条）”不再成立。现断言它确实只出现一次在首批，并仍然被锚点定位；
   跨批定位由回复链接的第 3 页与 location 用例覆盖。
2. 三进程链路里采集进程按固定节拍持续检查，`last_checked_at`（以及再次同步时的时间戳）会自然前进。
   归档只读断言改为只锁定读取不该改变的内容与计数（正文、标题、作者、本地评论/回复数）。

两处都是**校正断言以匹配既有夹具语义**，没有放宽业务检查。

## 2. 真实 HTTP 与 SQLite 的组合契约结论

`backend/tests/test_reading_ui_integration.py`（6 例）在同一次请求序列里给出：

1. **排序先于分页**：25 条一级评论的按时间/按热度批次是两条不同顺序（`LATEST_ROOTS`/`HOT_ROOTS`），
   两批并集完整、交集为空、没有重复；25 条回复的热度第 1 页取到时间序第 3 页的高赞项，第二页是时间序
   第 3 页的倒序段。来源回复数 40 > 本地 25 时，`count`/`local_reply_count` 只用本地集合。
2. **入口资格跨页**：起点 `960002` 的 11 条对话在时间序第 1 页（3 条）、第 2 页（8 条）、热度第 1 页
   与定位响应里都是同一个 `{start_id,count,incomplete}`；热点项不在热度首页时入口也不丢。
3. **关系不串父级**：另一楼把父指针指到本楼回复时不会被合并；同名作者与相同正文前缀没有影响；
   父未保存（2 条、不完整）与互指环（2 条、不完整）都有限止步；跨根/跨动态/不存在一律 404。
4. **旧时间 token 与定位兼容**：一级评论的时间/热度冻结 token、回复的时间序 cursor 在若干热度读取后
   仍重放同一批；`reply_pages` 行未被热度读取新增或改写；一级评论定位按请求排序给出以目标开头的窗口
   （`earlier_count` 23/13），回复定位固定时间序第 3 页；定位与会话拒绝 `sort`（422）。
5. **请求账本**：全程上游请求为 0（任何请求都会记录并让用例失败），归档文档与 `archives`／`root_comments`／
   `replies`／`reply_sync`／`reply_pages` 行数不变。

浏览器侧的只读证明另有两处：location 用例读取前后 `/api/test/source-requests` 不变；delivery 用例在真实
三进程里读取投递链接前后 API 进程上游请求数不变。

## 3. 执行结果（本候选）

| 命令（`frontend/` 下，除注明外） | 结果 |
| --- | --- |
| `pnpm check` | 通过：`vue-tsc`＋32 个 Vitest 文件 / 346 例＋e2e 项目覆盖守卫一致 |
| `pnpm check:dist` | 通过：两次构建 + 产物隔离（`dist` 无 mock 入口/夹具/归档数据） |
| `pnpm test:e2e` | 235 passed / 18 skipped（5.0m） |
| `pnpm test:e2e:production` | 3 passed / 3 skipped |
| `pnpm test:e2e:manage` | 9 passed（含新增组合用例） |
| `pnpm test:e2e:location` | 16 passed（含新增 3 条组合用例） |
| `DELIVERY_E2E_API_PORT=4402 DELIVERY_E2E_WEB_PORT=4403 pnpm test:e2e:delivery` | 6 passed |
| `pnpm test:nginx-parity` | 通过（片段安装路径与两阶段只读/鉴权结构一致） |
| `pnpm visual:baseline`（`VISUAL_OUT_DIR=…/09-screens`） | 6 passed：63 张四宽度截图 + 布局/触控/焦点审计 |
| `pnpm visual:compare --current …/09-screens` | 预期差异：63/63 张不同，退出码 1；差异图已写出（不再崩溃） |
| `pnpm visual:diff-report --current …/09-screens` | 字节完全相同 0 张；63 张有像素权重差；最大比例 17.854% |
| `pnpm test:delivery`（`NGINX_BIN=/tmp/nginx-16/nginx-1.28.0/objs/nginx`、`DELIVERY_PORT=4401`） | 三阶段全部 PASS |
| 仓库根 `uv run --no-sync pytest backend/tests -q` | 1255 passed（首次 11m22s，复验 11m29s；含新增 6 例） |

测试数据来源：一级评论/楼中楼为 `backend/tests/live_app` 与 `backend/tests/fixtures/*.json` 的虚构上游；
截图内容为受控 DTO + 固定 SVG；三进程链路的身份、动态、评论、凭据全部虚构。真实 B 站、真实飞书、
真实 OSS 均未访问。

## 4. 四宽度候选截图与视觉检查

- 候选：`sourceCommit b72d555`（干净工作树），目录 `.scratch/reading-ui-refresh/evidence/09-screens/`。
- 63 张，按 360/390/768/1280 覆盖：列表/单 UP 列表、详情、评论区、图片预览、窄屏楼中楼、宽屏回复区、
  空态/错误态/未保存/不存在、管理列表/单 UP/指定模式/未授权/未知 UP、UP 条错误与长昵称。
- 布局与触控审计同一次运行断言通过：四宽度无横向溢出、既有 6 行折叠高度、控件点击区 ≥44px、
  管理控制行右对齐、按钮视觉 32/36px、输入字号手机 16px / 桌面 14px 而基础字号仍 14px、焦点可见。
- 与用户签收黄金图（`frontend/tests/visual-baseline/`，候选 `89d0b49`）的差异是这轮排版的预期结果，
  逐张数值见 `09-screens/diff-report.json`；**黄金图未更新**，`visual:golden` 未运行，由 10 人工确认后
  才按既有流程处理。
- 每类视觉变化的设计依据：文案与阅读壳 §2／§3.1（UI-01/02）、UP 条 §3.2（UI-03）、详情页头与新标签
  §3.1（UI-04/06）、评论区与回复字号/控件 §4（UI-08/12）、会话页返回控件 §5.2（UI-11）、排版标尺与
  输入字号 §6（UI-12/14）、管理控制行与按钮 §7（UI-13）。

## 5. 隔离静态交付（本机 Nginx，不碰正式库与真实部署）

- 方式：`pnpm test:delivery` 用临时编译的 Nginx **1.28.0**（与票据 16 同版本，`/tmp/nginx-16/…`），
  `DELIVERY_PORT=4401`（现查空闲）；产物、workspace、SQLite、API/collector 都在临时目录，脚本结束时删除并
  重建生产 `dist/`。
- 结果：三阶段全部 PASS。
  - 阶段 1：显式 mock 构建的阅读/缓存/404、构建可复现、发布回退；`static-delivery` 用例覆盖旧路径
    （`/`、`/index.html`、`/ups/:id`、`/manage`、`/manage/ups/:id`、`/dynamics/:id`、`/dynamics/:id/comments/:rootId`）
    与新增会话路径 `/dynamics/:id/comments/:rootId/replies/:replyId/conversation` 的直达/刷新（200 + 入口 HTML +
    重新验证缓存头），哈希资源长期缓存、缺失资源 404 且不回退入口、API 404/422 保持 JSON。
  - 阶段 2：入口原子更新到 release B → 回退到 release A；旧/新入口引用资源仍可达，回退后浏览器加载旧产物并挂载，
    导航不请求 4xx 资源。
  - 阶段 3：生产构建＋实际 API/collector：六条路由 direct/reload、30 个哈希资源、应用自有图片、只读浏览、
    API 与资源错误边界、管理 401 提示与凭据扫描；产物原子切换与回退后 SQLite 文件未替换、collector 未重启、
    归档内容不变；API 不可用时 502 且不泄露诊断。
- 未做：目标机/云部署、系统 Nginx reload、真实发布目录写入、持续运行观察；`test:http`（局域网真实非 localhost）
  与真机自检留给 10。`/usr/bin/nginx`（1.30.6）本次未使用，版本口径无混用。

## 6. UI-01–UI-15 台账

证据层级缩写：**M**=mock 装配；**D**=生产 Adapter + HTTP 传输替身；**R**=实际隔离 API＋临时 SQLite（生产装配）；
**V**=受控截图/布局审计；**N**=本机隔离 Nginx 交付；**真机**=实际设备（本票无）。

| 项 | 实现（票/提交） | 执行入口 | 结果 | 层级 | 未验证 |
| --- | --- | --- | --- | --- | --- |
| UI-01 文案 | 01（`b018a88`）、08（`8044350`） | `tests/e2e/app-shell.spec.ts`、`manage.spec.ts`、`e2e-manage` 真实 API 文案断言 | 通过：阅读/管理生成文案统一“动态”，保存动作按语义改写；来源正文未改 | D、R | 来源真实文案抽样（无真实上游） |
| UI-02 顶栏与管理隔离 | 01（`8141cb4`） | `app-shell.spec.ts`；`e2e-manage` 组合用例 | 通过：阅读页无公共顶栏与主导航；`/manage` 独立地址可用 | M、D、R | 真机观感 |
| UI-03 UP 条 | 01（`61db5bf`，`69a2e96` 修测量时序） | `list.spec.ts`、视觉审计（四宽度长昵称/横滑/隐藏滚动条/12px 留白） | 通过 | D、V | 触摸板/真实触屏手势 |
| UI-04 手机入口与返回 | 04（`43164d2`） | `detail.spec.ts`、`thread.spec.ts`；location 组合用例（列表→详情→…→回列表还原 scope 与位置） | 通过 | D、R | 真机返回手势 |
| UI-05 桌面卡片评论 | 03（`ce71eca`） | `list-comments.spec.ts`；location 组合用例（两卡独立排序/追加/回复页码） | 通过 | D、R | 窄屏不提供内联（按设计） |
| UI-06 桌面正文新标签 | 04（`43164d2`） | `list-comments.spec.ts`；location 组合用例（`opener === null`、标题、无页头、刷新、原列表 URL/滚动/状态不变） | 通过 | D、R、N（会话/详情路由静态可达） | 真实浏览器窗口管理差异 |
| UI-07 图片与内部控件 | 01/03/04（图片沿用既有预览层） | `dynamic-images`/`comment-images`/`preview-*` 用例；视觉审计预览态 | 通过 | M、D、V | 真实来源图片与真机手势（既有 15 证据单独存在） |
| UI-08 排序与跨页 | 02（`0b872ab`）、05（`a473152`） | 后端组合用例；`e2e-location/reply-sort`；location 组合用例受控迟到 | 通过：排序先于分页、切换复位、迟到成功不覆盖 | R | 真实上游数量波动 |
| UI-09 对话门槛与分支 | 06（`ee70c8d`、`bd1495e`） | 后端组合用例；`e2e-location/conversation`；location 组合用例 | 通过：单条无入口、A→B 有入口、分支全含、跨页不截断 | R | — |
| UI-10 缺失关系/同名 | 06 | 后端组合用例；`conversation`（缺祖先/异常环）；delivery 组合用例 | 通过：只在断点止步，不按名字拼接 | R | — |
| UI-11 会话阅读与返回 | 06、07（`5f87a82`、`a60b3bb`） | `conversation`、location 组合用例（返回/前进恢复排序页码位置）、delivery 投递链接用例 | 通过 | R | — |
| UI-12 排版与触控 | 01、02、05、08 | `pnpm visual:baseline` 布局/触控/焦点审计；`e2e/manage.spec.ts` 四视口断言 | 通过：无横溢、6 行折叠、点击区 ≥44px、字号层级 | V、D | 真机字体回退与缩放 |
| UI-13 管理按钮与语义 | 08（`8044350`） | `e2e/manage.spec.ts` 四视口右对齐/32-36/44；`e2e-manage` 组合用例（草稿/启停/删除隔离） | 通过 | D、R、V | 真机触控精度 |
| UI-14 输入字号与真机 | 08 自动化；实机留 10 | `e2e/manage.spec.ts`（手机 16px / 桌面 14px，基础字号不变）；视觉审计 | 自动化通过 | D、V | **iPhone Safari 聚焦/失焦、页面缩放、键盘可用性**（旧限制未关闭） |
| UI-15 只读、直达与交付 | 04–07 各自链路；09 组合 | 后端请求账本与行数；location/delivery 上游计数；`pnpm test:delivery` 三阶段；`check:dist` | 通过：读取不请求 B 站、不写归档；旧路径与会话路径直达/刷新、生产/mock 隔离、API 错误边界 | R、N | 真实上游、真实飞书、目标机部署、局域网 `test:http` |

台账复核：11 复核发现 UI-01 当时仍漏了列表页签标题与图片状态占位文案（旧“归档”用语），已在 11 修复并重跑断言。本行“通过”只按当时已覆盖的可见范围成立，UI-01 的最终口径以[11 证据](final-independent-review.md)为准。

## 7. 可重放样例

```bash
REPO=/home/kevin/Projects/PI/bili_charge_dynamics
WT=/tmp/reading-ui-refresh-worktrees/09
export UV_PROJECT_ENVIRONMENT=$REPO/.venv
# 该工作树没有自己的 .venv 时，三进程 e2e 需要它（脚本按 <.venv/bin/python> 启动子进程）：
ln -s $UV_PROJECT_ENVIRONMENT $WT/.venv        # 仅本机临时，gitignore 外，收尾删除
cd $WT/frontend && . "$HOME/.nvm/nvm.sh" && nvm use
pnpm install --offline --frozen-lockfile

# 端口先现查，避免与其它运行相撞
for p in 4177 4178 4324 4325 4318 4319 4320 4321 4322 4401 4402 4403; do
  ss -ltn "sport = :$p" | tail -n +2 | grep -q . && echo "BUSY $p"; done

pnpm check && pnpm check:dist
pnpm test:e2e && pnpm test:e2e:production && pnpm test:e2e:manage && pnpm test:e2e:location
DELIVERY_E2E_API_PORT=4402 DELIVERY_E2E_WEB_PORT=4403 \
  NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost pnpm test:e2e:delivery
VISUAL_OUT_DIR=../.scratch/reading-ui-refresh/evidence/09-screens pnpm visual:baseline
pnpm visual:compare --current ../.scratch/reading-ui-refresh/evidence/09-screens   # 预期差异，退出码 1
pnpm visual:diff-report --current ../.scratch/reading-ui-refresh/evidence/09-screens
NGINX_BIN=/tmp/nginx-16/nginx-1.28.0/objs/nginx \
NGINX_MIME_TYPES=/tmp/nginx-16/nginx-1.28.0/conf/mime.types DELIVERY_PORT=4401 pnpm test:delivery

cd $WT && uv run --no-sync pytest backend/tests -q
```

代理变量：除 visual 配置自动补 `NO_PROXY` 外，其余入口需手工 `NO_PROXY=127.0.0.1,localhost`（本机有代理监听）。

## 8. 已知限制

1. 截图与视觉结论只来自 Linux Chromium 145；字体回退、输入框聚焦放大（旧 iOS 限制）与触控手感需真机。
2. `visual:compare` 在本候选上**必然失败**（01/08 的排版是本轮预期变化），差异数值仅供 10 判断；黄金图未更新。
3. 三进程投递链只证明本机隔离装配；真实飞书群、真实凭据、真实网络与代理可达性未验证。
4. 隔离 Nginx 只在本机回环 1.28.0 上验证；目标机、云环境、systemd 与持续运行未验证，`/usr/bin/nginx` 1.30.6 未使用。
5. 真实 B 站上游、OSS 上传与真实归档规模未参与；排序/关系/分页结论来自小样本地集合（25 条评论、25 条回复）。
6. 管理组合用例在同一隔离库上串行执行，依赖文件内测试顺序（既有约定）；不影响生产语义，但并行化前需重排。

## 9. 票 10 待人工确认清单

1. 在 1280 与 375/390 的真实 Chrome 上确认：阅读去顶栏与页面身份、UP 条长昵称与留白、正文新标签、
   详情无页头、管理控制行右对齐与按钮视觉/点击区。
2. 用 iPhone Safari 实机确认：输入字号 16px 后是否仍聚焦放大、键盘遮挡与可操作性，再决定旧限制是否关闭。
3. 对 `09-screens/` 的 63 张候选截图逐张确认（含空态/错误态/管理态），确认后才更新黄金图并写原因。
4. 真实飞书深链接（动态/一级评论/楼中楼回复）在真实客户端与手机上的打开、返回与定位。
5. 真实 B 站上游与真实归档量下复核排序、对话与分页观感（本票只用小样虚构数据）。
6. 目标机部署前的 Nginx/systemd/证书/备份演练与上线授权（本票未授权、未执行）。
7. 触屏横滑 UP 条、图片预览手势与返回手势的真机手感确认。
8. 管理页 360px 下真实设备的长昵称换行与按钮不遮挡相邻控件的确认。
9. 采集/通知三进程在目标环境的资源占用与重启行为（本票只在本机隔离验证）。
10. 若 10 要求关闭 `UI-14` 的旧 iOS 限制，需以实机证据更新设计 §6 与前端 README 的已知限制说明。

## 10. 复验记录

- 实施前核对 `spec/reading-ui-refresh` 的 tip = `1d071c4`（与任务给定的基点一致）；本票合入前再次核对，
  上游无新提交，未发生 rebase/冲突。
- 全部命令在 `b72d555`（组合回归代码）与 `703f931`（截图）之上执行；文档提交不改变代码与产物。
- 报告前在最终 HEAD（文档提交之后）整批复跑，结果与上表一致：`pnpm check` 通过（346 例）、`pnpm check:dist` 通过、
  主 e2e 235 passed / 18 skipped、production 3 passed / 3 skipped、manage 9 passed、location 16 passed、
  delivery 6 passed、`test:delivery` 三阶段 PASS（阶段 1 的 `static-delivery` 10 passed）、
  `visual:compare` 仍是 63/63 预期差异（退出码 1、无 `ReferenceError`）、后端全量 1255 passed（11m29s）。
- 集成分支 tip 复验：`spec/reading-ui-refresh` 仍为 `1d071c4`，本票无 rebase 与冲突；工作树除本机 `.venv` 软链（不入库、
  收尾删除）外干净。
