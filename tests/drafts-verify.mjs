// The assistant's drafts and the notification work around them, in Chrome against a scratch core and fixture, a fake needs file and
// a fake approve command. Starts and stops everything itself:
//   PW_DIR=$PWD/tests xvfb-run -a node tests/drafts-verify.mjs <port> [shots dir]
// APPROVE_REAL=<a local COPY of the approve command> runs that instead of the stand-in, under a scratch HOME with a stand-in hc,
// to check the contract against the real tool. Never point it at a live one.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopOnExit } from "./ports.mjs";
import { addresses, chromium, PROFILES, scratchEnv, target } from "./ui-lib.mjs";

const [port, shots] = process.argv.slice(2);
if (!port) { console.error("usage: drafts-verify.mjs <port> [shots dir]"); process.exit(2); }
if (shots) fs.mkdirSync(shots, { recursive: true });
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const real = process.env.APPROVE_REAL;
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  [${extra}]`}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(80); } return false; };

// ---- the stand-ins ------------------------------------------------------------------------------------------------

const S = fs.mkdtempSync(path.join(os.tmpdir(), "lumbridge-drafts-"));
const HOME = `${S}/home`, DRAFTS = `${HOME}/.local/state/assistant/drafts`, FILE = `${S}/needs-you.json`;
fs.mkdirSync(DRAFTS, { recursive: true });
fs.mkdirSync(`${HOME}/.local/bin`, { recursive: true });

// `hc send <address> <text>`: writes down exactly what would have gone, and takes a moment, as a real one does.
fs.writeFileSync(`${HOME}/.local/bin/hc`, `#!/usr/bin/env python3
import json, os, sys, time
if sys.argv[1] == "send":
    time.sleep(1)
    with open(${JSON.stringify(S)} + "/sent", "a") as f: f.write(json.dumps(sys.argv[1:]) + "\\n")
    sys.exit(1 if os.path.exists(${JSON.stringify(S)} + "/send-fails") else 0)
sys.exit(1)
`, { mode: 0o755 });

// The stand-in's behaviour is the real tool's: pending to running, then done or failed; "already" on a repeat.
const FAKE = `${S}/fake-approve.py`;
fs.writeFileSync(FAKE, `#!/usr/bin/env python3
import json, os, re, subprocess, sys
DRAFTS = ${JSON.stringify(DRAFTS)}
HC = ${JSON.stringify(`${HOME}/.local/bin/hc`)}
def path(i):
    if not re.match(r"^[0-9]+-[0-9a-f]{4}$", i): sys.exit("bad id: " + i)
    return os.path.join(DRAFTS, i + ".json")
def load(i):
    try: return json.load(open(path(i)))
    except FileNotFoundError: sys.exit("no draft " + i)
def save(d):
    tmp = path(d["id"]) + ".tmp"
    json.dump(d, open(tmp, "w"))
    os.replace(tmp, path(d["id"]))
a = sys.argv[1:]
if a[0] == "show": print(json.dumps(load(a[1])))
elif a[0] == "no":
    d = load(a[1])
    if d["state"] != "pending": sys.exit("already " + d["state"])
    d["state"], d["result"] = "rejected", "the owner said no"; save(d); print("dropped")
elif a[0] == "yes":
    d = load(a[1])
    if d["state"] != "pending": sys.exit("already " + d["state"])
    d["state"] = "running"; save(d)
    subprocess.Popen([sys.executable, os.path.abspath(__file__), "_run", d["id"]], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("started")
elif a[0] == "_run":
    d = load(a[1])
    if d["kind"] == "send":
        r = subprocess.run([HC, "send", d["address"], d["text"]])
        d["state"], d["result"] = ("done", "sent") if r.returncode == 0 else ("failed", "TOOL WORDS THAT MUST NOT REACH THE PAGE")
    else: d["state"], d["result"] = "done", {"address": "t99"}
    save(d)
`, { mode: 0o755 });

const BIN = `${S}/approve`;
fs.writeFileSync(BIN, `#!/bin/sh
echo "$*" >> ${S}/calls
[ -e ${S}/hang ] && exec sleep 60
[ -e ${S}/refuse ] && { echo "TOOL WORDS THAT MUST NOT REACH THE PAGE" >&2; exit 1; }
HOME=${HOME} exec python3 ${real ?? FAKE} "$@"
`, { mode: 0o755 });

let nextId = 1793760000;
const newId = () => `${nextId++}-${Math.random().toString(16).slice(2, 6).padEnd(4, "0")}`;
const write = (d) => fs.writeFileSync(`${DRAFTS}/${d.id}.json`, JSON.stringify(d));
const read = (id) => JSON.parse(fs.readFileSync(`${DRAFTS}/${id}.json`, "utf8"));
const draftSend = (text, why = "You asked me to chase this.", where = "Studio / Gateway work") => {
  const id = newId();
  write({ id, kind: "send", why, state: "pending", created_ms: Date.now(), address: "t7", where, text });
  return id;
};
const draftAccess = (text, what = "build-box:browser", minutes = "30") => {
  const id = newId();
  write({ id, kind: "access", why: "To fill the form.", state: "pending", created_ms: Date.now(), address: what, name: minutes, text });
  return id;
};
const draftWorker = (task, name = "tidy-logs") => {
  const id = newId();
  write({ id, kind: "worker", why: "The logs are noisy.", state: "pending", created_ms: Date.now(), machine: "rig", folder: "/home/sam/rig/repos/studio", name, task });
  return id;
};
const HASH = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const draftResume = (text, action = "tailor") => {
  const id = newId();
  write({ id, kind: "resume", why: "For the Acme application.", state: "pending", created_ms: Date.now(), address: action,
    name: 'Tailored copy "Sam Lee — Acme FDE" from Sam Lee (v10), 3 change(s)', text, fields: { action, changes: 3 } });
  return id;
};
const draftStory = (text, card = "out/2026-11-05_run.png") => {
  const id = newId();
  write({ id, kind: "ig_post", why: "You ran 10k.", state: "pending", created_ms: Date.now(), address: "@sam.runs", name: card, sha256: HASH, bytes: 482113, text });
  return id;
};
const draftInbox = (kind, text, name = kind === "cal_create" ? "new" : "18c2f0a9b7d3e1aa") => {
  const id = newId();
  write({ id, kind, why: "From your inbox.", state: "pending", created_ms: Date.now(), address: "k@example.com", name, text, fields: { to: ["a@example.com"] } });
  return id;
};
/** The watcher, on demand: tests choose when the list catches up, as it lags the files in real life. */
const watch = (extra = {}) => {
  const drafts = fs.readdirSync(DRAFTS).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(`${DRAFTS}/${f}`, "utf8"))).filter((d) => d.state === "pending");
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ updated_ms: Date.now(), agents: 3, assistant: "t4", helper: "t16", drafts, machines: [], ready: [],
    needs: [{ address: "t1", status: "blocked", question: "SCREEN TAIL THAT IS NOT FOR THE PAGE" }], ...extra }));
  fs.renameSync(tmp, FILE);
};
const calls = () => { try { return fs.readFileSync(`${S}/calls`, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };
const yeses = (id) => calls().filter((c) => c === `yes ${id} --bg`).length;
const sent = () => { try { return fs.readFileSync(`${S}/sent`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const flag = (name, on = true) => { if (on) fs.writeFileSync(`${S}/${name}`, ""); else fs.rmSync(`${S}/${name}`, { force: true }); };
const clearDrafts = () => { for (const f of fs.readdirSync(DRAFTS)) fs.rmSync(`${DRAFTS}/${f}`); watch(); };

// ---- the app ------------------------------------------------------------------------------------------------------

// LUMBRIDGE_DEV_NODE (dev builds only): the device every client plays, for the gateway started next.
let devNode = {};
const script = (name, ...a) => spawnSync("bash", [`${repo}/scripts/${name}`, port, ...a], {
  env: { ...process.env, LUMBRIDGE_MACHINE: "desk", LUMBRIDGE_ASSISTANT_NODES: "assistant-phone,desk,build-box", LUMBRIDGE_NEEDS_FILE: FILE, LUMBRIDGE_APPROVE_CMD: BIN, ...devNode },
  encoding: "utf8",
});
// Once, however the run ends: pass, fail, crash or Ctrl-C. Chrome is Playwright's to end.
const stopAll = stopOnExit(() => { script("dev-fixture.sh", "stop"); script("dev.sh", "stop"); fs.rmSync(S, { recursive: true, force: true }); });

script("dev.sh", "stop");
const up = script("dev.sh");
if (up.status !== 0) { console.error(up.stdout, up.stderr); process.exit(1); }
const base = `http://127.0.0.1:${port}/`;
for (let i = 0; i < 80; i++) { if (await fetch(`${base}healthz`).catch(() => null)) break; await sleep(100); }
const fixture = script("dev-fixture.sh");
if (fixture.status !== 0) { console.error(fixture.stdout, fixture.stderr); stopAll(); process.exit(1); }
const t = target(port);
/** The same gateway again, as `node` or as one of the owner's devices. The core and the fixture stay up. */
const restartGateway = async (node) => {
  devNode = node ? { LUMBRIDGE_DEV_NODE: node } : {};
  try { process.kill(Number(fs.readFileSync(`/run/user/${process.getuid()}/k${port}/gw.pid`, "utf8").trim())); } catch {}
  for (let i = 0; i < 80 && await fetch(`${base}healthz`).then(() => true, () => false); i++) await sleep(100);
  const r = script("dev.sh");
  if (r.status !== 0) throw new Error(`dev.sh: ${r.stdout}${r.stderr}`);
  for (let i = 0; i < 80; i++) { if (await fetch(`${base}healthz`).catch(() => null)) break; await sleep(100); }
};
const A = addresses(port);
const hc = (...a) => execFileSync("lbc", a, { env: scratchEnv(port), encoding: "utf8" });
const api = (p, method = "GET", body, tok = t.token) => fetch(new URL(p, base), { method,
  headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

// Chrome's own notification centre, never the desktop's: these are fakes, and this may be running on someone's screens.
const browser = await chromium.launch({ channel: "chrome", headless: false, args: ["--disable-features=NativeNotifications"] });
async function open({ profile = "iphone", dark = true, hash = "#/assistant", init, clock = false, grant = false } = {}) {
  const ctx = await browser.newContext({ ...PROFILES[profile], colorScheme: dark ? "dark" : "light", ...(grant ? { permissions: ["notifications"] } : {}) });
  await ctx.addInitScript((tok) => {
    try { localStorage.setItem("lumbridge.token", tok); } catch {}
    // The assistant's mic and speech aren't this test's business.
    window.__badges = [];
  }, t.token);
  if (init) await ctx.addInitScript(init);
  const p = await ctx.newPage();
  p.problems = [];
  p.on("pageerror", (e) => p.problems.push(e.message));
  p.apiCalls = [];
  p.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/assistant/needs") || u.pathname === "/api/push/focus") p.apiCalls.push({ path: u.pathname, body: r.postData(), at: Date.now() }); });
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  if (clock) await p.clock.install();
  await p.goto(t.base + hash);
  return p;
}
const close = async (p) => { await p.context().close(); };
const noScroll = async (p, name) => {
  const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${name}: no sideways scroll`, over <= 0, String(over));
};
const shot = async (p, name) => { if (shots) { await p.waitForTimeout(250); await p.screenshot({ path: `${shots}/${name}.png` }); } };
const card = (p, id) => p.locator(`.ppd-card[data-id="${id}"]`);
/** Read all, on a card that has it. */
const readAll = async (p, id) => { const t = card(p, id).locator(".ppd-toggle"); if ((await t.getAttribute("aria-expanded")) === "false") await t.click(); };
const isArmed = (approve) => approve.evaluate((b) => b.classList.contains("armed"));
/** Armed however it stands: an outward card the owner hasn't read opens on the first tap. */
const arm = async (approve) => { await approve.click(); if (!(await isArmed(approve))) await approve.click(); };
const STUB_BADGE = () => {
  Navigator.prototype.setAppBadge = async function (n) { window.__badges.push(n); };
  Navigator.prototype.clearAppBadge = async function () { window.__badges.push("clear"); };
};
const lastBadge = (p) => p.evaluate(() => window.__badges.at(-1));
const needsNow = () => JSON.parse(hc("ls", "--json")).terminals.filter((x) => x.state === "live" && ["blocked", "error"].includes(typeof x.status === "string" ? x.status : x.status?.state)).length;

const LONG = `Please re-run the gateway tests and tell me which of them failed.

Then look at this, which must stay exactly as written:
  <img src=x onerror="window.__xss=1"> & <b>not bold</b> "quotes" 'and' \`ticks\`
\tan indented line, and a very long one: ${"word ".repeat(60)}
${"https://example.com/".padEnd(160, "x")}
Last line.`;

try {
  // ---- API --------------------------------------------------------------------------------------------------------
  {
    fs.rmSync(FILE, { force: true });
    const r = await (await api("/api/assistant/needs")).json();
    check("no file yet reads as nothing pending", r.drafts.length === 0 && r.stale === false, JSON.stringify(r));
    check("no token: refused", (await api("/api/assistant/needs", "GET", undefined, "")).status === 401);
    check("no token: approve refused", (await api("/api/assistant/drafts/1-aaaa/approve", "POST", { digest: "x" }, "")).status === 401);
    check("no token: reject refused", (await api("/api/assistant/drafts/1-aaaa/reject", "POST", {}, "")).status === 401);
    check("a bad id is refused", (await api("/api/assistant/drafts/nope/approve", "POST", { digest: "x" })).status === 400);
    check("nothing ran", calls().length === 0, calls().join("; "));
  }

  // ---- nothing waiting: the tab is as it was --------------------------------------------------------------------------
  {
    watch();
    const p = await open({});
    await p.waitForSelector(".assistant");
    await sleep(600);
    check("nothing waiting: no section", !(await p.locator(".ppd").isVisible()));
    check("nothing waiting: the assistant's grid is untouched", !(await p.locator(".assistant").evaluate((e) => e.classList.contains("has-drafts"))));
    check("nothing waiting: no badge", !(await p.locator(".tab-assistant .badge").isVisible()));
    check("nothing waiting: no page errors", p.problems.length === 0, p.problems.join("; "));
    await shot(p, "nothing-waiting-iphone-dark");
    await close(p);
  }

  // ---- what the owner sees -------------------------------------------------------------------------------------------------
  const a1 = draftSend(LONG);
  const w1 = draftWorker("Find why the push watcher logs twice per reconnect, fix it, and open a PR.");
  watch();
  {
    const r = await (await api("/api/assistant/needs")).json();
    check("the API gives drafts and not agents' screens", !JSON.stringify(r).includes("SCREEN TAIL") && r.drafts.length === 2);

    const p = await open({ init: STUB_BADGE });
    await p.waitForSelector(".ppd-card");
    await p.waitForFunction(() => document.querySelector(".tab-assistant .badge")?.textContent === "2");
    check("the assistant's tab shows the count", true);
    check("the tab says so to a screen reader", /2 waiting/.test(await p.locator(".tab-assistant").getAttribute("aria-label")));
    check("a long one starts as its first lines", (await card(p, a1).locator(".ppd-text").evaluate((e) => e.textContent)) === LONG.split("\n").slice(0, 3).join("\n"));
    check("and says there's more", /^\+4 more lines · [\d,]+ characters$/.test(await card(p, a1).locator(".ppd-count").innerText()), await card(p, a1).locator(".ppd-count").innerText());
    await readAll(p, a1);
    check("the exact text, in full, as text", (await card(p, a1).locator(".ppd-text").evaluate((e) => e.textContent)) === LONG);
    check("nothing in it ran as HTML", (await p.evaluate(() => window.__xss)) === undefined && (await card(p, a1).locator(".ppd-text img, .ppd-text b").count()) === 0);
    check("says who it's to", (await card(p, a1).locator(".ppd-to").innerText()) === "To Studio / Gateway work");
    check("says where that is", (await card(p, a1).locator(".ppd-detail").innerText()) === "t7");
    check("says why", /You asked me/.test(await card(p, a1).locator(".ppd-why").innerText()));
    check("a worker says what would start", /Start worker tidy-logs on rig/.test(await card(p, w1).locator(".ppd-to").innerText()) && /branch assistant\/tidy-logs/.test(await card(p, w1).locator(".ppd-detail").innerText()));
    check("buttons are full size", await p.evaluate(() => [...document.querySelectorAll(".ppd-actions button")].every((b) => { const r = b.getBoundingClientRect(), min = (matchMedia("(pointer: fine)").matches && innerWidth >= 900 ? 36 : 44); return r.height >= min && r.width >= min; })));
    const order = await card(p, a1).evaluate((c) => c.querySelector(".ppd-text").compareDocumentPosition(c.querySelector(".ppd-approve")) & Node.DOCUMENT_POSITION_FOLLOWING);
    check("Approve comes after the words", !!order);
    const expected = needsNow() + 2;
    await p.waitForFunction((n) => window.__badges.at(-1) === n, expected, { timeout: 8000 }).then(() => check("the app icon counts agents and drafts", true), async () => check("the app icon counts agents and drafts", false, `${await lastBadge(p)} wanted ${expected}`));
    await noScroll(p, "iphone");

    // Two taps.
    const approve = card(p, a1).locator(".ppd-approve");
    await approve.scrollIntoViewIfNeeded();
    await approve.click();
    check("the first tap only arms it", (await approve.innerText()) === "Tap again to send" && yeses(a1) === 0);
    await shot(p, "armed-iphone-dark");
    await sleep(3300);
    check("arming wears off", (await approve.innerText()) === "Approve");
    check("and nothing ran", calls().length === 0, calls().join("; "));
    await close(p);
  }

  // Screenshots in every shape, with the list as it would look.
  if (shots) {
    for (const profile of ["iphone", "pixel", "desktop"]) for (const dark of [true, false]) {
      const p = await open({ profile, dark });
      await p.waitForSelector(".ppd-card");
      await shot(p, `list-${profile}-${dark ? "dark" : "light"}`);
      await noScroll(p, `${profile} ${dark ? "dark" : "light"}`);
      const fits = await p.evaluate(() => { const b = document.querySelector(".ppd"), o = document.querySelector(".pp-composer"); return b.getBoundingClientRect().bottom <= o.getBoundingClientRect().top + 1 || innerWidth >= 880; });
      check(`${profile}: the box to type in stays on screen`, fits);
      await arm(p.locator(".ppd-approve").first());
      await p.locator(".ppd-approve").first().scrollIntoViewIfNeeded();
      await shot(p, `armed-${profile}-${dark ? "dark" : "light"}`);
      await close(p);
    }
  }

  // ---- approving -----------------------------------------------------------------------------------------------------
  {
    const p = await open({ init: STUB_BADGE });
    await p.waitForSelector(".ppd-card");
    const approve = card(p, a1).locator(".ppd-approve");
    await readAll(p, a1);
    await approve.scrollIntoViewIfNeeded();
    await approve.dblclick();
    check("two taps approve", await until(() => yeses(a1) === 1), calls().join("; "));
    check("it read the draft before acting", calls().indexOf(`show ${a1}`) < calls().indexOf(`yes ${a1} --bg`) && calls().includes(`show ${a1}`));
    check("says it's on its way", await until(async () => /Approved\. It goes/.test(await card(p, a1).locator(".ppd-note").innerText().catch(() => ""))));
    await shot(p, "approved-iphone-dark");
    check("the buttons are gone, so it can't be pressed again", (await card(p, a1).locator("button:not(.ppd-toggle)").count()) === 0);
    check("says when it went", await until(async () => (await card(p, a1).locator(".ppd-note").innerText().catch(() => "")) === "Sent.", 12000));
    await shot(p, "sent-iphone-dark");
    check("exactly what the owner read went, to where it said", JSON.stringify(sent().at(-1)) === JSON.stringify(["send", "t7", LONG]), JSON.stringify(sent().at(-1)));
    check("the card goes", await until(() => card(p, a1).count().then((n) => n === 0), 6000));
    check("the list doesn't bring it back before the watcher catches up", (await card(p, a1).count()) === 0);

    // Retrying can't send it twice, whatever the list says.
    const digest = (await (await api("/api/assistant/needs")).json()).drafts.find((d) => d.id === w1)?.digest;
    const again = await api(`/api/assistant/drafts/${a1}/approve`, "POST", { digest: "whatever" });
    const said = await again.json();
    check("a repeat is answered, and runs nothing", again.status === 200 && said.repeat === true && yeses(a1) === 1, JSON.stringify(said));
    check("and went once", sent().filter((s) => s[2] === LONG).length === 1);
    watch();
    check("a draft that isn't listed is refused", (await api(`/api/assistant/drafts/1793799999-abcd/approve`, "POST", { digest })).status === 404);
    await close(p);
  }

  // A fresh gateway, knowing nothing, against files that say it already went.
  {
    const id = draftSend("Already went, says the file.");
    watch();
    const { digest } = (await (await api("/api/assistant/needs")).json()).drafts.find((d) => d.id === id);
    write({ ...read(id), state: "running" });
    const r = await api(`/api/assistant/drafts/${id}/approve`, "POST", { digest });
    check("the files beat the list: not sent again", r.status === 409 && (await r.json()).error === "already_handled" && yeses(id) === 0);
    clearDrafts();
  }

  // Presses at the same moment, from two devices.
  {
    const id = draftSend("Only once, please.");
    watch();
    const { digest } = (await (await api("/api/assistant/needs")).json()).drafts.find((d) => d.id === id);
    const all = await Promise.all([1, 2, 3, 4].map(() => api(`/api/assistant/drafts/${id}/approve`, "POST", { digest })));
    check("four presses at once all succeed", all.every((r) => r.status === 200), all.map((r) => r.status).join(","));
    check("and run it once", yeses(id) === 1, String(yeses(id)));
    await until(() => sent().some((s) => s[2] === "Only once, please."));
    await sleep(1500);
    check("and it goes once", sent().filter((s) => s[2] === "Only once, please.").length === 1);
    clearDrafts();
  }

  // ---- short cards: a preview, Read all, and Approve from there ---------------------------------------------------------
  {
    const BODY = ["## Why", ...Array.from({ length: 140 }, (_, i) => `Line ${i + 1}: ${"the gateway should say why it refused, ".repeat(1 + (i % 2))}`.trim())].join("\n");
    const iss = newId();
    write({ id: iss, kind: "issue", why: "You asked for this twice.", state: "pending", created_ms: Date.now(), address: "acme/app", name: "Say why a draft was refused", text: BODY });
    const short = draftWorker("Tidy the logs.", "short-one");
    const MAILTEXT = "To: Ana <a@example.com>\nSubject: Re: Lunch\n\nHi Ana,\n\nThursday works. I'll book somewhere near the office.\n\n  Sam";
    const mr = draftInbox("mail_reply", MAILTEXT);
    const LONGSEND = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: do the thing.`).join("\n");
    const ls = draftSend(LONGSEND, "To get it moving.");
    watch();
    for (const dark of [true, false]) {
      const p = await open({ dark });
      await card(p, iss).waitFor();
      const c = card(p, iss), text = c.locator(".ppd-text"), toggle = c.locator(".ppd-toggle"), approve = c.locator(".ppd-approve");
      const mode = dark ? "dark" : "light";
      const preview = BODY.split("\n").slice(0, 3).join("\n");
      check(`${mode}: a long issue starts short`, (await text.evaluate((e) => e.textContent)) === preview);
      check(`${mode}: says how much more`, (await c.locator(".ppd-count").innerText()) === `+138 more lines · ${BODY.length.toLocaleString("en-US")} characters`, await c.locator(".ppd-count").innerText());
      check(`${mode}: heading, title and why are there`, (await c.locator(".ppd-to").innerText()) === "File a factory issue on acme/app" && (await c.locator(".ppd-title").innerText()) === "Say why a draft was refused" && /twice/.test(await c.locator(".ppd-why").innerText()));
      check(`${mode}: Read all is a button that says what it controls`, (await toggle.evaluate((b) => b.tagName)) === "BUTTON" && (await toggle.innerText()) === "Read all"
        && (await toggle.getAttribute("aria-expanded")) === "false" && (await toggle.getAttribute("aria-controls")) === (await text.getAttribute("id")));
      const gap = await c.evaluate((el) => {
        const b = (s) => el.querySelector(s).getBoundingClientRect();
        const above = Math.max(b(".ppd-text").bottom, b(".ppd-toggle").bottom), below = Math.min(b(".ppd-approve").top, b(".ppd-reject").top);
        return below - above;
      });
      check(`${mode}: Approve and Reject keep 12 px from the words and Read all`, gap >= 12, String(gap));
      await noScroll(p, `short cards ${mode}`);
      await c.scrollIntoViewIfNeeded();
      await shot(p, `compact-collapsed-iphone-${mode}`);
      await toggle.click();
      check(`${mode}: Read all shows every word`, (await text.evaluate((e) => e.textContent)) === BODY && (await toggle.innerText()) === "Show less" && (await toggle.getAttribute("aria-expanded")) === "true" && !(await c.locator(".ppd-count").isVisible()));
      await c.scrollIntoViewIfNeeded();
      await shot(p, `compact-expanded-iphone-${mode}`);
      await toggle.click();
      check(`${mode}: Show less closes it`, (await text.evaluate((e) => e.textContent)) === preview && (await toggle.getAttribute("aria-expanded")) === "false");
      await text.click();
      check(`${mode}: a tap on the words opens it`, (await toggle.getAttribute("aria-expanded")) === "true" && !(await isArmed(approve)));
      await text.click({ position: { x: 20, y: 10 } });
      check(`${mode}: and another closes it`, (await toggle.getAttribute("aria-expanded")) === "false");
      await c.locator(".ppd-to").click();
      check(`${mode}: a tap on the heading opens it`, (await toggle.getAttribute("aria-expanded")) === "true");
      await c.locator(".ppd-to").click();
      await toggle.focus();
      await p.keyboard.press("Enter");
      check(`${mode}: the keyboard opens it`, (await toggle.getAttribute("aria-expanded")) === "true");
      await p.keyboard.press(" ");
      check(`${mode}: and closes it`, (await toggle.getAttribute("aria-expanded")) === "false");
      check(`${mode}: a short draft has no Read all`, (await card(p, short).locator(".ppd-toggle, .ppd-more").count()) === 0 && (await card(p, short).locator(".ppd-text").evaluate((e) => e.textContent)) === "Tidy the logs.");

      // Approve from short: arms, and doesn't open it.
      await approve.scrollIntoViewIfNeeded();
      await approve.click();
      check(`${mode}: the first tap arms it, still short`, (await approve.innerText()) === "Tap again to file" && await isArmed(approve) && (await toggle.getAttribute("aria-expanded")) === "false" && yeses(iss) === 0);
      await shot(p, `compact-armed-iphone-${mode}`);
      if (!dark && !real) {
        await approve.click();
        check("two taps approve it while it's short", await until(() => yeses(iss) === 1), calls().join("; "));
        check("and it's filed", await until(async () => (await c.locator(".ppd-note").innerText().catch(() => "")) === "Filed.", 12000));
      } else {
        await sleep(3300);
        check("arming wears off", !(await isArmed(approve)));
      }

      // An email reply: the first tap opens it, and only then can it arm.
      const m = card(p, mr), ma = m.locator(".ppd-approve");
      if (dark) {
        check("an email reply starts short", (await m.locator(".ppd-toggle").getAttribute("aria-expanded")) === "false");
        await ma.scrollIntoViewIfNeeded();
        await ma.click();
        check("an unread email reply: the first tap opens it, not arms it", !(await isArmed(ma)) && (await ma.innerText()) === "Send"
          && (await m.locator(".ppd-text").evaluate((e) => e.textContent)) === MAILTEXT && (await m.locator(".ppd-note").innerText()) === "Read it, then tap Send");
        await shot(p, "compact-read-first-iphone-dark");
        await ma.click();
        check("then it arms", (await ma.innerText()) === "Tap again to send" && await isArmed(ma) && yeses(mr) === 0);
        await m.locator(".ppd-toggle").click();
        await sleep(3300);
        await ma.click();
        check("read once is enough: closed again, it arms", await isArmed(ma) && (await m.locator(".ppd-toggle").getAttribute("aria-expanded")) === "false");
        await m.locator(".ppd-reject").click();
        check("and nothing was sent", await until(() => calls().includes(`no ${mr}`)) && yeses(mr) === 0);
      }
      check(`${mode}: no page errors`, p.problems.length === 0, p.problems.join("; "));
      await close(p);
    }

    // Changed words: the card comes back short, unread, with its note.
    const p = await open({});
    await card(p, ls).waitFor();
    await readAll(p, ls);
    const approve = card(p, ls).locator(".ppd-approve");
    await approve.scrollIntoViewIfNeeded();
    write({ ...read(ls), text: `${LONGSEND}\nStep 13: and delete everything.` });
    await approve.dblclick();
    check("changed: refused", await until(async () => /has changed/.test(await card(p, ls).locator(".ppd-note").innerText())) && yeses(ls) === 0);
    watch();
    check("changed: the card comes back short", await until(async () => (await card(p, ls).locator(".ppd-toggle").getAttribute("aria-expanded").catch(() => "")) === "false"
      && /\+10 more lines/.test(await card(p, ls).locator(".ppd-count").innerText()), 35000));
    check("changed: with its note", /has changed/.test(await card(p, ls).locator(".ppd-note").innerText()));
    await card(p, ls).scrollIntoViewIfNeeded();
    await shot(p, "compact-changed-iphone-dark");
    await card(p, ls).locator(".ppd-approve").click();
    check("changed: unread again, so the first tap opens it", !(await isArmed(card(p, ls).locator(".ppd-approve"))) && /delete everything/.test(await card(p, ls).locator(".ppd-text").innerText()));
    await close(p);
    clearDrafts();
  }

  // ---- rejecting ---------------------------------------------------------------------------------------------------
  {
    const id = draftWorker("Something he won't want.", "nope-worker");
    watch();
    const p = await open({});
    await card(p, id).waitFor();
    await card(p, id).locator(".ppd-reject").click();
    check("reject runs no", await until(() => calls().includes(`no ${id}`)), calls().join("; "));
    check("says so", await until(async () => /Dropped/.test(await card(p, id).locator(".ppd-note").innerText().catch(() => ""))));
    check("nothing started", yeses(id) === 0 && read(id).state === "rejected");
    check("the card goes", await until(() => card(p, id).count().then((n) => n === 0), 6000));
    await close(p);
    clearDrafts();
  }

  // ---- a worker -------------------------------------------------------------------------------------------------------
  {
    const id = draftWorker("Start me.", "start-me");
    watch();
    const p = await open({});
    await card(p, id).waitFor();
    const approve = card(p, id).locator(".ppd-approve");
    await approve.click();
    check("a worker's arming says start", (await approve.innerText()) === "Tap again to start");
    await approve.click();
    check("a worker approves", await until(() => yeses(id) === 1));
    // The real tool would try to start one through the stand-in hc and fail, which is its own honest answer.
    check("says how it went", await until(async () => /Worker started|didn't go through/.test(await card(p, id).locator(".ppd-note").innerText().catch(() => "")), 12000));
    await close(p);
    clearDrafts();
  }

  // ---- a factory issue ---------------------------------------------------------------------------------------------------
  {
    const id = newId();
    const title = "Thoughts lose a word\u202e";
    const body = "Say three words, stop.\nOnly two arrive.";
    write({ id, kind: "issue", why: "He said it twice today.", state: "pending", created_ms: Date.now(), address: "acme/app", name: title, text: body });
    watch();
    const p = await open({});
    await card(p, id).waitFor();
    check("an issue says where it'd be filed", (await card(p, id).locator(".ppd-to").innerText()) === "File a factory issue on acme/app");
    check("its title is there in full, nothing hidden", (await card(p, id).locator(".ppd-title").evaluate((e) => e.textContent)) === "Thoughts lose a word[U+202E]");
    check("and its body", (await card(p, id).locator(".ppd-text").evaluate((e) => e.textContent)) === body);
    const above = await card(p, id).evaluate((c) => [".ppd-title", ".ppd-text"].every((s) => c.querySelector(s).compareDocumentPosition(c.querySelector(".ppd-actions")) & Node.DOCUMENT_POSITION_FOLLOWING));
    check("both come before the buttons", above);
    const approve = card(p, id).locator(".ppd-approve");
    check("Approve names the repo and the title", (await approve.getAttribute("aria-label")) === "Approve: file a factory issue on acme/app, titled Thoughts lose a word[U+202E]");
    await shot(p, "issue-iphone-dark");
    await approve.click();
    check("an issue's arming says file", (await approve.innerText()) === "Tap again to file");
    // The real tool would file it on GitHub, so against it this stops at arming.
    if (!real) {
      await approve.click();
      check("an issue approves", await until(() => yeses(id) === 1));
      check("says it's filed", await until(async () => (await card(p, id).locator(".ppd-note").innerText().catch(() => "")) === "Filed.", 12000));
    }
    await close(p);
    clearDrafts();
  }

  // ---- a resume change, a Story, an email reply, a calendar change ------------------------------------------------------
  {
    const RESUME = [
      'Tailored copy "Sam Lee — Acme FDE" from Sam Lee (v10)',
      ...Array.from({ length: 30 }, (_, i) => `CHANGE experience[${i}].summary\n  was: Built the thing number ${i}.\n  now: Built and shipped the thing number ${i}, with customers.`),
      `ADD skills: ${"Rust, TypeScript, Postgres, ".repeat(12)}`,
      `REMOVE ${"https://example.com/".padEnd(140, "x")}`,
      "Last change.",
    ].join("\n");
    const MAIL = "Account: k@example.com\nTo: Ana <a@example.com>\nCc: b@example.com\nSubject: Re: Lunch\n\nHi Ana,\n\nThursday works.\n\n  Sam";
    const CAL = "Account: k@example.com\nEvent: Standup, Thu 6 Nov 09:30-09:45\nChange: start 10:00\nGoogle emails: a@example.com";
    const r1 = draftResume(RESUME), g1 = draftStory("Morning run, 10k."), m1 = draftInbox("mail_reply", MAIL), c1 = draftInbox("cal_change", CAL);
    const u1 = newId();
    write({ id: u1, kind: "mail_forward", why: "?", state: "pending", created_ms: Date.now(), address: "k@example.com", name: "x", text: "UNKNOWN KIND TEXT" });
    const bad = draftStory("Bad card.", "../secret.png");
    watch();
    const listed = (await (await api("/api/assistant/needs")).json()).drafts;
    check("new kinds: listed, and the unknown and malformed ones aren't", JSON.stringify(listed.map((d) => d.id).sort()) === JSON.stringify([r1, g1, m1, c1].sort()), JSON.stringify(listed.map((d) => [d.id, d.kind])));
    check("new kinds: fields never reach the page", listed.every((d) => !("fields" in d)));
    const digestOf = (id) => listed.find((d) => d.id === id).digest;
    for (const profile of ["iphone", "pixel", "desktop"]) {
      const p = await open({ profile });
      await card(p, c1).waitFor();
      check(`${profile}: an unknown or malformed kind never renders`, (await card(p, u1).count()) === 0 && (await card(p, bad).count()) === 0 && !/UNKNOWN KIND TEXT|Bad card/.test(await p.locator(".ppd").innerText()));
      // A resume change: its first lines, then all of it, in its own scroll.
      const rt = card(p, r1).locator(".ppd-text");
      check(`${profile}: a resume change starts short, not in a scroll box`, (await rt.evaluate((e) => getComputedStyle(e).overflowY)) === "visible" && (await rt.evaluate((e) => e.textContent)) === RESUME.split("\n").slice(0, 3).join("\n"));
      await readAll(p, r1);
      await readAll(p, m1);
      check(`${profile}: a resume says what changes`, (await card(p, r1).locator(".ppd-to").innerText()) === 'Resume: Tailored copy "Sam Lee — Acme FDE" from Sam Lee (v10), 3 change(s)' && (await card(p, r1).locator(".ppd-detail").innerText()) === "Tailor a copy");
      check(`${profile}: every word of the resume change, as text`, (await rt.evaluate((e) => e.textContent)) === RESUME);
      const box = await rt.evaluate((e) => ({ y: getComputedStyle(e).overflowY, ws: getComputedStyle(e).whiteSpace, sh: e.scrollHeight, ch: e.clientHeight, sw: e.scrollWidth, cw: e.clientWidth }));
      check(`${profile}: the resume change scrolls in its own box`, box.y === "auto" && box.sh > box.ch && box.ws === "pre-wrap", JSON.stringify(box));
      check(`${profile}: and nothing is cut sideways`, box.sw <= box.cw, JSON.stringify(box));
      const end = await rt.evaluate((e) => { e.scrollTop = e.scrollHeight; return e.scrollTop + e.clientHeight >= e.scrollHeight - 1; });
      check(`${profile}: it scrolls to the last change`, end);
      // A Story: the account, the card and its hash.
      check(`${profile}: a Story names the account`, (await card(p, g1).locator(".ppd-to").innerText()) === "Post a Story on @sam.runs");
      const gd = card(p, g1).locator(".ppd-detail");
      check(`${profile}: and the card and hash, plainly`, (await gd.innerText()) === `out/2026-11-05_run.png · sha256 ${HASH.slice(0, 16)}…` && await gd.evaluate((e) => e.classList.contains("ppd-title")) && await gd.isVisible());
      check(`${profile}: and its words`, (await card(p, g1).locator(".ppd-text").evaluate((e) => e.textContent)) === "Morning run, 10k.");
      // An email reply: Send, and the whole of what happens, line breaks kept.
      const mt = card(p, m1).locator(".ppd-text");
      check(`${profile}: an email reply says whose account`, (await card(p, m1).locator(".ppd-to").innerText()) === "Email reply · k@example.com" && (await card(p, m1).locator(".ppd-detail").innerText()) === "reply in thread, recipients from its headers");
      check(`${profile}: its button says Send`, (await card(p, m1).locator(".ppd-approve").innerText()) === "Send");
      const mb = await mt.evaluate((e) => ({ t: e.textContent, i: e.innerText, ws: getComputedStyle(e).whiteSpace, y: getComputedStyle(e).overflowY, sh: e.scrollHeight, ch: e.clientHeight }));
      check(`${profile}: the email in full, line breaks kept, nothing cut`, mb.t === MAIL && mb.i.split("\n").length >= 10 && mb.ws === "pre-wrap" && mb.y === "visible" && mb.sh <= mb.ch + 1, JSON.stringify(mb));
      check(`${profile}: a calendar change says Approve`, (await card(p, c1).locator(".ppd-approve").innerText()) === "Approve" && (await card(p, c1).locator(".ppd-to").innerText()) === "Calendar · k@example.com" && (await card(p, c1).locator(".ppd-detail").innerText()) === "change an event");
      check(`${profile}: buttons full size`, await p.evaluate(() => [...document.querySelectorAll(".ppd-actions button")].every((b) => { const r = b.getBoundingClientRect(), min = (matchMedia("(pointer: fine)").matches && innerWidth >= 900 ? 36 : 44); return r.height >= min && r.width >= min; })));
      await noScroll(p, `new kinds ${profile}`);
      await card(p, r1).scrollIntoViewIfNeeded();
      await shot(p, `resume-${profile}-dark`);
      await card(p, g1).scrollIntoViewIfNeeded();
      await shot(p, `story-${profile}-dark`);
      await card(p, m1).scrollIntoViewIfNeeded();
      await shot(p, `mail-${profile}-dark`);
      check(`${profile}: no page errors`, p.problems.length === 0, p.problems.join("; "));
      await close(p);
    }

    // Approving each from one of the owner's devices: the right id, with the digest of the words the owner read. The real tool would act
    // on Reactive Resume, Instagram, Gmail or Calendar, so against it this stops at arming.
    const p = await open({});
    await card(p, c1).waitFor();
    const sentDigests = {};
    p.on("request", (r) => { const m = new URL(r.url()).pathname.match(/^\/api\/assistant\/drafts\/([^/]+)\/approve$/); if (m) sentDigests[m[1]] = JSON.parse(r.postData()).digest; });
    for (const [id, armed, started, done] of [
      [r1, "Tap again to approve", "Approved. Making the change in Reactive Resume.", "Done in Reactive Resume."],
      [g1, "Tap again to post publicly", "Approved. Posting through the Pixel; it can take a few minutes.", "Posted."],
      [m1, "Tap again to send", "Approved. Sending from Gmail.", "Sent."],
      [c1, "Tap again to approve", "Approved. Changing the calendar.", "Done in the calendar."],
    ]) {
      const kind = read(id).kind;
      const approve = card(p, id).locator(".ppd-approve");
      await approve.scrollIntoViewIfNeeded();
      if (id === m1) {
        await approve.click();
        check(`${kind}: the first tap on an unread reply opens it instead`, !(await isArmed(approve)) && (await card(p, id).locator(".ppd-text").evaluate((e) => e.textContent)) === MAIL
          && (await card(p, id).locator(".ppd-note").innerText()) === "Read it, then tap Send");
      }
      await approve.click();
      check(`${kind}: the first tap arms it`, (await approve.innerText()) === armed && yeses(id) === 0, await approve.innerText());
      if (real) continue;
      await approve.click();
      check(`${kind}: two taps reach the approve command with its id`, await until(() => yeses(id) === 1), calls().join("; "));
      check(`${kind}: with the digest of what the owner read`, sentDigests[id] === digestOf(id), `${sentDigests[id]} vs ${digestOf(id)}`);
      const note = card(p, id).locator(".ppd-note");
      check(`${kind}: says it started`, await until(async () => [started, done].includes(await note.innerText().catch(() => ""))), await note.innerText().catch(() => ""));
      check(`${kind}: says when it's done`, await until(async () => (await note.innerText().catch(() => "")) === done, 12000));
    }
    check("new kinds: nothing unknown or malformed ran", !calls().some((c) => c.includes(u1) || c.includes(bad)), calls().join("; "));
    await close(p);
    clearDrafts();
  }

  // ---- when a send fails --------------------------------------------------------------------------------------------
  {
    flag("send-fails");
    const id = draftSend("This one will fail.");
    watch();
    const p = await open({});
    await card(p, id).waitFor();
    const approve = card(p, id).locator(".ppd-approve");
    await approve.dblclick();
    check("says it may not have gone", await until(async () => /didn't go through/.test(await card(p, id).locator(".ppd-note").innerText().catch(() => "")), 12000));
    check("not the tool's words", !/TOOL WORDS/.test(await p.locator(".ppd").innerText()));
    await shot(p, "failed-iphone-dark");
    await card(p, id).locator("button", { hasText: "OK" }).click();
    check("OK clears it", await until(() => card(p, id).count().then((n) => n === 0)));
    flag("send-fails", false);
    await close(p);
    clearDrafts();
  }

  // ---- things in the way -----------------------------------------------------------------------------------------------
  {
    const id = draftSend("Careful with this one.");
    watch();
    const p = await open({});
    await card(p, id).waitFor();
    const note = card(p, id).locator(".ppd-note");
    const approve = card(p, id).locator(".ppd-approve");
    const before = calls().length;

    // Offline.
    await p.context().setOffline(true);
    await approve.click();
    check("offline: says so and doesn't arm", /offline/.test(await note.innerText()) && !(await approve.evaluate((b) => b.classList.contains("armed"))));
    await shot(p, "offline-iphone-dark");
    await card(p, id).locator(".ppd-reject").click();
    check("offline: nothing ran", calls().length === before);
    await p.context().setOffline(false);

    // The answer never comes back.
    await p.route("**/approve", (r) => r.abort());
    await approve.dblclick();
    check("no answer: says it may not have gone and can be retried", await until(async () => /Trying again can't send it twice/.test(await note.innerText())));
    check("no answer: the buttons work again", await approve.isEnabled());
    await p.unroute("**/approve");

    // The tool hangs.
    flag("hang");
    await approve.dblclick();
    check("buttons wait while it's asking", await card(p, id).locator(".ppd-reject").isDisabled());
    check("a hung tool: a clear answer in time", await until(async () => /No answer in time/.test(await note.innerText()), 14000), await note.innerText());
    await shot(p, "hung-iphone-dark");
    flag("hang", false);
    check("a hung tool: nothing went", yeses(id) === 0);

    // Refused by the tool: a stable message, never its words.
    flag("refuse");
    await approve.dblclick();
    check("a tool failure: our words, not its", await until(async () => /That didn't work/.test(await note.innerText())) && !/TOOL WORDS/.test(await note.innerText()), await note.innerText());
    flag("refuse", false);

    // The words on disk changed under the list.
    write({ ...read(id), text: "Careful with this one. And delete everything." });
    await approve.dblclick();
    check("words the owner didn't read don't go", await until(async () => /has changed/.test(await note.innerText())) && yeses(id) === 0, await note.innerText());
    watch();
    check("the card shows the new words", await until(async () => /delete everything/.test(await card(p, id).locator(".ppd-text").innerText()), 35000));
    check("and says why it's back", /has changed/.test(await card(p, id).locator(".ppd-note").innerText()));
    await shot(p, "changed-iphone-dark");

    // Handled elsewhere (the desktop app) while it's on screen.
    write({ ...read(id), state: "done" });
    await card(p, id).locator(".ppd-approve").dblclick();
    check("handled elsewhere: says so and goes", await until(async () => /already handled/.test(await card(p, id).locator(".ppd-note").innerText().catch(() => ""))) && yeses(id) === 0);
    check("handled elsewhere: nothing went", yeses(id) === 0);
    await close(p);
    clearDrafts();
  }

  // Hidden characters are shown, not hidden.
  {
    const hide = "run this\u001b[2J\rthen‮this";
    const id = draftSend(hide);
    watch();
    const p = await open({});
    await card(p, id).waitFor();
    check("what would act unseen is shown", /\[U\+001B\]\[2J\[U\+000D\]then\[U\+202E\]this/.test(await card(p, id).locator(".ppd-text").innerText()), await card(p, id).locator(".ppd-text").innerText());
    await close(p);
    clearDrafts();
  }

  // A quiet watcher.
  {
    const id = draftSend("From a list nobody's keeping.");
    watch({ updated_ms: Date.now() - 600_000 });
    const p = await open({});
    await card(p, id).waitFor();
    check("a quiet watcher says the list may be behind", /may be behind/.test(await p.locator(".ppd-warn").innerText()));
    await shot(p, "stale-iphone-dark");
    await close(p);
    watch({ updated_ms: Date.now() - 600_000, drafts: [] });
    const q = await open({});
    await q.waitForSelector(".ppd-warn:not([hidden])");
    check("and says so with nothing listed", /may be behind/.test(await q.locator(".ppd-warn").innerText()));
    await close(q);
    clearDrafts();
  }

  // ---- how often it asks ----------------------------------------------------------------------------------------------
  {
    const id = draftSend("Timing.");
    watch();
    const p = await open({ clock: true });
    await p.waitForSelector(`.ppd-card[data-id="${id}"]`);
    const asks = () => p.apiCalls.filter((c) => c.path === "/api/assistant/needs").length;
    const count = async (ms) => { const a = asks(); await p.clock.runFor(ms); await sleep(150); return asks() - a; };
    check("in view: asks about every 30 s", (await count(61_000)) === 2);
    const goHidden = (hidden) => p.evaluate((h) => { Object.defineProperty(document, "hidden", { value: h, configurable: true }); Object.defineProperty(document, "visibilityState", { value: h ? "hidden" : "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); }, hidden);
    await goHidden(true);
    check("hidden: not at all", (await count(180_000)) === 0);
    const a = asks();
    await goHidden(false);
    await sleep(200);
    check("coming back: at once", asks() === a + 1, `${asks() - a}`);
    await p.evaluate(() => { location.hash = "#/agents"; });
    await p.clock.runFor(100); await sleep(100);
    check("on another tab: less often", (await count(61_000)) === 1);
    await close(p);
    clearDrafts();
  }

  // ---- the app icon ------------------------------------------------------------------------------------------------------
  {
    const p = await open({ init: STUB_BADGE });
    const needs = needsNow();
    await p.waitForFunction((n) => window.__badges.at(-1) === n, needs, { timeout: 8000 }).then(() => check("the icon shows agents waiting", true), async () => check("the icon shows agents waiting", false, `${await lastBadge(p)} wanted ${needs}`));
    const id = draftSend("Bump the number.");
    watch();
    await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await p.waitForFunction((n) => window.__badges.at(-1) === n, needs + 1, { timeout: 8000 }).then(() => check("a draft adds to it", true), async () => check("a draft adds to it", false, String(await lastBadge(p))));
    fs.rmSync(`${DRAFTS}/${id}.json`);
    watch();
    await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await p.waitForFunction((n) => window.__badges.at(-1) === n, needs, { timeout: 8000 }).then(() => check("and goes when it's gone", true), () => check("and goes when it's gone", false));
    check("the icon: no page errors", p.problems.length === 0, p.problems.join("; "));
    await close(p);

    // No Badging API at all.
    const q = await open({ init: () => { delete Navigator.prototype.setAppBadge; delete Navigator.prototype.clearAppBadge; } });
    await q.waitForSelector(".assistant");
    await sleep(500);
    check("no badging: no errors", q.problems.length === 0 && !(await q.evaluate(() => "setAppBadge" in navigator)), q.problems.join("; "));
    await close(q);
  }

  // ---- what the owner is looking at ---------------------------------------------------------------------------------------------
  {
    const addr = A["chat-agent"];
    const p = await open({ hash: `#/t/${encodeURIComponent(addr)}`, clock: true });
    await p.waitForSelector(".term, .composer", { state: "attached" });
    const focus = () => p.apiCalls.filter((c) => c.path === "/api/push/focus").map((c) => JSON.parse(c.body).terminal);
    await until(() => focus().length > 0, 3000);
    check("opening a terminal reports it", focus().at(-1) === addr, JSON.stringify(focus()));
    let n = focus().length;
    await p.clock.runFor(12_500); await sleep(150);
    check("repeats while the owner is there", focus().length > n && focus().at(-1) === addr);
    await p.clock.runFor(120_000); await sleep(150);
    check("no touch for two minutes: no longer claims the owner is looking", focus().at(-1) === null, JSON.stringify(focus().slice(-3)));
    n = focus().length;
    await p.clock.runFor(60_000); await sleep(150);
    check("and then says nothing at all", focus().length === n);
    await p.mouse.move(100, 100); await p.mouse.down(); await p.mouse.up(); await sleep(150);
    check("a touch and the owner is back", focus().at(-1) === addr, JSON.stringify(focus().slice(-3)));
    await p.evaluate(() => { location.hash = "#/agents"; }); await sleep(150);
    check("leaving says so", focus().at(-1) === null);
    n = focus().length;
    await p.clock.runFor(60_000); await sleep(150);
    check("on a list it says nothing", focus().length === n);
    await close(p);
  }

  // ---- notifications close when answered ----------------------------------------------------------------------------------
  {
    const gr = A["gateway-review"], pr = A["pr-branch"], done = A["web-tests"];
    const p = await open({ hash: "#/agents", grant: true });
    await p.evaluate(() => navigator.serviceWorker.ready);
    await p.reload();
    const show = (tag, kind) => p.evaluate(async ([tag, kind]) => { await (await navigator.serviceWorker.ready).showNotification(tag, { tag, data: { url: "/", kind } }); }, [tag, kind]);
    const tags = () => p.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => n.tag));
    const enc = encodeURIComponent;
    await p.waitForSelector(".inbox-lists .row");
    await p.evaluate(async () => { for (const n of await (await navigator.serviceWorker.ready).getNotifications()) n.close(); });

    // What's showing when the app opens.
    await show(`t-${enc(done)}`, "needs");    // it's finished: answered while the app was shut
    await show(`t-${enc(pr)}`, "needs");      // still waiting
    await show(`t-${enc("far/t9999")}`, "needs"); // a terminal this page can't see
    await show(`t-${enc(A["ledger-import"])}`, "finished"); // news, not a question
    await show(`draft-1-aaaa`, "draft");      // a draft no longer waiting
    await show(`test`, "");
    check("set up", (await tags()).length === 6, JSON.stringify(await tags()));
    await p.reload();
    await p.waitForSelector(".inbox-lists .row");
    check("on load: a question already answered closes", await until(async () => !(await tags()).includes(`t-${enc(done)}`)), JSON.stringify(await tags()));
    check("on load: a draft no longer waiting closes", await until(async () => !(await tags()).includes("draft-1-aaaa")), JSON.stringify(await tags()));
    const left = await tags();
    check("on load: one still waiting stays", left.includes(`t-${enc(pr)}`), JSON.stringify(left));
    check("on load: a terminal it can't see stays", left.includes(`t-${enc("far/t9999")}`), JSON.stringify(left));
    check("on load: 'finished' stays", left.includes(`t-${enc(A["ledger-import"])}`), JSON.stringify(left));
    check("on load: anything else stays", left.includes("test"), JSON.stringify(left));

    // The owner answers on another device, with this one open.
    await show(`t-${enc(gr)}`, "needs");
    check("showing", (await tags()).includes(`t-${enc(gr)}`));
    hc("keys", gr, "1");
    check("when it stops being blocked, its notification closes", await until(async () => !(await tags()).includes(`t-${enc(gr)}`)), JSON.stringify(await tags()));
    check("the others don't", (await tags()).includes(`t-${enc(pr)}`));

    // Opening the terminal: the owner is reading it.
    await show(`t-${enc(A["ledger-import"])}`, "finished");
    await p.evaluate((a) => { location.hash = `#/t/${encodeURIComponent(a)}`; }, A["ledger-import"]);
    check("opening a terminal closes what's about it", await until(async () => !(await tags()).includes(`t-${enc(A["ledger-import"])}`)), JSON.stringify(await tags()));

    // A draft handled somewhere else closes its notification once the list says so.
    const id = draftSend("With a notification.");
    watch();
    await p.evaluate(() => { location.hash = "#/assistant"; });
    await p.waitForSelector(`.ppd-card[data-id="${id}"]`);
    await show(`draft-${id}`, "draft");
    await card(p, id).locator(".ppd-reject").click();
    check("a decided draft closes its notification", await until(async () => !(await tags()).includes(`draft-${id}`)), JSON.stringify(await tags()));
    check("closing: no page errors", p.problems.length === 0, p.problems.join("; "));
    await close(p);
    clearDrafts();
  }

  // ---- a notification tapped with the app closed ----------------------------------------------------------------------
  {
    const addr = A["pr-branch"];
    const p = await open({ hash: `#/t/${encodeURIComponent(addr)}` });
    check("a cold start on a terminal's link opens that terminal", await p.waitForSelector(".term", { timeout: 10000 }).then(() => true, () => false) && (await p.evaluate(() => location.hash)) === `#/t/${encodeURIComponent(addr)}`);
    await close(p);
    const q = await open({ hash: "#/assistant" });
    check("a cold start on a draft's link opens the assistant", await q.waitForSelector(".assistant", { timeout: 10000 }).then(() => true, () => false));
    await close(q);
  }

  // ---- on a device the assistant can operate: words where Approve would be ---------------------------------------------------------
  {
    const s1 = draftSend("Sent from build-box, if it could be.");
    const x1 = draftAccess("Fill in the Acme form and stop before Submit.");
    const r2 = draftResume("CHANGE headline\n  was: Engineer\n  now: FDE"), g2 = draftStory("From build-box, if it could be."), m2 = draftInbox("mail_reply", "To: a@example.com\n\nNo.");
    const ops = [s1, x1, r2, g2, m2];
    watch();
    await restartGateway("build-box");
    const r = await (await api("/api/assistant/needs")).json();
    check("operable: the gateway says Approve won't work here", r.approveHere === false && r.drafts.length === ops.length, JSON.stringify(r));
    for (const id of ops) {
      const { digest } = r.drafts.find((d) => d.id === id);
      const a = await api(`/api/assistant/drafts/${id}/approve`, "POST", { digest });
      check(`operable: approving a ${read(id).kind} draft is refused`, a.status === 403 && (await a.json()).error === "not_from_here");
    }
    const pairing = await fetch(new URL("/api/pair", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "0".repeat(64) }) });
    check("operable: pairing is refused", pairing.status === 403 && (await pairing.json()).error === "not_from_here");
    check("operable: nothing ran", !calls().some((c) => ops.some((id) => c.includes(id))), calls().join("; "));

    for (const profile of ["iphone", "desktop"]) {
      const p = await open({ profile });
      await card(p, m2).waitFor();
      for (const id of ops) {
        const kind = read(id).kind;
        check(`operable ${profile}: no Approve on the ${kind} card`, (await card(p, id).locator(".ppd-approve").count()) === 0);
        check(`operable ${profile}: the ${kind} card says where to approve it`, (await card(p, id).locator(".ppd-elsewhere").innerText()) === "Assistant can operate this device, so approve this from another of your devices.");
        check(`operable ${profile}: the words come first`, !!(await card(p, id).evaluate((c) => c.querySelector(".ppd-text").compareDocumentPosition(c.querySelector(".ppd-elsewhere")) & Node.DOCUMENT_POSITION_FOLLOWING)));
        check(`operable ${profile}: Reject is still there, full size`, await card(p, id).locator(".ppd-reject").evaluate((b) => { const r = b.getBoundingClientRect(), min = (matchMedia("(pointer: fine)").matches && innerWidth >= 900 ? 36 : 44); return r.height >= min && r.width >= min; }));
      }
      await noScroll(p, `operable ${profile}`);
      await shot(p, `operable-${profile}-dark`);
      check(`operable ${profile}: no page errors`, p.problems.length === 0, p.problems.join("; "));
      await close(p);
    }

    const p = await open({});
    await card(p, x1).waitFor();
    await card(p, x1).locator(".ppd-reject").click();
    check("operable: Reject still works", await until(() => calls().includes(`no ${x1}`) && read(x1).state === "rejected"), calls().join("; "));
    await card(p, m2).locator(".ppd-reject").click();
    check("operable: Reject works for an email reply too", await until(() => calls().includes(`no ${m2}`) && read(m2).state === "rejected"), calls().join("; "));
    await close(p);

    // Back on one of the owner's: the same draft gets its button again.
    await restartGateway(null);
    watch();
    check("the owner's device: Approve works here", (await (await api("/api/assistant/needs")).json()).approveHere === true);
    const q = await open({});
    await card(q, s1).waitFor();
    check("the owner's device: the button is back", (await card(q, s1).locator(".ppd-approve").count()) === 1 && (await card(q, s1).locator(".ppd-elsewhere").count()) === 0);
    await close(q);
    clearDrafts();
  }

  // With no core there's nothing to send through, and the approve command must not get to start one: core belongs to the desktop.
  {
    const id = draftSend("With no core.");
    watch();
    const { digest } = (await (await api("/api/assistant/needs")).json()).drafts.find((d) => d.id === id);
    script("dev-fixture.sh", "stop");
    hc("server", "stop");
    await sleep(500);
    const r = await api(`/api/assistant/drafts/${id}/approve`, "POST", { digest });
    check("no core: refused, and nothing ran", r.status === 503 && (await r.json()).error === "core_down" && yeses(id) === 0 && !calls().includes(`show ${id}`));
    const rejected = await api(`/api/assistant/drafts/${id}/reject`, "POST", {});
    check("no core: rejecting still works, it touches nothing else", rejected.status === 200 && read(id).state === "rejected");
    clearDrafts();
  }

  // No secrets or draft text in the gateway's log.
  {
    const log = fs.readFileSync(`/run/user/${process.getuid()}/k${port}/gw.log`, "utf8");
    check("the log holds no draft text and no tool output", !/re-run the gateway|Careful with|TOOL WORDS|SCREEN TAIL/.test(log), log.slice(-400));
  }
} catch (e) {
  check("the run completed", false, e.stack);
} finally {
  await browser.close().catch(() => {});
  stopAll();
}
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
