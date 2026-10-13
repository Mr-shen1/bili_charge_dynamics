# 18 楼中楼阅读、局部恢复与详情历史：自动化证据

## 范围与装配

交付 [18](issues/18-reply-reading.md) 的生产回复阅读；复用 #16 评论区、#17 归档 API/Adapter、原讨论请求协调和详情访问快照，不新增回复导航或采集链路。父 [05](issues/05-replies.md) 的采集部分仍以 [17证据](acceptance-17.md) 为依据，本票不改写其结论，不自动收口父票。

- 服务端顺序首3、续10；25条累计3/13/23/25，终页不再请求。来源零不读回复，未知不补零；来源数与本地完整归档数、当前可见范围分开。
- 收起恢复最多3条可见范围，保留已读数据、cursor及文本展开；再次展开复用。切根评论排序重置回复，按当前动态作者ID标UP而不是昵称或全局creator。
- 读取状态保留ReplyBatch所有元信息并随该次访问快照恢复。成功空不冒充成功采集：pending/failed/unconfirmed独立提示，有旧归档仍可读；部分归档终页只表示本地已读完。采集失败提示不会提供伪装采集重试的读取按钮。
- 普通读取失败原根原批重试；失效cursor保留已有内容，仅显式重新开始才清空该根内容/cursor/展开并无cursor首读3条，不影响其他根。
- 请求防重与忽略取消的旧成功/失败/完成隔离沿用现有协调；没有写回、回复图、转发、上游读取或隐式同步。

## 已确认测试入口与 RED → GREEN

规格T1/T2为用户已确认seams，不新增私有方法/SQL测试面。

`tests/archive-replies-app.test.tsx`经真实`createArchiveReader`、HTTP传输替身和页面操作：

| 纵切 | RED | GREEN |
| --- | --- | --- |
| 首次采集失败但GET成功空 | 页面错误显示暂无回复，缺失败及计数提示 | 保留逐根失败和独立计数 |
| pending/unconfirmed | 2项缺状态提示 | 分别表达未完成/未确认 |
| CURSOR_INVALID | 通用失败/原cursor重试，无显式恢复 | 独立提示，用户重启对应根首批，其他根保留 |
| 部分归档终页与缺尝试状态 | 2项把本地结束/未知当作完成 | 本地已读完、未知尝试状态按未确认表达 |
| 审查：续页省略可选元信息 | 已知状态/计数在追加后消失 | 合并保留旧元信息，新值及明确null仍覆盖旧值 |

后续生产3/13/23/25、原cursor重试、收起及历史恢复、成功空/零来源回归直接通过，不冒称新增RED。临时过程日志 `/tmp/18-replies-*-red.log`仅为本地辅助证据，版本化测试与命令可复现。

既有`tests/replies-app.test.tsx`验证根级首次/追加失败隔离、同批连点、原批重试、收起中追加、服务端顺序及身份/安全文本兜底；`tests/discussion-history.test.tsx`验证同动态多访问、排序/评论/回复/文字范围与cursor隔离、读取中离开/历史返回、忽略取消的旧成功/错误/拒绝与完成失效。保留原导航、阅读位置与文本测量实现，不另建恢复机制。

## 实际 HTTP / SQLite 浏览器证据

`tests/e2e-archive/replies.spec.ts`通过公开管理/目标/initial入口，把结构真实、内容虚构的根/回复JSON写入临时SQLite；关闭重开API并令上游离线，再由生产Adapter读取实际HTTP：

1. 25回复来源倒序、同时间字符串ID并列及缺时间，验证服务端完整集合正序3/13/23/25、cursor、收起复用和结束不再请求；零来源根没有回复区域。
2. 实际6行不折叠、7行折叠/展开；emoji/换行/长URL/脚本安全文本、四宽度无横向溢出、只读身份/点赞、UP标识按ID及缺头像/作者/时间/正文兜底。
3. 同动态两个详情历史访问各自保留最热/最新、40根、13/23回复、根/回复文本展开、不同锚点位置；back/forward无需重读，分别从已保存cursor继续最后批。主动顶部和气泡入口不继承旧位置，切排序重置回复/文字展开。

双访问场景通过原生浏览器History seam注入列表访问（`history.pushState(null,...)`与`PopStateEvent`），再用生产卡片/气泡进入两个详情，真实back/forward恢复；不注入导航控件或修改应用会话快照。中间列表访问不是应用点击导航，不能据此宣称应用自身列表往返语义全部验证；它不代表新增用户可见导航入口。实际六行使用390px布局测量，另验证360/390/768/1280px无溢出。

新增首个RED：无回复fixture时期待3条、实际0条；增加必要回复分页响应及虚构fixture后GREEN。新spec重复三轮9/9通过，完整归档套件11/11通过。局部读取失败/乱序主要由RTL受控Reader验证，不声称在真实HTTP浏览器装配注入了这些故障。原mock/fault浏览器完整回归同时覆盖有界阅读位置后备与用户滚动优先，不能替代真实设备。

## 执行结果

Node命令先`source ~/.nvm/nvm.sh && nvm use`，Node24.21.0、pnpm10.34.6；Python仅uv。

| 命令 | 结果 |
| --- | --- |
| `pnpm test tests/archive-replies-app.test.tsx` | 8通过 |
| `pnpm test tests/replies-app.test.tsx` | 14通过 |
| `pnpm test tests/discussion-history.test.tsx` | 18通过 |
| `pnpm test tests/archive-reader.test.ts` | 28通过 |
| `pnpm test tests/archive-app.test.tsx` | 16通过 |
| `pnpm test tests/comments-app.test.tsx` | 22通过 |
| `pnpm typecheck` | 多次通过 |
| `uv run pytest backend/tests/test_replies.py -q` | 27通过 |
| `uv run --no-sync pytest backend/tests/test_replies.py backend/tests/test_root_comments.py` | 52通过 |
| `pnpm test --maxWorkers=2` | 20文件、198通过 |
| `uv run pytest backend/tests -q` | 208通过，既有Starlette/AnyIO弃用警告1项 |
| `pnpm build` | 生产构建通过 |
| `pnpm test:e2e:archive` | 11通过，含3项新增回复实际HTTP联测 |
| `pnpm test:e2e:archive replies.spec.ts --repeat-each=3` | 9通过 |
| `pnpm test:e2e:manage` | 2通过 |
| `pnpm test:e2e`（隔离网络） | 104通过、10跳过（静态Nginx专用项） |

用户已有服务占用原mock/fault固定端口，不停止或复用它。沿用独立网络命名空间运行mock/fault回归：

```sh
unshare --user --map-root-user --net -- bash -c \
  'ip link set lo up && env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy -u E2E_TARGET NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1 pnpm test:e2e'
```

实际归档套件使用localhost NO_PROXY及清除代理环境；不与管理套件同时争用4176测试API。最终日志在`/tmp/18-final-vitest.log`、`18-final-backend.log`、`18-final-typecheck.log`、`18-final-build.log`、`18-final-browser.log`、`18-final-archive.log`、`18-final-manage.log`；临时日志不是跨机器必备证据。

审查后并行多套件运行出现1项RTL 5000ms超时及1项既有移动预览初开失败；隔离历史RTL18/18和移动失败场景重复5/5通过。串行全量另暴露根评论UP断言把异步加载的回复UP标记也包含在内，非生产身份错误：将原断言限定为所属根评论自身，保留回复身份的独立断言。移动图片分支测试在首次点击前等待公开浏览器历史访问标记就绪，避免混入会话初始化竞态；未改生产导航，也未延长超时/移除断言。最终串行全量198项、typecheck/build及104项mock/fault浏览器再次通过，归档11项与管理2项也在审查修正后通过。失败日志保留在`/tmp/18-concurrent-*-failure.log`、`18-legacy-badge-failure.log`。

## 双轴代码审查

固定开工基线`27822eb788b88711fcaeb4f83abcf1b44ec4be38`；两个`review`子代理并行只读检查WIP，命令`git diff --cached <基线> --`包含新增文件。

### 规范轴

无成文硬性违规。3项判断性smell：状态文案嵌套三元、失效cursor提示块形状重复、评论和回复重启方式不同；另提示ready-for-human标签字面语义与“人工复核”略有偏差，以及未改动的既有计数字段组。

已将归档文案收敛为小函数，消除嵌套三元。保留短小的局部cursor提示，避免为不同列表/根评论/回复重置语义新增仅转发的组件。评论排序重挂载需要清空整棵回复子树；单根重启只需废弃其请求/分页和展开，现已注释解释这两个边界。ready-for-human沿用#16/#17交付待维护者复核的项目先例，不新增状态或宣称整个父票完成。

### 规格轴

1项潜在缺陷：续页省略可选ReplyBatch元信息时已知状态/计数会丢失；补RED后修复为保留已有元信息，新批显式值（含null）覆盖旧值，历史与cursor回归通过。1项证据边界提醒：双详情之间的列表访问由History seam注入，非应用列表点击导航；上文已明确，不声称这覆盖全部真实列表入口。未发现范围增加。

汇总：规范轴0硬违规、3判断性smell（文案已整理，其余有界取舍说明）；规格轴1潜在缺陷已修复、1证据边界已标注，未保留确认正确性缺陷。最终两个review子代理复核：规范轴无新增违规/阻塞，确认元信息合并顺序和测试修复边界；规格轴确认省略保留与明确null覆盖均有公开页面回归，未发现新规格违规。规范复核另提示restart重复置loading冗余但无害，保留其先清空旧分页再进入首读的显式顺序。

## 父05清单的证据归属

- 来源必要分页、关系、完整集合排序、cursor绑定/冻结/重开、失败不推进checkpoint、归档保留与幂等：#17的T2/T3证据。本票再次运行回复后端回归，不把页面通过替代采集证明。
- 3/13/23/25、收起复用、来源零/未知、根级读取失败及请求竞态、身份/缺失兜底：本票生产Adapter→RTL与既有受控Reader→RTL。
- 实际渲染六行、安全文本、多访问布局/锚点恢复与实际SQLite→HTTP→页面：浏览器证据独立列明，不由RTL或旧mock验收推定。
- 父票保持needs-triage，等待维护者结合#17/#18逐项复核；不据此宣称所有来源权限、全量或长期采集完成。

## 未验证边界

未使用真实Cookie、上游或OSS，未读取仓库外凭据。未验证Linux Chrome/iPhone Safari正式设备、生产部署、真实来源权限/计数/自然编辑、周期采集、长期运行、容量或资源规模。虚构协议fixture和Chromium自动化不是这些人工/实际环境证据；评论图片、周期采集及整期组合仍由对应子票交付。
