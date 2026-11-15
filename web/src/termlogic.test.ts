import { afterEach, describe, expect, it, vi } from "vitest";
import { NOT_SENT, SEND_LIMIT_MS, SENT_LATE, UNCONFIRMED_MS, clampFont, clearAfterSend, confirmer, defaultView, fitFont, followTop, isFollowing, keyGaps, keyLayout, loadView, readFont, reflow, saveView, unconfirmed, viewportPlan, withinLimit } from "./termlogic";
import { NS } from "./ns";

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

describe("key bar", () => {
  it("offers a menu's numbers first, only as many as it has, then Esc and Enter", () => {
    expect(keyLayout(3).slice(0, 5)).toEqual(["1", "2", "3", "esc", "enter"]);
    expect(keyLayout(2).slice(0, 4)).toEqual(["1", "2", "esc", "enter"]);
    expect(keyLayout(5).slice(0, 7)).toEqual(["1", "2", "3", "4", "5", "esc", "enter"]);
  });
  it("otherwise is for moving around a program, with no numbers", () => {
    expect(keyLayout(0)).toEqual(["esc", "up", "down", "enter", "tab", "left", "right", "space", "backspace", "shift+tab", "ctrl+c", "ctrl+d", "ctrl+o", "ctrl+r", "ctrl+l"]);
  });
  it("loses nothing and repeats nothing with a menu up", () => {
    const k = keyLayout(3);
    expect(new Set(k).size).toBe(k.length);
    for (const key of keyLayout(0)) expect(k).toContain(key);
  });
  it("gaps after a menu's numbers and before the Ctrl keys, nowhere else", () => {
    const k = keyLayout(3);
    expect([...keyGaps(k)].map((i) => k[i])).toEqual(["esc", "ctrl+c"]);
    const plain = keyLayout(0);
    expect([...keyGaps(plain)].map((i) => plain[i])).toEqual(["ctrl+c"]);
  });
});

describe("viewport", () => {
  it("rides the grid through history when the grid is taller than the view", () => {
    const p = { viewH: 500, cellH: 10, rows: 60, baseY: 1000 };
    expect(viewportPlan({ ...p, scrollTop: 0 })).toEqual({ line: 0, top: 0, height: 10600 });
    expect(viewportPlan({ ...p, scrollTop: 1234 })).toMatchObject({ line: 123, top: 1230 });
    // Past the last history line the grid stops moving and the view slides over it.
    expect(viewportPlan({ ...p, scrollTop: 10100 })).toMatchObject({ line: 1000, top: 10000 });
  });
  it("pins the grid to the view when the view is taller", () => {
    const p = { viewH: 800, cellH: 4, rows: 50, baseY: 100 };
    expect(viewportPlan({ ...p, scrollTop: 200 })).toEqual({ line: 50, top: 200, height: 1200 });
    expect(viewportPlan({ ...p, scrollTop: 400 })).toEqual({ line: 100, top: 400, height: 1200 });
  });
  it("follows the last used line, not the blank grid below it", () => {
    const p = { cellH: 10, viewH: 500, contentH: 1200, rows: 60, baseY: 60 };
    expect(followTop({ ...p, lastUsedLine: 10 })).toBe(0);
    expect(followTop({ ...p, lastUsedLine: 90 })).toBe(415);
    expect(followTop({ ...p, lastUsedLine: 200 })).toBe(700);
  });
  it("shows the last screen when the whole grid fits in the view", () => {
    // A 50-row pane on a tall monitor: the newest lines must be on screen, not lines from before them.
    const got = followTop({ lastUsedLine: 169, cellH: 16, viewH: 1240, contentH: 120 * 16 + 1240, rows: 50, baseY: 120 });
    expect(got).toBe(120 * 16);
    expect(viewportPlan({ scrollTop: got, viewH: 1240, cellH: 16, rows: 50, baseY: 120 }).line).toBe(120);
  });
  it("pauses following only when clearly scrolled up", () => {
    expect(isFollowing(400, 410, 10)).toBe(true);
    expect(isFollowing(380, 410, 10)).toBe(false);
    expect(isFollowing(900, 410, 10)).toBe(true);
  });
  it("fits a wide pane to the width", () => {
    expect(fitFont(390, 220, 0.6)).toBeCloseTo(2.94, 1);
    expect(fitFont(3000, 80, 0.6)).toBe(24);
    expect(clampFont(1)).toBe(5);
    expect(clampFont(11.3)).toBe(11.5);
  });
  it("reads at a size on the type scale, two px over the pan font", () => {
    expect([5, 10, 11, 11.5, 12, 13, 14, 15, 16, 17, 24].map(readFont)).toEqual([12, 12, 13, 13, 14, 14, 16, 16, 18, 18, 20]);
  });
});

describe("remembered view state", () => {
  it("round-trips per terminal", () => {
    const s = mem();
    saveView("gpu/t1", { ...defaultView(true), mode: "read", font: 14, draft: "half a th" }, s, 1);
    expect(loadView("gpu/t1", true, s)).toMatchObject({ mode: "read", font: 14, draft: "half a th" });
  });
  it("starts a new terminal at the last chosen size, with nothing else carried over", () => {
    const s = mem();
    saveView("a", { ...defaultView(true), mode: "read", font: 9, draft: "x" }, s, 1);
    saveView("b", { ...defaultView(true), font: 14 }, s, 2);
    expect(loadView("c", true, s)).toMatchObject({ mode: "pan", font: 14, draft: "" });
  });
  it("forgets the oldest past the cap", () => {
    const s = mem();
    for (let i = 0; i < 65; i++) saveView(`t${i}`, defaultView(false), s, i);
    const all = JSON.parse(s.getItem(`${NS}.view`)!);
    expect(Object.keys(all).length).toBe(60);
    expect(all.t0).toBeUndefined();
    expect(all.t64).toBeDefined();
  });
  it("survives junk and no storage", () => {
    const s = mem();
    s.setItem(`${NS}.view`, "{not json");
    expect(loadView("a", true, s).font).toBe(11);
    expect(loadView("a", false, null).font).toBe(13);
  });
});

describe("read mode", () => {
  it("rejoins wrapped lines and strips side rules", () => {
    const got = reflow([
      { text: "A long sentence that ", wrapped: false },
      { text: "kept going.   ", wrapped: true },
      { text: "╭───────╮", wrapped: false },
      { text: "│ inside │", wrapped: false },
      { text: "╰───────╯", wrapped: false },
    ]);
    expect(got).toBe("A long sentence that kept going.\n\ninside");
  });
  it("collapses blank runs and ends without blanks", () => {
    const blank = { text: "", wrapped: false };
    expect(reflow([blank, { text: "a", wrapped: false }, blank, blank, blank, { text: "b", wrapped: false }, blank])).toBe("a\n\nb");
  });
});

describe("Ctrl-C confirm", () => {
  it("needs a second tap inside the window", () => {
    let now = 0;
    const c = confirmer(2000, () => now);
    expect(c.tap()).toBe("armed");
    now = 1000;
    expect(c.tap()).toBe("send");
    expect(c.tap()).toBe("armed");
    now = 4000;
    expect(c.tap()).toBe("armed");
  });
});

describe("a send that may never answer", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("gives the answer when it comes in time", async () => {
    await expect(withinLimit(Promise.resolve(7), 50)).resolves.toEqual({ ok: true, value: 7 });
    await expect(withinLimit(Promise.reject(new Error("no such terminal")), 50)).resolves.toEqual({ ok: false, error: new Error("no such terminal") });
  });
  it("says late once the limit passes, and a late answer doesn't change that", async () => {
    vi.useFakeTimers();
    let answer!: (v: number) => void;
    const r = withinLimit(new Promise<number>((ok) => { answer = ok; }), SEND_LIMIT_MS);
    await vi.advanceTimersByTimeAsync(SEND_LIMIT_MS - 1);
    let settled = false;
    void r.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    answer(1);
    await expect(r).resolves.toBe("late");
  });
  it("is a little over the 10 s core gets", () => {
    expect(SEND_LIMIT_MS).toBeGreaterThan(10000);
    expect(SEND_LIMIT_MS).toBeLessThanOrEqual(15000);
  });
  it("empties the box only if it still holds what went", () => {
    expect(clearAfterSend("hello", "hello")).toBe(true);
    expect(clearAfterSend("hello, and more", "hello")).toBe(false);
    expect(clearAfterSend("", "hello")).toBe(false);
  });
});

describe("a send with no answer yet", () => {
  it("holds Send back only while the box holds exactly that text", () => {
    const u = unconfirmed("ls -la");
    expect(u.holds("ls -la")).toBe(true);
    expect(u.holds("ls -l")).toBe(false);
    expect(u.holds("ls -la ")).toBe(false);
  });
  it("lets go for good once the text is edited, even if it's edited back", () => {
    const u = unconfirmed("ls -la");
    u.edited("ls -la");
    expect(u.holds("ls -la")).toBe(true);
    u.edited("ls -l");
    expect(u.holds("ls -l")).toBe(false);
    u.edited("ls -la");
    expect(u.holds("ls -la")).toBe(false);
  });
  it("delivered after all: empties the box if it still holds what went, and says so", () => {
    const u = unconfirmed("ls");
    expect(u.answered(true, "ls")).toEqual({ clear: true, say: SENT_LATE });
    expect(u.holds("ls")).toBe(false);
    expect(unconfirmed("ls").answered(true, "ls and more")).toEqual({ clear: false, say: null });
  });
  it("refused or failed: not sent, the text stays, Send comes back", () => {
    const u = unconfirmed("ls");
    expect(u.answered(false, "ls")).toEqual({ clear: false, say: NOT_SENT });
    expect(u.holds("ls")).toBe(false);
  });
  it("at the hard end counts as not sent, and an answer after it only clears on delivery", () => {
    expect(UNCONFIRMED_MS).toBeGreaterThan(SEND_LIMIT_MS);
    const u = unconfirmed("ls");
    expect(u.expired()).toBe(NOT_SENT);
    expect(u.holds("ls")).toBe(false);
    expect(u.expired()).toBe(null);
    expect(unconfirmed("ls").answered(false, "ls").say).toBe(NOT_SENT);
    const late = unconfirmed("ls");
    late.expired();
    expect(late.answered(false, "ls")).toEqual({ clear: false, say: null });
    const later = unconfirmed("ls");
    later.expired();
    expect(later.answered(true, "ls")).toEqual({ clear: true, say: SENT_LATE });
  });
  it("says nothing at the hard end once already answered or edited", () => {
    const a = unconfirmed("ls");
    a.answered(true, "ls");
    expect(a.expired()).toBe(null);
    const e = unconfirmed("ls");
    e.edited("pwd");
    expect(e.expired()).toBe(null);
  });
});
