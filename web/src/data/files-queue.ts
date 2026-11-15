// Getting photos and files from this device to the server without ever losing one. Each is written to IndexedDB (`<prefix>-files`) the moment
// the owner picks or takes it, with an id chosen here, and only the server's answer to its upload removes it. Uploads go one at a time, oldest
// first, and anything short of a refusal only means waiting: 5 s out to every 5 minutes, and at once on reopening or the network
// coming back. The id makes a retry after a lost answer harmless, and the server also answers the same bytes with the row it has.
import { retryDelayMs } from "./thoughts-logic";
import { NS } from "../ns";

/** The gateway's limit (gateway/src/data/files.rs MAX_BYTES). */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface Waiting {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  added_at: string;
  /** The server refused it, and sending it again won't change that until the owner asks. */
  failed?: string | null;
}

export interface FileStore {
  all(): Promise<Waiting[]>;
  blob(id: string): Promise<Blob | null>;
  /** The item and its bytes in one go, so one is never kept without the other. */
  put(w: Waiting, blob: Blob): Promise<void>;
  update(w: Waiting): Promise<void>;
  remove(id: string): Promise<void>;
}

export class MemoryFiles implements FileStore {
  private items = new Map<string, Waiting>();
  private blobs = new Map<string, Blob>();
  get empty() { return this.items.size === 0; }
  async all() { return [...this.items.values()].map((w) => ({ ...w })); }
  async blob(id: string) { return this.blobs.get(id) ?? null; }
  async put(w: Waiting, blob: Blob) { this.items.set(w.id, { ...w }); this.blobs.set(w.id, blob); }
  async update(w: Waiting) { if (this.items.has(w.id)) this.items.set(w.id, { ...w }); }
  async remove(id: string) { this.items.delete(id); this.blobs.delete(id); }
  has(id: string) { return this.items.has(id); }
}

// ---- IndexedDB ----------------------------------------------------------------------------------------------------

const NAME = `${NS}-files`;
/** iOS can leave an IndexedDB call unanswered for ever. Writing a big photo takes a while, so this is longer than Thoughts'. */
const TIMEOUT_MS = 20000;

const done = <T>(r: IDBRequest<T>) => new Promise<T>((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const committed = (tx: IDBTransaction) => new Promise<void>((ok, no) => { tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); tx.onabort = () => no(tx.error); });
const within = <T>(p: Promise<T>) => new Promise<T>((ok, no) => {
  const t = setTimeout(() => no(new Error("IndexedDB didn't answer")), TIMEOUT_MS);
  p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); no(e); });
});

export class IdbFiles implements FileStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((ok, no) => {
      const r = indexedDB.open(NAME, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("items", { keyPath: "id" });
        r.result.createObjectStore("blobs"); // apart, so listing what's waiting doesn't read every photo
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

  private async use<T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> {
    try {
      return await within(this.open().then(run));
    } catch {
      this.db = null;
      return await within(this.open().then(run));
    }
  }

  all() { return this.use((db) => done<Waiting[]>(db.transaction("items").objectStore("items").getAll())); }
  async blob(id: string) { return (await this.use((db) => done<Blob | undefined>(db.transaction("blobs").objectStore("blobs").get(id)))) ?? null; }

  put(w: Waiting, blob: Blob) {
    return this.use((db) => {
      const tx = db.transaction(["items", "blobs"], "readwrite");
      tx.objectStore("blobs").put(blob, w.id);
      tx.objectStore("items").put(w);
      return committed(tx);
    });
  }

  update(w: Waiting) {
    return this.use((db) => {
      const tx = db.transaction("items", "readwrite");
      const s = tx.objectStore("items");
      const seen = s.getKey(w.id);
      seen.onsuccess = () => { if (seen.result !== undefined) s.put(w); };
      return committed(tx);
    });
  }

  remove(id: string) {
    return this.use((db) => {
      const tx = db.transaction(["items", "blobs"], "readwrite");
      tx.objectStore("items").delete(id);
      tx.objectStore("blobs").delete(id);
      return committed(tx);
    });
  }
}

/**
 * The durable store when it works, and memory for whatever it refuses, so a failed write never loses a photo. `durable` is false while
 * anything is only in memory, and the screen says so. A failed read of the durable store isn't taken for "nothing waiting".
 */
export class FallbackFiles implements FileStore {
  private memory = new MemoryFiles();
  constructor(private main: FileStore | null) {}
  get durable() { return this.main !== null && this.memory.empty; }

  async all() {
    const all = new Map<string, Waiting>();
    for (const w of (await this.main?.all()) ?? []) all.set(w.id, w);
    for (const w of await this.memory.all()) all.set(w.id, w);
    return [...all.values()];
  }
  async blob(id: string) { return (await this.memory.blob(id)) ?? (await this.main?.blob(id)) ?? null; }
  async put(w: Waiting, blob: Blob) {
    if (this.main) {
      try { await this.main.put(w, blob); return; } catch { /* below */ }
    }
    await this.memory.put(w, blob);
  }
  async update(w: Waiting) {
    if (this.memory.has(w.id)) await this.memory.update(w);
    else await this.main?.update(w);
  }
  async remove(id: string) {
    await this.memory.remove(id);
    await this.main?.remove(id);
  }
}

// ---- The queue ----------------------------------------------------------------------------------------------------

/** retry: down, or a moment's trouble. rejected: asking again won't help. */
export type UploadAnswer<R> = { ok: R } | { retry: true } | { rejected: string };

export interface FileIo<R> {
  upload(w: Waiting, blob: Blob): Promise<UploadAnswer<R>>;
}

export type WaitingState = "uploading" | "queued" | "waiting" | "failed";
export interface WaitingView extends Waiting { state: WaitingState }

export interface FileEvents<R> {
  changed: () => void;
  uploaded: (row: R, localId: string) => void;
}

export class FileQueue<R> {
  private running = false;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private timed = false;
  private down = false;
  private shownDown = false;
  private current: string | null = null;
  private views: WaitingView[] = [];

  constructor(private store: FileStore, private io: FileIo<R>, private on: FileEvents<R>) {}

  get waiting(): WaitingView[] { return this.views; }

  /** Kept before anything else happens. Throws only if even memory couldn't take it. */
  async add(file: Blob, name: string): Promise<Waiting> {
    const w: Waiting = { id: crypto.randomUUID(), name, mime: file.type, bytes: file.size, added_at: new Date().toISOString(), failed: null };
    if (file.size > MAX_FILE_BYTES) w.failed = "too_large";
    await this.store.put(w, file);
    await this.refresh();
    this.kick();
    return w;
  }

  async retry(id: string) {
    const w = (await this.store.all()).find((x) => x.id === id);
    if (w?.failed && w.failed !== "too_large") await this.store.update({ ...w, failed: null });
    this.kick();
  }

  async discard(id: string) {
    await this.store.remove(id);
    await this.refresh();
  }

  kick() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.running) { this.again = true; return; }
    this.running = true;
    void this.drain();
  }

  private async drain() {
    do {
      this.again = false;
      this.down = false;
      try {
        await this.pass();
      } catch {
        this.down = true;
      }
      if (!this.down) this.attempts = 0;
      else if (this.timed) this.attempts++;
      this.timed = false;
      this.shownDown = this.down;
      await this.refresh().catch(() => {});
    } while (this.again);
    this.running = false;
    if (this.down && !this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.timed = true; this.kick(); }, retryDelayMs(this.attempts));
    }
  }

  private async pass() {
    const all = (await this.store.all()).sort((a, b) => a.added_at.localeCompare(b.added_at) || a.id.localeCompare(b.id));
    for (const w of all) {
      if (w.failed) continue;
      if (this.down) break;
      const blob = await this.store.blob(w.id);
      if (!blob) { await this.store.update({ ...w, failed: "missing" }); continue; }
      this.current = w.id;
      await this.refresh().catch(() => {});
      let answer: UploadAnswer<R>;
      try {
        answer = await this.io.upload(w, blob);
      } finally {
        this.current = null;
      }
      if ("ok" in answer) {
        // The server has it. A failure from here only means the next try is told the same.
        await this.store.remove(w.id);
        this.on.uploaded(answer.ok, w.id);
      } else if ("rejected" in answer) {
        await this.store.update({ ...w, failed: answer.rejected });
      } else {
        this.down = true;
      }
    }
  }

  async refresh() {
    const all = (await this.store.all()).sort((a, b) => b.added_at.localeCompare(a.added_at));
    this.views = all.map((w) => ({
      ...w,
      state: w.failed ? "failed" : w.id === this.current ? "uploading" : this.down || this.shownDown ? "waiting" : "queued",
    }));
    this.on.changed();
  }
}
