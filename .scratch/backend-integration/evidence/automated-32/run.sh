#!/usr/bin/env bash
# Run from the repository root, after `source ~/.nvm/nvm.sh && nvm use`.
# Test dependencies/browser must already be installed; never inject real credentials.
# Run phases sequentially: Vite caches and Playwright test-results are shared.
set -uo pipefail
out=.scratch/backend-integration/evidence/automated-32
mkdir -p "$out"
failed=0

# Deliberately allowlist the environment: do not read .env or inherit OSS,
# database, proxy, source credentials, or developer fixture overrides.
run_isolated() {
  env -i HOME="$HOME" PATH="$PATH" LANG=C.UTF-8 TZ=Asia/Shanghai \
    NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
    NGINX_BIN="${NGINX_BIN:-nginx}" \
    NGINX_MIME_TYPES="${NGINX_MIME_TYPES:-/etc/nginx/mime.types}" "$@"
}
run() {
  local name=$1
  shift
  # Preserve previous attempts, including failures, instead of overwriting evidence.
  if [[ -e "$out/$name.log" ]]; then name="$name-$(date +%Y%m%dT%H%M%S)"; fi
  {
    printf 'started_at=%s\n' "$(date -Is)"
    printf 'source_commit=%s\n' "$(git rev-parse HEAD)"
    printf -v command '%q ' "$@"
    printf 'command=%s\n' "${command% }"
    if [[ $name == delivery* ]]; then
      printf 'nginx_bin=%s\nnginx_mime_types=%s\n' \
        "${NGINX_BIN:-nginx}" "${NGINX_MIME_TYPES:-/etc/nginx/mime.types}"
    fi
    run_isolated "$@"
    result=$?
    printf '\nexit_code=%s\nfinished_at=%s\n' "$result" "$(date -Is)"
    exit "$result"
  } 2>&1 | tee "$out/$name.log"
  local statuses=("${PIPESTATUS[@]}")
  local result=${statuses[0]}
  if (( result == 0 && statuses[1] != 0 )); then result=${statuses[1]}; fi
  if ! printf '%s\t%s\n' "$name" "$result" >> "$out/results.tsv"; then result=1; fi
  if (( result != 0 )); then failed=1; fi
  return "$result"
}

# Each phase retains its failures and continues to the next command.
case "${1:-}" in
  targeted)
    run targeted-backend uv run --no-sync pytest backend/tests/test_integrated_archive_lifecycle.py backend/tests/test_inflight_lifecycle.py backend/tests/test_versioned_edit_sync.py backend/tests/test_comment_count_sync.py -q
    run targeted-processes uv run --no-sync pytest backend/tests/test_deployment_processes.py -q
    ;;
  quality)
    run typecheck pnpm typecheck
    run build pnpm build
    ;;
  browsers)
    run e2e-mock pnpm test:e2e
    run e2e-manage pnpm test:e2e:manage
    run e2e-archive pnpm test:e2e:archive
    ;;
  preview)
    run e2e-preview pnpm test:e2e:preview
    ;;
  capture)
    run capture bash "$out/capture.sh"
    ;;
  visual)
    run visual pnpm exec playwright test --config playwright.visual.config.ts
    ;;
  delivery)
    run delivery pnpm test:delivery
    ;;
  full)
    run backend-full uv run --no-sync pytest backend/tests -q
    run frontend-full pnpm test --maxWorkers=2
    run typecheck-final pnpm typecheck
    ;;
  *) printf 'Usage: bash %s {targeted|quality|browsers|preview|visual|capture|delivery|full}\n' "$0" >&2; exit 2 ;;
esac
# The phase fails if any of its commands failed, independently of other phases.
exit "$failed"
