import { NS } from "../ns";
// What's on this device and not yet on the server: thoughts, and the audio of each one until its text is saved there. IndexedDB when
// it can be had. When it can't, or a write fails (quota, a lost connection iOS won't give back), memory, and `durable` says so.

export interface Pending {
  id: string;
  source: "voice" | "typed";
  created_at: string;
  duration_ms: number | null;
  /** The recording ended, so every chunk is final. A session that's unfinished with nobody recording it gets finished on reopen. */
  finished: boolean;
  /** A typed thought: this is the whole of it. */
  typed?: string;
  /** Written with each chunk. Only says a session is still alive where the Web Locks API doesn't exist. */
  touched: number;
  /** The server refused to save this, and retrying won't change that until the owner asks. */
  failed?: string | null;
}

export interface ChunkMeta {
  id: string;
  seq: number;
  ms: number;
  /** A checkpoint of a chunk still being recorded. The next write to this seq replaces it. */
  open: boolean;
  /** null: not transcribed yet. "" is an answer: nothing was said. */
  text: string | null;
  failed?: string | null;
}

export interface ThoughtStore {
  sessions(): Promise<Pending[]>;
  session(id: string): Promise<Pending | null>;
  chunks(id: string): Promise<ChunkMeta[]>;
  audio(id: string, seq: number): Promise<ArrayBuffer | null>;
  putSession(s: Pending): Promise<void>;
  /** `wav` null: no audio to keep for this chunk. */
  putChunk(c: ChunkMeta, wav: ArrayBuffer | null): Promise<void>;
  /** Text or a failure for a chunk that's there. Does nothing if it was discarded meanwhile. */
  updateChunk(c: ChunkMeta): Promise<void>;
  /** The session, its chunks and its audio, all at once. */
  remove(id: string): Promise<void>;
}

const bySeq = (a: ChunkMeta, b: ChunkMeta) => a.seq - b.seq;

export class MemoryStore implements ThoughtStore {
  private all = new Map<string, Pending>();
  private meta = new Map<string, Map<number, ChunkMeta>>();
  private wavs = new Map<string, Map<number, ArrayBuffer>>();

  get empty() { return this.all.size === 0 && this.meta.size === 0; }
  async sessions() { return [...this.all.values()].map((s) => ({ ...s })); }
  async session(id: string) { const s = this.all.get(id); return s ? { ...s } : null; }
  async chunks(id: string) { return [...(this.meta.get(id)?.values() ?? [])].map((c) => ({ ...c })).sort(bySeq); }
  async audio(id: string, seq: number) { return this.wavs.get(id)?.get(seq) ?? null; }
  async putSession(s: Pending) { this.all.set(s.id, { ...s }); }
  async putChunk(c: ChunkMeta, wav: ArrayBuffer | null) {
    if (!this.meta.has(c.id)) this.meta.set(c.id, new Map());
    this.meta.get(c.id)!.set(c.seq, { ...c });
    if (!this.wavs.has(c.id)) this.wavs.set(c.id, new Map());
    if (wav) this.wavs.get(c.id)!.set(c.seq, wav); else this.wavs.get(c.id)!.delete(c.seq);
  }
  async updateChunk(c: ChunkMeta) { if (this.meta.get(c.id)?.has(c.seq)) this.meta.get(c.id)!.set(c.seq, { ...c }); }
  async remove(id: string) { this.all.delete(id); this.meta.delete(id); this.wavs.delete(id); }
  /** The durable store took this after all. */
  forgetSession(id: string) { this.all.delete(id); }
  forgetChunk(id: string, seq: number) {
    this.wavs.get(id)?.delete(seq);
    this.meta.get(id)?.delete(seq);
    if (!this.meta.get(id)?.size) { this.meta.delete(id); this.wavs.delete(id); }
  }
}

// ---- IndexedDB ----------------------------------------------------------------------------------------------------

const NAME = `${NS}-thoughts`;
/** iOS can leave an IndexedDB call unanswered for ever. Nothing here may wait on one for longer than this. */
const TIMEOUT_MS = 5000;

const done = <T>(r: IDBRequest<T>) => new Promise<T>((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const committed = (tx: IDBTransaction) => new Promise<void>((ok, no) => { tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); tx.onabort = () => no(tx.error); });
const within = <T>(p: Promise<T>) => new Promise<T>((ok, no) => {
  const t = setTimeout(() => no(new Error("IndexedDB didn't answer")), TIMEOUT_MS);
  p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); no(e); });
});
/** Every key of a session: [id] sorts before [id, 0], and [id, []] after any number. */
const ofSession = (id: string) => IDBKeyRange.bound([id], [id, []]);

export class IdbStore implements ThoughtStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((ok, no) => {
      const r = indexedDB.open(NAME, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("sessions", { keyPath: "id" });
        r.result.createObjectStore("chunks", { keyPath: ["id", "seq"] });
        r.result.createObjectStore("audio"); // out of line, so listing chunks doesn't read every recording into memory
      };
      r.onsuccess = () => {
        const db = r.result;
        const forget = () => { this.db = null; };
        db.onclose = forget;
        db.onversionchange = () => { db.close(); forget(); };
        ok(db);
      };
      r.onerror = () => no(r.error);
      r.onblocked = () => no(new Error("blocked"));
    });
    return this.db;
  }

  /** iOS drops the connection in the background, and the next call throws. One fresh try before calling it a failure. */
  private async use<T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> {
    try {
      return await within(this.open().then(run));
    } catch {
      this.db = null;
      return await within(this.open().then(run));
    }
  }

  private read<T>(store: string, run: (s: IDBObjectStore) => IDBRequest<T>) {
    return this.use((db) => done(run(db.transaction(store).objectStore(store))));
  }

  sessions() { return this.read<Pending[]>("sessions", (s) => s.getAll()); }
  async session(id: string) { return (await this.read<Pending | undefined>("sessions", (s) => s.get(id))) ?? null; }
  async chunks(id: string) { return (await this.read<ChunkMeta[]>("chunks", (s) => s.getAll(ofSession(id)))).sort(bySeq); }
  async audio(id: string, seq: number) { return (await this.read<ArrayBuffer | undefined>("audio", (s) => s.get([id, seq]))) ?? null; }

  putSession(p: Pending) {
    return this.use((db) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put(p);
      return committed(tx);
    });
  }

  /** One transaction, so a chunk is never listed without its audio. */
  putChunk(c: ChunkMeta, wav: ArrayBuffer | null) {
    return this.use((db) => {
      const tx = db.transaction(["chunks", "audio"], "readwrite");
      tx.objectStore("chunks").put(c);
      if (wav) tx.objectStore("audio").put(wav, [c.id, c.seq]); else tx.objectStore("audio").delete([c.id, c.seq]);
      return committed(tx);
    });
  }

  updateChunk(c: ChunkMeta) {
    return this.use((db) => {
      const tx = db.transaction("chunks", "readwrite");
      const store = tx.objectStore("chunks");
      const seen = store.getKey([c.id, c.seq]);
      seen.onsuccess = () => { if (seen.result !== undefined) store.put(c); };
      return committed(tx);
    });
  }

  remove(id: string) {
    return this.use((db) => {
      const tx = db.transaction(["sessions", "chunks", "audio"], "readwrite");
      tx.objectStore("sessions").delete(id);
      tx.objectStore("chunks").delete(ofSession(id));
      tx.objectStore("audio").delete(ofSession(id));
      return committed(tx);
    });
  }
}

// ---- Falling back to memory -----------------------------------------------------------------------------------------

/**
 * Tries the durable store and never lets a failed write lose anything: what it refuses is held in memory instead, and reads see both.
 * `durable` is false for as long as anything is only in memory, which is what the screen tells the owner.
 *
 * A read that fails throws, unless the session lives in memory. Taking "couldn't read" for "no chunks" would finish a thought
 * with audio still on disk, and then delete it.
 */
export class FallbackStore implements ThoughtStore {
  private memory = new MemoryStore();

  constructor(private main: ThoughtStore | null) {}

  get durable() { return this.main !== null && this.memory.empty; }

  async sessions() {
    const all = new Map<string, Pending>();
    try { for (const s of (await this.main?.sessions()) ?? []) all.set(s.id, s); } catch { /* what's in memory can still go */ }
    for (const s of await this.memory.sessions()) all.set(s.id, s);
    return [...all.values()];
  }

  async session(id: string) {
    return (await this.memory.session(id)) ?? (await this.main?.session(id)) ?? null;
  }

  async chunks(id: string) {
    const all = new Map<number, ChunkMeta>();
    try {
      for (const c of (await this.main?.chunks(id)) ?? []) all.set(c.seq, c);
    } catch (e) {
      if (!(await this.memory.session(id))) throw e;
    }
    for (const c of await this.memory.chunks(id)) all.set(c.seq, c);
    return [...all.values()].sort(bySeq);
  }

  async audio(id: string, seq: number) {
    return (await this.memory.audio(id, seq)) ?? (await this.main?.audio(id, seq)) ?? null;
  }

  async putSession(s: Pending) {
    if (this.main) {
      try { await this.main.putSession(s); this.memory.forgetSession(s.id); return; } catch { /* below */ }
    }
    await this.memory.putSession(s);
  }

  async putChunk(c: ChunkMeta, wav: ArrayBuffer | null) {
    if (this.main) {
      try { await this.main.putChunk(c, wav); this.memory.forgetChunk(c.id, c.seq); return; } catch { /* below */ }
    }
    await this.memory.putChunk(c, wav);
  }

  async updateChunk(c: ChunkMeta) {
    await this.memory.updateChunk(c);
    try { await this.main?.updateChunk(c); } catch { /* transcribed again next time; the audio is still there */ }
  }

  /** Throws if the durable copy couldn't be removed, so a discarded recording doesn't quietly stay on the device. */
  async remove(id: string) {
    await this.memory.remove(id);
    await this.main?.remove(id);
  }
}
