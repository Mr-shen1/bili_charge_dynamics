## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): use the `mcp` gateway to call the `codegraph_explore` tool on the `codegraph` server; it answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

For implementation workflows or skills (including Matt Pocock's `implement`, `code-review`, and similar workflows), use the `mcp` gateway to call `codegraph_explore` on the `codegraph` server first when locating or understanding code, then verify graph results against live files. This applies inside delegated subagents too: tell them to use the `mcp` gateway during their own exploration and include `mcp` in their tool allowlist. Do not ask a subagent to spawn `Explore` or another nested subagent; pi-subagents-lite does not support nesting. If a child cannot access MCP, the parent should run CodeGraph and pass it the relevant findings. If the repo is not indexed or the MCP tool is unavailable, fall back to source tools. If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
