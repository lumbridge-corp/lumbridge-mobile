// Fails when a service worker can't do its job, so an empty or handler-less sw.js can't ship: `npm run build` runs this on
// the built file, the deploy script runs it again, and src/sw.test.ts proves it refuses the bad cases. A merge once left
// sw.js empty; everything else still passed, and no notification would ever have shown.
//   node scripts/check-sw.mjs [file]           a built worker (default dist/sw.js)
//   node scripts/check-sw.mjs --source <file>  web/public/sw.js, before its build stamp
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const NEEDED = ["install", "activate", "fetch", "push", "notificationclick"];

/** Runs the worker's top level with a stand-in `self`. Returns what's wrong, or nothing. */
export function problems(source, { built = true } = {}) {
  const seen = new Set();
  const self = { addEventListener: (type) => seen.add(type), registration: {}, clients: {}, skipWaiting() {} };
  try {
    vm.runInNewContext(source, { self, caches: {}, fetch() {}, URL, location: { origin: "https://mobile.example.com" } }, { timeout: 1000 });
  } catch (e) {
    return [`it doesn't run: ${e.message}`];
  }
  const out = NEEDED.filter((t) => !seen.has(t)).map((t) => `no ${t} handler`);
  if (built && source.includes("__BUILD__")) out.push("the cache name was never stamped with the build");
  if (built && source.includes("__CHUNKS__")) out.push("the list of chunks to precache was never filled in");
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const source = process.argv[2] === "--source";
  const file = process.argv[source ? 3 : 2] ?? "dist/sw.js";
  const wrong = problems(readFileSync(file, "utf8"), { built: !source });
  if (wrong.length) {
    console.error(`${file}: ${wrong.join("; ")}`);
    process.exit(1);
  }
}
