// Today, the first screen, in Chrome on an iPhone and a 1440x900 desktop: what needs the owner in one list, each part gone when it's empty,
// the one sentence when nothing does, and the capture box saving a thought, a task and a note. Against a scratch gateway with the
// fixture's agents (four of them blocked), a database of its own on the throwaway Postgres, a fake Prometheus with one critical alert
// (only where the instance's own screens are), and an ask from the assistant made with the gateway's own CLI. A second scratch core with no
// agents on it shows the all-clear. Starts and stops everything itself:
//   scripts/dev-db.sh && node tests/today-verify.mjs <port> [shots dir]
// LUMBRIDGE_PG_PORT picks the throwaway Postgres (default 5498). Needs web/dist and psql. Never `playwright install`.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PG_PORT, portAt, stopOnExit } from "./ports.mjs";
import { ASSISTANT, chromium, EXT, PROFILES, target } from "./ui-lib.mjs";

const [port, shots] = process.argv.slice(2);
if (!port) { console.error("usage: today-verify.mjs <port> [shots dir]"); process.exit(2); }
if (shots) mkdirSync(shots, { recursive: true });
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0, passed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  [${extra}]`}`); if (ok) passed++; else failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(100); } return false; };
const shot = async (p, name) => { if (shots) { await sleep(300); await p.screenshot({ path: `${shots}/${name}.png` }); } };

// ---- A database of its own ----

const psqlBin = [process.env.LUMBRIDGE_PG_BIN && `${process.env.LUMBRIDGE_PG_BIN}/psql`].find((p) => p && existsSync(p)) ?? "psql";
const SERVER = `postgres://postgres:lumbridge-throwaway@127.0.0.1:${PG_PORT}`;
const DB = `lumbridge_today_${process.pid}`;
const sql = (q, db = DB) => execFileSync(psqlBin, [`${SERVER}/${db}`, "-v", "ON_ERROR_STOP=1", "-Atqc", q], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
sql(`create database ${DB}`, "postgres");
spawnSync(psqlBin, [`${SERVER}/${DB}`, "-qc", "create role lumbridge_app login noinherit password 'dev'; alter role lumbridge_app set search_path = lumbridge"], { stdio: "ignore" });
sql("create schema lumbridge authorization lumbridge_app; revoke all on schema lumbridge from public");
const DB_URL = `postgres://lumbridge_app:dev@127.0.0.1:${PG_PORT}/${DB}`;

// ---- Prometheus, as far as the gateway can tell. `world` turns it quiet. ----

const world = { alert: true };
const now = () => Math.floor(Date.now() / 1000);
const BOXES = ["desk", "build-box", "rig", "gpu-box"];
const fake = createServer((req, res) => {
  const url = new URL(req.url, "http://fake");
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/api/v1/alerts") {
    const alerts = world.alert ? [{ labels: { alertname: "NodeDown", severity: "critical", box: "gpu-box", instance: "gpu-box" }, annotations: { summary: "Node gpu-box is DOWN" }, state: "firing", activeAt: new Date(Date.now() - 3600e3).toISOString(), value: "1" }] : [];
    return send(200, { status: "success", data: { alerts } });
  }
  if (url.pathname === "/api/v1/query_range") return send(200, { status: "success", data: { resultType: "matrix", result: [] } });
  if (url.pathname === "/api/v1/query") {
    const q = url.searchParams.get("query") ?? "";
    const result = q.startsWith('up{job=~".+-node"}') ? BOXES.map((instance, i) => ({ metric: { instance }, value: [now(), i === 3 && world.alert ? "0" : "1"] })) : [];
    return send(200, { status: "success", data: { resultType: "vector", result } });
  }
  send(404, {});
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;
const scratch = mkdtempSync(path.join(tmpdir(), "lumbridge-today-"));

// ---- Two gateways: the fixture's agents on `port`, nobody on the bare one ----

const bare = portAt(port, "bare");
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE") && !k.startsWith("LBC_"))),
  LUMBRIDGE_DATABASE_URL: DB_URL, LUMBRIDGE_PROMETHEUS_URL: FAKE, LUMBRIDGE_ALERTMANAGER_URL: "",
};
const sh = (script, p, ...a) => spawnSync("bash", [`${repo}/scripts/${script}`, String(p), ...a], { env, encoding: "utf8" });
let cleaned = false;
stopOnExit(() => {
  if (cleaned) return;
  cleaned = true;
  sh("dev-fixture.sh", port, "stop");
  sh("dev.sh", port, "stop");
  sh("dev.sh", bare, "stop");
  fake.close();
  rmSync(scratch, { recursive: true, force: true });
  try { sql(`drop database ${DB} with (force)`, "postgres"); } catch { /* it's a throwaway server */ }
});
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
for (const [s, p] of [["dev.sh", port], ["dev-fixture.sh", port], ["dev.sh", bare]]) {
  const r = sh(s, p);
  if (r.status !== 0) { console.error(`${s} ${p}: ${r.stdout}${r.stderr}`); process.exit(1); }
}
const bin = `${repo}/gateway/target/debug/lumbridge-mobile-server`;
const cli = (args, input = "") => spawnSync(bin, args, { env: { LUMBRIDGE_DATABASE_URL: DB_URL }, input, encoding: "utf8" });
const migrated = cli(["migrate"]);
if (migrated.status !== 0) { console.error(migrated.stderr); process.exit(1); }
const t = target(port), tb = target(bare);
const api = async (base, tok, method, p, body) => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(base + p.slice(1), { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    } catch (e) { if (i > 50) throw e; await sleep(100); } // the gateway is a moment behind dev.sh
  }
};
const A = (method, p, body) => api(t.base, t.token, method, p, body);
const newAsk = (title, body = "") => {
  const r = cli(["asks", "create"], JSON.stringify({ title, body }));
  if (r.status !== 0) throw new Error(`asks create: ${r.stderr}`);
  return JSON.parse(r.stdout).id;
};
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = localDate(new Date());
// Fake words only.
await A("POST", "/api/tasks", { id: crypto.randomUUID(), title: "Renew the domain", due_on: today, sort_key: Date.now() });
await A("POST", "/api/tasks", { id: crypto.randomUUID(), title: "Book the boiler service", due_on: null, sort_key: Date.now() + 1 });
const askId = newAsk("Move the dentist to Friday at 9:30?", "They have 9:30 or 15:00. I'd take 9:30.");

const browser = await chromium.launch({ channel: "chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const noise = /Failed to load resource|ERR_|503|403/;
async function open(profile = "iphone", { dark = true, hash = "", base = t } = {}) {
  const ctx = await browser.newContext({ ...PROFILES[profile], colorScheme: dark ? "dark" : "light", reducedMotion: "reduce", permissions: ["microphone"] });
  await ctx.addInitScript((tok) => { try { localStorage.setItem("lumbridge.token", tok); } catch {} }, base.token);
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(`pageerror: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !noise.test(m.text())) p.errors.push(`console: ${m.text()}`); });
  await p.goto(base.base + hash);
  await p.waitForSelector(".td", { timeout: 15000 });
  return p;
}
const close = (p) => p.context().close();
const shown = (p, sel) => p.locator(sel).isVisible().catch(() => false);
const ready = (p) => until(async () => (await p.locator(".td-needs .row").count()) >= 4 && (await p.locator(".fy-card").count()) >= 1
  && (await p.locator(".td-machines .td-line").count()) === (EXT ? 1 : 0) && (await p.locator(".td-task").count()) >= 2, 15000);

try {
  // ---- A bare start lands on Today, with everything that needs the owner ----
  {
    const p = await open("iphone");
    check("a bare start lands on Today", await ready(p), await p.evaluate(() => document.querySelector(".td")?.innerText.slice(0, 300)));
    check("Today is the first tab, and lit", await p.evaluate((ASSISTANT) => {
      const tabs = [...document.querySelectorAll(".tabs > .tab:not(.tab-drawer)")].filter((e) => getComputedStyle(e).display !== "none").map((e) => e.getAttribute("aria-label").split(",")[0]);
      return JSON.stringify(tabs) === JSON.stringify(["Today", "Agents", ASSISTANT, "Tasks", "Apps"]) && document.querySelector(".tab-today").classList.contains("on");
    }, ASSISTANT), await p.evaluate(() => [...document.querySelectorAll(".tabs > .tab")].map((e) => e.className).join(" | ")));
    const widths = await p.evaluate(() => [...document.querySelectorAll(".tabs > .tab")].filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().width)));
    check("five tabs share the bar evenly", widths.length === 5 && Math.max(...widths) - Math.min(...widths) <= 1, JSON.stringify(widths));
    check("the brand mark goes to Today", await p.evaluate(() => document.querySelector(".brand").getAttribute("href") === "#/today"));
    check("the Agents tab still goes to its own view", await p.evaluate(() => /^#\/(agents|panes)$/.test(document.querySelector(".tab-agents").getAttribute("href"))));
    check("the header has the date", (await p.locator(".td-date").innerText()).length > 5);
    const hud = await p.evaluate(() => [...document.querySelectorAll(".td-stat")].map((s) => [s.querySelector(".td-num").textContent, s.querySelector(".td-label").textContent]));
    const rows = await p.locator(".td-needs .row").count();
    check("the header counts who needs the owner, as many as the rows", hud[0][0] === String(rows) && hud[0][1] === "Need you" && hud[1][1] === "Working" && hud[2][1] === "Done", JSON.stringify(hud));
    check("and the same as the Agents badge", (await p.locator(".tab-agents .badge").innerText()) === String(rows));
    check("Needs you uses the Agents tab's rows, with their question", (await p.locator(".td-needs .row.needs .row-ask").count()) >= 2);
    check("a blocked agent's choices are buttons here too", await until(async () => (await p.locator(".td-needs .row .choice").count()) >= 2));
    check("For you is on Today, with the assistant's ask", (await p.locator(`.fy-card[data-id="${askId}"]`).count()) === 1);
    const lines = await p.locator(".td-machines .td-line").evaluateAll((as) => as.map((a) => [a.getAttribute("href"), a.querySelector(".td-line-title").textContent, a.querySelector(".td-line-meta")?.textContent ?? ""]));
    if (EXT) {
      check("a critical alert, one line, to Infra", lines[0][0] === "#/infra" && lines[0][1] === "Node down" && /gpu-box/.test(lines[0][2]), JSON.stringify(lines));
      check("and nothing else there", lines.length === 1, JSON.stringify(lines));
    } else {
      check("without Infra on this server: no Machines", lines.length === 0 && !(await shown(p, ".td-machines")), JSON.stringify(lines));
    }
    const titles = await p.locator(".td-task-title").allInnerTexts();
    check("the first open tasks, due first", titles[0] === "Renew the domain" && titles.includes("Book the boiler service"), JSON.stringify(titles));
    check("and a way to all of them", (await p.locator(".td-tasks .td-h-link").getAttribute("href")) === "#/tasks");
    check("no all-clear while things need the owner", !(await shown(p, ".td-clear")));
    await shot(p, "iphone-dark");
    if (shots) { await p.evaluate(() => { const v = document.querySelector(".view"); v.scrollTop = v.scrollHeight; }); await shot(p, "iphone-dark-end"); await p.evaluate(() => { document.querySelector(".view").scrollTop = 0; }); }

    // ---- Capture ----
    check("capture is a thought by default", (await p.locator(".td-input").getAttribute("placeholder")) === "Capture a thought…"
      && (await p.locator('.td-target[aria-checked="true"]').innerText()) === "Thought");
    check("thought: tap to talk is offered", (await p.locator('.td-mic[aria-label="Tap to talk"]').isVisible()));
    await p.locator(".td-input").fill("The garage door sensor keeps dropping off the mesh");
    check("with words in the box, the send button shows", await shown(p, ".td-send"));
    await p.locator(".td-input").press("Enter");
    check("Enter saves the thought to Thoughts", await until(async () => (await A("GET", "/api/thoughts")).body?.some?.((x) => x.preview?.startsWith?.("The garage door") || x.body?.startsWith?.("The garage door"))), JSON.stringify((await A("GET", "/api/thoughts")).body).slice(0, 300));
    check("and says so", await until(async () => (await p.locator(".td-said").innerText()) === "Saved to Thoughts"), await p.locator(".td-said").innerText());
    check("the box is empty again", (await p.locator(".td-input").inputValue()) === "");

    await p.locator('.td-target[data-target="task"]').click();
    check("Task: hold to talk instead, and its own placeholder", (await p.locator('.td-mic[aria-label="Hold to talk"]').isVisible()) && (await p.locator(".td-input").getAttribute("placeholder")) === "Add a task…");
    await p.locator(".td-input").fill("Call the plumber tomorrow");
    await p.locator(".td-input").press("Enter");
    const tomorrow = localDate(new Date(Date.now() + 86400e3));
    check("a task, with tomorrow as its date, as Tasks would", await until(async () => (await A("GET", "/api/tasks")).body?.some((x) => x.title === "Call the plumber" && x.due_on === tomorrow)));
    check("said in a sentence", await until(async () => (await p.locator(".td-said").innerText()) === "Added to Tasks, due tomorrow"), await p.locator(".td-said").innerText());
    check("and it's in Today's tasks", await until(async () => (await p.locator(".td-task-title").allInnerTexts()).includes("Call the plumber")));

    await p.locator('.td-target[data-target="note"]').click();
    await p.locator(".td-input").fill("Packing: charger, passport");
    await p.locator(".td-send").click();
    check("a note, through Notes' own saver", await until(async () => (await A("GET", "/api/notes")).body?.some((x) => x.preview?.includes?.("Packing: charger") || x.body?.includes?.("Packing: charger"))), JSON.stringify((await A("GET", "/api/notes")).body).slice(0, 300));
    check("the choice of Note is remembered", await (async () => { await p.reload(); await p.waitForSelector(".td-target"); return (await p.locator('.td-target[aria-checked="true"]').innerText()) === "Note"; })());
    await p.locator('.td-target[data-target="thought"]').click();

    // Offline: the thought waits on the device, and goes when the network is back.
    await p.context().setOffline(true);
    await p.locator(".td-input").fill("Offline thought about the router");
    await p.locator(".td-input").press("Enter");
    check("offline: kept on this device, and it says so", await until(async () => /Kept on this device/.test(await p.locator(".td-said").innerText()), 6000), await p.locator(".td-said").innerText());
    await p.context().setOffline(false);
    check("back online: it reaches Thoughts", await until(async () => (await A("GET", "/api/thoughts")).body?.some?.((x) => (x.preview ?? x.body ?? "").startsWith("Offline thought")), 15000));

    // A tick completes a task on the server.
    await until(async () => (await p.locator(".td-task-title").allInnerTexts()).includes("Book the boiler service"));
    await p.locator(".td-task", { hasText: "Book the boiler service" }).locator(".d-check").click();
    check("ticking a task completes it", await until(async () => (await A("GET", "/api/tasks")).body?.find((x) => x.title === "Book the boiler service")?.done_at));
    check("and it leaves the list", await until(async () => !(await p.locator(".td-task-title").allInnerTexts()).includes("Book the boiler service")));

    // A needs-you row opens its terminal, and Back comes to Today.
    const address = await p.locator(".td-needs .row").first().getAttribute("data-address");
    await p.locator(".td-needs .row .row-main").first().click();
    check("a needs-you row opens its terminal", await until(() => p.evaluate((a) => location.hash === `#/t/${encodeURIComponent(a)}`, address)) && await p.waitForSelector(".xterm-rows", { timeout: 10000 }).then(() => true, () => false));
    check("and Back goes to Today", (await p.locator(".term-head .back").getAttribute("href")) === "#/today");
    await p.locator(".term-head .back").click();
    check("back on Today", await until(async () => (await p.evaluate(() => location.hash)) === "#/today" && await shown(p, ".td")));

    // "/" is for a computer, but it's harmless here; Tasks no longer carries For you.
    await p.evaluate(() => { location.hash = "#/tasks"; });
    await p.waitForSelector(".d-capture");
    check("Tasks has no For you of its own", (await p.locator(".fy").count()) === 0);
    check("no page errors", p.errors.length === 0, p.errors.join(" | "));
    await close(p);
  }

  // ---- In light, and on a desktop: two columns, capture across the top ----
  {
    const p = await open("iphone", { dark: false });
    await ready(p);
    await shot(p, "iphone-light");
    if (shots) { await p.evaluate(() => { const v = document.querySelector(".view"); v.scrollTop = v.scrollHeight; }); await shot(p, "iphone-light-end"); }
    await close(p);
  }
  for (const dark of [true, false]) {
    const p = await open("desktop", { dark });
    await ready(p);
    const box = await p.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return { cap: r(".td-capture"), needs: r(".td-needs"), side: r(".td-side"), page: r(".td") };
    });
    if (dark) {
      check("desktop: within 1100 px", box.page.width <= 1100, JSON.stringify(box.page));
      check("desktop: decisions on the left, machines and tasks on the right", box.needs.right < box.side.left && Math.abs(box.needs.top - box.side.top) < 2, JSON.stringify(box));
      check("desktop: the capture box spans both", box.cap.left <= box.needs.left + 1 && box.cap.right >= box.side.right - 1, JSON.stringify(box));
      await p.locator(".td-date").click();
      await p.keyboard.press("/");
      check("desktop: / goes to the capture box", await p.evaluate(() => document.activeElement?.classList.contains("td-input")));
      await p.keyboard.type("x/y");
      check("and / typed there is just a slash", (await p.locator(".td-input").inputValue()) === "x/y");
      await p.locator(".td-input").fill("");
    }
    await shot(p, `desktop-${dark ? "dark" : "light"}`);
    check(`desktop ${dark ? "dark" : "light"}: no page errors`, p.errors.length === 0, p.errors.join(" | "));
    await close(p);
  }

  // ---- Each part goes when it's empty ----
  {
    world.alert = false;
    await A("POST", `/api/asks/${encodeURIComponent(askId)}/answer`, { verdict: "accept" });
    // The gateway keeps Prometheus's answer for a while (15 s): wait until it says nothing's firing.
    if (EXT) await until(async () => (await A("GET", "/api/infra")).body?.needs?.length === 0, 30000);
    const p = await open("iphone");
    await until(async () => (await p.locator(".td-needs .row").count()) >= 4);
    await sleep(3000); // Infra answers, For you loads
    check("no critical alert: no Machines", !(await shown(p, ".td-machines")));
    check("nothing from the assistant: no For you", !(await shown(p, ".fy")));
    check("agents still need the owner: Needs you stays, and no all-clear", await shown(p, ".td-needs") && !(await shown(p, ".td-clear")));
    await close(p);
  }

  // ---- Nothing needs the owner: one sentence ----
  {
    const p = await open("iphone", { base: tb });
    check("all clear: one plain sentence", await until(async () => /^Nothing needs you\./.test(await p.locator(".td-clear").innerText().catch(() => "")), 8000), await p.locator(".td").innerText());
    check("all clear: no empty sections", !(await shown(p, ".td-needs")) && !(await shown(p, ".fy")) && !(await shown(p, ".td-machines")));
    check("all clear: zero in the header, greyed", await p.evaluate(() => document.querySelector(".td-stat").classList.contains("zero") && document.querySelector(".td-num").textContent === "0"));
    await shot(p, "iphone-clear");
    await close(p);
    // No connection to core: no numbers made up, and no all-clear about agents it can't see.
    {
      const ctx = await browser.newContext({ ...PROFILES.iphone, colorScheme: "dark", reducedMotion: "reduce" });
      await ctx.addInitScript((tok) => { try { localStorage.setItem("lumbridge.token", tok); } catch {} }, tb.token);
      await ctx.routeWebSocket(/\/ws$/, (ws) => ws.close({ code: 1011 }));
      const q = await ctx.newPage();
      await q.goto(tb.base);
      await q.waitForSelector(".td");
      await sleep(3500);
      check("not connected: the numbers say –", await q.evaluate(() => [...document.querySelectorAll(".td-num")].every((n) => n.textContent === "–")));
      check("not connected: no all-clear", !(await shown(q, ".td-clear")));
      check("not connected: capture still works as a box", await shown(q, ".td-input"));
      await shot(q, "iphone-connecting");
      await ctx.close();
    }
    const d = await open("desktop", { base: tb, dark: false });
    await until(async () => await shown(d, ".td-clear"), 8000);
    await shot(d, "desktop-clear-light");
    await close(d);
  }
} catch (e) {
  check("the run completed", false, e.stack);
} finally {
  await browser.close().catch(() => {});
}
const log = readFileSync(`/run/user/${process.getuid()}/k${port}/gw.log`, "utf8");
check("the log holds none of what the owner captured", !/garage door|plumber|Packing|router/.test(log), log.slice(-400));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
