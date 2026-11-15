// Cmd-K (Ctrl-K off a Mac) opens the jump palette. Only this listener is in the first download: the palette itself is its own
// chunk, fetched the first time it's asked for (ui-verify's cold-load budget).
const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** For a tooltip: the keys, as this keyboard has them. */
export const paletteKeys = mac ? "⌘K" : "Ctrl+K";

let loading: Promise<typeof import("./palette")> | null = null;

export function openPalette() {
  const back = document.activeElement as HTMLElement | null;
  loading ??= import("./palette");
  loading.then((m) => m.showPalette(back), () => { loading = null; });
}

export function initPaletteKey() {
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "k" || e.altKey || e.shiftKey || !(mac ? e.metaKey : e.ctrlKey)) return;
    // Ctrl-K means something to a shell and to an editor's line: inside a terminal it's the terminal's.
    if (!mac && (e.target as Element | null)?.closest?.(".term")) return;
    e.preventDefault();
    openPalette();
  }, true);
}
