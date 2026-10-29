#!/usr/bin/env bash
# 票 10 隔离预览 seed：三个 UP × 一条指定动态，全部写入 $RUNTIME 的隔离 SQLite。
# 依据：frontend/tests/e2e-location/integrated-reading.spec.ts:9-53 的 beforeAll 形状。
# 只走 live_app 的仅测试夹具与真实归档写接口；不启动 collector/notifier，不连真实上游。
set -euo pipefail

API="${API:-http://127.0.0.1:4180}"
CURL=(curl -sS --noproxy '*' -H 'content-type: application/json')

post() { "${CURL[@]}" -XPOST "$API$1" -d "$2"; echo; }
patch() { "${CURL[@]}" -XPATCH "$API$1" -d "$2"; echo; }

# 1. 先登记仅测试用的虚构根评论/楼中楼（只改本进程夹具，不写库）。
#    800300 → 45 条根评论，首个根 860001 带 25 条回复（对话入口 960013 → 11 条）。
post /api/test/root-comments '{"dynamic":"800300"}'
#    9007199254740993123 → 12 条根评论（用不同条数证明卡片之间不共用状态）。
post /api/test/root-comments '{"dynamic":"9007199254740993123","size":12}'
#    900707 → 45 条根评论，第二页楼 860030 带 25 条回复。
post /api/test/root-comments '{"dynamic":"900707"}'
post /api/test/replies '{"dynamic":"800300","root":"860001"}'
post /api/test/replies '{"dynamic":"900707","root":"860030"}'

# 2. 三个 UP：登记 → 指定监控 → 目标 → 真实初始化归档（808→800300 / 202→…123 / 707→900707）。
for pair in 808:800300 202:9007199254740993123 707:900707; do
  uid=${pair%%:*}
  dynamic=${pair##*:}
  post "/api/manage/ups" "{\"uid\":\"$uid\"}"
  patch "/api/manage/ups/$uid/monitor" '{"mode":"specified","recent_n":10,"enabled":true}'
  post "/api/manage/ups/$uid/targets" "{\"id\":\"$dynamic\"}"
  # 期望 {"processed":1,"succeeded":1}；失败会在这里暴露。
  post "/api/sync/initial" "{\"uid\":\"$uid\"}"
done

# 3. 让「检查 / 发现」面板有虚构记录（仍是 MockTransport 上游，无真实请求）。
post /api/test/collect '{"action":"check","uid":"808"}'
post /api/test/collect '{"action":"discover","uid":"808"}'

# 4. 自检：上游请求计数应只含少量 profile/reply，与“只读归档”无关。
"${CURL[@]}" "$API/api/test/source-requests"; echo
