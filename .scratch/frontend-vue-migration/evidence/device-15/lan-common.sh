#!/usr/bin/env bash
# 票据 15 两个局域网启动脚本的公共部分：路径解析、候选校验、子进程清理、就绪等待与局域网地址打印。
# 只被 serve-env-a.sh / serve-env-b.sh source，不单独执行。

set -euo pipefail

device15_here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
device15_repo=$(cd "$device15_here/../../../.." && pwd)
device15_frontend="$device15_repo/frontend"
device15_pids=()

device15_cleanup() {
  for pid in "${device15_pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap device15_cleanup EXIT INT TERM

# 产物必须属于 candidate.json 登记的候选，否则设备结果无法与该候选关联。
device15_verify_candidate() {
  node "$device15_here/capture-candidate.mjs" --verify
}

# 后台起一个被测服务，并登记 pid 供退出时回收。
device15_spawn() {
  "$@" &
  device15_pids+=($!)
}

device15_wait_for() {
  local url=$1 name=$2
  for _ in $(seq 1 120); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  echo "等待 $name 就绪超时：$url" >&2
  return 1
}

device15_print_lan() {
  local port=$1 address
  # `hostname -I` 在部分发行版（net-tools 以外）不可用，优先用 iproute2。
  local addresses
  addresses=$(ip -4 -o addr show scope global 2>/dev/null | awk '{ print $4 }' | cut -d/ -f1)
  if [ -z "$addresses" ]; then
    echo "  未能自动列出局域网地址，请用 \`ip -4 addr\` 自行确认后用 http://<局域网 IP>:$port/ 访问"
    return 0
  fi
  for address in $addresses; do
    echo "  http://$address:$port/"
  done
}
