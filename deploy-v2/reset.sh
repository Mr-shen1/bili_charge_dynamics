#!/usr/bin/env bash
# reset.sh —— 清掉本项目的部署，让 deploy.sh install 可以重新跑（不做任何备份）。
#
# 保留：nginx 包、Nginx 主配置、bili 账号与 /home/bili（uv 的 CPython 缓存）、
#       /usr/local/bin/uv、前端产物 /srv/dynamics-viewer（要一起删用 --all）。
# 删除（本项目自己的东西）：服务与 unit、/srv/bili-monitor、/etc/bili-monitor、
#       conf.d/bili.conf、snippets/bili-locations.conf。
#
# 用法：
#     reset.sh --dry-run     # 只打印
#     reset.sh               # 要求输入 DELETE，然后提权执行
#     reset.sh --all         # 连 /srv/dynamics-viewer 与 bili 账号一起删
#     reset.sh --no-keep-credentials   # 连 credentials/ 与 env 一起删（默认会先另存）
#
# 默认行为：删之前把 credentials/ 与 /etc/bili-monitor/env 复制到
# /var/lib/bili-deploy/keep/，并打印恢复命令；--all 时不另存。

set -euo pipefail

MODE=interactive
ALL=0
KEEP_CREDS=""      # 空 = 未指定 → 默认开启（只有 --all 时关掉）
for arg in "$@"; do
    case "$arg" in
        --dry-run) MODE=dry ;;
        --confirmed) MODE=root ;;
        --all) ALL=1 ;;
        --keep-credentials) KEEP_CREDS=1 ;;
        --no-keep-credentials) KEEP_CREDS=0 ;;
        -h|--help) sed -n '/^# 用法：/,/^$/p' "$0"; exit 0 ;;
        *)
            cat >&2 <<'EOS'
未知参数。可用参数：
  --dry-run                 只打印将执行的动作，不写盘
  --all                     连 /srv/dynamics-viewer、bili 账号、/home/bili 一起删
  --keep-credentials        （默认行为）先把 credentials/ 与 env 另存到 /var/lib/bili-deploy/keep/
  --no-keep-credentials     不另存，凭据与 env 一起删
  -h, --help                显示用法
EOS
            exit 2 ;;
    esac
done

[[ -z "$KEEP_CREDS" ]] && { [[ "$ALL" == 1 ]] && KEEP_CREDS=0 || KEEP_CREDS=1; }

run() {
    if [[ "$MODE" == dry ]]; then printf '  [dry-run] %s\n' "$*"; else printf '  $ %s\n' "$*"; "$@"; fi
}
safe_rm() {
    case "$1" in
        /srv/bili-monitor|/srv/bili-monitor/*|/srv/dynamics-viewer|/srv/dynamics-viewer/*|\
        /etc/bili-monitor|/etc/bili-monitor/*|/home/bili|/home/bili/*)
            run rm -rf -- "$1" ;;
        *) echo "拒绝删除白名单外路径：$1" >&2; exit 1 ;;
    esac
}

[[ $EUID -eq 0 ]] && SUDO="" || SUDO="sudo"

echo "== 现状 =="
echo "  bili-monitor: $(systemctl is-active bili-monitor 2>/dev/null || true)"
for p in /srv/bili-monitor /etc/bili-monitor /etc/bili-monitor/env \
         /etc/systemd/system/bili-monitor.service /etc/nginx/conf.d/bili.conf \
         /etc/nginx/snippets/bili-locations.conf /srv/dynamics-viewer; do
    [[ -e "$p" ]] && echo "  存在: $p"
done

if [[ "$MODE" == interactive ]]; then
    echo
    echo "将删除：/srv/bili-monitor（含数据库与凭据）、/etc/bili-monitor、unit、"
    echo "        conf.d/bili.conf、snippets/bili-locations.conf"
    [[ "$ALL" == 1 ]] && echo "        [--all] 另加 /srv/dynamics-viewer 与 bili 账号、/home/bili"
    [[ "$KEEP_CREDS" == 1 ]] && echo "        （凭据默认另存到 /var/lib/bili-deploy/keep/：credentials/ 与 env；--all 时不存）"
    echo "不做任何备份。输入 DELETE 继续："
    read -r a
    [[ "$a" == "DELETE" ]] || { echo "已取消。"; exit 1; }
    [[ -z "$SUDO" ]] || $SUDO -v
    if [[ -z "$SUDO" ]]; then
        exec bash "$0" --confirmed $([[ "$ALL" == 1 ]] && echo --all)
    else
        exec $SUDO -E bash "$0" --confirmed $([[ "$ALL" == 1 ]] && echo --all)
    fi
fi

# 1. 停服务
run $SUDO systemctl disable --now bili-monitor.service || true
if pgrep -u bili >/dev/null 2>&1; then
    run $SUDO pkill -u bili || true; sleep 2; run $SUDO pkill -9 -u bili || true
fi
run $SUDO rm -f /etc/systemd/system/bili-monitor.service
run $SUDO systemctl daemon-reload

# 2. 可选：先把凭据挪出来（cookie.txt / notifications.json 就在 credentials/ 里）
STASH=/var/lib/bili-deploy/keep/credentials
if [[ "$KEEP_CREDS" == 1 && -d /srv/bili-monitor/credentials ]]; then
    if ! ls /srv/bili-monitor/credentials >/dev/null 2>&1; then
        printf '  · 读不到 credentials/（0700，需要 root）；真删时会以 root 处理\n'
    elif [[ -n "$(ls -A /srv/bili-monitor/credentials 2>/dev/null)" ]]; then
        run $SUDO install -d -m 0700 -o root -g root "$STASH"
        run $SUDO cp -a /srv/bili-monitor/credentials/. "$STASH"/
        ok_kept=1
        printf '  · 已另存凭据：%s\n' "$STASH"
    else
        printf '  · credentials/ 是空的，无需另存\n'
    fi
fi

# 3. 同样把 /etc/bili-monitor/env 另存（里面是 cookie/通知/OSS 的实际取值）
if [[ "$KEEP_CREDS" == 1 && -f /etc/bili-monitor/env ]]; then
    run $SUDO install -d -m 0700 -o root -g root /var/lib/bili-deploy/keep
    run $SUDO cp -a /etc/bili-monitor/env /var/lib/bili-deploy/keep/env
    ok_kept=1
    printf '  · 已另存 env：%s\n' /var/lib/bili-deploy/keep/env
fi

# 4. 删项目数据与配置
safe_rm /srv/bili-monitor
safe_rm /etc/bili-monitor
run $SUDO rm -f /etc/nginx/conf.d/bili.conf /etc/nginx/snippets/bili-locations.conf

# 3. reload nginx（保留其它站点）
if systemctl is-active --quiet nginx; then
    if run $SUDO nginx -t >/dev/null; then
        run $SUDO systemctl reload nginx
    else
        echo "  nginx -t 失败，未 reload；先人工检查 /etc/nginx" >&2
    fi
fi

# 4. 可选：前端与账号
if [[ "$ALL" == 1 ]]; then
    safe_rm /srv/dynamics-viewer
    if id -u bili >/dev/null 2>&1; then run $SUDO userdel -r bili || run $SUDO userdel bili; fi
    safe_rm /home/bili
    run $SUDO rm -rf /var/lib/bili-deploy
fi

[[ "$MODE" == dry ]] && { echo; echo "（dry-run 结束，未做任何改动）"; exit 0; }

# 5. 核验
echo "== 核验 =="
fail=0
for p in /srv/bili-monitor /etc/bili-monitor /etc/bili-monitor/env \
         /etc/systemd/system/bili-monitor.service /etc/nginx/conf.d/bili.conf \
         /etc/nginx/snippets/bili-locations.conf; do
    if [[ -e "$p" ]]; then echo "  残留: $p"; fail=1; else echo "  absent: $p"; fi
done
for i in $(seq 1 6); do ss -lnt 2>/dev/null | grep -qE ':(4273|4173|8000)\b' || break; sleep 1; done
ss -lnt 2>/dev/null | grep -qE ':(4173|4273|8000)\b' && { echo "  残留: 端口仍被占用"; fail=1; } || echo "  absent: 4173/4273/8000 监听"
echo
if [[ "$fail" == 0 ]]; then
    if [[ "${ok_kept:-0}" == 1 ]]; then
        echo "凭据已另存：$STASH（env 另存为 /var/lib/bili-deploy/keep/env）"
        echo "恢复 env：sudo install -m 0600 -o root -g root /var/lib/bili-deploy/keep/env /etc/bili-monitor/env"
        echo "装完之后手工放回（owner/mode 必须对，否则服务起不来）："
        echo "    sudo install -o bili -g bili -m 600 $STASH/cookie.txt        /srv/bili-monitor/credentials/"
        echo "    sudo install -o bili -g bili -m 640 $STASH/notifications.json /srv/bili-monitor/credentials/"
        echo "    sudo systemctl restart bili-monitor"
        echo
    fi
    echo "重置完成。下一步：deploy.sh --check → deploy.sh install"
else
    echo "仍有残留，先处理上面的项。" >&2; exit 1
fi
