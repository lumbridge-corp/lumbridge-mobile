#!/usr/bin/env bash
# Fills a scratch Lumbridge Mobile (scripts/dev.sh <port>) with believable agents. Never touches a real core.
#   scripts/dev-fixture.sh <port>            terminals on this core, plus scratch "lab" and "rig" cores
#   scripts/dev-fixture.sh <port> --storm N  also N terminals emitting titles and status as fast as a busy fleet
# Stop everything with scripts/dev-fixture.sh <port> stop, then scripts/dev.sh <port> stop.
set -euo pipefail

self=$(readlink -f "$0"); repo=$(cd "$(dirname "$self")/.." && pwd)

# ---- the fake agent, re-executed as: dev-fixture.sh --agent <mode> ----
if [ "${1:-}" = --agent ]; then
  mode=$2
  b64() { printf %s "$1" | base64 -w0; }
  # OSC 7501, the Program Status Protocol: state=...:kind=...:progress=...:app=...:title=<b64>:msg=<b64>
  say() { printf '\033]7501;%s\033\\' "$1"; }
  rep() { # rep <char> <n>
    local s; printf -v s '%*s' "$2" ''; printf %s "${s// /$1}"
  }
  W=${COLUMNS:-220}
  wide_para() {
    printf '\033[1;38;5;209m●\033[0m The gateway forwards only the methods in ALLOWED, so a stolen page cannot run a shell; \033[36msrc/ws.rs\033[0m keeps that list next to the frame encoder, which makes it easy to review, and the tests in \033[36mtests/e2e.mjs\033[0m prove each refusal against a scratch core rather than a mock.\n'
    printf '  I checked the three call sites. The one in \033[33mauth.rs\033[0m was reading the token before the origin check, which is harmless today but reads wrong, so I swapped them and added a test that a foreign origin never gets as far as a token comparison.\n'
    printf '\n'
  }
  box() { # box <width> <lines...>
    local w=$1; shift
    printf '\033[38;5;173m╭'; rep ─ $((w-2)); printf '╮\033[0m\n'
    for l in "$@"; do printf '\033[38;5;173m│\033[0m %-*s \033[38;5;173m│\033[0m\n' $((w-4)) "$l"; done
    printf '\033[38;5;173m╰'; rep ─ $((w-2)); printf '╯\033[0m\n'
  }
  history_lines() { for i in $(seq 1 "$1"); do printf '\033[2m%4d\033[0m  build step %d of %d: compiled crate number %d with a line long enough to need panning on any phone, which is the whole point of this fixture line, and it keeps going past where a phone gives up entirely\n' "$i" "$i" "$1" "$i"; done; }
  case "$mode" in
    permission)
      say "state=working:app=claude-code"; sleep 1; history_lines 120; wide_para; wide_para
      box 200 "Edit file: gateway/src/ws.rs" "" "  - const ALLOWED: &[&str] = &[\"terminal.list\", \"terminal.get\"];" "  + const ALLOWED: &[&str] = &[\"terminal.list\", \"terminal.get\", \"terminal.read\"];"
      printf ' Do you want to make this edit to \033[1mws.rs\033[0m?\n  \033[36m❯ 1. Yes\033[0m\n    2. Yes, allow all edits during this session (shift+tab)\n    3. No, and tell Claude what to do differently (esc)\n'
      say "state=blocked:kind=permission:app=claude-code:msg=$(b64 'Apply this edit to gateway/src/ws.rs?')"
      stty -echo -icanon 2>/dev/null || true
      while IFS= read -r -n1 k; do
        case "$k" in
          1|2) printf '\n\033[32m✓\033[0m Edit applied.\n'; say "state=working:app=claude-code"; sleep 1.5; say "state=done:app=claude-code"; ;;
          3) printf '\nOK, tell me what to change.\n'; say "state=idle:app=claude-code" ;;
          *) printf '[key %q]\n' "$k" ;;
        esac
      done ;;
    two-choices)
      printf ' Run the migration now?\n  \033[36m❯ 1. Yes\033[0m\n    2. No\n'
      say "state=blocked:kind=question:app=claude-code"; sleep 100000 ;;
    late-menu)
      # The status comes first and the menu paints after it, as a busy TUI can.
      say "state=blocked:kind=question:app=claude-code"; sleep 2
      printf ' Which one?\n  1. First\n  2. Second\n  3. Third\n  4. Fourth\n'; sleep 100000 ;;
    question)
      say "state=working:app=claude-code"; sleep 1; wide_para
      box 120 "Which branch should this PR target?" "" "❯ 1. main" "  2. feature/native-factory" "  3. Something else"
      printf '  esc to cancel · tab to amend\n'
      say "state=blocked:kind=question:app=claude-code"; sleep 100000 ;;
    auth)
      say "state=working"; sleep 1; printf 'Refreshing credentials for gpu-box...\nSign in again to continue? Open https://login.example/device and enter ABCD-1234\n'
      say "state=blocked:kind=auth:app=codex:msg=$(b64 'Sign in again to continue')"; sleep 100000 ;;
    error)
      say "state=working"; sleep 1; printf '\033[31mfatal:\033[0m cargo test failed: 3 tests failed in mobile-gateway (exit 101)\n'
      say "state=error:app=codex:msg=$(b64 'cargo test failed: 3 tests failed in mobile-gateway')"; sleep 100000 ;;
    stream)
      say "state=working:app=claude-code:progress=0"; n=0
      while :; do
        n=$((n+1))
        printf '\033[2m%s\033[0m  \033[36m%-18s\033[0m worker %d handled event %d and wrote %d bytes to the ledger, then carried on with a long line that shows how output wider than a phone behaves while it streams past\n' "$(date +%H:%M:%S)" "$(printf 'task-%d' $((n%7)))" $((n%5)) "$n" $((n*37%4096))
        [ $((n%10)) = 0 ] && say "state=working:app=claude-code:progress=$((n%100))"
        sleep 0.35
      done ;;
    working)
      say "state=working:app=claude-code"; wide_para
      printf '\033[38;5;209m✻\033[0m Thinking… \033[2m(esc to interrupt)\033[0m\n'; sleep 100000 ;;
    done)
      say "state=working:app=claude-code"; sleep 1; wide_para; printf 'All 42 tests pass. PR is ready for review.\n'
      say "state=done:app=claude-code"; sleep 100000 ;;
    idle)
      say "state=working:app=claude-code"; sleep .5; printf 'Finished earlier. Nothing to do.\n'; say "state=idle:app=claude-code"; sleep 100000 ;;
    chat)
      say "state=idle:app=claude-code"; printf 'Ready. Send me something.\n> '
      while IFS= read -r line; do
        say "state=working:app=claude-code"; sleep .4; printf 'You said: %s\n> ' "$line"; say "state=done:app=claude-code"
      done ;;
    tui)
      say "state=working:app=htop"
      printf '\033[?1049h\033[2J'
      while :; do
        printf '\033[H\033[7m %-*s\033[0m\n' $((W-2)) "fake-top  $(date +%T)  a full screen app on the alternate screen, $W columns wide"
        for i in $(seq 1 12); do printf ' %3d  %-20s %5d%%  %s\n' "$i" "worker-$i" $((RANDOM%100)) "$(rep '|' $((RANDOM%60)))$(rep ' ' 60)"; done
        sleep 1
      done ;;
    long-title)
      printf '\033]0;✳ Refactor the authentication middleware so the device token check happens before anything else reads the request\007'
      say "state=working:app=claude-code"; wide_para; sleep 100000 ;;
    storm)
      i=0
      while :; do
        i=$((i+1))
        printf '\033]0;⠂ storm turn %d\007' $((i/20))
        [ $((i%20)) = 0 ] && say "state=working:app=claude-code"
        [ $((i%20)) = 10 ] && say "state=done:app=claude-code"
        printf 'tick %d\n' "$i"
        sleep 0.1
      done ;;
    *) echo "unknown mode $mode"; exit 2 ;;
  esac
  exit 0
fi

# ---- set up ----
port=${1:?port}; d=/run/user/$(id -u)/k$port
[ -d "$d" ] || { echo "start it first: scripts/dev.sh $port"; exit 1; }
# Strip every CLAUDE* variable: rule 7, an agent's environment must never reach a core.
unsets=(); while IFS= read -r v; do unsets+=(-u "$v"); done < <(compgen -e | grep '^CLAUDE' || true)
base=(env "${unsets[@]}" XDG_STATE_HOME="$d/s" XDG_RUNTIME_DIR="$d" XDG_CONFIG_HOME="$d/c" XDG_DATA_HOME="$d/d")
hc_local=("${base[@]}" LBC_SESSION=k lbc)

if [ "${2:-}" = stop ]; then
  for t in $("${hc_local[@]}" ls --json 2>/dev/null | python3 -I -c 'import json,sys
for x in json.load(sys.stdin)["terminals"]:
  if x["address"]!="t1": print(x["address"])' || true); do "${hc_local[@]}" kill "$t" >/dev/null 2>&1 || true; done
  # Forget the machines first: core redials a lost machine, and that hc connect would start the fixture core again.
  for m in lab rig; do "${hc_local[@]}" machine rm "$m" >/dev/null 2>&1 || true; done
  for s in fx-lab fx-rig; do "${base[@]}" LBC_SESSION=$s lbc server stop >/dev/null 2>&1 || true; done
  exit 0
fi
# A setup that fails part-way, or is interrupted, takes down what it had started (the fixture's terminals and cores, not dev.sh's).
trap 'rc=$?; [ "$rc" = 0 ] || "$self" "$port" stop; exit "$rc"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cwd() { [ -d "$1" ] && echo "$1" || echo "$repo"; }
R=$HOME/repos/gitea; W=$HOME/worktrees/studio
started=()
run() { # run <core: here|lab|rig> <name or -> <mode> <cwd> [labels...]
  local on=$1 name=$2 mode=$3 dir; dir=$(cwd "$4"); shift 4
  local a=(run --bg --no-parent --cwd "$dir")
  [ "$name" != - ] && a+=(--name "$name")
  [ "$on" != here ] && a+=(--on "$on")
  for l in "$@"; do a+=(--label "$l"); done
  local out; out=$("${hc_local[@]}" "${a[@]}" "$self" --agent "$mode" 2>&1 | tail -1) || { echo "run failed: $out"; return 1; }
  started+=("$out")
}

# Two more scratch cores stand in for the other machines, with the real `machine/t7` addressing.
# (Not named after the host it runs on: core refuses a machine named after its own host.)
for m in lab rig; do
  s=fx-$m
  "${hc_local[@]}" machine ls 2>/dev/null | grep -q "\"$m\"" && continue
  "${base[@]}" LBC_SESSION=$s lbc ls 2>/dev/null | grep -q keeper || "${base[@]}" LBC_SESSION=$s lbc run --bg --name keeper sleep 1000000 >/dev/null
  # `--via` gets a shell line as its last argument, like ssh. Here "there" is this box, same scratch dirs.
  "${hc_local[@]}" machine add --name "$m" --session "$s" --via "env ${unsets[*]} XDG_STATE_HOME=$d/s XDG_RUNTIME_DIR=$d XDG_CONFIG_HOME=$d/c XDG_DATA_HOME=$d/d sh -c" >/dev/null
done
sleep 1

seen=lumbridge.seen=0
run here         gateway-review  permission "$W/ui"                 "$seen" lumbridge.pinned=1
run here         -               long-title "$R/mobile-app"      "$seen"
run here         pr-branch       question   "$R/assistant"             "$seen"
run here         web-tests       done       "$W/data"               "$seen"
run here         chat-agent      chat       "$W/assistant"             "$seen"
run here         docs-pass       idle       "$R/assistant-core/docs"   "lumbridge.seen=9"
run lab        acme-api     stream     "$R/acme"            "$seen"
run lab        token-refresh   auth       "$R/mobile-app"      "$seen"
run lab        top             tui        "$HOME"                 "$seen"
run lab        ledger-import   done       "$R/acme"            "$seen"
run rig      factory-batch     working    "$R/batch"                "$seen"
run rig      ci-gateway      error      "$W/push"               "$seen"
run rig      muxin-render    working    "$R/muxin"              "$seen"
run rig      nightly-archive idle       "$R/factory"            "lumbridge.seen=9" lumbridge.pinned=1
"${hc_local[@]}" run --bg --no-parent --name scratch-shell --cwd "$repo" bash >/dev/null
"${hc_local[@]}" run --bg --no-parent --on rig --name rig-shell --cwd "$repo" bash >/dev/null

if [ "${2:-}" = --storm ]; then
  for i in $(seq 1 "${3:?how many}"); do run here "storm-$i" storm "$repo" "$seen"; done
fi

# A desktop's size for most of them, held by a viewer as a real desktop would.
sleep 1.5
"${hc_local[@]}" run --bg --no-parent --name desktop-viewer --cwd "$repo" node "$repo/scripts/dev-fixture-viewer.mjs" "$port" "$d/token" >/dev/null
echo "fixture up on port $port: ${#started[@]} agents"
