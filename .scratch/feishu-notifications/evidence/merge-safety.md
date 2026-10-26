# 集成操作安全记录

## 08 合并时的一次操作失误

08 合并代理报告，为重做源分支更新后的合并，曾在主集成工作树执行 `git reset --hard 2ccd677`。这不符合本轮保护用户本地修改的要求，并短暂还原了 `.pi/subagents-lite.json`。代理随后从操作前备份恢复原内容。此操作不是本轮授权的安全合并方式，不能因为最终内容恢复而声称从未触碰。

主线程在集成版本 `bd03611` 上独立复核：

- 工作区仍只有 `.pi/subagents-lite.json` 的既存未提交修改；暂存区为空。
- 当前文件 Git blob 哈希：`4bc60768cfb171337014158b1c4e792263ecfbf6`，与开工时记录完全相同。
- 当前 `git diff -- .pi/subagents-lite.json` 与开工时仓库外保存的完整补丁逐字节比较一致（`cmp` 退出码 0）。未把配置内容或补丁纳入本记录。
- 本轮提交不包含该文件；未执行推送或部署。

已向用户主动说明；后续实施/合并明确禁止 `git reset --hard`、`git clean`、强制 checkout，以及任何恢复或改写 `.pi` 文件的操作。只允许普通合并、精确编辑和明确路径暂存提交。结束前须再次核验本地配置与开工备份完全一致。

## 07 合并（本轮）

07 合并全程只做普通操作：`git merge --no-ff --no-commit feat/feishu-07`（源 tip `c1da3cf`，合并前集成 tip `9296cff`，merge-base 核验为 `9296cff`）→ 核验与测试 → 提交合并 `18b177c` → 精确编辑 `map.md`/`implementation-plan.md`/设计文档状态行并提交。未执行 `git reset --hard`、`git clean`、强制 checkout，未重写任何历史，未推送、未部署，未嵌套代理。

`.pi/subagents-lite.json` 全程未参与暂存与提交，结束时复核：

- 文件 Git blob 哈希仍为 `4bc60768cfb171337014158b1c4e792263ecfbf6`（`git hash-object`），与开工记录完全相同。
- 当前 `git diff -- .pi/subagents-lite.json` 与 `/tmp/feishu-subagents-lite-existing.patch` 逐字节比较一致（`cmp` 退出码 0）；补丁仅用于核验，未重写文件。
- 工作区仅剩该文件这一处既存未提交修改，暂存区为空。

## 10 合并（本轮）

10 合并全程只做普通操作：先核验 `git rev-parse HEAD`＝`b6cef2c`、源 `feat/feishu-10`＝`12cb54c`、`git merge-base`＝`b6cef2c`（即集成 tip，理论上可快进），仍按约定执行 `git merge --no-ff -m "merge(feishu): 合并 10 三进程集成与交付准备（源 tip 12cb54c）"`，无冲突，合并提交 `ad07555`。未执行 `git reset --hard`、`git clean`、强制 checkout，未重写任何历史，未推送、未部署，未嵌套代理，未操作既有服务（18445）或 4173 端口上的 ssh 隧道，未读取真实通知配置/凭据。

合并后核验：

- `git diff --check` 通过；工作区仅剩 `.pi/subagents-lite.json` 这一处既存未提交修改，暂存区为空。
- schema 保持 v21（`storage.py` 两侧同文未变，08 `notification_alerts`／05 v20 候选根键／06 v19 失败事实／09 v17 心跳与有效期／01 v16 发件箱原位保留）。
- focused 测试：`test_three_process_delivery.py`＋`test_service_processes.py`＋`test_reply_notifications.py` `33 passed`；`test_deployment_processes.py` `6 passed`；`-k api_and_collector_never_start_the_notification_process` `1 passed`。按票据与计划不重复后端全量与前端 e2e/隔离 Nginx（10 源分支已全绿，最终审查后复核）。
- 10 对 05 回复图片元信息的回归修复随合并进入集成分支，根评论严格图片校验用例 `test_root_comment_picture_validation_stays_strict` 仍通过。

`.pi/subagents-lite.json` 全程未参与暂存与提交，合并与文档提交前复核：

- 文件 Git blob 哈希仍为 `4bc60768cfb171337014158b1c4e792263ecfbf6`（`git hash-object`），与用户开工时给出的哈希逐字符相同。
- 当前 `git diff -- .pi/subagents-lite.json` 与 `/tmp/feishu-subagents-lite-existing.patch` 逐字节比较一致（`cmp` 退出码 0）；补丁仅用于核验，未恢复、未重写。
