// Speed, measured (#64): By place usable soon after a cold load, and opening a terminal without a long task, on phones at 4x CPU.
// Against a scratch core with the fixture (scripts/dev.sh <port> && scripts/dev-fixture.sh <port>), or through scripts/ci-browser.sh:
//   node tests/speed-verify.mjs <port>
// CI runners are shared, so each limit is the one asked for and no tighter, judged on the median of a few runs; every run is printed.
// A busy host measures the host, not the app (#74), so each group (By place, terminal tap to text, terminal history) waits for a quiet
// host first and is measured once more if a median fails while the host got busy: tests/quiet-host.mjs.
import { execFileSync } from "node:child_process";
import { check, failed, group, meter, saidAll } from "./quiet-host.mjs";
import { addresses, chromium, PROFILES, scratchEnv, seedLayouts, target } from "./ui-lib.mjs";

const port = process.argv[2];
if (!port) { console.error("usage: speed-verify.mjs <port>"); process.exit(2); }
const t = target(port);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const RUNS = 5;

const A = addresses(port);
seedLayouts(port, A);
// A terminal with a full history: 2000 lines, coloured and wider than a phone, the most `terminal.attach` sends.
const hcEnv = scratchEnv(port);
const line = String.raw`\033[2m%4d\033[0m  \033[36mstep %d\033[0m compiled crate number %d with a line long enough to need panning on any phone, \033[1;33mwarnings 0\033[0m, and it keeps going\n`;
const listed = () => JSON.parse(execFileSync("lbc", ["ls", "--json"], { env: hcEnv, encoding: "utf8" })).terminals;
for (const x of listed().filter((x) => x.name === "speed-history")) execFileSync("lbc", ["kill", x.address], { env: hcEnv, stdio: "ignore" });
execFileSync("lbc", ["run", "--bg", "--no-parent", "--name", "speed-history", "bash", "-c", `for i in $(seq 1 2400); do printf '${line}' $i $i $i; done; printf '\\033]7501;state=idle\\033\\\\'; sleep 1000000`], { env: hcEnv, stdio: "ignore" });
const historyAddr = listed().find((x) => x.name === "speed-history").address;
await sleep(1500);

const browser = await chromium.launch({ channel: "chrome" });
async function fresh(profile, cpu) {
  const ctx = await browser.newContext({ ...PROFILES[profile], colorScheme: "dark" });
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  await p.addInitScript((tok) => { try { localStorage.setItem("lumbridge.token", tok); } catch {} }, t.token);
  if (cpu > 1) await (await ctx.newCDPSession(p)).send("Emulation.setCPUThrottlingRate", { rate: cpu });
  return p;
}
const CPU = { iphone: 4, pixel: 4, desktop: 1 };
const PROFILE_NAMES = ["iphone", "pixel", "desktop"];
const say = (profile, s) => `${profile}${CPU[profile] > 1 ? `, ${CPU[profile]}x CPU` : ""}: ${s}`;

// ---- 1. By place: the first space header, from navigation (L-09) ----
// Timed from the navigation's start (performance.now() counts from it) to the frame that first has a space header in it.
const firstHeader = () => {
  const w = window.__speed = { header: 0, machines: {} };
  const seen = () => {
    if (!w.header && document.querySelector(".pm-space-head")) requestAnimationFrame((now) => { w.header ||= now; });
    for (const m of document.querySelectorAll(".pm-machine")) if (m.querySelector(".pm-space-head") && !(m.dataset.machine in w.machines)) w.machines[m.dataset.machine] = performance.now();
  };
  new MutationObserver(seen).observe(document, { childList: true, subtree: true });
};
// Desktop had no limit asked of it; it may not get slower than the lane audit measured (330-370 ms).
const byPlaceNames = (profile) => [
  profile === "desktop" ? say(profile, `By place's first space header no slower than before, <= 370 ms (median of ${RUNS})`)
    : say(profile, `By place's first space header <= 300 ms after navigation (median of ${RUNS})`),
  say(profile, "all three machines' spaces show"),
  say(profile, "no page errors on By place"),
];
await group("By place", {
  names: () => PROFILE_NAMES.flatMap(byPlaceNames),
  async run() {
    const checks = [], all = [];
    for (const profile of PROFILE_NAMES) {
      const runs = [], hosts = [];
      let errors = [];
      for (let i = 0; i < RUNS; i++) {
        const host = meter();
        const p = await fresh(profile, CPU[profile]);
        await p.addInitScript(firstHeader);
        await p.goto(`${t.base}#/panes`);
        await p.waitForFunction(() => window.__speed?.header, null, { timeout: 15000 }).catch(() => {});
        await p.waitForFunction(() => Object.keys(window.__speed?.machines ?? {}).length >= 3, null, { timeout: 15000 }).catch(() => {});
        runs.push(await p.evaluate(() => ({ header: Math.round(window.__speed.header), machines: Object.fromEntries(Object.entries(window.__speed.machines).map(([k, v]) => [k || "desk", Math.round(v)])) })));
        errors = errors.concat(p.errors);
        await p.context().close();
        hosts.push(host());
      }
      all.push(...hosts);
      const ms = runs.map((r) => r.header || Infinity);
      console.log(say(profile, `first space header at ${ms.join(", ")} ms; each machine's: ${runs.map((r) => JSON.stringify(r.machines)).join(" ")}; ${saidAll(hosts)}`));
      const [timed, machines, pageErrors] = byPlaceNames(profile);
      checks.push({ name: timed, ok: median(ms) <= (profile === "desktop" ? 370 : 300), extra: `median ${median(ms)} ms`, timed: true });
      checks.push({ name: machines, ok: runs.every((r) => Object.keys(r.machines).length >= 3), extra: JSON.stringify(runs.map((r) => Object.keys(r.machines))) });
      checks.push({ name: pageErrors, ok: errors.length === 0, extra: errors.join(" | ") });
    }
    return { checks, runs: all };
  },
});

// ---- 2. opening a terminal: tap to text, and no long task (L-11) ----
// From the tap on its row (the pointerdown) to the frame whose xterm rows first hold text. Long tasks are counted from the tap to
// 1.5 s after the text, so a history that goes in after the first paint is held to the same limit.
const watchOpen = () => {
  const w = window.__open = { tap: 0, text: 0, long: [] };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) w.long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask" });
  addEventListener("pointerdown", (e) => { w.tap ||= e.timeStamp; }, { capture: true, once: true });
  const loop = (now) => {
    if (w.tap && !w.text && document.querySelector(".xterm-rows")?.textContent.trim()) w.text = now;
    if (!w.text) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
};
// The lane audit measured 124-157 ms on desktop: no slower than that.
const terminalNames = (profile, label) => profile === "desktop"
  ? [say(profile, `${label}: tap to text no slower than before, <= 157 ms (median of ${RUNS})`), say(profile, `${label}: no page errors`)]
  : [say(profile, `${label}: tap to text <= 250 ms (median of ${RUNS})`),
    say(profile, `${label}: no long task over 50 ms from tap to text and the history in (median of ${RUNS})`),
    say(profile, `${label}: no page errors`)];
const terminal = (label, address) => ({
  names: () => PROFILE_NAMES.flatMap((profile) => terminalNames(profile, label)),
  async run() {
    const checks = [], all = [];
    for (const profile of PROFILE_NAMES) {
      const runs = [], hosts = [];
      let errors = [];
      for (let i = 0; i < RUNS; i++) {
        const host = meter();
        const p = await fresh(profile, CPU[profile]);
        await p.goto(`${t.base}#/agents`);
        const row = p.locator(`.inbox-lists .row[data-address="${address}"] .row-main`).first();
        await row.waitFor({ timeout: 15000 });
        await sleep(1500);
        await row.scrollIntoViewIfNeeded();
        await sleep(300);
        await p.evaluate(watchOpen);
        if (profile === "desktop") await row.click(); else await row.tap();
        await p.waitForFunction(() => window.__open.text, null, { timeout: 15000 }).catch(() => {});
        await sleep(3000);
        runs.push(await p.evaluate(() => {
          const w = window.__open;
          const long = w.long.filter(([s]) => s >= w.tap && s <= w.text + 1500);
          return { ms: w.text ? Math.round(w.text - w.tap) : null, long: long.map(([, d]) => d) };
        }));
        errors = errors.concat(p.errors);
        await p.context().close();
        hosts.push(host());
      }
      all.push(...hosts);
      const ms = runs.map((r) => r.ms ?? Infinity);
      const longest = runs.map((r) => Math.max(0, ...r.long));
      console.log(say(profile, `${label}: tap to text ${ms.join(", ")} ms; long tasks ${runs.map((r) => `[${r.long.join(" ")}]`).join(" ")}; ${saidAll(hosts)}`));
      const names = terminalNames(profile, label);
      if (profile === "desktop") checks.push({ name: names[0], ok: median(ms) <= 157, extra: `median ${median(ms)} ms`, timed: true });
      else {
        checks.push({ name: names[0], ok: median(ms) <= 250, extra: `median ${median(ms)} ms`, timed: true });
        checks.push({ name: names[1], ok: median(longest) <= 50, extra: `longest per run ${longest.join(", ")} ms`, timed: true });
      }
      checks.push({ name: names.at(-1), ok: errors.length === 0, extra: errors.join(" | ") });
    }
    return { checks, runs: all };
  },
});
await group("terminal tap to text", terminal("gateway-review", A["gateway-review"]));
await group("terminal history", terminal("2000 lines of history", historyAddr));

execFileSync("lbc", ["kill", historyAddr], { env: hcEnv, stdio: "ignore" });
await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
