// Today's decisions, with no DOM, so they can be tested: what the header counts, the one sentence when nothing needs the owner, which
// machine alerts and tasks make the cut, and where a capture goes.
import { dueLabel } from "./data/dates";
import { splitTasks, withPending, type Pending, type Task } from "./data/tasks-logic";
import { alertTitle, needTime, shortInstance, splitNeeds, type Dismissed, type Need } from "./infra-logic";

export type Target = "thought" | "task" | "note";
export const TARGETS: { id: Target; label: string; placeholder: string; done: string }[] = [
  { id: "thought", label: "Thought", placeholder: "Capture a thought…", done: "Saved to Thoughts" },
  { id: "task", label: "Task", placeholder: "Add a task…", done: "Added to Tasks" },
  { id: "note", label: "Note", placeholder: "Start a note…", done: "Saved to Notes" },
];
/** Anything unreadable is a thought: that's the default, and the one that loses nothing. */
export const parseTarget = (raw: string | null): Target => (raw === "task" || raw === "note" ? raw : "thought");

export interface Counts { needs: number; working: number; done: number; agents: number }

/** The header's numbers. Before the first connect they aren't known, and a 0 would be a claim. */
export function hud(n: Counts, known: boolean): { value: string; label: string; tone: "warn" | "ok" | "" ; zero: boolean }[] {
  const v = (x: number) => (known ? String(x) : "–");
  return [
    { value: v(n.needs), label: n.needs === 1 ? "Needs you" : "Need you", tone: known && n.needs ? "warn" : "", zero: !known || !n.needs },
    { value: v(n.working), label: "Working", tone: "", zero: !known || !n.working },
    { value: v(n.done), label: "Done", tone: known && n.done ? "ok" : "", zero: !known || !n.done },
  ];
}

/** The one plain sentence when there's nothing to decide. Not said about agents while their state isn't known. */
export function clearLine(n: Counts, known: boolean): string {
  if (!known) return "Nothing here needs you.";
  if (n.working) return `Nothing needs you. ${n.working} ${n.working === 1 ? "agent" : "agents"} working.`;
  if (n.agents) return "Nothing needs you. Every agent is quiet.";
  return "Nothing needs you.";
}

/** Only critical alerts reach Today, and not one the owner dismissed on Infra from this device. */
export const criticalNeeds = (needs: Need[], dismissed: Dismissed): Need[] =>
  splitNeeds(needs, dismissed).shown.filter((n) => n.severity === "critical");

/** One line for an alert: what it is, and where, from its items. A long list says how many more. */
export function needLine(n: Need, nowMs: number): { title: string; meta: string } {
  const places = [...new Set(n.items.map((i) => i.label || shortInstance(i.instance)).filter(Boolean))];
  const where = places.length > 2 ? `${places.slice(0, 2).join(", ")} +${places.length - 2}` : places.join(", ");
  return { title: alertTitle(n.alert), meta: [where, needTime(n, nowMs)].filter(Boolean).join(" · ") };
}

/** The first few open tasks in Tasks' own order, captures not yet saved included, and how many are open in all. */
export function todaysTasks(server: Task[], pending: Pending[], max = 5): { shown: Task[]; open: number } {
  const { open } = splitTasks(withPending(server.filter((t) => !t.deleted_at), pending));
  return { shown: open.slice(0, max), open: open.length };
}

/** "/" goes to the capture box only when the owner isn't already typing somewhere. */
export function typingIn(e: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  return !!e && (e.tagName === "INPUT" || e.tagName === "TEXTAREA" || e.tagName === "SELECT" || !!e.isContentEditable);
}

/** The date the header shows, as the owner's phone would say it. */
export const dateLine = (d: Date, locale?: string) => d.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" });

/** What's said once a task is in. "Due tomorrow" reads as a sentence; a date or a weekday keeps its capital. */
export function taskSaid(due_on: string | null, now = new Date()): string {
  if (!due_on) return "Added to Tasks";
  const t = dueLabel(due_on, now).text;
  return `Added to Tasks, due ${["Today", "Tomorrow", "Yesterday"].includes(t) ? t.toLowerCase() : t}`;
}
