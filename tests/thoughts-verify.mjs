// Thoughts in Chrome, with its fake microphone, against a scratch gateway, a fake speech service and a database of its own on the throwaway
// Postgres. Starts and stops everything itself:
//   scripts/dev-db.sh && node tests/thoughts-verify.mjs <port> [shots dir]
// LUMBRIDGE_PG_PORT picks the throwaway Postgres (default 5498), as scripts/ci-db.sh and scripts/dev-db.sh do.
// Needs web/dist and psql. A real phone's mic isn't something this can tell you about. Never `playwright install`.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PG_PORT, stopOnExit } from "./ports.mjs";
import { chromium, PROFILES } from "./ui-lib.mjs";

const [port, shots] = process.argv.slice(2);
if (!port) { console.error("usage: thoughts-verify.mjs <port> [shots dir]"); process.exit(2); }
if (shots) mkdirSync(shots, { recursive: true });
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0, passed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  [${extra}]`}`); if (ok) passed++; else failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(100); } return false; };
const shot = async (p, name) => { if (shots) { await sleep(150); await p.screenshot({ path: `${shots}/${name}.png` }); } };

// ---- A database of its own ------------------------------------------------------------------------------------------

const psqlBin = [process.env.LUMBRIDGE_PG_BIN && `${process.env.LUMBRIDGE_PG_BIN}/psql`].find((p) => p && existsSync(p)) ?? "psql";
const SERVER = `postgres://postgres:lumbridge-throwaway@127.0.0.1:${PG_PORT}`;
const DB = `lumbridge_thoughts_${process.pid}`;
const sql = (q, db = DB) => execFileSync(psqlBin, [`${SERVER}/${db}`, "-v", "ON_ERROR_STOP=1", "-Atqc", q], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
sql(`create database ${DB}`, "postgres");
spawnSync(psqlBin, [`${SERVER}/${DB}`, "-qc", "create role lumbridge_app login noinherit password 'dev'; alter role lumbridge_app set search_path = lumbridge"], { stdio: "ignore" });
sql("create schema lumbridge authorization lumbridge_app; revoke all on schema lumbridge from public");
const URL_ = `postgres://lumbridge_app:dev@127.0.0.1:${PG_PORT}/${DB}`;
const count = (where = "true") => Number(sql(`select count(*) from lumbridge.thoughts where ${where}`));
const bodies = () => sql("select body from lumbridge.thoughts where deleted_at is null order by created_at").split("\n").filter(Boolean);
const wipe = () => sql("delete from lumbridge.thoughts; delete from lumbridge.notes");

// ---- The speech host, as far as the gateway can tell --------------------------------------------------------------------------

const speech = { up: true, heard: [], n: 0, inflight: 0, lastDown: 0 };
const fake = createServer((req, res) => {
  const parts = [];
  speech.inflight++;
  req.on("data", (d) => parts.push(d));
  req.on("end", () => {
    const bytes = Buffer.concat(parts).length;
    speech.inflight--;
    if (!speech.up) { speech.lastDown = Date.now(); res.writeHead(503); res.end("{}"); return; }
    speech.n++;
    speech.heard.push({ lane: req.headers["x-lane"], bytes, n: speech.n });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: `part${speech.n}` }));
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const asr = `http://127.0.0.1:${fake.address().port}/v1/audio/transcriptions`;
const heardReset = () => { speech.heard = []; speech.n = 0; speech.up = true; };

// ---- The gateway ----------------------------------------------------------------------------------------------------

const dev = (...a) => spawnSync("bash", [`${repo}/scripts/dev.sh`, port, ...a], {
  env: { ...process.env, LUMBRIDGE_DATABASE_URL: URL_, LUMBRIDGE_ASR_PRIMARY_URL: "", LUMBRIDGE_ASR_URL: asr, LUMBRIDGE_ASR_FALLBACK_URL: asr }, encoding: "utf8",
});
// Whatever happens below, nothing stays behind.
let cleaned = false;
const cleanUp = () => {
  if (cleaned) return;
  cleaned = true;
  dev("stop");
  try { sql(`drop database ${DB} with (force)`, "postgres"); } catch { /* it's a throwaway server */ }
};
// On Ctrl-C and SIGTERM too, not only a normal exit.
stopOnExit(cleanUp);
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
const up = dev();
if (up.status !== 0) { console.error(up.stdout, up.stderr); process.exit(1); }
const bin = `${repo}/gateway/target/debug/lumbridge-mobile-server`;
const cli = (...a) => spawnSync(bin, a, { env: { LUMBRIDGE_DATABASE_URL: URL_ }, encoding: "utf8" });
const migrated = cli("migrate");
if (migrated.status !== 0) { console.error(migrated.stderr); process.exit(1); }
const tok = readFileSync(`/run/user/${process.getuid()}/k${port}/token`, "utf8").trim();
const BASE = `http://127.0.0.1:${port}/`;
const api = async (method, p, body) => {
  const r = await fetch(BASE + p.slice(1), { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const browser = await chromium.launch({ channel: "chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const noise = /Failed to load resource|ERR_|503/;

async function device(profile = "iphone", { noIdb = false } = {}) {
  const ctx = await browser.newContext({ ...PROFILES[profile], colorScheme: "dark", permissions: ["microphone"] });
  await ctx.addInitScript(({ tok, noIdb }) => {
    try { localStorage.setItem("lumbridge.token", tok); } catch {}
    if (noIdb) Object.defineProperty(window, "indexedDB", { get() { throw new Error("no storage here"); } });
    // So a check can see the mic is really off.
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__tracks = [];
    navigator.mediaDevices.getUserMedia = async (c) => { const s = await get(c); window.__tracks.push(...s.getTracks()); return s; };
  }, { tok, noIdb });
  return ctx;
}
async function open(ctx, hash = "#/thoughts") {
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(`pageerror: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !noise.test(m.text())) p.errors.push(`console: ${m.text()}`); });
  await p.goto(BASE + hash);
  return p;
}
const screen = async (ctx) => { const p = await open(ctx); await p.waitForSelector(".th-mic"); return p; };

const statusText = (p) => p.textContent(".th-status span");
const listening = (p) => until(async () => (await statusText(p)) === "Listening");
const micOn = (p) => p.evaluate(() => window.__tracks.some((t) => t.readyState === "live"));
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const rowText = (p) => p.evaluate(() => [...document.querySelectorAll(".th-row .th-text")].map((e) => e.textContent));
/** What's held on this device, straight from IndexedDB. */
const onDevice = (p) => p.evaluate(async () => {
  if (!(await indexedDB.databases()).some((d) => d.name === "lumbridge-thoughts")) return { sessions: 0, chunks: 0, audio: 0, bytes: 0 };
  const db = await new Promise((ok, no) => { const r = indexedDB.open("lumbridge-thoughts"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const all = (s) => new Promise((ok) => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => ok(r.result); });
  const [sessions, chunks, audio] = [await all("sessions"), await all("chunks"), await all("audio")];
  db.close();
  return { sessions: sessions.length, chunks: chunks.length, audio: audio.length, bytes: audio.reduce((s, a) => s + a.byteLength, 0) };
});
async function talk(p, ms) {
  await p.click(".th-mic");
  if (!(await listening(p))) throw new Error(`never listened: ${await statusText(p)}`);
  await sleep(ms);
}

// ---- The screen -----------------------------------------------------------------------------------------------------
{
  const ctx = await device("iphone");
  const p = await open(ctx, "#/agents");
  await p.waitForSelector(".tab-apps");
  await p.click(".tab-apps");
  await p.waitForSelector('.drawer a[href="#/thoughts"]');
  await p.click('.drawer a[href="#/thoughts"]');
  await p.waitForSelector(".th-mic");
  check("it's in the Apps sheet, and opens", true);
  await p.waitForSelector(".d-empty-title");
  check("says what to do when there's nothing yet", (await p.textContent(".d-empty-title")) === "Nothing yet");
  check("phone: no sideways scroll", (await overflow(p)) === 0);
  const box = await p.locator(".th-mic").boundingBox();
  check("the button is big", box.width >= 100 && box.height >= 100, JSON.stringify(box));
  await shot(p, "thoughts-empty-phone");
  check("no errors", p.errors.length === 0, p.errors.join("; "));
  await ctx.close();

  const c2 = await device("desktop");
  const d = await open(c2, "#/thoughts");
  await d.waitForSelector(".th-mic");
  const rail = await d.evaluate(() => [...document.querySelectorAll("nav.tabs .tab-label")].filter((e) => e.offsetParent).map((e) => e.textContent));
  check("on the rail on a computer", rail.includes("Thoughts"), rail.join());
  check("computer: no sideways scroll", (await overflow(d)) === 0);
  await shot(d, "thoughts-empty-desktop");
  await c2.close();
}

// ---- A short thought --------------------------------------------------------------------------------------------------
{
  wipe(); heardReset();
  const ctx = await device("iphone");
  const p = await screen(ctx);
  await talk(p, 3000);
  check("the button says it's a stop now", (await p.getAttribute(".th-mic", "aria-label")) === "Stop talking");
  check("elapsed time runs", /^0:0[2-9]$/.test(await p.textContent(".th-clock")), await p.textContent(".th-clock"));
  const moved = await until(() => p.evaluate(() => { const m = new DOMMatrix(getComputedStyle(document.querySelector(".th-meter i")).transform); return m.a > 0; }), 3000);
  check("the level moves", moved);
  check("the mic is on", await micOn(p));
  check("phone: no sideways scroll while recording", (await overflow(p)) === 0);
  await shot(p, "thoughts-recording-phone");
  await p.click(".th-mic");
  check("tapping again stops the mic", await until(async () => !(await micOn(p)), 2000));
  check("and the button goes back at once", (await statusText(p)) === "Tap to talk");
  check("saved as one voice thought", await until(() => count("source = 'voice'") === 1));
  check("through the private lane", speech.heard.length === 1 && speech.heard[0].lane === "private-no-capture", JSON.stringify(speech.heard));
  check("how long the owner talked is kept", Number(sql("select duration_ms from lumbridge.thoughts")) > 2500);
  check("it's in the list", await until(async () => (await rowText(p)).includes("part1")));
  check("under Today", await p.evaluate(() => document.querySelector(".th-day")?.textContent === "Today"));
  check("no audio left on the device", await until(async () => (await onDevice(p)).audio === 0), JSON.stringify(await onDevice(p)));
  check("no errors", p.errors.length === 0, p.errors.join("; "));
  await ctx.close();
}

// ---- A long one -------------------------------------------------------------------------------------------------------
{
  wipe(); heardReset();
  const ctx = await device("iphone");
  const p = await screen(ctx);
  await p.click(".th-mic");
  await listening(p);
  // Real time, on purpose: there's no test hook in the recorder. Chrome's fake mic beeps once a second.
  check("text shows while the owner is still talking", await until(() => p.evaluate(() => { const l = document.querySelector(".th-live"); return !l.hidden && l.textContent.includes("part1"); }), 62000));
  check("still recording", await micOn(p));
  await sleep(21000);
  await p.click(".th-mic");
  check("saved as one thought", await until(() => count() === 1));
  const body = sql("select body from lumbridge.thoughts");
  const n = speech.heard.length;
  check("split into chunks", n >= 2, String(n));
  check("joined in order", body === Array.from({ length: n }, (_, i) => `part${i + 1}`).join(" "), body);
  check("every chunk under the gateway's 4 MB", speech.heard.every((h) => h.bytes < 4 * 1024 * 1024), speech.heard.map((h) => h.bytes).join());
  check("audio cleared", await until(async () => (await onDevice(p)).audio === 0));
  await ctx.close();
}

// ---- Speech down, and coming back to it later ----------------------------------------------------------------------------
{
  wipe(); heardReset();
  speech.up = false;
  const ctx = await device("iphone");
  const p = await screen(ctx);
  await talk(p, 2500);
  await p.click(".th-mic");
  check("says it's waiting to transcribe", await until(() => p.evaluate(() => document.querySelector(".th-state")?.textContent === "Waiting to transcribe"), 20000));
  check("and that it's kept here", await p.evaluate(() => document.querySelector(".th-notice")?.textContent.includes("kept on this device")));
  const held = await onDevice(p);
  check("the audio is in IndexedDB", held.sessions === 1 && held.audio >= 1 && held.bytes > 44, JSON.stringify(held));
  check("nothing on the server", count() === 0);
  await shot(p, "thoughts-waiting-phone");

  await p.reload();
  await p.waitForSelector(".th-mic");
  check("still waiting after a reload", await until(() => p.evaluate(() => document.querySelector(".th-state")?.textContent === "Waiting to transcribe"), 20000));
  await p.close();

  // Reopening on some other screen is enough.
  speech.up = true;
  const q = await open(ctx, "#/tasks");
  check("retried on reopening, whichever screen", await until(() => count() === 1, 20000));
  check("the audio went once it was saved", await until(async () => (await onDevice(q)).audio === 0), JSON.stringify(await onDevice(q)));
  check("one thought", bodies().join() === "part1", bodies().join());
  await ctx.close();
}

// ---- Try now ------------------------------------------------------------------------------------------------------------
{
  wipe(); heardReset();
  speech.up = false;
  const ctx = await device("iphone");
  const p = await screen(ctx);
  await talk(p, 2000);
  await p.click(".th-mic");
  await p.waitForSelector(".th-notice:not([hidden]) button", { timeout: 20000 });
  // The page may still be asking (a second pass once the recording finished). Speech coming back mid-ask would save it before the
  // tap, and the notice with its button would be gone (CI on PR #95). Its own retry is >= 5 s after the last failure.
  await until(() => speech.inflight === 0 && Date.now() - speech.lastDown > 500, 5000);
  speech.up = true;
  await p.click(".th-notice button");
  check("Try now doesn't wait for the timer", await until(() => count() === 1, 5000));
  check("and the waiting row gives way to the saved one", await until(async () => (await rowText(p)).join() === "part1" && !(await p.$(".th-row.pending"))));
  await ctx.close();
}

// ---- The server down, then a save whose answer never arrives ----------------------------------------------------------------
{
  wipe(); heardReset();
  const ctx = await device("iphone");
  const p = await screen(ctx);
  await p.route("**/api/thoughts", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 503, json: { error: "database_unavailable" } }) : r.continue()));
  await talk(p, 2000);
  await p.click(".th-mic");
  check("server down: the text shows, waiting to save", await until(() => p.evaluate(() => document.querySelector(".th-state")?.textContent === "Waiting to save" && document.querySelector(".th-row.pending .th-text")?.textContent === "part1"), 20000));
  check("its audio is still held", (await onDevice(p)).audio >= 1);
  const asked = speech.heard.length;
  await p.unroute("**/api/thoughts");

  // This one reaches the server, and the answer is lost on the way back.
  let lost = 0;
  await p.route("**/api/thoughts", async (r) => {
    if (r.request().method() !== "POST" || lost) return r.continue();
    lost++;
    await r.fetch();
    await r.abort("connectionreset");
  });
  await p.click(".th-notice button");
  check("the save reached the server", await until(() => lost === 1 && count() === 1));
  check("no answer, so the audio stays", (await onDevice(p)).audio >= 1, JSON.stringify(await onDevice(p)));
  await p.click(".th-notice button", { timeout: 8000 }).catch(() => {});
  check("the retry clears it", await until(async () => (await onDevice(p)).sessions === 0, 20000), JSON.stringify(await onDevice(p)));
  check("and there's still one thought", count() === 1, String(count()));
  check("speech wasn't asked again", speech.heard.length === asked, `${speech.heard.length} vs ${asked}`);
  await ctx.close();
}

// ---- The app dying part way through ------------------------------------------------------------------------------------------
{
  wipe(); heardReset();
  const ctx = await device("iphone");
  const p = await screen(ctx);
  await talk(p, 11500); // past the first checkpoint
  await p.close({ runBeforeUnload: false }); // no chance to say goodbye
  const q = await screen(ctx);
  check("what reached the disk becomes a thought", await until(() => count() === 1, 20000));
  check("as far as the last checkpoint", Number(sql("select duration_ms from lumbridge.thoughts")) >= 9000, sql("select duration_ms from lumbridge.thoughts"));
  check("nothing left behind", await until(async () => (await onDevice(q)).sessions === 0));
  await ctx.close();
}

// ---- A tab still recording isn't a crash --------------------------------------------------------------------------------------
{
  wipe(); heardReset();
  const ctx = await device("desktop");
  const p = await screen(ctx);
  await talk(p, 11500);
  const other = await screen(ctx);
  await sleep(1500);
  check("another tab leaves a live recording alone", count() === 0 && (await micOn(p)), String(count()));
  await p.click(".th-mic");
  check("and it finishes as one", await until(() => count() === 1));
  await other.close();
  await ctx.close();
}

// ---- Leaving the screen ----------------------------------------------------------------------------------------------------
{
  wipe(); heardReset();
  const ctx = await device("iphone");
  const p = await screen(ctx);
  await talk(p, 2000);
  await p.evaluate(() => { location.hash = "#/tasks"; });
  check("leaving turns the mic off", await until(async () => !(await micOn(p)), 3000));
  check("and saves what the owner said", await until(() => count() === 1));
  check("no errors", p.errors.length === 0, p.errors.join("; "));
  await ctx.close();
}

// ---- A tap too short to mean anything, and a mic refused --------------------------------------------------------------------------
{
  wipe(); heardReset();
  const ctx = await device("iphone");
  const p = await screen(ctx);
  await p.click(".th-mic");
  await p.click(".th-mic");
  check("two quick taps leave nothing", await until(async () => (await onDevice(p)).sessions === 0));
  await sleep(500);
  check("not on the server either", count() === 0);
  check("the mic is off", !(await micOn(p)));
  await ctx.close();

  const c2 = await device("iphone");
  await c2.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("no", "NotAllowedError")); });
  const d = await screen(c2);
  await d.click(".th-mic");
  check("a refused mic says so", await until(async () => (await statusText(d)) === "The mic isn't allowed", 3000));
  check("and leaves nothing behind", await until(async () => (await onDevice(d)).sessions === 0));
  await d.click(".th-mic");
  check("and the button still works", await until(async () => (await statusText(d)) === "The mic isn't allowed", 3000));
  await c2.close();
}

// ---- No IndexedDB -----------------------------------------------------------------------------------------------------------
{
  wipe(); heardReset();
  speech.up = false;
  const ctx = await device("iphone", { noIdb: true });
  const p = await screen(ctx);
  await talk(p, 2000);
  await p.click(".th-mic");
  check("no IndexedDB: says it's only in memory", await until(() => p.evaluate(() => document.querySelector(".th-state")?.textContent === "Waiting to transcribe" && document.querySelector(".th-notice")?.textContent.includes("only in memory")), 20000));
  check("and doesn't claim it's kept", !(await p.textContent(".th-notice")).includes("kept on this device"));
  await shot(p, "thoughts-memory-only-phone");
  speech.up = true;
  await p.click(".th-notice button");
  check("and it still gets saved", await until(() => count() === 1));
  check("no errors", p.errors.length === 0, p.errors.join("; "));
  await ctx.close();
}

// ---- Typing, opening, editing, a note, deleting, searching ---------------------------------------------------------------------
{
  wipe(); heardReset();
  const ctx = await device("iphone");
  const p = await screen(ctx);
  await p.fill(".th-compose textarea", "fix the gate before winter");
  await p.reload();
  await p.waitForSelector(".th-mic");
  check("what's in the box survives a reload", (await p.inputValue(".th-compose textarea")) === "fix the gate before winter");
  await p.click(".th-compose button");
  check("a typed thought is saved", await until(() => count("source = 'typed'") === 1));
  check("and the box is empty", (await p.inputValue(".th-compose textarea")) === "");
  check("in the list", await until(async () => (await rowText(p)).includes("fix the gate before winter")));

  // Typed with the server down: kept, then sent.
  await p.route("**/api/thoughts", (r) => (r.request().method() === "POST" ? r.abort("connectionrefused") : r.continue()));
  await p.fill(".th-compose textarea", "typed while it's down");
  await p.click(".th-compose button");
  check("typed offline waits, on the device", await until(() => p.evaluate(() => document.querySelector(".th-state")?.textContent === "Waiting to save")));
  await p.reload();
  await p.waitForSelector(".th-mic");
  await p.unroute("**/api/thoughts");
  check("and is sent after reopening", await until(() => count("source = 'typed'") === 2, 20000));
  check("once", bodies().filter((b) => b === "typed while it's down").length === 1);

  // Search.
  await p.waitForSelector(".th-row:not(.pending)");
  await p.fill(".d-search input", "winter");
  check("search narrows the list", await until(async () => { const r = await rowText(p); return r.length === 1 && r[0].includes("winter"); }));
  await p.fill(".d-search input", "zzzz");
  check("search says when nothing matches", await until(() => p.evaluate(() => document.querySelector(".d-list .d-empty")?.textContent.includes("Nothing matches"))));
  await p.fill(".d-search input", "");
  await until(async () => (await rowText(p)).length === 2);

  // Opening one, and editing.
  await p.click('.th-row:has-text("fix the gate")');
  await p.waitForSelector(".th-sheet-text:not([disabled])");
  check("phone: no sideways scroll in the sheet", (await overflow(p)) === 0);
  await shot(p, "thoughts-sheet-phone");
  await p.fill(".th-sheet-text", "fix the gate before the first frost");
  await p.click(".d-done");
  check("an edit saves, version bumped", await until(() => sql("select body || '/' || version from lumbridge.thoughts where body like 'fix%'") === "fix the gate before the first frost/2"));
  check("and the sheet closes", await until(async () => !(await p.$(".d-scrim"))));

  // Another device changed it meanwhile.
  await p.click('.th-row:has-text("fix the gate")');
  await p.waitForSelector(".th-sheet-text:not([disabled])");
  sql("update lumbridge.thoughts set body = 'changed elsewhere', version = version + 1 where body like 'fix%'");
  await p.fill(".th-sheet-text", "my edit");
  await p.click(".d-done");
  check("a conflict overwrites nothing and shows both", await until(() => p.evaluate(() => document.querySelector(".d-conflict")?.textContent.includes("changed elsewhere"))));
  check("the other device's text is still there", count("body = 'changed elsewhere'") === 1);
  await p.click('.d-conflict button:has-text("Keep mine")');
  check("keeping mine saves it", await until(() => count("body = 'my edit'") === 1));
  await p.click(".d-done");
  await until(async () => !(await p.$(".d-scrim")));

  // Into a note.
  await p.click('.th-row:has-text("my edit")');
  await p.waitForSelector(".th-sheet-text:not([disabled])");
  await p.click(".th-to-note");
  check("makes a note with that text", await until(() => sql("select count(*) from lumbridge.notes where body = 'my edit'") === "1"));
  check("and links it", await until(() => count("note_id is not null") === 1));
  await until(async () => (await p.textContent(".th-to-note")) === "Open note");
  await p.click(".th-to-note");
  check("Open note lands in the note's editor", await until(() => p.evaluate(() => document.querySelector(".d-editor .d-body")?.value === "my edit")));
  await p.click('.d-editor [aria-label="Back to notes"]');
  check("back returns to Thoughts", await until(() => p.evaluate(() => location.hash === "#/thoughts" && !!document.querySelector(".th-mic"))));
  check("marked In Notes", await until(() => p.evaluate(() => !!document.querySelector(".th-in-notes"))));
  await p.click('.th-row:has-text("my edit")');
  await p.waitForSelector(".th-sheet-text:not([disabled])");
  check("the button still says Open note, and made no second one", (await p.textContent(".th-to-note")) === "Open note" && sql("select count(*) from lumbridge.notes") === "1");

  // Delete, undo, and restore from the list.
  await p.click('.d-bar [aria-label="Delete"]');
  check("delete is soft", await until(() => count("deleted_at is not null") === 1));
  await p.click(".d-toast button");
  check("undo brings it back", await until(() => count("deleted_at is not null") === 0));
  await until(async () => (await rowText(p)).includes("my edit"));
  await p.click('.th-row:has-text("my edit")');
  await p.waitForSelector(".th-sheet-text:not([disabled])");
  await p.click('.d-bar [aria-label="Delete"]');
  await until(() => count("deleted_at is not null") === 1);
  await p.click(".d-section summary");
  await p.waitForSelector(".d-trash button");
  await p.click(".d-trash button");
  check("restore from Recently deleted", await until(() => count("deleted_at is not null") === 0));
  check("back in the list", await until(async () => (await rowText(p)).includes("my edit")));
  check("no errors", p.errors.length === 0, p.errors.join("; "));

  // The assistant's way in, on what's there now.
  const rows = JSON.parse(cli("thoughts", "search", "edit").stdout);
  check("the CLI finds it", rows.length === 1 && rows[0].body === "my edit" && !!rows[0].note_id, JSON.stringify(rows));
  check("the CLI lists them, newest first", JSON.parse(cli("thoughts", "recent", "--limit", "1").stdout)[0].body === "typed while it's down");
  await ctx.close();
}

// ---- Grouping, and many -------------------------------------------------------------------------------------------------------
{
  wipe();
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  await api("POST", "/api/thoughts", { body: "today's", created_at: day(0) });
  await api("POST", "/api/thoughts", { body: "yesterday's", created_at: day(1) });
  await api("POST", "/api/thoughts", { body: "older", created_at: day(5) });
  const ctx = await device("desktop");
  const p = await screen(ctx);
  await p.waitForSelector(".th-row");
  const heads = await p.evaluate(() => [...document.querySelectorAll(".th-day")].map((e) => e.textContent));
  check("grouped by day, newest first", heads.length === 3 && heads[0] === "Today" && heads[1] === "Yesterday", heads.join());
  check("said-at time decides the day, not when it arrived", (await rowText(p)).join() === "today's,yesterday's,older", (await rowText(p)).join());
  await shot(p, "thoughts-list-desktop");
  await ctx.close();
}

await browser.close();
fake.close();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
