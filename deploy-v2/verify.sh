#!/usr/bin/env bash
# verify.sh —— 只读验收。本地与云端同一份、同一组检查。
# 不写文件、不改服务；任何需要 root 的读取用 sudo（root 直跑时自动省略）。
#
# 用法：verify.sh [--port 4273|4173]
# 退出码：0 全绿；1 有失败项（逐条列出）。

set -uo pipefail

PORT=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --port) PORT="${2:?--port 需要数字}"; shift 2 ;;
        *) echo "未知参数：$1" >&2; exit 2 ;;
    esac
done
if [[ -z "$PORT" ]]; then
    command -v apt-get >/dev/null 2>&1 && PORT=4173 || PORT=4273
fi
[[ $EUID -eq 0 ]] && SUDO="" || SUDO="sudo"

API=http://127.0.0.1:8000
# 网页端优先用实际监听地址（--lan 时只绑局域网地址，127.0.0.1 不可达）
listen_addr="$(ss -H -ltn "sport = :$PORT" 2>/dev/null | awk '{print $4}' | head -1)"
case "$listen_addr" in
    ""|0.0.0.0:*|\*:*|\[::\]:*) listen_addr="127.0.0.1:$PORT" ;;
esac
WEB="http://$listen_addr"
DB=/srv/bili-monitor/monitor.sqlite
APP_DIR=/srv/bili-monitor/app
fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=1; }
info() { printf '    %s\n' "$*"; }

code() {
    local c
    c="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null)" || true
    printf '%s' "${c:-000}"
}

printf '\n\033[1m只读验收（端口 %s）\033[0m\n' "$PORT"

# 服务刚重启时 API 需要几秒；先等它就绪再判定，否则会假失败
for _ in $(seq 1 15); do
    [[ "$(code "$API/api/manage/ups")" == 200 ]] && break
    sleep 1
done

# 1. 服务
if systemctl is-active --quiet bili-monitor; then
    ok "bili-monitor active"
else
    bad "bili-monitor 不是 active"
fi

# 2. API 直连
if [[ "$(code "$API/api/manage/ups")" == 200 ]]; then
    ok "API 直连 200：$(curl -sS -m 5 "$API/api/manage/ups" | head -c 120)"
else
    bad "API 直连非 200"
fi
if [[ "$(code "$API/api/nope")" == 404 ]]; then
    ok "未知 API 直连 404"
else
    bad "未知 API 直连未返回 404"
fi

# 3. 通知开关与风控（只读）
notif="$(curl -sS -m 5 "$API/api/manage/notifications" 2>/dev/null || true)"
info "通知状态：$(printf '%s' "$notif" | head -c 160)"
risk="$(curl -sS -m 5 "$API/api/manage/risk" 2>/dev/null || true)"
info "风控状态：$(printf '%s' "$risk" | head -c 120)"

# 4. 页面与资源语义
for p in / /manage; do
    c="$(code "$WEB$p")"
    [[ "$c" == 200 ]] && ok "页面 $p 200" || bad "页面 $p 返回 $c"
done
c="$(code "$WEB/api/nope")"
[[ "$c" == 404 ]] && ok "经 Nginx 的未知 API 404（未回退 SPA）" || bad "经 Nginx 的未知 API 返回 $c"
hdr="$(curl -sSI -m 5 "$WEB/api/nope" 2>/dev/null | tr -d '\r' | grep -i '^cache-control:' || true)"
case "$hdr" in *no-store*) ok "未知 API 带 Cache-Control: no-store" ;; *) bad "未知 API 缺 no-store（$hdr）" ;; esac
hdr="$(curl -sSI -m 5 "$WEB/" 2>/dev/null | tr -d '\r' | grep -i '^cache-control:' || true)"
case "$hdr" in *no-cache*) ok "入口页带 Cache-Control: no-cache" ;; *) bad "入口页缺 no-cache（$hdr）" ;; esac
c="$(code "$WEB/assets/nonexistent.js")"
[[ "$c" == 404 ]] && ok "缺失资源 404（不是入口 HTML）" || bad "缺失资源返回 $c"

# 哈希资源：GET + 声明 gzip，验证压缩与不可变缓存
asset="$(cd /srv/dynamics-viewer/current/assets 2>/dev/null && ls -1S *.js 2>/dev/null | head -1 || true)"
if [[ -n "$asset" ]]; then
    out="$(curl -sS --compressed -D - -o /dev/null -m 8 -H 'Accept-Encoding: gzip' "$WEB/assets/$asset" | tr -d '\r')"
    echo "$out" | grep -qi '^content-encoding: gzip' && ok "资源 $asset 有 gzip" || bad "资源 $asset 无 gzip"
    echo "$out" | grep -qi 'cache-control:.*immutable' && ok "资源 $asset 有 immutable 缓存" || bad "资源 $asset 缺 immutable"
else
    bad "找不到哈希 JS 资源（/srv/dynamics-viewer/current/assets）"
fi

# 5. 监听
addrs="$(ss -H -ltn "sport = :$PORT" | awk '{print $4}' | paste -sd, -)"
[[ -n "$addrs" ]] && ok "Web 端口 $PORT 监听：$addrs" || bad "Web 端口 $PORT 未监听"
addrs="$(ss -H -ltn "sport = :8000" | awk '{print $4}' | paste -sd, -)"
case "$addrs" in
    127.0.0.1:8000*) ok "API 端口 8000 只监听回环：$addrs" ;;
    *) bad "API 端口 8000 监听异常：${addrs:-无}" ;;
esac
if grep -qE '^[[:space:]]*listen[[:space:]]+([^;]*:)?80([[:space:]]|;)' \
        <(if [[ -z "$SUDO" ]]; then nginx -T 2>/dev/null; else $SUDO -n nginx -T 2>/dev/null; fi); then
    bad "Nginx 生效配置含 80 监听（本项目不应占 80）"
elif [[ -z "$(if [[ -z "$SUDO" ]]; then nginx -T 2>/dev/null; else $SUDO -n nginx -T 2>/dev/null; fi)" ]]; then
    info "读不到 Nginx 生效配置（需要 sudo）；跳过 80 检查"
else
    ok "Nginx 生效配置无 80 监听"
fi

# 6. 进程与数据库
n="$(pgrep -u bili -c python 2>/dev/null || true)"; n="${n:-0}"
[[ "${n:-0}" -ge 2 ]] && ok "bili 名下 python 进程 $n 个（入口 + API + collector）" || bad "bili 名下 python 进程只有 ${n:-0} 个"
if [[ -r "$DB" ]]; then
    uv="$(sqlite3 "file:$DB?mode=ro" 'pragma user_version;' 2>/dev/null || echo '?')"
    # 期望版本从部署代码的 SCHEMA_VERSION 读：迁移后验收脚本不跟着改就能对齐。
    expected="$(sed -n 's/^SCHEMA_VERSION = \([0-9]\{1,\}\)$/\1/p' \
        "$APP_DIR/backend/bili_monitor/storage.py" 2>/dev/null | head -1)"
    if [[ -z "$expected" ]]; then
        info "读不到部署代码的 SCHEMA_VERSION；跳过 schema 比对（数据库 user_version=$uv）"
    elif [[ "$uv" == "$expected" ]]; then
        ok "数据库 schema user_version=$uv 与代码一致"
    else
        bad "数据库 user_version=$uv（代码期望 $expected）"
    fi
    ups="$(curl -sS -m 5 "$API/api/manage/ups" 2>/dev/null || true)"
    case "$ups" in
        '{"ups":[]}'*) info "当前没有任何 UP（新空库的正常状态）" ;;
        *) info "已有 UP 数据" ;;
    esac
else
    bad "读不到数据库 $DB"
fi

# 7. env / 凭据：启用了什么就必须能读到什么（避免重启循环）
VHERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
if [[ -x "$VHERE/doctor.sh" ]]; then
    if doc_out="$(bash "$VHERE/doctor.sh" --quiet --no-prompt 2>&1)"; then
        case "$doc_out" in
            *跳过*) info "env 与凭据检查跳过（需要 sudo；先 sudo -v 再跑）" ;;
            *)      ok "env 与凭据检查通过" ;;
        esac
    else
        bad "env 与凭据有问题：$(printf '%s' "$doc_out" | head -1)"
        info "详情：bash deploy-v2/doctor.sh"
    fi
fi

# 8. 日志里不该有的东西
if (if [[ -z "$SUDO" ]]; then journalctl -u bili-monitor -n 200 --no-pager 2>/dev/null; else $SUDO -n journalctl -u bili-monitor -n 200 --no-pager 2>/dev/null; fi) |
    grep -qiE 'traceback|future schema|lock conflict|migration failed'; then
    bad "最近日志里有 traceback / 迁移失败 / 锁冲突"
else
    ok "最近 200 行日志干净（或无权读取 journald）"
fi

echo
if [[ "$fail" == 0 ]]; then
    printf '\033[32m全部通过\033[0m\n'
else
    printf '\033[31m有失败项，逐条看上面 ✗\033[0m\n'
fi
exit "$fail"
