// For you: the assistant's asks and drafts as one list, and everything about answering that isn't a browser, so it can be tested.
// An ask's title and body are hers. The owner's reply is the only text here that is the owner's. An ask can carry options to pick from; their words are
// hers too, and can quote job postings written by strangers, so they are only ever text, and a link only an https: one.
import { titleOf, type Draft } from "../drafts-logic";
import type { Proposal } from "./proposals-logic";
import { NS } from "../ns";
import { ASSISTANT_NAME } from "../ns";

export type AskStatus = "pending" | "accepted" | "denied" | "replied";
export type Verdict = "accept" | "deny" | "reply" | "pick";

export interface AskOption {
  key: string;
  label: string;
  detail: string;
  /** Only ever an https: URL; anything else is dropped here. */
  link: string | null;
}

export interface Ask {
  id: string;
  title: string;
  body: string;
  status: AskStatus;
  reply: string | null;
  answered_at: string | null;
  delivered_at: string | null;
  created_at: string;
  version: number;
  /** Null for a plain ask. */
  options: AskOption[] | null;
  picked: string[] | null;
}

/** One row of For you, newest first whichever kind it is. */
export type ForYouItem = { kind: "ask"; key: string; at: number; ask: Ask } | { kind: "draft"; key: string; at: number; draft: Draft }
  | { kind: "proposal"; key: string; at: number; proposal: Proposal };

const STATUSES: AskStatus[] = ["pending", "accepted", "denied", "replied"];

/** An https: link, or null. A link of any other kind (javascript:, data:, http:) is never shown. */
export function safeLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

/** An ask's options, or undefined when they can't be shown in full. */
function parseOptions(raw: unknown): AskOption[] | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: AskOption[] = [];
  for (const o of raw as Array<Record<string, unknown> | null>) {
    if (!o || typeof o.key !== "string" || typeof o.label !== "string" || o.label.trim() === "") return undefined;
    out.push({ key: o.key, label: o.label, detail: typeof o.detail === "string" ? o.detail : "", link: safeLink(o.link) });
  }
  return out;
}

/** /api/asks, taken apart with care: a row that can't be shown in full isn't shown. */
export function parseAsks(body: unknown): Ask[] {
  if (!Array.isArray(body)) return [];
  const asks: Ask[] = [];
  for (const a of body) {
    const x = a as (Partial<Omit<Ask, "options">> & { options?: unknown }) | null;
    if (!x || typeof x.id !== "string" || typeof x.title !== "string" || x.title.trim() === "" || typeof x.body !== "string"
      || !STATUSES.includes(x.status as AskStatus) || typeof x.created_at !== "string") continue;
    const options = parseOptions(x.options);
    if (options === undefined) continue;
    const picked = Array.isArray(x.picked) && x.picked.every((k) => typeof k === "string") ? x.picked : null;
    asks.push({ ...(x as Ask), options, picked });
  }
  return asks;
}

export function forYouItems(asks: Ask[], drafts: Draft[], proposals: Proposal[] = []): ForYouItem[] {
  const items: ForYouItem[] = [
    ...asks.filter((a) => a.status === "pending").map((ask) => ({ kind: "ask" as const, key: `ask:${ask.id}`, at: Date.parse(ask.created_at) || 0, ask })),
    ...drafts.map((draft) => ({ kind: "draft" as const, key: `draft:${draft.id}`, at: draft.createdMs, draft })),
    ...proposals.filter((p) => p.status === "pending")
      .map((proposal) => ({ kind: "proposal" as const, key: `proposal:${proposal.id}`, at: Date.parse(proposal.created_at) || 0, proposal })),
  ];
  return items.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

/** What a closed card says: the kind in words, then one line. */
export function headline(item: ForYouItem): { kind: string; title: string } {
  if (item.kind === "ask") return { kind: `${ASSISTANT_NAME} asks`, title: item.ask.title };
  if (item.kind === "proposal") return { kind: "Note idea", title: item.proposal.title };
  const d = item.draft;
  const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return { kind: titleOf(d), title: firstLine(d.why) || firstLine(d.text) };
}

/** What Listen reads out: everything the owner could read, in the same order. */
export function listenText(item: ForYouItem): string {
  if (item.kind === "ask") {
    const options = (item.ask.options ?? []).map((o) => [o.label, o.detail].map((s) => s.trim()).filter(Boolean).join(". "));
    return [item.ask.title, item.ask.body, ...options].map((s) => s.trim()).filter(Boolean).join("\n\n");
  }
  if (item.kind === "proposal") {
    const p = item.proposal;
    return [p.title, p.body, p.why.trim() ? `Why keep it: ${p.why}` : ""].map((s) => s.trim()).filter(Boolean).join("\n\n");
  }
  const d = item.draft;
  return [titleOf(d) + ".", d.why ? `${ASSISTANT_NAME} says: ${d.why}` : "", d.text].map((s) => s.trim()).filter(Boolean).join("\n\n");
}

export const statusOf = (v: Verdict): AskStatus => (v === "accept" || v === "pick" ? "accepted" : v === "deny" ? "denied" : "replied");

const sameKeys = (a: string[] | null | undefined, b: string[]) => !!a && a.length === b.length && a.every((k) => b.includes(k));

/** After a 409: an answer already stands. When it's the one the owner just gave, it was this device's own, retried. */
export function sameAnswer(stands: Pick<Ask, "status" | "reply"> & { picked?: string[] | null }, verdict: Verdict, text: string, keys: string[] = []): boolean {
  return stands.status === statusOf(verdict) && (verdict !== "reply" || (stands.reply ?? "") === text.trim())
    && (verdict !== "pick" || sameKeys(stands.picked, keys));
}

/** The labels of what the owner picked, in the ask's order. */
export function pickedLabels(options: AskOption[] | null, picked: string[] | null | undefined): string[] {
  return (options ?? []).filter((o) => picked?.includes(o.key)).map((o) => o.label);
}

/** `options` and `picked` say what the owner chose, for an ask the owner answered by picking; "None of these" is its deny. */
export function answeredWords(status: AskStatus, reply?: string | null, picked?: { options: AskOption[] | null; keys: string[] | null }): string {
  const listed = !!picked?.options;
  switch (status) {
    case "accepted": {
      const labels = listed ? pickedLabels(picked.options, picked.keys) : [];
      return labels.length ? `Picked: ${labels.join("; ")}. ${ASSISTANT_NAME} will hear it.` : `Accepted. ${ASSISTANT_NAME} will hear it.`;
    }
    case "denied": return listed ? `None of these. ${ASSISTANT_NAME} will hear it.` : `Denied. ${ASSISTANT_NAME} will hear it.`;
    case "replied": return reply ? `Replied: ${reply}` : `Replied. ${ASSISTANT_NAME} will hear it.`;
    default: return "";
  }
}

/** Why an answer didn't go, in words, by the gateway's code or what went wrong on the way. None of these is success. */
export function answerRefusal(fail: "offline" | "unreachable" | "server" | "rejected" | "not_from_here" | "gone" | "other"): string {
  switch (fail) {
    case "offline": return "You're offline. Nothing was sent; your answer is still here.";
    case "unreachable": return "Couldn't reach Lumbridge, so this may not have been saved. Trying again can't answer twice.";
    case "server": return "Your tasks database isn't reachable right now. Nothing was sent; your answer is still here.";
    case "not_from_here": return `${ASSISTANT_NAME} can operate this device, so answers only work from your other devices.`;
    case "rejected": return "That couldn't be sent as it is. Change it and try again.";
    case "gone": return "This question isn't here any more.";
    default: return "That didn't work. Your answer is still here; try again.";
  }
}

export const replyKey = (id: string) => `${NS}.asks.reply.${id}`;
export const askTag = (id: string) => `ask-${id}`;
