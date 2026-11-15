export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** The word for pressing, as this device does it: "Click" with a mouse or trackpad, "Tap" on a touch screen. */
export const pressWord = (): "Click" | "Tap" => (matchMedia("(pointer: fine)").matches ? "Click" : "Tap");

/** A button that can't work right now: disabled, and said so to a screen reader too. */
export function setOff(b: HTMLButtonElement, off: boolean) {
  if (b.disabled !== off) b.disabled = off;
  if (off) b.setAttribute("aria-disabled", "true"); else b.removeAttribute("aria-disabled");
}
