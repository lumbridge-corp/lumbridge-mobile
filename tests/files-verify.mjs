// Files in Chrome, against a scratch gateway with a database of its own on the throwaway Postgres and a files folder of its own. Starts and
// stops everything itself:
//   scripts/dev-db.sh && node tests/files-verify.mjs <port> [shots dir]
// LUMBRIDGE_PG_PORT picks the throwaway Postgres (default 5498), as scripts/ci-db.sh and scripts/dev-db.sh do.
// Needs web/dist and psql. The filer (a separate tool on the server) is stood in for by `lumbridge-mobile-server files update`, the way it really writes. A real
// phone's camera isn't something this can tell you about: the camera input is fed files the same way the library is. Never `playwright install`.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PG_PORT, stopOnExit } from "./ports.mjs";
import { chromium, PROFILES } from "./ui-lib.mjs";

const [port, shots] = process.argv.slice(2);
if (!port) { console.error("usage: files-verify.mjs <port> [shots dir]"); process.exit(2); }
if (shots) mkdirSync(shots, { recursive: true });
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0, passed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  [${extra}]`}`); if (ok) passed++; else failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(100); } return false; };
const shot = async (p, name) => { if (shots) { await sleep(200); await p.screenshot({ path: `${shots}/${name}.png` }); } };

// ---- A database and a folder of its own ---------------------------------------------------------------------------------

const psqlBin = [process.env.LUMBRIDGE_PG_BIN && `${process.env.LUMBRIDGE_PG_BIN}/psql`].find((p) => p && existsSync(p)) ?? "psql";
const SERVER = `postgres://postgres:lumbridge-throwaway@127.0.0.1:${PG_PORT}`;
const DB = `lumbridge_files_${process.pid}`;
const sql = (q, db = DB) => execFileSync(psqlBin, [`${SERVER}/${db}`, "-v", "ON_ERROR_STOP=1", "-Atqc", q], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
sql(`create database ${DB}`, "postgres");
spawnSync(psqlBin, [`${SERVER}/${DB}`, "-qc", "create role lumbridge_app login noinherit password 'dev'; alter role lumbridge_app set search_path = lumbridge"], { stdio: "ignore" });
sql("create schema lumbridge authorization lumbridge_app; revoke all on schema lumbridge from public");
const URL_ = `postgres://lumbridge_app:dev@127.0.0.1:${PG_PORT}/${DB}`;
const count = (where = "true") => Number(sql(`select count(*) from lumbridge.files where ${where}`));
const wipe = () => sql("delete from lumbridge.files");
const DIR = mkdtempSync(path.join(os.tmpdir(), "lumbridge-files-"));
const onDisk = () => {
  const out = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else out.push(p); } };
  walk(DIR);
  return out.filter((p) => !p.includes("/.incoming/"));
};

const dev = (...a) => spawnSync("bash", [`${repo}/scripts/dev.sh`, port, ...a], {
  env: { ...process.env, LUMBRIDGE_DATABASE_URL: URL_, LUMBRIDGE_FILES_DIR: DIR }, encoding: "utf8",
});
let cleaned = false;
const cleanUp = () => {
  if (cleaned) return;
  cleaned = true;
  dev("stop");
  try { sql(`drop database ${DB} with (force)`, "postgres"); } catch { /* it's a throwaway server */ }
  rmSync(DIR, { recursive: true, force: true });
};
// On Ctrl-C and SIGTERM too, not only a normal exit.
stopOnExit(cleanUp);
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
const up = dev();
if (up.status !== 0) { console.error(up.stdout, up.stderr); process.exit(1); }
const bin = `${repo}/gateway/target/debug/lumbridge-mobile-server`;
const cli = (args, input) => spawnSync(bin, args, { env: { LUMBRIDGE_DATABASE_URL: URL_ }, encoding: "utf8", input });
const migrated = cli(["migrate"]);
if (migrated.status !== 0) { console.error(migrated.stderr); process.exit(1); }
const tok = readFileSync(`/run/user/${process.getuid()}/k${port}/token`, "utf8").trim();
const BASE = `http://127.0.0.1:${port}/`;

// ---- Things to add ------------------------------------------------------------------------------------------------------

const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDDoor0OtsxzH6ny+7e9+ttreT7nNh8P7a+trHnlFeh0V5v+sP/AE7/AB/4B0fUP734f8E88or0OuF1H/kJXX/XZ/5mvQy/M/rknHltbzv+iMK+G9kk73K1FFFeqcoV6HXnld19vsv+fy3/AO/i/wCNfOZ/CUvZ8qvv+h6GBaXNfy/Us0VW+32X/P5b/wDfxf8AGj7fZf8AP5b/APfxf8a+d9jU/lf3Hoc8e5ZrhdR/5CV1/wBdn/ma7H7fZf8AP5b/APfxf8a42/ZXv7llIZTKxBByCMmveyGnKNSfMraHDjpJxVmV6KKK+nPNCiiigAooooAKKKKACiiigD//2Q==", "base64");
let n = 0;
/** A different photo each time: a JPEG decoder ignores whatever follows its end marker, and the hash doesn't. */
const photo = (name = `photo-${++n}.jpg`) => ({ name, mimeType: "image/jpeg", buffer: Buffer.concat([JPEG, Buffer.from(`#${n}-${Math.random()}`)]) });
const pdf = { name: "lease.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n") };
const SCRIPTY = `<img src=x onerror="window.__pwned=1">.jpg`;

const browser = await chromium.launch({ channel: "chrome" });
const noise = /Failed to load resource|ERR_|503/;

async function device(profile = "iphone") {
  const ctx = await browser.newContext({ ...PROFILES[profile], colorScheme: "dark" });
  await ctx.addInitScript((tok) => { try { localStorage.setItem("lumbridge.token", tok); } catch {} }, tok);
  return ctx;
}
async function open(ctx, hash = "#/files") {
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(`pageerror: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !noise.test(m.text())) p.errors.push(`console: ${m.text()}`); });
  await p.goto(BASE + hash);
  return p;
}
const screen = async (ctx) => { const p = await open(ctx); await p.waitForSelector(".fi-hero"); return p; };
const inputs = (p) => p.$$(".fi-view input[type=file]"); // camera, library, any file
const captions = (p) => p.evaluate(() => [...document.querySelectorAll(".fi-grid:not(.fi-waiting) .fi-cap")].map((e) => e.textContent));
const waitingBadges = (p) => p.evaluate(() => [...document.querySelectorAll(".fi-waiting .fi-badge")].map((e) => e.textContent));
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const onDevice = (p) => p.evaluate(async () => {
  if (!(await indexedDB.databases()).some((d) => d.name === "lumbridge-files")) return { items: 0, blobs: 0 };
  const db = await new Promise((ok, no) => { const r = indexedDB.open("lumbridge-files"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const all = (s) => new Promise((ok) => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => ok(r.result); });
  const [items, blobs] = [await all("items"), await all("blobs")];
  db.close();
  return { items: items.length, blobs: blobs.length };
});
const rowId = (where) => sql(`select id from lumbridge.files where ${where} limit 1`);
const file = (where = "true") => JSON.parse(cli(["files", "read", rowId(where)]).stdout);

// ---- The screen, and adding several at once ------------------------------------------------------------------------------
{
  const ctx = await device("iphone");
  const p = await open(ctx, "#/agents");
  await p.waitForSelector(".tab-apps");
  await p.click(".tab-apps");
  await p.waitForSelector('.drawer a[href="#/files"]');
  await p.click('.drawer a[href="#/files"]');
  await p.waitForSelector(".fi-hero");
  check("it's in the Apps sheet, and opens", true);
  const labels = await p.evaluate(() => [...document.querySelectorAll(".fi-big")].map((b) => b.textContent));
  check("two big buttons: take photos, add from library", labels.slice(0, 2).join() === "Take photos,Add from library", labels.join());
  const [cam, lib, any] = await inputs(p);
  check("the camera opens the back camera; the library takes several", (await cam.getAttribute("capture")) === "environment" && (await lib.evaluate((i) => i.multiple && i.accept === "image/*")) && (await any.evaluate((i) => !i.accept)));
  await p.waitForSelector(".d-empty-title");
  await shot(p, "files-empty-iphone");

  await lib.setInputFiles([photo("one.jpg"), photo("two.jpg"), photo("three.jpg"), photo("four.jpg")]);
  check("several at once all arrive", await until(() => count() === 4), String(count()));
  check("each on disk, beside its row", await until(() => onDisk().length === 4), onDisk().join());
  check("and gone from the device once the server has them", await until(async () => (await onDevice(p)).items === 0));
  check("shown in the grid", await until(async () => (await captions(p)).length === 4), (await captions(p)).join());
  check("nothing is filed yet, and it says so", await until(() => p.evaluate(() => [...document.querySelectorAll(".fi-badge")].filter((b) => b.textContent === "Filing").length === 4)));
  check("their originals are private on disk", onDisk().every((f) => (statSync(f).mode & 0o077) === 0), onDisk().map((f) => (statSync(f).mode & 0o777).toString(8)).join());
  check("no sideways scroll", (await overflow(p)) <= 0);
  await shot(p, "files-filing-iphone");
  check("no errors", p.errors.length === 0, p.errors.join("; "));
  await ctx.close();
}

// ---- The camera, shot after shot ------------------------------------------------------------------------------------
{
  wipe();
  const ctx = await device("iphone");
  const p = await screen(ctx);
  const [cam] = await inputs(p);
  await cam.setInputFiles([photo("image.jpg")]);
  await p.waitForSelector(".fi-shooting:not([hidden])");
  check("after a shot, the next is one tap away", (await p.textContent(".fi-shot-count")) === "1 photo taken" && (await p.isVisible(".fi-again")) && (await p.isVisible(".fi-done")));
  await cam.setInputFiles([photo("image.jpg")]);
  check("and it counts them", await until(async () => (await p.textContent(".fi-shot-count")) === "2 photos taken"));
  await shot(p, "files-shooting-iphone");
  await p.click(".fi-done");
  check("Done goes back to the two buttons", (await p.isHidden(".fi-shooting")) && (await p.isVisible(".fi-hero")));
  check("both arrive, named by when they were taken", await until(() => count() === 2) && sql("select string_agg(name, ',' order by name) from lumbridge.files").split(",").every((x) => /^Photo \d{4}-\d\d-\d\d \d\d\.\d\d/.test(x)), sql("select string_agg(name, ',') from lumbridge.files"));
  await ctx.close();
}

// ---- Offline, then back: kept on the device, sent once ------------------------------------------------------------------------
{
  wipe();
  const ctx = await device("iphone");
  const p = await screen(ctx);
  await p.route("**/api/files?id=*", (r) => r.abort("connectionrefused"));
  const [, lib] = await inputs(p);
  await lib.setInputFiles([photo("offline-a.jpg"), photo("offline-b.jpg")]);
  check("offline, they wait on the device", await until(async () => (await waitingBadges(p)).filter((b) => b === "Waiting to upload").length === 2), (await waitingBadges(p)).join());
  check("both kept in IndexedDB, bytes and all", (await onDevice(p)).items === 2 && (await onDevice(p)).blobs === 2);
  check("the notice says so", await until(async () => /waiting to upload, kept on this device/.test((await p.textContent(".fi-notice")) ?? "")));
  await shot(p, "files-offline-iphone");
  check("nothing reached the server", count() === 0);

  // Closed and opened again, still offline: still there. Offline from before the page loads: the Files view kicks its queue
  // the moment it opens, so a block added after `open` let one upload through and left one badge, not two (runs 12742, 12951).
  await p.close();
  await ctx.route("**/api/files?id=*", (r) => r.abort("connectionrefused"));
  const q = await open(ctx);
  await q.waitForSelector(".fi-hero");
  check("still waiting after reopening", await until(async () => (await waitingBadges(q)).length === 2), (await waitingBadges(q)).join());

  // The network comes back.
  await ctx.unroute("**/api/files?id=*");
  await q.click(".fi-notice button");
  check("back online, both go", await until(() => count() === 2), String(count()));
  check("and leave the device", await until(async () => (await onDevice(q)).items === 0));
  check("and show in the grid", await until(async () => (await captions(q)).length === 2));
  await ctx.close();
}

// ---- A lost answer: the server has it, the device doesn't know ------------------------------------------------------------
{
  wipe();
  const ctx = await device("iphone");
  const p = await screen(ctx);
  let lost = 0;
  await p.route("**/api/files?id=*", async (r) => {
    if (lost < 2) { lost++; await r.fetch(); return r.abort("connectionreset"); }
    return r.continue();
  });
  const [, lib] = await inputs(p);
  await lib.setInputFiles([photo("lost.jpg")]);
  check("its upload reached the server", await until(() => count() === 1));
  await until(() => lost >= 2, 30000);
  await p.click(".fi-notice button").catch(() => {});
  check("a retry after a lost answer makes no second file", await until(async () => (await onDevice(p)).items === 0, 30000) && count() === 1, `${count()} rows, lost ${lost}`);
  await p.unroute("**/api/files?id=*");

  // The same photo again under a new id is the same file.
  const again = photo("same.jpg");
  const [, lib2] = await inputs(p);
  await lib2.setInputFiles([again]);
  await until(() => count() === 2);
  await lib2.setInputFiles([{ ...again, name: "same-again.jpg" }]);
  await until(async () => (await onDevice(p)).items === 0);
  await sleep(500);
  check("the same bytes added twice are one file", count() === 2, String(count()));
  check("no errors", p.errors.length === 0, p.errors.join("; "));
  await ctx.close();
}

// ---- Not an image, and a name that looks like code ------------------------------------------------------------------------
{
  wipe();
  const ctx = await device("desktop");
  const p = await screen(ctx);
  const [, lib, any] = await inputs(p);
  await any.setInputFiles([pdf]);
  await lib.setInputFiles([photo(SCRIPTY)]);
  check("a PDF and a photo both arrive", await until(() => count() === 2));
  const kinds = sql("select string_agg(mime, ',' order by mime) from lumbridge.files");
  check("their type comes from their bytes", kinds === "application/pdf,image/jpeg", kinds);
  check("the name is shown as text, exactly", await until(async () => (await captions(p)).includes(SCRIPTY)), (await captions(p)).join());
  check("and never runs", await p.evaluate(() => !window.__pwned && !document.querySelector('.fi-cap img, .fi-view img[src="x"]')));
  check("a PDF tile says PDF", await p.evaluate(() => [...document.querySelectorAll(".fi-glyph")].some((g) => g.textContent === "PDF")));
  const id = rowId("mime = 'application/pdf'");
  const r = await fetch(`${BASE}api/files/${id}/content`, { headers: { Authorization: `Bearer ${tok}` } });
  check("a PDF is served as a download, never inline", r.status === 200 && /^attachment/.test(r.headers.get("content-disposition") ?? "") && r.headers.get("x-content-type-options") === "nosniff" && /sandbox/.test(r.headers.get("content-security-policy") ?? ""), [...r.headers].join(" | "));
  const svg = await fetch(`${BASE}api/files?id=${crypto.randomUUID()}&name=x.svg`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "image/svg+xml" }, body: "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>" });
  const row = await svg.json();
  const back = await fetch(`${BASE}api/files/${row.id}/content`, { headers: { Authorization: `Bearer ${tok}` } });
  check("an SVG is kept as plain bytes, not an image", row.mime === "application/octet-stream" && back.headers.get("content-type") === "application/octet-stream" && /^attachment/.test(back.headers.get("content-disposition") ?? ""), `${row.mime} ${back.headers.get("content-type")}`);
  const range = await fetch(`${BASE}api/files/${rowId("mime = 'image/jpeg'")}/content?size=original`, { headers: { Authorization: `Bearer ${tok}`, Range: "bytes=0-1" } });
  check("ranges work", range.status === 206 && (await range.arrayBuffer()).byteLength === 2);
  const anon = await fetch(`${BASE}api/files/${id}/content`);
  check("no token, no bytes", anon.status === 401);
  check("no errors", p.errors.length === 0, p.errors.join("; "));
  await ctx.close();
}

// ---- Files with no preview ask for none (L-05) -----------------------------------------------------------------------------
{
  wipe();
  const ctx = await device("desktop");
  const p = await screen(ctx);
  const [, lib, any] = await inputs(p);
  await any.setInputFiles([{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("milk, eggs\n") }, pdf]);
  await lib.setInputFiles([photo("cat.jpg")]);
  check("a text file, a PDF and a photo arrive", await until(() => count() === 3), String(count()));
  await until(async () => (await onDevice(p)).items === 0);
  await p.close();
  // A fresh load, watched from the start: every request and every console error, the usual noise included.
  const q = await ctx.newPage();
  const bad = [], consoleErrors = [];
  q.on("response", (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
  q.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  await q.goto(BASE + "#/files");
  await q.waitForSelector(".fi-hero");
  check("all three show", await until(async () => (await captions(q)).length === 3), (await captions(q)).join());
  check("the photo's thumbnail loads", await until(() => q.evaluate(() => [...document.querySelectorAll(".fi-grid:not(.fi-waiting) .fi-thumb img")].some((i) => !i.hidden && i.complete && i.naturalWidth > 0))));
  await sleep(1500);
  check("loading Files makes no 4xx request", bad.length === 0, bad.join(" | "));
  check("and logs no console error", consoleErrors.length === 0, consoleErrors.join(" | "));
  const marks = await q.evaluate(() => [...document.querySelectorAll(".fi-grid:not(.fi-waiting) .fi-tile")].map((t) => ({ cap: t.querySelector(".fi-cap")?.textContent, ext: t.querySelector(".fi-ext")?.textContent, shown: getComputedStyle(t.querySelector(".fi-glyph")).display !== "none" })));
  const txt = marks.find((m) => m.cap === "notes.txt");
  check("the .txt tile shows its extension", txt?.ext === "TXT" && txt.shown, JSON.stringify(marks));
  await shot(q, "files-no-preview-desktop");
  await ctx.close();
}

// ---- Filed by the filer, then found, opened, changed, deleted and restored --------------------------------------------------
{
  wipe();
  const ctx = await device("iphone");
  const p = await screen(ctx);
  const [, lib] = await inputs(p);
  await lib.setInputFiles([photo("door-jamb.jpg"), photo("card.jpg"), photo("receipt.jpg")]);
  await until(() => count() === 3);
  const vin = "1M8GDM9AXKP042788";
  const filed = (name, body) => cli(["files", "update", rowId(`name = '${name}'`)], JSON.stringify(body));
  const a = filed("door-jamb.jpg", { status: "filed", category: "vehicle", description: "The VIN label on a white SUV door jamb.", ocr_text: `VIN ${vin}\nMFD BY EXAMPLE MOTORS`, identifiers: [{ kind: "vin", value: vin, verified: true, label: "Car A (white SUV)" }], taken_at: "2026-11-04T18:00:00Z", gps: { lat: 45.0, lon: 7.0 } });
  check("the filer's update is taken", a.status === 0, a.stderr);
  filed("card.jpg", { status: "filed", category: "document", description: "A driver's licence.", ocr_text: "DL 123456", identifiers: [{ kind: "account", value: "123456" }], sensitive: true });
  filed("receipt.jpg", { status: "failed", error: "the filer didn't answer" });
  check("the filer can't delete", cli(["files", "update", rowId("true")], JSON.stringify({ deleted_at: new Date().toISOString() })).status !== 0);
  await p.evaluate(() => window.dispatchEvent(new Event("online")));
  check("a filed one reads as what it is", await until(async () => (await captions(p)).includes("The VIN label on a white SUV door jamb.")), (await captions(p)).join());
  check("a private one shows only its category", (await captions(p)).includes("Private document") && !(await captions(p)).some((c) => /licence/.test(c)));
  await shot(p, "files-filed-iphone");

  // Search, by the VIN's start and by meaning's words.
  await p.fill(".d-search input", "1M8GDM9");
  check("search finds it by the VIN", await until(async () => { const c = await captions(p); return c.length === 1 && /VIN label/.test(c[0]); }), (await captions(p)).join());
  await p.fill(".d-search input", "suv jamb");
  check("and by its description", await until(async () => (await captions(p)).length === 1));
  await p.fill(".d-search input", "");
  await p.click('.fi-chip:has-text("Vehicles")');
  check("a category shows only its own", await until(async () => (await captions(p)).length === 1));
  await p.click('.fi-chip:has-text("All")');
  await until(async () => (await captions(p)).length === 3);

  // Open it.
  await p.click('.fi-tile:has-text("VIN label")');
  await p.waitForSelector(".fi-sheet .fi-value");
  check("opened, the VIN is there to copy", (await p.textContent(".fi-sheet .fi-value")) === vin && (await p.isVisible(".fi-sheet .fi-copy")));
  check("with which car it is, and that its check digit passed", /Car A/.test((await p.textContent(".fi-sheet .fi-line .fi-label")) ?? "") && (await p.isVisible(".fi-sure")));
  check("the text read from it is shown as text", await p.evaluate(() => document.querySelector(".fi-text pre")?.textContent?.includes("MFD BY EXAMPLE MOTORS")));
  check("the picture loads", await until(() => p.evaluate(() => { const i = document.querySelector(".fi-large img"); return !!i && i.naturalWidth > 0; })));
  await shot(p, "files-sheet-iphone");
  await p.selectOption(".fi-select", "home");
  check("Edit category saves", await until(() => sql(`select category from lumbridge.files where name = 'door-jamb.jpg'`) === "home"));
  await p.click('.fi-actions button:has-text("Rename")');
  await p.fill(".fi-rename", "Car A VIN");
  await p.press(".fi-rename", "Enter");
  check("Rename saves", await until(() => count("name = 'Car A VIN'") === 1));
  await p.click('.fi-sheet [aria-label="Delete"]');
  check("Delete is soft: the row stays, and so do its bytes", await until(() => count("deleted_at is not null") === 1) && existsSync(path.join(DIR, sql("select path from lumbridge.files where deleted_at is not null"))));
  check("and offers undo", await until(() => p.isVisible('.d-toast button:has-text("Undo")')));
  await p.click('.d-toast button:has-text("Undo")');
  check("Undo restores it", await until(() => count("deleted_at is null") === 3));
  await p.click('.fi-tile:has-text("VIN label")');
  await p.waitForSelector(".fi-sheet");
  await p.click('.fi-sheet [aria-label="Delete"]');
  await until(() => count("deleted_at is not null") === 1);
  await p.click(".d-section summary");
  await p.waitForSelector('.d-trash button:has-text("Restore")');
  await p.click('.d-trash button:has-text("Restore")');
  check("Recently deleted restores it too", await until(() => count("deleted_at is null") === 3));

  // A private one opens without its picture until the owner asks.
  await until(async () => (await captions(p)).length === 3);
  await p.click('.fi-tile:has-text("Private document")');
  await p.waitForSelector(".fi-reveal");
  check("a private one hides its picture until asked", await p.evaluate(() => !document.querySelector(".fi-large img")?.getAttribute("src")));
  await p.click(".fi-sheet .d-done");

  // The one that couldn't be filed can be tried again.
  await p.click('.fi-tile:has-text("receipt.jpg")');
  await p.waitForSelector('.fi-state.bad button');
  await p.click('.fi-state.bad button');
  check("a failed one goes back to the filer", await until(() => sql(`select status from lumbridge.files where name = 'receipt.jpg'`) === "new"));
  await p.click(".fi-sheet .d-done");

  // The assistant's way in.
  const found = JSON.parse(cli(["files", "search", "suv", "vin"]).stdout);
  check("the CLI finds it", found.length === 1 && found[0].identifiers[0].value === vin, JSON.stringify(found).slice(0, 200));
  check("the CLI lists what the filer still has to do", JSON.parse(cli(["files", "pending"]).stdout).map((f) => f.name).join() === "receipt.jpg");
  check("no errors", p.errors.length === 0, p.errors.join("; "));
  await ctx.close();
}

// ---- On a computer ------------------------------------------------------------------------------------------------------
{
  const ctx = await device("desktop");
  const p = await screen(ctx);
  await until(async () => (await captions(p)).length === 3);
  check("on a computer, no sideways scroll", (await overflow(p)) <= 0);
  await shot(p, "files-desktop");
  await ctx.close();
}

await browser.close();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
