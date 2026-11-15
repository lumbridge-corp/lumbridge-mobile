import { describe, expect, it } from "vitest";
import { forYouItems, headline, listenText, type Ask } from "./asks-logic";
import { decidedWords, decideRefusal, linkPieces, parseProposals, type Proposal } from "./proposals-logic";

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: "p1", title: "Boiler pressure", body: "Keep it at 1.5 bar.", why: "He asked twice.", source: "session 42", proposed_by: "claude-build",
  status: "pending", note_id: null, created_at: "2026-11-04T11:30:00Z", version: 1, ...over,
});
const ask = (over: Partial<Ask> = {}): Ask => ({
  id: "a1", title: "Book the dentist?", body: "", status: "pending", reply: null, answered_at: null, delivered_at: null,
  created_at: "2026-11-04T10:00:00Z", version: 1, options: null, picked: null, ...over,
});

describe("note ideas in For you", () => {
  it("sit with asks, newest first, and only while they wait", () => {
    const items = forYouItems([ask()], [], [proposal(), proposal({ id: "kept", status: "accepted", note_id: "n1" }), proposal({ id: "old", created_at: "2026-11-04T09:00:00Z" })]);
    expect(items.map((i) => i.key)).toEqual(["proposal:p1", "ask:a1", "proposal:old"]);
  });
  it("say what they are, and are read out with why", () => {
    const item = { kind: "proposal" as const, key: "proposal:p1", at: 0, proposal: proposal() };
    expect(headline(item)).toEqual({ kind: "Note idea", title: "Boiler pressure" });
    expect(listenText(item)).toBe("Boiler pressure\n\nKeep it at 1.5 bar.\n\nWhy keep it: He asked twice.");
    expect(listenText({ ...item, proposal: proposal({ why: " " }) })).toBe("Boiler pressure\n\nKeep it at 1.5 bar.");
  });
  it("keep only rows they can show in full", () => {
    const rows = parseProposals([proposal(), { ...proposal(), title: " " }, { ...proposal(), status: "maybe" }, { ...proposal(), version: "1" }, null, "x"]);
    expect(rows.map((r) => r.id)).toEqual(["p1"]);
    expect(parseProposals({ not: "a list" })).toEqual([]);
    expect(parseProposals([{ ...proposal(), note_id: 5 }])[0].note_id).toBeNull();
  });
});

describe("an agent's words", () => {
  it("link only https:, and keep everything else as text", () => {
    expect(linkPieces("See https://langfuse.example/trace/1. Or http://x.example and javascript:alert(1)")).toEqual([
      { text: "See " },
      { text: "https://langfuse.example/trace/1", href: "https://langfuse.example/trace/1" },
      { text: ". Or http://x.example and javascript:alert(1)" },
    ]);
    expect(linkPieces("plain")).toEqual([{ text: "plain" }]);
    expect(linkPieces("")).toEqual([]);
    expect(linkPieces("(https://a.example/x)")).toEqual([{ text: "(" }, { text: "https://a.example/x", href: "https://a.example/x" }, { text: ")" }]);
    expect(linkPieces("https:// nothing")).toEqual([{ text: "https:// nothing" }]);
    // Whatever the pieces, they put the text back together.
    const s = "a https://b.example/c?d=e, f https://g.example";
    expect(linkPieces(s).map((p) => p.text).join("")).toBe(s);
  });
});

describe("deciding", () => {
  it("never reads a refusal as success", () => {
    for (const f of ["offline", "unreachable", "server", "rejected", "not_from_here", "gone", "other"] as const) {
      expect(decideRefusal(f)).not.toMatch(/^(Kept|Dropped)/);
    }
    expect(decideRefusal("not_from_here")).toMatch(/Drop works here/);
    expect(decidedWords("accepted")).toBe("Already kept as a note.");
    expect(decidedWords("denied")).toBe("Already dropped.");
  });
});
