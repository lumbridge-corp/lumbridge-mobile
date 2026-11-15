import "./style.css";
import { isWeb, token, UNPAIRED_EVENT, wsUrl } from "./api";
import { app, applyEvent, needsCount, onConn, onTerms, setConn, setSnapshot } from "./app";
import { Core } from "./core";
import { el } from "./dom";
import { icon, icons } from "./icons";
import { initNeeds, onNeeds } from "./drafts-store";
import { initNotify } from "./notify";
import { initPush } from "./push";
import { createDrawer } from "./drawer";
import { initPaletteKey, openPalette, paletteKeys } from "./palette-key";
import { listView, originAfter, originList, route, setListView, setTerminalOrigin, START, terminalOrigin, type ListView } from "./router";
import { SCREENS } from "./screens";
import { ASSISTANT_NAME } from "./ns";
import { agentsView } from "./views/agents";
import { agentsTop, type AgentsTop } from "./views/agents-top";
import { panesView, type PanesHandle } from "./views/panes";
import { pairView, redeemFragment } from "./views/pair";
import { initFiles } from "./views/files-uploader";
import { initThoughts, recordingNow } from "./views/thoughts-recorder";
import { terminalView } from "./views/terminal";

/** An instance's own start-up (src/ext/boot.ts, when that folder is there): what it starts, and whether it is busy. */
const extBoot = Object.values(import.meta.glob<{ init(): void; busy(): boolean }>("./ext/boot.ts", { eager: true }));

const root = document.getElementById("app")!;

// scripts/dev.sh only, so plain http only: production devices pair with a one-time #pair= code (views/pair.ts).
const devToken = location.protocol === "http:" ? new URLSearchParams(location.hash.slice(1)).get("token") : null;
if (devToken) { token(devToken); history.replaceState(null, "", `${location.pathname}#/${START}`); }

// ---- The shell: built once, and connection trouble never takes it down. ----

let shell: HTMLElement | null = null;
let master!: HTMLElement, place!: HTMLElement, detail!: HTMLElement, view!: HTMLElement, banner!: HTMLElement, badge!: HTMLElement, assistantBadge!: HTMLElement;
let top!: AgentsTop, panes!: PanesHandle;
const tabLinks = new Map<string, HTMLAnchorElement>();
let leaveDetail: (() => void) | null = null;
let leaveView: (() => void) | null = null;
let detailAddress: string | null = null;
let viewName: string | null = null;
let appsTab!: HTMLElement;
let drawer: ReturnType<typeof createDrawer> | null = null;
let lastRoute: string | null = null;  // what was showing before this route
// A list that isn't showing loses its scroll, on some browsers, so each keeps its own. "found": search results, which share By place's element.
const scrolls = new Map<HTMLElement | "found", number>();
let emptyFor: string | null = null;
let offNeeds: (() => void) | null = null;

function emptyDetail(forPanes: boolean) {
  const box = el("div", "detail-empty");
  // Beside the list on a computer, an overview instead (views/agents-overview.ts). Its own chunk, so a phone's cold load doesn't carry
  // it; the plain words are the fallback if it can't load.
  if (matchMedia("(min-width: 900px)").matches) {
    import("./views/agents-overview").then((m) => { if (box.isConnected) m.agentsOverview(box, forPanes); }, () => plainEmpty(box, forPanes));
    return box;
  }
  plainEmpty(box, forPanes);
  return box;
}

function plainEmpty(box: HTMLElement, forPanes: boolean) {
  box.append(icon("mark", "detail-mark"), el("p", "", forPanes ? "Pick a pane to continue in it." : "Pick an agent to watch it."));
  if (!forPanes) {
    const hint = el("p", "hint");
    hint.innerHTML = "<kbd>j</kbd> <kbd>k</kbd> to move, <kbd>Enter</kbd> to open";
    box.append(hint);
  }
  return box;
}

function tab(id: string, label: string, ic: keyof typeof icons, cls = "", name = "") {
  const a = el("a", `tab tab-${id} ${cls}`.trim());
  a.draggable = false;
  a.href = `#/${id}`;
  a.setAttribute("aria-label", name || label);
  if (name) a.title = name;
  a.append(icon(ic), el("span", "tab-label", label));
  tabLinks.set(id, a);
  return a;
}

function buildShell() {
  const s = el("div", "shell");
  banner = el("button", "conn");
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");
  banner.hidden = true;
  banner.onclick = () => connectNow();
  const nav = el("nav", "tabs");
  nav.setAttribute("aria-label", "Main");
  const brand = el("a", "brand");
  brand.href = `#/${START}`;
  brand.setAttribute("aria-label", "Lumbridge");
  brand.append(icon("mark"));
  // The rail's way into the jump palette, for a mouse; the keys are in its tooltip. A phone has it in the Apps sheet.
  const find = el("button", "rail-find");
  find.type = "button";
  find.setAttribute("aria-label", "Jump to");
  find.title = `Jump to (${paletteKeys})`;
  find.append(icon("search"));
  find.onclick = () => openPalette();
  nav.append(brand, find);
  // A hairline where one group ends and the next begins (screens.ts GROUPS). The rail only: CSS hides it on a phone.
  SCREENS.forEach((s, i) => {
    if (i > 0 && !s.end && s.group !== SCREENS[i - 1].group) nav.append(el("hr", "rail-sep"));
    nav.append(tab(s.id, s.label, s.icon, `${s.where === "drawer" ? "tab-drawer" : ""} ${s.end ? "tab-end" : ""}`, s.name));
  });
  badge = el("b", "badge");
  badge.hidden = true;
  tabLinks.get("agents")!.append(badge);
  assistantBadge = el("b", "badge");
  assistantBadge.hidden = true;
  tabLinks.get("assistant")!.append(assistantBadge);
  // Phones only: what isn't a tab is in here. CSS swaps it for the rest of the rail on a computer.
  appsTab = el("button", "tab tab-apps");
  appsTab.setAttribute("type", "button");
  appsTab.setAttribute("aria-label", "Apps");
  appsTab.setAttribute("aria-haspopup", "dialog");
  appsTab.setAttribute("aria-expanded", "false");
  appsTab.append(icon("apps"), el("span", "tab-label", "Apps"));
  nav.append(appsTab);
  const panel = (cls: string, id: string) => {
    const e = el("section", cls);
    e.id = id;
    e.setAttribute("role", "tabpanel");
    e.setAttribute("aria-labelledby", `${id}-tab`);
    return e;
  };
  master = panel("master", "list-state");
  place = panel("place", "list-place");
  top = agentsTop({ switched: switchList, query: searched, enter: () => panes.openFirst() });
  const column = el("div", "agents-col");
  column.append(top.root, master, place);
  detail = el("section", "detail");
  detail.setAttribute("aria-label", "Terminal");
  view = el("main", "view");
  const stage = el("div", "stage");
  stage.append(column, detail, view);
  s.append(banner, stage, nav);
  root.replaceChildren(s);
  shell = s;
  drawer = createDrawer(stage, appsTab, SCREENS.filter((x) => x.where === "drawer"));
  // A tab tapped while the sheet is open: if it's the screen already showing, no route change would close it.
  nav.addEventListener("click", (e) => { if ((e.target as Element).closest("a")) drawer?.close(); });
  agentsView(master, top);
  panes = panesView(place, top);
  onTerms(updateBadge);
  updateBadge();
  offNeeds?.();
  offNeeds = onNeeds((n) => {
    const count = n.drafts.length;
    assistantBadge.hidden = count === 0;
    assistantBadge.textContent = count > 99 ? "99+" : String(count);
    tabLinks.get("assistant")?.setAttribute("aria-label", count ? `${ASSISTANT_NAME}, ${count} waiting for your OK` : ASSISTANT_NAME);
  });
}

function updateBadge() {
  const n = needsCount();
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? "99+" : String(n);
  tabLinks.get("agents")?.setAttribute("aria-label", n ? `Agents, ${n} need you` : "Agents");
  document.title = n ? `(${n}) Lumbridge` : "Lumbridge";
}

const shownList = () => [master, place].find((e) => e.offsetParent !== null) ?? null;
const scrollKey = (e: HTMLElement) => (e === place && shell!.dataset.finding !== undefined ? "found" : e);

/** Whatever changes which list is showing goes through here, so each comes back where the owner left it, with nothing painted between. */
function keepingScroll(change: () => void) {
  const was = shownList();
  if (was) scrolls.set(scrollKey(was), was.scrollTop);
  change();
  panes.refresh();
  const now = shownList();
  if (now && now !== was) now.scrollTop = scrolls.get(scrollKey(now)) ?? 0;
}

/** From the switch. On a computer a terminal can be open beside the list, and it stays open. */
function switchList(to: ListView) {
  top.clear();
  setListView(to);
  if (route().startsWith("t/")) {
    setTerminalOrigin(to);
    const back = detail.querySelector(".back");
    back?.setAttribute("href", `#/${to}`);
    back?.setAttribute("aria-label", `Back to ${to}`);
  } else location.replace(`#/${to}`);
  showRoute();
}

function searched(q: string) {
  const finding = !!q;
  if (finding === (shell!.dataset.finding !== undefined)) { panes.refresh(); place.scrollTop = 0; return; }
  const was = shownList();
  if (was) scrolls.set(scrollKey(was), was.scrollTop);
  if (finding) shell!.dataset.finding = ""; else delete shell!.dataset.finding;
  panes.refresh();
  // Results start at their top. Clearing puts the owner back where the owner was, in whichever view that was.
  const now = shownList();
  if (now) now.scrollTop = finding ? 0 : scrolls.get(scrollKey(now)) ?? 0;
}

function showRoute() {
  if (!shell) buildShell();
  const r = route();
  const inTerminal = r.startsWith("t/");
  if (inTerminal) setTerminalOrigin(originAfter(lastRoute, terminalOrigin()));
  const screen = SCREENS.find((s) => s.id === r || (s.subroutes && r.startsWith(`${s.id}/`)));
  const inList = inTerminal || r === "panes" || !screen?.view;
  const list: ListView = inTerminal ? originList(terminalOrigin()) : r === "panes" || r === "agents" ? r : listView();
  if (r === "panes" || r === "agents") setListView(list);
  keepingScroll(() => {
    shell!.dataset.list = list;
    shell!.dataset.mode = inTerminal ? "detail" : inList ? "list" : "view";
    shell!.toggleAttribute("data-back", !inTerminal && !!lastRoute?.startsWith("t/")); // leaving a terminal slides the other way
    top.select(list);
  });
  // A terminal opened from Today keeps Today lit in the rail: that's where Back goes.
  const current = inTerminal && terminalOrigin() === "today" ? "today" : inList ? "agents" : screen!.id;
  for (const [id, a] of tabLinks) {
    a.classList.toggle("on", id === current);
    if (id === current) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  // The tab goes back to the view the owner was on. Either way it's the same tab.
  tabLinks.get("agents")!.href = `#/${listView()}`;
  appsTab.classList.toggle("on", !inList && screen?.where === "drawer");
  drawer?.mark(current);
  drawer?.close();

  if (inList) { leaveView?.(); leaveView = null; viewName = null; view.replaceChildren(); }
  else if (viewName !== screen!.id) {
    leaveView?.();
    viewName = screen!.id;
    view.scrollTop = 0;
    leaveView = screen!.view!(view);
  }
  lastRoute = r;

  const address = inTerminal ? decodeURIComponent(r.slice(2)) : null;
  const emptyKind = address ? null : list;
  if (address !== detailAddress || emptyFor !== emptyKind) {
    leaveDetail?.();
    leaveDetail = null;
    detailAddress = address;
    emptyFor = emptyKind;
    if (address) leaveDetail = terminalView(detail, address);
    else detail.replaceChildren(emptyDetail(emptyKind === "panes"));
  }
}

// ---- The connection, underneath it all. ----

const CONNECT_TIMEOUT = 8000, PROBE_TIMEOUT = 1500, SHOW_BANNER_AFTER = 1200, SILENCE = 40000;
let attempt = 0;         // only the newest connection attempt may take effect
let retryIn = 500;
let retryTimer = 0;
let bannerTimer = 0;
let hiddenAt = 0;
let everUp = false;
let newBuild = false;

function renderBanner() {
  if (!shell) return;
  if (app.conn === "online") {
    clearTimeout(bannerTimer);
    bannerTimer = 0;
    banner.hidden = true;
    shell.classList.remove("has-banner");
    return;
  }
  const words = () => navigator.onLine === false ? "Offline. Your screen is kept; waiting for the network." : everUp ? "Reconnecting…" : "Connecting…";
  if (!banner.hidden) { if (banner.textContent !== words()) banner.textContent = words(); return; }
  // A short blip, or waking from the background, stays silent. Failed retries don't restart the wait.
  if (bannerTimer) return;
  bannerTimer = window.setTimeout(() => {
    bannerTimer = 0;
    if (app.conn === "online" || !shell) return;
    banner.textContent = words();
    banner.hidden = false;
    shell.classList.add("has-banner");
  }, SHOW_BANNER_AFTER);
}

function lost(c: Core) {
  if (app.core !== c) return;
  app.core = null;
  setConn("offline");
  scheduleRetry();
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => connect(), retryIn);
  retryIn = Math.min(retryIn * 2, 8000);
}

function connectNow() {
  clearTimeout(retryTimer);
  retryIn = 500;
  connect();
}

async function connect() {
  const url = wsUrl();
  const tok = token();
  if (!url || !tok) return showPair();
  const mine = ++attempt;
  const c = new Core();
  try {
    await Promise.race([
      c.connect(url, tok),
      new Promise((_, no) => setTimeout(() => no(new Error("timeout")), CONNECT_TIMEOUT)),
    ]);
    if (mine !== attempt) { c.close(); return; }
    c.onDown = () => lost(c);
    // A core that answered hello and then hangs must not leave this waiting forever.
    const snap = await Promise.race([
      c.subscribe(applyEvent),
      new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), CONNECT_TIMEOUT)),
    ]);
    if (mine !== attempt) { c.onDown = () => {}; c.close(); return; }
    const old = app.core;
    if (old) { old.onDown = () => {}; old.close(); }
    app.core = c;
    retryIn = 500;
    setSnapshot(snap);
    if (!shell) showRoute();
    everUp = true;
    setConn("online");
    renderBanner();
  } catch (e) {
    c.onDown = () => {};
    c.close();
    if (mine !== attempt) return;
    if ((e as Error).message === "bad_token") return showPair("This device isn't paired any more. Open a new pairing link.");
    if (!shell) showRoute();
    setConn("offline");
    renderBanner();
    scheduleRetry();
  }
}

/** iOS can leave a socket looking open after killing it. Ask it something; if nothing comes back, replace it. */
async function checkAlive() {
  const c = app.core;
  if (!c || !c.open) return connectNow();
  const alive = await Promise.race([
    c.call("machine.list").then(() => true, () => false),
    new Promise<boolean>((ok) => setTimeout(() => ok(false), PROBE_TIMEOUT)),
  ]);
  if (alive || app.core !== c) return;
  dropCore(c);
}

/** A core that can't be trusted any more: close it and start over. Until one answers, everything shows offline. */
function dropCore(c: Core) {
  c.onDown = () => {};
  c.close();
  app.core = null;
  setConn("offline");
  connectNow();
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  // The owner is only just looking again and everything is saved, so this is the moment to pick up a new build.
  if (newBuild && !recordingNow() && !extBoot.some((b) => b.busy())) { location.reload(); return; }
  if (Date.now() - hiddenAt > 3000) navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
  if (!token()) return;
  if (!app.core) connectNow();
  else if (Date.now() - hiddenAt > 3000) checkAlive();
});
window.addEventListener("pageshow", (e) => { if (e.persisted) checkAlive(); });
window.addEventListener("online", () => { if (!app.core) connectNow(); else checkAlive(); });
// The socket can sit open long after the network has gone, so don't wait for the silence check to find out.
window.addEventListener("offline", () => {
  if (app.core) dropCore(app.core);
  else setConn("offline");
  renderBanner();
});
setInterval(() => {
  const c = app.core;
  if (c && !document.hidden && Date.now() - c.lastRx > SILENCE) checkAlive();
}, 10000);
onConn(renderBanner);

function showPair(err = "") {
  clearTimeout(retryTimer);
  shell = null;
  drawer = null;
  lastRoute = null;
  emptyFor = null;
  leaveDetail?.(); leaveDetail = null; detailAddress = null;
  leaveView?.(); leaveView = null; viewName = null;
  pairView(root, err, () => { attempt++; connect(); });
}

// ---- Glass: the keyboard, and gestures the browser would otherwise take. ----

function trackViewport() {
  const vv = window.visualViewport;
  const rootStyle = document.documentElement.style;
  const update = () => {
    const h = vv ? vv.height : window.innerHeight;
    // The keyboard is up when the visual viewport is much shorter than the screen.
    const typing = document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement;
    const keyboard = typing && window.screen.height - h > 220 && matchMedia("(pointer: coarse)").matches;
    document.documentElement.classList.toggle("kb", keyboard);
    // Only follow the visual viewport for the keyboard. An installed iPhone app with a translucent status bar
    // reports it, and 100dvh, too short, which floats the tab bar up off the bottom of the glass. There the
    // screen's own size is right. `navigator.standalone` exists only on iOS.
    if (keyboard) {
      rootStyle.setProperty("--vvh", `${Math.round(h)}px`);
      rootStyle.setProperty("--vvt", `${Math.round(vv?.offsetTop ?? 0)}px`);
    } else {
      rootStyle.removeProperty("--vvt");
      if ((navigator as any).standalone === true) {
        const landscape = matchMedia("(orientation: landscape)").matches;
        const full = `${landscape ? window.screen.width : window.screen.height}px`;
        rootStyle.setProperty("--vvh", full);
        rootStyle.height = full;
        document.body.style.height = full;
        document.body.style.bottom = "auto";
      } else {
        rootStyle.removeProperty("--vvh");
      }
    }
  };
  vv?.addEventListener("resize", update);
  vv?.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  document.addEventListener("focusin", update);
  document.addEventListener("focusout", () => setTimeout(() => {
    update();
    // WebKit can leave an installed app's viewport short after the keyboard closes. A relayout restores it.
    if ((navigator as any).standalone === true && !document.documentElement.classList.contains("kb")) {
      const body = document.body;
      body.style.display = "none";
      void body.offsetHeight;
      body.style.display = "";
      window.scrollTo(0, 0);
    }
  }, 60));
  update();
}

trackViewport();
// iOS ignores user-scalable=no in places. Pinch means something only on the terminal, which handles its own.
for (const type of ["gesturestart", "gesturechange"]) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });

// Redeem a pairing link before anything reads the hash as a route.
async function boot() {
  const err = await redeemFragment();
  if (err) return showPair(err);
  if (wsUrl() && token()) showRoute();
  connect();
}

window.addEventListener("hashchange", () => {
  if (location.hash.startsWith("#pair=")) boot();
  else if (shell) showRoute();
});
window.addEventListener(UNPAIRED_EVENT, () => showPair("This device isn't paired any more. Open a new pairing link."));
if ("serviceWorker" in navigator && isWeb) {
  // The first worker taking over isn't news. A page that had one and gets another is running code from before a deploy.
  let controlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => { newBuild = controlled; controlled = true; });
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

boot();
initPush();
initNeeds();
initNotify();
initThoughts();
initFiles();
for (const b of extBoot) b.init();
// xterm is a separate chunk. Fetch it once the first screen is up, so opening a terminal doesn't wait. (For you, the other one, is
// cached for offline by the worker's own precache: public/sw.js, CHUNKS.)
const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 800));
idle(() => { import("./xterm").catch(() => {}); });
initPaletteKey();
