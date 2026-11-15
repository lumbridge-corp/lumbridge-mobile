#!/usr/bin/env bash
# A complete local Lumbridge Mobile against a SCRATCH core, never a real one.
#   scripts/dev.sh <port>   starts it (needs web/dist: cd web && npm run build) and prints the URL
#   scripts/dev.sh <port> stop
# Built with the dev-identity feature: no tailnet check, loopback only. Extra env passes through to the gateway.
set -euo pipefail
port=${1:?port}; repo=$(cd "$(dirname "$0")/.." && pwd); d=/run/user/$(id -u)/k$port
clean=(env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT
  LBC_SESSION=k XDG_STATE_HOME="$d/s" XDG_RUNTIME_DIR="$d" XDG_CONFIG_HOME="$d/c" XDG_DATA_HOME="$d/d")
if [ "${2:-}" = stop ]; then
  [ -f "$d/gw.pid" ] && kill "$(cat "$d/gw.pid")" 2>/dev/null || true
  "${clean[@]}" lbc server stop >/dev/null 2>&1 || true
  rm -rf "$d"; exit 0
fi
# A start that fails part-way, or is interrupted, leaves nothing running: no core, no gateway, no scratch dirs.
trap 'rc=$?; [ "$rc" = 0 ] || "$repo/scripts/dev.sh" "$port" stop; exit "$rc"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$d/state"; chmod 700 "$d"
[ -s "$d/token" ] || python3 -I -c 'import secrets;print(secrets.token_urlsafe(32))' > "$d/token"
(cd "$repo/gateway" && cargo build --features dev-identity 2>&1 | tail -1)
"${clean[@]}" lbc run --bg --name demo-shell bash >/dev/null 2>&1 || true  # already there when only the gateway restarts
# dev-identity only: registers $d/token as a device, since a real pairing code works once and scripts reuse this.
LUMBRIDGE_STATE_DIR="$d/state" "$repo/gateway/target/debug/lumbridge-mobile-server" dev-add dev < "$d/token"
# An instance's own screens may want settings of their own (tests/ext/dev-env.sh, not part of the public tree; it may use $d).
[ -f "$repo/tests/ext/dev-env.sh" ] && . "$repo/tests/ext/dev-env.sh"
LUMBRIDGE_LOGIN=dev@example.com LUMBRIDGE_ORIGINS="http://127.0.0.1:$port" \
  LUMBRIDGE_BIND="127.0.0.1:$port" LUMBRIDGE_WEB="$repo/web/dist" LUMBRIDGE_STATE_DIR="$d/state" \
  nohup "${clean[@]}" "$repo/gateway/target/debug/lumbridge-mobile-server" >"$d/gw.log" 2>&1 &
echo $! > "$d/gw.pid"
echo "http://127.0.0.1:$port/#token=$(cat "$d/token")"
echo "scratch core env: ${clean[*]:6}   log: $d/gw.log"
