import { describe, expect, it } from "vitest";
import { fold, rank, score, step, type Item } from "./palette-logic";

const screen = (label: string, also?: string[]): Item => ({ href: `#/${label.toLowerCase()}`, label, also, hint: "Screen", kind: "screen" });
const agent = (label: string): Item => ({ href: `#/t/${label}`, label, hint: "Server", kind: "agent" });
const ITEMS = [
  screen("Agents"), screen("Assistant"), screen("Tasks"), screen("Thoughts"), screen("Notes"), screen("Music"), screen("TV"),
  screen("Social"), screen("Files"), screen("Infra", ["Infrastructure"]), screen("Tools", ["Assistant's tools"]), screen("Settings"),
  agent("gateway-review"), agent("token-refresh"), agent("Notes sync fix"), agent("tv-wall"),
];
const labels = (q: string) => rank(ITEMS, q).map((i) => i.label);

describe("fold", () => {
  it("drops case and accents", () => {
    expect(fold("  Café ")).toBe("cafe");
    expect(fold("HELLO")).toBe("hello");
  });
});

describe("score", () => {
  it("ranks the whole name over its start, a word's start, anywhere, and letters in order", () => {
    const s = (t: string, q: string) => score(t, fold(q));
    expect(s("Notes", "notes")).toBeGreaterThan(s("Notes sync fix", "notes"));
    expect(s("Notes sync fix", "notes")).toBeGreaterThan(s("Assistant's tools", "tools"));
    expect(s("Assistant's tools", "tools")).toBeGreaterThan(s("Settings", "ttin"));
    expect(s("Settings", "ttin")).toBeGreaterThan(s("gateway-review", "gwr"));
    expect(s("gateway-review", "gwr")).toBeGreaterThan(0);
    expect(s("Music", "zz")).toBe(0);
  });
  it("finds letters in order only", () => {
    expect(score("Tasks", "kst")).toBe(0);
    expect(score("Tasks", "tsk")).toBeGreaterThan(0);
  });
  it("scores closer letters higher", () => {
    expect(score("token-refresh", "tok")).toBeGreaterThan(score("token-refresh", "trf"));
    expect(score("token-refresh", "tre")).toBeGreaterThan(score("token-refresh", "tnh"));
  });
});

describe("rank", () => {
  it("gives everything, in order, for nothing typed", () => {
    expect(labels("")).toEqual(ITEMS.map((i) => i.label));
    expect(labels("   ")).toEqual(ITEMS.map((i) => i.label));
  });
  it("puts the best match first", () => {
    expect(labels("no")[0]).toBe("Notes");
    expect(labels("set")[0]).toBe("Settings");
    expect(labels("tv")).toEqual(["TV", "tv-wall"]);
  });
  it("keeps a screen before an agent that scores the same", () => {
    expect(labels("notes").slice(0, 2)).toEqual(["Notes", "Notes sync fix"]);
  });
  it("finds a screen by its other name, below one whose own name it is", () => {
    expect(labels("assistant")).toEqual(["Assistant", "Tools"]);
    expect(labels("infrastructure")).toEqual(["Infra"]);
  });
  it("finds agents by letters in order", () => {
    expect(labels("gwr")).toEqual(["gateway-review"]);
  });
  it("finds nothing for nonsense, and stops at the limit", () => {
    expect(labels("qqqq")).toEqual([]);
    expect(rank(ITEMS, "", 3)).toHaveLength(3);
  });
});

describe("step", () => {
  it("wraps both ways, and has nowhere to go in an empty list", () => {
    expect(step(0, 1, 3)).toBe(1);
    expect(step(2, 1, 3)).toBe(0);
    expect(step(0, -1, 3)).toBe(2);
    expect(step(0, 1, 0)).toBe(-1);
  });
});
