import { describe, expect, it } from "vitest";
import { afterLoad, notLoadedText } from "./first-load";

describe("a list's first load", () => {
  it("is loaded only once a GET has worked", () => {
    expect(afterLoad("loading", true, true)).toBe("loaded");
    expect(afterLoad("offline", true, false)).toBe("loaded");
  });
  it("a failure before that is not an empty list, and says why", () => {
    expect(afterLoad("loading", false, false)).toBe("offline");
    expect(afterLoad("loading", false, true)).toBe("unreachable");
    expect(afterLoad("offline", false, true)).toBe("unreachable");
  });
  it("a failure after a load doesn't take the list away", () => {
    expect(afterLoad("loaded", false, false)).toBe("loaded");
    expect(afterLoad("loaded", false, true)).toBe("loaded");
  });
  it("only a failed first load gets the line", () => {
    expect(notLoadedText("offline")).toBe("Not loaded: you're offline.");
    expect(notLoadedText("unreachable")).toBe("Can't reach Lumbridge right now.");
    expect(notLoadedText("loading")).toBeNull();
    expect(notLoadedText("loaded")).toBeNull();
  });
});
