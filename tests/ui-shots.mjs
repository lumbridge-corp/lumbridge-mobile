// Screenshots of every screen and state: node tests/ui-shots.mjs <port> <outdir>
import { addresses, chromium, open, PROFILES, shooter, target } from "./ui-lib.mjs";
const [port, out] = process.argv.slice(2);
const t = target(port);
const A = addresses(port);
const shot = shooter(out);
const browser = await chromium.launch({ channel: "chrome" });
const term = (name) => `#/t/${encodeURIComponent(name)}`;
const ready = async (p) => { await p.waitForSelector(".xterm-rows"); await p.waitForTimeout(700); };

for (const [profile, tag] of [["iphone", "ios"], ["pixel", "pix"]]) {
  const p = await open(browser, t, profile);
  await shot(p, `${tag}-agents`);
  if (tag === "ios") {
    await p.evaluate(() => { document.querySelector(".master").scrollTop = 99999; });
    await shot(p, `${tag}-agents-scrolled`);
    await p.evaluate(() => { document.querySelector(".master").scrollTop = 0; });
    await p.click(".chip[data-m=rig]"); await shot(p, `${tag}-agents-filter`);
    await p.click(".chip[data-m=all]");
    await p.click(".inbox-head button.iconbtn"); await shot(p, `${tag}-agents-grouped`);
    await p.click(".inbox-head button.iconbtn");
    const row = p.locator(".row.needs .row-main").first();
    const b = await row.boundingBox();
    await p.touchscreen.tap(b.x + 100, b.y + 10);
    await p.waitForSelector(".term");
    await p.goBack();
    // long-press
    const cdp = await p.context().newCDPSession(p);
    const x = b.x + 100, y = b.y + 20;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await p.waitForTimeout(600);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await p.waitForSelector(".sheet");
    await shot(p, `${tag}-menu`);
    await p.click(".sheet-cancel");
  }
  for (const [name, addr] of [["blocked", A["gateway-review"]], ["question", A["pr-branch"]], ["stream", A["acme-api"]], ["error", A["ci-gateway"]], ["narrow", A["web-tests"]], ["alt", A.top]]) {
    if (tag === "pix" && name !== "blocked") continue;
    const q = await open(browser, t, profile, { hash: term(addr) });
    await ready(q);
    await shot(q, `${tag}-term-${name}`);
    if (name === "blocked" && tag === "ios") {
      await q.click('[aria-label="View options"]'); await shot(q, `${tag}-term-panel`);
      await q.click(".seg-btn:nth-child(2)"); await q.click('[aria-label="View options"]'); await shot(q, `${tag}-term-fit`);
      await q.click('[aria-label="View options"]'); await q.click(".seg-btn:nth-child(3)"); await q.click('[aria-label="View options"]'); await shot(q, `${tag}-term-read`);
      await q.click('[aria-label="View options"]'); await q.click(".seg-btn:nth-child(1)"); await q.click('[aria-label="View options"]');
      await q.evaluate(() => { const s = document.querySelector(".screen"); s.scrollTop = 300; });
      await shot(q, `${tag}-term-scrolledup`);
      await q.click(".key.danger"); await shot(q, `${tag}-term-armed`);
      await q.fill(".composer textarea", "Please also add a test for the refused origin case, and keep it next to the others\nsecond line\nthird line");
      await shot(q, `${tag}-term-composer`);
      await q.fill(".composer textarea", "");
    }
    await q.context().close();
  }
  for (const v of ["assistant", "notes", "tasks", "settings"]) { if (tag === "ios") { await p.goto(t.base + `#/${v}`); await shot(p, `${tag}-${v}`); } }
  await p.context().close();
}
{
  const p = await open(browser, t, "iphone", { dark: false });
  await shot(p, "ios-light-agents");
  const q = await open(browser, t, "iphone", { dark: false, hash: term(A["gateway-review"]) });
  await ready(q); await shot(q, "ios-light-term");
  await p.context().close(); await q.context().close();
}
{
  const p = await open(browser, t, "desktop");
  await shot(p, "desk-agents");
  await p.keyboard.press("j"); await p.keyboard.press("j");
  await shot(p, "desk-cursor");
  await p.keyboard.press("Enter"); await ready(p); await shot(p, "desk-master-detail");
  await p.click(`.row[data-address="${A['acme-api']}"] .row-main`); await ready(p); await shot(p, "desk-stream");
  await p.click('[aria-label="View options"]'); await shot(p, "desk-panel");
  await p.click('[aria-label="View options"]');
  const row = p.locator(".row").nth(3);
  await row.click({ button: "right" }); await shot(p, "desk-menu");
  await p.keyboard.press("Escape");
  await p.context().close();
  const l = await open(browser, t, "desktop", { dark: false, hash: term(A["gateway-review"]) });
  await ready(l); await shot(l, "desk-light");
  await l.context().close();
}
{
  const wide = await browser.newContext({ viewport: { width: 2560, height: 1440 }, colorScheme: "dark" });
  const p = await wide.newPage();
  await p.addInitScript((tok) => localStorage.setItem("lumbridge.token", tok), t.token);
  await p.goto(t.base + term(A["gateway-review"]));
  await ready(p); await shot(p, "wide-2560");
  await wide.close();
}
{
  // Before the first connection, and with the connection gone.
  const ctx = await browser.newContext({ ...PROFILES.iphone, colorScheme: "dark" });
  let block = true;
  const socks = new Set();
  await ctx.routeWebSocket(/\/ws$/, (ws) => {
    if (block) { ws.close({ code: 1011 }); return; }
    const s = ws.connectToServer(); socks.add(ws);
    ws.onMessage((m) => s.send(m)); s.onMessage((m) => ws.send(m));
    ws.onClose(() => s.close()); s.onClose(() => ws.close());
  });
  const p = await ctx.newPage();
  await p.addInitScript((tok) => localStorage.setItem("lumbridge.token", tok), t.token);
  await p.goto(t.base + "#/agents");
  await p.waitForTimeout(1600);
  await shot(p, "ios-connecting");
  block = false;
  await p.waitForSelector(".row", { timeout: 20000 });
  await p.goto(t.base + term(A["gateway-review"]));
  await ready(p);
  block = true;
  for (const s of socks) s.close({ code: 1011 });
  await p.waitForTimeout(1800);
  await shot(p, "ios-reconnecting");
  await ctx.close();
  const none = await browser.newContext({ ...PROFILES.iphone, colorScheme: "dark" });
  const q = await none.newPage();
  await q.goto(t.base);
  await shot(q, "ios-pair");
  await none.close();
}
if (process.argv[4]) {
  const e = target(process.argv[4]);
  const p = await open(browser, e, "iphone");
  await shot(p, "ios-empty");
  await p.context().close();
  const q = await open(browser, e, "desktop");
  await shot(q, "desk-empty");
  await q.context().close();
}
await browser.close();
