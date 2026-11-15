// End to end against scripts/dev.sh: the real gateway, a real Postgres, a real browser (system Chrome).
//   LUMBRIDGE_DATABASE_URL=... scripts/dev.sh 18540; BASE='http://127.0.0.1:18540/#token=...' node web/e2e/data.mjs [shots-dir]
// Needs `npm i --no-save playwright` in web/. It only ever talks to the database behind that gateway: never aim it at production.
import { chromium } from "playwright";

const pairing = process.env.BASE;
const shots = process.argv[2] ?? "/tmp";
const base = pairing.split("#")[0].replace(/\/$/, "");
const token = pairing.split("token=")[1];
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures++; };

const apiCall = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const wipe = async () => {
  for (const kind of ["notes", "tasks"]) {
    for (const row of (await apiCall("GET", `/api/${kind}?limit=500`)).body) await apiCall("DELETE", `/api/${kind}/${row.id}`);
  }
};

async function session(browser, viewport, colorScheme = "dark") {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme, hasTouch: viewport.width < 500, isMobile: viewport.width < 500 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(m.text()); });
  await page.goto(pairing);
  await page.waitForSelector('nav a[href="#/notes"]');
  return { ctx, page, errors };
}
const openTab = async (page, name) => { await page.click(`nav a[href="#/${name}"]`); await page.waitForSelector(".d-view"); };
const shot = (page, name) => page.screenshot({ path: `${shots}/${name}.png` });
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const tooSmall = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); return { h: r.height, w: r.width, t: e.textContent.trim().slice(0, 20) || e.getAttribute("aria-label") }; }).filter((r) => r.h < 44 || r.w < 44), sel);
const smallFonts = (page) => page.evaluate(() => [...document.querySelectorAll("input,textarea")].filter((e) => e.offsetParent).map((e) => parseFloat(getComputedStyle(e).fontSize)).filter((f) => f < 16));
const statusIs = (page, text) => page.waitForFunction((t) => document.querySelector(".d-status")?.textContent === t, text, { timeout: 8000 });

const browser = await chromium.launch({ channel: "chrome" });
await wipe();

// ---- Notes, phone ---------------------------------------------------------------------------------------------------
{
  const { ctx, page, errors } = await session(browser, { width: 390, height: 844 });
  await openTab(page, "notes");
  await page.waitForSelector(".d-empty-title");
  await shot(page, "notes-empty-phone");
  check((await overflow(page)) === 0, "notes empty: no sideways scroll");

  await page.click(".d-add");
  const focused = await page.evaluate(() => document.activeElement?.className);
  check(focused === "d-title", "new note takes focus inside the tap (keyboard on iOS)");
  await page.fill(".d-title", "Roof quote");
  await page.keyboard.press("Enter");
  check((await page.evaluate(() => document.activeElement?.className)) === "d-body", "Enter in the title moves to the body");
  await page.keyboard.type("Call the **contractor** about the flashing.\n\n- [x] Get photos\n- [ ] Get a second quote\n\nSee https://example.com/roof.");
  await shot(page, "note-editor-phone");
  await statusIs(page, "Saved");
  check(true, "autosave reaches Saved");
  check((await apiCall("GET", "/api/notes")).body[0]?.title === "Roof quote", "the server has the note");
  const draftsLeft = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("notes.draft.")).length);
  check(draftsLeft === 0, "no draft left once confirmed");
  const small = await tooSmall(page, ".d-bar button");
  check(small.length === 0, `editor buttons are 44px (${JSON.stringify(small)})`);
  check((await smallFonts(page)).length === 0, "editor inputs are 16px or more (no iOS zoom)");

  await page.click('[aria-label="Preview"]');
  check((await page.textContent(".d-preview strong")) === "contractor", "preview renders markdown");
  check((await page.$$eval(".d-preview a", (a) => a[0].href)) === "https://example.com/roof", "preview links the url");
  await shot(page, "note-preview-phone");
  await page.click('[aria-label="Edit"]');

  await page.click('[aria-label="Pin"]');
  await statusIs(page, "Saved");
  await page.click('[aria-label="Back to notes"]');
  await page.waitForSelector(".d-note");
  check((await page.$(".d-editor")) === null, "back closes the editor");

  for (const [title, body] of [["Groceries", "Eggs\nCoffee\nRunning shoes"], ["", "A note with no title\nand a second line"], ["Very long title that really should not push the time off the end of the row on a phone screen", "x"]]) {
    await page.click(".d-add");
    if (title) await page.fill(".d-title", title);
    await page.fill(".d-body", body);
    await statusIs(page, "Saved");
    await page.goBack();
    await page.waitForSelector(".d-note");
  }
  await page.waitForFunction(() => document.querySelectorAll(".d-note").length === 4);
  await shot(page, "notes-list-phone");
  check((await overflow(page)) === 0, "notes list: no sideways scroll");
  const firstRow = await page.textContent(".d-note");
  check(firstRow.includes("Roof quote"), "pinned note is first");
  check((await page.$$eval(".d-note-title", (t) => t.map((x) => x.textContent))).includes("A note with no title"), "no title: first line stands in");

  await page.fill(".d-search input", "runni");
  await page.waitForFunction(() => document.querySelectorAll(".d-note").length === 1);
  check((await page.textContent(".d-note")).includes("Groceries"), "search finds a word as it's typed");
  await shot(page, "notes-search-phone");
  await page.fill(".d-search input", "zzzz");
  await page.waitForSelector(".d-empty");
  await shot(page, "notes-search-empty-phone");
  await page.fill(".d-search input", "");
  await page.waitForFunction(() => document.querySelectorAll(".d-note").length === 4);

  // Delete and undo.
  await page.click(".d-note:has-text('Groceries')");
  await page.waitForFunction(() => document.querySelector(".d-title")?.value === "Groceries");
  await page.click('[aria-label="Delete"]');
  await page.waitForSelector(".d-toast");
  await shot(page, "note-deleted-toast-phone");
  await page.waitForFunction(() => ![...document.querySelectorAll(".d-note")].some((n) => n.textContent.includes("Groceries")));
  check(true, "deleted note leaves the list");
  await page.click(".d-toast button");
  await page.waitForFunction(() => [...document.querySelectorAll(".d-note")].some((n) => n.textContent.includes("Groceries")));
  check(true, "undo brings it back");

  // Offline: keep typing, nothing is lost, it saves on return.
  await page.click(".d-note:has-text('Groceries')");
  await page.waitForFunction(() => document.querySelector(".d-title")?.value === "Groceries");
  // The service worker caches the shell from the second load on; a real phone is long past that.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".d-title")?.value === "Groceries");
  check(true, "a reload inside the editor reopens the same note");
  await ctx.setOffline(true);
  await page.fill(".d-body", "Eggs\nCoffee\nTyped with no connection");
  await page.waitForFunction(() => document.querySelector(".d-status")?.textContent.startsWith("Offline"), null, { timeout: 8000 });
  await shot(page, "note-offline-phone");
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("notes.draft.")).map((k) => JSON.parse(localStorage[k]).body));
  check(stored[0]?.includes("Typed with no connection"), "offline: the text is in localStorage");
  await page.reload();
  await page.waitForSelector(".d-editor", { timeout: 20000 });
  check((await page.inputValue(".d-body")).includes("Typed with no connection"), "reloading with no connection still opens the owner's draft");
  await ctx.setOffline(false);
  await page.waitForFunction(() => document.querySelector(".d-status")?.textContent === "Saved", null, { timeout: 40000 });
  const after = (await apiCall("GET", "/api/notes?q=connection")).body;
  check(after[0]?.preview?.includes("Typed with no connection"), "a reload while offline lost nothing, and it saved on return");
  check((await page.inputValue(".d-body")).includes("Typed with no connection"), "the editor still shows the owner's text");
  await page.goBack();
  await page.waitForSelector(".d-note");

  // A real conflict: the same note changes elsewhere while the owner is typing.
  const victim = (await apiCall("GET", "/api/notes")).body.find((n) => n.title === "Groceries");
  await page.click(".d-note:has-text('Groceries')");
  await page.waitForFunction(() => document.querySelector(".d-title")?.value === "Groceries");
  const row = (await apiCall("GET", `/api/notes/${victim.id}`)).body;
  check((await apiCall("PATCH", `/api/notes/${victim.id}`, { version: row.version, body: "Written on the computer" })).status === 200, "(another device edits)");
  await page.fill(".d-body", "Written on the phone");
  await page.waitForSelector(".d-conflict p", { timeout: 8000 });
  await shot(page, "note-conflict-phone");
  check((await page.textContent(".d-other-body")) === "Written on the computer", "conflict shows the other version");
  check((await page.inputValue(".d-body")) === "Written on the phone", "conflict leaves the owner's text in the editor");
  check(((await apiCall("GET", `/api/notes/${victim.id}`)).body.body) === "Written on the computer", "conflict: nothing overwritten yet");
  await page.click("text=Keep mine");
  await statusIs(page, "Saved");
  const now = (await apiCall("GET", `/api/notes/${victim.id}`)).body;
  check(now.body === "Written on the phone", "keep mine: the owner's text is the note");
  const copy = (await apiCall("GET", "/api/notes?q=computer")).body;
  check(copy[0]?.title === "Groceries (other version)", "keep mine: the other text became a new note");
  await page.goBack();
  await page.waitForSelector(".d-note");

  // Deleted elsewhere while the owner edits.
  const groc = (await apiCall("GET", `/api/notes/${victim.id}`)).body;
  await page.click(".d-note:has-text('Groceries'):not(:has-text('other version'))");
  await page.waitForFunction((v) => document.querySelector(".d-body")?.value === v, groc.body);
  await apiCall("DELETE", `/api/notes/${victim.id}`);
  await page.fill(".d-body", "Still typing here");
  await page.waitForSelector("text=Restore with my text", { timeout: 8000 });
  await shot(page, "note-deleted-elsewhere-phone");
  await page.click("text=Restore with my text");
  await statusIs(page, "Saved");
  check((await apiCall("GET", `/api/notes/${victim.id}`)).body.body === "Still typing here", "restore with my text works");
  await page.goBack();
  await page.waitForSelector(".d-note");

  // Recently deleted.
  await apiCall("DELETE", `/api/notes/${copy[0].id}`);
  await page.reload();
  await page.waitForSelector(".d-note");
  await page.click(".d-section summary");
  await page.waitForSelector(".d-trash");
  await shot(page, "notes-recently-deleted-phone");
  await page.click(".d-trash button");
  await page.waitForFunction(() => [...document.querySelectorAll(".d-note")].some((n) => n.textContent.includes("other version")));
  check(true, "recently deleted restores");

  // The WebSocket dropping must not close the editor.
  await page.click(".d-note:has-text('Roof quote')");
  await page.waitForFunction(() => document.querySelector(".d-title")?.value === "Roof quote");
  await page.focus(".d-body");
  await ctx.setOffline(true);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
  check((await page.$(".d-editor")) !== null, "editor stays open while the connection is down");
  await ctx.setOffline(false);
  check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
  await ctx.close();
}

// ---- Notes, desktop ---------------------------------------------------------------------------------------------------
{
  const { ctx, page, errors } = await session(browser, { width: 1440, height: 900 });
  await openTab(page, "notes");
  await page.waitForSelector(".d-note");
  await shot(page, "notes-list-desktop");
  await page.click(".d-note:has-text('Roof quote')");
  await page.waitForFunction(() => document.querySelector(".d-title")?.value === "Roof quote");
  await shot(page, "note-editor-desktop");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".d-editor"));
  check(true, "Escape closes the editor");
  check(errors.length === 0, `no page errors on desktop (${errors.join(" | ")})`);
  await ctx.close();
}

// ---- Tasks, phone ---------------------------------------------------------------------------------------------------
{
  const { ctx, page, errors } = await session(browser, { width: 390, height: 844 });
  await openTab(page, "tasks");
  await page.waitForSelector(".d-empty-title");
  await shot(page, "tasks-empty-phone");

  await page.fill(".d-capture input", "Call the roofer tomorrow");
  check((await page.textContent(".d-hint")).startsWith("Due Tomorrow"), "capture shows the date it understood");
  await shot(page, "tasks-capture-hint-phone");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".d-task:not(.unsaved)");
  check((await page.inputValue(".d-capture input")) === "", "Enter clears the box");
  check((await page.evaluate(() => document.activeElement?.tagName)) === "INPUT", "the box keeps focus for the next one");
  const made = (await apiCall("GET", "/api/tasks")).body[0];
  check(made.title === "Call the roofer" && made.due_on, "the date came off the title");
  for (const t of ["Pay the invoice today", "Buy coffee", "Renew passport Jan 5", "An overdue thing"]) {
    await page.fill(".d-capture input", t);
    await page.keyboard.press("Enter");
  }
  await page.waitForFunction(() => document.querySelectorAll(".d-task:not(.unsaved)").length === 5);
  const overdue = (await apiCall("GET", "/api/tasks")).body.find((t) => t.title === "An overdue thing");
  await apiCall("PATCH", `/api/tasks/${overdue.id}`, { version: overdue.version, due_on: "2020-01-02", notes: "Notes show on the row" });
  await page.reload();
  await page.waitForSelector(".d-task");
  await shot(page, "tasks-list-phone");
  check((await page.textContent(".d-task")).includes("An overdue thing"), "overdue comes first");
  check((await overflow(page)) === 0, "tasks: no sideways scroll");
  check((await smallFonts(page)).length === 0, "capture input is 16px");

  // Tap to complete, undo.
  await page.click(".d-task:has-text('Buy coffee') .d-check");
  await page.waitForSelector(".d-toast");
  await shot(page, "tasks-completed-toast-phone");
  await page.waitForFunction(() => document.querySelector(".d-section summary")?.textContent === "Completed (1)");
  check(true, "completing moves it to Completed");
  check((await page.$eval(".d-section", (d) => d.open)) === false, "Completed starts collapsed");
  await page.click(".d-toast button");
  await page.waitForFunction(() => document.querySelector(".d-section")?.hidden === true);
  check(true, "undo reopens it");

  // Swipe to complete.
  const r = await page.locator(".d-task:has-text('Buy coffee') .d-task-main").boundingBox();
  const swipe = async (dist) => {
    const y = r.y + r.height / 2;
    await page.evaluate(({ x, y, dist }) => {
      const t = document.elementFromPoint(x, y);
      const ev = (type, cx) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: "touch", clientX: cx, clientY: y, isPrimary: true }));
      t.setPointerCapture = () => {};
      ev("pointerdown", x);
      for (let i = 1; i <= 6; i++) ev("pointermove", x + (dist * i) / 6);
      ev("pointerup", x + dist);
    }, { x: r.x + 20, y, dist });
  };
  await swipe(30);
  await page.waitForTimeout(100);
  check((await page.$(".d-section:not([hidden])")) === null, "a short swipe does nothing");
  await swipe(140);
  await page.waitForFunction(() => document.querySelector(".d-section summary")?.textContent === "Completed (1)");
  check(true, "a long swipe completes");
  await page.click(".d-toast button");
  await page.waitForFunction(() => document.querySelector(".d-section")?.hidden === true);
  await page.click(".d-task:has-text('Buy coffee') .d-check");
  await page.waitForSelector(".d-section:not([hidden])");
  await page.click(".d-section summary");
  await shot(page, "tasks-completed-open-phone");

  // Details sheet.
  await page.click(".d-task:has-text('Call the roofer') .d-task-main");
  await page.waitForSelector(".d-sheet");
  await page.fill(".d-sheet-notes", "Ask about the flashing");
  await page.click(".d-sheet [aria-label='Pin']");
  await shot(page, "task-sheet-phone");
  check((await tooSmall(page, ".d-sheet button")).length === 0, "sheet buttons are 44px");
  check((await smallFonts(page)).length === 0, "sheet inputs are 16px");
  await page.click(".d-done");
  await page.waitForFunction(() => !document.querySelector(".d-sheet"));
  await page.waitForTimeout(200);
  const saved = (await apiCall("GET", "/api/tasks")).body.find((t) => t.title === "Call the roofer");
  check(saved.notes === "Ask about the flashing" && saved.pinned, "sheet saves notes and pin");
  check((await page.textContent(".d-task")).includes("Call the roofer"), "pinned goes to the top");

  // The phone's back button closes the sheet, and only the sheet.
  await page.click(".d-task:has-text('Call the roofer') .d-task-main");
  await page.waitForSelector(".d-sheet");
  await page.goBack();
  await page.waitForFunction(() => !document.querySelector(".d-sheet"));
  check(page.url().includes("#/tasks"), "back closes the sheet and stays on Tasks");

  // Conflict in the sheet.
  await page.click(".d-task:has-text('Call the roofer') .d-task-main");
  await page.waitForSelector(".d-sheet");
  await apiCall("PATCH", `/api/tasks/${saved.id}`, { version: saved.version, notes: "From the computer" });
  await page.fill(".d-sheet-notes", "From the phone");
  await page.click(".d-done");
  await page.waitForSelector(".d-conflict p");
  await shot(page, "task-conflict-phone");
  check((await page.textContent(".d-conflict .d-other-body")) === "From the computer", "task conflict shows the other version");
  await page.click("text=Keep mine");
  await page.waitForFunction(() => !document.querySelector(".d-sheet"));
  await page.waitForTimeout(200);
  check((await apiCall("GET", `/api/tasks/${saved.id}`)).body.notes === "From the phone", "keep mine saves");

  // Delete and undo.
  await page.click(".d-task:has-text('Renew passport') .d-task-main");
  await page.waitForSelector(".d-sheet");
  await page.click(".d-sheet [aria-label='Delete']");
  await page.waitForSelector(".d-toast");
  check(!(await page.textContent(".d-list")).includes("Renew passport"), "delete removes the row");
  await page.click(".d-toast button");
  await page.waitForFunction(() => document.querySelector(".d-list").textContent.includes("Renew passport"));
  check(true, "undo restores the task");

  // Offline capture.
  await ctx.setOffline(true);
  await page.fill(".d-capture input", "Captured with no connection");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".d-task.unsaved");
  await page.waitForSelector(".d-notice:not([hidden])");
  await shot(page, "tasks-offline-phone");
  const queued = await page.evaluate(() => localStorage["tasks.pending"]);
  check(queued.includes("Captured with no connection"), "offline capture is on the device");
  await ctx.setOffline(false);
  await page.waitForFunction(() => !document.querySelector(".d-task.unsaved"), null, { timeout: 90000 });
  const captured = (await apiCall("GET", "/api/tasks?q=captured")).body;
  check(captured.length === 1, "it reached the server exactly once");
  check((await page.evaluate(() => localStorage["tasks.pending"])) === undefined, "the queue is empty again");
  check(errors.length === 0, `no page errors on tasks (${errors.join(" | ")})`);
  await ctx.close();
}

// ---- Tasks, desktop --------------------------------------------------------------------------------------------------
{
  const { ctx, page, errors } = await session(browser, { width: 1440, height: 900 });
  await openTab(page, "tasks");
  await page.waitForSelector(".d-task");
  await shot(page, "tasks-list-desktop");
  await page.click(".d-task:has-text('Call the roofer') .d-task-main");
  await page.waitForSelector(".d-sheet");
  await shot(page, "task-sheet-desktop");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".d-sheet"));
  check(errors.length === 0, `no page errors on desktop tasks (${errors.join(" | ")})`);
  await ctx.close();
}

await wipe();
await browser.close();
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
