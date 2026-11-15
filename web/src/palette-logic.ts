// The jump palette's arithmetic, kept apart so it can be tested: what's in it, and what a few typed letters pick.

export interface Item {
  /** Where Enter goes: a hash, "#/notes" or "#/t/<address>". */
  href: string;
  label: string;
  /** Other words that find it ("tool list" finds Tools). */
  also?: string[];
  /** Shown small on the right: "Screen", or the machine an agent is on. */
  hint: string;
  kind: "screen" | "agent";
}

/** Lower case, accents off, so "cafe" finds "Café". */
export const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

/**
 * How well `q` (folded) names `text`, or 0 for not at all. The whole name beats its start, its start beats a word's start, a
 * word's start beats anywhere inside, and three or more letters in order with gaps ("gwr" in "gateway-review") come last.
 */
export function score(text: string, q: string): number {
  const t = fold(text);
  if (!q) return 1;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const at = t.indexOf(q);
  if (at > 0 && /[^a-z0-9]/.test(t[at - 1])) return 60;
  if (at > 0) return 40;
  // Two letters in order are in half of everything; it takes three to mean something.
  if (q.length < 3) return 0;
  // In order, with gaps: fewer, shorter gaps score higher, and it never reaches a plain substring.
  let i = 0, gaps = 0, last = -1;
  for (const c of q) {
    const k = t.indexOf(c, i);
    if (k < 0) return 0;
    if (last >= 0 && k > last + 1) gaps++;
    last = k;
    i = k + 1;
  }
  return Math.max(1, 30 - gaps * 4 - Math.floor((last - q.length) / 4));
}

/** The items `query` finds, best first. Ties keep screens before agents, then the order they came in. Empty: everything. */
export function rank(items: Item[], query: string, limit = 50): Item[] {
  const q = fold(query);
  return items
    .map((it, i) => ({ it, i, s: Math.max(score(it.label, q), ...(it.also ?? []).map((a) => score(a, q) - 1)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.it.kind === b.it.kind ? 0 : a.it.kind === "screen" ? -1 : 1) || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.it);
}

/** Arrow keys: down from the last goes to the first, and up from the first to the last. */
export const step = (at: number, by: 1 | -1, count: number) => (count ? (at + by + count) % count : -1);
