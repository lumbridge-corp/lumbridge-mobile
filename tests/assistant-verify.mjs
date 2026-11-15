// The assistant's tab in Chrome, against a scratch gateway with a fake Hermes and fake speech: what she shows when she can't be reached
// (one card, Try again, the automatic recheck, what the owner types kept on the device), coming back, the starters, a message that didn't
// get through being offered again, and her states (idle, listening, thinking, speaking, away) shot on a phone and a desktop in both
// themes. Starts and stops everything itself:
//   node tests/assistant-verify.mjs <port> [shots dir]
// Needs web/dist. No database: the assistant's tab doesn't use one. Never `playwright install`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopOnExit } from "./ports.mjs";
import { ASSISTANT, chromium, PROFILES } from "./ui-lib.mjs";

const [port, shots] = process.argv.slice(2);
if (!port) { console.error("usage: assistant-verify.mjs <port> [shots dir]"); process.exit(2); }
if (shots) fs.mkdirSync(shots, { recursive: true });
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0, passed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  [${extra}]`}`); if (ok) passed++; else failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(100); } return false; };
const shot = async (p, name) => { if (shots) { await sleep(250); await p.screenshot({ path: `${shots}/${name}.png` }); } };

// ---- Hermes and speech, as far as the gateway can tell ------------------------------------------------------------------

// Made-up words only.
const SEED = [
  ["user", "What needs me right now?"],
  ["assistant", "Two things:\n- **gateway-review** on the server is blocked on a yes/no about the migration.\n- The dentist wants Thursday 9:30 or 15:00. It's in For you."],
  ["user", "Say yes to the migration, I'll do the dentist later"],
  ["assistant", "Done. I've drafted the reply for gateway-review; approve it above and it goes to the terminal."],
];
const hermes = { up: true, delay: 0, turns: [], sessions: new Map(), seedNext: null };
const speech = { spoken: 0 };
// Two seconds of a quiet tone, so her voice has a level for the orb to follow.
const WAV = (() => {
  const rate = 16000, n = rate * 2, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 220) * 9000 * (0.6 + 0.4 * Math.sin(i / rate * 9))), 44 + i * 2);
  return b;
})();
const historyOf = (id) => {
  if (!hermes.sessions.has(id) && hermes.seedNext) { hermes.sessions.set(id, hermes.seedNext); hermes.seedNext = null; }
  return hermes.sessions.get(id) ?? null;
};
const fake = createServer((req, res) => {
  const parts = [];
  req.on("data", (d) => parts.push(d));
  req.on("end", async () => {
    const raw = Buffer.concat(parts);
    const u = new URL(req.url, "http://hermes");
    const isHermes = u.pathname === "/v1/chat/completions" || u.pathname.startsWith("/api/sessions/");
    // Away is a closed door, as when Hermes isn't running: the gateway sees no answer at all.
    if (isHermes && !hermes.up) { req.socket.destroy(); return; }
    const session = u.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (session) {
      const h = historyOf(decodeURIComponent(session[1]));
      if (!h) { res.writeHead(404); res.end("{}"); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: h.map(([role, content], i) => ({ role, content, timestamp: 1000 + i })) }));
    } else if (u.pathname === "/v1/chat/completions") {
      const words = JSON.parse(raw.toString()).messages.at(-1).content;
      const id = req.headers["x-hermes-session-id"];
      hermes.turns.push(words);
      const reply = /calendar/i.test(words) ? "Today: standup at 10, the dentist call at 3." : "Noted. I'll keep it in mind.";
      const h = historyOf(id) ?? [];
      hermes.sessions.set(id, [...h, ["user", words], ["assistant", reply]]);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('event: hermes.tool.progress\ndata: {"tool":"calendar","status":"running","toolCallId":"c1"}\n\n');
      if (hermes.delay) await sleep(hermes.delay);
      res.write('event: hermes.tool.progress\ndata: {"tool":"calendar","status":"done","toolCallId":"c1"}\n\n');
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
    } else if (u.pathname === "/v1/audio/speech") {
      speech.spoken++;
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(WAV);
    } else if (u.pathname === "/v1/audio/transcriptions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "What needs me right now?" }));
    } else { res.writeHead(404); res.end(); }
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;
const S = fs.mkdtempSync(path.join(os.tmpdir(), "lumbridge-assistant-"));
fs.writeFileSync(`${S}/hermes-key`, "hermes-test-key");

// ---- The gateway ----------------------------------------------------------------------------------------------------

const dev = (...a) => spawnSync("bash", [`${repo}/scripts/dev.sh`, port, ...a], {
  env: {
    ...process.env, LUMBRIDGE_HERMES_URL: FAKE, LUMBRIDGE_HERMES_KEY_FILE: `${S}/hermes-key`,
    LUMBRIDGE_ASR_URL: `${FAKE}/v1/audio/transcriptions`, LUMBRIDGE_ASR_FALLBACK_URL: `${FAKE}/v1/audio/transcriptions`, LUMBRIDGE_TTS_URL: `${FAKE}/v1/audio/speech`,
  },
  encoding: "utf8",
});
let cleaned = false;
const cleanUp = () => { if (cleaned) return; cleaned = true; dev("stop"); fs.rmSync(S, { recursive: true, force: true }); };
stopOnExit(cleanUp);
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
dev("stop");
const up = dev();
if (up.status !== 0) { console.error(up.stdout, up.stderr); process.exit(1); }
const tok = fs.readFileSync(`/run/user/${process.getuid()}/k${port}/token`, "utf8").trim();
const BASE = `http://127.0.0.1:${port}/`;
for (let i = 0; i < 80; i++) { if (await fetch(`${BASE}healthz`).catch(() => null)) break; await sleep(100); }

const browser = await chromium.launch({ channel: "chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
// A turn that meets a closed door is a 503 from the gateway, which Chrome logs. That's this test's doing.
const noise = /Failed to load resource/;
async function open(profile = "iphone", dark = true) {
  const ctx = await browser.newContext({ ...PROFILES[profile], colorScheme: dark ? "dark" : "light", permissions: ["microphone"], serviceWorkers: "block" });
  await ctx.addInitScript((tok) => { try { localStorage.setItem("lumbridge.token", tok); } catch {} }, tok);
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(`pageerror: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !noise.test(m.text())) p.errors.push(`console: ${m.text()}`); });
  await p.goto(`${BASE}#/assistant`);
  await p.waitForSelector(".assistant");
  return p;
}
const close = (p) => p.context().close();
const card = (p) => p.evaluate(() => {
  const n = document.querySelector(".pp-notice");
  const box = n && !n.hidden ? n.querySelector(".d-error") : null;
  return box ? { tone: box.classList.contains("warn") ? "warn" : box.classList.contains("danger") ? "danger" : "note", what: box.querySelector(".d-error-what")?.textContent ?? "", next: box.querySelector(".d-error-next")?.textContent ?? "", button: box.querySelector(".d-error-retry")?.textContent ?? "" } : null;
});
const typed = (p) => p.$eval(".pp-composer textarea", (e) => e.value);
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const orbForm = (p) => p.$eval(".po", (e) => e.dataset.state);
const newConversation = async (p) => {
  await p.click('.pp-head button[aria-label="New conversation"]');
  if (!(await p.evaluate(() => document.querySelector(".assistant").classList.contains("empty")))) await p.click('.pp-head button[aria-label="New conversation"]');
  await p.waitForSelector(".assistant.empty");
};

try {
  // ---- Away from the start ------------------------------------------------------------------------------------------
  hermes.up = false;
  {
    const p = await open();
    check("away: one card says so", await until(async () => (await card(p))?.what === "Can't reach Assistant right now."), JSON.stringify(await card(p)));
    const c = await card(p);
    check("away: it says why and what still works", /agent runtime/.test(c.next) && /anything you type waits here/.test(c.next), c.next);
    check("away: amber, since it clears by itself", c.tone === "warn");
    check("away: with Try again", c.button === "Try again");
    check("away: said once, not three times", await p.evaluate(() => (document.querySelector(".assistant").innerText.match(/reach Assistant|unreachable/gi) ?? []).length === 1 && document.querySelector(".pp-state").textContent === ""));
    check("away: the orb is only its outline, and can't be pressed", (await orbForm(p)) === "error" && (await p.$eval(".pp-orb", (e) => e.disabled)));
    check("away: no starters to tap", !(await p.isVisible(".pp-starter")));
    await p.fill(".pp-composer textarea", "Remind me about the dentist");
    await p.press(".pp-composer textarea", "Enter");
    await sleep(800);
    check("away: what the owner typed stays in the box", (await typed(p)) === "Remind me about the dentist");
    check("away: and nothing was sent", hermes.turns.length === 0 && (await p.$$(".pp-me")).length === 0);
    await p.reload();
    await p.waitForSelector(".assistant");
    check("away: it's still there after a reload", await until(async () => (await typed(p)) === "Remind me about the dentist", 3000));
    check("no sideways scroll", (await overflow(p)) === 0);

    // Try again, once she's back.
    hermes.up = true;
    await p.click(".pp-notice .d-error-retry");
    check("Try again: the card goes", await until(async () => (await card(p)) === null, 3000), JSON.stringify(await card(p)));
    check("Try again: the orb is hers again", (await orbForm(p)) === "idle" && !(await p.$eval(".pp-orb", (e) => e.disabled)));
    check("Try again: the starters are back", (await p.$$eval(".pp-starter", (b) => b.filter((x) => x.offsetParent).length)) === 3);
    check("Try again: what the owner typed is still there", (await typed(p)) === "Remind me about the dentist");
    await p.press(".pp-composer textarea", "Enter");
    check("now it sends", await until(() => hermes.turns.includes("Remind me about the dentist")));
    check("and she answers", await until(() => p.evaluate(() => /Noted/.test(document.querySelector(".pp-her:last-child .pp-body")?.textContent ?? ""))));
    check("the box is empty, here and on the device", (await typed(p)) === "" && (await p.evaluate(() => localStorage.getItem("lumbridge.assistant.typed"))) === "");
    check("no page errors", p.errors.length === 0, p.errors.join("; "));
    await close(p);
  }

  // ---- She comes back by herself --------------------------------------------------------------------------------------
  {
    hermes.up = false;
    const p = await open();
    check("recheck: away at first", await until(async () => (await card(p))?.what === "Can't reach Assistant right now."));
    hermes.up = true;
    check("recheck: the card goes by itself", await until(async () => (await card(p)) === null, 8000));
    check("recheck: the conversation comes with her", await until(() => p.evaluate(() => document.querySelectorAll(".pp-me").length === 1)));
    await close(p);
  }

  // ---- A message that didn't get through ------------------------------------------------------------------------------
  {
    const p = await open();
    await p.waitForSelector(".pp-me");
    hermes.up = false;
    await p.fill(".pp-composer textarea", "Is the build green?");
    await p.press(".pp-composer textarea", "Enter");
    check("lost turn: the card says she's away", await until(async () => (await card(p))?.what === "Can't reach Assistant right now."), JSON.stringify(await card(p)));
    check("lost turn: and only the card", await p.evaluate(() => document.querySelectorAll(".d-error").length === 1));
    hermes.up = true;
    await p.click(".pp-notice .d-error-retry");
    check("lost turn: back, it offers to send it again", await until(async () => { const c = await card(p); return c?.what === `${ASSISTANT} is back.` && c.button === "Send again"; }), JSON.stringify(await card(p)));
    await p.click(".pp-notice .d-error-retry");
    check("lost turn: sent once", await until(() => hermes.turns.filter((t) => t === "Is the build green?").length === 1));
    check("lost turn: and on screen once", await until(() => p.evaluate(() => [...document.querySelectorAll(".pp-me")].filter((e) => e.textContent === "Is the build green?").length === 1)));
    check("lost turn: the line goes", await until(async () => (await card(p)) === null));
    await close(p);
  }

  // ---- The starters -------------------------------------------------------------------------------------------------
  {
    const p = await open();
    await p.waitForSelector(".pp-me");
    await newConversation(p);
    const starters = await p.$$eval(".pp-starter", (b) => b.map((x) => x.textContent));
    check("empty: three starters", starters.length === 3, starters.join(" | "));
    check("empty: one plain line of what she can do", /agents, mail, calendar/.test(await p.textContent(".pp-intro-line")));
    await p.click('.pp-starter:has-text("calendar")');
    check("a starter is sent as it reads", await until(() => hermes.turns.at(-1) === "What's on my calendar today?"));
    check("and answered", await until(() => p.evaluate(() => /standup/.test(document.querySelector(".pp-her:last-child .pp-body")?.textContent ?? ""))));
    check("the starters go once there's a conversation", !(await p.isVisible(".pp-starter")));
    check("no page errors", p.errors.length === 0, p.errors.join("; "));
    await close(p);
  }

  // ---- Every shape, every state ---------------------------------------------------------------------------------------
  if (shots) {
    for (const profile of ["iphone", "desktop"]) for (const dark of [true, false]) {
      const name = `${profile}-${dark ? "dark" : "light"}`;
      const p = await open(profile, dark);
      await newConversation(p);
      await shot(p, `${name}-empty`);
      hermes.seedNext = SEED;
      await p.reload();
      await p.waitForSelector(".pp-her");
      await shot(p, `${name}-idle`);
      check(`${name}: no sideways scroll`, (await overflow(p)) === 0);
      if (profile === "desktop") {
        check(`${name}: the conversation is a column, not the full width`, await p.evaluate(() => { const r = document.querySelector(".pp-her .pp-body").getBoundingClientRect(); return r.width <= 730 && Math.abs((r.left + r.right) / 2 - (document.querySelector(".pp-log").getBoundingClientRect().left + document.querySelector(".pp-log").getBoundingClientRect().right) / 2) < 380; }));
      }
      await p.click(".pp-orb");
      await p.waitForFunction(() => document.querySelector(".assistant").dataset.state === "listening");
      await sleep(700);
      await shot(p, `${name}-listening`);
      await p.click(".pp-orb"); // changed the owner's mind
      await p.waitForFunction(() => document.querySelector(".assistant").dataset.state !== "listening");
      hermes.delay = 2500;
      await p.fill(".pp-composer textarea", "Anything on the calendar this afternoon?");
      await p.press(".pp-composer textarea", "Enter");
      await p.waitForFunction(() => document.querySelector(".assistant").dataset.state === "thinking");
      await sleep(600);
      await shot(p, `${name}-thinking`);
      hermes.delay = 0;
      const speaking = await p.waitForFunction(() => document.querySelector(".assistant").dataset.state === "speaking", null, { timeout: 15000 }).then(() => true, () => false);
      check(`${name}: she speaks`, speaking);
      await sleep(500);
      await shot(p, `${name}-speaking`);
      await p.waitForFunction(() => document.querySelector(".assistant").dataset.state === "idle", null, { timeout: 15000 });
      hermes.up = false;
      await p.fill(".pp-composer textarea", "Is the build green?");
      await p.press(".pp-composer textarea", "Enter");
      await p.waitForSelector(".assistant.unreachable .pp-notice .d-error");
      await shot(p, `${name}-away-talk`);
      await p.reload();
      await p.waitForSelector(".pp-notice .d-error");
      await shot(p, `${name}-away`);
      await newConversation(p).catch(() => {});
      hermes.up = true;
      await close(p);
    }
  }
} finally {
  await browser.close();
  fake.close();
  cleanUp();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
