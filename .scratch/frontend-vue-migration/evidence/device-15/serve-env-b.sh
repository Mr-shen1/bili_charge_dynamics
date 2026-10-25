#!/usr/bin/env bash
# 票据 15 环境 B：生产装配产物 + 隔离 API（backend/tests/live_app 的固定虚构上游 + 本次独占临时 SQLite）。
#
# 覆盖：管理新增/启停/配置/错误反馈、检查与发现状态读取、真实 API 路径的归档阅读。
# 边界：不启动真实上游采集、不上传 OSS、不改动本机运行实例；这里是 vite preview 的产物服务器，
#       不是 Nginx 交付，也不替代票据 16 的静态交付证据。
#
# 启动后手机与电脑同网段，用浏览器打开脚本打印的 `http://<局域网 IP>:4328/`。
# 停止：Ctrl+C（脚本会一并结束 API 与产物服务器；临时 SQLite 随临时目录由系统清理）。
source "$(dirname "${BASH_SOURCE[0]}")/lan-common.sh"

device15_verify_candidate

api_port=4327
web_port=4328
database_dir=$(mktemp -d -t bili-device15-XXXXXX)
database="$database_dir/monitor.sqlite"

cd "$device15_repo"
device15_spawn env BILI_DATABASE_PATH="$database" uv run --no-sync python -m uvicorn \
  backend.tests.live_app:create_app --factory --host 127.0.0.1 --port "$api_port"

device15_wait_for "http://127.0.0.1:$api_port/api/manage/ups" "隔离 API"

cd "$device15_frontend"
device15_spawn env API_SERVER="http://127.0.0.1:$api_port" pnpm exec vite preview \
  --outDir dist --host 0.0.0.0 --port "$web_port" --strictPort

device15_wait_for "http://127.0.0.1:$web_port/" "生产产物服务器"

api="http://127.0.0.1:$api_port"
echo
echo "环境 B（生产装配 + 隔离 API，端口 $web_port / API $api_port）已就绪："
device15_print_lan "$web_port"
echo
echo "临时 SQLite：$database（本次运行独占，不触碰本机运行实例）"
echo
echo "管理流程用界面操作即可；固定上游的归档种子按需在电脑终端执行，顺序不能颠倒："
echo "  # 0. 先启用监控（界面里点「启用监控」等价于这条；未启用时发现不会被接受）"
echo "  curl -fsS -X PATCH $api/api/manage/ups/202/monitor -H 'content-type: application/json' -d '{\"mode\":\"recent\",\"recent_n\":1,\"enabled\":true}'"
echo "  # 1. 发现（近期 N 条窗口）"
echo "  curl -fsS -X POST $api/api/test/collect -H 'content-type: application/json' -d '{\"action\":\"discover\",\"uid\":\"202\"}'"
echo "  # 2. 检查（登记观察，窗口成员待同步）"
echo "  curl -fsS -X POST $api/api/test/collect -H 'content-type: application/json' -d '{\"action\":\"check\",\"uid\":\"202\"}'"
echo "  # 3. 执行（真实 Collector 节拍，写入归档正文与动态图）"
echo "  curl -fsS -X POST $api/api/test/collect -H 'content-type: application/json' -d '{\"action\":\"execute\"}'"
echo "  # 固定上游失败/恢复：{\"feed\":true} 影响发现，{\"reply\":true} 影响根评论"
echo "  curl -fsS -X POST $api/api/test/source-failure -H 'content-type: application/json' -d '{\"feed\":true}'"
echo
echo "固定上游事实（2026-10-25 实测）："
echo "  - 可新增 202 / 707 / 555；555 是「别的作者」，把 202 的动态关联到 555 会得到归属校验失败。"
echo "  - 新增 303 会得到 PROFILE_UNAVAILABLE（502，无法取得完整公开资料），用来验证真实错误反馈。"
echo "  - 执行上面三步种子后，归档只有一条动态 9007199254740993123，且没有图片（固定上游正文不含媒体）。"
echo "  - 头像地址是 example.invalid，加载失败按应用兜底显示，属预期；归档图片的成功与失败态在环境 A 验证。"
echo
echo "验收清单见 ../15-real-device-acceptance.md 第 7 节（环境 B）。停止：Ctrl+C"
echo
wait
