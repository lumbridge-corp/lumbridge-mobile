// The client's handling of bad moments, in real Chrome against a scratch core: node tests/client-regress.mjs <port>
// Needs web/dist and Playwright (PW_DIR, else tests/). Uses <port> and <port>+1 (tests/ports.mjs); starts scripts/dev.sh and stops it,
// pass, fail or Ctrl-C.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compress } from "../web/scripts/compress.mjs";
import { portAt, stopOnExit } from "./ports.mjs";

const port = Number(process.argv[2] ?? 18615);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(`${process.env.PW_DIR ?? path.join(repo, "tests")}/`)("playwright");
const d = `/run/user/${process.getuid()}/k${port}`;
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${ok ? "" : extra}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(100); } return false; };
const dev = (...a) => spawnSync("bash", [`${repo}/scripts/dev.sh`, String(port), ...a], { encoding: "utf8" });

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")));
Object.assign(env, { LBC_SESSION: "k", XDG_STATE_HOME: `${d}/s`, XDG_RUNTIME_DIR: d, XDG_CONFIG_HOME: `${d}/c`, XDG_DATA_HOME: `${d}/d` });
const hc = (...a) => execFileSync("lbc", a, { env, encoding: "utf8" });

// Whatever happens below, nothing this run started stays behind. Chrome is Playwright's to end.
let second = null, web = null;
const stopAll = stopOnExit(() => {
  second?.kill();
  if (web) fs.rmSync(web, { recursive: true, force: true });
  dev("stop");
});
const up = dev();
if (up.status !== 0) { console.log(up.stderr); process.exit(1); }
const token = fs.readFileSync(`${d}/token`, "utf8").trim();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ channel: "chrome" });

async function session(url = base) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await ctx.addInitScript((t) => { try { if (!localStorage.getItem("lumbridge.token")) localStorage.setItem("lumbridge.token", t); } catch {} }, token);
  const page = await ctx.newPage();
  await page.goto(`${url}/#/agents`);
  return { ctx, page };
}

// ---- pending tasks through 401, 403, 429 and 422
const pendingTasks = [["call the lawyer"], ["renew passport"], ["pay Gusto"]].map(([title], i) => ({ id: `00000000-0000-4000-8000-00000000000${i}`, title, due_on: null, sort_key: i }));
async function pendingWith(status) {
  const { ctx, page } = await session();
  await page.route("**/api/tasks", (r) => r.request().method() === "POST"
    ? r.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: "title_too_long" }) })
    : r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.waitForSelector('nav a[href="#/tasks"]');
  await page.evaluate((p) => localStorage.setItem("lumbridge.tasks.pending", JSON.stringify(p)), pendingTasks);
  await page.evaluate(() => { location.hash = "#/tasks"; });
  await sleep(1200);
  const left = await page.evaluate(() => JSON.parse(localStorage.getItem("lumbridge.tasks.pending") ?? "[]").length);
  const box = await page.locator(".d-capture input").inputValue().catch(() => "");
  await ctx.close();
  return { left, box };
}
for (const status of [403, 429, 503]) {
  const r = await pendingWith(status);
  check(`${status}: all three captured tasks are kept`, r.left === 3 && r.box === "", JSON.stringify(r));
}
const refused = await pendingWith(422);
check("422: the server really won't take them, and the first goes back to the box", refused.left === 0 && refused.box === "call the lawyer", JSON.stringify(refused));

// ---- a refused token: pairing, and no more requests
{
  const { ctx, page } = await session();
  let calls = 0;
  await page.route("**/api/**", (r) => { calls++; return r.fulfill({ status: 401, contentType: "application/json", body: "{}" }); });
  await page.waitForSelector('nav a[href="#/tasks"]');
  await page.evaluate((p) => localStorage.setItem("lumbridge.tasks.pending", JSON.stringify(p)), pendingTasks);
  await page.evaluate(() => { location.hash = "#/tasks"; });
  check("a 401 shows the pairing form", await until(() => page.locator("form.pair").count().then((n) => n === 1)));
  const left = await page.evaluate(() => JSON.parse(localStorage.getItem("lumbridge.tasks.pending") ?? "[]").length);
  check("and keeps what the owner captured", left === 3, String(left));
  const seen = calls;
  await sleep(1500);
  check("and stops asking", calls === seen, `${seen} then ${calls}`);
  await ctx.close();
}

// ---- a task change that lost a race
{
  const row = { id: "00000000-0000-4000-8000-0000000000aa", title: "buy milk", notes: "", due_on: null, done_at: null, pinned: false, sort_key: 1, created_at: "2026-11-03T00:00:00Z", updated_at: "2026-11-03T00:00:00Z", deleted_at: null, version: 1 };
  const { ctx, page } = await session();
  const patches = [];
  await page.route("**/api/tasks", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([row]) }));
  await page.route(`**/api/tasks/${row.id}`, (r) => {
    const body = JSON.parse(r.request().postData());
    patches.push(body);
    const current = { ...row, pinned: true, version: 2 };
    if (patches.length === 1) return r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify(current) });
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...current, due_on: body.due_on, version: 3 }) });
  });
  await page.waitForSelector('nav a[href="#/tasks"]');
  await page.evaluate(() => { location.hash = "#/tasks"; });
  await page.locator(".d-task-main").first().click();
  await page.getByRole("button", { name: "Tomorrow" }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await until(() => patches.length >= 2, 3000);
  check("the owner's due date survives the other device's pin", patches[1]?.version === 2 && !!patches[1]?.due_on && !("pinned" in patches[1]) && !("title" in patches[1]), JSON.stringify(patches));
  check("and the first try sent only what the owner changed", Object.keys(patches[0] ?? {}).sort().join() === "due_on,version", JSON.stringify(patches[0]));
  await ctx.close();
}

// ---- core down, and a rate limit: quiet retries, never the pairing form, and nothing started
{
  const { ctx, page } = await session();
  await page.waitForSelector('nav a[href="#/tasks"]');
  await sleep(500);
  hc("server", "stop");
  await sleep(4000);
  const coreSocket = `${d}/lumbridge-core/k.sock`;
  const answers = () => { try { execFileSync("python3", ["-I", "-c", `import socket;s=socket.socket(socket.AF_UNIX);s.connect(${JSON.stringify(coreSocket)})`], { stdio: "ignore" }); return true; } catch { return false; } };
  check("with core stopped and a client retrying, core stays stopped", !answers());
  check("and the client isn't sent to pair", (await page.locator("form.pair").count()) === 0);
  hc("run", "--bg", "--name", "back", "bash");
  check("when core returns the client is back by itself", await until(() => page.evaluate(() => [...document.querySelectorAll(".row")].some((r) => r.textContent.includes("back"))), 20000));
  await ctx.close();

  const rl = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await rl.addInitScript((t) => localStorage.setItem("lumbridge.token", t), token);
  let tries = 0;
  await rl.routeWebSocket(/\/ws$/, (ws) => { tries++; ws.onMessage(() => { ws.send('{"error":"rate_limited"}'); ws.close(); }); });
  const p = await rl.newPage();
  await p.goto(`${base}/#/agents`);
  await sleep(2500);
  check("rate_limited isn't read as unpaired: no pairing form, and it retries", (await p.locator("form.pair").count()) === 0 && tries >= 2, String(tries));
  await rl.close();
}

// ---- a new build reaches an installed client, with no cache clearing
{
  web = fs.mkdtempSync(path.join(os.tmpdir(), "kos-web-"));
  fs.cpSync(`${repo}/web/dist`, web, { recursive: true });
  const stampOf = (f) => /lumbridge-shell-([0-9a-f]+)/.exec(fs.readFileSync(f, "utf8"))[1];
  const stampA = stampOf(`${web}/sw.js`);
  const assets = fs.readdirSync(`${web}/assets`).filter((f) => /^index-.*\.js$/.test(f));
  const oldJs = assets[0];
  const a = { html: fs.readFileSync(`${web}/index.html`, "utf8"), sw: fs.readFileSync(`${web}/sw.js`, "utf8"), js: fs.readFileSync(`${web}/assets/${oldJs}`, "utf8") };
  // The other chunks import the entry by its name and the entry names them, so a real build B renames them too (their hashes
  // change with it). Build A's as they are; another build's under new names, pointing at its own entry.
  const chunksA = Object.fromEntries(fs.readdirSync(`${web}/assets`).filter((f) => /\.js$/.test(f) && f !== oldJs).map((f) => [f, fs.readFileSync(`${web}/assets/${f}`, "utf8")]));
  let written = [];
  const write = (name, stamp, html, sw, js, drop) => {
    if (drop) fs.rmSync(`${web}/assets/${drop}`, { force: true }); // as rsync --delete does
    for (const f of written) fs.rmSync(`${web}/assets/${f}`, { force: true });
    const renamed = Object.keys(chunksA).map((f) => [f, name === oldJs ? f : f.replace(/\.js$/, `-${stamp.slice(0, 6)}.js`)]);
    const rename = (text) => renamed.reduce((t, [f, f2]) => t.replaceAll(f, f2), text.replaceAll(oldJs, name));
    written = renamed.map(([f, f2]) => { fs.writeFileSync(`${web}/assets/${f2}`, rename(chunksA[f])); return f2; });
    fs.writeFileSync(`${web}/assets/${name}`, `window.__build=${JSON.stringify(stamp)};\n${rename(js)}`);
    fs.writeFileSync(`${web}/index.html`, rename(html));
    fs.writeFileSync(`${web}/sw.js`, rename(sw).replaceAll(stampA, stamp));
    compress(web); // as npm run build does: the gateway prefers the .br, so it must be this build's
  };
  write(oldJs, stampA, a.html, a.sw, a.js);
  const secondPort = portAt(port, "second");
  const g = second = spawn(`${repo}/gateway/target/debug/lumbridge-mobile-server`, [], { env: { ...env, LUMBRIDGE_LOGIN: "dev@example.com", LUMBRIDGE_ORIGINS: `http://127.0.0.1:${secondPort}`, LUMBRIDGE_BIND: `127.0.0.1:${secondPort}`, LUMBRIDGE_WEB: web, LUMBRIDGE_STATE_DIR: `${d}/state` }, stdio: "ignore" });
  await sleep(800);
  const url = `http://127.0.0.1:${secondPort}`;
  const { ctx, page } = await session(url);
  await page.waitForSelector('nav a[href="#/tasks"]');
  const swActive = () => page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!r.active && !!navigator.serviceWorker.controller; });
  check("the worker installs and controls the page", await until(swActive));
  const cacheNames = (p) => p.evaluate(() => caches.keys());
  check("its cache is this build's", (await cacheNames(page)).join() === `lumbridge-shell-${stampA}`);
  check("and holds the shell before any reload", await page.evaluate(async (js) => !!(await caches.match(`/assets/${js}`)) && !!(await caches.match("/")), oldJs), oldJs);

  // Deploy build B over it. Old chunks gone.
  write("index-BUILDB.js", "bbbbbbbbbbbb", a.html, a.sw, a.js, oldJs);
  const reopened = await ctx.newPage();
  await reopened.goto(`${url}/#/agents`);
  await reopened.waitForSelector('nav a[href="#/tasks"]');
  check("reopening runs the new build at once", (await reopened.evaluate(() => window.__build)) === "bbbbbbbbbbbb");
  check("the new worker replaces the old cache", await until(async () => (await cacheNames(reopened)).join() === "lumbridge-shell-bbbbbbbbbbbb"), (await cacheNames(reopened)).join());
  // The tab left open since before the deploy: it moves over when the owner comes back to it, not in the middle of something.
  const hide = (p, hidden) => p.evaluate((h) => { Object.defineProperty(document, "hidden", { configurable: true, get: () => h }); document.dispatchEvent(new Event("visibilitychange")); }, hidden);
  check("the old tab keeps running while the owner is in it", (await page.evaluate(() => window.__build)) === stampA);
  await hide(page, true);
  const reloaded = page.waitForEvent("load", { timeout: 8000 }).then(() => true, () => false);
  await hide(page, false);
  check("and picks up the new build when the owner returns", (await reloaded) && (await page.evaluate(() => window.__build)) === "bbbbbbbbbbbb");

  // Roll back: the older files are older by date, which a date-based cache check would call unchanged.
  write(oldJs, stampA, a.html, a.sw, a.js, "index-BUILDB.js");
  for (const f of [`${web}/index.html`, `${web}/sw.js`]) fs.utimesSync(f, new Date(0), new Date(1000 * 86400 * 365 * 20));
  const back = await ctx.newPage();
  await back.goto(`${url}/#/agents`);
  await back.waitForSelector('nav a[href="#/tasks"]');
  check("a rollback reaches it the same way", (await back.evaluate(() => window.__build)) === stampA);
  await ctx.close();
  g.kill();
  fs.rmSync(web, { recursive: true, force: true });
}

await browser.close();
stopAll();
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
