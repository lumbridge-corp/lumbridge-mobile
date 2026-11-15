// Note ideas, end to end: an agent device proposes notes (over MCP and over the API), they show in For you on a phone, Edit & keep
// makes the note from the owner's edited text, Keep makes it as proposed, Drop throws it away, and the push that says so carries no word of
// any of them. Against a scratch gateway and core, a database of its own on the throwaway Postgres, and a fake push service.
//   scripts/ci-db.sh && node tests/proposals-verify.mjs <port> [shots dir]
// LUMBRIDGE_PG_PORT picks the throwaway Postgres (default 5498). Needs web/dist and psql. Never `playwright install`.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PG_PORT, stopOnExit } from "./ports.mjs";
import { chromium, PROFILES } from "./ui-lib.mjs";

const [port, shots] = process.argv.slice(2);
if (!port) { console.error("usage: proposals-verify.mjs <port> [shots dir]"); process.exit(2); }
if (shots) fs.mkdirSync(shots, { recursive: true });
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0, passed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  [${extra}]`}`); if (ok) passed++; else failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(100); } return false; };
const shot = async (p, name) => { if (shots) { await sleep(200); await p.screenshot({ path: `${shots}/${name}.png` }); } };

// ---- A database of its own ------------------------------------------------------------------------------------------

const psqlBin = [process.env.LUMBRIDGE_PG_BIN && `${process.env.LUMBRIDGE_PG_BIN}/psql`].find((p) => p && fs.existsSync(p)) ?? "psql";
const SERVER = `postgres://postgres:lumbridge-throwaway@127.0.0.1:${PG_PORT}`;
const DB = `lumbridge_proposals_${process.pid}`;
const sql = (q, db = DB) => execFileSync(psqlBin, [`${SERVER}/${db}`, "-v", "ON_ERROR_STOP=1", "-Atqc", q], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
sql(`create database ${DB}`, "postgres");
spawnSync(psqlBin, [`${SERVER}/${DB}`, "-qc", "create role lumbridge_app login noinherit password 'dev'; alter role lumbridge_app set search_path = lumbridge"], { stdio: "ignore" });
sql("create schema lumbridge authorization lumbridge_app; revoke all on schema lumbridge from public");
const URL_ = `postgres://lumbridge_app:dev@127.0.0.1:${PG_PORT}/${DB}`;

// ---- A push service that decrypts what it's sent (RFC 8291), as tests/push-e2e.mjs has it --------------------------

const hkdf = (ikm, salt, info, n) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, n));
function decrypt(body, { ecdh, auth }) {
  const salt = body.subarray(0, 16), idlen = body[20];
  const keyid = body.subarray(21, 21 + idlen), cipher = body.subarray(21 + idlen);
  const shared = ecdh.computeSecret(keyid);
  const ikm = hkdf(shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), keyid]), 32);
  const cek = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  return JSON.parse(plain.subarray(0, end).toString());
}
const ecdh = crypto.createECDH("prime256v1");
ecdh.generateKeys();
const sub = { ecdh, auth: crypto.randomBytes(16) };
const pushes = [];
const service = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    try { pushes.push(decrypt(Buffer.concat(chunks), sub)); } catch (e) { pushes.push({ error: e.message }); }
    res.writeHead(201).end();
  });
});
await new Promise((r) => service.listen(0, "127.0.0.1", r));

// ---- The gateway ----------------------------------------------------------------------------------------------------

const run = `/run/user/${process.getuid()}/k${port}`;
const dev = (...a) => spawnSync("bash", [`${repo}/scripts/dev.sh`, port, ...a], {
  env: { ...process.env, LUMBRIDGE_DATABASE_URL: URL_, LUMBRIDGE_PROPOSALS_TICK_MS: "200", LUMBRIDGE_ASKS_TICK_MS: "200" },
  encoding: "utf8",
});
let cleaned = false;
const cleanUp = () => {
  if (cleaned) return;
  cleaned = true;
  service.close();
  dev("stop");
  try { sql(`drop database ${DB} with (force)`, "postgres"); } catch { /* it's a throwaway server */ }
};
stopOnExit(cleanUp);
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
dev("stop");
const up = dev();
if (up.status !== 0) { console.error(up.stdout, up.stderr); process.exit(1); }
const bin = `${repo}/gateway/target/debug/lumbridge-mobile-server`;
const migrated = spawnSync(bin, ["migrate"], { env: { LUMBRIDGE_DATABASE_URL: URL_ }, encoding: "utf8" });
if (migrated.status !== 0) { console.error(migrated.stderr); process.exit(1); }
// The agent: what `lumbridge-mobile-server pair claude-build --agent` makes, with a token this script knows.
const AGENT = crypto.randomBytes(32).toString("hex");
const added = spawnSync(bin, ["dev-add", "claude-build", "--agent"], { env: { LUMBRIDGE_STATE_DIR: `${run}/state` }, input: AGENT, encoding: "utf8" });
if (added.status !== 0) { console.error(added.stderr); process.exit(1); }
const tok = fs.readFileSync(`${run}/token`, "utf8").trim();
const BASE = `http://127.0.0.1:${port}/`;
for (let i = 0; i < 80; i++) { if (await fetch(`${BASE}healthz`).catch(() => null)) break; await sleep(100); }
const api = async (method, p, body, token = tok) => {
  const r = await fetch(BASE + p.slice(1), { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let rpc = 0;
const mcp = (method, params) => api("POST", "/mcp", { jsonrpc: "2.0", id: ++rpc, method, params }, AGENT);
const proposal = (id) => sql(`select status || ' ' || coalesce(note_id::text, '-') from lumbridge.note_proposals where id = '${id}'`);

const browser = await chromium.launch({ channel: "chrome" });
const noise = /Failed to load resource|ERR_|503|403/;
async function open(hash = "#/today") {
  const ctx = await browser.newContext({ ...PROFILES.iphone, colorScheme: "dark", serviceWorkers: "block" });
  await ctx.addInitScript((t) => { try { localStorage.setItem("lumbridge.token", t); } catch {} }, tok);
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(`pageerror: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !noise.test(m.text())) p.errors.push(`console: ${m.text()}`); });
  await p.goto(BASE + hash);
  await p.waitForSelector(".td-capture");
  return p;
}
const card = (p, id) => p.locator(`.fy-card[data-id="${id}"]`);
const opened = async (p, id) => { const c = card(p, id); await c.waitFor(); if (!(await c.evaluate((e) => e.classList.contains("open")))) await c.locator(".fy-head").click(); return c; };

// Words only an agent wrote: none of them may reach a push.
const WORDS = {
  title: "Boiler pressure lives at 1.5 bar",
  body: "Heatwise said keep it at 1.5 bar. <b>not bold</b> See https://heatwise.example/manual/7. Not http://plain.example nor javascript:alert(1).",
  why: "You asked about the boiler twice this month.",
  source: "https://langfuse.example/trace/abc",
};

try {
  // ---- The agent can do what it may, and nothing else ----------------------------------------------------------------
  const sub_ = await api("POST", "/api/push/subscribe", { endpoint: `http://127.0.0.1:${service.address().port}/phone`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: sub.auth.toString("base64url") } });
  check("the owner's phone subscribes to pushes", sub_.status < 300, `${sub_.status}`);
  check("an agent can't subscribe to pushes", (await api("POST", "/api/push/subscribe", {}, AGENT)).status === 403);
  check("an agent can't read tasks", (await api("GET", "/api/tasks", null, AGENT)).body?.error === "agent_not_allowed");
  check("nor write a note", (await api("POST", "/api/notes", { title: "x" }, AGENT)).status === 403);
  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } });
  check("MCP: initialize", init.body?.result?.serverInfo?.name === "lumbridge-notes", JSON.stringify(init.body));
  check("MCP: initialized is accepted", (await api("POST", "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, AGENT)).status === 202);

  // ---- An agent proposes; a push says only how many ---------------------------------------------------------------
  await sleep(600); // the watcher has seen the empty list, so what comes next is news
  const made = await mcp("tools/call", { name: "note_propose", arguments: WORDS });
  const editId = made.body?.result?.structuredContent?.id;
  check("MCP: note_propose makes a proposal", !!editId && proposal(editId) === "pending -", JSON.stringify(made.body));
  check("from the device, by name", sql(`select proposed_by from lumbridge.note_proposals where id = '${editId}'`) === "claude-build");
  check("a push came", await until(() => pushes.some((x) => x.kind === "note-ideas")), JSON.stringify(pushes));
  const push = pushes.find((x) => x.kind === "note-ideas");
  check("it says only how many", push?.title === "1 note idea" && push?.body === "", JSON.stringify(push));
  const pushText = JSON.stringify(pushes);
  check("and no word of the proposal", !["Boiler", "Heatwise", "1.5 bar", "boiler twice", "langfuse", "claude-build"].some((w) => pushText.includes(w)), pushText);

  const drop = (await api("POST", "/api/note-proposals", { title: "Drop this one", body: "Nobody needs it." }, AGENT)).body.id;
  const keep = (await api("POST", "/api/note-proposals", { title: "Keep this one", body: "As it is.", why: "Short." }, AGENT)).body.id;

  // ---- For you shows them ----------------------------------------------------------------------------------------------
  const p = await open();
  check("the cards appear in For you", await until(async () => (await p.locator(".fy-card.fy-proposal").count()) === 3), String(await p.locator(".fy-card").count()));
  check("a closed card says Note idea and the title", (await card(p, editId).locator(".fy-kind").innerText()) === "Note idea" && (await card(p, editId).locator(".fy-title").innerText()) === WORDS.title);
  const c = await opened(p, editId);
  check("open: the body as text, HTML and all", (await c.locator(".fy-text").evaluate((e) => e.textContent)) === WORDS.body);
  check("no element an agent's HTML made", (await c.locator(".fy-text b").count()) === 0);
  const links = await c.locator(".fy-body a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  check("only https: becomes a link", JSON.stringify(links) === JSON.stringify(["https://heatwise.example/manual/7", "https://langfuse.example/trace/abc"]), JSON.stringify(links));
  const meta = await c.locator(".fy-idea-meta").innerText();
  check("why, source and who proposed it", meta.includes(WORDS.why) && meta.includes("langfuse.example") && meta.includes("claude-build"), meta);
  const sizes = await c.locator(".fy-actions button").evaluateAll((bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); }));
  check("Keep, Edit & keep, Drop, big enough for a thumb", sizes.length === 3 && sizes.every((s) => s >= 48), sizes.join());
  check("phone: no sideways scroll", (await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) === 0);
  await shot(p, "proposal-open-iphone");

  // ---- Drop ---------------------------------------------------------------------------------------------------------
  const d = await opened(p, drop);
  await d.locator(".fy-drop").click();
  check("Drop says so", await until(async () => (await d.locator(".fy-note").innerText().catch(() => "")) === "Dropped."));
  check("and the card goes", await until(async () => (await card(p, drop).count()) === 0, 6000));
  check("dropped, no note", proposal(drop) === "denied -");

  // ---- Keep, as proposed -----------------------------------------------------------------------------------------------
  const k = await opened(p, keep);
  await k.locator(".fy-keep").click();
  check("Keep says so, with the note to open", await until(async () => (await k.locator(".fy-note").innerText().catch(() => "")) === "Kept in Notes.") && (await k.locator(".fy-open-note").isVisible()));
  const keptNote = proposal(keep).split(" ")[1];
  check("kept: one note, with the footer", sql(`select title || '|' || body from lumbridge.notes where id = '${keptNote}'`).startsWith("Keep this one|As it is.\n\n— proposed by claude-build, "));

  // ---- Edit & keep -----------------------------------------------------------------------------------------------------
  const e = await opened(p, editId);
  await e.locator(".fy-edit").click();
  const editor = p.locator(".fy-idea-editor");
  await editor.waitFor();
  check("the editor opens with the proposal in it", (await editor.locator(".d-title").inputValue()) === WORDS.title && (await editor.locator(".d-body").inputValue()) === WORDS.body);
  await editor.locator(".d-title").fill("Boiler: 1.5 bar");
  await editor.locator(".d-body").fill("Keep the boiler at 1.5 bar, says Heatwise.");
  await shot(p, "proposal-edit-iphone");
  await editor.locator(".fy-editor-keep").click();
  check("saving opens the new note", await until(async () => p.url().endsWith("#/notes") && (await p.locator(".d-editor:not(.fy-idea-editor) .d-title").inputValue().catch(() => "")) === "Boiler: 1.5 bar"), p.url());
  const editedNote = proposal(editId).split(" ")[1];
  const row = sql(`select title || '|' || body from lumbridge.notes where id = '${editedNote}'`);
  check("the note is the owner's edited text, with the footer", row.startsWith("Boiler: 1.5 bar|Keep the boiler at 1.5 bar, says Heatwise.\n\n— proposed by claude-build, ") && row.endsWith("; source: https://langfuse.example/trace/abc"), row);
  check("the note editor shows it", (await p.locator(".d-editor .d-body").inputValue()).startsWith("Keep the boiler at 1.5 bar"));
  check("two notes made, no more", sql("select count(*) from lumbridge.notes") === "2");
  check("the proposal is kept", proposal(editId) === `accepted ${editedNote}`);
  check("deciding again is refused with the row", (await api("POST", `/api/note-proposals/${editId}/decide`, { decision: "deny", version: 2 })).status === 409);
  check("MCP: the agent sees it kept", (await mcp("tools/call", { name: "my_proposals", arguments: { status: "accepted" } })).body?.result?.structuredContent?.proposals?.length === 2);
  check("no errors", p.errors.length === 0, p.errors.join("; "));

  // ---- A new one arrives while For you is open -------------------------------------------------------------------------
  await p.goto(BASE + "#/today");
  await p.waitForSelector(".td-capture");
  await sleep(800);
  check("nothing left waiting: no For you", !(await p.locator(".fy").isVisible()));
  const late = (await api("POST", "/api/note-proposals", { title: "Arrives later", body: "While the list is open." }, AGENT)).body.id;
  check("it appears without a reload", await until(async () => (await card(p, late).count()) === 1, 35000));
  check("its push says how many, and nothing else", await until(() => pushes.filter((x) => x.kind === "note-ideas").length >= 2) && pushes.filter((x) => x.kind === "note-ideas").every((x) => /^\d+ note ideas?$/.test(x.title) && x.body === ""), JSON.stringify(pushes));
  await p.context().close();

  // ---- Nothing of theirs in the log ----------------------------------------------------------------------------------
  const log = fs.readFileSync(`${run}/gw.log`, "utf8");
  check("the log holds no proposal text", !/Boiler|Heatwise|1\.5 bar|Arrives later|Drop this one/.test(log), log.slice(-400));
} catch (e) {
  check("the run completed", false, e.stack);
} finally {
  await browser.close().catch(() => {});
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
