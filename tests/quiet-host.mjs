// Timing checks at 4x CPU measure only on a quiet host (#74, #79). Shared by speed-verify, terminal-verify, ui-verify and layout-verify.
// A busy host measures the host, not the app. Two lines, both a 1-minute load per core (unset or empty means the default):
// - LUMBRIDGE_SPEED_QUIET (default 0.5) x cores, the line our CI scaler starts a runner at: each group waits for it before it measures.
// - LUMBRIDGE_SPEED_STRICT (default 0.125) x cores, 4.0 on our 32-core CI host: used only to judge. That host's efficiency cores and shared hyperthreads
//   slow a renderer long before the load nears the quiet line (#83's CI 13480 failed at 3.7-7.2 on 32).
// A run is busy if its load was above the strict line or the suite's own cgroup was throttled during it (cpu.stat throttled_usec went
// up; "throttle n/a" where that can't be read). A timed check that fails with any busy run is measured once more after waiting for
// the strict line, and the second result counts; both are printed. A failure in which every run was strict-quiet and unthrottled is
// real and fails at once. All waiting is polled every 5 s out of one 8-minute budget for the suite. A group that can't be measured
// within it FAILs as "host busy" (or "host busy (strict)" for the second measurement): nothing is skipped or passed for it.
// Limits and run counts stay each suite's own.
import { readFileSync } from "node:fs";
import os from "node:os";

/** The suite's failures so far: a live binding, so `failed` read after the checks is their count. */
export let failed = 0;
export const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const CORES = os.cpus().length;
const perCore = (name, dflt) => {
  const raw = process.env[name];
  const x = raw === undefined || raw.trim() === "" ? dflt : Number(raw);
  if (!Number.isFinite(x) || x < 0) { console.error(`${name} is a number per core, not ${raw}`); process.exit(2); }
  return x * CORES;
};
export const QUIET = perCore("LUMBRIDGE_SPEED_QUIET", 0.5);
export const STRICT = perCore("LUMBRIDGE_SPEED_STRICT", 0.125);
const POLL_MS = 5000;
let budgetMs = 8 * 60 * 1000;
export const load = () => os.loadavg()[0]; // host-wide, even inside the runner's netns
export const fmt = (x) => x.toFixed(2);
const onHost = (x) => `load ${fmt(x)} on ${CORES} cores`;

// The suite's own cgroup (v2): Chrome's renderers are its children, so they're in it too. null where it can't be read.
const cpuStat = (() => {
  try {
    const path = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((l) => l.startsWith("0::"))?.slice(3);
    return path === undefined ? null : `/sys/fs/cgroup${path === "/" ? "" : path}/cpu.stat`;
  } catch { return null; }
})();
const throttledUs = () => {
  if (!cpuStat) return null;
  try { const m = /^throttled_usec (\d+)$/m.exec(readFileSync(cpuStat, "utf8")); return m ? Number(m[1]) : null; } catch { return null; }
};
/** Call when a run starts; what it returns, called when the run ends, gives { load, throttleMs } for it (throttleMs null: n/a). */
export function meter() {
  const t0 = throttledUs();
  return () => { const t1 = throttledUs(); return { load: load(), throttleMs: t0 === null || t1 === null ? null : Math.round((t1 - t0) / 1000) }; };
}
const busy = (r) => r.load > STRICT || r.throttleMs > 0;
/** One run's load and throttle, for the log. */
export const said = (r) => `load ${fmt(r.load)}, throttle ${r.throttleMs === null ? "n/a" : `${r.throttleMs} ms`}`;
/** A few runs' loads and throttles, for the log. */
export const saidAll = (rs) => `${rs.map(said).join("; ")} (on ${CORES} cores)`;

/** Waits, out of what is left of the budget, until the 1-minute load is at or below `line`. Says how long and at what load. */
export async function waitQuiet(group, { line = QUIET, strict = false } = {}) {
  const which = strict ? "strict-quiet" : "quiet";
  const start = Date.now();
  let now = load();
  if (now > line && budgetMs > 0) {
    console.log(`${group}: host busy, ${onHost(now)} (${which} <= ${fmt(line)}); waiting up to ${Math.round(budgetMs / 1000)} s`);
    while (now > line && budgetMs > 0) {
      const step = Math.min(POLL_MS, budgetMs);
      await sleep(step);
      budgetMs -= step;
      now = load();
    }
  }
  const quiet = now <= line;
  console.log(`${group}: ${quiet ? "measuring" : "not measured"}, ${onHost(now)} (${which} <= ${fmt(line)}), waited ${Math.round((Date.now() - start) / 1000)} s, ${Math.round(budgetMs / 1000)} s of waiting left`);
  return { quiet, load: now };
}
/** A group's run() returns its checks as { name, ok, extra, timed } and each run's { load, throttleMs } (from meter()) as `runs`;
 * names() lists the same check names without measuring, for a group the host never got quiet enough for. `judged` says what a timed
 * check is judged on, for the log. */
export async function group(name, { names, run, judged = "a median" }) {
  const first = await waitQuiet(name);
  if (!first.quiet) {
    for (const c of names()) check(c, false, `host busy: ${onHost(first.load)}, not measured on a quiet host`);
    return;
  }
  const a = await run();
  const busyRuns = a.runs.filter(busy);
  if (!a.checks.some((c) => c.timed && !c.ok) || busyRuns.length === 0) {
    for (const c of a.checks) check(c.name, c.ok, c.extra);
    return;
  }
  console.log(`${name}: ${judged} failed with ${busyRuns.length} of ${a.runs.length} runs busy (${saidAll(busyRuns)}; strict-quiet <= ${fmt(STRICT)}, unthrottled); measuring it once more`);
  const firstOf = Object.fromEntries(a.checks.map((c) => [c.name, c]));
  const again = await waitQuiet(name, { line: STRICT, strict: true });
  if (!again.quiet) {
    for (const c of a.checks) {
      if (c.timed && !c.ok) check(c.name, false, `host busy (strict): ${onHost(again.load)}, not measured on a strict-quiet host; on the busy host ${c.extra}`);
      else check(c.name, c.ok, c.extra);
    }
    return;
  }
  const b = await run();
  for (const c of b.checks) check(c.name, c.ok, c.timed ? `${c.extra}; first, on a busy host, ${firstOf[c.name].ok ? "passed" : "failed"}: ${firstOf[c.name].extra}` : c.extra);
}
