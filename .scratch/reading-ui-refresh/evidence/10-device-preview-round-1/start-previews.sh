#!/usr/bin/env bash
# 票 10 第二轮（12+13+审查整改组合候选 344235a）隔离局域网预览启动脚本。
# 只启动 4 个进程：live_app API(127.0.0.1:4180)、图片夹具(127.0.0.1:4339)、
# 环境 A 正式 dist 预览(0.0.0.0:4318)、环境 B dist-mock 预览(0.0.0.0:4337)。
# 不启动 collector/notifier，不访问真实上游/飞书/OSS；既有 8000/4273 一律不碰。
#
# 启动前两道守卫：
#   1) 冻结产物：RUNTIME/artifacts.sha256 逐文件校验（dist-a/dist-b/server）；
#   2) 产品树：frontend/backend 与固定 sourceCommit 逐字节一致（HEAD 可以因证据文档提交而前进）。
# 前置：RUNTIME 已按 preparation.md「冻结产物」一节复制好 dist-a/dist-b/server 并生成
#       artifacts.sha256（命令见 preparation.md）。
set -euo pipefail

RUNTIME="${RUNTIME:-/tmp/bili-ticket10-round1-zogc}"
REPO="${REPO:-/home/kevin/Projects/PI/bili_charge_dynamics}"
FRONTEND="$REPO/frontend"
# 固定候选：产品树（frontend/backend）以这个提交为准；HEAD 允许之后因证据/状态文档前进。
SOURCE_COMMIT=344235a88b418dc07b644aef578487d0693e65d9
SOURCE_BRANCH=spec/reading-ui-refresh
FRONTEND_TREE=79f45fd947bbe46b7ed8d63f4f4a45dabcb9160e
BACKEND_TREE=b33aa187c2055a901cd568908679ff448c71f37e
INDEX_SHA_A=1a558c6ca9eb0cece45161b3d4773875eb4b92b75ca42348af95bd64f52c9e54
INDEX_SHA_B=b336d12eb9df969189b4dcee6540ea2494f5df4ee5f1afeede1011bbdad7bee8
API_PORT=4180
IMAGES_PORT=4339
PORT_A=4318
PORT_B=4337

mkdir -p "$RUNTIME"/{logs,run}
# uv run 必须在仓库根解析项目环境；pnpm 用 --dir 指定前端目录。
cd "$REPO"

# 1. 端口前置检查：任何目标端口已在监听则直接失败，绝不复用或接管别人的服务。
for port in "$PORT_A" "$API_PORT" "$PORT_B" "$IMAGES_PORT"; do
  if ss -ltn "sport = :$port" | tail -n +2 | grep -q .; then
    echo "REFUSE: 端口 $port 已在监听，不启动（先人工确认占用来源）" >&2
    exit 1
  fi
done

# 2. 冻结产物校验：逐文件哈希必须与冻结清单一致（产物被重建/复制不完整即拒绝启动）。
if [ ! -s "$RUNTIME/artifacts.sha256" ]; then
  echo "REFUSE: 缺少 $RUNTIME/artifacts.sha256（冻结产物清单）" >&2
  exit 1
fi
( cd "$RUNTIME" && sha256sum --quiet -c artifacts.sha256 ) || {
  echo "REFUSE: 冻结产物哈希不符（frontend/dist 可能已被重建，重新复制并生成 artifacts.sha256）" >&2
  exit 1
}

# 3. 产品树校验：frontend/backend 必须与固定 sourceCommit 完全一致；不要求 HEAD 仍等于该提交。
git rev-parse --verify --quiet "$SOURCE_COMMIT^{commit}" >/dev/null || {
  echo "REFUSE: 仓库里找不到固定候选 $SOURCE_COMMIT" >&2
  exit 1
}
[ "$(git rev-parse "$SOURCE_COMMIT:frontend")" = "$FRONTEND_TREE" ] || {
  echo "REFUSE: $SOURCE_COMMIT 的 frontend 树不是 $FRONTEND_TREE" >&2
  exit 1
}
[ "$(git rev-parse "$SOURCE_COMMIT:backend")" = "$BACKEND_TREE" ] || {
  echo "REFUSE: $SOURCE_COMMIT 的 backend 树不是 $BACKEND_TREE" >&2
  exit 1
}
if ! git diff --exit-code --quiet "$SOURCE_COMMIT" -- frontend backend; then
  echo "REFUSE: 工作树 frontend/backend 的受跟踪文件与 $SOURCE_COMMIT 有差异，不启动" >&2
  exit 1
fi
# 未跟踪文件不影响候选身份（冻结产物已单独校验），但必须如实列出，例如 merger 的临时 e2e 配置。
UNTRACKED=$(git status --porcelain -- frontend backend | grep '^??' || true)
if [ -n "$UNTRACKED" ]; then
  echo "NOTE: frontend/backend 存在未跟踪文件（未参与构建，冻结产物另行校验）：" >&2
  echo "$UNTRACKED" >&2
fi
echo "product tree ok: frontend=$FRONTEND_TREE backend=$BACKEND_TREE (= $SOURCE_COMMIT)"
echo "HEAD: $(git rev-parse --short=7 HEAD)（允许与固定候选不同，前端/后端树按上条校验）"

# 4. Node 24（nvm）与 pnpm；产物 index.html 指纹再单独校验一次，便于日志定位。
# shellcheck disable=SC1091
source "$HOME/.nvm/nvm.sh"
nvm use 24 >/dev/null
node --version
pnpm --version
[ "$(sha256sum "$RUNTIME/dist-a/index.html" | cut -d' ' -f1)" = "$INDEX_SHA_A" ] || {
  echo "REFUSE: dist-a/index.html 指纹不是 $INDEX_SHA_A" >&2; exit 1; }
[ "$(sha256sum "$RUNTIME/dist-b/index.html" | cut -d' ' -f1)" = "$INDEX_SHA_B" ] || {
  echo "REFUSE: dist-b/index.html 指纹不是 $INDEX_SHA_B" >&2; exit 1; }

# 子进程专用环境：清空所有代理变量，仅回环直连；只影响本脚本派生的新进程。
launch() {
  local name=$1 pidfile logfile
  shift
  pidfile="$RUNTIME/run/$name.pid"
  logfile="$RUNTIME/logs/$name.log"
  rm -f "$pidfile" "$RUNTIME/run/$name.pgid"
  : > "$logfile"
  # setsid 让进程成为新会话/进程组组长：pgid == pidfile 里的 pid，停机脚本按进程组精确回收。
  setsid env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
    -u ALL_PROXY -u all_proxy -u FTP_PROXY -u ftp_proxy \
    NO_PROXY=127.0.0.1,localhost,::1 no_proxy=127.0.0.1,localhost,::1 \
    "$@" > "$logfile" 2>&1 &
  local i
  for i in $(seq 1 100); do
    [ -s "$pidfile" ] && return 0
    sleep 0.1
  done
  echo "FAILED: $name 未写出 pidfile" >&2
  tail -n 20 "$logfile" >&2
  return 1
}

wait_http() {
  local url=$1 i
  for i in $(seq 1 300); do
    if curl -fsS --noproxy '*' -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  echo "FAILED: $url 未在 60s 内可读（看 $RUNTIME/logs/）" >&2
  tail -n 20 "$RUNTIME/logs/"*.log >&2
  return 1
}

record_pgid() {
  local name=$1 pidfile="$RUNTIME/run/$1.pid" pid pgid
  pid=$(cat "$pidfile")
  pgid=$(ps -o pgid= -p "$pid" | tr -d ' ')
  printf '%s\n' "$pgid" > "$RUNTIME/run/$name.pgid"
  printf '%-7s pid=%s pgid=%s\n' "$name" "$pid" "$pgid"
}

# 5. API：live_app 固定虚构上游，隔离 SQLite，只绑回环。
launch api \
  BILI_DATABASE_PATH="$RUNTIME/monitor.sqlite" \
  bash -c 'echo $$ > "$1"; shift; exec "$@"' _ "$RUNTIME/run/api.pid" \
  uv run --no-sync python -m uvicorn backend.tests.live_app:create_app --factory \
  --host 127.0.0.1 --port "$API_PORT" --app-dir "$REPO" --log-level info
wait_http "http://127.0.0.1:$API_PORT/api/manage/ups"
record_pgid api

# 6. 图片夹具：只 bind 127.0.0.1:4339，用 /tmp 冻结副本。
launch images \
  IMAGE_SERVER_PORT="$IMAGES_PORT" \
  bash -c 'echo $$ > "$1"; shift; exec "$@"' _ "$RUNTIME/run/images.pid" \
  node "$RUNTIME/server/imageServer.mjs"
wait_http "http://127.0.0.1:$IMAGES_PORT/__requests"
record_pgid images

# 7. 环境 A：正式 dist（绝对 --outDir 指向 /tmp 冻结副本）；显式 API/图片代理目标。
launch web-a \
  API_SERVER="http://127.0.0.1:$API_PORT" IMAGE_SERVER_PORT="$IMAGES_PORT" \
  bash -c 'echo $$ > "$1"; shift; exec "$@"' _ "$RUNTIME/run/web-a.pid" \
  pnpm --dir "$FRONTEND" exec vite preview --outDir "$RUNTIME/dist-a" \
  --host 0.0.0.0 --port "$PORT_A" --strictPort
wait_http "http://127.0.0.1:$PORT_A/"
record_pgid web-a

# 8. 环境 B：dist-mock（mock 自检装配，含 /__preview-fixtures）；同一 API 与图片代理。
launch web-b \
  API_SERVER="http://127.0.0.1:$API_PORT" IMAGE_SERVER_PORT="$IMAGES_PORT" \
  bash -c 'echo $$ > "$1"; shift; exec "$@"' _ "$RUNTIME/run/web-b.pid" \
  pnpm --dir "$FRONTEND" exec vite preview --outDir "$RUNTIME/dist-b" \
  --host 0.0.0.0 --port "$PORT_B" --strictPort
wait_http "http://127.0.0.1:$PORT_B/"
record_pgid web-b

echo "--- 监听（本轮 4 个端口） ---"
ss -ltnp 2>/dev/null | grep -E ":$PORT_A|:$API_PORT|:$PORT_B|:$IMAGES_PORT" || true
echo "--- 既有服务（不得变化） ---"
ss -ltn 2>/dev/null | grep -E ':(8000|4273)\b' || true
