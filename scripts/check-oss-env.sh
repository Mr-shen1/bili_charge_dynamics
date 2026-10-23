#!/usr/bin/env bash
# 校验 systemd 环境文件里的阿里云 OSS 配置，只报告结论，绝不打印密钥。
#
# 用法：
#     sudo scripts/check-oss-env.sh [env_file] [app_dir]
# 默认：/etc/bili-monitor/env、/srv/bili-monitor/app
#
# 退出码：0 有效或未启用；1 配置无效；2 读不到环境文件。
# 只构造 OSSUploader，不做任何网络请求，因此不会把假配置当成真实连通性。
set -euo pipefail

env_file=${1:-/etc/bili-monitor/env}
app_dir=${2:-/srv/bili-monitor/app}

[[ -r $env_file ]] || { echo "需要 root 读取 $env_file" >&2; exit 2; }
[[ -x $app_dir/.venv/bin/python ]] || { echo "找不到 $app_dir/.venv/bin/python" >&2; exit 2; }

set -a
# 只取 BILI_OSS_* 赋值行注入子进程，其余变量与环境无关，不进环境。
# shellcheck disable=SC1090
source <(grep -E "^BILI_OSS_[A-Za-z0-9_]+=" "$env_file" || true)
set +a

cd "$app_dir"
# 以只读方式校验，禁止写 .pyc，避免以 root 运行时污染仓库属主。
export PYTHONDONTWRITEBYTECODE=1
exec "$app_dir/.venv/bin/python" - <<'PY'
import os

from backend.bili_monitor.oss import OSSUploader

present = sorted(name for name in os.environ if name.startswith("BILI_OSS_"))
try:
    uploader = OSSUploader.from_environment()
except ValueError as error:
    print(f"OSS 配置无效：{error}")
    print(f"已生效的变量：{len(present)} 个（需要六项非空，SECURITY_TOKEN 可选）")
    raise SystemExit(1)
if uploader is None:
    print("OSS 未启用：未检测到任何 BILI_OSS_* 变量（全部注释即停用，属正常状态）")
else:
    print("OSS 配置有效：启动后媒体上传会启用")
PY
