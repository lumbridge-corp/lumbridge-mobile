// Tasks' pure logic: order, the offline capture queue, and reconciling a change that lost a race.

export interface Task {
  id: string; title: string; notes: string; due_on: string | null; done_at: string | null; pinned: boolean;
  sort_key: number; created_at: string; updated_at: string; deleted_at: string | null; version: number;
}

/** Same order as the server: pinned, soonest due, newest. */
export function compareOpen(a: Task, b: Task): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.due_on !== b.due_on) {
    if (!a.due_on) return 1;
    if (!b.due_on) return -1;
    return a.due_on < b.due_on ? -1 : 1;
  }
  if (a.sort_key !== b.sort_key) return b.sort_key - a.sort_key;
  return a.id < b.id ? -1 : 1;
}

export function splitTasks(all: Task[]): { open: Task[]; done: Task[] } {
  const open = all.filter((t) => !t.done_at).sort(compareOpen);
  const done = all.filter((t) => t.done_at).sort((a, b) => (a.done_at! < b.done_at! ? 1 : -1));
  return { open, done };
}

/** A task typed but not yet confirmed by the server. The id is chosen here, so retrying can't make two. */
export interface Pending { id: string; title: string; due_on: string | null; sort_key: number }

export const asTask = (p: Pending): Task => ({
  id: p.id, title: p.title, notes: "", due_on: p.due_on, done_at: null, pinned: false, sort_key: p.sort_key,
  created_at: "", updated_at: "", deleted_at: null, version: 0,
});

export function loadPending(raw: string | null): Pending[] {
  try {
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((p) => p && typeof p.id === "string" && typeof p.title === "string") : [];
  } catch { return []; }
}

/** Show the server's list plus what hasn't reached it, without showing anything twice. */
export function withPending(server: Task[], pending: Pending[]): Task[] {
  const known = new Set(server.map((t) => t.id));
  return [...server, ...pending.filter((p) => !known.has(p.id)).map(asTask)];
}

export type TaskText = { title: string; notes: string };
const same = (a: TaskText, b: TaskText) => a.title === b.title && a.notes === b.notes;

/** A PATCH got 409. "retry" goes again on their version; "take" means theirs already says this; "ask" needs the owner. */
export function reconcile(base: TaskText, mine: TaskText, theirs: Task): "retry" | "take" | "ask" | "deleted" {
  if (theirs.deleted_at) return "deleted";
  if (same(mine, theirs)) return "take";
  if (same(mine, base) || same(theirs, base)) return "retry";
  return "ask";
}

export type TaskFields = TaskText & { due_on: string | null; pinned: boolean };
const FIELDS = ["title", "notes", "due_on", "pinned"] as const;

/** What the owner actually changed since `base`. Only this ever goes to the server or into the stored draft. */
export function changedFields(base: TaskFields, draft: TaskFields): Partial<TaskFields> {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) if (draft[f] !== base[f]) out[f] = draft[f];
  return out as Partial<TaskFields>;
}

/** The owner's changes on top of their newer row: what the owner didn't touch follows them. */
export function rebase(base: TaskFields, draft: TaskFields, theirs: TaskFields): TaskFields {
  const pick = ({ title, notes, due_on, pinned }: TaskFields): TaskFields => ({ title, notes, due_on, pinned });
  return { ...pick(theirs), ...changedFields(base, draft) };
}
