// A computer's pane beside the list when no terminal is open: how many need the owner, are working and are idle, the asks the owner can answer
// right here (the same rows and the same two-tap, screen-checked choices as the list), and what finished lately. Its own chunk:
// a phone never shows it, so a phone's cold load doesn't carry it (main.ts emptyDetail).
import "./agents-overview.css";
import { app, folderOf, isAgent, machineName, machineOf, onTerms, terms } from "../app";
import { bucket, statusWord, type Terminal } from "../core";
import { el } from "../dom";
import { compareRows, showFolder, summarize } from "../inbox";
import { createRow, setText, type Row } from "./rows";

const DONE_SHOWN = 5;

export function agentsOverview(box: HTMLElement, forPanes: boolean) {
  box.className = "detail-empty overview";
  const stat = (label: string, cls: string) => {
    const s = el("div", `ov-stat ${cls}`);
    const n = el("b", "ov-num", "0");
    s.append(n, el("span", "ov-label", label));
    return { s, n };
  };
  const needs = stat("Need you", "needs"), working = stat("Working", "working"), idle = stat("Idle", "idle");
  const hud = el("div", "ov-hud");
  hud.append(needs.s, working.s, idle.s);
  const line = el("p", "ov-line");
  // By place answers nothing itself (By state does), so it points there.
  const toState = el("a", "ov-go", "Answer what needs you in By state");
  // By place's own noun is pane (L-14), so its sentence is only what to do.
  if (forPanes) line.textContent = "Pick a pane to continue in it.";
  toState.href = "#/agents";
  const asks = section("Needs you"), done = section("Recently done");
  asks.root.classList.add("ov-asks");
  const hint = el("p", "hint");
  // Fixed words, no one else's text.
  hint.innerHTML = "<kbd>j</kbd> <kbd>k</kbd> to move, <kbd>Enter</kbd> to open";
  const wrap = el("div", "ov");
  if (forPanes) wrap.append(hud, toState, line);
  else wrap.append(hud, line, asks.root, done.root, hint);
  box.replaceChildren(wrap);

  const rows = new Map<string, Row>();
  const where = (t: Terminal) => [machineName(machineOf(t)), showFolder(folderOf(t))].filter(Boolean).join(" · ");
  function rowFor(t: Terminal, asking: boolean) {
    const key = `${asking ? "a" : "d"}:${t.address}`;
    let r = rows.get(key);
    if (!r) {
      const address = t.address;
      r = createRow(address, {
        asks: asking,
        cls: (x) => `row ${asking ? "needs" : "done"}${statusWord(x) === "error" ? " error" : ""}`,
        meta: where,
        where: (x) => [machineName(machineOf(x)), folderOf(x)].filter(Boolean).join(", "),
        current: () => false,
        grew: () => { const x = terms.get(address); if (x) rows.get(key)?.patch(x, Date.now()); },
      });
      rows.set(key, r);
    }
    return r;
  }

  function patch() {
    const n = summarize(terms.values());
    setText(needs.n, String(n.needs));
    setText(working.n, String(n.working));
    setText(idle.n, String(n.idle));
    needs.s.classList.toggle("on", n.needs > 0);
    if (!forPanes) setText(line, sentence(n));
    toState.hidden = !n.needs;
    if (forPanes) return;
    const live = [...terms.values()].filter((t) => t.state === "live" && isAgent(t));
    const asking = live.filter((t) => bucket(t) === "needs").sort(compareRows("needs"));
    const finished = live.filter((t) => bucket(t) === "done").sort(compareRows("done")).slice(0, DONE_SHOWN);
    const now = Date.now();
    const wanted = new Set<string>();
    const fill = (s: ReturnType<typeof section>, list: Terminal[], ask: boolean) => {
      s.root.hidden = !list.length;
      setText(s.count, String(list.length));
      const els = list.map((t) => { const r = rowFor(t, ask); wanted.add(`${ask ? "a" : "d"}:${t.address}`); r.patch(t, now); return r.root; });
      if (els.length !== s.list.children.length || els.some((e, i) => s.list.children[i] !== e)) s.list.replaceChildren(...els);
    };
    fill(asks, asking, true);
    fill(done, finished, false);
    for (const k of [...rows.keys()]) if (!wanted.has(k)) rows.delete(k);
  }

  // Lives as long as it's on the page: main.ts swaps it out without a word when a terminal opens.
  let frame = 0;
  const off = onTerms(() => {
    if (!box.isConnected) { stop(); return; }
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; patch(); });
  });
  const tick = window.setInterval(() => { if (!box.isConnected) stop(); else if (!document.hidden) patch(); }, 30000);
  const stop = () => { off(); clearInterval(tick); cancelAnimationFrame(frame); };
  patch();
  return stop;
}

function section(title: string) {
  const root = el("section", "ov-sec");
  const head = el("h2", "group-head");
  const count = el("span", "group-count");
  head.append(el("span", "group-title", title), count);
  const list = el("div", "ov-rows");
  list.setAttribute("role", "list");
  root.append(head, list);
  root.hidden = true;
  return { root, count, list };
}

function sentence(n: ReturnType<typeof summarize>): string {
  if (app.conn !== "online" && !terms.size) return "Waiting for your machines.";
  if (!n.agents) return "No agents running.";
  if (n.needs) return `${n.needs === 1 ? "One agent needs" : `${n.needs} agents need`} you.`;
  return n.working ? `Nothing needs you. ${n.working} working.` : "All quiet.";
}
