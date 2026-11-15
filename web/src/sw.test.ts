import { describe, expect, it } from "vitest";
// @ts-expect-error A plain script, shared with `npm run build` and the deploy script.
import { problems } from "../scripts/check-sw.mjs";
import source from "../public/sw.js?raw";

describe("the service worker check", () => {
  it("passes the real worker", () => {
    expect(problems(source, { built: false })).toEqual([]);
  });
  it("refuses an empty file", () => {
    expect(problems("").length).toBeGreaterThan(0);
  });
  it("refuses a worker without a push handler, even one that mentions it", () => {
    const without = source.replace('self.addEventListener("push"', '// "push"\nvoid ("push"');
    expect(problems(without, { built: false })).toEqual(["no push handler"]);
  });
  it("refuses a worker that doesn't run", () => {
    expect(problems("self.addEventListener(")[0]).toMatch(/doesn't run/);
  });
  it("refuses a built worker with no build stamp", () => {
    expect(problems(source.replaceAll("__CHUNKS__", "/assets/a.js"))).toEqual(["the cache name was never stamped with the build"]);
  });
  it("refuses a built worker whose chunks to precache were never filled in", () => {
    expect(problems(source.replaceAll("__BUILD__", "abc123"))).toEqual(["the list of chunks to precache was never filled in"]);
  });
});
