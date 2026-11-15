#!/usr/bin/env bash
# CI only: end every process a CI job left behind, so the next job on this runner starts clean. A cancelled or killed job's
# background processes (scratch cores, fake services, Chrome, Postgres) outlive it, and one held 127.0.0.1:18613 and failed the
# next run's infra-verify ("met another run's gateway", 2026-11-04).
#
# Each of our CI runners runs in its own network namespace (rootlesskit + slirp4netns, which names its interface tap0), and all
# of a job's processes live in it. So: every process of this user in this network namespace that isn't this script or one of its
# ancestors (the job's shell, the runner daemon) belongs to a job, and goes. Run as a job's first step and as its last, always.
#
# It refuses to run anywhere else: outside a runner it would kill your own processes.
#   scripts/ci-reap.sh            TERM, then KILL after 5 s, then report what's left
#   scripts/ci-reap.sh --list     show what it would end, end nothing
set -uo pipefail
if { [ "${GITEA_ACTIONS:-}" != true ] && [ "${GITHUB_ACTIONS:-}" != true ]; } || ! ip -o link show tap0 >/dev/null 2>&1; then
  echo "ci-reap: not inside a CI runner's own network namespace; refusing" >&2
  exit 2
fi
me=$(id -u)
net=$(readlink /proc/self/ns/net)
keep=" "
p=$$
while [ "$p" -gt 1 ] 2>/dev/null; do
  keep+="$p "
  p=$(awk '{print $4}' "/proc/$p/stat" 2>/dev/null) || break
done
victims() {
  local pid
  for d in /proc/[0-9]*; do
    pid=${d#/proc/}
    [ "$pid" = "$BASHPID" ] && continue
    case "$keep" in *" $pid "*) continue ;; esac
    [ "$(stat -c %u "$d" 2>/dev/null)" = "$me" ] || continue
    [ "$(readlink "$d/ns/net" 2>/dev/null)" = "$net" ] || continue
    # The runner's own plumbing, which a job never starts.
    case "$(cat "$d/comm" 2>/dev/null)" in rootlesskit|exe|slirp4netns|gitea-runner) continue ;; esac
    echo "$pid"
  done
}
list=$(victims)
if [ "${1:-}" = --list ]; then
  for pid in $list; do printf '%s %s\n' "$pid" "$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-120)"; done
  exit 0
fi
[ -n "$list" ] || { echo "ci-reap: nothing left behind"; exit 0; }
echo "ci-reap: ending $(echo "$list" | wc -w) leftover processes:"
for pid in $list; do printf '  %s %s\n' "$pid" "$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-120)"; done
kill -TERM $list 2>/dev/null
for _ in 1 2 3 4 5; do sleep 1; list=$(victims); [ -n "$list" ] || break; done
[ -z "$list" ] || kill -KILL $list 2>/dev/null
sleep 0.5
left=$(victims)
if [ -n "$left" ]; then echo "ci-reap: still running: $left" >&2; exit 1; fi
echo "ci-reap: clean"
