// One row, wherever a terminal is listed: its dot, name, program, state and, when it's asking, its question and choices. And the menu
// a long press or right click opens on it. Everything on a row is somebody's text, so it only ever goes in as text.
import "./agents.css";
import { app, askOf, choicesOf, isAgent, labelOf, statusOf, terms } from "../app";
import { statusWord, type Terminal } from "../core";
import { el } from "../dom";
import { icon } from "../icons";
import { fmtAge, isPinned, kindWord, stateWord } from "../inbox";
import { programOf } from "../panes-logic";
import { go } from "../router";
import { choiceBar } from "./choices";

const LONG_PRESS = 450, MOVE_SLOP = 9;

export const pref = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
export const setPref = (k: string, v: string | null) => {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* only a convenience */ }
};
/** Sets text only when it changed, so a row that didn't change costs nothing. */
export function setText(e: HTMLElement, s: string) { if (e.textContent !== s) e.textContent = s; }
export function setHidden(e: HTMLElement, h: boolean) { if (e.hidden !== h) e.hidden = h; }

export const termHref = (address: string) => `#/t/${encodeURIComponent(address)}`;
/** In words, for the meta line and a screen reader. */
export const stateOf = (t: Terminal) => (t.state !== "live" ? "Ended" : stateWord[statusOf(t)?.state ?? ""] ?? "");

export interface RowOptions {
  /** The row's whole class. */
  cls: (t: Terminal) => string;
  meta: (t: Terminal) => string;
  /** Where it is, for a screen reader. */
  where: (t: Terminal) => string;
  /** Says what a blocked agent is asking, and offers its choices. */
  asks: boolean;
  current: (t: Terminal) => boolean;
  /** The question and choices arrived, a moment after the row was drawn. */
  grew: () => void;
  key?: string;
}

export interface Row { root: HTMLElement; link: HTMLAnchorElement; patch(t: Terminal, now: number): void }

export function createRow(address: string, o: RowOptions): Row {
  const root = el("div", "row");
  root.setAttribute("role", "listitem");
  root.dataset.address = address;
  const link = el("a", "row-main");
  link.href = termHref(address);
  link.draggable = false;
  if (o.key) link.dataset.k = o.key;
  const body = el("span", "row-body");
  const l1 = el("span", "row-l1");
  const name = el("span", "name");
  const program = el("span", "row-program");
  program.hidden = true;
  const pin = icon("pin", "row-pin");
  pin.hidden = true;
  const kind = el("span", "row-kind");
  kind.hidden = true;
  const age = el("span", "row-age");
  l1.append(name, program, pin, kind, age);
  const meta = el("span", "meta");
  const ask = el("span", "row-ask");
  ask.hidden = true;
  body.append(l1, meta, ask);
  link.append(el("span", "dot"), body);
  const more = el("button", "row-more");
  more.type = "button";
  more.setAttribute("aria-label", "More actions");
  more.append(icon("more"));
  more.onclick = (e) => { e.preventDefault(); const t = terms.get(address); if (t) openRowMenu(t, more); };
  const choices = choiceBar(address);
  root.append(link, more, choices.root);
  wirePress(link, address);

  let cls = "", aria = "";
  return {
    root, link,
    patch(t, now) {
      const label = labelOf(t);
      setText(name, label);
      const word = programOf(t);
      const showProgram = word && word.toLowerCase() !== label.toLowerCase() ? word : "";
      setText(program, showProgram);
      setHidden(program, !showProgram);
      setHidden(pin, !isPinned(t));
      const s = statusOf(t);
      const w = statusWord(t);
      const live = t.state === "live";
      const since = t.status_ms ?? t.created_ms;
      const progress = w === "working" && s?.progress != null ? `${s.progress}%` : "";
      setText(age, !live ? "" : progress || (isAgent(t) && since ? fmtAge(now - since) : ""));
      setText(meta, o.meta(t));
      const blocked = live && (w === "blocked" || w === "error");
      // Every ask gets a tag, so a card always says what kind of thing it wants: an unknown kind is just Waiting.
      const kindText = o.asks && blocked ? (w === "error" ? "Error" : kindWord[s?.kind ?? ""] ?? "Waiting") : "";
      setText(kind, kindText);
      setHidden(kind, !kindText);
      const asking = o.asks && blocked ? askOf(t, o.grew) : "";
      setText(ask, asking);
      setHidden(ask, !asking);
      choices.show(o.asks && live && w === "blocked" ? choicesOf(t) : []);
      // Asking, it's a card: the question leads, and who's asking is the quiet line under it (agents.css).
      const next = o.cls(t) + (kindText ? " asking" : "");
      if (cls !== next) { root.className = cls = next; }
      const nextAria = [label, showProgram, stateOf(t), kindText, o.where(t), asking].filter(Boolean).join(", ");
      if (aria !== nextAria) { link.setAttribute("aria-label", nextAria); aria = nextAria; }
      const current = o.current(t);
      if (link.hasAttribute("aria-current") !== current) link.toggleAttribute("aria-current", current);
    },
  };
}

// ---- long press and right click ----
function wirePress(link: HTMLElement, address: string) {
  let timer = 0, sx = 0, sy = 0, fired = false;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  link.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    fired = false;
    sx = e.clientX; sy = e.clientY;
    timer = window.setTimeout(() => {
      fired = true;
      const t = terms.get(address);
      if (t) { navigator.vibrate?.(8); openRowMenu(t, link); }
    }, LONG_PRESS);
  });
  link.addEventListener("pointermove", (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > MOVE_SLOP) cancel(); });
  link.addEventListener("pointerup", cancel);
  link.addEventListener("pointercancel", cancel);
  link.addEventListener("click", (e) => { if (fired) { e.preventDefault(); fired = false; } });
  // Right click on a computer. Android also fires this for a long press, which the timer already handled.
  link.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const t = terms.get(address);
    if (t && !fired && !menu) openRowMenu(t, link);
  });
}

// ---- the menu: pin, mark unread ----
let menu: { close(): void } | null = null;
const closedSubs = new Set<() => void>();
export const menuOpen = () => menu !== null;
/** A list holding still under the menu moves when it closes. */
export function onMenuClosed(fn: () => void) { closedSubs.add(fn); return () => { closedSubs.delete(fn); }; }

export const setPinned = (t: Terminal, on: boolean) =>
  app.core?.call("terminal.label", { terminal: t.address, labels: { "lumbridge.pinned": on ? "1" : "" } }).catch(() => {});
// At turn 0 nothing has finished, so there is nothing to mark. `lumbridge.seen` holds the last turn the owner has seen.
export const markUnread = (t: Terminal) => {
  if ((t.turn ?? 0) > 0) app.core?.call("terminal.label", { terminal: t.address, labels: { "lumbridge.seen": String((t.turn ?? 0) - 1) } }).catch(() => {});
};

function openRowMenu(t: Terminal, anchor: HTMLElement) {
  menu?.close();
  const scrim = el("div", "sheet-scrim");
  const sheet = el("div", "sheet");
  sheet.setAttribute("role", "menu");
  sheet.setAttribute("aria-label", labelOf(t));
  sheet.append(el("div", "sheet-title", labelOf(t)));
  const close = () => {
    scrim.remove();
    document.removeEventListener("keydown", onKey, true);
    menu = null;
    anchor.focus({ preventScroll: true });
    for (const fn of [...closedSubs]) fn();
  };
  const item = (label: string, act: () => void) => {
    const b = el("button", "sheet-item", label);
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.onclick = () => { close(); act(); };
    sheet.append(b);
    return b;
  };
  const first = item("Open", () => go(`t/${encodeURIComponent(t.address)}`));
  item(isPinned(t) ? "Unpin" : "Pin to top", () => setPinned(t, !isPinned(t)));
  if ((t.turn ?? 0) > 0) item("Mark unread", () => markUnread(t));
  const cancel = el("button", "sheet-item sheet-cancel only-phone", "Cancel");
  cancel.type = "button";
  cancel.onclick = close;
  sheet.append(cancel);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...sheet.querySelectorAll<HTMLButtonElement>(".sheet-item:not(.sheet-cancel)")];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    e.preventDefault();
  };
  document.addEventListener("keydown", onKey, true);
  scrim.onpointerdown = (e) => { if (e.target === scrim) { e.preventDefault(); close(); } };
  scrim.append(sheet);
  document.querySelector(".shell")?.append(scrim);
  // On a computer it opens by the row; on a phone CSS makes it a bottom sheet.
  if (matchMedia("(min-width: 900px)").matches) {
    const a = anchor.getBoundingClientRect();
    sheet.style.left = `${Math.min(a.left + 40, innerWidth - 240)}px`;
    sheet.style.top = `${Math.min(a.bottom - 8, innerHeight - sheet.offsetHeight - 12)}px`;
  }
  menu = { close };
  first.focus({ preventScroll: true });
}
