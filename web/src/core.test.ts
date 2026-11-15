import { describe, expect, it } from "vitest";
import { bucket, creditFrame, decode, encode, shouldMarkSeen, DATA, type Terminal } from "./core";

const t = (o: Partial<Terminal>): Terminal => ({ address: "t1", state: "live", cols: 80, rows: 24, ...o });

describe("frames", () => {
  it("match the layout in schema/README.md", () => {
    const f = encode(7, DATA, new Uint8Array([104, 105]));
    expect([...f]).toEqual([7, 0, 0, 0, 0, 2, 0, 0, 0, 104, 105]);
    const d = decode(f.buffer as ArrayBuffer);
    expect([d.channel, d.kind, ...d.payload]).toEqual([7, 0, 104, 105]);
  });
  it("carry credit as u32 LE", () => {
    expect([...creditFrame(1, 258)]).toEqual([1, 0, 0, 0, 1, 4, 0, 0, 0, 2, 1, 0, 0]);
  });
});

describe("shared seen state", () => {
  it("sorts by need first", () => {
    expect(bucket(t({ status: "blocked" }))).toBe("needs");
    expect(bucket(t({ status: "error" }))).toBe("needs");
    expect(bucket(t({ status: "working" }))).toBe("working");
  });
  it("reads core's status record, not only a bare word", () => {
    expect(bucket(t({ status: { state: "blocked", kind: "permission", msg: "Apply?" } }))).toBe("needs");
    expect(bucket(t({ status: { state: "working" } }))).toBe("working");
    expect(bucket(t({ status: { state: "done" }, turn: 2, labels: { "lumbridge.seen": "1" } }))).toBe("done");
    expect(bucket(t({ status: null }))).toBe("idle");
  });
  it("is done only when the turn passed what a person saw", () => {
    expect(bucket(t({ status: "idle", turn: 3, labels: { "lumbridge.seen": "2" } }))).toBe("done");
    expect(bucket(t({ status: "idle", turn: 3, labels: { "lumbridge.seen": "3" } }))).toBe("idle");
  });
  it("does not treat a missing label as 0", () => {
    expect(bucket(t({ status: "idle", turn: 3 }))).toBe("idle");
  });
  it("only ever raises seen", () => {
    expect(shouldMarkSeen(t({ turn: 3, labels: { "lumbridge.seen": "3" } }))).toBe(false);
    expect(shouldMarkSeen(t({ turn: 4, labels: { "lumbridge.seen": "3" } }))).toBe(true);
    expect(shouldMarkSeen(t({ turn: 4, labels: { "lumbridge.seen": "9" } }))).toBe(false);
    expect(shouldMarkSeen(t({ turn: 0 }))).toBe(true);
  });
});
