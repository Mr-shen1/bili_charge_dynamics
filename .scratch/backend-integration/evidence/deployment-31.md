# #31 隔离部署专项证据

## 环境与复现

2026-10-16，Linux 7.2.9-2-cachyos x86_64，Node v24.21.0（nvm）、pnpm 10.34.6、uv 0.12.23、Python 3.12.15，Nginx 1.28.0 从官方源码在用户临时目录编译，无 make install、系统 reload 或云操作。依赖沿用原 `pnpm-lock.yaml`、`uv.lock`，未增加依赖。此主机不是 2 核 2GB 验收环境，不据此推容量。

```bash
source ~/.nvm/nvm.sh
nvm use
pnpm install --frozen-lockfile
uv sync --locked --group dev
pnpm typecheck
uv run --no-sync pytest backend/tests/test_deployment_processes.py -q
uv run --no-sync pytest backend/tests -q
pnpm test --maxWorkers=2
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
pnpm test:e2e
pnpm test:e2e:manage
pnpm test:e2e:archive
pnpm test:e2e:preview
NGINX_BIN=/tmp/bili-31-nginx/nginx-1.28.0/objs/nginx \
NGINX_MIME_TYPES=/tmp/bili-31-nginx/nginx-1.28.0/conf/mime.types \
pnpm test:delivery
```

上述 Nginx 路径是本次临时编译输出，不是跨机器依赖。源码下载/编译命令见正式交付说明第 4 节。4173 为临时 Nginx 回环监听，API 从空闲回环端口选择；两个 Python 进程共享临时目录的同一个 `deployment.sqlite`。正常或异常退出均清理测试进程；测试结束移除临时数据、恢复生产 dist，不持有真实环境。

## 实际输出摘要

```text
669 passed, 3 warnings in 142.59s (0:02:22)
Test Files 25 passed (25)
Tests 268 passed (268)
development: 104 passed, 10 skipped
management: 7 passed
archive: 38 passed
preview: 96 passed, 10 skipped
nginx: 106 passed (44.4s)
PASS: 生产与显式 mock bundle 构建可复现；fault 构建仍使用 production 装配
PASS: build update /assets/index-BJeTzpq2.js -> /assets/index-Djg1z2DG.js; conditional entry and browser reload use release B
PASS: production Adapter, four deep links/reloads, public images, read-only browsing, API/resource errors and secret scan
PASS: build update /assets/index-BTVOgYMH.js -> /assets/index-C7nDeOSd.js; conditional entry and browser reload use release B
PASS: real API + collector share SQLite; production build update, API unavailable 502 and diagnostic secret scan
PASS: tracked-only clean install/build is byte-identical
```

## HTTP 与缓存观察

由脚本逐一断言，而非仅配置检查：

| 路径/动作 | 观察 |
| --- | --- |
| `/`、`/ups/202`、`/dynamics/91001`、`/manage` 直达及刷新 | 200，入口 `no-cache`，生产 API 内容/管理页面可见；未知页刷新仍显示前端未找到 |
| 未变入口 ETag、Last-Modified 条件请求 | 304，`no-cache`，空响应体 |
| 生产构建更新后旧 ETag | 200 新入口，引用新 hash，浏览器实际执行 release-b 标记，正文可读 |
| 新旧入口引用的 JS/CSS | 200，正确 MIME，`public, max-age=31536000, immutable`；旧哈希仍可取 |
| `/api/manage/ups` | 200 JSON，`no-store` |
| `/api`、`/api/no-such-route`、`/api/archive/dynamics/99999` | 404 JSON，`no-store`，无 SPA root |
| `/api/archive/dynamics?limit=0` | 422 JSON，`no-store`，无 SPA root |
| 停 API 后 `/api/archive/ups?token=<虚构秘密>` | 502，`no-store`；Nginx 原生错误 HTML 不是 SPA 入口 |
| `/assets/missing.js`、无扩展名资源、缺图/样式/头像 | 404，`no-store`，无 SPA root |
| 业务图 | 归档返回 `https://media.example.invalid/deployment.png`，浏览器原样直取；只替换外部图片 HTTP，不代理或回退来源 |
| 浏览归档、评论、管理/重读 | API 请求均 GET，不调用同步/采集写入口、不访问 B站来源 |

## 真进程恢复与脱敏

六个 pytest 用例使用真实 Uvicorn 和独立 `Collector.run()`（固定真实 15 秒调度，不 mock 内部锁/仓储/协调）。配置与目标走 HTTP；来源和上传通过测试专属 `.block/.entered` 文件门闩，只在确认进入外部 I/O 后检查 API 可读可写。门闩和进程清理属于测试装配，不进入生产。

- API 单独启动无自动采集，重启后配置和未检查状态保留。
- 单采集完成正文、零评论和模拟图片上传，检查/成功时间与 archive 经 HTTP 可读，重开保留。
- 来源阻塞时 API 请求及配置保存不等待来源；上传阻塞时已提交正文仍可读。
- 同库第二采集进程拒绝；API 重启不恢复 running。SIGKILL 采集后，阻塞新检查再重启采集，仅持久未完成工作即可完成媒体，revision/检查时间不被伪造为新检查。
- 上传失败保持 pending 和固定错误，重启后无需新信号即可重试；无 collector 的反复浏览不进入外部 I/O、不改变检查。
- 外部异常携带虚构秘密，HTTP、公开状态、子进程日志均不包含它；构建/页面/Nginx 诊断也扫描同一标记。

Nginx 日志 red→green 的最小装配：直接包含交付 server，临时 root/端口，API 指向未监听端口，GET 带秘密 query，观察 502 后检查进程 stderr。修正前断言失败，修正后通过；最终脚本保留同场景。其余 API/采集功能为已有能力的部署回归。

## 干净副本

使用 `git ls-files -z` 打包当前版本化文件，再加入本次新增脚本与测试到独立临时目录；未复制 node_modules、.venv、.env、ignored 参考、用户两个未跟踪 Markdown。分别重新 `pnpm install --frozen-lockfile`、`uv sync --locked --group dev`、`pnpm build`，`diff -r` 完整生产 dist 字节一致。缓存仅用于获取锁定依赖，副本依赖目录全新；不是离线安装保证或跨平台字节保证。

副本的双进程专项也执行通过：`6 passed in 55.00s`（仅证明本次环境）。提交后可直接使用下列命令复现，不需要脚本缓存或 ignored 输入：

```bash
# 仓库根目录，已按正式文档准备 nvm/pnpm/uv；仅打包版本化文件
clean=$(mktemp -d)
git ls-files -z | tar --null -T - -cf - | tar -xf - -C "$clean"
pnpm build
(
  cd "$clean" || exit 1
  nvm use
  pnpm install --frozen-lockfile
  uv sync --locked --group dev
  pnpm build
  uv run --no-sync pytest backend/tests/test_deployment_processes.py -q
)
diff -r dist "$clean/dist"
# 完成后删除本次创建的临时副本，不触碰原仓库
rm -r "$clean"
```

详细结论、首轮环境限制与未验证风险见 [验收记录](../acceptance-31.md)。
