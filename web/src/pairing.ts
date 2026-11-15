// Reads a pairing code out of what a person pasted or a link's fragment. No DOM: it's unit-tested on its own.
import { ASSISTANT_NAME } from "./ns";
const CODE = /^[0-9a-f]{64}$/;

/** The code in `#pair=<code>`, a whole pairing link, or a bare code; null when it's none of them. */
export function pairCode(text: string): string | null {
  const t = text.trim();
  const hash = t.includes("#") ? t.slice(t.indexOf("#") + 1) : t;
  const code = hash.startsWith("pair=") ? hash.slice(5) : hash;
  return CODE.test(code) ? code : null;
}

/** Where a code came from: a `#pair=` link (opened, or pasted whole), or one typed or pasted on its own. */
export type PairFrom = "link" | "typed";
export const pairFrom = (text: string): PairFrom => (text.includes("#") ? "link" : "typed");

export function pairError(e: unknown, from: PairFrom = "link"): string {
  switch ((e as Error).message) {
    case "bad_code": return from === "typed"
      ? "That code didn't work: it has expired or was already used. Make a new one."
      : "That pairing link has expired or was already used. Make a new one.";
    case "refused": return "This device isn't allowed to use Lumbridge.";
    case "not_from_here": return `${ASSISTANT_NAME} can operate this device, so it can't be paired. Use Lumbridge on another of your devices.`;
    case "too_many": return "Too many failed tries. Wait a few minutes.";
    default: return "Couldn't reach Lumbridge. Is Tailscale on?";
  }
}
