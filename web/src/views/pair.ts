import { host, isWeb, redeemPairCode } from "../api";
import { el } from "../dom";
import { pairCode, pairError, pairFrom } from "../pairing";

/**
 * Spends a `#pair=` code from the address, if there is one. The fragment goes first, whatever happens next, so it
 * doesn't linger. Returns what to tell the person, or "" when there was no code or it worked.
 */
export async function redeemFragment(): Promise<string> {
  if (!location.hash.startsWith("#pair=")) return "";
  const code = pairCode(location.hash);
  history.replaceState(null, "", `${location.pathname}#/today`);
  if (!code) return pairError(new Error("bad_code"));
  try {
    await redeemPairCode(code);
    return "";
  } catch (e) {
    return pairError(e);
  }
}

// For when there's no link to tap: the Tauri app, or a home-screen install that keeps its own storage.
export function pairView(root: HTMLElement, err: string, done: () => void) {
  const box = el("form", "center pair");
  box.append(el("h1", "", "Lumbridge"));
  const message = el("p", "err", err);
  if (err) box.append(message);
  const hostBox = el("input");
  hostBox.placeholder = "mobile.example.com";
  hostBox.value = host() ?? "";
  if (!isWeb) box.append(hostBox);
  const link = el("input");
  link.placeholder = "Pairing link";
  // Not type=password: iOS would offer saved passwords over the Connect button. It's a one-time code anyway.
  link.type = "text";
  link.autocomplete = "off";
  link.autocapitalize = "off";
  link.spellcheck = false;
  box.append(link, el("button", "primary", "Connect"));
  box.onsubmit = async (e) => {
    e.preventDefault();
    if (!isWeb) host(hostBox.value.trim());
    const code = pairCode(link.value);
    const from = pairFrom(link.value);
    link.value = "";
    try {
      if (!code) throw new Error("bad_code");
      await redeemPairCode(code);
      done();
    } catch (failure) {
      message.textContent = pairError(failure, from);
      if (!message.isConnected) box.insertBefore(message, box.children[1] ?? null);
    }
  };
  root.replaceChildren(box);
}
