// Pick a desktop app pane from the phone and carry on in it: machine, space, tab, pane. Data comes from each machine's layout
// document (panes-logic.ts), and opening one is the ordinary terminal screen, so watching never resizes it (rule 3).
import "./panes.css";
import { app, folderOf, homeless, isAgent, labelOf, LOCAL_MACHINE, machineName, onConn, onDoc, onTerms, setNamer, terms, touchTerminals } from "../app";
import { bucket, type Terminal } from "../core";
import { el } from "../dom";
import { icon } from "../icons";
import { compareRows, showFolder } from "../inbox";
import {
  addressesIn, DOC, favoritesIn, findPanes, isDefaultName, listAll, looseNeeds, needsYou, paneKind, paneLabel, paneNames, parseDoc, parseRecent, pushRecent, recentIn, startsOpen, tally,
  type Box, type Listed, type Machine, type Pane, type Space, type Tab,
} from "../panes-logic";
import { go, route } from "../router";
import type { AgentsTop } from "./agents-top";
import { createRow, menuOpen, onMenuClosed, pref, setHidden, setPref, setText, stateOf, termHref } from "./rows";
import { NS } from "../ns";

const MACHINE_KEY = `${NS}.panes.machine`, OPEN_KEY = `${NS}.panes.open`, RECENT_KEY = `${NS}.panes.recent`;
const DEBOUNCE = 250, CALL_TIMEOUT = 8000;

/** `sig` is the layout as one string, so a frame can compare it without walking it. */
type Doc = { status: "loading" } | { status: "ok"; spaces: Space[]; written: boolean; sig: string } | { status: "error"; why: string };
interface Known { machine: Machine; state?: string }

// Kept between visits, so coming back to the screen shows the last layout at once while it refreshes.
let known: Known[] = [{ machine: null }];
let listed = false;  // until the machines are known, a remembered filter can't be judged
const docs = new Map<string, Doc>();
const keyOf = (m: Machine) => m ?? "";
const spacesOf = (m: Machine) => { const d = docs.get(keyOf(m)); return d?.status === "ok" ? d.spaces : []; };
const sigOf = (m: Machine) => { const d = docs.get(keyOf(m)); return d?.status === "ok" ? d.sig : d?.status === "error" ? `!${d.why}` : "…"; };
const nameOf = (m: Machine) => machineName(m ?? LOCAL_MACHINE);

const inTime = <T,>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("no answer")), CALL_TIMEOUT))]);

export interface PanesHandle {
  /** Something changed that decides what shows here: which list, or the search. Draws it now, before anything paints. */
  refresh(): void;
  /** Enter in the search box. */
  openFirst(): void;
}

export function panesView(root: HTMLElement, top: AgentsTop): PanesHandle {
  let dirty = false;                 // something changed while this was hidden
  let names = new Map<string, string>();
  let placed = new Set<string>();
  setNamer((t) => names.get(t.address) ?? paneLabel(t));
  let recent = parseRecent(pref(RECENT_KEY));
  let recentShown = recent;          // holds still while a terminal is open beside the list, and while it's scrolled out of sight above
  let seenScroll = 0;                // the list's scroll as the owner last saw it (not a search's)
  let found: Listed[] = [];
  let only = pref(MACHINE_KEY);      // show one machine; `""` is this core
  let listFailed = "";
  let openAddress: string | null = null;
  let touching = false, touchEnded = 0, deferred = false;
  let lastKey = "";
  const gens = new Map<string, number>();
  const timers = new Map<string, number>();
  let listTimer = 0;
  // Which spaces the owner has opened or closed, by machine and id. Anything else follows startsOpen.
  let choices: Record<string, boolean> = {};
  try { choices = JSON.parse(pref(OPEN_KEY) ?? "{}") ?? {}; } catch { /* start over */ }

  // ---- what's patched in place between layouts ----
  const patches = new Map<string, (() => void)[]>();  // by address
  let spacePatches: (() => void)[] = [];
  const onPatch = (address: string, fn: () => void) => { const l = patches.get(address); if (l) l.push(fn); else patches.set(address, [fn]); fn(); };

  // ---- skeleton of the screen ----
  const page = el("div", "inbox panes");
  const chips = el("div", "chips");
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", "Filter by machine");
  const lists = el("div", "pm-lists");
  page.append(chips, lists);
  root.replaceChildren(page);

  function skeleton() {
    const s = el("div", "skeleton");
    s.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 6; i++) { const r = el("div", "skel-row"); r.append(el("span", "skel-dot"), el("span", "skel-lines")); s.append(r); }
    return s;
  }

  // ---- reading the documents ----
  function schedule(m: Machine) {
    const key = keyOf(m);
    clearTimeout(timers.get(key));
    timers.set(key, window.setTimeout(() => { timers.delete(key); read(m); }, DEBOUNCE));
  }

  async function read(m: Machine) {
    const c = app.core;
    if (!c || !root.isConnected) return;
    const key = keyOf(m);
    const gen = (gens.get(key) ?? 0) + 1;
    gens.set(key, gen);
    // A machine the list has since dropped keeps no document.
    const stale = () => gens.get(key) !== gen || app.core !== c || !known.some((k) => keyOf(k.machine) === key);
    try {
      const params = m ? { name: DOC, on: m } : { name: DOC };
      const r = await inTime(c.call<{ value: unknown; version: number }>("doc.get", params));
      if (stale()) return;
      const spaces = parseDoc(r?.value, m);
      docs.set(key, { status: "ok", spaces, written: r?.value != null, sig: JSON.stringify(spaces) });
      refreshNames();
    } catch (e) {
      // The connection went: what the owner is looking at is still the best there is, and the reconnect reads it again.
      if (stale() || !c.open) return;
      docs.set(key, { status: "error", why: (e as Error).message });
    }
    render();
  }

  async function readAll() {
    const c = app.core;
    if (!c || !root.isConnected) return;
    // The machines already known (this core, at least) are read while the list is asked for, not after it. Each one draws
    // as soon as its own answer is in: a slow or failing machine holds up nobody else.
    const asked = new Set<string>();
    const readKnown = () => {
      for (const k of known) {
        const key = keyOf(k.machine);
        if (asked.has(key)) continue;
        asked.add(key);
        if (!docs.has(key)) docs.set(key, { status: "loading" });
        read(k.machine);
      }
    };
    readKnown();
    try {
      const r = await inTime(c.call<{ machines?: { name?: unknown; state?: unknown }[] }>("machine.list"));
      if (app.core !== c) return;
      const named = (r?.machines ?? []).filter((x) => typeof x?.name === "string" && x.name).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      known = [{ machine: null }, ...named.map((x) => ({ machine: x.name as string, state: typeof x.state === "string" ? x.state : undefined }))];
      listed = true;
      listFailed = "";
      const wanted = new Set(known.map((k) => keyOf(k.machine)));
      for (const k of docs.keys()) if (!wanted.has(k)) docs.delete(k);
      refreshNames();
    } catch (e) {
      if (app.core !== c) return;
      listFailed = (e as Error).message;
    }
    readKnown();
    render();
  }

  function scheduleAll() {
    clearTimeout(listTimer);
    // Nothing on the screen yet (a cold load's first snapshot): there's nothing to batch with, so read now.
    if (!everRead()) readAll();
    else listTimer = window.setTimeout(readAll, DEBOUNCE);
  }

  // ---- what each pane is called, for every view ----
  const allDocs = () => known.map((k) => ({ machine: k.machine, spaces: spacesOf(k.machine) }));

  function refreshNames() {
    const docsNow = allDocs();
    const next = paneNames(docsNow, terms);
    const changed = [...next].filter(([a, n]) => names.get(a) !== n).map(([a]) => a);
    for (const a of names.keys()) if (!next.has(a)) changed.push(a);
    names = next;
    placed = new Set(docsNow.flatMap((d) => d.spaces.flatMap(addressesIn)));
    // Every list and the open terminal show these. One frame later, and only the rows it touched.
    if (changed.length) touchTerminals(changed);
  }

  // ---- a pane ----
  const openable = (p: Pane, k: string, o: { meta: (t: Terminal) => string; where: (t: Terminal) => string; asks: boolean }) => {
    const address = p.address!;
    const row = createRow(address, {
      key: k, asks: o.asks, meta: o.meta,
      cls: (t) => `row pane-row ${t.state !== "live" ? "ended" : isAgent(t) ? bucket(t) : "plain"}${address === openAddress ? " open" : ""}`,
      where: o.where,
      current: () => address === openAddress,
      grew: () => patchOne(address),
    });
    onPatch(address, () => { const t = terms.get(address); if (t) row.patch(t, Date.now()); });
    return row.root;
  };

  /** A pane in its place in the tree. Its tab's name goes on the line when the tab has no heading to say it. */
  function paneRow(p: Pane, k: string, tabNote: string): HTMLElement {
    const kind = paneKind(p, terms);
    if (kind === "live" || kind === "ended") {
      const note = (t: Terminal) => (labelOf(t).startsWith(tabNote) ? "" : tabNote);
      return openable(p, k, {
        asks: false,
        meta: (t) => [stateOf(t) || (isAgent(t) ? "" : "Shell"), note(t), showFolder(folderOf(t))].filter(Boolean).join(" · "),
        where: (t) => [note(t), folderOf(t)].filter(Boolean).join(", "),
      });
    }
    const r = el("div", `row pane-row ${kind}`);
    r.setAttribute("role", "listitem");
    const main = el("div", "row-main");
    const body = el("span", "row-body");
    const l1 = el("span", "row-l1");
    l1.append(el("span", "name", kind === "panel" ? p.title || "Panel" : p.title || p.address || "Terminal"));
    body.append(l1, el("span", "meta", kind === "panel" ? "Panel" : "Gone"));
    main.append(el("span", "dot"), body);
    r.append(main);
    return r;
  }

  /** A pane out of its place, in a group or a search result, so it says where it lives. */
  const placedRow = (x: Listed, k: string, asks: boolean) => openable(x.pane, k, { asks, meta: () => placeOf(x), where: () => placeOf(x) });

  /** The tab's real arrangement. The list below says all of it for a screen reader, and has the bigger targets. */
  function tabMap(boxes: Box[]): HTMLElement {
    const map = el("div", "pm-map");
    map.setAttribute("aria-hidden", "true");
    for (const b of boxes) {
      const kind = paneKind(b.pane, terms);
      const tappable = kind === "live" || kind === "ended";
      const box = tappable ? el("a", "pm-box") : el("div", "pm-box");
      box.style.left = `${b.x * 100}%`;
      box.style.top = `${b.y * 100}%`;
      box.style.width = `${b.w * 100}%`;
      box.style.height = `${b.h * 100}%`;
      const inner = el("span", "pm-box-in");
      const label = el("span", "pm-box-name");
      inner.append(el("span", "dot"), label);
      box.append(inner);
      map.append(box);
      if (!tappable) {
        box.className = `pm-box ${kind}`;
        setText(label, kind === "panel" ? b.pane.title || "Panel" : "Gone");
        continue;
      }
      const address = b.pane.address!;
      (box as HTMLAnchorElement).href = termHref(address);
      (box as HTMLAnchorElement).tabIndex = -1;
      (box as HTMLAnchorElement).draggable = false;
      box.dataset.address = address;
      let cls = "";
      onPatch(address, () => {
        const t = terms.get(address);
        if (!t) return;
        const next = `pm-box ${t.state !== "live" ? "ended" : isAgent(t) ? bucket(t) : "plain"}${address === openAddress ? " open" : ""}`;
        if (cls !== next) { box.className = cls = next; }
        setText(label, labelOf(t));
      });
    }
    return map;
  }

  function tabBlock(tab: Tab, spaceKey: string): HTMLElement {
    const sec = el("section", "pm-tab");
    sec.dataset.tab = tab.id;
    const unnamed = isDefaultName(tab.name);
    // One pane's row already says it, and "Tab" says nothing.
    if (tab.panes.length > 1 && !unnamed) sec.append(el("h4", "pm-tab-head", tab.name));
    if (tab.boxes.length > 1) sec.append(tabMap(tab.boxes));
    const list = el("div", "pm-rows");
    list.setAttribute("role", "list");
    if (!tab.panes.length) list.append(el("p", "pm-note", "Nothing in this tab."));
    const note = tab.panes.length === 1 && !unnamed ? tab.name.trim() : "";
    tab.panes.forEach((p, i) => list.append(paneRow(p, `${spaceKey}/${tab.id}/${p.id || i}`, note)));
    sec.append(list);
    return sec;
  }

  // ---- a space, folded or not ----
  function isOpen(key: string, spaces: number) { return choices[key] ?? startsOpen(spaces); }

  function spaceBlock(space: Space, m: Machine, count: number): HTMLElement {
    const key = `${keyOf(m)}|${space.id}`;
    const open = isOpen(key, count);
    const card = el("section", `pm-space${open ? " open" : ""}`);
    const btn = el("button", "pm-space-head");
    btn.type = "button";
    btn.dataset.k = `space:${key}`;
    btn.setAttribute("aria-expanded", String(open));
    const text = el("span", "pm-space-text");
    text.append(el("span", "pm-space-name", space.name || "Space"));
    const folder = showFolder(homeless(space.folder));
    if (folder) text.append(el("span", "meta", folder));
    const marks = el("span", "pm-marks");
    btn.append(icon("chevron", "pm-chev"), text, marks);
    btn.onclick = () => {
      choices[key] = !open;
      setPref(OPEN_KEY, JSON.stringify(choices));
      render(true);
    };
    card.append(btn);
    const all = addressesIn(space);
    const patchMarks = () => {
      const n = tally(all, terms);
      const bits: [string, number, string][] = [["needs", n.needs, "need you"], ["working", n.working, "working"], ["done", n.done, "done"]];
      const key2 = bits.map((b) => b[1]).join();
      if (marks.dataset.n === key2) return;
      marks.dataset.n = key2;
      marks.replaceChildren(...bits.filter((b) => b[1]).map(([cls, v, word]) => {
        const m2 = el("span", `pm-mark ${cls}`, String(v));
        m2.title = `${v} ${word}`;
        return m2;
      }));
    };
    patchMarks();
    spacePatches.push(patchMarks);
    if (open) for (const tab of space.tabs) card.append(tabBlock(tab, key));
    return card;
  }

  // ---- a machine ----
  function machineBlock(k: Known): HTMLElement {
    const doc = docs.get(keyOf(k.machine)) ?? { status: "loading" as const };
    const sec = el("section", "pm-machine");
    sec.dataset.machine = keyOf(k.machine);
    const h = el("h2", "pm-machine-head", nameOf(k.machine));
    sec.append(h);
    if (doc.status === "loading") {
      sec.append(el("p", "pm-note", "Reading its layout…"));
    } else if (doc.status === "error") {
      const box = el("div", "pm-trouble");
      box.append(el("span", "", `Couldn't read ${nameOf(k.machine)}'s layout.`));
      box.append(el("span", "pm-why", doc.why));
      const retry = el("button", "btn pm-retry", "Try again");
      retry.type = "button";
      retry.onclick = () => { docs.set(keyOf(k.machine), { status: "loading" }); render(); read(k.machine); };
      box.append(retry);
      sec.append(box);
    } else if (!doc.spaces.length) {
      sec.append(el("p", "pm-note", doc.written ? "Its layout has no spaces." : "No desktop app layout on this machine."));
    } else {
      for (const s of doc.spaces) sec.append(spaceBlock(s, k.machine, doc.spaces.length));
    }
    return sec;
  }

  // ---- the page ----
  const placeOf = (p: Listed) => {
    // A tab named only with symbols, like the Favorites mod's ★, says nothing the space doesn't.
    const tab = p.tab && !isDefaultName(p.tab.name) && /[\p{L}\p{N}]/u.test(p.tab.name) ? p.tab.name : "";
    const within = [p.space?.name, tab].filter(Boolean).join(" › ");
    return [nameOf(p.machine), within || showFolder(folderOf(p.terminal))].filter(Boolean).join(" · ");
  };

  function visibleMachines() {
    if (listed && only !== null && !known.some((k) => keyOf(k.machine) === only)) only = null;
    return known.filter((k) => only === null || keyOf(k.machine) === only);
  }

  function renderChips() {
    chips.classList.toggle("pending", !listed);
    setHidden(chips, !!top.query() || (listed && known.length < 2));
    const wanted = [null, ...known.map((k) => keyOf(k.machine))];
    if (chips.dataset.m !== JSON.stringify(wanted)) {
      chips.dataset.m = JSON.stringify(wanted);
      chips.replaceChildren(...wanted.map((m) => {
        const c = el("button", "chip", m === null ? "All" : nameOf(m || null));
        c.type = "button";
        c.dataset.m = m ?? "*";
        c.onclick = () => { only = m; setPref(MACHINE_KEY, only); render(true); };
        return c;
      }));
    }
    for (const c of chips.children) {
      const on = (c as HTMLElement).dataset.m === (only ?? "*");
      c.classList.toggle("on", on);
      c.setAttribute("aria-pressed", String(on));
    }
  }

  /** The row at the top of the view, to hold still when something above it comes or goes. Never one in Recent: coming back
   * from a pane reorders Recent, and holding one of its rows still would move everything else by a row. */
  function anchorRow() {
    if (root.scrollTop <= 0) return null;
    const edge = root.getBoundingClientRect().top;
    for (const r of lists.querySelectorAll<HTMLElement>("[data-k]")) {
      if (r.closest(".group.recent")) continue;
      const b = r.getBoundingClientRect();
      if (b.bottom > edge) return { k: r.dataset.k!, top: b.top };
    }
    return null;
  }

  /** Whether Recent can catch up without moving the owner's scroll or what the owner is reading: the owner is at the top, or the row the list holds
   * still (anchorRow's) is above where Recent is, or would go (just above the first machine). Otherwise, coming back from a pane
   * scrolled further down, it waits until the owner scrolls up to it. Measured against the scroll the owner left (seenScroll): a list coming
   * back into view can be drawn before its scroll is put back. */
  function recentInSight() {
    if (seenScroll <= 0) return true;
    const at = (e: Element) => { const b = e.getBoundingClientRect(), edge = root.getBoundingClientRect().top - root.scrollTop; return [b.top - edge, b.bottom - edge]; };
    const spot = lists.querySelector(".group.recent") ?? lists.querySelector(".pm-machine");
    if (!spot) return true;
    for (const r of lists.querySelectorAll<HTMLElement>("[data-k]")) {
      if (r.closest(".group.recent")) continue;
      const [rTop, rBottom] = at(r);
      if (rBottom > seenScroll) return rTop < at(spot)[0];
    }
    return true;
  }

  function quickGroup(title: string, cls: string, items: Listed[]): HTMLElement {
    const sec = el("section", `group ${cls}`);
    const h = el("h2", "group-head");
    h.append(el("span", "group-title", title), el("span", "group-count", String(items.length)));
    const rows = el("div", "pm-quick");
    rows.setAttribute("role", "list");
    for (const x of items) rows.append(placedRow(x, `${cls}/${x.terminal.address}`, false));
    sec.append(h, rows);
    return sec;
  }

  function layOut(needs: Listed[], favorites: Listed[], recents: Listed[]) {
    const anchor = anchorRow();
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.k ?? null;
    const scroll = root.scrollTop;
    patches.clear();
    spacePatches = [];
    if (top.query()) {
      lists.replaceChildren(found.length ? resultsBlock() : emptyState("Nothing matches.", "Search covers every pane on every machine, folded spaces included."));
      refocus(focused);
      return;
    }
    const parts: HTMLElement[] = [];
    if (listFailed) {
      const box = el("div", "pm-trouble");
      box.append(el("span", "", "Couldn't ask which machines there are, so these may not be all of them."), el("span", "pm-why", listFailed));
      parts.push(box);
    }
    // By state lists who needs the owner; here it's one line that goes there, and each of them is marked where it sits below.
    if (needs.length) {
      const line = el("a", "pm-needs");
      line.href = "#/agents";
      line.dataset.k = "needs";
      line.setAttribute("aria-label", `${needs.length} need${needs.length === 1 ? "s" : ""} you: show them By state`);
      line.append(el("span", "dot"), el("span", "pm-needs-title", "Needs you"), el("span", "pm-needs-count", String(needs.length)), el("span", "pm-needs-go", "By state"), icon("chevron", "pm-needs-chev"));
      parts.push(line);
      // One in no layout has no place below to be marked in, so it's listed here, under the line, and only here.
      const nowhere = needs.filter((x) => !x.space);
      if (nowhere.length) {
        const rows = el("div", "pm-quick pm-loose");
        rows.setAttribute("role", "list");
        for (const x of nowhere) rows.append(placedRow(x, `loose/${x.terminal.address}`, true));
        parts.push(rows);
      }
    }
    if (favorites.length) parts.push(quickGroup("Favorites", "favorites", favorites));
    if (recents.length) parts.push(quickGroup("Recent", "recent", recents));
    for (const k of visibleMachines()) parts.push(machineBlock(k));
    if (!parts.length) parts.push(emptyState("No machines.", ""));
    const blank = visibleMachines().every((k) => { const d = docs.get(keyOf(k.machine)); return d?.status === "ok" && !d.spaces.length; });
    lists.replaceChildren(...(blank ? [emptyState("No desktop layouts yet.", "When the Lumbridge desktop app has a space on a machine, its panes show up here.")] : parts));
    root.scrollTop = scroll;
    if (anchor) {
      const again = [...lists.querySelectorAll<HTMLElement>("[data-k]")].find((r) => r.dataset.k === anchor.k);
      if (again) root.scrollTop += again.getBoundingClientRect().top - anchor.top;
    }
    refocus(focused);
  }

  function refocus(k: string | null) {
    if (k) [...lists.querySelectorAll<HTMLElement>("[data-k]")].find((r) => r.dataset.k === k)?.focus({ preventScroll: true });
  }

  function resultsBlock() {
    const rows = el("div", "pm-quick pm-results");
    rows.setAttribute("role", "list");
    for (const x of found) rows.append(placedRow(x, `found/${x.terminal.address}`, true));
    return rows;
  }

  function emptyState(title: string, sub: string) {
    const e = el("div", "inbox-empty pm-empty");
    e.append(icon("mark", "empty-mark"), el("p", "empty-title", title));
    if (sub) e.append(el("p", "empty-sub", sub));
    return e;
  }

  function renderSum(loose: number) {
    const n = tally(visibleMachines().flatMap((k) => spacesOf(k.machine).flatMap(addressesIn)), terms);
    n.needs += loose;
    const bits: string[] = [];
    if (n.needs) bits.push(`${n.needs} need${n.needs === 1 ? "s" : ""} you`);
    if (n.working) bits.push(`${n.working} working`);
    // Beside the switch there's room for what matters. The count is for when nothing else is going on.
    if (!bits.length && n.panes) bits.push(`${n.panes} pane${n.panes === 1 ? "" : "s"}`);
    top.setSum("panes", bits.join(" · "));
  }

  const everRead = () => [...docs.values()].some((d) => d.status !== "loading");

  function render(force = false, changed?: Set<string>) {
    // Hidden, there's nobody to draw for. Coming back draws it all, before anything paints.
    if (root.offsetParent === null) { dirty = true; return; }
    const all = dirty ? undefined : changed;
    dirty = false;
    const query = top.query();
    renderChips();
    const everything = listAll(allDocs(), terms);
    const loose = looseNeeds(everything).filter((x) => only === null || keyOf(x.machine) === only);
    renderSum(loose.length);
    found = query ? findPanes(query, everything, labelOf) : [];
    top.setFound(query ? (found.length === 1 ? "1 match" : `${found.length} matches`) : null);
    if (!query && !everRead()) {
      // Nothing to show yet: say why, once it's clear that's what's happening.
      const offline = app.conn === "offline";
      const k = offline ? "offline" : "waiting";
      if (lastKey !== k) {
        lastKey = k;
        lists.replaceChildren(offline ? emptyState("Can't reach your machines right now.", "Your panes will be here as soon as the connection is back.") : skeleton());
      }
      return;
    }
    const docsNow = visibleMachines().map((k) => ({ machine: k.machine, spaces: spacesOf(k.machine) }));
    const byChange = compareRows("needs");
    const needs: Listed[] = [...needsYou(docsNow, terms), ...loose].sort((a, b) => byChange(a.terminal, b.terminal));
    // Quick ways in belong to the whole list: one machine at a time is a narrower question.
    if (!openAddress && recentInSight()) recentShown = recent;
    // Each pane once above the layouts: one in no layout that needs the owner is under the Needs you line, so not again in Favorites.
    const favorites = only === null ? favoritesIn(everything).filter((x) => !loose.includes(x)) : [];
    // Recent leaves out what needs the owner, as before the Needs you line (L-15): the line stands for those, and a pane that starts
    // needing the owner doesn't shuffle Recent above the place the owner is reading.
    const recents = only === null ? recentIn(recentShown, everything, [...needs, ...favorites].map((x) => x.terminal.address)) : [];
    // Terminals coming and going change what a row is; a status only changes what it says.
    const kinds = docsNow.flatMap((d) => d.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes.map((p) => paneKind(p, terms)[0]))));
    const ids = (l: Listed[]) => l.map((x) => x.terminal.address);
    const key = JSON.stringify(query ? [query, ids(found)] : [
      only, listFailed, ids(needs), ids(favorites), ids(recents), kinds,
      known.map((k) => [keyOf(k.machine), k.state, sigOf(k.machine)]),
      choices,
    ]);
    if (key !== lastKey || force) {
      if (touching || menuOpen() || Date.now() - touchEnded < 180) deferred = true;
      else { lastKey = key; deferred = false; layOut(needs, favorites, recents); }
    }
    for (const fn of spacePatches) fn();
    for (const a of all ?? patches.keys()) for (const fn of patches.get(a) ?? []) fn();
  }

  // A row can grow here (its question and choices arrive a moment later), and what the owner is reading must not move.
  function patchOne(address: string) {
    const anchor = anchorRow();
    for (const fn of patches.get(address) ?? []) fn();
    if (!anchor) return;
    const again = [...lists.querySelectorAll<HTMLElement>("[data-k]")].find((r) => r.dataset.k === anchor.k);
    if (again) root.scrollTop += again.getBoundingClientRect().top - anchor.top;
  }

  // ---- wiring ----
  const syncRoute = () => {
    const r = route();
    const next = r.startsWith("t/") ? decodeURIComponent(r.slice(2)) : null;
    if (next === openAddress) return;
    const prev = openAddress;
    openAddress = next;
    if (next) { recent = pushRecent(recent, next); setPref(RECENT_KEY, JSON.stringify(recent)); }
    if (prev) patchOne(prev);
    if (next) patchOne(next);
    render();  // leaving a terminal is when Recent catches up
  };
  const down = () => { touching = true; };
  const up = () => {
    touching = false;
    touchEnded = Date.now();
    window.setTimeout(() => { if (deferred && !touching) render(true); }, 200);
  };
  // Recent held back while out of sight above catches up once the owner scrolls back to it.
  root.addEventListener("scroll", () => {
    if (root.offsetParent === null || top.query()) return;  // hidden, a browser may drop the scroll; results have their own
    seenScroll = root.scrollTop;
    if (recentShown !== recent && !openAddress && recentInSight()) render();
  }, { passive: true });
  root.addEventListener("touchstart", down, { passive: true });
  root.addEventListener("touchend", up, { passive: true });
  root.addEventListener("touchcancel", up, { passive: true });
  window.addEventListener("hashchange", syncRoute);

  onMenuClosed(() => { if (deferred) render(true); });
  onTerms((c) => {
    if (c.all || [...c.addresses].some((a) => placed.has(a))) refreshNames();
    render(false, c.all ? undefined : c.addresses);
  });
  onConn(() => render());
  onDoc((c) => {
    if (c.name === null) scheduleAll();
    else if (c.name === DOC) schedule(c.machine);
  });
  // Ages move slowly, so a slow tick that writes only what changed is plenty.
  window.setInterval(() => { if (!document.hidden) render(); }, 30000);

  syncRoute();
  render();
  if (app.core) readAll();

  return {
    refresh: () => render(),
    openFirst() { const x = found[0]; if (x) go(termHref(x.terminal.address).slice(2)); },
  };
}
