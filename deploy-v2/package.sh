#!/usr/bin/env bash
# package.sh —— 打离线安装包（deploy-v2 自带的打包器，不依赖 scripts/ 下任何脚本）
#
# 只做两件事：把某个已提交的版本固化成一份带校验和的目录；不装系统软件、不调用 sudo。
# 前端构建链（Node/pnpm）只在本机用，目标机不需要。
#
# 用法（在仓库根目录，普通用户执行）：
#     deploy-v2/package.sh                 # 用当前 HEAD（必须是 main）
#     deploy-v2/package.sh --commit <40位SHA>
#     deploy-v2/package.sh --output DIR
#
# 产物目录结构（deploy.sh 只认这些）：
#     VERSION  MANIFEST.sha256  repo/<name>.bundle
#     frontend/dist/…  uv/uv  deploy/{bili-monitor.service,nginx-locations.conf}
#
# 输出默认 /var/tmp/bili-deploy-pkg/<7位短SHA>（与旧向导的 bili-local-deployment 目录分开，
# 避免 deploy.sh 自动挑选时拿到旧格式的包）。

set -euo pipefail

EXPECTED_NODE=24.21.0
EXPECTED_PNPM=10.34.6
PINNED_REF=refs/heads/main
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
REPO_ROOT="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null)" || {
    echo "deploy-v2/package.sh 必须在 git 仓库里运行" >&2; exit 1; }

die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }

CLI_COMMIT=""
OUTPUT=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --commit) CLI_COMMIT="${2:?--commit 需要 40 位 SHA}"; shift 2 ;;
        --output) OUTPUT="${2:?--output 需要目录}"; shift 2 ;;
        -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
        *) die "未知参数：$1" ;;
    esac
done

# ── 工具链 ──────────────────────────────────────────────────────────────────
for t in git tar node pnpm uv; do command -v "$t" >/dev/null || die "缺少 $t"; done
NODE_BIN="$(command -v node)"; PNPM_BIN="$(command -v pnpm)"; NODE_DIR="$(dirname "$NODE_BIN")"
[[ "$($NODE_BIN -v)" == "v$EXPECTED_NODE" ]] || die "node 必须是 $EXPECTED_NODE，当前 $($NODE_BIN -v)（用 nvm）"
[[ "$($PNPM_BIN -v)" == "$EXPECTED_PNPM" ]] || die "pnpm 必须是 $EXPECTED_PNPM，当前 $($PNPM_BIN -v)"

# 构建环境隔离：丢掉操作员的 VITE_* / BILI_*，只留代理变量透传
while IFS= read -r n; do unset -v "$n"; done < <(compgen -v | LC_ALL=C grep -E '^(VITE_|BILI_)' || true)
CLEAN_ENV=(env -i "HOME=$HOME" "PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin" \
           "TMPDIR=/var/tmp" "LANG=C.UTF-8" "CI=1")
for n in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
    [[ -n "${!n:-}" ]] && CLEAN_ENV+=("$n=${!n}")
done

# ── 版本锚点：只认已提交的 main（或显式 --commit）───────────────────────────
cd "$REPO_ROOT"
HEAD_COMMIT="$(git rev-parse --verify 'HEAD^{commit}')"
MAIN_COMMIT="$(git rev-parse --verify "$PINNED_REF^{commit}")"
if [[ -n "$CLI_COMMIT" ]]; then
    [[ "$CLI_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "--commit 需要完整 40 位 SHA"
    git cat-file -e "$CLI_COMMIT^{commit}" 2>/dev/null || die "提交不在本仓库：$CLI_COMMIT"
    COMMIT="$CLI_COMMIT"
else
    [[ "$HEAD_COMMIT" == "$MAIN_COMMIT" ]] || \
        die "HEAD=$HEAD_COMMIT 不是 main=$MAIN_COMMIT；先切到 main 或显式 --commit"
    COMMIT="$HEAD_COMMIT"
fi
git merge-base --is-ancestor "$COMMIT" "$PINNED_REF" || die "提交不在 main 历史里"
SHORT="${COMMIT:0:7}"
[[ -z "$OUTPUT" ]] && OUTPUT="/var/tmp/bili-deploy-pkg/$SHORT"

if [[ -e "$OUTPUT" ]]; then
    if ( cd "$OUTPUT" && sha256sum --check --strict --quiet MANIFEST.sha256 ) >/dev/null 2>&1 &&
       grep -qx "commit=$COMMIT" "$OUTPUT/VERSION" 2>/dev/null; then
        ok "同版本安装包已存在且校验通过：$OUTPUT（换 --output 可另存）"
        exit 0
    fi
    die "目标已存在但不是同版本的可校验产物：$OUTPUT（移走或用 --output）"
fi

step "打包 $SHORT（$COMMIT）"
info "输出：$OUTPUT"

# ── 1. 干净快照 + 前端构建 ──────────────────────────────────────────────────
SNAP="$(mktemp -d /var/tmp/bili-pkg-snapshot.XXXXXX)"
trap 'rm -rf "$SNAP"' EXIT
info "git archive 导出干净快照"
git archive --format=tar "$COMMIT" | tar -x -C "$SNAP"
find "$SNAP" \( -name '.env' -o -name '.env.*' \) -print -quit | grep -q . && die "快照里出现 .env，拒绝继续"
[[ -f "$SNAP/frontend/pnpm-lock.yaml" ]] || die "快照缺 frontend/pnpm-lock.yaml"
[[ ! -e "$SNAP/frontend/dist" && ! -e "$SNAP/frontend/dist-mock" ]] || die "快照里出现构建产物"

info "pnpm install --frozen-lockfile"
"${CLEAN_ENV[@]}" "$PNPM_BIN" --dir "$SNAP/frontend" install --frozen-lockfile --reporter=append-only
info "pnpm check（typecheck + 单测 + e2e 项目守卫）"
"${CLEAN_ENV[@]}" "$PNPM_BIN" --dir "$SNAP/frontend" run check
info "pnpm check:dist（构建 + 产物隔离自检）"
"${CLEAN_ENV[@]}" "$PNPM_BIN" --dir "$SNAP/frontend" run check:dist

[[ -f "$SNAP/frontend/dist/index.html" ]] || die "frontend/dist/index.html 缺失"
grep -rIl -- '__preview-fixtures\|dist-mock' "$SNAP/frontend/dist" >/dev/null 2>&1 && \
    die "生产产物里出现 mock 标记，拒绝收录"

# ── 2. 组装产物 ─────────────────────────────────────────────────────────────
TMP_OUT="$(dirname "$OUTPUT")/.$(basename "$OUTPUT").new.$$"
rm -rf "$TMP_OUT"
mkdir -p "$TMP_OUT"/{repo,frontend,uv,deploy}
rsync -a --delete "$SNAP/frontend/dist/" "$TMP_OUT/frontend/dist/"
( cd "$TMP_OUT/frontend/dist" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum ) \
    > "$TMP_OUT/frontend/dist.sha256"
ok "前端 dist：$(find "$TMP_OUT/frontend/dist" -type f | wc -l | tr -d ' ') 个文件，index $(sha256sum "$TMP_OUT/frontend/dist/index.html" | cut -c1-12)…"

info "git bundle（$PINNED_REF @ $SHORT）"
BUNDLE="$TMP_OUT/repo/bili-charge-dynamics-$SHORT.bundle"
git bundle create "$BUNDLE" "$PINNED_REF" >/dev/null
heads="$(git bundle list-heads "$BUNDLE" | awk '{print $1" "$2}')"
[[ "$heads" == "$COMMIT $PINNED_REF" ]] || die "bundle 头部不是 $COMMIT $PINNED_REF：$heads"
VERIFY="$(mktemp -d /var/tmp/bili-pkg-verify.XXXXXX)"
git init -q --bare "$VERIFY/r.git"
git -C "$VERIFY/r.git" fetch -q --no-tags "$BUNDLE" 'refs/heads/*:refs/heads/*'
git -C "$VERIFY/r.git" rev-parse --verify "$COMMIT^{commit}" >/dev/null
git -C "$VERIFY/r.git" fsck --no-progress --strict
rm -rf "$VERIFY"
ok "bundle 独立验证通过（fetch + fsck）"

info "复制 uv 二进制"
UV_SRC="$(command -v uv)"
[[ "$(head -c 4 "$UV_SRC" | od -An -tx1 | tr -d ' \n')" == "7f454c46" ]] || die "uv 不是 ELF：$UV_SRC"
cp "$UV_SRC" "$TMP_OUT/uv/uv"; chmod 0755 "$TMP_OUT/uv/uv"
UV_VERSION="$("$TMP_OUT/uv/uv" --version)"
ok "uv：$UV_VERSION"

# ── 3. deploy 模板（来自 deploy-v2/assets，同时比对仓库 deploy/ 是否漂移）─────
cp "$HERE/assets/bili-monitor.service" "$TMP_OUT/deploy/bili-monitor.service"
cp "$HERE/assets/nginx-locations.conf" "$TMP_OUT/deploy/nginx-locations.conf"
for f in bili-monitor.service nginx-locations.conf; do
    if ! cmp -s "$TMP_OUT/deploy/$f" "$REPO_ROOT/deploy/$f"; then
        info "注意：deploy-v2/assets/$f 与仓库 deploy/$f 不同（以 deploy-v2/assets 为准）"
    fi
done
ok "deploy 模板：systemd unit + nginx snippet"

# ── 4. VERSION / MANIFEST ───────────────────────────────────────────────────
remote_https=""
url="$(git remote get-url origin 2>/dev/null || true)"
case "$url" in
    git@github.com:*)         remote_https="https://github.com/${url#git@github.com:}" ;;
    ssh://git@github.com/*)   remote_https="https://github.com/${url#ssh://git@github.com/}" ;;
    https://*)                remote_https="$url" ;;
esac
{
    echo "format=2"
    echo "commit=$COMMIT"
    echo "short=$SHORT"
    echo "pinned_ref=$PINNED_REF"
    echo "remote_https=${remote_https:-none}"
    echo "created_utc=$(date -u +%Y%m%dT%H%M%SZ)"
    echo "prepared_by=$(id -un)"
    echo "node=v$EXPECTED_NODE"
    echo "pnpm=$EXPECTED_PNPM"
    echo "uv=$UV_VERSION"
    echo "frontend_dist_files=$(find "$TMP_OUT/frontend/dist" -type f | wc -l | tr -d ' ')"
    echo "frontend_dist_index_sha256=$(sha256sum "$TMP_OUT/frontend/dist/index.html" | cut -d' ' -f1)"
} > "$TMP_OUT/VERSION"

( cd "$TMP_OUT" && find . -type f ! -name MANIFEST.sha256 -print0 | LC_ALL=C sort -z | xargs -0 sha256sum ) \
    > "$TMP_OUT/MANIFEST.sha256"
( cd "$TMP_OUT" && sha256sum --check --strict --quiet MANIFEST.sha256 ) || die "MANIFEST 自检失败"
chmod 0755 "$TMP_OUT/uv/uv"
( cd "$TMP_OUT" && sha256sum MANIFEST.sha256 > MANIFEST.sha256.sha256 )

# ── 5. 落盘 ────────────────────────────────────────────────────────────────
mkdir -p "$(dirname "$OUTPUT")"
mv -T "$TMP_OUT" "$OUTPUT"
( cd "$OUTPUT" && sha256sum --check --strict --quiet MANIFEST.sha256 ) || die "最终 MANIFEST 校验失败"

step "安装包就绪"
ok "目录：$OUTPUT"
ok "提交：$COMMIT（$SHORT）"
ok "大小：$(du -sh "$OUTPUT" | cut -f1)　文件数：$(find "$OUTPUT" -type f | wc -l | tr -d ' ')"
ok "manifest：$(cut -d' ' -f1 "$OUTPUT/MANIFEST.sha256.sha256")"
echo
echo "下一步（本地或云端都一样）："
echo "    deploy-v2/deploy.sh --check --package $OUTPUT"
echo "    deploy-v2/deploy.sh install  --package $OUTPUT"
