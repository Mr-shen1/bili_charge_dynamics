#!/usr/bin/env bash
# Invoked by run.sh in an allowlisted environment, from the repository root.
set -euo pipefail
out=.scratch/backend-integration/evidence/automated-32
visual="$out/visual"
server_log="$out/preview-server.log"
if [[ -e "$visual" || -e "$server_log" ]]; then
  attempt_id=$(date +%Y%m%dT%H%M%S)
  visual="$out/visual-$attempt_id"
  server_log="$out/preview-server-$attempt_id.log"
fi
# Do not reuse or stop the developer's #35 preview on ports 8000/18443.
uv run --no-sync python -m scripts.visual_preview \
  --port 19080 --asset-port 19443 --frontend-dir dist > "$server_log" 2>&1 &
pid=$!
cleanup() {
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
trap cleanup EXIT
ready=0
for (( attempt=0; attempt<180; attempt++ )); do
  if ! kill -0 "$pid" 2>/dev/null; then
    printf 'Isolated preview exited before readiness; see %s\n' "$server_log" >&2
    exit 1
  fi
  # Readiness must belong to this process, not an existing service on that port.
  if grep -Fq 'Uvicorn running on https://127.0.0.1:19443' "$server_log" && \
    curl --noproxy '*' --fail --silent --insecure \
      https://127.0.0.1:19443/api/archive/ups >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if (( ready == 0 )); then printf 'Isolated preview readiness timed out\n' >&2; exit 1; fi
VISUAL_PREVIEW_URL=https://127.0.0.1:19443 \
VISUAL_OUTPUT_DIR="$visual" node scripts/capture-visual-35.mjs
