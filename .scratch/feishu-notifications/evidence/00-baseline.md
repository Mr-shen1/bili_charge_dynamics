# 飞书通知实施前回归基线

- 被测集成版本：`0348e74`（业务代码仍为 `4b4761a` 基线）。01、02 的未完成改动在独立工作树，不在本次结果内。
- 范围：现有自动化回归；不代表新增飞书功能、真实飞书、设备或目标环境验收。
- 安全：测试清除 `BILI_COOKIE_FILE`，使用项目隔离测试装配；未读取真实路由配置，未推送或部署。本地 `.pi/subagents-lite.json` 既存改动保持不动、不纳入提交。

## 后端

命令（仓库根目录）：

```sh
env -u BILI_COOKIE_FILE -u BILI_FEISHU_CONFIG uv run --no-sync pytest backend/tests -q
```

结果：**825 passed，3 warnings，133.72s**。警告来自 Starlette 的 BlockingPortal 别名及 OSS SDK 的 `datetime.utcnow()` 弃用提示。首次执行因命令工具 120 秒上限中止，随后以 600 秒上限完整重跑通过，不把第一次中断算失败或通过。

## 前端

命令：先加载 nvm 并执行仓库 `.nvmrc` 的 Node `24.21.0`，在 `frontend/` 下执行 `pnpm check`。

结果：类型检查通过；Vitest **23 个文件、254 个测试通过**；e2e 项目声明覆盖守卫通过。本命令不运行浏览器，也不构建交付产物；新功能集成后须另行完成相关浏览器验证与 `pnpm check:dist`。

## 未验证

所有飞书新增验收条件尚待各票及集成证据；真实群、内置浏览器、手机、代理可达性、目标环境三进程与资源验证均留给 11 的人工授权门槛。
