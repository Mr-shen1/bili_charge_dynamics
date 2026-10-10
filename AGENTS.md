## Agent skills

### Issue tracker

Issues and specs are tracked as Markdown in `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout. See `docs/agents/domain.md`.

## Subagent routing
- code-review skill:Standards 与 Spec 两个子代理都用 `review`(`.pi/agents/review.md`)派发。
- research 任务:调研与探索一律派给 `explore` 子代理,主线程只下指令和聚合结论,不自己读文件爬代码。派发时必须在 prompt 里写明「用 codegraph 查」,探索子代理优先调用 codegraph MCP 工具(见下节),grep/find/read 只作补充。
- 探索子代理的产出是结论 + 关键文件:行号引用,不是文件转储;不要让它整段贴源码回来。

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

For implementation workflows or skills (including Matt Pocock's `implement`, `code-review`, and similar workflows), use `codegraph_explore` MCP first when locating or understanding code, then verify graph results against live files. This applies inside delegated subagents too: tell them to call CodeGraph MCP directly during their own exploration and include `codegraph_explore` in their tool allowlist. Do not ask a subagent to spawn `Explore` or another nested subagent; pi-subagents-lite does not support nesting. If a child cannot access MCP, the parent should run CodeGraph and pass it the relevant findings. If the repo is not indexed or the MCP tool is unavailable, fall back to source tools. If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
