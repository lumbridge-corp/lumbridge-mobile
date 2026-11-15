import { describe, expect, it } from "vitest";
import { choiceFit, shortLabel } from "./choices-logic";

describe("short choice labels", () => {
  it("shortens Claude Code's permission menu", () => {
    expect(shortLabel("Yes")).toBe("Yes");
    expect(shortLabel("Yes, allow all edits during this session (shift+tab)")).toBe("Allow all edits this session");
    expect(shortLabel("No, and tell Claude what to do differently (esc)")).toBe("No, tell it what to do");
    expect(shortLabel("Yes, allow all edits in src/ during this session (shift+tab)")).toBe("Allow all edits in src/ this session");
    expect(shortLabel("Yes, and don't ask again for npm test commands in /home/sam/app")).toBe("Yes, don't ask again for npm test commands in /home/sam/app");
    expect(shortLabel("Yes, and auto-accept edits")).toBe("Yes, auto-accept edits");
    expect(shortLabel("Yes, and manually approve edits")).toBe("Yes, approve each edit");
  });

  it("shortens Codex's", () => {
    expect(shortLabel("Yes, proceed (y)")).toBe("Yes");
    expect(shortLabel("Yes, and don't ask again for this command (a)")).toBe("Yes, don't ask again for this command");
    expect(shortLabel("No, and tell Codex what to do differently (esc)")).toBe("No, tell it what to do");
    expect(shortLabel("Yes, just this once")).toBe("Yes, this once");
  });

  it("strips every kind of trailing key hint", () => {
    for (const hint of ["(esc)", "(Esc)", "(enter)", "(tab)", "(shift+tab)", "(ctrl+e)", "(alt+m)", "(n)", "(2)"]) {
      expect(shortLabel(`Something else ${hint}`)).toBe("Something else");
    }
    expect(shortLabel("Keep going (ctrl+e) (esc)")).toBe("Keep going");
  });

  it("never rewrites what it doesn't know", () => {
    expect(shortLabel("feature/native-factory")).toBe("feature/native-factory");
    expect(shortLabel("No, keep planning")).toBe("No, keep planning");
    expect(shortLabel("Use the (old) parser")).toBe("Use the (old) parser");
    expect(shortLabel("Run it (this will delete files)")).toBe("Run it (this will delete files)");
    expect(shortLabel("Yes, allow all edits during this session but not deletes")).toBe("Yes, allow all edits during this session but not deletes");
    expect(shortLabel("No, and tell Claude what to do differently, then stop")).toBe("No, and tell Claude what to do differently, then stop");
  });

  it("leaves a label that is only a hint alone", () => {
    expect(shortLabel("(esc)")).toBe("(esc)");
    expect(shortLabel("  ")).toBe("");
  });
});

describe("how the buttons sit", () => {
  it("rows short labels, stacks long ones and long menus", () => {
    expect(choiceFit(["Yes", "No"])).toBe("row");
    expect(choiceFit(["main", "feature/native-factory", "Something else"])).toBe("row");
    expect(choiceFit(["Yes", "Allow all edits this session", "No, tell it what to do"])).toBe("row");
    expect(choiceFit(["First", "Second", "Third", "Fourth"])).toBe("stack");
    expect(choiceFit(["Yes", "Yes, don't ask again for npm test commands in /home/sam/app", "No, tell it what to do"])).toBe("stack");
  });
});
