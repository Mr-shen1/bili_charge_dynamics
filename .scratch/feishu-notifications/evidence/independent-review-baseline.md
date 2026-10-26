# 审查版本的主线程独立回归

- 被测版本：`306356c`（业务代码与双轴审查对象 `2d408c3` 相同，只新增审查报告）。
- 在主集成工作树执行，与整改工作树隔离；无真实来源或飞书请求、无真实凭据读取、无推送/部署。

```sh
env -u BILI_COOKIE_FILE -u BILI_NOTIFICATION_CONFIG \
  NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
  uv run --no-sync pytest backend/tests -q
```

结果：**首次运行 1029 passed，3 warnings，191.05s**。完整原始输出保留于仓库外 `/tmp/feishu-independent-backend-before-fixes.log`。警告仍为 Starlette/OSS SDK 弃用提示。

本轮未复现票据 10 首轮的跨进程失败，但一次绿灯不证明偶发根因已消除。原始失败历史保留，最终整改仍须核验纯墙钟假设，并在新的固定代码候选上重新回归。本结果不覆盖后续整改提交，也不构成真实飞书、设备或目标环境验收。
