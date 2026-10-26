## Agent skills

### Issue tracker

Issues and specs are tracked as Markdown in `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Project docs

需求、设计、接口、交付或票据规划：先从 `docs/README.md` 定位并阅读相关原文，再开展工作；该索引也说明正式文档与 `.scratch/` 任务证据的归属。

### Frontend commands

前端（`frontend/`，唯一前端应用）的构建、单文件 e2e、e2e 项目声明约定见 `frontend/README.md`「命令」段；在该目录下跑，一趟绿灯是 `pnpm check`，交付前是 `pnpm check:dist`。

### Domain docs

Single-context layout. See `docs/agents/domain.md`.

## Subagent routing
- code-review skill:Standards 与 Spec 两个子代理都用 `review`(`.pi/agents/review.md`)派发。
- research 任务:调研与探索一律派给 `Explore` 子代理,主线程只下指令和聚合结论,不自己读文件爬代码。派发时必须在 prompt 里写明「用 CodeGraph 查」,探索子代理优先通过 `mcp` 网关调用 `codegraph` 服务的 `codegraph_explore` 工具(见下节),grep/find/read 只作补充。
- 探索子代理的产出是结论 + 关键文件:行号引用,不是文件转储;不要让它整段贴源码回来。


## CodeGraph

定位或理解代码、派发探索子代理前，先阅读 `docs/agents/codegraph.md`，按索引与工具可用性选择查询入口。

## Git

提交代码或执行 `implement-spec` 的分支、合并、清理操作前，先阅读 `docs/agents/implement-spec.md`。