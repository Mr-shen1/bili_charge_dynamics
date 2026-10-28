# 本机「与云端同形式」部署：准备阶段与安全测试证据

> **这是任务阶段证据，不是第二份部署指南。** 当前操作只以 [统一部署指南](../../docs/deployment/README.md) 为准。下文的“未提交”、旧 `e58271c` 包及早期硬编码锚点属于开发、回归当时的记录；现行锚点规则见 §1.1，最终包以已提交 main 的 `prepare` 与 `--check` 输出为准。实际 sudo 安装结果另行记录，不能由本准备记录推断已安装。

> 任务：为**本机新部署**（不复用 live-34）提供 `scripts/` 安装工具、可审阅的离线安装包，以及本目录的实施证据。
> 约束：不改业务代码、不改 `docs/`、`README`、`backend/README`、前端源码；不 `git switch/reset/stash/commit/push`；
> 未执行真实 sudo、未安装系统软件、未启动任何服务、未访问 B 站／OSS／飞书／生产库。
> 统一主指南由另一 agent 维护在 `docs/deployment/README.md`；脚本的固定接口另见 `/tmp/bili-local-deployment-interface.md`。

## 1. 交付物

| 路径 | 说明 |
| --- | --- |
| `scripts/prepare-local-deployment-package.sh` | 非 root 构建离线安装包：干净快照 → 冻结依赖 → `pnpm check` / `check:dist` → bundle/dist/uv/模板/渲染文件 → `MANIFEST.sha256` |
| `scripts/setup-local-deployment.sh` | 交互向导（唯一安装入口）：7 阶段、每阶段 confirm、sudo 只在用户 TTY 提示；`--check` 为只读预检 |
| `/var/tmp/bili-local-deployment/e58271c/` | 已生成的安装包（78 MB，51 个文件），见 §2；不在仓库内、未提交 |
| `.scratch/local-cloud-deployment/tests/sandbox-safety-tests.sh` | 沙箱安全分支测试（**59 项**，不 sudo、不装软件、不启服务；fixture 已入库） |
| `.scratch/local-cloud-deployment/tests/fixtures/nginx-1.30.6-1.conf` | 真实 **Arch 官方 1.30.6-1** 包默认 `nginx.conf`（2717B，`sha256=7cd7c15a…49b9`），来源/版本见同目录 `README.md` |
| `.scratch/local-cloud-deployment/evidence/verification-log.txt` | 本轮全部验证命令与输出（可复跑） |

两个脚本均为**新增未提交文件**；`deploy/bili-monitor.env.example` 有一处**未提交的注释级改动**（见 §6）。

## 1.1 版本锚点（v2：不再硬编码提交）

脚本内**没有**任何硬编码提交 SHA，期望版本（锚点）在进入向导时固定：

| 模式 | 来源 | 约束 |
| --- | --- | --- |
| 默认 `repo-head` | 正在运行的脚本所在受信仓库的 `HEAD` | `HEAD == refs/heads/main`；`HEAD` 中存在 `scripts/setup-local-deployment.sh` 且与运行中的脚本**逐字节相同**；`scripts/` 无未提交改动 |
| `--commit <40位SHA>` | 操作者显式给出（只用于旧包回归/复现） | 必须完整 40 位；不依赖当前 HEAD |

- 包目录默认 `/var/tmp/bili-local-deployment/<锚点短SHA>`；`--package` 仍可显式指定同版本目录。
- `preflight` 只把包 `VERSION.commit` 与锚点比对，**从不**用包内 VERSION/MANIFEST 反推期望值。
- root 写入前（Stage 4/5）`assert_anchor_stable` 再确认：`repo-head` 模式下源 HEAD 未变动、包提交 == 锚点；
  随后重新校验 MANIFEST/属主，并用 bundle 内锚点提交反向校验 `render/`。
- 现状：运维脚本尚未提交，故默认锚点模式会**正确拒绝**（"受信 HEAD 中没有 scripts/setup-local-deployment.sh"）；
  旧包回归须显式 `--commit e58271c6e093b436bfbfc9bb45d3d7a7d349be19`。等运维脚本提交并合入 main 后，
  默认模式即可用，再用 `prepare` 重打最终包（本轮按指示**未重建**）。

## 1.2 旧部署文档删除后的一致性修复（deploy 模板，未提交）

旧 4 页部署文档已物理删除、只留 `docs/deployment/README.md`；`deploy/` 与 `scripts/deploy-frontend.sh` 里的死指针已机械改为该主指南，
**运行指令未变**：

- `deploy/bili-monitor.service`：`Documentation=file:/srv/bili-monitor/app/docs/deployment/static-delivery.md`
  → `.../docs/deployment/README.md`（systemd 元数据），另两处注释指针同步；
- `deploy/nginx-ecs-https.conf`、`deploy/nginx-ecs-tunnel.conf`、`scripts/deploy-frontend.sh`：注释里的旧路径 → `docs/deployment/README.md`；
- `deploy/`+`scripts/` 中已无旧文档/旧 runbook 指针（脚本扫描为空）。

该改动属于**新部署提交**的一部分：打包脚本的闸门只允许 deploy 模板做"注释级"工作区同步，`Documentation=` 不是注释行，
因此 `prepare` 在旧锚点（e582）下会拒绝把工作区版本并入旧包（实测见 `evidence/verification-log.txt` §12）。
新的最终包必须在**包含该改动的提交**上生成，此时 `render` 与 bundle 内模板逐字节相同，`verify_bundle_and_render` 照常通过。

> 旧包 `e58271c` 的 unit 仍记录旧 Documentation 路径——它只用于 `--commit` 旧锚点回归，**不交给用户安装**。

## 1.3 B4：发行包默认 `listen 80`（新装 Arch/CachyOS 必现）

核验：只读包检查记录及已入库的真实包默认配置 fixture
`tests/fixtures/nginx-1.30.6-1.conf`（2717B，`sha256=7cd7c15a…49b9`，第 38–39 行有激活的 `server { listen 80; }`，且**没有** `conf.d` include）。

处理（`scripts/setup-local-deployment.sh`）：

1. **硬阻断**：删除 `仍要启用 nginx？`/`NGINX_80_RISK` 软门；新增 `list_static_listen_80`（排除本项目 `bili.conf`）与
   `assert_no_listen_80_effective`（`nginx -T` 解析 include 后的**有效配置**，命中 80 立即 `die`）。该硬门在 Stage 5（配置后）、
   Stage 7（`nginx -t` 后）以及**紧接 `enable --now`/`reload` 之前**各执行一次，不存在“先启起来再靠健康检查发现”的路径。
2. **只对本次新装、已确认未改动的包原始配置自动处理**（`ensure_nginx_main`）：
   - 来源：Stage 2 仅在运行前无 nginx 时写 `pkg:nginx-fresh-install=<版本>`；
   - 核验：`pacman -Q nginx` 版本、`pacman -Qo /etc/nginx/nginx.conf`、`/var/cache/pacman/pkg/nginx-<版本>-*.pkg.tar.*`
     **唯一候选**用 `bsdtar -xOf` 提取包原始配置并与现文件**逐字节比对**（不按结构猜）；
   - 动作：原始文件备份到 `/var/lib/bili-local-deployment/backups/nginx.conf.<UTC>.orig`（root 0700/0600），
     换成固定受管 main（`worker_processes auto` + 可选 `modules.d/*.conf` + `events` + `http{ mime.types; default_type; sendfile; keepalive; conf.d/*.conf; }`），
     **无任何 server/默认站点/80 监听**；`nginx -t` 失败按原内容和原 mode 回滚；成功登记 `backup:`/`file:`。
   - fail closed（不动任何系统文件）：缺缓存、多候选、文件被改、nginx 事先已存在、缺 `mime.types`、原始配置含 `load_module`。
   - 续跑：受管 main 只接受内容等于登记值，重跑不会把它当未知，也不会重复备份；
     旧版向导留下的“只加 include 但仍有默认 server”的登记值会被迁移闸门拒绝（交人工，不自动改写）。
   - 不删除 `/usr/share/nginx/html`、不碰 `/etc/nginx` 下其它站点/文件、不用 `--overwrite`。
3. **`--check` 不假称已隔离**：未安装 nginx 时明确提示“当前不能证明发行包默认配置安全，安装后必须原始核验、备份隔离默认站点、启动前硬检查”；
   若现有配置里已有 80 监听，直接记 problem（硬阻断）。
4. **健康检查按“本实例”口径**：有效配置无 80 + 80 端口上没有 nginx 进程；其它程序占用 80 只提示、不处理、不停服务。
5. **错误提示统一为“保留现场 + 人工核查”**（纯消息，逻辑未变）：`require_managed` 的“已修改配置”、
   “非本次新装的 nginx main”、“已存在未登记数据库”三处，统一为
   “保留现文件、备份与状态 / 保留数据库与现场，不删除、不移动真实配置或数据库，不手改 state，
   并按 `docs/deployment/README.md` 人工核查来源后处理”；不再给 `pacman -S nginx`、移走 main、手改 `state.tsv` 之类的“恢复步骤”。
   沙箱用静态守卫与两条负向用例锁住：旧文案回退即红，断言只允许安全拒绝措辞。
6. 测试 fixture 已入库：`.scratch/local-cloud-deployment/tests/fixtures/nginx-1.30.6-1.conf`
   （Arch 官方 `1.30.6-1`，2717B，`sha256=7cd7c15a…49b9`），测试默认走脚本相对路径；
   “移走 `/tmp` fixture 仍 59/59 绿”的历史回归记录保留在 `evidence/verification-log.txt` §14。

## 2. 安装包事实（`/var/tmp/bili-local-deployment/e58271c`，仅作旧包回归）

```
commit            e58271c6e093b436bfbfc9bb45d3d7a7d349be19（refs/heads/main）
short             e58271c
生成时间(UTC)     20261028T033237Z
MANIFEST.sha256   sha256 = 65c05e5e2fc98a1efc33638a975dbba55b678f26792173632ee566ed2aeb459e
文件数/大小       51 个文件 / 78 MB
前端              生产 dist 33 个文件，index.html sha256 = 88ae5c49…ac51f65f
uv                uv 0.12.23 (x86_64-unknown-linux-gnu)（ELF 副本，root 装到 /usr/local/bin/uv）
deploy 模板       unit 与 snippet 与提交逐字节相同；env.example 为注释级同步（见 §6）
bundle            e58271c6e093b436bfbfc9bb45d3d7a7d349be19 refs/heads/main（独立 bare fetch + fsck 通过）
```

包内结构（`README.md`/`PROVENANCE.md`/`VERSION` 同目录）：

```
MANIFEST.sha256 + MANIFEST.sha256.sha256 + VERSION + PROVENANCE.md + README.md
repo/bili-charge-dynamics-e58271c.bundle
frontend/dist/**（生产）+ frontend/dist.sha256
uv/uv + uv/uv-version.txt
deploy/{bili-monitor.service,bili-monitor.env.example,nginx-ecs-tunnel.conf,nginx-locations.conf}
render/etc/bili-monitor/env                          → /etc/bili-monitor/env（0600）
render/etc/systemd/system/bili-monitor.service       → /etc/systemd/system/bili-monitor.service（0644）
render/etc/nginx/snippets/bili-locations.conf        → /etc/nginx/snippets/bili-locations.conf（0644）
render/etc/nginx/conf.d/bili.conf                    → /etc/nginx/conf.d/bili.conf（listen 127.0.0.1:4273）
verify/bundle-verify.txt
```

**与云端唯一指令差异**：`listen 127.0.0.1:4173` → `127.0.0.1:4273`（外加一段来源注释头）。
`proxy_pass` 两处仍为 `127.0.0.1:8000`；unit 与 `nginx-locations.conf` 与提交模板逐字节相同。

**渲染 env 的有效行只有三行**：`BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite`、
`PYTHONDONTWRITEBYTECODE=1`、`PYTHONUNBUFFERED=1`。OSS 七项、Cookie、通知全部保持**注释**
（变量不存在，不是空字符串）；Cookie/通知示例路径按云端实测统一为
`/srv/bili-monitor/credentials/cookie.txt`、`/srv/bili-monitor/credentials/notifications.json`。
因此本机初始态是 **API＋collector 两进程、通知闸门 off、功能未启用**，不是“已接入但关闭”，也不生成假 Cookie/webhook。

## 3. 前端构建的隔离性（回应「避免开发仓库 ignored 污染」）

- 源码来自 `git archive e58271c` 的**干净快照**，不是工作区；ignored 的 `.env`、`dist/`、`node_modules/` 不参与。
- 快照内断言不存在任何 `.env` 文件、不存在预置 `dist/`/`dist-mock/`/`node_modules/`。
- `pnpm install --frozen-lockfile`、`pnpm run check`、`pnpm run check:dist` 全部在 `env -i` 下执行
  （只带 HOME/PATH/TMPDIR/LANG/CI 与代理变量），脚本启动时还会擦除操作员 shell 的 `VITE_*` / `BILI_*`；
  擦除名单写入包内 `VERSION` 的 `oper_env_scrubbed`。
- 只收录生产 `frontend/dist`；`grep -rIl '__preview-fixtures'` 无命中，包内无 `dist-mock`。
- 安装向导自身不使用任何 `.env`，不继承操作员 `BILI_*`（启动时清除并提示），
  后端运行环境只来自 `/etc/bili-monitor/env`；`bili` 子进程一律 `env -i` 启动。

## 4. 安装向导的阶段与安全边界

进入向导时先**固定锚点**（受信仓库 main HEAD 或 `--commit`，见 §1.1），再解析包目录；一次 sudo 授权
（密码只在用户 TTY 输入，不捕获/不持久化/不打印，不改 sudoers），7 个阶段：

1. **预检（只读）**：MANIFEST、VERSION↔dist 互证、bundle 独立验证、必需命令、`/etc/nginx` 包归属、
   软件源中 nginx 版本、`bili` 账号、8 类目标路径的 absent/ours/modified/unknown 判定、8000/4273 占用、既有 `listen 80` 扫描。
   有任何阻塞项即停止，不做改动。
2. **管理员依赖**：`pacman -S --needed --noconfirm nginx git rsync sqlite`（**不 `-Syu`、不 `--overwrite`**）+
   `install -m 0755 /usr/local/bin/uv`（包的 uv 二进制）。
3. **账号与目录**：`useradd -m -s /bin/bash bili`；`/srv/bili-monitor{,/backup}` 0755、
   `credentials/` **0700 空目录**、`/srv/dynamics-viewer/releases`、`/etc/bili-monitor`、`/etc/nginx/{conf.d,snippets}`；
   不动 `/srv` 下既有的 `ftp/`、`http/` 等目录。
4. **代码与依赖**：从包内 bundle 检出到 `/srv/bili-monitor/app`（单检出，无 releases/current），
   校验 `HEAD==e58271c` 与工作区干净；`sudo -u bili env -i … uv sync --locked --no-dev --python 3.12`，
   断言 venv Python 为 3.12.x、解释器在 `/home/bili/.local/share/uv/python/…`、无 pytest（`--no-dev`）。
5. **系统配置**：安装 §2 的四个文件；若 `nginx.conf` 缺 `conf.d/*.conf` 的 include，
   先把原文件备份到 **`/var/lib/bili-local-deployment/backups/nginx.conf.<UTC>.bak`（root 0700 私有，不污染 `/etc/nginx`）**，
   再在 http 块末尾精准插入一行并 `nginx -t`，失败按原 mode 自动回滚；
   `mime.types` 未加载时直接拒绝（否则 JS 以 octet-stream 发出，浏览器拒跑模块脚本）。
6. **前端发布**：`rsync` 到 `releases/<UTC>-e58271c`，`ln -sfn` + `mv -Tf` 原子切换 `current`；
   只清理本项目命名规则的历史版本（保留最新 5 个）；同产物重跑跳过发布。
7. **校验与启动**：`nginx -t`、`systemd-analyze verify`、权限/属主与 env 有效行复核 → confirm →
   `enable --now nginx` / `enable --now bili-monitor`（配置有变则 restart）→ **先把 `service:` 与 `db:` 状态落盘** →
   只读 GET 健康检查 → 打开 `http://127.0.0.1:4273/`。因此健康检查即使失败，重跑也不会把自己的服务/库判成未知对象。

健康检查全部是 `127.0.0.1` 的只读请求：`/api/manage/ups == {"ups":[]}`、
`/api/manage/notifications == {"state":"off","pending":0}`、页面 `/` 与 `/manage` 200、
未知 API 404 + `no-store`、哈希资源（**挑 >1024B 的 `.js`，真实 GET + `--compressed` 协商 gzip**）`immutable` + gzip、
8000/4273 只监听回环、无 80 监听、
`bili` 名下 python 进程 ≥2、`PRAGMA user_version>0`（空库由迁移创建）、journal 无 traceback。
**不调用** `POST /api/manage/ups`、`/api/sync/initial`、targets 写接口，因此空库零上游请求。

## 5. 已验证（详见 `evidence/verification-log.txt`）

| 项 | 结果 |
| --- | --- |
| `bash -n` 两个脚本 | 通过 |
| `shellcheck` | **本机未安装，未运行**（如实记录，不算通过） |
| wizard library 前缀与 `template.sh` | 前 **199 行逐字节一致**（`cmp` 通过） |
| 安装包 `sha256sum --check --strict MANIFEST.sha256` | 51 个文件全部成功 |
| bundle 独立验证 | bare fetch + `rev-parse` + `fsck --strict` 通过，heads = e58271c refs/heads/main |
| unit / snippet 与 e58271c 模板 | `cmp` 逐字节相同 |
| nginx server 差异 | 仅 `listen 4173→4273` 一行 + 来源注释头 |
| env 有效行 | 恰好 3 行（DB + 2×PYTHON） |
| 生产 dist | 33 文件、无 mock 路由、无 dist-mock、`dist.sha256` 存在 |
| `wizard --check` | 退出 0；未写文件、未调用 sudo（测试断言 `/var/lib` 无新增） |
| 锚点来源（v2） | 默认 `--check` 在脚本未提交时**正确拒绝**；`--check --commit e582…`（旧包）EXIT=0；`--commit` 短 SHA/不存在对象均拒绝；`prepare --commit e582…` 命中已有同版本包时秒退 0 且包 MANIFEST 不变 |
| 脚本内硬编码提交 | 静态守卫断言两个脚本中**无** 40 位十六进制提交 SHA |
| 沙箱安全分支测试 | **59/59 通过**；其中 B4/F1/F2 相关 17 例（**13 例使用入库 fixture**，已用“移走 /tmp fixture”复跑验证） |

沙箱测试覆盖（替换 sudo 与命令、把绝对路径重定向到 `/var/tmp` 沙箱，不碰真实系统）：
静态守卫（无 `sudo -n`/`NOPASSWD`/`-Syu`/`--overwrite`/`apt`/`sites-enabled/default`、无打印 env、无非回环 curl、必须 `env -i`）、
library 前缀一致、`bash -n`、包 MANIFEST/VERSION/uv、生产 dist 隔离、渲染文件与模板一致、
`--check` 只读通过/拒绝被篡改包/拒绝 other 可写包、state 往返、`path_owner` 四种判定、
`require_managed` 拒绝未识别与被改动文件、`install_managed` 幂等且拒绝覆盖用户改动、
nginx.conf 缺 include 时插入且幂等、`nginx -t` 失败自动回滚、缺 mime.types 拒绝、`listen 80` 告警、
前端原子发布与同产物跳过、`current` 被改动时拒绝发布、端口占用检测、
preflight 干净沙箱零问题且**零 sudo 调用**、拒绝未识别 unit／被改动 unit／占用端口／未识别 `/usr/local/bin/uv`。

F1（fixture 入库）：默认 fixture 改为脚本相对路径 `tests/fixtures/nginx-1.30.6-1.conf`，硬断言 2717B 与 `sha256=7cd7c15a…49b9`；
把 `/tmp/bili-nginx-pkg.pIRIoM` 移走后仍 57/57 绿；显式指向不存在的 fixture 会 45 通过 / 12 失败（不静默 skip）。
F2（中断恢复）：`ensure_nginx_main` 成功登记后**立即 `state_save`**；若“写盘成功、登记前中断”，在“本次新装 + pacman 归属 + 缓存包原文”已成立的前提下，
用同一生成器产出预期受管 main 与现文件逐字节比较，**完全一致才补登记、绝不重写**。
不一致时**只 fail closed，不给“人工出路”清单**：固定建议是**保留现文件/备份/state 不动（不删除、不移动真实配置、不手改 state）**，
停止安装，并按唯一主指南 `docs/deployment/README.md` 人工核查来源后再处理。
理由：`pacman -S nginx` 不保证覆盖已修改的 backup 配置（通常只产出 `.pacnew`）；让用户移走 main 配置不能作为自动安装失败的泛用建议；
手改 `state.tsv` 登记真实 sha 会绕过“未知配置”信任护栏——这些都不能由 bootstrap 自行“解决”。
新增“冷重载 state 后续跑”“中断补登记”“两条错误提示只含固定安全建议”共 4 例，不依赖同进程内存状态。

B4 相关覆盖（真实 fixture `7cd7c15a…`）：正例（默认配置→备份 0600→受管 main 无 server/80→续跑幂等）、
被人工改动不动、缺可信缓存不动、非本次新装不动、多缓存候选不动、`nginx -t` 失败按原内容/mode 回滚、缺 `mime.types` 不动、
静态 80 扫描（含排除本项目站点）、有效配置含 `listen 80` 与 `127.0.0.1:80` 均硬阻断、预检对既有默认 80 硬报、
预检在未装 nginx 时给出“不能证明安全”提示；静态守卫断言脚本内无 `仍要启用 nginx`/`NGINX_80_RISK`、
健康检查不再用全局 ss 80 断言、且 `enable --now nginx` 之前存在有效配置硬检查。

沙箱新增覆盖（第三轮：锚点来源）：默认取受信仓库 main HEAD 且包路径按短 SHA、脚本与 HEAD 不一致拒绝、
HEAD 不在 main 拒绝、向导运行期间源 HEAD 变动拒绝 root 写入、`--commit` 显式锚点不受 HEAD 漂移影响、非完整 SHA 拒绝；
静态守卫新增"脚本内不得出现硬编码 40 位提交 SHA"。

沙箱新增覆盖（第二轮安全复核后）：**首启/健康检查失败后的真实文件集重跑**（自有 nginx 配置、备份、DB、`current` 全部识别；外部文件仍拒绝且提示"移走/改名"而非删除）、
**包信任锚**（group 可写成员、非 sticky 0777 父目录、包内软链、提交与钉住版本不一致、**重算 MANIFEST 的恶意 unit** 均被拒；`/var/tmp` 1777 sticky 祖先合法放行）、
**gzip 探测**（真实 GET 协商通过、服务器不压缩时判失败、只有小资源时明确报"无法验证压缩"）。

早前测试已发现并修正两个真实缺陷（硬编码路径改为按配置推导，生产语义不变）：nginx.conf 备份路径、`listen 80` 扫描目录。

## 6. 安全复核修复记录（B1/B2/B3，红→绿）

| 项 | 根因 | 修复 | 回归证据 |
| --- | --- | --- | --- |
| **B1** 首装必在健康检查失败 | 用 `curl -sSI`（HEAD，不发 `Accept-Encoding`）断言 `Content-Encoding: gzip`，nginx 只对声明可压缩的客户端压缩 ⇒ 永远失败；且未挑 >`gzip_min_length`(1024) 资源 | 抽出 `probe_static_assets`：挑 current/assets 里首个 **>1024B** 的 `.js`，用 **真实 GET + `curl --compressed`** 取响应头，同时验 immutable；找不到大资源时明确报"无法验证压缩"而不是误报 | 沙箱 `gzip 探测：…协商通过…`、`…服务器未压缩时判失败`、`…只有小资源时…` 三例；`probe_static_assets` 用 python 假服务器（仅在收到 `Accept-Encoding: gzip` 且 >1024B 时压缩）验证 |
| **B2** 重跑被自己的产物挡住 | ①`/etc/nginx` 包归属扫描把自有 `bili.conf`/snippet 与 `/etc/nginx` 里的备份判为"未被包拥有"；②首启迁移创建的库只有健康检查通过后才登记 `db:`，健康检查失败即丢记录，重跑判 `unknown`；③提示语"备份/删除后重跑"会诱导删库 | ①扫描跳过**已安装/已登记**的自有文件与登记过的备份路径，旧版 `/etc/nginx/*.bak` 只按精确命名识别并提示**移走**，未知文件仍拒绝；②库文件一出现（`wait_api` 探测到即 `db:`+落盘）与 `service:` 均在健康检查**之前**登记，`path_owner` 新增 `db` 判定；③所有提示改为"移走/改名，**不要删除数据库或真实配置**"；④nginx.conf 备份改到 `/var/lib/bili-local-deployment/backups/`(root 0700) | 沙箱 5 例：首启真实文件集 0 问题、健康失败后连跑两次 0 问题、外部 nginx 文件仍拒绝且提示移走/改名、旧版备份精确标记、未登记 DB 拒绝且提示"不删除"+移走/改名 |
| **B3** root 从无锚点 `/var/tmp` 目录安装 | 只拒 other 可写包目录；commit 只与包内 VERSION 自洽；软链/组写/父目录未校验 | ①`assert_trusted_package`：包与**每一级祖先**属主 ∈{操作员,root}、group/other 可写仅允许 root+sticky（`/var/tmp` 1777 例外）、包内无软链/设备/fifo、无 group/other 可写条目；②向导硬编码 `PINNED_COMMIT=e58271c…` 并与 VERSION/bundle `refs/heads/main` 比对；③**信任锚**：安装前用 bundle 里的钉住提交反向校验 `render/` 的 unit 与 snippet 逐字节相同、nginx server 仅差 `listen 4173→4273`（忽略注释行），env 有效行/DB 路径/不得有未注释 OSS·Cookie·通知；④root 写入前（Stage 4/5）再跑一次包校验与锚定 | 沙箱 6 例（见上）；**真实包实测**：替换 unit 后重算 MANIFEST（攻击者视角自校验通过）仍被 `--check` 以"render unit 与钉住提交…不一致"拒绝（`evidence/verification-log.txt` §11） |

## 6.1 已存在数据库/配置的处置提示（不诱导破坏）

未登记的库/配置一律拒绝，提示固定为"移走/改名（**不要删除数据库或真实配置**）"，并在 `--check` 输出里说明来源；
库文件永远只登记 `db:`，向导不会删除或覆盖它。nginx.conf 备份落在 `/var/lib/bili-local-deployment/backups/`，
旧版遗留在 `/etc/nginx` 的备份只按精确命名识别并提示"移走"。

## 7. 未完成 / 需用户执行（不得宣称已部署）

1. **没有任何系统改动被做**：`bili` 账号、`/srv/bili-monitor`、`/srv/dynamics-viewer`、`/etc/bili-monitor`、
   nginx、unit、服务启动、数据库都**尚不存在**。
2. 用户需在自己的终端执行**一次**（不是 8 条手做命令）：

   ```bash
   cd /home/kevin/Projects/PI/bili_charge_dynamics
   scripts/setup-local-deployment.sh --package /var/tmp/bili-local-deployment/e58271c
   ```

   只读预检可先跑：`scripts/setup-local-deployment.sh --check --package /var/tmp/bili-local-deployment/e58271c`。
3. `uv sync` 首次需要 PyPI 与 uv 的 CPython 分发网络（缓存/解释器落在 `/home/bili`）；离线环境会失败并提示。
4. 浏览器验收、`nginx -t`/`systemd-analyze verify` 的真机结果、健康检查结果都要等用户跑完向导才有。
5. **未提交改动**（本次约定不 commit，交接给有权限者）：
   - 新增 `scripts/prepare-local-deployment-package.sh`、`scripts/setup-local-deployment.sh`；
   - 新增本目录证据与测试脚本；
   - `deploy/bili-monitor.env.example` **注释级改动**：Cookie 与通知示例路径统一为云端实测
     `/srv/bili-monitor/credentials/{cookie.txt,notifications.json}`（仍注释、不启用）。
     打包脚本对此有专门闸门：**只允许注释行差异**，非注释改动会拒绝打包；本次已在包内 `VERSION`
     标注 `deploy_templates=worktree-comment-only-sync(未提交):bili-monitor.env.example`。
6. 安装包在 `/var/tmp`（不会自动清理）。**等运维脚本提交并合入 main 后**重打最终包：
   `scripts/prepare-local-deployment-package.sh`（输出 `/var/tmp/bili-local-deployment/<新HEAD短SHA>`）；
   新提交必须包含本文件 §1.2 的 deploy 模板指针修复（否则新包 unit 的 `Documentation=` 仍是死路径）；
   本轮按用户指示未重建，`e58271c` 旧包仅用于 `--commit` 回归。
7. 用户最终可直接运行 `scripts/setup-local-deployment.sh`（锚点=受信 main HEAD，包路径自动按短 SHA 解析）。

## 8. 重跑边界

**支持**：中断后重跑（已完成阶段复用）、**首启/健康检查失败后重跑**（`db:` 与 `service:` 已在健康检查前登记）、
同产物前端跳过发布、配置无变化时只启服务不重启、向导记录且未被修改的对象可被新版本覆盖、依赖网络恢复后从 `uv sync` 继续。

**拒绝（默认不覆盖，需人工）**：未识别的已存在数据库／env／unit／nginx 配置／`current` 软链；
本脚本产物被用户改动（SHA256 漂移）；被其他进程占用的 8000/4273；已存在但非本脚本记录的
`bili` 账号或 `/usr/local/bin/uv`；`/etc/nginx` 下非包拥有的文件（不用 `--overwrite`）；
安装包 MANIFEST/bundle 校验失败或目录 other 可写；软件源库过期（提示人工 `pacman -Sy`）。
**不做**：自动备份用户数据、自动删除未知对象（含数据库与真实配置）、自动改 sudoers/SSH/swap、自动回退服务版本。
已存在数据库**永不删除/覆盖**：只登记 `db:`，未登记的库一律拒绝并明确提示"不删除、移走/改名"。

## 9. 已知限制

- nginx 版本必然是 Arch 包（1.30.x），非云端 1.26.3；语法在向导第 7 阶段实测，不声称版本一致。
- `systemd-analyze verify` 与 `nginx -t` 的真机结果未取证（本机未安装 nginx、未提权）。
- 沙箱测试不能替代真机：未验证 `useradd`/`pacman`/`uv sync`/systemd 启动/回环监听的真实结果。
- 向导不是“任意 root 命令入口”：所有 root 动作都是脚本内固定命令，参数来自安装包与固定的绝对路径。
- 本机 4173 留给 `ssh -N bili` 的 LocalForward；不改用户 SSH 配置，也不占用 4173。
- gzip 验收必须发真实 GET 且声明压缩（`curl --compressed` / `Accept-Encoding: gzip`）并选 >1024B 的资源；
  裸 `curl -sSI` 看到不到 `Content-Encoding` 是协议行为，不是配置错误。
- B4 修复后，**必须重新提交并重打安装包**才能交给用户安装：当前工作区脚本领先于已提交的 `23f50c4`，
  默认 `repo-head` 模式会正确拒绝（提示脚本与 HEAD 不一致）；`23f50c4` 包只用于 `--commit 23f50c4` 只读回归，不默认交付。
- 向导的包信任锚要求安装包版本 == 进入向导时固定的锚点；默认锚点必须来自受信 main HEAD 的已提交脚本，
  所以"提交前不能正式安装"是设计行为（旧包回归用 `--commit`），不需要也不允许在脚本里硬编码提交号。
