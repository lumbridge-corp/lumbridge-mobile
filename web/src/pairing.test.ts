import { describe, expect, it } from "vitest";
import { pairCode, pairError, pairFrom } from "./pairing";

const code = "ab".repeat(32);

describe("pairCode", () => {
  it("finds the code in a fragment, a link and on its own", () => {
    expect(pairCode(`#pair=${code}`)).toBe(code);
    expect(pairCode(`https://mobile.example.com/#pair=${code}`)).toBe(code);
    expect(pairCode(`  ${code}\n`)).toBe(code);
  });
  it("refuses anything else", () => {
    for (const bad of ["", "#/agents", "#pair=", "#pair=short", `#token=${code}`, code.slice(1), `${code}00`, code.toUpperCase()]) {
      expect(pairCode(bad)).toBeNull();
    }
  });
});

describe("pairError", () => {
  it("says something useful for each failure", () => {
    expect(pairError(new Error("bad_code"))).toMatch(/expired/);
    expect(pairError(new Error("refused"))).toMatch(/allowed/);
    expect(pairError(new Error("not_from_here"))).toMatch(/Assistant can operate/);
    expect(pairError(new Error("too_many"))).toMatch(/Wait/);
    expect(pairError(new TypeError("Failed to fetch"))).toMatch(/Tailscale/);
  });
  it("calls a typed code a code, and a link a link", () => {
    expect(pairError(new Error("bad_code"), "typed")).toBe("That code didn't work: it has expired or was already used. Make a new one.");
    expect(pairError(new Error("bad_code"), "link")).toBe("That pairing link has expired or was already used. Make a new one.");
    expect(pairError(new Error("bad_code"))).toBe("That pairing link has expired or was already used. Make a new one.");
    expect(pairError(new Error("too_many"), "typed")).toMatch(/Wait/);
  });
  it("knows a typed code from a link", () => {
    expect(pairFrom(`  ${code}\n`)).toBe("typed");
    expect(pairFrom("not a code")).toBe("typed");
    expect(pairFrom(`#pair=${code}`)).toBe("link");
    expect(pairFrom(`https://mobile.example.com/#pair=${code}`)).toBe("link");
  });
});
