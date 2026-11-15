// The settings screen and the service worker in real Chrome, against a scratch core:
//   PW_DIR=<dir with playwright installed> SHOTS=<dir> xvfb-run -a node tests/push-browser.mjs <port>
// Needs web/dist. If the browser's push service is reachable it also does a real subscribe and test send; that goes
// to this throwaway Chrome profile, never to a phone.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopOnExit } from "./ports.mjs";

const port = process.argv[2] ?? "18532";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.env.SHOTS ?? os.tmpdir();
const { chromium } = createRequire(`${process.env.PW_DIR ?? repo}/`)("playwright");
const d = `/run/user/${process.getuid()}/k${port}`;
const base = `http://127.0.0.1:${port}`;
const origin = base;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); if (!ok) failed++; };
const dev = (...a) => spawnSync("bash", [`${repo}/scripts/dev.sh`, port, ...a], { encoding: "utf8" });

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

// Chrome's own notification centre: these are fakes, and this may be running on someone's screens.
const NO_DESKTOP = ["--disable-features=NativeNotifications"];
const VIEW = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "dark" };

async function open(browser, { ua, permission, shot, persistent } = {}) {
  // Chrome has no Push API in incognito, so the on/off run takes a real, throwaway profile.
  const ctx = persistent ?? await browser.newContext({ ...VIEW, userAgent: ua });
  if (permission === "granted") await ctx.grantPermissions(["notifications"], { origin });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(e.message));
  // Only what this lane owns: the worker's badge arrives with the UI lane's icons, and other views' API calls are theirs.
  page.on("response", (r) => { if (r.status() >= 400 && new URL(r.url()).pathname.startsWith("/api/push")) problems.push(`${r.status()} ${r.url()}`); });
  if (permission === "denied") {
    const tab = await ctx.newCDPSession(page);
    const { targetInfo } = await tab.send("Target.getTargetInfo");
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send("Browser.setPermission", { origin, browserContextId: targetInfo.browserContextId, permission: { name: "notifications" }, setting: "denied" });
  }
  await page.goto(`${base}/#token=${fs.readFileSync(`${d}/token`, "utf8").trim()}`);
  await page.waitForFunction(() => location.hash === "#/today");
  await page.evaluate(() => { location.hash = "#/settings"; });
  await page.waitForSelector(".set-lead");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${shot}: no sideways scroll`, overflow <= 0, `${overflow}`);
  await page.waitForTimeout(200); // Headed Chrome under xvfb can refuse a capture right after load.
  await page.screenshot({ path: path.join(shots, `settings-${shot}.png`) }).catch(() => page.waitForTimeout(1000).then(() => page.screenshot({ path: path.join(shots, `settings-${shot}.png`) })));
  return { ctx, page, problems };
}
const lead = (page) => page.locator(".set-lead").innerText();

dev("stop");
// Once, however the run ends: pass, fail, crash or Ctrl-C. Chrome is Playwright's to end.
const stopAll = stopOnExit(() => dev("stop"));
const started = dev();
if (started.status !== 0) { console.error(started.stderr); process.exit(1); }
for (let i = 0; i < 50; i++) { if (await fetch(`${base}/healthz`).catch(() => null)) break; await sleep(100); }
const browser = await chromium.launch({ channel: "chrome", headless: false, args: NO_DESKTOP });

try {
  // iPhone in Safari, not on the Home Screen.
  {
    const { ctx, page, problems } = await open(browser, { ua: IPHONE, shot: "iphone-not-installed" });
    check("iPhone in a tab says add to Home Screen", /Home Screen/.test(await lead(page)), await lead(page));
    const text = await page.locator(".settings").innerText();
    check("iPhone in a tab explains it plainly", /only work from the Home Screen/.test(text) && /Share/.test(text));
    check("iPhone in a tab offers no button that can't work", (await page.locator(".primary").count()) === 0);
    check("iPhone in a tab: This device says so", /iPhone/.test(text) && /Browser/.test(text) && /0\.1\.0/.test(text));
    check("iPhone in a tab: no errors", problems.length === 0, problems.join("; "));
    await ctx.close();
  }
  // Blocked.
  {
    const { ctx, page, problems } = await open(browser, { permission: "denied", shot: "blocked" });
    check("blocked says so and how to fix it", /blocked/.test(await lead(page)) && (await page.locator(".set-steps li").count()) >= 2, await lead(page));
    check("blocked: no errors", problems.length === 0, problems.join("; "));
    await ctx.close();
  }
  // Off, then on.
  {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lumbridge-push-"));
    // A stored permission, as a person's Allow leaves.
    fs.mkdirSync(`${profile}/Default`);
    fs.writeFileSync(`${profile}/Default/Preferences`, JSON.stringify({ profile: { content_settings: { exceptions: { notifications: { [`${origin},*`]: { setting: 1 } } } } } }));
    // Playwright's default flags keep Chrome off its push service.
    const persistent = await chromium.launchPersistentContext(profile, { ...VIEW, channel: "chrome", headless: false, args: NO_DESKTOP,
      ignoreDefaultArgs: ["--disable-background-networking", "--disable-component-update", "--disable-sync"] });
    const { ctx, page, problems } = await open(browser, { shot: "off", persistent });
    check("off offers to turn on", (await page.locator(".primary").innerText()) === "Turn on notifications");
    await page.locator(".primary").click();
    await page.waitForSelector(".set-lead.on, .set-note.err", { timeout: 20000 });
    const on = (await page.locator(".set-lead.on").count()) === 1;
    let stillOn = false;
    await page.screenshot({ path: path.join(shots, `settings-after-turn-on.png`), fullPage: true });
    if (!on) {
      console.log(`NOTE real subscribe unavailable here: ${await page.locator(".set-note").innerText()}`);
    } else {
      const state = JSON.parse(fs.readFileSync(`${d}/state/push.json`));
      check("a real browser subscription reached the gateway", state.subscriptions.length === 1, new URL(state.subscriptions[0].endpoint).host);
      check("the device is labelled", /Chrome/.test(state.subscriptions[0].label), state.subscriptions[0].label);
      check("subscribe wrote prefs defaults", state.prefs.needsYou === true && state.prefs.finished === true);
      const switches = page.locator(".set-switch");
      check("three prefs", (await switches.count()) === 3);

      // Prefs save and survive a reload.
      await page.getByText("Quiet hours", { exact: true }).click();
      await page.waitForSelector(".set-times");
      await page.getByText("Finished", { exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".set-switch")[1]?.checked === false);
      await page.screenshot({ path: path.join(shots, "settings-on-quiet.png"), fullPage: true });
      await page.reload();
      await page.waitForSelector(".set-times");
      check("prefs survive a reload", (await page.locator(".set-switch").nth(1).isChecked()) === false && (await page.locator(".set-switch").nth(2).isChecked()) === true);
      await page.getByText("Quiet hours", { exact: true }).click();
      await page.getByText("Finished", { exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".set-times") && document.querySelectorAll(".set-switch")[1]?.checked);
      await page.screenshot({ path: path.join(shots, "settings-on.png"), fullPage: true });

      // A real test send, through the push service, back to this profile's worker.
      await page.getByRole("button", { name: "Send a test" }).click();
      await page.waitForSelector(".set-note", { timeout: 25000 });
      const said = await page.locator(".set-note").innerText();
      await page.screenshot({ path: path.join(shots, "settings-test-sent.png"), fullPage: true });
      const expired = /expired/.test(said);
      // Google sometimes answers 404/410 for a throwaway profile's brand-new subscription. Not ours to fail on,
      // but the screen must then tell the truth, which is checked here.
      if (expired) {
        console.log(`NOTE the push service dropped this new subscription: ${said}`);
        await page.waitForSelector(".primary");
        check("an expired subscription shows off, not on", (await page.locator(".set-lead.on").count()) === 0);
      } else {
        check("test send: the push service took it", /^Sent/.test(said), said);
        let shown = [];
        for (let i = 0; i < 40 && !shown.length; i++) {
          shown = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, tag: n.tag })));
          if (!shown.length) await sleep(500);
        }
        check("the real push arrived, decrypted, and showed", shown[0]?.title === "Lumbridge notifications work", JSON.stringify(shown));
      }
      stillOn = !expired;
    }

    // The worker itself, with a delivered push event and a tap.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("ServiceWorker.enable");
    let registrationId;
    cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => { for (const r of e.registrations) registrationId = r.registrationId; });
    for (let i = 0; i < 30 && !registrationId; i++) await sleep(100);
    check("found the worker", !!registrationId);
    const notes = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, renotify: n.renotify, url: n.data?.url })));
    const clear = () => page.evaluate(async () => { for (const n of await (await navigator.serviceWorker.ready).getNotifications()) n.close(); });
    const deliver = (data) => cdp.send("ServiceWorker.deliverPushMessage", { origin, registrationId, data });
    const until = async (test) => { for (let i = 0; i < 30; i++) { const n = await notes(); if (test(n)) return n; await sleep(100); } return notes(); };

    await clear();
    await deliver(JSON.stringify({ title: "Acme deploy needs you", body: "rig · waiting for you", url: "/#/t/rig%2Ft7", tag: "t-rig%2Ft7" }));
    let n = await until((x) => x.length === 1);
    check("push shows the notification", n[0]?.title === "Acme deploy needs you" && n[0]?.body === "rig · waiting for you", JSON.stringify(n));
    check("it renotifies under its tag", n[0]?.tag === "t-rig%2Ft7" && n[0]?.renotify === true);
    await deliver(JSON.stringify({ title: "Acme deploy finished", body: "rig", url: "/#/t/rig%2Ft7", tag: "t-rig%2Ft7" }));
    n = await until((x) => x[0]?.title === "Acme deploy finished");
    check("one agent shows one notification", n.length === 1 && n[0].title === "Acme deploy finished", JSON.stringify(n));

    // The number on the app icon, from the worker, with the app closed.
    const stubBadge = () => ctx.serviceWorkers()[0].evaluate(() => {
      self.__badge = [];
      const proto = Object.getPrototypeOf(self.navigator);
      proto.setAppBadge = async (n) => { self.__badge.push(n); };
      proto.clearAppBadge = async () => { self.__badge.push("clear"); };
    });
    const badges = () => ctx.serviceWorkers()[0].evaluate(() => self.__badge);
    await stubBadge();
    await clear();
    await deliver(JSON.stringify({ title: "b", url: "/", tag: "t-b", kind: "needs", badge: 3 }));
    await until((x) => x.length === 1);
    check("a push sets the icon's number", JSON.stringify(await badges()) === "[3]", JSON.stringify(await badges()));
    const kept = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications())[0]?.data?.kind);
    check("a notification remembers its kind, so the page can close it", kept === "needs", String(kept));
    await clear();
    await deliver(JSON.stringify({ title: "b", url: "/", tag: "t-b", badge: 0 }));
    await until((x) => x.length === 1);
    check("zero clears it", (await badges()).at(-1) === "clear", JSON.stringify(await badges()));
    await clear();
    await deliver(JSON.stringify({ title: "b", url: "/", tag: "t-b", badge: "many" }));
    await until((x) => x.length === 1);
    check("a push with no good number leaves it alone, and still shows", (await badges()).length === 2, JSON.stringify(await badges()));
    await ctx.serviceWorkers()[0].evaluate(() => { const proto = Object.getPrototypeOf(self.navigator); delete proto.setAppBadge; delete proto.clearAppBadge; });
    await clear();
    await deliver(JSON.stringify({ title: "no badging here", url: "/", tag: "t-b", badge: 2 }));
    check("where there's no badging it still shows", (await until((x) => x.length === 1))[0]?.title === "no badging here");

    await clear();
    await deliver("this is not json");
    n = await until((x) => x.length === 1);
    check("a malformed push still shows something, as Apple requires", n[0]?.title === "Lumbridge", JSON.stringify(n));
    await clear();
    await deliver(JSON.stringify({ title: "x", url: "//evil.example/" }));
    n = await until((x) => x.length === 1);
    check("a foreign url isn't kept", n[0]?.url === "/", n[0]?.url);
    await clear();

    // A tap on an open window moves it to the agent (t1 is dev.sh's demo shell; a missing one falls back to the list).
    await deliver(JSON.stringify({ title: "Far agent needs you", body: "far", url: "/#/t/t1", tag: "t-far" }));
    await until((x) => x.length === 1);
    // A synthetic event has no user gesture behind it, so `waitUntil` is lent and `openWindow` recorded. A real OS tap is
    // the coordinator's phone test.
    const tap = (stubOpen) => ctx.serviceWorkers()[0].evaluate(async (stubOpen) => {
      const [notification] = await self.registration.getNotifications();
      const event = new NotificationEvent("notificationclick", { notification });
      let done = Promise.resolve();
      Object.defineProperty(event, "waitUntil", { value: (p) => { done = p; } });
      let opened = null;
      const real = self.clients.openWindow;
      if (stubOpen) self.clients.openWindow = async (url) => { opened = url; return null; };
      self.dispatchEvent(event);
      await done;
      if (stubOpen) self.clients.openWindow = real;
      return opened;
    }, stubOpen);
    await tap(false);
    await page.waitForFunction(() => location.hash === "#/t/t1", null, { timeout: 5000 }).then(() => check("a tap goes to the agent in the open window", true), () => check("a tap goes to the agent in the open window", false, page.url()));
    check("the tap closed it", (await until((x) => x.length === 0)).length === 0);

    // A tap with no window open opens one, at the agent.
    await deliver(JSON.stringify({ title: "Far agent needs you", body: "far", url: "/#/t/far%2Ft2", tag: "t-far" }));
    await until((x) => x.length === 1);
    const home = await ctx.newPage();
    await page.goto("about:blank");
    const opened = await tap(true);
    check("a tap with no window opens the agent", opened?.endsWith("/#/t/far%2Ft2"), opened ?? "nothing opened");
    await home.goto(`${base}/#/t/t1`);
    await home.waitForSelector(".term, main");
    const back = home;

    // Nothing private in the cache.
    await back.waitForLoadState();
    const cached = await back.evaluate(async () => {
      const all = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) all.push(new URL(r.url).pathname);
      return all;
    });
    check("the cache holds no /api, /ws or /healthz", cached.length > 0 && !cached.some((p) => p.startsWith("/api") || p === "/ws" || p === "/healthz"), cached.join(" "));

    // Off again.
    if (stillOn) {
      await back.evaluate(() => { location.hash = "#/settings"; });
      await back.waitForSelector(".set-lead.on");
      await back.getByRole("button", { name: "Turn off" }).click();
      await back.waitForSelector(".primary");
      check("turning off forgets this device", JSON.parse(fs.readFileSync(`${d}/state/push.json`)).subscriptions.length === 0);
      await back.screenshot({ path: path.join(shots, "settings-turned-off.png"), fullPage: true });
    }
    check("off and on: no page errors", problems.length === 0, problems.join("; "));
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
} catch (e) {
  check("the run completed", false, e.stack);
} finally {
  await browser.close().catch(() => {});
  stopAll();
}
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
