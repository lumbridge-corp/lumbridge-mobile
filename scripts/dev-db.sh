#!/usr/bin/env bash
# The throwaway Postgres for the data tests: container lumbridge-dev-db, 127.0.0.1:5498.
#   scripts/dev-db.sh        start it (idempotent)
#   scripts/dev-db.sh stop   remove it and everything in it
# LUMBRIDGE_PG_PORT=<port> gives a second one beside it, container lumbridge-dev-db-<port>; the tests read the same variable.
set -euo pipefail
port=${LUMBRIDGE_PG_PORT:-5498}
[[ $port =~ ^[0-9]+$ ]] || { echo "LUMBRIDGE_PG_PORT is not a port: $port" >&2; exit 2; }
name=lumbridge-dev-db; [ "$port" = 5498 ] || name=lumbridge-dev-db-$port
if [ "${1:-}" = stop ]; then docker rm -f "$name" >/dev/null 2>&1 || true; exit 0; fi
if ! docker ps --format '{{.Names}}' | grep -qx "$name"; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --restart no --tmpfs /var/lib/postgresql/data \
    -e POSTGRES_PASSWORD=lumbridge-throwaway -p "127.0.0.1:$port:5432" postgres:17 >/dev/null
fi
for _ in $(seq 1 30); do
  docker exec "$name" pg_isready -U postgres -q && docker exec "$name" psql -U postgres -Atqc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
echo "postgres://postgres:lumbridge-throwaway@127.0.0.1:$port/postgres"
