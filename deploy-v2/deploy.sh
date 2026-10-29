#!/usr/bin/env bash
# deploy.sh —— 本地与阿里云 ECS 共用的部署入口（首次安装 / 升级 / 只读预检）
#
# 设计取舍（相对仓库里已被移除的旧部署向导）：
#   * 没有状态文件。安装前只做「目标是否为空」的检查，不维护 state.tsv，因此没有续跑矩阵。
#   * 平台自适配：pacman(Debian 用 apt)、非 root 用 sudo / root 直接执行（云端）。
#   * 代码永远来自离线安装包内的 bundle，本地与云端完全同构、版本可复现。
#   * 以 bili 身份执行命令时先 cd /var/tmp，避免 operator 家目录 0700 导致的
#     "fatal: Invalid path ... Permission denied"。
#
# 用法（本地与云端一字不差，只是 --package 指向的目录可能不同）：
#     deploy.sh --check                    # 只读预检，不写盘、不调 sudo
#     deploy.sh install  [--lan]           # 首次安装
#     deploy.sh upgrade  --sha <40位SHA>   # 升级到指定提交（只前滚）
#     deploy.sh env                        # 打印 env 模板（含默认路径）
#     deploy.sh env --write                # 写入 /etc/bili-monitor/env（备份旧的），需 restart
#
# 可选参数：
#     --package DIR   离线包目录（默认取 /var/tmp/bili-deploy-pkg 下最新的）
#     --port N        Web 端口（默认：有 apt 的机器 4173，其它 4273）
#     --lan [ADDR]    让 Nginx 监听局域网地址（默认自动探测），而不是只回环
#     --yes           不询问，直接执行（危险动作仍需显式 install/upgrade 子命令）
#
# 退出码：0 成功；1 前置条件不满足（未做任何改动或已回滚）；2 用法错误。

set -euo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
ASSETS="$HERE/assets"

# ── 常量 ────────────────────────────────────────────────────────────────────
RUN_USER=bili
DEPLOY_ROOT=/srv/bili-monitor
APP_DIR=$DEPLOY_ROOT/app
DB_PATH=$DEPLOY_ROOT/monitor.sqlite
BACKUP_DIR=$DEPLOY_ROOT/backup
CRED_DIR=$DEPLOY_ROOT/credentials
ENV_FILE=/etc/bili-monitor/env
UNIT_FILE=/etc/systemd/system/bili-monitor.service
NGINX_ROOT=/etc/nginx
NGINX_CONF=$NGINX_ROOT/conf.d/bili.conf
NGINX_SNIPPET=$NGINX_ROOT/snippets/bili-locations.conf
SITE_ROOT=/srv/dynamics-viewer
SERVICE=bili-monitor.service
API_PORT=8000
STATE_DIR=/var/lib/bili-deploy

# ── 输出 ────────────────────────────────────────────────────────────────────
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
run()  { printf '  $ %s\n' "$*"; "$@"; }

# ── 参数 ────────────────────────────────────────────────────────────────────
ACTION=""
PKG=""
PORT=""
BIND="127.0.0.1"
LAN=0
LAN_ADDR=""
ASSUME_YES=0
TARGET_SHA=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --check|install|upgrade|env) ACTION="$1"; shift ;;
        --write) WRITE_ENV=1; shift ;;
        --package) PKG="${2:?--package 需要目录}"; shift 2 ;;
        --port)    PORT="${2:?--port 需要数字}"; shift 2 ;;
        --sha)     TARGET_SHA="${2:?--sha 需要 40 位提交}"; shift 2 ;;
        --lan)     LAN=1; shift; [[ "${1:-}" =~ ^[0-9.]+$ ]] && { LAN_ADDR="$1"; shift; } ;;
        --yes|-y)  ASSUME_YES=1; shift ;;
        -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
        *) echo "未知参数：$1（--help 看用法）" >&2; exit 2 ;;
    esac
done
[[ -n "$ACTION" ]] || { sed -n '2,30p' "$0"; exit 2; }

# ── 平台探测 ────────────────────────────────────────────────────────────────
if command -v pacman >/dev/null 2>&1; then
    PKG_MGR=pacman
elif command -v apt-get >/dev/null 2>&1; then
    PKG_MGR=apt
else
    echo "只支持 pacman / apt 系统" >&2; exit 1
fi

if [[ -z "$PORT" ]]; then
    [[ "$PKG_MGR" == apt ]] && PORT=4173 || PORT=4273
fi

if [[ $EUID -eq 0 ]]; then SUDO=""; else SUDO="sudo"; fi

# 以目标账号执行（先切到一个该账号可访问的目录，避开 operator 家目录 0700）
as_bili() {
    local su
    if [[ -z "$SUDO" ]]; then su=(runuser -u "$RUN_USER" --); else su=(sudo -u "$RUN_USER" --); fi
    ( cd /var/tmp && "${su[@]}" \
        env -i "HOME=/home/$RUN_USER" "USER=$RUN_USER" "LOGNAME=$RUN_USER" \
            PATH=/usr/local/bin:/usr/bin:/bin "LANG=C.UTF-8" "TMPDIR=/var/tmp" \
            "$@" )
}

# 读 Nginx 生效配置；拿不到 sudo 时返回空（只读预检不应因提权失败而中断）
nginx_dump() {
    if [[ -z "$SUDO" ]]; then nginx -T 2>/dev/null || true
    else $SUDO -n nginx -T 2>/dev/null || true; fi
}

# ── 安装包解析 ──────────────────────────────────────────────────────────────
resolve_pkg() {
    if [[ -z "$PKG" ]]; then
        # 优先 deploy-v2/package.sh 的产物目录；其次兼容旧格式包目录（同结构，只是生成器不同）
        PKG="$(ls -1dt /var/tmp/bili-deploy-pkg/*/ 2>/dev/null | head -1 || true)"
        [[ -n "$PKG" ]] || PKG="$(ls -1dt /var/tmp/bili-local-deployment/*/ 2>/dev/null | head -1 || true)"
        PKG="${PKG%/}"
    fi
    [[ -n "$PKG" && -d "$PKG" ]] || die "找不到离线安装包：先在开发机跑 deploy-v2/package.sh"

    for f in "$ASSETS/bili-monitor.service" "$ASSETS/nginx-locations.conf"; do
        [[ -f "$f" ]] || die "缺 $f（deploy-v2 目录不完整：assets/ 必须随 deploy.sh 一起存在）"
    done

    [[ -f "$PKG/MANIFEST.sha256" && -f "$PKG/VERSION" ]] || die "$PKG 不是完整的安装包（缺 MANIFEST/VERSION）"
    ( cd "$PKG" && sha256sum --check --strict --quiet MANIFEST.sha256 ) \
        || die "$PKG 的 MANIFEST 校验失败（包被改动或传输不完整）"

    SHA="$(sed -n 's/^commit=//p' "$PKG/VERSION" | head -1)"
    SHORT="$(sed -n 's/^short=//p' "$PKG/VERSION" | head -1)"
    REMOTE="$(sed -n 's/^remote_https=//p' "$PKG/VERSION" | head -1)"
    [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "$PKG/VERSION 里的 commit 不是完整 SHA：${SHA:-空}"
    BUNDLE="$(ls -1 "$PKG"/repo/*.bundle 2>/dev/null | head -1 || true)"
    [[ -n "$BUNDLE" ]] || die "$PKG/repo 下没有 bundle"
    DIST="$PKG/frontend/dist"
    [[ -f "$DIST/index.html" ]] || die "$PKG/frontend/dist 不完整"

    info "安装包：$PKG"
    info "提交：$SHA（$SHORT）"
    info "平台：$PKG_MGR　Web 端口：$PORT　提权：${SUDO:-root 直跑}"
}

# ── 目标状态检查 ────────────────────────────────────────────────────────────
occupied() {
    local p
    for p in "$ENV_FILE" "$UNIT_FILE" "$NGINX_CONF" "$NGINX_SNIPPET"; do
        [[ -e "$p" ]] && { echo "$p"; return 0; }
    done
    return 1
}

port_busy() { ss -H -ltn "sport = :$1" 2>/dev/null | grep -q .; }

# ── 只读预检 ────────────────────────────────────────────────────────────────
cmd_check() {
    step "预检（只读）"
    resolve_pkg

    local missing=()
    for t in git rsync sqlite3 curl ss; do
        command -v "$t" >/dev/null 2>&1 || missing+=("$t")
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        warn "缺少命令：${missing[*]}（install 会在依赖阶段安装）"
    else
        ok "命令齐备：git rsync sqlite3 curl ss"
    fi

    [[ -d /srv ]] && ok "/srv 存在" || warn "/srv 不存在（install 会创建）"

    if id -u "$RUN_USER" >/dev/null 2>&1; then
        ok "账号 $RUN_USER 已存在（uid=$(id -u "$RUN_USER")，将复用）"
    else
        ok "账号 $RUN_USER 不存在（install 会创建）"
    fi

    local occ
    if occ="$(occupied)"; then
        warn "目标已存在：$occ"
        warn "这不是空机器。要重装请先跑 deploy-v2/reset.sh；要升级请用 deploy.sh upgrade"
    else
        ok "目标无冲突（app、env、unit、Nginx 站点都不存在）"
        [[ -d "$DEPLOY_ROOT" ]] && info "$DEPLOY_ROOT 已存在（只含 backup/credentials，install 会复用）"
        [[ -d "$SITE_ROOT" ]] && info "$SITE_ROOT 已存在（前端产物，install 会新增 release 并原子切换）"
    fi

    for p in "$API_PORT" "$PORT"; do
        if port_busy "$p"; then
            warn "端口 $p 已被占用：$(ss -H -ltn "sport = :$p" | awk '{print $4}' | paste -sd, -)"
        else
            ok "端口 $p 空闲"
        fi
    done

    if [[ -f $NGINX_ROOT/nginx.conf ]]; then
        local dump
        dump="$(nginx_dump)"
        if [[ -z "$dump" ]]; then
            info "读不到 Nginx 生效配置（需要 sudo）；跳过 80 监听检查"
        elif printf '%s' "$dump" | grep -qE '^[[:space:]]*listen[[:space:]]+([^;]*:)?80([[:space:]]|;)'; then
            warn "现有 Nginx 配置里有 80 监听（install 会先隔离再启动，本项目不占 80）"
        else
            ok "现有 Nginx 配置无 80 监听"
        fi
    else
        ok "Nginx 未安装（install 会装）"
    fi

    echo
    ok "预检结束（未写盘、未调用 sudo）"
}

# ── 1. 依赖 ─────────────────────────────────────────────────────────────────
stage_deps() {
    step "1/7 安装系统依赖"
    case "$PKG_MGR" in
        pacman)
            info "pacman -S --needed --noconfirm nginx git rsync sqlite curl"
            $SUDO pacman -S --needed --noconfirm nginx git rsync sqlite curl >/dev/null \
                || die "pacman 安装依赖失败"
            ;;
        apt)
            info "apt-get update && apt-get install -y nginx git rsync sqlite3 curl"
            $SUDO apt-get update -qq || die "apt-get update 失败"
            $SUDO apt-get install -y -qq nginx git rsync sqlite3 curl >/dev/null \
                || die "apt-get install 失败"
            ;;
    esac
    ok "nginx $(nginx -v 2>&1 | sed 's#.*/##')　sqlite3 $(sqlite3 --version | cut -d' ' -f1)"

    if [[ -x /usr/local/bin/uv ]]; then
        ok "uv 已存在：$(/usr/local/bin/uv --version)"
    else
        run $SUDO install -m 0755 "$PKG/uv/uv" /usr/local/bin/uv
        ok "uv 已安装：$(/usr/local/bin/uv --version)"
    fi
    run $SUDO install -d -m 0755 "$STATE_DIR/backups"
}

# ── 2. 账号与目录 ───────────────────────────────────────────────────────────
stage_dirs() {
    step "2/7 账号与目录"
    if id -u "$RUN_USER" >/dev/null 2>&1; then
        ok "复用账号 $RUN_USER"
    else
        run $SUDO useradd -m -s /bin/bash "$RUN_USER"
        ok "已创建账号 $RUN_USER"
    fi
    run $SUDO install -d -m 0755 -o "$RUN_USER" -g "$RUN_USER" "$DEPLOY_ROOT"
    run $SUDO install -d -m 0755 -o "$RUN_USER" -g "$RUN_USER" "$BACKUP_DIR"
    run $SUDO install -d -m 0700 -o "$RUN_USER" -g "$RUN_USER" "$CRED_DIR"
    run $SUDO install -d -m 0755 "$SITE_ROOT" "$SITE_ROOT/releases"
    run $SUDO install -d -m 0755 /etc/bili-monitor
    run $SUDO install -d -m 0755 "$NGINX_ROOT/conf.d" "$NGINX_ROOT/snippets"
    ok "目录就绪：$DEPLOY_ROOT、$SITE_ROOT、/etc/bili-monitor"
}

# ── 3. Nginx 底座（隔离发行版默认站点）─────────────────────────────────────
managed_nginx_conf() {
    cat <<'EOF'
# 由 deploy-v2/deploy.sh 生成的受管主配置：不含任何 server 块，
# 站点全部来自 conf.d/*.conf，因此不会继承发行包默认的 listen 80。
worker_processes auto;

include modules.d/*.conf;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    sendfile on;
    keepalive_timeout 65;
    include /etc/nginx/conf.d/*.conf;
}
EOF
}

stage_nginx_base() {
    step "3/7 Nginx 底座隔离（本项目不占 80）"
    local main=$NGINX_ROOT/nginx.conf
    [[ -f "$main" ]] || die "缺 $main（nginx 安装异常）"

    if [[ "$PKG_MGR" == apt ]]; then
        # Debian/Ubuntu：默认站点在 sites-enabled，nginx.conf 保持包原样
        if [[ -e "$NGINX_ROOT/sites-enabled/default" ]]; then
            local bk="$STATE_DIR/backups/sites-enabled-default.$(date -u +%Y%m%dT%H%M%SZ)"
            run $SUDO mv "$NGINX_ROOT/sites-enabled/default" "$bk"
            ok "已移走默认站点 → $bk"
        else
            ok "默认站点已不存在（sites-enabled/default）"
        fi
        grep -qE 'include[[:space:]]+/etc/nginx/conf\.d/\*\.conf' "$main" \
            || warn "Debian nginx.conf 未 include conf.d/*.conf，本项目站点可能不生效；请人工确认"
    else
        # Arch 系：包自带激活的 listen 80 且没有 conf.d include → 换成受管最小主配置
        if grep -qE '^[[:space:]]*(server[[:space:]]*\{|listen[[:space:]])' "$main" ||
           ! grep -qE 'include[[:space:]]+[^;]*conf\.d/\*\.conf' "$main"; then
            local bk="$STATE_DIR/backups/nginx.conf.$(date -u +%Y%m%dT%H%M%SZ).orig"
            run $SUDO cp -a "$main" "$bk"
            local tmp; tmp="$(mktemp /var/tmp/bili-nginx.conf.XXXXXX)"
            managed_nginx_conf > "$tmp"
            run $SUDO install -m 0644 "$tmp" "$main"
            rm -f "$tmp"
            ok "已把 $main 换成受管主配置（原件备份在 $bk）"
        else
            ok "Nginx 主配置已是受管形态（无 server/listen）"
        fi
    fi

    run $SUDO nginx -t >/dev/null
    if nginx_dump | grep -qE '^[[:space:]]*listen[[:space:]]+([^;]*:)?80([[:space:]]|;)'; then
        die "Nginx 生效配置里仍有 80 监听（本项目不占 80）；请人工处理后重跑"
    fi
    ok "nginx -t 通过，生效配置无 80 监听"
}

# ── 4. 代码与依赖 ───────────────────────────────────────────────────────────
stage_code() {
    step "4/7 检出代码并安装依赖（需要联网拉 PyPI）"
    if [[ -e "$APP_DIR" ]]; then
        # 上一次运行在 Stage 4 之后失败时的续跑路径：同提交 + 干净工作区才复用
        [[ -d "$APP_DIR/.git" ]] || die "$APP_DIR 存在但不是 git 检出；先跑 deploy-v2/reset.sh"
        local reused; reused="$(as_bili git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)"
        [[ "$reused" == "$SHA" ]] || die "$APP_DIR 已检出 ${reused:-未知} ≠ 包内 $SHA；先跑 deploy-v2/reset.sh"
        [[ -z "$(as_bili git -C "$APP_DIR" status --porcelain)" ]] || die "$APP_DIR 工作区不干净；先跑 deploy-v2/reset.sh"
        ok "复用已检出的代码（$SHORT）"
    else
        info "git clone $BUNDLE → $APP_DIR"
        as_bili git clone --quiet --branch main --single-branch "$BUNDLE" "$APP_DIR" \
            || die "git clone 失败"
        ok "已检出到 $APP_DIR"
    fi

    # origin：先留离线 bundle 备查，再把 origin 指向 GitHub（升级用）
    as_bili git -C "$APP_DIR" remote rename origin local-bundle >/dev/null 2>&1 || true
    as_bili git -C "$APP_DIR" remote add local-bundle "$BUNDLE" >/dev/null 2>&1 || true
    if [[ "$REMOTE" == https://* ]]; then
        as_bili git -C "$APP_DIR" remote add origin "$REMOTE" >/dev/null 2>&1 || \
            as_bili git -C "$APP_DIR" remote set-url origin "$REMOTE"
        ok "origin → $REMOTE（升级用）"
    else
        warn "安装包未记录远端地址，升级前需手工补 origin"
    fi

    local head; head="$(as_bili git -C "$APP_DIR" rev-parse HEAD)"
    [[ "$head" == "$SHA" ]] || die "检出提交 $head ≠ 包内提交 $SHA"
    ok "检出提交与安装包一致：$SHORT"

    info "uv sync --locked --no-dev --python 3.12（首次会下载 CPython，几分钟）"
    as_bili /usr/bin/env UV_PYTHON_PREFERENCE=only-managed /usr/local/bin/uv sync \
        --locked --no-dev --python 3.12 --directory "$APP_DIR"
    as_bili "$APP_DIR/.venv/bin/python" -V | grep -q '^Python 3\.12' \
        || die "venv Python 版本不是 3.12"
    as_bili "$APP_DIR/.venv/bin/python" -c 'import fastapi, uvicorn' \
        || die "venv 缺少运行时依赖"
    ok "venv：$(as_bili "$APP_DIR/.venv/bin/python" -V)"
}

# ── 5. 系统配置 ─────────────────────────────────────────────────────────────
render_env() { cat <<EOF
# /etc/bili-monitor/env —— 由 deploy-v2/deploy.sh 生成（0600 root:root）
#
# 应用本身不读 .env；只有 systemd 读取本文件后注入给 bili 用户。
# 改完必须重启：sudo systemctl restart bili-monitor
#
# 铁律：选配变量要么**整行注释掉**，要么填完整值。
# 写成 `BILI_COOKIE_FILE=` 这种空值会让服务直接起不来（空串既非“未设置”又是不完整配置）。

# ── 必填：持久化数据库（仓库外绝对路径，目录需 bili 可写）───────────────────
BILI_DATABASE_PATH=$DB_PATH

# ── 运行时（配合 ProtectSystem=strict，只读文件系统下禁止写 .pyc）────────────
PYTHONDONTWRITEBYTECODE=1
PYTHONUNBUFFERED=1

# ── 选配：飞书通知路由（第三个进程；不放文件就保持注释）─────────────────────
# 指向仓库外 JSON（内含 webhook 与可选签名密钥），属主 bili（或 root 可读）、权限 ≤0640。
# 未设置时统一入口只托管 API＋collector，不投递任何飞书消息。
# 改本行后需重启；已排队投递与成功目标状态保留，不热加载。
# BILI_NOTIFICATION_CONFIG=/srv/bili-monitor/credentials/notifications.json

# ── 选配：B 站登录 Cookie（仅服务端；默认匿名）──────────────────────────────
# 指向仓库外、属主 bili、权限 0600 的文件，其直属目录 0700。
# 启动时只读一次；格式无效直接拒启。
# BILI_COOKIE_FILE=/srv/bili-monitor/credentials/cookie.txt

# ── 选配：阿里云 OSS 媒体归档（七项必须同时填，缺一项或留空都会启动失败）────
# 不启用时媒体保持「待归档」，不占本地磁盘。
#   启用前必读：
#     · ENDPOINT 必须无路径、无端口、以 .aliyuncs.com 结尾
#     · PUBLIC_BASE_URL 是浏览器直取前缀，可被直接访问和外链——加登录也不保护图片
#     · ACCESS_KEY_* 建议用专用 RAM 子账号，只授该桶 oss:PutObject
#     · SECURITY_TOKEN 仅 STS 临时凭据需要，长期 AK 时省略
#   填好后先预检再重启（不打印密钥、不发网络请求）：
#     sudo install -m 0755 scripts/check-oss-env.sh /usr/local/sbin/bili-monitor-check-oss
#     sudo /usr/local/sbin/bili-monitor-check-oss
# BILI_OSS_ENDPOINT=https://oss-cn-shenzhen.aliyuncs.com
# BILI_OSS_REGION=cn-shenzhen
# BILI_OSS_BUCKET=your-bucket-name
# BILI_OSS_ACCESS_KEY_ID=your-access-key-id
# BILI_OSS_ACCESS_KEY_SECRET=your-access-key-secret
# BILI_OSS_PUBLIC_BASE_URL=https://your-bucket-name.oss-cn-shenzhen.aliyuncs.com
# BILI_OSS_SECURITY_TOKEN=
EOF
}

render_conf() {
    local bind="$1"
    cat <<EOF
# 由 deploy-v2/deploy.sh 生成。只改下面一行 listen 即可换绑定地址/端口。
server {
    listen $bind:$PORT;
    server_name _;

    access_log off;
    error_log /dev/null;

    gzip on;
    gzip_vary on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_proxied any;
    gzip_types
        text/plain
        text/css
        text/javascript
        application/javascript
        application/json
        application/manifest+json
        image/svg+xml;

    include $NGINX_SNIPPET;
}
EOF
}

stage_config() {
    step "5/7 写系统配置（env / unit / Nginx 站点）"

    # 自检：deploy.sh 把路径/账号/端口写死在脚本里，包的模板必须与之一致。
    # 任何一项对不上就停，避免“装完了但服务指向别处”的静默错误。
    local unit_src="$ASSETS/bili-monitor.service" snip_src="$ASSETS/nginx-locations.conf"
    # 若包里也带了同名模板，必须与本目录的资产逐字节一致（防漂移）
    local f
    for f in bili-monitor.service nginx-locations.conf; do
        if [[ -f "$PKG/deploy/$f" ]] && ! cmp -s "$PKG/deploy/$f" "$ASSETS/$f"; then
            die "包内 deploy/$f 与 deploy-v2/assets/$f 不一致：包与脚本不同源，拒绝安装"
        fi
    done
    grep -qx "User=$RUN_USER" "$unit_src" || die "包的 unit User 不是 $RUN_USER"
    grep -qx "EnvironmentFile=$ENV_FILE" "$unit_src" || die "包的 unit EnvironmentFile 不是 $ENV_FILE"
    grep -qx "ReadWritePaths=$DEPLOY_ROOT" "$unit_src" || die "包的 unit ReadWritePaths 不是 $DEPLOY_ROOT"
    grep -qF -- "-m backend.bili_monitor.service --host 127.0.0.1 --port $API_PORT" "$unit_src" \
        || die "包的 unit ExecStart 与本脚本约定的入口/端口（$API_PORT）不一致"
    grep -qx "$APP_DIR/.venv/bin/python -m backend.bili_monitor.service --host 127.0.0.1 --port $API_PORT" \
        <(sed -n 's/^ExecStart=//p' "$unit_src") || die "包的 unit ExecStart 路径不是 $APP_DIR/.venv"
    grep -qF "root $SITE_ROOT/current;" "$snip_src" || die "包的 nginx snippet 静态根不是 $SITE_ROOT/current"
    grep -qF "proxy_pass http://127.0.0.1:$API_PORT;" "$snip_src" || die "包的 nginx snippet proxy_pass 不是 127.0.0.1:$API_PORT"
    ok "包模板与脚本约定一致（User/env 路径/ReadWritePaths/ExecStart/静态根/反代）"

    local tmp
    tmp="$(mktemp /var/tmp/bili-env.XXXXXX)"; render_env > "$tmp"
    run $SUDO install -m 0600 -o root -g root "$tmp" "$ENV_FILE"; rm -f "$tmp"
    ok "$ENV_FILE（0600，有效行仅 DB 路径 + 两项 PYTHON*）"

    run $SUDO install -m 0644 -o root -g root "$unit_src" "$UNIT_FILE"
    run $SUDO systemctl daemon-reload
    ok "$UNIT_FILE（来自 deploy-v2/assets/bili-monitor.service）"

    run $SUDO install -m 0644 -o root -g root "$snip_src" "$NGINX_SNIPPET"
    ok "$NGINX_SNIPPET"

    local bind="127.0.0.1"
    if [[ "$LAN" == 1 ]]; then
        if [[ -n "$LAN_ADDR" ]]; then
            bind="$LAN_ADDR"
        else
            bind="$(ip -4 -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
            [[ -n "$bind" ]] || die "探测不到局域网 IPv4，请用 --lan <地址> 显式指定"
        fi
        warn "Nginx 将监听 $bind:$PORT（局域网可访问，管理页无鉴权）"
        # ufw 处于 active 时，局域网设备会被拦；给出确切放行命令
        local ufw_status cidr net
        if command -v ufw >/dev/null 2>&1; then
            ufw_status="$(if [[ -z "$SUDO" ]]; then ufw status 2>/dev/null; else $SUDO -n ufw status 2>/dev/null; fi || true)"
            if printf '%s' "$ufw_status" | grep -q '^Status: active'; then
                if printf '%s' "$ufw_status" | grep -q "$PORT"; then
                    info "ufw 已有 $PORT 相关规则"
                else
                    cidr="$(ip -4 -o addr show scope global | awk -v ip="$bind" 'index($4, ip "/") == 1 {print $4; exit}')"
                    net="${cidr%.*}.0/${cidr#*/}"
                    warn "ufw 处于 active，且没有 $PORT 规则；局域网可能连不上。需要时执行："
                    warn "    $SUDO ufw allow from $net to any port $PORT proto tcp"
                fi
            fi
        fi
    else
        info "Nginx 监听 127.0.0.1:$PORT（只回环）"
    fi
    tmp="$(mktemp /var/tmp/bili-conf.XXXXXX)"; render_conf "$bind" > "$tmp"
    run $SUDO install -m 0644 -o root -g root "$tmp" "$NGINX_CONF"; rm -f "$tmp"
    BIND="$bind"
    ok "$NGINX_CONF（listen $bind:$PORT）"

    run $SUDO nginx -t >/dev/null || die "nginx -t 失败"
    ok "nginx -t 通过"
}

# ── 6. 前端发布 ─────────────────────────────────────────────────────────────
stage_frontend() {
    step "6/7 发布前端（原子切换 current）"
    local release="$SITE_ROOT/releases/$(date -u +%Y%m%dT%H%M%SZ)-$SHORT"
    run $SUDO install -d -m 0755 -o root -g root "$release"
    run $SUDO rsync -a --delete "$DIST/" "$release/"
    [[ "$(sha256sum "$release/index.html" | cut -d' ' -f1)" == "$(sha256sum "$DIST/index.html" | cut -d' ' -f1)" ]] \
        || die "发布后 index.html 与包内不一致"
    run $SUDO ln -sfn "$release" "$SITE_ROOT/current.tmp"
    run $SUDO mv -Tf "$SITE_ROOT/current.tmp" "$SITE_ROOT/current"
    ok "current → $release"

    # 只清理本项目命名规则（<UTC>-<7hex>）的历史版本，保留最新 5 个
    local old
    while IFS= read -r old; do
        [[ -n "$old" ]] || continue
        [[ "$SITE_ROOT/releases/$old" == "$(readlink -f "$SITE_ROOT/current")" ]] && continue
        run $SUDO rm -rf -- "$SITE_ROOT/releases/$old"
        info "清理旧版本 $old"
    done < <(cd "$SITE_ROOT/releases" && ls -1d -- */ 2>/dev/null | sed 's#/$##' |
        grep -E '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$' | LC_ALL=C sort -r | tail -n +6 || true)
}

# ── 7. 启动与验收 ───────────────────────────────────────────────────────────
wait_api() {
    local i
    for i in $(seq 1 60); do
        if curl -fsS -m 2 "http://127.0.0.1:$API_PORT/api/manage/ups" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

stage_start() {
    step "7/7 启动并验收"
    # 注意：nginx 可能已在跑（共用宿主机），此时 `enable --now` 不会重新加载配置，
    # 新写的 conf.d/bili.conf 不会生效。已运行就 reload，未运行才 start。
    run $SUDO systemctl enable nginx >/dev/null 2>&1 || warn "enable nginx 失败（继续）"
    if systemctl is-active --quiet nginx; then
        run $SUDO nginx -t >/dev/null || die "nginx -t 失败，未 reload"
        run $SUDO systemctl reload nginx
        ok "nginx 已 reload（站点配置生效）"
    else
        run $SUDO systemctl start nginx
        ok "nginx 已启动"
    fi
    # 先体检再启动：env 里若启用了 cookie/通知/OSS 但读不到，直接停在这里，
    # 不进 systemd 的 restart 循环（那条路的 traceback 被应用吞掉了）。
    if [[ -x "$HERE/doctor.sh" ]] && ! bash "$HERE/doctor.sh" --quiet --ignore-service; then
        die "环境/凭据检查未通过，服务未启动。按上面的 ✗ 修好后再跑 install"
    fi
    run $SUDO systemctl enable --now "$SERVICE"
    if ! wait_api; then
        $SUDO journalctl -u "$SERVICE" -n 30 --no-pager || true
        die "API 60 秒内未就绪；看上面的日志，修好后重跑 deploy.sh install"
    fi
    ok "API 已就绪（首次启动会执行数据库迁移）"
    bash "$(dirname "$(readlink -f "$0")")/verify.sh" --port "$PORT"
}

# ── 升级 ────────────────────────────────────────────────────────────────────
cmd_upgrade() {
    step "升级"
    [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || die "必须用 --sha 指定 40 位完整提交（不要用 main）"
    [[ -d "$APP_DIR/.git" ]] || die "$APP_DIR 不是 git 检出；首次安装请用 deploy.sh install"

    run $SUDO systemctl stop "$SERVICE"
    local i
    for i in $(seq 1 30); do systemctl is-active --quiet "$SERVICE" || break; sleep 1; done
    ok "服务已停止"

    if [[ -f "$DB_PATH" ]]; then
        local bk="$BACKUP_DIR/monitor-$(date +%F-%H%M).sqlite"
        as_bili sqlite3 "$DB_PATH" ".backup $bk"
        ok "数据库一致性备份：$bk"
    fi

    as_bili git -C "$APP_DIR" fetch --quiet origin
    as_bili git -C "$APP_DIR" checkout --quiet "$TARGET_SHA"
    ok "代码已切到 $TARGET_SHA"

    as_bili /usr/bin/env UV_PYTHON_PREFERENCE=only-managed /usr/local/bin/uv sync \
        --locked --no-dev --python 3.12 --directory "$APP_DIR"
    ok "依赖已同步"

    # 前端与代码同批：从当前安装包取 dist（若提供了包），否则提示单独发布
    if [[ -n "$PKG" ]]; then
        resolve_pkg
        stage_frontend
    else
        warn "未提供 --package：本次未更新前端。需要时重新打包后带 --package 重跑 upgrade"
    fi

    if [[ -x "$HERE/doctor.sh" ]] && ! bash "$HERE/doctor.sh" --quiet --ignore-service; then
        die "环境/凭据检查未通过，服务未启动；代码已切到 $TARGET_SHA"
    fi
    run $SUDO systemctl start "$SERVICE"
    wait_api || die "升级后 API 未就绪，看 journalctl -u $SERVICE；数据库只前滚，不要回退代码强开新库"
    ok "API 已就绪"
    bash "$(dirname "$(readlink -f "$0")")/verify.sh" --port "$PORT"
}

# ── 安装 ────────────────────────────────────────────────────────────────────
cmd_install() {
    step "首次安装"
    resolve_pkg
    local occ
    if occ="$(occupied)"; then
        die "目标已存在：$occ
这不是空机器。要重装先跑 deploy-v2/reset.sh；要升级用 deploy.sh upgrade --sha <提交>"
    fi
    [[ $ASSUME_YES == 1 ]] || {
        echo
        echo "将安装：$DEPLOY_ROOT、$SITE_ROOT、$ENV_FILE、$UNIT_FILE、$NGINX_CONF"
        [[ -d "$APP_DIR/.git" ]] && echo "（检测到已有代码检出，将在校验后复用）"
        echo "提交：$SHA（$SHORT）　Web 端口：$PORT"
        read -r -p "继续？输入 y：" a
        [[ "$a" == "y" ]] || { echo "已取消。"; exit 1; }
    }
    [[ -z "$SUDO" ]] || $SUDO -v

    stage_deps
    stage_dirs
    stage_nginx_base
    stage_code
    stage_config
    stage_frontend
    stage_start

    echo
    ok "部署完成：$SHORT，Web 端口 $PORT"
    echo "  管理页：http://$BIND:$PORT/manage"
    echo "  升级：  deploy.sh upgrade --sha <40位SHA> --package <新包目录>"
}

cmd_env() {
    if [[ "${WRITE_ENV:-0}" == 0 ]]; then
        render_env
        echo
        echo "# ↑ 上面就是要写入 $ENV_FILE 的内容；确认后执行：deploy.sh env --write && sudo systemctl restart bili-monitor" >&2
        return 0
    fi
    $SUDO -v
    run $SUDO install -d -m 0755 "$STATE_DIR/backups"
    if [[ -f "$ENV_FILE" ]]; then
        local bk="$STATE_DIR/backups/env.$(date -u +%Y%m%dT%H%M%SZ)"
        run $SUDO cp -a "$ENV_FILE" "$bk"
        ok "旧 env 已备份：$bk"
    fi
    local tmp; tmp="$(mktemp /var/tmp/bili-env.XXXXXX)"
    render_env > "$tmp"
    run $SUDO install -m 0600 -o root -g root "$tmp" "$ENV_FILE"
    rm -f "$tmp"
    ok "$ENV_FILE 已写入（0600 root:root）"
    echo
    echo "让改动生效：sudo systemctl restart bili-monitor"
    echo "重启后验收：  bash deploy-v2/verify.sh"
}

case "$ACTION" in
    --check) cmd_check ;;
    install) cmd_install ;;
    upgrade) cmd_upgrade ;;
    env) cmd_env ;;
esac
