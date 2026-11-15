// The desktop app's layout as data: each machine's `lumbridge-app` document, joined against the live terminals. No DOM, so it can be
// tested. The model it reads is the desktop app's layout document. Everything in a document is somebody's text, and
// any of it may be missing or the wrong shape: this never throws, and the view only ever uses it as text.
import { cleanTitle, folderOf, isAgent, LOCAL_MACHINE, machineName, statusOf } from "./app";
import { bucket, statusWord, type Terminal } from "./core";
import { compareRows, isPinned } from "./inbox";

export const DOC = "lumbridge-app";
/** A machine as core names it. Null is this core, whose addresses have no prefix. */
export type Machine = string | null;

export interface Pane {
  id: string;
  /** Null for a block showing anything but a terminal. */
  address: string | null;
  /** A block's own name for itself: its title, or the mod it shows. */
  title: string;
}
/** A pane's place in its tab, as fractions of the tab (0 to 1). */
export interface Box { x: number; y: number; w: number; h: number; pane: Pane }
export interface Tab { id: string; name: string; panes: Pane[]; boxes: Box[] }
export interface Space { id: string; name: string; folder: string; tabs: Tab[] }

const MAX_DEPTH = 32, MAX_NODES = 4000;
/** How wide a fixed-size block is taken to be against its row or column: there's no real window to measure here. */
const PX_REF = 1200;

/** mirror.rs `qualify`: a pane on machine m names `t13`; this core addresses it `m/t13`. */
export const qualify = (id: string, machine: Machine) => (machine ? `${machine}/${id}` : id);

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const kids = (n: Record<string, any>): Record<string, any>[] => (Array.isArray(n.children) ? n.children.filter(isObj) : []);

/** Shares along a row or column that add up to 1. No size is a weight of 1; px counts against a nominal width. */
export function shares(children: { size?: unknown }[]): number[] {
  const parsed = children.map((c) => {
    const s = isObj(c.size) ? c.size : {};
    if (Number.isFinite(s.px) && s.px > 0) return { px: s.px as number };
    return { weight: Number.isFinite(s.weight) && s.weight > 0 ? (s.weight as number) : 1 };
  });
  const weights = parsed.reduce((a, p) => a + (p.weight ?? 0), 0);
  const pxs = parsed.reduce((a, p) => a + (p.px ?? 0), 0);
  // With nothing to share the rest, fixed sizes just compare with each other.
  const pxScale = weights ? Math.min(1 / PX_REF, 0.8 / (pxs || 1)) : 1 / (pxs || 1);
  const left = 1 - pxs * pxScale;
  return parsed.map((p) => (p.px ? p.px * pxScale : ((p.weight ?? 0) / (weights || 1)) * left));
}

function blockPane(n: Record<string, any>, machine: Machine): Pane {
  const content = isObj(n.content) ? n.content : {};
  const terminal = str(content.terminal);
  return {
    id: str(n.id),
    address: terminal ? qualify(terminal, machine) : null,
    title: str(n.title) || str(content.mod),
  };
}

/** Everything a tab holds, for the list. What a stack keeps behind its active child is still a pane the owner can go to. */
function collect(root: Record<string, any>, machine: Machine): Pane[] {
  const out: Pane[] = [];
  let budget = MAX_NODES;
  const walk = (n: Record<string, any>, depth: number) => {
    if (depth > MAX_DEPTH || budget-- <= 0) return;
    if (n.type === "block") out.push(blockPane(n, machine));
    if (Array.isArray(n.floating)) {
      for (const f of n.floating) if (isObj(f) && isObj(f.content) && str(f.content.terminal)) out.push(blockPane(f, machine));
    }
    for (const c of kids(n)) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** What's on screen in the tab, laid out from the weights: hidden nodes skipped, a stack showing its active child. */
function layout(root: Record<string, any>, machine: Machine): Box[] {
  const out: Box[] = [];
  let budget = MAX_NODES;
  const walk = (n: Record<string, any>, x: number, y: number, w: number, h: number, depth: number) => {
    if (depth > MAX_DEPTH || budget-- <= 0 || n.hidden === true) return;
    if (n.type === "block") { out.push({ x, y, w, h, pane: blockPane(n, machine) }); return; }
    const visible = kids(n).filter((c) => c.hidden !== true);
    if (n.type === "stack") {
      const active = visible.find((c) => c.id === n.active) ?? visible[0];
      if (active) walk(active, x, y, w, h, depth + 1);
      return;
    }
    const across = n.type !== "column";
    const parts = shares(visible);
    let at = 0;
    visible.forEach((c, i) => {
      const s = parts[i];
      if (across) walk(c, x + at * w, y, s * w, h, depth + 1);
      else walk(c, x, y + at * h, w, s * h, depth + 1);
      at += s;
    });
  };
  walk(root, 0, 0, 1, 1, 0);
  return out;
}

/** A document's spaces, addressed from this core. Anything else, null included, is no spaces. */
export function parseDoc(value: unknown, machine: Machine): Space[] {
  if (!isObj(value) || !Array.isArray(value.spaces)) return [];
  return value.spaces.filter(isObj).map((s, si) => ({
    id: str(s.id) || `space-${si}`,
    name: str(s.name),
    folder: str(s.folder),
    tabs: (Array.isArray(s.tabs) ? s.tabs : []).filter(isObj).map((t, ti) => {
      const root = isObj(t.root) ? t.root : {};
      return { id: str(t.id) || `tab-${ti}`, name: str(t.name), panes: collect(root, machine), boxes: layout(root, machine) };
    }),
  }));
}

export type PaneKind = "panel" | "gone" | "ended" | "live";
/** A terminal core no longer has is gone. One that has ended still has a last screen to look at. */
export function paneKind(p: Pane, terms: Map<string, Terminal>): PaneKind {
  if (!p.address) return "panel";
  const t = terms.get(p.address);
  if (!t) return "gone";
  return t.state === "live" ? "live" : "ended";
}

export interface Placed { pane: Pane; terminal: Terminal; machine: Machine; space: Space; tab: Tab }

export function needsYou(docs: { machine: Machine; spaces: Space[] }[], terms: Map<string, Terminal>): Placed[] {
  const seen = new Map<string, Placed>();
  for (const { machine, spaces } of docs) {
    for (const space of spaces) for (const tab of space.tabs) for (const pane of tab.panes) {
      const terminal = pane.address ? terms.get(pane.address) : undefined;
      if (!pane.address || !terminal || seen.has(pane.address)) continue;
      if (terminal.state === "live" && bucket(terminal) === "needs") seen.set(pane.address, { pane, terminal, machine, space, tab });
    }
  }
  const byChange = compareRows("needs");
  return [...seen.values()].sort((a, b) => byChange(a.terminal, b.terminal));
}

export interface Tally { panes: number; needs: number; working: number; done: number }
export function tally(addresses: Iterable<string>, terms: Map<string, Terminal>): Tally {
  const n: Tally = { panes: 0, needs: 0, working: 0, done: 0 };
  for (const a of new Set(addresses)) {
    const t = terms.get(a);
    if (!t || t.state !== "live") continue;
    n.panes++;
    const b = bucket(t);
    if (b === "needs") n.needs++;
    else if (b === "working") n.working++;
    else if (b === "done" && isAgent(t)) n.done++;
  }
  return n;
}

export const addressesIn = (space: Space) =>
  space.tabs.flatMap((t) => t.panes.flatMap((p) => (p.address ? [p.address] : [])));

/** Machines with a lot of spaces start folded, or the page is one long scroll. The owner's choice sticks after that. */
export const startsOpen = (spacesOnMachine: number) => spacesOnMachine <= 3;

// ---- what to call a pane ----

/** A tab or pane nobody named: nothing, a number, "Tab 2", "shell". */
const DEFAULT_NAME = /^(?:(?:new\s+)?tab|untitled|shell|terminal|term|window|pane|session)?(?:\s*#?\d+)?$/i;
/** Names that say which program runs and nothing about the work. */
const PROGRAMS = new Set([
  "claude", "claudecode", "codex", "opencode", "gemini", "geminicli", "amp", "pi", "hermes", "openclaw", "aider", "cursor", "goose", "assistant",
  "bash", "zsh", "fish", "sh", "dash", "ksh", "nu", "tmux", "screen", "ssh", "mosh", "node", "python", "python3", "vim", "nvim", "vi", "nano",
  "less", "man", "top", "htop", "btop", "ghostty", "hc", "lumbridge", "lumbridgetui", "lumbridgecore", "lbc",
]);
/** What a shell sets as its title: `me@box: ~/here`, `me@box`, or just a path. */
const PROMPT = /^[^\s@:]+@[^\s:]+(?::\s*(?:~|\/).*)?\s*[$#%>]?$/;
const PATHLIKE = /^(?:~(?:\/|$)|\/)/;
const squash = (s: string) => s.toLowerCase().replace(/\s+v?\d+(?:\.\d+)*$/, "").replace(/[^\p{L}\p{N}]+/gu, "");

export const isDefaultName = (s: string) => DEFAULT_NAME.test(s.trim());
const isShellish = (s: string) => PROMPT.test(s) || PATHLIKE.test(s);

/** True when `s` says nothing but which program this is, or where its shell is sitting. */
export function isGenericName(s: string, t?: Terminal): boolean {
  const word = squash(s);
  if (!word || PROGRAMS.has(word) || isShellish(s.trim())) return true;
  if (!t) return false;
  return word === squash(t.foreground?.name ?? "") || word === squash(statusOf(t)?.app ?? "");
}

/** The last part of a folder. Nothing for home, which tells the owner nothing. */
export function lastSegment(folder: string): string {
  const f = folder.replace(/\/+$/, "");
  if (!f || f === "~") return "";
  return f.slice(f.lastIndexOf("/") + 1);
}

/** The program, as a small word beside the name. Empty once it has ended. */
export function programOf(t: Terminal): string {
  if (t.state !== "live") return "";
  return (statusOf(t)?.app ?? "").replace(/-code$/, "") || t.foreground?.name || "";
}

/**
 * The name a pane goes by: your own, then a title that means something, then its desktop app pane or tab, then its folder.
 * When none of those says anything, the program is at least true.
 */
export function paneLabel(t: Terminal, where: { pane?: string; tab?: string } = {}): string {
  const given = t.name?.trim();
  if (given) return given;
  const titles = [cleanTitle(statusOf(t)?.title), cleanTitle(t.title)];
  for (const title of titles) if (title && !isGenericName(title, t)) return title;
  for (const place of [where.pane, where.tab]) if (place?.trim() && !isDefaultName(place) && !isGenericName(place, t)) return place.trim();
  const folder = lastSegment(folderOf(t));
  if (folder) return folder;
  if (where.tab?.trim() && !isDefaultName(where.tab)) return where.tab.trim();
  return titles.find((x) => x && !isShellish(x)) || t.foreground?.name || t.address;
}

/**
 * What each placed terminal is called, with panes of one space told apart when they'd read the same: by their own folder or
 * tab where that's theirs alone, and by number where nothing is. One left over needs nothing: the others already differ from it.
 */
export function paneNames(docs: { machine: Machine; spaces: Space[] }[], terms: Map<string, Terminal>): Map<string, string> {
  const out = new Map<string, string>();
  for (const { spaces } of docs) for (const space of spaces) {
    const same = new Map<string, { address: string; label: string; folder: string; tab: string }[]>();
    for (const tab of space.tabs) for (const pane of tab.panes) {
      const t = pane.address ? terms.get(pane.address) : undefined;
      if (!t || out.has(t.address)) continue;
      const label = paneLabel(t, { pane: pane.title, tab: tab.name });
      out.set(t.address, label);
      const key = label.toLowerCase();
      const entry = { address: t.address, label, folder: lastSegment(folderOf(t)), tab: isDefaultName(tab.name) ? "" : tab.name.trim() };
      const list = same.get(key);
      if (list) list.push(entry); else same.set(key, [entry]);
    }
    for (const group of same.values()) {
      if (group.length < 2) continue;
      const count = (pick: (e: (typeof group)[number]) => string, v: string) => group.filter((e) => pick(e).toLowerCase() === v.toLowerCase()).length;
      const rest: typeof group = [];
      for (const e of group) {
        const own = [e.folder, e.tab].find((v, i) => v && v.toLowerCase() !== e.label.toLowerCase() && count(i ? (x) => x.tab : (x) => x.folder, v) === 1);
        if (own) out.set(e.address, `${e.label} · ${own}`); else rest.push(e);
      }
      if (rest.length > 1) rest.forEach((e, i) => out.set(e.address, `${e.label} ${i + 1}`));
    }
  }
  return out;
}

// ---- everything that can be opened, flat ----

/** A terminal and where it is, when a layout says. */
export interface Listed { pane: Pane; terminal: Terminal; machine: Machine; space?: Space; tab?: Tab }

/** Every placed terminal in layout order, then any live one no layout mentions. A gone terminal or a panel can't be opened, so neither is here. */
export function listAll(docs: { machine: Machine; spaces: Space[] }[], terms: Map<string, Terminal>): Listed[] {
  const seen = new Map<string, Listed>();
  for (const { machine, spaces } of docs) for (const space of spaces) for (const tab of space.tabs) for (const pane of tab.panes) {
    const terminal = pane.address ? terms.get(pane.address) : undefined;
    if (terminal && !seen.has(terminal.address)) seen.set(terminal.address, { pane, terminal, machine, space, tab });
  }
  for (const terminal of terms.values()) {
    if (terminal.state !== "live" || seen.has(terminal.address)) continue;
    const i = terminal.address.indexOf("/");
    seen.set(terminal.address, { pane: { id: "", address: terminal.address, title: "" }, terminal, machine: i > 0 ? terminal.address.slice(0, i) : null });
  }
  return [...seen.values()];
}

/** Needing the owner and in no layout: the badge counts these, so the list has to show them. */
export const looseNeeds = (all: Listed[]) => all.filter((x) => !x.space && x.terminal.state === "live" && bucket(x.terminal) === "needs");

export const favoritesIn = (all: Listed[]) => all.filter((x) => x.terminal.state === "live" && isPinned(x.terminal));

// ---- the panes the owner opened last, by address ----
export const RECENT_SHOWN = 5;
const RECENT_KEPT = 20;

export function parseRecent(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 200))].slice(0, RECENT_KEPT) : [];
  } catch { return []; }
}

/** Newest first. More are kept than shown, so one going away doesn't leave the list short. */
export const pushRecent = (list: string[], address: string) => [address, ...list.filter((a) => a !== address)].slice(0, RECENT_KEPT);

/** The last few still there, leaving out what's already on show above them. */
export function recentIn(list: string[], all: Listed[], above: Iterable<string> = []): Listed[] {
  const skip = new Set(above);
  const by = new Map(all.map((x) => [x.terminal.address, x]));
  const out: Listed[] = [];
  for (const a of list) {
    const x = by.get(a);
    if (x && !skip.has(a)) out.push(x);
    if (out.length === RECENT_SHOWN) break;
  }
  return out;
}

// ---- search ----
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

export const queryWords = (q: string) => fold(q).split(/\s+/).filter(Boolean);

/** Every word has to be in one field or another, in any order. */
export function matchesWords(words: string[], fields: (string | null | undefined)[]): boolean {
  const hay = fields.map((f) => fold(f ?? ""));
  return words.every((w) => hay.some((h) => h.includes(w)));
}

/** What a query finds across every machine, folded spaces included. What needs the owner goes first, then layout order; what has ended, last. */
export function findPanes(query: string, all: Listed[], nameOf: (t: Terminal) => string = (t) => paneLabel(t)): Listed[] {
  const words = queryWords(query);
  if (!words.length) return [];
  const rank = (x: Listed) => (x.terminal.state !== "live" ? 2 : ["blocked", "error"].includes(statusWord(x.terminal) ?? "") ? 0 : 1);
  return all
    .filter((x) => matchesWords(words, [
      nameOf(x.terminal), x.tab?.name, x.space?.name, machineName(x.machine ?? LOCAL_MACHINE), folderOf(x.terminal), programOf(x.terminal),
    ]))
    .map((x, i) => ({ x, i }))
    .sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i)
    .map((e) => e.x);
}
