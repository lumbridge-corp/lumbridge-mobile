import { describe, expect, it } from "vitest";
import { dueLabel, localDate, parseCapture, relTime } from "./dates";

const wed = new Date(2026, 10, 4, 15, 0); // Wednesday, Nov 4 2026

describe("parseCapture", () => {
  const due = (s: string) => parseCapture(s, wed);
  it("takes a date off the end", () => {
    expect(due("Call the roofer tomorrow")).toEqual({ title: "Call the roofer", due_on: "2026-11-05" });
    expect(due("Call the roofer today")).toEqual({ title: "Call the roofer", due_on: "2026-11-04" });
    expect(due("Pay rent TOMORROW")).toEqual({ title: "Pay rent", due_on: "2026-11-05" });
    expect(due("Pay rent by Friday")).toEqual({ title: "Pay rent", due_on: "2026-11-06" });
    expect(due("Pay rent due fri")).toEqual({ title: "Pay rent", due_on: "2026-11-06" });
    expect(due("Book flights next week")).toEqual({ title: "Book flights", due_on: "2026-11-11" });
    expect(due("Renew in 3 days")).toEqual({ title: "Renew", due_on: "2026-11-07" });
    expect(due("Renew in 2 weeks")).toEqual({ title: "Renew", due_on: "2026-11-18" });
    expect(due("Taxes Nov 20")).toEqual({ title: "Taxes", due_on: "2026-11-20" });
    expect(due("Taxes 20 november")).toEqual({ title: "Taxes", due_on: "2026-11-20" });
    expect(due("Taxes 12/25")).toEqual({ title: "Taxes", due_on: "2026-12-25" });
  });
  it("a weekday means the next one, and today's weekday means a week out", () => {
    expect(due("Standup Wednesday").due_on).toBe("2026-11-11");
    expect(due("Standup Thursday").due_on).toBe("2026-11-05");
    expect(due("Standup Sunday").due_on).toBe("2026-11-08");
    expect(due("Standup Monday").due_on).toBe("2026-11-09");
  });
  it("a date already past this year means next year", () => {
    expect(due("Renew passport Jan 5").due_on).toBe("2027-01-05");
    expect(due("Renew passport 3/1").due_on).toBe("2027-03-01");
  });
  it("leaves ordinary words alone", () => {
    for (const s of ["Sit in the sun", "Buy a marble 5", "Call may", "Fix the mon", "Feb 30", "Taxes 13/45", "Taxes Feb 30", "Next steps", "next door"]) {
      expect(due(s)).toEqual({ title: s, due_on: null });
    }
  });
  it("a bare date stays the title, so the owner never gets an empty task", () => {
    expect(due("tomorrow")).toEqual({ title: "tomorrow", due_on: null });
  });
  it("crosses month and year ends", () => {
    const dec31 = new Date(2026, 11, 31);
    expect(parseCapture("x tomorrow", dec31).due_on).toBe("2027-01-01");
  });
});

describe("dueLabel", () => {
  it("names the near days", () => {
    expect(dueLabel("2026-11-04", wed)).toEqual({ text: "Today", kind: "today" });
    expect(dueLabel("2026-11-05", wed)).toEqual({ text: "Tomorrow", kind: "soon" });
    expect(dueLabel("2026-11-03", wed)).toEqual({ text: "Yesterday", kind: "overdue" });
    expect(dueLabel("2026-11-07", wed)).toEqual({ text: "Sat", kind: "soon" });
    expect(dueLabel("2026-11-30", wed)).toEqual({ text: "Nov 30", kind: "later" });
    expect(dueLabel("2027-02-01", wed).text).toBe("Feb 1, 2027");
    expect(dueLabel("2026-10-01", wed)).toEqual({ text: "Oct 1", kind: "overdue" });
  });
  it("uses the local day, not UTC, late at night", () => {
    const late = new Date(2026, 10, 4, 23, 59);
    expect(localDate(late)).toBe("2026-11-04");
    expect(dueLabel("2026-11-04", late).kind).toBe("today");
  });
});

describe("relTime", () => {
  it("stays short", () => {
    expect(relTime(new Date(wed.getTime() - 5000).toISOString(), wed)).toBe("now");
    expect(relTime(new Date(wed.getTime() - 300000).toISOString(), wed)).toBe("5m");
    expect(relTime(new Date(wed.getTime() - 3 * 3600000).toISOString(), wed)).toBe("3h");
    expect(relTime(new Date(2026, 10, 3, 9).toISOString(), wed)).toBe("Yesterday");
    expect(relTime(new Date(2026, 9, 1, 9).toISOString(), wed)).toBe("Oct 1");
  });
});
