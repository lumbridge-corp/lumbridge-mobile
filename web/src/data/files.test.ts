import { describe, expect, it } from "vitest";
import { caption, categoryLabel, hasThumb, photoName, sizeText, typeMark } from "./files-logic";
import { FallbackFiles, FileQueue, MemoryFiles, type FileStore, type UploadAnswer, type Waiting } from "./files-queue";

declare function setImmediate(run: () => void): void;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); };
const blob = (s: string) => new Blob([s], { type: "image/jpeg" });

describe("files logic", () => {
  it("asks for a thumbnail only when the server has one", () => {
    expect(hasThumb({ mime: "image/jpeg", status: "new" })).toBe(true);
    expect(hasThumb({ mime: "image/heic", status: "new" })).toBe(false);
    expect(hasThumb({ mime: "image/heic", status: "filed" })).toBe(true);
    expect(hasThumb({ mime: "application/pdf", status: "new" })).toBe(false);
    expect(hasThumb({ mime: "application/pdf", status: "filed" })).toBe(true);
    expect(hasThumb({ mime: "text/plain", status: "filed" })).toBe(false);
    expect(hasThumb({ mime: "application/octet-stream", status: "failed" })).toBe(false);
  });

  it("a tile with no picture shows its extension", () => {
    expect(typeMark("notes.txt", "text/plain")).toBe("TXT");
    expect(typeMark("lease", "application/pdf")).toBe("PDF");
    expect(typeMark("README", "application/octet-stream")).toBe("FILE");
    expect(typeMark("a.verylongext", "application/octet-stream")).toBe("FILE");
  });

  it("a private file shows only its category", () => {
    expect(caption({ name: "dl.jpg", description: "A driver's licence for Sam", status: "filed", sensitive: true, category: "document" })).toBe("Private document");
    expect(caption({ name: "a.jpg", description: "The VIN label", status: "filed", sensitive: false, category: "vehicle" })).toBe("The VIN label");
    expect(caption({ name: "a.jpg", description: null, status: "new", sensitive: false, category: null })).toBe("a.jpg");
    expect(categoryLabel("vehicle", true)).toBe("Vehicles");
    expect(categoryLabel("nonsense")).toBe("Not filed yet");
  });
  it("names and sizes", () => {
    expect(photoName(new Date(2026, 10, 4, 9, 5), 2, "image/jpeg")).toBe("Photo 2026-11-04 09.05 (2).jpg");
    expect(sizeText(900)).toBe("900 B");
    expect(sizeText(3.4 * 1024 * 1024)).toBe("3.4 MB");
  });
});

describe("the upload queue", () => {
  it("keeps a file until the server answers, and sends it once", async () => {
    const store = new MemoryFiles();
    let up = false;
    const sent: string[] = [];
    const q = new FileQueue<string>(store, { upload: async (w): Promise<UploadAnswer<string>> => { sent.push(w.id); return up ? { ok: w.id } : { retry: true }; } }, { changed: () => {}, uploaded: () => {} });
    const w = await q.add(blob("a"), "a.jpg");
    await settle();
    expect(await store.all()).toHaveLength(1);
    expect(q.waiting[0]!.state).toBe("waiting");
    up = true;
    q.kick();
    await settle();
    expect(await store.all()).toHaveLength(0);
    expect(sent.filter((id) => id === w.id).length).toBe(2); // the same id both times, so the server makes one
  });
  it("a refusal waits for the owner; too big is never sent", async () => {
    const store = new MemoryFiles();
    const sent: string[] = [];
    const q = new FileQueue<string>(store, { upload: async (w) => { sent.push(w.name); return { rejected: "empty_file" }; } }, { changed: () => {}, uploaded: () => {} });
    await q.add(blob("x"), "x.jpg");
    await q.add({ size: 60 * 1024 * 1024, type: "image/jpeg" } as Blob, "huge.jpg");
    await settle();
    expect(sent).toEqual(["x.jpg"]);
    expect(q.waiting.map((v) => v.state)).toEqual(["failed", "failed"]);
  });
  it("a store that refuses a write still keeps it, in memory", async () => {
    const broken: FileStore = { all: async () => [], blob: async () => null, put: async () => { throw new Error("quota"); }, update: async () => {}, remove: async () => {} };
    const store = new FallbackFiles(broken);
    const w: Waiting = { id: "1", name: "a", mime: "image/jpeg", bytes: 1, added_at: "2026-11-04T00:00:00Z" };
    await store.put(w, blob("a"));
    expect((await store.all()).map((x) => x.id)).toEqual(["1"]);
    expect(store.durable).toBe(false);
  });
});
