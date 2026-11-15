// Notes and Tasks after a reload with no network, or with the server unreachable, in Chrome as an iPhone 14 and a computer, against
// a scratch gateway and a database of its own on the throwaway Postgres. Starts and stops everything itself:
//   scripts/dev-db.sh && node tests/lists-offline-verify.mjs <port>
// A first load that failed is not an empty list: no "No notes yet", no "N open", one line saying why with Try again, the
// captures kept on the device still listed under it, and the real lists back by themselves with the network.
// LUMBRIDGE_PG_PORT picks the throwaway Postgres (default 5498). Needs web/dist and psql. Never `playwright install`.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PG_PORT, stopOnExit } from "./ports.mjs";
import { chromium, PROFILES } from "./ui-lib.mjs";

const [port] = process.argv.slice(2);
if (!port) { console.error("usage: lists-offline-verify.mjs <port>"); process.exit(2); }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0, passed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  [${extra}]`}`); if (ok) passed++; else failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(100); } return false; };

// ---- A database of its own ------------------------------------------------------------------------------------------

const psqlBin = [process.env.LUMBRIDGE_PG_BIN && `${process.env.LUMBRIDGE_PG_BIN}/psql`].find((p) => p && existsSync(p)) ?? "psql";
const SERVER = `postgres://postgres:lumbridge-throwaway@127.0.0.1:${PG_PORT}`;
const DB = `lumbridge_lists_${process.pid}`;
const sql = (q, db = DB) => execFileSync(psqlBin, [`${SERVER}/${db}`, "-v", "ON_ERROR_STOP=1", "-Atqc", q], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
sql(`create database ${DB}`, "postgres");
spawnSync(psqlBin, [`${SERVER}/${DB}`, "-qc", "create role lumbridge_app login noinherit password 'dev'; alter role lumbridge_app set search_path = lumbridge"], { stdio: "ignore" });
sql("create schema lumbridge authorization lumbridge_app; revoke all on schema lumbridge from public");
const DB_URL = `postgres://lumbridge_app:dev@127.0.0.1:${PG_PORT}/${DB}`;

// ---- The gateway ----------------------------------------------------------------------------------------------------

const dev = (...a) => spawnSync("bash", [`${repo}/scripts/dev.sh`, port, ...a], { env: { ...process.env, LUMBRIDGE_DATABASE_URL: DB_URL }, encoding: "utf8" });
let cleaned = false;
const cleanUp = () => {
  if (cleaned) return;
  cleaned = true;
  dev("stop");
  try { sql(`drop database ${DB} with (force)`, "postgres"); } catch { /* it's a throwaway server */ }
};
stopOnExit(cleanUp);
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
const up = dev();
if (up.status !== 0) { console.error(up.stdout, up.stderr); process.exit(1); }
const migrated = spawnSync(`${repo}/gateway/target/debug/lumbridge-mobile-server`, ["migrate"], { env: { LUMBRIDGE_DATABASE_URL: DB_URL }, encoding: "utf8" });
if (migrated.status !== 0) { console.error(migrated.stderr); process.exit(1); }
const tok = readFileSync(`/run/user/${process.getuid()}/k${port}/token`, "utf8").trim();
const BASE = `http://127.0.0.1:${port}/`;
const api = async (method, p, body) => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(BASE + p.slice(1), { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return r.status;
    } catch (e) { if (i > 50) throw e; await sleep(100); } // the gateway is a moment behind dev.sh
  }
};

// Fake text only: three notes and five open tasks.
const NOTES = ["Packing list", "Garage door sensor", "Birthday ideas"];
const TASKS = ["Renew the domain", "Call the plumber", "Return the drill", "Book the car service", "Water the plants"];
for (const title of NOTES) await api("POST", "/api/notes", { id: crypto.randomUUID(), title, body: "Some words." });
for (const [i, title] of TASKS.entries()) await api("POST", "/api/tasks", { id: crypto.randomUUID(), title, due_on: null, sort_key: Date.now() + i });
check("seeded: 3 notes, 5 tasks", sql("select count(*) from lumbridge.notes") === "3" && sql("select count(*) from lumbridge.tasks") === "5",
  `${sql("select count(*) from lumbridge.notes")} ${sql("select count(*) from lumbridge.tasks")}`);

// ---- The browser ----------------------------------------------------------------------------------------------------

const browser = await chromium.launch({ channel: "chrome" });
// What a dead network or a refused request logs. That's the case being tested, not a fault in the page.
const noise = /Failed to load resource|ERR_|503|WebSocket/;
async function device(profile) {
  const ctx = await browser.newContext({ ...PROFILES[profile], colorScheme: "dark" });
  await ctx.addInitScript((t) => { try { localStorage.setItem("lumbridge.token", t); } catch {} }, tok);
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(`pageerror: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !noise.test(m.text())) p.errors.push(`console: ${m.text()}`); });
  return p;
}
const go = (p, hash) => p.evaluate((h) => { location.hash = h; }, hash);
const viewText = (p) => p.evaluate(() => document.querySelector(".d-view")?.textContent ?? "");
const notice = (p) => p.evaluate(() => { const n = document.querySelector(".d-view .d-notice"); return n && !n.hidden ? n.textContent : ""; });
const tryAgain = (p) => p.locator(".d-view .d-notice button", { hasText: "Try again" });
const noteRows = (p) => p.evaluate(() => [...document.querySelectorAll(".d-view .d-note .d-note-title")].map((e) => e.textContent));
const taskRows = (p) => p.evaluate(() => [...document.querySelectorAll(".d-view .d-task:not(.done) .d-task-title")].map((e) => e.textContent));
const countText = (p) => p.evaluate(() => document.querySelector(".d-view .d-count")?.textContent ?? "");
const hasAll = (got, want) => want.every((w) => got.includes(w));
/** The "Not loaded" line sits above the given row: what's on the device shows under it. */
const lineAbove = (p, sel) => p.evaluate((s) => {
  const n = document.querySelector(".d-view .d-notice"), r = document.querySelector(s);
  return !!n && !!r && n.getBoundingClientRect().bottom <= r.getBoundingClientRect().top + 1;
}, sel);
const OFF = "Not loaded: you're offline.";
const AWAY = "Can't reach Lumbridge right now.";

for (const profile of ["iphone", "desktop"]) {
  const say = (s) => `${profile}: ${s}`;
  const capture = `Buy stamps (${profile})`;

  // ---- Loaded once online, then a reload with no network ----
  {
    const p = await device(profile);
    await p.goto(BASE + "#/notes");
    check(say("online: Notes lists all three"), await until(async () => hasAll(await noteRows(p), NOTES)), JSON.stringify(await noteRows(p)));
    await go(p, "#/tasks");
    check(say("online: Tasks says 5 open"), await until(async () => (await countText(p)) === "5 open" && hasAll(await taskRows(p), TASKS)), await countText(p));
    // The shell has to be on the device before a reload with no network can open the app at all.
    check(say("the app shell is kept for offline"), await until(() => p.evaluate(async () => !!(await navigator.serviceWorker.ready) && !!(await caches.match("/")))));
    // As on a device that has opened the app before: one load with the worker in charge, which keeps the rest of the shell
    // (theme-boot.js isn't precached; a first visit loaded it before the worker was there).
    await p.reload();
    check(say("reloaded online: still 5 open"), await until(async () => (await countText(p)) === "5 open"), await countText(p));
    check(say("the whole shell is kept"), await until(() => p.evaluate(async () => !!navigator.serviceWorker.controller && !!(await caches.match("/theme-boot.js")))));

    await p.context().setOffline(true);
    await p.fill(".d-capture input", capture);
    await p.press(".d-capture input", "Enter");
    check(say("offline: a capture is kept on the device"), await until(async () => (await taskRows(p)).includes(capture)), JSON.stringify(await taskRows(p)));

    await p.reload();
    await p.waitForSelector(".d-view", { timeout: 15000 });
    check(say("reloaded offline: Tasks says Not loaded: you're offline."), await until(async () => (await notice(p)).startsWith(OFF)), await notice(p));
    check(say("with Try again"), (await tryAgain(p).count()) === 1 && await tryAgain(p).isVisible());
    check(say("no count"), (await countText(p)) === "", await countText(p));
    check(say("no N open anywhere"), !/\d+ open/.test(await viewText(p)), await viewText(p));
    check(say("no empty state"), !/Nothing to do yet|All done/.test(await viewText(p)), await viewText(p));
    check(say("the unsent capture is still listed"), JSON.stringify(await taskRows(p)) === JSON.stringify([capture]), JSON.stringify(await taskRows(p)));
    check(say("still saying it's kept on this device"), await p.evaluate(() => [...document.querySelectorAll(".d-task.unsaved")].some((r) => r.textContent.includes("Not saved yet"))));
    check(say("under the Not loaded line"), await lineAbove(p, ".d-view .d-task.unsaved"));

    await go(p, "#/notes");
    check(say("Notes says Not loaded: you're offline."), await until(async () => (await notice(p)).startsWith(OFF)), await notice(p));
    check(say("with Try again"), (await tryAgain(p).count()) === 1 && await tryAgain(p).isVisible());
    check(say("never No notes yet"), !(await viewText(p)).includes("No notes yet"), await viewText(p));
    check(say("and no Write a note in its place"), !(await viewText(p)).includes("Write a note"), await viewText(p));
    await tryAgain(p).click();
    await sleep(500);
    check(say("Try again while still offline: the same line, still no empty state"), (await notice(p)).startsWith(OFF) && !(await viewText(p)).includes("No notes yet"), await viewText(p));

    // ---- The network back: the lists come by themselves ----
    await p.context().setOffline(false);
    check(say("back online: the notes come back by themselves"), await until(async () => hasAll(await noteRows(p), NOTES)), JSON.stringify(await noteRows(p)));
    check(say("and the line goes"), await until(async () => (await notice(p)) === ""), await notice(p));
    await go(p, "#/tasks");
    check(say("Tasks: the real list, the capture sent, and the count"), await until(async () => (await countText(p)) === "6 open" && hasAll(await taskRows(p), [...TASKS, capture])), `${await countText(p)} ${JSON.stringify(await taskRows(p))}`);
    check(say("the capture saved once"), sql(`select count(*) from lumbridge.tasks where title = '${capture.replace(/'/g, "''")}'`) === "1");
    check(say("no line on Tasks either"), await until(async () => (await notice(p)) === ""), await notice(p));
    check(say("no errors"), p.errors.length === 0, p.errors.join("; "));
    await p.context().close();
    sql(`delete from lumbridge.tasks where title = '${capture.replace(/'/g, "''")}'`);
  }

  // ---- Online, but Lumbridge can't answer ----
  {
    const p = await device(profile);
    const refuse = (r) => r.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    await p.route(/\/api\/(notes|tasks)(\?|$)/, refuse);
    await p.goto(BASE + "#/notes");
    await p.waitForSelector(".d-view", { timeout: 15000 });
    check(say("unreachable: Notes says Can't reach Lumbridge right now."), await until(async () => (await notice(p)).startsWith(AWAY)), await notice(p));
    check(say("with Try again"), (await tryAgain(p).count()) === 1);
    check(say("never No notes yet"), !(await viewText(p)).includes("No notes yet"), await viewText(p));
    await go(p, "#/tasks");
    check(say("unreachable: Tasks says Can't reach Lumbridge right now."), await until(async () => (await notice(p)).startsWith(AWAY)), await notice(p));
    check(say("no count, no empty state"), (await countText(p)) === "" && !/Nothing to do yet|\d+ open/.test(await viewText(p)), await viewText(p));
    await p.unroute(/\/api\/(notes|tasks)(\?|$)/, refuse);
    await tryAgain(p).click();
    check(say("Try again once it answers: the list and the count"), await until(async () => (await countText(p)) === "5 open" && (await notice(p)) === ""), `${await countText(p)} ${await notice(p)}`);
    await go(p, "#/notes");
    check(say("and Notes loads"), await until(async () => hasAll(await noteRows(p), NOTES)), JSON.stringify(await noteRows(p)));
    check(say("no errors"), p.errors.length === 0, p.errors.join("; "));
    await p.context().close();
  }
}

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
