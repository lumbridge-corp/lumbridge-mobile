import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, getTheme, setTheme } from "./theme";
import { NS } from "./ns";

const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
const fakeDoc = () => {
  const attrs = new Map<string, string>();
  const metas = [{ media: "(prefers-color-scheme: dark)", content: "" }, { media: "(prefers-color-scheme: light)", content: "" }];
  const doc = { documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k) }, querySelectorAll: () => metas };
  return { doc: doc as unknown as Document, attrs, metas };
};
afterEach(() => vi.unstubAllGlobals());

describe("theme", () => {
  it("defaults to system, and ignores junk", () => {
    vi.stubGlobal("localStorage", store());
    expect(getTheme()).toBe("system");
    localStorage.setItem(`${NS}.theme`, "purple");
    expect(getTheme()).toBe("system");
  });
  it("remembers dark and light, and system clears the key", () => {
    const f = fakeDoc();
    vi.stubGlobal("localStorage", store());
    vi.stubGlobal("document", f.doc);
    setTheme("light");
    expect(getTheme()).toBe("light");
    expect(f.attrs.get("data-theme")).toBe("light");
    setTheme("system");
    expect(localStorage.getItem(`${NS}.theme`)).toBeNull();
    expect(f.attrs.has("data-theme")).toBe(false);
  });
  it("survives storage that throws", () => {
    const f = fakeDoc();
    vi.stubGlobal("localStorage", { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } });
    vi.stubGlobal("document", f.doc);
    expect(getTheme()).toBe("system");
    expect(() => setTheme("dark")).not.toThrow();
    expect(f.attrs.get("data-theme")).toBe("dark");
  });
  it("points the browser's theme color at the chosen theme, and back", () => {
    const f = fakeDoc();
    applyTheme("light", f.doc);
    expect(f.metas.map((m) => m.content)).toEqual(["#ffffff", "#ffffff"]);
    applyTheme("system", f.doc);
    expect(f.metas.map((m) => m.content)).toEqual(["#0a0a0a", "#ffffff"]);
  });
});
