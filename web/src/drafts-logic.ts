// The assistant's drafts: everything about them that isn't a browser, so it can be tested.
import { ASSISTANT_NAME } from "./ns";

export type DraftKind = "send" | "worker" | "access" | "issue" | "resume" | "ig_post" | "mail_reply" | "cal_create" | "cal_change" | "cal_decline" | "service_record" | "deploy";
const KINDS: readonly DraftKind[] = ["send", "worker", "access", "issue", "resume", "ig_post", "mail_reply", "cal_create", "cal_change", "cal_decline", "service_record", "deploy"];

export interface Draft {
  id: string;
  kind: DraftKind;
  /** Who or where, as the assistant's tools name it: for a resume change its summary, for an inbox draft the account, for a car service entry "<Car>: <date> <title>". */
  to: string;
  /** The terminal's address, the folder and branch a worker would get, an issue's title, a resume action, or a Story's card and hash. */
  detail: string;
  why: string;
  /** Exactly what would be sent, a worker's task, an issue's body, a resume change, a Story's words, or all an inbox draft would do. */
  text: string;
  /** Sent back with Approve: the gateway refuses if these aren't the words on disk. */
  digest: string;
  createdMs: number;
}

export type DraftState = "pending" | "running" | "done" | "failed" | "rejected";

// Things a screen doesn't show but a terminal acts on: escapes, a carriage return, text running backwards, zero-width characters.
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;

/** The owner approves what the owner sees, so nothing that would be sent may be invisible. Newlines and tabs read as themselves. */
export function visibleText(text: string): string {
  return text.replace(INVISIBLE, (c) => `[U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`);
}

export function titleOf(d: Draft): string {
  switch (d.kind) {
    case "send": return `To ${d.to}`;
    case "access": return `Let ${ASSISTANT_NAME} use ${d.to}`;
    case "issue": return `File a factory issue on ${d.to}`;
    case "resume": return `Resume: ${d.to}`;
    case "ig_post": return `Post a Story on ${d.to}`;
    case "worker": return `Start worker ${d.to}`;
    case "service_record": return `Car service log: ${d.to}`;
    case "deploy": return `${d.detail === "rollback" ? "Roll back" : "Deploy"} ${d.to}`;
    default: return d.to; // inbox drafts: "Email reply · account", "Calendar · account"
  }
}

// ---- a card's preview ----

export const PREVIEW_LINES = 3;
export const PREVIEW_CHARS = 240;

/** What a reader counts as one character: a whole emoji or accented letter, never half of one. */
function characters(text: string): string[] {
  const Seg = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  return Seg ? Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment) : Array.from(text);
}

export interface Preview {
  /** The start of the text, to go through visibleText like the rest. */
  text: string;
  /** Short enough to show in full: no preview, no expand control. */
  whole: boolean;
  /** Lines after the preview's last (a line cut part way counts as shown). */
  moreLines: number;
  /** Characters after the preview. */
  moreChars: number;
  /** Characters in all. */
  chars: number;
}

/** The first 3 lines or 240 characters, whichever is shorter. Trailing blank lines aren't lines. */
export function previewOf(text: string): Preview {
  const all = characters(text);
  const lines = text.replace(/\n+$/, "").split("\n");
  if (lines.length <= PREVIEW_LINES && all.length <= PREVIEW_CHARS) return { text, whole: true, moreLines: 0, moreChars: 0, chars: all.length };
  const head = characters(lines.slice(0, PREVIEW_LINES).join("\n")).slice(0, PREVIEW_CHARS);
  const shown = head.join("");
  return { text: shown, whole: false, moreLines: lines.length - shown.split("\n").length, moreChars: all.length - head.length, chars: all.length };
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Under a preview: never hides that there's more. */
export function moreWords(p: Preview): string {
  return p.moreLines > 0
    ? `+${count(p.moreLines, "more line", "more lines")} · ${count(p.chars, "character", "characters")}`
    : `+${count(p.moreChars, "more character", "more characters")} · ${count(p.chars, "character", "characters")}`;
}

/** What leaves your hands for someone else to read, or lets the assistant act as you: every word must have been on screen before Approve arms. */
export const OUTWARD_KINDS: readonly DraftKind[] = ["mail_reply", "ig_post", "send", "access", "deploy"];
export const isOutward = (d: Draft) => OUTWARD_KINDS.includes(d.kind);

/** Said instead of arming, on an outward-facing card the owner hasn't read in full. */
export const readFirstWords = (d: Draft) => `Read it, then tap ${approveLabel(d)}`;

/** The button before it's armed. An email reply is sent the moment it's approved, so it says so. */
export const approveLabel = (d: Draft) => (d.kind === "mail_reply" ? "Send" : "Approve");

export function armedLabel(d: Draft): string {
  switch (d.kind) {
    case "send": case "mail_reply": return "Tap again to send";
    case "access": return "Tap again to allow";
    case "issue": return "Tap again to file";
    case "ig_post": return "Tap again to post publicly";
    case "worker": return "Tap again to start";
    case "service_record": return "Tap again to add it";
    case "deploy": return d.detail === "rollback" ? "Tap again to roll back" : "Tap again to deploy";
    default: return "Tap again to approve";
  }
}

export function startedWords(d: Draft): string {
  switch (d.kind) {
    case "send": return "Approved. It goes at the next pause in that terminal.";
    case "access": return "Approved. Giving her access.";
    case "issue": return "Approved. Filing the issue.";
    case "resume": return "Approved. Making the change in Reactive Resume.";
    case "ig_post": return "Approved. Posting through the Pixel; it can take a few minutes.";
    case "mail_reply": return "Approved. Sending from Gmail.";
    case "worker": return "Approved. Starting the worker.";
    case "service_record": return "Approved. Adding it to the car's service log.";
    case "deploy": return `Approved. ${d.detail === "rollback" ? "Rolling back" : "Deploying"} ${d.to}; it can take a few minutes.`;
    default: return "Approved. Changing the calendar.";
  }
}

function doneWords(d: Draft): string {
  switch (d.kind) {
    case "send": case "mail_reply": return "Sent.";
    case "access": return "Allowed.";
    case "issue": return "Filed.";
    case "resume": return "Done in Reactive Resume.";
    case "ig_post": return "Posted.";
    case "worker": return "Worker started.";
    case "service_record": return "Added to the car's service log. Not committed yet.";
    case "deploy": return d.detail === "rollback" ? `${d.to} is rolled back.` : `${d.to} is deployed.`;
    default: return "Done in the calendar.";
  }
}

/** What you're told once a decision has run its course. `bad` stays on screen until you clear it. */
export function outcomeWords(d: Draft, state: DraftState): { text: string; bad: boolean } | null {
  switch (state) {
    case "done": return { text: doneWords(d), bad: false };
    case "rejected": return { text: "Dropped. Nothing was sent.", bad: false };
    // A Story can be up without the Pixel proving it, so never "try again" blind: look first.
    case "failed": return d.kind === "ig_post"
      ? { text: "Not posted, or not proven posted. Check the account before asking again.", bad: true }
      : d.kind === "service_record"
      ? { text: `It wasn't added. Nothing in the service log changed unless it already has it; ask ${ASSISTANT_NAME} what it said.`, bad: true }
      // Includes "not confirmed: it may yet arrive", so never suggests sending it again blind.
      : { text: "It didn't go through, or couldn't be confirmed. Look at the terminal before asking again.", bad: true };
    default: return null;
  }
}

/** In place of Approve on a device the assistant can operate, and if Approve is refused there anyway. Reject still works. */
export const ELSEWHERE_WORDS = `${ASSISTANT_NAME} can operate this device, so approve this from another of your devices.`;

/** Every code the gateway can answer with, in words. The gateway's codes are the whole contract: no tool output reaches here. */
export function refusalWords(code: string): string {
  switch (code) {
    case "not_from_here": return ELSEWHERE_WORDS;
    case "changed": return "This draft has changed. Read it again before approving.";
    case "already_handled": return "This was already handled, from here or from the desktop app.";
    case "not_pending": case "bad_id": return "This draft isn't waiting any more.";
    case "core_down": return "The agents aren't reachable on the server right now, so nothing was sent. Try again in a moment.";
    case "timed_out": return "No answer in time, so it may or may not have started. Trying again can't send it twice.";
    case "busy": return "Busy for a moment. Try again.";
    default: return "That didn't work. Try again, or look in the desktop app.";
  }
}

export const OFFLINE_WORDS = "You're offline. Nothing was sent.";
export const UNREACHABLE_WORDS = "Couldn't reach Lumbridge, so this may not have gone through. Trying again can't send it twice.";

/**
 * The answer from /api/assistant/needs, taken apart with care: a draft that can't be shown in full isn't shown. `approveHere`
 * is the gateway's word on this device, and anything but a plain yes is no.
 */
export function parseNeeds(body: unknown): { drafts: Draft[]; stale: boolean; approveHere: boolean } {
  const b = (body ?? {}) as { drafts?: unknown; stale?: unknown; approveHere?: unknown };
  const drafts = Array.isArray(b.drafts) ? b.drafts.filter((d): d is Draft => {
    const x = d as Partial<Draft> | null;
    return !!x && KINDS.includes(x.kind as DraftKind) && [x.id, x.to, x.detail, x.text, x.digest].every((f) => typeof f === "string" && f !== "");
  }) : [];
  return { drafts, stale: b.stale === true, approveHere: b.approveHere === true };
}

// ---- notifications ----

/** The tag the gateway gives a terminal's notification. Its `encode_component` is encodeURIComponent. */
export const terminalTag = (address: string) => `t-${encodeURIComponent(address)}`;
export const draftTag = (id: string) => `draft-${id}`;

/** The terminal a tag belongs to, or null. */
export function addressOfTag(tag: string): string | null {
  if (!tag.startsWith("t-")) return null;
  try { return decodeURIComponent(tag.slice(2)); } catch { return null; }
}

/** The draft a tag belongs to, or null. */
export const draftOfTag = (tag: string): string | null => (tag.startsWith("draft-") ? tag.slice(6) : null);

/** The terminal the owner is provably looking at right now, or null, which the gateway takes to mean "buzz". */
export function focusedTerminal(f: { route: string; hidden: boolean; hasFocus: boolean; idleMs: number }, activeMs: number): string | null {
  if (f.hidden || !f.hasFocus || f.idleMs > activeMs || !f.route.startsWith("t/")) return null;
  try { return decodeURIComponent(f.route.slice(2)) || null; } catch { return null; }
}
