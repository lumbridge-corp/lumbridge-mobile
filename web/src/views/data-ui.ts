// What the notes and tasks screens share: requests, icons, the undo toast and keeping things above the keyboard.
import { api, ApiError } from "../api";
import { el } from "../dom";

export const ICONS: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  pin: '<path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 15v5"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
  check: '<path d="M5 13l4 4 10-11"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l5 5"/>',
};

export function icon(name: keyof typeof ICONS): SVGSVGElement {
  const wrap = document.createElement("span");
  // Static strings from the table above, never note text.
  wrap.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

export function iconButton(name: keyof typeof ICONS, label: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "d-icon");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = label;
  b.append(icon(name));
  b.addEventListener("click", onClick);
  return b;
}

export type Failure = "offline" | "server" | "conflict" | "gone" | "rejected";
export interface Outcome<T> { ok: T | null; fail: Failure | null; why: string; current: T | null }

/** A request that always comes back with a result. A network failure and a 503 both mean "try again later". */
export async function request<T>(path: string, init: RequestInit = {}): Promise<Outcome<T>> {
  const none = (fail: Failure, why = "", current: T | null = null): Outcome<T> => ({ ok: null, fail, why, current });
  try {
    const res = await api(path, init);
    return { ok: (await res.json()) as T, fail: null, why: "", current: null };
  } catch (e) {
    if (!(e instanceof ApiError)) return none("offline");
    const body: any = await e.res.json().catch(() => null);
    if (e.status === 409) return none("conflict", "", body as T);
    if (e.status === 404) return none("gone");
    if (e.status === 503 || e.status === 502 || e.status === 504) return none("server");
    if (e.status >= 500) return none("server", "internal");
    // Only these say the request itself is wrong. A 401, 403 or 429 is about the moment (a whois hiccup, the rate limit, a
    // token being replaced), so what the owner typed stays on the device for another try.
    if (e.status === 400 || e.status === 413 || e.status === 422) return none("rejected", body?.error ?? `HTTP ${e.status}`);
    return none("offline");
  }
}

export const jsonInit = (method: string, body: unknown, keepalive = false): RequestInit => {
  const text = JSON.stringify(body);
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: text,
    // Browsers cap a keepalive request's body at 64 KB and refuse the whole fetch above that.
    keepalive: keepalive && text.length < 60000,
  };
};

let current: { node: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;

/** One toast at a time, above the keyboard and the tabs. */
export function toast(message: string, action?: { label: string; run: () => void }, ms = 6000) {
  dismissToast();
  const node = el("div", "d-toast");
  node.setAttribute("role", "status");
  node.append(el("span", "", message));
  if (action) {
    const b = el("button", "", action.label);
    b.type = "button";
    b.addEventListener("click", () => { dismissToast(); action.run(); });
    node.append(b);
  }
  document.body.append(node);
  current = { node, timer: setTimeout(dismissToast, ms) };
}

export function dismissToast() {
  if (!current) return;
  clearTimeout(current.timer);
  current.node.remove();
  current = null;
}

/**
 * Tracks the on-screen keyboard. On iOS it covers the page without resizing anything, so a fixed screen has to size
 * itself from the visual viewport. Sets --d-vh and --d-kb on <html>; returns the cleanup.
 */
export function watchKeyboard(): () => void {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) return () => {};
  const fit = () => {
    root.style.setProperty("--d-vh", `${vv.height}px`);
    root.style.setProperty("--d-top", `${vv.offsetTop}px`);
    root.style.setProperty("--d-kb", `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`);
  };
  fit();
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  return () => {
    vv.removeEventListener("resize", fit);
    vv.removeEventListener("scroll", fit);
    for (const k of ["--d-vh", "--d-top", "--d-kb"]) root.style.removeProperty(k);
  };
}

/** Runs when the app comes back into view or back online, and on a slow timer while it's in view. */
export function whenFresh(run: () => void, everyMs = 60000): () => void {
  const onVisible = () => { if (document.visibilityState === "visible") run(); };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", run);
  const t = setInterval(onVisible, everyMs);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", run);
    clearInterval(t);
  };
}

export interface ErrorOpts {
  /** danger (default): it failed and needs the owner. warn: it sorts itself out. note: just so the owner knows. */
  tone?: "danger" | "warn" | "note";
  /** A button after the words: Retry unless `label` says otherwise. */
  retry?: () => void;
  label?: string;
}

/**
 * The error state from DESIGN.md, the same on every screen: a status dot and what happened in the tone's color, then one plain
 * sentence of what to do, and Retry when trying again is something the owner can do. Words go in as text, never markup.
 */
export function errorState(what: string, next = "", o: ErrorOpts = {}): HTMLElement {
  const tone = o.tone ?? "danger";
  const box = el("div", `d-error ${tone}`);
  box.setAttribute("role", tone === "danger" ? "alert" : "status");
  const words = el("div", "d-error-words");
  words.append(el("p", "d-error-what", what));
  if (next) words.append(el("p", "d-error-next", next));
  box.append(words);
  if (o.retry) {
    const b = el("button", "d-error-retry", o.label ?? "Retry");
    b.type = "button";
    b.addEventListener("click", o.retry);
    box.append(b);
  }
  return box;
}

/**
 * A place on a screen that shows one error state or nothing, redrawn only when the words change, so a screen that repaints often
 * doesn't announce the same trouble again and again. `null` clears it.
 */
export function errorSlot(cls = ""): { root: HTMLElement; set(what: string | null, next?: string, o?: ErrorOpts): void } {
  const root = el("div", `d-error-slot ${cls}`.trim());
  root.hidden = true;
  let key = "";
  return {
    root,
    set(what, next = "", o = {}) {
      const now = what === null ? "" : JSON.stringify([what, next, o.tone, o.label, !!o.retry]);
      if (now === key) return;
      key = now;
      root.hidden = what === null;
      root.replaceChildren(...(what === null ? [] : [errorState(what, next, o)]));
    },
  };
}
