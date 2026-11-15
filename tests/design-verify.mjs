// The design system's three hard rules, measured on every screen at iPhone 14, Pixel 6 and a 1440x900 desktop, in both themes:
//   (a) every computed font-size is on the type scale (12 13 14 16 18 20 24 32 40 48 64 96), except the terminal's own cells (.xterm)
//   (b) every visible control (button, [role=button], input, select, textarea, .chip) has a hit area, its ::after included,
//       at least 44 px tall on a phone; on a desktop with a mouse 36, and 32 for the in-sheet .choice and .sheet-item. So a
//       chip drawn 32 (touch) or 28 (desktop) passes on its ::after (style.css, beside --tap; DESIGN.md, Accessibility)
//   (c) focusing each input from the keyboard shows a ring: a box-shadow or outline on it, or on the wrapper that draws its box
// Against a scratch gateway with the fixture's terminals, a database of its own on the throwaway Postgres, and fakes for whatever
// else a screen asks (an instance's own screens bring theirs), so nothing real is asked. Starts and stops everything itself; offenders are printed.
//   node tests/design-verify.mjs <port> [shots dir]
// LUMBRIDGE_PG_PORT picks the throwaway Postgres (default 5498). Needs web/dist and psql. Never `playwright install`.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PG_PORT, stopOnExit } from "./ports.mjs";
import { addresses, chromium, EXT, PROFILES, target } from "./ui-lib.mjs";

const [port, shots] = process.argv.slice(2);
if (!port) { console.error("usage: design-verify.mjs <port> [shots dir]"); process.exit(2); }
if (shots) mkdirSync(shots, { recursive: true });
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0, passed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n${extra}`}`); if (ok) passed++; else failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- A database of its own ----

const psqlBin = [process.env.LUMBRIDGE_PG_BIN && `${process.env.LUMBRIDGE_PG_BIN}/psql`].find((p) => p && existsSync(p)) ?? "psql";
const SERVER = `postgres://postgres:lumbridge-throwaway@127.0.0.1:${PG_PORT}`;
const DB = `lumbridge_design_${process.pid}`;
const sql = (q, db = DB) => execFileSync(psqlBin, [`${SERVER}/${db}`, "-v", "ON_ERROR_STOP=1", "-Atqc", q], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
sql(`create database ${DB}`, "postgres");
spawnSync(psqlBin, [`${SERVER}/${DB}`, "-qc", "create role lumbridge_app login noinherit password 'dev'; alter role lumbridge_app set search_path = lumbridge"], { stdio: "ignore" });
sql("create schema lumbridge authorization lumbridge_app; revoke all on schema lumbridge from public");
const DB_URL = `postgres://lumbridge_app:dev@127.0.0.1:${PG_PORT}/${DB}`;

// ---- An instance's own screens bring their fakes (tests/ext/design.mjs, not part of the public tree) ----

const scratch = mkdtempSync(path.join(tmpdir(), "lumbridge-design-"));
const ext = EXT ? await (await import("./ext/design.mjs")).extDesign(scratch) : { env: {}, close() {}, screens: [], prep: {} };

// ---- The gateway and the fixture ----

const env = { ...process.env, LUMBRIDGE_DATABASE_URL: DB_URL, ...ext.env };
const sh = (script, ...a) => spawnSync("bash", [`${repo}/scripts/${script}`, port, ...a], { env, encoding: "utf8" });
let cleaned = false;
stopOnExit(() => {
  if (cleaned) return;
  cleaned = true;
  sh("dev-fixture.sh", "stop");
  sh("dev.sh", "stop");
  ext.close();
  rmSync(scratch, { recursive: true, force: true });
  try { sql(`drop database ${DB} with (force)`, "postgres"); } catch { /* it's a throwaway server */ }
});
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
for (const [s, ...a] of [["dev.sh"], ["dev-fixture.sh"]]) {
  const r = sh(s, ...a);
  if (r.status !== 0) { console.error(`${s}: ${r.stdout}${r.stderr}`); process.exit(1); }
}
const migrated = spawnSync(`${repo}/gateway/target/debug/lumbridge-mobile-server`, ["migrate"], { env: { LUMBRIDGE_DATABASE_URL: DB_URL }, encoding: "utf8" });
if (migrated.status !== 0) { console.error(migrated.stderr); process.exit(1); }
const t = target(port);
const A = addresses(port);
const api = async (method, p, body) => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(t.base + p.slice(1), { method, headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return r.status;
    } catch (e) { if (i > 50) throw e; await sleep(100); } // the gateway is a moment behind dev.sh
  }
};
// Something in each list, so its rows and their buttons are measured too. Fake text only.
const seeded = [
  await api("POST", "/api/thoughts", { body: "The garage door sensor is the one that keeps dropping off the mesh." }),
  await api("POST", "/api/notes", { id: crypto.randomUUID(), title: "Packing list", body: "- [ ] charger\n- [x] passport" }),
  await api("POST", "/api/tasks", { id: crypto.randomUUID(), title: "Renew the domain", due_on: null, sort_key: Date.now() }),
];
console.log(`seeded: ${seeded.join(" ")}`);

// ---- What's measured ----

const SCALE = [12, 13, 14, 16, 18, 20, 24, 32, 40, 48, 64, 96];
const SCREENS = [
  ["Today", "#/today", ".td-capture"],
  ["Agents", "#/agents", ".inbox-lists .row"],
  ["By place", "#/panes", ".pm-lists"],
  ["Assistant", "#/assistant", ".assistant"],
  ["Thoughts", "#/thoughts", ".th-row"],
  ["Files", "#/files", ".fi-hero"],
  ["Notes", "#/notes", ".d-note"],
  ["Tasks", "#/tasks", ".d-task"],
  ...ext.screens,
  ["Settings", "#/settings", ".set-row"],
  ["Terminal", `#/t/${encodeURIComponent(A["gateway-review"])}`, ".xterm-rows"],
  // Phones only: on a computer the drawer's apps are in the rail.
  ["Drawer", "#/agents", ".drawer .app"],
  // The jump palette, open over Agents: Ctrl-K on a computer, the Apps sheet's search button on a phone.
  ["Palette", "#/agents", ".pal-row"],
];

/** What a screen needs done after it loads and before it's measured. */
const PREP = { ...ext.prep };

/** Runs in the page: what breaks (a) and (b), and the inputs to try for (c). */
function measure({ scale, touch }) {
  const visible = (e) => {
    if (e.closest(".xterm, [hidden], [aria-hidden='true'], [inert]")) return false;
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const label = (e) => {
    const c = typeof e.className === "string" && e.className.trim() ? `.${e.className.trim().split(/\s+/).join(".")}` : "";
    const name = (e.getAttribute("aria-label") || e.placeholder || e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28);
    return `${e.tagName.toLowerCase()}${c}${name ? ` "${name}"` : ""}`;
  };
  const fonts = new Map();
  for (const e of document.querySelectorAll("body *")) {
    if (["SCRIPT", "STYLE", "svg", "path"].includes(e.tagName) || e.closest("svg") || !visible(e)) continue;
    const px = parseFloat(getComputedStyle(e).fontSize);
    if (!scale.some((s) => Math.abs(s - px) < 0.05)) { const k = `${label(e)} ${+px.toFixed(2)}px`; fonts.set(k, (fonts.get(k) ?? 0) + 1); }
  }
  const short = [];
  for (const e of document.querySelectorAll("button, [role=button], input, select, textarea, .chip")) {
    if (e.type === "hidden" || !visible(e)) continue;
    // A checkbox or radio is hit through its label, so the label is the target.
    const target = (e.type === "checkbox" || e.type === "radio") && e.closest("label") ? e.closest("label") : e;
    const h = target.getBoundingClientRect().height;
    // The hit area: the box, or an absolutely placed ::after stretched past it (a chip's), whichever is taller.
    const after = getComputedStyle(target, "::after");
    const reach = after.content !== "none" && after.position === "absolute" && after.display !== "none"
      ? h - (parseFloat(after.top) || 0) - (parseFloat(after.bottom) || 0) : 0;
    const hit = Math.max(h, reach);
    const secondary = e.matches(".choice, .sheet-item");
    const min = touch ? 44 : secondary ? 32 : 36;
    if (hit < min - 0.05) short.push(`${label(e)} ${+hit.toFixed(1)}px${hit !== h ? ` (box ${+h.toFixed(1)})` : ""} < ${min}`);
  }
  for (const e of document.querySelectorAll("[data-dv-input]")) delete e.dataset.dvInput; // left from the screen before
  const inputs = [...document.querySelectorAll("input, select, textarea")].filter((e) => e.type !== "hidden" && !e.disabled && visible(e));
  inputs.forEach((e, i) => { e.dataset.dvInput = String(i); });
  return { fonts: [...fonts].map(([k, n]) => (n > 1 ? `${k} x${n}` : k)), short, inputs: inputs.map(label) };
}

/**
 * Runs in the page, on the TV screen: colour only where it means something, no emoji, and readable text. --danger-solid only in an
 * error line or the Clear item, --ok only in a done line or "Playing on …"; Pause/Play in both states, Loading… and the meta line at
 * 4.5:1 or better against what's behind them.
 */
function tvLook() {
  const view = document.querySelector(".tv-view");
  const shown = (e) => { if (e.closest("[hidden], [aria-hidden='true']")) return false; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const resolve = (v) => { const d = document.createElement("div"); d.style.color = `var(${v})`; view.append(d); const c = getComputedStyle(d).color; d.remove(); return c; };
  const danger = resolve("--danger-solid"), ok = resolve("--ok");
  const name = (e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")} "${(e.textContent || "").trim().slice(0, 24)}"`;
  const colours = [];
  for (const e of view.querySelectorAll("*")) {
    if (e.closest("svg") || !shown(e)) continue;
    const s = getComputedStyle(e);
    if ((s.color === danger || s.backgroundColor === danger) && !e.closest(".tv-msg.err, .tv-note.err, .tv-menu-item.danger")) colours.push(`${name(e)} uses --danger-solid`);
    if ((s.color === ok || s.backgroundColor === ok) && !e.closest(".tv-msg.ok, .tv-picked-where")) colours.push(`${name(e)} uses --ok`);
  }
  const emoji = [];
  const walk = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (/\p{Extended_Pictographic}/u.test(n.textContent)) emoji.push(n.textContent.trim().slice(0, 30));
  const rgba = (c) => { const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const behind = (e) => {
    const layers = [];
    for (let x = e; x; x = x.parentElement) { const b = rgba(getComputedStyle(x).backgroundColor); if (b.a > 0) layers.push(b); if (b.a >= 1) break; }
    return layers.reverse().reduce((acc, l) => over(l, acc), { r: 255, g: 255, b: 255, a: 1 });
  };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (e) => { const bg = behind(e), fg = over(rgba(getComputedStyle(e).color), bg); const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x); return (a + 0.05) / (b + 0.05); };
  const contrast = [];
  const want = { "Pause": 0, "Play": 0 };
  for (const b of view.querySelectorAll(".tv-playpause")) if (shown(b) && b.textContent in want) { want[b.textContent]++; contrast.push([`.tv-playpause "${b.textContent}"`, ratio(b)]); }
  for (const sel of [".tv-loading", ".tv-tile-meta"]) for (const e of view.querySelectorAll(sel)) if (shown(e)) contrast.push([sel, ratio(e)]);
  return { colours, emoji, contrast: contrast.map(([k, r]) => [k, +r.toFixed(2)]), seen: { pause: want.Pause, play: want.Play, loading: contrast.some(([k]) => k === ".tv-loading") } };
}

/** Runs in the page: the ring that input `i` shows when focused from the keyboard, if any. */
function ringOf(i) {
  const e = document.querySelector(`[data-dv-input="${i}"]`);
  const chain = [e, e.parentElement, e.parentElement?.parentElement].filter(Boolean);
  const look = () => chain.map((x) => { const s = getComputedStyle(x); return `${s.boxShadow}|${s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 ? `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}` : "none"}`; });
  e.blur();
  const before = look();
  e.focus({ preventScroll: true });
  const focused = document.activeElement === e;
  const after = look();
  e.blur();
  const shows = after.some((a, k) => a !== before[k] && a !== "none|none");
  return { focused, shows };
}

const browser = await chromium.launch({ channel: "chrome" });
for (const profile of ["iphone", "pixel", "desktop"]) {
  for (const dark of [true, false]) {
    const theme = dark ? "dark" : "light";
    const ctx = await browser.newContext({ ...PROFILES[profile], colorScheme: dark ? "dark" : "light", reducedMotion: "reduce" });
    await ctx.addInitScript((tok) => { try { localStorage.setItem("lumbridge.token", tok); } catch {} }, t.token);
    const page = await ctx.newPage();
    for (const [name, hash, ready] of SCREENS) {
      if (name === "Drawer" && profile === "desktop") continue;
      const where = `${profile} ${theme} ${name}`;
      await page.goto("about:blank"); // each screen from a fresh load, so nothing of the one before is measured
      await page.goto(t.base + hash);
      if (name === "Drawer") { await page.waitForSelector(".tab-apps"); await page.click(".tab-apps"); }
      if (name === "Palette") {
        await page.waitForSelector(".inbox-lists .row", { timeout: 15000 });
        if (profile === "desktop") await page.keyboard.press("Control+k");
        else { await page.click(".tab-apps"); await page.click(".drawer-find"); }
      }
      if (PREP[name]) await PREP[name](page);
      const found = await page.waitForSelector(ready, { timeout: 15000 }).then(() => true, () => false);
      if (!found) { check(`${where}: the screen shows (${ready})`, false, "  never appeared"); continue; }
      await sleep(600);
      // The TV's More menu, open, so its items are measured with the rest.
      if (name === "TV") {
        await page.click('.tv-tile[data-tile="middle"] .tv-more-btn');
        const open = await page.waitForSelector(".tv-menu-item", { timeout: 5000 }).then(() => true, () => false);
        check(`${where}: More opens its menu`, open, "  no menu items");
      }
      // A keyboard user: :focus-visible is what the ring hangs on.
      await page.keyboard.press("Shift");
      const m = await page.evaluate(measure, { scale: SCALE, touch: profile !== "desktop" });
      check(`${where}: font sizes on the scale`, m.fonts.length === 0, m.fonts.map((x) => `  ${x}`).join("\n"));
      check(`${where}: controls ${profile === "desktop" ? "≥ 36 px (choices, sheet items ≥ 32)" : "≥ 44 px"}`, m.short.length === 0, m.short.map((x) => `  ${x}`).join("\n"));
      const ringless = [];
      for (let i = 0; i < m.inputs.length; i++) {
        const r = await page.evaluate(ringOf, i);
        if (!r.focused || !r.shows) ringless.push(`${m.inputs[i]}${r.focused ? "" : " (took no focus)"}`);
      }
      if (m.inputs.length) check(`${where}: ${m.inputs.length} input(s) show a focus ring`, ringless.length === 0, ringless.map((x) => `  ${x}`).join("\n"));
      if (name === "TV") {
        const tv = await page.evaluate(tvLook);
        check(`${where}: colour only with meaning (no --danger-solid or --ok outside errors and done lines)`, tv.colours.length === 0, tv.colours.map((x) => `  ${x}`).join("\n"));
        check(`${where}: no emoji`, tv.emoji.length === 0, tv.emoji.map((x) => `  ${x}`).join("\n"));
        const low = tv.contrast.filter(([, r]) => r < 4.5);
        check(`${where}: Pause, Play, Loading… and the meta line at 4.5:1 or better`, low.length === 0 && tv.seen.pause > 0 && tv.seen.play > 0 && tv.seen.loading,
          `  ${JSON.stringify(tv.seen)} ${low.map(([k, r]) => `${k} ${r}`).join(", ")}`);
      }
      if (shots && dark && ["Agents", "Thoughts", "TV", "Library", "Library components", "Lumbridge", "Lumbridge editions", "Lumbridge client"].includes(name)) await page.screenshot({ path: `${shots}/${profile}-${name.toLowerCase().replace(/ /g, "-")}.png` });
    }
    await ctx.close();
  }
}
await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
