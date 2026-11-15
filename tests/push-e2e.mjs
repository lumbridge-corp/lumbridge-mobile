// End to end for notifications, against scratch cores and a fake push service: node tests/push-e2e.mjs <port>
// Needs web/dist. Starts scripts/dev.sh on <port>, plus a second scratch core added as machine "far", and stops both, pass, fail or Ctrl-C.
// The fake service checks each request independently of the crates that made it (RFC 8291 + 8292, no Topic).
import { spawnSync, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopOnExit } from "./ports.mjs";

const port = process.argv[2] ?? "18531";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uid = process.getuid();
const a = `/run/user/${uid}/k${port}`, b = `/run/user/${uid}/k${port}far`;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); if (!ok) failed++; };

// Real cores are never fixtures, and no hc starts with CLAUDE* in its environment.
const env = (d, session) => {
  const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE") && !k.startsWith("LBC_") && !k.startsWith("LUMBRIDGE")));
  return { ...e, LBC_SESSION: session, XDG_STATE_HOME: `${d}/s`, XDG_RUNTIME_DIR: d, XDG_CONFIG_HOME: `${d}/c`, XDG_DATA_HOME: `${d}/d` };
};
const hcA = (...args) => execFileSync("lbc", args, { env: env(a, "k"), encoding: "utf8" });
const hcB = (...args) => execFileSync("lbc", args, { env: env(b, "far"), encoding: "utf8" });

const needsFile = `${b}/needs-you.json`;
const dev = (...args) => spawnSync("bash", [`${repo}/scripts/dev.sh`, port, ...args], { env: { ...process.env, LUMBRIDGE_MACHINE: "desk", LUMBRIDGE_NEEDS_FILE: needsFile, LUMBRIDGE_APPROVE_CMD: "/bin/true" }, encoding: "utf8" });

// --- the fake push service ------------------------------------------------------------------------------------

const b64u = (b) => Buffer.from(b).toString("base64url");
function browser() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { ecdh, auth: crypto.randomBytes(16) };
}
const hkdf = (ikm, salt, info, n) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, n));

function decrypt(body, { ecdh, auth }) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20];
  const keyid = body.subarray(21, 21 + idlen), cipher = body.subarray(21 + idlen);
  if (idlen !== 65) throw new Error(`idlen ${idlen}`);
  if (cipher.length > rs) throw new Error("more than one record");
  const shared = ecdh.computeSecret(keyid);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), keyid]);
  const ikm = hkdf(shared, auth, info, 32);
  const cek = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error("no 0x02 delimiter on the last record");
  return JSON.parse(plain.subarray(0, end).toString());
}

function vapid(header) {
  const m = /^vapid t=([^,\s]+),\s*k=([^,\s]+)$/.exec(header ?? "");
  if (!m) throw new Error(`authorization: ${header}`);
  const [h, c, s] = m[1].split(".");
  const point = Buffer.from(m[2], "base64url");
  if (point.length !== 65 || point[0] !== 4) throw new Error("k isn't an uncompressed P-256 point");
  const key = crypto.createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) } });
  const ok = crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  if (!ok) throw new Error("bad signature");
  return { header: JSON.parse(Buffer.from(h, "base64url")), claims: JSON.parse(Buffer.from(c, "base64url")), k: m[2] };
}

const received = [];
const routes = new Map(); // path -> { sub, reply: () => status, hits }
const service = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const route = routes.get(req.url);
    if (!route) { res.writeHead(404).end(); return; }
    route.hits++;
    const status = route.reply(route.hits);
    if (status < 300) {
      const r = { path: req.url, headers: req.headers, at: Date.now() };
      try { r.vapid = vapid(req.headers.authorization); r.payload = decrypt(Buffer.concat(chunks), route.sub); } catch (e) { r.error = e.message; }
      received.push(r);
    }
    res.writeHead(status, { "content-type": "application/json" }).end(status < 300 ? "" : '{"reason":"FakeReason"}');
  });
});
await new Promise((r) => service.listen(0, "127.0.0.1", r));
const servicePort = service.address().port;

const waitPush = async (test, ms = 9000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = received.find(test);
    if (hit) return hit;
    await sleep(100);
  }
  return null;
};
const titles = () => received.map((r) => r.payload?.title);

// --- the API --------------------------------------------------------------------------------------------------

let token = "";
const api = (p, method = "GET", body, tok = token) => fetch(base + p, {
  method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
async function subscribe(p, reply = () => 201) {
  const sub = browser();
  routes.set(p, { sub, reply, hits: 0 });
  const r = await api("/api/push/subscribe", "POST", {
    endpoint: `http://127.0.0.1:${servicePort}${p}`,
    keys: { p256dh: b64u(sub.ecdh.getPublicKey()), auth: b64u(sub.auth) },
  });
  if (!r.ok) throw new Error(`subscribe: ${r.status}`);
  return `http://127.0.0.1:${servicePort}${p}`;
}

// --- agents: programs that report status through OSC 7501 when told to through a fifo ------------------------------

const fifos = new Map();
function agent(name, where = hcA, d = a) {
  const fifo = `${d}/${name}.fifo`;
  execFileSync("mkfifo", [fifo]);
  const line = `exec 3<>${fifo}; while read s <&3; do printf '\\033]7501;state=%s\\033\\\\' "$s"; done`;
  where("run", "--bg", "--no-parent", "--name", name, "bash", "-c", line);
  fifos.set(name, fifo);
}
const say = (name, state) => fs.writeFileSync(fifos.get(name), `${state}\n`);
const settle = () => sleep(300);

// Once, however the run ends: pass, fail, crash or Ctrl-C.
const stopAll = stopOnExit(() => {
  service.close();
  dev("stop"); // First: a core with a machine dials it back up.
  try { hcB("server", "stop"); } catch {}
  fs.rmSync(b, { recursive: true, force: true });
});

try {
  dev("stop");
  fs.mkdirSync(`${b}/s`, { recursive: true }); fs.chmodSync(b, 0o700);
  const started = dev();
  if (started.status !== 0) throw new Error(`dev.sh: ${started.stderr}`);
  token = fs.readFileSync(`${a}/token`, "utf8").trim();
  for (let i = 0; i < 50; i++) { if (await fetch(`${base}/healthz`).catch(() => null)) break; await sleep(100); }

  // Every handler takes the Device extractor.
  for (const [p, m] of [["/api/push/config", "GET"], ["/api/push/subscribe", "POST"], ["/api/push/unsubscribe", "POST"], ["/api/push/test", "POST"], ["/api/push/prefs", "GET"], ["/api/push/prefs", "PUT"], ["/api/push/focus", "POST"]]) {
    const r = await api(p, m, m === "GET" ? undefined : {}, "");
    check(`${m} ${p} needs a device token`, r.status === 401, `${r.status}`);
  }
  const config = await (await api("/api/push/config")).json();
  check("config gives the public key", typeof config.publicKey === "string" && config.publicKey.length === 87);
  check("VAPID key and state are private", (fs.statSync(`${a}/state/vapid.key`).mode & 0o777) === 0o600);
  const evil = await api("/api/push/subscribe", "POST", { endpoint: "https://evil.example/x", keys: { p256dh: "x", auth: "y" } });
  check("a non-push endpoint is refused", evil.status === 400, `${evil.status}`);
  const prefs = await (await api("/api/push/prefs")).json();
  check("prefs default on, quiet hours off", prefs.needsYou && prefs.finished && !prefs.quiet.enabled);
  const badPrefs = await api("/api/push/prefs", "PUT", { ...prefs, quiet: { enabled: true, start: "nope", end: "07:00" } });
  check("bad quiet hours refused", badPrefs.status === 400, `${badPrefs.status}`);

  // A second core, added as a machine: remote terminals arrive in the same stream.
  // The gate file holds the line down, so things can change while it's away.
  const gate = `${b}/line-down`;
  fs.writeFileSync(`${b}/via.sh`, `#!/bin/sh\n[ -e ${gate} ] && exit 1\nexport LBC_SESSION=far XDG_STATE_HOME=${b}/s XDG_RUNTIME_DIR=${b} XDG_CONFIG_HOME=${b}/c XDG_DATA_HOME=${b}/d\nexec sh -c "$1"\n`, { mode: 0o700 });
  const farVia = `${b}/via.sh`;
  hcB("server", "start");
  hcA("machine", "add", "--via", farVia, "--name", "far");

  // Created before we subscribe or while nothing is news.
  agent("acme-deploy");
  agent("flappy");
  agent("nightly-lineup");
  agent("looked-at");
  agent("quiet-one");
  agent("far-agent", hcB, b);
  agent("watched");
  agent("unwatched");
  agent("let-go");
  for (const n of ["acme-deploy", "flappy", "nightly-lineup", "looked-at", "quiet-one", "far-agent", "watched", "unwatched", "let-go"]) say(n, "idle");
  await settle();

  await subscribe("/phone");

  // Test send, fully checked.
  const tested = await (await api("/api/push/test", "POST", { endpoint: `http://127.0.0.1:${servicePort}/phone` })).json();
  check("test send reports sent", tested.sent === 1, JSON.stringify(tested));
  const t = await waitPush((r) => r.payload?.tag === "test");
  check("request decrypts (RFC 8291) and verifies (RFC 8292)", !!t && !t.error, t?.error ?? "");
  check("aes128gcm", t?.headers["content-encoding"] === "aes128gcm");
  check("no Topic header", t && !("topic" in t.headers));
  check("TTL set", Number(t?.headers.ttl) === 43200, t?.headers.ttl);
  check("Urgency set", ["high", "normal"].includes(t?.headers.urgency), t?.headers.urgency);
  const c = t?.vapid?.claims ?? {};
  check("JWT is ES256", t?.vapid?.header.alg === "ES256" && t?.vapid?.header.typ === "JWT", JSON.stringify(t?.vapid?.header));
  // The crate leaves a port out of aud. Real push services have no port (send::valid_endpoint insists), so only this fake differs.
  check("JWT aud is the service's origin", c.aud === "http://127.0.0.1", c.aud);
  check("JWT sub is a real mailto", c.sub === "mailto:dev@example.com", c.sub);
  const left = c.exp - Date.now() / 1000;
  check("JWT exp under 24 h", left > 0 && left <= 86400, `${Math.round(left)} s`);
  console.log(`     JWT claims: ${Object.keys(c).join(", ")}`);
  check("k is the configured key", t?.vapid?.k === config.publicKey);
  received.length = 0;

  // Rules, from real OSC 7501 reports.
  say("acme-deploy", "working"); await settle();
  const t0 = Date.now();
  say("acme-deploy", "blocked");
  const need = await waitPush((r) => r.payload?.title === "Acme deploy needs you");
  check("blocked fires needs you", !!need, JSON.stringify(titles()));
  check("after the hold, right away", need && need.at - t0 >= 2500 && need.at - t0 < 5000, need ? `${need.at - t0} ms` : "");
  check("the payload names the machine and goes to the agent", need?.payload.body === "desk · waiting for you" && /^\/#\/t\/t\d+$/.test(need?.payload.url), JSON.stringify(need?.payload));
  check("one tag per terminal", /^t-t\d+$/.test(need?.payload.tag ?? ""), need?.payload.tag);
  check("needs you is high urgency", need?.headers.urgency === "high");
  check("needs you says it can be closed when answered", need?.payload.kind === "needs");
  check("and carries the number for the app icon", need?.payload.badge === 1, JSON.stringify(need?.payload));

  say("flappy", "blocked"); await sleep(1000); say("flappy", "working");
  await sleep(4000);
  check("blocked to working flap doesn't buzz", !received.some((r) => /Flappy/.test(r.payload?.title)), JSON.stringify(titles()));

  say("acme-deploy", "error");
  const err = await waitPush((r) => r.payload?.body === "desk · hit an error");
  check("error fires needs you", !!err);

  say("nightly-lineup", "working"); await settle(); say("nightly-lineup", "done");
  const fin = await waitPush((r) => r.payload?.title === "Nightly lineup finished");
  check("a turn ending done fires finished", !!fin, JSON.stringify(titles()));
  check("finished is normal urgency", fin?.headers.urgency === "normal");
  check("finished is its own kind", fin?.payload.kind === "finished");
  const tag = fin?.payload.tag;
  say("nightly-lineup", "working"); await settle(); say("nightly-lineup", "idle");
  const fin2 = await waitPush((r) => r.payload?.title === "Nightly lineup finished" && r !== fin);
  check("a new turn ending idle fires again with the same tag", !!fin2 && fin2.payload.tag === tag);

  say("looked-at", "working"); await settle(); say("looked-at", "done"); await sleep(500);
  const turn = JSON.parse(hcA("get", "looked-at", "--json")).turn;
  hcA("label", "looked-at", `lumbridge.seen=${turn}`);
  await sleep(4000);
  check("lumbridge.seen at this turn stops finished", !received.some((r) => /Looked/.test(r.payload?.title)), `turn ${turn}`);

  // Prefs.
  await api("/api/push/prefs", "PUT", { ...prefs, finished: false });
  say("quiet-one", "working"); await settle(); say("quiet-one", "done");
  await sleep(4000);
  check("finished off stops finished", !received.some((r) => /Quiet one/.test(r.payload?.title)));
  await api("/api/push/prefs", "PUT", prefs);

  // The owner is looking at it: no buzz. Only on positive, recent proof, and only for that terminal.
  const addressOf = (name) => JSON.parse(hcA("get", name, "--json")).address;
  const bad = await api("/api/push/focus", "POST", { terminal: "a b" });
  check("a nonsense address is refused", bad.status === 400, `${bad.status}`);
  const told = await api("/api/push/focus", "POST", { terminal: addressOf("watched") });
  check("focus is taken", told.status === 204, `${told.status}`);
  say("watched", "working"); await settle(); say("watched", "blocked");
  await sleep(4000);
  check("the agent the owner is looking at doesn't buzz", !received.some((r) => r.payload?.title === "Watched needs you"), JSON.stringify(titles()));
  say("unwatched", "working"); await settle(); say("unwatched", "blocked");
  check("another agent still does", !!(await waitPush((r) => r.payload?.title === "Unwatched needs you")), JSON.stringify(titles()));
  await api("/api/push/focus", "POST", { terminal: null });
  say("let-go", "working"); await settle();
  await api("/api/push/focus", "POST", { terminal: addressOf("let-go") });
  await api("/api/push/focus", "POST", { terminal: null });
  say("let-go", "blocked");
  check("once the owner is looked away, it buzzes", !!(await waitPush((r) => r.payload?.title === "Let go needs you")), JSON.stringify(titles()));

  // A new draft from the assistant buzzes once, with nothing of the draft in it. One that was already there isn't news.
  const writeNeeds = (ids) => {
    const drafts = ids.map((id) => ({ id, kind: "send", state: "pending", address: "t1", text: "SECRET DRAFT WORDS", why: "SECRET REASON" }));
    fs.writeFileSync(`${needsFile}.tmp`, JSON.stringify({ updated_ms: Date.now(), drafts }));
    fs.renameSync(`${needsFile}.tmp`, needsFile);
  };
  received.length = 0;
  writeNeeds(["1793760000-aaaa"]);
  const firstDraft = await waitPush((r) => r.payload?.tag === "draft-1793760000-aaaa", 12000);
  check("a new draft buzzes", firstDraft?.payload.title === "Your assistant has a draft for you" && firstDraft?.headers.urgency === "high", JSON.stringify(titles()));
  check("and goes to the assistant's tab", firstDraft?.payload.url === "/#/assistant");
  check("and has none of the draft in it", !/SECRET/.test(JSON.stringify(firstDraft?.payload)), JSON.stringify(firstDraft?.payload));
  check("and counts in the icon's number", firstDraft?.payload.badge >= 1, JSON.stringify(firstDraft?.payload));
  received.length = 0;
  await api("/api/push/prefs", "PUT", { ...prefs, needsYou: false });
  writeNeeds(["1793760000-aaaa", "1793760000-bbbb"]);
  await sleep(6500);
  check("needs-you off stops it, and it doesn't repeat the first", !received.some((r) => r.payload?.kind === "draft"), JSON.stringify(titles()));
  await api("/api/push/prefs", "PUT", prefs);
  writeNeeds(["1793760000-aaaa", "1793760000-bbbb"]);
  await sleep(6500);
  check("what was skipped doesn't come later", !received.some((r) => r.payload?.kind === "draft"), JSON.stringify(titles()));
  writeNeeds([]);

  // Remote terminals.
  let seen = false;
  for (let i = 0; i < 50 && !seen; i++) { seen = hcA("ls", "--json").includes("far/"); if (!seen) await sleep(200); }
  check("the second core's terminals are in the stream", seen);
  say("far-agent", "working"); await settle();
  say("far-agent", "blocked");
  const far = await waitPush((r) => r.payload?.title === "Far agent needs you");
  check("a remote agent fires with its machine and address", far?.payload.body === "far · waiting for you" && /^\/#\/t\/far%2Ft\d+$/.test(far?.payload.url ?? ""), JSON.stringify(far?.payload));

  // A machine's line coming back re-delivers `created`, including changes made while it was down.
  say("far-agent", "working"); await settle(); say("far-agent", "idle");
  await waitPush((r) => r.payload?.title === "Far agent finished");
  await settle();
  received.length = 0;
  const pids = fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  const farLine = pids.filter((p) => {
    try {
      const environ = fs.readFileSync(`/proc/${p}/environ`, "latin1");
      const argv = fs.readFileSync(`/proc/${p}/cmdline`, "latin1");
      return environ.includes(`XDG_RUNTIME_DIR=${b}\0`) && argv.includes("\0connect");
    } catch { return false; }
  });
  check("found the scratch machine's line", farLine.length >= 1, `${farLine.length}`);
  fs.writeFileSync(gate, "");
  for (const p of farLine) process.kill(Number(p));
  await sleep(1500);
  say("far-agent", "working"); await settle(); say("far-agent", "blocked");
  await sleep(1500);
  check("the line was really down", received.length === 0 && !JSON.stringify(JSON.parse(hcA("machine", "ls", "--json"))).includes('"connected"'));
  fs.rmSync(gate);
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { up = JSON.stringify(JSON.parse(hcA("machine", "ls", "--json"))).includes('"connected"'); if (!up) await sleep(200); }
  check("the line came back", up);
  await sleep(5000);
  const redelivered = JSON.parse(hcA("get", "far/far-agent", "--json")).status?.state;
  check("the core has the change made while it was down", redelivered === "blocked", redelivered);
  check("a machine's reconnect doesn't flood", received.length === 0, JSON.stringify(titles()));
  say("far-agent", "working"); await settle(); say("far-agent", "done");
  check("news after the reconnect still fires", !!(await waitPush((r) => r.payload?.title === "Far agent finished")), JSON.stringify(titles()));

  // A restart must not flood the phone. Several agents are blocked or done right now.
  received.length = 0;
  const gw = fs.readFileSync(`${a}/gw.pid`, "utf8").trim();
  const kids = execFileSync("pgrep", ["-P", gw], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  check("the gateway holds one hc connect for the watcher", kids.length === 1, `${kids.length}`);
  process.kill(Number(kids[0]));
  await sleep(5000);
  check("the watcher's core connection dropping doesn't flood", received.length === 0, JSON.stringify(titles()));
  say("nightly-lineup", "working"); await settle(); say("nightly-lineup", "done");
  check("the watcher reconnected by itself", !!(await waitPush((r) => r.payload?.title === "Nightly lineup finished", 12000)), JSON.stringify(titles()));

  received.length = 0;
  writeNeeds(["1793760000-cccc"]);
  await sleep(100);
  process.kill(Number(gw));
  await sleep(500);
  const again = dev();
  if (again.status !== 0) throw new Error(`dev.sh restart: ${again.stderr}`);
  for (let i = 0; i < 50; i++) { if (await fetch(`${base}/healthz`).catch(() => null)) break; await sleep(100); }
  await sleep(5000);
  check("a gateway restart doesn't flood, drafts included", received.length === 0, JSON.stringify(titles()));
  check("subscriptions survive the restart", JSON.parse(fs.readFileSync(`${a}/state/push.json`)).subscriptions.length === 1);
  const key2 = (await (await api("/api/push/config")).json()).publicKey;
  check("the VAPID key survives the restart", key2 === config.publicKey);

  // Delivery failures. None of them may touch the others.
  say("nightly-lineup", "working"); await settle();
  const gone = await subscribe("/gone", () => 410);
  await subscribe("/missing", () => 404);
  await subscribe("/flaky", (hit) => (hit === 1 ? 503 : 201));
  await subscribe("/broken", () => 400);
  received.length = 0;
  say("nightly-lineup", "done");
  check("a good subscription still gets it", !!(await waitPush((r) => r.path === "/phone")));
  check("a 5xx is retried", !!(await waitPush((r) => r.path === "/flaky")) && routes.get("/flaky").hits === 2, `${routes.get("/flaky").hits} tries`);
  await sleep(1000);
  const saved = JSON.parse(fs.readFileSync(`${a}/state/push.json`)).subscriptions.map((s) => s.endpoint);
  check("410 drops the subscription", !saved.includes(gone));
  check("404 drops the subscription", !saved.some((e) => e.endpoint?.endsWith("/missing")) && !saved.some((e) => e.endsWith("/missing")));
  check("a 400 isn't retried and doesn't drop it", routes.get("/broken").hits === 1 && saved.some((e) => e.endsWith("/broken")), `${routes.get("/broken").hits} tries`);
  check("push.json is private", (fs.statSync(`${a}/state/push.json`).mode & 0o777) === 0o600);
  const again410 = await api("/api/push/subscribe", "POST", { endpoint: gone, keys: { p256dh: b64u(routes.get("/gone").sub.ecdh.getPublicKey()), auth: b64u(routes.get("/gone").sub.auth) } });
  check("a dead subscription reported again is refused with 410", again410.status === 410, `${again410.status}`);
  check("the gateway still answers", (await api("/api/push/prefs")).ok);

  const off = await api("/api/push/unsubscribe", "POST", { endpoint: `http://127.0.0.1:${servicePort}/phone` });
  check("unsubscribe works", off.ok && !JSON.parse(fs.readFileSync(`${a}/state/push.json`)).subscriptions.some((s) => s.endpoint.endsWith("/phone")));

  // Logs name the service, never a subscription or a notification.
  const log = fs.readFileSync(`${a}/gw.log`, "utf8");
  check("the log has no endpoint paths or contents", !/\/phone|\/gone|\/flaky|needs you|finished"/.test(log));
  check("the log has no key material", !log.includes(config.publicKey) && !log.includes(fs.readFileSync(`${a}/state/vapid.key`, "utf8").trim()));
} catch (e) {
  check("the run completed", false, e.stack);
} finally {
  stopAll();
}
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
