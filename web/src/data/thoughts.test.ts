import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { clock, CUTS, CutPlanner, groupByDay, joinChunks, MAX_REQUEST_BYTES, PcmBuffer, retryDelayMs } from "./thoughts-logic";
import { ThoughtQueue, type Answer, type NewThought } from "./thoughts-queue";
import { FallbackStore, MemoryStore, type ChunkMeta, type Pending, type ThoughtStore } from "./thoughts-store";
import { encodeWav, resample } from "../views/assistant-logic";

declare function setImmediate(run: () => void): void;

const FRAME = 2048 / 48; // the worklet's frame at 48 kHz, in ms
const LOUD = 0.1, QUIET = 0.001;

/** Feeds levels by the ms and gives back where each cut fell, on the recording's own clock. */
function cutsFor(levelAt: (ms: number) => number, totalMs: number) {
  const p = new CutPlanner();
  const cuts: number[] = [];
  let last = 0;
  for (let t = 0; t < totalMs; t += FRAME) {
    const level = levelAt(t);
    const c = p.push(level, FRAME, level * 2);
    if (c) { last += c.atMs; cuts.push(last); }
  }
  return cuts;
}

describe("splitting a long recording", () => {
  it("never lets a chunk reach the limit, however long the owner goes on without a breath", () => {
    const cuts = cutsFor(() => LOUD, 10 * 60_000);
    const sizes = cuts.map((c, i) => c - (cuts[i - 1] ?? 0));
    expect(cuts.length).toBeGreaterThanOrEqual(10);
    for (const s of sizes) expect(s).toBeLessThanOrEqual(CUTS.hardMs);
  });

  it("the longest chunk, encoded the way it's sent, fits the gateway's limit", () => {
    const wav = encodeWav(resample(new Float32Array((CUTS.hardMs / 1000) * 48000), 48000, 16000), 16000);
    expect(wav.byteLength).toBeLessThan(MAX_REQUEST_BYTES);
    const fast = encodeWav(resample(new Float32Array((CUTS.hardMs / 1000) * 96000), 96000, 16000), 16000);
    expect(fast.byteLength).toBeLessThan(MAX_REQUEST_BYTES);
  });

  it("ends a chunk at the first pause past the soft limit, in the middle of the pause", () => {
    const pause = (t: number) => t >= 25_000 && t < 26_000;
    const [first] = cutsFor((t) => (pause(t) ? QUIET : LOUD), 40_000);
    expect(first).toBeGreaterThan(25_000);
    expect(first).toBeLessThan(26_000);
  });

  it("doesn't cut before the soft limit, and doesn't take a short breath for a pause", () => {
    const pauses = (t: number) => (t >= 8000 && t < 9000) || (t >= 30_000 && t < 30_200);
    const cuts = cutsFor((t) => (pauses(t) ? QUIET : LOUD), 50_000);
    expect(cuts).toEqual([]);
  });

  it("with no pause, a hard cut falls at the quietest moment in reach", () => {
    const dip = (t: number) => t >= 48_000 && t < 48_300;
    const [first] = cutsFor((t) => (dip(t) ? 0.03 : LOUD), CUTS.hardMs + 2000);
    expect(first).toBeGreaterThan(47_800);
    expect(first).toBeLessThan(48_500);
  });

  it("keeps time: what's past a cut counts towards the next chunk", () => {
    const p = new CutPlanner({ softMs: 1000, gapMs: 200, hardMs: 5000, lookbackMs: 1000 });
    let total = 0, sum = 0;
    for (let t = 0; t < 30_000; t += FRAME) {
      const c = p.push(Math.floor(t / 1500) % 2 ? QUIET : LOUD, FRAME, 0.1);
      total += FRAME;
      if (c) sum += c.atMs;
    }
    expect(sum).toBeGreaterThan(20_000);
    expect(sum).toBeLessThanOrEqual(total);
  });

  it("reports the loudest moment in a chunk, so a dead-quiet one isn't sent to be hallucinated over", () => {
    const p = new CutPlanner({ softMs: 1000, gapMs: 200, hardMs: 5000, lookbackMs: 1000 });
    let cut = null;
    for (let t = 0; t < 2000 && !cut; t += FRAME) cut = p.push(0.0001, FRAME, 0.0002);
    expect(cut?.peak).toBe(0.0002);
  });

  it("every sample goes out exactly once, in order", () => {
    const b = new PcmBuffer();
    let n = 0;
    const out: number[] = [];
    for (let i = 0; i < 50; i++) {
      b.add(Float32Array.from({ length: 7 }, () => n++));
      if (i % 11 === 10) out.push(...b.take(Math.floor(b.length / 2)));
    }
    expect(b.peek().length).toBe(b.length); // a checkpoint looks without taking
    out.push(...b.take(b.length));
    expect(out).toEqual(Array.from({ length: 350 }, (_, i) => i));
    expect(b.length).toBe(0);
  });

  it("joins text in order, skipping chunks with nothing said", () => {
    expect(joinChunks([" one ", "", null, "two"])).toBe("one two");
  });
});

describe("how the list reads", () => {
  it("elapsed time", () => {
    expect(clock(7900)).toBe("0:07");
    expect(clock(750_000)).toBe("12:30");
    expect(clock(3_723_000)).toBe("1:02:03");
  });
  it("groups newest first by local day", () => {
    const now = new Date(2026, 10, 4, 12);
    const at = (d: number, h: number) => ({ created_at: new Date(2026, 10, d, h).toISOString(), n: `${d}/${h}` });
    const days = groupByDay([at(3, 9), at(4, 8), at(1, 23), at(4, 11), at(1, 0)], now);
    expect(days.map((d) => d.label)).toEqual(["Today", "Yesterday", "Sun, Nov 1"]);
    expect(days[0]!.items.map((i) => i.n)).toEqual(["4/11", "4/8"]);
    expect(days[2]!.items.map((i) => i.n)).toEqual(["1/23", "1/0"]);
  });
  it("names the year only when it isn't this one", () => {
    const [day] = groupByDay([{ created_at: new Date(2025, 11, 31, 12).toISOString() }], new Date(2026, 10, 4));
    expect(day!.label).toBe("Wed, Dec 31, 2025");
  });
  it("backs off, and doesn't stop", () => {
    expect(retryDelayMs(0)).toBe(5000);
    expect(retryDelayMs(99)).toBe(300_000);
  });
});

// ---- The queue -----------------------------------------------------------------------------------------------------

const WAV = (n: number) => new Uint8Array([n]).buffer;
const session = (id: string, over: Partial<Pending> = {}): Pending =>
  ({ id, source: "voice", created_at: "2026-11-04T10:00:00.000Z", duration_ms: null, finished: false, touched: 0, ...over });

/** The speech service and the server, each of which can be down, and the record of everything asked of them. */
function world(store: ThoughtStore = new MemoryStore()) {
  const w = {
    store,
    speech: "up" as "up" | "down" | "refuses",
    server: "up" as "up" | "down" | "refuses" | "loses-answer",
    heard: [] as number[],
    posted: [] as NewThought[],
    rows: new Map<string, NewThought>(),
    saved: [] as string[],
    nothing: [] as string[],
    elsewhere: false,
    queue: null as unknown as ThoughtQueue<string>,
    settle: async () => { for (let i = 0; i < 40; i++) await new Promise<void>((r) => setImmediate(r)); },
  };
  w.queue = new ThoughtQueue<string>(store, {
    transcribe: async (wav): Promise<Answer<string>> => {
      if (w.speech === "down") return { retry: true };
      if (w.speech === "refuses") return { rejected: "too_big" };
      const n = new Uint8Array(wav)[0]!;
      w.heard.push(n);
      return { ok: n === 0 ? "  " : `part${n}` };
    },
    save: async (t): Promise<Answer<string>> => {
      w.posted.push(t);
      if (w.server === "down") return { retry: true };
      if (w.server === "refuses") return { rejected: "body_too_long" };
      if (!w.rows.has(t.id)) w.rows.set(t.id, t); // as the gateway does: the id decides
      if (w.server === "loses-answer") { w.server = "up"; return { retry: true }; }
      return { ok: t.id };
    },
    recordingElsewhere: async () => w.elsewhere,
  }, {
    changed: () => {},
    saved: (id) => w.saved.push(id),
    nothingSaid: (id) => w.nothing.push(id),
  });
  return w;
}

async function record(w: ReturnType<typeof world>, id: string, parts: number[], finish = true) {
  const s = session(id);
  await w.queue.begin(s);
  for (const [seq, n] of parts.entries()) await w.queue.addChunk(s, seq, 1000, WAV(n), false, true);
  if (finish) await w.queue.finish(s, parts.length * 1000);
  await w.settle();
}

describe("never losing a thought", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("transcribes in order, joins into one thought, and clears the audio once it's saved", async () => {
    const w = world();
    await record(w, "a", [1, 2, 3]);
    expect(w.heard).toEqual([1, 2, 3]);
    expect(w.rows.get("a")).toMatchObject({ body: "part1 part2 part3", source: "voice", duration_ms: 3000, created_at: "2026-11-04T10:00:00.000Z" });
    expect(await w.store.audio("a", 0)).toBeNull();
    expect(await w.store.sessions()).toEqual([]);
    expect(w.saved).toEqual(["a"]);
  });

  it("shows text as it arrives, and doesn't save until the recording has ended", async () => {
    const w = world();
    await record(w, "a", [1, 2], false);
    expect(w.queue.pending[0]).toMatchObject({ text: "part1 part2", state: "recording" });
    expect(w.posted).toEqual([]);
    expect(await w.store.audio("a", 0)).not.toBeNull();
  });

  it("leaves a chunk still being recorded alone, and a checkpoint of it is replaced by the real thing", async () => {
    const w = world();
    const s = session("a");
    await w.queue.begin(s);
    await w.queue.addChunk(s, 0, 10_000, WAV(9), true, true);
    w.queue.kick();
    await w.settle();
    expect(w.heard).toEqual([]);
    await w.queue.addChunk(s, 0, 20_000, WAV(1), false, true);
    await w.queue.finish(s, 20_000);
    await w.settle();
    expect(w.heard).toEqual([1]);
    expect(w.rows.get("a")?.body).toBe("part1");
  });

  it("speech down: holds the audio, says it's waiting, and carries on from where it was when speech returns", async () => {
    const w = world();
    w.speech = "down";
    await record(w, "a", [1, 2]);
    expect(w.posted).toEqual([]);
    expect(await w.store.audio("a", 0)).not.toBeNull();
    expect(await w.store.audio("a", 1)).not.toBeNull();
    expect(w.queue.pending[0]).toMatchObject({ state: "waiting_speech", untranscribed: 2 });

    w.speech = "up";
    await vi.advanceTimersByTimeAsync(retryDelayMs(0) + 1);
    await w.settle();
    expect(w.heard).toEqual([1, 2]);
    expect(w.rows.get("a")?.body).toBe("part1 part2");
    expect(await w.store.sessions()).toEqual([]);
  });

  it("speech dying part way keeps the text it got, and doesn't ask for it twice", async () => {
    const w = world();
    const s = session("a");
    await w.queue.begin(s);
    await w.queue.addChunk(s, 0, 1000, WAV(1), false, true);
    await w.settle();
    w.speech = "down";
    await w.queue.addChunk(s, 1, 1000, WAV(2), false, true);
    await w.queue.finish(s, 2000);
    await w.settle();
    expect(w.queue.pending[0]).toMatchObject({ text: "part1", untranscribed: 1 });
    w.speech = "up";
    w.queue.kick();
    await w.settle();
    expect(w.heard).toEqual([1, 2]);
    expect(w.rows.get("a")?.body).toBe("part1 part2");
  });

  it("server down: keeps text and audio until a save is answered, and transcribes nothing again", async () => {
    const w = world();
    w.server = "down";
    await record(w, "a", [1]);
    expect(await w.store.audio("a", 0)).not.toBeNull();
    expect(w.queue.pending[0]).toMatchObject({ state: "waiting_save", text: "part1" });
    w.server = "up";
    w.queue.kick();
    await w.settle();
    expect(w.heard).toEqual([1]);
    expect(await w.store.audio("a", 0)).toBeNull();
  });

  it("a retried save after a lost answer makes one thought, with the same id", async () => {
    const w = world();
    w.server = "loses-answer";
    await record(w, "a", [1]);
    expect(w.rows.size).toBe(1);
    expect(await w.store.audio("a", 0)).not.toBeNull(); // no answer, so the audio stays
    w.queue.kick();
    await w.settle();
    expect(w.posted.map((t) => t.id)).toEqual(["a", "a"]);
    expect(w.rows.size).toBe(1);
    expect(await w.store.sessions()).toEqual([]);
  });

  it("reopening: a new queue on the same store picks up everything, even a recording that was cut off", async () => {
    const store = new MemoryStore();
    const before = world(store);
    before.speech = "down";
    await record(before, "finished", [1]);
    await record(before, "cut-off", [2, 3], false);
    const s = session("cut-off");
    await before.queue.addChunk(s, 2, 1000, WAV(4), true, true); // the last checkpoint before the crash

    const after = world(store);
    after.queue.kick();
    await after.settle();
    expect(after.rows.get("finished")?.body).toBe("part1");
    expect(after.rows.get("cut-off")).toMatchObject({ body: "part2 part3 part4", duration_ms: 3000 });
    expect(await store.sessions()).toEqual([]);
  });

  it("leaves alone a recording another tab is still making", async () => {
    const store = new MemoryStore();
    const tab = world(store);
    await record(tab, "a", [1], false);
    const other = world(store);
    other.elsewhere = true;
    other.queue.kick();
    await other.settle();
    expect(other.posted).toEqual([]);
    expect((await store.session("a"))?.finished).toBe(false);
  });

  it("a recording with nothing said is cleared, and says so", async () => {
    const w = world();
    await record(w, "a", [0, 0]);
    expect(w.posted).toEqual([]);
    expect(w.nothing).toEqual(["a"]);
    expect(await w.store.sessions()).toEqual([]);
  });

  it("an inaudible chunk isn't sent and leaves no audio behind", async () => {
    const w = world();
    const s = session("a");
    await w.queue.begin(s);
    await w.queue.addChunk(s, 0, 1000, WAV(7), false, false);
    await w.queue.addChunk(s, 1, 1000, WAV(1), false, true);
    expect(await w.store.audio("a", 0)).toBeNull();
    await w.queue.finish(s, 2000);
    await w.settle();
    expect(w.heard).toEqual([1]);
    expect(w.rows.get("a")?.body).toBe("part1");
  });

  it("what the server refuses stays on the device until the owner decides", async () => {
    const w = world();
    w.server = "refuses";
    await record(w, "a", [1]);
    expect(w.queue.pending[0]!.state).toBe("failed");
    await vi.advanceTimersByTimeAsync(600_000);
    await w.settle();
    expect(w.posted.length).toBe(1); // no pointless retries
    expect(await w.store.audio("a", 0)).not.toBeNull();
    w.server = "up";
    await w.queue.retry("a");
    await w.settle();
    expect(w.rows.size).toBe(1);
  });

  it("a chunk speech refuses holds its own thought and nobody else's", async () => {
    const w = world();
    w.speech = "refuses";
    await record(w, "a", [1]);
    expect(w.queue.pending[0]!.state).toBe("failed");
    w.speech = "up";
    await record(w, "b", [2]);
    expect(w.rows.get("b")?.body).toBe("part2");
    await w.queue.retry("a");
    await w.settle();
    expect(w.rows.get("a")?.body).toBe("part1");
  });

  it("one chunk that keeps failing doesn't hold up the thoughts behind it", async () => {
    const w = world();
    const io = (w.queue as unknown as { io: { transcribe: (b: ArrayBuffer) => Promise<Answer<string>> } }).io;
    const real = io.transcribe;
    io.transcribe = async (b) => (new Uint8Array(b)[0] === 66 ? { retry: true } : real(b));
    await record(w, "poison", [66]);
    await record(w, "fine", [1]);
    await vi.advanceTimersByTimeAsync(retryDelayMs(5) + 1);
    await w.settle();
    expect(w.rows.get("fine")?.body).toBe("part1");
    expect(await w.store.audio("poison", 0)).not.toBeNull();
  });

  it("a typed thought waits the same way, even with speech down", async () => {
    const w = world();
    w.speech = "down";
    await record(w, "voice", [1]);
    w.server = "down";
    await w.queue.addTyped("typed", "by hand", "2026-11-04T11:00:00.000Z");
    await w.settle();
    expect(w.queue.pending.find((p) => p.id === "typed")).toMatchObject({ state: "waiting_save", text: "by hand" });
    w.server = "up";
    w.queue.kick();
    await w.settle();
    expect(w.rows.get("typed")).toMatchObject({ body: "by hand", source: "typed", duration_ms: null });
    expect(w.rows.has("voice")).toBe(false);
  });

  it("discarding while speech is out doesn't bring it back", async () => {
    const w = world();
    const io = (w.queue as unknown as { io: { transcribe: (b: ArrayBuffer) => Promise<Answer<string>> } }).io;
    let answer!: (a: Answer<string>) => void;
    io.transcribe = () => new Promise((r) => { answer = r; });
    await record(w, "a", [1]);
    await w.queue.discard("a");
    answer({ ok: "too late" });
    await w.settle();
    expect(w.posted).toEqual([]);
    expect(w.nothing).toEqual([]);
    expect(await w.store.sessions()).toEqual([]);
  });
});

// ---- The store falling back -------------------------------------------------------------------------------------------

/** A durable store that can be made to fail, to stand in for IndexedDB (which the browser suite tests for real). */
class Flaky extends MemoryStore {
  writes = true;
  reads = true;
  private guard<T>(ok: boolean, run: () => Promise<T>) { return ok ? run() : Promise.reject(new Error("no")); }
  override putSession(s: Pending) { return this.guard(this.writes, () => super.putSession(s)); }
  override putChunk(c: ChunkMeta, w: ArrayBuffer | null) { return this.guard(this.writes, () => super.putChunk(c, w)); }
  override chunks(id: string) { return this.guard(this.reads, () => super.chunks(id)); }
  override sessions() { return this.guard(this.reads, () => super.sessions()); }
  override session(id: string) { return this.guard(this.reads, () => super.session(id)); }
  override audio(id: string, seq: number) { return this.guard(this.reads, () => super.audio(id, seq)); }
}

describe("with no durable storage", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("no IndexedDB at all: it all works from memory, and says it isn't durable", async () => {
    const store = new FallbackStore(null);
    const w = world(store);
    w.speech = "down";
    await record(w, "a", [1]);
    expect(store.durable).toBe(false);
    w.speech = "up";
    w.queue.kick();
    await w.settle();
    expect(w.rows.get("a")?.body).toBe("part1");
  });

  it("writes failing part way hold the chunk in memory, and it still gets through in order", async () => {
    const main = new Flaky();
    const store = new FallbackStore(main);
    const w = world(store);
    w.speech = "down";
    const s = session("a");
    await w.queue.begin(s);
    await w.queue.addChunk(s, 0, 1000, WAV(1), false, true);
    expect(store.durable).toBe(true);
    main.writes = false;
    await w.queue.addChunk(s, 1, 1000, WAV(2), false, true);
    expect(store.durable).toBe(false);
    expect((await store.chunks("a")).map((c) => c.seq)).toEqual([0, 1]);
    main.writes = true;
    await w.queue.finish(s, 2000);
    w.speech = "up";
    w.queue.kick();
    await w.settle();
    expect(w.rows.get("a")?.body).toBe("part1 part2");
    expect(store.durable).toBe(true);
  });

  it("a later write to the same chunk reaching the disk replaces the copy in memory", async () => {
    const main = new Flaky();
    const store = new FallbackStore(main);
    const c = { id: "a", seq: 0, ms: 1, open: true, text: null };
    main.writes = false;
    await store.putChunk(c, WAV(1));
    main.writes = true;
    await store.putChunk({ ...c, open: false }, WAV(2));
    expect(new Uint8Array((await store.audio("a", 0))!)[0]).toBe(2);
    expect(store.durable).toBe(true);
  });

  it("couldn't read isn't the same as nothing there: a failed read never finishes or clears a thought", async () => {
    const main = new Flaky();
    const store = new FallbackStore(main);
    const w = world(store);
    w.speech = "down";
    await record(w, "a", [1]);
    main.reads = false;
    await expect(store.chunks("a")).rejects.toThrow();
    w.speech = "up";
    w.queue.kick();
    await w.settle();
    main.reads = true;
    expect(w.nothing).toEqual([]);
    expect(await main.audio("a", 0)).not.toBeNull();
    w.queue.kick();
    await w.settle();
    expect(w.rows.get("a")?.body).toBe("part1");
  });
});
