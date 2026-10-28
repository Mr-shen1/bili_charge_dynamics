#!/usr/bin/env bash
# 构建「本机与云端同形式部署」的离线安装包（只做非 root 的构建与固化，不改系统）。
#
# 用法（在仓库根目录，以普通用户执行；不需要 sudo）：
#     scripts/prepare-local-deployment-package.sh                # 用当前 main HEAD，输出 /var/tmp/bili-local-deployment/<HEAD 短SHA>
#     scripts/prepare-local-deployment-package.sh --output DIR
#     scripts/prepare-local-deployment-package.sh --commit <40位SHA>   # 显式旧提交（回归用）
#     scripts/prepare-local-deployment-package.sh --replace       # 覆盖同路径旧包
#
# 安装入口（由用户在自己终端执行一次，含 sudo 交互；省略 --package 时自动用锚点短 SHA 对应目录）：
#     scripts/setup-local-deployment.sh
#
# 本脚本的硬约束：
#   * 代码版本取「受信开发仓库的已提交 HEAD」（默认必须等于 main；可 --commit 显式指定旧提交），
#     不硬编码任何提交 SHA，也不从已有安装包的 VERSION/MANIFEST 反推；前端从 `git archive`
#     的**干净快照**构建，开发仓库里 ignored 的 .env / dist / node_modules 不参与。
#   * 构建子进程使用 `env -i` 的隔离环境：不继承操作员的 VITE_* / BILI_* / 代理之外的变量，
#     不 source 任何 .env，不读取云端凭据或 live-34 目录。
#   * 只收录生产 `frontend/dist`（不含 `dist-mock`），不含任何凭据、ignored 文件、开发 .venv。
#   * 产物自带 MANIFEST.sha256、VERSION、PROVENANCE.md，供安装向导在 root 操作前复核。
#
# 只写 $OUTPUT 目录；不安装系统软件、不调用 sudo、不启动服务、不提交 git。

set -euo pipefail

PINNED_REF="refs/heads/main"
EXPECTED_NODE="24.21.0"
EXPECTED_PNPM="10.34.6"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OUTPUT=""
REPLACE=0
CLI_COMMIT=""

usage() {
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while (($#)); do
    case "$1" in
        --output) OUTPUT="${2:?--output 需要路径}"; shift 2 ;;
        --commit) CLI_COMMIT="${2:?--commit 需要 40 位 SHA}"; shift 2 ;;
        --replace) REPLACE=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "error: 未知参数 '$1'（--help 查看用法）" >&2; exit 2 ;;
    esac
done

die()  { printf 'error: %s\n' "$1" >&2; exit 1; }
info() { printf '==> %s\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }

# ── 操作员环境擦除：任何 VITE_* / BILI_* 都不能进入前端构建或包内容 ────────────
SCRUBBED=()
while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    SCRUBBED+=("$name")
    unset -v "$name"
done < <(compgen -v | LC_ALL=C grep -E '^(VITE_|BILI_)' || true)

# ── 前置条件 ─────────────────────────────────────────────────────────────────
command -v git  >/dev/null || die "缺少 git"
command -v tar  >/dev/null || die "缺少 tar"
command -v node >/dev/null || die "缺少 node（先 nvm use 24.21.0）"
command -v pnpm >/dev/null || die "缺少 pnpm（只用 pnpm，不用 npm/yarn）"

NODE_BIN="$(command -v node)"
PNPM_BIN="$(command -v pnpm)"
NODE_DIR="$(dirname "$NODE_BIN")"

node_version="$("$NODE_BIN" -v)"
pnpm_version="$("$PNPM_BIN" -v)"
[[ "$node_version" == "v$EXPECTED_NODE" ]] || die "node 版本必须是 $EXPECTED_NODE，当前 $node_version（nvm use $EXPECTED_NODE）"
[[ "$pnpm_version" == "$EXPECTED_PNPM" ]] || die "pnpm 版本必须是 $EXPECTED_PNPM，当前 $pnpm_version"

# 隔离构建环境：空环境 + 只放必要变量。代理变量允许透传（不是构建输入），
# 但 VITE_* / BILI_* 一律不带，避免开发 shell 里的变量进入产物。
CLEAN_ENV=(env -i "HOME=$HOME" "PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin" \
           "TMPDIR=/var/tmp" "LANG=C.UTF-8" "CI=1")
for name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
    if [[ -n "${!name:-}" ]]; then CLEAN_ENV+=("$name=${!name}"); fi
done

# ── 版本锚定：期望版本只来自受信仓库的已提交 HEAD 或操作者 --commit，绝不硬编码 ──────
HEAD_COMMIT="$(git rev-parse --verify 'HEAD^{commit}')"
MAIN_COMMIT="$(git rev-parse --verify "$PINNED_REF^{commit}")"
if [[ -n "$CLI_COMMIT" ]]; then
    [[ "$CLI_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "--commit 需要完整 40 位十六进制 SHA（收到：$CLI_COMMIT）"
    COMMIT="$CLI_COMMIT"
    ANCHOR_SOURCE="operator(--commit)"
    git cat-file -e "$COMMIT^{commit}" 2>/dev/null ||
        die "--commit 指定的提交不在本仓库：$COMMIT（请先 fetch/确认对象存在）"
else
    COMMIT="$HEAD_COMMIT"
    ANCHOR_SOURCE="repo-head"
    [[ "$HEAD_COMMIT" == "$MAIN_COMMIT" ]] ||
        die "HEAD=$HEAD_COMMIT 不等于 $PINNED_REF=$MAIN_COMMIT：默认只从已合入 main 的提交打包（旧提交请显式 --commit）"
fi
git merge-base --is-ancestor "$COMMIT" "$PINNED_REF" ||
    die "提交 $COMMIT 不是 $PINNED_REF 的历史：拒绝为未合入 main 的提交打包"
SHORT="${COMMIT:0:7}"

# 包内容全部按提交内容重建（git archive / git show / git bundle），工作区脏文件不会进包；
# 这里只把「运行时相关路径的非文档改动」当作需要如实记录的信号，不阻断打包。
CODE_DIRTY="$(git status --porcelain=v1 --untracked-files=no -- \
    frontend backend deploy pyproject.toml uv.lock .nvmrc ':(exclude)*.md' 2>/dev/null || true)"
if [[ -n "$CODE_DIRTY" ]]; then
    printf 'warning: 运行时相关路径有未提交改动；包内容仍取自提交 %s，不含这些改动：\n%s\n' \
        "$SHORT" "$CODE_DIRTY" >&2
fi
CODE_DIRTY_LIST="$(printf '%s\n' "$CODE_DIRTY" | awk 'NF{print $NF}' | paste -sd ',' - || true)"
WORKTREE_DIRTY="$(git status --porcelain=v1 | wc -l | tr -d ' ')"
WORKTREE_DIRTY_LIST="$(git status --porcelain=v1 | awk '{print $NF}' | head -n 20 | paste -sd ',' - || true)"

OUTPUT="${OUTPUT:-/var/tmp/bili-local-deployment/$SHORT}"
PARENT="$(dirname "$OUTPUT")"
mkdir -p "$PARENT"
[[ -w "$PARENT" ]] || die "无法写入 $PARENT"

TMP_BUILD=""
SNAP=""
cleanup() {
    [[ -n "$TMP_BUILD" && -d "$TMP_BUILD" ]] && rm -rf "$TMP_BUILD"
    [[ -n "$SNAP" && -d "$SNAP" ]] && rm -rf "$SNAP"
    return 0
}
trap cleanup EXIT

# 已存在的目标：只有「MANIFEST 可校验且同版本」的本脚本产物才允许按 --replace 重建。
EXISTING_OURS=0
if [[ -e "$OUTPUT" ]]; then
    if [[ -f "$OUTPUT/MANIFEST.sha256" ]] \
        && ( cd "$OUTPUT" && sha256sum --check --strict --quiet MANIFEST.sha256 ) >/dev/null 2>&1 \
        && grep -qx "commit=$COMMIT" "$OUTPUT/VERSION" 2>/dev/null; then
        EXISTING_OURS=1
    fi
    if [[ "$REPLACE" != "1" ]]; then
        if ((EXISTING_OURS)); then
            ok "已存在同版本安装包并由 MANIFEST 校验通过：$OUTPUT"
            info "如需重建请加 --replace"
            info "安装命令：scripts/setup-local-deployment.sh --package $OUTPUT"
            exit 0
        fi
        die "目标已存在且不是本脚本产出的可校验安装包：$OUTPUT（拒绝覆盖；请换 --output）"
    fi
    ((EXISTING_OURS)) || die "目标存在但 MANIFEST 校验失败/不是本脚本产物，拒绝 --replace：$OUTPUT"
    info "按 --replace 重建：$OUTPUT"
fi

info "构建安装包 $OUTPUT（版本 $SHORT）"
TMP_BUILD="$PARENT/.$(basename "$OUTPUT").new.$$"
rm -rf "$TMP_BUILD"
mkdir -p "$TMP_BUILD"/{repo,frontend,uv,deploy,render/etc/bili-monitor,render/etc/systemd/system,render/etc/nginx/conf.d,render/etc/nginx/snippets,verify}

# ── 1. 干净快照 + 冻结安装 + 前端检查与构�建 ─────────────────────────────────
SNAP="$(mktemp -d /var/tmp/bili-local-deployment-snapshot.XXXXXX)"
info "从 $SHORT 导出干净快照（git archive，不含 ignored/.env/node_modules）"
git archive --format=tar "$COMMIT" | tar -x -C "$SNAP"

# 快照必须只有提交内容：不得出现 .env 之类的本地凭据/环境文件，也不得含构建产物。
if find "$SNAP" \( -name '.env' -o -name '.env.*' \) -print -quit | grep -q .; then
    die "快照里出现 .env 文件，拒绝继续"
fi
[[ -f "$SNAP/frontend/pnpm-lock.yaml" ]] || die "快照缺少 frontend/pnpm-lock.yaml"
[[ ! -e "$SNAP/frontend/dist" && ! -e "$SNAP/frontend/dist-mock" && ! -e "$SNAP/frontend/node_modules" ]] \
    || die "快照里出现构建产物或依赖目录，导出方式异常"

info "pnpm install --frozen-lockfile（隔离环境）"
"${CLEAN_ENV[@]}" "$PNPM_BIN" --dir "$SNAP/frontend" install --frozen-lockfile --reporter=append-only

info "pnpm check（typecheck + 单测 + e2e 项目守卫）"
"${CLEAN_ENV[@]}" "$PNPM_BIN" --dir "$SNAP/frontend" run check

info "pnpm check:dist（两次构建 + 产物隔离）"
"${CLEAN_ENV[@]}" "$PNPM_BIN" --dir "$SNAP/frontend" run check:dist

[[ -f "$SNAP/frontend/dist/index.html" ]] || die "生产产物 frontend/dist/index.html 缺失"
if grep -rIl -- '__preview-fixtures\|dist-mock' "$SNAP/frontend/dist" >/dev/null 2>&1; then
    die "生产产物里出现 mock/fault 自检路由或 dist-mock 标记，拒绝收录"
fi

info "只收录生产 frontend/dist（不含 dist-mock）"
rsync -a --delete "$SNAP/frontend/dist/" "$TMP_BUILD/frontend/dist/"
( cd "$TMP_BUILD/frontend/dist" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum ) \
    > "$TMP_BUILD/frontend/dist.sha256"
frontend_dist_files="$(find "$TMP_BUILD/frontend/dist" -type f | wc -l | tr -d ' ')"
frontend_index_sha="$(sha256sum "$TMP_BUILD/frontend/dist/index.html" | cut -d' ' -f1)"

# ── 2. git bundle：离线、可独立验证的代码来源 ────────────────────────────────
info "生成 git bundle（$PINNED_REF @ $SHORT）"
BUNDLE="$TMP_BUILD/repo/bili-charge-dynamics-$SHORT.bundle"
git bundle create "$BUNDLE" "$PINNED_REF" >/dev/null
bundle_head="$(git bundle list-heads "$BUNDLE" | awk '{print $1" "$2}')"
[[ "$bundle_head" == "$COMMIT $PINNED_REF" ]] || die "bundle 头部不是 $COMMIT $PINNED_REF：$bundle_head"

info "独立验证 bundle（临时 bare 仓库 fetch + fsck）"
VERIFY_REPO="$(mktemp -d /var/tmp/bili-local-deployment-verify.XXXXXX)"
{
    git init -q --bare "$VERIFY_REPO/repo.git"
    git -C "$VERIFY_REPO/repo.git" fetch -q --no-tags "$BUNDLE" 'refs/heads/*:refs/heads/*'
    git -C "$VERIFY_REPO/repo.git" rev-parse --verify "$COMMIT^{commit}"
    git -C "$VERIFY_REPO/repo.git" fsck --no-progress --strict
    git -C "$VERIFY_REPO/repo.git" log -1 --format='%H %cI %s' "$COMMIT"
} > "$TMP_BUILD/verify/bundle-verify.txt" 2>&1 || {
    cat "$TMP_BUILD/verify/bundle-verify.txt" >&2
    rm -rf "$VERIFY_REPO"
    die "bundle 独立验证失败"
}
rm -rf "$VERIFY_REPO"
ok "bundle 验证通过（详见 verify/bundle-verify.txt）"

# ── 3. deploy 模板：提交版原样；仅允许工作区做注释级文档同步（如实标注） ────────
info "提取 deploy 模板（提交 $SHORT）"
DEPLOY_SYNCED=()
for name in bili-monitor.service bili-monitor.env.example nginx-ecs-tunnel.conf nginx-locations.conf; do
    if [[ -f "$REPO_ROOT/deploy/$name" ]] && ! git diff --quiet "$COMMIT" -- "deploy/$name"; then
        changed="$(git diff -U0 "$COMMIT" -- "deploy/$name" |
            grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' || true)"
        if printf '%s\n' "$changed" | grep -qvE '^[+-][[:space:]]*#'; then
            die "deploy/$name 相对 $SHORT 有非注释改动；安装包只接受提交内容或注释级文档同步"
        fi
        cp "$REPO_ROOT/deploy/$name" "$TMP_BUILD/deploy/$name"
        DEPLOY_SYNCED+=("$name")
    else
        git show "$COMMIT:deploy/$name" > "$TMP_BUILD/deploy/$name"
    fi
    [[ -s "$TMP_BUILD/deploy/$name" ]] || die "deploy/$name 提取为空"
done
if ((${#DEPLOY_SYNCED[@]})); then
    printf 'warning: deploy 模板来自工作区（尚未提交，仅注释级改动）：%s\n' "${DEPLOY_SYNCED[*]}" >&2
fi

# ── 4. uv 二进制（root 装到 /usr/local/bin；不用 source ~/.local 启动 bili） ──
info "复制 uv 二进制"
UV_SRC="$(command -v uv || true)"
[[ -n "$UV_SRC" && -x "$UV_SRC" ]] || die "找不到可执行的 uv"
[[ "$(head -c 4 "$UV_SRC" | od -An -tx1 | tr -d ' \n')" == "7f454c46" ]] || die "uv 不是 ELF 可执行文件：$UV_SRC"
cp "$UV_SRC" "$TMP_BUILD/uv/uv"
chmod 0755 "$TMP_BUILD/uv/uv"
uv_version="$("$TMP_BUILD/uv/uv" --version)"
printf '%s\n' "$uv_version" > "$TMP_BUILD/uv/uv-version.txt"
printf 'source=%s\n' "$UV_SRC" >> "$TMP_BUILD/uv/uv-version.txt"

# ── 5. 渲染本机最终安装文件 ──────────────────────────────────────────────────
info "渲染 /etc/bili-monitor/env（仅 DB 路径 + PYTHON*；OSS/Cookie/通知保持注释）"
cat > "$TMP_BUILD/render/etc/bili-monitor/env" <<'EOF'
# /etc/bili-monitor/env —— 本机 bili 部署渲染产物（root:root 0600）
#
# 由 scripts/prepare-local-deployment-package.sh 生成；来源 deploy/bili-monitor.env.example。
# 有效行只有 BILI_DATABASE_PATH 与两项 PYTHON*：本机未接 OSS、Cookie、飞书通知。
# 应用不读取 .env，只有 systemd 通过 EnvironmentFile= 注入；改完必须重启 bili-monitor。
#
# 可选变量不要留空值：空字符串既不是“未设置”，又会触发配置校验直接退出
# （backend/bili_monitor/oss.py、source_cookies.py）。要么整项注释，要么六项全填。

# ---- 必填：持久化数据库（仓库外、bili 可写；不要放进发布目录） ----
BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite

# ---- 可选：阿里云 OSS 媒体归档（本机未启用：七项保持注释，不要写成空值） ----
# BILI_OSS_ENDPOINT=
# BILI_OSS_REGION=
# BILI_OSS_BUCKET=
# BILI_OSS_ACCESS_KEY_ID=
# BILI_OSS_ACCESS_KEY_SECRET=
# BILI_OSS_PUBLIC_BASE_URL=
# BILI_OSS_SECURITY_TOKEN=

# ---- 可选：B 站登录 Cookie（本机未启用；启用时指向仓库外 0600 文件、直属目录 0700） ----
# 与云端同文件名约定：/srv/bili-monitor/credentials/cookie.txt（本机不生成假 Cookie）
# BILI_COOKIE_FILE=/srv/bili-monitor/credentials/cookie.txt

# ---- 可选：飞书通知（本机未配置 ⇒ 统一入口只托管 API＋collector 两个进程） ----
# 与云端同文件名约定：/srv/bili-monitor/credentials/notifications.json
# 未来启用时取消注释并填入真实路由后重启；不要用占位 webhook 假填，也不要把值改成空字符串。
# 本机当前状态：通知功能未启用（不是“已接入但关闭”）；闸门默认 off。
# BILI_NOTIFICATION_CONFIG=/srv/bili-monitor/credentials/notifications.json

# ---- 运行时（配合 ProtectSystem=strict：只读文件系统下禁止写 .pyc） ----
PYTHONDONTWRITEBYTECODE=1
PYTHONUNBUFFERED=1
EOF

nginx_body="$(mktemp /var/tmp/bili-local-nginx.XXXXXX)"
sed -e 's|^    listen 127\.0\.0\.1:4173;$|    listen 127.0.0.1:4273;|' \
    "$TMP_BUILD/deploy/nginx-ecs-tunnel.conf" > "$nginx_body"
[[ "$(grep -c '^    listen 127\.0\.0\.1:4273;$' "$nginx_body")" == "1" ]] \
    || die "nginx server 渲染失败：期望恰好一行 listen 127.0.0.1:4273"
if grep -Eq '^[[:space:]]*listen .*4173' "$nginx_body"; then
    die "渲染后仍存在 4173 的 listen 指令"
fi
{
    cat <<HEADER
# ─────────────────────────────────────────────────────────────────────────────
# 本机渲染产物（不是手工编辑）：来源 deploy/nginx-ecs-tunnel.conf @ $SHORT
# 唯一指令差异：listen 127.0.0.1:4173 → listen 127.0.0.1:4273
#   （本机 4173 是本机 SSH 配置 Host bili 的 LocalForward 本地端口，留给隧道；
#    云端配置文件本身与 server/gzip/include 其余指令逐字节相同。）
# 注释中出现的 4173 与 SSH 隧道段落属于云端形态，本机不使用隧道。
# ─────────────────────────────────────────────────────────────────────────────
HEADER
    cat "$nginx_body"
} > "$TMP_BUILD/render/etc/nginx/conf.d/bili.conf"
rm -f "$nginx_body"

cp "$TMP_BUILD/deploy/nginx-locations.conf" "$TMP_BUILD/render/etc/nginx/snippets/bili-locations.conf"
cp "$TMP_BUILD/deploy/bili-monitor.service" "$TMP_BUILD/render/etc/systemd/system/bili-monitor.service"

# ── 6. VERSION / PROVENANCE / README ─────────────────────────────────────────
info "写 VERSION 与 PROVENANCE"
# 记录可用于部署后 `git fetch` 的 HTTPS 远端：安装包内的 bundle 只是离线来源，
# 升级需要真实远端。SSH 形式的 origin 需要部署账号持有密钥，故规范化为匿名可读的 HTTPS。
remote_url="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
remote_https=""
case "$remote_url" in
    git@github.com:*) remote_https="https://github.com/${remote_url#git@github.com:}" ;;
    ssh://git@github.com/*) remote_https="https://github.com/${remote_url#ssh://git@github.com/}" ;;
    https://*) remote_https="$remote_url" ;;
esac
{
    echo "format=1"
    echo "commit=$COMMIT"
    echo "short=$SHORT"
    echo "pinned_ref=$PINNED_REF"
    echo "anchor_source=$ANCHOR_SOURCE"
    echo "source_repo=$REPO_ROOT"
    echo "remote_https=${remote_https:-none}"
    echo "created_utc=$(date -u +%Y%m%dT%H%M%SZ)"
    echo "prepared_by=$(id -un)"
    echo "node=$node_version"
    echo "pnpm=$pnpm_version"
    echo "uv=$uv_version"
    echo "frontend_source=git archive $SHORT（干净快照；无 .env/node_modules/dist）"
    echo "frontend_build=env -i 隔离环境：pnpm install --frozen-lockfile; pnpm run check; pnpm run check:dist"
    echo "frontend_dist_files=$frontend_dist_files"
    echo "frontend_dist_index_sha256=$frontend_index_sha"
    echo "oper_env_scrubbed=${SCRUBBED[*]:-none}"
    echo "tracked_runtime_dirty=${CODE_DIRTY_LIST:-none}"
    if ((${#DEPLOY_SYNCED[@]})); then
        echo "deploy_templates=worktree-comment-only-sync(未提交):${DEPLOY_SYNCED[*]}"
    else
        echo "deploy_templates=commit"
    fi
    echo "worktree_dirty_entries=$WORKTREE_DIRTY"
    echo "worktree_dirty_paths=${WORKTREE_DIRTY_LIST:-none}"
} > "$TMP_BUILD/VERSION"

if ((${#DEPLOY_SYNCED[@]})); then
    deploy_note="- 注释级同步：\`${DEPLOY_SYNCED[*]}\` 取自工作区（尚未提交，改动仅涉及 \`#\` 注释行；字节已计入 MANIFEST）。"
else
    deploy_note="- 本次全部取自提交内容，工作区无 deploy 改动。"
fi

cat > "$TMP_BUILD/PROVENANCE.md" <<EOF
# 安装包来源与生成方式

- 钉住版本：\`$COMMIT\`（\`$PINNED_REF\`），短号 \`$SHORT\`
- 源仓库：\`$REPO_ROOT\`
- 生成时间（UTC）：\`$(date -u +%Y%m%dT%H%M%SZ)\`
- 生成者：\`$(id -un)\`

## 每个文件怎么来的

| 包内路径 | 来源 | 变换 |
| --- | --- | --- |
| \`repo/bili-charge-dynamics-$SHORT.bundle\` | \`git bundle create ... $PINNED_REF\` | 无（离线全量历史） |
| \`frontend/dist/**\` | \`git archive $SHORT\` 干净快照 → \`pnpm install --frozen-lockfile\` → \`pnpm run check\` → \`pnpm run check:dist\` | 只取生产 dist；不含 dist-mock |
| \`frontend/dist.sha256\` | 上述 dist 的逐文件 SHA256 | 无 |
| \`deploy/*\` | \`git show $SHORT:deploy/<file>\`（若工作区仅有注释级同步，取工作区版本并在 VERSION 标注） | 无（原样，供审阅与对照） |
| \`uv/uv\` | 本机已安装的 uv 二进制副本 | 无 |
| \`render/etc/bili-monitor/env\` | 按 \`deploy/bili-monitor.env.example\` 的取值规则新写 | 只启用 DB 路径 + PYTHON*；OSS/Cookie/通知保持注释 |
| \`render/etc/systemd/system/bili-monitor.service\` | \`deploy/bili-monitor.service\` @ \`$SHORT\` | 无（逐字节相同） |
| \`render/etc/nginx/snippets/bili-locations.conf\` | \`deploy/nginx-locations.conf\` @ \`$SHORT\` | 无（逐字节相同） |
| \`render/etc/nginx/conf.d/bili.conf\` | \`deploy/nginx-ecs-tunnel.conf\` @ \`$SHORT\` | 仅 \`listen 127.0.0.1:4173\` → \`listen 127.0.0.1:4273\`，另加来源注释头 |

## deploy 模板来源

- 默认取提交 \`$SHORT\` 的内容（\`git show\`）。
$deploy_note

## 前端构建的隔离性

- 源码取自 \`git archive $SHORT\`，开发仓库里 ignored 的 \`.env\`、\`dist/\`、\`node_modules/\` 不参与。
- 构建命令在 \`env -i\` 下执行（只带 HOME/PATH/TMPDIR/LANG/CI 与代理变量），
  因此操作员 shell 里的 \`VITE_*\` / \`BILI_*\` 不可能进入产物。
- 打包时已擦除的环境变量名：\`${SCRUBBED[*]:-none}\`

## 包内不含

- 任何 B 站 Cookie、OSS AccessKey、飞书 webhook、SSH 私钥、云端 env 或 live-34 内容。- 开发仓库的 \`.venv/\`、\`frontend/dist-mock/\`、\`node_modules/\`、\`test-results/\`。
- 未提交的改动；工作区脏文件只记录在 \`VERSION\` 的 \`worktree_dirty_paths\`，不进包。
EOF

cat > "$TMP_BUILD/README.md" <<EOF
# bili_charge_dynamics 本机「同形式」部署安装包（$SHORT）

本机新部署，不复用 \`live-34\`；路径/unit 形式与云端一致，唯一配置差异是网页端口 **4273**
（云端 4173，本机把 4173 留给 \`ssh -N bili\` 的 LocalForward）。API 仍是 \`127.0.0.1:8000\`。

## 内容

\`\`\`
VERSION                     版本、构建工具、来源与脏文件记录
MANIFEST.sha256             全包逐文件 SHA256（安装前必须校验通过）
PROVENANCE.md               每个文件怎么来的（含唯一的那一处端口变换）
repo/…-$SHORT.bundle        主树 main@$SHORT 的离线 git bundle
frontend/dist/              生产前端产物（不含 dist-mock）
frontend/dist.sha256        产物逐文件 SHA256
uv/uv                       uv $uv_version 二进制（root 装到 /usr/local/bin/uv）
deploy/                     提交版本里的原始模板（审阅对照用）
render/                     将被 root 安装的最终文件（/etc 下的绝对路径布局）
verify/bundle-verify.txt    bundle 独立 fetch/fsck 验证记录
\`\`\`

## 校验

\`\`\`bash
cd "$OUTPUT"
sha256sum --check --strict MANIFEST.sha256
git bundle list-heads repo/bili-charge-dynamics-$SHORT.bundle   # 应显示 $COMMIT refs/heads/main
\`\`\`

## 安装

在仓库根目录、用你自己的终端执行一次（脚本会按阶段确认，sudo 密码只在你的 TTY 输入）：

\`\`\`bash
scripts/setup-local-deployment.sh --package $OUTPUT
\`\`\`

只读预检（不写文件、不调用 sudo）：

\`\`\`bash
scripts/setup-local-deployment.sh --check --package $OUTPUT
\`\`\`

## 目标形态

\`\`\`
/srv/bili-monitor/               bili:bili
├── app/                         单 git 检出（main@$SHORT）+ 独立 .venv（uv sync --locked --no-dev，3.12）
├── monitor.sqlite               新空库（首次启动由迁移创建）
├── backup/                      空目录
└── credentials/                 空 0700（无任何凭据）
/etc/bili-monitor/env             root:root 0600（仅 BILI_DATABASE_PATH + PYTHON*）
/etc/systemd/system/bili-monitor.service   与 deploy/bili-monitor.service 逐字节相同
/srv/dynamics-viewer/releases/<UTC>-$SHORT + current 原子软链
/etc/nginx/conf.d/bili.conf      listen 127.0.0.1:4273
/etc/nginx/snippets/bili-locations.conf     root /srv/dynamics-viewer/current，proxy_pass 127.0.0.1:8000
\`\`\`

## 本机与云端的有意差异

1. 网页监听 \`127.0.0.1:4273\`（不是 4173）；API 与 \`proxy_pass\` 仍是 8000。
2. 未配置 OSS / Cookie / 飞书通知：\`/etc/bili-monitor/env\` 里相应项保持**注释状态（变量不存在，不是空字符串）**，
   因此统一入口只托管 **API + collector 两进程**，通知闸门默认 \`off\`（安全初始态）。
   本地初始态是**功能未启用**，不是“已接入但关闭”；未来启用沿用云端文件名约定：
   \`/srv/bili-monitor/credentials/cookie.txt\` 与 \`/srv/bili-monitor/credentials/notifications.json\`（目录 0700），
   填入真实值后重启才有第三个进程；本安装包不生成假 Cookie/webhook。
3. \`credentials/\` 预建为空 \`0700\` 目录，不放任何凭据。
4. 包管理是 Arch/CachyOS：\`pacman -S --needed nginx git rsync sqlite\`（不是 \`apt\`），不 \`-Syu\`。

## 不含 / 不触碰

- 不改 SSH 配置与转发、不改 swap、不动 \`/srv\` 下既有 \`ftp/\`、\`http/\` 等无关目录。
- 不读云端 \`/etc/bili-monitor/env\`、不读 live-34 凭据、不调用 B 站/OSS/飞书上游。
EOF

# ── 7. 权限与 MANIFEST ───────────────────────────────────────────────────────
find "$TMP_BUILD" -type d -exec chmod 0755 {} +
find "$TMP_BUILD" -type f -exec chmod 0644 {} +
chmod 0755 "$TMP_BUILD/uv/uv"
( cd "$TMP_BUILD" && find . -type f ! -name MANIFEST.sha256 ! -name MANIFEST.sha256.sha256 -print0 | LC_ALL=C sort -z | xargs -0 sha256sum ) \
    > "$TMP_BUILD/MANIFEST.sha256"
MANIFEST_SHA="$(sha256sum "$TMP_BUILD/MANIFEST.sha256" | cut -d' ' -f1)"
printf '%s  MANIFEST.sha256\n' "$MANIFEST_SHA" > "$TMP_BUILD/MANIFEST.sha256.sha256"

info "自检 MANIFEST"
( cd "$TMP_BUILD" && sha256sum --check --strict --quiet MANIFEST.sha256 ) \
    || die "MANIFEST 自检失败"
[[ "$(stat -c '%a' "$TMP_BUILD/uv/uv")" == "755" ]] || die "uv/uv 权限异常"

if [[ -e "$OUTPUT" ]]; then
    OLD_OUTPUT="$PARENT/.$(basename "$OUTPUT").old.$$"
    mv "$OUTPUT" "$OLD_OUTPUT"
    if mv "$TMP_BUILD" "$OUTPUT"; then
        rm -rf "$OLD_OUTPUT"
    else
        mv "$OLD_OUTPUT" "$OUTPUT"
        die "替换安装包失败，已恢复旧目录"
    fi
else
    mv "$TMP_BUILD" "$OUTPUT"
fi
TMP_BUILD=""

info "安装包就绪：$OUTPUT"
MANIFEST_SHA="$(sha256sum "$OUTPUT/MANIFEST.sha256" | cut -d' ' -f1)"
ok "commit      $COMMIT ($SHORT)"
ok "文件数      $(find "$OUTPUT" -type f | wc -l | tr -d ' ')"
ok "总大小      $(du -sh "$OUTPUT" | cut -f1)"
ok "manifest    $MANIFEST_SHA"
ok "dist 文件   $frontend_dist_files（index.html $frontend_index_sha）"
ok "uv          $uv_version"
if [[ "$WORKTREE_DIRTY" != "0" ]]; then
    ok "工作区另有 $WORKTREE_DIRTY 处未提交改动（docs/.scratch 等），未进入安装包：$WORKTREE_DIRTY_LIST"
fi
printf '\n下一步（用户在自己终端执行一次）：\n    scripts/setup-local-deployment.sh --package %s\n' "$OUTPUT"
printf '只读预检：\n    scripts/setup-local-deployment.sh --check --package %s\n' "$OUTPUT"
