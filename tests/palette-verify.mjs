// The jump palette (Cmd-K, Ctrl-K off a Mac) in Chrome against a scratch core: every screen and agent by name, the keys, focus
// kept in and given back, its own chunk, and the way in from the rail and from a phone's Apps sheet.
//   scripts/dev.sh <port> && scripts/dev-fixture.sh <port> && node tests/palette-verify.mjs <port> [shots dir]
// System Chrome; never `playwright install`.
import { mkdirSync } from "node:fs";
import { ASSISTANT, EXT, SCREENS, addresses, chromium, open, target } from "./ui-lib.mjs";

const [port, shots] = process.argv.slice(2);
if (!port) { console.error("usage: palette-verify.mjs <port> [shots dir]"); process.exit(2); }
if (shots) mkdirSync(shots, { recursive: true });
const t = target(port);
const A = addresses(port);
let failed = 0, passed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== "" ? `  [${extra}]` : ""}`); if (ok) passed++; else failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(50); } return false; };
const shot = async (p, name) => { if (shots) { await sleep(150); await p.screenshot({ path: `${shots}/${name}.png` }); } };
const hash = (p) => p.evaluate(() => location.hash);
const isOpen = (p) => p.evaluate(() => !!document.querySelector(".pal"));
const look = (p) => p.evaluate(() => ({
  options: [...document.querySelectorAll(".pal-row")].map((e) => e.querySelector(".pal-label").textContent),
  selected: document.querySelector('.pal-row[aria-selected="true"] .pal-label')?.textContent ?? null,
  active: document.activeElement?.className ?? "",
  none: document.querySelector(".pal-none")?.textContent ?? null,
}));
const typeIn = async (p, text) => { await p.fill(".pal-input", ""); await p.keyboard.type(text); await sleep(80); };

const browser = await chromium.launch({ channel: "chrome" });
const LABELS = SCREENS.map((s) => s.label);

for (const dark of [true, false]) {
  const name = `desk-${dark ? "dark" : "light"}`;
  const say = (s) => `${name}: ${s}`;
  const p = await open(browser, t, "desktop", { dark });
  await p.waitForSelector(".inbox-lists .row");
  const chunk = () => p.evaluate(() => performance.getEntriesByType("resource").some((e) => /\/assets\/palette-.+\.js/.test(e.name)));
  if (dark) check(say("the palette isn't part of the first download"), !(await chunk()));

  // -- open, and what's in it --
  await p.focus(".tab-notes");
  await p.keyboard.press("Control+k");
  check(say("Ctrl-K opens it"), await until(() => isOpen(p)));
  if (dark) check(say("and fetches its chunk then"), await chunk());
  const dialog = await p.evaluate(() => { const d = document.querySelector(".pal"); return { role: d.getAttribute("role"), modal: d.getAttribute("aria-modal"), label: d.getAttribute("aria-label"), appInert: document.getElementById("app").inert }; });
  check(say("a labelled modal dialog, the app behind it inert"), dialog.role === "dialog" && dialog.modal === "true" && dialog.label === "Jump to" && dialog.appInert, JSON.stringify(dialog));
  let l = await look(p);
  check(say("focus is in the field"), l.active.includes("pal-input"), l.active);
  check(say("nothing typed: every screen, in the rail's order, then the agents"), l.options.slice(0, LABELS.length).join() === LABELS.join() && l.options.includes("gateway-review"), l.options.join());
  check(say("the first is selected"), l.selected === "Today", l.selected);
  const sizes = await p.evaluate(() => ({ row: Math.round(document.querySelector(".pal-row").getBoundingClientRect().height), field: Math.round(document.querySelector(".pal-input").getBoundingClientRect().height), w: Math.round(document.querySelector(".pal").getBoundingClientRect().width) }));
  check(say("rows 36 px, the field 40, the panel 560 wide"), sizes.row === 36 && sizes.field === 40 && sizes.w === 560, JSON.stringify(sizes));
  await shot(p, `${name}-open`);

  // -- the keys --
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("ArrowDown");
  check(say("down twice selects the third"), (await look(p)).selected === ASSISTANT);
  await p.keyboard.press("ArrowUp");
  await p.keyboard.press("ArrowUp");
  await p.keyboard.press("ArrowUp");
  l = await look(p);
  check(say("up from the first wraps to the last"), l.selected === l.options.at(-1), JSON.stringify(l));
  await p.keyboard.press("Tab");
  await p.keyboard.press("Shift+Tab");
  check(say("Tab and Shift-Tab stay in the field"), (await look(p)).active.includes("pal-input"));
  await p.keyboard.press("Escape");
  check(say("Esc closes it"), await until(async () => !(await isOpen(p))));
  check(say("and gives focus back where it was"), await p.evaluate(() => document.activeElement?.classList.contains("tab-notes") && !document.getElementById("app").inert));

  // -- filter and go --
  await p.keyboard.press("Control+k");
  await until(() => isOpen(p));
  await typeIn(p, "set");
  l = await look(p);
  check(say('"set": Settings first, and selected'), l.options[0] === "Settings" && l.selected === "Settings", JSON.stringify(l));
  await p.keyboard.press("Enter");
  check(say("Enter goes there and closes"), await until(async () => (await hash(p)) === "#/settings" && !(await isOpen(p))));
  await p.keyboard.press("Control+k");
  await until(() => isOpen(p));
  if (EXT) {
    const tools = SCREENS.find((s) => s.id === "tools");
    await typeIn(p, tools.name.split(" ")[0].toLowerCase());
    check(say("finds Tools by its full name"), (await look(p)).options[0] === "Tools");
  }
  await typeIn(p, "gwr");
  l = await look(p);
  check(say('"gwr" finds gateway-review'), l.options[0] === "gateway-review", JSON.stringify(l));
  check(say("an agent says which machine it's on"), await p.evaluate(() => document.querySelector(".pal-row .pal-hint")?.textContent.trim().length > 0));
  await p.keyboard.press("Enter");
  check(say("Enter on an agent opens its terminal"), await until(async () => decodeURIComponent(await hash(p)) === `#/t/${A["gateway-review"]}`), await hash(p));
  await p.waitForSelector(".xterm-rows", { timeout: 10000 });

  // -- a terminal keeps Ctrl-K: it means something to a shell --
  if (dark) {
    await p.click(".screen");
    await p.keyboard.press("Control+k");
    await sleep(300);
    check(say("Ctrl-K inside a terminal is the terminal's"), !(await isOpen(p)));
  }

  // -- nothing found, the rail button, a click outside --
  await p.click(".rail-find");
  check(say("the rail's search button opens it"), await until(() => isOpen(p)));
  await typeIn(p, "qqqq");
  l = await look(p);
  check(say("nonsense says so plainly"), l.options.length === 0 && l.none === 'Nothing called "qqqq".', JSON.stringify(l));
  await typeIn(p, "fil");
  await p.click('.pal-row:has-text("Files")');
  check(say("clicking an option goes there"), await until(async () => (await hash(p)) === "#/files" && !(await isOpen(p))));
  await p.keyboard.press("Control+k");
  await until(() => isOpen(p));
  await p.mouse.click(30, 870);
  check(say("a click outside closes it, and goes nowhere"), await until(async () => !(await isOpen(p))) && (await hash(p)) === "#/files");
  await p.keyboard.press("Control+k");
  await until(() => isOpen(p));
  await p.keyboard.press("Control+k");
  check(say("Ctrl-K again closes it"), await until(async () => !(await isOpen(p))));

  // -- j and k typed into it don't move the agents list behind --
  await p.goto(t.base + "#/agents");
  await p.waitForSelector(".inbox-lists .row");
  const cursor = () => p.evaluate(() => document.querySelector(".row.cursor")?.dataset.address ?? null);
  const before = await cursor();
  await p.keyboard.press("Control+k");
  await until(() => isOpen(p));
  await p.keyboard.type("jjk");
  const after = { cursor: await cursor(), value: await p.inputValue(".pal-input") };
  check(say("typing j and k filters, and moves no agent cursor"), after.cursor === before && after.value === "jjk", JSON.stringify({ before, ...after }));
  await p.keyboard.press("Escape");
  const errors = p.errors.filter((e) => !e.includes("503 (Service Unavailable)")); // Music and the like, with no service behind them
  check(say("no page errors"), errors.length === 0, errors.join(" | "));
  await p.context().close();
}

// ---- A phone: the Apps sheet's search button ----
for (const dark of [true, false]) {
  const name = `iphone-${dark ? "dark" : "light"}`;
  const say = (s) => `${name}: ${s}`;
  const p = await open(browser, t, "iphone", { dark });
  await p.waitForSelector(".inbox-lists .row");
  await p.tap(".tab-apps");
  await p.waitForSelector(".drawer-find");
  await sleep(300);
  await p.tap(".drawer-find");
  check(say("the sheet's search button opens it, and the sheet closes"), await until(async () => (await isOpen(p)) && await p.evaluate(() => document.querySelector(".drawer-layer").hidden)));
  const r = await p.evaluate(() => ({ row: Math.round(document.querySelector(".pal-row").getBoundingClientRect().height), field: Math.round(document.querySelector(".pal-input").getBoundingClientRect().height), font: getComputedStyle(document.querySelector(".pal-input")).fontSize, foot: getComputedStyle(document.querySelector(".pal-foot")).display }));
  check(say("rows and field are touch size, 16 px type so iOS doesn't zoom, no key hints"), r.row >= 44 && r.field >= 44 && r.font === "16px" && r.foot === "none", JSON.stringify(r));
  await p.keyboard.type("not");
  await sleep(80);
  await shot(p, `${name}-open`);
  await p.tap('.pal-row:has-text("Notes")');
  check(say("tapping an option goes there"), await until(async () => (await hash(p)) === "#/notes" && !(await isOpen(p))));
  check(say("no page errors"), p.errors.length === 0, p.errors.join(" | "));
  await p.context().close();
}

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
