// Thoughts, the parts with no browser in them: where to cut a long recording, and how the list reads.
import { localDate } from "./dates";

/** The gateway takes 4 MB. At 16 kHz, 16 bit, mono, the longest chunk here is about 1.8 MB. */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

export interface CutOptions {
  /** Past this, the next pause ends the chunk. */
  softMs: number;
  /** How long a quiet spell has to be to count as a pause. */
  gapMs: number;
  /** A chunk never gets longer than this. */
  hardMs: number;
  /** With no pause by hardMs, how far back to look for the quietest moment. */
  lookbackMs: number;
}
export const CUTS: CutOptions = { softMs: 20000, gapMs: 600, hardMs: 55000, lookbackMs: 15000 };

/** A chunk with nothing louder than this holds no speech, so the speech service isn't asked: Whisper tends to invent words for silence. */
export const INAUDIBLE_PEAK = 0.003;

const WINDOW_MS = 100;
interface Win { level: number; peak: number; ms: number }

export interface Cut {
  /** From the start of the current chunk. */
  atMs: number;
  /** The loudest moment before the cut. */
  peak: number;
}

/**
 * Decides from mic level alone where to end a chunk, so a word isn't cut in half when that can be helped. Quiet means well under
 * what this chunk usually sounds like: close to the room's floor (the quietest tenth, three times over, like the assistant's Endpointer), but
 * never above half the typical level, or a man talking without a break would count as a pause.
 */
export class CutPlanner {
  private opts: CutOptions;
  private windows: Win[] = [];
  private total = 0;
  private open: Win = { level: 0, peak: 0, ms: 0 };

  constructor(opts: Partial<CutOptions> = {}) { this.opts = { ...CUTS, ...opts }; }

  /** One frame from the mic. A Cut means end the chunk there; what's after it already counts towards the next one. */
  push(level: number, ms: number, peak: number): Cut | null {
    const w = this.open;
    w.level += level * ms;
    w.peak = Math.max(w.peak, peak);
    w.ms += ms;
    this.total += ms;
    if (w.ms < WINDOW_MS) return null;
    this.windows.push({ level: w.level / w.ms, peak: w.peak, ms: w.ms });
    this.open = { level: 0, peak: 0, ms: 0 };
    if (this.total < this.opts.softMs) return null;
    const at = this.total >= this.opts.hardMs ? this.quietest() : this.pause();
    return at === null ? null : this.cut(at);
  }

  private threshold(): number {
    const sorted = this.windows.map((w) => w.level).sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length / 10)]!, typical = sorted[Math.floor(sorted.length / 2)]!;
    return Math.max(0.006, Math.min(floor * 3, typical / 2));
  }

  /** How many windows to keep in this chunk, if it's now in a pause. Half the pause goes each way. */
  private pause(): number | null {
    const quiet = this.threshold();
    let ms = 0, i = this.windows.length;
    while (i > 0 && this.windows[i - 1]!.level <= quiet) ms += this.windows[--i]!.ms;
    if (ms < this.opts.gapMs) return null;
    let half = 0, keep = this.windows.length;
    while (keep > 1 && half < ms / 2) half += this.windows[--keep]!.ms;
    return keep;
  }

  /** No pause came: the quietest three windows in reach, cutting through the middle one. */
  private quietest(): number {
    let reach = 0, from = this.windows.length;
    while (from > 1 && reach < this.opts.lookbackMs) reach += this.windows[--from]!.ms;
    let best = this.windows.length, lowest = Infinity;
    for (let i = from + 1; i < this.windows.length - 1; i++) {
      const sum = this.windows[i - 1]!.level + this.windows[i]!.level + this.windows[i + 1]!.level;
      if (sum < lowest) { lowest = sum; best = i + 1; }
    }
    return best;
  }

  private cut(keep: number): Cut {
    const kept = this.windows.slice(0, keep);
    const atMs = kept.reduce((sum, w) => sum + w.ms, 0);
    const peak = kept.reduce((max, w) => Math.max(max, w.peak), 0);
    this.windows = this.windows.slice(keep);
    this.total -= atMs;
    return { atMs, peak };
  }

  /** The loudest moment since the last cut, for the chunk that ends with the recording. */
  get peak(): number {
    return this.windows.reduce((max, w) => Math.max(max, w.peak), this.open.peak);
  }
}

/** Mic audio not yet in a chunk. Every sample goes out exactly once, in order. */
export class PcmBuffer {
  private parts: Float32Array[] = [];
  length = 0;

  add(samples: Float32Array) {
    if (!samples.length) return;
    this.parts.push(samples);
    this.length += samples.length;
  }

  /** Everything, still held. */
  peek(): Float32Array {
    if (this.parts.length === 1) return this.parts[0]!;
    const all = new Float32Array(this.length);
    let at = 0;
    for (const p of this.parts) { all.set(p, at); at += p.length; }
    this.parts = this.length ? [all] : [];
    return all;
  }

  /** The first `n` samples, gone from here. */
  take(n: number): Float32Array {
    const all = this.peek();
    const head = all.slice(0, n);
    const rest = all.slice(n);
    this.parts = rest.length ? [rest] : [];
    this.length = rest.length;
    return head;
  }
}

export const joinChunks = (texts: (string | null)[]): string =>
  texts.map((t) => (t ?? "").trim()).filter(Boolean).join(" ");

/** Seconds, then doubling or so, up to five minutes. Coming back to the app or the network returning tries at once. */
const DELAYS = [5, 15, 30, 60, 120, 300];
export const retryDelayMs = (attempts: number): number => DELAYS[Math.min(attempts, DELAYS.length - 1)]! * 1000;

/** "0:07", "12:30", "1:02:03". */
export function clock(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export interface Day<T> { key: string; label: string; items: T[] }

/** Newest first, by the day in the owner's own time zone that the owner said it. */
export function groupByDay<T extends { created_at: string }>(items: T[], now = new Date()): Day<T>[] {
  const sorted = [...items].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const today = localDate(now);
  const yesterday = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const days: Day<T>[] = [];
  for (const item of sorted) {
    const d = new Date(item.created_at);
    const key = localDate(d);
    let day = days[days.length - 1];
    if (day?.key !== key) {
      const label = key === today ? "Today" : key === yesterday ? "Yesterday"
        : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
      day = { key, label, items: [] };
      days.push(day);
    }
    day.items.push(item);
  }
  return days;
}
