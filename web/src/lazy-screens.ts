// Screens the owner rarely opens first come as their own chunks, so the first screen's download doesn't carry them (ui-verify's cold load).
// The worker precaches every one on install (public/sw.js, CHUNKS; web/vite.config.ts lists them), so they still open offline after a deploy.
import { el } from "./dom";

type View = (root: HTMLElement) => () => void;
/** Under this a chunk from the cache is simply there: no "Opening…" flashed on the way. */
const QUIET_MS = 200;

export function lazy(name: string, load: () => Promise<View>): View {
  return (root) => {
    let stop: (() => void) | null = null;
    let gone = false;
    root.replaceChildren();
    const slow = setTimeout(() => { if (!gone && !stop) root.replaceChildren(el("p", "center", `Opening ${name}…`)); }, QUIET_MS);
    load().then(
      (view) => { clearTimeout(slow); if (!gone) stop = view(root); },
      () => {
        clearTimeout(slow);
        if (gone) return;
        // A browser won't try a failed import again until the page reloads, so that's the way back.
        const box = el("div", "center");
        const again = el("button", "btn", "Reload");
        again.type = "button";
        again.onclick = () => location.reload();
        box.append(el("p", "", `Couldn't load ${name}. Check the connection, then reload.`), again);
        root.replaceChildren(box);
      },
    );
    return () => { gone = true; clearTimeout(slow); stop?.(); };
  };
}

export const filesView = lazy("Files", () => import("./views/files").then((m) => m.filesView));
export const settingsView = lazy("Settings", () => import("./views/settings").then((m) => m.settingsView));
