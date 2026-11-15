// The agents inbox as data: which rows go where, in what order. No DOM, so it can be tested.
import { bucket, type Bucket, type Terminal } from "./core";
import { isAgent, LOCAL_MACHINE, machineName, machineOf } from "./app";

export interface Group { key: string; title: string; cls: string; rows: Terminal[]; collapsible?: boolean; count?: number }
export interface InboxOptions {
  machine: string | null;       // only this machine
  byMachine: boolean;           // group by machine instead of by state
  holds?: Map<string, Bucket>;  // keep these rows in a bucket while they are open
}

const HEADINGS: [Bucket, string][] = [["needs", "Needs you"], ["done", "Done"], ["working", "Working"], ["idle", "Idle"]];
const RANK: Record<Bucket, number> = { needs: 0, done: 1, working: 2, idle: 3 };

export const isPinned = (t: Terminal) => !!t.labels?.["lumbridge.pinned"];

/** Looking at a done row writes `lumbridge.seen`, which would move it to Idle from under you. A held row waits. */
export function bucketOf(t: Terminal, holds?: Map<string, Bucket>): Bucket {
  const b = bucket(t);
  const held = holds?.get(t.address);
  return held && b === "idle" ? held : b;
}

/** Pinned first. Then newest change first, except Working, which churns: there the order stays put. */
export function compareRows(b: Bucket) {
  return (x: Terminal, y: Terminal) =>
    Number(isPinned(y)) - Number(isPinned(x))
    || (b === "working" ? 0 : (y.status_ms ?? 0) - (x.status_ms ?? 0))
    || (x.created_ms ?? 0) - (y.created_ms ?? 0)
    || x.address.localeCompare(y.address);
}

export const machinesIn = (terminals: Iterable<Terminal>) => {
  const seen = new Set<string>();
  for (const t of terminals) if (t.state === "live") seen.add(machineOf(t));
  const rest = [...seen].filter((m) => m !== LOCAL_MACHINE).sort();
  return seen.has(LOCAL_MACHINE) ? [LOCAL_MACHINE, ...rest] : rest;
};

export function layoutInbox(terminals: Iterable<Terminal>, o: InboxOptions): Group[] {
  const live = [...terminals].filter((t) => t.state === "live" && (!o.machine || machineOf(t) === o.machine));
  const agents = live.filter(isAgent);
  const shells = live.filter((t) => !isAgent(t)).sort((x, y) => (x.created_ms ?? 0) - (y.created_ms ?? 0) || x.address.localeCompare(y.address));
  const groups: Group[] = [];
  if (o.byMachine) {
    for (const m of machinesIn(agents)) {
      const rows = agents.filter((t) => machineOf(t) === m).sort((x, y) => {
        const bx = bucketOf(x, o.holds), by = bucketOf(y, o.holds);
        return RANK[bx] - RANK[by] || compareRows(bx)(x, y);
      });
      groups.push({ key: `machine:${m}`, title: machineName(m), cls: "machine", rows });
    }
  } else {
    for (const [b, title] of HEADINGS) {
      const rows = agents.filter((t) => bucketOf(t, o.holds) === b).sort(compareRows(b));
      if (rows.length) groups.push({ key: b, title, cls: b, rows });
    }
  }
  if (shells.length) groups.push({ key: "shells", title: "Shells", cls: "shells", rows: shells, collapsible: true });
  return groups;
}

export function summarize(terminals: Iterable<Terminal>) {
  const n = { needs: 0, done: 0, working: 0, idle: 0, agents: 0 };
  for (const t of terminals) {
    if (t.state !== "live" || !isAgent(t)) continue;
    n[bucket(t)]++;
    n.agents++;
  }
  return n;
}

export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The end of a path is the part that says which project this is. */
export function shortFolder(path: string, max = 34): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  let out = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i--) {
    if (out.length + parts[i].length + 3 > max) break;
    out = `${parts[i]}/${out}`;
  }
  return `…/${out}`;
}

/** The folder as a row shows it. Home says nothing, so it isn't shown. */
export const showFolder = (path: string, max?: number) => (path === "~" ? "" : shortFolder(path, max));

export const stateWord: Record<string, string> = {
  blocked: "Waiting", error: "Error", working: "Working", done: "Done", idle: "Idle",
};
export const kindWord: Record<string, string> = { permission: "Permission", question: "Question", auth: "Sign-in" };

/** Everything a row shows, as one comparable value: if it hasn't changed, the row isn't touched. */
export function reorderKey(groups: Group[]): string {
  return groups.map((g) => `${g.key}:${g.rows.map((r) => r.address).join(",")}`).join("|");
}
