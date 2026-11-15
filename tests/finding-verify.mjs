// Finding the right pane fast: names, less chrome, Favorites and Recent, search, and the merged Agents tab, in Chrome against a scratch core.
//   scripts/dev.sh <port> && scripts/dev-fixture.sh <port> && node tests/finding-verify.mjs <port> [shots dir]
// Seeds layouts straight into the SCRATCH core, and adds terminals with real program titles. System Chrome; never `playwright install`.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { addresses, ASSISTANT, chromium, DRAWER, open, scratchEnv, SCREENS, seedDoc, seedLayouts, target, webkit, PROFILES } from "./ui-lib.mjs";

const [port, shots] = process.argv.slice(2);
if (shots) mkdirSync(shots, { recursive: true });
const t = target(port);
const hc = (...a) => execFileSync("lbc", a, { env: scratchEnv(port), encoding: "utf8" });
let failed = 0, passed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== "" ? `  [${extra}]` : ""}`); if (ok) passed++; else failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(60); } return false; };
const shot = async (p, name) => { if (shots) { await sleep(150); await p.screenshot({ path: `${shots}/${name}.png` }); } };
const tap = async (p, sel) => { await p.locator(sel).first().tap(); };
const hash = (p) => p.evaluate(() => location.hash);
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const HOME = homedir();

// A program that titles itself as real ones do, reports like one if asked, and stays.
const started = [];
function program({ title = "", app = "", cwd = REPO, name = "", on = "", labels = [] }) {
  const script = `printf '\\033]0;%s\\007' "$1"; [ -n "$2" ] && printf '\\033]7501;state=idle:app=%s\\033\\\\' "$2"; exec sleep 100000`;
  const a = ["run", "--bg", "--no-parent", "--json", "--cwd", cwd, ...(name ? ["--name", name] : []), ...(on ? ["--on", on] : []), ...labels.flatMap((l) => ["--label", l]), "bash", "-c", script, "x", title, app];
  const address = JSON.parse(hc(...a)).address;
  started.push(address);
  return address;
}
const local = (a) => a.split("/").pop();
const block = (a, id = `p-${a}`, weight) => ({ id, type: "block", content: { terminal: local(a) }, ...(weight ? { size: { weight } } : {}) });
const row = (id, children) => ({ id, type: "row", children });

// Each of these came from the real core on 2026-11-04.
const A = addresses(port);
const twinA = program({ title: "Claude Code", app: "claude-code", cwd: `${REPO}/web` });
const twinB = program({ title: "Claude Code", app: "claude-code", cwd: `${REPO}/web` });
const hermes = program({ title: "", cwd: HOME });
const prompt = program({ title: `sam@build: ~`, cwd: HOME });
const promptTab = program({ title: "sam@build: ~/repos/acme", cwd: `${REPO}/tests` });
const working = program({ title: "✳ Mobile frontend options", app: "claude-code", cwd: HOME });
const folderSide = program({ title: "Claude Code", app: "claude-code", cwd: `${REPO}/docs` });
const longName = program({ title: "an extremely long pane name that nobody would ever choose but somebody surely will, and it keeps going past any phone", cwd: `${REPO}/gateway/src`, labels: ["lumbridge.pinned=1"] });
const remoteDeep = program({ title: "Claude Code", app: "claude-code", on: "rig", cwd: `${REPO}/scripts` });

function seed() {
  seedLayouts(port, A);
  seedDoc(port, { spaces: [
    { id: "s-studio", name: "Studio", folder: `${REPO}`, tabs: [
      { id: "t-gw", name: "Gateway work", root: row("t-gw", [block(A["gateway-review"], "p1", 0.5), block(A["pr-branch"], "p2", 0.3), block(A["web-tests"], "p3", 0.2)]) },
      { id: "t-docs", name: "Docs", root: row("t-docs", [block(A["docs-pass"])]) },
      { id: "t-tab", name: "Tab", root: row("t-tab", [block(twinA), block(twinB)]) },
      { id: "t-chat", name: "Tab 2", root: row("t-chat", [block(A["chat-agent"])]) },
    ] },
    { id: "s-home", name: "Home", folder: HOME, tabs: [
      { id: "t-h1", name: "Hermes", root: row("t-h1", [block(hermes)]) },
      { id: "t-h2", name: "1", root: row("t-h2", [block(prompt)]) },
      { id: "t-h3", name: "storage + security", root: row("t-h3", [block(promptTab), block(working), block(folderSide)]) },
      { id: "t-h4", name: "Long", root: row("t-h4", [block(longName)]) },
      { id: "t-h5", name: "a tab whose name is much too long for any phone to show on one line, by a long way", root: row("t-h5", [block(A["scratch-shell"]), { id: "m1", type: "block", title: "A panel with a very long title indeed", content: { mod: "notebook" } }]) },
    ] },
    { id: "s-odd", name: '<img src=x onerror="window.__xss=1">Odd', folder: "/tmp/<script>window.__xss=1</script>", tabs: [] },
  ] });
  // Five spaces on rig: folded to start with, so search has to reach inside.
  seedDoc(port, { spaces: [
    { id: "s-batch", name: "Batch", folder: "/home/sam/rig/batch", tabs: [{ id: "t-a", name: "Factory", root: row("t-a", [block(A["factory-batch"])]) }] },
    { id: "s-ci", name: "CI", folder: "/home/sam/rig/ci", tabs: [{ id: "t-b", name: "Gateway", root: row("t-b", [block(A["ci-gateway"]), block(A["rig-shell"])]) }] },
    { id: "s-muxin", name: "Muxin", folder: "/home/sam/rig/muxin", tabs: [{ id: "t-c", name: "Render", root: row("t-c", [block(A["muxin-render"])]) }] },
    { id: "s-arch", name: "Archive", folder: "/home/sam/rig/archive", tabs: [{ id: "t-d", name: "Nightly", root: row("t-d", [block(A["nightly-archive"]), block(remoteDeep)]) }] },
  ] }, "rig");
}
seed();
await sleep(600);

const browser = await chromium.launch({ channel: "chrome" });
const nameIn = (p, a, scope = ".place .pm-rows") => p.evaluate(([a, s]) => document.querySelector(`${s} .row[data-address="${a}"] .name`)?.textContent, [a, scope]);
const openSpace = async (p, machine, name) => {
  await p.evaluate(([m, n]) => {
    const sp = [...document.querySelectorAll(`.pm-machine[data-machine="${m}"] .pm-space`)].find((s) => s.querySelector(".pm-space-name").textContent === n);
    if (!sp.classList.contains("open")) sp.querySelector(".pm-space-head").click();
  }, [machine, name]);
  await sleep(120);
};
const seeded = (p) => p.waitForSelector(".place .pane-row");
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

for (const [profile, tag] of [["iphone", "ios"], ["pixel", "pix"], ["desktop", "desk"]]) {
  for (const dark of [true, false]) {
    const name = `${tag}-${dark ? "dark" : "light"}`;
    const say = (s) => `${name}: ${s}`;
    const phone = profile !== "desktop";
    const press = (p, sel) => (phone ? tap(p, sel) : p.locator(sel).first().click());
    const p = await open(browser, t, profile, { dark, hash: "#/agents", ...(tag === "ios" ? { userAgent: IPHONE_UA } : {}) });
    await p.waitForSelector(".master .row");
    await shot(p, `${name}-bystate`);

    // -- the merged tab --
    const nav = await p.evaluate(() => [...document.querySelectorAll(".tabs .tab")].filter((e) => e.offsetParent).map((e) => e.querySelector(".tab-label").textContent));
    check(say("the tabs"), nav.join() === (phone ? `Today,Agents,${ASSISTANT},Tasks,Apps` : SCREENS.map((s) => s.label).join()), nav.join());
    if (phone) {
      await press(p, ".tab-apps");
      await sleep(600);
      const tiles = await p.evaluate(() => [...document.querySelectorAll(".drawer .app-label")].map((e) => e.textContent));
      check(say(`the drawer holds ${DRAWER.map((s) => s.label).join(", ")}`), tiles.join() === DRAWER.map((s) => s.label).join(), tiles.join());
      await p.keyboard.press("Escape");
      await sleep(600);
    }
    const seg = () => p.evaluate(() => {
      const on = document.querySelector(".list-btn.on");
      return { on: on.dataset.list, selected: on.getAttribute("aria-selected"), others: [...document.querySelectorAll(".list-btn:not(.on)")].map((b) => b.getAttribute("aria-selected")).join(), panel: document.getElementById(on.getAttribute("aria-controls"))?.offsetParent != null, tabindex: [on.tabIndex, ...[...document.querySelectorAll(".list-btn:not(.on)")].map((b) => b.tabIndex)].join() };
    });
    let s = await seg();
    check(say("By state is on, its panel shown, and that's what aria says"), s.on === "agents" && s.selected === "true" && s.others === "false" && s.panel && s.tabindex === "0,-1", JSON.stringify(s));
    const badge = await p.evaluate(() => { const b = document.querySelector(".tab-agents .badge"); return { hidden: b.hidden, n: Number(b.textContent), label: document.querySelector(".tab-agents").getAttribute("aria-label") }; });
    check(say("the needs-you badge is on the Agents tab"), !badge.hidden && badge.n > 0 && badge.label.includes("need you"), JSON.stringify(badge));
    const box0 = await p.evaluate(() => { document.querySelector(".master").scrollTop = 140; const r = document.querySelector(".agents-top").getBoundingClientRect(); return [r.top, r.height]; });

    // Nothing may paint empty: the moment the switch is pressed, the other list is already there, its layout read while it was hidden.
    await sleep(800);
    await p.evaluate(() => {
      window.__blank = 0; window.__placeEl = document.querySelector(".place .inbox"); window.__masterEl = document.querySelector(".master .inbox");
      const look = () => { const shown = [...document.querySelectorAll(".master, .place")].find((e) => e.offsetParent); if (!shown || shown.querySelectorAll(".row").length === 0 || shown.querySelector(".skeleton")) window.__blank++; window.__rq = requestAnimationFrame(look); };
      look();
    });
    await press(p, '.list-btn[data-list="panes"]');
    await seeded(p);
    check(say("the switch selects By place, and the route says so"), (await hash(p)) === "#/panes" && (await seg()).on === "panes");
    await sleep(300);
    await press(p, '.list-btn[data-list="agents"]');
    await sleep(200);
    await press(p, '.list-btn[data-list="panes"]');
    await sleep(200);
    const noFlash = await p.evaluate(() => { cancelAnimationFrame(window.__rq); return { blank: window.__blank, same: window.__placeEl === document.querySelector(".place .inbox") && window.__masterEl === document.querySelector(".master .inbox") }; });
    check(say("no blank frame on the switch, and neither list was rebuilt"), noFlash.blank === 0 && noFlash.same, JSON.stringify(noFlash));
    const box1 = await p.evaluate(() => { const r = document.querySelector(".agents-top").getBoundingClientRect(); return [r.top, r.height]; });
    check(say("the top doesn't move between views"), box0[0] === box1[0] && box0[1] === box1[1], `${box0} ${box1}`);
    await p.reload();
    await seeded(p);
    check(say("By place is remembered across a reload"), (await seg()).on === "panes");
    await p.goto(t.base);
    await p.waitForSelector(".td");
    check(say("a bare start is Today, and the Agents tab still goes to By place"), await p.evaluate(() => document.querySelector(".tab-agents").getAttribute("href") === "#/panes"));
    await p.click(".tab-agents");
    await seeded(p);
    check(say("and the tab opens it"), (await seg()).on === "panes");
    await p.goto(`${t.base}#/agents`);
    await until(async () => (await seg()).on === "agents");
    check(say("an old #/agents link selects By state"), (await seg()).on === "agents" && await p.evaluate(() => !!document.querySelector(".master").offsetParent && !document.querySelector(".place").offsetParent));
    await p.goto(`${t.base}#/panes`);
    await until(async () => (await seg()).on === "panes");
    check(say("an old #/panes link selects By place"), (await seg()).on === "panes" && await p.evaluate(() => !!document.querySelector(".place").offsetParent && !document.querySelector(".master").offsetParent));
    await p.focus('.list-btn.on');
    await p.keyboard.press("ArrowLeft");
    check(say("arrow keys move the switch, and focus with it"), (await seg()).on === "agents" && await p.evaluate(() => document.activeElement.dataset.list === "agents"));
    await p.keyboard.press("ArrowRight");
    await seeded(p);
    if (phone) await shot(p, `${name}-byplace-top`);

    // -- names, on real titles --
    await openSpace(p, "", "Studio");
    await openSpace(p, "", "Home");
    check(say("the two Claude Codes in ~/.../web under 'Tab' get told apart"), await until(async () => (await nameIn(p, twinA)) === "web 1" && (await nameIn(p, twinB)) === "web 2"), `${await nameIn(p, twinA)} / ${await nameIn(p, twinB)}`);
    check(say("a shell's prompt isn't a name: it takes the tab, then told apart by folder"), (await nameIn(p, promptTab)) === "storage + security · tests", await nameIn(p, promptTab));
    check(say("a title that means something stands"), (await nameIn(p, working)) === "Mobile frontend options", await nameIn(p, working));
    check(say("a program in home, whose tab only names it, is called that"), (await nameIn(p, hermes)) === "Hermes", await nameIn(p, hermes));
    check(say("an unnamed shell in home, under a default tab, is its program"), (await nameIn(p, prompt)) === "bash" || (await nameIn(p, prompt)) === "sleep", await nameIn(p, prompt));
    check(say("the owner's own name wins"), (await nameIn(p, A["gateway-review"])) === "gateway-review");
    const word = await p.evaluate((a) => document.querySelector(`.pm-rows .row[data-address="${a}"] .row-program`)?.textContent, twinA);
    check(say("the program stays as a small word"), word === "claude", word);
    const hiddenWord = await p.evaluate((a) => { const e = document.querySelector(`.pm-rows .row[data-address="${a}"] .row-program`); return e.hidden || e.textContent !== "hermes"; }, hermes);
    check(say("and doesn't repeat the name"), hiddenWord);
    const small = await p.evaluate((a) => { const r = document.querySelector(`.pm-rows .row[data-address="${a}"]`); return [parseFloat(getComputedStyle(r.querySelector(".row-program")).fontSize), parseFloat(getComputedStyle(r.querySelector(".name")).fontSize)]; }, twinA);
    check(say("smaller than the name"), small[0] < small[1], small.join());
    await p.evaluate(() => { location.hash = "#/agents"; });
    await p.waitForSelector(".master .row");
    check(say("By state and the terminal use the same names"), await until(async () => (await nameIn(p, twinA, ".master")) === "web 1"));
    await p.evaluate((a) => { location.hash = `#/t/${encodeURIComponent(a)}`; }, twinA);
    await p.waitForSelector(".term .title .name");
    check(say("the terminal's title too"), await until(() => p.evaluate(() => document.querySelector(".term .title .name").textContent === "web 1")), await p.evaluate(() => document.querySelector(".term .title .name").textContent));
    await p.evaluate(() => { location.hash = "#/panes"; });
    await seeded(p);

    // -- less chrome --
    const chrome = await p.evaluate(({ twinA, hermes, docs }) => {
      const heads = [...document.querySelectorAll('.pm-machine[data-machine=""] .pm-tab-head')].map((e) => e.textContent);
      const meta = (a) => document.querySelector(`.pm-rows .row[data-address="${a}"] .meta`)?.textContent;
      const spaceFolder = (n) => [...document.querySelectorAll(".pm-space")].find((s) => s.querySelector(".pm-space-name").textContent === n)?.querySelector(".pm-space-head .meta");
      return { heads, twin: meta(twinA), hermes: meta(hermes), docs: meta(docs), homeSpace: !!spaceFolder("Home"), repoSpace: !!spaceFolder("Studio") };
    }, { twinA, hermes, docs: A["docs-pass"] });
    check(say("a tab with several panes keeps its heading"), chrome.heads.includes("Gateway work") && chrome.heads.includes("storage + security"), chrome.heads.join("|"));
    check(say("a one-pane tab loses it, and a 'Tab' has none to lose"), !chrome.heads.includes("Docs") && !chrome.heads.includes("Tab") && !chrome.heads.includes("Tab 2") && !chrome.heads.includes("1"), chrome.heads.join("|"));
    check(say("what that heading said is still on the row"), chrome.docs.includes("Docs"), chrome.docs);
    check(say("a folder of ~ isn't shown, on a row or a space"), !/~$|~ /.test(chrome.hermes) && chrome.hermes !== "" && !chrome.homeSpace && chrome.repoSpace, JSON.stringify(chrome));

    // -- favorites and recent --
    const group = (cls) => p.evaluate((c) => [...document.querySelectorAll(`.place .group.${c} .row`)].map((r) => r.dataset.address), cls);
    const head = () => p.evaluate(() => [...document.querySelectorAll(".pm-lists > .group .group-title")].map((e) => e.textContent));
    const favs = await group("favorites");
    check(say("Favorites holds what's labelled lumbridge.pinned, everywhere"), favs.includes(A["gateway-review"]) && favs.includes(A["nightly-archive"]) && favs.includes(longName), favs.join());
    const before = await head();
    const y = await p.evaluate(() => [...document.querySelectorAll(".pm-lists > *")].map((e) => e.className.split(" ")[1] ?? e.className));
    // Needs you is one line here now (L-15), a link to By state: its rows are By state's.
    check(say("the Needs you line, then Favorites, then Recent, then machines"), y[0] === "pm-needs" && y[1] === "favorites" && y.indexOf("pm-machine") > 1 && (y.indexOf("recent") === -1 || y.indexOf("recent") === 2), y.join());
    hc("label", A["web-tests"], "lumbridge.pinned=1");
    check(say("pinned elsewhere, it joins by itself"), await until(async () => (await group("favorites")).includes(A["web-tests"])));
    hc("label", A["web-tests"], "lumbridge.pinned=");
    check(say("and leaves"), await until(async () => !(await group("favorites")).includes(A["web-tests"])));

    const opens = [A["docs-pass"], A["chat-agent"], twinA, twinB, hermes, prompt];
    await p.evaluate(() => localStorage.removeItem("lumbridge.panes.recent"));
    await p.reload();
    await seeded(p);
    check(say("nothing opened yet: no Recent"), (await p.locator(".place .group.recent").count()) === 0, (await head()).join());
    for (const a of opens) {
      await p.evaluate((x) => { location.hash = `#/t/${encodeURIComponent(x)}`; }, a);
      await p.waitForSelector(".xterm-rows");
      await sleep(350);
      await p.evaluate(() => { location.hash = "#/panes"; });
      await sleep(60);
    }
    check(say("Recent is the last five the owner opened, newest first"), await until(async () => (await group("recent")).join() === [prompt, hermes, twinB, twinA, A["chat-agent"]].join()), (await group("recent")).join());
    const stored = await p.evaluate(() => JSON.parse(localStorage.getItem("lumbridge.panes.recent"))[0]);
    check(say("remembered on this device, by address"), stored === prompt, stored);
    await p.reload();
    await seeded(p);
    check(say("and still there after a reload"), await until(async () => (await group("recent"))[0] === prompt));
    await p.evaluate((a) => { const l = JSON.parse(localStorage.getItem("lumbridge.panes.recent")); localStorage.setItem("lumbridge.panes.recent", JSON.stringify(["t-not-here", a, ...l])); }, A["gateway-review"]);
    await p.reload();
    await seeded(p);
    await until(async () => (await group("recent")).length > 0);
    const dropped = await group("recent");
    check(say("one that's gone is dropped, and what's already above isn't repeated"), !dropped.includes("t-not-here") && !dropped.includes(A["gateway-review"]) && dropped.length === 5 && dropped[0] === prompt, dropped.join());
    await shot(p, `${name}-byplace-favorites-recent`);
    if (shots && phone) { await p.evaluate(() => { document.querySelector(".place").scrollTop = 600; }); await shot(p, `${name}-byplace-tree`); await p.evaluate(() => { document.querySelector(".place").scrollTop = 0; }); }

    await press(p, '.panes .chip[data-m="rig"]');
    await until(() => p.evaluate(() => document.querySelectorAll(".pm-machine").length === 1));
    check(say("a machine filter hides both"), (await p.locator(".place .group.recent, .place .group.favorites").count()) === 0);
    await press(p, '.panes .chip[data-m="*"]');
    await until(() => p.evaluate(() => document.querySelectorAll(".pm-machine").length > 1));
    check(say("and they come back"), (await p.locator(".place .group.recent").count()) === 1 && (await p.locator(".place .group.favorites").count()) === 1);

    // -- search --
    const input = ".find-input";
    await p.reload();
    await seeded(p);
    check(say("opening doesn't raise the keyboard"), await p.evaluate(() => document.activeElement !== document.querySelector(".find-input")));
    const results = () => p.evaluate(() => [...document.querySelectorAll(".place .pm-results .row")].map((r) => r.dataset.address));
    const seen = () => p.evaluate(() => ({ machines: document.querySelectorAll(".pm-machine").length, groups: document.querySelectorAll(".place .group").length, chips: !!document.querySelector(".panes .chips").offsetParent, sum: document.querySelector(".inbox-sum").textContent }));
    await p.fill(input, "muxin");
    check(say("a pane in a folded space on another machine is found"), await until(async () => (await results()).includes(A["muxin-render"])), (await results()).join());
    let v = await seen();
    check(say("flat: no machines, groups or chips"), v.machines === 0 && v.groups === 0 && !v.chips, JSON.stringify(v));
    check(say("and says how many"), /^\d+ match/.test(v.sum), v.sum);
    await shot(p, `${name}-search`);
    await p.fill(input, "rig render");
    check(say("every word must match, across fields"), await until(async () => (await results()).join() === A["muxin-render"]), (await results()).join());
    await p.fill(input, "storage bash xyz");
    await until(() => p.evaluate(() => !!document.querySelector(".place .pm-empty")));
    check(say("no match says so"), await p.evaluate(() => document.querySelector(".place .pm-empty .empty-title").textContent === "Nothing matches." && document.querySelector(".inbox-sum").textContent === "0 matches"));
    await shot(p, `${name}-search-none`);
    for (const [q, a] of [["Gateway work", A["pr-branch"]], ["Studio", A["docs-pass"]], ["Batch", A["factory-batch"]], ["rig", A["ci-gateway"]], ["gateway/src", longName]]) {
      await p.fill(input, q);
      check(say(`"${q}" finds by name, tab, space, machine or folder`), await until(async () => (await results()).includes(a)), (await results()).join());
    }
    await p.fill(input, '<img src=x onerror="window.__xss=1">');
    await sleep(120);
    await p.fill(input, "odd");
    await sleep(120);
    check(say("what's searched and shown is only ever text"), await p.evaluate(() => window.__xss === undefined && !document.querySelector(".place img, .place script")));
    const clearBox = await (async () => { await p.fill(input, "muxin"); await sleep(80); return p.locator(".find-clear").boundingBox(); })();
    await p.locator(input).blur();
    await press(p, ".find-clear");
    check(say("one tap clears it, and the list is back"), await until(async () => (await p.inputValue(input)) === "" && (await seen()).machines > 0));
    check(say("and it doesn't raise the keyboard"), await p.evaluate(() => document.activeElement !== document.querySelector(".find-input")));
    const clearMin = await p.evaluate(() => (matchMedia("(pointer: fine)").matches && innerWidth >= 900 ? 36 : 44));
    check(say("the clear button is a real target"), clearBox.width >= clearMin && clearBox.height >= clearMin, JSON.stringify(clearBox));
    check(say("hidden when there's nothing to clear"), await p.evaluate(() => document.querySelector(".find-clear").hidden));

    // Search from By state too, and clearing goes back there.
    await p.evaluate(() => { location.hash = "#/agents"; });
    await p.waitForSelector(".master .row");
    await p.evaluate(() => { document.querySelector(".master").scrollTop = 200; });
    await sleep(60);
    const m0 = await p.evaluate(() => document.querySelector(".master").scrollTop);
    await p.fill(input, "ci-gateway");
    check(say("search works from By state, flat"), await until(async () => (await results()).join() === A["ci-gateway"] && await p.evaluate(() => !document.querySelector(".master").offsetParent)), (await results()).join());
    const row = await p.evaluate((a) => document.querySelector(`.pm-results .row[data-address="${a}"]`).querySelector(".meta").textContent, A["ci-gateway"]);
    check(say("a result says where it lives"), row === "rig · CI › Gateway", row);
    await p.fill(input, "");
    check(say("clearing goes back to By state, where the owner was"), await until(() => p.evaluate(() => !!document.querySelector(".master").offsetParent)) && Math.abs(await p.evaluate(() => document.querySelector(".master").scrollTop) - m0) < 2);
    await p.fill(input, "gateway-rev");
    await until(async () => (await results()).length === 1);
    await p.press(input, "Enter");
    check(say("Enter opens the first result"), await until(async () => (await hash(p)) === `#/t/${encodeURIComponent(A["gateway-review"])}`), await hash(p));
    await p.waitForSelector(".xterm-rows");
    if (phone) {
      await press(p, ".back");
      check(say("back from a result is the results"), await until(async () => (await results()).length === 1 && (await p.inputValue(input)) === "gateway-rev"));
    } else {
      check(say("beside a result, the results stay"), (await results()).length === 1);
      await p.keyboard.press("Escape");
      await p.keyboard.press("Escape");
      await until(async () => !(await hash(p)).startsWith("#/t/"));
    }
    await p.fill(input, "");

    // -- back keeps the view and the place --
    for (const [list, sel, scroller] of [["panes", ".place .row", ".place"], ["agents", ".master .row", ".master"]]) {
      await p.evaluate((l) => { location.hash = `#/${l}`; }, list);
      await p.waitForSelector(`${scroller} .row`);
      await sleep(80);
      const y0 = await p.evaluate((s) => { const e = document.querySelector(s); e.scrollTop = Math.min(320, e.scrollHeight - e.clientHeight); return e.scrollTop; }, scroller);
      await sleep(60);
      const target = await p.evaluate(([sel0, s]) => { const top = document.querySelector(s).getBoundingClientRect(); return [...document.querySelectorAll(`${sel0} a.row-main`)].find((e) => { const b = e.getBoundingClientRect(); return b.top > top.top + 10 && b.bottom < top.bottom - 10; })?.getAttribute("href"); }, [sel, scroller]);
      const link = p.locator(`${sel} a[href="${target}"]`).first();
      await (phone ? link.tap() : link.click());
      await p.waitForSelector(".xterm-rows");
      if (phone) await press(p, ".back");
      else { await p.keyboard.press("Escape"); await p.keyboard.press("Escape"); }
      check(say(`back to ${list}, the view the owner came from`), await until(async () => (await hash(p)) === `#/${list}`), await hash(p));
      await sleep(120);
      const y1 = await p.evaluate((s) => document.querySelector(s).scrollTop, scroller);
      check(say(`and the same scroll in ${list}`), y0 > 0 && Math.abs(y1 - y0) < 2, `${y0} -> ${y1}`);
    }
    // Each view keeps its own scroll across the switch.
    const ys = await p.evaluate(async () => {
      const m = document.querySelector(".master"), q = document.querySelector(".place");
      location.hash = "#/agents"; await new Promise((r) => setTimeout(r, 80)); m.scrollTop = 100; const a = m.scrollTop;
      location.hash = "#/panes"; await new Promise((r) => setTimeout(r, 80)); q.scrollTop = 260; const b = q.scrollTop;
      location.hash = "#/agents"; await new Promise((r) => setTimeout(r, 80)); const a2 = m.scrollTop;
      location.hash = "#/panes"; await new Promise((r) => setTimeout(r, 80)); const b2 = q.scrollTop;
      return { a, b, a2, b2 };
    });
    check(say("each view keeps its scroll across the switch"), Math.abs(ys.a - ys.a2) < 2 && Math.abs(ys.b - ys.b2) < 2 && ys.b > 0, JSON.stringify(ys));

    if (!phone) {
      await p.click('.list-btn[data-list="panes"]');
      await p.click(`.place .pm-rows .row[data-address="${A["chat-agent"]}"] a`);
      await p.waitForSelector(".xterm-rows");
      await shot(p, `${name}-terminal-beside`);
      const side = await p.evaluate(() => { const l = document.querySelector(".place").getBoundingClientRect(), d = document.querySelector(".detail").getBoundingClientRect(); return { beside: l.right <= d.left + 1 && d.width > 600 && l.width > 300, on: document.querySelector(".tab.on").getAttribute("aria-label").split(",")[0] }; });
      check(say("the list column stays, with the terminal beside it, under the Agents tab"), side.beside && side.on === "Agents", JSON.stringify(side));
      await p.click('.list-btn[data-list="agents"]');
      const still = await p.evaluate(() => ({ hash: location.hash, term: !!document.querySelector(".xterm-rows")?.offsetParent, master: !!document.querySelector(".master").offsetParent, back: document.querySelector(".back").getAttribute("href") }));
      check(say("the switch beside an open terminal changes the list and leaves the terminal"), still.hash.startsWith("#/t/") && still.term && still.master && still.back === "#/agents", JSON.stringify(still));
      await p.keyboard.press("Escape");
      await until(async () => (await hash(p)) === "#/agents");
      await p.keyboard.press("/");
      check(say("/ goes to search"), await p.evaluate(() => document.activeElement === document.querySelector(".find-input")));
      await p.keyboard.press("Escape");
      check(say("Esc leaves it"), await p.evaluate(() => document.activeElement !== document.querySelector(".find-input")));
    }

    // -- the polish bar --
    await p.evaluate(() => { location.hash = "#/panes"; });
    await seeded(p);
    await p.fill(input, "");
    await sleep(100);
    const sizes = await p.evaluate(() => {
      const small = [];
      for (const e of document.querySelectorAll(".list-btn, .find-input, .pm-space-head, .place a.row-main, .tabs .tab")) {
        if (!e.offsetParent) continue;
        const b = e.getBoundingClientRect();
        const min = (matchMedia("(pointer: fine)").matches && innerWidth >= 900 ? 36 : 44);
        if (b.height < min || b.width < min) small.push(`${e.className} ${Math.round(b.width)}x${Math.round(b.height)}`);
      }
      return small;
    });
    check(say("targets are 44 px on touch, 36 on a desktop"), sizes.length === 0, sizes.join("; "));
    const sideways = await p.evaluate(() => [document.documentElement, document.querySelector(".place"), document.querySelector(".agents-top")].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className));
    check(say("no sideways scroll with very long names"), sideways.length === 0, sideways.join());
    const clipped = await p.evaluate((a) => { const n = document.querySelector(`.pm-rows .row[data-address="${a}"] .name`); const r = n.closest(".row").getBoundingClientRect(); return n.getBoundingClientRect().right <= r.right && n.scrollWidth > n.clientWidth; }, longName);
    check(say("a long name truncates inside its row"), clipped);
    check(say("nothing from a document became markup"), await p.evaluate(() => window.__xss === undefined && !document.querySelector(".place img, .place script, .master img")));
    const errors = p.errors.filter((e) => !e.includes("503"));
    check(say("no page errors"), errors.length === 0, errors.join("; "));
    await p.context().close();
  }
}

// ---- Data arriving doesn't move what's there ----
{
  const ctx = await browser.newContext({ ...PROFILES.iphone, colorScheme: "dark" });
  await ctx.addInitScript((tok) => { try { localStorage.setItem("lumbridge.token", tok); localStorage.setItem("lumbridge.agents.list", "panes"); } catch {} }, t.token);
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    window.__tops = new Set();
    const look = () => { const s = document.querySelector(".place"), h = document.querySelector(".agents-top"); if (s?.offsetParent) window.__tops.add(`${h.getBoundingClientRect().height}|${Math.round(s.getBoundingClientRect().top)}|${Math.round(s.querySelector(".pm-lists")?.getBoundingClientRect().top ?? 0)}`); requestAnimationFrame(look); };
    requestAnimationFrame(look);
  });
  await p.goto(`${t.base}#/panes`);
  await p.waitForSelector(".place .pane-row");
  await sleep(500);
  const tops = await p.evaluate(() => [...window.__tops]);
  check("the top and the list's start hold still while the layout arrives", tops.length === 1, tops.join(" "));
  await ctx.close();
}

// ---- What needs the owner is in By place even with no layout: the badge counts it ----
{
  const stray = JSON.parse(hc("run", "--bg", "--no-parent", "--json", "--name", "stray-question", new URL("../scripts/dev-fixture.sh", import.meta.url).pathname, "--agent", "question")).address;
  started.push(stray);
  const p = await open(browser, t, "iphone", { hash: "#/panes" });
  // Needs you is one line in By place (L-15). One in no layout has nowhere below to be marked, so it's listed under the line,
  // once; the line counts it, as the badge does, and takes the owner to By state, where its row is.
  check("a blocked terminal in no layout is under the Needs you line", await until(() => p.evaluate((a) => !!document.querySelector(`.place .pm-needs + .pm-loose .row[data-address="${a}"]`), stray)));
  const counts = () => p.evaluate((a) => ({ badge: Number(document.querySelector(".tab-agents .badge")?.textContent), line: Number(document.querySelector(".place .pm-needs-count")?.textContent), once: document.querySelectorAll(`.place .pm-lists .row[data-address="${a}"]`).length }), stray);
  check("and the line and the badge agree, and it's listed once", await until(async () => { const c = await counts(); return c.badge === 5 && c.line === c.badge && c.once === 1; }), JSON.stringify(await counts()));
  await tap(p, ".place .pm-needs");
  check("and following the line, it's under Needs you in By state", await until(() => p.evaluate((a) => location.hash === "#/agents" && !!document.querySelector(`.master .group.needs .row[data-address="${a}"]`), stray)), await p.evaluate(() => location.hash));
  await p.context().close();
  hc("kill", stray);
}

// ---- Leaving a terminal the moment xterm comes up: nothing thrown after it's gone ----
{
  const p = await open(browser, t, "iphone", { hash: "#/agents" });
  await p.waitForSelector(".master .row");
  // The observer runs in the same task as xterm's open(), before the timer that open() queues: as early as anyone can leave.
  await p.evaluate(() => {
    window.__left = 0;
    new MutationObserver(() => {
      if (!location.hash.startsWith("#/t/") || !document.querySelector(".xterm-rows")) return;
      history.replaceState(null, "", "#/agents");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      window.__left++;
    }).observe(document.body, { childList: true, subtree: true });
  });
  for (let i = 0; i < 3; i++) {
    await p.evaluate((a) => { location.hash = `#/t/${encodeURIComponent(a)}`; }, twinA);
    await until(() => p.evaluate((n) => window.__left > n, i));
    await sleep(300);
  }
  check("left as xterm opened, three times", await p.evaluate(() => window.__left) === 3, await p.evaluate(() => window.__left));
  const errors = p.errors.filter((e) => !e.includes("503")); // the data screens, with no database in a scratch world
  check("and nothing thrown after", errors.length === 0, errors.join("; "));
  await p.context().close();
}

// ---- Many panes: everything searchable, and quick enough ----
{
  const many = [];
  for (let i = 0; i < 24; i++) many.push(program({ title: "Claude Code", app: "claude-code", cwd: i % 2 ? `${REPO}/web/src` : `${REPO}/tests`, ...(i % 3 ? {} : { title: `worker ${i} on the very long running migration that never seems to end` }) }));
  seedDoc(port, { spaces: [
    ...Array.from({ length: 6 }, (_, s) => ({ id: `big-${s}`, name: `Project ${s} with a name long enough to run out of room on a phone`, folder: `${REPO}/tests`, tabs: Array.from({ length: 2 }, (_, tb) => ({ id: `big-${s}-${tb}`, name: tb ? "Tab" : `Stage ${tb}`, root: row(`r${s}${tb}`, many.slice(s * 4 + tb * 2, s * 4 + tb * 2 + 2).map((a, i) => block(a, `b${s}${tb}${i}`))) })) })),
  ] });
  for (const dark of [true, false]) {
    const p = await open(browser, t, "iphone", { dark, hash: "#/panes", userAgent: IPHONE_UA });
    await p.waitForSelector(".place .pm-space");
    await p.evaluate(() => { for (const b of document.querySelectorAll('.pm-machine[data-machine=""] .pm-space:not(.open) .pm-space-head')) b.click(); });
    await sleep(120);
    await p.evaluate(() => { for (const b of document.querySelectorAll('.pm-machine[data-machine=""] .pm-space:not(.open) .pm-space-head')) b.click(); });
    await sleep(120);
    await shot(p, `many-${dark ? "dark" : "light"}-top`);
    await p.evaluate(() => { document.querySelector(".place").scrollTop = 900; });
    await shot(p, `many-${dark ? "dark" : "light"}-middle`);
    const worst = await p.evaluate(() => { const list = document.querySelector(".place"); return list.scrollWidth <= list.clientWidth; });
    check(`many panes: no sideways scroll (${dark ? "dark" : "light"})`, worst);
    const ms = await p.evaluate(() => { const i = document.querySelector(".find-input"); const t0 = performance.now(); i.value = "worker migration"; i.dispatchEvent(new Event("input")); return performance.now() - t0; });
    check("many panes: a search draws in under 50 ms", ms < 50, `${ms}`);
    check("many panes: and finds the long ones", (await p.locator(".pm-results .row").count()) >= 8);
    await shot(p, `many-${dark ? "dark" : "light"}-search`);
    await p.context().close();
  }
}

// ---- WebKit, the closest thing here to Safari ----
{
  const wk = await webkit.launch();
  const ctx = await wk.newContext({ ...PROFILES.iphone, colorScheme: "dark", userAgent: IPHONE_UA });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.addInitScript((tok) => localStorage.setItem("lumbridge.token", tok), t.token);
  await p.goto(`${t.base}#/agents`);
  await p.waitForSelector(".master .row", { state: "attached" });
  await p.tap('.list-btn[data-list="panes"]');
  await p.waitForSelector(".place .pane-row");
  check("WebKit: the switch works", (await hash(p)) === "#/panes");
  const y = await p.evaluate(async () => { const q = document.querySelector(".place"); q.scrollTop = 300; await new Promise((r) => setTimeout(r, 50)); return q.scrollTop; });
  const a = await p.evaluate(() => { const top = document.querySelector(".place").getBoundingClientRect().top; return [...document.querySelectorAll(".place .pm-rows a.row-main, .place .pm-quick a.row-main")].find((e) => e.getBoundingClientRect().top > top + 10).getAttribute("href"); });
  await p.tap(`.place a[href="${a}"]`);
  await p.waitForSelector(".xterm-rows", { timeout: 10000 });
  await p.tap(".back");
  await until(async () => (await hash(p)) === "#/panes");
  await sleep(120);
  check("WebKit: back keeps the scroll", Math.abs(await p.evaluate(() => document.querySelector(".place").scrollTop) - y) < 2);
  await p.fill(".find-input", "worker migration");
  check("WebKit: search finds flat", await until(() => p.evaluate(() => document.querySelectorAll(".pm-results .row").length > 0)));
  await p.tap(".find-clear");
  check("WebKit: and clears with one tap", await until(async () => (await p.inputValue(".find-input")) === ""));
  await shot(p, "webkit-byplace");
  check("WebKit: no errors", errors.length === 0, errors.join("; "));
  await wk.close();
}

await browser.close();
for (const a of started) { try { hc("kill", a); } catch { /* it may have gone */ } }
await sleep(300);
seedLayouts(port, A);
console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
process.exit(failed ? 1 : 0);
