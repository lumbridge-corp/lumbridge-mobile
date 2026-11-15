import { NS } from "./ns";
// The Infrastructure page's decisions, with no DOM, so they can be tested. The view only draws what these say.

export interface Item { label: string; instance: string; machine: string | null; since_ms: number | null }
export interface Need {
  alert: string; severity: string; count: number; since_ms: number | null; new: boolean;
  summary: string; key: string; items: Item[];
}
export interface Gpu { util_pct: number | null; temp_c: number | null; mem_pct: number | null; name: string }
export interface Machine {
  id: string; label: string; role: string; up: boolean | null;
  cpu_pct: number | null; mem_pct: number | null; disk_pct: number | null; temp_c: number | null;
  gpu: Gpu | null; cpu_history: (number | null)[];
}
export interface Model { name: string; area: string; port: number | null; up: boolean | null }
export interface Backups {
  last_run_age_s: number | null; repos_ok: number; repos_total: number; sources: number;
  sources_failing: { source: string; age_s: number | null }[];
  lake1: { mounted: boolean; used_bytes: number | null; size_bytes: number | null };
}
export interface Phone { up: boolean; battery_pct: number | null; charging: boolean | null; age_s: number | null }
export interface Infra {
  at_ms: number; stale: boolean; age_s: number;
  needs: Need[]; machines: Machine[]; models: Model[]; backups: Backups; phone: Phone | null;
}

/** How long old data goes without comment. Long enough that one missed poll, or a phone waking up, says nothing. */
export const GRACE_S = 90;
/** With nothing on screen there's less to protect, so a failure says so sooner. */
export const FIRST_LOAD_GRACE_S = 8;

// ---- Words ----

/** Spellings plain splitting would get wrong. */
const SPELLED: [RegExp, string][] = [[/\bOpen Claw\b/g, "OpenClaw"], [/\bPitr\b/g, "PITR"]];

/** "UserUnitRestartLoop" to "User unit restart loop". Unknown names still read; none is hidden or special-cased. */
export function alertTitle(name: string): string {
  let spaced = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
  for (const [from, to] of SPELLED) spaced = spaced.replace(from, to);
  return spaced
    .split(" ")
    .map((w, i) => (i === 0 || /^[A-Z0-9]{2,}$/.test(w) || w === "OpenClaw" ? w : w.toLowerCase()))
    .join(" ");
}

/**
 * One plain line for what an alert means, by name, for the ones that actually fire. Each says only what its rule
 * measures, never why: nobody here knows why yet. A name not listed gets the generic line.
 */
const MEANINGS: Record<string, string> = {
  NodeDown: "Monitoring can't reach a machine",
  SiteDown: "A public website isn't answering",
  TailnetAppDown: "An app on the tailnet isn't answering",
  StorageMountMissing: "A disk that should be mounted isn't",
  SystemdUnitFailed: "A system service ended in failure",
  SystemdBackupUnitFailed: "A backup job ended in failure",
  UserUnitFailed: "A user service ended in failure",
  UserUnitRestartLoop: "A service keeps crashing and restarting",
  MeshNodeLostWiredBackhaul: "A Wifi point lost its wired link and fell back to wireless",
};
export const GENERIC_MEANING = "Monitoring is reporting a problem";

export function alertMeaning(name: string): string {
  return Object.hasOwn(MEANINGS, name) ? MEANINGS[name] : GENERIC_MEANING;
}

export function severityWord(severity: string): string {
  if (severity === "critical") return "Critical";
  if (severity === "warning") return "Warning";
  if (severity === "info") return "Info";
  return "Alert";
}

/** A blackbox instance is a whole URL; on a phone only the host and port say anything. */
export function shortInstance(instance: string): string {
  return instance.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/\.[a-z0-9-]+\.ts\.net/, "");
}

/** What a row says after the name, leaving out what would only repeat it. */
export function itemPlace(item: Item): string {
  const place = shortInstance(item.instance);
  return place === item.label ? "" : place;
}

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 172800) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} days`;
}

export function fmtAgo(seconds: number | null): string {
  if (seconds === null) return "unknown";
  return seconds < 10 ? "just now" : `${fmtDuration(seconds)} ago`;
}

export function fmtPct(v: number | null): string {
  return v === null ? "–" : `${Math.round(v)}%`;
}

export function fmtTemp(v: number | null): string {
  return v === null ? "–" : `${Math.round(v)}°`;
}

/** Binary, as `df -h` counts, so a number here matches the one in a terminal. */
export function fmtBytes(bytes: number | null): string {
  if (bytes === null) return "–";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export type Level = "ok" | "warn" | "bad";

export function usageLevel(pct: number | null): Level {
  if (pct === null || pct < 85) return "ok";
  return pct < 95 ? "warn" : "bad";
}

export function tempLevel(c: number | null): Level {
  if (c === null || c < 80) return "ok";
  return c < 92 ? "warn" : "bad";
}

export function batteryLevel(pct: number | null, charging: boolean | null): Level {
  if (pct === null || charging) return "ok";
  if (pct < 10) return "bad";
  return pct < 20 ? "warn" : "ok";
}

export type MachineState = "up" | "down" | "unknown";
export const machineState = (up: boolean | null): MachineState => (up === null ? "unknown" : up ? "up" : "down");

// ---- What needs the owner ----

/** New ones first; otherwise the gateway's order, worst severity then newest. */
export function orderNeeds(needs: Need[]): Need[] {
  return [...needs.filter((n) => n.new), ...needs.filter((n) => !n.new)];
}

export type Dismissed = Record<string, string>;
/** Where this device keeps them (Infra and Today both read it). */
export const DISMISSED_KEY = `${NS}.infra.dismissed`;

/** Dismissals are this device's: `key` to the alert's name. Anything unreadable counts as nothing dismissed. */
export function loadDismissed(raw: string | null): Dismissed {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string")) as Dismissed;
  } catch {
    return {};
  }
}

export function splitNeeds(needs: Need[], dismissed: Dismissed): { shown: Need[]; hidden: Need[] } {
  const ordered = orderNeeds(needs);
  return { shown: ordered.filter((n) => !(n.key in dismissed)), hidden: ordered.filter((n) => n.key in dismissed) };
}

/** A key nobody reports any more has done its job. Its set changed, so the group came back on its own. */
export function pruneDismissed(dismissed: Dismissed, needs: Need[]): Dismissed {
  const live = new Set(needs.map((n) => n.key));
  return Object.fromEntries(Object.entries(dismissed).filter(([k]) => live.has(k)));
}

/** New is whatever fired in the last hour (the gateway's call). Both keep the gateway's order: worst first, then newest, so the oldest ends each list. */
export function sectionNeeds(needs: Need[]): { fresh: Need[]; ongoing: Need[] } {
  return { fresh: needs.filter((n) => n.new), ongoing: needs.filter((n) => !n.new) };
}

export function severityCounts(needs: Need[]): string {
  const crit = needs.filter((n) => n.severity === "critical").length;
  const others = needs.length - crit;
  return [crit ? `${crit} critical` : "", others ? `${others} other${others === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
}

/**
 * How it reads after the severity. One thing has been going on "for 3 days", or "started 5 min ago" while that's still
 * the news. Several began at their own times, so a group says when the newest did.
 */
export function needTime(need: Need, nowMs: number): string {
  if (need.since_ms === null) return "";
  const s = (nowMs - need.since_ms) / 1000;
  if (need.count > 1) return `newest ${fmtAgo(s)}`;
  return s < 3600 ? `started ${fmtAgo(s)}` : `for ${fmtDuration(s)}`;
}

export function itemTime(item: Item, nowMs: number): string {
  return item.since_ms === null ? "" : fmtDuration((nowMs - item.since_ms) / 1000);
}

/**
 * The line at the top when there's nothing to show. "All clear" is a claim about now, so it isn't made on old data, and
 * it isn't made when the owner is only moved the alerts out of sight.
 */
export function clearLine(hiddenCount: number, dataAgeS: number): string {
  if (dataAgeS >= GRACE_S) return `No alerts as of ${fmtAgo(dataAgeS)}`;
  return hiddenCount ? "Nothing else needs you" : "All clear";
}

// ---- Freshness ----

export interface LinkState {
  hasData: boolean;
  /** Seconds since the data on screen was read from Prometheus. */
  dataAgeS: number;
  /** The gateway says it has never reached Prometheus. */
  neverReached: boolean;
  /** Seconds since this page started asking, while it has nothing. */
  waitingS: number;
  /** The device itself has no network. */
  offline?: boolean;
}

export const NOT_LOADED_OFFLINE = "Not loaded: you're offline.";

/** The calm banner. Null during the grace period, and whenever the data is current. */
export function linkNote(s: LinkState): string | null {
  if (s.hasData) {
    return s.dataAgeS >= GRACE_S ? `No fresh data for ${fmtDuration(s.dataAgeS)}. Showing the last good reading.` : null;
  }
  // Nothing is coming until the network is back, so there's no waiting to do first.
  if (s.offline) return NOT_LOADED_OFFLINE;
  if (s.neverReached || s.waitingS >= FIRST_LOAD_GRACE_S) return "Monitoring isn't answering yet. This keeps trying.";
  return null;
}

export function headline(hasData: boolean, dataAgeS: number): string {
  if (!hasData) return "Loading";
  return dataAgeS < 10 ? "Updated just now" : `Updated ${fmtDuration(dataAgeS)} ago`;
}

// ---- Sections ----

export function modelsSummary(models: Model[]): string {
  const up = models.filter((m) => m.up === true).length;
  return `${up} of ${models.length} up`;
}

export function reposLine(b: Backups): string {
  return b.repos_total ? `${b.repos_ok} of ${b.repos_total} OK` : "No data";
}

export function sourcesLine(b: Backups): string {
  if (!b.sources) return "No data";
  const n = b.sources_failing.length;
  return n ? `${n} of ${b.sources} failing` : `${b.sources}, all fresh`;
}

export function lakeShare(b: Backups): number | null {
  const { used_bytes: used, size_bytes: size } = b.lake1;
  return used === null || size === null || size <= 0 ? null : Math.min(100, (100 * used) / size);
}

export function phoneLine(p: Phone | null): string {
  if (!p) return "Not reporting yet";
  const parts: string[] = [];
  if (p.battery_pct !== null) parts.push(p.charging ? `${Math.round(p.battery_pct)}%, charging` : `${Math.round(p.battery_pct)}%`);
  else if (p.charging) parts.push("Charging");
  if (p.age_s !== null) parts.push(fmtAgo(p.age_s));
  return parts.join(" · ") || "No data";
}

export const AREA_WORDS: Record<string, string> = {
  brain: "Brain", "speech in": "Speech in", "voice out": "Voice out", vision: "Vision", search: "Search", image: "Image",
};

export function areaWord(area: string): string {
  return AREA_WORDS[area] ?? area;
}

// ---- The sparkline, as points. viewBox is 0 0 100 30. ----

export interface SparkScale {
  /** Fix the bottom of the scale. */
  lo?: number;
  /** Never let the scale span less than this, so a machine idling between 1% and 3% doesn't draw a mountain. */
  minSpan?: number;
}

const PAD = 2;
const num = (v: number) => String(Math.round(v * 100) / 100);

/** One `points` string per unbroken run, so a null leaves a gap. A lone point gets a short dash, or it wouldn't draw. */
export function sparkLines(values: (number | null)[], scale: SparkScale = {}): string[] {
  const known = values.filter((v): v is number => v !== null);
  if (!known.length) return [];
  const lo = scale.lo ?? Math.min(...known);
  let hi = Math.max(...known);
  if (scale.minSpan !== undefined) hi = Math.max(hi, lo + scale.minSpan);
  const span = hi - lo;
  const last = Math.max(1, values.length - 1);
  const x = (i: number) => (i / last) * 100;
  // max == min: a level line through the middle rather than a division by zero.
  const y = (v: number) => (span <= 0 ? 15 : 30 - PAD - ((v - lo) / span) * (30 - 2 * PAD));
  const runs: string[] = [];
  let run: string[] = [];
  const close = (i: number) => {
    if (run.length === 1) {
      const px = i - 1;
      const v = values[px] as number;
      run = [`${num(Math.max(0, x(px) - 0.8))},${num(y(v))}`, `${num(Math.min(100, x(px) + 0.8))},${num(y(v))}`];
    }
    if (run.length) runs.push(run.join(" "));
    run = [];
  };
  values.forEach((v, i) => {
    if (v === null) close(i);
    else run.push(`${num(x(i))},${num(y(v))}`);
  });
  close(values.length);
  return runs;
}

export function sparkLabel(values: (number | null)[]): string {
  const known = values.filter((v): v is number => v !== null);
  if (!known.length) return "No CPU history";
  return `CPU over the last hour, peak ${Math.round(Math.max(...known))}%`;
}

// ---- Tabs ----

export type InfraTab = "machines" | "models" | "lakes" | "services";
export const INFRA_TABS: { id: InfraTab; label: string }[] = [
  { id: "machines", label: "Machines" }, { id: "models", label: "Models" }, { id: "lakes", label: "Lakes" }, { id: "services", label: "Services" },
];
/** Where this device keeps the tab it was last on. */
export const TAB_KEY = `${NS}.infra.tab`;
const isTab = (t: string | null | undefined): t is InfraTab => INFRA_TABS.some((x) => x.id === t);

/** `infra/<tab>` names its tab; a bare `infra` is the one this device was last on, else Machines. Anything else is Machines. */
export function tabOf(route: string, remembered: string | null): InfraTab {
  const [, sub] = route.split("/");
  if (isTab(sub)) return sub;
  return isTab(remembered) ? remembered : "machines";
}
