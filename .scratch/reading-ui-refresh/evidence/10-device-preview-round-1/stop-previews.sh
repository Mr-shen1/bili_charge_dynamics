#!/usr/bin/env bash
# 票 10 第二轮隔离预览停机脚本。
# 只按本轮 pidfile 精确回收本次启动的 4 个进程组：不扫端口、不按端口匹配、不杀别人的进程。
# pidfile 里的 PID 若已被别的服务复用（命令行不匹配或不再是进程组组长），一律拒绝并跳过。
# 不删除 SQLite（运行产物留在 /tmp 供复查），也不动既有 8000/4273。
set -uo pipefail

RUNTIME="${RUNTIME:-/tmp/bili-ticket10-round1-zogc}"

# pidfile → 期望命令特征（双重校验，防止 pid 复用误杀）。
expected() {
  case "$1" in
    api) echo 'live_app:create_app' ;;
    images) echo 'imageServer.mjs' ;;
    web-a) echo 'dist-a' ;;
    web-b) echo 'dist-b' ;;
  esac
}

for name in web-b web-a images api; do
  pidfile="$RUNTIME/run/$name.pid"
  if [ ! -s "$pidfile" ]; then
    echo "$name: 无 pidfile，跳过"
    continue
  fi
  pid=$(cat "$pidfile")
  if [ ! -d "/proc/$pid" ]; then
    echo "$name: pid $pid 已不存在"
    rm -f "$pidfile" "$RUNTIME/run/$name.pgid"
    continue
  fi
  cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline")
  want=$(expected "$name")
  case "$cmdline" in
    *"$want"*) ;;
    *)
      echo "$name: pid $pid 命令行不匹配 '$want'，拒绝杀（cmdline: $cmdline）" >&2
      continue
      ;;
  esac
  pgid=$(ps -o pgid= -p "$pid" | tr -d ' ')
  if [ "$pgid" != "$pid" ]; then
    echo "$name: pid $pid 不是进程组组长（pgid=$pgid），拒绝按组杀" >&2
    continue
  fi
  echo "$name: TERM -$pgid ($cmdline)"
  kill -TERM -- "-$pgid" 2>/dev/null
  for _ in $(seq 1 100); do
    [ -d "/proc/$pid" ] || break
    sleep 0.1
  done
  if [ -d "/proc/$pid" ]; then
    echo "$name: pid $pid 10s 内未退出，保留现状，请人工检查（不做 kill -9）" >&2
  else
    echo "$name: 已退出"
    rm -f "$pidfile" "$RUNTIME/run/$name.pgid"
  fi
done

echo '--- 剩余监听（本轮端口应为空） ---'
ss -ltnp 2>/dev/null | grep -E ':(4318|4180|4337|4339)\b' || echo '（无）'
echo '--- 既有服务（不得变化） ---'
ss -ltn 2>/dev/null | grep -E ':(8000|4273)\b' || echo '（无）'
