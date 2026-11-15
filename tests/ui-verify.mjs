// Behaviour checks against a scratch core with scripts/dev-fixture.sh running: node tests/ui-verify.mjs <port> [--storm]
import { execFileSync } from "node:child_process";
import { check, failed, group, meter, said } from "./quiet-host.mjs";
import { addresses, chromium, webkit, open, target, PROFILES } from "./ui-lib.mjs";

const [port] = process.argv.slice(2);
const t = target(port);
const A = addresses(port);
const d = `/run/user/${process.getuid()}/k${port}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")));
Object.assign(env, { XDG_STATE_HOME: `${d}/s`, XDG_RUNTIME_DIR: d, XDG_CONFIG_HOME: `${d}/c`, XDG_DATA_HOME: `${d}/d`, LBC_SESSION: "k" });
const hc = (...a) => execFileSync("lbc", a, { env, encoding: "utf8" });
const get = (addr) => JSON.parse(hc("get", addr, "--json"));
const size = (addr) => { const x = get(addr); return `${x.cols}x${x.rows}`; };
const fixture = new URL("../scripts/dev-fixture.sh", import.meta.url).pathname;
const agent = (name, mode) => JSON.parse(hc("run", "--bg", "--no-parent", "--json", "--name", name, "--label", "lumbridge.seen=0", fixture, "--agent", mode)).address;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(100); } return false; };
const term = (a) => `#/t/${encodeURIComponent(a)}`;
const browser = await chromium.launch({ channel: "chrome" });
const screenText = (p) => p.evaluate(() => document.querySelector(".xterm-rows")?.textContent ?? "");

/** Puts a controllable pipe between the page and the gateway. */
async function piped(profile, opts = {}) {
  const ctx = await browser.newContext({ ...PROFILES[profile], colorScheme: "dark" });
  const ctl = { conns: 0, refuse: false, stall: false, sockets: new Set() };
  await ctx.routeWebSocket(/\/ws$/, (ws) => {
    if (ctl.refuse) { ws.close({ code: 1011 }); return; }
    ctl.conns++;
    const server = ws.connectToServer();
    ctl.sockets.add(ws);
    ws.onMessage((m) => { if (!ctl.stall || ctl.sockets.size > 1 && ws !== [...ctl.sockets].at(-1)) server.send(m); });
    server.onMessage((m) => { if (!ctl.stall || ws !== ctl.stalled) ws.send(m); });
    ws.onClose(() => { ctl.sockets.delete(ws); server.close(); });
    server.onClose(() => { ctl.sockets.delete(ws); ws.close(); });
  });
  ctl.cut = () => { for (const s of ctl.sockets) s.close({ code: 1011 }); };
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.addInitScript((tok) => localStorage.setItem("lumbridge.token", tok), t.token);
  await page.goto(t.base + (opts.hash ?? "#/agents"));
  return { page, ctl, ctx };
}

// ---- a cold load is small ----
// Measured on a bare start, which is Today.
// The gateway sends the build's .br files (web/scripts/compress.mjs). Counted: everything the page fetched before the idle
// xterm prefetch, as the Resource Timing API saw it. Uncompressed this was 378 KB. No worker: its precache would count twice.
{
  const ctx = await browser.newContext({ ...PROFILES.iphone, colorScheme: "dark", serviceWorkers: "block" });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const encodings = new Map();
  p.on("response", (r) => { if (/\/assets\/.+\.(js|css)$/.test(r.url())) encodings.set(new URL(r.url()).pathname, r.headers()["content-encoding"] ?? "none"); });
  await p.addInitScript((tok) => localStorage.setItem("lumbridge.token", tok), t.token);
  // A bare start: Today, the first screen, with its own asks (For you's chunk, Infra, Tasks) all counted.
  await p.goto(t.base);
  await p.waitForSelector(".td-needs .row", { timeout: 15000 });
  await until(() => p.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("/assets/xterm-"))));
  await sleep(500);
  const r = await p.evaluate(() => {
    const all = [...performance.getEntriesByType("navigation"), ...performance.getEntriesByType("resource")];
    const sum = (es) => es.reduce((n, e) => n + e.transferSize, 0);
    const xterm = all.filter((e) => e.name.includes("/assets/xterm-"));
    return { before: sum(all) - sum(xterm), xterm: sum(xterm), entries: all.length };
  });
  console.log(`cold load: ${(r.before / 1024).toFixed(1)} KB before the xterm prefetch, ${(r.xterm / 1024).toFixed(1)} KB for it`);
  check("a cold load moves at most 170 KB before the xterm prefetch", r.before > 0 && r.before <= 170 * 1024, JSON.stringify(r));
  const plain = [...encodings].filter(([, e]) => e !== "br");
  check("the app's JS and CSS come as brotli", encodings.size >= 4 && plain.length === 0, JSON.stringify([...encodings]));
  check("the app works after a compressed load", await p.locator(".td-needs .row").count() > 0 && await p.locator(".inbox-lists .row").count() > 0);
  check("no page errors on a compressed load", errors.length === 0, errors.join(" | "));
  // The fonts are hashed into /assets, so the gateway's long cache covers them; at /fonts/ they were no-store, fetched on
  // every cold load. The preloads must name the very files style.css asks for, or the font arrives late and moves the header.
  const fonts = await p.evaluate(() => ({
    preloaded: [...document.querySelectorAll('link[rel="preload"][as="font"]')].map((l) => new URL(l.href).pathname).sort(),
    used: [...new Set(performance.getEntriesByType("resource").filter((e) => e.name.endsWith(".woff2")).map((e) => new URL(e.name).pathname))].sort(),
  }));
  check("both fonts are preloaded from hashed /assets paths", fonts.preloaded.length === 2 && fonts.preloaded.every((u) => /^\/assets\/geist(-mono)?-[\w-]+\.woff2$/.test(u)), JSON.stringify(fonts.preloaded));
  check("the page uses exactly the preloaded fonts", JSON.stringify(fonts.used) === JSON.stringify(fonts.preloaded), JSON.stringify(fonts.used));
  for (const u of fonts.preloaded) {
    const res = await fetch(new URL(u, t.base), { method: "HEAD" });
    check(`${u} is cached for good`, res.ok && res.headers.get("cache-control") === "public, max-age=31536000, immutable", `${res.status} ${res.headers.get("cache-control")}`);
  }
  await ctx.close();
}

// ---- rows don't rebuild ----
{
  const p = await open(browser, t, "iphone");
  await p.waitForSelector(".row");
  await p.evaluate(() => {
    window.__rows = new Map([...document.querySelectorAll(".row")].map((r) => [r.dataset.address, r]));
    window.__removed = 0; window.__added = 0; window.__text = 0;
    window.__mo = new MutationObserver((ms) => { for (const m of ms) {
      for (const n of m.addedNodes) if (n.classList?.contains("row")) window.__added++;
      for (const n of m.removedNodes) if (n.classList?.contains("row")) window.__removed++;
      if (m.type === "characterData" || m.type === "childList") window.__text++;
    } });
    window.__mo.observe(document.querySelector(".inbox-lists"), { childList: true, subtree: true, characterData: true });
    document.querySelector(".master").scrollTop = 300;
  });
  await sleep(100);
  await p.evaluate(() => { window.__top = document.querySelector(".master").scrollTop; });
  await sleep(4000); // acme-api streams, its progress changes; everything else sits still
  let r = await p.evaluate(() => ({
    same: [...window.__rows].every(([a, e]) => document.querySelector(`.row[data-address="${a}"]`) === e),
    removed: window.__removed, added: window.__added, top: document.querySelector(".master").scrollTop, top0: window.__top,
  }));
  check("rows keep their elements while events arrive", r.same && r.removed === 0 && r.added === 0, JSON.stringify(r));
  check("scroll position holds while events arrive", r.top === r.top0, `${r.top0} -> ${r.top}`);

  // A row above the view changes bucket, and grows when its question and choices arrive: the rows on screen must not jump.
  await p.evaluate(() => { const m = document.querySelector(".master"); const needs = document.querySelector(".master .group.needs"); m.scrollTop += needs.getBoundingClientRect().bottom - m.getBoundingClientRect().top + 8; });
  await sleep(100);
  const before = await p.evaluate(() => { const top = document.querySelector(".master").getBoundingClientRect().top; const v = [...document.querySelectorAll(".row")].find((e) => e.getBoundingClientRect().top > top + 80); return { a: v.dataset.address, y: v.getBoundingClientRect().top }; });
  const extra = agent("verify-move", "permission");
  await until(() => p.evaluate((a) => !!document.querySelector(`.row.needs[data-address="${a}"]`), extra));
  await until(() => p.evaluate((a) => document.querySelectorAll(`.row[data-address="${a}"] .choice`).length > 0, extra));
  await sleep(200);
  const after = await p.evaluate((a) => document.querySelector(`.row[data-address="${a}"]`).getBoundingClientRect().top, before.a);
  check("a new row above doesn't move what you're looking at", Math.abs(after - before.y) < 2, `${before.a} ${before.y} -> ${after}`);
  const moved = await p.evaluate((a) => window.__rows.get(a) === document.querySelector(`.row[data-address="${a}"]`), A["pr-branch"]);
  check("a row keeps its element when others are inserted", moved);
  hc("kill", extra);
  await until(() => p.evaluate((a) => !document.querySelector(`.row[data-address="${a}"]`), extra));

  // pin via long-press menu
  await p.evaluate(() => { document.querySelector(".master").scrollTop = 0; });
  await sleep(100);
  const pinTarget = A["pr-branch"];
  const box = await p.locator(`.row[data-address="${pinTarget}"] .row-main`).boundingBox();
  const cdp = await p.context().newCDPSession(p);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 90, y: box.y + 20 }] });
  await sleep(600);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await p.waitForSelector(".sheet");
  check("long press opens the menu, and doesn't navigate", (await p.evaluate(() => location.hash)) === "#/agents");
  await p.click('.sheet-item:has-text("Pin to top")');
  check("pin writes the shared label", await until(() => get(pinTarget).labels["lumbridge.pinned"] === "1"));
  check("pin shows on the row", await until(() => p.evaluate((a) => !document.querySelector(`.row[data-address="${a}"] .row-pin`).hidden, pinTarget)));
  hc("label", pinTarget, "lumbridge.pinned=");
  check("labels from elsewhere reach the row", await until(() => p.evaluate((a) => document.querySelector(`.row[data-address="${a}"] .row-pin`).hidden, pinTarget)));
  check("no page errors on the inbox", p.errors.length === 0, p.errors.join("; "));
  check("no sideways page scroll on a phone", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await p.context().close();
}

// ---- watching never resizes ----
{
  const addrs = [A["gateway-review"], A["acme-api"], A["ci-gateway"], A["web-tests"]];
  const sizes = Object.fromEntries(addrs.map((a) => [a, size(a)]));
  for (const profile of ["iphone", "pixel"]) {
    for (const a of addrs) {
      const p = await open(browser, t, profile, { hash: term(a) });
      await p.waitForSelector(".xterm-rows");
      await sleep(500);
      await p.click('[aria-label="View options"]');
      await p.click(".seg-btn:nth-child(2)");
      await sleep(200);
      await p.click(".seg-btn:nth-child(1)");
      await p.click(".stepper-btn:last-child");
      await sleep(200);
      await p.context().close();
    }
  }
  const after = Object.fromEntries(addrs.map((a) => [a, size(a)]));
  check("a phone attach never changes cols/rows", JSON.stringify(sizes) === JSON.stringify(after), JSON.stringify(after));
}

// ---- reconnect keeps the screen ----
{
  const chat = agent("verify-chat", "chat");
  const sizeBefore = size(chat);
  const { page: p, ctl, ctx } = await piped("iphone", { hash: term(chat) });
  await p.waitForSelector(".xterm-rows");
  await until(async () => (await screenText(p)).includes("Ready"));
  await p.fill(".composer textarea", "half a thought");
  await p.evaluate(() => { window.__term = document.querySelector(".term"); window.__shell = document.querySelector(".shell"); });
  ctl.refuse = true;
  ctl.cut();
  await sleep(400);
  const quiet = await p.evaluate(() => document.querySelector(".conn").hidden);
  check("a short blip shows nothing", quiet);
  check("banner appears when it lasts", await until(() => p.evaluate(() => !document.querySelector(".conn").hidden), 4000));
  let same = await p.evaluate(() => ({
    term: window.__term === document.querySelector(".term"), shell: window.__shell === document.querySelector(".shell"),
    text: document.querySelector(".xterm-rows").textContent.includes("Ready"), draft: document.querySelector(".composer textarea").value, hash: location.hash,
    banner: document.querySelector(".conn").textContent,
  }));
  check("losing the connection keeps the screen, text and draft", same.term && same.shell && same.text && same.draft === "half a thought", JSON.stringify(same));
  await sleep(1500);
  ctl.refuse = false;
  check("banner clears after reconnecting", await until(() => p.evaluate(() => document.querySelector(".conn").hidden), 15000));
  await sleep(300); // the repaint lands a moment after the banner clears
  same = await p.evaluate(() => ({ term: window.__term === document.querySelector(".term"), text: document.querySelector(".xterm-rows").textContent.includes("Ready") }));
  check("the same screen is still there after reconnecting", same.term && same.text, JSON.stringify(same));
  hc("send", chat, "after reconnect");
  check("the terminal re-attached: new output arrives", await until(async () => (await screenText(p)).includes("You said: after reconnect")));
  check("reconnect didn't resize", size(chat) === sizeBefore, sizeBefore);

  // A dead socket that still looks open, found on resume.
  const conns = ctl.conns;
  await p.evaluate(() => {
    window.__sawBanner = false;
    new MutationObserver(() => { if (!document.querySelector(".conn").hidden) window.__sawBanner = true; }).observe(document.querySelector(".conn"), { attributes: true });
    let hidden = false;
    Object.defineProperty(document, "hidden", { get: () => hidden, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => (hidden ? "hidden" : "visible"), configurable: true });
    window.__setHidden = (h) => { hidden = h; document.dispatchEvent(new Event("visibilitychange")); };
    window.__setHidden(true);
  });
  ctl.stall = true; ctl.stalled = [...ctl.sockets][0];
  await sleep(3200);
  ctl.stall = false;
  const old = ctl.stalled;
  ctl.stalled = null;
  await p.evaluate(() => {});
  // Silence it for good from here: this socket's frames no longer pass.
  ctl.stall = true; ctl.stalled = old;
  const t0 = Date.now();
  await p.evaluate(() => window.__setHidden(false));
  check("on resume a dead socket is replaced", await until(() => ctl.conns > conns, 6000), `${Date.now() - t0} ms`);
  check("and quietly: no banner", !(await p.evaluate(() => window.__sawBanner)));
  ctl.stall = false;
  hc("send", chat, "after resume");
  check("output flows after resume", await until(async () => (await screenText(p)).includes("You said: after resume")));
  check("no page errors through all of that", p.errors.length === 0, p.errors.join("; "));
  await ctx.close();
  hc("kill", chat);
}

// ---- stream closes, restarted ----
{
  const chat = agent("verify-end", "chat");
  const p = await open(browser, t, "iphone", { hash: term(chat) });
  await p.waitForSelector(".xterm-rows");
  await until(async () => (await screenText(p)).includes("Ready"));
  hc("kill", chat);
  check("an ended terminal says so and keeps its last screen", await until(() => p.evaluate(() => !document.querySelector(".term-note").hidden && document.querySelector(".xterm-rows").textContent.includes("Ready"))));
  check("and can't be typed at", await p.evaluate(() => document.querySelector(".composer textarea").disabled));
  await p.context().close();
  try { hc("rm", chat); } catch {}

  const kept = JSON.parse(hc("run", "--bg", "--no-parent", "--keep", "--json", "--name", "verify-kept", "bash", "-c", "echo first-life; exec sleep 100000")).address;
  const q = await open(browser, t, "iphone", { hash: term(kept) });
  await q.waitForSelector(".xterm-rows");
  await until(async () => (await screenText(q)).includes("first-life"));
  const pid = get(kept).pid;
  process.kill(pid, "SIGKILL");
  const restarted = await until(() => { const x = get(kept); return !!x.pid && x.pid !== pid; }, 15000);
  check("kept terminal restarted in the fixture", restarted);
  hc("send", kept, "echo second-life-$((40+2))");
  check("restarted: re-attached to the new shell", await until(async () => (await screenText(q)).includes("second-life-42"), 12000));
  await q.context().close();
  hc("kill", kept);
}

// ---- reading: follow, jump, size, memory ----
{
  const stream = A["acme-api"];
  const p = await open(browser, t, "iphone", { hash: term(stream) });
  await p.waitForSelector(".xterm-rows");
  await sleep(800);
  const atEnd = () => p.evaluate(() => { const s = document.querySelector(".screen"); return s.scrollTop; });
  const y0 = await atEnd();
  await sleep(3000);
  const y1 = await atEnd();
  check("follows output while at the end", y1 > y0, `${y0} -> ${y1}`);
  check("no jump button while following", await p.evaluate(() => document.querySelector(".jump").hidden));
  await p.evaluate(() => { document.querySelector(".screen").scrollTop -= 400; });
  await sleep(300);
  const y2 = await atEnd();
  check("scrolling up shows the jump button", await p.evaluate(() => !document.querySelector(".jump").hidden));
  await sleep(2500);
  const y3 = await atEnd();
  check("scrolling up pauses following", y3 === y2, `${y2} -> ${y3}`);
  // The line actually at the top of the view, wherever the grid has got to.
  const topLine = () => p.evaluate(() => {
    const s = document.querySelector(".screen"), h = document.querySelector(".xhost"), r = document.querySelector(".xterm-rows");
    const cell = r.getBoundingClientRect().height / r.children.length;
    return r.children[Math.floor((s.scrollTop - parseFloat(h.style.top)) / cell) + 1]?.textContent.slice(0, 40);
  });
  const line = await topLine();
  await sleep(1500);
  const line2 = await topLine();
  check("history on screen holds still while paused", line === line2, `${line} / ${line2}`);
  await p.click(".jump");
  await sleep(600);
  check("jump resumes following", (await atEnd()) > y3 && await p.evaluate(() => document.querySelector(".jump").hidden));

  // pinch with two real touch points
  const font = () => p.evaluate(() => JSON.parse(localStorage.getItem("lumbridge.view") ?? "{}"));
  const box = await p.locator(".screen").boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const cdp = await p.context().newCDPSession(p);
  const cellBefore = await p.evaluate(() => document.querySelector(".xterm-screen").getBoundingClientRect().width);
  const pts = (d) => [{ x: cx - d, y: cy, id: 0 }, { x: cx + d, y: cy, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(40) });
  for (const d of [50, 60, 70, 80]) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(d) }); await sleep(30); }
  const live = await p.evaluate(() => document.querySelector(".xhost").style.transform);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(600);
  const cellAfter = await p.evaluate(() => document.querySelector(".xterm-screen").getBoundingClientRect().width);
  check("pinch scales live, then commits to a real font size", live.startsWith("scale") && cellAfter > cellBefore * 1.5, `${live} ${Math.round(cellBefore)} -> ${Math.round(cellAfter)}`);
  const remembered = (await font())[stream]?.font;
  check("the size is remembered per terminal", remembered >= 16, String(remembered));
  check("crisp: no transform left on the terminal", await p.evaluate(() => document.querySelector(".xhost").style.transform === ""));

  await p.evaluate(() => { document.querySelector(".screen").scrollLeft = 120; });
  await sleep(600);
  await p.reload();
  await p.waitForSelector(".xterm-rows");
  await sleep(1000);
  const back = await p.evaluate(() => ({ w: document.querySelector(".xterm-screen").getBoundingClientRect().width, left: document.querySelector(".screen").scrollLeft }));
  check("size and sideways position survive a reload", Math.abs(back.w - cellAfter) < 3 && back.left === 120, JSON.stringify(back));
  // leave it as we found it
  await p.evaluate(() => localStorage.removeItem("lumbridge.view"));
  await p.context().close();
}

// ---- keys, Ctrl-C confirm, send, blocked banner ----
{
  const a = agent("verify-perm", "permission");
  const p = await open(browser, t, "iphone", { hash: term(a) });
  await p.waitForSelector(".xterm-rows");
  check("blocked shows a clear banner", await until(() => p.evaluate(() => !document.querySelector(".term-alert").hidden && document.querySelector(".term-alert").textContent.includes("Apply this edit"))));
  await p.click('.key:has-text("Ctrl-C")');
  await sleep(300);
  const armed = await p.evaluate(() => document.querySelector(".key.danger").classList.contains("armed"));
  check("one tap on Ctrl-C only arms it", armed && get(a).state === "live" && get(a).status?.state === "blocked");
  await sleep(2600);
  check("and it disarms by itself", await p.evaluate(() => !document.querySelector(".key.danger").classList.contains("armed")));
  await p.click('.key:has-text("3")');
  check("a number key answers the prompt", await until(() => get(a).status?.state === "idle"));
  check("the banner goes when it's answered", await until(() => p.evaluate(() => document.querySelector(".term-alert").hidden)));
  await p.click('.key:has-text("Ctrl-C")');
  await p.click('.key:has-text("Again?")');
  check("two taps send Ctrl-C", await until(() => get(a).state !== "live", 8000), get(a).state);
  await p.context().close();
  try { hc("rm", a); } catch {}

  const c = agent("verify-send", "chat");
  const q = await open(browser, t, "pixel", { hash: term(c) });
  await q.waitForSelector(".xterm-rows");
  await until(async () => (await screenText(q)).includes("Ready"));
  await q.fill(".composer textarea", "hello from the composer");
  await q.click(".send");
  // The text stays until core answers (tests/offline-verify.mjs: a socket that never answers loses nothing), then goes.
  check("composer's text reaches the program", await until(async () => (await screenText(q)).includes("You said: hello from the composer"), 12000));
  check("composer clears once core has it", await until(async () => (await q.inputValue(".composer textarea")) === "", 12000), await q.inputValue(".composer textarea"));
  const h1 = await q.evaluate(() => document.querySelector(".composer textarea").offsetHeight);
  await q.fill(".composer textarea", "a\nb\nc\nd");
  const h2 = await q.evaluate(() => document.querySelector(".composer textarea").offsetHeight);
  await q.fill(".composer textarea", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl");
  const h3 = await q.evaluate(() => document.querySelector(".composer textarea").offsetHeight);
  check("composer autosizes, up to a limit", h2 > h1 && h3 <= 150 && h3 >= h2, `${h1} ${h2} ${h3}`);
  // A keyboard, as iOS reports one: the visual viewport shrinks while the layout doesn't.
  await q.focus(".composer textarea");
  await q.evaluate(() => { Object.defineProperty(visualViewport, "height", { get: () => 480, configurable: true }); visualViewport.dispatchEvent(new Event("resize")); });
  await sleep(200);
  const kb = await q.evaluate(() => { const c = document.querySelector(".composer").getBoundingClientRect(); return { bottom: c.bottom, kb: document.documentElement.classList.contains("kb"), h: document.querySelector(".shell").getBoundingClientRect().height }; });
  check("the composer stays above the keyboard", kb.bottom <= 480 && kb.kb, JSON.stringify(kb));
  await q.context().close();
  hc("kill", c);
}

// ---- seen state: holds, mark unread ----
{
  const a = agent("verify-done", "done");
  await until(() => get(a).status?.state === "done");
  const p = await open(browser, t, "desktop");
  const inGroup = (g) => p.evaluate(([g, a]) => !!document.querySelector(`.group.${g} .row[data-address="${a}"]`), [g, a]);
  check("a finished agent with an unseen turn is in Done", await until(() => inGroup("done")));
  await p.click(`.row[data-address="${a}"] .row-main`);
  check("looking at it writes lumbridge.seen", await until(() => get(a).labels["lumbridge.seen"] === String(get(a).turn)));
  await sleep(300);
  check("it stays in Done while it's open", await inGroup("done"));
  await p.keyboard.press("Escape");
  check("and goes to Idle when you leave", await until(() => inGroup("idle")));
  await p.click(`.row[data-address="${a}"] .row-main`, { button: "right" });
  await p.click('.sheet-item:has-text("Mark unread")');
  check("mark unread writes turn-1", await until(() => Number(get(a).labels["lumbridge.seen"]) === get(a).turn - 1));
  check("and it's back in Done", await until(() => inGroup("done")));
  await p.context().close();
  hc("kill", a);
}

// ---- desktop ----
{
  const p = await open(browser, t, "desktop");
  await p.keyboard.press("j");
  await p.keyboard.press("j");
  const cur = await p.evaluate(() => document.querySelector(".row.cursor")?.dataset.address);
  check("j/k move a cursor", !!cur, cur);
  await p.keyboard.press("Enter");
  await p.waitForSelector(".xterm-rows");
  check("Enter opens it; the route is #/t/<address>", (await p.evaluate(() => location.hash)) === term(cur));
  const both = await p.evaluate(() => { const m = document.querySelector(".master").getBoundingClientRect(), d = document.querySelector(".detail").getBoundingClientRect(); return m.width > 300 && d.width > 700 && m.right <= d.left + 1; });
  check("list and terminal are side by side", both);
  // A grid shorter than the pane (50 rows on a tall monitor): the newest lines must be what's on screen.
  await p.setViewportSize({ width: 2560, height: 1440 });
  await p.click(`.row[data-address="${A["acme-api"]}"] .row-main`);
  await sleep(900);
  const lastShown = await p.evaluate(() => [...document.querySelectorAll(".xterm-rows > div")].map((e) => e.textContent).filter((s) => s.trim()).at(-1).slice(0, 8));
  const now = new Date().toTimeString().slice(0, 5);
  check("a tall monitor shows the newest output", lastShown.startsWith(now) || lastShown.startsWith(new Date(Date.now() - 60000).toTimeString().slice(0, 5)), `${lastShown} at ${now}`);
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.evaluate(() => { window.__m = document.querySelector(".inbox"); });
  await p.keyboard.press("Escape");
  check("Esc closes it", await until(() => p.evaluate(() => location.hash === "#/agents")));
  check("the list wasn't rebuilt by any of that", await p.evaluate(() => window.__m === document.querySelector(".inbox")));
  // A mouse: the wheel scrolls our scroller (xterm doesn't take it), and dragging selects text.
  await p.click(`.row[data-address="${A["gateway-review"]}"] .row-main`);
  await p.waitForSelector(".xterm-rows");
  await sleep(600);
  const box = await p.locator(".screen").boundingBox();
  await p.mouse.move(box.x + 200, box.y + 200);
  const y0 = await p.evaluate(() => document.querySelector(".screen").scrollTop);
  await p.mouse.wheel(0, -500);
  await sleep(300);
  const y1 = await p.evaluate(() => document.querySelector(".screen").scrollTop);
  check("the wheel scrolls back", y1 < y0 - 100, `${y0} -> ${y1}`);
  await p.mouse.move(box.x + 60, box.y + 100);
  await p.mouse.down();
  await p.mouse.move(box.x + 400, box.y + 140, { steps: 5 });
  await p.mouse.up();
  await sleep(200);
  check("dragging selects text on a computer", await p.evaluate(() => document.querySelectorAll(".xterm-selection div").length > 0));
  await p.keyboard.press("Escape");
  await until(() => p.evaluate(() => location.hash === "#/agents"));
  const focused = await p.evaluate(() => { document.querySelector(".row-main").focus(); return document.activeElement.className; });
  check("rows take keyboard focus", focused === "row-main");
  // One noun per view (L-14): By state lists agents, By place lists the desktop app's panes, and search and the empty pane say which.
  const words = () => p.evaluate(() => ({ hash: location.hash, ph: document.querySelector(".find-input").placeholder, aria: document.querySelector(".find-input").getAttribute("aria-label"), empty: document.querySelector(".detail .detail-empty")?.textContent ?? "" }));
  // Focusing a row above opened it; back to the list, nothing open.
  await p.evaluate(() => { document.activeElement?.blur(); location.hash = "#/agents"; });
  // On a computer the empty pane is the overview (views/agents-overview.ts): its words follow the view's noun too.
  const isByState = (w) => w.ph === "Search agents" && w.aria === "Search every agent" && w.empty.includes("Need you") && w.empty.endsWith("to move, Enter to open") && !/pane/i.test(w.empty);
  check("By state: search and the empty pane say agent", await until(async () => isByState(await words())), JSON.stringify(await words()));
  await p.click('.list-btn[data-list="panes"]');
  const isByPlace = (w) => w.ph === "Search panes" && w.aria === "Search every pane" && w.empty.includes("Need you") && w.empty.endsWith("Pick a pane to continue in it.") && !/agent/i.test(w.empty);
  check("By place: search and the empty pane say pane", await until(async () => isByPlace(await words())), JSON.stringify(await words()));
  await p.click('.list-btn[data-list="agents"]');
  check("and back on By state, agent again", await until(async () => isByState(await words())), JSON.stringify(await words()));
  check("no page errors on desktop", p.errors.length === 0, p.errors.join("; "));
  await p.context().close();
}

// ---- The assistant when it can't be reached (L-06). The scratch gateway has no Hermes, so it's away until a route says otherwise ----
for (const profile of ["desktop", "iphone"]) {
  const p = await open(browser, t, profile);
  const failedRequests = [];
  p.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });
  await p.evaluate(() => { location.hash = "#/assistant"; });
  await p.waitForSelector(".pp-orb");
  const orb = () => p.evaluate(() => { const b = document.querySelector(".pp-orb"); return { disabled: b.disabled, aria: b.getAttribute("aria-disabled"), label: b.getAttribute("aria-label"), line: document.querySelector(".pp-state").textContent, form: document.querySelector(".po").dataset.state, notice: document.querySelector(".pp-notice").hidden ? "" : document.querySelector(".pp-notice .d-error-what").textContent }; });
  // The card says why, once: the line under the orb stays quiet and the orb is only its outline.
  check(`${profile}: an unreachable assistant's orb is an outline and disabled, and one card says why`, await until(async () => { const o = await orb(); return o.disabled && o.aria === "true" && o.line === "" && o.label === "Assistant is unreachable" && o.form === "error" && o.notice === "Can't reach Assistant right now."; }), JSON.stringify(await orb()));
  await sleep(500);
  check(`${profile}: and finding that out made no failed request`, failedRequests.length === 0, failedRequests.join(" | "));
  check(`${profile}: nor any console error`, p.errors.length === 0, p.errors.join("; "));
  // She answers again: the page notices by itself, within its 5 s recheck, and the orb invites a press in the pointer's word.
  await p.route("**/api/assistant/status", (r) => r.fulfill({ json: { reachable: true }, headers: { "cache-control": "no-store" } }));
  await p.route("**/api/assistant/history", (r) => r.fulfill({ json: { messages: [] }, headers: { "cache-control": "no-store" } }));
  const idle = profile === "desktop" ? "Click to talk" : "Tap to talk";
  check(`${profile}: when she answers again the orb comes back by itself, reading "${idle}"`, await until(async () => { const o = await orb(); return !o.disabled && o.aria === null && o.line === idle && o.label === idle && o.form === "idle" && o.notice === ""; }, 12000), JSON.stringify(await orb()));
  check(`${profile}: still no console error`, p.errors.length === 0, p.errors.join("; "));
  await p.context().close();
}

// ---- themes: contrast of the tokens ----
{
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  for (const dark of [true, false]) {
    const ctx = await browser.newContext({ colorScheme: dark ? "dark" : "light" });
    const p = await ctx.newPage();
    await p.goto(t.base + "#/agents");
    const v = await p.evaluate(() => {
      const css = (n) => { const e = document.createElement("div"); e.style.color = `var(${n})`; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c.match(/[\d.]+/g).slice(0, 3).map(Number); };
      return Object.fromEntries(["--bg", "--panel", "--text", "--dim", "--faint", "--accent-text", "--done", "--work"].map((n) => [n, css(n)]));
    });
    for (const n of ["--text", "--dim", "--faint", "--accent-text"]) {
      const r = ratio(v[n], v["--bg"]);
      check(`${dark ? "dark" : "light"}: ${n} on --bg is readable`, r >= 4.5, r.toFixed(2));
    }
    await ctx.close();
  }
}

// ---- WebKit, the closest thing here to Safari ----
{
  const wk = await webkit.launch();
  const ctx = await wk.newContext({ ...PROFILES.iphone, colorScheme: "dark" });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  // Android needs this viewport key and WebKit logs that it doesn't know it. That's the only expected one.
  p.on("console", (m) => { if (m.type() === "error" && !m.text().includes("interactive-widget")) errors.push(m.text()); });
  await p.addInitScript((tok) => localStorage.setItem("lumbridge.token", tok), t.token);
  await p.goto(t.base + "#/agents");
  await p.waitForSelector(".row", { state: "attached" });
  check("WebKit: inbox renders, no sideways scroll", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await p.goto(t.base + term(A["gateway-review"]));
  await p.waitForSelector(".xterm-rows", { timeout: 10000 });
  await sleep(800);
  const r = await p.evaluate(() => ({ font: getComputedStyle(document.querySelector(".composer textarea")).fontSize, rows: document.querySelector(".xterm-rows").textContent.length, h: document.querySelector(".screen").clientHeight, sw: document.querySelector(".screen").scrollWidth, vw: innerWidth }));
  check("WebKit: terminal draws and pans; input is 16px so iOS won't zoom", r.rows > 50 && r.font === "16px" && r.sw > r.vw, JSON.stringify(r));
  await p.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/webkit-term.png` : "/dev/null" }).catch(() => {});
  check("WebKit: no errors", errors.length === 0, errors.join("; "));
  await wk.close();
}

// ---- thirty terminals emitting, on a throttled phone. Timed, so only on a quiet host (tests/quiet-host.mjs) ----
if (process.argv.includes("--storm")) {
  const storms = [];
  for (let i = 1; i <= 30; i++) storms.push(agent(`storm-${i}`, "storm"));
  const STORM = "30 terminals storming on a 4x slower CPU stays smooth";
  await group("storm at 4x CPU", {
    judged: "a single run",
    names: () => [STORM],
    async run() {
      const p = await open(browser, t, "iphone");
      await p.waitForSelector(".row");
      await sleep(1500);
      const cdp = await p.context().newCDPSession(p);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      const host = meter();
      const r = await p.evaluate(() => new Promise((done) => {
        const rows = new Map([...document.querySelectorAll(".row")].map((e) => [e.dataset.address, e]));
        let frames = 0, last = performance.now(), worst = 0, muts = 0, added = 0;
        const mo = new MutationObserver((ms) => { muts += ms.length; for (const m of ms) added += m.addedNodes.length; });
        mo.observe(document.querySelector(".inbox-lists"), { childList: true, subtree: true, characterData: true, attributes: true });
        const start = last;
        const loop = (now) => {
          frames++; worst = Math.max(worst, now - last); last = now;
          if (now - start < 6000) requestAnimationFrame(loop);
          else done({ fps: Math.round(frames / 6), worstFrameMs: Math.round(worst), mutationsPerSec: Math.round(muts / 6), same: [...rows].every(([a, e]) => e.isConnected || !document.querySelector(`.row[data-address="${a}"]`)) });
        };
        requestAnimationFrame(loop);
      }));
      const now = host();
      console.log("storm:", JSON.stringify(r), said(now));
      await p.context().close();
      return { checks: [{ name: STORM, ok: r.fps >= 40 && r.worstFrameMs < 150 && r.same, extra: JSON.stringify(r), timed: true }], runs: [now] };
    },
  });
  for (const a of storms) hc("kill", a);
}

await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
