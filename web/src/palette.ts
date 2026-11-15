// The jump palette: Cmd-K (Ctrl-K), a few letters, Enter. Every screen and every agent by name. Its own chunk (palette-key.ts).
import "./palette.css";
import { isAgent, labelOf, machineName, machineOf, terms } from "./app";
import { statusWord } from "./core";
import { el } from "./dom";
import { icon } from "./icons";
import { rank, step, type Item } from "./palette-logic";
import { SCREENS } from "./screens";

let close: (() => void) | null = null;
let n = 0;

function items(): Item[] {
  const screens: Item[] = SCREENS.map((s) => ({ href: `#/${s.id}`, label: s.label, also: s.name ? [s.name] : undefined, hint: "", kind: "screen" }));
  // Agents, and shells the owner gave a name; a plain shell is a dozen "zsh" rows. Needs-you first, then by name.
  const agents = [...terms.values()]
    .filter((t) => t.state === "live" && (isAgent(t) || !!t.name))
    .map((t) => {
      const w = statusWord(t);
      const needs = w === "blocked" || w === "error";
      return { needs, item: { href: `#/t/${encodeURIComponent(t.address)}`, label: labelOf(t), hint: `${needs ? "Needs you · " : ""}${machineName(machineOf(t))}`, kind: "agent" as const } };
    })
    .sort((a, b) => Number(b.needs) - Number(a.needs) || a.item.label.localeCompare(b.item.label))
    .map((x) => x.item);
  return [...screens, ...agents];
}

/** Opens it, or closes it if it's open. `back` gets focus again when it closes without going anywhere. */
export function showPalette(back: HTMLElement | null) {
  if (close) { close(); return; }
  const app = document.getElementById("app");
  const all = items();
  const id = `pal-${++n}`;

  const scrim = el("div", "pal-scrim");
  const box = el("div", "pal");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "Jump to");
  const field = el("label", "pal-field");
  const input = el("input", "pal-input");
  input.type = "text";
  input.placeholder = "Jump to a screen or an agent";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.enterKeyHint = "go";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", `${id}-list`);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-label", "Jump to");
  field.append(icon("search"), input);
  const list = el("ul", "pal-list");
  list.id = `${id}-list`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Screens and agents");
  const foot = el("p", "pal-foot");
  foot.innerHTML = "<span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to go</span><span><kbd>Esc</kbd> to close</span>";
  box.append(field, list, foot);
  scrim.append(box);

  let shown: Item[] = [];
  let opts: HTMLElement[] = [];
  let at = 0;

  function paint() {
    shown = rank(all, input.value);
    at = Math.min(at, shown.length - 1);
    if (at < 0 && shown.length) at = 0;
    opts = shown.map((it, i) => {
      const li = el("li", "pal-row");
      li.id = `${id}-${i}`;
      li.setAttribute("role", "option");
      const s = it.kind === "screen" ? SCREENS.find((x) => `#/${x.id}` === it.href) : null;
      li.append(icon(s ? s.icon : "agents", "pal-ic"), el("span", "pal-label", it.label), el("span", it.hint.startsWith("Needs you") ? "pal-hint needs" : "pal-hint", it.hint));
      li.title = it.kind === "screen" && it.also ? it.also[0] : "";
      li.addEventListener("pointermove", () => { if (at !== i) { at = i; mark(); } });
      li.addEventListener("click", () => go(it));
      return li;
    });
    const rows: HTMLElement[] = [...opts];
    const label = (text: string) => { const h = el("li", "pal-sec", text); h.setAttribute("role", "presentation"); return h; };
    // Nothing typed: everything, under a label for each kind. Typed: best first, whatever kind.
    if (!input.value.trim()) {
      const firstAgent = shown.findIndex((x) => x.kind === "agent");
      if (firstAgent >= 0) rows.splice(firstAgent, 0, label("Agents"));
      rows.unshift(label("Screens"));
    }
    if (!opts.length) {
      const none = el("li", "pal-none", `Nothing called "${input.value.trim()}".`);
      none.setAttribute("role", "presentation");
      rows.push(none);
    }
    list.replaceChildren(...rows);
    mark();
  }

  function mark() {
    opts.forEach((li, i) => li.setAttribute("aria-selected", String(i === at)));
    if (at >= 0 && opts[at]) {
      input.setAttribute("aria-activedescendant", `${id}-${at}`);
      // The first one brings its label into view with it.
      (at === 0 ? list.firstElementChild : opts[at])?.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  function go(it: Item) {
    shut(false);
    if (location.hash !== it.href) location.hash = it.href;
  }

  function shut(refocus = true) {
    if (!close) return;
    close = null;
    scrim.remove();
    if (app) app.inert = false;
    document.removeEventListener("keydown", onKey, true);
    if (refocus && back?.isConnected) back.focus({ preventScroll: true });
  }

  // On the document, before anything else hears it: Esc mustn't also close the note behind, nor j and k move the agents list.
  function onKey(e: KeyboardEvent) {
    const mine = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === "Escape") { mine(); shut(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { mine(); at = step(at, e.key === "ArrowDown" ? 1 : -1, shown.length); mark(); }
    else if (e.key === "Enter" && !e.isComposing) { mine(); if (shown[at]) go(shown[at]); }
    // One field to be in: Tab stays in it.
    else if (e.key === "Tab") { mine(); input.focus(); }
    else if (document.activeElement !== input && e.key.length === 1 && !e.metaKey && !e.ctrlKey) input.focus();
  }

  input.addEventListener("input", () => { at = 0; paint(); });
  scrim.addEventListener("click", (e) => { if (e.target === scrim) shut(); });
  document.addEventListener("keydown", onKey, true);
  close = () => shut();
  if (app) app.inert = true;
  document.body.append(scrim);
  paint();
  input.focus();
}
