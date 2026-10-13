# 23 固定节拍检查验收记录

## 范围与边界

交付独立 Python 采集入口、固定 15 秒检查、检查/同步阶段分离、持久观察与待处理、实际状态 HTTP 和 v10 迁移。复用 #02 同步底座，不新增 API 定时器、Redis/Celery、多 worker 或第二套来源服务；不交付 #24 完整编辑分项流程/UI、#25 评论计数策略、#27 近期发现。

测试边界沿用票据 T2/T3：公开 `Collector.check_once/run/execute_pending`、实际 SQLite 关库重开、管理/归档 HTTP、原始 HTML/JSON、阻塞传输及外部受控时钟。仅外部 HTTP、时钟和 OSS 边界可替换。

## 自动化证据

`backend/tests/test_collector.py`：

- 无编辑标记首次检查仍登记初始化，重复登记 revision 幂等；检查时间不冒充成功时间。
- 0/15/30/45 固定槽：忙检查跳过，释放后下一槽继续，其他目标继续；无完成后再延迟策略。
- 归档 detail 阻塞时两个目标继续检查；SQLite 实际 HTTP 读取及配置写入可完成。
- 同步期间新编辑观察持久登记；旧执行完成保持新 revision 待处理，不推进成功时间。
- 实际处理版本不同于领取观察时不能冒领成功。
- 无效编辑信号保留旧可信版本和其他可读信号，原始秘密不出现在状态/日志。
- 取消中断执行后 API 重开仍 running；独立运行入口取得锁后恢复并成功归档。
- 停用后后续固定槽无来源请求；删除关联保留状态和成功归档。
- 2 个有界检查槽用尽时跳过，不创建排队检查；后续轮转覆盖全部 5 个目标。
- 首次检查来源失败保留既有归档可信观察；HTTP 直接公开分项成功/待处理、实际版本及独立同步错误。
- 隔离独立子进程连续四槽、同路径重启保留成功时间。
- 生产 CLI 在空目标隔离库中 `--once`、常驻启动、重复进程拒绝及 SIGTERM 干净停止；无真实来源请求。

`backend/tests/test_migrations.py` 新增 v9→v10 真实文件迁移、失败回滚重试、旧配置/归档保留、未检查只读 HTTP、状态合并/代次/错误/领取、停止与历史保留。既有管理/归档/评论/媒体测试作为回归。

## 隔离演示记录

实际执行 `uv run python -m backend.tests.collector_demo --database <全新临时SQLite>`，输出公开 HTTP 状态：

| 受控槽 | 检查状态 | 工作 | 最近检查 | 最近实际成功 |
| --- | --- | --- | --- | --- |
| 0 | checked | pending | 2030-01-01T00:00:00+00:00 | null |
| 15 | unchanged | complete | 2030-01-01T00:00:15+00:00 | 2030-01-01T00:00:15+00:00 |
| 30 | unchanged | complete | 2030-01-01T00:00:30+00:00 | 保持 15 秒时刻 |
| 45 | unchanged | complete | 2030-01-01T00:00:45+00:00 | 保持 15 秒时刻 |

虚构目标 ID 123，无图与确认零评论；成功来自实际归档而非检查基线。运行入口、命令、进程锁与重启说明见 [后端 README](../../backend/README.md#23-独立采集进程)，状态契约见 [collector-api.md](../../docs/backend/api/collector-api.md)。

## 验证结果

- `uv run pytest backend/tests/test_collector.py -q`：11 passed。
- `uv run pytest backend/tests/test_collector.py backend/tests/test_initial_archive.py backend/tests/test_migrations.py -q --tb=short`：65 passed。
- `uv run pytest backend/tests -q --tb=short`：301 passed。
- `pnpm typecheck`：通过。仓库未配置 Python 静态类型检查器，不将 pytest 冒称类型检查。
- `pnpm test --maxWorkers=2`：21 个文件、204 tests passed。
- 首轮默认 `pnpm test` 与后端全量并行时，一个未改动的 `discussion-history` 用例触发 5000ms 超时；单文件复跑 18 passed，随后限制前端测试 worker 的全量复跑 204 passed。未修改测试超时或前端代码，不据此断言失败根因。
- 隔离演示及同库重启实际执行各输出 4 个槽，成功时间保留；生产 CLI 启停/互斥通过子进程测试。
- `git diff --check`：通过。

## 双轴审查

### Standards

初审发现 1 项硬违规（尚未补齐交付记录）和 7 项判断建议。交付记录本次补齐；写事务归档完整性判断改为 SQL 状态谓词，不在写事务中加载全部根文档；测试改为可观察条件等待；演示使用独立共享 support，不导入测试用例。重复入选谓词、幂等日志配置、固定脱敏异常捕获与模块职责属于低风险结构建议，不视为阻断缺陷。

### Spec

初审无确认缺陷，提出部分完成可观察性与单执行阶段的两项判断。HTTP 已增加 `parts/synced_version` 直接展示部分完成；保留有界串行执行阶段，明确其他目标检查不受慢同步阻塞，不承诺无限同步并发。另补齐旧归档可信观察在新接口中的基线读取与首次失败保留。修正后由 review 子代理复核：无残余确认缺陷。

## 未验证事项

没有真实上游、真实 OSS 或长期运行稳定性结论。默认 4 个并发检查/1 个执行阶段是资源边界，不是所有目标每槽必完成的许诺；容量不足跳槽并轮转。未纳入近期模式、计数触发、每日校准、退避或自适应频率。现有归档 API 的分项 work/checkpoint 不等于新管理 UI 已交付。
