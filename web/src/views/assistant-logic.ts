// The parts of the assistant's screen that are pure logic, so they can be tested without a browser.

import { ASSISTANT_NAME } from "../ns";

// ---------------------------------------------------------------- SSE

export interface SseEvent { event: string; data: string }

/** Incremental SSE parser for what fetch() hands back. Comments (keepalives) are skipped. */
export class SseParser {
  private buf = "";
  private event = "";
  private data: string[] = [];

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (line === "") {
        if (this.data.length || this.event) out.push({ event: this.event || "message", data: this.data.join("\n") });
        this.event = "";
        this.data = [];
      } else if (line.startsWith(":")) {
        continue;
      } else if (line.startsWith("event:")) {
        this.event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        this.data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- what gets spoken

/** Her words without the markdown, links, code and emoji, or "" when nothing is left to say. */
export function stripForSpeech(input: string): string {
  let s = input
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/\bhttps?:\/\/\S+/g, " ")
    .replace(/\bwww\.\S+/g, " ");
  s = s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !/^\|.*\|?$/.test(l) && !/^[-=*_:| ]{3,}$/.test(l))
    .map((l) => l.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "").replace(/^[-*+•]\s+/, "").replace(/^\d{1,3}[.)]\s+/, ""))
    .join(" ");
  s = s
    .replace(/`([^`]*)`/g, "$1")
    .replace(/`/g, "")
    .replace(/(\*\*|__)(?=\S)(.*?\S)\1/g, "$2")
    .replace(/(^|[\s(])\*(?=\S)([^*]*\S)\*/g, "$1$2")
    .replace(/(^|[\s(])_(?=\S)([^_]*\S)_(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/\*+/g, "")
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
  return /[\p{L}\p{N}]/u.test(s) ? s : "";
}

const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "st", "vs", "etc", "e.g", "i.e", "eg", "ie", "no", "approx", "sr", "jr", "prof", "inc", "ltd", "co"]);
const SOFT_LIMIT = 200;

/**
 * Turns a stream of text into sentences to speak, as soon as each one is complete. Code blocks
 * are dropped whole, even when a fence arrives split across deltas. A sentence that runs on
 * gets cut at a comma or a space so she starts speaking quickly.
 */
export class SentenceSplitter {
  private buf = "";
  private fenced = false;

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    this.scan(out);
    return out;
  }

  flush(): string[] {
    const out: string[] = [];
    this.scan(out);
    if (!this.fenced) this.emit(this.buf, out);
    this.buf = "";
    this.fenced = false;
    return out;
  }

  private emit(raw: string, out: string[]) {
    const spoken = stripForSpeech(raw);
    if (spoken) out.push(spoken);
  }

  private scan(out: string[]) {
    for (;;) {
      if (this.fenced) {
        const end = this.buf.indexOf("```");
        // Only the backticks at the very end can still become a closing fence.
        if (end < 0) { this.buf = this.buf.match(/`{1,2}$/)?.[0] ?? ""; return; }
        this.buf = this.buf.slice(end + 3);
        this.fenced = false;
        continue;
      }
      const fence = this.buf.indexOf("```");
      const limit = fence >= 0 ? fence : this.buf.length;
      const cut = this.boundary(this.buf.slice(0, limit));
      if (cut > 0) {
        this.emit(this.buf.slice(0, cut), out);
        this.buf = this.buf.slice(cut);
        continue;
      }
      if (fence >= 0) {
        this.emit(this.buf.slice(0, fence), out);
        this.buf = this.buf.slice(fence + 3);
        this.fenced = true;
        continue;
      }
      return;
    }
  }

  /** Index just after the first finished sentence, or 0 when there isn't one yet. */
  private boundary(s: string): number {
    const re = /[.!?…]+["')\]*_]*(?=\s)|\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      if (m[0] === "\n") {
        if (stripForSpeech(s.slice(0, m.index))) return m.index + 1;
        continue;
      }
      if (m[0][0] === "." && m[0].length === 1 && this.notAnEnd(s.slice(0, m.index))) continue;
      return m.index + m[0].length;
    }
    if (s.length > SOFT_LIMIT) {
      const head = s.slice(0, SOFT_LIMIT);
      const clause = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": "), head.lastIndexOf(" — "));
      if (clause > 40) return clause + 1;
      const space = head.lastIndexOf(" ");
      if (space > 0) return space;
    }
    return 0;
  }

  private notAnEnd(before: string): boolean {
    const word = (before.match(/([\p{L}\p{N}.]+)$/u)?.[1] ?? "").toLowerCase();
    if (ABBREVIATIONS.has(word)) return true;
    if (/^\p{L}$/u.test(word)) return true; // an initial
    // "1. " opening a list item is a marker, not the end of a sentence.
    return /^\d{1,3}$/.test(word) && /(^|\n)\s*\d{1,3}$/.test(before);
  }
}

// ---------------------------------------------------------------- what gets displayed

export type Block =
  | { type: "p"; spans: Span[] }
  | { type: "li"; spans: Span[] }
  | { type: "code"; text: string };
export type Span = { text: string; style?: "b" | "code" };

/** A small safe subset of markdown. It yields data, which the view turns into text nodes. */
export function parseBlocks(input: string): Block[] {
  const out: Block[] = [];
  const parts = input.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push({ type: "code", text: part.replace(/^[^\n]*\n/, "").replace(/\n$/, "") });
      return;
    }
    let para: string[] = [];
    const flush = () => {
      if (para.length) out.push({ type: "p", spans: parseSpans(para.join(" ")) });
      para = [];
    };
    for (const raw of part.split("\n")) {
      const line = raw.trim();
      const item = line.match(/^(?:[-*+•]|\d{1,3}[.)])\s+(.*)$/);
      if (!line) flush();
      else if (item) { flush(); out.push({ type: "li", spans: parseSpans(item[1]!) }); }
      else para.push(line.replace(/^#{1,6}\s+/, ""));
    }
    flush();
  });
  return out;
}

function parseSpans(text: string): Span[] {
  const out: Span[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ text: m[1], style: "b" });
    else out.push({ text: m[2]!, style: "code" });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

// ---------------------------------------------------------------- WAV

/** Averages down (or interpolates up) to the target rate. Averaging is the anti-alias filter. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const n = Math.round((input.length * to) / from);
  const out = new Float32Array(n);
  const step = from / to;
  if (step > 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * step);
      const b = Math.min(input.length, Math.max(a + 1, Math.floor((i + 1) * step)));
      let sum = 0;
      for (let j = a; j < b; j++) sum += input[j]!;
      out[i] = sum / (b - a);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const x = i * step;
      const a = Math.floor(x);
      const v0 = input[a] ?? 0;
      const v1 = input[a + 1] ?? v0;
      out[i] = v0 + (v1 - v0) * (x - a);
    }
  }
  return out;
}

/** Mono PCM16 in a WAV container. */
export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const tag = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  tag(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const c = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, c < 0 ? c * 0x8000 : c * 0x7fff, true);
  }
  return buffer;
}

export function rms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

// ---------------------------------------------------------------- end of speech

const CALIBRATE_MS = 200;

export type EndpointResult = "listening" | "ended" | "no_speech" | "max_length";

export interface EndpointOptions { silenceMs: number; noSpeechMs: number; maxMs: number; minSpeechMs: number }

/** Decides from mic level alone when you have finished. The floor adapts to the room. */
export class Endpointer {
  private opts: EndpointOptions;
  private floor = 0;
  private elapsed = 0;
  private voiced = 0;
  private quiet = 0;
  /** Set once enough speech was heard. */
  started = false;

  constructor(opts: Partial<EndpointOptions> = {}) {
    // 900 ms: 700 cut off a sentence pause of 800 ms in testing, and losing the owner's words costs more than 200 ms.
    this.opts = { silenceMs: 900, noSpeechMs: 8000, maxMs: 60000, minSpeechMs: 120, ...opts };
  }

  get threshold(): number { return Math.max(0.006, this.floor * 3); }

  feed(level: number, ms: number): EndpointResult {
    const calibrating = this.elapsed < CALIBRATE_MS;
    this.elapsed += ms;
    if (calibrating) {
      // The quietest moment of the first instants; the owner may already be talking when the owner taps.
      this.floor = this.elapsed <= ms ? level : Math.min(this.floor, level);
      this.quiet += ms;
      if (this.elapsed < this.opts.maxMs) return "listening";
    }
    const loud = level > this.threshold;
    // The floor follows dips at once and rises slowly, so the gaps between words hold it down
    // during speech while a steady noise still gets learned.
    const tau = level < this.floor ? 100 : 4000;
    this.floor += (level - this.floor) * Math.min(1, ms / tau);
    if (loud) {
      this.voiced += ms;
      this.quiet = 0;
      if (this.voiced >= this.opts.minSpeechMs) this.started = true;
    } else {
      this.quiet += ms;
      if (!this.started && this.quiet > 300) this.voiced = 0;
    }
    if (this.elapsed >= this.opts.maxMs) return this.started ? "max_length" : "no_speech";
    if (this.started && this.quiet >= this.opts.silenceMs) return "ended";
    if (!this.started && this.elapsed >= this.opts.noSpeechMs) return "no_speech";
    return "listening";
  }
}

// ---------------------------------------------------------------- the TV

/** What `/api/voice/tv` takes in one call, as for `/api/voice/speak`. */
export const TV_MAX_CHARS = 2000;

export interface TvEvents {
  /** The TV has started on her reply. */
  started: () => void;
  /** Everything so far has been said. */
  idle: () => void;
  /** The TV couldn't say it. `unsaid` is what it didn't get to, in order, for the phone to say instead. */
  failed: (status: number, code: string | undefined, unsaid: string[]) => void;
}

/**
 * Says her reply on the TV. Each call comes back when the TV has finished, so the first sentence goes at once and what
 * arrives while it plays goes next, as one: few calls, no waiting for the whole answer. `cancel` aborts the call,
 * and the gateway stops the TV with it. Once it fails, it takes nothing more until `reset`.
 */
export class TvQueue {
  private waiting: string[] = [];
  private sending = false;
  private generation = 0;
  private controller = new AbortController();
  private dead = false;

  constructor(private send: (text: string, signal: AbortSignal) => Promise<void>, private on: TvEvents) {}

  get busy() { return this.sending || this.waiting.length > 0; }

  say(text: string) {
    if (this.dead || !text.trim()) return;
    this.waiting.push(text);
    void this.pump();
  }

  cancel() {
    this.generation++;
    this.controller.abort();
    this.controller = new AbortController();
    this.waiting = [];
    this.dead = false;
  }

  /** New turn: forget that the TV failed last time. */
  reset() { this.dead = false; }

  /** The sentences waiting, up to what one call takes. */
  private next(): string[] {
    const batch: string[] = [];
    let length = 0;
    while (this.waiting.length) {
      const s = this.waiting[0]!;
      if (!batch.length && s.length > TV_MAX_CHARS) { this.waiting[0] = s.slice(TV_MAX_CHARS); return [s.slice(0, TV_MAX_CHARS)]; }
      if (batch.length && length + 1 + s.length > TV_MAX_CHARS) break;
      length += (batch.length ? 1 : 0) + s.length;
      batch.push(s);
      this.waiting.shift();
    }
    return batch;
  }

  private async pump() {
    if (this.sending) return;
    this.sending = true;
    const generation = this.generation;
    const signal = this.controller.signal;
    try {
      let first = true;
      while (generation === this.generation && this.waiting.length) {
        const batch = this.next();
        if (first) { first = false; this.on.started(); }
        try {
          await this.send(batch.join(" "), signal);
        } catch (e) {
          if (generation === this.generation && !signal.aborted) {
            const failure = e as { status?: number; code?: string };
            const unsaid = [...batch, ...this.waiting];
            this.dead = true;
            this.waiting = [];
            this.on.failed(failure.status ?? 0, failure.code, unsaid);
          }
          return;
        }
      }
    } finally {
      this.sending = false;
      // A cancel during the call may have left a newer turn's sentences waiting.
      if (this.waiting.length) void this.pump();
      else if (generation === this.generation && !this.dead) this.on.idle();
    }
  }
}

// ---------------------------------------------------------------- errors

/** Each failure you can tell apart, with what to say about it. */
export type Trouble = "mic_denied" | "mic_missing" | "mic_silent" | "mic_insecure" | "assistant" | "offline" | "voice" | "tv" | "speaker" | "speaker_listen" | "unpaired";

export const TROUBLE_TEXT: Record<Trouble, string> = {
  mic_denied: "I can't hear you. Allow the microphone for Lumbridge in Settings, or type below.",
  mic_missing: "I can't hear you. This device has no microphone I can use. You can type below.",
  mic_silent: "I can't hear you. The microphone is sending silence. Tap to try again, or type below.",
  mic_insecure: "I can't hear you. The microphone only works over the secure Lumbridge address.",
  assistant: `Can't reach ${ASSISTANT_NAME} right now.`,
  offline: "Can't reach Lumbridge right now.",
  voice: `Voice is offline. ${ASSISTANT_NAME} can still read and write here.`,
  tv: "The TV isn't answering, so the answer is spoken here.",
  speaker: "That speaker isn't answering, so the answer is spoken here.",
  speaker_listen: "That speaker isn't listening, so the answer is spoken here. Open its page there and tap once.",
  unpaired: "This device isn't paired any more. Pair it again from Settings.",
};

/** Red for what failed and needs you; amber for what sorts itself out, or where the assistant carries on another way (DESIGN.md). */
export type Tone = "danger" | "warn";
export const TROUBLE_TONE: Record<Trouble, Tone> = {
  mic_denied: "danger", mic_missing: "danger", mic_silent: "danger", mic_insecure: "danger", assistant: "danger", unpaired: "danger",
  offline: "warn", voice: "warn", tv: "warn", speaker: "warn", speaker_listen: "warn",
};

/** "What happened. What to do." as its two halves, for an error state that shows them apart. One sentence stays whole. */
export function splitSentence(text: string): [string, string] {
  const at = text.search(/[.!?] /);
  return at < 0 ? [text, ""] : [text.slice(0, at + 1), text.slice(at + 2)];
}

/** Why the tab can't talk to the assistant at all: Hermes not answering, Lumbridge itself not answering, or this device no longer paired. */
export type Away = "assistant" | "offline" | "unpaired";

export interface AwayCard { what: string; next: string; tone: Tone; action: "retry" | "settings" }

/**
 * The one card that says the assistant can't be reached. The first two clear by themselves (the tab checks every few seconds), so they're
 * amber with a Try again; a device that isn't paired stays that way until you pair it again.
 */
export function awayCard(why: Away): AwayCard {
  if (why === "unpaired") {
    const [what, next] = splitSentence(TROUBLE_TEXT.unpaired);
    return { what, next, tone: "danger", action: "settings" };
  }
  const where = why === "assistant" ? "Its agent runtime isn't answering." : "This device is offline, or the server isn't answering.";
  return { what: TROUBLE_TEXT[why], next: `${where} Checking every few seconds; anything you type waits here.`, tone: "warn", action: "retry" };
}

// ---------------------------------------------------------------- what to ask it

/**
 * The empty conversation's starters: things it really does, each with the tool in its toolset that answers it,
 * so none of them promise what it can't do.
 */
export const STARTERS: readonly { text: string; tool: string }[] = [
  { text: "What needs me right now?", tool: "needs_you" },
  { text: "What's on my calendar today?", tool: "calendar" },
  { text: "How are my machines doing?", tool: "fleet_health" },
];

/** From a gateway reply's status and `error` code to what went wrong. */
export function troubleFor(status: number, code?: string): Trouble {
  if (status === 401 || status === 403) return "unpaired";
  if (code === "voice_offline") return "voice";
  if (code?.startsWith("tv_")) return "tv";
  if (code === "speaker_not_listening" || code === "speaker_blocked") return "speaker_listen";
  if (code?.startsWith("speaker_")) return "speaker";
  return "assistant";
}

// ---------------------------------------------------------------- where it answers

/**
 * The phone, or what `GET /api/voice/tv` offers: the TV, and any other speaker an instance adds (src/ext/), which names itself
 * with `label`. A speaker other than the phone and the TV may say whether its page is `listening`.
 */
export type SpeakerId = string;
export interface Speaker { id: SpeakerId; label: string; available: boolean; listening: boolean | null }

const BUILT_IN: Record<string, string> = { phone: "Phone", tv: "TV" };
const SPEAKER_ID = /^[A-Za-z0-9][\w-]{0,31}$/;
const MAX_LABEL = 40;
const isSpeakerId = (v: unknown): v is SpeakerId => typeof v === "string" && SPEAKER_ID.test(v);
/** The phone and the TV keep their own names; another speaker says its own, or is called by its id. */
const labelFor = (id: SpeakerId, label: unknown) =>
  BUILT_IN[id] ?? (typeof label === "string" && label.trim() ? label.trim().slice(0, MAX_LABEL) : id);

/** The phone first, always there, then what the gateway offers. An older gateway only says `available` for the TV. */
export function parseSpeakers(body: unknown): Speaker[] {
  const b = (body ?? {}) as { available?: unknown; speakers?: unknown };
  const out: Speaker[] = [{ id: "phone", label: BUILT_IN.phone, available: true, listening: null }];
  if (Array.isArray(b.speakers)) {
    for (const raw of b.speakers) {
      const s = (raw ?? {}) as { id?: unknown; label?: unknown; available?: unknown; listening?: unknown };
      if (!isSpeakerId(s.id) || s.id === "phone" || out.some((o) => o.id === s.id)) continue;
      out.push({ id: s.id, label: labelFor(s.id, s.label), available: s.available === true, listening: typeof s.listening === "boolean" ? s.listening : null });
    }
  } else {
    out.push({ id: "tv", label: BUILT_IN.tv, available: b.available === true, listening: null });
  }
  return out;
}

/** What this device chose. Before the picker, a TV toggle stored "1" in the `tv` key. */
export function storedSpeaker(stored: string | null, oldTv: string | null): SpeakerId {
  if (isSpeakerId(stored)) return stored;
  return oldTv === "1" ? "tv" : "phone";
}

/** A speaker that isn't listening stays selectable: this says what to do. Nothing for the phone, the TV, or a speaker we can't ask. */
export function speakerHint(s: Speaker | undefined): string {
  if (!s || s.id === "phone" || s.id === "tv" || !s.available || s.listening !== false) return "";
  return `${s.label} isn't listening. Open its page there and tap once.`;
}
