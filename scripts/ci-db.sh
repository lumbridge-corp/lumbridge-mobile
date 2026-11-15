#!/usr/bin/env bash
# The throwaway Postgres for the data tests where Docker isn't an option, such as CI: same password as scripts/dev-db.sh, from
# unpacked binaries, kept under ~/.cache. One server per port, each in its own directory, so runs side by side on one machine
# never touch each other's: a start clears only what a run that died left on ITS port, and stop removes only that one.
#   LUMBRIDGE_PG_BIN=<dir with initdb and pg_ctl> scripts/ci-db.sh        start it
#   scripts/ci-db.sh stop                                               remove it and everything in it
# LUMBRIDGE_PG_PORT picks the port (default 5498); the tests read the same variable.
set -euo pipefail
bin=${LUMBRIDGE_PG_BIN:-$(dirname "$(command -v pg_ctl 2>/dev/null || echo /usr/lib/postgresql/16/bin/pg_ctl)")} port=${LUMBRIDGE_PG_PORT:-5498}
[[ $port =~ ^[0-9]+$ ]] || { echo "LUMBRIDGE_PG_PORT is not a port: $port" >&2; exit 2; }
d=${XDG_CACHE_HOME:-$HOME/.cache}/lumbridge-ci-db-$port
remove() {
  if [ -d "$d/data" ]; then "$bin/pg_ctl" -D "$d/data" -w -m immediate stop >/dev/null 2>&1 || true; fi
  rm -rf "$d"
}
remove
[ "${1:-}" = stop ] && exit 0
# A start that fails part-way, or is interrupted, leaves nothing running.
trap 'rc=$?; [ "$rc" = 0 ] || remove; exit "$rc"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$d"; chmod 700 "$d"; printf lumbridge-throwaway > "$d/pw"
"$bin/initdb" -D "$d/data" -U postgres --pwfile="$d/pw" --auth=scram-sha-256 >/dev/null
"$bin/pg_ctl" -D "$d/data" -w -l "$d/log" -o "-p $port -c listen_addresses=127.0.0.1 -c unix_socket_directories=$d -c fsync=off" start >/dev/null || { cat "$d/log"; exit 1; }
echo "postgres://postgres:lumbridge-throwaway@127.0.0.1:$port/postgres"
