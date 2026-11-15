import { describe, expect, it } from "vitest";
import { axisLock, damp, follow, nextVelocity, quickFlick, releaseVelocity, settleMs, snapsOpen } from "./drawer-logic";

describe("velocity", () => {
  it("smooths, weighing the latest sample at 0.7", () => {
    expect(nextVelocity(0, 10, 10)).toBeCloseTo(0.7);
    expect(nextVelocity(1, 20, 10)).toBeCloseTo(1.7);
  });
  it("ignores a gap of 100 ms or more, and a sample with no time in it", () => {
    expect(nextVelocity(0.5, 300, 100)).toBe(0.5);
    expect(nextVelocity(0.5, 300, 5000)).toBe(0.5);
    expect(nextVelocity(0.5, 300, 0)).toBe(0.5);
  });
  it("a finger that stopped before lifting has no speed", () => {
    expect(releaseVelocity(2, 16)).toBe(2);
    expect(releaseVelocity(2, 100)).toBe(0);
  });
});

describe("axis", () => {
  it("decides nothing inside 10 px", () => {
    expect(axisLock(9, 9)).toBeNull();
    expect(axisLock(-3, 2)).toBeNull();
  });
  it("then goes with the bigger move", () => {
    expect(axisLock(0, 10)).toBe("y");
    expect(axisLock(0, -10)).toBe("y");
    expect(axisLock(10, 2)).toBe("x");
    expect(axisLock(-12, 11)).toBe("x");
    expect(axisLock(10, 10)).toBe("y");
  });
});

describe("following the finger", () => {
  it("is exact below open", () => {
    expect(follow(0)).toBe(0);
    expect(follow(123)).toBe(123);
  });
  it("damps past open, from nothing, and never comes back through it", () => {
    expect(damp(0)).toBe(0);
    expect(damp(6)).toBe(0); // 8(ln 7 - 2) is still negative
    expect(follow(-5)).toBeCloseTo(0);
    expect(follow(-100)).toBeCloseTo(-8 * (Math.log(101) - 2));
    expect(follow(-400)).toBeLessThan(follow(-100));
    expect(follow(-400)).toBeGreaterThan(-400 / 4);
  });
});

describe("where it lands", () => {
  it("goes to the nearer end when it's let go still", () => {
    expect(snapsOpen(100, 0, 300)).toBe(true);
    expect(snapsOpen(151, 0, 300)).toBe(false);
  });
  it("counts a flick by where it would be in 350 ms", () => {
    expect(snapsOpen(30, 1, 300)).toBe(false);   // 380: closes from near the top
    expect(snapsOpen(280, -1, 300)).toBe(true);  // -70: opens from near the bottom
    expect(snapsOpen(100, 0.1, 300)).toBe(true); // 135: slow drift stays
  });
  it("a fast flick goes its own way, however tall the sheet", () => {
    expect(snapsOpen(17, 0.6, 600)).toBe(false); // 227 would stay open by position alone
    expect(snapsOpen(17, 0.6, 300)).toBe(false);
    expect(snapsOpen(560, -0.6, 600)).toBe(true);
    expect(snapsOpen(17, 0.39, 600)).toBe(true); // slower than a flick: position decides
  });
  it("a short, quick touch is a flick, however slowly its moves were sampled", () => {
    expect(quickFlick(34, 120, 10)).toBe(1);   // the 34 px flick, even on a slow runner
    expect(quickFlick(-60, 200, 10)).toBe(-1);
    expect(quickFlick(34, 300, 10)).toBe(0);   // too long: speed and position decide
    expect(quickFlick(12, 80, 10)).toBe(0);    // too small
    expect(quickFlick(34, 200, 120)).toBe(0);  // stopped before it lifted
  });
  // DESIGN.md caps motion at 200 ms, drawers included (#50): the spec moved from 400-500 ms to 150-200 ms.
  it("settles in 150 to 200 ms, whatever the speed", () => {
    expect(settleMs(300, 2)).toBe(150);
    expect(settleMs(150, 0.75)).toBeCloseTo(150 / 0.825);
    expect(settleMs(300, 0.1)).toBe(200);
    expect(settleMs(300, -2)).toBe(150);
    expect(settleMs(-300, 2)).toBe(150);
    expect(settleMs(300, 0)).toBe(200);
    expect(settleMs(0, 0)).toBe(200);
    expect(settleMs(0, 2)).toBe(150);
  });
});
