import { NS } from "./ns";
// Theme choice: System, Dark or Light, remembered per device. Storage can be blocked, so every touch of it is in try/catch.
// public/theme-boot.js applies the saved choice before the first paint; this is the same rule for changes after that.
export type Theme = "system" | "dark" | "light";
export const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "System" }, { id: "dark", label: "Dark" }, { id: "light", label: "Light" },
];
const KEY = `${NS}.theme`;
const COLOR = { dark: "#0a0a0a", light: "#ffffff" } as const;

export function getTheme(): Theme {
  try { const t = localStorage.getItem(KEY); return t === "dark" || t === "light" ? t : "system"; } catch { return "system"; }
}

export function applyTheme(t: Theme, doc: Document = document) {
  const root = doc.documentElement;
  if (t === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", t);
  // The browser chrome follows too: a forced theme sets both metas, System puts back the one per scheme.
  for (const m of doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = (m.media || "").includes("light") ? "light" : "dark";
    m.content = t === "system" ? COLOR[scheme] : COLOR[t];
  }
}

export function setTheme(t: Theme) {
  try { if (t === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* this visit only */ }
  applyTheme(t);
}
