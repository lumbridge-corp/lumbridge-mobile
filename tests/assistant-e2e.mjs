// The assistant's screen end to end, in real Chrome with a fake mic. Against a dev gateway only:
//   PW=<dir with playwright installed> node tests/assistant-e2e.mjs <base url with #token> <wav> <shots dir> [scenario]
// scenario: main (default, real Hermes and speech) | voice (one spoken turn, prints timings) | webkit | desktop | noasr | notts | nohermes | denied
// noasr needs a gateway whose LUMBRIDGE_ASR_PRIMARY_URL, LUMBRIDGE_ASR_URL and LUMBRIDGE_ASR_FALLBACK_URL all point at a dead port.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require = createRequire(`${process.env.PW}/`);
const { chromium } = require("playwright");
const [url, wav, shots, scenario = "main"] = process.argv.slice(2);
mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); if (!ok) failed++; };

const browser = await chromium.launch({
  channel: "chrome",
  args: [
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}%noloop`,
    "--autoplay-policy=user-gesture-required",
  ],
});

// Counts what is really played through the shared AudioContext; no content, just lengths.
const SPY = () => {
  window.__played = [];
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) {
    if (this.buffer && this.buffer.length > 1) window.__played.push({ at: performance.now(), s: this.buffer.duration });
    return start.apply(this, a);
  };
};

async function open(viewport, { mic = true, dark = true } = {}) {
  const ctx = await browser.newContext({
    viewport, deviceScaleFactor: 2, hasTouch: viewport.width < 800, isMobile: viewport.width < 800,
    colorScheme: dark ? "dark" : "light", permissions: mic ? ["microphone"] : [],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(SPY);
  await page.goto(url);
  await page.waitForSelector("nav");
  await page.evaluate(() => { location.hash = "#/assistant"; });
  await page.waitForSelector(".assistant");
  return { ctx, page, errors };
}
const state = (page) => page.$eval(".assistant", (e) => e.dataset.state);
const waitState = (page, s, timeout = 60000) =>
  page.waitForFunction((want) => document.querySelector(".assistant")?.dataset.state === want, s, { timeout });
const trace = (page) => page.$eval(".assistant", (e) => JSON.parse(e.dataset.trace || "{}"));
const shot = (page, name) => page.screenshot({ path: `${shots}/${name}.png` });
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const tapOrb = (page) => page.click(".pp-orb");

async function typeAndSend(page, text) {
  await page.fill(".pp-composer textarea", text);
  await page.press(".pp-composer textarea", "Enter");
}
const notice = (page) => page.$eval(".pp-notice", (e) => (e.hidden ? "" : e.textContent));

if (scenario === "main") {
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await shot(page, "01-empty");
  check("no sideways scroll", (await noOverflow(page)) === 0);

  // Voice: fake mic -> transcript -> streamed reply -> played audio.
  await tapOrb(page);
  await waitState(page, "listening", 5000);
  await page.waitForTimeout(2500);
  await shot(page, "02-listening");
  await page.waitForSelector(".pp-me", { timeout: 20000 });
  const heard = await page.textContent(".pp-me .pp-body");
  console.log("  heard:", heard);
  check("speech became text", /test/i.test(heard), heard);
  await shot(page, "03-thinking");
  await page.waitForFunction(() => window.__played.length > 0, null, { timeout: 60000 });
  await shot(page, "04-speaking");
  await waitState(page, "idle", 90000);
  const t = await trace(page);
  const played = await page.evaluate(() => window.__played);
  const reply = await page.textContent(".pp-her:last-child .pp-body");
  console.log("  replied:", reply);
  check("the reply appeared", reply.trim().length > 0);
  check("audio played", played.length > 0, `${played.length} clips, ${played.reduce((a, p) => a + p.s, 0).toFixed(1)} s`);
  console.log("  timings ms after real end of speech:", JSON.stringify({
    endpoint: t.endpoint - t.speechEnd, transcribed: t.transcribed - t.speechEnd, firstDelta: t.firstDelta - t.speechEnd,
    firstSentence: t.firstSentence - t.speechEnd, firstAudio: t.firstAudio - t.speechEnd,
  }));
  await shot(page, "05-replied");

  // A second device sees the same conversation.
  const other = await open({ width: 390, height: 844 });
  await other.page.waitForSelector(".pp-me", { timeout: 8000 });
  check("another device has the conversation",
    (await other.page.textContent(".pp-me .pp-body")) === heard && (await other.page.$$(".pp-her")).length === 1);
  await other.ctx.close();

  // Text.
  await typeAndSend(page, "test from the Lumbridge builder, reply with one word");
  await page.waitForFunction(() => document.querySelectorAll(".pp-me").length === 2);
  await waitState(page, "thinking", 3000).catch(() => {});
  await waitState(page, "idle", 60000);
  check("text got an answer", (await page.$$(".pp-her")).length === 2);
  await page.waitForTimeout(200);
  await shot(page, "06-text");

  // Interrupt: tap while she's speaking. Its audio stops and it's your turn.
  const before = (await page.evaluate(() => window.__played)).length;
  await typeAndSend(page, "test from the Lumbridge builder, count from one to twenty in words, a sentence for each number");
  await page.waitForFunction((n) => window.__played.length > n, before, { timeout: 60000 });
  await page.waitForTimeout(300);
  await shot(page, "07-before-interrupt");
  await tapOrb(page);
  await waitState(page, "listening", 3000);
  check("the tap interrupts her and listens", true);
  const clipsAtTap = (await page.evaluate(() => window.__played)).length;
  await page.waitForTimeout(1500);
  check("no more audio after the interrupt", (await page.evaluate(() => window.__played)).length === clipsAtTap);
  await shot(page, "08-interrupted");
  await tapOrb(page); // ends the listening; the fake mic has finished so this sends silence
  await waitState(page, "idle", 20000);
  await shot(page, "09-after");

  // Mute.
  await page.click('.pp-head button[aria-label="Mute Assistant"]');
  const clips = (await page.evaluate(() => window.__played)).length;
  await typeAndSend(page, "test from the Lumbridge builder, reply with one word");
  await page.waitForTimeout(500);
  await waitState(page, "idle", 60000);
  check("muted means no audio", (await page.evaluate(() => window.__played)).length === clips);
  await page.click('.pp-head button[aria-label="Unmute Assistant"]');

  // New conversation takes two taps.
  await page.click('.pp-head button[aria-label="New conversation"]');
  check("first tap only asks", (await page.$$(".pp-msg")).length > 0);
  await shot(page, "10-confirm-new");
  await page.click('.pp-head button[aria-label="New conversation"]');
  await page.waitForSelector(".assistant.empty");
  check("new conversation empties the screen", (await page.$$(".pp-msg")).length === 0);
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

if (scenario === "voice") {
  const { ctx, page } = await open({ width: 390, height: 844 });
  await tapOrb(page);
  await page.waitForFunction((n) => document.querySelectorAll(".pp-me").length > n, (await page.$$(".pp-me")).length, { timeout: 30000 });
  await page.waitForFunction(() => window.__played.length > 0, null, { timeout: 90000 });
  const t = await trace(page);
  console.log("  heard:", await page.$$eval(".pp-me .pp-body", (e) => e[e.length - 1].textContent));
  console.log("  ms after end of speech:", JSON.stringify({ endpoint: t.endpoint - t.speechEnd, transcribed: t.transcribed - t.speechEnd, firstDelta: t.firstDelta - t.speechEnd, firstSentence: t.firstSentence - t.speechEnd, firstAudio: t.firstAudio - t.speechEnd }));
  await waitState(page, "idle", 120000);
  await ctx.close();
}

if (scenario === "webkit") {
  // The closest engine to iOS Safari on this box. Not iOS: no real audio route, gesture rules or keyboard.
  const { webkit, devices } = require("playwright");
  const wk = await webkit.launch();
  const ctx = await wk.newContext({ ...devices["iPhone 15 Pro"], colorScheme: "dark" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(SPY);
  await page.goto(url);
  await page.waitForSelector("nav");
  await page.evaluate(() => { location.hash = "#/assistant"; });
  await page.waitForSelector(".assistant");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shots}/40-webkit-iphone.png` });
  const facts = await page.evaluate(async () => {
    const c = new AudioContext();
    let worklet = false;
    try { await c.audioWorklet.addModule("/pcm-worklet.js"); worklet = true; } catch { /* reported below */ }
    await c.close();
    return { worklet, font: getComputedStyle(document.querySelector(".pp-composer textarea")).fontSize, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  check("worklet loads under the page's CSP", facts.worklet);
  check("input font is 16px", facts.font === "16px", facts.font);
  check("no sideways scroll", facts.overflow === 0);
  await page.fill(".pp-composer textarea", "test from the Lumbridge builder, reply with one word");
  await page.tap(".pp-send");
  await page.waitForSelector(".pp-her .pp-body p", { timeout: 60000 });
  await page.waitForFunction(() => window.__played.length > 0, null, { timeout: 30000 }).catch(() => {});
  const played = await page.evaluate(() => window.__played);
  check("streams and decodes the WAV in WebKit", played.length > 0, `${played.length} clips`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shots}/41-webkit-reply.png` });
  check("no page errors", errors.length === 0, errors.join(" | "));
  await wk.close();
}

if (scenario === "desktop") {
  const { ctx, page, errors } = await open({ width: 1440, height: 900 });
  await page.waitForTimeout(600);
  await shot(page, "20-desktop");
  check("desktop: no sideways scroll", (await noOverflow(page)) === 0);
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

if (scenario === "noasr") {
  const { ctx, page } = await open({ width: 390, height: 844 });
  await tapOrb(page);
  await waitState(page, "error", 20000);
  const n = await notice(page);
  check("ASR down says voice is offline", /Voice is offline/.test(n), n);
  await page.waitForTimeout(300);
  await shot(page, "30-voice-offline-asr");
  await ctx.close();
}

if (scenario === "notts") {
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  await typeAndSend(page, "test from the Lumbridge builder, reply with one word");
  await page.waitForSelector(".pp-her .pp-body p", { timeout: 60000 });
  await waitState(page, "idle", 60000);
  const n = await notice(page);
  check("TTS down keeps her words", (await page.textContent(".pp-her .pp-body")).length > 0);
  check("TTS down says voice is offline", /Voice is offline/.test(n), n);
  await page.waitForTimeout(300);
  await shot(page, "31-voice-offline-tts");
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

if (scenario === "nohermes") {
  // Away from the start: one card with Try again, and what the owner types stays in the box instead of being sent into nothing.
  const { ctx, page } = await open({ width: 390, height: 844 });
  await page.waitForSelector(".assistant.unreachable .pp-notice .d-error", { timeout: 15000 });
  const n = await notice(page);
  check("Hermes down says can't reach the assistant", /Can't reach Assistant/.test(n), n);
  check("offers a retry", await page.isVisible(".pp-retry"));
  await typeAndSend(page, "this never leaves the gateway");
  await page.waitForTimeout(800);
  check("what the owner typed stays in the box", (await page.inputValue(".pp-composer textarea")) === "this never leaves the gateway");
  await shot(page, "32-cant-reach");
  await ctx.close();
}

if (scenario === "denied") {
  const { ctx, page } = await open({ width: 390, height: 844 }, { mic: false });
  await ctx.setOffline(false);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("no", "NotAllowedError"));
  });
  await tapOrb(page);
  await waitState(page, "error", 5000);
  const n = await notice(page);
  check("a denied mic says it can't hear", /can't hear you/.test(n) && /Settings/.test(n), n);
  await page.waitForTimeout(300);
  await shot(page, "33-mic-denied");
  await ctx.close();
}

await browser.close();
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
