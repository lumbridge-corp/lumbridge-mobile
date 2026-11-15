#!/usr/bin/env bash
# What CI runs (.github/workflows/ci.yml): the scrub check, the web app, and the server against a throwaway Postgres.
# Needs Rust, Node.js 20+, and PostgreSQL binaries (LUMBRIDGE_PG_BIN: the folder with initdb and pg_ctl).
# The end-to-end and browser suites need lbc and Chrome and are not run here; see the README.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd); cd "$repo"
scripts/scrub-check
(cd web && npm ci --no-audit --no-fund && npx tsc --noEmit && npm test && npm run build)
eval "$(scripts/test-ports.sh)"
export LUMBRIDGE_TEST_PORT LUMBRIDGE_PG_PORT
trap 'scripts/ci-db.sh stop >/dev/null 2>&1 || true' EXIT
scripts/ci-db.sh >/dev/null
cd gateway
LUMBRIDGE_TEST_REQUIRE_DB=1 cargo test --locked
LUMBRIDGE_TEST_REQUIRE_DB=1 cargo test --locked --features dev-identity
cargo clippy --locked --all-targets -- -D warnings
cargo clippy --locked --all-targets --features dev-identity -- -D warnings
echo "ci.sh: all passed"
