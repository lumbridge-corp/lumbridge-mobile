// Ports, and stopping what a run started. Shared by the suites that start servers.
//
// Every port a suite listens on is the port it was given plus a fixed offset from this table, so two runs given different
// bases never share one. scripts/test-ports.sh hands out whole blocks of 50 (aligned, so two blocks never overlap); CI gives each
// group of suites its own 10 of them. Fake services that listen on port 0 get theirs from the OS and need no entry.
//
//   offset  suite             what
//   +0      every suite       its gateway (scripts/dev.sh <port>, or the one it starts itself)
//   +1      client-regress    a second gateway, serving the build that gets swapped under an installed client
//   +1      e2e               the plain listener a TLS gateway must NOT open (nothing should ever answer there)
//   +2      e2e               the off-loopback address each startup guard is given (refused before it binds)
//   +2      infra-verify      the fake Prometheus
//   +3      e2e               a gateway started with no core
//   +4      e2e               a gateway on a hung core
//   +5      e2e               a gateway with short dead-client and idle limits
//   +6      e2e               a gateway with 128 file descriptors
//   +7      offline-verify    a second scratch core (scripts/dev.sh), with no agents on it
//   +9      (highest offset any suite uses; keep it below SPAN)
//
// The throwaway Postgres is separate: LUMBRIDGE_PG_PORT, default 5498 (scripts/ci-db.sh, scripts/dev-db.sh).
export const SPAN = 10;
export const OFFSETS = { gateway: 0, second: 1, plain: 1, guard: 2, prometheus: 2, noCore: 3, hungCore: 4, quick: 5, tight: 6, bare: 7 };

/** The port at `name`'s offset from `base`. */
export function portAt(base, name) {
  const b = Number(base);
  if (!Number.isInteger(b) || b < 1 || b + SPAN > 65535) throw new Error(`not a usable base port: ${base}`);
  if (!(name in OFFSETS)) throw new Error(`no offset called ${name}`);
  return b + OFFSETS[name];
}

/** The throwaway Postgres's port: LUMBRIDGE_PG_PORT, else 5498. */
export const PG_PORT = Number(process.env.LUMBRIDGE_PG_PORT || 5498);

/**
 * Runs `stop` (synchronous) exactly once when the process ends, however it ends: a normal exit, a failure, an uncaught error,
 * or SIGINT / SIGTERM / SIGHUP (exit 128 + signal). Returns `stop`, idempotent, for calling early.
 */
export function stopOnExit(stop) {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    try { stop(); } catch (e) { console.error(`stopping: ${e?.message ?? e}`); }
  };
  process.on("exit", once);
  for (const [sig, n] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]]) {
    process.on(sig, () => { console.error(`${sig}: stopping what this run started`); process.exit(128 + n); });
  }
  return once;
}
