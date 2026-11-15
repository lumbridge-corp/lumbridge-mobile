import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Autosave, DEBOUNCE_MS, Drafts, draftOf, isDirty, newDraft, patchFor, resolve, rowText, type Draft, type DraftStorage, type Note, type NoteIo, type Saved } from "./notes-sync";
import { NS } from "../ns";

function memory(): DraftStorage & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

const note = (o: Partial<Note> = {}): Note => ({
  id: "n1", title: "t", body: "b", pinned: false, created_at: "", updated_at: "", deleted_at: null, version: 1, ...o,
});

// A server the test drives: every call waits until the test answers it.
function server() {
  const calls: { kind: string; args: any; answer(r: Saved): void }[] = [];
  const call = (kind: string) => (...args: any[]) =>
    new Promise<Saved>((answer) => { calls.push({ kind, args: args[args.length > 1 && kind === "patch" ? 1 : 0], answer }); });
  const io: NoteIo = { create: call("create"), patch: call("patch"), restore: call("restore") };
  return { io, calls };
}

const tick = () => vi.advanceTimersByTimeAsync(0);

describe("resolve", () => {
  const d = (o: Partial<Draft>): Draft => ({ ...draftOf(note()), ...o });
  it("sees that the owner's text already landed", () => expect(resolve(d({ body: "x" }), note({ version: 2, body: "x" }))).toBe("same"));
  it("takes theirs when the owner hasn't edited", () => expect(resolve(d({}), note({ version: 2, body: "new" }))).toBe("take-theirs"));
  it("rebases when only metadata moved", () => expect(resolve(d({ body: "mine" }), note({ version: 2, pinned: true }))).toBe("rebase"));
  it("stops when both changed the text", () => expect(resolve(d({ body: "mine" }), note({ version: 2, body: "theirs" }))).toBe("conflict"));
  it("notices a delete first", () => expect(resolve(d({ body: "mine" }), note({ version: 2, deleted_at: "x" }))).toBe("deleted"));
});

describe("patchFor", () => {
  it("sends only what changed", () => {
    expect(patchFor({ ...draftOf(note({ version: 3 })), body: "x" })).toEqual({ version: 3, body: "x" });
    expect(patchFor({ ...draftOf(note({ version: 3 })), pinned: true })).toEqual({ version: 3, pinned: true });
  });
});

describe("Autosave", () => {
  let store: ReturnType<typeof memory>;
  let drafts: Drafts;
  const stored = (id = "n1") => drafts.load(id);

  beforeEach(() => { vi.useFakeTimers(); store = memory(); drafts = new Drafts(store); });
  afterEach(() => { vi.useRealTimers(); });

  it("stores on every keystroke and sends once after a pause", async () => {
    const { io, calls } = server();
    const a = new Autosave(draftOf(note()), io, drafts);
    a.edit({ body: "h" });
    expect(stored()?.body).toBe("h");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS / 2);
    a.edit({ body: "he" });
    expect(stored()?.body).toBe("he");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS / 2);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ version: 1, body: "he" });
    expect(a.status).toBe("saving");
    expect(stored()?.body, "still there until the server confirms").toBe("he");
    calls[0].answer({ kind: "ok", note: note({ version: 2, body: "he" }) });
    await tick();
    expect(a.status).toBe("saved");
    expect(stored(), "gone once confirmed").toBeNull();
    expect(a.draft.version).toBe(2);
  });

  it("never runs two saves at once, and sends what the owner typed during the first", async () => {
    const { io, calls } = server();
    const a = new Autosave(draftOf(note()), io, drafts);
    a.edit({ body: "one" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    a.edit({ body: "two" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    expect(calls).toHaveLength(1);
    calls[0].answer({ kind: "ok", note: note({ version: 2, body: "one" }) });
    await tick();
    expect(stored()?.body, "two isn't confirmed yet").toBe("two");
    expect(a.status).toBe("saving");
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual({ version: 2, body: "two" });
    calls[1].answer({ kind: "ok", note: note({ version: 3, body: "two" }) });
    await tick();
    expect(a.status).toBe("saved");
    expect(stored()).toBeNull();
  });

  it("keeps the draft through an outage and retries by itself", async () => {
    const { io, calls } = server();
    const a = new Autosave(draftOf(note()), io, drafts);
    a.edit({ body: "typed offline" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    calls[0].answer({ kind: "offline" });
    await tick();
    expect(a.status).toBe("offline");
    expect(stored()?.body).toBe("typed offline");
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(2);
    calls[1].answer({ kind: "offline" });
    await tick();
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls, "backs off").toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);
    calls[2].answer({ kind: "ok", note: note({ version: 2, body: "typed offline" }) });
    await tick();
    expect(a.status).toBe("saved");
    expect(stored()).toBeNull();
  });

  it("a new note isn't sent until there's something in it, and an emptied one leaves no draft", async () => {
    const { io, calls } = server();
    const a = new Autosave(newDraft("n1"), io, drafts);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(calls).toHaveLength(0);
    a.edit({ title: "x" });
    expect(stored()?.title).toBe("x");
    a.edit({ title: "" });
    expect(stored()).toBeNull();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(calls).toHaveLength(0);
    a.edit({ body: "real" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(calls[0].kind).toBe("create");
    expect(calls[0].args).toMatchObject({ id: "n1", body: "real" });
    calls[0].answer({ kind: "ok", note: note({ body: "real", title: "" }) });
    await tick();
    expect(a.draft.version).toBe(1);
    expect(a.status).toBe("saved");
  });

  it("a lost response to a save isn't a conflict", async () => {
    const { io, calls } = server();
    const a = new Autosave(draftOf(note()), io, drafts);
    a.edit({ body: "mine" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    // The server applied it, the answer never arrived, the retry is on the old version.
    calls[0].answer({ kind: "conflict", note: note({ version: 2, body: "mine" }) });
    await tick();
    expect(a.status).toBe("saved");
    expect(a.draft.version).toBe(2);
    expect(stored()).toBeNull();
  });

  it("a pin on another device doesn't interrupt the owner", async () => {
    const { io, calls } = server();
    const a = new Autosave(draftOf(note()), io, drafts);
    a.edit({ body: "mine" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    calls[0].answer({ kind: "conflict", note: note({ version: 2, pinned: true }) });
    await tick();
    expect(calls[1].args).toEqual({ version: 2, body: "mine" });
    expect(a.draft.pinned).toBe(true);
    calls[1].answer({ kind: "ok", note: note({ version: 3, body: "mine", pinned: true }) });
    await tick();
    expect(a.status).toBe("saved");
  });

  it("a real conflict stops saving and keeps both, on the device, until the owner chooses", async () => {
    const { io, calls } = server();
    const seen: string[] = [];
    const a = new Autosave(draftOf(note()), io, drafts, () => seen.push(a.status));
    a.edit({ body: "mine" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    calls[0].answer({ kind: "conflict", note: note({ version: 2, body: "theirs" }) });
    await tick();
    expect(a.status).toBe("conflict");
    expect(stored()?.body).toBe("mine");
    expect(stored()?.other?.body).toBe("theirs");
    // The owner keeps typing; nothing goes out, nothing is lost.
    a.edit({ body: "mine, more" });
    expect(stored()?.body).toBe("mine, more");
    await vi.advanceTimersByTimeAsync(60000);
    await a.flush();
    expect(calls).toHaveLength(1);
    expect(a.status).toBe("conflict");

    // A reload brings the same state back.
    const again = new Autosave(stored()!, io, drafts);
    expect(again.status).toBe("conflict");
    expect(again.draft.other?.body).toBe("theirs");
  });

  it("keep mine: theirs becomes a new note, then the owner's text goes on top", async () => {
    const { io, calls } = server();
    const a = new Autosave(draftOf(note()), io, drafts, undefined, undefined, () => "copy-id");
    a.edit({ body: "mine" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    calls[0].answer({ kind: "conflict", note: note({ version: 2, title: "T", body: "theirs" }) });
    await tick();

    const done = a.keepMine();
    await tick();
    expect(calls[1]).toMatchObject({ kind: "create", args: { id: "copy-id", title: "T (other version)", body: "theirs" } });
    calls[1].answer({ kind: "ok", note: note({ id: "copy-id" }) });
    await tick();
    expect(calls[2].kind).toBe("patch");
    expect(calls[2].args).toMatchObject({ version: 2, body: "mine" });
    expect(calls[2].args.title, "the owner's title too").toBe("t");
    calls[2].answer({ kind: "ok", note: note({ version: 3, title: "t", body: "mine" }) });
    expect(await done).toBe(true);
    expect(a.status).toBe("saved");
    expect(stored()).toBeNull();
  });

  it("keep mine fails safely: if the copy can't be saved nothing changes", async () => {
    const { io, calls } = server();
    const a = new Autosave(draftOf(note()), io, drafts);
    a.edit({ body: "mine" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    calls[0].answer({ kind: "conflict", note: note({ version: 2, body: "theirs" }) });
    await tick();
    const done = a.keepMine();
    await tick();
    calls[1].answer({ kind: "offline" });
    expect(await done).toBe(false);
    expect(a.status).toBe("conflict");
    expect(stored()?.body).toBe("mine");
    expect(stored()?.other?.body).toBe("theirs");
  });

  it("keep theirs: the owner's text becomes a new note and the editor shows theirs", async () => {
    const { io, calls } = server();
    const replaced = vi.fn();
    const a = new Autosave(draftOf(note()), io, drafts, undefined, replaced, () => "copy-id");
    a.edit({ title: "T", body: "mine" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    calls[0].answer({ kind: "conflict", note: note({ version: 2, body: "theirs" }) });
    await tick();
    const done = a.keepTheirs();
    await tick();
    expect(calls[1].args).toMatchObject({ id: "copy-id", title: "T (my version)", body: "mine" });
    calls[1].answer({ kind: "ok", note: note({ id: "copy-id" }) });
    expect(await done).toBe(true);
    expect(a.draft.body).toBe("theirs");
    expect(a.draft.version).toBe(2);
    expect(a.status).toBe("saved");
    expect(replaced).toHaveBeenCalled();
    expect(stored()).toBeNull();
  });

  it("deleted elsewhere: the owner's text survives, and restore brings it back", async () => {
    const { io, calls } = server();
    const a = new Autosave(draftOf(note()), io, drafts);
    a.edit({ body: "mine" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    calls[0].answer({ kind: "conflict", note: note({ version: 2, deleted_at: "2026-01-01" }) });
    await tick();
    expect(a.status).toBe("deleted");
    expect(stored()?.body).toBe("mine");
    const done = a.restoreMine();
    await tick();
    expect(calls[1].kind).toBe("restore");
    calls[1].answer({ kind: "ok", note: note({ version: 3 }) });
    await tick();
    expect(calls[2].args).toEqual({ version: 3, body: "mine" });
    calls[2].answer({ kind: "ok", note: note({ version: 4, body: "mine" }) });
    await done;
    expect(a.status).toBe("saved");
  });

  it("discarding means nothing more goes out", async () => {
    const { io, calls } = server();
    const a = new Autosave(draftOf(note()), io, drafts);
    a.edit({ body: "mine" });
    a.discard();
    await a.flush();
    await vi.advanceTimersByTimeAsync(60000);
    expect(calls).toHaveLength(0);
    expect(stored()).toBeNull();
  });

  it("a note the server lost goes back as new, under the same id", async () => {
    const { io, calls } = server();
    const a = new Autosave(draftOf(note()), io, drafts);
    a.edit({ body: "mine" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    calls[0].answer({ kind: "gone" });
    await tick();
    await tick();
    expect(calls[1]).toMatchObject({ kind: "create", args: { id: "n1", body: "mine" } });
  });

  it("a refused save stays on the device and says why", async () => {
    const { io, calls } = server();
    const a = new Autosave(draftOf(note()), io, drafts);
    a.edit({ body: "too much" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    calls[0].answer({ kind: "rejected", why: "body_too_long" });
    await tick();
    expect(a.status).toBe("rejected");
    expect(a.why).toBe("body_too_long");
    expect(stored()?.body).toBe("too much");
    await vi.advanceTimersByTimeAsync(60000);
    expect(calls, "no pointless retries").toHaveLength(1);
    a.edit({ body: "less" });
    expect(a.status).toBe("pending");
  });

  it("says so when the browser won't store the draft", async () => {
    const { io } = server();
    const full = { ...memory(), setItem() { throw new Error("quota"); } } as DraftStorage;
    const a = new Autosave(draftOf(note()), io, new Drafts(full));
    a.edit({ body: "x" });
    expect(a.stored).toBe(false);
  });

  it("shows newer text when the owner has no edits, and never over the owner's edits", async () => {
    const { io } = server();
    const replaced = vi.fn();
    const a = new Autosave(draftOf(note()), io, drafts, undefined, replaced);
    a.refresh(note({ version: 1, body: "same version" }));
    expect(replaced).not.toHaveBeenCalled();
    a.refresh(note({ version: 2, body: "newer" }));
    expect(a.draft.body).toBe("newer");
    expect(replaced).toHaveBeenCalledTimes(1);
    a.edit({ body: "mine" });
    a.refresh(note({ version: 3, body: "newest" }));
    expect(a.draft.body).toBe("mine");
    expect(replaced).toHaveBeenCalledTimes(1);
    expect(isDirty(a.draft)).toBe(true);
    a.stop();
  });
});

describe("Drafts", () => {
  it("survives junk in storage and lists newest first", () => {
    const m = memory();
    m.setItem(`${NS}.notes.draft.bad`, "{not json");
    m.setItem(`${NS}.other`, "x");
    const d = new Drafts(m);
    d.save({ ...newDraft("a", 1) });
    d.save({ ...newDraft("b", 2) });
    expect(d.all().map((x) => x.id)).toEqual(["b", "a"]);
  });
});

describe("rowText", () => {
  const clean = (s: string) => s.replace(/^#+\s*/, "").trim();
  it("uses the title, or the first line when there is none", () => {
    expect(rowText("Title", "# hello", clean)).toEqual({ title: "Title", preview: "hello" });
    expect(rowText("", "# First\n\nsecond\nthird", clean)).toEqual({ title: "First", preview: "second third" });
    expect(rowText(" ", "", clean)).toEqual({ title: "Untitled", preview: "" });
  });
});
