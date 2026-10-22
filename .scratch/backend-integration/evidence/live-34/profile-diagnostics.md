# #34：公开资料失败的服务端脱敏诊断

本文保留第一阶段 `reason/http_status` 分类诊断及其实测证据；用户随后要求补充 error message，后续安全消息字段、测试与部署状态见[错误消息增补](profile-error-message.md)。该扩展不追溯补出原真实 412 的响应体或消息。

## 授权与测试边界

用户同意补充诊断，并明确同意以下测试边界：真实 `POST /api/manage/ups` 与服务端运维日志；仅测试中替换外部 HTTP，使用临时 SQLite；验证分类、安全、不落库、原有错误及成功行为。测试不使用运行中的隔离服务，不请求 B站/OSS，不复用真实 UID、图片或凭据。

审查基线为 `057921bc182626a743a8ea158f97f3482e4a4c70`。本次诊断子变更的代码范围为 `backend/bili_monitor/profiles.py`、新增 `backend/tests/test_profile_diagnostics.py`，并同步正式管理契约和后端 README。此前同会话另有 #34 票据 Comments、服务准备/页面步骤及失败观察证据，它们不是本次诊断代码，但仍属于 #34 任务材料；票据将链接本诊断记录。#33 材料、用户原有未跟踪文件和其他工作不纳入本轮代码审查或提交；不改数据库 schema、前端业务代码、权限策略、重试策略或 transport。

## 行为

- 预期失败发出一条服务端 WARNING：`profile_lookup_failed reason=... http_status=...`。
- 分类为 `timeout`、`network_error`、`http_status`、`upstream_rejected`、`payload_invalid`、`uid_mismatch`、`profile_invalid`。
- 仅 HTTP 非成功记录 100–599 的严格整数状态，否则 `unknown`；其他分支为 `none`。业务拒绝不记录原始业务码。
- 不记录 UID、URL/query、请求或响应 headers/body、个人资料、原始业务 message、异常字符串或 traceback。测试在输入及异常中放置虚构秘密标记，并核验响应、日志及事件数量。
- API 仍为 `502 PROFILE_UNAVAILABLE`，固定安全提示不变；失败不新增身份，成功仍为原 201 DTO。原有 HTTPError/ValueError/KeyError/TypeError 捕获集合不变，其余非预期异常仍由原安全中间件处理。
- 不增加页面错误细节或初始化按钮。页面仍可能显示原安全文案，具体分类由服务端运维读取。

## TDD：逐片红—绿

执行命令均使用现有 uv 环境与离线/不同步模式：

```bash
uv run --offline --no-sync pytest backend/tests/test_profile_diagnostics.py -q
```

| 切片 | 先观察的失败 | 最小实现后 |
| --- | --- | --- |
| 读超时诊断 | 1 failed：日志事件为 0 | 1 passed |
| 连接/协议错误 | 2 failed，1 passed：日志事件为 0 | 3 passed |
| HTTP 状态及状态范围 | 6 failed，3 passed：错误分类不符 | 9 passed |
| 非零整数业务码 | 3 failed，9 passed：日志事件为 0 | 12 passed |
| JSON/结构/码类型无效 | 10 failed，12 passed：日志事件为 0 | 22 passed |
| 返回身份类型或值不符 | 4 failed，22 passed：被归为结构错误 | 26 passed |
| 昵称/头像无效 | 8 failed，26 passed：被归为结构错误 | 34 passed |

随后扩展其他 HTTPX 超时类型与成功路径回归，初轮共 38 个参数化用例。审查阶段另补 3 个缺字段回归：缺 `mid` 为结构无效，缺 `name`/`face` 为资料字段无效；重构前已观察 41 passed。随后在审查阶段删除恒真守卫、合并为单一日志与错误出口，重跑原测试保持通过。复核后另补 3 个非整数 HTTP 状态防泄漏回归及 2 个其他 HTTPX 错误类型回归，最终本文件覆盖 46 个参数化用例。全部通过真实管理 HTTP 和实际临时 SQLite 观察，不直接查询内部表、不 mock 内部解析函数。

## 回归

```bash
uv run --offline --no-sync pytest backend/tests/test_profile_diagnostics.py backend/tests/test_management.py -q
# 初轮 120 passed；最终 128 passed, 1 warning
uv run --offline --no-sync pytest backend/tests -q
# 初轮 707 passed；最终 715 passed, 3 warnings, 127.00s
```

警告为既有 Starlette/AnyIO alias 和 OSS SDK `datetime.utcnow()` 弃用提示。OSS SDK 测试使用测试边界，不是实际云上传。后端回归通过不等于真实上游、图片交付、长期稳定、设备验收或全项目通过；上述编码/自动化阶段未为取证发起真实来源重试。其后用户另行授权的受控实测独立记录于下方，不混入自动化通过结论。

## 双轴审查

审查范围为上述诊断代码、测试、正式说明和本文件，不包含已有 #33 改动。两轴由独立 `review` 子代理只读执行，先通过 CodeGraph 定位并核对实时文件；代理不运行测试或访问来源。

### Standards

初审：0 个硬违规，3 个判断性发现：恒真守卫、重复日志/异常出口、缺昵称/头像时的分类说明歧义。已删除守卫、收敛为单一出口，明确缺字段边界并补回归。

### Spec

初审：0 个硬性功能缺陷，4 个判断项：诊断子变更与此前 #34 任务材料范围表述、`mid` 缺失/无效类型的区别、恒真守卫、README 未说明 `unknown` 回退。已分别澄清范围、补分类边界、移除守卫并统一正式说明。

两轴随后独立复核：Standards 为 0 个硬违规，Spec 为 0 个硬性缺陷；确认初轮问题已修正。复核提出的非整数状态测试、其他 HTTPX 错误类型覆盖和捕获集合措辞，已补测试/明确说明；后端 README 仅链接正式分类契约，避免多处复述分类表。最终回归为 715 passed。

保留的非阻断判断/边界分轴记录：

- Standards：分类依赖当前协议阶段的局部变量；暂不为小范围诊断引入专用异常层级，未来修改协议步骤需同步维护分类测试。`from None` 虽在本函数内部 except 之后，仍保留原安全抑制语义作为防御，不用于输出原始异常。
- Spec：复核时 pytest 只验证应用日志事件，Uvicorn/journal 端到端交付尚未实测，不能把 caplog 成功升级为实际来源结论。其后 2026-10-21 经独立授权，在一次真实 HTTP 412 样本中观察到生产 journal 的固定分类；这不证明其他错误类别或长期日志交付稳定。原捕获集合中的 TypeError 等仍保持 502 行为，文档已避免一概称所有“编程异常”为 500。Spec 轴同样提示未来新增协议步骤时须维护阶段分类，保留该非阻断维护边界。

末轮补充仅为测试和文档，未再改已复核的生产实现。

差异检查通过；原有 index 的二进制 diff 摘要、排除本轮目标文件后的 tracked worktree diff 摘要均与开工时一致。未 reset/stash、未暂存或提交，未改用户原有未跟踪材料。

## 部署与真实验证边界

编码与测试完成时未触碰运行中服务。2026-10-21 用户随后确认更新，并明确要求真实 B站验证：预检发现旧 transient unit 已停止；核对启动脚本、空库、生产 transport 后，仅恢复隔离 API，加载新诊断代码，未操作前端或原验收站。

随后仅对授权 UID 执行 1 次公开资料查询：本地 `502 PROFILE_UNAVAILABLE`，生产 journal 记录 `reason=http_status http_status=412`。未保存身份，停止本次验证，不进入动态关联/初始化，不自动重试。资料接口拒绝的具体机制仍未知；不能追溯认定先前截图的上游状态。完整脱敏证据与范围见 [2026-10-21 真实验证](real-profile-check-2026-10-21.md)。
