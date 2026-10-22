# Codex 子代理迁移调研

## 范围与本机状态

面向本仓库从 Pi 切换到 Codex 本地代理，仅记录调研，不修改代理配置。
探索子代理检查时，`codex` 不在当前 PATH，因此未核实本机版本及其支持的配置格式；不等同于确认机器未安装 Codex。

## 已核实结论

- 当前官方子代理文档提供 `.codex/agents/*.toml` 自定义角色，必需字段为 `name`、`description`、`developer_instructions`。
- 官方配置参考和角色加载源码也支持 `.codex/config.toml` 的 `[agents.<role>]` 与 `config_file`。具体采用哪种方式，须先核对实际 Codex 版本；本次未确定格式变化的版本边界。
- 按当前官方文档，子代理默认启用；不应未经版本核对照搬旧教程中的 `features.multi_agent` 开关。
- 子代理继承父会话的权限和 MCP 环境。Pi 的 MCP 配置仍需迁移到 Codex，不能只迁移角色提示词。
- Pi 模型名称、`thinking` 和工具白名单不能直接当作 Codex 等价字段。角色提示词中的“只读”要求不等于操作系统级权限隔离。

## 本项目建议

- 将 `.pi/agents/Explore.md` 的职责整理为项目探索角色，保留优先 CodeGraph、只读探索、结论及文件行号输出约定。
- 将 `.pi/agents/review.md` 的职责整理为项目审查角色。
- 主代理执行代码审查时，并行派发两个审查实例，分别承担 Standards 和 Spec，分开上下文与报告。
- 更新 `AGENTS.md` 的 Pi 专属路由，并适配 `.agents/skills/code-review/SKILL.md` 的派发语法；不要只重命名目录。
- 先迁移只读角色；暂不扩展并行写代码，避免共享工作树冲突。

## 项目依据

- `AGENTS.md:19–32`
- `.pi/agents/Explore.md`
- `.pi/agents/review.md`
- `.pi/subagents-lite.json`
- `.agents/skills/code-review/SKILL.md:6–12,58–80`

## 一手来源

- https://developers.openai.com/codex/subagents
- https://developers.openai.com/codex/config-reference
- https://developers.openai.com/codex/cli/reference
- https://github.com/openai/codex/blob/cc44ffb3e2008e25dd216d59fa7871a0b9434346/codex-rs/agent-roles/src/loader.rs#L23-L113

## 补充：DeepSeek 与独立审查 provider

后续只读调研确认项目 Pi 审查角色使用 `deepseek/deepseek-flash`（`.pi/agents/review.md:4`、`.pi/subagents-lite.json:26`），该 provider/model 组合标识不能直接复制为 Codex 的模型名。

- DeepSeek 当前官方指南已提供原生 Responses API，以及 Codex 接入方式，API 根地址为 `https://api.deepseek.com`，不需要预设必须使用协议转换网关。
- 当前核对的 Codex 源码只支持 `wire_api = "responses"`，明确拒绝 `chat`；部分模型页面仍保留旧描述。
- 当前角色覆盖实现支持 `model`，但不包含 `model_provider`。新角色文件与旧 `config_file` 均使用该角色覆盖逻辑，不能依靠标准子代理配置实现主代理 OpenAI、审查子代理 DeepSeek。
- 可采用不同 provider 的独立 Codex 会话／profile，或保留现有 Pi 审查流程；不要把独立会话误称为主会话内的跨 provider 子代理。
- DeepSeek Codex 指南示例为 `deepseek-v4-flash`，而 Responses schema 另有 `deepseek-flash`；实际配置应核实可用模型名。本次没有执行真实 API 验证。

补充来源：

- https://api-docs.deepseek.com/guides/responses_api
- https://api-docs.deepseek.com/quick_start/agent_integrations/codex/
- https://github.com/openai/codex/blob/1b89beea82ae60e0dbeacb38f1ad2eae9dfed377/codex-rs/model-provider-info/src/lib.rs#L100-L133
- https://github.com/openai/codex/blob/1b89beea82ae60e0dbeacb38f1ad2eae9dfed377/codex-rs/core/src/agent/role.rs#L37-L128

本记录来自只读 Explore 子代理的项目检查与官方资料调研；主线程未运行 Codex 验证配置。
