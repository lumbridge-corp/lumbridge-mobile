// What carries on when the Files screen is gone: the upload queue, which also starts when the app opens on any screen.
import { api, ApiError, token } from "../api";
import { FallbackFiles, FileQueue, IdbFiles, type FileIo } from "../data/files-queue";

export interface FileRow {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  status: "new" | "filed" | "failed";
  description: string | null;
  ocr_text: string | null;
  category: string | null;
  identifiers: { kind: string; value: string; verified?: boolean; label?: string }[];
  sensitive: boolean;
  error: string | null;
  taken_at: string | null;
  gps: { lat: number; lon: number } | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

/** Long enough for 50 MB on a slow phone connection, short enough that a hung request doesn't stop the queue for good. */
const timeoutFor = (bytes: number) => 60000 + bytes / 50;

const io: FileIo<FileRow> = {
  async upload(w, blob) {
    if (!token()) return { retry: true };
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), timeoutFor(w.bytes));
    try {
      const q = new URLSearchParams({ id: w.id, name: w.name });
      const res = await api(`/api/files?${q}`, {
        method: "POST",
        headers: { "Content-Type": blob.type || "application/octet-stream" },
        body: blob,
        signal: stop.signal,
      });
      return { ok: (await res.json()) as FileRow };
    } catch (e) {
      if (e instanceof ApiError && (e.status === 413 || e.status === 422 || e.status === 400)) {
        const body: any = await e.res.json().catch(() => null);
        return { rejected: body?.error ?? `HTTP ${e.status}` };
      }
      return { retry: true };
    } finally {
      clearTimeout(timer);
    }
  },
};

function hasIndexedDb(): boolean {
  try { return !!window.indexedDB; } catch { return false; }
}

export interface FilesListener {
  changed?: () => void;
  uploaded?: (row: FileRow, localId: string) => void;
}
const listeners = new Set<FilesListener>();
export function onFiles(l: FilesListener) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

const store = new FallbackFiles(hasIndexedDb() ? new IdbFiles() : null);
export const fileQueue = new FileQueue<FileRow>(store, io, {
  changed: () => { for (const l of [...listeners]) l.changed?.(); },
  uploaded: (r, id) => { for (const l of [...listeners]) l.uploaded?.(r, id); },
});
export const filesDurable = () => store.durable;
/** The bytes of one still on this device, for its thumbnail. */
export const localBlob = (id: string) => store.blob(id);

/** Anything left from last time goes as soon as the app opens, and whenever it comes back or the network does. */
export function initFiles() {
  const look = () => { if (token() && !document.hidden) fileQueue.kick(); };
  document.addEventListener("visibilitychange", look);
  window.addEventListener("online", look);
  void fileQueue.refresh().catch(() => {});
  look();
}
