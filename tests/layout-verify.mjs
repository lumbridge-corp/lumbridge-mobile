// Layout, measured (#50): the Apps drawer's speed, how much of the Agents list a phone shows, and how desktop lists use the width.
// Starts its own scratch gateway and fixture, with a database of its own on the throwaway Postgres, and stops them after:
//   scripts/ci-db.sh && node tests/layout-verify.mjs <port> [shots dir]
// LUMBRIDGE_PG_PORT picks the throwaway Postgres (default 5498). Needs web/dist and psql. Never `playwright install`.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PG_PORT, stopOnExit } from "./ports.mjs";
import { check, failed, group, meter, saidAll } from "./quiet-host.mjs";
import { addresses, chromium, EXT, PROFILES, seedLayouts } from "./ui-lib.mjs";

const [port, shots] = process.argv.slice(2);
if (!port) { console.error("usage: layout-verify.mjs <port> [shots dir]"); process.exit(2); }
if (shots) mkdirSync(shots, { recursive: true });
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (p, name) => { if (shots) { await sleep(150); await p.screenshot({ path: `${shots}/${name}.png` }); } };

// ---- a database, a gateway and the fixture, all scratch ----
const psqlBin = [process.env.LUMBRIDGE_PG_BIN && `${process.env.LUMBRIDGE_PG_BIN}/psql`].find((p) => p && existsSync(p)) ?? "psql";
const SERVER = `postgres://postgres:lumbridge-throwaway@127.0.0.1:${PG_PORT}`;
const DB = `lumbridge_layout_${process.pid}`;
const sql = (q, db = DB) => execFileSync(psqlBin, [`${SERVER}/${db}`, "-v", "ON_ERROR_STOP=1", "-Atqc", q], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
sql(`create database ${DB}`, "postgres");
spawnSync(psqlBin, [`${SERVER}/${DB}`, "-qc", "create role lumbridge_app login noinherit password 'dev'; alter role lumbridge_app set search_path = lumbridge"], { stdio: "ignore" });
sql("create schema lumbridge authorization lumbridge_app; revoke all on schema lumbridge from public");
const URL_ = `postgres://lumbridge_app:dev@127.0.0.1:${PG_PORT}/${DB}`;
const FILES_DIR = mkdtempSync(path.join(tmpdir(), "lumbridge-layout-files-"));
const script = (name, ...a) => spawnSync("bash", [`${repo}/scripts/${name}`, port, ...a], { env: { ...process.env, LUMBRIDGE_DATABASE_URL: URL_, LUMBRIDGE_FILES_DIR: FILES_DIR }, encoding: "utf8" });
let cleaned = false;
stopOnExit(() => {
  if (cleaned) return;
  cleaned = true;
  script("dev-fixture.sh", "stop");
  script("dev.sh", "stop");
  try { sql(`drop database ${DB} with (force)`, "postgres"); } catch { /* it's a throwaway server */ }
  rmSync(FILES_DIR, { recursive: true, force: true });
});
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
for (const [name, ...a] of [["dev.sh"], ["dev-fixture.sh"]]) {
  const r = script(name, ...a);
  if (r.status !== 0) { console.error(name, r.stdout, r.stderr); process.exit(1); }
}
const migrated = spawnSync(`${repo}/gateway/target/debug/lumbridge-mobile-server`, ["migrate"], { env: { LUMBRIDGE_DATABASE_URL: URL_ }, encoding: "utf8" });
if (migrated.status !== 0) { console.error(migrated.stderr); process.exit(1); }
const tok = readFileSync(`/run/user/${process.getuid()}/k${port}/token`, "utf8").trim();
const BASE = `http://127.0.0.1:${port}/`;
const api = async (method, p, body) => {
  const r = await fetch(BASE + p.slice(1), { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status}`);
  return r.json();
};
// Enough of each that a desktop screen has a full list, some with the second line (a date, a preview) that made rows tall.
const soon = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
for (let i = 1; i <= 15; i++) await api("POST", "/api/tasks", { title: `Task ${i}: check the ${["gateway", "drawer", "fixture"][i % 3]} again`, ...(i % 2 ? { due_on: soon(i % 4) } : {}), ...(i % 5 === 0 ? { notes: "with notes" } : {}) });
for (let i = 1; i <= 12; i++) await api("POST", "/api/notes", { title: `Note ${i}`, body: `First line of note ${i}, long enough to wrap on a phone and show a preview.\nSecond line.` });
for (let i = 1; i <= 12; i++) await api("POST", "/api/thoughts", { body: `Thought ${i}: ${"a thing worth remembering ".repeat(1 + (i % 3))}` });

const browser = await chromium.launch({ channel: "chrome" });
async function page(profile, hash, { reducedMotion, cpu, theme = "dark", prefs = {} } = {}) {
  const ctx = await browser.newContext({ ...PROFILES[profile], colorScheme: theme, reducedMotion });
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  await p.addInitScript(([t, prefs]) => { try { localStorage.setItem("lumbridge.token", t); for (const [k, v] of Object.entries(prefs)) localStorage.setItem(k, v); } catch {} }, [tok, prefs]);
  await p.goto(BASE + hash);
  if (cpu) await (await ctx.newCDPSession(p)).send("Emulation.setCPUThrottlingRate", { rate: cpu });
  return p;
}
const center = (p, sel) => p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);

/** Starts watching the sheet, one sample a frame. The clock starts when the page handles the tap's click, or Escape's keydown: what
 * tells the drawer to move. The touch's own dispatch, before that, is the browser's (and Playwright's); it's logged as `input`. */
const watch = (p) => p.evaluate(() => {
  const w = window.__w = { t0: 0, input: 0, frames: [] };
  addEventListener("pointerdown", (e) => { w.input ||= e.timeStamp; }, { capture: true, once: true });
  const start = (e) => { w.input ||= e.timeStamp; w.t0 ||= performance.now(); };
  addEventListener("click", start, { capture: true, once: true });
  addEventListener("keydown", start, { capture: true, once: true });
  const sheet = document.querySelector(".drawer"), layer = document.querySelector(".drawer-layer");
  const loop = (now) => {
    // null once it's hidden, or at its closed place (its top on the layer's bottom edge, out of sight)
    const top = layer.hidden ? null : sheet.getBoundingClientRect().top;
    if (w.t0) w.frames.push([now, top === null || Math.abs(top - layer.getBoundingClientRect().bottom) < 0.5 ? null : top]);
    if (!w.t0 || now - w.t0 < 1000) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
/** Ms to the first frame from which the sheet no longer moves: open, or closed (out of sight or hidden). [from the click, from the input] */
const settled = (p, closing) => p.evaluate((closing) => {
  const { t0, input, frames } = window.__w;
  if (!t0 || !frames.length) return [null, null];
  const last = frames.at(-1)[1];
  if (closing ? last !== null : last === null) return [null, null];
  let i = frames.length - 1;
  while (i > 0 && (closing ? frames[i - 1][1] === null : frames[i - 1][1] !== null && Math.abs(frames[i - 1][1] - last) < 0.5)) i--;
  return [Math.round(frames[i][0] - t0), Math.round(frames[i][0] - input)];
}, closing);
const fast = (r) => r[0] !== null && r[0] <= 220;
const said = (rs) => rs.map(([a, b]) => `${a} ms (input ${b})`).join(", ");

// ---- 1. the Apps drawer opens and closes in 200 ms (plus a frame), at 4x CPU ----
// Timed, so only on a quiet host (tests/quiet-host.mjs), a group for each phone; the load is printed after each open and close.
for (const profile of ["iphone", "pixel"]) {
  const say = (s) => `${profile}, 4x CPU: ${s}`;
  const names = [say("tap the Apps tab: sheet open and still in <= 220 ms"), say("a scrim tap closes it in <= 220 ms"), say("the handle closes it in <= 220 ms"), say("Escape closes it in <= 220 ms"), say("no page errors")];
  await group(`${profile}: Apps drawer at 4x CPU`, {
    judged: "a timed check",
    names: () => names,
    async run() {
      const p = await page(profile, "#/agents", { cpu: 4 });
      await p.waitForSelector(".tab-apps");
      await sleep(1500);
      const hosts = [];
      const open = async () => { await watch(p); const host = meter(); await p.touchscreen.tap(...await center(p, ".tab-apps")); await sleep(1100); hosts.push(host()); return settled(p, false); };
      const close = async (how) => { await watch(p); const host = meter(); await how(); await sleep(1100); hosts.push(host()); return settled(p, true); };
      const opened = [];
      for (let i = 0; i < 3; i++) {
        opened.push(await open());
        if (i < 2) await close(async () => p.keyboard.press("Escape"));
      }
      const scrim = await close(async () => p.touchscreen.tap(PROFILES[profile].viewport.width / 2, 40));
      await open();
      const handle = await close(async () => p.touchscreen.tap(...await center(p, ".drawer-handle")));
      await open();
      const esc = await close(async () => p.keyboard.press("Escape"));
      console.log(say(`opened ${said(opened)}; closed by the scrim ${said([scrim])}, the handle ${said([handle])}, Escape ${said([esc])}; ${saidAll(hosts)}`));
      const checks = [
        { name: names[0], ok: opened.every(fast), extra: said(opened), timed: true },
        { name: names[1], ok: fast(scrim), extra: said([scrim]), timed: true },
        { name: names[2], ok: fast(handle), extra: said([handle]), timed: true },
        { name: names[3], ok: fast(esc), extra: said([esc]), timed: true },
        { name: names[4], ok: p.errors.length === 0, extra: p.errors.join(" | ") },
      ];
      await p.context().close();
      return { checks, runs: hosts };
    },
  });
}
{
  const p = await page("iphone", "#/agents", { reducedMotion: "reduce" });
  await p.waitForSelector(".tab-apps");
  await sleep(800);
  await watch(p);
  await p.touchscreen.tap(...await center(p, ".tab-apps"));
  await sleep(600);
  const [ms] = await settled(p, false);
  const moved = await p.evaluate(() => new Set(window.__w.frames.filter(([, y]) => y !== null).map(([, y]) => Math.round(y))).size);
  check("reduced motion: the sheet opens at once (one position, <= 50 ms)", ms !== null && ms <= 50 && moved === 1, `${ms} ms, ${moved} positions`);
  await p.context().close();
}

// ---- 2. Needs-you cards leave room for the rest on an iPhone 14 ----
for (const profile of ["iphone", "pixel"]) {
  const p = await page(profile, "#/agents");
  await p.waitForSelector(".row.needs .choice");
  await sleep(800);
  const r = await p.evaluate(() => {
    const fold = document.querySelector(".tabs").getBoundingClientRect().top;
    const rows = [...document.querySelectorAll(".inbox-lists .row")].filter((e) => e.offsetParent);
    const choices = [...document.querySelectorAll(".row-choices .choice")].map((e) => e.getBoundingClientRect());
    const bars = [...document.querySelectorAll(".row-choices:not([hidden])")].map((b) => new Set([...b.children].map((c) => Math.round(c.getBoundingClientRect().top))).size);
    const short = [...document.querySelectorAll(".inbox-lists .row.done, .inbox-lists .row.working")].filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().height));
    return { fold, rows: rows.length, above: rows.filter((e) => e.getBoundingClientRect().bottom <= fold).length, minChoice: Math.min(...choices.map((c) => c.height)), bars, short: [...new Set(short)] };
  });
  const say = (s) => `${profile}: ${s}`;
  // Fully above the tab bar: a row under it can't be read or tapped. The bar is 7 on an iPhone 14; the Pixel's count is logged.
  if (profile === "iphone") check(say(">= 7 agent rows fully above the tab bar with the fixture's agents"), r.above >= 7, JSON.stringify(r));
  console.log(`${profile}: ${r.above} agent rows fully above the tab bar (y < ${r.fold})`);
  check(say("Done and Working rows are 44 px (--tap)"), r.short.length > 0 && r.short.every((h) => h === 44), JSON.stringify(r.short));
  check(say("every choice is >= 44 px tall"), r.minChoice >= 44, String(r.minChoice));
  check(say("up to 3 choices sit side by side, on one line"), r.bars.length >= 2 && r.bars.every((n) => n === 1), JSON.stringify(r.bars));
  await shot(p, `${profile}-agents`);
  await p.context().close();
}

const headers = [];
// ---- 3. desktop lists sit in one readable column (Tasks, Thoughts), Notes beside the open note; rows of --row; phones as they were ----
for (const [screen, rowSel, listSel] of [["tasks", ".d-task", ".d-list"], ["notes", ".d-note", ".d-list"], ["thoughts", ".th-row", ".d-list"]]) {
  const p = await page("desktop", `#/${screen}`);
  await p.waitForSelector(`${listSel} ${rowSel}`, { timeout: 15000 });
  await sleep(500);
  const r = await p.evaluate(([rowSel, listSel]) => {
    const rows = [...document.querySelectorAll(`${listSel} ${rowSel}`)].map((e) => Math.round(e.getBoundingClientRect().height));
    const view = document.querySelector(".view").getBoundingClientRect(), list = document.querySelector(listSel).getBoundingClientRect();
    const h1 = document.querySelector(".view h1").getBoundingClientRect();
    return { rows: rows.length, tallest: Math.max(...rows), list: Math.round(list.width), left: Math.round(list.left - view.left), right: Math.round(view.right - list.right), h1: Math.round(h1.left), h1Top: Math.round(h1.top) };
  }, [rowSel, listSel]);
  if (screen === "notes") {
    check("desktop 1440: notes rows are <= 64 px (title and a line of it)", r.rows >= 10 && r.tallest <= 64, JSON.stringify(r));
    check("desktop 1440: the notes list is a 320-400 px column at the left", r.list >= 320 && r.list <= 400 && r.left === 0, JSON.stringify(r));
    // Opening one: it's beside the list, which stays where it was; another row swaps it, and Esc puts the list back alone.
    const names = await p.$$eval(".d-note .d-note-title", (es) => es.map((e) => e.textContent));
    await p.click(".d-note >> nth=0");
    await p.waitForSelector(".n-dock .d-editor .d-title");
    const open = await p.evaluate(() => {
      const e = document.querySelector(".d-editor").getBoundingClientRect(), l = document.querySelector(".d-list").getBoundingClientRect();
      return { beside: e.left >= l.right - 1, top: Math.round(e.top), on: document.querySelectorAll(".d-note.on").length, title: document.querySelector(".d-editor .d-title").value, depth: history.length };
    });
    check("desktop: a note opens beside the list, the list still there and its row marked", open.beside && open.on === 1 && names[0].includes(open.title), JSON.stringify(open));
    await p.click(".d-note >> nth=1");
    await p.waitForFunction((t) => document.querySelector(".n-dock .d-editor .d-title")?.value !== t, open.title, { timeout: 5000 }).catch(() => {});
    const swapped = await p.evaluate(() => ({ editors: document.querySelectorAll(".d-editor").length, title: document.querySelector(".d-editor .d-title").value, depth: history.length, on: document.querySelector(".d-note.on .d-note-title")?.textContent }));
    check("desktop: another row swaps the open note, one editor, no new history entry", swapped.editors === 1 && swapped.title !== open.title && swapped.depth === open.depth && swapped.on?.includes(swapped.title), JSON.stringify(swapped));
    await p.keyboard.press("Escape");
    check("desktop: Esc closes it, and the dock says what to do", await p.waitForFunction(() => !document.querySelector(".d-editor") && !!document.querySelector(".n-idle")?.offsetParent, null, { timeout: 3000 }).then(() => true, () => false));
  } else {
    check(`desktop 1440: ${screen} rows are <= 44 px`, r.rows >= 10 && r.tallest <= 44, JSON.stringify(r));
    check(`desktop 1440: the ${screen} list is one centred column, 720-800 px`, r.list >= 720 && r.list <= 800 && Math.abs(r.left - r.right) <= 2, JSON.stringify(r));
    headers.push([screen, r.h1, r.h1Top]);
  }
  check(`desktop: no page errors on ${screen}`, p.errors.length === 0, p.errors.join(" | "));
  await shot(p, `desktop-${screen}`);
  await p.context().close();
  const phone = await page("iphone", `#/${screen}`);
  await phone.waitForSelector(`${listSel} ${rowSel}`, { timeout: 15000 });
  const ph = await phone.evaluate(([rowSel, listSel]) => ({ shortest: Math.min(...[...document.querySelectorAll(`${listSel} ${rowSel}`)].map((e) => e.getBoundingClientRect().height)), list: document.querySelector(listSel).getBoundingClientRect().width }), [rowSel, listSel]);
  check(`iphone: ${screen} keeps its phone rows (>= 52 px, full width)`, ph.shortest >= 52 && ph.list === 390, JSON.stringify(ph));
  await phone.context().close();
}
// The other column screens: their titles start where Tasks' does, at the same height.
for (const screen of ["settings", "files", ...(EXT ? ["music", "tools", "social"] : [])]) {
  const p = await page("desktop", `#/${screen}`);
  await p.waitForSelector(".view h1", { timeout: 15000 });
  await sleep(300);
  const h1 = await p.evaluate(() => { const r = document.querySelector(".view h1").getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; });
  headers.push([screen, ...h1]);
  await p.context().close();
}
check("desktop: every column screen's title starts at the same x and y", headers.every(([, x, y]) => x === headers[0][1] && y === headers[0][2]), JSON.stringify(headers));

// ---- 4. By place doesn't repeat By state (L-15): Needs you is one line to By state, and nothing above the layouts twice ----
// The fixture's layouts, and a Recent that names panes Needs you and Favorites have too (gateway-review is all three).
const A = addresses(port);
seedLayouts(port, A);
const RECENT = JSON.stringify(["gateway-review", "pr-branch", "token-refresh", "ci-gateway", "chat-agent"].map((n) => A[n]));
for (const profile of ["iphone", "pixel", "desktop"]) {
  for (const theme of ["dark", "light"]) {
    const say = (s) => `${profile} ${theme}, By place: ${s}`;
    const p = await page(profile, "#/panes", { theme, prefs: { "lumbridge.panes.recent": RECENT } });
    await p.waitForSelector(".pm-machine .pm-space-head", { timeout: 15000 });
    await p.waitForSelector(".pm-needs, .pm-lists > .group.needs", { timeout: 15000 });
    await sleep(600);
    const r = await p.evaluate((gw) => {
      const kids = [...document.querySelector(".pm-lists").children];
      const first = kids.findIndex((e) => e.classList.contains("pm-machine"));
      const above = kids.slice(0, first);
      const seen = above.flatMap((g) => [...g.querySelectorAll(".row[data-address]")].map((e) => e.dataset.address));
      const twice = [...new Set(seen.filter((a, i) => seen.indexOf(a) !== i))];
      const needs = document.querySelector(".pm-needs, .pm-lists > .group.needs");
      const head = document.querySelector(".pm-machine .pm-space-head").getBoundingClientRect();
      const tabs = document.querySelector(".tabs");
      const fold = tabs?.offsetParent ? tabs.getBoundingClientRect().top : innerHeight;
      return {
        groups: above.map((g) => g.className), twice, needsH: Math.round(needs.getBoundingClientRect().height), needsText: needs.textContent,
        needsRows: needs.querySelectorAll(".row").length, headBottom: Math.round(head.bottom), fold: Math.round(fold),
        marked: !!document.querySelector(`.pm-machine .pm-rows .row.needs[data-address="${gw}"]`),
      };
    }, A["gateway-review"]);
    console.log(say(JSON.stringify(r)));
    check(say("no pane address in two of the groups above the first machine's layout"), r.twice.length === 0, JSON.stringify(r.twice));
    check(say("Needs you is one line, no rows in it, with its count"), r.needsRows === 0 && /^Needs you\d+/.test(r.needsText), r.needsText.slice(0, 80));
    if (profile !== "desktop") check(say(`the Needs you line is <= 48 px tall (${r.needsH})`), r.needsH <= 48, String(r.needsH));
    check(say("a pane that needs the owner is still marked in its place"), r.marked);
    if (profile === "iphone") check(say(`the first machine's first space header is on the first screen (bottom ${r.headBottom} <= ${r.fold})`), r.headBottom <= r.fold, JSON.stringify(r));
    await shot(p, `${profile}-${theme}-by-place`);
    if (theme === "dark") {
      if (profile === "desktop") {
        // From the keyboard: Tab reaches it, Enter takes the owner there.
        let on = false;
        for (let i = 0; i < 60 && !on; i++) { await p.keyboard.press("Tab"); on = await p.evaluate(() => document.activeElement?.classList.contains("pm-needs")); }
        check(say("Tab reaches the Needs you line"), on);
        if (on) await p.keyboard.press("Enter");
      } else if (await p.$(".pm-needs")) {
        await p.touchscreen.tap(...await center(p, ".pm-needs"));
      }
      const went = await p.evaluate(() => new Promise((ok) => setTimeout(() => ok({ hash: location.hash, on: document.querySelector(".list-btn.on")?.dataset.list }), 400)));
      check(say(`the Needs you line goes to By state in one ${profile === "desktop" ? "Enter" : "tap"}`), went.hash === "#/agents" && went.on === "agents", JSON.stringify(went));
    }
    check(say("no page errors"), p.errors.length === 0, p.errors.join(" | "));
    await p.context().close();
  }
}

// Back from a pane opened far down By place: the scroll is the same, and Recent, which would grow above it, waits until the owner is back up.
{
  const say = (s) => `iphone, By place: ${s}`;
  const p = await page("iphone", "#/panes");
  await p.waitForSelector(".pm-machine .pm-rows .row", { timeout: 15000 });
  await sleep(600);
  const api = A["acme-api"];
  const y0 = await p.evaluate((a) => { const s = document.querySelector(".place"), r = document.querySelector(`.pm-rows .row[data-address="${a}"]`); s.scrollTop += r.getBoundingClientRect().top - s.getBoundingClientRect().top - 120; return s.scrollTop; }, api);
  await sleep(100);
  await p.touchscreen.tap(...await center(p, `.pm-rows .row[data-address="${api}"] a`));
  await p.waitForSelector(".xterm-rows");
  await p.touchscreen.tap(...await center(p, ".back"));
  await p.waitForSelector(".pm-machine .pm-rows .row");
  await sleep(300);
  const back = await p.evaluate(() => ({ y: document.querySelector(".place").scrollTop, recent: document.querySelectorAll(".place .group.recent").length }));
  check(say(`back from a pane far down, the scroll is the same (${y0} -> ${back.y}) and Recent hasn't moved it`), y0 > 300 && Math.abs(back.y - y0) < 2 && back.recent === 0, JSON.stringify(back));
  await p.evaluate(() => { document.querySelector(".place").scrollTop = 0; });
  check(say("scrolled back up, Recent has the pane"), await (async () => { for (let i = 0; i < 20; i++) { if (await p.evaluate((a) => !!document.querySelector(`.place .group.recent .row[data-address="${a}"]`), api)) return true; await sleep(100); } return false; })());
  check(say("no page errors"), p.errors.length === 0, p.errors.join(" | "));
  await p.context().close();
}

// ---- 5. Files: the capture row fits (L-18). A phone: <= 120 px from the top of the view to search; a mouse: one Add files ----
for (const profile of ["iphone", "pixel", "desktop"]) {
  const say = (s) => `${profile}, Files: ${s}`;
  const p = await page(profile, "#/files");
  await p.waitForSelector(".fi-hero");
  await p.waitForSelector(".fi-chip");
  await sleep(600);
  const r = await p.evaluate(() => {
    const view = document.querySelector(".fi-view").getBoundingClientRect();
    const search = document.querySelector(".d-search").getBoundingClientRect();
    const shown = [...document.querySelectorAll(".fi-view button")].filter((b) => !b.closest(".fi-shooting") && b.offsetParent && b.getBoundingClientRect().bottom <= search.top)
      .map((b) => { const r = b.getBoundingClientRect(); return { text: b.textContent, h: Math.round(r.height), top: Math.round(r.top) }; });
    return { capture: Math.round(search.top - view.top), shown };
  });
  console.log(say(JSON.stringify(r)));
  const texts = r.shown.map((b) => b.text);
  const chooser = async (text) => {
    const [fc] = await Promise.all([p.waitForEvent("filechooser", { timeout: 3000 }).catch(() => null), p.click(`.fi-hero button:visible:has-text("${text}")`, { timeout: 3000 }).catch(() => {})]);
    return fc && { multiple: fc.isMultiple(), accept: await fc.element().getAttribute("accept"), capture: await fc.element().getAttribute("capture") };
  };
  if (profile === "desktop") {
    const b = r.shown[0];
    check(say(`one Add files button above search, no Take photos (${texts.join(" | ")})`), texts.length === 1 && texts[0] === "Add files", texts.join(" | "));
    check(say(`Add files is 36-40 px tall, at the density rule (${b?.h})`), b && b.h >= 36 && b.h <= 40, JSON.stringify(b));
    const fc = await chooser("Add files");
    check(say("Add files opens a picker for several files of any kind"), fc?.multiple && !fc.accept && !fc.capture, JSON.stringify(fc));
    console.log(say(`capture area ${r.capture} px`));
  } else {
    check(say(`the capture area, title included, is <= 120 px (${r.capture})`), r.capture <= 120, String(r.capture));
    const want = ["Take photos", "Add from library", "PDF or file"];
    check(say("Take photos, Add from library and PDF or file, in one row"), want.every((w) => texts.includes(w)) && new Set(r.shown.map((b) => b.top)).size === 1, JSON.stringify(r.shown));
    check(say("each is >= 44 px tall"), r.shown.length > 0 && r.shown.every((b) => b.h >= 44), JSON.stringify(r.shown));
    check(say("Take photos opens the back camera"), (await chooser("Take photos"))?.capture === "environment");
    const lib = await chooser("Add from library");
    check(say("Add from library takes several photos"), lib?.multiple && lib.accept === "image/*", JSON.stringify(lib));
    const other = await chooser("PDF or file");
    check(say("PDF or file takes any file"), other?.multiple && !other.accept && !other.capture, JSON.stringify(other));
  }
  // The chip row's edge fade: at an edge with more beyond it, and only there.
  const fade = () => p.evaluate(() => {
    const c = document.querySelector(".fi-chips"), w = c.parentElement;
    const on = (pseudo) => { const s = getComputedStyle(w, pseudo); return s.content !== "none" && s.content !== "normal" && Number(s.opacity) > 0.9; };
    return { left: Math.round(c.scrollLeft), right: Math.round(c.scrollWidth - c.clientWidth - c.scrollLeft), leftFade: on("::before"), rightFade: on("::after") };
  });
  const matches = (f) => f.leftFade === f.left > 4 && f.rightFade === f.right > 4;
  const f0 = await fade();
  check(say("the chips' edge fades show exactly where there's more"), matches(f0), JSON.stringify(f0));
  if (profile !== "desktop") {
    check(say("on a phone the chips run past the right edge, and the fade says so"), f0.right > 4 && f0.rightFade, JSON.stringify(f0));
    await p.evaluate(() => { const c = document.querySelector(".fi-chips"); c.scrollLeft = c.scrollWidth; });
    await sleep(400);
    const f1 = await fade();
    check(say("scrolled to the end, the fade moves to the left"), matches(f1) && f1.leftFade && !f1.rightFade, JSON.stringify(f1));
  }
  await shot(p, `${profile}-files`);
  check(say("no page errors"), p.errors.length === 0, p.errors.join(" | "));
  await p.context().close();
}

await browser.close();
console.log(failed ?`\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
