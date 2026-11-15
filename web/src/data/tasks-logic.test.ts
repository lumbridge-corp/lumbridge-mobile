import { describe, expect, it } from "vitest";
import { changedFields, rebase, asTask, compareOpen, loadPending, reconcile, splitTasks, withPending, type Task } from "./tasks-logic";

const t = (o: Partial<Task>): Task => ({
  id: "x", title: "", notes: "", due_on: null, done_at: null, pinned: false, sort_key: 0, created_at: "", updated_at: "", deleted_at: null, version: 1, ...o,
});

describe("order", () => {
  it("is pinned, then soonest due, then newest", () => {
    const list = [
      t({ id: "none-old", sort_key: 1 }),
      t({ id: "none-new", sort_key: 2 }),
      t({ id: "later", due_on: "2030-02-01" }),
      t({ id: "soon", due_on: "2030-01-01" }),
      t({ id: "pin", pinned: true }),
    ].sort(compareOpen);
    expect(list.map((x) => x.id)).toEqual(["pin", "soon", "later", "none-new", "none-old"]);
  });
  it("splits completed, most recent first", () => {
    const { open, done } = splitTasks([t({ id: "a" }), t({ id: "b", done_at: "2026-01-01" }), t({ id: "c", done_at: "2026-02-01" })]);
    expect(open.map((x) => x.id)).toEqual(["a"]);
    expect(done.map((x) => x.id)).toEqual(["c", "b"]);
  });
});

describe("pending captures", () => {
  it("survive bad storage", () => {
    expect(loadPending(null)).toEqual([]);
    expect(loadPending("{oops")).toEqual([]);
    expect(loadPending('{"a":1}')).toEqual([]);
    expect(loadPending('[{"id":"a","title":"b"},{"nope":1},null]')).toHaveLength(1);
  });
  it("don't show twice once the server has them", () => {
    const pending = [{ id: "a", title: "A", due_on: null, sort_key: 1 }, { id: "b", title: "B", due_on: null, sort_key: 2 }];
    const merged = withPending([t({ id: "a", title: "A" })], pending);
    expect(merged.map((x) => x.id)).toEqual(["a", "b"]);
    expect(merged[1]).toEqual(asTask(pending[1]));
    expect(merged[1].version, "version 0 marks it as not saved").toBe(0);
  });
});

describe("reconcile", () => {
  const base = { title: "a", notes: "n" };
  it("works out the easy cases", () => {
    expect(reconcile(base, { title: "b", notes: "n" }, t({ title: "b", notes: "n" }))).toBe("take");
    expect(reconcile(base, base, t({ title: "z", notes: "n" }))).toBe("retry");
    expect(reconcile(base, { title: "b", notes: "n" }, t({ title: "a", notes: "n", pinned: true }))).toBe("retry");
    expect(reconcile(base, base, t({ ...base, deleted_at: "x" }))).toBe("deleted");
  });
  it("asks when both changed the text", () => {
    expect(reconcile(base, { title: "mine", notes: "n" }, t({ title: "theirs", notes: "n" }))).toBe("ask");
  });
});

describe("a change that lost a race", () => {
  const row = (o: Partial<Task> = {}): Task => ({ id: "1", title: "a", notes: "n", due_on: null, done_at: null, pinned: false, sort_key: 0, created_at: "", updated_at: "", deleted_at: null, version: 1, ...o });
  const fields = ({ title, notes, due_on, pinned }: Task) => ({ title, notes, due_on, pinned });

  it("sends only what the owner changed", () => {
    expect(changedFields(row(), fields(row()))).toEqual({});
    expect(changedFields(row(), { ...fields(row()), due_on: "2026-11-06" })).toEqual({ due_on: "2026-11-06" });
    expect(changedFields(row({ due_on: "2026-11-01" }), { ...fields(row()), due_on: null })).toEqual({ due_on: null });
  });
  it("keeps the owner's due date when the other device only pinned it", () => {
    const base = row(), mine = { ...fields(base), due_on: "2026-11-06" }, theirs = row({ pinned: true, version: 2 });
    expect(reconcile(base, mine, theirs)).toBe("take");
    expect(rebase(base, mine, theirs)).toEqual({ title: "a", notes: "n", due_on: "2026-11-06", pinned: true });
    expect(changedFields(theirs, rebase(base, mine, theirs))).toEqual({ due_on: "2026-11-06" });
  });
  it("doesn't overwrite their due date with the stale one when the owner only edited the notes", () => {
    const base = row(), mine = { ...fields(base), notes: "mine" }, theirs = row({ due_on: "2026-12-01", version: 2 });
    expect(reconcile(base, mine, theirs)).toBe("retry");
    expect(changedFields(theirs, rebase(base, mine, theirs))).toEqual({ notes: "mine" });
  });
  it("has nothing left to send when both made the same change", () => {
    const base = row(), mine = { ...fields(base), title: "b" }, theirs = row({ title: "b", version: 2 });
    expect(changedFields(theirs, rebase(base, mine, theirs))).toEqual({});
  });
});
