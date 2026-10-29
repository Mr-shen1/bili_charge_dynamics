#!/usr/bin/env bash
# 票 10 隔离局域网预览启动脚本（准备用，非产品实施）。
# 只启动 4 个进程：live_app API(127.0.0.1:4180)、图片夹具(127.0.0.1:4339)、
# 环境 A 正式 dist 预览(0.0.0.0:4318)、环境 B dist-mock 预览(0.0.0.0:4337)。
# 不启动 collector/notifier，不访问真实上游/飞书/OSS；既有 8000/4273 一律不碰。
# 前置：RUNTIME 已按 preparation.md「运行时目录」一节准备好（dist-a/dist-b/server 已复制）。
set -euo pipefail

RUNTIME="${RUNTIME:-/tmp/bili-ticket10-iOV2nX}"
REPO="${REPO:-/home/kevin/Projects/PI/bili_charge_dynamics}"
FRONTEND="$REPO/frontend"
API_PORT=4180
IMAGES_PORT=4339
PORT_A=4318
PORT_B=4337
# 冻结产物指纹（与 frontend/dist、frontend/dist-mock 的 index.html 一致）。
SHA_A=e578cdca2abb7ecec9e928f16b90e1590821017fed0e4119cb320ff1245ccc99
SHA_B=8e3676cdbd93fdfef385cae51602a065458372d3fa03584e3b3a158094505f16

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

# 2. 冻结产物校验：/tmp 内的副本必须与已构建产物指纹一致。
check_sha() {
  local want=$1 file=$2
  local got
  got=$(sha256sum "$file" | cut -d' ' -f1)
  if [ "$got" != "$want" ]; then
    echo "REFUSE: $file 指纹 $got != 期望 $want（产物被重建或复制不完整）" >&2
    exit 1
  fi
}
check_sha "$SHA_A" "$RUNTIME/dist-a/index.html"
check_sha "$SHA_B" "$RUNTIME/dist-b/index.html"

# 3. Node 24（nvm）与 pnpm。
# shellcheck disable=SC1091
source "$HOME/.nvm/nvm.sh"
nvm use 24 >/dev/null
node --version
pnpm --version

# 子进程专用环境：清空所有代理变量，仅回环直连；只影响本脚本派生的新进程。
launch() {
  local name=$1 pidfile logfile
  shift
  pidfile="$RUNTIME/run/$name.pid"
  logfile="$RUNTIME/logs/$name.log"
  rm -f "$pidfile"
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

# 4. API：live_app 固定虚构上游，隔离 SQLite，只绑回环。
launch api \
  BILI_DATABASE_PATH="$RUNTIME/monitor.sqlite" \
  bash -c 'echo $$ > "$1"; shift; exec "$@"' _ "$RUNTIME/run/api.pid" \
  uv run --no-sync python -m uvicorn backend.tests.live_app:create_app --factory \
  --host 127.0.0.1 --port "$API_PORT" --app-dir "$REPO" --log-level info
wait_http "http://127.0.0.1:$API_PORT/api/manage/ups"

# 5. 图片夹具：只 bind 127.0.0.1:4339，用 /tmp 冻结副本。
launch images \
  IMAGE_SERVER_PORT="$IMAGES_PORT" \
  bash -c 'echo $$ > "$1"; shift; exec "$@"' _ "$RUNTIME/run/images.pid" \
  node "$RUNTIME/server/imageServer.mjs"
wait_http "http://127.0.0.1:$IMAGES_PORT/__requests"

# 6. 环境 A：正式 dist（绝对 --outDir 指向 /tmp 冻结副本）；显式 API/图片代理目标。
launch web-a \
  API_SERVER="http://127.0.0.1:$API_PORT" IMAGE_SERVER_PORT="$IMAGES_PORT" \
  bash -c 'echo $$ > "$1"; shift; exec "$@"' _ "$RUNTIME/run/web-a.pid" \
  pnpm --dir "$FRONTEND" exec vite preview --outDir "$RUNTIME/dist-a" \
  --host 0.0.0.0 --port "$PORT_A" --strictPort
wait_http "http://127.0.0.1:$PORT_A/"

# 7. 环境 B：dist-mock（mock 自检装配，含 /__preview-fixtures）；同一 API 与图片代理。
launch web-b \
  API_SERVER="http://127.0.0.1:$API_PORT" IMAGE_SERVER_PORT="$IMAGES_PORT" \
  bash -c 'echo $$ > "$1"; shift; exec "$@"' _ "$RUNTIME/run/web-b.pid" \
  pnpm --dir "$FRONTEND" exec vite preview --outDir "$RUNTIME/dist-b" \
  --host 0.0.0.0 --port "$PORT_B" --strictPort
wait_http "http://127.0.0.1:$PORT_B/"

echo "--- 进程（pid / pgid / 监听） ---"
for name in api images web-a web-b; do
  pid=$(cat "$RUNTIME/run/$name.pid")
  printf '%-7s pid=%s pgid=%s\n' "$name" "$pid" "$(ps -o pgid= -p "$pid" | tr -d ' ')"
done
ss -ltnp 2>/dev/null | grep -E ":$PORT_A|:$API_PORT|:$PORT_B|:$IMAGES_PORT" || true
echo "--- 既有服务（不得变化） ---"
ss -ltn 2>/dev/null | grep -E ':(8000|4273)\b' || true
