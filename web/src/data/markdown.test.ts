import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, plainLine } from "./markdown";

describe("inline", () => {
  it("reads the common marks", () => {
    expect(parseInline("a **b** *c* _d_ `e`")).toEqual([
      { t: "text", v: "a " }, { t: "strong", c: [{ t: "text", v: "b" }] }, { t: "text", v: " " },
      { t: "em", c: [{ t: "text", v: "c" }] }, { t: "text", v: " " }, { t: "em", c: [{ t: "text", v: "d" }] },
      { t: "text", v: " " }, { t: "code", v: "e" },
    ]);
  });
  it("leaves stray marks and snake_case alone", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([{ t: "text", v: "2 * 3 * 4" }]);
    expect(parseInline("snake_case_name")).toEqual([{ t: "text", v: "snake_case_name" }]);
    expect(parseInline("\\*not em\\*")).toEqual([{ t: "text", v: "*not em*" }]);
  });
  it("only links to http, https and mailto", () => {
    expect(parseInline("[x](https://a.b)")).toEqual([{ t: "link", href: "https://a.b", c: [{ t: "text", v: "x" }] }]);
    expect(parseInline("[x](mailto:a@b.c)")[0]).toMatchObject({ t: "link" });
    for (const bad of ["[x](javascript:alert(1))", "[x](data:text/html,hi)", "[x](vbscript:y)", "[x](JaVaScRiPt:alert)"]) {
      expect(parseInline(bad).every((n) => n.t === "text")).toBe(true);
    }
  });
  it("links bare urls without the sentence's punctuation", () => {
    expect(parseInline("see https://a.b/c.")).toEqual([
      { t: "text", v: "see " }, { t: "link", href: "https://a.b/c", c: [{ t: "text", v: "https://a.b/c" }] }, { t: "text", v: "." },
    ]);
  });
  it("never produces markup out of html", () => {
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([{ t: "text", v: "<img src=x onerror=alert(1)>" }]);
  });
});

describe("blocks", () => {
  it("reads headings, lists, quotes, code and rules", () => {
    const b = parseMarkdown("# One\n\npara\nmore\n\n- a\n- [x] b\n- [ ] c\n\n1. x\n2. y\n\n> q\n> r\n\n```\ncode\n# not a heading\n```\n\n---\nend");
    expect(b.map((x) => x.t)).toEqual(["heading", "para", "list", "list", "quote", "code", "rule", "para"]);
    expect(b[2]).toMatchObject({ ordered: false, items: [{ done: null }, { done: true }, { done: false }] });
    expect(b[3]).toMatchObject({ ordered: true });
    expect(b[5]).toEqual({ t: "code", v: "code\n# not a heading" });
  });
  it("survives an unclosed fence and an empty note", () => {
    expect(parseMarkdown("```\nabc")).toEqual([{ t: "code", v: "abc" }]);
    expect(parseMarkdown("")).toEqual([]);
  });
});

describe("plainLine", () => {
  it("takes the markup out", () => {
    expect(plainLine("# Title\n- **bold** and [link](https://x.y)")).toBe("Title bold and link");
  });
});
