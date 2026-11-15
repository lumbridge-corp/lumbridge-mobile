// Dates for tasks and notes. A due date is a calendar day in your local time, never an instant.

const pad = (n: number) => String(n).padStart(2, "0");
export const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const fromLocal = (s: string) => {
  const [y, m, day] = s.split("-").map(Number);
  return new Date(y, m - 1, day);
};
const daysBetween = (a: Date, b: Date) =>
  Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime() - new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()) / 86400000);

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
// Short weekday names are real words ("sun", "sat", "wed"), so they only count after "by", "on" or "due".
const SHORT_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WORD_DATE = /^(?:(.*?\S)\s+)?(?:(by|on|due)\s+)?(today|tonight|tomorrow|tmrw|next week|next [a-z]+|in \d+ days?|in \d+ weeks?|[a-z]{3,9} \d{1,2}|\d{1,2} [a-z]{3,9}|\d{1,2}\/\d{1,2}|[a-z]{3,9})$/i;

function nextWeekday(now: Date, target: number, skipThisWeek: boolean): Date {
  const ahead = ((target - now.getDay() + 7) % 7) || 7;
  return addDays(now, skipThisWeek && ahead < 7 - now.getDay() + 1 ? ahead + 7 : ahead);
}

function monthDay(now: Date, month: number, day: number): Date | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  let d = new Date(now.getFullYear(), month, day);
  if (d.getMonth() !== month) return null; // Feb 30
  if (daysBetween(now, d) < 0) d = new Date(now.getFullYear() + 1, month, day);
  return d;
}

function dateFor(phrase: string, prefixed: boolean, now: Date): Date | null {
  const p = phrase.toLowerCase();
  if (p === "today" || p === "tonight") return addDays(now, 0);
  if (p === "tomorrow" || p === "tmrw") return addDays(now, 1);
  if (p === "next week") return addDays(now, 7);
  let m: RegExpMatchArray | null;
  if ((m = p.match(/^next ([a-z]+)$/))) {
    const i = dayIndex(m[1], true);
    return i < 0 ? null : nextWeekday(now, i, true);
  }
  if ((m = p.match(/^in (\d+) days?$/))) return addDays(now, Number(m[1]));
  if ((m = p.match(/^in (\d+) weeks?$/))) return addDays(now, Number(m[1]) * 7);
  if ((m = p.match(/^(\d{1,2})\/(\d{1,2})$/))) return monthDay(now, Number(m[1]) - 1, Number(m[2]));
  if ((m = p.match(/^([a-z]{3,9}) (\d{1,2})$/))) return monthDay(now, monthIndex(m[1]), Number(m[2]));
  if ((m = p.match(/^(\d{1,2}) ([a-z]{3,9})$/))) return monthDay(now, monthIndex(m[2]), Number(m[1]));
  const i = dayIndex(p, prefixed);
  return i < 0 ? null : nextWeekday(now, i, false);
}

function dayIndex(word: string, allowShort: boolean): number {
  const full = WEEKDAYS.indexOf(word);
  return full >= 0 || !allowShort ? full : SHORT_DAYS.indexOf(word);
}

function monthIndex(word: string): number {
  const i = MONTHS.indexOf(word.slice(0, 3));
  // "mar" and "march" are fine; "marble 5" isn't a date.
  const names = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  return i >= 0 && names[i].startsWith(word) ? i : -1;
}

/** "Call the roofer tomorrow" -> title "Call the roofer", due tomorrow. A date with nothing left to do isn't a task title. */
export function parseCapture(text: string, now = new Date()): { title: string; due_on: string | null } {
  const trimmed = text.trim();
  const m = trimmed.match(WORD_DATE);
  const none = { title: trimmed, due_on: null };
  if (!m || !m[1]) return none;
  const date = dateFor(m[3], Boolean(m[2]), now);
  return date ? { title: m[1], due_on: localDate(date) } : none;
}

export type DueKind = "overdue" | "today" | "soon" | "later";

export function dueLabel(due: string, now = new Date()): { text: string; kind: DueKind } {
  const d = fromLocal(due);
  const n = daysBetween(now, d);
  if (n < 0) return { text: n === -1 ? "Yesterday" : `${shortDate(d, now)}`, kind: "overdue" };
  if (n === 0) return { text: "Today", kind: "today" };
  if (n === 1) return { text: "Tomorrow", kind: "soon" };
  if (n < 7) return { text: d.toLocaleDateString("en-US", { weekday: "short" }), kind: "soon" };
  return { text: shortDate(d, now), kind: "later" };
}

function shortDate(d: Date, now: Date): string {
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString("en-US", opts);
}

/** "now", "5m", "3h", "Yesterday", "Nov 2". Short enough for the end of a row. */
export function relTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const s = (now.getTime() - d.getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const days = daysBetween(d, now);
  if (days === 0) return `${Math.floor(s / 3600)}h`;
  if (days === 1) return "Yesterday";
  return shortDate(d, now);
}
