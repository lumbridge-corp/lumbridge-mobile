// lumbridge-core's framed protocol, over one WebSocket message per frame.
export const DATA = 0, CREDIT = 1, CLOSE = 2, RESIZE = 3;
const HEADER = 9;

export function encode(channel: number, kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER + payload.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, channel, true);
  v.setUint8(4, kind);
  v.setUint32(5, payload.length, true);
  out.set(payload, HEADER);
  return out;
}

export function decode(buf: ArrayBuffer): { channel: number; kind: number; payload: Uint8Array } {
  const v = new DataView(buf);
  return { channel: v.getUint32(0, true), kind: v.getUint8(4), payload: new Uint8Array(buf, HEADER) };
}

export function creditFrame(channel: number, bytes: number): Uint8Array {
  const p = new Uint8Array(4);
  new DataView(p.buffer).setUint32(0, bytes, true);
  return encode(channel, CREDIT, p);
}

/** One OSC 7501 record, as core sends it. */
export interface StatusRecord {
  state: string; kind?: string | null; progress?: number | null; app?: string; title?: string; msg?: string;
}

export interface Terminal {
  address: string; name?: string | null; title?: string | null; cwd?: string | null;
  state: string; status?: StatusRecord | string | null; turn?: number; cols: number; rows: number;
  labels?: Record<string, string>; waiting_for_person?: unknown;
  foreground?: { name?: string; cwd?: string } | null; status_ms?: number | null; reported?: boolean;
  created_ms?: number; reason?: string | null; exit_code?: number | null; keep?: boolean;
}

/** The program's status word. Core's `status` is a record; a bare word is tolerated. */
export const statusWord = (t: Pick<Terminal, "status">): string | null =>
  typeof t.status === "string" ? t.status : t.status?.state ?? null;

export type Bucket = "needs" | "working" | "done" | "idle";

/** The status rule (needs, working, done, idle), with a missing seen label treated as already seen. */
export function bucket(t: Terminal): Bucket {
  const word = statusWord(t);
  if (word === "blocked" || word === "error") return "needs";
  if (word === "working") return "working";
  const seen = t.labels?.["lumbridge.seen"];
  if (seen !== undefined && (t.turn ?? 0) > Number(seen)) return "done";
  return "idle";
}

export function shouldMarkSeen(t: Terminal): boolean {
  const seen = t.labels?.["lumbridge.seen"];
  return seen === undefined || (t.turn ?? 0) > Number(seen);
}

/** `done` says the bytes have been dealt with. That's what earns more from core, so a slow screen slows the stream down. */
export type StreamHandler = { data(b: Uint8Array, done: () => void): void; resize?(cols: number, rows: number): void; close?(reason: string): void };

const dec = new TextDecoder();
const enc = new TextEncoder();

export class Core {
  private ws!: WebSocket;
  private id = 0;
  private waiting = new Map<number, { ok(v: any): void; no(e: Error): void }>();
  private streams = new Map<number, StreamHandler>();
  onEvent: (msg: any) => void = () => {};
  onDown: (why: string) => void = () => {};
  /** When anything last arrived. Core sends a heartbeat every 15 s, so silence means a dead socket. */
  lastRx = 0;

  get open() { return this.ws?.readyState === WebSocket.OPEN; }

  connect(url: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      let up = false;
      ws.onopen = () => ws.send(token);
      ws.onmessage = (e) => {
        this.lastRx = Date.now();
        if (typeof e.data === "string") {
          const m = JSON.parse(e.data);
          if (m.error) { reject(new Error(m.error)); return; }
          up = true;
          resolve();
          return;
        }
        this.frame(e.data);
      };
      ws.onclose = () => {
        for (const w of this.waiting.values()) w.no(new Error("disconnected"));
        this.waiting.clear();
        if (up) this.onDown("disconnected"); else reject(new Error("could not reach the server"));
      };
    });
  }

  close() { this.ws?.close(); }

  private frame(buf: ArrayBuffer) {
    const { channel, kind, payload } = decode(buf);
    if (channel === 0) {
      if (kind !== DATA) return;
      const m = JSON.parse(dec.decode(payload));
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.error) w.no(new Error(m.error.message)); else w.ok(m.result);
      return;
    }
    const s = this.streams.get(channel);
    if (!s) return;
    if (kind === DATA) {
      const ws = this.ws;
      s.data(payload, () => { if (ws.readyState === WebSocket.OPEN) ws.send(creditFrame(channel, payload.length)); });
    } else if (kind === RESIZE) {
      const v = new DataView(payload.buffer, payload.byteOffset);
      s.resize?.(v.getUint16(0, true), v.getUint16(2, true));
    } else if (kind === CLOSE) {
      this.streams.delete(channel);
      s.close?.(dec.decode(payload));
    }
  }

  call<T = any>(method: string, params: object = {}): Promise<T> {
    const id = ++this.id;
    const body = enc.encode(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((ok, no) => {
      this.waiting.set(id, { ok, no });
      this.ws.send(encode(0, DATA, body));
    });
  }

  listen(channel: number, s: StreamHandler) { this.streams.set(channel, s); }

  detach(channel: number) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(channel, CLOSE, new Uint8Array()));
  }

  async subscribe(onLine: (msg: any) => void): Promise<{ seq: number; terminals: Terminal[] }> {
    const r = await this.call("events.subscribe", {});
    let rest = "";
    const lines = new TextDecoder(); // its own: `stream` state must not mix with other frames
    this.listen(r.channel, {
      data: (b, done) => {
        rest += lines.decode(b, { stream: true });
        let i;
        while ((i = rest.indexOf("\n")) >= 0) {
          const line = rest.slice(0, i);
          rest = rest.slice(i + 1);
          if (line.trim()) onLine(JSON.parse(line));
        }
        done();
      },
    });
    return r;
  }
}
