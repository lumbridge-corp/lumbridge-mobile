#!/usr/bin/env bash
# The browser suites, for CI: every one runs, each against its own scratch core and fixture (scripts/dev.sh, scripts/dev-fixture.sh),
# and a failure in one doesn't hide the next. Needs web/dist and tests/node_modules. Real cores are never touched.
# Not here: push-browser. Its "turn on" does a real subscribe, which needs Chrome's push service; on a runner that reaches only Gitea, Chrome
# neither finishes nor fails. Run it by hand where that's open. tests/push-e2e.mjs covers the server side with a fake push service.
#   scripts/ci-browser.sh <port> [suite ...]     default: all of them
# ui-verify-storm, never in the default: ui-verify with --storm (30 terminals storming at 4x CPU), the way to run that timing check.
# Uses <port> and <port>+1 (tests/ports.mjs). The data suites use the throwaway Postgres on LUMBRIDGE_PG_PORT (default 5498).
# Ctrl-C or SIGTERM ends the running suite and stops its scratch core and fixture before exiting.
set -uo pipefail
port=${1:?port}; shift
repo=$(cd "$(dirname "$0")/.." && pwd); cd "$repo"
failed=()
stamp() { printf '=== %s %s (%ss)\n' "$1" "$2" "$SECONDS"; }
# A suite runs in the background and is waited for, so a signal reaches this script at once rather than after the suite.
# Job control on: without it, bash starts a background command with SIGINT and SIGQUIT ignored, the scratch core started from
# it inherits that, and so does every terminal it runs, so a fake agent couldn't be stopped with Ctrl-C (ui-verify "two taps
# send Ctrl-C" stayed live, runs 12795 and 12804). With -m each step is its own process group and keeps default signals.
set -m
child=
tree() { local p; for p in $(pgrep -P "$1" 2>/dev/null); do tree "$p"; done; echo "$1"; }
run() { "$@" & child=$!; wait "$child"; local rc=$?; child=; return "$rc"; }
stop_all() {
  if [ -n "$child" ]; then
    local pids; pids=$(tree "$child")
    kill -TERM $pids 2>/dev/null
    # The suite's own handler stops what it started; give it up to 10 s, then end whatever of it is left.
    for _ in $(seq 1 20); do kill -0 $pids 2>/dev/null || break; sleep 0.5; done
    kill -KILL $pids 2>/dev/null
  fi
  scripts/dev-fixture.sh "$port" stop >/dev/null 2>&1 || true
  scripts/dev.sh "$port" stop >/dev/null 2>&1 || true
}
trap 'echo "interrupted: stopping what is running on $port"; stop_all; exit 130' INT
trap 'echo "terminated: stopping what is running on $port"; stop_all; exit 143' TERM HUP
# A suite is tests/<name>.mjs, or tests/ext/<name>.mjs for an instance's own screens (not part of the public tree).
suite() { if [ -f "tests/$1.mjs" ]; then echo "tests/$1.mjs"; else echo "tests/ext/$1.mjs"; fi; }
scratch() { # suite [file [arg ...]]: the documented setup, run, teardown
  local name=$1 file=${2:-$1} rc=0
  shift; [ $# -gt 0 ] && shift
  stamp "$name" start
  run scripts/dev.sh "$port" >/dev/null && run scripts/dev-fixture.sh "$port" >/dev/null || rc=$?
  if [ "$rc" = 0 ]; then run node "$(suite "$file")" "$port" "$@" || rc=$?; else echo "setup failed for $name: $rc"; fi
  scripts/dev-fixture.sh "$port" stop >/dev/null 2>&1 || true
  scripts/dev.sh "$port" stop >/dev/null 2>&1 || true
  stamp "$name" "exit $rc"
  [ "$rc" = 0 ] || failed+=("$name")
}
xvfb() { # suite: starts what it needs by itself, under a display
  local name=$1 rc=0
  stamp "$name" start
  PW_DIR=$repo/tests SHOTS=$(mktemp -d) run xvfb-run -a node "$(suite "$name")" "$port" || rc=$?
  stamp "$name" "exit $rc"
  [ "$rc" = 0 ] || failed+=("$name")
}
own() { # suite: starts its own gateway and fake speech, on the throwaway Postgres (scripts/ci-db.sh or scripts/dev-db.sh)
  local name=$1 rc=0
  stamp "$name" start
  run node "$(suite "$name")" "$port" || rc=$?
  stamp "$name" "exit $rc"
  [ "$rc" = 0 ] || failed+=("$name")
}
if [ $# -eq 0 ]; then
  set -- finding-verify ui-verify apps-verify palette-verify answer-verify terminal-verify offline-verify drafts-verify thoughts-verify foryou-verify proposals-verify today-verify files-verify assistant-verify design-verify layout-verify lists-offline-verify speed-verify
  for f in tests/ext/*-verify.mjs; do [ -f "$f" ] && [ "$(basename "$f")" != infra-verify.mjs ] && set -- "$@" "$(basename "$f" .mjs)"; done
fi
# Plain if/elif, not `case`: the factory's policy hook can't read a case pattern, and a builder that changes this script must
# still be able to run it. The kinds: under a display (xvfb), starts its own gateway (own), else a scratch core.
is() { local x=$1; shift; for k in "$@"; do [ "$x" = "$k" ] && return 0; done; return 1; }
for s in "$@"; do
  if is "$s" drafts-verify push-browser; then xvfb "$s"
  elif is "$s" ui-verify-storm; then scratch "$s" ui-verify --storm
  elif is "$s" thoughts-verify foryou-verify proposals-verify today-verify cars-verify files-verify music-verify social-verify tv-verify tvwall-verify library-verify lumbridge-verify assistant-verify design-verify layout-verify lists-offline-verify; then own "$s"
  else scratch "$s"
  fi
done
if [ ${#failed[@]} -gt 0 ]; then echo "FAILED: ${failed[*]}"; exit 1; fi
echo "all browser suites passed (${SECONDS}s)"
