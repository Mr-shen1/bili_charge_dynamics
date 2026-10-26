### implement-spec 工作流覆盖

执行 `implement-spec` 时，本节覆盖其分支、提交、合并、清理约定；`.agents/skills/implement-spec/SKILL.md` 保持原样。验证循环沿用既有子代理快反馈与项目验证约定，本节不增加检查步骤。以下均为提示词层约束，不配脚本、不加 gate，优先保持反馈循环速度。

#### 分支

| 分支 | 切自 | 生命期 |
| --- | --- | --- |
| `main` | — | 恒绿；只接 hotfix 与 spec 收尾提交 |
| `spec/<slug>` | `main` | 一个 spec 一条；可 push 作 draft PR 基点；合回即删 |
| `wt/<slug>-<NN>` | `spec/<slug>` 当前 HEAD | 一个 ticket 一条；只存在于本地；合回即删 |
| `exp/<slug>` | `main` | 长期对照实验（换规则版本、换运行时），不混进 `spec/` |

hotfix 落到 `main` 后，立刻把各活跃 `spec/` 分支 rebase 一遍。

#### 提交格式与正文

首行使用 `type(scope): 中文描述`：

- type 取 `feat`、`fix`、`docs`、`refactor`、`test`、`perf`、`build`、`ci`、`chore`。
- scope 取本仓库目录名（如 `backend`、`frontend`、`deploy`、`scripts`、`docs`）或子系统名（如 `collector`、`archive`、`notifications`、`git`）；跨范围用逗号并列。
- 首行与正文之间空一行；正文用自然段或 `- ` 分点，不设固定栏目。
- 正文说明做了什么、波及哪里、为什么这样做，补足 diff 无法表达的判断。测试是验证的家，正文不堆测试日志或命令清单。
- 需要指针时使用 `Refs:` footer，指向长期存在的 `docs/` 文档（ADR 如有则指向 `docs/adr/`），不依赖 `.scratch/` 留存。

#### 提交粒度

粒度按概念计，不按 ticket 计：条数等于概念数，与票数无关。

- 小 spec 且单一概念，留一个提交。
- 同一机制被拆成两半的票，合成一个提交，避免“绿但半成品”的中间提交。
- 机械改动（生成物重跑、格式化、批量改名）单独成提交，不混进逻辑改动。
- “一个概念”的判据：单独 revert 它，动作有意义，且 revert 后仍绿。想拆提交而拆不动，先检查 spec 是否混入多个概念；若是，先拆 spec。

逐票集成与最终提交粒度分开：票据先合入 `spec/`；合回 `main` 前，由 implementer 按上述概念边界整理提交，merger 不负责重组实现。

#### 合并与清理

- `spec/` 合回 `main` 使用 rebase 或 `--no-ff`，保留已经整理的概念提交；不用 GitHub squash 按钮绕过上述 message 与粒度约定。
- merger 每合入一个 ticket，就跑该 ticket 范围的测试；通过后随即删除其 worktree 与 `wt/` 分支，不等全部完成统一清理。测试失败则退回 implementer 修复，保留工作树供返工。
- 冲突超过三个文件或属于非机械冲突，退回 implementer 重做；merger 只搬运，不改代码。
- `.scratch/` 的清理方式与文档策略另行决定，工作流不依赖它。
