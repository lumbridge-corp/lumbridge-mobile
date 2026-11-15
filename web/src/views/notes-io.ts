// Notes' way to the server, shared by Notes and Today's capture. Text stays on the device (Drafts, localStorage) until the server has
// confirmed it, and one saver per note for the whole page's life: it carries on after the note closes, and two can't race.
import { Autosave, Drafts, newDraft, type Draft, type Note, type NoteIo, type Saved } from "../data/notes-sync";
import { jsonInit, request, type Outcome } from "./data-ui";

const memoryStorage = (): Storage => {
  try { return localStorage; } catch { return { length: 0, key: () => null, getItem: () => null, setItem() { throw new Error("no storage"); }, removeItem() {}, clear() {} }; }
};
export const drafts = new Drafts(memoryStorage());

export function saved(res: Outcome<Note>): Saved {
  if (res.ok) return { kind: "ok", note: res.ok };
  if (res.fail === "conflict" && res.current) return { kind: "conflict", note: res.current };
  if (res.fail === "gone") return { kind: "gone" };
  if (res.fail === "rejected") return { kind: "rejected", why: res.why };
  return { kind: "offline" };
}

const io: NoteIo = {
  create: async (n, keepalive) => saved(await request<Note>("/api/notes", jsonInit("POST", n, keepalive))),
  patch: async (id, p, keepalive) => saved(await request<Note>(`/api/notes/${id}`, jsonInit("PATCH", p, keepalive))),
  restore: async (id) => saved(await request<Note>(`/api/notes/${id}/restore`, { method: "POST" })),
};

// One saver per note for the whole page's life: it carries on after the owner closes the note, and two can't race.
export const savers = new Map<string, Autosave>();
export function saverFor(d: Draft): Autosave {
  let s = savers.get(d.id);
  if (!s) { s = new Autosave(d, io, drafts); savers.set(d.id, s); }
  return s;
}

/** Try every note that still has unsent text. Each one's own conflict is kept for when the owner opens it. */
export function flushAll(keepalive = false) {
  for (const d of drafts.all()) void saverFor(d).flush(keepalive);
}

/** A new note from words the owner said or typed elsewhere (Today). Kept first; saved now, or by Notes the next time it opens. */
export async function captureNote(body: string): Promise<Autosave> {
  const s = saverFor(newDraft(crypto.randomUUID()));
  s.edit({ body });
  await s.flush();
  return s;
}
