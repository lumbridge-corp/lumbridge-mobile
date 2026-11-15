// End to end: the real non-dev gateway, with TLS + PROXY exactly as tailscale serve drives it, against a SCRATCH core.
//   node tests/e2e.mjs <port>     uses <port> to <port>+6 (tests/ports.mjs) (cd web && npm ci first; cargo builds what it needs)
// `tailscale whois` is a fixture here, so the admission rule runs for every kind of node without touching the tailnet.
// It never connects to a real core: every process gets its own XDG dirs and LBC_SESSION.
import { execFileSync, spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import https from "node:https";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { portAt, stopOnExit } from "./ports.mjs";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const WebSocket = require("ws");
const port = Number(process.argv[2] ?? 18519);
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = `/run/user/${process.getuid()}/ke${port}`;
const LOGIN = "sam@example.com", ORIGIN = "https://mobile.example.com", TAILNET = "example-tailnet.ts.net";

let failed = 0, passed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${ok ? "" : extra}`); if (ok) passed++; else failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- scratch world
rmSync(dir, { recursive: true, force: true });
for (const d of ["", "state", "bin", "s", "c", "d", "web"]) mkdirSync(join(dir, d), { recursive: true, mode: 0o700 });
const cleanEnv = { ...process.env };
for (const k of Object.keys(cleanEnv)) if (k.startsWith("CLAUDE")) delete cleanEnv[k];
Object.assign(cleanEnv, { LBC_SESSION: "e", XDG_STATE_HOME: join(dir, "s"), XDG_RUNTIME_DIR: dir, XDG_CONFIG_HOME: join(dir, "c"), XDG_DATA_HOME: join(dir, "d") });
const hc = (...args) => execFileSync("lbc", args, { env: cleanEnv, stdio: ["ignore", "pipe", "ignore"] });

const whois = (name, tags, login) => JSON.stringify({ Node: { Name: `${name}.${TAILNET}.`, ComputedName: name, ...(tags.length ? { Tags: tags } : {}) }, UserProfile: { LoginName: login } });
const nodes = {
  pixel: ["100.64.0.11", whois("assistant-phone", [], LOGIN)],
  iphone: ["100.64.0.12", whois("sam-iphone", [], LOGIN)],
  build: ["100.64.0.13", whois("build-box", ["tag:build"], "tagged-devices")],
  laptop: ["100.64.0.14", whois("laptop", ["tag:desk"], "tagged-devices")],
  desk: ["100.64.0.15", whois("desk", ["tag:server"], "tagged-devices")],
  cloud: ["100.64.0.16", whois("vps", ["tag:server"], "tagged-devices")],
  guestMac: ["100.64.0.17", whois("guest-macbook-pro", ["tag:guest", "tag:server"], "tagged-devices")],
  guestPhone: ["100.64.0.18", whois("guest-iphone", [], "guest@example.com")],
  guestPc: ["100.64.0.19", whois("sam-small", [], LOGIN)],
  // On the owner's login and not on the list: nothing else needs to be said about them.
  iphone12: ["100.64.0.20", whois("sam-iphone-12", [], LOGIN)],
  renamed: ["100.64.0.21", whois("hp-guest", [], LOGIN)],
  listedOtherLogin: ["100.64.0.22", whois("assistant-phone", [], "guest@example.com")],
  foreignLaptop: ["100.64.0.23", JSON.stringify({ Node: { Name: "build-box.other-example-tailnet.ts.net.", Tags: ["tag:x"] }, UserProfile: { LoginName: "tagged-devices" } })],
};
const arms = Object.values(nodes).map(([ip, json]) => `  ${ip}) echo '${json}' ;;`).join("\n");
const fake = join(dir, "bin/tailscale");
writeFileSync(fake, `#!/bin/sh\n[ "$1 $2" = "whois --json" ] || exit 9\ncase "$3" in\n${arms}\n  100.64.0.201) echo 'not json' ;;\n  100.64.0.202) sleep 30 ;;\n  *) echo "no such peer" >&2; exit 1 ;;\nesac\n`);
chmodSync(fake, 0o755);

function makeCert(name, cn) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2", "-subj", `/CN=${cn}`,
    "-addext", `subjectAltName=DNS:${cn}`, "-keyout", join(dir, `${name}.key`), "-out", join(dir, `${name}.crt`)], { stdio: "ignore" });
}
makeCert("cert", "mobile.example.com");
writeFileSync(join(dir, "web/index.html"), "<!doctype html><title>scratch</title>");

// A port nothing else holds: if the gateway wrongly opened its plain listener too, it would be on this one.
const plainPort = portAt(port, "plain");
const gatewayEnv = {
  ...cleanEnv, LUMBRIDGE_LOGIN: LOGIN, LUMBRIDGE_TAILNET: TAILNET, LUMBRIDGE_ALLOWED_NODES: "assistant-phone,sam-iphone,laptop,desk,build-box,rig",
  // The assistant has a shell on desk and build-box and taps assistant-phone; that phone may pair all the same.
  LUMBRIDGE_ASSISTANT_NODES: "assistant-phone,desk,build-box", LUMBRIDGE_PAIRS_ANYWAY: "assistant-phone",
  LUMBRIDGE_TAILSCALE: fake, LUMBRIDGE_ORIGINS: `${ORIGIN},https://tauri.localhost,http://tauri.localhost,tauri://localhost`, LUMBRIDGE_TLS_BIND: `127.0.0.1:${port}`,
  LUMBRIDGE_BIND: `127.0.0.1:${plainPort}`, LUMBRIDGE_TLS_CERT: join(dir, "cert.crt"), LUMBRIDGE_TLS_KEY: join(dir, "cert.key"), LUMBRIDGE_WEB: join(dir, "web"), LUMBRIDGE_STATE_DIR: join(dir, "state"),
};
const cargo = (...args) => execFileSync("cargo", args, { cwd: join(repo, "gateway"), stdio: ["ignore", "ignore", "inherit"] });
cargo("build");
const bin = join(repo, "gateway/target/debug/lumbridge-mobile-server");
const cli = (...args) => execFileSync(bin, args, { env: { LUMBRIDGE_STATE_DIR: gatewayEnv.LUMBRIDGE_STATE_DIR, LUMBRIDGE_ORIGINS: gatewayEnv.LUMBRIDGE_ORIGINS }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

hc("run", "--bg", "--name", "pm-e2e", "bash");
let gatewayLog = "";
const gateway = spawn(bin, [], { env: gatewayEnv, stdio: ["ignore", "ignore", "pipe"] });
gateway.stderr.on("data", (d) => { gatewayLog += d; });
// However the run ends (a crash, Ctrl-C, a cancelled job), the gateways and the scratch core go with it.
stopOnExit(() => {
  gateway.kill();
  for (const g of globalThis.othersToStop ?? []) g.kill();
  try { hc("server", "stop"); } catch {}
  rmSync(dir, { recursive: true, force: true });
});
const finish = (code) => {
  console.log(failed ? `${failed} FAILED, ${passed} passed` : `ALL ${passed} PASSED`);
  process.exit(code);
};
process.on("uncaughtException", (e) => { console.log(`FAIL crashed: ${e.stack}`); failed++; finish(1); });
for (let i = 0; i < 100 && !gatewayLog.includes("TLS + PROXY on"); i++) await sleep(100);
check("gateway started on TLS + PROXY", gatewayLog.includes("TLS + PROXY on"), gatewayLog);

// ---- client: what tailscale serve sends, then TLS
const SIG = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
function proxyV2(ip) {
  const h = Buffer.alloc(28); SIG.copy(h); h[12] = 0x21; h[13] = 0x11; h.writeUInt16BE(12, 14);
  ip.split(".").forEach((o, i) => { h[16 + i] = Number(o); });
  [127, 0, 0, 1].forEach((o, i) => { h[20 + i] = o; });
  h.writeUInt16BE(40000, 24); h.writeUInt16BE(443, 26);
  return h;
}
// Which gateway the helpers below talk to. The later sections start others with different settings.
let target = port;
function agentFrom(preamble) {
  const agent = new https.Agent({ keepAlive: false, rejectUnauthorized: false });
  agent.createConnection = (opts, cb) => {
    const raw = net.connect(target, "127.0.0.1");
    if (preamble) raw.write(preamble);
    return tls.connect({ socket: raw, rejectUnauthorized: false, servername: "mobile.example.com", ALPNProtocols: opts.ALPNProtocols ?? ["http/1.1"] }, () => cb?.(null));
  };
  return agent;
}
const from = (ip) => agentFrom(proxyV2(ip));
function request(agent, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = https.request({ host: "127.0.0.1", port, path, method, agent, headers: { host: "mobile.example.com", ...headers }, timeout: 8000 }, (res) => {
      let data = ""; res.on("data", (d) => { data += d; }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message, headers: {}, body: "" }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
}
const post = (agent, path, json, headers = {}) => request(agent, path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(json) });
const get = (who, path, headers) => request(from(nodes[who][0]), path, { headers });

// ---- PROXY
check("TLS without a PROXY header is refused", (await request(agentFrom(null), "/healthz")).status === 0);
check("a malformed PROXY header is refused", (await request(agentFrom(Buffer.from("PROXY TCP4 100.64.0.11 127.0.0.1 1 443\r\n")), "/healthz")).status === 0);
const local = Buffer.alloc(16); SIG.copy(local); local[12] = 0x20; local[13] = 0;
check("a PROXY LOCAL header is refused", (await request(agentFrom(local), "/healthz")).status === 0);
check("plain HTTP isn't served when TLS is on", await new Promise((r) => { const s = net.connect(plainPort, "127.0.0.1"); s.on("connect", () => { s.destroy(); r(false); }); s.on("error", () => r(true)); }));

// ---- admission, using the real rule
for (const who of ["pixel", "iphone", "build"]) check(`${who} is admitted`, (await get(who, "/")).status === 200);
// Refused means the socket closes after the PROXY header: no TLS, no HTTP, nothing to hold open.
const closedBeforeTls = (r) => r.status === 0 && !r.body.includes("scratch");
for (const who of ["cloud", "guestMac", "guestPhone", "guestPc", "foreignLaptop", "iphone12", "renamed", "listedOtherLogin"]) {
  const r = await get(who, "/");
  check(`${who} gets no page`, closedBeforeTls(r), String(r.status));
}
check("a source not on the tailnet is refused", closedBeforeTls(await request(from("203.0.113.12"), "/")));
check("loopback in the PROXY header is refused", (await request(from("127.0.0.1"), "/")).status === 403);
check("a node whois doesn't know is refused", closedBeforeTls(await request(from("100.64.0.209"), "/")));
check("unparseable whois is refused", closedBeforeTls(await request(from("100.64.0.201"), "/")));
check("whois that hangs is refused", closedBeforeTls(await request(from("100.64.0.202"), "/")));
check("/healthz from an admitted node", (await get("build", "/healthz")).body === "ok");
check("/healthz from a refused node is refused", closedBeforeTls(await get("cloud", "/healthz")));

// ---- headers
const page = await get("pixel", "/");
const h = page.headers;
check("CSP", /default-src 'self'/.test(h["content-security-policy"] ?? "") && /frame-ancestors 'none'/.test(h["content-security-policy"]));
check("nosniff", h["x-content-type-options"] === "nosniff");
check("no-referrer", h["referrer-policy"] === "no-referrer");
check("HSTS", /max-age=\d+/.test(h["strict-transport-security"] ?? ""));
check("refusals carry the headers too", (await get("pixel", "/", { origin: "https://evil.example" })).headers["x-content-type-options"] === "nosniff");
check("the page is never cached", h["cache-control"] === "no-store");

// ---- CORS
const options = (who, origin, extra = {}) => request(from(nodes[who][0]), "/api/pair", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type", ...extra } });
for (const o of ["https://tauri.localhost", "http://tauri.localhost", "tauri://localhost", ORIGIN]) {
  const r = await options("pixel", o);
  check(`preflight from ${o}`, r.status === 204 && r.headers["access-control-allow-origin"] === o && /authorization/.test(r.headers["access-control-allow-headers"]), JSON.stringify(r.headers));
}
const evil = await options("pixel", "https://evil.example");
check("preflight from an unknown origin refused", evil.status === 403 && !evil.headers["access-control-allow-origin"]);
check("preflight from a refused node refused", (await options("guestPhone", "https://tauri.localhost")).status === 0);
const pna = await options("pixel", "https://tauri.localhost", { "access-control-request-private-network": "true" });
check("private network preflight", pna.headers["access-control-allow-private-network"] === "true");
const refusedOrigin = await post(from(nodes.pixel[0]), "/api/pair", { code: "x" }, { origin: "https://evil.example" });
check("a request from an unknown origin is refused", refusedOrigin.status === 403 && !refusedOrigin.headers["access-control-allow-origin"]);

// ---- pairing
const pairLink = (name) => {
  const link = cli("pair", name).trim();
  const m = link.match(/^https:\/\/mobile\.example\.com\/#pair=([0-9a-f]{64})$/);
  check(`link for ${name} has the right shape`, !!m);
  return m[1];
};
const code = pairLink("pixel");
const devicesFile = join(gatewayEnv.LUMBRIDGE_STATE_DIR, "devices.json");
check("devices.json is 0600", (statSync(devicesFile).mode & 0o777) === 0o600);
check("the code isn't stored", !readFileSync(devicesFile, "utf8").includes(code));
check("a refused node can't spend a code", (await post(from(nodes.guestPhone[0]), "/api/pair", { code })).status === 0);
// The assistant has a shell on these, so a token there would be its to make: refused, and the code isn't spent.
for (const who of ["build", "desk"]) {
  const r = await post(from(nodes[who][0]), "/api/pair", { code });
  check(`${who} can't pair: the assistant can operate it`, r.status === 403 && JSON.parse(r.body || "{}").error === "not_from_here", r.body);
}
// The phone it taps may pair (LUMBRIDGE_PAIRS_ANYWAY). Its token approves nothing: the Approve checks below use this very token.
const paired = await post(from(nodes.pixel[0]), "/api/pair", { code }, { origin: "https://tauri.localhost" });
const pixelToken = JSON.parse(paired.body || "{}").token ?? "";
check("the code buys a token", paired.status === 200 && pixelToken.length === 64 && JSON.parse(paired.body).device === "pixel");
check("the answer isn't cacheable and allows the origin", paired.headers["cache-control"] === "no-store" && paired.headers["access-control-allow-origin"] === "https://tauri.localhost" && /Origin/.test(paired.headers.vary ?? ""));
check("the token isn't stored", !readFileSync(devicesFile, "utf8").includes(pixelToken));
check("the hash is", readFileSync(devicesFile, "utf8").includes(createHash("sha256").update(pixelToken).digest("hex")));
const again = await post(from(nodes.laptop[0]), "/api/pair", { code });
check("a code works once", again.status === 401 && JSON.parse(again.body).error === "bad_code");
check("nothing secret in the gateway's log", !gatewayLog.includes(pixelToken) && !gatewayLog.includes(code));
check("the CLI lists it", /^pixel\s+active/m.test(cli("devices")));
check("as one of the owner's", /^pixel\s+active.*\sowner$/m.test(cli("devices")), cli("devices"));

// ---- Approve, judged by a fresh whois of the device asking. No approve command here, so a draft that may be decided is "not_pending".
const bearer = { authorization: `Bearer ${pixelToken}` };
for (const who of ["pixel", "build", "desk", "iphone", "laptop"]) {
  const operable = ["pixel", "build", "desk"].includes(who);
  const list = await request(from(nodes[who][0]), "/api/assistant/needs", { headers: bearer });
  check(`${who}: the list says whether Approve works here`, list.status === 200 && JSON.parse(list.body).approveHere === !operable, list.body);
  const yes = await post(from(nodes[who][0]), "/api/assistant/drafts/1793758374-ec32/approve", { digest: "x" }, bearer);
  check(`${who}: approve ${operable ? "refused" : "goes on to the draft"}`, operable ? yes.status === 403 && JSON.parse(yes.body).error === "not_from_here" : yes.status === 404, `${yes.status} ${yes.body}`);
  const no = await post(from(nodes[who][0]), "/api/assistant/drafts/1793758374-ec32/reject", {}, bearer);
  check(`${who}: reject goes on to the draft`, no.status === 404 && JSON.parse(no.body).error === "not_pending", `${no.status} ${no.body}`);
}

// ---- failed attempts
const bad = from(nodes.iphone[0]);
let last;
for (let i = 0; i < 10; i++) last = await post(from(nodes.iphone[0]), "/api/pair", { code: "wrong" });
check("failures answer 401", last.status === 401);
check("the next one is rate limited", (await post(bad, "/api/pair", { code: "wrong" })).status === 429);
check("another device isn't affected", (await post(from(nodes.laptop[0]), "/api/pair", { code: "wrong" })).status === 401);
const tripped = pairLink("iphone-blocked");
check("a good code waits out the limit", (await post(from(nodes.iphone[0]), "/api/pair", { code: tripped })).status === 429);

// ---- WebSocket: admission, token, allowlist
const frame = (ch, kind, p) => { const b = Buffer.alloc(9 + p.length); b.writeUInt32LE(ch, 0); b[4] = kind; b.writeUInt32LE(p.length, 5); Buffer.from(p).copy(b, 9); return b; };
const wsOpts = (ip, headers = {}) => ({ agent: from(ip), rejectUnauthorized: false, headers: { host: "mobile.example.com", ...headers } });
function tryWs(ip, tok, headers) {
  return new Promise((res) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, wsOpts(ip, headers));
    ws.on("unexpected-response", (_q, r) => res(`http ${r.statusCode}`));
    ws.on("error", (e) => res(`error ${e.message}`));
    ws.on("open", () => ws.send(tok));
    ws.on("message", (d, bin) => { if (!bin) { const m = JSON.parse(d); res(m.error ?? "accepted"); ws.close(); } });
  });
}
check("ws: refused node", (await tryWs(nodes.guestPhone[0], pixelToken)).startsWith("error"));
check("ws: a rate-limited source is told so, not sent to pair again", (await tryWs(nodes.iphone[0], pixelToken)) === "rate_limited");
check("ws: foreign origin", (await tryWs(nodes.pixel[0], pixelToken, { origin: "https://evil.example" })) === "http 403");
check("ws: bad token", (await tryWs(nodes.build[0], "x".repeat(64))) === "bad_token");
check("ws: the hash of a token isn't a token", (await tryWs(nodes.build[0], createHash("sha256").update(pixelToken).digest("hex"))) === "bad_token");

const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, wsOpts(nodes.pixel[0], { origin: ORIGIN }));
const waiting = new Map(); let n = 0; const streams = new Map();
await new Promise((res, rej) => { ws.on("error", rej); ws.on("open", () => ws.send(pixelToken)); ws.once("message", (d) => { check("ws: hello framed", JSON.parse(d).result?.framed === true); res(); }); });
let wsClosed = false;
ws.on("close", () => { wsClosed = true; });
ws.on("message", (d) => {
  const ch = d.readUInt32LE(0), kind = d[4], p = d.subarray(9);
  if (ch === 0) { const m = JSON.parse(p.toString()); waiting.get(m.id)?.(m); waiting.delete(m.id); return; }
  if (kind === 0) { streams.set(ch, (streams.get(ch) ?? "") + p.toString()); const c = Buffer.alloc(4); c.writeUInt32LE(p.length); ws.send(frame(ch, 1, c)); }
});
const call = (method, params = {}) => new Promise((res) => { const i = ++n; waiting.set(i, res); ws.send(frame(0, 0, JSON.stringify({ jsonrpc: "2.0", id: i, method, params }))); });
const list = await call("terminal.list");
const t = list.result.terminals.find((x) => x.name === "pm-e2e");
check("lists the scratch terminal", !!t, `of ${list.result.terminals.length}`);
const [cols, rows] = [t.cols, t.rows];
for (const m of ["terminal.run", "machine.exec", "file.read", "terminal.kill", "server.stop", "machine.add", "doc.set"]) {
  const r = await call(m, { command: "id" });
  check(`${m} refused`, r.error?.data?.kind === "not_allowed");
}

// ---- documents: the layout can be read, and nothing else
const rawCall = (text) => new Promise((res) => { const i = ++n; waiting.set(i, res); ws.send(frame(0, 0, text.replace("ID", String(i)))); });
const layout = await call("doc.get", { name: "lumbridge-app" });
check("doc.get of the layout reaches core", !layout.error && "value" in layout.result && typeof layout.result.version === "number", JSON.stringify(layout));
for (const params of [{ name: "secret" }, { name: "lumbridge-app2" }, { name: "lumbridge-app", value: 1 }, { name: "lumbridge-app", version: 0 }, { name: "lumbridge-app", on: 7 }, {}]) {
  const r = await call("doc.get", params);
  check(`doc.get ${JSON.stringify(params)} refused`, r.error?.data?.kind === "not_allowed", JSON.stringify(r));
}
const lastWins = await rawCall('{"jsonrpc":"2.0","id":ID,"method":"doc.get","params":{"name":"secret","name":"lumbridge-app"}}');
check("a repeated name reads as its last value and reaches core", !lastWins.error && lastWins.result?.version === layout.result.version, JSON.stringify(lastWins));
const lastRefused = await rawCall('{"jsonrpc":"2.0","id":ID,"method":"doc.get","params":{"name":"lumbridge-app","name":"secret"}}');
check("a repeated name ending in anything else is refused", lastRefused.error?.data?.kind === "not_allowed", JSON.stringify(lastRefused));
const wrote = await call("doc.set", { name: "lumbridge-app", value: { spaces: [] }, version: layout.result.version });
check("doc.set of the layout refused", wrote.error?.data?.kind === "not_allowed", JSON.stringify(wrote));
check("and nothing was written", (await call("doc.get", { name: "lumbridge-app" })).result.version === layout.result.version);
const unknown = await call("doc.get", { name: "lumbridge-app", on: "nowhere" });
check("a machine core doesn't know is core's error, not ours", !!unknown.error && unknown.error.data?.kind !== "not_allowed", JSON.stringify(unknown));

const sub = await call("events.subscribe");
check("events give a snapshot + channel", sub.result?.channel > 0 && sub.result.terminals.length > 0);
const att = await call("terminal.attach", { terminal: t.address, cols: 40, rows: 10, observe: true, resize_notifications: true, history: 100 });
check("observe attach", att.result?.channel > 0, JSON.stringify(att.error ?? {}));
const ch = att.result.channel;
await sleep(300);
const sent = await call("terminal.send", { terminal: t.address, text: "echo lumbridge-$((40+2))", timeout: 5 });
check("send accepted", !sent.error, JSON.stringify(sent.error ?? ""));
await sleep(800);
check("output reaches the phone", (streams.get(ch) ?? "").includes("lumbridge-42"));
const keys = await call("terminal.keys", { terminal: t.address, keys: ["ctrl+c"] });
check("keys accepted", !keys.error, JSON.stringify(keys.error ?? ""));
const after = (await call("terminal.get", { terminal: t.address })).result;
check("observing did not resize the terminal", after.cols === cols && after.rows === rows, `${after.cols}x${after.rows}`);
const lab = await call("terminal.label", { terminal: t.address, labels: { "lumbridge.seen": "0" } });
check("seen label writes", !lab.error, JSON.stringify(lab.error ?? ""));
check("last_seen is recorded", /^pixel\s+active\s+\S+ \S+\s+\d{4}-/m.test(cli("devices")), cli("devices"));

// ---- revoke, with no restart
check("revoke works", /revoked pixel/.test(cli("revoke", "pixel")));
check("the new connection is refused at once", (await tryWs(nodes.build[0], pixelToken)) === "bad_token");
for (let i = 0; i < 80 && !wsClosed; i++) await sleep(100);
check("the open session is ended", wsClosed);
check("the CLI shows it", /^pixel\s+revoked/m.test(cli("devices")));
const noSuch = (() => { try { cli("revoke", "never"); return false; } catch { return true; } })();
check("revoking nothing is an error", noSuch);

// ---- certificate renewal, with no restart
const servedCert = () => new Promise((res) => {
  const raw = net.connect(port, "127.0.0.1"); raw.write(proxyV2(nodes.build[0]));
  const s = tls.connect({ socket: raw, rejectUnauthorized: false, servername: "mobile.example.com" }, () => { const c = s.getPeerX509Certificate(); s.destroy(); res(c?.fingerprint256); });
  s.on("error", () => res(null));
});
const before = await servedCert();
check("serves the first certificate", before === new X509Certificate(readFileSync(join(dir, "cert.crt"))).fingerprint256);
makeCert("cert2", "mobile.example.com");
renameSync(join(dir, "cert2.crt"), join(dir, "cert.crt"));
check("half a renewal keeps the old certificate", (await servedCert()) === before);
renameSync(join(dir, "cert2.key"), join(dir, "cert.key"));
const fresh = new X509Certificate(readFileSync(join(dir, "cert.crt"))).fingerprint256;
check("a finished renewal is served at once", (await servedCert()) === fresh && fresh !== before);
writeFileSync(join(dir, "cert.crt"), "garbage");
check("a broken file keeps the working certificate", (await servedCert()) === fresh);

// ---- startup guards
const refuses = async (b, env) => new Promise((res) => {
  const p = spawn(b, [], { env, stdio: ["ignore", "ignore", "pipe"] }); let err = "";
  p.stderr.on("data", (d) => { err += d; });
  const timer = setTimeout(() => { p.kill(); res(`still running: ${err}`); }, 3000);
  p.on("exit", (code) => { clearTimeout(timer); res(code === 2 ? "refused" : `exit ${code}: ${err}`); });
});
const plain = { ...gatewayEnv }; delete plain.LUMBRIDGE_TLS_CERT; delete plain.LUMBRIDGE_TLS_KEY;
const guard = portAt(port, "guard");
check("plain HTTP off loopback refused", (await refuses(bin, { ...plain, LUMBRIDGE_BIND: `0.0.0.0:${guard}` })) === "refused");
check("TLS + PROXY off loopback refused", (await refuses(bin, { ...gatewayEnv, LUMBRIDGE_TLS_CERT: join(dir, "cert.key"), LUMBRIDGE_TLS_BIND: `0.0.0.0:${guard}` })) === "refused");
const devTarget = join(repo, "gateway/target/guard");
cargo("build", "--features", "dev-identity", "--target-dir", devTarget);
const dev = join(devTarget, "debug/lumbridge-mobile-server");
check("dev build off loopback refused", (await refuses(dev, { ...plain, LUMBRIDGE_BIND: `100.64.0.250:${guard}` })) === "refused");
check("dev build refuses TLS", (await refuses(dev, gatewayEnv)) === "refused");
check("only the CLI's commands exist", (() => { try { execFileSync(bin, ["dev-add", "x"], { env: { LUMBRIDGE_STATE_DIR: gatewayEnv.LUMBRIDGE_STATE_DIR }, stdio: "ignore", input: "y" }); return false; } catch { return true; } })());
check("the state dir kept no stray temp file", !existsSync(`${devicesFile}.tmp`));

ws.close();
await sleep(200);

// ---- the gateway never starts a core
const others = [];
globalThis.othersToStop = others;
makeCert("later", "mobile.example.com"); // the certificate section above left garbage in cert.crt
const startGateway = async (p, env = {}, wrap = null) => {
  const e = { ...gatewayEnv, LUMBRIDGE_TLS_BIND: `127.0.0.1:${p}`, LUMBRIDGE_TLS_CERT: join(dir, "later.crt"), LUMBRIDGE_TLS_KEY: join(dir, "later.key"), ...env };
  const g = wrap ? spawn("sh", ["-c", wrap, bin], { env: e, stdio: ["ignore", "ignore", "pipe"] }) : spawn(bin, [], { env: e, stdio: ["ignore", "ignore", "pipe"] });
  g.log = "";
  g.stderr.on("data", (d) => { g.log += d; });
  others.push(g);
  for (let i = 0; i < 100 && !g.log.includes("TLS + PROXY on"); i++) await sleep(50);
  check(`another gateway started on ${p}`, g.log.includes("TLS + PROXY on"), g.log);
  return g;
};
const children = (g) => { try { return execFileSync("pgrep", ["-P", String(g.pid)], { encoding: "utf8" }).trim().split("\n").length; } catch { return 0; } };
const coreSocket = join(dir, "lumbridge-core/e.sock");
const coreAnswers = () => new Promise((res) => { const s = net.connect(coreSocket); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });
const until = async (f, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(100); } return false; };

target = port;
const secondCode = pairLink("second");
const token2 = JSON.parse((await post(from(nodes.laptop[0]), "/api/pair", { code: secondCode })).body).token;
check("core answers to start with", await coreAnswers());
hc("server", "stop");
await sleep(6000);
check("hc server stop stays stopped with a gateway running", !(await coreAnswers()));
check("the gateway has no hc child with no core", children(gateway) === 0, String(children(gateway)));
check("ws: says core is down and starts nothing", (await tryWs(nodes.build[0], token2)) === "core_down");
check("still no core after that", !(await coreAnswers()));
check("the watcher says so once", gatewayLog.split("waiting for core").length === 2, gatewayLog);

const envDump = join(dir, "hc-env");
const hcWrapper = join(dir, "bin/hc-wrapper");
// Written aside and renamed into place: the test waits for the file to exist, and `env > file` creates it empty before
// writing, so a read in between saw no variables at all (run 12790: "it still has what hc needs" failed under load).
writeFileSync(hcWrapper, `#!/bin/sh\nenv > ${envDump}.$$ && mv -f ${envDump}.$$ ${envDump}\nexec lbc "$@"\n`);
chmodSync(hcWrapper, 0o755);
const fresh2 = await startGateway(portAt(port, "noCore"), { LUMBRIDGE_HC: hcWrapper, LUMBRIDGE_DATABASE_URL: "postgres://x:SENTINELPW@127.0.0.1:1/x" });
await sleep(3000);
check("a gateway started with no core doesn't start one", !(await coreAnswers()));
check("it didn't even run hc", !existsSync(envDump));
hc("run", "--bg", "--name", "pm-e2e-back", "bash");
check("when core comes back, /ws works again", (await tryWs(nodes.build[0], token2)) === "accepted");
check("and the watcher finds it", await until(() => existsSync(envDump), 35000), fresh2.log);
const dumped = readFileSync(envDump, "utf8");
check("no hc child sees the database URL or any LUMBRIDGE_ variable", !dumped.includes("SENTINELPW") && !dumped.includes("LUMBRIDGE_"), dumped);
check("it still has what hc needs", dumped.includes("LBC_SESSION=e") && dumped.includes("XDG_RUNTIME_DIR="));
fresh2.kill();

// ---- a hung core can't collect children
const hungSocket = join(dir, "hung.sock");
const hungServer = net.createServer().listen(hungSocket);
const hungHc = join(dir, "bin/hc-hung");
writeFileSync(hungHc, "#!/bin/sh\nexec sleep 30\n"); // not long: a child outlives a gateway killed outright
chmodSync(hungHc, 0o755);
const hungPort = portAt(port, "hungCore");
const hung = await startGateway(hungPort, { LUMBRIDGE_HC: hungHc, LBC_SOCKET: hungSocket });
target = hungPort;
const hungAnswers = await Promise.all([1, 2, 3, 4, 5].map(() => tryWs(nodes.build[0], token2)));
check("a core that never says hello reads as down", hungAnswers.every((a) => a === "core_down"), hungAnswers.join());
check("and leaves no children behind", await until(() => children(hung) <= 1, 8000), String(children(hung)));
hung.kill();
hungServer.close();

// ---- dead clients and idle connections
const quickPort = portAt(port, "quick");
const quick = await startGateway(quickPort, { LUMBRIDGE_WS_DEAD_SECS: "3", LUMBRIDGE_CONN_IDLE_SECS: "2" });
target = quickPort;
const openWs = (opts = {}) => new Promise((res) => {
  const c = new WebSocket(`wss://127.0.0.1:${port}/ws`, { ...wsOpts(nodes.build[0]), ...opts });
  c.pings = 0; c.closed = false;
  c.on("ping", () => { c.pings++; });
  c.on("close", () => { c.closed = true; });
  c.on("error", () => {});
  c.on("open", () => c.send(token2));
  c.once("message", () => res(c));
});
await until(() => children(quick) >= 1, 5000);
const baseChildren = children(quick);
const deaf = await openWs({ autoPong: false });
const alive = await openWs();
check("each session has its hc child", children(quick) === baseChildren + 2, `${children(quick)} vs ${baseChildren}`);
await sleep(5000);
check("a client that stops answering is pinged", deaf.pings > 0);
check("and hung up on, child and all", deaf.closed && children(quick) === baseChildren + 1, `${deaf.closed} ${children(quick)} ${baseChildren}`);
check("a client that answers pings stays", !alive.closed && alive.pings > 0);
alive.close();

const idleTls = (alpn) => new Promise((res) => {
  const raw = net.connect(target, "127.0.0.1"); raw.write(proxyV2(nodes.build[0]));
  const s = tls.connect({ socket: raw, rejectUnauthorized: false, servername: "mobile.example.com", ALPNProtocols: [alpn] });
  const began = Date.now();
  s.on("error", () => {});
  s.resume();
  s.on("close", () => res(Date.now() - began));
  setTimeout(() => { s.destroy(); res(null); }, 6000);
});
const [idle1, idle2] = await Promise.all([idleTls("http/1.1"), idleTls("h2")]);
check("an idle HTTP/1.1 connection is closed", idle1 !== null && idle1 < 5000, String(idle1));
check("an idle HTTP/2 connection is closed", idle2 !== null && idle2 < 5000, String(idle2));

const held = [];
let cut = 0;
for (let i = 0; i < 70; i++) {
  const c = net.connect(target, "127.0.0.1"); c.write(proxyV2(nodes.pixel[0]));
  c.on("close", () => { cut++; }); c.on("error", () => {});
  held.push(c);
}
await sleep(1000);
check("one node can't hold more than 64 connections", cut === 6, String(cut));
check("another still gets in", (await request(from(nodes.build[0]), "/healthz")).body === "ok");
for (const c of held) c.destroy();
quick.kill();

// ---- running out of file descriptors doesn't end the gateway
const tightPort = portAt(port, "tight");
const tight = await startGateway(tightPort, { LUMBRIDGE_HC: "/bin/false" }, 'ulimit -n 128; exec "$0"');
target = tightPort;
const fds = () => { try { return execFileSync("sh", ["-c", `ls /proc/${tight.pid}/fd | wc -l`], { encoding: "utf8" }).trim() * 1; } catch { return -1; } };
await sleep(300);
const baseFds = fds();
const flood = [];
for (let i = 0; i < 300; i++) { const c = net.connect(target, "127.0.0.1"); c.on("error", () => {}); flood.push(c); }
await sleep(1500);
check("300 connections with a limit of 128 don't end the gateway", tight.exitCode === null && tight.log.includes("accept:"), tight.log.slice(-200));
for (const c of flood) c.destroy();
await sleep(500);
check("and it serves again once they've gone", (await request(from(nodes.build[0]), "/healthz")).body === "ok");
for (let i = 0; i < 300; i++) { const c = net.connect(target, "127.0.0.1"); c.on("error", () => {}); c.write(proxyV2(nodes.cloud[0])); await new Promise((r) => { c.on("close", r); }); }
await sleep(300);
check("300 connections from a refused node each close at once and hold nothing", tight.exitCode === null && fds() <= baseFds + 2, `${fds()} vs ${baseFds}`);
tight.kill();

finish(failed ? 1 : 0);
