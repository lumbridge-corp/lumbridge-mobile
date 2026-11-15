// What's waiting for your OK, for the assistant's tab, its badge and the app icon. Asks the gateway on open, when you come back, every
// 30 s while the section is in view, otherwise once a minute. Nothing at all while the app is in the background.
import { ApiError, api, getJson, token } from "./api";
import { parseNeeds, type Draft, type DraftState } from "./drafts-logic";

export interface Needs {
  drafts: Draft[];
  stale: boolean;
  /** Approve can work from this device: not one the assistant can operate. */
  approveHere: boolean;
  /** False until the first answer. */
  known: boolean;
  /** The last ask got no answer, so this is the list from before. */
  unreachable: boolean;
}

const IN_VIEW_MS = 30_000, ELSEWHERE_MS = 60_000;

let needs: Needs = { drafts: [], stale: false, approveHere: false, known: false, unreachable: false };
const subs = new Set<(n: Needs) => void>();
let inView = false;
let timer = 0;
let asking: Promise<void> | null = null;

export const currentNeeds = () => needs;
export function onNeeds(fn: (n: Needs) => void) {
  subs.add(fn);
  fn(needs);
  return () => { subs.delete(fn); };
}
function publish(next: Needs) {
  needs = next;
  for (const fn of [...subs]) fn(next);
}

export function refreshNeeds(): Promise<void> {
  asking ??= ask().finally(() => { asking = null; schedule(); });
  return asking;
}

async function ask() {
  if (!token()) return; // Before pairing. An empty token would only use up the rate limit.
  try {
    publish({ ...parseNeeds(await getJson<unknown>("/api/assistant/needs")), known: true, unreachable: false });
  } catch (e) {
    // A gateway from before this route has nothing to offer. Anything else: keep what the owner can see, and say so.
    if (e instanceof ApiError && e.status === 404) publish({ drafts: [], stale: false, approveHere: false, known: true, unreachable: false });
    else publish({ ...needs, unreachable: true });
  }
}

function schedule() {
  clearTimeout(timer);
  if (!document.hidden) timer = window.setTimeout(() => void refreshNeeds(), inView ? IN_VIEW_MS : ELSEWHERE_MS);
}

export function setNeedsInView(v: boolean) {
  inView = v;
  if (v) void refreshNeeds(); else schedule();
}

export function initNeeds() {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(timer); else void refreshNeeds();
  });
  void refreshNeeds();
}

/** The gateway's code for a refusal, or null when the answer never came. */
export async function refusalOf(e: unknown): Promise<string | null> {
  if (!(e instanceof ApiError)) return null;
  try { return String((await e.res.clone().json()).error ?? "failed"); } catch { return "failed"; }
}

// A request that never answers must not leave the buttons disabled. The gateway's own limit is under this.
const withTimeout = () => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 30_000);
  return { signal: c.signal, done: () => clearTimeout(t) };
};

export async function decideDraft(d: Draft, verdict: "approve" | "reject"): Promise<void> {
  const { signal, done } = withTimeout();
  try {
    await api(`/api/assistant/drafts/${encodeURIComponent(d.id)}/${verdict}`, {
      method: "POST", signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify(verdict === "approve" ? { digest: d.digest } : {}),
    });
  } finally { done(); }
}

export const draftState = async (id: string) =>
  (await getJson<{ state: DraftState }>(`/api/assistant/drafts/${encodeURIComponent(id)}`)).state;

export const reportFocus = (terminal: string | null, keepalive = false) =>
  token() ? sendFocus(terminal, keepalive) : Promise.resolve();
const sendFocus = (terminal: string | null, keepalive: boolean) =>
  api("/api/push/focus", { method: "POST", keepalive, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ terminal }) }).then(() => {});

