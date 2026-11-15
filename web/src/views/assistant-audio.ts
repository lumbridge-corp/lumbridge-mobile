// Audio for the assistant, written for iOS Safari first.
//
// - One AudioContext for capture and playback, created and resumed inside a tap. iOS blocks audio
//   that isn't started from a gesture, but a context unlocked once stays usable.
// - Capture is raw PCM (AudioWorklet, ScriptProcessor as a fallback), never MediaRecorder, whose
//   formats differ on iOS. We encode the WAV ourselves.
// - Playback goes through that context (decodeAudioData + buffer sources), not <audio>.
// - `navigator.audioSession` (Safari 16.4+) is set per phase: "play-and-record" while listening,
//   "playback" while speaking, so she comes out of the speaker and isn't silenced by the ring switch.
// - `resume()` can hang forever on iOS without a gesture, so it's always raced with a timeout.

import { rms } from "./assistant-logic";

type AudioSessionType = "auto" | "playback" | "play-and-record" | "ambient" | "transient" | "transient-solo";

function setAudioSession(type: AudioSessionType) {
  try {
    const s = (navigator as unknown as { audioSession?: { type: AudioSessionType } }).audioSession;
    if (s) s.type = type;
  } catch { /* not supported */ }
}

let shared: AudioContext | null = null;
let output: GainNode | null = null;
let analyser: AnalyserNode | null = null;
let workletLoaded: Promise<boolean> | null = null;

function context(): AudioContext {
  if (shared && shared.state !== "closed") return shared;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctor({ latencyHint: "interactive" });
  output = ctx.createGain();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.6;
  output.connect(analyser);
  analyser.connect(ctx.destination);
  workletLoaded = null;
  shared = ctx;
  return ctx;
}

export const audioRunning = () => shared?.state === "running";

/** Must be called synchronously inside a tap or key press. */
export function unlockAudio(): AudioContext {
  const ctx = context();
  void ctx.resume().catch(() => {});
  // The classic iOS unlock: start any source inside the gesture.
  try {
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    src.connect(ctx.destination);
    src.start(0);
  } catch { /* the context wasn't ready; resume above still counts */ }
  return ctx;
}

/** Tries to resume without a gesture, e.g. after a call or a screen lock. True when running. */
export async function tryResume(ms = 800): Promise<boolean> {
  const ctx = shared;
  if (!ctx || ctx.state === "closed") return false;
  if (ctx.state === "running") return true;
  await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
  return (ctx.state as string) === "running";
}

/** Throws the context away; a silent mic on iOS can need a fresh one. The next tap rebuilds it. */
export function resetAudio() {
  const ctx = shared;
  shared = null;
  output = null;
  analyser = null;
  workletLoaded = null;
  void ctx?.close().catch(() => {});
}

export function onAudioStateChange(fn: () => void): () => void {
  const ctx = context();
  ctx.addEventListener("statechange", fn);
  return () => ctx.removeEventListener("statechange", fn);
}

const levelBuf = new Float32Array(1024);
/** What she's saying right now, 0..1-ish, for the orb. */
export function outputLevel(): number {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(levelBuf);
  return rms(levelBuf);
}

export type MicError = "denied" | "missing" | "insecure";

export class Mic {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private total = 0;
  private stopped = false;
  readonly rate: number;

  constructor(private ctx: AudioContext, private onChunk: (level: number, ms: number, peak: number) => void) {
    this.rate = ctx.sampleRate;
  }

  /** Rejects with a MicError. */
  async start(): Promise<void> {
    const devices = navigator.mediaDevices;
    if (!devices?.getUserMedia) throw "insecure" satisfies MicError;
    setAudioSession("play-and-record");
    try {
      this.stream = await devices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      setAudioSession("playback");
      const name = (e as DOMException).name;
      throw (name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError" ? "missing" : "denied") satisfies MicError;
    }
    // Stopped while the permission prompt was up.
    if (this.stopped) { this.release(); return; }
    // Asking for the mic can interrupt the context on iOS.
    void tryResume();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(this.ctx.destination);
    this.node = await this.captureNode();
    if (this.stopped) { this.release(); return; }
    this.source.connect(this.node);
    this.node.connect(this.sink);
  }

  private take = (samples: Float32Array) => {
    if (this.stopped) return;
    this.chunks.push(samples);
    this.total += samples.length;
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!));
    this.onChunk(rms(samples), (samples.length / this.rate) * 1000, peak);
  };

  private async captureNode(): Promise<AudioNode> {
    const ctx = this.ctx;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      workletLoaded ??= ctx.audioWorklet.addModule("/pcm-worklet.js").then(() => true, () => false);
      if (await workletLoaded) {
        const node = new AudioWorkletNode(ctx, "pcm-capture", { numberOfOutputs: 1 });
        node.port.onmessage = (e) => this.take(e.data as Float32Array);
        return node;
      }
    }
    const sp = ctx.createScriptProcessor(2048, 1, 1);
    sp.onaudioprocess = (e) => this.take(new Float32Array(e.inputBuffer.getChannelData(0)));
    return sp;
  }

  /** Everything captured so far, as one buffer at `rate`. */
  samples(): Float32Array {
    const out = new Float32Array(this.total);
    let at = 0;
    for (const c of this.chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  /** Turns the mic off (the iOS indicator goes away), and hands the audio route back to playback. */
  release() {
    this.stopped = true;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    if (this.node instanceof AudioWorkletNode) this.node.port.onmessage = null;
    else if (this.node) (this.node as ScriptProcessorNode).onaudioprocess = null;
    this.source?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
    this.source = null;
    this.node = null;
    this.sink = null;
    setAudioSession("playback");
  }

  /** Frees the audio once it has been used. */
  clear() { this.chunks = []; this.total = 0; }
}

interface QueueItem { text: string; audio?: Promise<AudioBuffer | null> }

export interface QueueEvents {
  /** A sentence has started playing. */
  started: () => void;
  /** Nothing left to play. */
  idle: () => void;
  /** A sentence couldn't be synthesized; the caller says why. Later sentences are dropped. */
  failed: (status: number, code?: string) => void;
  /** The context isn't running and needs a tap. */
  blocked: () => void;
}

/**
 * Speaks sentences in order, one at a time, fetching the next one ahead so there's no gap.
 * `fetchSpeech` is the only link to the server. `cancel` stops everything now.
 */
export class SpeechQueue {
  private items: QueueItem[] = [];
  private pumping = false;
  private generation = 0;
  private controller = new AbortController();
  private current: AudioBufferSourceNode | null = null;
  private dead = false;
  private unblock: (() => void) | null = null;

  constructor(private fetchSpeech: (text: string, signal: AbortSignal) => Promise<ArrayBuffer>, private on: QueueEvents) {}

  get busy() { return this.pumping || this.items.length > 0; }

  say(text: string) {
    if (this.dead) return;
    this.items.push({ text });
    this.prefetch();
    void this.pump();
  }

  /** The tap that unblocks a context stuck without a gesture. */
  retryBlocked() { this.unblock?.(); }

  /** Stops her now. A new turn can use the queue again afterwards. */
  cancel() {
    this.generation++;
    this.controller.abort();
    this.controller = new AbortController();
    this.items = [];
    this.dead = false;
    this.unblock?.();
    try { this.current?.stop(); } catch { /* already ended */ }
    this.current = null;
  }

  /** New turn: forget that voice failed last time. */
  reset() { this.dead = false; }

  private prefetch() {
    for (const item of this.items.slice(0, 2)) {
      if (!item.audio) item.audio = this.load(item.text, this.generation);
    }
  }

  private async load(text: string, generation: number): Promise<AudioBuffer | null> {
    const signal = this.controller.signal;
    try {
      const wav = await this.fetchSpeech(text, signal);
      return await decode(context(), wav);
    } catch (e) {
      if (generation === this.generation && !signal.aborted) {
        const failure = e as { status?: number; code?: string };
        this.dead = true;
        this.items = [];
        this.on.failed(failure.status ?? 0, failure.code);
      }
      return null;
    }
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    const generation = this.generation;
    try {
      while (generation === this.generation && this.items.length) {
        const item = this.items[0]!;
        this.prefetch();
        const buffer = await item.audio;
        if (generation !== this.generation) return;
        if (buffer) await this.play(buffer, generation);
        if (generation !== this.generation) return;
        if (this.items[0] === item) this.items.shift();
        this.prefetch();
      }
    } finally {
      this.pumping = false;
      // A cancel during the await may have left newer sentences waiting.
      if (this.items.length) void this.pump();
      else if (generation === this.generation) this.on.idle();
    }
  }

  private async play(buffer: AudioBuffer, generation: number) {
    const ctx = context();
    if (!(await tryResume())) {
      this.on.blocked();
      await new Promise<void>((r) => { this.unblock = r; });
      this.unblock = null;
      if (generation !== this.generation) return;
      await tryResume();
    }
    await new Promise<void>((done) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(output!);
      this.current = src;
      // `ended` may never fire if iOS interrupts the context mid-sentence.
      const watchdog = setTimeout(done, buffer.duration * 1000 + 1500);
      src.onended = () => { clearTimeout(watchdog); done(); };
      src.start();
      this.on.started();
    });
    if (this.current?.buffer === buffer) this.current = null;
  }
}

/** The callback form works on every Safari; the promise form doesn't on older ones. */
function decode(ctx: AudioContext, wav: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => { void ctx.decodeAudioData(wav, resolve, reject); });
}
