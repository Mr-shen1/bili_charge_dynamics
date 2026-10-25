#!/usr/bin/env bash
# 票据 15 环境 A：把 mock 自检产物发布到局域网，供 Linux Chrome 与 iPhone Safari 实测。
#
# 覆盖：全部/单 UP 阅读、卡片与评论入口、排序/追加、宽屏回复与窄屏楼中楼、返回恢复、
#       长图、图片切换/关闭/工具栏、混合失败与局部重试、预览焦点与历史、滚动恢复、触控尺寸。
# 不覆盖：管理流程（生产装配才有真实管理接口，见 serve-env-b.sh）。
#
# 启动后手机与电脑同网段，用 Safari 打开脚本打印的 `http://<局域网 IP>:4318/`。
# 停止：Ctrl+C（脚本会一并结束夹具服务器与静态产物服务器）。
source "$(dirname "${BASH_SOURCE[0]}")/lan-common.sh"

device15_verify_candidate

image_port=4319
web_port=4318

cd "$device15_frontend"
device15_spawn env IMAGE_SERVER_PORT=$image_port node server/imageServer.mjs
device15_spawn pnpm exec vite preview --outDir dist-mock --host 0.0.0.0 --port "$web_port" --strictPort

device15_wait_for "http://127.0.0.1:$image_port/images/thumb/single-1.svg" "图片夹具服务器"
device15_wait_for "http://127.0.0.1:$web_port/" "自检产物服务器"

echo
echo "环境 A（mock 自检装配，端口 $web_port / 夹具 $image_port）已就绪："
device15_print_lan "$web_port"
echo
echo "验收清单见 ../15-real-device-acceptance.md 第 5 节（环境 A），要点："
echo "  - 阅读：全部/单 UP 列表、卡片、评论入口、排序与追加、宽屏回复或窄屏楼中楼、返回恢复"
echo "  - 图片：/__preview-fixtures 的单图/十二图/长图/成功与异常混合/未上传组"
echo "  - 归档图片：第 1、2、3、4、6、7 条动态的 4/1/9/12/长图/2 图组"
echo "  - 停止：Ctrl+C"
echo
wait
