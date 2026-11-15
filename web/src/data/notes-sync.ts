import { NS } from "../ns";
// Autosave for one note. The rule behind all of it: the owner's text stays on the device until the server has confirmed it,
// and a conflict never overwrites anything without the owner seeing both versions.

export interface Note {
  id: string; title: string; body: string; pinned: boolean;
  created_at: string; updated_at: string; deleted_at: string | null; version: number;
}

export interface Draft {
  id: string;
  /** The server version this draft is based on; null if the server hasn't got it yet. */
  version: number | null;
  /** What the server had at `version`. */
  base: { title: string; body: string; pinned: boolean };
  title: string; body: string; pinned: boolean;
  /** When the owner last touched it, for ordering in the list. */
  edited_at: number;
  /** The server's version, when it can't be reconciled without the owner. */
  other?: Note | null;
}

export function newDraft(id: string, now = Date.now()): Draft {
  return { id, version: null, base: { title: "", body: "", pinned: false }, title: "", body: "", pinned: false, edited_at: now };
}

export function draftOf(n: Note, now = Date.now()): Draft {
  return { id: n.id, version: n.version, base: { title: n.title, body: n.body, pinned: n.pinned }, title: n.title, body: n.body, pinned: n.pinned, edited_at: now };
}

const sameText = (a: { title: string; body: string }, b: { title: string; body: string }) => a.title === b.title && a.body === b.body;
export const isDirty = (d: Draft) => d.version === null ? !isEmpty(d) : !sameText(d, d.base) || d.pinned !== d.base.pinned;
export const isEmpty = (d: Draft) => !d.title.trim() && !d.body.trim();

/** Only what changed, so a pin on one device and an edit on another don't look like a clash. */
export function patchFor(d: Draft): Record<string, unknown> {
  const p: Record<string, unknown> = { version: d.version };
  if (d.title !== d.base.title) p.title = d.title;
  if (d.body !== d.base.body) p.body = d.body;
  if (d.pinned !== d.base.pinned) p.pinned = d.pinned;
  return p;
}

export type Resolution = "same" | "rebase" | "take-theirs" | "conflict" | "deleted";

/**
 * After a 409. "same": the owner's text is already there (say the response to the last save got lost). "rebase": only their
 * metadata moved, so the owner's edit applies cleanly on top. "take-theirs": the owner hasn't changed the text, so theirs is simply
 * newer. Anything else needs the owner.
 */
export function resolve(d: Draft, theirs: Note): Resolution {
  if (theirs.deleted_at) return "deleted";
  if (sameText(d, theirs)) return "same";
  if (sameText(d, d.base)) return "take-theirs";
  if (sameText(theirs, d.base)) return "rebase";
  return "conflict";
}

export type Saved =
  | { kind: "ok"; note: Note }
  | { kind: "conflict"; note: Note }
  | { kind: "gone" } // The server has no such note, so it goes back as new.
  | { kind: "offline" } // Network down or 503: keep it and try again.
  | { kind: "rejected"; why: string }; // The server will never take this as it stands.

export interface NoteIo {
  create(n: { id: string; title: string; body: string; pinned: boolean }, keepalive: boolean): Promise<Saved>;
  patch(id: string, patch: Record<string, unknown>, keepalive: boolean): Promise<Saved>;
  restore(id: string): Promise<Saved>;
}

export interface DraftStorage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; key(i: number): string | null; readonly length: number }

const PREFIX = `${NS}.notes.draft.`;

export class Drafts {
  constructor(private s: DraftStorage) {}
  save(d: Draft): boolean {
    try { this.s.setItem(PREFIX + d.id, JSON.stringify(d)); return true; } catch { return false; }
  }
  remove(id: string) { try { this.s.removeItem(PREFIX + id); } catch { /* nothing to lose */ } }
  load(id: string): Draft | null {
    try { const v = this.s.getItem(PREFIX + id); return v ? JSON.parse(v) : null; } catch { return null; }
  }
  all(): Draft[] {
    const out: Draft[] = [];
    try {
      for (let i = 0; i < this.s.length; i++) {
        const k = this.s.key(i);
        if (k?.startsWith(PREFIX)) { const d = this.load(k.slice(PREFIX.length)); if (d) out.push(d); }
      }
    } catch { /* storage is unavailable: no drafts to show */ }
    return out.sort((a, b) => b.edited_at - a.edited_at);
  }
}

export type Status = "saved" | "pending" | "saving" | "offline" | "conflict" | "deleted" | "rejected";

export const DEBOUNCE_MS = 800;
const RETRY_MS = [2000, 5000, 15000, 30000];

export class Autosave {
  status: Status = "saved";
  why = "";
  /** False if the browser refused to store the draft: the one case where a lost connection could lose text. */
  stored = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private retries = 0;
  private discarded = false;

  constructor(
    public draft: Draft,
    private io: NoteIo,
    private store: Drafts,
    /** Any status change. The editor sets this while it's open. */
    public changed: () => void = () => {},
    /** The text on screen must change to match the draft (theirs was newer and the owner had no edits). */
    public replaced: () => void = () => {},
    private newId: () => string = () => crypto.randomUUID(),
  ) {
    if (draft.other) this.status = draft.other.deleted_at ? "deleted" : "conflict";
    else if (isDirty(draft)) this.status = "pending";
  }

  private set(s: Status) { if (this.status !== s) { this.status = s; this.changed(); } }
  private blocked() { return this.status === "conflict" || this.status === "deleted"; }
  private keep() { this.stored = this.store.save(this.draft); }

  /** Every keystroke. Stored synchronously, sent after a pause. */
  edit(change: Partial<Pick<Draft, "title" | "body" | "pinned">>, now = Date.now()) {
    Object.assign(this.draft, change, { edited_at: now });
    if (isDirty(this.draft) || this.blocked()) {
      this.keep();
    } else {
      // Back to exactly what the server has (or nothing, for a new note): no draft to keep.
      this.store.remove(this.draft.id);
    }
    if (this.blocked()) { this.changed(); return; }
    if (!isDirty(this.draft)) { this.clearTimer(); if (!this.inflight) this.set("saved"); return; }
    this.retries = 0;
    this.set("pending");
    this.schedule(DEBOUNCE_MS);
  }

  private clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  private schedule(ms: number) {
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, ms);
  }

  /** Save now: on leaving the note, hiding the page, or coming back online. */
  flush(keepalive = false): Promise<void> {
    this.clearTimer();
    if (this.discarded) return Promise.resolve();
    if (this.inflight) return this.inflight;
    if (this.blocked() || !isDirty(this.draft)) {
      if (!this.blocked()) { this.store.remove(this.draft.id); this.set("saved"); }
      return Promise.resolve();
    }
    this.inflight = this.send(keepalive).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async send(keepalive: boolean): Promise<void> {
    // Stored even if this send succeeds at once: the page can die between here and the answer.
    this.keep();
    this.set("saving");
    const d = this.draft;
    const res = d.version === null
      ? await this.io.create({ id: d.id, title: d.title, body: d.body, pinned: d.pinned }, keepalive)
      : await this.io.patch(d.id, patchFor(d), keepalive);
    await this.received(res);
  }

  private async received(res: Saved): Promise<void> {
    if (this.discarded) return;
    const d = this.draft;
    switch (res.kind) {
      case "ok":
        if (res.note.deleted_at) { this.hold(res.note); return; }
        this.rebaseOn(res.note);
        this.retries = 0;
        return this.settle();
      case "conflict":
        switch (resolve(d, res.note)) {
          case "deleted":
          case "conflict":
            this.hold(res.note);
            return;
          case "take-theirs":
            d.title = res.note.title;
            d.body = res.note.body;
            this.replaced();
            // fallthrough
          case "same":
          case "rebase":
            // A pin the owner changed still goes on top of theirs; otherwise theirs stands.
            if (d.pinned === d.base.pinned) d.pinned = res.note.pinned;
            this.rebaseOn(res.note);
            return this.settle();
        }
        return;
      case "gone":
        d.version = null;
        return this.settle();
      case "offline":
        this.set("offline");
        this.schedule(RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)]);
        return;
      case "rejected":
        this.why = res.why;
        this.set("rejected");
        return;
    }
  }

  private rebaseOn(n: Note) {
    this.draft.version = n.version;
    this.draft.base = { title: n.title, body: n.body, pinned: n.pinned };
  }

  private settle() {
    if (isDirty(this.draft)) {
      this.keep();
      // The owner typed while that was in flight (or it was a rebase); send what's new right after this one.
      this.set("pending");
      this.schedule(0);
    } else {
      this.store.remove(this.draft.id);
      this.set("saved");
    }
  }

  private hold(theirs: Note) {
    this.draft.other = theirs;
    this.keep();
    this.set(theirs.deleted_at ? "deleted" : "conflict");
  }

  /** The owner's text wins; theirs is kept as a new note. Nothing is lost whichever way this goes. */
  async keepMine(): Promise<boolean> {
    const theirs = this.draft.other;
    if (!theirs) return true;
    const copy = await this.io.create({ id: this.newId(), title: `${theirs.title || "Untitled"} (other version)`, body: theirs.body, pinned: false }, false);
    if (copy.kind !== "ok") return false;
    this.rebaseOn(theirs);
    this.draft.other = null;
    this.status = "pending";
    this.changed();
    await this.flush();
    return true;
  }

  /** Theirs wins; the owner's text is kept as a new note. */
  async keepTheirs(): Promise<boolean> {
    const theirs = this.draft.other;
    if (!theirs) return true;
    const copy = await this.io.create({ id: this.newId(), title: `${this.draft.title || "Untitled"} (my version)`, body: this.draft.body, pinned: false }, false);
    if (copy.kind !== "ok") return false;
    this.draft.title = theirs.title;
    this.draft.body = theirs.body;
    this.draft.pinned = theirs.pinned;
    this.rebaseOn(theirs);
    this.draft.other = null;
    this.store.remove(this.draft.id);
    this.status = "saved";
    this.replaced();
    this.changed();
    return true;
  }

  /** Deleted on another device, but the owner wants it: bring it back with the owner's text. */
  async restoreMine(): Promise<boolean> {
    const res = await this.io.restore(this.draft.id);
    if (res.kind !== "ok") return false;
    this.rebaseOn(res.note);
    this.draft.other = null;
    this.status = "pending";
    this.changed();
    await this.flush();
    return true;
  }

  /** Deleted on another device, and the owner agrees. An explicit choice, the only way a draft is thrown away. */
  discard() {
    this.discarded = true;
    this.clearTimer();
    this.store.remove(this.draft.id);
    this.status = "saved";
    this.changed();
  }

  /** Newer text arrived and the owner has no edits: show it. */
  refresh(n: Note) {
    if (isDirty(this.draft) || this.blocked() || this.inflight) return;
    if (this.draft.version !== null && n.version <= this.draft.version) return;
    this.draft.title = n.title;
    this.draft.body = n.body;
    this.draft.pinned = n.pinned;
    this.rebaseOn(n);
    this.replaced();
  }

  stop() { this.clearTimer(); }
}

/** What a row shows: the owner's title, or the first line of the text when the owner didn't give one. */
export function rowText(title: string, preview: string, clean: (s: string) => string): { title: string; preview: string } {
  const t = title.trim();
  if (t) return { title: t, preview: clean(preview) };
  const lines = preview.split("\n").map(clean).filter(Boolean);
  return { title: lines[0] ?? "Untitled", preview: lines.slice(1).join(" ") };
}
