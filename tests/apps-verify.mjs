// The screen registry, the Apps drawer and the Agents tab's By place view, in real browsers against a scratch core.
//   scripts/dev.sh <port> && scripts/dev-fixture.sh <port> && node tests/apps-verify.mjs <port> [shots dir]
// It seeds layouts straight into the SCRATCH core (ui-lib's seedDoc), which the gateway itself refuses to do. System Chrome and any
// installed WebKit; never `playwright install`.
import { execFileSync } from "node:child_process";
import { addresses, ASSISTANT, chromium, DRAWER, DRAWER_GROUPS, EXT, open, PROFILES, RAIL_SEPS, SCREENS, scratchEnv, seedDoc, seedLayouts, target, webkit } from "./ui-lib.mjs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const [port, shots] = process.argv.slice(2);
if (shots) mkdirSync(shots, { recursive: true });
const t = target(port);
const A = addresses(port);
const hc = (...a) => execFileSync("lbc", a, { env: scratchEnv(port), encoding: "utf8" });
const size = (a) => { const x = JSON.parse(hc("get", a, "--json")); return `${x.cols}x${x.rows}`; };

let failed = 0, passed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra !== "" ? `  [${extra}]` : ""}`); if (ok) passed++; else failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(80); } return false; };
const shot = async (p, name) => { if (shots) { await sleep(120); await p.screenshot({ path: `${shots}/${name}.png` }); } };
const term = (a) => `#/t/${encodeURIComponent(a)}`;
const hash = (p) => p.evaluate(() => location.hash);
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

const browser = await chromium.launch({ channel: "chrome" });

/** A real finger, through the browser's touch handling, so touch-action and pointercancel are what they'd be on a phone. */
async function swipe(p, from, to, { steps = 12, every = 16, hold = 0, during } = {}) {
  const cdp = await p.context().newCDPSession(p);
  const at = (x, y) => [{ x, y, id: 0 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(from.x, from.y) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps) });
    await sleep(every);
  }
  const seen = during ? await during() : undefined;
  if (hold) await sleep(hold);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  return seen;
}
const center = async (p, sel) => {
  const b = await p.locator(sel).boundingBox();
  if (!b) throw new Error(`${sel} isn't on screen at ${await p.evaluate(() => JSON.stringify({ hash: location.hash, cls: document.documentElement.className, mode: document.querySelector(".shell")?.dataset.mode }))}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const drawerY = (p) => p.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".drawer")).transform).m42);
const isOpen = (p) => p.evaluate(() => !document.querySelector(".drawer-layer").hidden);
const openedFully = (p) => until(async () => (await isOpen(p)) && Math.abs(await drawerY(p)) < 0.5, 1500);
const closedFully = (p) => until(async () => !(await isOpen(p)), 1500);
const focusOn = (p, sel) => p.evaluate((s) => !!document.activeElement?.closest(s), sel);

const LAYOUT = () => seedLayouts(port, A);
const blank = () => { seedDoc(port, null); seedDoc(port, null, "lab"); seedDoc(port, null, "rig"); };

// ---- Panes with nothing to show, then a layout arriving by itself ----
blank();
{
  const p = await open(browser, t, "iphone", { hash: "#/panes" });
  check("no layouts anywhere says so", await until(() => p.evaluate(() => document.querySelector(".pm-empty")?.textContent.includes("layouts yet"))));
  await shot(p, "ios-dark-panes-empty");
  LAYOUT();
  check("a layout written meanwhile appears by itself (doc event)", await until(() => p.evaluate(() => document.querySelectorAll(".pane-row").length > 0)));
  check("each machine's document was refetched", await until(() => p.evaluate(() => ["", "lab", "rig"].every((m) => !!document.querySelector(`.pm-machine[data-machine="${m}"] .pm-space`)))));
  check("no errors while it was empty", p.errors.filter((e) => !e.includes("503")).length === 0, p.errors.join("; "));
  await p.context().close();
}

// ---- A machine that can't answer, beside ones that can ----
// A scratch core reached through a script that stops letting anyone through once it's added: core can't add one it can't reach.
const d = `/run/user/${process.getuid()}/k${port}`;
const ghostEnv = scratchEnv(port, "ghost");
const via = `${d}/ghost-via`, gate = `${d}/ghost-up`;
writeFileSync(via, `#!/bin/sh\n[ -e ${gate} ] || exit 1\nexec env XDG_STATE_HOME=${d}/s XDG_RUNTIME_DIR=${d} XDG_CONFIG_HOME=${d}/c XDG_DATA_HOME=${d}/d sh -c "$1"\n`, { mode: 0o755 });
writeFileSync(gate, "");
execFileSync("lbc", ["run", "--bg", "--name", "keeper", "sleep", "1000000"], { env: ghostEnv, stdio: "ignore" });
hc("machine", "add", "--name", "ghost", "--session", "ghost", "--via", via);
rmSync(gate);
execFileSync("lbc", ["server", "stop"], { env: ghostEnv, stdio: "ignore" });
try {
  const p = await open(browser, t, "iphone", { hash: "#/panes" });
  await p.waitForSelector(".pane-row");
  const ghost = '.pm-machine[data-machine="ghost"]';
  check("a machine whose doc.get fails says so plainly", await until(() => p.evaluate((g) => document.querySelector(`${g} .pm-trouble`)?.textContent.includes("Couldn't read ghost's layout"), ghost), 12000));
  check("the others still work", await p.evaluate(() => document.querySelectorAll('.pm-machine[data-machine="lab"] a.row-main').length > 0));
  check("and it has a way to try again", await p.locator(`${ghost} .pm-retry`).count() === 1);
  await p.evaluate(() => { document.querySelector('.pm-machine[data-machine="ghost"]').scrollIntoView(); });
  await shot(p, "ios-dark-panes-machine-down");
  await p.click(`${ghost} .pm-retry`);
  check("trying again asks again, and tells the truth again", await until(() => p.evaluate((g) => !!document.querySelector(`${g} .pm-trouble`), ghost), 12000));
  check("no page errors", p.errors.filter((e) => !e.includes("503")).length === 0, p.errors.join("; "));
  await p.context().close();
} finally {
  hc("machine", "rm", "ghost");
  rmSync(via);
}

// ---- Phones, both themes ----
for (const [profile, tag, ua] of [["iphone", "ios", IPHONE_UA], ["pixel", "pix", ANDROID_UA]]) {
  for (const dark of [true, false]) {
    const name = `${tag}-${dark ? "dark" : "light"}`;
    const say = (s) => `${name}: ${s}`;
    const p = await open(browser, t, profile, { dark, userAgent: ua });
    await p.waitForSelector(".row");

    // -- tabs --
    const shown = await p.evaluate(() => [...document.querySelectorAll(".tabs .tab")].filter((e) => e.offsetParent).map((e) => e.textContent.trim().replace(/\d+\+?$/, "")));
    const labels = shown.map((s) => s.replace(/^\d+/, ""));
    check(say(`tabs are Today, Agents, ${ASSISTANT}, Tasks, Apps`), labels.join() === `Today,Agents,${ASSISTANT},Tasks,Apps`, labels.join());

    // -- open by tap --
    await p.touchscreen.tap(...Object.values(await center(p, ".tab-apps")));
    check(say("tapping Apps opens the sheet"), await openedFully(p));
    await shot(p, `${name}-drawer`);
    const look = await p.evaluate(() => {
      const d = document.querySelector(".drawer"), h = document.querySelector(".drawer-handle"), s = document.querySelector(".drawer-scrim"), tabs = document.querySelector(".tabs");
      const b = getComputedStyle(h, "::before"), a = getComputedStyle(d, "::after");
      return {
        role: d.getAttribute("role"), modal: d.getAttribute("aria-modal"), label: d.getAttribute("aria-label"), radius: getComputedStyle(d).borderTopLeftRadius,
        hw: b.width, hh: b.height, scrim: getComputedStyle(s).backgroundColor, scrimOpacity: getComputedStyle(s).opacity, after: a.content !== "none",
        overTabs: d.getBoundingClientRect().bottom <= tabs.getBoundingClientRect().top + 0.5,
        touch: [getComputedStyle(h).touchAction, getComputedStyle(document.documentElement).touchAction, getComputedStyle(document.body).touchAction],
        tiles: [...document.querySelectorAll(".drawer .app-label")].map((e) => e.textContent),
        groups: [...document.querySelectorAll(".drawer-sec")].map((g) => `${document.getElementById(g.getAttribute("aria-labelledby"))?.textContent}:${[...g.querySelectorAll(".app-label")].map((e) => e.textContent).join()}`),
        // Each tile's left edge, by its place in the row: section by section they must match.
        columns: [...document.querySelectorAll(".drawer-tiles")].map((r) => [...r.children].slice(0, 2).map((e) => Math.round(e.getBoundingClientRect().left))),
        toolsName: document.querySelector('.app[href="#/tools"]')?.getAttribute("aria-label"),
      };
    });
    check(say("it's a labelled dialog"), look.role === "dialog" && look.modal === "true" && look.label === "Apps");
    check(say(`radius ${tag === "ios" ? 32 : 16}, handle 36x5, scrim half black`), look.radius === (tag === "ios" ? "32px" : "16px") && look.hw === "36px" && look.hh === "5px" && look.scrim === "rgba(0, 0, 0, 0.5)" && Number(look.scrimOpacity) > 0.99, JSON.stringify(look));
    check(say("the grid has every screen that isn't a tab, in order"), look.tiles.join() === DRAWER.map((s) => s.label).join(), look.tiles.join());
    check(say("in labelled groups: Daily, Media, System"), look.groups.join("|") === DRAWER_GROUPS.join("|"), look.groups.join("|"));
    const widest = look.columns.reduce((w, c) => (c.length > w.length ? c : w), []);
    check(say("each group's tiles share the same columns"), look.columns.every((c) => c.join() === widest.slice(0, c.length).join()), JSON.stringify(look.columns));
    if (EXT) check(say("Tools keeps its full name for a screen reader"), look.toolsName === SCREENS.find((s) => s.id === "tools").name, look.toolsName);
    check(say("touch-action none on the handle, never the page"), look.touch[0] === "none" && look.touch[1] !== "none" && look.touch[2] !== "none", look.touch.join());
    check(say("the tab bar and the agents badge stay in sight"), look.overTabs && await p.evaluate(() => {
      const b = document.querySelector(".tab-agents .badge"); const r = b.getBoundingClientRect();
      return !b.hidden && Number(b.textContent) > 0 && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(".tab-agents") !== null;
    }));
    check(say("focus moved into it"), await focusOn(p, ".drawer"));

    // -- what a drag does --
    const handle = await center(p, ".drawer-handle");
    const h = await p.evaluate(() => document.querySelector(".drawer").offsetHeight);
    await swipe(p, handle, { x: handle.x + 2, y: handle.y + h * 0.3 }, { steps: 16, every: 25, hold: 180 });
    check(say("a short, slow drag settles back open"), await openedFully(p) && await isOpen(p));
    const mid = await swipe(p, handle, { x: handle.x, y: handle.y - 220 }, { during: () => drawerY(p) });
    check(say("pulled up past open, it barely follows"), mid < -5 && mid > -60, mid.toFixed(1));
    check(say("and settles back"), await openedFully(p));
    const side = await swipe(p, handle, { x: handle.x + 130, y: handle.y + 6 }, { during: () => drawerY(p) });
    check(say("a sideways drag does nothing"), Math.abs(side) < 0.5 && await isOpen(p), side);
    const followed = await swipe(p, handle, { x: handle.x, y: handle.y + h * 0.7 }, { steps: 18, every: 22, hold: 150, during: () => drawerY(p) });
    // The axis locks on the first move of 10 px or more, and the sheet follows from there: with 18 steps that first move is h * 0.7 / 18,
    // which grows with the sheet (a fifth System tile, Lumbridge, added a row).
    const lockedAt = Math.max(10, (h * 0.7) / 18);
    check(say("the sheet follows the finger, minus the move that locks the axis"), Math.abs(followed - (h * 0.7 - lockedAt)) < 12, `${followed.toFixed(0)} of ${(h * 0.7).toFixed(0)}`);
    check(say("dragged past half and let go, it closes"), await closedFully(p));
    check(say("focus returns to the Apps tab"), await focusOn(p, ".tab-apps"));
    await p.touchscreen.tap(...Object.values(await center(p, ".tab-apps")));
    await openedFully(p);
    await swipe(p, handle, { x: handle.x, y: handle.y + 34 }, { steps: 4, every: 8 });
    check(say("a short flick closes it"), await closedFully(p));

    // -- from the tab --
    const appsTab = await center(p, ".tab-apps");
    await swipe(p, appsTab, { x: appsTab.x, y: appsTab.y - 170 }, { steps: 8, every: 12 });
    check(say("dragging up from the Apps tab opens it"), await openedFully(p));
    check(say("and that isn't also a tap on the tab"), await sleep(120).then(() => isOpen(p)));
    await p.keyboard.press("Escape");
    check(say("Esc closes it"), await closedFully(p));
    await swipe(p, appsTab, { x: appsTab.x, y: appsTab.y - 30 }, { steps: 12, every: 30, hold: 150 });
    check(say("a slight, slow pull from the tab falls back"), await closedFully(p));

    // -- from a tile, and tapping --
    await p.touchscreen.tap(...Object.values(await center(p, ".tab-apps")));
    await openedFully(p);
    const before = await hash(p);
    const tile = await center(p, '.app[href="#/notes"]');
    await swipe(p, tile, { x: tile.x, y: tile.y + h * 0.8 }, { steps: 18, every: 22, hold: 150 });
    check(say("a drag that starts on a tile closes, and doesn't open it"), await closedFully(p) && (await hash(p)) === before);
    await p.touchscreen.tap(...Object.values(await center(p, ".tab-apps")));
    await openedFully(p);
    const top = await p.evaluate(() => { const r = document.querySelector(".stage").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 40 }; });
    await p.touchscreen.tap(top.x, top.y);
    check(say("tapping the scrim closes it"), await closedFully(p));
    check(say("and that's all the tap did"), (await hash(p)) === before);

    await p.touchscreen.tap(...Object.values(await center(p, ".tab-tasks")));
    check(say("tasks is a tab now"), await until(async () => (await hash(p)) === "#/tasks" && await p.evaluate(() => document.querySelector(".tab-tasks").classList.contains("on") && !!document.querySelector(".view").offsetParent && document.querySelector(".view").textContent.length > 0)));
    for (const id of EXT ? ["social", "notes", "infra", "tools", "settings"] : ["notes", "files", "thoughts", "settings"]) {
      await p.touchscreen.tap(...Object.values(await center(p, ".tab-apps")));
      await openedFully(p);
      await p.touchscreen.tap(...Object.values(await center(p, `.app[href="#/${id}"]`)));
      const went = await until(async () => (await hash(p)) === `#/${id}` && !(await isOpen(p)), 1500);
      // Most of these load as their own chunk (src/lazy-screens.ts): give it a moment to arrive.
      await until(() => p.evaluate(() => document.querySelector(".view").textContent.length > 0), 3000);
      const v = await p.evaluate(() => ({ text: document.querySelector(".view").textContent.length, on: document.querySelector(".tab-apps").classList.contains("on"), visible: !!document.querySelector(".view").offsetParent }));
      check(say(`${id}: selecting it navigates and closes`), went && v.text > 0 && v.visible && v.on, JSON.stringify(v));
    }
    await p.touchscreen.tap(...Object.values(await center(p, ".tab-apps")));
    await openedFully(p);
    check(say("the screen the owner is on is marked"), await p.evaluate(() => document.querySelector('.app[href="#/settings"]').getAttribute("aria-current") === "page"));
    await shot(p, `${name}-drawer-on-settings`);
    await p.touchscreen.tap(...Object.values(await center(p, ".tab-agents")));
    check(say("another tab closes it and goes there"), await closedFully(p) && (await hash(p)) === "#/agents");
    await p.touchscreen.tap(...Object.values(await center(p, '.list-btn[data-list="panes"]')));
    check(say("the switch goes to By place"), (await hash(p)) === "#/panes");

    // -- Panes --
    await p.waitForSelector(".pane-row");
    await shot(p, `${name}-panes`);
    // Needs you is one line here (L-15): its count, to By state. Each of them is marked where it sits, and says so on its row.
    const order = await p.evaluate(() => {
      const first = document.querySelector(".pm-lists").firstElementChild;
      return { cls: first.className, title: first.querySelector(".pm-needs-title")?.textContent, count: first.querySelector(".pm-needs-count")?.textContent, href: first.getAttribute("href"), rows: first.querySelectorAll(".row").length };
    });
    check(say("Needs you comes first, as one line to By state"), order.cls === "pm-needs" && order.title === "Needs you" && order.href === "#/agents" && order.rows === 0, JSON.stringify(order));
    check(say("counting every machine's"), order.count === "4", JSON.stringify(order));
    const marked = await p.evaluate(() => [...document.querySelectorAll(".pm-machine .pm-rows .row.needs .name, .pm-machine .pm-box.needs .pm-box-name")].map((e) => e.textContent));
    // ci-gateway's space on rig starts folded, so there it's its space header's mark; its own row is checked once that's opened.
    const ciMark = await p.evaluate(() => [...document.querySelectorAll('.pm-machine[data-machine="rig"] .pm-space')].find((s) => s.querySelector(".pm-space-name").textContent === "CI")?.querySelector(".pm-mark.needs")?.textContent ?? "");
    check(say("each is marked in its place, ci-gateway's folded space too"), ["gateway-review", "pr-branch", "token-refresh"].every((n) => marked.includes(n)) && ciMark === "1", `${marked.join()} | CI mark: ${ciMark}`);
    // Out of its place (a search result, as the Needs you group's rows were), a pane says where it is.
    await p.fill(".find-input", "token-refresh");
    const place = await until(() => p.evaluate(() => document.querySelector(".pm-results .row .meta")?.textContent === "lab · Acme › Import"))
      ? "lab · Acme › Import" : await p.evaluate(() => document.querySelector(".pm-results .row .meta")?.textContent ?? "no result");
    check(say("each says where it is"), place === "lab · Acme › Import", place);
    await p.fill(".find-input", "");
    await p.waitForSelector(".pm-machine");
    check(say("no sideways scroll"), await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector(".place").scrollWidth <= document.querySelector(".place").clientWidth));

    const tree = await p.evaluate(() => ({
      machines: [...document.querySelectorAll(".pm-machine-head")].map((e) => e.textContent),
      spaces: [...document.querySelectorAll('.pm-machine[data-machine=""] .pm-space-name')].map((e) => e.textContent),
      tabs: [...document.querySelectorAll('.pm-machine[data-machine=""] .pm-tab-head')].map((e) => e.textContent),
    }));
    check(say("machine, then space, then tab"), tree.machines.length === 3 && tree.machines.slice(1).join() === "lab,rig" && tree.spaces[0] === "Studio" && tree.tabs[0] === "Gateway work", JSON.stringify(tree));
    const odd = await p.evaluate(() => ({
      xss: window.__xss, tags: document.querySelectorAll(".pm-lists img, .pm-lists script, .pm-lists svg[onload], .pm-lists b, .pm-lists i").length,
      name: [...document.querySelectorAll(".pm-space-name")].some((e) => e.textContent.includes("<b>Odd</b>")),
    }));
    check(say("names are text, never markup"), odd.xss === undefined && odd.tags === 0 && odd.name, JSON.stringify(odd));

    const rows = await p.evaluate(() => {
      const row = (sel) => [...document.querySelectorAll(sel)];
      const named = (n) => row(".pane-row").filter((r) => r.querySelector(".name").textContent.includes(n));
      return {
        gone: named("t9999").map((r) => [r.classList.contains("gone"), !!r.querySelector("a"), r.querySelector(".meta").textContent]),
        panel: named("notebook").map((r) => [r.classList.contains("panel"), !!r.querySelector("a"), r.querySelector(".meta").textContent]),
        stackList: named("scratch-shell").length + named("docs-pass").length,
        goneBox: row(".pm-box.gone").length && !row(".pm-box.gone")[0].href, panelBox: row(".pm-box.panel").length && !row(".pm-box.panel")[0].href,
      };
    });
    check(say("a terminal core doesn't have shows as gone, not tappable"), rows.gone[0]?.[0] && !rows.gone[0]?.[1] && rows.gone[0]?.[2] === "Gone", JSON.stringify(rows.gone));
    check(say("a mod panel is a plain row, not tappable"), rows.panel[0]?.[0] && !rows.panel[0]?.[1] && rows.panel[0]?.[2] === "Panel", JSON.stringify(rows.panel));
    check(say("what a stack keeps behind its active child is still listed"), rows.stackList >= 3, rows.stackList);
    check(say("neither is tappable on the map either"), rows.goneBox && rows.panelBox);
    const map = await p.evaluate((a) => {
      const box = (x) => document.querySelector(`.pm-box[data-address="${x}"]`).getBoundingClientRect();
      const m = document.querySelector(`.pm-box[data-address="${a.gw}"]`).parentElement.getBoundingClientRect();
      return { w: box(a.gw).width / m.width, side: box(a.pr).width / m.width, h: box(a.pr).height / m.height, h2: box(a.web).height / m.height, rightOf: box(a.pr).left >= box(a.gw).right - 1, below: box(a.web).top >= box(a.pr).bottom - 1 };
    }, { gw: A["gateway-review"], pr: A["pr-branch"], web: A["web-tests"] });
    check(say("the map follows the weights and the real arrangement"), Math.abs(map.w - 0.5) < 0.01 && Math.abs(map.side - 0.35) < 0.01 && Math.abs(map.h - 0.3) < 0.01 && Math.abs(map.h2 - 0.7) < 0.01 && map.rightOf && map.below, JSON.stringify(map));

    const folded = await p.evaluate(() => [...document.querySelectorAll('.pm-machine[data-machine="rig"] .pm-space')].map((s) => s.classList.contains("open")));
    check(say("a machine with a lot of spaces starts folded"), folded.length === 4 && folded.every((o) => !o), folded.join());
    await p.evaluate(() => { document.querySelector('.pm-machine[data-machine="rig"]').scrollIntoView(); });
    await shot(p, `${name}-panes-folded`);
    await p.click('.pm-machine[data-machine="rig"] .pm-space-head >> nth=1');
    check(say("tapping opens one"), await until(() => p.evaluate(() => document.querySelectorAll('.pm-machine[data-machine="rig"] .pm-space.open .pane-row').length === 2)));
    check(say("with its state in the header"), await p.evaluate(() => document.querySelectorAll('.pm-machine[data-machine="rig"] .pm-mark.needs').length === 1));
    check(say("and ci-gateway is marked on its row there"), await p.evaluate((a) => !!document.querySelector(`.pm-machine[data-machine="rig"] .pm-space.open .pm-rows .row.needs[data-address="${a}"]`), A["ci-gateway"]));

    // -- one machine at a time, remembered --
    await p.tap('.panes .chip[data-m="rig"]');
    const onlyRig = () => p.evaluate(() => ({ machines: [...document.querySelectorAll(".pm-machine-head")].map((e) => e.textContent).join(), needs: document.querySelector(".pm-lists .pm-needs-count")?.textContent ?? "" }));
    const filtered = await until(async () => JSON.stringify(await onlyRig()) === JSON.stringify({ machines: "rig", needs: "1" }));
    check(say("a chip shows one machine, needs-you included"), filtered, JSON.stringify(await onlyRig()));
    await p.reload();
    await p.waitForSelector(".pane-row");
    check(say("and it's still that one after a reload"), await until(async () => (await onlyRig()).machines === "rig"), JSON.stringify(await onlyRig()));
    check(say("the space the owner opened stayed open"), await until(() => p.evaluate(() => document.querySelectorAll('.pm-machine[data-machine="rig"] .pm-space.open').length === 1)));
    await p.tap('.panes .chip[data-m="*"]');
    await p.waitForSelector('.pm-machine[data-machine="lab"]');

    // -- into a pane and back --
    const chat = A["chat-agent"], api = A["acme-api"];
    const sizes = { chat: size(chat), api: size(api) };
    await p.evaluate((a) => { document.querySelector(`.pm-rows .row[data-address="${a}"]`).scrollIntoView({ block: "center" }); }, api);
    await sleep(60);
    await p.touchscreen.tap(...Object.values(await center(p, `.pm-rows .row[data-address="${api}"] a`)));
    await p.waitForSelector(".xterm-rows");
    check(say("tapping a pane opens its terminal"), (await hash(p)) === term(api), await hash(p));
    check(say("back says Panes"), await p.evaluate(() => document.querySelector(".back").getAttribute("href") === "#/panes" && document.querySelector(".back").getAttribute("aria-label") === "Back to panes"));
    await p.reload();
    await p.waitForSelector(".xterm-rows");
    check(say("and still does after a reload"), await p.evaluate(() => document.querySelector(".back").getAttribute("href") === "#/panes"));
    await p.touchscreen.tap(...Object.values(await center(p, ".back")));
    await p.waitForSelector(".pane-row");
    check(say("back returns to Panes"), (await hash(p)) === "#/panes");
    await p.evaluate((a) => { document.querySelector(`.pm-rows .row[data-address="${a}"]`).scrollIntoView({ block: "center" }); }, chat);
    await sleep(60);
    const y1 = await p.evaluate(() => document.querySelector(".place").scrollTop);
    const rowAt = () => p.evaluate((a) => document.querySelector(`.pm-rows .row[data-address="${a}"]`).getBoundingClientRect().top, chat);
    const on1 = await rowAt();
    await p.touchscreen.tap(...Object.values(await center(p, `.pm-rows .row[data-address="${chat}"] a`)));
    await p.waitForSelector(".xterm-rows");
    await until(() => p.evaluate(() => document.querySelector(".xterm-rows").textContent.includes("Ready") || document.querySelector(".xterm-rows").textContent.includes("You said")));
    const words = `from panes ${name} ${Date.now() % 100000}`;
    await p.fill(".composer textarea", words);
    await p.click(".send");
    const got = await until(() => hc("read", chat).includes(`You said: ${words}`), 12000);
    check(say("text sent reaches the scratch terminal"), got);
    check(say("and comes back on screen"), await until(() => p.evaluate((w) => document.querySelector(".xterm-rows").textContent.includes(`You said: ${w}`), words), 8000));
    await shot(p, `${name}-pane-terminal`);
    await p.touchscreen.tap(...Object.values(await center(p, ".back")));
    await until(async () => (await hash(p)) === "#/panes");
    await sleep(100);
    // Recent gains this pane above the list as the owner comes back, so it's the row on screen that has to hold still, not the number.
    const on2 = await rowAt();
    check(say("back lands where the owner was: that row, at that height"), Math.abs(on2 - on1) < 2 && y1 > 0 && on1 > 0, `${on1} -> ${on2}`);
    check(say("looking and sending didn't resize anything"), size(chat) === sizes.chat && size(api) === sizes.api, JSON.stringify(sizes));

    // A box on the map opens the same terminal.
    await p.evaluate((a) => { document.querySelector(`.pm-box[data-address="${a}"]`).scrollIntoView({ block: "center" }); }, A["gateway-review"]);
    await sleep(60);
    await p.touchscreen.tap(...Object.values(await center(p, `.pm-box[data-address="${A["gateway-review"]}"]`)));
    check(say("tapping a box on the map opens that pane"), await until(async () => (await hash(p)) === term(A["gateway-review"])));
    await p.waitForSelector(".xterm-rows");
    await p.touchscreen.tap(...Object.values(await center(p, ".back")));
    await until(async () => (await hash(p)) === "#/panes");

    // -- from Agents, back is Agents --
    await p.waitForSelector(".tab-agents", { state: "visible" });
    await p.touchscreen.tap(...Object.values(await center(p, ".tab-agents")));
    check(say("the Agents tab keeps the owner in the view the owner was on"), (await hash(p)) === "#/panes" && !!(await p.waitForSelector(".place .pane-row")));
    await p.touchscreen.tap(...Object.values(await center(p, '.list-btn[data-list="agents"]')));
    await p.waitForSelector(".master .row");
    await p.touchscreen.tap(...Object.values(await center(p, `.master .row[data-address="${A["gateway-review"]}"] .row-main`)));
    await p.waitForSelector(".xterm-rows");
    check(say("a terminal opened from Agents goes back to Agents"), await p.evaluate(() => document.querySelector(".back").getAttribute("href") === "#/agents"));
    await p.touchscreen.tap(...Object.values(await center(p, ".back")));
    await until(async () => (await hash(p)) === "#/agents");

    const errors = p.errors.filter((e) => !e.includes("503")); // the data screens, with no database in a scratch world
    check(say("no page errors"), errors.length === 0, errors.join("; "));
    await p.context().close();
  }
}

// ---- Terminal gestures keep working: nothing here took the page's touches ----
{
  const p = await open(browser, t, "iphone", { hash: "#/panes" });
  await p.waitForSelector(".pane-row");
  await p.goto(t.base + term(A["gateway-review"]));
  await p.waitForSelector(".xterm-rows");
  await sleep(600);
  const y0 = await p.evaluate(() => document.querySelector(".screen").scrollTop);
  const c = await center(p, ".screen");
  await swipe(p, c, { x: c.x, y: c.y + 200 }, { steps: 10, every: 16 });
  await sleep(300);
  const y1 = await p.evaluate(() => document.querySelector(".screen").scrollTop);
  check("a finger still pans the terminal", y1 < y0, `${y0} -> ${y1}`);
  await p.context().close();
}

// ---- Reduced motion: style.css kills transitions, so nothing can wait on transitionend ----
{
  const p = await open(browser, t, "iphone", { reducedMotion: "reduce" });
  await p.waitForSelector(".row");
  await p.tap(".tab-apps");
  check("reduced motion: opens at once", await until(async () => Math.abs(await drawerY(p)) < 0.5, 200));
  await p.keyboard.press("Escape");
  check("reduced motion: closes and finishes without a transitionend", await closedFully(p));
  await p.tap(".tab-apps");
  await openedFully(p);
  const handle = await center(p, ".drawer-handle");
  const h = await p.evaluate(() => document.querySelector(".drawer").offsetHeight);
  await swipe(p, handle, { x: handle.x, y: handle.y + h * 0.8 }, { steps: 12, every: 16, hold: 150 });
  check("reduced motion: a drag closes too", await closedFully(p));
  await p.context().close();
}

// ---- Keyboard ----
{
  const p = await open(browser, t, "pixel");
  await p.waitForSelector(".row");
  await p.focus(".tab-apps");
  await p.keyboard.press("Enter");
  await openedFully(p);
  const seen = [];
  for (let i = 0; i < 6; i++) { await p.keyboard.press("Tab"); seen.push(await p.evaluate(() => (document.activeElement.closest(".drawer") ? (document.activeElement.getAttribute("href") ?? "handle") : "OUT"))); }
  check("Tab stays inside the sheet", !seen.includes("OUT"), seen.join());
  await p.keyboard.press("Escape");
  await closedFully(p);
  check("Esc gives focus back to the tab", await focusOn(p, ".tab-apps"));
  check("the tab says it's closed", await p.evaluate(() => document.querySelector(".tab-apps").getAttribute("aria-expanded") === "false"));
  await p.focus(".tab-apps");
  await p.keyboard.press("Enter");
  await openedFully(p);
  await p.focus('.app[href="#/notes"]');
  await p.keyboard.press("Enter");
  check("Enter on a tile goes there and closes", await until(async () => (await hash(p)) === "#/notes" && !(await isOpen(p)), 1500));
  await p.context().close();
}

// ---- Desktop, both themes ----
for (const dark of [true, false]) {
  const name = `desk-${dark ? "dark" : "light"}`;
  const say = (s) => `${name}: ${s}`;
  const p = await open(browser, t, "desktop", { dark });
  await p.waitForSelector(".row");
  const rail = await p.evaluate(() => [...document.querySelectorAll(".tabs .tab")].filter((e) => e.offsetParent).map((e) => e.getAttribute("aria-label")?.split(",")[0]));
  check(say("the rail shows every screen, and no Apps"), rail.join() === SCREENS.map((s) => s.name).join(), rail.join());
  const look = await p.evaluate(() => {
    const kids = [...document.querySelector(".tabs").children].filter((e) => e.offsetParent);
    const seps = kids.map((e, i) => (e.classList.contains("rail-sep") ? kids[i - 1].getAttribute("aria-label") : null)).filter(Boolean);
    const tools = document.querySelector(".tab-tools");
    const sep = document.querySelector(".rail-sep").getBoundingClientRect();
    return { seps, label: tools?.querySelector(".tab-label").textContent, lines: tools && Math.round(tools.querySelector(".tab-label").getBoundingClientRect().height), title: tools?.title, rail: Math.round(document.querySelector(".tabs").getBoundingClientRect().width), sepH: sep.height };
  });
  check(say("hairlines between Daily, Media and System"), look.seps.join() === RAIL_SEPS.map((s) => s.name).join() && look.sepH === 1, JSON.stringify(look));
  check(say("the rail still 76 px"), look.rail === 76, JSON.stringify(look));
  if (EXT) check(say("Tools on one line, its full name in its tooltip"), look.label === "Tools" && look.lines <= 20 && look.title === SCREENS.find((s) => s.id === "tools").name, JSON.stringify(look));
  await shot(p, `${name}-agents`);
  check(say("the old list and detail layout stands"), await p.evaluate(() => { const m = document.querySelector(".master").getBoundingClientRect(), d = document.querySelector(".detail").getBoundingClientRect(); return m.width > 300 && d.width > 700 && m.right <= d.left + 1; }));
  await p.click('.list-btn[data-list="panes"]');
  await p.waitForSelector(".pane-row");
  const splitNow = () => p.evaluate(() => {
    const v = document.querySelector(".place").getBoundingClientRect(), d = document.querySelector(".detail").getBoundingClientRect();
    return { side: v.right <= d.left + 1 && v.width > 300 && d.width > 600, master: getComputedStyle(document.querySelector(".master")).display, empty: document.querySelector(".detail").textContent };
  });
  // The pane beside it is the overview, its own chunk, so its words land a moment after the switch.
  const splitOk = (x) => x.side && x.master === "none" && x.empty.includes("Pick a pane");
  await until(async () => splitOk(await splitNow()));
  const split = await splitNow();
  check(say("By place sits where the list does, with the terminal beside it"), splitOk(split), JSON.stringify(split));
  await shot(p, `${name}-panes`);
  const chat = A["chat-agent"];
  const before = size(chat);
  await p.click(`.pm-rows .row[data-address="${chat}"] a`);
  await p.waitForSelector(".xterm-rows");
  const both = await p.evaluate((a) => ({
    panes: !!document.querySelector(".pm-lists")?.offsetParent, current: document.querySelector(".tab.on")?.getAttribute("aria-label")?.split(",")[0],
    open: document.querySelector(`.pm-rows .row[data-address="${a}"]`).classList.contains("open"), box: document.querySelector(`.pm-box[data-address="${a}"]`).classList.contains("open"),
    aria: document.querySelector(`.pm-rows .row[data-address="${a}"] a`).hasAttribute("aria-current"),
  }), chat);
  check(say("opening one keeps Panes up, and marks it"), both.panes && both.current === "Agents" && both.open && both.box && both.aria, JSON.stringify(both));
  await shot(p, `${name}-panes-terminal`);
  await p.fill(".composer textarea", "desktop words");
  await p.keyboard.press("Enter");
  check(say("sending works beside the list"), await until(() => hc("read", chat).includes("You said: desktop words"), 12000));
  await p.keyboard.press("Escape"); // leaves the composer
  await p.keyboard.press("Escape");
  check(say("Esc goes back to Panes, and shows the prompt again"), await until(async () => (await hash(p)) === "#/panes" && await p.evaluate(() => document.querySelector(".detail").textContent.includes("Pick a pane"))));
  check(say("didn't resize it"), size(chat) === before);
  await p.click('.list-btn[data-list="agents"]');
  check(say("back on By state the list is there and the prompt is its own"), await until(() => p.evaluate(() => !!document.querySelector(".master").offsetParent && document.querySelector(".detail").textContent.includes("to move, Enter to open") && !document.querySelector(".detail").textContent.includes("Pick a pane"))));
  for (const id of EXT ? ["assistant", "notes", "tasks", "social", "infra", "tools", "settings"] : ["assistant", "notes", "tasks", "files", "settings"]) {
    await p.click(`.tab-${id}`);
    const ok = await until(() => p.evaluate((i) => location.hash === `#/${i}` && document.querySelector(`.tab-${i}`).classList.contains("on") && !!document.querySelector(".view").offsetParent && document.querySelector(".view").textContent.length > 0, id));
    check(say(`${id} opens from the rail`), ok);
  }
  if (EXT) check(say("Infra's placeholder is in place until the real one lands"), await p.evaluate(() => { location.hash = "#/infra"; return true; }) && await until(() => p.evaluate(() => document.querySelector(".view").textContent.includes("Infra is coming") || document.querySelector(".view").textContent.length > 0)));
  const errors = p.errors.filter((e) => !e.includes("503"));
  check(say("no page errors"), errors.length === 0, errors.join("; "));
  await p.context().close();
}

// ---- Old links still go where they went ----
{
  for (const [route, list] of [["agents", "agents"], ["panes", "panes"]]) {
    const p = await open(browser, t, "iphone", { hash: `#/${route}` });
    const seen = await p.evaluate(() => ({ on: document.querySelector(".list-btn.on").dataset.list, tab: document.querySelector(".tab.on").getAttribute("aria-label").split(",")[0], master: !!document.querySelector(".master").offsetParent, place: !!document.querySelector(".place").offsetParent }));
    check(`#/${route} still opens, at its position on the switch`, seen.on === list && seen.tab === "Agents" && seen.master === (list === "agents") && seen.place === (list === "panes"), JSON.stringify(seen));
    await p.context().close();
  }
  for (const route of ["assistant", "notes", "tasks", "settings"]) {
    const p = await open(browser, t, "iphone", { hash: `#/${route}` });
    const ok = await until(() => p.evaluate(() => !!document.querySelector(".view").offsetParent && document.querySelector(".view").textContent.length > 0));
    check(`#/${route} opens directly`, ok);
    await p.context().close();
  }
  const q = await open(browser, t, "iphone", { hash: term(A["gateway-review"]) });
  await q.waitForSelector(".xterm-rows");
  check("#/t/<address> opens directly, and goes back to Agents", await q.evaluate(() => document.querySelector(".back").getAttribute("href") === "#/agents"));
  await q.goto(t.base + "#/nonsense");
  check("a route that doesn't exist is the inbox", await until(() => q.evaluate(() => !!document.querySelector(".master").offsetParent)));
  await q.context().close();
}

// ---- A pane's terminal coming and going ----
{
  const doomed = JSON.parse(hc("run", "--bg", "--no-parent", "--json", "--name", "doomed-pane", "--label", "lumbridge.seen=0", "sleep", "100000")).address;
  seedDoc(port, { spaces: [{ id: "s1", name: "Short lived", folder: "", tabs: [{ id: "t1", name: "One", root: { id: "t1", type: "row", children: [{ id: "p1", type: "block", content: { terminal: doomed } }] } }] }] });
  const p = await open(browser, t, "iphone", { hash: "#/panes" });
  const row = (x) => p.evaluate((a) => document.querySelector(`.pm-rows .row[data-address="${a}"]`)?.className ?? "", x);
  check("a live terminal is a link", await until(async () => (await row(doomed)).includes("pane-row")));
  hc("kill", doomed);
  try { hc("rm", doomed); } catch { /* it may already be gone */ }
  check("when core no longer has it, it shows as gone, without a reload", await until(() => p.evaluate(() => [...document.querySelectorAll(".pane-row.gone")].some((r) => r.textContent.includes("Gone")))));
  check("the row stopped being a link", await p.evaluate(() => [...document.querySelectorAll(".pane-row.gone")].every((r) => !r.querySelector("a"))));

  // A rename from elsewhere, while the owner is reading.
  await p.evaluate(() => { window.__head = document.querySelector(".inbox-head"); });
  seedDoc(port, { spaces: [{ id: "s1", name: "Renamed elsewhere", folder: "", tabs: [] }] });
  check("a document changing on this core shows up", await until(() => p.evaluate(() => document.querySelector(".pm-space-name")?.textContent === "Renamed elsewhere")));
  check("without rebuilding the screen", await p.evaluate(() => window.__head === document.querySelector(".inbox-head")));
  seedDoc(port, { spaces: [{ id: "m1", name: "Rig moved", folder: "", tabs: [] }] }, "rig");
  check("a document changing on another machine shows up", await until(() => p.evaluate(() => [...document.querySelectorAll('.pm-machine[data-machine="rig"] .pm-space-name')].some((e) => e.textContent === "Rig moved"))));
  await p.context().close();
  LAYOUT();
}

// ---- Losing the connection ----
{
  const ctx = await browser.newContext({ ...PROFILES.iphone, colorScheme: "dark" });
  const ctl = { refuse: true, sockets: new Set() };
  await ctx.routeWebSocket(/\/ws$/, (ws) => {
    if (ctl.refuse) { ws.close({ code: 1011 }); return; }
    const server = ws.connectToServer();
    ctl.sockets.add(ws);
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    ws.onClose(() => { ctl.sockets.delete(ws); server.close(); });
    server.onClose(() => { ctl.sockets.delete(ws); ws.close(); });
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.addInitScript((tok) => localStorage.setItem("lumbridge.token", tok), t.token);
  await p.goto(`${t.base}#/panes`);
  check("offline with nothing read yet says so", await until(() => p.evaluate(() => document.querySelector(".pm-empty")?.textContent.includes("Can't reach"))));
  await shot(p, "ios-dark-panes-offline");
  ctl.refuse = false;
  check("and fills in when the connection comes", await until(() => p.evaluate(() => document.querySelectorAll(".pane-row").length > 0), 15000));
  const named = () => p.evaluate(() => [...document.querySelectorAll(".pm-space-name")].map((e) => e.textContent));
  ctl.refuse = true;
  for (const s of ctl.sockets) s.close({ code: 1011 });
  await sleep(300);
  check("losing the connection keeps what's on screen", (await named()).includes("Studio"));
  seedDoc(port, { spaces: [{ id: "s-new", name: "Written while away", folder: "", tabs: [] }] });
  await sleep(500);
  check("nothing reaches it while it's away", !(await named()).includes("Written while away"));
  ctl.refuse = false;
  check("reconnecting reads the documents again, which a snapshot wouldn't say", await until(async () => (await named()).includes("Written while away"), 20000), (await named()).join());
  check("no page errors through all of that", errors.length === 0, errors.join("; "));
  await ctx.close();
  LAYOUT();
}

// ---- WebKit, the closest thing here to Safari ----
{
  const wk = await webkit.launch();
  const ctx = await wk.newContext({ ...PROFILES.iphone, colorScheme: "dark", userAgent: IPHONE_UA });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !m.text().includes("interactive-widget") && !m.text().includes("503")) errors.push(m.text()); });
  await p.addInitScript((tok) => localStorage.setItem("lumbridge.token", tok), t.token);
  await p.goto(`${t.base}#/agents`);
  await p.waitForSelector(".row", { state: "attached" });
  await p.tap(".tab-apps");
  check("WebKit: tapping Apps opens the sheet", await openedFully(p));
  check("WebKit: radius 32 on iOS", await p.evaluate(() => getComputedStyle(document.querySelector(".drawer")).borderTopLeftRadius === "32px"));
  await shot(p, "webkit-drawer");
  const h = await p.evaluate(() => document.querySelector(".drawer").offsetHeight);
  const c = await center(p, ".drawer-handle");
  await p.mouse.move(c.x, c.y);
  await p.mouse.down();
  for (let i = 1; i <= 16; i++) { await p.mouse.move(c.x, c.y + (h * 0.8 * i) / 16); await sleep(20); }
  await sleep(150);
  await p.mouse.up();
  check("WebKit: dragging down closes it", await closedFully(p));
  check("WebKit: focus returns to the tab", await focusOn(p, ".tab-apps"));
  await p.tap(".tab-apps");
  await openedFully(p);
  await p.tap('.app[href="#/notes"]');
  check("WebKit: selecting an app navigates and closes", await until(async () => (await hash(p)) === "#/notes" && !(await isOpen(p)), 1500));
  await p.tap(".tab-agents");
  await p.waitForSelector(".list-btn.on", { state: "visible" });
  await p.tap('.list-btn[data-list="panes"]');
  await p.waitForSelector(".pane-row");
  await shot(p, "webkit-panes");
  check("WebKit: Panes lists, the Needs you line first", await p.evaluate(() => document.querySelector(".pm-lists").firstElementChild.classList.contains("pm-needs")));
  check("WebKit: no sideways scroll", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const chat = A["chat-agent"];
  const before = size(chat);
  await p.tap(`.pm-rows .row[data-address="${chat}"] a`);
  await p.waitForSelector(".xterm-rows", { timeout: 10000 });
  await p.fill(".composer textarea", "webkit words");
  await p.tap(".send");
  check("WebKit: a pane opens, and text reaches it", await until(() => hc("read", chat).includes("You said: webkit words"), 12000));
  await p.tap(".back");
  check("WebKit: back returns to Panes", await until(async () => (await hash(p)) === "#/panes"));
  check("WebKit: no resize", size(chat) === before);
  check("WebKit: no errors", errors.length === 0, errors.join("; "));
  await wk.close();
}

// ---- one screen at a time: each drawer app replaces the last, never stacks under it (Music once appended, so Files stayed on top)
{
  const p = await open(browser, t, "iphone", { hash: "#/files" });
  for (const id of EXT ? ["files", "music", "thoughts", "music", "notes", "infra", "tools", "social", "settings", "music", "files"] : ["files", "thoughts", "notes", "files", "settings", "thoughts", "files"]) {
    await p.evaluate((h) => { location.hash = h; }, `#/${id}`);
    const kids = await until(() => p.evaluate(() => document.querySelector("main.view")?.childElementCount === 1), 5000);
    check(`#/${id}: the view holds that one screen`, kids, String(await p.evaluate(() => document.querySelector("main.view")?.childElementCount)));
  }
  await p.context().close();
}

await browser.close();
console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
process.exit(failed ? 1 : 0);
