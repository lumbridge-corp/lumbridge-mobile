import { describe, expect, it } from "vitest";
import type { Task } from "./data/tasks-logic";
import type { Need } from "./infra-logic";
import { clearLine, criticalNeeds, hud, needLine, parseTarget, taskSaid, todaysTasks, typingIn } from "./today-logic";
import { originAfter, originList } from "./router";

const task = (o: Partial<Task>): Task => ({
  id: "x", title: "", notes: "", due_on: null, done_at: null, pinned: false, sort_key: 0, created_at: "", updated_at: "", deleted_at: null, version: 1, ...o,
});
const need = (o: Partial<Need>): Need => ({ alert: "NodeDown", severity: "critical", count: 1, since_ms: null, new: false, summary: "", key: "k", items: [], ...o });
const counts = (needs = 0, working = 0, done = 0, agents = needs + working + done) => ({ needs, working, done, agents });

describe("the header", () => {
  it("counts need you, working and done, with need you in amber and done in green", () => {
    const h = hud(counts(2, 5, 1), true);
    expect(h.map((s) => [s.value, s.label, s.tone])).toEqual([["2", "Need you", "warn"], ["5", "Working", ""], ["1", "Done", "ok"]]);
  });
  it("says one needs you, and greys a zero", () => {
    const h = hud(counts(1, 0, 0), true);
    expect(h[0].label).toBe("Needs you");
    expect(h.map((s) => s.zero)).toEqual([false, true, true]);
    expect(h[2].tone).toBe("");
  });
  it("makes no claim before the first connect", () => {
    expect(hud(counts(0, 3, 0), false).map((s) => [s.value, s.tone])).toEqual([["–", ""], ["–", ""], ["–", ""]]);
  });
});

describe("the all-clear sentence", () => {
  it("says how many are working", () => {
    expect(clearLine(counts(0, 5), true)).toBe("Nothing needs you. 5 agents working.");
    expect(clearLine(counts(0, 1), true)).toBe("Nothing needs you. 1 agent working.");
  });
  it("says they're quiet, or nothing, when none work", () => {
    expect(clearLine(counts(0, 0, 2), true)).toBe("Nothing needs you. Every agent is quiet.");
    expect(clearLine(counts(), true)).toBe("Nothing needs you.");
  });
  it("doesn't talk about agents it can't see", () => {
    expect(clearLine(counts(0, 5), false)).toBe("Nothing here needs you.");
  });
});

describe("machines", () => {
  it("keeps only critical alerts the owner hasn't dismissed", () => {
    const list = [need({ key: "a" }), need({ key: "b", severity: "warning" }), need({ key: "c" })];
    expect(criticalNeeds(list, { c: "NodeDown" }).map((n) => n.key)).toEqual(["a"]);
  });
  it("names an alert and where it is, and how many more", () => {
    const item = (label: string) => ({ label, instance: `${label}:9100`, machine: null, since_ms: null });
    expect(needLine(need({ items: [item("gpu-box")] }), 0)).toEqual({ title: "Node down", meta: "gpu-box" });
    expect(needLine(need({ count: 4, items: ["a", "b", "c", "d"].map(item) }), 0).meta).toBe("a, b +2");
    expect(needLine(need({ since_ms: 0, items: [] }), 2 * 3600e3).meta).toBe("for 2 h");
  });
});

describe("today's tasks", () => {
  it("are Tasks' first open ones, captures kept on the device included", () => {
    const server = [task({ id: "a", sort_key: 1 }), task({ id: "b", pinned: true }), task({ id: "c", done_at: "2026-01-01" }), task({ id: "d", deleted_at: "2026-01-01" })];
    const r = todaysTasks(server, [{ id: "p", title: "Call the bank", due_on: null, sort_key: 9 }], 2);
    expect(r.shown.map((t) => t.id)).toEqual(["b", "p"]);
    expect(r.open).toBe(3);
  });
  it("says when a captured task is due, as a sentence", () => {
    const now = new Date(2026, 10, 6, 9);
    expect(taskSaid(null, now)).toBe("Added to Tasks");
    expect(taskSaid("2026-11-07", now)).toBe("Added to Tasks, due tomorrow");
    expect(taskSaid("2026-11-09", now)).toBe("Added to Tasks, due Mon");
  });
});

describe("capture", () => {
  it("is a thought unless the owner picked something else", () => {
    expect(parseTarget(null)).toBe("thought");
    expect(parseTarget("note")).toBe("note");
    expect(parseTarget("task")).toBe("task");
    expect(parseTarget("<b>")).toBe("thought");
  });
  it("leaves / alone while the owner is typing somewhere", () => {
    expect(typingIn({ tagName: "INPUT" })).toBe(true);
    expect(typingIn({ tagName: "TEXTAREA" })).toBe(true);
    expect(typingIn({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(typingIn({ tagName: "BUTTON" })).toBe(false);
    expect(typingIn(null)).toBe(false);
  });
});

describe("a terminal opened from Today", () => {
  it("goes back to Today, and sits beside the Agents tab's own list", () => {
    expect(originAfter("today", "agents")).toBe("today");
    expect(originAfter("t/a", "today")).toBe("today");
    expect(originAfter(null, "today")).toBe("today");
    expect(["agents", "panes"]).toContain(originList("today"));
    expect(originList("panes")).toBe("panes");
  });
});
