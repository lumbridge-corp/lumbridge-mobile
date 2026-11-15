import { describe, expect, it } from "vitest";
import {
  alertMeaning, alertTitle, batteryLevel, clearLine, fmtAgo, fmtBytes, fmtDuration, fmtPct, fmtTemp, GENERIC_MEANING, GRACE_S, headline, itemPlace, lakeShare,
  linkNote, loadDismissed, machineState, modelsSummary, needTime, orderNeeds, phoneLine, pruneDismissed, reposLine, sectionNeeds, severityCounts,
  shortInstance, sourcesLine, sparkLabel, sparkLines, splitNeeds, tempLevel, usageLevel, type Backups, type Need,
} from "./infra-logic";

const need = (o: Partial<Need>): Need => ({
  alert: "A", severity: "warning", count: 1, since_ms: 0, new: false, summary: "", key: o.alert ?? "A", items: [], ...o,
});
const backups = (o: Partial<Backups> = {}): Backups => ({
  last_run_age_s: 60, repos_ok: 2, repos_total: 2, sources: 56, sources_failing: [],
  lake1: { mounted: true, used_bytes: 25, size_bytes: 100 }, ...o,
});

describe("New and Ongoing", () => {
  it("splits on the gateway's word, keeping its order: critical first, the oldest last", () => {
    const list = [
      need({ alert: "crit-old", severity: "critical", since_ms: 500 }), need({ alert: "crit-new", severity: "critical", new: true, since_ms: 900 }),
      need({ alert: "warn-new", new: true, since_ms: 950 }), need({ alert: "warn-old", since_ms: 400 }), need({ alert: "warn-oldest", since_ms: 100 }),
    ];
    const { fresh, ongoing } = sectionNeeds(list);
    expect(fresh.map((n) => n.alert)).toEqual(["crit-new", "warn-new"]);
    expect(ongoing.map((n) => n.alert)).toEqual(["crit-old", "warn-old", "warn-oldest"]);
  });

  it("says what each firing alert means, and invents nothing for the rest", () => {
    expect(alertMeaning("UserUnitRestartLoop")).toBe("A service keeps crashing and restarting");
    for (const name of ["NodeDown", "SiteDown", "TailnetAppDown", "StorageMountMissing", "SystemdUnitFailed", "UserUnitFailed", "MeshNodeLostWiredBackhaul"]) {
      expect(alertMeaning(name)).not.toBe(GENERIC_MEANING);
    }
    expect(alertMeaning("SomethingBrandNew")).toBe(GENERIC_MEANING);
    expect(alertMeaning("constructor")).toBe(GENERIC_MEANING);
  });
});

describe("words", () => {
  it("turns alert names into plain words", () => {
    expect(alertTitle("UserUnitRestartLoop")).toBe("User unit restart loop");
    expect(alertTitle("TailnetAppDown")).toBe("Tailnet app down");
    expect(alertTitle("OpenClawGatewayDown")).toBe("OpenClaw gateway down");
    expect(alertTitle("KopiaBackupVeryStale")).toBe("Kopia backup very stale");
    expect(alertTitle("HTTPErrorRate")).toBe("HTTP error rate");
    expect(alertTitle("AcmePitrBasebackupStale")).toBe("Acme PITR basebackup stale");
    expect(alertTitle("disk_nearly_full")).toBe("disk nearly full");
    expect(alertTitle("Watchdog")).toBe("Watchdog");
  });

  it("shortens a blackbox URL to its host and port", () => {
    expect(shortInstance("https://build-box.example-tailnet.ts.net:8460/")).toBe("build-box:8460");
    expect(shortInstance("https://music.example.com/")).toBe("music.example.com");
    expect(shortInstance("old-laptop")).toBe("old-laptop");
  });

  it("doesn't say a machine's name twice", () => {
    expect(itemPlace({ label: "old-laptop", instance: "old-laptop", machine: "old-laptop", since_ms: 0 })).toBe("");
    expect(itemPlace({ label: "Music", instance: "https://music.example.com/", machine: null, since_ms: 0 })).toBe("music.example.com");
  });

  it("formats time, percentages and bytes, with null as a dash", () => {
    expect(fmtDuration(42)).toBe("42 s");
    expect(fmtDuration(600)).toBe("10 min");
    expect(fmtDuration(7200)).toBe("2 h");
    expect(fmtDuration(86400 * 3)).toBe("3 days");
    expect(fmtDuration(-5)).toBe("0 s");
    expect(fmtAgo(3)).toBe("just now");
    expect(fmtAgo(120)).toBe("2 min ago");
    expect(fmtAgo(null)).toBe("unknown");
    expect(fmtPct(null)).toBe("–");
    expect(fmtPct(0)).toBe("0%");
    expect(fmtTemp(null)).toBe("–");
    expect(fmtTemp(44.6)).toBe("45°");
    expect(fmtBytes(null)).toBe("–");
    expect(fmtBytes(15349525921792)).toBe("14 TB");
    expect(fmtBytes(4238178160640)).toBe("3.9 TB");
    expect(fmtBytes(512)).toBe("512 B");
  });
});

describe("levels", () => {
  it("only colours what deserves it, and null is never alarming", () => {
    expect([usageLevel(null), usageLevel(84), usageLevel(85), usageLevel(95)]).toEqual(["ok", "ok", "warn", "bad"]);
    expect([tempLevel(null), tempLevel(79), tempLevel(80), tempLevel(92)]).toEqual(["ok", "ok", "warn", "bad"]);
    expect([batteryLevel(null, false), batteryLevel(5, true), batteryLevel(5, false), batteryLevel(15, false), batteryLevel(50, null)])
      .toEqual(["ok", "ok", "bad", "warn", "ok"]);
  });

  it("tells down from no data", () => {
    expect([machineState(true), machineState(false), machineState(null)]).toEqual(["up", "down", "unknown"]);
  });
});

describe("what needs the owner", () => {
  it("puts new first and otherwise keeps the gateway's order", () => {
    const list = [need({ alert: "crit", severity: "critical" }), need({ alert: "w1" }), need({ alert: "w2", new: true }), need({ alert: "w3" })];
    expect(orderNeeds(list).map((n) => n.alert)).toEqual(["w2", "crit", "w1", "w3"]);
  });

  it("hides a dismissed group only while its key is the same", () => {
    const list = [need({ alert: "a", key: "k1" }), need({ alert: "b", key: "k2" })];
    const { shown, hidden } = splitNeeds(list, { k1: "a" });
    expect(shown.map((n) => n.alert)).toEqual(["b"]);
    expect(hidden.map((n) => n.alert)).toEqual(["a"]);
    // The set changed, so the key did, so it's back.
    expect(splitNeeds([need({ alert: "a", key: "k9" })], { k1: "a" }).shown).toHaveLength(1);
  });

  it("forgets dismissals nobody reports any more", () => {
    expect(pruneDismissed({ k1: "a", gone: "b" }, [need({ key: "k1" })])).toEqual({ k1: "a" });
  });

  it("survives whatever is in storage", () => {
    expect(loadDismissed(null)).toEqual({});
    expect(loadDismissed("not json")).toEqual({});
    expect(loadDismissed("[1,2]")).toEqual({});
    expect(loadDismissed("null")).toEqual({});
    expect(loadDismissed('{"a":"x","b":3}')).toEqual({ a: "x" });
  });

  it("counts by what matters", () => {
    expect(severityCounts([need({ severity: "critical" }), need({}), need({ severity: "info" })])).toBe("1 critical, 2 others");
    expect(severityCounts([need({})])).toBe("1 other");
    expect(severityCounts([need({ severity: "critical" })])).toBe("1 critical");
    expect(severityCounts([])).toBe("");
  });

  it("says latest for a group and since for one thing", () => {
    expect(needTime(need({ count: 1, since_ms: 0 }), 3600_000)).toBe("for 1 h");
    expect(needTime(need({ count: 1, since_ms: 0 }), 86400_000 * 3)).toBe("for 3 days");
    expect(needTime(need({ count: 1, since_ms: 0 }), 600_000)).toBe("started 10 min ago");
    expect(needTime(need({ count: 1, since_ms: 0 }), 3_000)).toBe("started just now");
    expect(needTime(need({ count: 5, since_ms: 0 }), 3600_000)).toBe("newest 1 h ago");
    expect(needTime(need({ since_ms: null }), 3600_000)).toBe("");
  });

  it("doesn't claim all clear on old data or with alerts tucked away", () => {
    expect(clearLine(0, 5)).toBe("All clear");
    expect(clearLine(2, 5)).toBe("Nothing else needs you");
    expect(clearLine(0, GRACE_S)).toBe("No alerts as of 1 min ago");
    expect(clearLine(2, 600)).toBe("No alerts as of 10 min ago");
  });
});

describe("freshness", () => {
  const link = { hasData: true, dataAgeS: 0, neverReached: false, waitingS: 0 };

  it("stays quiet through the grace period", () => {
    expect(linkNote({ ...link, dataAgeS: GRACE_S - 1 })).toBeNull();
    expect(linkNote({ ...link, dataAgeS: GRACE_S })).toContain("1 min");
    expect(linkNote({ ...link, dataAgeS: 600 })).toContain("Showing the last good reading");
  });

  it("with nothing to show, says so once it's clear nothing is coming", () => {
    const empty = { ...link, hasData: false };
    expect(linkNote({ ...empty, waitingS: 1 })).toBeNull();
    expect(linkNote({ ...empty, waitingS: 8 })).toContain("isn't answering");
    expect(linkNote({ ...empty, neverReached: true })).toContain("isn't answering");
  });

  it("offline with nothing loaded, says so at once; with data, the age says enough", () => {
    expect(linkNote({ ...link, hasData: false, offline: true })).toBe("Not loaded: you're offline.");
    expect(linkNote({ ...link, hasData: false, offline: true, neverReached: true, waitingS: 30 })).toBe("Not loaded: you're offline.");
    expect(linkNote({ ...link, offline: true, dataAgeS: 5 })).toBeNull();
  });

  it("keeps its headline honest", () => {
    expect(headline(false, 0)).toBe("Loading");
    expect(headline(true, 3)).toBe("Updated just now");
    expect(headline(true, 300)).toBe("Updated 5 min ago");
  });
});

describe("sections", () => {
  it("counts a model with no data as not up", () => {
    const m = (up: boolean | null) => ({ name: "m", area: "", port: 1, up });
    expect(modelsSummary([m(true), m(false), m(null)])).toBe("1 of 3 up");
  });

  it("reads backups", () => {
    expect(reposLine(backups())).toBe("2 of 2 OK");
    expect(reposLine(backups({ repos_total: 0, repos_ok: 0 }))).toBe("No data");
    expect(sourcesLine(backups())).toBe("56, all fresh");
    expect(sourcesLine(backups({ sources: 0 }))).toBe("No data");
    expect(sourcesLine(backups({ sources_failing: [{ source: "s", age_s: 1 }] }))).toBe("1 of 56 failing");
    expect(lakeShare(backups())).toBe(25);
    expect(lakeShare(backups({ lake1: { mounted: false, used_bytes: null, size_bytes: null } }))).toBeNull();
    expect(lakeShare(backups({ lake1: { mounted: true, used_bytes: 1, size_bytes: 0 } }))).toBeNull();
  });

  it("reads the phone, with null metrics left out", () => {
    expect(phoneLine(null)).toBe("Not reporting yet");
    expect(phoneLine({ up: true, battery_pct: 81, charging: true, age_s: 120 })).toBe("81%, charging · 2 min ago");
    expect(phoneLine({ up: true, battery_pct: 81, charging: false, age_s: null })).toBe("81%");
    expect(phoneLine({ up: false, battery_pct: null, charging: null, age_s: null })).toBe("No data");
  });
});

describe("sparkline", () => {
  it("has nothing to draw with no data", () => {
    expect(sparkLines([])).toEqual([]);
    expect(sparkLines([null, null])).toEqual([]);
    expect(sparkLabel([null])).toBe("No CPU history");
  });

  it("draws a level line when max equals min, with no NaN", () => {
    const [line] = sparkLines([5, 5, 5]);
    expect(line).toBe("0,15 50,15 100,15");
  });

  it("splits at nulls so gaps show", () => {
    const lines = sparkLines([1, 2, null, 3, 4]);
    expect(lines).toHaveLength(2);
    expect(lines[0].split(" ")).toHaveLength(2);
    expect(lines[1].split(" ")).toHaveLength(2);
    expect(lines[0].startsWith("0,")).toBe(true);
    expect(lines[1].endsWith(",2")).toBe(true);
  });

  it("gives a lone point something to draw", () => {
    const lines = sparkLines([null, 7, null, 1, 2]);
    expect(lines).toHaveLength(2);
    expect(lines[0].split(" ")).toHaveLength(2);
    const [a, b] = lines[0].split(" ").map((p) => p.split(",").map(Number));
    expect(a[1]).toBe(b[1]);
    expect(a[0]).toBeLessThan(b[0]);
  });

  it("stays inside the viewBox and puts high values at the top", () => {
    const [line] = sparkLines([0, 100, 50]);
    const points = line.split(" ").map((p) => p.split(",").map(Number));
    for (const [x, y] of points) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(30);
    }
    expect(points[1][1]).toBeLessThan(points[0][1]);
  });

  it("doesn't make a mountain of an idle machine", () => {
    const [line] = sparkLines([1, 3], { lo: 0, minSpan: 20 });
    const ys = line.split(" ").map((p) => Number(p.split(",")[1]));
    for (const y of ys) expect(y).toBeGreaterThan(24);
  });

  it("names its peak", () => {
    expect(sparkLabel([1, 44.6, null])).toBe("CPU over the last hour, peak 45%");
  });
});

describe("tabs", () => {
  it("takes the tab from the route, then what this device remembers, then Machines", async () => {
    const { tabOf } = await import("./infra-logic");
    expect(tabOf("infra/services", "models")).toBe("services");
    expect(tabOf("infra/lakes", null)).toBe("lakes");
    expect(tabOf("infra", "models")).toBe("models");
    expect(tabOf("infra", null)).toBe("machines");
    expect(tabOf("infra/nope", "junk")).toBe("machines");
    expect(tabOf("infra/__proto__", "constructor")).toBe("machines");
  });
});
