import { describe, expect, it, vi } from "vitest";
import type { Bucket, Terminal } from "./core";
import { fmtAge, layoutInbox, machinesIn, shortFolder, summarize } from "./inbox";

vi.stubGlobal("document", { hidden: true });
const { askFromScreen, choicesFromScreen, cleanTitle, labelOf, machineOf } = await import("./app");

const t = (address: string, o: Partial<Terminal> = {}): Terminal =>
  ({ address, state: "live", cols: 80, rows: 24, status: { state: "idle" }, reported: true, ...o });

const keys = (ts: Terminal[], o = {}) =>
  layoutInbox(ts, { machine: null, byMachine: false, ...o }).map((g) => [g.key, g.rows.map((r) => r.address)]);

describe("inbox layout", () => {
  it("orders needs, done, working, idle and leaves empty groups out", () => {
    const got = keys([
      t("a", { status: { state: "working" } }),
      t("b", { status: { state: "blocked" } }),
      t("c", { status: { state: "done" }, turn: 2, labels: { "lumbridge.seen": "1" } }),
      t("d"),
    ]);
    expect(got.map((g) => g[0])).toEqual(["needs", "done", "working", "idle"]);
    expect(keys([t("a", { status: { state: "working" } })]).map((g) => g[0])).toEqual(["working"]);
  });
  it("puts pinned rows first, then newest", () => {
    const got = keys([
      t("old", { status: { state: "blocked" }, status_ms: 1 }),
      t("new", { status: { state: "blocked" }, status_ms: 9 }),
      t("pin", { status: { state: "blocked" }, status_ms: 0, labels: { "lumbridge.pinned": "1" } }),
    ]);
    expect(got[0][1]).toEqual(["pin", "new", "old"]);
  });
  it("keeps Working stable when one changes", () => {
    const a = t("a", { status: { state: "working" }, created_ms: 1, status_ms: 5 });
    const b = t("b", { status: { state: "working" }, created_ms: 2, status_ms: 9 });
    expect(keys([b, a])[0][1]).toEqual(["a", "b"]);
    a.status_ms = 100;
    expect(keys([b, a])[0][1]).toEqual(["a", "b"]);
  });
  it("collapses shells into their own group, and hides finished terminals", () => {
    const got = layoutInbox([t("s", { status: null, reported: false }), t("x", { state: "finished" })], { machine: null, byMachine: false });
    expect(got.map((g) => [g.key, g.collapsible, g.rows.length])).toEqual([["shells", true, 1]]);
  });
  it("filters by machine", () => {
    const got = keys([t("gpu/t1"), t("t2"), t("build-box/t3")], { machine: "gpu" });
    expect(got).toEqual([["idle", ["gpu/t1"]]]);
  });
  it("groups by machine with the most urgent first", () => {
    const got = keys([t("gpu/i"), t("gpu/n", { status: { state: "blocked" } }), t("e", { status: { state: "working" } })], { byMachine: true });
    expect(got).toEqual([["machine:local", ["e"]], ["machine:gpu", ["gpu/n", "gpu/i"]]]);
  });
  it("holds an open done row in Done after it's marked seen", () => {
    const row = t("a", { turn: 3, labels: { "lumbridge.seen": "3" } });
    const holds = new Map<string, Bucket>([["a", "done"]]);
    expect(keys([row], { holds })[0][0]).toBe("done");
    expect(keys([row])[0][0]).toBe("idle");
    row.status = { state: "blocked" };
    expect(keys([row], { holds })[0][0]).toBe("needs");
  });
  it("lists the machines with this one first", () => {
    expect(machinesIn([t("gpu/a"), t("b"), t("build-box/c")])).toEqual(["local", "build-box", "gpu"]);
  });
  it("summarizes agents, not shells", () => {
    const s = summarize([t("a", { status: { state: "blocked" } }), t("s", { status: null, reported: false })]);
    expect(s).toMatchObject({ needs: 1, agents: 1 });
  });
});

describe("row text", () => {
  it("formats ages", () => {
    expect([fmtAge(-5), fmtAge(30e3), fmtAge(90e3), fmtAge(3 * 3600e3), fmtAge(72 * 3600e3)]).toEqual(["now", "now", "1m", "3h", "3d"]);
  });
  it("keeps the end of a long folder", () => {
    expect(shortFolder("~/repos/x")).toBe("~/repos/x");
    expect(shortFolder("~/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t").startsWith("…/")).toBe(true);
    expect(shortFolder("~/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t").length).toBeLessThanOrEqual(36);
  });
  it("drops spinner glyphs and emoji from titles", () => {
    expect(cleanTitle("✳ Fix login")).toBe("Fix login");
    expect(cleanTitle("⠂ Fix login")).toBe("Fix login");
    expect(cleanTitle("~/repos/x")).toBe("~/repos/x");
    expect(cleanTitle("Ship it 🚀")).toBe("Ship it");
    expect(cleanTitle(null)).toBe("");
  });
  it("names a row by name, then title, then program", () => {
    expect(labelOf(t("a", { name: "api", title: "x" }))).toBe("api");
    expect(labelOf(t("a", { title: "✳ x" }))).toBe("x");
    expect(labelOf(t("a", { title: "", foreground: { name: "node" } }))).toBe("node");
    expect(machineOf(t("gpu/t2"))).toBe("gpu");
    expect(machineOf(t("t2"))).toBe("local");
  });
});

describe("what a blocked agent is asking", () => {
  it("finds the question above a box and its choices", () => {
    const screen = "lots of output\n╭──────────╮\n│ Apply this edit to main.rs?  │\n│ ❯ 1. Yes │\n│   2. No  │\n╰──────────╯\n  esc to cancel\n";
    expect(askFromScreen(screen)).toBe("Apply this edit to main.rs?");
  });
  it("takes the line above the first choice when nothing ends in a question mark", () => {
    expect(askFromScreen("Pick a branch\n1. main\n2. dev")).toBe("Pick a branch");
  });
  it("falls back to the last line, and survives an empty screen", () => {
    expect(askFromScreen("one\ntwo\n\n")).toBe("two");
    expect(askFromScreen("\n\n")).toBe("");
  });
});

describe("choicesFromScreen", () => {
  const menu = "Do you want to make this edit?\n ❯ 1. Yes\n   2. Yes, allow all edits (shift+tab)\n   3. No, and tell Claude what to do (esc)\n";
  it("reads a numbered menu with its labels", () => {
    expect(choicesFromScreen(menu)).toEqual([
      { key: "1", label: "Yes" },
      { key: "2", label: "Yes, allow all edits (shift+tab)" },
      { key: "3", label: "No, and tell Claude what to do (esc)" },
    ]);
  });
  it("reads one inside a box, with a footer under it", () => {
    expect(choicesFromScreen("╭───╮\n│ Which branch? │\n│ ❯ 1. main │\n│   2. dev │\n╰───╯\n esc to cancel").map((c) => c.label)).toEqual(["main", "dev"]);
  });
  it("takes the last menu on the screen", () => {
    expect(choicesFromScreen("1. old\n2. older\nsome output\n1) new\n2) newer").map((c) => c.label)).toEqual(["new", "newer"]);
  });
  it("offers nothing when it isn't sure", () => {
    for (const bad of ["", "no menu here", "1. only one", "1. a\n3. skipped", "2. a\n3. b", "1. a\nsomething\n2. b",
      `1. old\n2. older\n${"filler\n".repeat(20)}`]) {
      expect(choicesFromScreen(bad)).toEqual([]);
    }
  });
});
