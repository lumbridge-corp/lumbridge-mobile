import { app, folderOf, isAgent, machineName, machineOf, onConn, onTerms, terms, type Change } from "../app";
import { bucket, statusWord, type Bucket } from "../core";
import { el } from "../dom";
import { icon } from "../icons";
import { isPinned, layoutInbox, machinesIn, reorderKey, showFolder, summarize, type Group } from "../inbox";
import { go, route, terminalOrigin } from "../router";
import type { AgentsTop } from "./agents-top";
import { createRow, markUnread, menuOpen, onMenuClosed, pref, setHidden, setPinned, setPref, setText, termHref, type Row } from "./rows";
import { NS } from "../ns";

const SHELLS_KEY = `${NS}.inbox.shells`, MACHINE_KEY = `${NS}.inbox.machine`, GROUP_KEY = `${NS}.inbox.group`;

export function agentsView(root: HTMLElement, top: AgentsTop) {
  let machine = pref(MACHINE_KEY);
  let byMachine = pref(GROUP_KEY) === "1";
  let shellsOpen = pref(SHELLS_KEY) === "1";
  let everConnected = false;
  let cursor: string | null = null;      // keyboard position
  let openAddress: string | null = null;
  let touching = false;                  // a finger is down: don't move anything under it
  let touchEnded = 0;
  let deferred: number | null = null;
  const holds = new Map<string, Bucket>();
  const rows = new Map<string, Row>();
  const sections = new Map<string, { root: HTMLElement; head: HTMLElement; title: HTMLElement; count: HTMLElement; list: HTMLElement }>();
  let lastOrder = "";

  // ---- skeleton of the screen ----
  const page = el("div", "inbox");
  const groupBtn = el("button", "iconbtn group-toggle");
  groupBtn.type = "button";
  top.tools.append(groupBtn);
  const chips = el("div", "chips");
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", "Filter by machine");
  const lists = el("div", "inbox-lists");
  lists.setAttribute("role", "list");
  const empty = el("div", "inbox-empty");
  page.append(chips, lists, empty);
  root.replaceChildren(page);

  const skeleton = el("div", "skeleton");
  skeleton.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 6; i++) { const s = el("div", "skel-row"); s.append(el("span", "skel-dot"), el("span", "skel-lines")); skeleton.append(s); }
  lists.append(skeleton);

  const renderGroupBtn = () => {
    groupBtn.replaceChildren(icon(byMachine ? "list" : "group"));
    groupBtn.setAttribute("aria-label", byMachine ? "Group by state" : "Group by machine");
    groupBtn.title = byMachine ? "Group by state" : "Group by machine";
    groupBtn.setAttribute("aria-pressed", String(byMachine));
  };
  groupBtn.onclick = () => {
    byMachine = !byMachine;
    setPref(GROUP_KEY, byMachine ? "1" : null);
    renderGroupBtn();
    patch(true);
  };
  renderGroupBtn();

  // ---- a row ----
  function makeRow(address: string): Row {
    return createRow(address, {
      asks: true,
      cls: (t) => {
        const b = holds.get(t.address) && bucket(t) === "idle" ? holds.get(t.address)! : bucket(t);
        return `row ${isAgent(t) ? b : "plain"}${statusWord(t) === "error" ? " error" : ""}${t.address === openAddress ? " open" : ""}${t.address === cursor ? " cursor" : ""}`;
      },
      meta: (t) => [byMachine ? "" : machineName(machineOf(t)), showFolder(folderOf(t))].filter(Boolean).join(" · "),
      where: (t) => [machineName(machineOf(t)), folderOf(t)].filter(Boolean).join(", "),
      current: (t) => t.address === openAddress,
      grew: () => schedule(new Set([address])),
    });
  }

  // ---- machine filter ----
  function renderChips() {
    const all = machinesIn(terms.values());
    if (machine && !all.includes(machine)) machine = null;
    const show = all.length > 1;
    setHidden(chips, !show);
    if (!show) return;
    const wanted = ["all", ...all];
    const have = [...chips.children].map((c) => (c as HTMLElement).dataset.m);
    if (wanted.join() !== have.join()) {
      chips.replaceChildren(...wanted.map((m) => {
        const c = el("button", "chip", m === "all" ? "All" : machineName(m));
        c.type = "button";
        c.dataset.m = m;
        c.onclick = () => {
          machine = m === "all" ? null : m;
          setPref(MACHINE_KEY, machine);
          patch(true);
        };
        return c;
      }));
    }
    for (const c of chips.children) {
      const on = ((c as HTMLElement).dataset.m === "all" && !machine) || (c as HTMLElement).dataset.m === machine;
      c.classList.toggle("on", on);
      c.setAttribute("aria-pressed", String(on));
    }
  }

  // ---- the list, patched in place ----
  function section(g: Group) {
    let s = sections.get(g.key);
    if (!s) {
      const sec = el("section", "group");
      const h = el(g.collapsible ? "button" : "h2", "group-head") as HTMLElement;
      const title = el("span", "group-title");
      const count = el("span", "group-count");
      h.append(title, count);
      if (g.collapsible) {
        (h as HTMLButtonElement).type = "button";
        h.onclick = () => {
          shellsOpen = !shellsOpen;
          setPref(SHELLS_KEY, shellsOpen ? "1" : null);
          patch(true);
        };
      }
      const list = el("div", "group-rows");
      sec.append(h, list);
      s = { root: sec, head: h, title, count, list };
      sections.set(g.key, s);
    }
    s.root.className = `group ${g.cls}`;
    setText(s.title, g.title);
    setText(s.count, String(g.rows.length));
    return s;
  }

  /** The row at the top of the view, to hold still across a patch that moves things above it. */
  function anchorRow(): { el: HTMLElement; top: number } | null {
    if (root.scrollTop <= 0) return null;
    const top = root.getBoundingClientRect().top;
    for (const r of rows.values()) {
      if (!r.root.isConnected) continue;
      const b = r.root.getBoundingClientRect();
      if (b.bottom > top + 1 && b.top <= top + b.height) return { el: r.root, top: b.top };
    }
    return null;
  }

  function reorder(groups: Group[]) {
    const anchor = anchorRow();
    const wantedRows = new Set<string>();
    const wantedSections = new Set<string>();
    let prevSection: HTMLElement | null = null;
    for (const g of groups) {
      const s = section(g);
      wantedSections.add(g.key);
      const at: Element | null = prevSection ? prevSection.nextElementSibling : lists.firstElementChild;
      if (at !== s.root) lists.insertBefore(s.root, at);
      prevSection = s.root;
      const open = !g.collapsible || shellsOpen;
      s.root.classList.toggle("collapsed", !open);
      if (g.collapsible) s.head.setAttribute("aria-expanded", String(open));
      setHidden(s.list, !open);
      let next: ChildNode | null = s.list.firstChild;
      for (const t of g.rows) {
        wantedRows.add(t.address);
        let r = rows.get(t.address);
        if (!r) { r = makeRow(t.address); rows.set(t.address, r); r.patch(t, Date.now()); }
        if (r.root === next) next = next.nextSibling;
        else s.list.insertBefore(r.root, next);
      }
    }
    for (const [address, r] of rows) if (!wantedRows.has(address)) { r.root.remove(); rows.delete(address); }
    for (const [key, s] of sections) if (!wantedSections.has(key)) s.root.remove();
    if (anchor?.el.isConnected) {
      const moved = anchor.el.getBoundingClientRect().top - anchor.top;
      if (Math.abs(moved) > 0.5) root.scrollTop += moved;
    }
  }

  function showEmpty(text: string, sub: string) {
    setHidden(empty, false);
    if (empty.dataset.t !== text) {
      empty.dataset.t = text;
      empty.replaceChildren(icon("mark", "empty-mark"), el("p", "empty-title", text), el("p", "empty-sub", sub));
    }
  }

  /** Before core has listed anything on this visit: the skeleton while connecting, and why it's empty once it's clear it's offline. */
  function renderUnlisted() {
    if (everConnected) return;
    const offline = app.conn === "offline";
    if (offline) {
      skeleton.remove();
      showEmpty("Can't reach your machines right now.", "Your agents will be here as soon as the connection is back.");
    } else {
      setHidden(empty, true);
      if (!skeleton.isConnected) lists.append(skeleton);
    }
  }

  function renderEmpty(groups: Group[]) {
    const n = summarize(terms.values());
    const parts: string[] = [];
    if (n.needs) parts.push(`${n.needs} need${n.needs === 1 ? "s" : ""} you`);
    if (n.working) parts.push(`${n.working} working`);
    if (n.done) parts.push(`${n.done} done`);
    top.setSum("agents", !everConnected ? "" : parts.join(" · ") || (n.agents ? "All quiet" : ""));
    const hasAgents = groups.some((g) => !g.collapsible);
    setHidden(empty, !everConnected || hasAgents);
    if (!everConnected || hasAgents) return;
    const text = machine ? `No agents on ${machineName(machine)} right now.` : "No agents running.";
    const sub = machine ? "Everything else is still in All." : "When one starts on a machine, it shows up here.";
    showEmpty(text, sub);
  }

  function patch(force = false, only?: Set<string>) {
    if (!everConnected) return;
    skeleton.remove();
    renderChips();
    const groups = layoutInbox(terms.values(), { machine, byMachine, holds });
    const order = reorderKey(groups) + (shellsOpen ? "+" : "-");
    if (order !== lastOrder || force) {
      if (touching || Date.now() - touchEnded < 180 || menuOpen()) {
        // Hold the structure still under a finger. Text still updates; the move happens on lift.
        deferred = deferred ?? 1;
      } else {
        reorder(groups);
        lastOrder = order;
        deferred = null;
      }
    }
    const now = Date.now();
    const list = only ? [...only] : [...rows.keys()];
    // A row can grow here (its question and choices arrive a moment later), and what the owner is reading must not move.
    const anchor = anchorRow();
    for (const a of list) {
      const r = rows.get(a), t = terms.get(a);
      if (r && t) r.patch(t, now);
    }
    if (anchor?.el.isConnected) {
      const moved = anchor.el.getBoundingClientRect().top - anchor.top;
      if (Math.abs(moved) > 0.5) root.scrollTop += moved;
    }
    for (const g of groups) { const s = sections.get(g.key); if (s) setText(s.count, String(g.rows.length)); }
    renderEmpty(groups);
    syncRoute();
  }

  function flushDeferred() {
    if (deferred !== null && !touching && !menuOpen()) patch(true);
  }

  // Coalesced by app.ts to once a frame, and only the rows that changed get looked at, unless the order changed.
  let pendingRows: Set<string> | null = null;
  function schedule(addresses: Set<string>) {
    if (!pendingRows) {
      pendingRows = new Set();
      requestAnimationFrame(() => { const p = pendingRows; pendingRows = null; if (p) patch(false, p); });
    }
    for (const a of addresses) pendingRows.add(a);
  }

  function onChange(c: Change) { patch(c.all, c.all ? undefined : c.addresses); }

  // The row of the open terminal is highlighted, and stays in its bucket until you leave it.
  function syncRoute() {
    const r = route();
    const next = r.startsWith("t/") ? decodeURIComponent(r.slice(2)) : null;
    if (next === openAddress) return;
    const prev = openAddress;
    openAddress = next;
    if (prev) holds.delete(prev);
    if (next) {
      const t = terms.get(next);
      if (t) holds.set(next, bucket(t));
      cursor = next;
    }
    patch(true);
  }

  // ---- gestures and keys ----
  const down = () => { touching = true; };
  const up = () => {
    touching = false;
    touchEnded = Date.now();
    window.setTimeout(flushDeferred, 200);
  };
  root.addEventListener("touchstart", down, { passive: true });
  root.addEventListener("touchend", up, { passive: true });
  root.addEventListener("touchcancel", up, { passive: true });

  const typingIn = (e: Element | null) =>
    !!e && !e.classList.contains("xterm-helper-textarea") && (e.tagName === "TEXTAREA" || e.tagName === "INPUT" || (e as HTMLElement).isContentEditable);

  function visibleOrder(): string[] {
    return [...lists.querySelectorAll<HTMLElement>(".group:not(.collapsed) .row")].map((r) => r.dataset.address!);
  }
  function moveCursor(step: number) {
    const order = visibleOrder();
    if (!order.length) return;
    const i = cursor ? order.indexOf(cursor) : -1;
    const n = i < 0 ? (step > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, i + step));
    cursor = order[n];
    patch();
    rows.get(cursor)?.root.scrollIntoView({ block: "nearest" });
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || menuOpen()) return;
    if (typingIn(document.activeElement)) return;
    if (e.key === "Escape" && route().startsWith("t/")) { go(terminalOrigin()); e.preventDefault(); return; }
    if (root.offsetParent === null) return; // the list isn't on screen
    if (e.key === "j" || e.key === "k") { moveCursor(e.key === "j" ? 1 : -1); e.preventDefault(); }
    else if (e.key === "Enter" && cursor && document.activeElement?.tagName !== "BUTTON") { go(termHref(cursor).slice(2)); e.preventDefault(); }
    else if ((e.key === "p" || e.key === "u") && cursor) {
      const t = terms.get(cursor);
      if (!t) return;
      if (e.key === "p") setPinned(t, !isPinned(t));
      else markUnread(t);
    }
  };
  document.addEventListener("keydown", onKey);
  window.addEventListener("hashchange", syncRoute);

  const offMenu = onMenuClosed(flushDeferred);
  const offTerms = onTerms(onChange);
  const offConn = onConn((s) => {
    if (s === "online") { everConnected = true; patch(true); }
    else renderUnlisted();
  });
  if (app.conn === "online") { everConnected = true; patch(true); }
  else renderUnlisted();
  // Ages move slowly, so a slow tick that writes only what changed is plenty.
  const tick = window.setInterval(() => { if (!document.hidden) patch(); }, 30000);

  return () => {
    offTerms();
    offConn();
    clearInterval(tick);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("hashchange", syncRoute);
    offMenu();
  };
}
