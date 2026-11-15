// Note ideas in For you: notes an agent proposed (a coding agent, the assistant), which you keep, edits and keeps, or drops. Everything
// about them that isn't a browser. Every word of a proposal was written by an agent and can quote a stranger, as an ask's can: it is
// only ever text, and a link only an https: one. `proposed_by` is the device the gateway knew it by, not anything the agent said.
import { safeLink } from "./asks-logic";
import { ASSISTANT_NAME } from "../ns";

export type ProposalStatus = "pending" | "accepted" | "denied";

export interface Proposal {
  id: string;
  title: string;
  body: string;
  why: string;
  source: string;
  proposed_by: string;
  status: ProposalStatus;
  note_id: string | null;
  created_at: string;
  version: number;
}

const STATUSES: ProposalStatus[] = ["pending", "accepted", "denied"];
const str = (v: unknown) => typeof v === "string";

/** /api/note-proposals, taken apart with care: a row that can't be shown in full isn't shown. */
export function parseProposals(body: unknown): Proposal[] {
  if (!Array.isArray(body)) return [];
  const out: Proposal[] = [];
  for (const p of body as Array<Record<string, unknown> | null>) {
    if (!p || !str(p.id) || !str(p.title) || (p.title as string).trim() === "" || !str(p.body) || !str(p.why) || !str(p.source)
      || !str(p.proposed_by) || !STATUSES.includes(p.status as ProposalStatus) || !str(p.created_at) || typeof p.version !== "number") continue;
    out.push({
      id: p.id as string, title: p.title as string, body: p.body as string, why: p.why as string, source: p.source as string,
      proposed_by: p.proposed_by as string, status: p.status as ProposalStatus, note_id: str(p.note_id) ? (p.note_id as string) : null,
      created_at: p.created_at as string, version: p.version,
    });
  }
  return out;
}

/** Text in pieces, with each https: URL in it as a link. Anything else that looks like a link (http:, javascript:) stays text. */
export type Piece = { text: string } | { text: string; href: string };

export function linkPieces(text: string): Piece[] {
  const pieces: Piece[] = [];
  let at = 0;
  for (const m of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
    // A sentence's own full stop or closing bracket isn't part of the link.
    const raw = m[0].replace(/[.,;:!?)\]}]+$/, "");
    const href = safeLink(raw);
    if (!href) continue;
    const start = m.index!;
    if (start > at) pieces.push({ text: text.slice(at, start) });
    pieces.push({ text: raw, href });
    at = start + raw.length;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
}

export type DecideFail = "offline" | "unreachable" | "server" | "rejected" | "not_from_here" | "gone" | "other";

/** Why a decision didn't go, in words. None of these is success. */
export function decideRefusal(fail: DecideFail): string {
  switch (fail) {
    case "offline": return "You're offline. Nothing was saved; the idea is still here.";
    case "unreachable": return "Couldn't reach Lumbridge, so this may not have been saved. Trying again can't keep it twice.";
    case "server": return "Your notes database isn't reachable right now. Nothing was saved; the idea is still here.";
    case "not_from_here": return `${ASSISTANT_NAME} can operate this device, so Keep only works from your other devices. Drop works here.`;
    case "rejected": return "That couldn't be saved as it is. Change it and try again.";
    case "gone": return "This idea isn't here any more.";
    default: return "That didn't work. The idea is still here; try again.";
  }
}

/** After a 409: it was decided already, here or on another device. */
export function decidedWords(status: ProposalStatus): string {
  return status === "accepted" ? "Already kept as a note." : status === "denied" ? "Already dropped." : "";
}

export const proposalTag = "note-ideas";
