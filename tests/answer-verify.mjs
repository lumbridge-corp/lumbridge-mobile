// Answering from the list, the terminal's new keys and hold-to-talk, in Chrome against a scratch core and fixture:
//   scripts/dev.sh <port> && scripts/dev-fixture.sh <port> && node tests/answer-verify.mjs <port> [shots dir]
import { execFileSync } from "node:child_process";
import { addresses, chromium, PROFILES, scratchEnv, seedLayouts, target } from "./ui-lib.mjs";

const [port, shots] = process.argv.slice(2);
const t = target(port);
const A = addresses(port);
const hc = (...a) => execFileSync("lbc", a, { env: scratchEnv(port), encoding: "utf8" });
const screen = (a) => JSON.parse(hc("read", a, "--json")).text ?? hc("read", a);
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  [${extra}]`}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(100); } return false; };

seedLayouts(port, A);
const browser = await chromium.launch({ channel: "chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const ctx = await browser.newContext({ ...PROFILES.iphone, colorScheme: "dark", permissions: ["microphone"] });
await ctx.addInitScript((tok) => { try { localStorage.setItem("lumbridge.token", tok); } catch {} }, t.token);
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));

const addr = A["gateway-review"];
// Answering is By state's: By place has one Needs you line that goes there (L-15), and the list holds its choices.
const row = () => p.locator(`.master .group.needs .row[data-address="${addr}"]`).first();

// ---- By place's rows, then its Needs you line into By state, and the agent's own choices there
await p.goto(`${t.base}#/panes`);
check("the switch is on By place", await until(() => p.evaluate(() => document.querySelector(".list-btn.on")?.dataset.list === "panes")));
await until(() => p.evaluate(() => !!document.querySelector(".place .pm-needs")));
const tallest = await p.evaluate(() => Math.max(...[...document.querySelectorAll(".place .row")].filter((r) => !r.querySelector(".choice")).map((r) => r.getBoundingClientRect().height)));
check("no row is taller than a row: a plain shell's class once matched the app frame's", tallest > 0 && tallest < 160, String(tallest));
const plain = await p.locator(".place .row.plain").count();
check("and plain shells are in the list to prove it", plain > 0, String(plain));
await p.tap(".place .pm-needs");
check("By place's Needs you line goes to By state", await until(() => p.evaluate(() => location.hash === "#/agents" && document.querySelector(".list-btn.on")?.dataset.list === "agents")));
check("the blocked agent shows its choices in Needs you", await until(() => row().locator(".choice").count().then((n) => n === 3)), await row().innerHTML().catch(() => "no row"));
const labels = await row().locator(".choice").allTextContents();
check("labelled from its screen", labels[0] === "Yes" && labels[2].startsWith("No"), labels.join("|"));
check("short on the button, with no key hints", labels[1] === "Allow all edits this session" && labels[2] === "No, tell it what to do", labels.join("|"));
const titles = await row().locator(".choice").evaluateAll((bs) => bs.map((b) => `${b.title}|${b.getAttribute("aria-label")}`));
check("the program's own words stay in its title and aria-label", titles[2] === "No, and tell Claude what to do differently (esc)|Answer 3: No, and tell Claude what to do differently (esc)", titles.join(" / "));
if (shots) await p.screenshot({ path: `${shots}/answer-panes.png` });
const before = screen(addr);

await row().locator(".choice").nth(0).click();
check("the first tap only arms it", (await row().locator(".choice.armed").textContent()) === "Tap again: Yes");
await sleep(500);
check("and nothing reached the program", screen(addr) === before && !screen(addr).includes("Edit applied"));
if (shots) await p.screenshot({ path: `${shots}/answer-armed.png` });

await row().locator(".choice").nth(1).click();
check("tapping another moves the arming, sending nothing", (await row().locator(".choice.armed").count()) === 1 && (await row().locator(".choice").nth(0).textContent()) === "Yes" && !screen(addr).includes("Edit applied"));
await sleep(3300);
check("arming wears off", (await row().locator(".choice.armed").count()) === 0);

// The arm's word fits the pointer (L-16): a mouse clicks, a phone taps. Arming only: nothing is pressed here.
for (const [profile, word] of [["desktop", "Click"], ["pixel", "Tap"]]) {
  const c2 = await browser.newContext({ ...PROFILES[profile], colorScheme: "dark" });
  await c2.addInitScript((tok) => { try { localStorage.setItem("lumbridge.token", tok); } catch {} }, t.token);
  const q = await c2.newPage();
  await q.goto(`${t.base}#/agents`);
  const r2 = q.locator(`.master .group.needs .row[data-address="${addr}"]`).first();
  await until(() => r2.locator(".choice").count().then((n) => n === 3));
  await r2.locator(".choice").nth(0).click();
  check(`${profile}: the first press arms it with "${word} again"`, (await r2.locator(".choice.armed").textContent().catch(() => "")) === `${word} again: Yes`, await r2.locator(".choice").first().textContent().catch(() => "no row"));
  await sleep(3300);
  check(`${profile}: and still wears off`, (await r2.locator(".choice.armed").count()) === 0 && (await r2.locator(".choice").nth(0).textContent()) === "Yes");
  await c2.close();
}
check("and nothing reached the program from either", !screen(addr).includes("Edit applied"));

const box = row().locator(".choice").nth(0);
await box.click();
await box.click();
check("the second tap presses it in the real program", await until(() => screen(addr).includes("Edit applied"), 6000), screen(addr).slice(-300));
check("and the row stops asking", await until(() => row().count().then((n) => n === 0), 8000));

// ---- The terminal screen: new keys, and hold-to-talk
const shell = A["scratch-shell"];
await p.goto(`${t.base}#/t/${encodeURIComponent(shell)}`);
await p.waitForSelector(".composer .talk");
for (const k of ["Space", "Backspace", "Control D", "Control O", "Control R", "Control L"]) check(`key bar has ${k}`, (await p.locator(`.keys [aria-label="${k}"]`).count()) === 1);
await p.locator('.composer textarea').fill("");
const sizeBefore = JSON.parse(hc("get", shell, "--json"));
hc("send", shell, "stty -echo; cat -v; stty echo", "--force");
await sleep(600);
const keyBar = p.locator('.keys [aria-label="Space"]');
await keyBar.scrollIntoViewIfNeeded();
await p.locator('.keys [aria-label="Control L"]').scrollIntoViewIfNeeded();
await p.locator('.keys [aria-label="Control L"]').click();
await p.locator('.keys [aria-label="Enter"]').scrollIntoViewIfNeeded();
await p.locator('.keys [aria-label="Enter"]').click();
check("a new key reaches the program", await until(() => screen(shell).includes("^L"), 6000), screen(shell).slice(-200));
const sizeAfter = JSON.parse(hc("get", shell, "--json"));
check("and doesn't resize it", sizeBefore.cols === sizeAfter.cols && sizeBefore.rows === sizeAfter.rows);
const ctrlD = p.locator('.keys [aria-label="Control D"]');
await ctrlD.scrollIntoViewIfNeeded();
await ctrlD.click();
check("Ctrl-D needs a second tap", (await ctrlD.textContent()) === "Again?");

// Hold to talk, with Chrome's fake microphone and a stand-in for speech.
let received = null;
await p.route("**/api/voice/transcribe", async (r) => { received = r.request().postDataBuffer(); await r.fulfill({ status: 200, contentType: "application/json", body: '{"text":"hello from the mic"}' }); });
const talk = p.locator(".composer .talk");
const b = await talk.boundingBox();
await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
await p.mouse.down();
await until(() => talk.evaluate((e) => e.classList.contains("listening")), 2000);
await sleep(1200);
check("it listens while held", await talk.evaluate((e) => e.classList.contains("listening")));
if (shots) await p.screenshot({ path: `${shots}/answer-talk.png` });
await p.mouse.up();
check("letting go puts the words in the box, unsent", await until(() => p.locator(".composer textarea").inputValue().then((v) => v === "hello from the mic"), 5000), await p.locator(".composer textarea").inputValue());
check("what it sent is real audio", !!received && received.subarray(0, 4).toString() === "RIFF" && received.length > 1000, String(received?.length));
check("the mic is off again", !(await talk.evaluate((e) => e.classList.contains("listening"))));
await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
await p.mouse.down(); await sleep(60); await p.mouse.up();
check("a quick tap says how, and adds nothing", await until(async () => (await p.locator(".term-toast").textContent()) === "Hold to talk", 2000) && (await p.locator(".composer textarea").inputValue()) === "hello from the mic");

// ---- A computer's overview beside the list: the HUD, and an ask answered right there with a short label pressing its own key
{
  const out = hc("run", "--bg", "--no-parent", "--name", "ov-perm", new URL("../scripts/dev-fixture.sh", import.meta.url).pathname, "--agent", "permission").trim().split("\n").pop();
  const ov = JSON.parse(out).address;
  const c3 = await browser.newContext({ ...PROFILES.desktop, colorScheme: "light" });
  await c3.addInitScript((tok) => { try { localStorage.setItem("lumbridge.token", tok); } catch {} }, t.token);
  const q = await c3.newPage();
  q.on("pageerror", (e) => errors.push(e.message));
  await q.goto(`${t.base}#/agents`);
  check("desktop: the pane beside the list is the overview", await until(() => q.locator(".detail .overview .ov-hud").count().then((n) => n === 1)));
  const needNum = () => q.locator(".detail .ov-stat.needs .ov-num").textContent().then(Number);
  const card = q.locator(`.detail .ov-asks .row[data-address="${ov}"]`);
  check("its asks are there to answer, with the same short labels", await until(() => card.locator(".choice").count().then((n) => n === 3), 10000), await q.locator(".detail").innerText().catch(() => ""));
  const listNeeds = await q.locator(".master .group.needs .row").count();
  check("its need-you numeral matches the list", (await needNum()) === listNeeds, `${await needNum()} vs ${listNeeds}`);
  if (shots) await q.screenshot({ path: `${shots}/answer-overview.png` });
  const no = card.locator(".choice").nth(2);
  check("the short No is key 3", (await no.textContent()) === "No, tell it what to do" && (await no.getAttribute("data-key")) === "3");
  await no.click();
  check("the first click only arms it there too", (await no.textContent()) === "Click again: No, tell it what to do" && !screen(ov).includes("tell me what to change"));
  await no.click();
  check("the second presses 3 in the real program", await until(() => screen(ov).includes("OK, tell me what to change"), 6000), screen(ov).slice(-200));
  check("and the overview follows live: the ask goes and the numeral drops", await until(async () => (await card.count()) === 0 && (await needNum()) === listNeeds - 1, 8000), String(await needNum()));
  await c3.close();
  try { hc("kill", ov); } catch { /* the fixture's stop takes it anyway */ }
}

check("no page errors", errors.length === 0, errors.join("; "));
await browser.close();
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
