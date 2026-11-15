// The terminal screen, the move between it and the list, and page titles, in Chrome against a scratch core and fixture:
//   scripts/dev.sh <port> && scripts/dev-fixture.sh <port> && node tests/terminal-verify.mjs <port> [shots dir]
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { check, failed, group, meter, said } from "./quiet-host.mjs";
import { addresses, chromium, EXT, open as openPage, scratchCalls, scratchEnv, target, webkit, PROFILES } from "./ui-lib.mjs";

const [port, shots] = process.argv.slice(2);
if (shots) mkdirSync(shots, { recursive: true });
const t = target(port);
const A = addresses(port);
const hc = (...a) => execFileSync("lbc", a, { env: scratchEnv(port), encoding: "utf8" });
const fixture = new URL("../scripts/dev-fixture.sh", import.meta.url).pathname;
const run = Date.now().toString(36); // a run that crashed leaves its terminals, and a name can't be reused while they live
const agent = (name, mode) => JSON.parse(hc("run", "--bg", "--no-parent", "--json", "--name", `${name}-${run}`, "--label", "lumbridge.seen=0", fixture, "--agent", mode)).address;
const get = (a) => JSON.parse(hc("get", a, "--json"));
const press = (a, key) => scratchCalls(port, [["terminal.keys", { terminal: a, keys: [key] }]]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(60); } return false; };
const term = (a) => `#/t/${encodeURIComponent(a)}`;
// Chrome's own swipe-back is off: a touch drag from the left edge of a page with nothing to pan left would otherwise go back in
// history, to about:blank for a page this suite opened, and "stays in the terminal" would be testing Chrome, not the app.
const browser = await chromium.launch({ channel: "chrome", args: ["--disable-features=OverscrollHistoryNavigation"] });

const COMBOS = [["iphone", true], ["iphone", false], ["pixel", true], ["pixel", false], ["desktop", true], ["desktop", false]];
const combo = (profile, dark) => `${profile}/${dark ? "dark" : "light"}`;
const open = async (profile, dark, hash, extra = {}) => {
  const p = await openPage(browser, t, profile, { dark, hash, ...extra });
  await p.waitForSelector(".xterm-rows", { timeout: 15000 }).catch(() => {});
  return p;
};
const shot = async (p, name) => { if (shots) { await p.waitForTimeout(200); await p.screenshot({ path: `${shots}/${name}.png` }); } };
const bar = (p) => p.evaluate(() => [...document.querySelectorAll(".keys .key")].map((k) => k.textContent));
const barIs = (p, want) => bar(p).then((b) => b.slice(0, want.length).join() === want.join());
const NORMAL = ["Esc", "↑", "↓", "Enter", "Tab", "←", "→", "Space", "⌫", "⇧Tab", "Ctrl-C", "Ctrl-D", "Ctrl-O", "Ctrl-R", "Ctrl-L"];
const rects = (p) => p.evaluate(() => [...document.querySelectorAll(".keys .key")].map((k) => { const r = k.getBoundingClientRect(); return `${k.textContent}@${Math.round(r.left)},${Math.round(r.width)}`; }).join(" "));
/** Same keys in the same places. Within a pixel: a fallback font for a glyph like ⇧ can settle a fraction of one, once, as a page loads. */
const sameKeys = (x, y) => {
  const parse = (r) => r.split(" ").map((k) => { const [label, at] = k.split("@"); const [left, w] = at.split(",").map(Number); return { label, left, w }; });
  const [a, b] = [parse(x), parse(y)];
  return a.length === b.length && a.every((k, i) => k.label === b[i].label && Math.abs(k.left - b[i].left) <= 1 && Math.abs(k.w - b[i].w) <= 1);
};
const isTouch = (profile) => profile !== "desktop";
/** Tapping as this device does: a real touch on a phone, the mouse on a computer. */
const tap = async (p, profile, selector) => {
  const loc = p.locator(selector).first();
  await loc.scrollIntoViewIfNeeded();
  if (isTouch(profile)) await loc.tap(); else await loc.click();
};

// ---- the key bar follows the terminal ----
const twoChoices = agent("verify-two", "two-choices");
const lateMenu = agent("verify-late", "late-menu");
// Its own, because answer-verify answers the fixture's. Answering this one is left to nobody: it stays blocked throughout.
const menuAgent = agent("verify-menu", "permission");
await until(() => get(menuAgent).status?.state === "blocked", 15000);
for (const [profile, dark] of COMBOS) {
  const name = combo(profile, dark);
  const p = await open(profile, dark, term(menuAgent));
  check(`${name}: a 3-choice menu: 1, 2, 3, Esc, Enter first`, await until(() => barIs(p, ["1", "2", "3", "Esc", "Enter"])), (await bar(p)).join(" "));
  const all = await bar(p);
  check(`${name}: and no number it doesn't have`, !all.includes("4") && !all.includes("5"), all.join(" "));
  check(`${name}: and the rest are still along the bar`, NORMAL.every((k) => all.includes(k)) && new Set(all).size === all.length, all.join(" "));
  const label = await p.locator('.keys .key:has-text("1")').first().getAttribute("aria-label");
  check(`${name}: a number key says what it answers`, label === "Press 1: Yes", label);
  const small = await p.evaluate(() => [...document.querySelectorAll(".keys .key, .composer .talk, .composer .send, .term-head .iconbtn")].filter((b) => { const r = b.getBoundingClientRect(), min = (matchMedia("(pointer: fine)").matches && innerWidth >= 900 ? 36 : 44) - 0.5; return r.height < min || r.width < min; }).map((b) => { const r = b.getBoundingClientRect(); return `${b.getAttribute("aria-label")} ${r.width}x${r.height}`; }));
  check(`${name}: every key and button is 44 px on touch, 36 on a desktop`, small.length === 0, small.join());
  check(`${name}: the status word is on screen, whatever the folder's length`, await p.evaluate(() => { const s = document.querySelector(".title .meta-state").getBoundingClientRect(), m = document.querySelector(".title .meta").getBoundingClientRect(); return s.width > 0 && s.right <= m.right + 1 && document.querySelector(".title .meta").textContent.startsWith("Waiting"); }));
  check(`${name}: nothing runs off the side of the page`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await shot(p, `term-blocked-${profile}-${dark ? "dark" : "light"}`);
  await p.context().close();

  const q = await open(profile, dark, term(A["acme-api"]));
  check(`${name}: otherwise: the keys for moving around, in order, no numbers`, (await bar(q)).join() === NORMAL.join(), (await bar(q)).join(" "));
  await q.evaluate(() => Promise.race([new Promise((r) => setTimeout(r, 1000)), Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})))])); // the slide in has to end first; a pulsing dot never does
  const before = await rects(q);
  await q.evaluate(() => { window.__m = 0; new MutationObserver((m) => { window.__m += m.length; }).observe(document.querySelector(".keys"), { childList: true }); });
  await sleep(2500); // acme-api streams all through this
  check(`${name}: a busy terminal never moves a key`, (await q.evaluate(() => window.__m)) === 0 && sameKeys(await rects(q), before), `${await q.evaluate(() => window.__m)} ${before} / ${await rects(q)}`);
  await shot(q, `term-stream-${profile}-${dark ? "dark" : "light"}`);
  await q.context().close();
}
{
  const p = await open("iphone", true, term(twoChoices));
  check("a 2-choice menu: 1, 2, Esc, Enter, and no 3", await until(() => barIs(p, ["1", "2", "Esc", "Enter"])) && !(await bar(p)).includes("3"), (await bar(p)).join(" "));
  await shot(p, "term-two-choices");
  await p.context().close();
  // A menu that paints after its status: what askOf read was too early, and the screen itself has it.
  const q = await open("pixel", true, term(lateMenu));
  await until(async () => get(lateMenu).status?.state === "blocked");
  check("a menu painted after its status still reaches the bar, 4 choices", await until(() => barIs(q, ["1", "2", "3", "4", "Esc", "Enter"]), 8000), (await bar(q)).join(" "));
  await q.context().close();
  hc("kill", twoChoices); hc("kill", lateMenu);
}

// ---- never under a thumb ----
for (const profile of ["iphone", "pixel"]) {
  const a = agent(`verify-held-${profile}`, "permission");
  const p = await open(profile, true, term(a));
  await until(() => barIs(p, ["1", "2", "3", "Esc", "Enter"]), 10000);
  await sleep(1700); // past the moment of opening: from here the owner might be aiming
  const box = await p.locator('.keys .key:has-text("Esc")').boundingBox();
  const cdp = await p.context().newCDPSession(p);
  const before = await rects(p);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
  press(a, "3"); // answered from elsewhere while the owner's finger is down
  await until(() => get(a).status?.state === "idle");
  await sleep(900);
  check(`${profile}: the state changed while the owner's finger was on the bar: nothing moved`, sameKeys(await rects(p), before), await rects(p));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  check(`${profile}: and it changes after the owner lets go`, await until(() => barIs(p, ["Esc", "↑", "↓", "Enter", "Tab"]), 3000), (await bar(p)).join(" "));
  await p.context().close();
  hc("kill", a);
}
{
  // An armed Ctrl-C is a pending second tap.
  const a = agent("verify-armed", "permission");
  const p = await open("iphone", true, term(a));
  await until(() => barIs(p, ["1", "2", "3", "Esc", "Enter"]), 10000);
  await sleep(1700);
  const ctrl = p.locator('.key.danger').first();
  await ctrl.scrollIntoViewIfNeeded();
  const w0 = (await ctrl.boundingBox());
  const next0 = (await p.locator('.key.danger').nth(1).boundingBox()).x;
  await ctrl.tap();
  await sleep(100);
  const w1 = (await ctrl.boundingBox());
  check("arming Ctrl-C shows Again? and doesn't change its width or move its neighbour", (await ctrl.textContent()) === "Again?" && Math.abs(w0.width - w1.width) < 0.5 && Math.abs((await p.locator('.key.danger').nth(1).boundingBox()).x - next0) < 0.5, `${w0.width} -> ${w1.width}`);
  await shot(p, "term-armed");
  const armedAt = await rects(p);
  press(a, "3");
  await until(() => get(a).status?.state === "idle");
  await sleep(500);
  check("the state changing doesn't move an armed key", sameKeys(await rects(p), armedAt) && (await ctrl.textContent()) === "Again?");
  check("the bar changes once it's disarmed", await until(() => barIs(p, ["Esc", "↑", "↓", "Enter", "Tab"]), 5000), (await bar(p)).join(" "));
  await p.context().close();
  hc("kill", a);
}
{
  // Ctrl-D's two taps, for real: cat ends on it.
  const a = JSON.parse(hc("run", "--bg", "--no-parent", "--json", "--name", `verify-ctrl-d-${run}`, "--label", "lumbridge.seen=0", "bash", "-c", "cat; echo cat-ended; sleep 100000")).address;
  const p = await open("pixel", true, term(a));
  const d = p.locator('.keys [aria-label="Control D"]');
  await d.scrollIntoViewIfNeeded();
  await d.tap();
  await sleep(400);
  check("one tap on Ctrl-D sends nothing", !hc("read", a).includes("cat-ended"));
  await d.tap();
  check("two taps send it", await until(() => hc("read", a).includes("cat-ended"), 5000));
  await p.context().close();
  hc("kill", a);
}

// ---- a tap never takes the focus ----
for (const profile of ["iphone", "pixel", "desktop"]) {
  const a = agent(`verify-focus-${profile}`, "chat");
  const p = await open(profile, true, term(a));
  await p.fill(".composer textarea", "half a thought");
  await p.focus(".composer textarea");
  const before = await p.evaluate(() => { const v = visualViewport; return v.height; });
  for (const k of ["Esc", "↑", "Enter", "Tab"]) {
    await tap(p, profile, `.keys .key:text-is("${k}")`);
    const still = await p.evaluate(() => document.activeElement?.tagName === "TEXTAREA" && document.querySelector(".composer textarea").value === "half a thought");
    check(`${profile}: ${k} leaves the box focused, so the keyboard stays`, still);
  }
  check(`${profile}: and the screen doesn't jump`, (await p.evaluate(() => visualViewport.height)) === before);
  await p.context().close();
  hc("kill", a);
}

// ---- the send and mic buttons, the toast, a wide pane ----
for (const [profile, dark] of COMBOS) {
  const name = combo(profile, dark);
  const p = await open(profile, dark, term(A["acme-api"]));
  const bg = () => p.evaluate(() => getComputedStyle(document.querySelector(".send")).backgroundColor);
  const accent = await p.evaluate(() => { const e = document.createElement("div"); e.style.color = "var(--accent)"; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; });
  check(`${name}: send is quiet with nothing to send`, (await bg()) !== accent, await bg());
  await p.fill(".composer textarea", "x");
  await sleep(180);
  check(`${name}: and red when there is`, (await bg()) === accent, await bg());
  await p.fill(".composer textarea", "");
  // Scrolled back, so the jump button is up: the toast must be clear of it, the composer and the owner's thumb.
  await p.evaluate(() => { document.querySelector(".screen").scrollTop -= 400; });
  await p.waitForSelector(".jump:not([hidden])");
  await p.locator(".composer .talk").click();
  await p.waitForSelector(".term-toast:not([hidden])");
  const r = await p.evaluate(() => { const box = (s) => document.querySelector(s).getBoundingClientRect(); const t = box(".term-toast"), j = box(".jump"), b = box(".term-body"); return { clear: t.bottom < j.top || t.top > j.bottom || t.right < j.left || t.left > j.right, top: t.top - b.top, height: b.height, within: t.left >= b.left && t.right <= b.right }; });
  check(`${name}: the toast is at the top, clear of the jump button`, r.clear && r.top < 40 && r.within, JSON.stringify(r));
  await shot(p, `term-toast-${profile}-${dark ? "dark" : "light"}`);
  await p.context().close();
}
{
  const p = await open("iphone", true, term(A["gateway-review"]));
  await sleep(500);
  const more = () => p.evaluate(() => document.querySelector(".term-body").classList.contains("more-right"));
  check("a wide pane shows there's more to the right", await more());
  await p.evaluate(() => { const s = document.querySelector(".screen"); s.scrollLeft = s.scrollWidth; });
  check("and stops at its right edge", await until(async () => !(await more()), 1500));
  await p.evaluate(() => { document.querySelector(".screen").scrollLeft = 0; });
  await p.click('[aria-label="View options"]');
  await p.click(".seg-btn:nth-child(2)");
  check("Fit has nothing off to the right", await until(async () => !(await more()), 1500));
  await p.click(".seg-btn:nth-child(3)");
  await sleep(200);
  check("Read neither", !(await more()));
  await p.click(".seg-btn:nth-child(1)");
  await p.evaluate(() => localStorage.removeItem("lumbridge.view"));
  await p.context().close();
}

// ---- haptics, where there are any ----
{
  const ctx = await browser.newContext({ ...PROFILES.pixel, colorScheme: "dark" });
  await ctx.addInitScript((tok) => { localStorage.setItem("lumbridge.token", tok); window.__buzz = []; navigator.vibrate = (ms) => { window.__buzz.push(ms); return true; }; }, t.token);
  const p = await ctx.newPage();
  const a = agent("verify-haptic", "chat");
  await p.goto(t.base + term(a));
  await p.waitForSelector(".xterm-rows");
  const buzzes = () => p.evaluate(() => window.__buzz.length);
  await p.locator('.keys .key:text-is("Tab")').tap();
  check("a key press buzzes, lightly", (await buzzes()) === 1 && (await p.evaluate(() => window.__buzz[0])) <= 10);
  await p.fill(".composer textarea", "hello");
  await p.locator(".send").tap();
  check("sending buzzes", (await buzzes()) === 2);
  hc("kill", a);
  const asker = agent("verify-haptic-2", "permission");
  await p.goto(`${t.base}#/agents`);
  const choice = p.locator(`.row[data-address="${asker}"] .choice`).first();
  await choice.waitFor({ timeout: 10000 });
  await p.evaluate(() => { window.__buzz = []; });
  await choice.tap();
  check("arming an answer doesn't buzz: nothing has been sent", (await buzzes()) === 0);
  await choice.tap();
  check("answering does", await until(async () => (await buzzes()) === 1));
  await ctx.close();
  hc("kill", asker);

  // No vibrate at all, as on iOS.
  const wk = await webkit.launch();
  const wctx = await wk.newContext({ ...PROFILES.iphone, colorScheme: "dark" });
  const q = await wctx.newPage();
  const errors = [];
  q.on("pageerror", (e) => errors.push(e.message));
  await q.addInitScript((tok) => localStorage.setItem("lumbridge.token", tok), t.token);
  const c = agent("verify-haptic-3", "chat");
  await q.goto(t.base + term(c));
  await q.waitForSelector(".xterm-rows");
  check("WebKit really has no vibrate", await q.evaluate(() => !navigator.vibrate));
  await q.locator('.keys .key:text-is("Tab")').tap();
  await q.fill(".composer textarea", "hello");
  await q.locator(".send").tap();
  await sleep(300);
  check("and keys and send still work there, no errors", errors.length === 0, errors.join("; "));
  await wk.close();
  hc("kill", c);
}

// ---- moving between the list and a terminal ----
/** Listens from the moment of the call, so a slow check can't miss a 200 ms animation. */
const recordSlides = (p) => p.evaluate(() => {
  window.__slides = [];
  if (window.__listening) return;
  window.__listening = true;
  document.addEventListener("animationstart", (e) => { if (["push-in", "pull-back"].includes(e.animationName)) window.__slides.push({ on: e.target.className, name: e.animationName, ms: Math.round(parseFloat(getComputedStyle(e.target).animationDuration) * 1000) }); }, true);
});
const slide = async (p, cls) => { await sleep(90); return p.evaluate((cls) => window.__slides.find((s) => s.on === cls) ?? null, cls); };
for (const profile of ["iphone", "pixel"]) {
  const p = await open(profile, true, "#/agents");
  await p.evaluate(() => { document.querySelector(".master").scrollTop = 220; });
  const y = await p.evaluate(() => document.querySelector(".master").scrollTop);
  await recordSlides(p);
  await p.evaluate((h) => { location.hash = h; }, term(A["acme-api"]));
  await p.waitForFunction(() => document.querySelector(".shell").dataset.mode === "detail");
  const fwd = await slide(p, "detail");
  check(`${profile}: opening a terminal slides, briefly`, fwd?.name === "push-in" && fwd.ms > 0 && fwd.ms <= 250, JSON.stringify(fwd));
  await p.waitForSelector(".xterm-rows");
  await sleep(350);
  // What Safari's and Android's own edge gestures do: go back in history.
  await recordSlides(p);
  await p.goBack();
  await p.waitForFunction(() => document.querySelector(".shell").dataset.mode === "list");
  const back = await slide(p, "agents-col");
  check(`${profile}: the browser's back returns to the list, sliding the other way`, back?.name === "pull-back" && back.ms <= 250, JSON.stringify(back));
  check(`${profile}: at the same place in the list`, await p.evaluate(() => document.querySelector(".master").scrollTop) === y, String(y));
  await sleep(300);
  check(`${profile}: and it lands square`, await p.evaluate(() => { const r = document.querySelector(".master").getBoundingClientRect(); return Math.abs(r.left) < 1 && getComputedStyle(document.querySelector(".master")).opacity === "1"; }));
  // A tab change isn't going back.
  await p.evaluate(() => { location.hash = "#/panes"; });
  await sleep(100);
  await recordSlides(p);
  await p.evaluate(() => { location.hash = "#/agents"; });
  await p.waitForFunction(() => document.querySelector(".shell").dataset.mode === "list");
  check(`${profile}: changing tabs doesn't slide`, (await slide(p, "agents-col")) === null);

  // From Panes, and back to Panes.
  await p.evaluate(() => { location.hash = "#/panes"; });
  await sleep(200);
  await p.evaluate((h) => { location.hash = h; }, term(A["acme-api"]));
  await p.waitForFunction(() => document.querySelector(".shell").dataset.mode === "detail");
  await sleep(350);
  await recordSlides(p);
  await p.locator(".term-head .back").tap();
  await p.waitForFunction(() => location.hash === "#/panes");
  check(`${profile}: back from a terminal opened in Panes goes to Panes, sliding`, (await slide(p, "agents-col"))?.name === "pull-back", await p.evaluate(() => JSON.stringify(window.__slides)));
  await p.context().close();
}
{
  const p = await open("desktop", true, "#/agents");
  await recordSlides(p);
  await p.evaluate((h) => { location.hash = h; }, term(A["acme-api"]));
  await p.waitForSelector(".xterm-rows");
  check("computer: side by side, so nothing slides", (await slide(p, "detail")) === null);
  await p.keyboard.press("Escape");
  await p.waitForFunction(() => location.hash === "#/agents");
  check("computer: nor on leaving", (await slide(p, "agents-col")) === null);
  await p.context().close();
}
// Reduced motion: style.css takes the animation away. Everything must simply be there, nothing waiting on an event that won't come.
for (const profile of ["iphone", "pixel"]) {
  const p = await open(profile, true, "#/agents", { reducedMotion: "reduce" });
  await p.evaluate((h) => { location.hash = h; }, term(menuAgent));
  await p.waitForFunction(() => document.querySelector(".shell").dataset.mode === "detail");
  const opened = await p.evaluate(() => { const d = document.querySelector(".detail"); const r = d.getBoundingClientRect(); return { n: d.getAnimations().length, left: r.left, o: getComputedStyle(d).opacity }; });
  check(`${profile}: reduced motion: the terminal is simply there`, opened.n === 0 && opened.left === 0 && opened.o === "1", JSON.stringify(opened));
  check(`${profile}: and works`, await until(() => barIs(p, ["1", "2", "3", "Esc", "Enter"])));
  await p.goBack();
  await p.waitForFunction(() => document.querySelector(".shell").dataset.mode === "list");
  check(`${profile}: reduced motion: the list is simply back`, await p.evaluate(() => document.querySelector(".master").getAnimations().length === 0 && document.querySelector(".master").getBoundingClientRect().left === 0));
  await p.context().close();
}
// On a phone-speed CPU, the slide is one uninterrupted movement. Timed, so only on a quiet host (tests/quiet-host.mjs); one run each.
const SLIDE_IN = "slide in: no frame over 150 ms on a 4x slower CPU", SLIDE_BACK = "slide back: no frame over 120 ms on a 4x slower CPU";
await group("slide at 4x CPU", {
  judged: "a single run",
  names: () => [SLIDE_IN, SLIDE_BACK],
  async run() {
    const p = await open("iphone", true, "#/agents");
    await sleep(1500); // xterm's chunk is fetched by now, as it is on a phone a moment after opening
    const cdp = await p.context().newCDPSession(p);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const during = (hash) => p.evaluate((hash) => new Promise((done) => {
      const gaps = [];
      let last = performance.now();
      const start = last;
      const loop = (now) => { gaps.push(Math.round(now - last)); last = now; if (now - start < 400) requestAnimationFrame(loop); else done({ frames: gaps.length, worst: Math.max(...gaps), first: gaps.slice(0, 3) }); };
      requestAnimationFrame((now) => { last = now; location.hash = hash; requestAnimationFrame(loop); });
    }), hash);
    let host = meter();
    const go = await during(term(A["acme-api"]));
    const goHost = host();
    console.log("slide in, 4x slower CPU:", JSON.stringify(go), said(goHost));
    await sleep(800);
    host = meter();
    const back = await during("#/agents");
    const backHost = host();
    console.log("slide back, 4x slower CPU:", JSON.stringify(back), said(backHost));
    await p.context().close();
    return {
      checks: [{ name: SLIDE_IN, ok: go.worst < 150, extra: String(go.worst), timed: true }, { name: SLIDE_BACK, ok: back.worst < 120, extra: String(back.worst), timed: true }],
      runs: [goHost, backHost],
    };
  },
});

// ---- the left edge belongs to panning ----
for (const profile of ["iphone", "pixel"]) {
  const p = await open(profile, true, term(A["gateway-review"]));
  await sleep(500);
  const hash = await p.evaluate(() => location.hash);
  const b = await p.locator(".screen").boundingBox();
  const cdp = await p.context().newCDPSession(p);
  const drag = async (fromX) => {
    const y = b.y + b.height / 2;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: fromX, y }] });
    for (let i = 1; i <= 8; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: fromX + i * 25, y }] }); await sleep(16); }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(350);
  };
  await p.evaluate(() => { document.querySelector(".screen").scrollLeft = 300; });
  await sleep(80);
  await drag(4);
  const left = await p.evaluate(() => document.querySelector(".screen").scrollLeft);
  check(`${profile}: a drag from the very edge pans a panned wide terminal`, left < 300, String(left));
  check(`${profile}: and stays in the terminal`, (await p.evaluate(() => location.hash)) === hash);
  await p.evaluate(() => { document.querySelector(".screen").scrollLeft = 0; });
  await sleep(80);
  await drag(4);
  check(`${profile}: from a terminal panned fully left too`, (await p.evaluate(() => location.hash)) === hash);
  await p.evaluate(() => localStorage.removeItem("lumbridge.view"));
  await p.context().close();
}

// ---- page titles: one size everywhere ----
for (const profile of ["iphone", "pixel", "desktop"]) {
  const p = await open(profile, true, "#/agents");
  const sizes = {};
  for (const r of ["agents", "panes", "assistant", "notes", "tasks", ...(EXT ? ["infra"] : []), "settings"]) {
    await p.evaluate((r) => { location.hash = `#/${r}`; }, r);
    await p.waitForFunction((r) => location.hash === `#/${r}`, r);
    const titleOf = r === "agents" || r === "panes" ? ".agents-top h1" : ".view h1";
    await p.waitForSelector(titleOf, { timeout: 8000 }).catch(() => {});
    await sleep(120);
    sizes[r] = await p.evaluate((r) => { const h = document.querySelector(r === "agents" || r === "panes" ? ".agents-top h1" : ".view h1"); return h ? { s: getComputedStyle(h).fontSize, w: getComputedStyle(h).fontWeight, top: Math.round(h.getBoundingClientRect().top) } : null; }, r);
  }
  const all = Object.values(sizes);
  check(`${profile}: every title is the same size and weight`, all.every((x) => x && x.s === "24px" && x.w === "700"), JSON.stringify(sizes));
  const tops = all.map((x) => x?.top ?? 0);
  check(`${profile}: and sits at about the same height`, Math.max(...tops) - Math.min(...tops) <= 8, tops.join());
  if (profile === "iphone") {
    await p.evaluate(() => { location.hash = "#/agents"; });
    await shot(p, "title-agents");
  }
  await p.context().close();
}

hc("kill", menuAgent);
await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
