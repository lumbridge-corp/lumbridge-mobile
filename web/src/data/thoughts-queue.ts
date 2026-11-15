// Getting thoughts from this device to the server. Everything is written to the store first. Each chunk is transcribed in order and its
// text kept; when a recording is finished and all its text is in, one POST with an id chosen on the device, and only an answer to that
// clears the audio. The worst a failure at any step can do is wait: speech or the server being down leaves everything where it is, for
// a later try or a later open of the app.
import { joinChunks, retryDelayMs } from "./thoughts-logic";
import type { ChunkMeta, Pending, ThoughtStore } from "./thoughts-store";

/** retry: down, or a moment's trouble. rejected: asking again won't help. */
export type Answer<T> = { ok: T } | { retry: true } | { rejected: string };

export interface NewThought { id: string; body: string; source: "voice" | "typed"; duration_ms: number | null; created_at: string }

export interface ThoughtIo<S> {
  transcribe(wav: ArrayBuffer): Promise<Answer<string>>;
  save(t: NewThought): Promise<Answer<S>>;
  /** Is another tab still recording this? */
  recordingElsewhere(s: Pending): Promise<boolean>;
}

export type PendingState = "recording" | "working" | "waiting_speech" | "waiting_save" | "failed";

export interface PendingView {
  id: string;
  source: "voice" | "typed";
  created_at: string;
  duration_ms: number | null;
  /** What's been transcribed so far, in order. */
  text: string;
  /** Chunks still needing speech. */
  untranscribed: number;
  state: PendingState;
}

export interface QueueEvents<S> {
  changed: () => void;
  saved: (row: S) => void;
  /** A recording was transcribed and there was nothing in it. */
  nothingSaid: (id: string) => void;
}

export class ThoughtQueue<S> {
  private live = new Set<string>();
  private running = false;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Waits in a row on the timer. A kick, say a new chunk arriving, tries again without waiting any longer afterwards. */
  private attempts = 0;
  private timed = false;
  private speechDown = false;
  private saveDown = false;
  /** As of the last finished look, so the screen doesn't flicker back to "working" on every retry. */
  private shownSpeechDown = false;
  private shownSaveDown = false;
  /** Who failed last goes last, so one chunk the speech service can't take doesn't hold up the others. */
  private failedAt = new Map<string, number>();
  private clock = 0;
  private views: PendingView[] = [];

  constructor(private store: ThoughtStore, private io: ThoughtIo<S>, private on: QueueEvents<S>) {}

  get pending(): PendingView[] { return this.views; }

  /** Starts a recording. It stays out of reach of finishing until `finish`. */
  async begin(s: Pending) {
    this.live.add(s.id);
    await this.store.putSession(s);
    await this.refresh();
  }

  /** A checkpoint (`open`) or a finished chunk. `spoke` false: nothing audible, so the speech service isn't asked. */
  async addChunk(s: Pending, seq: number, ms: number, wav: ArrayBuffer, open: boolean, spoke: boolean) {
    await this.store.putChunk({ id: s.id, seq, ms, open, text: spoke ? null : "" }, spoke ? wav : null);
    if (!open) {
      await this.store.putSession({ ...s, touched: Date.now() });
      this.kick();
    }
  }

  async finish(s: Pending, durationMs: number) {
    await this.store.putSession({ ...s, finished: true, duration_ms: Math.round(durationMs), touched: Date.now() });
    this.live.delete(s.id);
    this.kick();
  }

  /** Too short to mean anything, or the owner said to. Gone from the device. */
  async discard(id: string) {
    this.live.delete(id);
    await this.store.remove(id);
    await this.refresh();
  }

  async addTyped(id: string, text: string, created_at: string) {
    await this.store.putSession({ id, source: "typed", created_at, duration_ms: null, finished: true, typed: text, touched: Date.now() });
    this.kick();
  }

  /** The owner asked to try again, including what the server refused. */
  async retry(id: string) {
    const s = await this.store.session(id);
    if (s?.failed) await this.store.putSession({ ...s, failed: null });
    for (const c of await this.store.chunks(id)) {
      if (c.failed) await this.store.updateChunk({ ...c, failed: null });
    }
    this.kick();
  }

  /** Try now, whatever the wait. */
  kick() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.running) { this.again = true; return; }
    this.running = true;
    void this.drain();
  }

  private async drain() {
    do {
      this.again = false;
      this.speechDown = this.saveDown = false;
      try {
        await this.pass();
      } catch {
        // The store itself failed a read. Nothing is decided on that; look again later.
        this.saveDown = true;
      }
      if (!this.speechDown && !this.saveDown) this.attempts = 0;
      else if (this.timed) this.attempts++;
      this.timed = false;
      this.shownSpeechDown = this.speechDown;
      this.shownSaveDown = this.saveDown;
      await this.refresh().catch(() => {});
    } while (this.again);
    this.running = false;
    if ((this.speechDown || this.saveDown) && !this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.timed = true; this.kick(); }, retryDelayMs(this.attempts));
    }
  }

  private async pass() {
    const order = (s: Pending) => this.failedAt.get(s.id) ?? 0;
    const sessions = (await this.store.sessions()).sort((a, b) => order(a) - order(b) || a.created_at.localeCompare(b.created_at));
    for (const s of sessions) await this.work(s);
  }

  private async work(s: Pending) {
    if (!s.finished && !this.live.has(s.id)) {
      // Nobody is recording it: the app was closed or crashed part way. Whatever reached the disk is the thought.
      if (await this.io.recordingElsewhere(s)) return;
      const ms = (await this.store.chunks(s.id)).reduce((sum, c) => sum + c.ms, 0);
      s = { ...s, finished: true, duration_ms: Math.round(ms) };
      await this.store.putSession(s);
    }
    if (s.failed) return;
    if (s.source === "typed") return void (await this.send(s, s.typed ?? ""));

    let chunks = await this.store.chunks(s.id);
    for (const c of chunks) {
      if (c.text !== null || c.failed || (c.open && !s.finished)) continue;
      if (this.speechDown) break;
      await this.transcribe(s, c);
      await this.refresh();
    }
    if (!s.finished || this.live.has(s.id)) return;
    chunks = await this.store.chunks(s.id);
    if (chunks.some((c) => c.text === null)) return;
    const body = joinChunks(chunks.map((c) => c.text));
    if (body) return void (await this.send(s, body));
    if (await this.store.session(s.id)) {
      await this.store.remove(s.id);
      this.on.nothingSaid(s.id);
    }
  }

  private async transcribe(s: Pending, c: ChunkMeta) {
    const wav = await this.store.audio(c.id, c.seq);
    if (!wav) {
      await this.store.updateChunk({ ...c, failed: "audio_missing" });
      return;
    }
    const answer = await this.io.transcribe(wav);
    if ("ok" in answer) await this.store.updateChunk({ ...c, text: answer.ok.trim(), failed: null });
    else if ("rejected" in answer) await this.store.updateChunk({ ...c, failed: answer.rejected });
    else {
      this.speechDown = true;
      this.failedAt.set(s.id, ++this.clock);
    }
  }

  private async send(s: Pending, body: string) {
    if (this.saveDown || !(await this.store.session(s.id))) return; // Discarded while its speech was out.
    const answer = await this.io.save({ id: s.id, body, source: s.source, duration_ms: s.duration_ms, created_at: s.created_at });
    if ("ok" in answer) {
      // The server has it, so a failure from here on only means the next try gets told the same.
      await this.store.remove(s.id);
      this.failedAt.delete(s.id);
      this.on.saved(answer.ok);
    } else if ("rejected" in answer) {
      await this.store.putSession({ ...s, failed: answer.rejected });
    } else {
      this.saveDown = true;
      this.failedAt.set(s.id, ++this.clock);
    }
  }

  /** Reads what's waiting, for the screen. */
  async refresh() {
    const views: PendingView[] = [];
    for (const s of await this.store.sessions()) {
      const chunks = s.source === "voice" ? await this.store.chunks(s.id) : [];
      const untranscribed = chunks.filter((c) => c.text === null).length;
      const failed = !!s.failed || chunks.some((c) => c.failed);
      const state: PendingState = this.live.has(s.id) ? "recording" : failed ? "failed"
        : untranscribed && (this.speechDown || this.shownSpeechDown) ? "waiting_speech"
        : !untranscribed && (this.saveDown || this.shownSaveDown) ? "waiting_save" : "working";
      views.push({
        id: s.id, source: s.source, created_at: s.created_at, duration_ms: s.duration_ms,
        text: s.source === "typed" ? s.typed ?? "" : joinChunks(chunks.map((c) => c.text)),
        untranscribed, state,
      });
    }
    this.views = views;
    this.on.changed();
  }
}
