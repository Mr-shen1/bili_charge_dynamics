# #26 评论状态：实际 API/fixture 浏览器证据

## 装配与边界

- 既有实际 harness 为 `tests/e2e-archive/live_app.py`（不存在 `backend/tests/archive_live_app.py`），启动函数复用 `tests/e2e-manage/apiProcess.ts`（不存在 archive 自己的 `apiProcess.ts`）。
- 本票新增 `comment_status_app.py`，复用生产 `create_app`、`Collector.check_once/execute_pending` 与真实临时 SQLite；没有手工 SQL 状态、假 Adapter 或生产测试 endpoint。
- `commentStatusProcess.ts` 通过本机私有 Unix socket 驱动同一测试进程。`check` 登记观察，`execute-start` 在虚构回复第二页停住，`release-failure` 产生页失败，`retry` 用相同 501 再检查并执行未完成工作，`calls` 只读取 fixture 请求记录。
- 原始虚构 HTML/detail/count 位于 `tests/e2e-archive/fixtures/comment-status/`；根/回复沿用 `tests/e2e-archive/fixtures/root-comments.json`、`tests/e2e-archive/fixtures/replies.json` 的协议结构，经虚构传输分页。业务媒体为空，不读取真实凭据，不请求真实上游、OSS 或网络来源图片。
- 生产评论状态只位于详情评论区；原卡片/正文隐藏归档信息断言保持不变。旧终页文案更新为“本地归档评论已读完”，最热/最新排序与 20/20/5 验证没有减少。

## 场景

`comment-status.spec.ts` 两个场景分别覆盖：

1. T2/T3：来源 501、本地根 45；回复第二页阻塞时 running，释放为失败后本地回复 20；来源总数未变、revision 未变的重试后回复 25、工作 complete。公开归档 `comment_sync` 与管理 checks 一致；来源未知且根页失败不是成功空；真实零完成根/回复归档。无变化检查不推进分项成功时间，关闭/重开数据库后归档/checks/评论仍可读。
2. T1/T2/T3：实际 HTTP 经生产 Adapter，页面同步中 → 部分完成/最近失败 → 后台无新计数重试 → 用户只读刷新完成。保留最新排序、40 条评论、文字展开及评论 25 的视口锚点；刷新只发 GET，不重新请求评论分页、不增加 fixture 上游调用。零显示 0 与“暂无评论”，未知显示 — 与同步失败，脚本文字不执行、虚构秘密不外泄。

阅读位置以评论锚点相对视口的位置核验，不锁死 `scrollY` 数字：状态文案换行可以改变文档高度，浏览器滚动锚定应使原评论仍处于原视口位置。

## 命令与执行记录

```bash
source "$HOME/.nvm/nvm.sh" && nvm use
NO_PROXY=127.0.0.1,localhost HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= \
  pnpm test:e2e:archive tests/e2e-archive/comment-status.spec.ts --reporter=line
NO_PROXY=127.0.0.1,localhost HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= \
  pnpm test:e2e:archive --reporter=line
pnpm typecheck
uv run --no-sync python -m compileall -q tests/e2e-archive/comment_status_app.py
git diff --check
```

当前环境带 HTTP proxy；若未给本地地址绕过代理，Playwright 会把 4177 判断成已占用。上列命令显式绕过本地代理，不停止其他人的进程。

- 首轮 harness 调试先失败后修正：profile face 必须是 HTTPS URL、回复默认首批是 3、HTML 中脚本文字必须 JSON 转义，不能把这些装配问题算作产品 UI red。
- 新增两场景曾连续通过；当时整套 archive 为 **34 通过 / 2 失败（36 场）**。失败在 `media-live.spec.ts:88、135`，详情读取被新增错误码映射拒绝，初始化和列表已成功；已向主线程报告。
- 后端错误码并行修改后的相关 7 场重跑为 **5 通过 / 2 失败**：`archive.spec.ts` 详情读取失败；新增 UI 场景首次刷新保留旧同步中状态并显示“评论同步状态读取失败；保留已有状态。”。这是实际 API → 生产 Adapter 的产品 red，断言未放宽。原因是客户端封闭错误码集合与新根/回复脱敏错误码不一致，修复归主线程。
- 主线程统一错误码契约后，只重跑新增 `comment-status.spec.ts`，**2 通过（5.7 秒）**，形成实际 API/生产 Adapter 的 red → green。没有放宽失败状态/刷新断言。后续不再占用端口跑全量，最终全套由主线程统一执行。
- `pnpm typecheck`、Python 编译与 `git diff --check` 当次通过。
- 主线程最终统一全量：`pnpm test:e2e:archive --reporter=line` **36 passed（1.5 分钟）**；管理 **7 passed**；独立 mock **104 passed / 10 skipped**。上述最终 archive 结果包含错误码和评论分项时间/错误展示更新，旧阅读/媒体回归保留。总记录见 [26 验收](../acceptance-26.md)，不把并行变更期间的历史通过当最终验收。

## 未验证

没有真实 B 站/OSS 请求、凭据、Linux Chrome 人工签收、iPhone Safari 真机、实际规模持续调度证据。此处只证明本机 Playwright Chromium、生产 HTTP/Adapter 与虚构协议同步链；不宣称实时、完整来源评论或所有受限评论可读。
