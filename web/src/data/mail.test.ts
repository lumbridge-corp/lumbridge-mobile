import { describe, expect, it } from "vitest";
import { mailDraftIds, mailFooter, mailLine, mailRefusal, parseMail } from "./mail-logic";

const body = {
  updated_ms: 1793861000000, spark: "ok", unsorted: 0, fyi_count: 23, noise_count: 34, stale: false,
  rows: [
    { key: "sam:event:abc123", kind: "invite", from: "vendor@example.test", subject: "Vendor pitch", why: "Invite.", draft: null, since_ms: 2 },
    { key: "sam:aaaaa1", kind: "mail", from: "Dana Lee", subject: "Lunch Thursday?", why: "Dana asks.", draft: "1793800000-ab12", since_ms: 4 },
    { key: "sam:aaaaa2", kind: "mail", from: "IRS", subject: "Your notice", sensitive: "government", why: "Government mail.", since_ms: 3 },
    { key: "sam:aaaaa3", kind: "mail", from: "Helpful", subject: null, suspicious: true, why: "Instructions.", since_ms: 1 },
    { key: "sam:aaaaa4", kind: "chat", from: "x", why: "unknown kind" },
    { key: "", kind: "mail", why: "no key" },
    { key: "sam:aaaaa5", kind: "mail", why: "  " },
    null, "x",
  ],
};

describe("the Mail group", () => {
  it("keeps the rows it can show, newest first", () => {
    const m = parseMail(body);
    expect(m.rows.map((r) => r.key)).toEqual(["sam:aaaaa1", "sam:aaaaa2", "sam:event:abc123", "sam:aaaaa3"]);
    expect(m.present).toBe(true);
    expect(parseMail({ rows: [], stale: false })).toMatchObject({ rows: [], present: false });
    expect(parseMail(null).rows).toEqual([]);
  });
  it("shows from and subject, and leaves out a missing subject", () => {
    const [lunch, irs, invite, favor] = parseMail(body).rows;
    expect(mailLine(lunch)).toBe("Dana Lee — Lunch Thursday?");
    expect(mailLine(invite)).toBe("vendor@example.test — Vendor pitch");
    expect(mailLine(favor)).toBe("Helpful");
    expect(favor.suspicious).toBe(true);
    expect(irs).toMatchObject({ sensitive: "government", subject: null, from: "" });
    expect(mailLine(irs)).toBe("");
  });
  it("treats anything but a plain no as sensitive", () => {
    const one = (sensitive: unknown) => parseMail({ rows: [{ key: "sam:aaaaa1", kind: "mail", from: "A", subject: "S", why: "w", sensitive }] }).rows[0];
    expect(one(true).sensitive).toBe("sensitive");
    expect(one(true).subject).toBeNull();
    expect(one(false).subject).toBe("S");
    expect(one(null).subject).toBe("S");
  });
  it("says what else came in, and when sorting is behind", () => {
    const m = parseMail(body);
    expect(mailFooter(m)).toBe("23 FYI · 34 noise");
    expect(mailFooter({ ...m, unsorted: 5 })).toBe("23 FYI · 34 noise · 5 not sorted yet");
    expect(mailFooter({ ...m, unsorted: 5, spark: "down" })).toBe("23 FYI · 34 noise · 5 not sorted yet (sorting is down)");
  });
  it("knows which drafts are a row's", () => {
    expect([...mailDraftIds(parseMail(body))]).toEqual(["1793800000-ab12"]);
  });
  it("never calls a refusal success", () => {
    for (const code of [null, "offline", "not_from_here", "bad_key", "busy", "failed"]) expect(mailRefusal(code)).not.toMatch(/^Done/);
    expect(mailRefusal("not_from_here")).toMatch(/your other devices/);
  });
});
