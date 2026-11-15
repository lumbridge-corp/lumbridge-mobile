// The connection to lumbridge-core and the live terminal list, shared by the views.
import { Core, statusWord, type StatusRecord, type Terminal } from "./core";
import { SERVER_NAME } from "./ns";

export const terms = new Map<string, Terminal>();

/** What changed since the last notification. `all` means re-read everything (a fresh snapshot). */
export interface Change { all: boolean; addresses: Set<string>; restarted: Set<string> }
export type ConnState = "connecting" | "online" | "offline";
/** A document changed on a machine (null: this core), or `name: null`: re-read them all, snapshots don't carry them. */
export interface DocChange { name: string | null; machine: string | null }

// `changed` is the old single hook, still called for views that assign it. New code uses onTerms.
export const app: { core: Core | null; changed: () => void; conn: ConnState } = {
  core: null, changed: () => {}, conn: "connecting",
};

const termSubs = new Set<(c: Change) => void>();
const connSubs = new Set<(s: ConnState) => void>();
const docSubs = new Set<(c: DocChange) => void>();

export function onTerms(fn: (c: Change) => void) { termSubs.add(fn); return () => { termSubs.delete(fn); }; }
export function onDoc(fn: (c: DocChange) => void) { docSubs.add(fn); return () => { docSubs.delete(fn); }; }
export function onConn(fn: (s: ConnState) => void) { connSubs.add(fn); return () => { connSubs.delete(fn); }; }
/** Something sent now can reach core. Off, what needs core is disabled and the banner says why. */
export const connected = () => !!app.core && navigator.onLine !== false;
export function setConn(s: ConnState) {
  if (app.conn === s) return;
  app.conn = s;
  for (const fn of [...connSubs]) fn(s);
}

// Thirty terminals can emit in one frame. Views hear about it once per frame, however many events came.
let pending: Change | null = null;
function flush() {
  const c = pending;
  pending = null;
  if (!c) return;
  for (const fn of [...termSubs]) fn(c);
  app.changed();
}
function touch(address: string | null, restarted = false) {
  if (!pending) {
    pending = { all: false, addresses: new Set(), restarted: new Set() };
    if (document.hidden) setTimeout(flush, 250); else requestAnimationFrame(flush);
  }
  if (address === null) pending.all = true;
  else {
    pending.addresses.add(address);
    if (restarted) pending.restarted.add(address);
  }
}

const SPINNER = /^[^\p{L}\p{N}~/.([{"'-]+/u;
const PICTOGRAPH = /\p{Extended_Pictographic}️?/gu;
/** Agents animate a spinner glyph in their title. Dropping it keeps a row from repainting ten times a second. */
export const cleanTitle = (s: string | null | undefined) =>
  (s ?? "").replace(PICTOGRAPH, "").replace(SPINNER, "").trim();

export const statusOf = (t: Terminal): StatusRecord | null =>
  typeof t.status === "string" ? { state: t.status } : t.status ?? null;

// The Agents tab knows where each pane sits, which is most of what names one (paneNames in panes-logic.ts). Every view asks here.
let namer: ((t: Terminal) => string) | null = null;
export const setNamer = (fn: typeof namer) => { namer = fn; };
export const labelOf = (t: Terminal) =>
  namer?.(t) ?? (t.name || cleanTitle(statusOf(t)?.title) || cleanTitle(t.title) || t.foreground?.name || t.address);
/** The machine key for this server's own terminals: they have no machine in their address. */
export const LOCAL_MACHINE = "local";
export const machineOf = (t: Terminal) => (t.address.includes("/") ? t.address.split("/")[0] : LOCAL_MACHINE);
/** For showing: this server's own terminals under its name (SERVER_NAME), the rest under theirs. */
export const machineName = (m: string) => (m === LOCAL_MACHINE ? SERVER_NAME : m);
export const homeless = (path: string) => path.replace(/^\/(?:home\/[^/]+|root)(?=\/|$)/, "~");
export const folderOf = (t: Terminal) => homeless(t.foreground?.cwd || t.cwd || "");
// Core's `status` is only ever set by a program that reports it, which agents do and shells don't.
export const isAgent = (t: Terminal) => t.reported === true || t.status != null;

/** These rows should look again, though core said nothing about them: what they're called has changed. */
export const touchTerminals = (addresses: Iterable<string>) => { for (const a of addresses) touch(a); };

let lastSeq = -1;

/** Replaces everything with a fresh snapshot (first connect, reconnect, `missed`). */
export function setSnapshot(snap: { seq?: number; terminals: Terminal[] }) {
  terms.clear();
  for (const t of snap.terminals) terms.set(t.address, t);
  lastSeq = snap.seq ?? -1;
  touch(null);
  // A first connect, a reconnect or `missed`: whatever documents changed meanwhile, nobody said.
  for (const fn of [...docSubs]) fn({ name: null, machine: null });
}

export function applyEvent(m: any) {
  if (m.method === "missed") { setSnapshot(m.params); return; }
  if (m.method !== "event") return;
  const { seq, type, terminal, data, machine } = m.params;
  if (typeof seq === "number") {
    if (seq <= lastSeq) return;
    lastSeq = seq;
  }
  if (type === "doc") {
    for (const fn of [...docSubs]) fn({ name: data?.name ?? null, machine: machine ?? null });
    return;
  }
  if (!terminal) return;
  if (type === "created" || type === "restarted") terms.set(terminal, data);
  else if (type === "removed") terms.delete(terminal);
  else {
    const t = terms.get(terminal);
    if (!t) return;
    if (type === "status") {
      if (statusWord({ status: data.status }) !== statusWord(t)) t.status_ms = Date.now();
      t.status = data.status;
      t.reported = data.reported ?? t.reported;
    }
    else if (type === "turn") t.turn = data.turn;
    else if (type === "title") t.title = data.title;
    else if (type === "labels") t.labels = data.labels;
    else if (type === "size") { t.cols = data.cols; t.rows = data.rows; }
    else if (type === "foreground") t.foreground = data;
    else if (type === "lost") { t.reason = data.reason; t.exit_code = data.exit_code; t.foreground = null; }
    else if (type === "finished") {
      t.state = "finished"; t.status = null; t.foreground = null; t.reason = data.reason; t.exit_code = data.exit_code;
    }
  }
  touch(terminal, type === "restarted");
}

export const needsCount = () => {
  let n = 0;
  for (const t of terms.values()) {
    const w = statusWord(t);
    if (t.state === "live" && (w === "blocked" || w === "error")) n++;
  }
  return n;
};

// What a blocked agent is asking: the program's own message when it gave one, else the bottom of its screen. The screen is
// also where its numbered choices are. Reads only for blocked rows, at most a few at a time, once per status change.
const asks = new Map<string, { key: number; text: string; choices: Choice[] }>();
const asking = new Map<string, Set<() => void>>();  // whoever wants to hear when this screen has been read
let reading = 0;
const queue: (() => void)[] = [];
const next = () => { if (reading < 3) queue.shift()?.(); };

export function askOf(t: Terminal, done: () => void): string {
  const msg = statusOf(t)?.msg;
  const key = t.status_ms ?? 0;
  const hit = asks.get(t.address);
  if (hit?.key === key) return msg || hit.text;
  // By state and By place can both be showing this row, and both want to hear.
  const waiting = asking.get(t.address);
  if (waiting) { waiting.add(done); return msg || (hit?.text ?? ""); }
  if (!app.core) return msg || (hit?.text ?? "");
  const listeners = new Set([done]);
  asking.set(t.address, listeners);
  const address = t.address;
  queue.push(() => {
    const c = app.core;
    reading++;
    (c ? c.call<{ text: string }>("terminal.read", { terminal: address, lines: 0 }) : Promise.reject(new Error("offline")))
      .then((r) => { asks.set(address, { key, text: askFromScreen(r.text), choices: choicesFromScreen(r.text) }); for (const fn of listeners) fn(); })
      .catch(() => { asks.set(address, { key, text: "", choices: [] }); })
      .finally(() => { reading--; asking.delete(address); next(); });
  });
  next();
  return msg || (hit?.text ?? "");
}

/** The numbered choices on a blocked terminal's screen, once `askOf` has read it. */
export function choicesOf(t: Terminal): Choice[] {
  const hit = asks.get(t.address);
  return hit?.key === (t.status_ms ?? 0) ? hit.choices : [];
}

/**
 * Presses a choice, but only if the screen still offers exactly that: the owner read it a moment ago, and a key sent to a screen
 * that has moved on could answer something else. False if it has moved on.
 */
export async function pressChoice(address: string, choice: Choice): Promise<boolean> {
  const c = app.core;
  if (!c) throw new Error("Not connected");
  const screen = await c.call<{ text: string }>("terminal.read", { terminal: address, lines: 0 });
  if (!choicesFromScreen(screen.text).some((x) => x.key === choice.key && x.label === choice.label)) return false;
  await c.call("terminal.keys", { terminal: address, keys: [choice.key] });
  return true;
}

const FRAME = /[─-╿▀-▟]+/g;
export interface Choice { key: string; label: string }

const screenLines = (text: string) => text.split("\n").map((l) => l.replace(FRAME, " ").replace(/\s+/g, " ").trim()).filter(Boolean);

/**
 * A numbered menu near the bottom of a screen: 1, 2, 3... in order and on consecutive lines. Anything less certain gives
 * nothing, and the owner opens the terminal instead: these become buttons that press keys in a real program.
 */
export function choicesFromScreen(text: string): Choice[] {
  const tail = screenLines(text).slice(-14);
  const ITEM = /^[>❯›]?\s*(\d)[.)]\s+(.+)$/;
  for (let start = tail.length - 1; start >= 0; start--) {
    if (ITEM.exec(tail[start])?.[1] !== "1") continue;
    const out: Choice[] = [];
    for (let i = start; i < tail.length; i++) {
      const m = ITEM.exec(tail[i]);
      if (!m || Number(m[1]) !== out.length + 1) break;
      out.push({ key: m[1], label: m[2] });
    }
    return out.length >= 2 && out.length <= 5 ? out : [];
  }
  return [];
}

/** The most question-like line near the bottom of a screen, with box drawing removed. */
export function askFromScreen(text: string): string {
  const tail = screenLines(text).slice(-14);
  for (let i = tail.length - 1; i >= 0; i--) if (/\?\s*$/.test(tail[i])) return tail[i];
  // Numbered choices follow their question, so the line above the first choice is usually it.
  const firstChoice = tail.findIndex((l) => /^[>❯›]?\s*1[.)]\s/.test(l));
  if (firstChoice > 0) return tail[firstChoice - 1];
  return tail[tail.length - 1] ?? "";
}
