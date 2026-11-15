// Offline, in Chrome as an iPhone 14, a Pixel 6 and a computer, against a scratch core and fixture:
//   scripts/dev.sh <port> && scripts/dev-fixture.sh <port> && node tests/offline-verify.mjs <port>
// It also starts and stops a second scratch core, with no fixture, on <port>+7 (tests/ports.mjs): a core that has no agents.
// The network going is noticed within 2 s, what can't work is disabled until it's back, and a typed line is never lost: not
// while offline, and not when the socket stays open but nothing answers (the gateway stopped with SIGSTOP, then SIGCONT). A line
// that isn't confirmed yet can't be sent a second time, so when it lands late it lands once.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { portAt, stopOnExit } from "./ports.mjs";
import { chromium, EXT, open as openPage, PROFILES, scratchEnv, target } from "./ui-lib.mjs";

const [port] = process.argv.slice(2);
const t = target(port);
const hc = (...a) => execFileSync("lbc", a, { env: scratchEnv(port), encoding: "utf8" });
const fixture = new URL("../scripts/dev-fixture.sh", import.meta.url).pathname;
const devSh = new URL("../scripts/dev.sh", import.meta.url).pathname;
const gwPid = Number(readFileSync(`/run/user/${process.getuid()}/k${port}/gw.pid`, "utf8").trim());
const run = Date.now().toString(36); // a run that crashed leaves its terminals, and a name can't be reused while they live
const start = (name, ...cmd) => JSON.parse(hc("run", "--bg", "--no-parent", "--json", "--name", `${name}-${run}`, ...cmd)).address;
const get = (a) => JSON.parse(hc("get", a, "--json"));
const screen = (a) => hc("read", a);
const count = (hay, needle) => hay.split(needle).length - 1;

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !extra ? "" : `  [${extra}]`}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(50); } return false; };
const term = (a) => `#/t/${encodeURIComponent(a)}`;

const asker = start("offline-asker", "--label", "lumbridge.seen=0", fixture, "--agent", "permission"); // never answered: it stays blocked
const shell = start("offline-shell", "bash");
await until(() => get(asker).status?.state === "blocked", 15000);
const browser = await chromium.launch({ channel: "chrome" });

const bannerUp = (p) => p.evaluate(() => { const b = document.querySelector(".conn"); return !!b && !b.hidden && b.offsetParent !== null; });
const bannerText = (p) => p.evaluate(() => document.querySelector(".conn")?.textContent ?? "");
/** Every button given: disabled, and saying so. Or all enabled with no aria-disabled. */
const allOff = (p, sel, off) => p.evaluate(([s, o]) => {
  const bs = [...document.querySelectorAll(s)];
  return bs.length > 0 && bs.every((b) => b.disabled === o && (o ? b.getAttribute("aria-disabled") === "true" : !b.hasAttribute("aria-disabled")));
}, [sel, off]);
const toast = (p) => p.evaluate(() => { const e = document.querySelector(".term-toast"); return e && !e.hidden ? e.textContent : ""; });
const boxValue = (p) => p.inputValue(".composer textarea");
// Chrome logs each reconnect it can't make while the network is off. That's the retry working, not a fault in the page.
const realErrors = (p) => p.errors.filter((e) => !/WebSocket connection to .* failed: .*ERR_INTERNET_DISCONNECTED/.test(e));
const tapSend = async (p, profile) => { const s = p.locator(".composer .send"); if (profile === "desktop") await s.click(); else await s.tap(); };

for (const profile of ["iphone", "pixel", "desktop"]) {
  // ---- Needs you: the banner, and the choices off while offline ----
  {
    const p = await openPage(browser, t, profile, { hash: "#/agents" });
    const choices = `.row[data-address="${asker}"] .choice`;
    // The list's own three. On a computer the overview beside it has the same buttons, and everything below covers both.
    check(`${profile}: the blocked agent's choices are up`, await until(() => p.locator(`.master ${choices}`).count().then((n) => n === 3), 10000));
    check(`${profile}: and pressable while connected`, await allOff(p, choices, false));
    const t0 = Date.now();
    await p.context().setOffline(true);
    const shown = await until(() => bannerUp(p), 4000);
    const took = Date.now() - t0;
    check(`${profile}: offline: the banner within 2 s`, shown && took <= 2000, `${took} ms`);
    check(`${profile}: and it says offline`, (await bannerText(p)).startsWith("Offline"), await bannerText(p));
    check(`${profile}: the choices are disabled, aria-disabled too`, await until(() => allOff(p, choices, true), 1000));
    await p.locator(choices).first().click({ force: true }).catch(() => {});
    check(`${profile}: and a tap doesn't even arm one`, (await p.locator(`${choices}.armed`).count()) === 0);
    await p.context().setOffline(false);
    check(`${profile}: back online: reconnected, the banner gone`, await until(async () => !(await bannerUp(p)), 10000));
    check(`${profile}: and the choices come back by themselves`, await until(() => allOff(p, choices, false), 5000));
    check(`${profile}: no errors`, realErrors(p).length === 0, realErrors(p).join("; "));
    await p.context().close();
  }

  // ---- a terminal: Send off while offline, and the line kept ----
  {
    const p = await openPage(browser, t, profile, { hash: term(shell) });
    await p.waitForSelector(".xterm-rows", { timeout: 15000 });
    const marker = `off-${run}-${profile}`;
    const line = `echo ${marker}-$((40+2))`; // the shell prints "<marker>-42" only if it really ran
    const out = `${marker}-42`;
    await p.fill(".composer textarea", line);
    check(`${profile}: Send is on while connected`, await until(() => allOff(p, ".composer .send", false), 3000));
    const t0 = Date.now();
    await p.context().setOffline(true);
    const shown = await until(() => bannerUp(p), 4000);
    check(`${profile}: in a terminal too, the banner within 2 s`, shown && Date.now() - t0 <= 2000, `${Date.now() - t0} ms`);
    check(`${profile}: Send is disabled, aria-disabled too`, await until(() => allOff(p, ".composer .send", true), 1000));
    // A disabled button can't be tapped, but Enter on a keyboard, or anything else that submits, still could.
    await p.evaluate(() => document.querySelector(".composer").requestSubmit());
    check(`${profile}: a send while offline says so`, await until(async () => (await toast(p)) === "Not connected. Your message is still here.", 1000), await toast(p));
    check(`${profile}: and the text stays in the box`, (await boxValue(p)) === line, await boxValue(p));
    await sleep(800);
    check(`${profile}: and nothing reached the terminal`, !screen(shell).includes(marker), screen(shell).slice(-300));
    await p.context().setOffline(false);
    check(`${profile}: back online: Send comes back`, await until(() => allOff(p, ".composer .send", false), 10000));
    check(`${profile}: the text is still there`, (await boxValue(p)) === line, await boxValue(p));
    await tapSend(p, profile);
    check(`${profile}: Send delivers it`, await until(() => screen(shell).includes(out), 8000), screen(shell).slice(-300));
    check(`${profile}: and the box empties once it has`, await until(async () => (await boxValue(p)) === "", 3000), await boxValue(p));
    await sleep(800);
    check(`${profile}: exactly once`, count(screen(shell), out) === 1, String(count(screen(shell), out)));

    // ---- a send whose answer never comes: the socket stays open, the gateway is stopped ----
    const hung = `hung-${run}-${profile}`;
    const hungLine = `echo ${hung}-$((40+2))`;
    await p.fill(".composer textarea", hungLine);
    process.kill(gwPid, "SIGSTOP");
    let sentAt = 0;
    try {
      sentAt = Date.now();
      await tapSend(p, profile);
      await sleep(1500);
      check(`${profile}: waiting for an answer, the text stays in the box`, (await boxValue(p)) === hungLine, await boxValue(p));
      check(`${profile}: and nothing says it was sent`, !(await toast(p)), await toast(p));
      const said = await until(async () => (await toast(p)) === "Not confirmed yet. It may still arrive.", 14000);
      const after = Date.now() - sentAt;
      check(`${profile}: no answer: "Not confirmed yet", after the 12 s limit`, said && after >= 11500 && after <= 14500, `${said} ${after} ms`);
      check(`${profile}: and the text is still in the box`, (await boxValue(p)) === hungLine, await boxValue(p));
      check(`${profile}: and the wait is over`, !(await p.evaluate(() => document.querySelector(".term").classList.contains("sending"))));
      check(`${profile}: Send is disabled while the box holds the same text, aria-disabled too`, await allOff(p, ".composer .send", true));
      check(`${profile}: and it says why`, (await p.getAttribute(".composer .send", "title")) === "Not confirmed yet. It may still arrive.");
      await p.evaluate(() => document.querySelector(".composer").requestSubmit());
      check(`${profile}: a submit anyway sends nothing and says so`, await until(async () => (await toast(p)) === "Not confirmed yet. It may still arrive.", 1000), await toast(p));
      await p.fill(".composer textarea", `${hungLine} # edited`);
      check(`${profile}: editing the text brings Send back`, await until(() => allOff(p, ".composer .send", false), 1000));
      check(`${profile}: and no reason is left on it`, !(await p.getAttribute(".composer .send", "title")));
      // Back to the line that went, untouched, so its late arrival can clear it. Nothing is tapped.
      await p.fill(".composer textarea", hungLine);
    } finally {
      process.kill(gwPid, "SIGCONT");
    }
    // The stopped gateway still had the call queued: it arrives once, and the box lets it go.
    check(`${profile}: after SIGCONT: "Sent after all."`, await until(async () => (await toast(p)) === "Sent after all.", 8000), await toast(p));
    check(`${profile}: and the box is empty`, await until(async () => (await boxValue(p)) === "", 2000), await boxValue(p));
    check(`${profile}: the line arrived`, await until(() => screen(shell).includes(`${hung}-42`), 5000), screen(shell).slice(-300));
    await sleep(1500);
    check(`${profile}: exactly once`, count(screen(shell), `${hung}-42`) === 1, String(count(screen(shell), `${hung}-42`)));
    check(`${profile}: no errors`, realErrors(p).length === 0, realErrors(p).join("; "));
    await p.context().close();
  }
}

// ---- an offline reload right after the very first visit: the worker has everything the page loads, theme-boot.js included ----
{
  const p = await openPage(browser, t, "iphone", { dark: true });
  await p.evaluate(() => localStorage.setItem("lumbridge.theme", "light"));
  check("first visit: the worker is ready", await until(() => p.evaluate(async () => !!(await navigator.serviceWorker.ready) && (await caches.keys()).length > 0), 15000));
  await until(() => p.evaluate(async () => { const c = await caches.open((await caches.keys())[0]); return !!(await c.match("/theme-boot.js")); }), 8000);
  p.errors.length = 0;
  await p.context().setOffline(true);
  await p.reload({ waitUntil: "domcontentloaded" });
  await sleep(500);
  const boot = await p.evaluate(async () => (await fetch("/theme-boot.js")).headers.get("content-type") ?? "");
  check("offline reload: theme-boot.js comes from the worker as JavaScript", /javascript/.test(boot), boot);
  check("offline reload: the chosen theme is applied before paint", (await p.evaluate(() => document.documentElement.dataset.theme)) === "light");
  check("offline reload: no MIME or other console error", !p.errors.some((e) => /MIME|theme-boot/i.test(e)), p.errors.join("; "));
  // The fonts live under /assets with a hashed name now; the worker precaches them from index.html's preloads.
  const fonts = await p.evaluate(async () => {
    await Promise.all(['16px "Geist"', '16px "Geist Mono"'].map((f) => document.fonts.load(f).catch(() => [])));
    return [...document.fonts].map((f) => `${f.family.replace(/"/g, "")}:${f.status}`).sort();
  });
  check("offline reload: Geist and Geist Mono load from the worker", JSON.stringify(fonts) === JSON.stringify(["Geist Mono:loaded", "Geist:loaded"]), JSON.stringify(fonts));
  await p.context().close();
}

// ---- an offline reload on Agents, Infra and a terminal: each says it isn't connected, never that there's nothing, and never
// waits forever; back online, each fills in by itself. /api/infra is answered here, so the scratch gateway never asks the real
// Prometheus (infra-verify has the fake one). Nothing about these is kept on the device for reading offline.
const INFRA = () => ({
  at_ms: Date.now(), stale: false, age_s: 0, needs: [], models: [], phone: null,
  machines: [{ id: "desk", label: "Desk", role: "gateway", up: true, cpu_pct: 12, mem_pct: 30, disk_pct: 40, temp_c: null, gpu: null, cpu_history: [10, 12, 11] }],
  backups: { last_run_age_s: 60, repos_ok: 1, repos_total: 1, sources: 1, sources_failing: [], lake1: { mounted: true, used_bytes: 1, size_bytes: 10 } },
});
/** A page at `hash`, its worker ready to serve the shell with no network. `net.offline` makes /api/infra fail as it would. */
async function openReady(target, profile, hash, ready) {
  const ctx = await browser.newContext({ ...PROFILES[profile], colorScheme: "dark" });
  const net = { offline: false };
  await ctx.route("**/api/infra", (r) => (net.offline ? r.abort("internetdisconnected") : r.fulfill({ json: INFRA() })));
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(`pageerror: ${e.message}`));
  await p.addInitScript((tok) => { try { localStorage.setItem("lumbridge.token", tok); } catch {} }, target.token);
  await p.goto(target.base + hash);
  await p.waitForSelector(ready, { timeout: 15000, state: "attached" });
  const sw = await until(() => p.evaluate(async () => !!navigator.serviceWorker.controller && !!(await caches.match("/")) && !!(await caches.match("/theme-boot.js"))), 15000);
  check(`${profile} ${hash}: the worker can serve the page offline`, sw);
  const offline = async (on) => { net.offline = on; await ctx.setOffline(on); };
  return { p, net, offline };
}
const text = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return e && e.offsetParent !== null ? e.textContent : ""; }, sel);
const NONE = /No agents running|No agents on/;

for (const profile of ["iphone", "desktop"]) {
  // Agents, By state
  {
    const { p, offline } = await openReady(t, profile, "#/agents", `.row[data-address="${asker}"]`);
    await offline(true);
    await p.reload({ waitUntil: "domcontentloaded" });
    let saidNone = false;
    const calm = await until(async () => {
      const all = await p.evaluate(() => document.querySelector(".inbox:not(.panes)")?.innerText ?? "");
      if (NONE.test(all)) saidNone = true;
      return (await text(p, ".inbox:not(.panes) .inbox-empty .empty-title")) === "Can't reach your machines right now.";
    }, 5000);
    check(`${profile}: Agents offline reload: "Can't reach your machines right now."`, calm, await text(p, ".inbox:not(.panes) .inbox-empty"));
    await sleep(1500);
    const all = await p.evaluate(() => document.querySelector(".inbox:not(.panes)")?.innerText ?? "");
    check(`${profile}: and never "No agents running"`, !saidNone && !NONE.test(all), all.slice(0, 200));
    check(`${profile}: and no skeleton left loading`, (await p.locator(".inbox:not(.panes) .skeleton").count()) === 0);
    await offline(false);
    check(`${profile}: back online: the agents fill in by themselves`, await until(() => p.locator(`.row[data-address="${asker}"]`).isVisible(), 15000));
    check(`${profile}: and the offline line is gone`, !(await p.locator(".inbox:not(.panes) .inbox-empty").isVisible()));
    check(`${profile}: no page errors`, p.errors.length === 0, p.errors.join("; "));
    await p.context().close();
  }
  // Infra (an instance's own screen: only where web/src/ext is)
  if (EXT) {
    const { p, offline } = await openReady(t, profile, "#/infra", ".i-body:not([hidden])");
    await offline(true);
    const t0 = Date.now();
    await p.reload({ waitUntil: "domcontentloaded" });
    const said = await until(async () => (await text(p, ".i-note .i-note-text")) === "Not loaded: you're offline.", 6000);
    const took = Date.now() - t0;
    check(`${profile}: Infra offline reload: "Not loaded: you're offline." within 5 s`, said && took <= 5000, `${took} ms, "${await text(p, ".i-note")}"`);
    check(`${profile}: with Try again`, await p.locator(".i-note .i-retry").isVisible());
    await sleep(5500); // past a tick: still no "Loading", and nothing else claimed
    check(`${profile}: and never "Loading"`, (await text(p, ".i-updated")) !== "Loading" && (await text(p, ".i-note .i-note-text")) === "Not loaded: you're offline.", `${await text(p, ".i-updated")} / ${await text(p, ".i-note")}`);
    await p.locator(".i-note .i-retry").click({ timeout: 3000 }).catch(() => {});
    await sleep(500);
    check(`${profile}: Try again while still offline says the same`, (await text(p, ".i-note .i-note-text")) === "Not loaded: you're offline.");
    await offline(false);
    check(`${profile}: back online: Infra fills in by itself`, await until(async () => (await p.locator(".i-body").isVisible()) && /^Updated/.test(await text(p, ".i-updated")), 10000), await text(p, ".i-updated"));
    check(`${profile}: and the offline line and Try again are gone`, !(await p.locator(".i-note").isVisible()) && (await p.locator(".i-retry").count()) === 0);
    check(`${profile}: no page errors`, p.errors.length === 0, p.errors.join("; "));
    await p.context().close();
  }
  // Today, offline, when this device has never opened it: For you is a chunk of its own that the page only fetches when Today opens,
  // so it must already be in the worker's cache from the first online visit (public/sw.js, CHUNKS), or For you would be missing.
  {
    const { p, offline } = await openReady(t, profile, "#/agents", `.row[data-address="${asker}"]`);
    const cached = await until(() => p.evaluate(async () => {
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) if (/\/assets\/for-you-[^/]+\.js$/.test(r.url)) return true;
      return false;
    }), 10000);
    check(`${profile}: the worker has For you cached without Today ever opening`, cached);
    await offline(true);
    await p.evaluate(() => { location.hash = "#/today"; });
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForSelector(".td-capture", { timeout: 10000 });
    check(`${profile}: Today offline reload: For you is there`, await until(() => p.locator(".fy").count().then((n) => n === 1), 5000));
    await offline(false);
    check(`${profile}: no page errors`, p.errors.length === 0, p.errors.join("; "));
    await p.context().close();
  }
  // A terminal from a link
  {
    const { p, offline } = await openReady(t, profile, term(shell), ".xterm-rows");
    const label = await text(p, ".term-head .name");
    await offline(true);
    await p.reload({ waitUntil: "domcontentloaded" });
    const shown = await until(async () => (await text(p, ".term-head .name")) === shell && (await text(p, ".term-head .meta-state")) === "Offline, connecting…", 5000);
    check(`${profile}: terminal offline reload: its address, and "Offline, connecting…"`, shown, `${await text(p, ".term-head .name")} / ${await text(p, ".term-head .meta")}`);
    await offline(false);
    check(`${profile}: back online: its name comes by itself`, await until(async () => (await text(p, ".term-head .name")) === label && label !== shell, 15000), `${await text(p, ".term-head .name")} (was ${label})`);
    check(`${profile}: and the meta line no longer says offline`, !/Offline|Connecting/.test(await text(p, ".term-head .meta")), await text(p, ".term-head .meta"));
    check(`${profile}: no page errors`, p.errors.length === 0, p.errors.join("; "));
    await p.context().close();
  }
}

// ---- a connected core that really has no agents still says so: a second scratch core, no fixture terminals ----
{
  const bare = portAt(port, "bare");
  const stopBare = stopOnExit(() => execFileSync(devSh, [String(bare), "stop"], { stdio: "ignore" }));
  execFileSync(devSh, [String(bare)], { env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE") && !k.startsWith("LBC_"))), stdio: "ignore" });
  const tb = target(bare);
  await until(() => fetch(`${tb.base}healthz`).then((r) => r.ok, () => false), 20000);
  for (const profile of ["iphone", "desktop"]) {
    const { p } = await openReady(tb, profile, "#/agents", ".inbox:not(.panes)");
    check(`${profile}: a connected core with no agents: "No agents running."`, await until(async () => (await text(p, ".inbox:not(.panes) .inbox-empty .empty-title")) === "No agents running.", 10000), await text(p, ".inbox:not(.panes) .inbox-empty"));
    await p.context().close();
  }
  stopBare();
}

hc("kill", asker);
hc("kill", shell);
await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
