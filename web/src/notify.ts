// Notifications from the page's side. Three small jobs, none of which costs anything while nothing is happening:
//  - the number on the app icon: agents waiting plus drafts waiting
//  - closing a notification once it's been answered, which only a page can do (Apple revokes for silent pushes)
//  - telling the gateway which terminal the owner is looking at, so it doesn't buzz about it (gateway/src/push/focus.rs)
import { needsCount, onTerms, terms } from "./app";
import { statusWord, type Terminal } from "./core";
import { addressOfTag, draftOfTag, draftTag, focusedTerminal, terminalTag } from "./drafts-logic";
import { currentNeeds, onNeeds, refreshNeeds, reportFocus } from "./drafts-store";
import { route } from "./router";

/** Repeated this often while the owner is looking. The gateway's word runs out after 30 s. */
const FOCUS_EVERY_MS = 12_000;
/** No touch or key for this long and we no longer claim the owner is looking: a screen left on buzzes the owner's phone. */
const ACTIVE_MS = 120_000;

const stuck = (t: Terminal | undefined) => {
  if (!t || t.state !== "live") return false;
  const w = statusWord(t);
  return w === "blocked" || w === "error";
};

// ---- the app icon ----

type Badging = { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
let termsKnown = false;
let shown: number | null = null;

export function updateAppBadge() {
  const needs = currentNeeds();
  if (!termsKnown || !needs.known) return; // not knowing isn't zero
  const n = needsCount() + needs.drafts.length;
  if (n === shown) return;
  shown = n;
  const nav = navigator as Navigator & Badging;
  try {
    if (n > 0) nav.setAppBadge?.(n)?.catch?.(() => {});
    else nav.clearAppBadge?.()?.catch?.(() => {});
  } catch { /* where it isn't supported, there's no number to keep right */ }
}

// ---- closing what's been answered ----

async function notifications(filter?: { tag: string }): Promise<Notification[]> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    return (await reg?.getNotifications?.(filter)) ?? [];
  } catch { return []; }
}

const isNeeds = (n: Notification) => (n.data as { kind?: string } | null)?.kind === "needs";

/** A terminal stopped waiting. "Finished" shares its tag and stays: that one is news the owner hasn't seen. */
async function closeNeedsFor(address: string) {
  for (const n of await notifications({ tag: terminalTag(address) })) if (isNeeds(n)) n.close();
}

/** The owner is looking at it, so anything about it has been read. */
async function closeAllFor(address: string) {
  for (const n of await notifications({ tag: terminalTag(address) })) n.close();
}

/** Check every notification showing against what we know now. A terminal we can't see says nothing: its machine may be away. */
async function sweep() {
  const needs = currentNeeds();
  for (const n of await notifications()) {
    const address = addressOfTag(n.tag);
    if (address !== null && isNeeds(n)) {
      const t = terms.get(address);
      if (termsKnown && t && !stuck(t)) n.close();
    }
    const draft = draftOfTag(n.tag);
    if (draft !== null && needs.known && !needs.unreachable && !needs.drafts.some((d) => d.id === draft)) n.close();
  }
}

// ---- what the owner is looking at ----

let lastInput = Date.now();
let reported: string | null = null;
let beat = 0;

function focusNow() {
  clearTimeout(beat);
  const now = focusedTerminal({ route: route(), hidden: document.hidden, hasFocus: document.hasFocus(), idleMs: Date.now() - lastInput }, ACTIVE_MS);
  if (now === null) {
    if (reported !== null) { reported = null; reportFocus(null, true).catch(() => {}); }
    return;
  }
  if (now !== reported) void closeAllFor(now);
  reported = now;
  reportFocus(now).catch(() => {});
  beat = window.setTimeout(focusNow, FOCUS_EVERY_MS);
}

function onInput() {
  const wasIdle = Date.now() - lastInput > ACTIVE_MS;
  lastInput = Date.now();
  if (wasIdle) focusNow();
}

export function initNotify() {
  const known = new Set<string>();
  onTerms((c) => {
    if (c.all) {
      termsKnown = true;
      known.clear();
      for (const t of terms.values()) if (stuck(t)) known.add(t.address);
      void sweep();
    } else {
      for (const a of c.addresses) {
        const now = stuck(terms.get(a));
        if (now) known.add(a);
        else if (known.delete(a)) void closeNeedsFor(a); // or removed: nothing left to answer
      }
    }
    updateAppBadge();
  });

  let ids = "";
  onNeeds((n) => {
    updateAppBadge();
    const next = n.drafts.map((d) => draftTag(d.id)).join(" ");
    if (n.known && !n.unreachable && next !== ids) { ids = next; void sweep(); }
  });

  // A push came in: the worker set the icon from the gateway's count, so ours is out of date, and there may be a new draft.
  navigator.serviceWorker?.addEventListener("message", (e) => {
    if (e.data?.type !== "lumbridge-push") return;
    shown = null;
    updateAppBadge();
    void refreshNeeds();
  });

  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(type, onInput, { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { lastInput = Date.now(); void sweep(); shown = null; updateAppBadge(); }
    focusNow();
  });
  window.addEventListener("hashchange", () => { lastInput = Date.now(); focusNow(); });
  window.addEventListener("focus", () => { lastInput = Date.now(); focusNow(); });
  window.addEventListener("blur", focusNow);
  window.addEventListener("pagehide", () => { clearTimeout(beat); if (reported !== null) { reported = null; reportFocus(null, true).catch(() => {}); } });
  focusNow();
}
