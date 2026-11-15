// For you, on Today, in Chrome at phone width: the assistant's asks and drafts, read, listened to and answered. Against a scratch
// gateway and core, a database of its own on the throwaway Postgres, a fake Hermes, fake speech, a fake needs file and a fake
// approve command, and for the Mail group a fake triage command and a made-up inbox. Starts and stops everything itself:
//   scripts/dev-db.sh && node tests/foryou-verify.mjs <port> [shots dir]
// LUMBRIDGE_PG_PORT picks the throwaway Postgres (default 5498), as scripts/ci-db.sh and scripts/dev-db.sh do.
// Needs web/dist and psql. Never `playwright install`.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PG_PORT, stopOnExit } from "./ports.mjs";
import { chromium, PROFILES } from "./ui-lib.mjs";

const [port, shots] = process.argv.slice(2);
if (!port) { console.error("usage: foryou-verify.mjs <port> [shots dir]"); process.exit(2); }
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
const DB = `lumbridge_foryou_${process.pid}`;
const sql = (q, db = DB) => execFileSync(psqlBin, [`${SERVER}/${db}`, "-v", "ON_ERROR_STOP=1", "-Atqc", q], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
sql(`create database ${DB}`, "postgres");
spawnSync(psqlBin, [`${SERVER}/${DB}`, "-qc", "create role lumbridge_app login noinherit password 'dev'; alter role lumbridge_app set search_path = lumbridge"], { stdio: "ignore" });
sql("create schema lumbridge authorization lumbridge_app; revoke all on schema lumbridge from public");
const URL_ = `postgres://lumbridge_app:dev@127.0.0.1:${PG_PORT}/${DB}`;
const askRow = (id, cols = "status") => sql(`select ${cols} from lumbridge.asks where id = '${id}'`);
const wipeAsks = () => sql("delete from lumbridge.asks");

// ---- Hermes and the speech host, as far as the gateway can tell -------------------------------------------------------------

const S = fs.mkdtempSync(path.join(os.tmpdir(), "lumbridge-foryou-"));
const hermes = { up: true, turns: [] };
const speech = { spoken: [], heard: 0 };
// Three seconds of silence: long enough to stop it part way through.
const WAV = (() => {
  const rate = 16000, n = rate * 3, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  return b;
})();
const fake = createServer((req, res) => {
  const parts = [];
  req.on("data", (d) => parts.push(d));
  req.on("end", () => {
    const raw = Buffer.concat(parts);
    if (req.url === "/v1/chat/completions") {
      if (!hermes.up) { res.writeHead(503); res.end("{}"); return; }
      const body = JSON.parse(raw.toString());
      hermes.turns.push({ session: req.headers["x-hermes-session-id"], words: body.messages.at(-1).content, key: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"Noted."}}]}\n\ndata: [DONE]\n\n');
    } else if (req.url === "/v1/audio/speech") {
      speech.spoken.push(JSON.parse(raw.toString()).input);
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(WAV);
    } else if (req.url === "/v1/audio/transcriptions") {
      speech.heard++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "Friday after three" }));
    } else { res.writeHead(404); res.end(); }
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;
fs.writeFileSync(`${S}/hermes-key`, "hermes-test-key");

// ---- The assistant's drafts: a needs file and an approve stand-in--------------------------------------------------------

const DRAFTS = `${S}/drafts`, FILE = `${S}/needs-you.json`;
fs.mkdirSync(DRAFTS);
const BIN = `${S}/approve`;
fs.writeFileSync(BIN, `#!/usr/bin/env python3
import json, os, re, sys
D = ${JSON.stringify(DRAFTS)}
with open(${JSON.stringify(`${S}/calls`)}, "a") as f: f.write(" ".join(sys.argv[1:]) + "\\n")
a = sys.argv[1:]
if not re.match(r"^[0-9]+-[0-9a-f]{4}$", a[1]): sys.exit("bad id")
p = os.path.join(D, a[1] + ".json")
d = json.load(open(p))
if a[0] == "show": print(json.dumps(d)); sys.exit(0)
if d["state"] != "pending": sys.exit("already " + d["state"])
d["state"] = "done" if a[0] == "yes" else "rejected"
json.dump(d, open(p, "w"))
print("ok")
`, { mode: 0o755 });
// The watcher's `mail` key, once the Mail checks set it. Made-up people and words only.
let inbox = null;
const watch = () => {
  const drafts = fs.readdirSync(DRAFTS).map((f) => JSON.parse(fs.readFileSync(`${DRAFTS}/${f}`, "utf8"))).filter((d) => d.state === "pending");
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify({ updated_ms: Date.now(), drafts, ...(inbox ? { mail: inbox } : {}) }));
  fs.renameSync(`${FILE}.tmp`, FILE);
};
const calls = () => { try { return fs.readFileSync(`${S}/calls`, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };
const draftSend = (text, why, createdMs = Date.now()) => {
  const id = `${Math.floor(createdMs / 1000)}-${Math.random().toString(16).slice(2, 6).padEnd(4, "0")}`;
  fs.writeFileSync(`${DRAFTS}/${id}.json`, JSON.stringify({ id, kind: "send", why, state: "pending", created_ms: createdMs, address: "t7", where: "Studio / Gateway", text }));
  watch();
  return id;
};
watch();
// The triage stand-in: writes each call down, and does nothing else. It's the gateway that hides what the owner is dealt with until the file catches up.
const TRIAGE = `${S}/triage`;
fs.writeFileSync(TRIAGE, `#!/bin/sh\necho "$*" >> ${JSON.stringify(`${S}/triage-calls`)}\n`, { mode: 0o755 });
const triageCalls = () => { try { return fs.readFileSync(`${S}/triage-calls`, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };

// ---- The gateway ----------------------------------------------------------------------------------------------------

const dev = (...a) => spawnSync("bash", [`${repo}/scripts/dev.sh`, port, ...a], {
  env: {
    ...process.env, LUMBRIDGE_DATABASE_URL: URL_, LUMBRIDGE_HERMES_URL: FAKE, LUMBRIDGE_HERMES_KEY_FILE: `${S}/hermes-key`,
    LUMBRIDGE_ASR_PRIMARY_URL: "", LUMBRIDGE_ASR_URL: `${FAKE}/v1/audio/transcriptions`, LUMBRIDGE_ASR_FALLBACK_URL: `${FAKE}/v1/audio/transcriptions`, LUMBRIDGE_TTS_URL: `${FAKE}/v1/audio/speech`,
    LUMBRIDGE_NEEDS_FILE: FILE, LUMBRIDGE_APPROVE_CMD: BIN, LUMBRIDGE_TRIAGE_CMD: TRIAGE, LUMBRIDGE_MAIL_ACCOUNTS: "sam,sam-work", LUMBRIDGE_ASKS_TICK_MS: "200", LUMBRIDGE_ASKS_RETRY_MS: "500",
  },
  encoding: "utf8",
});
let cleaned = false;
const cleanUp = () => {
  if (cleaned) return;
  cleaned = true;
  dev("stop");
  try { sql(`drop database ${DB} with (force)`, "postgres"); } catch { /* it's a throwaway server */ }
  fs.rmSync(S, { recursive: true, force: true });
};
// On Ctrl-C and SIGTERM too, not only a normal exit.
stopOnExit(cleanUp);
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
dev("stop");
const up = dev();
if (up.status !== 0) { console.error(up.stdout, up.stderr); process.exit(1); }
const bin = `${repo}/gateway/target/debug/lumbridge-mobile-server`;
const cli = (args, input = "") => spawnSync(bin, args, { env: { LUMBRIDGE_DATABASE_URL: URL_ }, input, encoding: "utf8" });
const migrated = cli(["migrate"]);
if (migrated.status !== 0) { console.error(migrated.stderr); process.exit(1); }
const newAsk = (title, body = "") => {
  const r = cli(["asks", "create"], JSON.stringify({ title, body }));
  if (r.status !== 0) throw new Error(`asks create: ${r.stderr}`);
  return JSON.parse(r.stdout).id;
};
const newPick = (title, options) => {
  const r = cli(["asks", "create"], JSON.stringify({ title, body: "The assistant's shortlist.", options }));
  if (r.status !== 0) throw new Error(`asks create: ${r.stderr}`);
  return JSON.parse(r.stdout).id;
};
const tok = fs.readFileSync(`/run/user/${process.getuid()}/k${port}/token`, "utf8").trim();
const BASE = `http://127.0.0.1:${port}/`;
for (let i = 0; i < 80; i++) { if (await fetch(`${BASE}healthz`).catch(() => null)) break; await sleep(100); }
const api = async (method, p, body) => {
  const r = await fetch(BASE + p.slice(1), { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const browser = await chromium.launch({ channel: "chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const noise = /Failed to load resource|ERR_|503|403/;
async function open(profile = "iphone", hash = "#/today") {
  // No service worker: once one controls the page, a request goes through it and page.route can miss it, which made the
  // "answer lost on the way back" check see a plain success on a loaded runner. Nothing here is about the worker.
  const ctx = await browser.newContext({ ...PROFILES[profile], colorScheme: "dark", permissions: ["microphone"], serviceWorkers: "block" });
  await ctx.addInitScript((tok) => { try { localStorage.setItem("lumbridge.token", tok); } catch {} }, tok);
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(`pageerror: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !noise.test(m.text())) p.errors.push(`console: ${m.text()}`); });
  await p.goto(BASE + hash);
  await p.waitForSelector(hash === "#/today" ? ".td-capture" : hash === "#/tasks" ? ".d-capture" : "main");
  return p;
}
const close = (p) => p.context().close();
const card = (p, id) => p.locator(`.fy-card[data-id="${id}"]`);
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const note = (p, id) => card(p, id).locator(".fy-note").innerText({ timeout: 1000 }).catch(() => "");
const opened = async (p, id) => { const c = card(p, id); await c.waitFor(); if (!(await c.evaluate((e) => e.classList.contains("open")))) await c.locator(".fy-head").click(); return c; };

try {
  // ---- Nothing waiting --------------------------------------------------------------------------------------------------
  {
    const p = await open();
    await sleep(800);
    check("nothing waiting: no For you at all", !(await p.locator(".fy").isVisible()));
    check("nothing waiting: Today is as it was", await p.locator(".td-capture").isVisible());
    check("no errors", p.errors.length === 0, p.errors.join("; "));
    await close(p);
  }

  // ---- What the owner sees ----------------------------------------------------------------------------------------------------
  const older = newAsk("Book the dentist for Thursday?", "They have 9:30 or 15:00. I'd take 9:30.\nSay which.");
  await sleep(20);
  const draft = draftSend("Run the tests again, please.", "He asked me to chase the failing build.");
  await sleep(1100);
  const newer = newAsk("Cancel the gym? It renews on the 10th and you haven't been since June, so it seems a waste", "run this\u001b[2J then that");
  {
    const p = await open();
    // Asks and drafts arrive separately (/api/asks, /api/assistant/needs), so wait for the list both make before reading it.
    await until(async () => (await p.locator(".fy-card").count()) === 3);
    check("For you is on Today, under the capture box", await p.evaluate(() => {
      const fy = document.querySelector(".td .fy"), cap = document.querySelector(".td-capture");
      return !!fy && !!cap && (cap.compareDocumentPosition(fy) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }));
    const keys = await p.evaluate(() => [...document.querySelectorAll(".fy-card")].map((c) => c.dataset.id));
    check("asks and drafts together, newest first", JSON.stringify(keys) === JSON.stringify([newer, draft, older]), JSON.stringify(keys));
    check("says how many", (await p.textContent(".fy-count")) === "3", await p.textContent(".fy-count"));
    const oneLine = await card(p, newer).locator(".fy-title").evaluate((e) => { const s = getComputedStyle(e); return s.whiteSpace === "nowrap" && e.getBoundingClientRect().height < 30; });
    check("a closed card is one line of title", oneLine);
    check("a draft says its kind in words", (await card(p, draft).locator(".fy-kind").innerText()) === "To Studio / Gateway");
    check("closed, the words stay folded away", !(await card(p, older).locator(".fy-body").isVisible()));
    const heads = await p.evaluate(() => [...document.querySelectorAll(".fy-head")].map((b) => b.getBoundingClientRect().height));
    check("closed cards are big to tap", heads.every((h) => h >= 56), heads.join());
    check("phone: no sideways scroll", (await overflow(p)) === 0);
    await shot(p, "foryou-closed-iphone");

    const c = await opened(p, older);
    check("open: the whole text, as text", (await c.locator(".fy-text").evaluate((e) => e.textContent)) === "They have 9:30 or 15:00. I'd take 9:30.\nSay which.");
    const n = await opened(p, newer);
    check("open: the whole title, wrapped", (await n.locator(".fy-full-title").innerText()).endsWith("since June, so it seems a waste"));
    check("what a screen would hide is shown", /\[U\+001B\]\[2J/.test(await n.locator(".fy-text").innerText()));
    const buttons = await p.evaluate(() => [...document.querySelectorAll(".fy-card.open button")].filter((b) => b.offsetParent).map((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); }));
    check("every button is big enough for a thumb", buttons.length >= 8 && buttons.every((s) => s >= 48), buttons.join());
    check("phone: no sideways scroll, opened", (await overflow(p)) === 0);
    await shot(p, "foryou-open-iphone");
    check("nothing played by itself", speech.spoken.length === 0, speech.spoken.join("|"));
    check("no errors", p.errors.length === 0, p.errors.join("; "));
    await close(p);
  }

  // ---- Listen -----------------------------------------------------------------------------------------------------------
  {
    const p = await open();
    const c = await opened(p, older);
    const listen = c.locator(".fy-listen");
    await listen.click();
    // The queue asks for the first two sentences at once (SpeechQueue.prefetch), so which of them reaches the fake first is up to
    // the runner; it still plays them in order. What it must ask for first is the title and the words' first sentence, nothing else.
    const firstTwo = () => [...speech.spoken.slice(0, 2)].sort().join("|");
    check("Listen reads the title, then the words", await until(() => firstTwo() === ["Book the dentist for Thursday?", "They have 9:30 or 15:00."].sort().join("|")), speech.spoken.join("|"));
    check("it says it can be stopped", (await listen.innerText()) === "Stop" && (await listen.getAttribute("aria-pressed")) === "true");
    await sleep(500);
    await listen.click();
    check("tapping again stops it", (await listen.innerText()) === "Listen" && (await listen.getAttribute("aria-pressed")) === "false");
    const asked = speech.spoken.length;
    await sleep(3500);
    check("and nothing more is fetched or played", speech.spoken.length === asked, `${asked} then ${speech.spoken.length}`);
    check("Listen goes through the assistant's voice", asked >= 1 && asked < 4);
    await close(p);
  }

  // ---- Accept and deny -----------------------------------------------------------------------------------------------
  {
    hermes.turns = [];
    const p = await open();
    const c = await opened(p, older);
    await c.locator(".fy-accept").click();
    check("accept is saved", await until(() => askRow(older) === "accepted"));
    check("and says so", await until(async () => /^Accepted/.test(await note(p, older))));
    await shot(p, "foryou-accepted-iphone");
    check("the assistant hears it in its session", await until(() => hermes.turns.some((t) => t.words === 'The owner answered your question "Book the dentist for Thursday?": accepted.')), JSON.stringify(hermes.turns));
    check("in the pinned session, with the key", hermes.turns.every((t) => /^[a-z]+_[0-9]+$/.test(t.session) && t.key === "Bearer hermes-test-key"));
    check("delivered is written down", await until(() => askRow(older, "delivered_at is not null") === "t"));
    check("the card goes", await until(async () => (await card(p, older).count()) === 0, 6000));

    const d = await opened(p, newer);
    await d.locator(".fy-deny").click();
    check("deny is saved", await until(() => askRow(newer) === "denied"));
    check("the assistant hears that too", await until(() => hermes.turns.some((t) => /: denied\.$/.test(t.words))));
    const r = await api("POST", `/api/asks/${newer}/answer`, { verdict: "accept" });
    check("a repeat answer is refused, stably, and changes nothing", r.status === 409 && r.body.error === "already_answered" && r.body.ask.status === "denied" && askRow(newer) === "denied", JSON.stringify(r));
    await sleep(1500);
    check("each went to her once", hermes.turns.length === 2, JSON.stringify(hermes.turns));
    check("no errors", p.errors.length === 0, p.errors.join("; "));
    await close(p);
  }

  // ---- Reply, said and then fixed ------------------------------------------------------------------------------------
  {
    hermes.turns = [];
    const id = newAsk("Which day for the plumber?");
    const p = await open();
    const c = await opened(p, id);
    await c.locator(".fy-reply-open").click();
    const box = c.locator(".fy-reply");
    check("Reply opens a box to say or type it", await box.isVisible());
    const send = c.locator(".fy-send");
    await send.click();
    check("an empty reply isn't sent", /Say or type/.test(await note(p, id)) && askRow(id) === "pending");
    const talk = c.locator(".fy-talk");
    const b = await talk.boundingBox();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.down();
    await sleep(1500);
    await p.mouse.up();
    check("hold to talk: the speech host's words land in the box", await until(async () => (await box.inputValue()) === "Friday after three"), await box.inputValue());
    check("and nothing is sent until the owner says so", askRow(id) === "pending");
    await box.fill("Friday after three, or Saturday morning");
    await p.reload();
    await p.waitForSelector(".fy-card");
    const again = await opened(p, id);
    check("the owner's reply survives a reload", (await again.locator(".fy-reply").inputValue()) === "Friday after three, or Saturday morning");
    await shot(p, "foryou-reply-iphone");
    await again.locator(".fy-send").click();
    check("the fixed words are what's saved", await until(() => askRow(id, "status || '/' || reply") === "replied/Friday after three, or Saturday morning"));
    check("and what the assistant hears", await until(() => hermes.turns.some((t) => t.words === 'The owner answered your question "Which day for the plumber?": replied: Friday after three, or Saturday morning')), JSON.stringify(hermes.turns));
    check("the kept copy goes once it's saved", await until(() => p.evaluate((k) => localStorage.getItem(k) === null, `lumbridge.asks.reply.${id}`)));
    await close(p);
  }

  // ---- Things in the way -------------------------------------------------------------------------------------------------
  {
    const id = newAsk("Renew the domain?");
    const p = await open();
    const c = await opened(p, id);

    // A device the assistant can operate.
    await p.route("**/answer", (r) => r.fulfill({ status: 403, json: { error: "not_from_here" } }));
    await c.locator(".fy-reply-open").click();
    await c.locator(".fy-reply").fill("Yes, for two years");
    await c.locator(".fy-send").click();
    check("a refused device says so plainly", await until(async () => /Assistant can operate this device/.test(await note(p, id))));
    check("and doesn't look like success", await c.locator(".fy-note.bad").isVisible() && (await c.locator(".fy-accept").isEnabled()));
    check("the owner's reply is still there", (await c.locator(".fy-reply").inputValue()) === "Yes, for two years");
    check("and nothing was saved", askRow(id) === "pending");
    await shot(p, "foryou-refused-iphone");
    await p.unroute("**/answer");

    // Offline.
    await p.context().setOffline(true);
    await c.locator(".fy-send").click();
    check("offline: says so, nothing sent", await until(async () => /offline/.test(await note(p, id))) && askRow(id) === "pending");
    await p.context().setOffline(false);

    // The answer gets there and the reply back is lost; trying again finds its own answer standing.
    let lost = 0;
    await p.route("**/answer", async (r) => { if (lost) return r.continue(); lost++; await r.fetch(); await r.abort("connectionreset"); });
    await c.locator(".fy-send").click();
    check("no answer back: says it may not have been saved", await until(async () => /may not have been saved/.test(await note(p, id))));
    check("it was, once", askRow(id, "status || '/' || reply") === "replied/Yes, for two years");
    await c.locator(".fy-send").click();
    check("trying again recognises its own answer", await until(async () => /^Replied: Yes, for two years/.test(await note(p, id))), await note(p, id));
    check("no errors", p.errors.length === 0, p.errors.join("; "));
    await close(p);
  }

  // ---- Hermes away: saved now, delivered later, once -------------------------------------------------------------------------
  {
    hermes.turns = [];
    hermes.up = false;
    const id = newAsk("Move the call to 4?");
    const p = await open();
    const c = await opened(p, id);
    const started = Date.now();
    await c.locator(".fy-accept").click();
    check("with Hermes down the owner's tap isn't held up", await until(async () => /^Accepted/.test(await note(p, id)), 3000) && Date.now() - started < 3000);
    check("the answer is saved", askRow(id) === "accepted");
    await sleep(1500);
    check("and waits, undelivered", askRow(id, "delivered_at is null") === "t" && hermes.turns.length === 0);
    hermes.up = true;
    check("when she's back it reaches her", await until(() => hermes.turns.length === 1, 8000));
    check("and is written down as delivered", await until(() => askRow(id, "delivered_at is not null") === "t"));
    await sleep(2000);
    check("only once", hermes.turns.length === 1, JSON.stringify(hermes.turns));
    await close(p);
  }

  // ---- An ask with options: tick two, Pick these ------------------------------------------------------------------------
  {
    hermes.turns = [];
    const roles = [
      { key: "459", label: "Platform engineer, Acme", detail: "Remote. Rust and Postgres.", link: "https://jobs.example.com/459" },
      { key: "436", label: "SRE, Initech <b>urgent</b>", detail: "<img src=x onerror=\"window.pwned=1\">Hybrid" },
      { key: "12", label: "Backend, Globex", detail: "Berlin.\nVisa sponsored.", link: "https://jobs.example.com/12" },
    ];
    const plain = newAsk("Renew the car insurance?");
    const id = newPick("Pick roles for your first applications", roles);
    const none = newPick("Pick roles for round two", roles);
    const p = await open();
    const pl = await opened(p, plain);
    check("a plain ask still renders as before", (await pl.locator(".fy-accept").innerText()) === "Accept" && (await pl.locator(".fy-deny").innerText()) === "Deny"
      && (await pl.locator(".fy-options").count()) === 0 && (await pl.locator(".fy-accept").isEnabled()));
    const c = await opened(p, id);
    const rows = c.locator(".fy-option");
    check("one row per option", (await rows.count()) === 3);
    check("label bold, detail under it", (await rows.nth(0).locator("strong.fy-option-label").innerText()) === "Platform engineer, Acme"
      && (await rows.nth(0).locator(".fy-option-detail").innerText()) === "Remote. Rust and Postgres.");
    check("a stranger's markup is text, never HTML", (await rows.nth(1).locator(".fy-option-label").innerText()) === "SRE, Initech <b>urgent</b>"
      && (await c.locator("b, img").count()) === 0 && !(await p.evaluate(() => window.pwned)));
    const links = await c.locator(".fy-option-link").evaluateAll((as) => as.map((a) => [a.textContent, a.href, a.target, a.rel].join("|")));
    check("Open posting, in a new tab, noopener noreferrer, https only", JSON.stringify(links) === JSON.stringify([
      "Open posting|https://jobs.example.com/459|_blank|noopener noreferrer", "Open posting|https://jobs.example.com/12|_blank|noopener noreferrer",
    ]), JSON.stringify(links));
    const pick = c.locator(".fy-accept");
    check("Pick these and None of these", (await pick.innerText()) === "Pick these" && (await c.locator(".fy-deny").innerText()) === "None of these");
    check("Pick these waits for a tick", await pick.isDisabled());
    await rows.nth(0).locator(".fy-option-pick").click();
    await rows.nth(2).locator(".fy-option-words").click();
    check("tapping a row ticks it", (await c.locator(".fy-tick:checked").count()) === 2);
    check("then Pick these can go", await pick.isEnabled());
    check("phone: no sideways scroll, with options", (await overflow(p)) === 0);
    await shot(p, "foryou-options-iphone");
    await pick.click();
    check("the two picked are saved", await until(() => askRow(id, "status || '/' || array_to_string(picked, ',')") === "accepted/459,12"), askRow(id, "status || '/' || coalesce(array_to_string(picked, ','), '-')"));
    check("the row shows answered with those two", await until(async () => /^Picked: Platform engineer, Acme; Backend, Globex/.test(await note(p, id))), await note(p, id));
    const marked = await c.locator(".fy-option.picked").evaluateAll((r) => r.map((x) => x.dataset.key));
    check("and marks them", JSON.stringify(marked) === JSON.stringify(["459", "12"]), JSON.stringify(marked));
    check("ticks can't change after", (await c.locator(".fy-tick:not(:disabled)").count()) === 0);
    await shot(p, "foryou-picked-iphone");
    check("the assistant hears which", await until(() => hermes.turns.some((t) => t.words === 'The owner answered your question "Pick roles for your first applications": picked 459, 12.')), JSON.stringify(hermes.turns));
    const again = await api("POST", `/api/asks/${id}/answer`, { verdict: "pick", keys: ["436"] });
    check("a second pick is refused and changes nothing", again.status === 409 && JSON.stringify(again.body.ask.picked) === '["459","12"]', JSON.stringify(again));
    const accept = await api("POST", `/api/asks/${none}/answer`, { verdict: "accept" });
    check("a plain accept on a list is refused", accept.status === 400 && accept.body.error === "pick_which", JSON.stringify(accept));

    const n = await opened(p, none);
    await n.locator(".fy-deny").click();
    check("None of these is a deny", await until(() => askRow(none, "status || '/' || (picked is null)") === "denied/true"));
    check("and says so", await until(async () => /^None of these/.test(await note(p, none))));
    check("the assistant hears none of these", await until(() => hermes.turns.some((t) => t.words === 'The owner answered your question "Pick roles for round two": none of these.')));
    check("no errors", p.errors.length === 0, p.errors.join("; "));
    await close(p);
    wipeAsks();
  }

  // ---- Twenty at most ----------------------------------------------------------------------------------------------------------
  {
    wipeAsks();
    for (let i = 0; i < 20; i++) newAsk(`Question ${i + 1}`);
    const r = cli(["asks", "create"], JSON.stringify({ title: "One too many" }));
    check("the 21st waiting ask is refused", r.status !== 0 && /at most 20/.test(r.stderr) && r.stdout === "", r.stderr);
    const p = await open();
    await p.waitForSelector(".fy-card");
    check("all twenty show, with the draft", await until(async () => (await p.locator(".fy-card").count()) === 21));
    check("phone: no sideways scroll with many", (await overflow(p)) === 0);
    await close(p);
    wipeAsks();
  }

  // ---- A draft, approved from Tasks ------------------------------------------------------------------------------------------
  {
    const q = await open("iphone", "#/assistant");
    check("the assistant's tab still shows the draft", await q.waitForSelector(`.ppd-card[data-id="${draft}"]`, { timeout: 8000 }).then(() => true, () => false));
    await close(q);
    const p = await open();
    const c = await opened(p, draft);
    check("open, the draft's own card: why, where, the exact words", /chase the failing build/.test(await c.locator(".ppd-why").innerText()) && (await c.locator(".ppd-text").innerText()) === "Run the tests again, please." && (await c.locator(".ppd-detail").innerText()) === "t7");
    check("without a second heading", (await c.locator(".ppd-to").count()) === 0);
    await c.locator(".fy-listen").click();
    check("a draft can be listened to", await until(() => speech.spoken.some((s) => /To Studio/.test(s))), speech.spoken.slice(-3).join("|"));
    await c.locator(".fy-listen").click();
    const approve = c.locator(".ppd-approve");
    await approve.click();
    check("the first tap only arms it", (await approve.innerText()) === "Tap again to send" && !calls().some((x) => x.startsWith("yes")));
    await shot(p, "foryou-draft-armed-iphone");
    await approve.click();
    check("the second approves, through the same path", await until(() => calls().includes(`yes ${draft} --bg`)), calls().join("; "));
    check("after reading it first", calls().indexOf(`show ${draft}`) < calls().indexOf(`yes ${draft} --bg`));
    check("and says so", await until(async () => /Approved/.test(await c.locator(".ppd-note").innerText().catch(() => ""))));
    watch();
    check("and when it went", await until(async () => /Sent/.test(await c.locator(".ppd-note").innerText().catch(() => "")), 10000));
    check("then it goes", await until(async () => (await card(p, draft).count()) === 0, 8000));
    check("and For you is hidden again", await until(async () => !(await p.locator(".fy").isVisible())));
    check("no errors", p.errors.length === 0, p.errors.join("; "));
    await close(p);
  }

  // ---- Mail: what in the owner's inbox needs the owner ------------------------------------------------------------------------------------------
  const LUNCH = "sam:18f2c0a1b2c3d4e5", IRS = "sam:18f2c0a1b2c3ffff", INVITE = "sam-work:event:abc123", FAVOR = "sam:18f2c0a1b2c30000";
  const reply = `${Math.floor(Date.now() / 1000)}-ab12`;
  {
    fs.writeFileSync(`${DRAFTS}/${reply}.json`, JSON.stringify({
      id: reply, kind: "mail_reply", why: "Dana asked about lunch.", state: "pending", created_ms: Date.now(), address: "sam@example.com",
      name: "18f2c0a1b2c3d4e5", text: "From: sam@example.com\nTo: dana@example.test\nSubject: Re: Lunch Thursday?\n\nThursday at noon works.\n",
    }));
    const now = Date.now();
    inbox = {
      updated_ms: now, spark: "ok", unsorted: 0, fyi_count: 23, noise_count: 34,
      needs_you: [
        { key: LUNCH, account: "sam@example.com", kind: "mail", from: "Dana Lee", subject: "Lunch Thursday?", why: "Dana asks about lunch Thursday at noon.", draft: reply, since_ms: now - 1000 },
        { key: IRS, account: "sam@example.com", kind: "mail", from: "IRS", subject: "Your 2026 notice", sensitive: "government", why: "Government mail from IRS.", draft: null, since_ms: now - 2000 },
        { key: INVITE, account: "sam.work@example.com", kind: "invite", from: "vendor@example.test", subject: "Vendor pitch", why: "Invite for 2026-11-07T10:00, not answered yet.", draft: null, since_ms: now - 3000 },
        { key: FAVOR, account: "sam@example.com", kind: "mail", from: "Helpful", subject: "Quick <b>favor</b>", suspicious: true, why: "Looks like it's trying to instruct an assistant. Nothing was done.", draft: null, since_ms: now - 4000 },
      ],
    };
    watch();
    const p = await open();
    const row = (key) => p.locator(`.fy-mail-row[data-key="${key}"]`);
    check("Mail shows in For you", await until(async () => (await p.locator(".fy-mail-row").count()) === 4));
    const keys = await p.evaluate(() => [...document.querySelectorAll(".fy-mail-row")].map((c) => c.dataset.key));
    check("one row each, newest first", JSON.stringify(keys) === JSON.stringify([LUNCH, IRS, INVITE, FAVOR]), JSON.stringify(keys));
    check("a row says who and what, then why", (await row(LUNCH).locator(".fy-mail-line").innerText()) === "Dana Lee — Lunch Thursday?"
      && (await row(LUNCH).locator(".fy-mail-why").innerText()) === "Dana asks about lunch Thursday at noon.");
    const irs = row(IRS);
    check("a sensitive row shows only why, with a lock", (await irs.locator(".fy-mail-line").count()) === 0 && (await irs.locator(".fy-lock").isVisible())
      && (await irs.locator(".fy-mail-why").innerText()) === "Government mail from IRS.");
    check("and its subject is nowhere on the page", !(await p.evaluate(() => document.body.textContent.includes("2026 notice"))));
    check("a suspicious row gets a red chip", (await row(FAVOR).locator(".fy-chip-suspicious").innerText()).toLowerCase() === "suspicious"
      && (await row(FAVOR).locator(".fy-chip-suspicious").evaluate((e) => getComputedStyle(e).backgroundColor)) !== "rgba(0, 0, 0, 0)");
    check("strangers' words are text, never HTML", (await row(FAVOR).locator(".fy-mail-line").innerText()) === "Helpful — Quick <b>favor</b>"
      && (await row(FAVOR).locator("b").count()) === 0);
    check("no Listen on mail", (await p.locator(".fy-mail-row .fy-listen").count()) === 0);
    check("the reply draft shows once in For you", await until(async () => (await p.locator(`.fy .ppd-card[data-id="${reply}"]`).count()) === 1)
      && (await p.locator(`.fy-card.fy-draft[data-id="${reply}"]`).count()) === 0, String(await p.locator(`.fy .ppd-card[data-id="${reply}"]`).count()));
    check("under its row, with Send", (await row(LUNCH).locator(`.ppd-card[data-id="${reply}"] .ppd-approve`).innerText()) === "Send");
    check("the footer counts what else came in", (await p.locator(".fy-mail-foot").innerText()) === "23 FYI · 34 noise", await p.locator(".fy-mail-foot").innerText());
    check("says how many, mail included", (await p.textContent(".fy-count")) === "4", await p.textContent(".fy-count"));
    const buttons = await p.evaluate(() => [...document.querySelectorAll(".fy-mail-row .fy-actions button")].filter((b) => b.offsetParent).map((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); }));
    check("Done and Wrong sort are big enough for a thumb", buttons.length === 8 && buttons.every((x) => x >= 48), buttons.join());
    check("phone: no sideways scroll with mail", (await overflow(p)) === 0);
    await shot(p, "foryou-mail-iphone");

    // Refused, as on a device the assistant operates: says so and nothing changes.
    await p.route("**/dismiss", (r) => r.fulfill({ status: 403, json: { error: "not_from_here" } }));
    await row(INVITE).locator(".fy-done").click();
    check("a refused Done says where it works", await until(async () => /your other devices/.test(await row(INVITE).locator(".fy-note").innerText().catch(() => ""))));
    check("and the row stays", (await row(INVITE).count()) === 1 && (await row(INVITE).locator(".fy-done").isEnabled()));
    await p.unroute("**/dismiss");

    await row(INVITE).locator(".fy-done").click();
    check("Done runs triage dismiss", await until(() => triageCalls().includes(`dismiss ${INVITE}`)), triageCalls().join("; "));
    check("and says so", await until(async () => /^Done/.test(await row(INVITE).locator(".fy-note").innerText().catch(() => ""))));
    await row(FAVOR).locator(".fy-wrong").click();
    await row(FAVOR).locator('.fy-sort-to[data-category="fyi"]').click();
    check("Wrong sort → FYI runs triage correct", await until(() => triageCalls().includes(`correct ${FAVOR} fyi`)), triageCalls().join("; "));
    await p.reload();
    await p.waitForSelector(".fy-mail-row");
    await sleep(500);
    const left = await p.evaluate(() => [...document.querySelectorAll(".fy-mail-row")].map((c) => c.dataset.key));
    check("after a reload, Done and the sorted row are gone", JSON.stringify(left) === JSON.stringify([LUNCH, IRS]), JSON.stringify(left));
    check("no errors", p.errors.length === 0, p.errors.join("; "));
    await close(p);
  }
  {
    inbox = { ...inbox, spark: "down", unsorted: 5 };
    watch();
    const p = await open();
    await p.waitForSelector(".fy-mail-row");
    check("the footer says when sorting is down", await until(async () => (await p.locator(".fy-mail-foot").innerText()) === "23 FYI · 34 noise · 5 not sorted yet (sorting is down)"), await p.locator(".fy-mail-foot").innerText());
    const q = await open("iphone", "#/assistant");
    check("the assistant's tab still lists the reply draft", await q.waitForSelector(`.ppd-card[data-id="${reply}"]`, { timeout: 8000 }).then(() => true, () => false));
    await close(q);
    await close(p);
  }

  // ---- For you couldn't be fetched when Today opened: it comes once the connection is back, without leaving Today ----------------
  {
    const id = newAsk("Water the plants on Sunday?");
    const ctx = await browser.newContext({ ...PROFILES.iphone, colorScheme: "dark", serviceWorkers: "block" });
    await ctx.addInitScript((t) => { try { localStorage.setItem("lumbridge.token", t); } catch {} }, tok);
    let blocked = true;
    await ctx.route("**/assets/for-you-*", (r) => (blocked ? r.abort("internetdisconnected") : r.continue()));
    const p = await ctx.newPage();
    p.errors = [];
    p.on("pageerror", (e) => p.errors.push(`pageerror: ${e.message}`));
    await p.goto(BASE + "#/today");
    await p.waitForSelector(".td-capture");
    await sleep(1000);
    check("For you's chunk failed: no For you yet", (await p.locator(".fy").count()) === 0);
    await ctx.setOffline(true);
    await sleep(300);
    blocked = false;
    await ctx.setOffline(false);
    check("back online: the ask appears without leaving Today", await until(async () => (await card(p, id).count()) === 1, 10000));
    check("no errors", p.errors.length === 0, p.errors.join("; "));
    await ctx.close();
  }

  // ---- Nothing of theirs in the log ----------------------------------------------------------------------------------------------
  {
    const log = fs.readFileSync(`/run/user/${process.getuid()}/k${port}/gw.log`, "utf8");
    check("the log holds no ask or reply text", !/dentist|plumber|Saturday morning|two years|Renew the domain/.test(log), log.slice(-400));
    check("nor any mail", !/Dana|Lunch|IRS|notice|Vendor|favor|Helpful|18f2c0a1b2c3/.test(log), log.slice(-400));
  }
} catch (e) {
  check("the run completed", false, e.stack);
} finally {
  await browser.close().catch(() => {});
  fake.close();
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
