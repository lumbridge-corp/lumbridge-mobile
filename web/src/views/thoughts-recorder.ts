// Recording a thought, and what carries on when the screen is gone: the queue, which also picks up on opening the app, whichever
// screen it opens on. Audio goes through the same Mic and the same private speech path as the assistant and hold-to-talk.
import { token } from "../api";
import { CutPlanner, INAUDIBLE_PEAK, PcmBuffer } from "../data/thoughts-logic";
import { ThoughtQueue, type ThoughtIo } from "../data/thoughts-queue";
import { FallbackStore, IdbStore, type Pending } from "../data/thoughts-store";
import { jsonInit, request } from "./data-ui";
import { Mic, resetAudio, tryResume } from "./assistant-audio";
import { encodeWav, resample } from "./assistant-logic";
import { NS } from "../ns";

export interface Thought {
  id: string;
  body: string;
  source: "voice" | "typed";
  duration_ms: number | null;
  note_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

const ASR_RATE = 16000;
const TOO_SHORT_MS = 350;
/** Under this at the very end there's no word to find, and speech services can choke on it. */
const TINY_TAIL_MS = 250;
const SILENT_MIC_MS = 3000;
/** The most a crash can cost: the audio since the last time it reached the disk. */
const CHECKPOINT_MS = 10000;
/** The gateway tries both speech services for up to 25 s each. A request that never answers mustn't stop the queue. */
const TRANSCRIBE_TIMEOUT_MS = 90000;
/** With no frames for this long, on a page in view, something has taken the mic: a call, Siri. */
const MIC_LOST_MS = 8000;
/** Where Web Locks don't exist: a live recording writes at least this often. */
const ALIVE_MS = 70000;

const lockName = (id: string) => `${NS}.thoughts.recording.${id}`;

/** Held for as long as this page records, and let go by the browser when the page dies, whichever way it dies. */
function holdLock(id: string): Promise<() => void> {
  const locks = navigator.locks;
  if (!locks) return Promise.resolve(() => {});
  return new Promise((granted) => {
    locks.request(lockName(id), () => new Promise<void>((release) => granted(release))).catch(() => granted(() => {}));
  });
}

const io: ThoughtIo<Thought> = {
  async transcribe(wav) {
    if (!token()) return { retry: true }; // Before pairing. An empty token would only use up the rate limit.
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), TRANSCRIBE_TIMEOUT_MS);
    const res = await request<{ text: string }>("/api/voice/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav, signal: stop.signal });
    clearTimeout(timer);
    if (res.ok) return { ok: res.ok.text };
    return res.fail === "rejected" ? { rejected: res.why } : { retry: true };
  },
  async save(t) {
    if (!token()) return { retry: true };
    const res = await request<Thought>("/api/thoughts", jsonInit("POST", t));
    if (res.ok) return { ok: res.ok };
    return res.fail === "rejected" ? { rejected: res.why } : { retry: true }; // A 404 is a gateway from before this route.
  },
  async recordingElsewhere(s) {
    const locks = navigator.locks;
    if (!locks) return Date.now() - s.touched < ALIVE_MS;
    return ((await locks.query()).held ?? []).some((h) => h.name === lockName(s.id));
  },
};

function hasIndexedDb(): boolean {
  try { return !!window.indexedDB; } catch { return false; }
}

export interface ThoughtListener {
  changed?: () => void;
  saved?: (t: Thought) => void;
  nothingSaid?: () => void;
}
const listeners = new Set<ThoughtListener>();
export function onThoughts(l: ThoughtListener) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

const store = new FallbackStore(hasIndexedDb() ? new IdbStore() : null);
export const queue = new ThoughtQueue<Thought>(store, io, {
  changed: () => { for (const l of [...listeners]) l.changed?.(); },
  saved: (t) => { for (const l of [...listeners]) l.saved?.(t); },
  nothingSaid: () => { for (const l of [...listeners]) l.nothingSaid?.(); },
});
export const durable = () => store.durable;

let recording: Recording | null = null;
/** main.ts doesn't reload for a new build under a recording. */
export const recordingNow = () => recording !== null;

/** Anything left from last time goes as soon as the app opens, and whenever it comes back or the network does. */
export function initThoughts() {
  const look = () => { if (token() && !document.hidden) queue.kick(); };
  document.addEventListener("visibilitychange", look);
  window.addEventListener("online", look);
  look();
}

export type RecordingEnd = "mic_silent" | "mic_lost" | "too_short" | null;

export class Recording {
  readonly id = crypto.randomUUID();
  private session: Pending;
  private mic: Mic;
  private planner = new CutPlanner();
  private buffer = new PcmBuffer();
  private seq = 0;
  private elapsed = 0;
  private lastCheckpoint = 0;
  private lastFrame = 0;
  private heard = false;
  private stopped = false;
  private watchdog = 0;
  private wake: WakeLockSentinel | null = null;
  /** Writes go in the order they were made, and nothing in the audio callback waits on one. */
  private writes: Promise<unknown>;
  private release: () => void = () => {};

  /** `ctx` from unlockAudio, inside the tap. */
  constructor(ctx: AudioContext, private on: { frame: (level: number, elapsedMs: number) => void; ended: (why: RecordingEnd) => void }) {
    this.session = { id: this.id, source: "voice", created_at: new Date().toISOString(), duration_ms: null, finished: false, touched: Date.now() };
    this.mic = new Mic(ctx, this.frame);
    recording = this;
    this.writes = holdLock(this.id).then(async (release) => {
      this.release = release;
      await queue.begin(this.session);
    });
    void navigator.storage?.persist?.().catch(() => {});
  }

  /** Rejects with a MicError, having left nothing behind. */
  async start(): Promise<void> {
    try {
      await this.mic.start();
    } catch (failure) {
      this.stopped = true;
      this.mic.release();
      this.leave();
      this.after(() => queue.discard(this.id));
      this.after(async () => this.release());
      throw failure;
    }
    if (this.stopped) return;
    this.lastFrame = performance.now();
    this.watchdog = window.setInterval(this.watch, 1000);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.checkpoint);
    void this.keepAwake();
  }

  /** Ends it and sends what there is. */
  stop(why: RecordingEnd = null) {
    if (this.stopped) return;
    this.stopped = true;
    this.mic.release();
    this.drainMic();
    this.leave();
    const silent = !this.heard;
    if (silent && why === "mic_silent") resetAudio(); // A silent mic on iOS can need a fresh context. The next tap builds it.
    if (silent || this.elapsed < TOO_SHORT_MS) {
      this.after(() => queue.discard(this.id));
      this.on.ended(why ?? (this.elapsed < TOO_SHORT_MS ? "too_short" : null));
    } else {
      const tail = this.buffer.take(this.buffer.length);
      const ms = (tail.length / this.mic.rate) * 1000;
      if (tail.length || this.lastCheckpoint > 0) this.writeChunk(tail, ms, false, ms >= TINY_TAIL_MS && this.planner.peak >= INAUDIBLE_PEAK);
      this.after(() => queue.finish(this.session, this.elapsed));
      this.on.ended(why);
    }
    this.after(async () => this.release());
  }

  private frame = (level: number, ms: number, peak: number) => {
    if (this.stopped) return;
    this.elapsed += ms;
    this.lastFrame = performance.now();
    if (peak > 0) this.heard = true;
    this.on.frame(level, this.elapsed);
    if (!this.heard && this.elapsed >= SILENT_MIC_MS) { this.stop("mic_silent"); return; }
    const cut = this.planner.push(level, ms, peak);
    if (cut) {
      this.drainMic();
      const head = this.buffer.take(Math.round((cut.atMs / 1000) * this.mic.rate));
      this.writeChunk(head, (head.length / this.mic.rate) * 1000, false, cut.peak >= INAUDIBLE_PEAK);
      this.seq++;
      this.lastCheckpoint = this.elapsed;
    } else if (this.elapsed - this.lastCheckpoint >= CHECKPOINT_MS) {
      this.checkpoint();
    }
  };

  /** What's been heard of the current chunk, onto the disk now. The next write to this seq replaces it. */
  private checkpoint = () => {
    if (this.stopped) return;
    this.lastCheckpoint = this.elapsed;
    if (this.planner.peak < INAUDIBLE_PEAK) return;
    this.drainMic();
    if (this.buffer.length) this.writeChunk(this.buffer.peek(), (this.buffer.length / this.mic.rate) * 1000, true, true);
  };

  private drainMic() {
    this.buffer.add(this.mic.samples());
    this.mic.clear();
  }

  private writeChunk(samples: Float32Array, ms: number, open: boolean, spoke: boolean) {
    const wav = encodeWav(resample(samples, this.mic.rate, ASR_RATE), ASR_RATE);
    const seq = this.seq;
    this.after(() => queue.addChunk(this.session, seq, ms, wav, open, spoke));
  }

  private after(run: () => Promise<unknown>) {
    this.writes = this.writes.then(run, run).catch(() => {});
  }

  private watch = () => {
    if (document.hidden) return;
    const quiet = performance.now() - this.lastFrame;
    if (quiet > MIC_LOST_MS) this.stop("mic_lost");
    else if (quiet > 3000) void tryResume();
  };

  private onVisibility = () => {
    if (document.hidden) { this.checkpoint(); return; }
    this.lastFrame = performance.now();
    void tryResume();
    void this.keepAwake();
  };

  /** Not everywhere, and refused on low battery. The browser lets go of it when the page is hidden. */
  private async keepAwake() {
    try { this.wake = (await navigator.wakeLock?.request("screen")) ?? null; } catch { /* the owner just has to keep it awake themselves */ }
    if (this.stopped) void this.wake?.release().catch(() => {});
  }

  private leave() {
    clearInterval(this.watchdog);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.checkpoint);
    void this.wake?.release().catch(() => {});
    this.wake = null;
    if (recording === this) recording = null;
  }
}
