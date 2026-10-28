#!/usr/bin/env bash
# 沙箱安全分支测试：不调用真实 sudo、不安装系统软件、不启动服务、不碰 /srv 或 /etc。
#
# 用途：证明 scripts/prepare-local-deployment-package.sh 与 scripts/setup-local-deployment.sh
# 的“拒绝未知/已修改/占用”分支、路径渲染、MANIFEST 校验、wizard library 前缀一致性等
# 安全行为，而无需 root 或真实目标机状态。
#
# 运行：bash .scratch/local-cloud-deployment/tests/sandbox-safety-tests.sh
# 退出码：0 全部通过；非 0 有失败项。

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WIZARD="$REPO_ROOT/scripts/setup-local-deployment.sh"
PREPARE="$REPO_ROOT/scripts/prepare-local-deployment-package.sh"
TEMPLATE="$REPO_ROOT/.agents/skills/wizard/template.sh"
PACKAGE="${BILI_DEPLOY_PACKAGE:-/var/tmp/bili-local-deployment/e58271c}"

WORK="$(mktemp -d /var/tmp/bili-sandbox-tests.XXXXXX)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

FAILED=0
PASSED=0
LOG="$WORK/case.log"

pass() { printf 'PASS  %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() {
    printf 'FAIL  %s\n' "$1"
    FAILED=$((FAILED + 1))
    [[ -s "$LOG" ]] && sed 's/^/      /' "$LOG" | tail -n 8
}
case_run() {
    local name="$1" fn="$2"
    : >"$LOG"
    if ("$fn") >"$LOG" 2>&1; then pass "$name"; else fail "$name"; fi
}

assert_contains() { grep -qF -- "$2" <<<"$1" || { printf "缺少数值 %q，实际：%s\n" "$2" "$1"; return 1; }; }

# 抽取 wizard library + 自有 helpers（截至 run_wizard 之前）；不执行任何阶段。
HELPERS="$WORK/helpers.sh"
awk '/^run_wizard\(\) \{$/{exit} {print}' "$WIZARD" >"$HELPERS"
[[ -s "$HELPERS" ]] || { echo "无法抽取 helpers" >&2; exit 1; }

# 沙箱公共初始化：把脚本里的绝对路径全部重定向到 $WORK，并注入 sudo/命令替身。
sandbox_init() {
    # shellcheck disable=SC1090
    source "$HELPERS"
    set +euo pipefail
    # helpers 是在函数内 source 的，declare -A 会变成局部；测试需要全局关联数组
    declare -gA STATE=()

    SB="$WORK/sandbox"
    rm -rf "$SB"
    # 注意：不预建 nginx/conf.d、nginx/snippets——真实首装时它们也不存在，
    # 否则 preflight 会把它们判成“未识别已存在对象”。
    mkdir -p "$SB"/{root,etc,state,nginx,bin}
    DEPLOY_ROOT="$SB/root/bili-monitor"
    APP_DIR="$DEPLOY_ROOT/app"
    DB_PATH="$DEPLOY_ROOT/monitor.sqlite"
    BACKUP_DIR="$DEPLOY_ROOT/backup"
    CRED_DIR="$DEPLOY_ROOT/credentials"
    SITE_ROOT="$SB/site"
    CONF_ENV="$SB/etc/env"
    UNIT_FILE="$SB/etc/bili-monitor.service"
    NGINX_ROOT="$SB/nginx"
    NGINX_MAIN="$NGINX_ROOT/nginx.conf"
    NGINX_CONF="$NGINX_ROOT/conf.d/bili.conf"
    NGINX_SNIPPET="$NGINX_ROOT/snippets/bili-locations.conf"
    NGINX_SITES_DIR="$NGINX_ROOT/sites-enabled"
    PACMAN_PKG_CACHE="$SB/pkgcache"
    NGINX_STOCK_CONF="etc/nginx/nginx.conf"
    FAKE_NGINX_PKGVER="1.30.6-1"
    NGINX_INSTALLED_FLAG="$SB/nginx-installed"
    FAKE_NGINX_DUMP="$SB/effective.conf"
    export PACMAN_PKG_CACHE NGINX_STOCK_CONF FAKE_NGINX_PKGVER NGINX_INSTALLED_FLAG FAKE_NGINX_DUMP
    STATE_DIR="$SB/state"
    STATE_FILE="$STATE_DIR/state.tsv"
    BACKUP_STATE_DIR="$STATE_DIR/backups"
    UV_SYSTEM="$SB/root/usr-local-bin-uv"
    API_PORT=18000
    WEB_PORT=14273
    PROBLEMS=()
    STATE=()
    CONFIG_CHANGED=0
    NGINX_80_RISK=0
    SUDO_LOG="$WORK/sudo.log"
    : >"$SUDO_LOG"

    # 命令替身：pacman/systemctl/getent 只回答测试需要的问题；nginx 由 FAKE_NGINX_RC 控制。
    PACMAN_OWNED="$SB/pacman-owned.txt"
    : >"$PACMAN_OWNED"
    export PACMAN_OWNED
    mkdir -p "$PACMAN_PKG_CACHE"
    cat >"$SB/bin/pacman" <<'SH'
#!/usr/bin/env bash
case "$1" in
  -Si) printf 'Name            : nginx\nVersion         : 1.30.6-1.1\n' ;;
  -Q)
    if [[ "${2:-}" == "nginx" && -f "${NGINX_INSTALLED_FLAG:-/nonexistent}" ]]; then
        printf 'nginx %s\n' "${FAKE_NGINX_PKGVER:-1.30.6-1}"
    else
        exit 1
    fi
    ;;
  -Qo)
    # 只有清单里列出的路径算“由包拥有”；其余返回 1（与真实 pacman 一致）
    /usr/bin/grep -qxF -- "${2:-}" "${PACMAN_OWNED:-/nonexistent}" 2>/dev/null
    ;;
  *) exit 0 ;;
esac
SH
    cat >"$SB/bin/systemctl" <<'SH'
#!/usr/bin/env bash
# is-active 默认认为“未运行”
exit 3
SH
    cat >"$SB/bin/getent" <<'SH'
#!/usr/bin/env bash
exit 2
SH
    cat >"$SB/bin/nginx" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  -T)
    [[ -f "${FAKE_NGINX_DUMP:-}" ]] && cat "${FAKE_NGINX_DUMP}"
    exit "${FAKE_NGINX_RC:-0}"
    ;;
  -v)
    echo 'nginx version: nginx/1.30.6' >&2
    exit "${FAKE_NGINX_RC:-0}"
    ;;
esac
exit "${FAKE_NGINX_RC:-0}"
SH
    chmod 0755 "$SB/bin"/*
    PATH="$SB/bin:$PATH"

    # sudo 替身：只实现测试用到的最小集合；任何未白名单调用都会记录并失败。
    sudo() {
        printf '%s\n' "$*" >>"$SUDO_LOG"
        case "$1" in
            sha256sum) shift; command sha256sum "$@" ;;
            install)
                shift
                local args=()
                while (($#)); do
                    case "$1" in
                        -o|-g) shift 2 ;;
                        *) args+=("$1"); shift ;;
                    esac
                done
                command install "${args[@]}"
                ;;
            cp) shift; command cp "$@" ;;
            sed) shift; command sed "$@" ;;
            ln) shift; command ln "$@" ;;
            rsync) shift; command rsync "$@" ;;
            nginx) shift; command nginx "$@" ;;
            ss) shift; command ss "$@" ;;
            rm) shift; command rm "$@" ;;
            mv) shift; command mv "$@" ;;
            find) shift; command find "$@" ;;
            *) return 127 ;;
        esac
    }
}

# ── 静态断言：脚本里不允许出现危险快捷方式 ─────────────────────────────────
case_static_guards() {
    local bad=0 stripped
    stripped="$WORK/stripped.sh"
    # 去掉整行注释、行尾 # 注释与双引号文案后再检查“真实命令”：
    # 脚本里大量 “不执行 -Syu / 不用 --overwrite” 的提示文案不应被当成违规。
    sed -E 's/(^|[[:space:]])#.*$//; s/"[^"]*"//g' "$WIZARD" "$PREPARE" >"$stripped" 2>/dev/null

    check_forbidden() { # $1 pattern, $2 说明
        if grep -nE -- "$1" "$stripped" >"$LOG" 2>&1; then
            printf '发现禁止用法（%s）：\n' "$2"
            cat "$LOG"
            bad=1
        fi
    }
    check_forbidden 'sudo[[:space:]]+-n' 'sudo -n 免密'
    check_forbidden 'NOPASSWD' 'sudoers 免密'
    check_forbidden '(^|[;&|][[:space:]]*)(sudo[[:space:]]+)?pacman[[:space:]].*(-Syu|--overwrite)' 'pacman -Syu/--overwrite'
    check_forbidden '(^|[;&|[:space:]])apt(-get)?[[:space:]]' 'apt 命令'
    check_forbidden '(^|[;&|[:space:]])(source|\.[[:space:]])[[:space:]]*[^ ]*(\.env|~/\.local)' 'source .env / ~/.local'
    check_forbidden 'rm[[:space:]][^|;&]*sites-enabled/default' '删除 sites-enabled/default'

    # 向导不得打印 env 内容（只允许 sed 提取变量名）
    check_forbidden 'cat[[:space:]]+"?\$CONF_ENV' '打印 env'
    # 所有带 URL 的 curl 只能打回环
    if grep -nE '\bcurl\b' "$WIZARD" | grep -E 'https?://' | grep -vE 'https?://127\.0\.0\.1' >"$LOG" 2>&1; then
        printf '向导出现非回环 curl：\n'
        cat "$LOG"
        bad=1
    fi
    # bili 子进程必须 env -i；前端构建必须 env -i 且擦除 VITE_/BILI_
    grep -q 'sudo -u "$RUN_USER" env -i' "$WIZARD" || { printf '缺少 bili 的 env -i 调用\n'; bad=1; }
    grep -q 'CLEAN_ENV=(env -i' "$PREPARE" || { printf '准备脚本缺少 env -i\n'; bad=1; }
    grep -q "VITE_|BILI_" "$PREPARE" || { printf '准备脚本缺少 VITE_/BILI_ 擦除\n'; bad=1; }
    # 期望版本不得硬编码为完整提交 SHA（只允许来自受信仓库 HEAD 或 --commit）
    if grep -nEo '[0-9a-f]{40}' "$WIZARD" "$PREPARE" >"$LOG" 2>&1; then
        printf '脚本内出现硬编码 40 位提交 SHA：\n'
        cat "$LOG"
        bad=1
    fi
    # B4：错误提示不得推荐手改 state、伪恢复命令或让用户移走 main/配置
    local bad_advice
    for bad_advice in 'pacman -S nginx' '移走后重跑' '把该文件移走' '把默认 server 移走' \
        '移走该默认 server' '登记 file:' '移除 file:'; do
        if grep -nF -- "$bad_advice" "$WIZARD" >"$LOG" 2>&1; then
            printf '错误提示仍在推荐不安全出路：%s\n' "$bad_advice"
            cat "$LOG"
            bad=1
        fi
    done
    grep -qF '不删除、不移动真实配置、不手改 state' "$WIZARD" ||
        { printf '缺少固定安全建议文案（不删除/不移动/不手改 state）\n'; bad=1; }
    # 这 3 处消息已统一为“保留现场 + 人工按主指南核查”；禁止回退成旧文案
    local old_msg
    for old_msg in '把它移走/改名（**不要删除数据库或真实配置**）' \
        '请人工备份并移除默认 server 后重跑' \
        '把它移走/改名（别删）再重跑'; do
        if grep -nF -- "$old_msg" "$WIZARD" >"$LOG" 2>&1; then
            printf '已统一的旧文案回退了：%s\n' "$old_msg"
            cat "$LOG"
            bad=1
        fi
    done
    grep -qF '保留现文件、备份与状态' "$WIZARD" ||
        { printf '缺少“保留现文件、备份与状态”安全措辞\n'; bad=1; }
    grep -qF '保留数据库与现场' "$WIZARD" ||
        { printf '缺少“保留数据库与现场”安全措辞\n'; bad=1; }
    (($(grep -cF 'docs/deployment/README.md 人工核查来源' "$WIZARD") >= 3)) ||
        { printf '3 处统一消息未全部指向唯一主指南\n'; bad=1; }

    # B4：不允许“确认后照旧启动 80”的软门；启动/重载 nginx 之前必须有有效配置硬检查
    if grep -nE '仍要启用 nginx|NGINX_80_RISK' "$WIZARD" >"$LOG" 2>&1; then
        printf '仍存在可覆盖的 80 软门：\n'
        cat "$LOG"
        bad=1
    fi
    if grep -nE "grep -qE '\(\^\|:\)80\$'" "$WIZARD" >"$LOG" 2>&1; then
        printf '健康检查仍用全局 ss 80 断言：\n'
        cat "$LOG"
        bad=1
    fi
    grep -q 'users:(("nginx"' "$WIZARD" || { printf '健康检查未做本实例 nginx 占 80 判定\n'; bad=1; }
    local enable_line assert_line
    enable_line="$(grep -n 'systemctl enable --now nginx' "$WIZARD" | head -n1 | cut -d: -f1)"
    assert_line="$(grep -n 'assert_no_listen_80_effective' "$WIZARD" | tail -n1 | cut -d: -f1)"
    if [[ -z "$enable_line" || -z "$assert_line" ]] || ((assert_line > enable_line)); then
        printf 'nginx enable 之前缺少有效配置 80 硬检查（enable=%s assert=%s）\n' "${enable_line:-无}" "${assert_line:-无}"
        bad=1
    fi

    # 反向确认：注释里确实写明了这些限制
    grep -q '不执行 -Syu' "$WIZARD" || { printf '缺少 -Syu 禁止说明\n'; bad=1; }
    grep -q '不用 --overwrite' "$WIZARD" || { printf '缺少 --overwrite 禁止说明\n'; bad=1; }
    ((bad == 0))
}

case_library_prefix_identical() {
    local marker prefix_lines prefix_bytes
    marker="$(awk '/^run_wizard\(\) \{$/{print NR; exit}' "$TEMPLATE")"
    ((marker > 0)) || { printf 'template 无 run_wizard 标记\n'; return 1; }
    prefix_lines="$(head -n "$((marker - 1))" "$TEMPLATE" | grep -n '^# ─\{10,\}$' | tail -n1 | cut -d: -f1)"
    ((prefix_lines > 0)) || { printf '无法定位 STAGES 段结束分隔线\n'; return 1; }
    prefix_bytes="$(head -n "$prefix_lines" "$TEMPLATE" | wc -c)"
    head -c "$prefix_bytes" "$WIZARD" | cmp -s - <(head -n "$prefix_lines" "$TEMPLATE") || {
        printf 'wizard library 前缀不是逐字节相同（前 %s 行）\n' "$prefix_lines"
        return 1
    }
    printf 'library 前缀 %s 行 / %s bytes 逐字节一致\n' "$prefix_lines" "$prefix_bytes"
}

case_bash_syntax() {
    bash -n "$WIZARD" && bash -n "$PREPARE"
}

# ── 包校验 ────────────────────────────────────────────────────────────────
case_package_manifest() {
    [[ -d "$PACKAGE" ]] || { printf '安装包不存在：%s\n' "$PACKAGE"; return 1; }
    (cd "$PACKAGE" && sha256sum --check --strict --quiet MANIFEST.sha256) || return 1
    (cd "$PACKAGE" && sha256sum --check --strict --quiet MANIFEST.sha256.sha256) || return 1
    grep -qx 'commit=e58271c6e093b436bfbfc9bb45d3d7a7d349be19' "$PACKAGE/VERSION" || {
        printf 'VERSION commit 不是钉住版本\n'
        return 1
    }
    [[ -x "$PACKAGE/uv/uv" ]] || { printf 'uv/uv 不可执行\n'; return 1; }
    head -c 4 "$PACKAGE/uv/uv" | od -An -tx1 | tr -d ' \n' | grep -qx '7f454c46' || {
        printf 'uv/uv 不是 ELF\n'
        return 1
    }
}

case_package_is_production_only() {
    local bad=0
    [[ -f "$PACKAGE/frontend/dist/index.html" ]] || { printf '缺少生产 index.html\n'; bad=1; }
    [[ ! -e "$PACKAGE/frontend/dist-mock" ]] || { printf '包内含 dist-mock\n'; bad=1; }
    for dir in .venv node_modules test-results playwright-report; do
        if find "$PACKAGE" -maxdepth 3 -name "$dir" -print -quit | grep -q .; then
            printf '包内含 %s\n' "$dir"
            bad=1
        fi
    done
    if find "$PACKAGE" -name '.env' -o -name '.env.local' -o -name '*.sqlite' -o -name 'cookie.txt' |
        grep -q .; then
        printf '包内出现 .env / 数据库 / cookie 文件\n'
        bad=1
    fi
    grep -rIl -- '__preview-fixtures' "$PACKAGE/frontend/dist" >/dev/null 2>&1 && {
        printf '生产 dist 含 mock 自检路由\n'
        bad=1
    }
    ((bad == 0))
}

case_render_files() {
    local env_file="$PACKAGE/render/etc/bili-monitor/env" listen_count
    [[ -f "$env_file" ]] || { printf '缺少渲染 env\n'; return 1; }
    local active
    active="$(sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$env_file" | paste -sd, -)"
    [[ "$active" == "BILI_DATABASE_PATH,PYTHONDONTWRITEBYTECODE,PYTHONUNBUFFERED" ]] || {
        printf 'env 有效行不符：%s\n' "$active"
        return 1
    }
    grep -q '^# BILI_OSS_ENDPOINT=$' "$env_file" || { printf 'OSS 示例不是注释空值\n'; return 1; }
    grep -q '^BILI_OSS_' "$env_file" && { printf '出现未注释的 OSS 变量\n'; return 1; }
    grep -q '^BILI_COOKIE_FILE=' "$env_file" && { printf '出现未注释的 Cookie 变量\n'; return 1; }
    grep -q '^BILI_NOTIFICATION_CONFIG=' "$env_file" && { printf '出现未注释的通知变量\n'; return 1; }
    grep -q '/srv/bili-monitor/credentials/cookie.txt' "$env_file" || { printf 'Cookie 示例路径未对齐云端\n'; return 1; }
    grep -q '/srv/bili-monitor/credentials/notifications.json' "$env_file" || { printf '通知示例路径未对齐云端\n'; return 1; }
    listen_count="$(grep -c '^    listen 127\.0\.0\.1:4273;$' "$PACKAGE/render/etc/nginx/conf.d/bili.conf")"
    [[ "$listen_count" == "1" ]] || { printf 'listen 行数 %s\n' "$listen_count"; return 1; }
    grep -qE '^[[:space:]]*listen .*4173' "$PACKAGE/render/etc/nginx/conf.d/bili.conf" && {
        printf '仍存在 4173 listen\n'
        return 1
    }
    grep -q 'proxy_pass http://127.0.0.1:8000;' "$PACKAGE/render/etc/nginx/snippets/bili-locations.conf" || {
        printf 'proxy_pass 不是 8000\n'
        return 1
    }
    cmp -s "$PACKAGE/render/etc/systemd/system/bili-monitor.service" "$PACKAGE/deploy/bili-monitor.service" || {
        printf 'unit 与模板不逐字节相同\n'
        return 1
    }
    cmp -s "$PACKAGE/render/etc/nginx/snippets/bili-locations.conf" "$PACKAGE/deploy/nginx-locations.conf" || {
        printf 'snippet 与模板不逐字节相同\n'
        return 1
    }
}

# ── wizard --check（真实预检，只读；依赖本机状态） ─────────────────────────
case_wizard_check_readonly() {
    local before after
    before="$(ls -la /var/lib 2>/dev/null | grep -c bili-local-deployment || true)"
    bash "$WIZARD" --check --commit e58271c6e093b436bfbfc9bb45d3d7a7d349be19 --package "$PACKAGE" >"$WORK/check.log" 2>&1 || {
        printf '--check 退出非 0：\n'
        cat "$WORK/check.log"
        return 1
    }
    grep -q '只读预检通过' "$WORK/check.log" || { printf '--check 未报告通过\n'; return 1; }
    grep -qE '未写文件|不调用 sudo' "$WORK/check.log" || { printf '--check 未声明只读\n'; return 1; }
    after="$(ls -la /var/lib 2>/dev/null | grep -c bili-local-deployment || true)"
    [[ "$before" == "$after" ]] || { printf '--check 创建了 /var/lib 状态目录\n'; return 1; }
}

case_wizard_check_rejects_tampered_package() {
    local bad="$WORK/badpkg"
    cp -a "$PACKAGE" "$bad"
    printf 'tampered\n' >>"$bad/render/etc/systemd/system/bili-monitor.service"
    bash "$WIZARD" --check --commit e58271c6e093b436bfbfc9bb45d3d7a7d349be19 --package "$bad" >"$WORK/bad.log" 2>&1 && {
        printf '被改动的安装包未被拒绝\n'
        return 1
    }
    grep -q 'MANIFEST 校验失败' "$WORK/bad.log" || { printf '缺少 MANIFEST 失败提示\n'; cat "$WORK/bad.log"; return 1; }
}

case_wizard_check_rejects_world_writable_package() {
    local wide="$WORK/widened"
    cp -a "$PACKAGE" "$wide"
    chmod 0777 "$wide"
    bash "$WIZARD" --check --commit e58271c6e093b436bfbfc9bb45d3d7a7d349be19 --package "$wide" >"$WORK/wide.log" 2>&1 && {
        chmod 0755 "$wide"
        printf 'other 可写的安装包未被拒绝\n'
        return 1
    }
    chmod 0755 "$wide"
    grep -qE 'group/other 可写|对 other 可写' "$WORK/wide.log" || { printf '缺少可写拒绝提示\n'; cat "$WORK/wide.log"; return 1; }
}

# ── 状态与所有权矩阵 ───────────────────────────────────────────────────────
case_state_roundtrip() {
    sandbox_init
    state_load
    [[ -z "$(state_get account:bili)" ]] || { printf '初始状态非空\n'; return 1; }
    state_set "account:bili" "1234"
    state_set "file:/x/y" "abc"
    state_save || { printf 'state_save 失败\n'; return 1; }
    [[ -f "$STATE_FILE" ]] || { printf '状态文件不存在\n'; return 1; }
    STATE=()
    state_load
    [[ "$(state_get account:bili)" == "1234" ]] || { printf 'account 回读失败\n'; return 1; }
    [[ "$(state_get file:/x/y)" == "abc" ]] || { printf 'file 回读失败\n'; return 1; }
}

case_path_owner_matrix() {
    sandbox_init
    local dir="$SB/probe" file="$SB/probe/file"
    [[ "$(path_owner "$dir")" == "absent" ]] || { printf 'absent 判定错误\n'; return 1; }
    mkdir -p "$dir"
    state_set "dir:$dir" "test:test:755"
    [[ "$(path_owner "$dir")" == "ours" ]] || { printf '记录目录应为 ours\n'; return 1; }
    : >"$file"
    [[ "$(path_owner "$file")" == "unknown" ]] || { printf '未记录文件应为 unknown\n'; return 1; }
    printf 'v1\n' >"$file"
    state_set "file:$file" "$(sha_of "$file")"
    [[ "$(path_owner "$file")" == "ours" ]] || { printf '哈希一致应为 ours\n'; return 1; }
    printf 'v2\n' >"$file"
    [[ "$(path_owner "$file")" == "modified" ]] || { printf '哈希漂移应为 modified\n'; return 1; }
    chmod 000 "$file"
    [[ "$(path_owner "$file")" == "ours" ]] || { printf '不可读的已记录文件应放行给 sudo 复核\n'; return 1; }
    chmod 600 "$file"
}

case_require_managed_refusals() {
    sandbox_init
    local f="$SB/etc/unknown.conf"
    mkdir -p "$(dirname "$f")"
    printf 'preexisting\n' >"$f"
    if (require_managed "$f" "目标") >"$LOG" 2>&1; then
        printf '未识别文件未被拒绝\n'
        return 1
    fi
    grep -q '未识别' "$LOG" || { printf '缺少未识别提示\n'; return 1; }
    state_set "file:$f" "$(sha_of "$f")"
    require_managed "$f" "目标" || { printf '已记录文件被误拒\n'; return 1; }
    printf 'drift\n' >"$f"
    if (require_managed "$f" "目标") >"$LOG" 2>&1; then
        printf '被改动的文件未被拒绝\n'
        return 1
    fi
    grep -q '已被修改' "$LOG" || { printf '缺少修改提示\n'; return 1; }
    grep -qF '不手改 state' "$LOG" || { printf 'modified 分支缺少“不手改 state”\n'; cat "$LOG"; return 1; }
    grep -qF 'docs/deployment/README.md 人工核查来源' "$LOG" ||
        { printf 'modified 分支缺少主指南指针\n'; cat "$LOG"; return 1; }
    if grep -qE '移走/改名' "$LOG"; then
        printf 'modified 分支仍在推荐移走/改名\n'
        cat "$LOG"
        return 1
    fi
    return 0
}

case_install_managed_gate() {
    sandbox_init
    local pkg="$SB/pkg" src="$SB/pkg/render/x.conf" dst="$SB/etc/x.conf"
    mkdir -p "$(dirname "$src")" "$(dirname "$dst")"
    printf 'v1\n' >"$src"
    PACKAGE_DIR="$pkg"
    install_managed "render/x.conf" "$dst" 0644 || { printf '首次安装失败\n'; return 1; }
    [[ -f "$dst" && "$(sha_of "$dst")" == "$(sha_of "$src")" ]] || { printf '安装内容不符\n'; return 1; }
    [[ -n "$(state_get "file:$dst")" ]] || { printf '未记录 SHA\n'; return 1; }
    install_managed "render/x.conf" "$dst" 0644 >"$LOG" 2>&1
    grep -q '已是最新' "$LOG" || { printf '重跑未识别为最新\n'; return 1; }
    printf 'later real edit\n' >"$dst"
    if (install_managed "render/x.conf" "$dst" 0644) >"$LOG" 2>&1; then
        printf '用户改动后的文件被覆盖\n'
        return 1
    fi
    grep -q '拒绝覆盖' "$LOG" || { printf '缺少拒绝覆盖提示\n'; return 1; }
}

# ── nginx 主配置处理 ───────────────────────────────────────────────────────
nginx_fixture() { # $1: 是否含 conf.d include; $2: 是否含 mime.types
    cat >"$NGINX_MAIN" <<EOF
worker_processes auto;
events { worker_connections 1024; }
http {
    include       mime.types;
    default_type  application/octet-stream;
$([[ "$1" == "include" ]] && printf '    include %s/conf.d/*.conf;\n' "$NGINX_ROOT")
    server { listen 127.0.0.1:9999; }
}
EOF
    if [[ "$2" == "nomime" ]]; then
        sed -i '/mime\.types/d' "$NGINX_MAIN"
    fi
}

# ── 发行包默认 nginx.conf（B4） ──────────────────────────────────────────────
# F1：真实 Arch 官方 1.30.6-1 的包默认 nginx.conf 已入库，测试只用脚本相对路径（不依赖 /tmp）。
# 来源与 sha 记录见 tests/fixtures/README.md；可用 NGINX_STOCK_FIXTURE 覆盖，但 sha 断言不变。
TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_NGINX_FIXTURE="$TESTS_DIR/fixtures/nginx-1.30.6-1.conf"
NGINX_STOCK_FIXTURE="${NGINX_STOCK_FIXTURE:-$DEFAULT_NGINX_FIXTURE}"

# nginx_pkg_fixture：在沙箱里搭“本次新装 + pacman 拥有 + 缓存包原始配置”的可信环境。
# 使用真实发行包默认配置 fixture（2717B / sha256 7cd7c15a…），并用 bsdtar 造同版本缓存包。
nginx_pkg_fixture() {
    [[ -f "$NGINX_STOCK_FIXTURE" ]] ||
        { printf '缺少真实发行包默认配置 fixture：%s\n' "$NGINX_STOCK_FIXTURE"; return 1; }
    mkdir -p "$(dirname "$NGINX_MAIN")" "$PACMAN_PKG_CACHE" "$BACKUP_STATE_DIR" \
        "$SB/pkgroot/etc/nginx"
    cp "$NGINX_STOCK_FIXTURE" "$NGINX_MAIN"
    chmod 0644 "$NGINX_MAIN"
    printf '# mime.types (mailcap fixture)\n' >"$NGINX_ROOT/mime.types"
    cp "$NGINX_STOCK_FIXTURE" "$SB/pkgroot/etc/nginx/nginx.conf"
    (
        cd "$SB/pkgroot" || exit 1
        bsdtar -cf "$PACMAN_PKG_CACHE/nginx-$FAKE_NGINX_PKGVER-x86_64.pkg.tar.zst" etc/nginx/nginx.conf
    ) || { printf '构造缓存包失败（bsdtar）\n'; return 1; }
    : >"$NGINX_INSTALLED_FLAG"
    printf '%s\n' "$NGINX_MAIN" >"$PACMAN_OWNED"
    state_set "pkg:nginx-fresh-install" "$FAKE_NGINX_PKGVER"
}

case_fixture_sha_matches() {
    [[ -f "$DEFAULT_NGINX_FIXTURE" ]] ||
        { printf '入库 fixture 缺失：%s\n' "$DEFAULT_NGINX_FIXTURE"; return 1; }
    [[ "$(stat -c %s "$DEFAULT_NGINX_FIXTURE")" == "2717" ]] ||
        { printf 'fixture 大小不是 2717 字节\n'; return 1; }
    [[ "$(sha256sum -- "$DEFAULT_NGINX_FIXTURE" | cut -d' ' -f1)" == "7cd7c15a98e2124a5cbf46e9483072d03e99f647c64d2ae0522c2ff43e1a49b9" ]] ||
        { printf 'fixture sha256 不是钉住值\n'; return 1; }
    grep -qE '^[[:space:]]*listen[[:space:]]+80;' "$DEFAULT_NGINX_FIXTURE" ||
        { printf 'fixture 不含激活的 listen 80\n'; return 1; }
    grep -qE '^[[:space:]]*include[[:space:]]+mime\.types;' "$DEFAULT_NGINX_FIXTURE" ||
        { printf 'fixture 不含 mime.types include\n'; return 1; }
}

case_nginx_state_persist_and_cold_reload() {
    sandbox_init
    nginx_pkg_fixture || return 1
    state_save || return 1
    FAKE_NGINX_RC=0 ensure_nginx_main >"$LOG" 2>&1 || { cat "$LOG"; return 1; }
    # 成功登记必须已落盘到 state 文件（不是只在内存 array）
    [[ -n "$(awk -F'\t' -v k="file:$NGINX_MAIN" '$1==k{print $2}' "$STATE_FILE")" ]] ||
        { printf '成功登记未落盘到 state 文件\n'; cat "$STATE_FILE"; return 1; }
    [[ -n "$(awk -F'\t' -v k="backup:$NGINX_MAIN" '$1==k{print $2}' "$STATE_FILE")" ]] ||
        { printf '备份登记未落盘\n'; return 1; }
    # 冷重载：清空内存（模拟新进程），从 state 文件恢复后续跑
    local before
    before="$(sha_of "$NGINX_MAIN")"
    STATE=()
    state_load
    FAKE_NGINX_RC=0 ensure_nginx_main >"$LOG" 2>&1 || { printf '冷重载后续跑被拒\n'; cat "$LOG"; return 1; }
    grep -q '登记过的受管版本' "$LOG" || { printf '冷重载未识别受管版本\n'; return 1; }
    [[ "$(sha_of "$NGINX_MAIN")" == "$before" ]] || { printf '冷重载续跑改写了 main\n'; return 1; }
    [[ "$(find "$BACKUP_STATE_DIR" -name 'nginx.conf.*.orig' | wc -l)" == "1" ]] ||
        { printf '冷重载生成了额外备份\n'; return 1; }
}

case_nginx_interrupted_state_recovery() {
    sandbox_init
    nginx_pkg_fixture || return 1
    state_save || return 1   # 只落了 pkg:nginx-fresh-install，模拟“写盘成功后、登记前中断”
    local tmp before
    tmp="$(mktemp /var/tmp/bili-expect.XXXXXX)"
    write_managed_nginx_main "$tmp" "modules"
    cp "$tmp" "$NGINX_MAIN"
    rm -f "$tmp"
    [[ -z "$(state_get "file:$NGINX_MAIN")" ]] || { printf '前提不成立：不应已登记\n'; return 1; }
    before="$(sha_of "$NGINX_MAIN")"
    STATE=()
    state_load                     # 冷重载：内存里没有 file: 记录
    FAKE_NGINX_RC=0 ensure_nginx_main >"$LOG" 2>&1 || { printf '中断恢复失败\n'; cat "$LOG"; return 1; }
    grep -q '只补登记' "$LOG" || { printf '未走补登记恢复\n'; cat "$LOG"; return 1; }
    [[ "$(sha_of "$NGINX_MAIN")" == "$before" ]] || { printf '恢复过程改写了系统文件\n'; return 1; }
    [[ "$(awk -F'\t' -v k="file:$NGINX_MAIN" '$1==k{print $2}' "$STATE_FILE")" == "$before" ]] ||
        { printf '未把真实 sha 补登记到 state 文件\n'; cat "$STATE_FILE"; return 1; }
    [[ "$(find "$BACKUP_STATE_DIR" -name 'nginx.conf.*.orig' | wc -l)" == "0" ]] ||
        { printf '补登记过程仍写盘/建备份\n'; return 1; }
    # 补登记后冷重载再跑：走受管分支
    STATE=()
    state_load
    FAKE_NGINX_RC=0 ensure_nginx_main >"$LOG" 2>&1 || { printf '补登记后仍不可续跑\n'; cat "$LOG"; return 1; }
    grep -q '登记过的受管版本' "$LOG" || { printf '补登记后未识别受管版本\n'; return 1; }
}

case_nginx_normalize_fresh_install() {
    sandbox_init
    nginx_pkg_fixture || return 1
    local orig_sha backup body before
    orig_sha="$(sha_of "$NGINX_MAIN")"
    [[ "$orig_sha" == "7cd7c15a98e2124a5cbf46e9483072d03e99f647c64d2ae0522c2ff43e1a49b9" ]] ||
        { printf 'fixture 不是预期的发行包默认配置\n'; return 1; }
    FAKE_NGINX_RC=0 ensure_nginx_main >"$LOG" 2>&1 || { printf '规范化失败\n'; cat "$LOG"; return 1; }

    backup="$(state_get "backup:$NGINX_MAIN")"
    [[ -f "$backup" ]] || { printf '未创建/登记备份\n'; return 1; }
    [[ "$(sha_of "$backup")" == "$orig_sha" ]] || { printf '备份内容不是原始配置\n'; return 1; }
    [[ "$(stat -c %a "$backup")" == "600" ]] || { printf '备份权限不是 0600\n'; return 1; }
    case "$backup" in
        "$BACKUP_STATE_DIR"/*) : ;;
        *) printf '备份不在 root 私有目录：%s\n' "$backup"; return 1 ;;
    esac

    body="$(cat "$NGINX_MAIN")"
    if grep -qE '^[[:space:]]*server[[:space:]]*\{' <<<"$body"; then
        printf '受管 main 仍含 server 块\n'
        return 1
    fi
    if grep -qE '^[[:space:]]*listen[[:space:]]' <<<"$body"; then
        printf '受管 main 仍含 listen\n'
        return 1
    fi
    grep -qF "include $NGINX_ROOT/mime.types;" <<<"$body" || { printf '缺 mime.types include\n'; return 1; }
    grep -qF "include $NGINX_ROOT/conf.d/*.conf;" <<<"$body" || { printf '缺 conf.d include\n'; return 1; }
    grep -qF 'include modules.d/*.conf;' <<<"$body" || { printf '未保留原始配置的 modules.d include\n'; return 1; }
    [[ -n "$(state_get "file:$NGINX_MAIN")" ]] || { printf '未登记受管 main\n'; return 1; }

    # 重跑：受管 main 被识别为自家版本，不重复备份、不改写
    before="$(sha_of "$NGINX_MAIN")"
    FAKE_NGINX_RC=0 ensure_nginx_main >"$LOG" 2>&1 || { printf '受管 main 续跑被拒\n'; cat "$LOG"; return 1; }
    grep -q '登记过的受管版本' "$LOG" || { printf '续跑未识别受管版本\n'; return 1; }
    [[ "$(sha_of "$NGINX_MAIN")" == "$before" ]] || { printf '续跑改动了受管 main\n'; return 1; }
    [[ "$(find "$BACKUP_STATE_DIR" -name 'nginx.conf.*.orig' | wc -l)" == "1" ]] ||
        { printf '续跑生成了额外备份\n'; return 1; }
}

case_nginx_legacy_managed_main_refused() {
    sandbox_init
    nginx_pkg_fixture || return 1
    # 模拟旧版向导：只往默认配置里插了 include 就把文件登记成“受管”
    mkdir -p "$(dirname "$NGINX_CONF")"
    local line
    line="$(grep -n '^}' "$NGINX_MAIN" | tail -n1 | cut -d: -f1)"
    sed -i "${line}i\\    include $NGINX_ROOT/conf.d/*.conf;" "$NGINX_MAIN"
    state_set "file:$NGINX_MAIN" "$(sha_of "$NGINX_MAIN")"
    if (ensure_nginx_main) >"$LOG" 2>&1; then
        printf '旧版受管 main（仍带 listen 80）被当作安全版本续跑\n'
        return 1
    fi
    grep -q '旧版向导留下的默认站点' "$LOG" || { printf '缺少迁移闸门提示\n'; cat "$LOG"; return 1; }
}

case_error_advice_mismatch_safe() {
    sandbox_init
    nginx_pkg_fixture || return 1
    printf '\n# 人工改动\n' >>"$NGINX_MAIN"
    local adv="$WORK/advice.log" bad
    if (ensure_nginx_main) >"$adv" 2>&1; then
        printf '被改动的配置未被拒绝\n'
        return 1
    fi
    grep -qF '保留现文件' "$adv" || { printf '缺少“保留现文件/备份”\n'; cat "$adv"; return 1; }
    grep -qF '不手改 state' "$adv" || { printf '缺少“不手改 state”\n'; cat "$adv"; return 1; }
    grep -qF 'docs/deployment/README.md' "$adv" || { printf '缺少指向唯一主指南\n'; return 1; }
    for bad in 'pacman -S nginx' '移走后重跑' '把该文件移走' '登记 file:'; do
        if grep -qF -- "$bad" "$adv"; then
            printf '错误提示仍在推荐不安全出路：%s\n' "$bad"
            cat "$adv"
            return 1
        fi
    done
}

case_error_advice_legacy_safe() {
    sandbox_init
    nginx_pkg_fixture || return 1
    mkdir -p "$(dirname "$NGINX_CONF")"
    local line adv="$WORK/advice-legacy.log" bad
    line="$(grep -n '^}' "$NGINX_MAIN" | tail -n1 | cut -d: -f1)"
    sed -i "${line}i\\    include $NGINX_ROOT/conf.d/*.conf;" "$NGINX_MAIN"
    state_set "file:$NGINX_MAIN" "$(sha_of "$NGINX_MAIN")"
    if (ensure_nginx_main) >"$adv" 2>&1; then
        printf '旧版受管 main 未拒绝\n'
        return 1
    fi
    grep -qF '保留现文件' "$adv" || { printf '缺少“保留现文件/备份”\n'; cat "$adv"; return 1; }
    grep -qF '不手改 state' "$adv" || { printf '缺少“不手改 state”\n'; cat "$adv"; return 1; }
    for bad in 'pacman -S nginx' '移走该默认 server' '把默认 server 移走' '登记 file:' '移除 file:'; do
        if grep -qF -- "$bad" "$adv"; then
            printf '错误提示仍在推荐不安全出路：%s\n' "$bad"
            cat "$adv"
            return 1
        fi
    done
}

case_nginx_modified_config_fail_closed() {
    sandbox_init
    nginx_pkg_fixture || return 1
    printf '\n# 人工改动\n' >>"$NGINX_MAIN"
    local before
    before="$(sha_of "$NGINX_MAIN")"
    if (ensure_nginx_main) >"$LOG" 2>&1; then
        printf '被人工改动的配置未被拒绝\n'
        return 1
    fi
    grep -qE '既不是包原始配置|逐字节不同' "$LOG" || { printf '缺少“非原始且非受管”拒绝提示\n'; cat "$LOG"; return 1; }
    [[ "$(sha_of "$NGINX_MAIN")" == "$before" ]] || { printf '失败时仍改写了系统文件\n'; return 1; }
    [[ -z "$(state_get "file:$NGINX_MAIN")" ]] || { printf '失败时仍登记了受管 main\n'; return 1; }
}

case_nginx_missing_cache_fail_closed() {
    sandbox_init
    nginx_pkg_fixture || return 1
    rm -f "$PACMAN_PKG_CACHE"/nginx-*.pkg.tar.*
    local before
    before="$(sha_of "$NGINX_MAIN")"
    if (ensure_nginx_main) >"$LOG" 2>&1; then
        printf '缺可信缓存时未被拒绝\n'
        return 1
    fi
    grep -q '没有 nginx' "$LOG" || { printf '缺少缓存提示不符\n'; cat "$LOG"; return 1; }
    [[ "$(sha_of "$NGINX_MAIN")" == "$before" ]] || { printf '缺缓存时仍改写了系统文件\n'; return 1; }
}

case_nginx_not_fresh_fail_closed() {
    sandbox_init
    nginx_pkg_fixture || return 1
    unset 'STATE[pkg:nginx-fresh-install]'
    local before
    before="$(sha_of "$NGINX_MAIN")"
    if (ensure_nginx_main) >"$LOG" 2>&1; then
        printf '非本次新装的 nginx 未被拒绝\n'
        return 1
    fi
    grep -q '不是本次运行新装' "$LOG" || { printf '缺少来源提示\n'; cat "$LOG"; return 1; }
    grep -qF '不手改 state' "$LOG" || { printf '非新装分支缺少“不手改 state”\n'; cat "$LOG"; return 1; }
    grep -qF 'docs/deployment/README.md 人工核查来源' "$LOG" ||
        { printf '非新装分支缺少主指南指针\n'; cat "$LOG"; return 1; }
    grep -qE '移除默认 server|移走该默认 server' "$LOG" &&
        { printf '非新装分支仍在推荐移除/移走默认 server\n'; cat "$LOG"; return 1; }
    [[ "$(sha_of "$NGINX_MAIN")" == "$before" ]] || { printf '非新装时仍改写了系统文件\n'; return 1; }
}

case_nginx_multiple_cache_fail_closed() {
    sandbox_init
    nginx_pkg_fixture || return 1
    cp "$PACMAN_PKG_CACHE"/nginx-*.pkg.tar.zst "$PACMAN_PKG_CACHE/nginx-$FAKE_NGINX_PKGVER-x86_64_v4.pkg.tar.zst"
    if (ensure_nginx_main) >"$LOG" 2>&1; then
        printf '多个缓存候选时未被拒绝\n'
        return 1
    fi
    grep -q '多个 nginx' "$LOG" || { printf '缺少多候选提示\n'; cat "$LOG"; return 1; }
}

case_nginx_rollback_on_failed_test() {
    sandbox_init
    nginx_pkg_fixture || return 1
    local before mode
    before="$(sha_of "$NGINX_MAIN")"
    mode="$(stat -c %a "$NGINX_MAIN")"
    if (FAKE_NGINX_RC=1 ensure_nginx_main) >"$LOG" 2>&1; then
        printf 'nginx -t 失败时未中止\n'
        return 1
    fi
    [[ "$(sha_of "$NGINX_MAIN")" == "$before" ]] || { printf '未按原内容恢复\n'; return 1; }
    [[ "$(stat -c %a "$NGINX_MAIN")" == "$mode" ]] || { printf '未按原 mode 恢复\n'; return 1; }
    grep -q '已从' "$LOG" || { printf '缺少回滚提示\n'; cat "$LOG"; return 1; }
    [[ -z "$(state_get "file:$NGINX_MAIN")" ]] || { printf '回滚后仍登记了受管 main\n'; return 1; }
}

case_nginx_requires_mime_types() {
    sandbox_init
    nginx_pkg_fixture || return 1
    rm -f "$NGINX_ROOT/mime.types"
    local before
    before="$(sha_of "$NGINX_MAIN")"
    if (ensure_nginx_main) >"$LOG" 2>&1; then
        printf '缺 mime.types 未被拒绝\n'
        return 1
    fi
    grep -q 'mime.types' "$LOG" || { printf '缺少 mime.types 提示\n'; return 1; }
    [[ "$(sha_of "$NGINX_MAIN")" == "$before" ]] || { printf '缺 mime.types 时仍改写\n'; return 1; }
}

case_static_listen_80_hardblock() {
    sandbox_init
    nginx_pkg_fixture || return 1
    local hits
    hits="$(list_static_listen_80)"
    printf '%s\n' "$hits" | grep -q "listen       80;" || { printf '未从真实默认配置识别 80\n'; return 1; }
    # 本项目自己的 bili.conf 即便写 80 也不应被计入（它由受管模板锚定，正常不会有）
    mkdir -p "$(dirname "$NGINX_CONF")"
    printf 'server {\n    listen 80;\n}\n' >"$NGINX_CONF"
    hits="$(list_static_listen_80)"
    printf '%s\n' "$hits" | grep -q 'bili.conf' && { printf '把自己的站点计入 80 残留\n'; return 1; }
    rm -f "$NGINX_CONF"
}

case_hard_block_effective_80() {
    sandbox_init
    local dump="$SB/effective.conf"
    export FAKE_NGINX_DUMP="$dump"
    printf 'events {}\nhttp {\n    server {\n        listen       80;\n    }\n}\n' >"$dump"
    if (FAKE_NGINX_RC=0 assert_no_listen_80_effective) >"$LOG" 2>&1; then
        printf '有效配置含 80 未被硬阻断\n'
        return 1
    fi
    grep -q '拒绝 enable/start' "$LOG" || { printf '缺少硬阻断提示\n'; cat "$LOG"; return 1; }

    printf 'events {}\nhttp {\n    include %s/conf.d/*.conf;\n}\n' "$NGINX_ROOT" >"$dump"
    FAKE_NGINX_RC=0 assert_no_listen_80_effective >"$LOG" 2>&1 ||
        { printf '无 80 的有效配置被误拒\n'; cat "$LOG"; return 1; }

    # 只监听 127.0.0.1:80 也算占 80（本项目目标是完全不占 80）
    printf 'events {}\nhttp {\n    server {\n        listen 127.0.0.1:80;\n    }\n}\n' >"$dump"
    if (FAKE_NGINX_RC=0 assert_no_listen_80_effective) >"$LOG" 2>&1; then
        printf '127.0.0.1:80 未被阻断\n'
        return 1
    fi
}

case_preflight_nginx_default_80_hardblock() {
    preflight_fixture || return 1
    mkdir -p "$(dirname "$NGINX_MAIN")" "$NGINX_ROOT"
    cp "$NGINX_STOCK_FIXTURE" "$NGINX_MAIN"
    : >"$NGINX_INSTALLED_FLAG"
    printf '%s\n' "$NGINX_MAIN" >"$PACMAN_OWNED"
    preflight >"$LOG" 2>&1
    ((${#PROBLEMS[@]} > 0)) || { printf '预检未报默认 80 风险\n'; return 1; }
    printf '%s\n' "${PROBLEMS[@]}" | grep -q '80 监听' || { printf '预检问题里没有 80\n'; cat "$LOG"; return 1; }
    printf '%s\n' "${PROBLEMS[@]}" | grep -q '硬阻断' || { printf '提示未说明硬阻断\n'; return 1; }
}

case_preflight_nginx_missing_warns() {
    preflight_fixture || return 1
    mv "$SB/bin/nginx" "$SB/bin/nginx.disabled"   # 模拟“尚未安装 nginx”
    preflight >"$LOG" 2>&1
    mv "$SB/bin/nginx.disabled" "$SB/bin/nginx"
    grep -q '不能证明发行包默认配置安全' "$LOG" || { printf '--check 未提示默认配置风险\n'; cat "$LOG"; return 1; }
    ((${#PROBLEMS[@]} == 0)) || { printf '未安装场景被误判阻塞\n'; printf '%s\n' "${PROBLEMS[@]}"; return 1; }
}


# ── 前端原子发布 ───────────────────────────────────────────────────────────
frontend_fixture() {
    PACKAGE_DIR="$SB/pkg"
    mkdir -p "$PACKAGE_DIR/frontend/dist/assets" "$SITE_ROOT/releases"
    printf '<html>v1</html>\n' >"$PACKAGE_DIR/frontend/dist/index.html"
    printf 'console.log(1)\n' >"$PACKAGE_DIR/frontend/dist/assets/app-abc123.js"
    : >"$PACKAGE_DIR/frontend/dist.sha256"
}

case_publish_frontend_atomic_and_idempotent() {
    sandbox_init
    frontend_fixture
    publish_frontend || { printf '首次发布失败\n'; return 1; }
    local target
    target="$(readlink -f "$SITE_ROOT/current")"
    [[ -d "$target" && -f "$target/index.html" ]] || { printf 'current 未指向发布目录\n'; return 1; }
    [[ "$target" == "$SITE_ROOT/releases/"* ]] || { printf 'current 未指向 releases/\n'; return 1; }
    [[ "$(state_get "symlink:$SITE_ROOT/current")" == "$target" ]] || { printf '未记录软链\n'; return 1; }
    publish_frontend >"$LOG" 2>&1
    grep -q '跳过发布' "$LOG" || { printf '同产物未跳过\n'; return 1; }
}

case_publish_frontend_refuses_drifted_symlink() {
    sandbox_init
    frontend_fixture
    publish_frontend || { printf '首次发布失败\n'; return 1; }
    local target
    target="$(readlink -f "$SITE_ROOT/current")"
    mkdir -p "$SB/elsewhere"
    ln -sfn "$SB/elsewhere" "$SITE_ROOT/current.tmp"
    mv -Tf "$SITE_ROOT/current.tmp" "$SITE_ROOT/current"
    if (publish_frontend) >"$LOG" 2>&1; then
        printf '被改动的 current 未被拒绝\n'
        return 1
    fi
    grep -q '已被改动' "$LOG" || { printf '缺少 current 改动提示\n'; return 1; }
    # 恢复成发布目标，避免后续用例误判（本沙箱独立，可忽略）
    ln -sfn "$target" "$SITE_ROOT/current"
}

# ── 端口检测 ───────────────────────────────────────────────────────────────
case_port_detection() {
    sandbox_init
    local port=18731
    port_busy "$port" && { printf '空闲端口被判定占用\n'; return 1; }
    python3 -m http.server --bind 127.0.0.1 "$port" >/dev/null 2>&1 &
    local pid=$!
    local i
    for i in {1..30}; do port_busy "$port" && break; sleep 0.1; done
    local ok=0
    if port_busy "$port"; then ok=1; fi
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    [[ "$ok" == "1" ]] || { printf '占用端口未被检测到\n'; return 1; }
    listen_addrs "$port" >/dev/null
}

# ── preflight 冲突矩阵（伪安装包 + 命令替身，无需 root） ─────────────────────
make_fixture_package() {
    local dir="$1" tree="$WORK/fixture-repo"
    rm -rf "$tree"
    mkdir -p "$tree/deploy"
    printf '[Unit]\nDescription=fixture\n\n[Service]\nExecStart=/bin/true\n' >"$tree/deploy/bili-monitor.service"
    printf '    root /srv/dynamics-viewer/current;\n    location /api/ {\n        proxy_pass http://127.0.0.1:8000;\n    }\n' \
        >"$tree/deploy/nginx-locations.conf"
    printf 'server {\n    listen 127.0.0.1:4173;\n    server_name _;\n    include /etc/nginx/snippets/bili-locations.conf;\n}\n' \
        >"$tree/deploy/nginx-ecs-tunnel.conf"
    (
        cd "$tree" || exit 1
        git init -q -b main .
        git add -A
        git -c user.email=t@example.invalid -c user.name=t commit -qm fixture
    ) || return 1
    local commit short
    commit="$(git -C "$tree" rev-parse HEAD)"
    short="${commit:0:7}"
    mkdir -p "$dir"/{repo,frontend/dist,uv,render/etc/nginx/conf.d,render/etc/nginx/snippets,render/etc/systemd/system,render/etc/bili-monitor}
    git -C "$tree" bundle create "$dir/repo/fixture-$short.bundle" main >/dev/null 2>&1 || return 1
    printf '<html>fixture</html>\n' >"$dir/frontend/dist/index.html"
    printf '#!/bin/sh\nprintf "uv 0.0.0-fixture\\n"\n' >"$dir/uv/uv"
    chmod 0755 "$dir/uv/uv"
    cp "$tree/deploy/bili-monitor.service" "$dir/render/etc/systemd/system/bili-monitor.service"
    cp "$tree/deploy/nginx-locations.conf" "$dir/render/etc/nginx/snippets/bili-locations.conf"
    sed 's|listen 127\.0\.0\.1:4173;|listen 127.0.0.1:4273;|' "$tree/deploy/nginx-ecs-tunnel.conf" \
        >"$dir/render/etc/nginx/conf.d/bili.conf"
    {
        printf '# fixture env\n'
        printf 'BILI_DATABASE_PATH=/srv/bili-monitor/monitor.sqlite\n'
        printf '# BILI_COOKIE_FILE=/srv/bili-monitor/credentials/cookie.txt\n'
        printf 'PYTHONDONTWRITEBYTECODE=1\nPYTHONUNBUFFERED=1\n'
    } >"$dir/render/etc/bili-monitor/env"
    {
        printf 'format=1\ncommit=%s\nshort=%s\ncreated_utc=fixture\n' "$commit" "$short"
        printf 'uv=uv 0.0.0-fixture\n'
        printf 'frontend_dist_index_sha256=%s\n' "$(sha_of "$dir/frontend/dist/index.html")"
    } >"$dir/VERSION"
    find "$dir" -type d -exec chmod 0755 {} +
    find "$dir" -type f -exec chmod 0644 {} +
    chmod 0755 "$dir/uv/uv"
    (cd "$dir" && find . -type f ! -name MANIFEST.sha256 -print0 | LC_ALL=C sort -z |
        xargs -0 sha256sum >MANIFEST.sha256) || return 1
    PACKAGE_DIR="$dir"
    COMMIT="$commit"
    SHORT="$short"
    # 沙箱内把“进入向导时的锚点”指向伪提交（真实运行由受信仓库 HEAD 或 --commit 决定）
    ANCHOR_COMMIT="$commit"
    ANCHOR_SOURCE="synthetic(fixture)"
}

preflight_fixture() {
    sandbox_init
    make_fixture_package "$SB/pkg" || { printf '构造伪安装包失败\n'; return 1; }
    [[ ! -e "$DEPLOY_ROOT" && ! -e "$SITE_ROOT" ]] || { printf '沙箱目标路径不应预先存在\n'; return 1; }
    : >"$SUDO_LOG"
}

case_preflight_clean() {
    preflight_fixture || return 1
    preflight >"$LOG" 2>&1
    [[ -s "$SUDO_LOG" ]] && { printf 'preflight 调用了 sudo：\n'; cat "$SUDO_LOG"; return 1; }
    ((${#PROBLEMS[@]} == 0)) || { printf '干净沙箱被误报：\n'; printf '%s\n' "${PROBLEMS[@]}"; return 1; }
}

case_preflight_unknown_unit_refused() {
    preflight_fixture || return 1
    printf '[Service]\nExecStart=/bin/true\n' >"$UNIT_FILE"
    preflight >"$LOG" 2>&1
    ((${#PROBLEMS[@]} > 0)) || { printf '未识别 unit 未被报错\n'; return 1; }
    printf '%s\n' "${PROBLEMS[@]}" | grep -q '未识别' || { printf '缺少未识别提示\n'; return 1; }
    printf '%s\n' "${PROBLEMS[@]}" | grep -q "bili-monitor.service" || { printf '提示未指向 unit 路径\n'; return 1; }
}

case_preflight_recorded_unit_ok() {
    preflight_fixture || return 1
    printf '[Service]\nExecStart=/bin/true\n' >"$UNIT_FILE"
    state_set "file:$UNIT_FILE" "$(sha_of "$UNIT_FILE")"
    state_save || return 1
    preflight >"$LOG" 2>&1
    ((${#PROBLEMS[@]} == 0)) || { printf '已记录 unit 被误报：\n'; printf '%s\n' "${PROBLEMS[@]}"; return 1; }
}

case_preflight_modified_unit_refused() {
    preflight_fixture || return 1
    printf '[Service]\nExecStart=/bin/true\n' >"$UNIT_FILE"
    state_set "file:$UNIT_FILE" "$(sha_of "$UNIT_FILE")"
    state_save || return 1
    printf '\n# local edit\n' >>"$UNIT_FILE"
    preflight >"$LOG" 2>&1
    printf '%s\n' "${PROBLEMS[@]}" | grep -q '内容与上次安装记录不同' || {
        printf '被修改的 unit 未被报错\n'
        return 1
    }
}

case_preflight_occupied_port_refused() {
    preflight_fixture || return 1
    local port=18732
    python3 -m http.server --bind 127.0.0.1 "$port" >/dev/null 2>&1 &
    local pid=$! i
    for i in {1..30}; do port_busy "$port" && break; sleep 0.1; done
    API_PORT="$port"
    preflight >"$LOG" 2>&1
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    printf '%s\n' "${PROBLEMS[@]}" | grep -q "端口 $port 被占用" || {
        printf '占用端口未被报错：\n'
        printf '%s\n' "${PROBLEMS[@]}"
        return 1
    }
}

case_preflight_unknown_uv_refused() {
    preflight_fixture || return 1
    printf '#!/bin/sh\nexit 0\n' >"$UV_SYSTEM"
    chmod 0755 "$UV_SYSTEM"
    preflight >"$LOG" 2>&1
    printf '%s\n' "${PROBLEMS[@]}" | grep -q '未识别' || {
        printf '未知 uv 未被报错\n'
        return 1
    }
}


# ── 首启后重跑矩阵（B2） ────────────────────────────────────────────────────
# 模拟“首轮已跑到第 7 阶段（服务已起、库已由迁移创建、健康检查失败后中断）”的真实文件集与状态。
first_start_fixture() {
    preflight_fixture || return 1
    mkdir -p "$DEPLOY_ROOT"/{app,backup,credentials} "$SITE_ROOT/releases/20260101T000000Z-$SHORT"
    mkdir -p "$(dirname "$CONF_ENV")" "$(dirname "$UNIT_FILE")" \
        "$(dirname "$NGINX_CONF")" "$(dirname "$NGINX_SNIPPET")" "$BACKUP_STATE_DIR"
    chmod 700 "$CRED_DIR"
    cp "$PACKAGE_DIR/render/etc/bili-monitor/env" "$CONF_ENV"
    chmod 600 "$CONF_ENV"
    cp "$PACKAGE_DIR/render/etc/systemd/system/bili-monitor.service" "$UNIT_FILE"
    cp "$PACKAGE_DIR/render/etc/nginx/snippets/bili-locations.conf" "$NGINX_SNIPPET"
    cp "$PACKAGE_DIR/render/etc/nginx/conf.d/bili.conf" "$NGINX_CONF"
    printf 'events {}\nhttp {\n    include mime.types;\n    include %s/conf.d/*.conf;\n}\n' "$NGINX_ROOT" >"$NGINX_MAIN"
    printf '# mime.types fixture\n' >"$NGINX_ROOT/mime.types"
    # 只有 nginx.conf 与 mime.types 由包拥有（真实 pacman -Qo 语义）；本向导自己的 conf/snippet 不属于任何包
    printf '%s\n%s\n' "$NGINX_MAIN" "$NGINX_ROOT/mime.types" >"$PACMAN_OWNED"
    printf 'SQLite format 3\0' >"$DB_PATH"
    : >"$BACKUP_STATE_DIR/nginx.conf.20260101T000000Z.bak"
    ln -sfn "$SITE_ROOT/releases/20260101T000000Z-$SHORT" "$SITE_ROOT/current"
    # 状态键与各阶段写入一致；service 为 start-attempt（健康检查失败后中断的形态）
    for d in "$DEPLOY_ROOT" "$APP_DIR" "$BACKUP_DIR" "$CRED_DIR" "$SITE_ROOT" "$SITE_ROOT/releases" \
        "$NGINX_ROOT/conf.d" "$NGINX_ROOT/snippets"; do
        state_set "dir:$d" "x:x:755"
    done
    local f
    for f in "$CONF_ENV" "$UNIT_FILE" "$NGINX_SNIPPET" "$NGINX_CONF"; do
        state_set "file:$f" "$(sha_of "$f")"
    done
    state_set "symlink:$SITE_ROOT/current" "$SITE_ROOT/releases/20260101T000000Z-$SHORT"
    state_set "db:$DB_PATH" "created-by-first-start:20260101T000000Z"
    state_set "service:$SERVICE" "start-attempt:20260101T000000Z"
    state_set "backup:$NGINX_MAIN" "$BACKUP_STATE_DIR/nginx.conf.20260101T000000Z.bak"
    state_set "pkg:$COMMIT" "$PACKAGE_DIR"
    state_save || return 1
}

case_preflight_after_first_start() {
    first_start_fixture || return 1
    : >"$SUDO_LOG"
    preflight >"$LOG" 2>&1
    [[ -s "$SUDO_LOG" ]] && { printf 'preflight 调用了 sudo：\n'; cat "$SUDO_LOG"; return 1; }
    ((${#PROBLEMS[@]} == 0)) || {
        printf '首启后的真实文件集被误报：\n'
        printf '%s\n' "${PROBLEMS[@]}"
        return 1
    }
    grep -q '首启迁移创建的库' "$LOG" || { printf '未把 DB 识别为自家首启库\n'; cat "$LOG"; return 1; }
    grep -q '由本向导上次创建' "$LOG" || { printf '未把已安装配置识别为自家产物\n'; return 1; }
}

case_preflight_health_failure_rerun() {
    # 首启在健康检查处失败（B1 场景）：db 已登记、service=start-attempt、release/current 已切
    first_start_fixture || return 1
    preflight >"$LOG" 2>&1
    ((${#PROBLEMS[@]} == 0)) || { printf '健康检查失败后的重跑被拒：\n'; printf '%s\n' "${PROBLEMS[@]}"; return 1; }
    # 再跑第二遍仍稳定（不重复登记、不报错）
    PROBLEMS=()
    state_load
    preflight >"$LOG" 2>&1
    ((${#PROBLEMS[@]} == 0)) || { printf '第二次重跑被拒：\n'; printf '%s\n' "${PROBLEMS[@]}"; return 1; }
}

case_preflight_foreign_nginx_file_refused() {
    first_start_fixture || return 1
    printf 'server { listen 127.0.0.1:9999; }\n' >"$NGINX_ROOT/conf.d/foreign.conf"
    preflight >"$LOG" 2>&1
    ((${#PROBLEMS[@]} == 1)) || {
        printf '自有 nginx 文件未被跳过，或外部文件数量不对（%d）：\n' "${#PROBLEMS[@]}"
        printf '%s\n' "${PROBLEMS[@]}"
        return 1
    }
    printf '%s\n' "${PROBLEMS[@]}" | grep -q 'foreign.conf' || { printf '未指向外部文件\n'; return 1; }
    printf '%s\n' "${PROBLEMS[@]}" | grep -q '移走/改名' || { printf '提示未引导“移走/改名”\n'; return 1; }
}

case_preflight_legacy_backup_flagged() {
    first_start_fixture || return 1
    : >"$NGINX_MAIN.bili-local-deployment.20260101T000000Z.bak"
    preflight >"$LOG" 2>&1
    ((${#PROBLEMS[@]} == 1)) || { printf '旧版备份未被精确识别（%d 个问题）\n' "${#PROBLEMS[@]}"; printf '%s\n' "${PROBLEMS[@]}"; return 1; }
    printf '%s\n' "${PROBLEMS[@]}" | grep -q '旧版本' || { printf '未识别为本向导旧版备份\n'; return 1; }
    printf '%s\n' "${PROBLEMS[@]}" | grep -q '移走' || { printf '未提示移走\n'; return 1; }
}

case_preflight_unrecorded_db_refused() {
    first_start_fixture || return 1
    unset "STATE[db:$DB_PATH]"
    state_save || return 1
    preflight >"$LOG" 2>&1
    printf '%s\n' "${PROBLEMS[@]}" | grep -q '已存在未登记数据库' || { printf '未登记 DB 未被拒绝\n'; printf '%s\n' "${PROBLEMS[@]}"; return 1; }
    printf '%s\n' "${PROBLEMS[@]}" | grep -qF '保留数据库与现场' || { printf '提示未要求保留数据库与现场\n'; printf '%s\n' "${PROBLEMS[@]}"; return 1; }
    printf '%s\n' "${PROBLEMS[@]}" | grep -qF '不手改 state' || { printf '提示未要求不手改 state\n'; return 1; }
    printf '%s\n' "${PROBLEMS[@]}" | grep -qF 'docs/deployment/README.md' || { printf '提示未指向唯一主指南\n'; return 1; }
    if printf '%s\n' "${PROBLEMS[@]}" | grep -qE '移走/改名|删除数据库'; then
        printf '提示仍在推荐移走/改名或删除数据库\n'
        return 1
    fi
    return 0
}

# ── 包信任锚（B3） ─────────────────────────────────────────────────────────
case_trust_group_writable_file() {
    preflight_fixture || return 1
    chmod 0664 "$PACKAGE_DIR/render/etc/systemd/system/bili-monitor.service"
    if (verify_package "$PACKAGE_DIR") >"$LOG" 2>&1; then
        printf 'group 可写成员未被拒绝\n'
        return 1
    fi
    grep -q 'group/other 可写' "$LOG" || { printf '缺少 group 可写提示\n'; cat "$LOG"; return 1; }
}

case_trust_nonsticky_world_writable_parent() {
    sandbox_init
    local wide="$SB/wide"
    mkdir -p "$wide"
    make_fixture_package "$wide/pkg" || return 1
    chmod 0777 "$wide"
    if (verify_package "$wide/pkg") >"$LOG" 2>&1; then
        chmod 0755 "$wide"
        printf '非 sticky 的 0777 父目录未被拒绝\n'
        return 1
    fi
    chmod 0755 "$wide"
    grep -q 'group/other 可写' "$LOG" || { printf '缺少父目录可写提示\n'; cat "$LOG"; return 1; }
}

case_trust_symlink_in_package() {
    preflight_fixture || return 1
    ln -s /etc/passwd "$PACKAGE_DIR/render/etc/leak"
    if (verify_package "$PACKAGE_DIR") >"$LOG" 2>&1; then
        printf '包内软链未被拒绝\n'
        return 1
    fi
    grep -q '符号链接' "$LOG" || { printf '缺少软链提示\n'; cat "$LOG"; return 1; }
}

case_trust_version_pin_mismatch() {
    preflight_fixture || return 1
    # 锚点改成另一个 40 位 SHA，伪包 commit 与之不同 ⇒ 必须拒绝安装其他版本
    ANCHOR_COMMIT="0000000000000000000000000000000000000000"
    ANCHOR_SOURCE="synthetic(mismatch)"
    preflight >"$LOG" 2>&1
    printf '%s\n' "${PROBLEMS[@]}" | grep -q '不是进入向导时固定的锚点' || {
        printf '提交与锚点不一致未报错\n'
        printf '%s\n' "${PROBLEMS[@]}"
        return 1
    }
}

case_trust_tampered_unit_with_recomputed_manifest() {
    preflight_fixture || return 1
    # 攻击形态：替换 unit 并把 MANIFEST 一并重算（包内自洽），信任锚必须仍能拒绝
    printf '[Service]\nExecStart=/bin/sh -c "id"\n' >"$PACKAGE_DIR/render/etc/systemd/system/bili-monitor.service"
    (cd "$PACKAGE_DIR" && find . -type f ! -name MANIFEST.sha256 -print0 | LC_ALL=C sort -z |
        xargs -0 sha256sum >MANIFEST.sha256) || return 1
    (verify_package "$PACKAGE_DIR") >"$LOG" 2>&1 || { printf '重算 MANIFEST 后 MANIFEST 校验失败\n'; cat "$LOG"; return 1; }
    PROBLEMS=()
    preflight >"$LOG" 2>&1
    printf '%s\n' "${PROBLEMS[@]}" | grep -q 'render unit 与钉住提交' || {
        printf '被替换的 unit 未被信任锚拒绝\n'
        printf '%s\n' "${PROBLEMS[@]}"
        return 1
    }
}

case_trust_var_tmp_sticky_ancestor_allowed() {
    sandbox_init
    local pkg
    pkg="$(mktemp -d /var/tmp/bili-sticky-test.XXXXXX)"
    make_fixture_package "$pkg" || { rm -rf "$pkg"; return 1; }
    if ! (verify_package "$pkg") >"$LOG" 2>&1; then
        printf 'root 拥有的 sticky 祖先（/var/tmp 1777）被误拒：\n'
        cat "$LOG"
        rm -rf "$pkg"
        return 1
    fi
    rm -rf "$pkg"
}

# ── gzip 探测（B1） ────────────────────────────────────────────────────────
write_gzip_server() {
    cat >"$WORK/gzipsrv.py" <<'PYSERVER'
import gzip, http.server, os, sys
root, port, honor = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "honor"

class H(http.server.BaseHTTPRequestHandler):
    def _serve(self):
        path = os.path.join(root, self.path.lstrip("/"))
        if not os.path.isfile(path):
            self.send_response(404); self.end_headers(); return
        data = open(path, "rb").read()
        enc = honor and "gzip" in self.headers.get("Accept-Encoding", "") and len(data) >= 1024
        body = gzip.compress(data) if enc else data
        self.send_response(200)
        self.send_header("Content-Type", "text/javascript")
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        if enc:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    do_GET = _serve
    do_HEAD = _serve

    def log_message(self, *a):
        pass

http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
PYSERVER
}

start_gzip_server() { # $1 端口 $2 honor|never ；echo PID
    local port="$1" mode="$2" pid i
    python3 "$WORK/gzipsrv.py" "$SITE_ROOT/current" "$port" "$mode" >/dev/null 2>&1 &
    pid=$!
    for i in {1..40}; do
        port_busy "$port" && { printf '%s' "$pid"; return 0; }
        sleep 0.1
    done
    kill "$pid" 2>/dev/null
    return 1
}

gzip_asset_fixture() {
    sandbox_init
    mkdir -p "$SITE_ROOT/releases/r1/assets"
    python3 - "$SITE_ROOT/releases/r1/assets/big.js" <<'PYASSET'
import sys
open(sys.argv[1], "w").write("x" * 4096 + "\n")
PYASSET
    printf 'y\n' >"$SITE_ROOT/releases/r1/assets/small.js"
    ln -sfn "$SITE_ROOT/releases/r1" "$SITE_ROOT/current"
    write_gzip_server
}

case_gzip_probe_negotiated() {
    gzip_asset_fixture
    local port=18741 pid
    pid="$(start_gzip_server "$port" honor)" || { printf '启动 gzip 服务器失败\n'; return 1; }
    PROBLEMS=()
    probe_static_assets "http://127.0.0.1:$port" >"$LOG" 2>&1
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    ((${#PROBLEMS[@]} == 0)) || { printf '协商 gzip 仍被判失败：\n'; printf '%s\n' "${PROBLEMS[@]}"; cat "$LOG"; return 1; }
    grep -q 'big.js' "$LOG" || { printf '未选中 >1024B 的资源\n'; cat "$LOG"; return 1; }
    if grep -q 'small.js' "$LOG"; then
        printf '误用小于 gzip_min_length 的资源\n'
        return 1
    fi
    return 0
}

case_gzip_probe_server_never_gzips() {
    gzip_asset_fixture
    local port=18742 pid
    pid="$(start_gzip_server "$port" never)" || { printf '启动服务器失败\n'; return 1; }
    PROBLEMS=()
    probe_static_assets "http://127.0.0.1:$port" >"$LOG" 2>&1
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    printf '%s\n' "${PROBLEMS[@]}" | grep -q '未 gzip' || { printf '未压缩未被发现\n'; printf '%s\n' "${PROBLEMS[@]}"; return 1; }
}

case_gzip_probe_requires_large_asset() {
    gzip_asset_fixture
    rm -f "$SITE_ROOT/releases/r1/assets/big.js"
    local port=18743 pid
    pid="$(start_gzip_server "$port" honor)" || { printf '启动服务器失败\n'; return 1; }
    PROBLEMS=()
    probe_static_assets "http://127.0.0.1:$port" >"$LOG" 2>&1
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    printf '%s\n' "${PROBLEMS[@]}" | grep -q '没有大于 gzip_min_length' || {
        printf '小资源未被识别为“无法验证压缩”\n'
        printf '%s\n' "${PROBLEMS[@]}"
        return 1
    }
}


# ── 锚点来源与稳定性（受信 HEAD / --commit） ────────────────────────────────
make_dev_repo() {  # 造一个“已提交、main==HEAD、含运维脚本”的受信开发仓库，echo HEAD
    local repo="$SB/devrepo"
    rm -rf "$repo"
    mkdir -p "$repo/scripts"
    cp "$WIZARD" "$repo/scripts/setup-local-deployment.sh"
    cp "$PREPARE" "$repo/scripts/prepare-local-deployment-package.sh"
    (
        cd "$repo" || exit 1
        git init -q -b main .
        git add -A
        git -c user.email=t@example.invalid -c user.name=t commit -qm "ops scripts"
    ) || return 1
    SCRIPT_PATH="$repo/scripts/setup-local-deployment.sh"
    SCRIPT_DIR="$repo/scripts"
    DEV_REPO=""
    CLI_COMMIT=""
    printf '%s' "$(git -C "$repo" rev-parse HEAD)"
}

case_anchor_from_repo_head() {
    sandbox_init
    local head
    # 注意：不能用命令替换调用（否则 SCRIPT_DIR/DEV_REPO 的赋值丢在子 shell 里）
    make_dev_repo >/dev/null || return 1
    head="$(git -C "$SB/devrepo" rev-parse HEAD)"
    resolve_anchor >"$LOG" 2>&1 || { printf 'repo-head 解析失败\n'; cat "$LOG"; return 1; }
    [[ "$ANCHOR_COMMIT" == "$head" ]] || { printf '锚点 != HEAD（%s vs %s）\n' "$ANCHOR_COMMIT" "$head"; return 1; }
    [[ "$ANCHOR_SOURCE" == repo-head* ]] || { printf '锚点来源不是 repo-head\n'; return 1; }
    [[ "$(default_package_dir)" == "/var/tmp/bili-local-deployment/${head:0:7}" ]] || {
        printf '默认包路径未按锚点短 SHA 生成：%s\n' "$(default_package_dir)"
        return 1
    }
}

case_anchor_rejects_uncommitted_script() {
    sandbox_init
    make_dev_repo >/dev/null || return 1
    printf '\n# local edit\n' >>"$SCRIPT_PATH"
    if (resolve_anchor) >"$LOG" 2>&1; then printf '未提交的脚本未被拒绝\n'; return 1; fi
    grep -q '与受信 HEAD 中的版本不一致' "$LOG" || { printf '缺少脚本不一致提示\n'; cat "$LOG"; return 1; }
}

case_anchor_rejects_head_not_main() {
    sandbox_init
    make_dev_repo >/dev/null || return 1
    (
        cd "$SB/devrepo" || exit 1
        git checkout -q -b dev
        printf 'x\n' >extra
        git add extra
        git -c user.email=t@example.invalid -c user.name=t commit -qm dev
    ) || return 1
    if (resolve_anchor) >"$LOG" 2>&1; then printf 'HEAD 不在 main 未被拒绝\n'; return 1; fi
    grep -q '不等于 main' "$LOG" || { printf '缺少 main 提示\n'; cat "$LOG"; return 1; }
}

case_anchor_stability() {
    sandbox_init
    make_dev_repo >/dev/null || return 1
    resolve_anchor >/dev/null || return 1
    COMMIT="$ANCHOR_COMMIT"
    assert_anchor_stable || { printf '稳定锚点被误判漂移\n'; return 1; }
    (
        cd "$SB/devrepo" || exit 1
        printf 'y\n' >next
        git add next
        git -c user.email=t@example.invalid -c user.name=t commit -qm next
    ) || return 1
    if (assert_anchor_stable) >"$LOG" 2>&1; then printf '源 HEAD 变动未被拒绝\n'; return 1; fi
    grep -q 'HEAD 在向导运行期间变了' "$LOG" || { printf '缺少 HEAD 漂移提示\n'; cat "$LOG"; return 1; }
}

case_anchor_explicit_commit_ignores_head_drift() {
    sandbox_init
    local head
    head="$(make_dev_repo)" || return 1
    CLI_COMMIT="$head"
    resolve_anchor >/dev/null || return 1
    [[ "$ANCHOR_SOURCE" == operator* ]] || { printf '显式锚点来源标记错误\n'; return 1; }
    COMMIT="$head"
    (
        cd "$SB/devrepo" || exit 1
        printf 'z\n' >next2
        git add next2
        git -c user.email=t@example.invalid -c user.name=t commit -qm next2
    ) || return 1
    assert_anchor_stable || { printf '显式锚点被 HEAD 漂移误伤\n'; return 1; }
}

case_anchor_rejects_bad_cli_commit() {
    sandbox_init
    CLI_COMMIT="e58271c"
    if (resolve_anchor) >"$LOG" 2>&1; then printf '短 SHA 未被拒绝\n'; return 1; fi
    grep -q '完整 40 位' "$LOG" || { printf '缺少完整 SHA 提示\n'; cat "$LOG"; return 1; }
}


# ── 执行 ──────────────────────────────────────────────────────────────────
case_run "静态守卫：无 sudo -n/NOPASSWD/-Syu/--overwrite/apt/sites-enabled 等" case_static_guards
case_run "wizard library 前缀与 template 逐字节一致" case_library_prefix_identical
case_run "两个脚本 bash -n 通过" case_bash_syntax
case_run "安装包 MANIFEST/VERSION/uv 可执行" case_package_manifest
case_run "安装包仅含生产 dist（无 dist-mock/.venv/node_modules/库/cookie）" case_package_is_production_only
case_run "渲染文件：env 有效行、4273 listen、模板逐字节" case_render_files
case_run "wizard --check 只读通过" case_wizard_check_readonly
case_run "wizard --check 拒绝被篡改安装包" case_wizard_check_rejects_tampered_package
case_run "wizard --check 拒绝 other 可写安装包" case_wizard_check_rejects_world_writable_package
case_run "锚点：默认取受信仓库 main HEAD，包路径用锚点短 SHA" case_anchor_from_repo_head
case_run "锚点：脚本与受信 HEAD 不一致时拒绝" case_anchor_rejects_uncommitted_script
case_run "锚点：HEAD 不在 main 时拒绝" case_anchor_rejects_head_not_main
case_run "锚点：向导运行期间源 HEAD 变动时拒绝 root 写入" case_anchor_stability
case_run "锚点：--commit 显式锚点不受源 HEAD 漂移影响" case_anchor_explicit_commit_ignores_head_drift
case_run "锚点：--commit 非完整 SHA 拒绝" case_anchor_rejects_bad_cli_commit
case_run "state 保存/回读" case_state_roundtrip
case_run "path_owner absent/ours/modified/不可读 矩阵" case_path_owner_matrix
case_run "require_managed 拒绝未识别与被改动文件" case_require_managed_refusals
case_run "install_managed 幂等且拒绝覆盖用户改动" case_install_managed_gate
case_run "F1：入库 fixture 为真实 Arch 官方 1.30.6-1（2717B/sha 钉死）" case_fixture_sha_matches
case_run "错误提示：被改配置 fail-closed 只给固定安全建议（不推手改 state/不移走/pacman）" case_error_advice_mismatch_safe
case_run "错误提示：旧版受管 main 只给固定安全建议" case_error_advice_legacy_safe
case_run "F2：登记立即落盘 + 冷重载 state 后续跑不重写/不重复备份" case_nginx_state_persist_and_cold_reload
case_run "F2：写盘后未登记的中断恢复——逐字节一致才补登记，绝不重写" case_nginx_interrupted_state_recovery
case_run "B4 正例：真实发行包默认配置备份后隔离为受管 main（无 server/80）且续跑幂等" case_nginx_normalize_fresh_install
case_run "B4：旧版受管 main（仍含默认 listen 80）不续跑，交人工" case_nginx_legacy_managed_main_refused
case_run "B4 负例：被人工改动的 nginx.conf 不动（fail closed）" case_nginx_modified_config_fail_closed
case_run "B4 负例：缺可信缓存包时不动（fail closed）" case_nginx_missing_cache_fail_closed
case_run "B4 负例：非本次新装来源时不动（fail closed）" case_nginx_not_fresh_fail_closed
case_run "B4 负例：多个缓存候选时不动（fail closed）" case_nginx_multiple_cache_fail_closed
case_run "B4：受管 main 未过 nginx -t 时按原内容/mode 回滚" case_nginx_rollback_on_failed_test
case_run "B4：缺 mime.types 时不改写（fail closed）" case_nginx_requires_mime_types
case_run "B4：静态扫描识别默认 80 且排除本项目站点" case_static_listen_80_hardblock
case_run "B4：有效配置含 80（含 127.0.0.1:80）硬阻断，无 80 放行" case_hard_block_effective_80
case_run "预检：已存在默认 80 配置时硬报（不假称可隔离）" case_preflight_nginx_default_80_hardblock
case_run "预检：未安装 nginx 时明确提示不能证明默认配置安全" case_preflight_nginx_missing_warns
case_run "前端原子发布与同产物跳过" case_publish_frontend_atomic_and_idempotent
case_run "current 软链被改动时拒绝发布" case_publish_frontend_refuses_drifted_symlink
case_run "端口占用检测" case_port_detection
case_run "preflight 干净沙箱零问题且不调用 sudo" case_preflight_clean
case_run "preflight 拒绝未识别 systemd unit" case_preflight_unknown_unit_refused
case_run "preflight 接受已记录且未改的 unit" case_preflight_recorded_unit_ok
case_run "preflight 拒绝被改动的 unit" case_preflight_modified_unit_refused
case_run "preflight 拒绝被占用端口" case_preflight_occupied_port_refused
case_run "preflight 拒绝未识别的 /usr/local/bin/uv" case_preflight_unknown_uv_refused
case_run "preflight 首启后重跑：真实文件集/备份/DB/current 全部识别" case_preflight_after_first_start
case_run "preflight 健康检查失败后重跑仍可继续" case_preflight_health_failure_rerun
case_run "preflight 外部 nginx 文件仍拒绝、自有文件跳过" case_preflight_foreign_nginx_file_refused
case_run "preflight 旧版 /etc/nginx 备份被精确标记（提示移走）" case_preflight_legacy_backup_flagged
case_run "preflight 未登记 DB 拒绝且提示不删除数据库" case_preflight_unrecorded_db_refused
case_run "信任锚：包内 group 可写成员被拒" case_trust_group_writable_file
case_run "信任锚：非 sticky 0777 父目录被拒" case_trust_nonsticky_world_writable_parent
case_run "信任锚：包内符号链接被拒" case_trust_symlink_in_package
case_run "信任锚：提交与钉住版本不一致被拒" case_trust_version_pin_mismatch
case_run "信任锚：重算 MANIFEST 的恶意 unit 仍被拒" case_trust_tampered_unit_with_recomputed_manifest
case_run "信任锚：/var/tmp 1777 sticky 祖先合法放行" case_trust_var_tmp_sticky_ancestor_allowed
case_run "gzip 探测：真实 GET+Accept-Encoding 协商通过且只用 >1024B 资源" case_gzip_probe_negotiated
case_run "gzip 探测：服务器未压缩时判失败" case_gzip_probe_server_never_gzips
case_run "gzip 探测：只有小资源时明确报“无法验证压缩”" case_gzip_probe_requires_large_asset

printf '\n通过 %d，失败 %d\n' "$PASSED" "$FAILED"
((FAILED == 0))
