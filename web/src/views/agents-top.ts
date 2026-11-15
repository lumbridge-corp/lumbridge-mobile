// The top of the Agents tab, over both of its views: the title, the By state / By place switch, and search.
import "./panes.css";
import { el } from "../dom";
import { icon } from "../icons";
import type { ListView } from "../router";
import { setHidden, setText } from "./rows";

const LABELS: [ListView, string, string][] = [["agents", "By state", "list-state"], ["panes", "By place", "list-place"]];

export interface AgentsTop {
  root: HTMLElement;
  /** Where the By state view puts its grouping button. */
  tools: HTMLElement;
  select(list: ListView): void;
  setSum(list: ListView, text: string): void;
  /** While searching, the line under the title says what it found. Null: back to the view's own. */
  setFound(text: string | null): void;
  query(): string;
  clear(): void;
}

export function agentsTop(on: { switched(to: ListView): void; query(q: string): void; enter(): void }): AgentsTop {
  const root = el("header", "inbox-head agents-top");
  const line = el("div", "agents-line");
  const titles = el("div", "inbox-titles");
  const sum = el("p", "inbox-sum");
  sum.setAttribute("aria-live", "polite");
  titles.append(el("h1", "", "Agents"), sum);

  // A switch between two views of one list, so tabs to a screen reader, with arrow keys between them and one stop for Tab.
  const seg = el("div", "list-switch");
  seg.setAttribute("role", "tablist");
  seg.setAttribute("aria-label", "Show agents");
  const tabs = new Map<ListView, HTMLButtonElement>();
  for (const [id, label, panel] of LABELS) {
    const b = el("button", "list-btn", label);
    b.type = "button";
    b.id = `${panel}-tab`;
    b.dataset.list = id;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-controls", panel);
    b.onclick = () => on.switched(id);
    tabs.set(id, b);
    seg.append(b);
  }
  seg.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const to = current === "agents" ? "panes" : "agents";
    on.switched(to);
    tabs.get(to)?.focus();
  });
  line.append(titles, seg);

  const tools = el("div", "agents-tools");
  const box = el("div", "find");
  box.setAttribute("role", "search");
  const input = el("input", "find-input");
  input.type = "search";
  // Says what the showing view lists: agents By state, the desktop app's panes By place (select() keeps it so).
  input.placeholder = "Search agents";
  input.setAttribute("aria-label", "Search every agent");
  input.setAttribute("enterkeyhint", "search");
  input.autocomplete = "off";
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocorrect", "off");
  input.spellcheck = false;
  const clearBtn = el("button", "find-clear");
  clearBtn.type = "button";
  clearBtn.setAttribute("aria-label", "Clear search");
  clearBtn.append(icon("close"));
  clearBtn.hidden = true;
  box.append(icon("search", "find-ic"), input, clearBtn);
  tools.append(box);
  root.append(line, tools);

  let current: ListView = "agents";
  let found: string | null = null;
  const sums: Record<ListView, string> = { agents: "", panes: "" };
  const showSum = () => setText(sum, found ?? sums[current]);

  const changed = () => {
    setHidden(clearBtn, !input.value);
    on.query(input.value.trim());
  };
  input.addEventListener("input", changed);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (input.value) { input.value = ""; changed(); } else input.blur();
    } else if (e.key === "Enter") { e.preventDefault(); input.blur(); on.enter(); }
  });
  // Clearing doesn't take the keyboard away if it's up, and doesn't raise it if it's not.
  clearBtn.addEventListener("mousedown", (e) => e.preventDefault());
  clearBtn.onclick = () => { input.value = ""; changed(); };

  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || root.offsetParent === null) return;
    const a = document.activeElement as HTMLElement | null;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return;
    e.preventDefault();
    input.focus();
  });

  return {
    root, tools,
    select(list) {
      current = list;
      const noun = list === "agents" ? "agent" : "pane";
      input.placeholder = `Search ${noun}s`;
      input.setAttribute("aria-label", `Search every ${noun}`);
      for (const [id, b] of tabs) {
        const on2 = id === list;
        b.classList.toggle("on", on2);
        b.setAttribute("aria-selected", String(on2));
        b.tabIndex = on2 ? 0 : -1;
      }
      showSum();
    },
    setSum(list, text) { sums[list] = text; showSum(); },
    setFound(text) { found = text; showSum(); },
    query: () => input.value.trim(),
    clear() { if (input.value) { input.value = ""; changed(); } },
  };
}
