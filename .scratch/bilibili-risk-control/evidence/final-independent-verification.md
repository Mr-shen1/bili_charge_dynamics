# 最终独立验证与清理

## 结论与版本

- 集成分支：`spec/bilibili-risk-control`；父规格与 10 张票均已 `resolved`。
- 独立全量验证版本：`fb017f409d6a88c2f7abed7c9b0aaa1970b3ef52`；backend 子树 `f588f465d05bb31f14ee0698015a70fd252bb198`。
- 随后的 `41da72a` 仅修改三个 Python docstring 和审查证据，不改变业务行为；其相关用例另行通过。本文与导航更新也仅为文档。
- [双轴审查与逐项处置](final-independent-review.md)：规格轴复核无阻塞；规范轴保留历史专项测试适配器等判断性取舍，已记录理由，不宣称所有整轮辅助函数均已删除。

## 独立后端全量

在仓库根目录执行，uv 0.12.23、Python 3.12.15、pytest 8.4.2：

```sh
uv run --no-sync pytest backend/tests -q
uv run --no-sync pytest backend/tests -q --collect-only -p no:cacheprovider
```

- 唯一有效全量执行：**1217 passed, 3 warnings in 670.65s**，退出码 0，墙钟 671 秒。
- 收集核对：**1217 tests collected**，与执行数一致，无静默跳过或失败重跑。
- 三条警告来自 Starlette 的 `BlockingPortal` 别名与 oss2 的 `datetime.utcnow()` 弃用，不是本次功能失败。
- 首次包装命令因本机缺少 `/usr/bin/time` 退出 127，pytest 尚未启动；改用 shell 计时后执行上述命令。这里不把命令构造失败混为测试失败，也不隐去该尝试。
- 独立全量运行前后 HEAD、backend/frontend 子树与工作区状态均一致，工作区干净。

合入 `41da72a` 文案后另行运行：

```sh
uv run --no-sync pytest backend/tests/test_reply_page_resume.py \
  backend/tests/test_reply_page_pacing.py backend/tests/test_reply_incremental.py \
  backend/tests/test_risk_observation.py -q
```

结果：**34 passed, 1 warning in 29.02s**；`git diff --check` 通过。该次不是重新运行全量，不将其与全量数字混记。

## 前端证据复用

前端子树保持 `92502ec70610793f1aa286e5ae37f048a5ecda11`，锁文件 SHA-256 为 `8b7b09908c334a72895d0da69ec33375e830a863bca987b47978e1314fe2811a`。本轮在该子树已独立执行（nvm Node 24.21.0、pnpm 10.34.6，工作目录 `frontend/`）：

- `pnpm check`：类型检查、**294 单测**与 e2e 项目声明守卫通过。
- `pnpm check:dist`：生产/mock 构建与产物隔离检查通过。
- 最终独立验证只核对上述子树与锁文件未变，未声称再次执行前端门槛；未执行浏览器 e2e、视觉或真机验收。

## 清理与边界

- 各票及审查整改分支通过合并验证后，工作树与本地 `wt/` 分支已逐一删除；最后仅保留主工作树和集成分支，`main` 仍为 `423402f`。
- 独立验证发现一处前序审查遗留的隔离 fixture 服务器。核对其命令为 `/tmp/bili-risk-control-review/.venv/bin/python -m uvicorn backend.tests.fair_serial_fixture:create_app --factory --host 127.0.0.1 --port 45859`、cwd 为该已删除临时工作树后，仅对该进程发送 SIGTERM，并确认退出；没有停止或重启现有部署服务。
- 三进程、8 目标／10000 回复与 RC 台账见[票据 10 证据](10-integrated-performance-verification.md)。
- 性能公式是**非硬性参考目标**；一次有界对照无法证明等价，整体性能未验收，不为公式继续优化或阻塞交付。
- 真实 B 站／OSS／飞书、生产数据库迁移、部署／回滚、真实平台阈值及长期稳定性、真机与视觉均未验证；本次未连接真实环境。
