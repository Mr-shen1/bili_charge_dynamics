#!/usr/bin/env bash
# 前端发布：本地构建 → 上传 → 原子切换 current 符号链接。
#
# 用法（在本地仓库根目录执行）：
#     HOST=<user>@<公网IP> scripts/deploy-frontend.sh
#
# 可选环境变量：
#     HOST        ssh 目标，必填，例如 monitor@1.2.3.4
#     SITE_ROOT   服务器发布根，默认 /srv/dynamics-viewer
#     KEEP        保留的历史版本数，默认 5
#     SKIP_BUILD  设为 1 跳过构建（复用现有 frontend/dist/）
#
# 只发布前端静态产物，不重启 Python 进程。后端升级是另一条流程，
# 必须先停服务再切代码，见 .scratch/aliyun-deployment/runbook.md。
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

if [[ -z "$HOST" ]]; then
    echo "error: 必须设置 HOST，例如 HOST=monitor@1.2.3.4 $0" >&2
    exit 1
fi

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

echo "==> 目标 $HOST:$SITE_ROOT  版本 $RELEASE"

if [[ "$SKIP_BUILD" != "1" ]]; then
    echo "==> 构建生产产物"
    ( cd "$APP_DIR" && pnpm build )
fi

if [[ ! -f "$APP_DIR/dist/index.html" ]]; then
    echo "error: frontend/dist/index.html 不存在，构建可能失败" >&2
    exit 1
fi

echo "==> 上传产物"
ssh "$HOST" "mkdir -p '$REMOTE_RELEASE'"
rsync -az --delete "$APP_DIR/dist/" "$HOST:$REMOTE_RELEASE/"

echo "==> 原子切换 current"
# ln -sfn 在目标已存在时不是原子替换；先建临时链接再 mv -Tf 覆盖。
ssh "$HOST" "
    set -euo pipefail
    cd '$SITE_ROOT'
    ln -sfn '$REMOTE_RELEASE' current.tmp
    mv -Tf current.tmp current
    readlink -f current
"

echo "==> 清理超过 $KEEP 个的旧版本"
ssh "$HOST" "
    set -euo pipefail
    cd '$SITE_ROOT/releases'
    # 按修改时间倒序，跳过最新 KEEP 个，其余删除。current 指向的版本
    # 若落在删除范围说明 KEEP 设置过小，这里不额外保护，因 mv 已原子切换。
    ls -1dt */ 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf
    ls -1dt */ 2>/dev/null | head -n $KEEP
"

echo "==> 校验入口可读"
ssh "$HOST" "test -r '$CURRENT/index.html' && echo 'current/index.html OK'"

echo "==> 完成：$RELEASE"
echo "   回滚：ssh $HOST 'cd $SITE_ROOT && ln -sfn releases/<旧版本> current.tmp && mv -Tf current.tmp current'"
