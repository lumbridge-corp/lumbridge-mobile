import { describe, expect, it, vi } from "vitest";
import { applyEvent, onDoc, setSnapshot } from "./app";
import type { Terminal } from "./core";
import {
  addressesIn, favoritesIn, findPanes, isDefaultName, isGenericName, lastSegment, listAll, looseNeeds, matchesWords, needsYou, paneKind, paneLabel, paneNames,
  parseDoc, parseRecent, programOf, pushRecent, qualify, queryWords, recentIn, shares, startsOpen, tally,
} from "./panes-logic";
import { originAfter } from "./router";

const block = (id: string, terminal: string, weight?: number) => ({ id, type: "block", content: { terminal }, ...(weight ? { size: { weight } } : {}) });
const doc = (root: unknown) => ({ spaces: [{ id: "s", name: "Work", folder: "/work", tabs: [{ id: "t", name: "Tab", root }] }] });
const term = (address: string, over: Partial<Terminal> = {}): Terminal => ({ address, state: "live", cols: 80, rows: 24, ...over });
const boxesOf = (root: unknown, machine: string | null = null) => parseDoc(doc(root), machine)[0].tabs[0].boxes;
const near = (a: { x: number; y: number; w: number; h: number }, x: number, y: number, w: number, h: number) => {
  for (const [p, q] of [[a.x, x], [a.y, y], [a.w, w], [a.h, h]]) expect(p).toBeCloseTo(q);
};

describe("addresses", () => {
  it("qualifies a remote pane and leaves a local one alone, as mirror.rs does", () => {
    expect(qualify("t13", "gpu")).toBe("gpu/t13");
    expect(qualify("t13", null)).toBe("t13");
  });
  it("joins a document to terminals by that address", () => {
    const [s] = parseDoc(doc({ type: "row", children: [block("a", "t13")] }), "gpu");
    expect(addressesIn(s)).toEqual(["gpu/t13"]);
    expect(parseDoc(doc(block("a", "t13")), null)[0].tabs[0].panes[0].address).toBe("t13");
  });
});

describe("the real layout shape", () => {
  // From a live document: a row holding a pane, a column of two, and a thin third.
  const root = {
    id: "tb1", type: "row", children: [
      block("p1", "t13", 0.45),
      { id: "s1", type: "column", size: { weight: 0.44 }, children: [block("p2", "t2w", 0.4), block("p3", "t30", 1.6)] },
      block("p4", "t2x", 0.11),
    ],
  };
  it("places every pane in proportion", () => {
    const b = boxesOf(root);
    expect(b.map((x) => x.pane.address)).toEqual(["t13", "t2w", "t30", "t2x"]);
    near(b[0], 0, 0, 0.45, 1);
    near(b[1], 0.45, 0, 0.44, 0.2);
    near(b[2], 0.45, 0.2, 0.44, 0.8);
    near(b[3], 0.89, 0, 0.11, 1);
  });
  it("covers the whole tab, with nothing overlapping or left out", () => {
    const area = boxesOf(root).reduce((a, b) => a + b.w * b.h, 0);
    expect(area).toBeCloseTo(1);
  });
  it("lists the panes in tree order", () => {
    expect(parseDoc(doc(root), "m")[0].tabs[0].panes.map((p) => p.address)).toEqual(["m/t13", "m/t2w", "m/t30", "m/t2x"]);
  });
  it("treats a missing size as a weight of 1", () => {
    const b = boxesOf({ type: "row", children: [block("a", "t1"), block("b", "t2")] });
    near(b[0], 0, 0, 0.5, 1);
    near(b[1], 0.5, 0, 0.5, 1);
  });
});

describe("other nodes", () => {
  const stack = { id: "st", type: "stack", active: "b", children: [block("a", "t1"), block("b", "t2"), block("c", "t3")] };
  it("draws a stack's active child, and lists all of it", () => {
    const [s] = parseDoc(doc(stack), null);
    expect(s.tabs[0].boxes.map((b) => b.pane.address)).toEqual(["t2"]);
    near(s.tabs[0].boxes[0], 0, 0, 1, 1);
    expect(s.tabs[0].panes.map((p) => p.address)).toEqual(["t1", "t2", "t3"]);
  });
  it("falls back to the first visible child when the active one is hidden or missing", () => {
    expect(boxesOf({ ...stack, active: "nope" }).map((b) => b.pane.id)).toEqual(["a"]);
    const hidden = { ...stack, children: [{ ...block("a", "t1"), hidden: true }, block("b", "t2")], active: "a" };
    expect(boxesOf(hidden).map((b) => b.pane.id)).toEqual(["b"]);
  });
  it("gives a hidden node's share to its siblings, and keeps it in the list", () => {
    const root = { type: "row", children: [block("a", "t1", 1), { ...block("b", "t2", 1), hidden: true }] };
    near(boxesOf(root)[0], 0, 0, 1, 1);
    expect(parseDoc(doc(root), null)[0].tabs[0].panes).toHaveLength(2);
  });
  it("names a mod panel, and it has no address", () => {
    const [s] = parseDoc(doc({ type: "row", children: [{ id: "m", type: "block", content: { mod: "notebook", props: { terminal: "t1" } } }] }), "gpu");
    expect(s.tabs[0].panes[0]).toEqual({ id: "m", address: null, title: "notebook" });
  });
  it("prefers a block's title, and copes with a tab or agent block", () => {
    const [s] = parseDoc(doc({ type: "row", children: [
      { id: "m", title: "Board", type: "block", content: { mod: "x" } },
      { id: "c", type: "block", content: { tab: "active" } },
      { id: "g", type: "block", content: { agent: "focused" } },
    ] }), null);
    expect(s.tabs[0].panes.map((p) => [p.address, p.title])).toEqual([[null, "Board"], [null, ""], [null, ""]]);
  });
  it("lists a floating terminal, off the map", () => {
    const [s] = parseDoc(doc({ type: "row", children: [block("a", "t1")], floating: [{ id: "f", content: { terminal: "t9" } }, { id: "g", content: { mod: "x" } }] }), "m");
    expect(s.tabs[0].panes.map((p) => p.address)).toEqual(["m/t9", "m/t1"]);
    expect(s.tabs[0].boxes).toHaveLength(1);
  });
  it("gives a fixed size its share against a nominal width", () => {
    const [a, b] = shares([{ size: { px: 240 } }, { size: { weight: 3 } }]);
    expect(a).toBeCloseTo(0.2);
    expect(b).toBeCloseTo(0.8);
    expect(shares([{ size: { px: 100 } }, { size: { px: 300 } }])).toEqual([0.25, 0.75]);
    expect(shares([{ size: { px: 99999 } }, {}])[0]).toBeCloseTo(0.8);
  });
  it("ignores a size that makes no sense", () => {
    for (const size of [{ weight: -1 }, { weight: 0 }, { weight: "9" }, { weight: null }, "big", null, { px: -5 }]) {
      expect(shares([{ size }, {}])).toEqual([0.5, 0.5]);
    }
  });
});

describe("a document is somebody's data", () => {
  it("reads nothing from anything that isn't one", () => {
    for (const v of [null, undefined, 7, "x", [], {}, { spaces: null }, { spaces: {} }, { spaces: 3 }]) expect(parseDoc(v, null)).toEqual([]);
  });
  it("skips junk and fills in what's missing", () => {
    const [s, ...rest] = parseDoc({ spaces: [7, null, { tabs: [5, { root: 3 }, { root: { type: "row", children: [8, null, { type: "block" }] } }] }] }, null);
    expect(rest).toEqual([]);
    expect(s.name).toBe("");
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs[0].panes).toEqual([]);
    expect(s.tabs[1].panes).toEqual([{ id: "", address: null, title: "" }]);
  });
  it("takes only strings as text and addresses", () => {
    const [s] = parseDoc({ spaces: [{ id: 3, name: {}, folder: [], tabs: [{ id: 1, name: 2, root: { id: 5, type: "block", title: 4, content: { terminal: 9, mod: 8 } } }] }] }, null);
    expect(s).toMatchObject({ name: "", folder: "" });
    expect(s.tabs[0].name).toBe("");
    expect(s.tabs[0].panes[0]).toEqual({ id: "", address: null, title: "" });
  });
  it("survives a tree too deep to be real", () => {
    let n: Record<string, unknown> = block("x", "t1");
    for (let i = 0; i < 5000; i++) n = { type: "row", children: [n] };
    const [s] = parseDoc(doc(n), null);
    expect(s.tabs[0].panes).toEqual([]);
    expect(s.tabs[0].boxes).toEqual([]);
  });
  it("stops counting at a tree too big to be real", () => {
    const children = Array.from({ length: 20000 }, (_, i) => block(`p${i}`, `t${i}`));
    const [s] = parseDoc(doc({ type: "row", children }), null);
    expect(s.tabs[0].panes.length).toBeLessThanOrEqual(4000);
  });
});

describe("joining against terminals", () => {
  const terms = new Map([
    ["t1", term("t1")],
    ["t2", term("t2", { state: "finished" })],
  ]);
  it("says what each pane is", () => {
    expect(paneKind({ id: "a", address: "t1", title: "" }, terms)).toBe("live");
    expect(paneKind({ id: "a", address: "t2", title: "" }, terms)).toBe("ended");
    expect(paneKind({ id: "a", address: "t3", title: "" }, terms)).toBe("gone");
    expect(paneKind({ id: "a", address: null, title: "x" }, terms)).toBe("panel");
  });
});

describe("needs you", () => {
  const spaces = parseDoc({ spaces: [
    { id: "s1", name: "One", tabs: [{ id: "t1", name: "A", root: { type: "row", children: [block("a", "t1"), block("b", "t2"), block("c", "t3")] } }] },
    { id: "s2", name: "Two", tabs: [{ id: "t2", name: "B", root: block("d", "t2") }] },
  ] }, null);
  const docs = [{ machine: null, spaces }];
  it("finds blocked and error panes, newest first, each once", () => {
    const terms = new Map([
      ["t1", term("t1", { status: { state: "blocked" }, status_ms: 10 })],
      ["t2", term("t2", { status: { state: "error" }, status_ms: 20 })],
      ["t3", term("t3", { status: { state: "working" }, status_ms: 30 })],
    ]);
    const found = needsYou(docs, terms);
    expect(found.map((p) => p.pane.address)).toEqual(["t2", "t1"]);
    expect(found[0].space.name).toBe("One");
    expect(found[1].tab.name).toBe("A");
  });
  it("skips ended and gone terminals, and panels", () => {
    const terms = new Map([["t1", term("t1", { state: "finished", status: { state: "blocked" } })]]);
    expect(needsYou(docs, terms)).toEqual([]);
    expect(needsYou([{ machine: null, spaces: parseDoc(doc({ type: "block", content: { mod: "x" } }), null) }], terms)).toEqual([]);
  });
  it("counts what a space holds, each terminal once", () => {
    const terms = new Map([
      ["t1", term("t1", { status: { state: "blocked" } })],
      ["t2", term("t2", { status: { state: "working" } })],
    ]);
    expect(tally(["t1", "t2", "t2", "t3"], terms)).toEqual({ panes: 2, needs: 1, working: 1, done: 0 });
  });
});

describe("folding", () => {
  it("opens a few spaces, and folds a lot of them", () => {
    expect(startsOpen(3)).toBe(true);
    expect(startsOpen(4)).toBe(false);
  });
});

describe("going back from a terminal", () => {
  it("returns to Panes only when it came from there", () => {
    expect(originAfter("panes", "agents")).toBe("panes");
    expect(originAfter("agents", "panes")).toBe("agents");
    expect(originAfter("notes", "panes")).toBe("agents");
  });
  it("keeps what it had from a terminal, or across a reload", () => {
    expect(originAfter("t/a", "panes")).toBe("panes");
    expect(originAfter("t/a", "agents")).toBe("agents");
    expect(originAfter(null, "panes")).toBe("panes");
  });
});

describe("document events", () => {
  it("hooks doc events, which have no terminal, with the machine they came from", () => {
    const seen: unknown[] = [];
    const off = onDoc((c) => seen.push(c));
    applyEvent({ method: "event", params: { seq: 1000, type: "doc", data: { name: "lumbridge-app", version: 2 } } });
    applyEvent({ method: "event", params: { seq: 1001, type: "doc", data: { name: "lumbridge-app", version: 3 }, machine: "gpu" } });
    expect(seen).toEqual([{ name: "lumbridge-app", machine: null }, { name: "lumbridge-app", machine: "gpu" }]);
    off();
    applyEvent({ method: "event", params: { seq: 1002, type: "doc", data: { name: "lumbridge-app", version: 4 } } });
    expect(seen).toHaveLength(2);
  });
  it("drops one already seen", () => {
    const fn = vi.fn();
    const off = onDoc(fn);
    applyEvent({ method: "event", params: { seq: 1, type: "doc", data: { name: "x" } } });
    expect(fn).not.toHaveBeenCalled();
    off();
  });
  it("asks for everything again on a snapshot and on `missed`, since snapshots carry no documents", () => {
    vi.stubGlobal("document", { hidden: true });
    const fn = vi.fn();
    const off = onDoc(fn);
    setSnapshot({ seq: 2000, terminals: [] });
    expect(fn).toHaveBeenLastCalledWith({ name: null, machine: null });
    applyEvent({ method: "missed", params: { seq: 2001, terminals: [] } });
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    vi.unstubAllGlobals();
  });
});

describe("what a pane is called", () => {
  const claude = (over: Partial<Terminal> = {}) => term("t1", { title: "Claude Code", status: { state: "idle", app: "claude-code" }, foreground: { name: "claude", cwd: "/home/sam/notes-app" }, ...over });
  it("takes your own name first, whatever else there is", () => {
    expect(paneLabel(claude({ name: "reviewer" }), { tab: "Docs" })).toBe("reviewer");
  });
  it("takes a title that means something, status first", () => {
    expect(paneLabel(claude({ title: "Mobile frontend options" }), { tab: "Docs" })).toBe("Mobile frontend options");
    expect(paneLabel(claude({ status: { state: "idle", title: "⠂ Fix the gate" } }))).toBe("Fix the gate");
  });
  it("knows a bare program name and a shell's prompt aren't names, from real titles", () => {
    for (const s of ["Claude Code", "✳ Claude Code", "bash", "hermes", "Codex", "sam@build-box: ~", "sam@build-box: ~/Desktop/Workie V2", "sam@gpu-box:~/models$", "me@box", "~/repos/x", "/tmp", "Claude Code v2.1.310", ""]) {
      expect(isGenericName(s.replace("✳ ", "")), s).toBe(true);
    }
    for (const s of ["Mobile frontend options", "Refactor the auth", "a@b: fix the thing", "Acme Website", "Bash script audit"]) {
      expect(isGenericName(s), s).toBe(false);
    }
  });
  it("counts whatever this terminal runs as its program", () => {
    const t = term("t1", { foreground: { name: "my-tool" }, status: { state: "idle", app: "other-app" } });
    expect(isGenericName("my-tool", t)).toBe(true);
    expect(isGenericName("Other App", t)).toBe(true);
    expect(isGenericName("my-tool")).toBe(false);
  });
  it("uses the desktop app's pane title, then the tab", () => {
    expect(paneLabel(claude(), { pane: "Review", tab: "Docs" })).toBe("Review");
    expect(paneLabel(claude(), { tab: "Docs" })).toBe("Docs");
  });
  it("skips a default tab or pane, for the folder", () => {
    for (const tab of ["Tab", "tab 2", "1", "shell", "Terminal", "New Tab", "", "  "]) {
      expect(isDefaultName(tab), tab).toBe(true);
      expect(paneLabel(claude(), { tab })).toBe("notes-app");
    }
    expect(isDefaultName("Tabby")).toBe(false);
    expect(isDefaultName("112 wind-down")).toBe(false);
  });
  it("doesn't take a tab that only names the program, until there's nothing else", () => {
    const hermes = term("t1", { title: "", foreground: { name: "hermes", cwd: "/home/sam/work" } });
    expect(paneLabel(hermes, { tab: "Hermes" })).toBe("work");
    expect(paneLabel({ ...hermes, foreground: { name: "hermes", cwd: "/home/sam" } }, { tab: "Hermes" })).toBe("Hermes");
  });
  it("falls back to the program, never a prompt, when home is all it knows", () => {
    expect(paneLabel(term("t1", { title: "sam@build-box: ~", foreground: { name: "bash", cwd: "/home/sam" } }))).toBe("bash");
    expect(paneLabel(claude({ foreground: { name: "claude", cwd: "/home/sam" } }), { tab: "1" })).toBe("Claude Code");
    expect(paneLabel(term("t7"))).toBe("t7");
  });
  it("finds the last part of a folder, and nothing in home", () => {
    expect(lastSegment("~/repos/gitea/acme")).toBe("acme");
    expect(lastSegment("~/Desktop/Workie V2/")).toBe("Workie V2");
    expect(lastSegment("~")).toBe("");
    expect(lastSegment("")).toBe("");
    expect(lastSegment("/")).toBe("");
  });
  it("says the program in a small word, while it runs", () => {
    expect(programOf(claude())).toBe("claude");
    expect(programOf(term("t", { foreground: { name: "bash" } }))).toBe("bash");
    expect(programOf(term("t", { state: "finished", foreground: { name: "bash" } }))).toBe("");
  });
});

describe("telling panes apart", () => {
  const docOf = (tabs: { name: string; panes: string[] }[]) => [{ machine: null, spaces: parseDoc({ spaces: [{ id: "s", name: "S", tabs: tabs.map((t, i) => ({ id: `t${i}`, name: t.name, root: { type: "row", children: t.panes.map((a) => block(`p${a}`, a)) } })) }] }, null) }];
  const claudeIn = (address: string, cwd: string) => term(address, { title: "Claude Code", foreground: { name: "claude", cwd } });
  const asMap = (...l: Terminal[]) => new Map(l.map((t) => [t.address, t]));
  it("numbers the two that were both 'Claude Code · ~/notes-app' under 'Tab'", () => {
    const names = paneNames(docOf([{ name: "Tab", panes: ["a", "b"] }]), asMap(claudeIn("a", "/home/sam/notes-app"), claudeIn("b", "/home/sam/notes-app")));
    expect([names.get("a"), names.get("b")]).toEqual(["notes-app 1", "notes-app 2"]);
  });
  it("uses a folder when that's what differs", () => {
    const names = paneNames(docOf([{ name: "Work", panes: ["a", "b"] }]), asMap(claudeIn("a", "/home/sam/x"), claudeIn("b", "/home/sam/y")));
    expect([names.get("a"), names.get("b")]).toEqual(["Work · x", "Work · y"]);
  });
  it("uses a tab when that's what differs", () => {
    const named = (a: string) => term(a, { name: "reviewer", cwd: "/home/sam/same" });
    const names = paneNames(docOf([{ name: "One", panes: ["a"] }, { name: "Two", panes: ["b"] }]), asMap(named("a"), named("b")));
    expect([names.get("a"), names.get("b")]).toEqual(["reviewer · One", "reviewer · Two"]);
  });
  it("leaves the last one bare when the others already differ from it", () => {
    const names = paneNames(docOf([{ name: "Acme", panes: ["a", "b"] }]), asMap(claudeIn("a", "/home/sam"), claudeIn("b", "/home/sam/mods")));
    expect([names.get("a"), names.get("b")]).toEqual(["Acme", "Acme · mods"]);
  });
  it("mixes them when only some differ", () => {
    const names = paneNames(docOf([{ name: "W", panes: ["a", "b", "c"] }]), asMap(claudeIn("a", "/home/sam"), claudeIn("b", "/home/sam"), claudeIn("c", "/home/sam/mods")));
    expect([...names.values()]).toEqual(["W 1", "W 2", "W · mods"]);
  });
  it("only compares within a space, and names a terminal once", () => {
    const doc = [{ machine: null, spaces: parseDoc({ spaces: ["A", "B"].map((n) => ({ id: n, name: n, tabs: [{ id: n, name: "Work", root: block(n, n === "A" ? "a" : "b") }, { id: `${n}2`, name: "Other", root: block(`${n}2`, "a") }] })) }, null) }];
    const names = paneNames(doc, asMap(claudeIn("a", "/home/sam"), claudeIn("b", "/home/sam")));
    expect([names.get("a"), names.get("b")]).toEqual(["Work", "Work"]);
  });
  it("doesn't read a repeat as a difference by its own name", () => {
    const named = (a: string) => term(a, { name: "One" });
    const names = paneNames(docOf([{ name: "One", panes: ["a", "b"] }]), asMap(named("a"), named("b")));
    expect([names.get("a"), names.get("b")]).toEqual(["One 1", "One 2"]);
  });
});

describe("favorites and recent", () => {
  const docs = [{ machine: "m", spaces: parseDoc({ spaces: [{ id: "s", name: "S", tabs: [{ id: "t", name: "T", root: { type: "row", children: [block("a", "t1"), block("b", "t2"), block("c", "t3"), { id: "m", type: "block", content: { mod: "x" } }] } }] }] }, "m") }];
  const pinned = { labels: { "lumbridge.pinned": "1" } };
  const terms = new Map([
    ["m/t1", term("m/t1", pinned)], ["m/t2", term("m/t2")], ["m/t3", term("m/t3", { state: "finished", ...pinned })],
    ["loose", term("loose", pinned)], ["other/t9", term("other/t9")], ["dead", term("dead", { state: "finished" })],
  ]);
  const all = listAll(docs, terms);
  it("lists what can be opened, placed ones first, and a live terminal no layout has", () => {
    expect(all.map((x) => x.terminal.address)).toEqual(["m/t1", "m/t2", "m/t3", "loose", "other/t9"]);
    expect(all[3]).toMatchObject({ machine: null });
    expect(all[3].space).toBeUndefined();
    expect(all[4].machine).toBe("other");
    expect(all[0].space?.name).toBe("S");
  });
  it("finds what needs the owner outside any layout, and only that", () => {
    const t = new Map([["m/t1", term("m/t1", { status: { state: "blocked" } })], ["x", term("x", { status: { state: "error" } })], ["y", term("y")], ["z", term("z", { state: "finished", status: { state: "blocked" } })]]);
    expect(looseNeeds(listAll(docs, t)).map((v) => v.terminal.address)).toEqual(["x"]);
  });
  it("a favorite is a live terminal labelled lumbridge.pinned", () => {
    expect(favoritesIn(all).map((x) => x.terminal.address)).toEqual(["m/t1", "loose"]);
    expect(favoritesIn(listAll([], new Map([["a", term("a", { labels: { "lumbridge.pinned": "" } })]])))).toEqual([]);
  });
  it("keeps the newest first, each once", () => {
    expect(pushRecent(pushRecent(["a", "b"], "c"), "a")).toEqual(["a", "c", "b"]);
    let l: string[] = [];
    for (let i = 0; i < 40; i++) l = pushRecent(l, `t${i}`);
    expect(l.length).toBe(20);
    expect(l[0]).toBe("t39");
  });
  it("shows five, dropping ones gone, without leaving it short", () => {
    const many = new Map(Array.from({ length: 9 }, (_, i) => [`t${i}`, term(`t${i}`)]));
    const every = listAll([], many);
    expect(recentIn(["gone", "t1", "t2", "t3", "t4", "t5", "t6"], every).map((x) => x.terminal.address)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(recentIn(["t1", "t2", "t3"], every, ["t2"]).map((x) => x.terminal.address)).toEqual(["t1", "t3"]);
    expect(recentIn([], every)).toEqual([]);
  });
  it("reads anything back from storage without trouble", () => {
    for (const raw of [null, "", "{", "7", "{}", "null"]) expect(parseRecent(raw)).toEqual([]);
    expect(parseRecent(JSON.stringify(["a", 3, null, "a", "", "b", "x".repeat(300)]))).toEqual(["a", "b"]);
  });
});

describe("search", () => {
  const docs = [
    { machine: null, spaces: parseDoc({ spaces: [{ id: "s", name: "Acme", tabs: [{ id: "t", name: "Gateway work", root: block("a", "t1") }] }] }, null) },
    { machine: "gpu", spaces: parseDoc({ spaces: [{ id: "s", name: "Muxin", tabs: [{ id: "t", name: "Render", root: { type: "row", children: [block("a", "t1"), block("b", "t2")] } }] }] }, "gpu") },
  ];
  const terms = new Map([
    ["t1", term("t1", { name: "gateway-review", cwd: "/home/sam/repos/gitea/acme-app" })],
    ["gpu/t1", term("gpu/t1", { name: "muxin-render", cwd: "/home/alex/muxin", foreground: { name: "bash" } })],
    ["gpu/t2", term("gpu/t2", { name: "Résumé", cwd: "/home/alex/muxin", status: { state: "blocked" } })],
  ]);
  const all = listAll(docs, terms);
  const find = (q: string) => findPanes(q, all, (t) => t.name ?? "").map((x) => x.terminal.address);
  it("searches name, tab, space, machine and folder", () => {
    expect(find("gateway-rev")).toEqual(["t1"]);
    expect(find("gateway work")).toEqual(["t1"]);
    expect(find("acme")).toEqual(["t1"]);
    expect(find("server")).toEqual(["t1"]);
    expect(find("gpu")).toEqual(["gpu/t2", "gpu/t1"]);
    expect(find("gitea")).toEqual(["t1"]);
    expect(find("bash")).toEqual(["gpu/t1"]);
  });
  it("needs every word, in any order and any field", () => {
    expect(find("render gpu")).toEqual(["gpu/t2", "gpu/t1"]);
    expect(find("gpu review")).toEqual([]);
    expect(find("RENDER   MUXIN-")).toEqual(["gpu/t1"]);
  });
  it("ignores case and accents", () => {
    expect(find("resume")).toEqual(["gpu/t2"]);
    expect(queryWords("  Résumé  KO ")).toEqual(["resume", "ko"]);
  });
  it("finds nothing for nothing, without throwing on what's missing", () => {
    expect(find("")).toEqual([]);
    expect(find("   ")).toEqual([]);
    expect(matchesWords(["a"], [null, undefined, ""])).toBe(false);
    expect(matchesWords([], [])).toBe(true);
  });
  it("takes a regex character as itself", () => {
    expect(find(".*")).toEqual([]);
    expect(find("(")).toEqual([]);
  });
  it("puts what needs the owner first, and what has ended last", () => {
    const t = new Map([["a", term("a", { name: "x" })], ["b", term("b", { name: "x", state: "finished" })], ["c", term("c", { name: "x", status: { state: "error" } })]]);
    const d = [{ machine: null, spaces: parseDoc({ spaces: [{ id: "s", tabs: [{ id: "t", root: { type: "row", children: ["a", "b", "c"].map((a) => block(a, a)) } }] }] }, null) }];
    expect(findPanes("x", listAll(d, t), (v) => v.name ?? "").map((v) => v.terminal.address)).toEqual(["c", "a", "b"]);
  });
});
