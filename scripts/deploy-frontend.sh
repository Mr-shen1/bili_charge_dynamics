#!/usr/bin/env bash
# 前端发布：本地构建 → 上传 → 原子切换 current 符号链接。
#
# 用法（在本地仓库根目录执行）：
#     HOST=<user>@<公网IP> scripts/deploy-frontend.sh      # 远端（云端）
#     scripts/deploy-frontend.sh --local                   # 本机（/srv 属 root，脚本用 sudo）
#
# 可选环境变量：
#     HOST        ssh 目标，必填，例如 monitor@1.2.3.4
#     SITE_ROOT   服务器发布根，默认 /srv/dynamics-viewer
#     KEEP        保留的历史版本数，默认 5
#     SKIP_BUILD  设为 1 跳过构建（复用现有 frontend/dist/）
#
# 只发布前端静态产物，不重启 Python 进程。后端升级是另一条流程，
# 必须先停服务再切代码，见 docs/deployment/README.md。
#
# 为什么需要逐次发布目录 + 软链：Nginx 缓存规则依赖内容哈希资源长期缓存，
# 就地覆盖 dist/ 会让已缓存的旧页面请求到不存在的哈希文件。保留旧版本
# 目录可以避免这一窗口。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Vue 前端应用在 frontend/：构建与产物都在该目录，仓库根只保留部署脚本。
APP_DIR="$REPO_ROOT/frontend"
cd "$REPO_ROOT"

HOST="${HOST:-}"
SITE_ROOT="${SITE_ROOT:-/srv/dynamics-viewer}"
KEEP="${KEEP:-5}"
SKIP_BUILD="${SKIP_BUILD:-0}"
LOCAL=0
for arg in "$@"; do
    case "$arg" in
        --local) LOCAL=1 ;;
        -h | --help)
            printf 'usage: %s [--local]\n  HOST=<user>@<host> %s   # 发布到远端\n  %s --local             # 发布到本机（需要 sudo）\n' "$0" "$0" "$0"
            exit 0
            ;;
        *)
            echo "error: 未知参数 $arg" >&2
            exit 1
            ;;
    esac
done

if [[ "$LOCAL" != "1" && -z "$HOST" ]]; then
    echo "error: 必须设置 HOST，例如 HOST=monitor@1.2.3.4 $0（本机发布用 --local）" >&2
    exit 1
fi

# 两端发布语义相同：新 releases/<UTC>-<commit>/ → 原子切换 current → 保留最近 KEEP 个。
# 远端经 ssh 由登录用户执行；本机发布目录属 root，故用 sudo。
run_remote() {
    if [[ "$LOCAL" == "1" ]]; then sudo bash -c "$1"; else ssh "$HOST" "$1"; fi
}
push_dir() {
    if [[ "$LOCAL" == "1" ]]; then sudo rsync -a --delete "$1" "$2"
    else rsync -az --delete "$1" "$HOST:$2"; fi
}

if [[ ! "$KEEP" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: KEEP 必须是正整数，当前为 '$KEEP'" >&2
    exit 1
fi
# 发布必须以干净工作区为基础，避免把未提交的改动混进产物。
if [[ -n "$(git status --porcelain)" ]]; then
    echo "error: 工作区不干净，先提交或 stash 后再发布" >&2
    git status --short >&2
    exit 1
fi

COMMIT="$(git rev-parse --short HEAD)"
RELEASE="$(date -u +%Y%m%dT%H%M%SZ)-$COMMIT"
REMOTE_RELEASE="$SITE_ROOT/releases/$RELEASE"
CURRENT="$SITE_ROOT/current"

if [[ "$LOCAL" == "1" ]]; then
    echo "==> 目标 本机:$SITE_ROOT  版本 $RELEASE"
else
    echo "==> 目标 $HOST:$SITE_ROOT  版本 $RELEASE"
fi

if [[ "$SKIP_BUILD" != "1" ]]; then
    echo "==> 构建生产产物"
    ( cd "$APP_DIR" && pnpm build )
fi

if [[ ! -f "$APP_DIR/dist/index.html" ]]; then
    echo "error: frontend/dist/index.html 不存在，构建可能失败" >&2
    exit 1
fi

echo "==> 上传产物"
run_remote "mkdir -p '$REMOTE_RELEASE'"
push_dir "$APP_DIR/dist/" "$REMOTE_RELEASE/"

echo "==> 原子切换 current"
# ln -sfn 在目标已存在时不是原子替换；先建临时链接再 mv -Tf 覆盖。
run_remote "
    set -euo pipefail
    cd '$SITE_ROOT'
    ln -sfn '$REMOTE_RELEASE' current.tmp
    mv -Tf current.tmp current
    readlink -f current
"

echo "==> 清理超过 $KEEP 个的旧版本"
run_remote "
    set -euo pipefail
    cd '$SITE_ROOT/releases'
    # 按修改时间倒序，跳过最新 KEEP 个，其余删除。current 指向的版本
    # 若落在删除范围说明 KEEP 设置过小，这里不额外保护，因 mv 已原子切换。
    ls -1dt */ 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf
    ls -1dt */ 2>/dev/null | head -n $KEEP
"

echo "==> 校验入口可读"
run_remote "test -r '$CURRENT/index.html' && echo 'current/index.html OK'"

echo "==> 完成：$RELEASE"
if [[ "$LOCAL" == "1" ]]; then
    echo "   回滚：sudo sh -c 'cd $SITE_ROOT && ln -sfn releases/<旧版本> current.tmp && mv -Tf current.tmp current'"
else
    echo "   回滚：ssh $HOST 'cd $SITE_ROOT && ln -sfn releases/<旧版本> current.tmp && mv -Tf current.tmp current'"
fi
