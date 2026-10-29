#!/usr/bin/env bash
# 票 10 第二轮隔离预览的轻量 HTTP 冒烟（准备用，不是人工验收、不是真机结果）。
# 覆盖：A/B 首页与深链、两个预览的 /api 代理确实打到 4180、B 的 /images 代理到 4339、
# 管理/归档读取可读（3 UP、45 评、25 回复、11 条整段会话、通知默认 off），
# 以及 13 的整段会话契约（一次读取、无 page 键、无分页查询、旧显式分页仅兼容）。
# 只用 curl/python 标准库，不重跑大套件、不访问真实上游。
set -euo pipefail

RUNTIME="${RUNTIME:-/tmp/bili-ticket10-round1-zogc}"
API=http://127.0.0.1:4180
A=http://127.0.0.1:4318
B=http://127.0.0.1:4337
IMAGES=http://127.0.0.1:4339
OUT="$RUNTIME/logs/smoke.json"
FAIL=0
declare -a LINES=()

get() { curl -sS --noproxy '*' -o /tmp/t10r1-body -w '%{http_code} %{content_type}' "$1"; }

record() { # name expected actual
  local name=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then
    LINES+=("PASS  $name  ($actual)")
  else
    LINES+=("FAIL  $name  期望 $expected 实际 $actual")
    FAIL=1
  fi
}

record_body() { # name verdict
  local name=$1 verdict=$2
  if [ "$verdict" = ok ]; then LINES+=("PASS  $name"); else LINES+=("FAIL  $name"); FAIL=1; fi
}

py() { python3 -c "$1"; }

echo "== 1. 首页与深链（SPA fallback 必须返回 index.html） =="
for url in "$A/" "$A/dynamics/800300" "$A/dynamics/800300/comments/860001/replies/960013/conversation" \
           "$A/ups/808" "$A/manage" "$A/manage/ups/808" "$A/manage/ups/202" \
           "$B/" "$B/__preview-fixtures" "$B/dynamics/800300" "$B/manage"; do
  out=$(get "$url")
  code=${out%% *}
  record "GET $url" "200 text/html" "$code $(echo "$out" | cut -d' ' -f2 | cut -d';' -f1)"
  record_body "  index.html 标记（$(grep -c 'id="app"' /tmp/t10r1-body 2>/dev/null || true) 处 #app）" \
    "$(grep -q 'id="app"' /tmp/t10r1-body && echo ok || echo bad)"
done

echo "== 2. 静态资源（A/B 各自的 /assets 必须可读） =="
for base in "$A" "$B"; do
  asset=$(curl -sS --noproxy '*' "$base/" | grep -o '/assets/[^"]*\.js' | head -1)
  out=$(get "$base$asset")
  record "GET $base$asset" "200 text/javascript" "$(echo "$out" | cut -d' ' -f1) $(echo "$out" | cut -d' ' -f2 | cut -d';' -f1)"
done

echo "== 3. /api 代理目标取证：必须命中 4180 的 live_app，而不是既有 8000 =="
for base in "$A" "$B"; do
  out=$(get "$base/api/test/source-requests")
  record "GET $base/api/test/source-requests（仅 live_app 有）" "200 application/json" \
    "$(echo "$out" | cut -d' ' -f1) $(echo "$out" | cut -d' ' -f2 | cut -d';' -f1)"
done
direct=$(curl -sS --noproxy '*' "$API/api/manage/ups")
for base in "$A" "$B"; do
  proxied=$(curl -sS --noproxy '*' "$base/api/manage/ups")
  record_body "  $base/api/manage/ups 与 $API 逐字节相同" \
    "$([ "$proxied" = "$direct" ] && echo ok || echo bad)"
done
record_body "  4180 返回 3 个虚构 UP（808/202/707）" \
  "$(py "
import json,subprocess
d=json.loads(subprocess.run(['curl','-sS','--noproxy','*','$API/api/manage/ups'],capture_output=True,text=True).stdout)
print('ok' if sorted(u['uid'] for u in d['ups'])==['202','707','808'] else 'bad')")"

echo "== 4. 图片：B 经 4337 代理到 127.0.0.1:4339 =="
out=$(get "$B/images/thumb/p1.svg")
record "GET $B/images/thumb/p1.svg（代理 4339）" "200 image/svg+xml" \
  "$(echo "$out" | cut -d' ' -f1) $(echo "$out" | cut -d' ' -f2 | cut -d';' -f1)"
out=$(get "$IMAGES/__requests")
record "GET $IMAGES/__requests（图片夹具直连，仅回环）" "200 application/json" \
  "$(echo "$out" | cut -d' ' -f1) $(echo "$out" | cut -d' ' -f2 | cut -d';' -f1)"
out=$(get "$B/images/nothing/none.svg")
record "GET $B/images/nothing/none.svg（未知路径 404 由夹具给出）" "404" "$(echo "$out" | cut -d' ' -f1)"
# 环境 A 也显式把 /images 指向 4339（A 的归档没有图片）：代理目标一致，避免误入其它服务。
out=$(get "$A/images/thumb/p1.svg")
record "GET $A/images/thumb/p1.svg（A 也显式代理 4339）" "200 image/svg+xml" \
  "$(echo "$out" | cut -d' ' -f1) $(echo "$out" | cut -d' ' -f2 | cut -d';' -f1)"

echo "== 5. 管理可读 =="
record_body "  /api/manage/ups/808 monitor.mode=specified enabled=true" \
  "$(py "
import json,subprocess
d=json.loads(subprocess.run(['curl','-sS','--noproxy','*','$API/api/manage/ups/808'],capture_output=True,text=True).stdout)
m=d['monitor']
print('ok' if (m['mode'],m['recent_n'],m['enabled'])==('specified',10,True) else 'bad')")"
record_body "  /api/manage/notifications state=off（未启动通知）" \
  "$(py "
import json,subprocess
d=json.loads(subprocess.run(['curl','-sS','--noproxy','*','$API/api/manage/notifications'],capture_output=True,text=True).stdout)
print('ok' if d['state']=='off' else 'bad')")"
record_body "  /api/manage/ups/808/checks、/discovery 可读" \
  "$(py "
import json,subprocess
def get(p):
    return subprocess.run(['curl','-sS','--noproxy','*','$API'+p],capture_output=True,text=True).stdout
ok=all(get(p).lstrip().startswith(('{','[')) for p in ['/api/manage/ups/808/checks','/api/manage/ups/808/discovery'])
print('ok' if ok else 'bad')")"

echo "== 6. 归档读取：45 评 / 25 回复 / 11 条整段会话 =="
record_body "  A 800300 根评论分页合计 45（20/20/5）" \
  "$(py "
import json,subprocess
def get(u): return json.loads(subprocess.run(['curl','-sS','--noproxy','*',u],capture_output=True,text=True).stdout)
total=0; cursor=None; pages=[]
while True:
    q='?sort=latest&limit=20'+('&cursor='+cursor if cursor else '')
    d=get('$API/api/archive/dynamics/800300/comments'+q)
    pages.append(len(d['items'])); total+=len(d['items']); cursor=d.get('next_cursor')
    if not cursor: break
print('ok' if total==45 and pages==[20,20,5] else 'bad')")"
record_body "  A 860001 楼中楼合计 25（首批 3 条时间序快照 + 续批 10/10/2）" \
  "$(py "
import json,subprocess
def get(u): return json.loads(subprocess.run(['curl','-sS','--noproxy','*',u],capture_output=True,text=True).stdout)
base='$API/api/archive/dynamics/800300/comments/860001/replies'
d=get(base); total=len(d['items']); first=len(d['items']); cursor=d.get('next_cursor'); pages=[first]
while cursor:
    d=get(base+'?cursor='+cursor); pages.append(len(d['items'])); total+=len(d['items']); cursor=d.get('next_cursor')
print('ok' if total==25 and pages==[3,10,10,2] else 'bad')")"
record_body "  A 会话入口 960013 一次读取整段：count=11、items=11、无 page 键、next_cursor=null" \
  "$(py "
import json,subprocess
url='$API/api/archive/dynamics/800300/comments/860001/replies/960013/conversation'
d=json.loads(subprocess.run(['curl','-sS','--noproxy','*',url],capture_output=True,text=True).stdout)
ok=(d['count'],len(d['items']),d.get('next_cursor'),d.get('start_id'),d.get('incomplete'))==(11,11,None,'960002',False) \
   and 'page' not in d and any(i['id']=='960013' for i in d['items'])
print('ok' if ok else 'bad')")"
record_body "  整段成员时间序：首条 960002、末条 960020（11 条全给）" \
  "$(py "
import json,subprocess
url='$API/api/archive/dynamics/800300/comments/860001/replies/960013/conversation'
d=json.loads(subprocess.run(['curl','-sS','--noproxy','*',url],capture_output=True,text=True).stdout)
ids=[i['id'] for i in d['items']]
print('ok' if ids[0]=='960002' and ids[-1]=='960020' and len(ids)==11 else 'bad')")"
record_body "  仅 limit、非法页码仍 422（整段入口不接受分页参数）" \
  "$(py "
import subprocess
base='$API/api/archive/dynamics/800300/comments/860001/replies/960013/conversation'
codes=[subprocess.run(['curl','-sS','--noproxy','*','-o','/dev/null','-w','%{http_code}',base+q],capture_output=True,text=True).stdout for q in ['?limit=10','?limit=3','?page=0']]
print('ok' if codes==['422','422','422'] else 'bad')")"
record_body "  旧显式分页仅兼容：?page=2&limit=10 → page=2、items=1 且与整段 items[10:] 相同" \
  "$(py "
import json,subprocess
base='$API/api/archive/dynamics/800300/comments/860001/replies/960013/conversation'
def get(q): return json.loads(subprocess.run(['curl','-sS','--noproxy','*',base+q],capture_output=True,text=True).stdout)
whole=get(''); legacy=get('?page=2&limit=10')
print('ok' if legacy.get('page')==2 and len(legacy['items'])==1 and legacy['items']==whole['items'][10:] else 'bad')")"
record_body "  202 的 9007199254740993123 只有 12 条根评论（卡片间不串页）" \
  "$(py "
import json,subprocess
d=json.loads(subprocess.run(['curl','-sS','--noproxy','*','$API/api/archive/dynamics/9007199254740993123/comments?limit=20'],capture_output=True,text=True).stdout)
print('ok' if len(d['items'])==12 and d.get('next_cursor') is None else 'bad')")"

echo "== 7. 环境 A 无归档图片（限制，不是失败） =="
record_body "  800300 归档 media_sources 全空 → 图片只能走环境 B" \
  "$(py "
import json,subprocess
d=json.loads(subprocess.run(['curl','-sS','--noproxy','*','$API/api/archive/dynamics/800300/comments?limit=20'],capture_output=True,text=True).stdout)
print('ok' if all(not item.get('media_sources') for item in d['items']) else 'bad')")"

echo
for line in "${LINES[@]}"; do echo "$line"; done

python3 - "$OUT" "$FAIL" <<'PY' "${LINES[@]}"
import json, sys, datetime
out, fail = sys.argv[1], sys.argv[2]
lines = sys.argv[3:]
checks = []
for line in lines:
    status = 'pass' if line.startswith('PASS') else 'fail'
    rest = line[6:].strip()
    name, _, detail = rest.partition('  ')
    checks.append({'status': status, 'name': name, 'detail': detail})
json.dump({'kind': 'http-prep-smoke', 'at': datetime.datetime.now().astimezone().isoformat(),
           'fail': fail == '1', 'checks': checks}, open(out, 'w'), ensure_ascii=False, indent=2)
print(('FAILED' if fail == '1' else 'smoke ok') + f' → {out}')
PY
exit "$FAIL"
