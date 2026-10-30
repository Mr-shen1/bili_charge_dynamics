#!/usr/bin/env bash
# doctor.sh —— 部署体检：指出「服务起不来」的真实原因（应用的 traceback 被 `from None` 吞了）。
#
# 只读：不改文件、不重启服务。
# env 的读取有三级降级，所以 root、有 sudo 的账号、甚至 bili 用户自己都能跑：
#   1. /etc/bili-monitor/env 当前用户可读        → 直接读
#   2. 有 sudo                                   → sudo 读
#   3. 以 bili 身份运行时                        → 读运行中服务进程的 /proc/<pid>/environ
#      （systemd 注入的就是这一份；bili 本来就在用这些凭据，不扩大可见面）
#
# 用法：
#     bash deploy-v2/doctor.sh                 # 全量体检
#     bash deploy-v2/doctor.sh --quiet         # 每条只出一行结论
#     bash deploy-v2/doctor.sh --quiet --no-prompt   # 只用已缓存的 sudo（verify.sh 用）
#
# 退出码：0 通过或无法检查（跳过）；1 有阻塞问题。

set -uo pipefail

APP_DIR=/srv/bili-monitor/app
ENV_FILE=/etc/bili-monitor/env
DB_DEFAULT=/srv/bili-monitor/monitor.sqlite
RUN_USER=bili
SERVICE_UNIT=bili-monitor

QUIET=0
NO_PROMPT=0
IGNORE_SERVICE=0
for arg in "$@"; do
    case "$arg" in
        --quiet)     QUIET=1 ;;
        --no-prompt) NO_PROMPT=1 ;;
        --ignore-service) IGNORE_SERVICE=1 ;;   # install/upgrade 启动服务之前用
        -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "未知参数：$arg（可用 --quiet、--no-prompt）" >&2; exit 2 ;;
    esac
done

[[ $EUID -eq 0 ]] && SUDO="" || SUDO="sudo"
ME="$(id -un)"

skip_all() {
    printf '  \033[33m!\033[0m %s\n' "$1"
    echo "env/凭据检查跳过：$2"
    exit 0
}

as_root() {
    if [[ -z "$SUDO" ]]; then "$@"
    elif [[ "$CAN_ASK_SUDO" == 1 && "$NO_PROMPT" == 0 ]]; then $SUDO "$@"
    else $SUDO -n "$@"; fi
}
as_bili() {
    if [[ -z "$SUDO" ]]; then runuser -u "$RUN_USER" -- "$@"
    elif [[ "$CAN_ASK_SUDO" == 1 && "$NO_PROMPT" == 0 ]]; then $SUDO -u "$RUN_USER" -- "$@"
    else $SUDO -n -u "$RUN_USER" -- "$@"; fi
}
# credentials/ 是 bili 0700：既不是 root 也不是 bili 时，读/判/删都必须借 sudo
maybe_root() {
    if [[ $EUID -eq 0 || "$ME" == "$RUN_USER" ]]; then "$@"
    else as_root "$@"; fi
}
# 普通 stat 能读就读，读不到再借 sudo（/etc/bili-monitor 是 755，stat 本身通常不需要 root）
stat_of() {
    stat -c "$1" "${@:2}" 2>/dev/null && return 0
    as_root stat -c "$1" "${@:2}" 2>/dev/null
}

# 只有确实具备 sudo 权限的账号才去问密码；bili 这种服务账号问了也白问，
# 会直接走下面的 /proc 路径。
CAN_ASK_SUDO=0
if [[ -n "$SUDO" ]] && id -nG 2>/dev/null | tr ' ' '\n' | grep -qxE 'sudo|wheel'; then
    CAN_ASK_SUDO=1
fi
if [[ "$CAN_ASK_SUDO" == 1 && "$NO_PROMPT" == 0 ]]; then
    $SUDO -v 2>/dev/null || true   # 失败不致命：下面还有 /proc 和跳过两条路
fi
if as_root true >/dev/null 2>&1; then CAN_SUDO=1; else CAN_SUDO=0; fi

fail=0
ok()    { [[ $QUIET == 1 ]] || printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()   { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=1; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
info()  { [[ $QUIET == 1 ]] || printf '    %s\n' "$*"; }
head_() { [[ $QUIET == 1 ]] || printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

redact() {
    case "$1" in
        *SECRET*|*TOKEN*) printf '<已设置，%s 字节>' "${#2}" ;;
        *KEY_ID*)         printf '%s…' "${2:0:4}" ;;
        *)                printf '%s' "$2" ;;
    esac
}

# ── 取 env ──────────────────────────────────────────────────────────────────
head_ "环境文件 $ENV_FILE"
envdump=""
env_source=""
if [[ -r $ENV_FILE ]]; then
    envdump="$(cat "$ENV_FILE")"; env_source="$ENV_FILE（当前用户可读）"
elif [[ "$CAN_SUDO" == 1 ]]; then
    envdump="$(as_root cat "$ENV_FILE" 2>/dev/null || true)"; env_source="$ENV_FILE（sudo 读取）"
else
    pid="$(pgrep -u "$ME" -f 'backend\.bili_monitor\.service' 2>/dev/null | head -1 || true)"
    if [[ -n "$pid" && -r "/proc/$pid/environ" ]]; then
        envdump="$(tr '\0' '\n' < "/proc/$pid/environ" | grep -E '^BILI_' || true)"
        env_source="/proc/$pid/environ（运行中服务进程，systemd 注入的同一份）"
    fi
fi
[[ -n "$envdump" ]] || skip_all "读不到 $ENV_FILE" \
    "用 root 或具备 sudo 的账号运行，或在 bili 账号下、服务已启动时运行"

if [[ "$env_source" == "$ENV_FILE"* ]]; then
    meta="$(stat_of '%U:%G %a' "$ENV_FILE" || true)"
    [[ "$meta" == "root:root 600" ]] && ok "权限 $meta" || bad "权限应为 root:root 600，实际 ${meta:-读不到}"
else
    info "env 来源：$env_source"
fi

declare -A E=()
while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || { bad "无法解析的行：${line:0:40}"; continue; }
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
    E["$key"]="$value"
    info "$key=$(redact "$key" "$value")"
done <<<"$envdump"

# 空的选配变量是硬错误：既不是「未设置」，又算配置不完整
for key in "${!E[@]}"; do
    case "$key" in
        BILI_COOKIE_FILE|BILI_NOTIFICATION_CONFIG|BILI_OSS_*|BILI_DATABASE_PATH)
            [[ -n "${E[$key]}" ]] || bad "$key 存在但为空值 —— 要么整行注释，要么填完整（空值会让服务起不来）" ;;
    esac
done

DB_PATH="${E[BILI_DATABASE_PATH]:-$DB_DEFAULT}"
if [[ -z "${E[BILI_DATABASE_PATH]:-}" ]]; then
    bad "缺少必填 BILI_DATABASE_PATH"
elif [[ "$DB_PATH" != /* ]]; then
    bad "BILI_DATABASE_PATH 必须是绝对路径：$DB_PATH"
else
    ok "BILI_DATABASE_PATH=$DB_PATH"
fi

dbdir="$(dirname "$DB_PATH")"
if [[ ! -d "$dbdir" ]]; then
    bad "数据库目录不存在：$dbdir"
elif [[ "$ME" == "$RUN_USER" ]]; then
    [[ -w "$dbdir" ]] && ok "数据库目录可写：$dbdir" || bad "数据库目录对 $RUN_USER 不可写：$dbdir"
elif [[ "$CAN_SUDO" == 1 ]]; then
    ( cd /var/tmp && as_bili test -w "$dbdir" ) 2>/dev/null \
        && ok "数据库目录可写：$dbdir" || bad "数据库目录对 $RUN_USER 不可写：$dbdir"
else
    info "数据库目录可写性未验证（需要 sudo 或 bili 身份）"
fi
if [[ -f "$DB_PATH" ]]; then
    magic="$(head -c 15 "$DB_PATH" 2>/dev/null || true)"
    [[ "$magic" == "SQLite format 3" ]] && ok "数据库文件是 SQLite" || bad "数据库文件头异常：$DB_PATH"
    uv="$(sqlite3 "file:$DB_PATH?mode=ro" 'pragma user_version;' 2>/dev/null || echo '?')"
    # 期望版本取部署代码里的 SCHEMA_VERSION，不在这里写死数字。
    expected="$(sed -n 's/^SCHEMA_VERSION = \([0-9]\{1,\}\)$/\1/p' \
        "$APP_DIR/backend/bili_monitor/storage.py" 2>/dev/null | head -1)"
    if [[ -z "$expected" ]]; then
        info "读不到代码里的 SCHEMA_VERSION；跳过 schema 比对（数据库 user_version=$uv）"
    elif [[ "$uv" == "$expected" ]]; then
        ok "schema user_version=$uv 与代码一致"
    else
        warn "schema user_version=$uv（代码期望 $expected）"
    fi
else
    info "数据库还不存在（首次启动会创建）"
fi

# ── Cookie ──────────────────────────────────────────────────────────────────
head_ "B 站 Cookie"
if [[ -z "${E[BILI_COOKIE_FILE]:-}" ]]; then
    ok "未启用（匿名访问）"
else
    p="${E[BILI_COOKIE_FILE]}"
    if ! maybe_root test -e "$p" && ! maybe_root test -L "$p"; then
        bad "BILI_COOKIE_FILE 指向的文件不存在：$p"
    else
        maybe_root test -L "$p" && bad "不允许符号链接：$p" || ok "不是符号链接"
        d="$(dirname "$p")"
        dmeta="$(stat_of '%U %a' "$d" || true)"
        [[ "$dmeta" == "$RUN_USER 700" ]] && ok "目录属主/权限 $dmeta" \
            || bad "目录必须是 $RUN_USER 的 0700，实际 ${dmeta:-读不到}"
        fmeta="$(stat_of '%U %a %h' "$p" || true)"
        if [[ "$fmeta" == "$RUN_USER 600 1" ]]; then
            ok "文件属主/权限/链接数 $fmeta"
        else
            bad "文件必须是 $RUN_USER 的 0600 且 nlink=1，实际 ${fmeta:-读不到}"
            [[ $QUIET == 1 ]] || info "修复：sudo chown $RUN_USER:$RUN_USER $p && sudo chmod 600 $p"
        fi
        if LC_ALL=C maybe_root cat "$p" 2>/dev/null |
            grep -qP '[\x80-\xFF]|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'; then
            bad "文件含非 ASCII 或控制字符"
        else
            ok "内容为 ASCII、无控制字符"
        fi
    fi
fi

# ── 通知配置 ────────────────────────────────────────────────────────────────
head_ "飞书通知配置"
if [[ -z "${E[BILI_NOTIFICATION_CONFIG]:-}" ]]; then
    ok "未启用（只有 API + collector 两个进程）"
else
    p="${E[BILI_NOTIFICATION_CONFIG]}"
    if ! maybe_root test -f "$p"; then
        bad "BILI_NOTIFICATION_CONFIG 指向的文件不存在：$p"
    else
        fmeta="$(stat_of '%U %a' "$p" || true)"
        case "$fmeta" in
            "$RUN_USER 640"|"$RUN_USER 600"|"root 640"|"root 600") ok "属主/权限 $fmeta" ;;
            "")  bad "读不到 $p 的属性" ;;
            *)   bad "权限应为 ≤0640 且属主 $RUN_USER 或 root，实际 $fmeta"
                 [[ $QUIET == 1 ]] || info "修复：sudo chown $RUN_USER:$RUN_USER $p && sudo chmod 640 $p" ;;
        esac
        if maybe_root cat "$p" 2>/dev/null | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
            ok "JSON 可解析"
        else
            bad "JSON 解析失败：$p"
        fi
    fi
fi

# ── OSS ─────────────────────────────────────────────────────────────────────
head_ "OSS 媒体归档"
oss_keys=(BILI_OSS_ENDPOINT BILI_OSS_REGION BILI_OSS_BUCKET BILI_OSS_ACCESS_KEY_ID \
          BILI_OSS_ACCESS_KEY_SECRET BILI_OSS_PUBLIC_BASE_URL)
oss_set=0
for k in "${oss_keys[@]}" BILI_OSS_SECURITY_TOKEN; do
    [[ -n "${E[$k]:-}" ]] && oss_set=1
done
if [[ "$oss_set" == 0 ]]; then
    ok "未启用（媒体保持待归档）"
else
    want=0
    for k in "${oss_keys[@]}"; do
        [[ -n "${E[$k]:-}" ]] && want=$((want+1)) || bad "启用 OSS 后 $k 不能为空"
    done
    [[ "$want" == 6 ]] && ok "六项必填都存在（SECURITY_TOKEN 可选）"
    ep="${E[BILI_OSS_ENDPOINT]:-}"
    if [[ "$ep" =~ ^https://[a-z0-9][a-z0-9.-]*\.aliyuncs\.com$ ]]; then
        ok "ENDPOINT 形态正确：$ep"
    else
        bad "ENDPOINT 必须是 https://<域名>.aliyuncs.com，且无路径/端口：${ep:-空}"
    fi
    pub="${E[BILI_OSS_PUBLIC_BASE_URL]:-}"
    if [[ "$pub" =~ ^https?://[^?#[:space:]]+$ ]]; then
        ok "PUBLIC_BASE_URL 形态正确"
    else
        bad "PUBLIC_BASE_URL 必须是无 query/fragment 的 http(s) 前缀：${pub:-空}"
    fi
fi

# ── 真实加载器探查 ──────────────────────────────────────────────────────────
head_ "用真实加载器验证凭据"
probe_out=""; probe_err=""; probe_rc=0
if [[ "$ME" != "$RUN_USER" && "$CAN_SUDO" == 0 ]]; then
    warn "跳过（需要 sudo 才能以 $RUN_USER 身份运行加载器）"
else
    tmp_dir="$(mktemp -d /var/tmp/bili-doctor.XXXXXX)"
    # 目录必须可被运行用户穿过（0711：能进入、不能列目录），否则 bili 读不到里面的文件
    chmod 0711 "$tmp_dir"
    tmp_env="$tmp_dir/env"; tmp_py="$tmp_dir/probe.py"; tmp_err="$tmp_dir/err"
    {
        printf 'BILI_DATABASE_PATH=%q\n' "$DB_PATH"
        for k in BILI_COOKIE_FILE BILI_NOTIFICATION_CONFIG \
                 BILI_OSS_ENDPOINT BILI_OSS_REGION BILI_OSS_BUCKET BILI_OSS_ACCESS_KEY_ID \
                 BILI_OSS_ACCESS_KEY_SECRET BILI_OSS_PUBLIC_BASE_URL BILI_OSS_SECURITY_TOKEN; do
            [[ -n "${E[$k]:-}" ]] && printf '%s=%q\n' "$k" "${E[$k]}"
        done
    } > "$tmp_env"
    cat > "$tmp_py" <<'PY'
import os, sys
problems = []
try:
    from backend.bili_monitor.source_cookies import load_source_cookie_pairs
    print(f"cookie: 已读取 {len(load_source_cookie_pairs())} 组")
except Exception as error:
    problems.append(f"cookie: {error}")
try:
    from backend.bili_monitor.oss import OSSUploader
    uploader = OSSUploader.from_environment()
    print(f"oss: {'已启用' if uploader else '未启用'}")
    if uploader:
        uploader.close()
except Exception as error:
    problems.append(f"oss: {error}")
try:
    path = os.environ.get("BILI_NOTIFICATION_CONFIG")
    if path:
        from backend.bili_monitor.notifications.config import NotificationConfig
        config = NotificationConfig.load(path)
        print(f"notification: base_url={config.base_url} destinations={len(config.destinations)}")
    else:
        print("notification: 未启用")
except Exception as error:
    problems.append(f"notification: {error}")
for problem in problems:
    print(f"FAIL {problem}")
sys.exit(1 if problems else 0)
PY
    : > "$tmp_err"
    chmod 0600 "$tmp_env" "$tmp_py" "$tmp_err"
    if [[ "$ME" != "$RUN_USER" ]]; then
        # 只把子进程要“读”的 env 与 probe.py 交给运行用户。
        # err 必须留给调用者：`2>"$tmp_err"` 是调用者 shell 打开的重定向，
        # chown 给 bili 之后调用者自己就打不开（Permission denied）。
        as_root chown "$RUN_USER:$RUN_USER" "$tmp_env" "$tmp_py" 2>/dev/null || true
        runner=(as_bili)
    else
        runner=()
    fi
    probe_out="$(
        cd /var/tmp && "${runner[@]}" env -i \
            "HOME=/home/$RUN_USER" "USER=$RUN_USER" "LOGNAME=$RUN_USER" \
            "PATH=/usr/local/bin:/usr/bin:/bin" "PYTHONPATH=$APP_DIR" "LANG=C.UTF-8" \
            bash -c 'set -a; . "$1"; shift; exec "$@"' _ "$tmp_env" \
                "$APP_DIR/.venv/bin/python" -W ignore::SyntaxWarning "$tmp_py" 2>"$tmp_err"
    )"; probe_rc=$?
    # 第三方库导入的 SyntaxWarning 不是诊断结论；只在真失败时展示 stderr 尾部
    probe_err="$(maybe_root cat "$tmp_err" 2>/dev/null | grep -vE 'SyntaxWarning|^[[:space:]]+r\.|warnings\.warn' | tail -3 || true)"
    maybe_root rm -rf "$tmp_dir" 2>/dev/null || true
fi
while IFS= read -r line; do
    case "$line" in
        FAIL*)                         bad "${line#FAIL }" ;;
        cookie:*|oss:*|notification:*) ok "$line" ;;
        "")                            ;;
        *)                             bad "探针输出异常：$line" ;;
    esac
done <<<"$probe_out"
if [[ "$probe_rc" != 0 ]]; then
    fail=1
    [[ -n "$probe_err" ]] && bad "探针 stderr：$probe_err"
fi

# ── 服务状态 ────────────────────────────────────────────────────────────────
head_ "服务状态"
if [[ "$IGNORE_SERVICE" == 1 ]]; then
    info "跳过（本次是启动前的体检，服务由 deploy.sh 随后拉起）"
    state=active
else
state="$(systemctl is-active "$SERVICE_UNIT" 2>/dev/null || true)"
restarts="$(systemctl show "$SERVICE_UNIT" -p NRestarts --value 2>/dev/null || echo '?')"
[[ "$state" == active ]] && ok "$SERVICE_UNIT active" || bad "$SERVICE_UNIT 是 $state（重启计数 $restarts）"
if [[ "$state" != active ]]; then
    info "最近日志里的关键行："
    as_root journalctl -u "$SERVICE_UNIT" -n 200 --no-pager 2>/dev/null |
        grep -E "ERROR|RuntimeError|ValueError|FAILURE|failed" | tail -5 | sed 's/^/      /'
fi
fi

echo
if [[ "$fail" == 0 ]]; then
    [[ $QUIET == 1 ]] && echo "env/凭据检查通过"
    [[ $QUIET == 1 ]] || printf '\033[32m体检通过\033[0m\n'
    exit 0
fi
[[ $QUIET == 1 ]] && echo "env/凭据检查有失败项（跑 deploy-v2/doctor.sh 看详情）"
printf '\033[31m有阻塞问题，逐条看上面 ✗\033[0m\n'
echo "修好之后：sudo systemctl restart bili-monitor，再 bash deploy-v2/verify.sh"
exit 1
