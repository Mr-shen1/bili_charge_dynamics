# 16 真实一级评论区与排序交互：自动化证据

## 范围

票据 [16](issues/16-root-comment-reading.md)，复用 #15 根评论归档 API、现有 Reader、详情、请求协调和访问快照。生产阅读不采集、不写回；#18 回复和 #22 评论图片实际读取未交付。父 #04 不据此自动收口，#15 的既有证据与状态不改写。

- 生产 Adapter 读取完整本地集合的服务端 hot/latest 顺序，固定每批 20，cursor 原样传递；页面不重排当前批。
- 初访最热；切换定位评论区、首批/文字/回复状态重置，上方动态保留。现有受控 Reader 回归覆盖忽略取消的旧成功、失败、拒绝及完成回调。
- 首读/追加错误原位重试，追加保留已有内容；CURSOR_INVALID 单独提示，只有显式重新开始才丢弃旧批并无 cursor 请求。
- 成功空读取结合详情根分项状态区分尚未归档与真正空；部分已归档内容仍可阅读。来源总数、本地根数、本地回复数独立，未知与零不混淆。
- UP 标识比较当前动态作者 ID；未知作者不借用作者 ID。安全普通文本、北京时间及默认头像沿用现有组件。
- 生产回复仅提示尚未归档，不请求回复；评论图片仅提示待归档张数，不暴露来源业务图或伪装已上传。纯图不补虚假的空正文。
- 卡片气泡、来源数量与详情来源数量均定位同一评论区，无新评论页。历史访问恢复排序、多批、文字展开、cursor、锚点和位置；主动入口不借用旧位置。

## TDD 与公开测试边界

用户确认 Adapter/HTTP、详情 RTL、浏览器布局导航、SQLite/HTTP→详情四个 seams。Adapter 11 个 RED→GREEN 片段详见 [客户端契约](../../docs/backend/api/archive-api-client.md#adapter-seam-的-red--green)。

主线程 RTL RED 证明通用失败无法表达失效 cursor，以及成功空/未归档、回复能力、本地回复数、纯图提示缺失；对应实现后 GREEN。新增浏览器 RED 首批 0/20，接入后暴露未传 cursor 导致第二批仍为 20，修复后 GREEN。既有排序竞态和历史测试直接复用，不把直接通过冒称新增 RED。

### T1

- `tests/archive-reader.test.ts`：生产传输契约、严格 DTO/nullable 字段、安全 URL、服务端顺序、20/20/5、cursor 原样重试/失效及取消。
- `tests/archive-app.test.tsx`：生产 Adapter→详情，20/20/5、局部失败原批重试、回复/图片未归档、零/未知、根分项空态。
- `tests/comments-app.test.tsx`、`tests/discussion-history.test.tsx`：排序及访问竞态、局部失败、历史状态恢复；新增失效 cursor 重新开始。
- 原 scope/导航夹具补充只读评论响应，保留原 scope/cursor 回归，不将新请求误记为列表分页。

### T2 + 浏览器

`tests/e2e-archive/root-comments.spec.ts` 通过生产首次同步入口，用结构真实、内容虚构的 JSON/HTML 写入临时 SQLite，关闭重开并让上游断源，再经真实 FastAPI HTTP→生产 Adapter→页面：

1. 45 根最热/最新 20/20/5，字符串并列与缺字段，完成后不再请求。
2. 六行不折叠、七行折叠至六行；长 URL/emoji/恶意脚本普通文本，随宽度重排且不溢出。
3. 图标与来源数量直达同详情评论区，501 来源数与45根/0回复分开，同名不同 ID 不误标 UP；头像昵称和点赞只读。
4. 历史恢复最新/40条/文字展开/cursor/锚点位置，继续最终批；新主动访问最热首批、顶部优先旧快照。

不使用真实 Cookie、上游、OSS 或仓库外凭据，不把移动 Chromium 模拟宣称 iPhone Safari 真机。

## 执行结果

Node 24.21.0（nvm）、pnpm 10.34.6，Python 由 uv 管理。Node 命令先 `source ~/.nvm/nvm.sh && nvm use`。

| 命令 | 结果 |
| --- | --- |
| `pnpm test tests/archive-reader.test.ts` | 18 通过 |
| `pnpm test tests/archive-app.test.tsx` | 16 通过 |
| `pnpm test tests/comments-app.test.tsx tests/discussion-history.test.tsx` | 40 通过 |
| `pnpm test tests/scoped-app.test.tsx` | 12 通过 |
| `pnpm typecheck` | 多次通过 |
| `pnpm test --maxWorkers=2` | 19 文件、180 测试通过 |
| `uv run pytest backend/tests -q` | 181 通过；既有 Starlette/AnyIO deprecation warning |
| `pnpm build` | 生产构建通过 |
| `pnpm test:e2e:archive` | 8 通过，含新增4项真实根评论链路 |
| `pnpm test:e2e:manage` | 2 通过 |
| `pnpm test:e2e`（隔离网络） | 104 通过、10 跳过（仅 static-delivery 模式运行的测试） |
| `pnpm test:delivery`（隔离网络） | 环境阻塞：未提供有效 Nginx mime.types，未进入静态交付测试，不冒称通过 |

初次 `pnpm test` 与其他套件并行出现5项5000ms超时；限制 `--maxWorkers=2` 且串行重跑后暴露并修复一处旧 scope HTTP 夹具未处理评论请求的断言，最终180通过。没有增大超时或删掉原回归。

用户服务占用4173，未停止或复用它。原 mock/fault 测试保留写死的4173/4174来源，通过独立网络命名空间执行：

```sh
unshare --user --map-root-user --net -- bash -c \
  'ip link set lo up && env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy -u E2E_TARGET NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1 pnpm test:e2e'
```

归档与管理 E2E 顺序执行，使用同样代理环境清理和 localhost NO_PROXY，不同时争用4176测试API。过程日志在 `/tmp/16-adapter-*.log`、`/tmp/16-unit-final-limited.log`、`/tmp/16-backend-final.log`、`/tmp/16-browser-final.log`、`/tmp/16-archive-final.log`、`/tmp/16-manage-final.log`、`/tmp/16-build-final.log`；临时日志不是跨机器必备证据，版本化测试与上述命令可复现。

## 双轴代码审查

固定开工基线：`53404d9651796b4a9c08aaf3c06b9748396652f9`；WIP 通过 `git diff --cached <基线>` 包含新文件，Standards 与 Spec 两个 `review` 子代理并行只读核验。

### Standards

初审4项：1项票末 Comments 尚未回填（成文交付要求），3项判断性 smell（评论快照重置重复、详情通过 aria-label 字符串定位并重复滚动代码、pendingMediaCount 隐式泄漏到 Reply）。已补票末记录、提取空评论快照、共享评论区 ref/定位操作，并把图片待归档字段收窄为 Comment 专有。没有新增行为或改变分页范围。

### Spec

初审2项潜在/判断性提示，没有确认实施错误或 scope creep：无 archive 元数据会当作成功空；全局 discussions 未归档路径在当前生产装配不再使用。前者仅是无归档 metadata 的独立 mock 语义，生产 Adapter 必须产出 archive；后者保留旧 Reader 公开能力兼容，并由生产根分项状态表达实际未归档，不改变独立 Reader 可注入的契约。审查还指出详情来源数量定位缺独立浏览器断言，已补充实际布局定位测试。真实链路媒体待归档数未使用带图 fixture，本票由生产 Adapter/RTL 验证，实际图片交付仍属于 #22。

汇总：Standards 初审4项均已处理；Spec 2项判断性提示已说明边界，确认缺陷0项。审查后的重构继续用同一公开测试边界复测，不新增私有函数测试。最终 `pnpm typecheck`、180项前端全量、生产构建、8项归档联测及104项mock/fault浏览器回归再次通过；`git diff --check` 通过。

## 未验证与后续范围

未验证 Linux Chrome/iPhone Safari 正式设备、本期部署、真实上游全量/权限/计数口径、实际 OSS、周期采集、持续运行及资源规模；自动化 Chromium/虚构来源不替代这些证据。回复实际展开由 #18，评论图片实际展示由 #22；#16 没有新增周期任务、鉴权、容量治理或全历史回填。正式视觉对照使用 tracked UI 文字规范，不宣称参考图片像素级比对或整期验收完成。
