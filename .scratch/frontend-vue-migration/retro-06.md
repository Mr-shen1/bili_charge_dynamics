# 06 实现会话 retro：环境改进候选

- 范围：票据 06（宽屏回复）实现会话，`feat/backend-integration` 上从 `f8e61d0` 到 `62d63bb`
- 一手材料：本机会话日志 `~/.pi/agent/sessions/--home-kevin-Projects-PI-bili_charge_dynamics--/2026-10-24T14-30-03*.jsonl`（290 行；工具调用 read 21 / bash 93 / edit 21 / write 14 / 子代理 4），仓库现状（`package.json`、`playwright.config.ts`、`frontend/README.md`、`docs/`、`AGENTS.md`）
- 判据：机械型问题做成确定性检查；判断题写成 review 期标准。落点优先级：确定性检查 > review 期标准 > 常驻指针 > 按需文档。
- 状态：**第 1、2、5 条已落地（提交 `chore(frontend): 收口检查命令并补 e2e 项目覆盖守卫`）；第 3、4 条留待 07；1b/1c、6、7 未采纳，理由见文末。**

## 已落地

| # | 问题（证据） | 落地形式 | 后续会话如何撞上 |
| --- | --- | --- | --- |
| 1 | 一趟绿灯要手敲 4 条命令：本会话 typecheck ×5、test ×6、`check:isolation` 只跑 1 次且顺序错（改完 mock 才想起） | `pnpm check`（typecheck + 单测 + 覆盖守卫，约 15s）、`pnpm check:dist`（两次构建 + 隔离 + 副本） | `implement` 技能要求"run typechecking / run the full test suite"，列 `scripts` 即可见；`AGENTS.md` 另有指针 |
| 2 | `replies.spec.ts` 被两个 mock 项目误匹配 → 6 例假失败 + 两次全量 e2e（约 5 分钟）+ 3 次试错改 `testIgnore` | 每个 `tests/e2e/*.spec.ts` 首行声明 `// @projects …`；`scripts/check-e2e-projects.mjs` 用 Playwright 自身 `--list --reporter=json` 的实测矩阵对照声明，不一致即失败并打印矩阵 | `pnpm check` 里机械执行；已用"删掉 `mockIgnore` 中的 replies"复现原 bug，脚本报 `被声明外的 project 匹配到` |
| 5 | 5 次 bash 摸索单文件/单 project 跑法与 `test-results/<case>/error-context.md` 快照 | `frontend/README.md` 命令段新增跑法、`@projects` 约定与失败排查入口；`AGENTS.md` 加 `Frontend commands` 指针 | `AGENTS.md` 常驻指针 → README 命令段 |

## 留给 07 的两条

| # | 问题（证据） | 建议落点 |
| --- | --- | --- |
| 3 | 组合式函数 `catch {}` 把真实原因折成 `status:'error'`：本会话 #37–44 共 6 次工具调用用于定位一个被吞掉的 `ReferenceError: reply is not defined` | 07 写读取逻辑时顺带：`catch (error)` 在非生产装配下记录原因，或给 `reason` 增补"异常"取值。06 的 `useReplyPreview`/`useReplyPage` 是 07 会照抄的模板，越早定规矩越好 |
| 4 | Vue 迁移"已交付"状态复述在 6 处（`frontend/README.md:4`、`:85`、`docs/design/frontend-migration.md:3`、`:181`、`docs/README.md:13`、`:45`），每票要全改一遍 | 07 顺手收敛：保留 `frontend/README.md` 一处为准，其余压成一句指针 + 证据链接；不做结构性重排（01–06 按老格式写过） |

## 未采纳与理由

- **1b/1c（eslint + `eslint-plugin-vuejs-accessibility`、pre-commit/CI）**：本票 3 条 review 发现里有 2 条是判断题、1 条（`aria-busy`）属于机械型，eslint 确实能机械拦住部分。但既有代码会喷几十条告警，warn-only 等于不拦，全改是一次独立大提交。**推到票据 12（Vue-only RC）之前统一做**，别打断业务票节奏。
- **6（`AGENTS.md` 的 CodeGraph 长段下沉）**：本会话 4 次子代理派发全部按该段执行（探索只走 Explore + `codegraph_explore`，主线程未自行爬代码），规则有效。下沉只省 token，却可能降低子代理遵循度 → 暂不动。
- **7（追加式编辑摩擦）**：14 次 `write` + 18 次 `python3` heredoc 主要用于"往测试文件追加用例"和"撤掉自插的 debug 行"。这是 harness 层摩擦（`edit` 要求唯一 `oldText`），仓库无可修项，仅记录。

## 判断依据备忘

- 第 2 条属于 retro 说的机械型：`testMatch`/`testIgnore` 是纯静态配置，实测结果可枚举，因此做成检查而非写进文档。
- 第 3、4 条属于判断题（异常保真度、文档单一事实源），按 retro 的分工交给 **review 会话**承担，不塞进实现会话的标准记忆；等出现第 4 条同类问题时再考虑建 `CODING_STANDARDS.md`（现在是 0 条，先不建空文件）。
