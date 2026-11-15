import { NS } from "./ns";
// The terminal screen's reasoning, without a DOM: where to scroll, what to remember, how to reflow.

export type ViewMode = "pan" | "fit" | "read";
export interface ViewState {
  mode: ViewMode;
  font: number;         // px, in pan mode
  fromEnd: number | null; // lines above the end when scrolled back; null when following
  left: number;
  draft: string;
}

export const FONT_MIN = 5, FONT_MAX = 24;
export const clampFont = (f: number) => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(f * 2) / 2));
/** Read mode's text size for a pan font: two px bigger, kept to the design system's type scale between 12 and 20 (ties go smaller). */
const READ_SIZES = [12, 13, 14, 16, 18, 20];
export const readFont = (font: number) => READ_SIZES.reduce((best, s) => (Math.abs(s - (font + 2)) < Math.abs(best - (font + 2)) ? s : best));

const KEY = `${NS}.view`;
const MAX_REMEMBERED = 60;

type Stored = Record<string, ViewState & { at: number }>;
function readAll(s: Pick<Storage, "getItem">): Stored {
  try { return JSON.parse(s.getItem(KEY) ?? "{}") as Stored; } catch { return {}; }
}

export function defaultView(coarse: boolean): ViewState {
  return { mode: "pan", font: coarse ? 11 : 13, fromEnd: null, left: 0, draft: "" };
}

export function loadView(address: string, coarse: boolean, s: Pick<Storage, "getItem"> | null = safeStorage()): ViewState {
  const base = defaultView(coarse);
  if (!s) return base;
  const all = readAll(s);
  // A terminal never seen before starts at the size last chosen anywhere.
  const newest = Object.values(all).sort((a, b) => b.at - a.at)[0];
  const hit = all[address];
  if (!hit) return newest ? { ...base, font: newest.font } : base;
  return { ...base, ...hit };
}

export function saveView(address: string, v: ViewState, s: Pick<Storage, "getItem" | "setItem"> | null = safeStorage(), now = Date.now()) {
  if (!s) return;
  const all = readAll(s);
  all[address] = { ...v, draft: v.draft.slice(0, 4000), at: now };
  const keys = Object.keys(all);
  if (keys.length > MAX_REMEMBERED) {
    keys.sort((a, b) => all[a].at - all[b].at);
    for (const k of keys.slice(0, keys.length - MAX_REMEMBERED)) delete all[k];
  }
  try { s.setItem(KEY, JSON.stringify(all)); } catch { /* storage full or blocked: only a convenience */ }
}

function safeStorage(): Storage | null {
  try { return localStorage; } catch { return null; }
}

/**
 * The scroller is native (real momentum), and xterm draws only `rows` lines, so its element rides inside a
 * spacer as tall as the whole buffer. Given where the scroller is, this says which buffer line to show and
 * where to put the element. When the view is taller than the grid, the grid stays at the top of the view.
 */
export function viewportPlan(p: { scrollTop: number; viewH: number; cellH: number; rows: number; baseY: number }) {
  const { scrollTop, viewH, cellH, rows, baseY } = p;
  const grid = rows * cellH;
  if (grid > viewH) {
    const line = Math.min(baseY, Math.max(0, Math.floor(scrollTop / cellH)));
    return { line, top: line * cellH, height: (baseY + rows) * cellH };
  }
  const line = Math.min(baseY, Math.max(0, Math.round(scrollTop / cellH)));
  return { line, top: Math.min(scrollTop, baseY * cellH), height: baseY * cellH + viewH };
}

/**
 * Follow the last line with anything on it, not the grid's bottom: a tall pane is mostly blank at first.
 * A grid shorter than the view is pinned to its top, so following there just means showing the last screen.
 */
export function followTop(p: { lastUsedLine: number; cellH: number; viewH: number; contentH: number; rows: number; baseY: number }) {
  if (p.rows * p.cellH <= p.viewH) return p.baseY * p.cellH;
  const want = (p.lastUsedLine + 1) * p.cellH + p.cellH / 2 - p.viewH;
  return Math.max(0, Math.min(want, p.contentH - p.viewH));
}

/** Near enough to the end counts as following: a flick that lands one line short shouldn't pause it. */
export const isFollowing = (scrollTop: number, target: number, cellH: number) => scrollTop >= target - cellH * 1.5;

export function fitFont(viewW: number, cols: number, cellWPerFontPx: number) {
  if (!cols || !cellWPerFontPx) return FONT_MIN;
  return Math.max(2, Math.min(FONT_MAX, (viewW - 2) / cols / cellWPerFontPx));
}

const BOX = /[─-╿▀-▟]/;
const ALL_BOX = /^[\s─-╿▀-▟]*$/;

/**
 * For Read mode: lines of a 200-column pane as prose a phone can wrap. Wrapped lines rejoin, side rules
 * and full-width rules go, and runs of blank lines shrink to one.
 */
export function reflow(lines: { text: string; wrapped: boolean }[]): string {
  const joined: string[] = [];
  for (const l of lines) {
    if (l.wrapped && joined.length) joined[joined.length - 1] += l.text;
    else joined.push(l.text);
  }
  const out: string[] = [];
  for (const raw of joined) {
    let s = raw.trimEnd();
    if (ALL_BOX.test(s)) s = "";
    else if (BOX.test(s)) s = s.replace(/^\s*[─-╿]\s?/, "").replace(/\s*[─-╿]\s*$/, "").trimEnd();
    if (!s && !out[out.length - 1]) continue;
    out.push(s);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join("\n");
}

const ANY_TIME = ["up", "down", "tab", "left", "right", "space", "backspace", "shift+tab", "ctrl+c", "ctrl+d", "ctrl+o", "ctrl+r", "ctrl+l"];

/**
 * The key bar, as key names in order. A numbered menu on screen puts its numbers first, and only as many as it has, then
 * what closes or accepts it. Otherwise it's the keys for moving around a program. Nothing is ever out of reach, only further along.
 */
export function keyLayout(choices: number): string[] {
  if (choices <= 0) return ["esc", "up", "down", "enter", "tab", ...ANY_TIME.slice(3)];
  return [...Array.from({ length: Math.min(choices, 5) }, (_, i) => String(i + 1)), "esc", "enter", ...ANY_TIME];
}

/** Where the bar shows a small gap: after a menu's numbers, and before the Ctrl keys, so a thumb finds each group by shape. */
export function keyGaps(ids: string[]): Set<number> {
  const num = (k: string) => /^\d$/.test(k), ctrl = (k: string) => k.startsWith("ctrl+");
  const out = new Set<number>();
  for (let i = 1; i < ids.length; i++) if ((num(ids[i - 1]) && !num(ids[i])) || (ctrl(ids[i]) && !ctrl(ids[i - 1]))) out.add(i);
  return out;
}

/** Ctrl-C is easy to hit by accident on glass: the first tap arms it, the second sends. */
export function confirmer(ms: number, now: () => number = Date.now) {
  let armedAt = -Infinity;
  return {
    tap() {
      const t = now();
      if (t - armedAt <= ms) { armedAt = -Infinity; return "send" as const; }
      armedAt = t;
      return "armed" as const;
    },
    reset() { armedAt = -Infinity; },
  };
}

/** A little over the 10 s `timeout` core gets for terminal.send: past this, a dead socket isn't going to answer. */
export const SEND_LIMIT_MS = 12000;
export const NOT_SENT = "Not sent. Your message is still here.";

/** A call's answer, or "late" if none came within `ms`. The call itself goes on; a late answer still arrives through it. */
export function withinLimit<T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; error: Error } | "late"> {
  return new Promise((done) => {
    const timer = setTimeout(() => done("late"), ms);
    p.then(
      (value) => { clearTimeout(timer); done({ ok: true, value }); },
      (error) => { clearTimeout(timer); done({ ok: false, error: error instanceof Error ? error : new Error(String(error)) }); },
    );
  });
}

/** After a send answers: the box empties only if it still holds what went, so nothing typed since is lost. */
export const clearAfterSend = (boxNow: string, sent: string) => boxNow === sent;

export const NOT_CONFIRMED = "Not confirmed yet. It may still arrive.";
export const SENT_LATE = "Sent after all.";
/** How long a send that went quiet holds Send back. Past this it counts as not sent, and Send comes back. */
export const UNCONFIRMED_MS = 60000;

/**
 * A send with no answer by the limit. It may still land, so while the box holds exactly that text Send is held back:
 * the same line mustn't go twice. Editing the text, an answer, or the hard end lets go.
 */
export function unconfirmed(text: string) {
  let state: "held" | "released" | "over" = "held";
  return {
    text,
    holds: (boxNow: string) => state === "held" && boxNow === text,
    /** The box changed. Different text is a new message, so it can go. */
    edited(boxNow: string) { if (state === "held" && boxNow !== text) state = "released"; },
    /** The answer came after all: delivered empties the box if it still holds what went; refused or failed says so, unless the hard end already did. */
    answered(ok: boolean, boxNow: string): { clear: boolean; say: string | null } {
      const wasOver = state === "over";
      state = "over";
      if (ok) { const clear = clearAfterSend(boxNow, text); return { clear, say: clear ? SENT_LATE : null }; }
      return { clear: false, say: wasOver ? null : NOT_SENT };
    },
    /** The hard end: still held, it's treated as not sent. */
    expired(): string | null {
      const was = state;
      if (was !== "over") state = "over";
      return was === "held" ? NOT_SENT : null;
    },
  };
}
export type Unconfirmed = ReturnType<typeof unconfirmed>;
