// Stands in for the desktop: a normal viewer holding each fixture terminal at a desktop's size, because the last
// active viewer sets a terminal's size and it goes back to the default without one. Runs inside the scratch core.
//   node scripts/dev-fixture-viewer.mjs <port> <token-file>
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const [port, tokenFile] = process.argv.slice(2);
const require = createRequire(new URL("../web/package.json", import.meta.url));
const WebSocket = require("ws");
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
const frame = (ch, kind, p) => { const b = Buffer.alloc(9 + p.length); b.writeUInt32LE(ch, 0); b[4] = kind; b.writeUInt32LE(p.length, 5); Buffer.from(p).copy(b, 9); return b; };
let n = 0; const waiting = new Map();
const call = (method, params = {}) => new Promise((ok) => { const id = ++n; waiting.set(id, ok); ws.send(frame(0, 0, JSON.stringify({ jsonrpc: "2.0", id, method, params }))); });
await new Promise((ok, no) => { ws.on("error", no); ws.on("open", () => ws.send(readFileSync(tokenFile, "utf8").trim())); ws.once("message", ok); });
ws.on("message", (d) => {
  const ch = d.readUInt32LE(0), body = d.subarray(9);
  if (ch === 0) { const m = JSON.parse(body.toString()); waiting.get(m.id)?.(m.result ?? m.error); waiting.delete(m.id); return; }
  if (d[4] === 0) { const c = Buffer.alloc(4); c.writeUInt32LE(body.length); ws.send(frame(ch, 1, c)); }
});
const { terminals } = await call("terminal.list");
const narrow = new Set(["web-tests", "docs-pass"]);
for (const t of terminals) {
  if (!t.reported || t.name?.startsWith("storm-") || t.name === "desktop-viewer") continue;
  const [cols, rows] = narrow.has(t.name) ? [100, 40] : [220, 50];
  await call("terminal.attach", { terminal: t.address, cols, rows });
}
console.log("holding sizes");
ws.on("close", () => process.exit(0));
