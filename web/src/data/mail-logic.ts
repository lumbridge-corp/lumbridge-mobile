// The Mail group in For you: what in your inbox needs you, as the assistant's triage sorted it. Everything about it that isn't a browser.
// Every word in a row is a stranger's (who wrote, the subject) or the assistant's about a stranger's (why). They only go in through
// textContent, after visibleText, and a sensitive row shows none but `why`.
import { ASSISTANT_NAME } from "../ns";

export type MailCategory = "needs_you" | "fyi" | "noise";
export const CATEGORIES: { value: MailCategory; label: string }[] = [
  { value: "needs_you", label: "Needs you" },
  { value: "fyi", label: "FYI" },
  { value: "noise", label: "Noise" },
];

export interface MailRow {
  key: string;
  kind: "mail" | "invite";
  from: string;
  subject: string | null;
  /** What kind of sensitive, or null. A sensitive row shows only `why`, behind a lock. */
  sensitive: string | null;
  suspicious: boolean;
  why: string;
  /** A mail_reply draft's id: its card goes under this row and nowhere else in For you. */
  draft: string | null;
  sinceMs: number;
}

export interface MailListing {
  rows: MailRow[];
  stale: boolean;
  spark: string;
  unsorted: number;
  fyiCount: number;
  noiseCount: number;
  /** The gateway sent a `mail` at all: without it there's no footer to show. */
  present: boolean;
}

export const NO_MAIL: MailListing = { rows: [], stale: false, spark: "ok", unsorted: 0, fyiCount: 0, noiseCount: 0, present: false };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** /api/mail, taken apart with care: a row without a key or a why isn't shown, and newest comes first. */
export function parseMail(body: unknown): MailListing {
  const b = (body ?? {}) as Record<string, unknown>;
  const rows: MailRow[] = (Array.isArray(b.rows) ? b.rows : []).flatMap((r): MailRow[] => {
    const x = (r ?? {}) as Record<string, unknown>;
    const key = str(x.key), why = str(x.why);
    if (!key || !why.trim() || (x.kind !== "mail" && x.kind !== "invite")) return [];
    const sensitive = x.sensitive === null || x.sensitive === undefined || x.sensitive === false ? null : str(x.sensitive) || "sensitive";
    return [{
      key, kind: x.kind, why, sensitive,
      from: sensitive ? "" : str(x.from),
      subject: sensitive ? null : str(x.subject) || null,
      suspicious: x.suspicious === true,
      draft: str(x.draft) || null,
      sinceMs: num(x.since_ms),
    }];
  });
  rows.sort((a, c) => c.sinceMs - a.sinceMs || a.key.localeCompare(c.key));
  return {
    rows,
    stale: b.stale === true,
    spark: str(b.spark) || "ok",
    unsorted: num(b.unsorted),
    fyiCount: num(b.fyi_count),
    noiseCount: num(b.noise_count),
    present: typeof b.updated_ms === "number",
  };
}

/** `from — subject`, the subject left out when there's none. Never for a sensitive row. */
export function mailLine(r: MailRow): string {
  if (r.sensitive) return "";
  return [r.from.trim(), r.subject?.trim() ?? ""].filter(Boolean).join(" — ");
}

/** Under the rows: what else came in, and what triage hasn't got to. */
export function mailFooter(m: MailListing): string {
  const parts = [`${m.fyiCount} FYI · ${m.noiseCount} noise`];
  const down = m.spark !== "ok";
  if (m.unsorted > 0 || down) parts.push(`${m.unsorted} not sorted yet${down ? " (sorting is down)" : ""}`);
  return parts.join(" · ");
}

/** The drafts that belong under a mail row, so For you doesn't list them twice. */
export const mailDraftIds = (m: MailListing) => new Set(m.rows.flatMap((r) => (r.draft ? [r.draft] : [])));

/** Why Done or a sort didn't go, by the gateway's code or what went wrong on the way. */
export function mailRefusal(code: string | null): string {
  switch (code) {
    case null: return "Couldn't reach Lumbridge. Nothing changed; try again.";
    case "offline": return "You're offline. Nothing changed.";
    case "not_from_here": return `${ASSISTANT_NAME} can operate this device, so this only works from your other devices.`;
    case "bad_key": case "bad_request": return "That can't be changed from here.";
    case "busy": return "Busy for a moment. Try again.";
    default: return `${ASSISTANT_NAME}'s inbox sorting didn't take that. Try again in a moment.`;
  }
}
