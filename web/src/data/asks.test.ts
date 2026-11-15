import { describe, expect, it } from "vitest";
import type { Draft } from "../drafts-logic";
import {
  answerRefusal, answeredWords, forYouItems, headline, listenText, parseAsks, pickedLabels, safeLink, sameAnswer, statusOf, type Ask, type AskOption,
} from "./asks-logic";

const ask = (over: Partial<Ask> = {}): Ask => ({
  id: "a1", title: "Book the dentist for Thursday?", body: "They have 9:30 or 15:00.", status: "pending", reply: null,
  answered_at: null, delivered_at: null, created_at: "2026-11-04T10:00:00Z", version: 1, options: null, picked: null, ...over,
});
const draft = (over: Partial<Draft> = {}): Draft => ({
  id: "1793760000-aaaa", kind: "send", to: "Acme / Gateway", detail: "t7", why: "He asked me to chase this.\nMore.", text: "Run the tests",
  digest: "d", createdMs: Date.parse("2026-11-04T11:00:00Z"), ...over,
});

describe("the list", () => {
  it("is asks and drafts together, newest first, without answered asks", () => {
    const items = forYouItems(
      [ask({ id: "old", created_at: "2026-11-04T09:00:00Z" }), ask({ id: "new", created_at: "2026-11-04T12:00:00Z" }), ask({ id: "done", status: "accepted" })],
      [draft()],
    );
    expect(items.map((i) => i.key)).toEqual(["ask:new", "draft:1793760000-aaaa", "ask:old"]);
  });
  it("keeps only rows it can show in full", () => {
    const rows = parseAsks([ask(), { ...ask(), title: "  " }, { ...ask(), status: "maybe" }, null, "x", { id: 1 }]);
    expect(rows.map((r) => r.id)).toEqual(["a1"]);
    expect(parseAsks({ not: "a list" })).toEqual([]);
  });
  it("says what each closed card is in words, on one line", () => {
    expect(headline({ kind: "ask", key: "ask:a1", at: 0, ask: ask() })).toEqual({ kind: "Assistant asks", title: "Book the dentist for Thursday?" });
    expect(headline({ kind: "draft", key: "d", at: 0, draft: draft() })).toEqual({ kind: "To Acme / Gateway", title: "He asked me to chase this." });
    expect(headline({ kind: "draft", key: "d", at: 0, draft: draft({ kind: "worker", to: "tidy on runner", why: "" }) }).kind).toBe("Start worker tidy on runner");
    expect(headline({ kind: "draft", key: "d", at: 0, draft: draft({ why: "", text: "\n first line\nsecond" }) }).title).toBe("first line");
  });
});

describe("Listen", () => {
  it("reads what the owner could read, title first", () => {
    expect(listenText({ kind: "ask", key: "k", at: 0, ask: ask() })).toBe("Book the dentist for Thursday?\n\nThey have 9:30 or 15:00.");
    expect(listenText({ kind: "ask", key: "k", at: 0, ask: ask({ body: "" }) })).toBe("Book the dentist for Thursday?");
    expect(listenText({ kind: "draft", key: "k", at: 0, draft: draft() })).toBe("To Acme / Gateway.\n\nAssistant says: He asked me to chase this.\nMore.\n\nRun the tests");
  });
});

describe("answering", () => {
  it("knows its own answer when it comes back as already answered", () => {
    expect(sameAnswer({ status: "accepted", reply: null }, "accept", "")).toBe(true);
    expect(sameAnswer({ status: "accepted", reply: null }, "deny", "")).toBe(false);
    expect(sameAnswer({ status: "replied", reply: "Friday" }, "reply", " Friday ")).toBe(true);
    expect(sameAnswer({ status: "replied", reply: "Friday" }, "reply", "Saturday")).toBe(false);
    expect(statusOf("deny")).toBe("denied");
  });
  it("says how it went, and a refusal never reads as success", () => {
    expect(answeredWords("accepted")).toMatch(/^Accepted/);
    expect(answeredWords("replied", "Friday")).toBe("Replied: Friday");
    for (const f of ["offline", "unreachable", "server", "rejected", "not_from_here", "gone", "other"] as const) {
      expect(answerRefusal(f)).not.toMatch(/^(Accepted|Denied|Replied)/);
    }
    expect(answerRefusal("not_from_here")).toMatch(/Assistant can operate this device/);
    expect(answerRefusal("offline")).toMatch(/offline.*still here/);
  });
});

describe("an ask with options", () => {
  const roles: AskOption[] = [
    { key: "459", label: "Platform engineer, Acme", detail: "Remote.", link: "https://jobs.example.com/459" },
    { key: "436", label: "SRE, Initech", detail: "", link: null },
  ];
  it("keeps its options, and a link only if it's https:", () => {
    const [a] = parseAsks([{ ...ask(), options: [
      { key: "459", label: "Platform engineer, Acme", detail: "Remote.", link: "https://jobs.example.com/459" },
      { key: "1", label: "x", detail: "", link: "javascript:alert(1)" },
      { key: "2", label: "y", link: "http://jobs.example.com/2" },
      { key: "3", label: "z", detail: "", link: "data:text/html,<b>hi</b>" },
    ], picked: null }]);
    expect(a.options?.map((o) => o.link)).toEqual(["https://jobs.example.com/459", null, null, null]);
    expect(a.options?.[2].detail).toBe("");
    expect(parseAsks([ask()])[0].options).toBeNull();
  });
  it("drops an ask whose options can't be shown in full", () => {
    for (const options of [[], "x", [{ key: "a" }], [{ key: "a", label: " " }], [null]]) {
      expect(parseAsks([{ ...ask(), options }])).toEqual([]);
    }
  });
  it("only ever takes https: links", () => {
    expect(safeLink("https://jobs.example.com/a?b=c")).toBe("https://jobs.example.com/a?b=c");
    for (const bad of ["javascript:alert(1)", "http://x.com", "data:text/html,x", "//x.com", "x", 5, null, "https://"]) expect(safeLink(bad)).toBeNull();
  });
  it("is read out with its options", () => {
    expect(listenText({ kind: "ask", key: "k", at: 0, ask: ask({ body: "", options: roles }) }))
      .toBe("Book the dentist for Thursday?\n\nPlatform engineer, Acme. Remote.\n\nSRE, Initech");
  });
  it("says what the owner picked, and None of these", () => {
    expect(statusOf("pick")).toBe("accepted");
    expect(pickedLabels(roles, ["436", "459"])).toEqual(["Platform engineer, Acme", "SRE, Initech"]);
    expect(answeredWords("accepted", null, { options: roles, keys: ["436"] })).toBe("Picked: SRE, Initech. Assistant will hear it.");
    expect(answeredWords("denied", null, { options: roles, keys: null })).toMatch(/^None of these/);
    expect(answeredWords("denied")).toMatch(/^Denied/);
    expect(sameAnswer({ status: "accepted", reply: null, picked: ["459", "436"] }, "pick", "", ["436", "459"])).toBe(true);
    expect(sameAnswer({ status: "accepted", reply: null, picked: ["459"] }, "pick", "", ["436"])).toBe(false);
  });
});
