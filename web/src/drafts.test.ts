import { describe, expect, it } from "vitest";
import { ELSEWHERE_WORDS, OUTWARD_KINDS, addressOfTag, isOutward, moreWords, previewOf, readFirstWords, approveLabel, armedLabel, draftOfTag, draftTag, focusedTerminal, outcomeWords, parseNeeds, refusalWords, startedWords, terminalTag, titleOf, visibleText, type Draft } from "./drafts-logic";

const send: Draft = { id: "1-aaaa", kind: "send", to: "Acme / Gateway", detail: "t7", why: "", text: "Run the tests", digest: "d", createdMs: 1 };
const worker: Draft = { ...send, kind: "worker", to: "tidy on runner" };
const access: Draft = { ...send, kind: "access", to: "desk:b1", detail: "for 30 minutes" };

describe("what the owner reads is what goes", () => {
  it("leaves ordinary text alone, however odd", () => {
    const t = "line one\n\tindented <b>not html</b> & \"quotes\" 🙂 日本語";
    expect(visibleText(t)).toBe(t);
  });
  it("shows what a screen would hide but a terminal would act on", () => {
    expect(visibleText("a\x1b[2Jb")).toBe("a[U+001B][2Jb");
    expect(visibleText("yes\rno")).toBe("yes[U+000D]no");
    expect(visibleText("ab\u202ecd")).toBe("ab[U+202E]cd");
    expect(visibleText("a\u200bb")).toBe("a[U+200B]b");
    expect(visibleText("\ufeffx")).toBe("[U+FEFF]x");
    expect(visibleText("a\x7fb\x00")).toBe("a[U+007F]b[U+0000]");
  });
});

describe("the words", () => {
  it("names who it's to", () => {
    expect(titleOf(send)).toBe("To Acme / Gateway");
    expect(titleOf(worker)).toBe("Start worker tidy on runner");
  });
  it("says how it ended, and only when it has", () => {
    expect(outcomeWords(send, "done")).toEqual({ text: "Sent.", bad: false });
    expect(outcomeWords(worker, "done")).toEqual({ text: "Worker started.", bad: false });
    expect(outcomeWords(send, "failed")?.bad).toBe(true);
    expect(outcomeWords(send, "failed")?.text).toMatch(/before asking again/);
    expect(outcomeWords(send, "running")).toBeNull();
    expect(outcomeWords(send, "pending")).toBeNull();
  });
  it("has words for every code, and an unknown one still reads", () => {
    for (const c of ["changed", "already_handled", "not_pending", "bad_id", "core_down", "timed_out", "busy", "failed", "bad_request", "anything"]) {
      expect(refusalWords(c).length).toBeGreaterThan(10);
    }
    expect(refusalWords("core_down")).toMatch(/nothing was sent/);
    expect(refusalWords("timed_out")).toMatch(/can't send it twice/);
    expect(refusalWords("not_from_here")).toBe(ELSEWHERE_WORDS);
  });
});

describe("a card's preview", () => {
  const lines = (n: number, w = "line") => Array.from({ length: n }, (_, i) => `${w} ${i + 1}`).join("\n");
  it("shows a short draft whole, with no control", () => {
    for (const t of ["Run the tests", lines(3), "x".repeat(240), `${lines(3)}\n\n`]) {
      const p = previewOf(t);
      expect(p.whole).toBe(true);
      expect(p.text).toBe(t);
    }
  });
  it("cuts at three lines when they're shorter", () => {
    const p = previewOf(lines(44));
    expect(p).toMatchObject({ whole: false, text: lines(3), moreLines: 41 });
    expect(moreWords(p)).toBe(`+41 more lines · ${lines(44).length} characters`);
  });
  it("cuts at 240 characters when they're shorter, and says so in characters if no whole line is left", () => {
    const long = "word ".repeat(1500).trim();
    const p = previewOf(long);
    expect(p).toMatchObject({ whole: false, text: long.slice(0, 240), moreLines: 0, moreChars: long.length - 240, chars: long.length });
    expect(moreWords(p)).toBe(`+${(long.length - 240).toLocaleString("en-US")} more characters · ${long.length.toLocaleString("en-US")} characters`);
  });
  it("counts lines after a line cut part way", () => {
    const t = `${"a".repeat(300)}\nsecond\nthird`;
    expect(previewOf(t)).toMatchObject({ text: "a".repeat(240), moreLines: 2, moreChars: 60 + 13 });
  });
  it("counts thousands as the owner would read them, and one as one", () => {
    const t = `${lines(3)}\n${"y".repeat(7000)}`;
    expect(moreWords(previewOf(t))).toBe(`+1 more line · ${t.length.toLocaleString("en-US")} characters`);
    expect(moreWords(previewOf(t))).toMatch(/· 7,0\d\d characters$/);
  });
  it("never cuts a character in half", () => {
    const t = "🙂日本語é👩‍👩‍👧".repeat(60);
    const p = previewOf(t);
    expect(p.whole).toBe(false);
    expect([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(p.text)].length).toBe(240);
    expect(t.startsWith(p.text)).toBe(true);
    expect(p.text.endsWith("👩‍👩‍👧") || p.text.endsWith("é") || p.text.endsWith("語")).toBe(true);
    expect(p.chars).toBe(60 * 6);
    expect(p.moreChars).toBe(60 * 6 - 240);
  });
  it("a draft at exactly 241 characters isn't short", () => {
    expect(previewOf("z".repeat(241))).toMatchObject({ whole: false, moreChars: 1 });
    expect(moreWords(previewOf("z".repeat(241)))).toBe("+1 more character · 241 characters");
  });
});

describe("what must be read before it arms", () => {
  it("is what leaves the owner's hands, and only that", () => {
    expect([...OUTWARD_KINDS].sort()).toEqual(["access", "deploy", "ig_post", "mail_reply", "send"]);
    for (const k of ["mail_reply", "ig_post", "send", "access", "deploy"] as const) expect(isOutward({ ...send, kind: k })).toBe(true);
    for (const k of ["worker", "issue", "resume", "cal_create", "cal_change", "cal_decline", "service_record"] as const) expect(isOutward({ ...send, kind: k })).toBe(false);
  });
  it("says to read it, naming the button the owner will press", () => {
    expect(readFirstWords(send)).toBe("Read it, then tap Approve");
    expect(readFirstWords({ ...send, kind: "mail_reply" })).toBe("Read it, then tap Send");
  });
});

describe("the list from the gateway", () => {
  it("takes what can be shown in full", () => {
    expect(parseNeeds({ drafts: [send, worker], stale: true, approveHere: true })).toEqual({ drafts: [send, worker], stale: true, approveHere: true });
  });
  it("takes Approve here only from a plain yes", () => {
    expect(parseNeeds({ drafts: [], approveHere: false }).approveHere).toBe(false);
    for (const odd of [undefined, "true", 1, null]) expect(parseNeeds({ drafts: [], approveHere: odd }).approveHere).toBe(false);
  });
  it("drops what can't, and survives nonsense", () => {
    const empty = { drafts: [], stale: false, approveHere: false };
    expect(parseNeeds(null)).toEqual(empty);
    expect(parseNeeds("x")).toEqual(empty);
    expect(parseNeeds({ drafts: "x" })).toEqual(empty);
    expect(parseNeeds({ drafts: [null, 1, {}, { ...send, kind: "mystery" }, { ...send, text: "" }, { ...send, digest: 7 }] })).toEqual(empty);
  });
});

describe("notification tags", () => {
  it("match the gateway's", () => {
    // gateway/src/push.rs: encode_component, and the payload test there.
    expect(terminalTag("gpu/t7")).toBe("t-gpu%2Ft7");
    expect(terminalTag("t7")).toBe("t-t7");
    expect(draftTag("1793758374-ec32")).toBe("draft-1793758374-ec32");
  });
  it("read back", () => {
    expect(addressOfTag("t-gpu%2Ft7")).toBe("gpu/t7");
    expect(addressOfTag("test")).toBeNull();
    expect(addressOfTag("acme")).toBeNull();
    expect(addressOfTag("t-%E0%A4%A")).toBeNull();
    expect(draftOfTag("draft-1-aaaa")).toBe("1-aaaa");
    expect(draftOfTag("t-t7")).toBeNull();
  });
});

describe("what the owner is provably looking at", () => {
  const sure = { route: "t/gpu%2Ft7", hidden: false, hasFocus: true, idleMs: 1000 };
  const f = (o: Partial<typeof sure>) => focusedTerminal({ ...sure, ...o }, 120_000);
  it("needs all of it", () => {
    expect(f({})).toBe("gpu/t7");
    expect(f({ hidden: true })).toBeNull();
    expect(f({ hasFocus: false })).toBeNull();
    expect(f({ idleMs: 120_001 })).toBeNull();
    expect(f({ route: "agents" })).toBeNull();
    expect(f({ route: "assistant" })).toBeNull();
  });
  it("is unsure about nonsense, so it buzzes", () => {
    expect(f({ route: "t/" })).toBeNull();
    expect(f({ route: "t/%E0%A4%A" })).toBeNull();
  });
});

describe("access drafts", () => {
  it("say what she'd get, and survive parsing", () => {
    expect(titleOf(access)).toBe("Let Assistant use desk:b1");
    expect(outcomeWords(access, "done")).toEqual({ text: "Allowed.", bad: false });
    expect(parseNeeds({ drafts: [access] }).drafts).toEqual([access]);
  });
});

describe("issue drafts", () => {
  const issue: Draft = { ...send, kind: "issue", to: "acme/app", detail: "Thoughts lose a word", text: "Steps to reproduce" };
  it("say where it'd be filed, and survive parsing", () => {
    expect(titleOf(issue)).toBe("File a factory issue on acme/app");
    expect(armedLabel(issue)).toBe("Tap again to file");
    expect(startedWords(issue)).toBe("Approved. Filing the issue.");
    expect(outcomeWords(issue, "done")).toEqual({ text: "Filed.", bad: false });
    expect(parseNeeds({ drafts: [issue] }).drafts).toEqual([issue]);
    expect(parseNeeds({ drafts: [{ ...issue, detail: "" }] }).drafts).toEqual([]);
  });
});

describe("resume drafts", () => {
  const resume: Draft = { ...send, kind: "resume", to: "Tailored copy \"Acme FDE\" from Sam Rivera (v10), 3 change(s)", detail: "Tailor a copy",
    text: "CHANGE summary\n  was: Engineer\n  now: Forward-deployed engineer\n".repeat(40) };
  it("say what changes in Reactive Resume, and survive parsing whole", () => {
    expect(titleOf(resume)).toBe(`Resume: ${resume.to}`);
    expect(approveLabel(resume)).toBe("Approve");
    expect(armedLabel(resume)).toBe("Tap again to approve");
    expect(startedWords(resume)).toBe("Approved. Making the change in Reactive Resume.");
    expect(outcomeWords(resume, "done")).toEqual({ text: "Done in Reactive Resume.", bad: false });
    expect(outcomeWords(resume, "failed")).toEqual(outcomeWords(send, "failed"));
    expect(parseNeeds({ drafts: [resume] }).drafts[0].text).toBe(resume.text);
    expect(parseNeeds({ drafts: [{ ...resume, text: "" }] }).drafts).toEqual([]);
  });
});

describe("Story drafts", () => {
  const story: Draft = { ...send, kind: "ig_post", to: "@samrivera", detail: "out/run.png · sha256 0123456789abcdef…", text: "Morning run" };
  it("say where it goes public and what card", () => {
    expect(titleOf(story)).toBe("Post a Story on @samrivera");
    expect(approveLabel(story)).toBe("Approve");
    expect(armedLabel(story)).toBe("Tap again to post publicly");
    expect(startedWords(story)).toBe("Approved. Posting through the Pixel; it can take a few minutes.");
    expect(outcomeWords(story, "done")).toEqual({ text: "Posted.", bad: false });
    expect(outcomeWords(story, "failed")).toEqual({ text: "Not posted, or not proven posted. Check the account before asking again.", bad: true });
    expect(parseNeeds({ drafts: [story] }).drafts).toEqual([story]);
    expect(parseNeeds({ drafts: [{ ...story, detail: "" }] }).drafts).toEqual([]);
  });
});

describe("deploy drafts", () => {
  const roll: Draft = { ...send, kind: "deploy", to: "www.example.com", detail: "rollback",
    text: "Rollback www.example.com to 81cf537.\nWhat runs: tags the commit you name and runs the same deploy workflow on it." };
  const ship: Draft = { ...roll, to: "mobile.example.com", detail: "deploy", text: "Deploy mobile.example.com from main.\nWhat runs: scripts/deploy.sh" };
  it("name the site and the action, read in full first, and survive parsing whole", () => {
    expect(titleOf(roll)).toBe("Roll back www.example.com");
    expect(titleOf(ship)).toBe("Deploy mobile.example.com");
    expect(isOutward(ship)).toBe(true);
    expect(armedLabel(roll)).toBe("Tap again to roll back");
    expect(armedLabel(ship)).toBe("Tap again to deploy");
    expect(startedWords(ship)).toBe("Approved. Deploying mobile.example.com; it can take a few minutes.");
    expect(outcomeWords(roll, "done")).toEqual({ text: "www.example.com is rolled back.", bad: false });
    expect(outcomeWords(ship, "failed")?.bad).toBe(true);
    expect(parseNeeds({ drafts: [roll, ship] }).drafts).toEqual([roll, ship]);
  });
});

describe("car service drafts", () => {
  const entry = "## 2026-11-05 · Tire shop · Four-wheel alignment\n\n- Car: Blue (2023 sedan)\n\nReadings:\n- Right front toe 0.24° before, 0.08° after";
  const car: Draft = { ...send, kind: "service_record", to: "Car A: 2026-11-05 Four-wheel alignment",
    detail: "adds this entry to docs/service-log.md in the car notes, not committed", text: entry };
  it("say which car's log, that nothing is committed, and survive parsing whole", () => {
    expect(titleOf(car)).toBe("Car service log: Car A: 2026-11-05 Four-wheel alignment");
    expect(approveLabel(car)).toBe("Approve");
    expect(armedLabel(car)).toBe("Tap again to add it");
    expect(startedWords(car)).toBe("Approved. Adding it to the car's service log.");
    expect(outcomeWords(car, "done")).toEqual({ text: "Added to the car's service log. Not committed yet.", bad: false });
    expect(outcomeWords(car, "failed")?.bad).toBe(true);
    expect(outcomeWords(car, "failed")?.text).not.toMatch(/terminal/);
    expect(parseNeeds({ drafts: [car] }).drafts).toEqual([car]);
    expect(parseNeeds({ drafts: [{ ...car, text: "" }, { ...car, detail: "" }, { ...car, kind: "service-record" }] }).drafts).toEqual([]);
  });
});

describe("inbox drafts", () => {
  const all = "Account: k@example.com\nTo: a@example.com\nCc: b@example.com\nSubject: Re: Lunch\n\nThursday works.";
  const mail: Draft = { ...send, kind: "mail_reply", to: "Email reply · k@example.com", detail: "reply in thread, recipients from its headers", text: all };
  const cal = (kind: "cal_create" | "cal_change" | "cal_decline", detail: string): Draft => ({ ...mail, kind, to: "Calendar · k@example.com", detail });
  it("an email reply says Send, and what it'll do", () => {
    expect(titleOf(mail)).toBe("Email reply · k@example.com");
    expect(approveLabel(mail)).toBe("Send");
    expect(armedLabel(mail)).toBe("Tap again to send");
    expect(startedWords(mail)).toBe("Approved. Sending from Gmail.");
    expect(outcomeWords(mail, "done")).toEqual({ text: "Sent.", bad: false });
    expect(parseNeeds({ drafts: [mail] }).drafts[0].text).toBe(all);
  });
  it("a calendar change says Approve", () => {
    for (const d of [cal("cal_create", "new event, no guests"), cal("cal_change", "change an event"), cal("cal_decline", "decline an invite")]) {
      expect(titleOf(d)).toBe("Calendar · k@example.com");
      expect(approveLabel(d)).toBe("Approve");
      expect(armedLabel(d)).toBe("Tap again to approve");
      expect(startedWords(d)).toBe("Approved. Changing the calendar.");
      expect(outcomeWords(d, "done")).toEqual({ text: "Done in the calendar.", bad: false });
      expect(parseNeeds({ drafts: [d] }).drafts).toEqual([d]);
    }
  });
  it("one with a part missing, or of a kind it doesn't know, is dropped", () => {
    const { to: _to, ...noName } = mail;
    expect(parseNeeds({ drafts: [noName, { ...mail, to: "" }, { ...mail, text: "" }, { ...mail, text: undefined }] }).drafts).toEqual([]);
    for (const kind of ["mystery", "cal_delete", "mail", "Resume", "ig-post"]) expect(parseNeeds({ drafts: [{ ...mail, kind }] }).drafts).toEqual([]);
  });
});
