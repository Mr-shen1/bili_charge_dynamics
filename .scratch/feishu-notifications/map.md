# 飞书通知实施地图

## Notes

- 集成分支：`feat/feishu-notifications`；基准：`4b4761a161d5fe077110823d6c1cede889b8f082`。
- 规格与依赖：[spec.md](spec.md)、[implementation-plan.md](implementation-plan.md)。
- 按票据独立分支、worktree、TDD 实施并经合并代理集成；完成判据是验收与证据，不是提交存在。
- 01–10 仅实现和隔离验证；11 等待真实群、设备、环境及操作边界授权，不自动完成。
- 不修改或提交用户已有的 `.pi/subagents-lite.json` 修改；不推送、不部署、不读取真实机器人配置、不向真实 B 站或飞书发请求。
- 本地 Markdown 票据使用 `claimed` / `resolved` 记录领取与完成；最终父规格保留未完成真实验收的含义。

## Decisions-so-far

- 01 已 `resolved`：动态变化闭环落地事务发件箱 + 独立通知进程（schema v16）；通知阶段自有令牌，入选令牌轮换不重设起点；证据见 [evidence/01-dynamic-change-notification.md](evidence/01-dynamic-change-notification.md)。

- 起始可并行票为 01、02，分别在 `/tmp/feishu-worktrees/01`、`/tmp/feishu-worktrees/02` 实施。
- 本轮接续 01、02 已存在的未提交工作，保留其内容并由各实施代理核验、完成；不重置工作树。
- 本轮共享探索笔记放仓库外 `/tmp/feishu-notifications-research/implementation-notes.md`，供后续实现者参考；笔记不替代活文件及官方协议核验。
- 真实验收票 11 保持 `ready-for-human`；01–10 的隔离准备即使完成，也不自动关闭父规格或 11。

## Fog

- 真实飞书显示、内置浏览器、手机、代理可达性、授权目标环境三进程及资源证据均未取得，归票据 11。
- 各票隔离验证与最终双轴审查结果尚待形成。
