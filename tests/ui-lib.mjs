// Shared by the UI checks. Library only: uses the system Chrome; never run `playwright install`.
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
const require = createRequire(new URL("./package.json", import.meta.url));
export const { chromium, webkit, devices } = require("playwright");

/** Whether this checkout has an instance's own screens (web/src/ext, tests/ext). They are not part of the public tree: a suite
 * checks them only when they are here. */
export const EXT = existsSync(new URL("./ext/screens.mjs", import.meta.url));
/** What the assistant is called on screen in a build without VITE_ASSISTANT_NAME (web/src/ns.ts). */
export const ASSISTANT = "Assistant";

/** Every screen, in the app's order (web/src/screens.ts): `id`, short `label`, `name` (what a screen reader says) and `group`. */
export const SCREENS = [
  { id: "today", label: "Today", group: "daily", tab: true },
  { id: "agents", label: "Agents", group: "daily", tab: true },
  { id: "assistant", label: ASSISTANT, group: "daily", tab: true },
  { id: "tasks", label: "Tasks", group: "daily", tab: true },
  { id: "thoughts", label: "Thoughts", group: "daily" },
  { id: "notes", label: "Notes", group: "daily" },
  { id: "files", label: "Files", group: "media" },
  { id: "settings", label: "Settings", group: "system", end: true },
];
for (const s of EXT ? (await import("./ext/screens.mjs")).EXT_SCREENS : []) {
  let at = s.before ? SCREENS.findIndex((x) => x.id === s.before) : -1;
  if (at < 0) {
    const last = SCREENS.map((x) => x.group === s.group && !x.end).lastIndexOf(true);
    at = last < 0 ? SCREENS.findIndex((x) => x.end) : last + 1;
  }
  SCREENS.splice(at, 0, s);
}
for (const s of SCREENS) s.name ??= s.label;
/** The screens a phone keeps in the Apps sheet, and its groups as "Group:Label,Label". */
export const DRAWER = SCREENS.filter((s) => !s.tab);
export const GROUP_NAMES = { daily: "Daily", media: "Media", system: "System" };
export const DRAWER_GROUPS = Object.keys(GROUP_NAMES).map((g) => [g, DRAWER.filter((s) => s.group === g)]).filter(([, l]) => l.length)
  .map(([g, l]) => `${GROUP_NAMES[g]}:${l.map((s) => s.label).join()}`);
/** The last screen of each group but the last: where the rail draws its hairlines. */
export const RAIL_SEPS = SCREENS.filter((s, i) => i + 1 < SCREENS.length && !SCREENS[i + 1].end && SCREENS[i + 1].group !== s.group); // as main.ts draws them

export function target(port) {
  const token = readFileSync(`/run/user/${process.getuid()}/k${port}/token`, "utf8").trim();
  return { base: `http://127.0.0.1:${port}/`, token, port };
}
export const PROFILES = {
  iphone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true },
  pixel: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, hasTouch: true, isMobile: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};
export async function open(browser, t, profile, { dark = true, hash = "#/agents", reducedMotion, userAgent, clock } = {}) {
  const ctx = await browser.newContext({ ...PROFILES[profile], colorScheme: dark ? "dark" : "light", reducedMotion, ...(userAgent ? { userAgent } : {}) });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") page.errors.push(`console: ${m.text()}`); });
  await page.addInitScript((tok) => { try { localStorage.setItem("lumbridge.token", tok); } catch {} }, t.token);
  // clock: the page's time starts here and runs on at the normal speed (Playwright's page.clock), for tests about times of day.
  if (clock !== undefined) await page.clock.install({ time: clock });
  await page.goto(t.base + hash);
  await page.waitForSelector(".inbox-lists .row, .term", { timeout: 15000, state: "attached" });
  return page;
}
export function shooter(dir) {
  mkdirSync(dir, { recursive: true });
  return async (page, name) => { await page.waitForTimeout(350); await page.screenshot({ path: `${dir}/${name}.png` }); console.log(`shot ${name}`); };
}

/** Fixture terminals by name, so the checks don't care which addresses a run got. */
export function addresses(port) {
  const d = `/run/user/${process.getuid()}/k${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")));
  Object.assign(env, { XDG_STATE_HOME: `${d}/s`, XDG_RUNTIME_DIR: d, XDG_CONFIG_HOME: `${d}/c`, XDG_DATA_HOME: `${d}/d`, LBC_SESSION: "k" });
  const list = JSON.parse(execFileSync("lbc", ["ls", "--json"], { env, encoding: "utf8" })).terminals;
  return Object.fromEntries(list.filter((t) => t.name).map((t) => [t.name, t.address]));
}

/** A scratch core's environment and nothing that could point anywhere else: no CLAUDE*, no HC_* inherited from a real pane. */
export function scratchEnv(port, session = "k") {
  const d = `/run/user/${process.getuid()}/k${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE") && !k.startsWith("LBC_")));
  return { ...env, XDG_STATE_HOME: `${d}/s`, XDG_RUNTIME_DIR: d, XDG_CONFIG_HOME: `${d}/c`, XDG_DATA_HOME: `${d}/d`, LBC_SESSION: session };
}

/** Calls made straight to the SCRATCH core through `hc connect`, past the gateway: doc.set for seeding, which the gateway refuses. */
export function scratchCalls(port, calls) {
  const input = calls.map(([method, params], i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, method, params })).join("\n") + "\n";
  const r = spawnSync("lbc", ["connect"], { env: scratchEnv(port), input, encoding: "utf8", timeout: 8000, maxBuffer: 1 << 24 });
  const answers = new Map(r.stdout.trim().split("\n").filter(Boolean).map((l) => { const m = JSON.parse(l); return [m.id, m]; }));
  return calls.map((_, i) => answers.get(i + 1));
}

/** Writes a machine's layout document on the scratch core, whatever version it's at. */
export function seedDoc(port, value, on) {
  const where = on ? { on } : {};
  const [got] = scratchCalls(port, [["doc.get", { name: "lumbridge-app", ...where }]]);
  if (got?.error || !got?.result) throw new Error(`doc.get ${on ?? "here"}: ${JSON.stringify(got)}`);
  const [set] = scratchCalls(port, [["doc.set", { name: "lumbridge-app", value, version: got.result.version, ...where }]]);
  if (set?.error) throw new Error(`doc.set ${on ?? "here"}: ${JSON.stringify(set)}`);
}

/** The fixture's terminals laid out as the desktop app would, with the awkward things a real document can hold. `A`: addresses(port). */
export function seedLayouts(port, A) {
  const id = (name) => A[name].split("/").pop();
  const term = (name, weight, nodeId = `p-${name}`) => ({ id: nodeId, type: "block", content: { terminal: id(name) }, ...(weight ? { size: { weight } } : {}) });
  const row = (i, children, weight) => ({ id: i, type: "row", children, ...(weight ? { size: { weight } } : {}) });
  const column = (i, children, weight) => ({ id: i, type: "column", children, ...(weight ? { size: { weight } } : {}) });
  seedDoc(port, { spaces: [
    { id: "s-studio", name: "Studio", folder: "/home/sam/repos/studio", tabs: [
      { id: "t-gw", name: "Gateway work", root: row("t-gw", [term("gateway-review", 0.5), column("c1", [term("pr-branch", 0.3), term("web-tests", 0.7)], 0.35), term("chat-agent", 0.15)]) },
      { id: "t-docs", name: "Docs", root: row("t-docs", [term("docs-pass")]) },
    ] },
    { id: "s-odd", name: '<img src=x onerror="window.__xss=1"><b>Odd</b>', folder: "/tmp/<script>window.__xss=1</script>", tabs: [
      { id: "t-odd", name: "<i>Panels</i> & stacks", root: row("t-odd", [
        { id: "m1", type: "block", content: { mod: "<svg onload=window.__xss=1>notebook", props: { terminal: id("chat-agent") } }, size: { weight: 0.3 } },
        { id: "g1", type: "block", content: { terminal: "t9999" }, size: { weight: 0.3 } },
        { id: "st", type: "stack", active: "p-scratch-shell", size: { weight: 0.4 }, children: [term("scratch-shell"), { id: "x-hidden", type: "block", content: { terminal: id("docs-pass") } }] },
      ]) },
    ] },
  ] });
  seedDoc(port, { spaces: [
    { id: "s-acme", name: "Acme", folder: "/home/sam/repos/acme", tabs: [
      { id: "t-api", name: "API", root: row("t-api", [term("acme-api", 0.62), term("top", 0.38)]) },
      { id: "t-import", name: "Import", root: row("t-import", [column("c2", [term("ledger-import", 0.5), term("token-refresh", 0.5)])]) },
    ] },
  ] }, "lab");
  seedDoc(port, { spaces: [
    { id: "s-batch", name: "Batch", folder: "/home/sam/rig/batch", tabs: [{ id: "t-a", name: "Factory", root: row("t-a", [term("factory-batch")]) }] },
    { id: "s-ci", name: "CI", folder: "/home/sam/rig/ci", tabs: [{ id: "t-b", name: "Gateway", root: row("t-b", [term("ci-gateway"), term("rig-shell")]) }] },
    { id: "s-muxin", name: "Muxin", folder: "/home/sam/rig/muxin", tabs: [{ id: "t-c", name: "Render", root: row("t-c", [term("muxin-render")]) }] },
    { id: "s-arch", name: "Archive", folder: "/home/sam/rig/archive", tabs: [{ id: "t-d", name: "Nightly", root: row("t-d", [term("nightly-archive")]) }] },
  ] }, "rig");
}
