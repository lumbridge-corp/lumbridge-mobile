// Today: the first screen, and one calm list of what needs you. The date and three numbers, a box to catch a thought, then what's
// waiting on you: agents that are blocked, the assistant's asks and drafts (For you), a machine down, and the
// first few tasks. Each part is gone when it's empty, and with nothing to decide it says so in one sentence.
// Everything here is somebody else's screen, reused: rows and choices from the Agents tab, For you as it was on Tasks, the Thoughts
// queue, Tasks' and Notes' own ways to the server. So offline behaves as it does on those screens, and an answer works the same.
import "./today.css";
// For you's styles come with Today, not with its chunk: a retried chunk (below) is fetched by its URL, which brings no CSS.
import "./for-you.css";
import { getJson, store, token } from "../api";
import { folderOf, machineName, machineOf, onConn, onTerms, terms, app } from "../app";
import { statusWord } from "../core";
import { parseCapture, dueLabel } from "../data/dates";
import type { Task } from "../data/tasks-logic";
import { el } from "../dom";
import { icon as bigIcon } from "../icons";
import { layoutInbox, showFolder, summarize } from "../inbox";
import { DISMISSED_KEY, loadDismissed, type Infra, type Need } from "../infra-logic";
import {
  TARGETS, clearLine, criticalNeeds, dateLine, hud, needLine, parseTarget, taskSaid, todaysTasks, typingIn, type Target,
} from "../today-logic";
import { icon, request, toast, whenFresh } from "./data-ui";
import { holdToSpeak } from "./hold-to-speak";
import { captureNote } from "./notes-io";
import { unlockAudio, type MicError } from "./assistant-audio";
import { createRow, setHidden, setText, type Row } from "./rows";
import { captureTask, changeTask, pendingTasks } from "./tasks-io";
import { onThoughts, queue, Recording } from "./thoughts-recorder";
import { HAS_EXT, NS } from "../ns";

const TARGET_KEY = `${NS}.today.target`, DRAFT_KEY = `${NS}.today.draft`;
const INFRA_MS = 60_000, TASKS_MS = 60_000;
/** For you and Infra get this long to answer before "nothing needs you" is said without them. */
const SETTLE_MS = 2500;
const SAID_MS = 5000;

const pref = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const setPref = (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* only a convenience */ } };

function section(cls: string, title: string) {
  const root = el("section", `td-sec ${cls}`);
  root.hidden = true;
  const head = el("h2", "td-h");
  const label = el("span", "td-h-label", title);
  const count = el("span", "td-h-count");
  head.append(label, count);
  root.setAttribute("aria-label", title);
  root.append(head);
  return { root, head, count };
}

/** A line that goes to another screen, such as Infra. Words from the gateway go in as text. */
function lineLink(href: string, tone: "danger" | "warn", title: string, meta: string) {
  const a = el("a", "td-line");
  a.href = href;
  a.append(el("span", `td-dot ${tone}`));
  const body = el("span", "td-line-body");
  body.append(el("span", "td-line-title", title));
  if (meta) body.append(el("span", "td-line-meta", meta));
  a.append(body, bigIcon("chevron", "td-chev"));
  return a;
}

export function todayView(root: HTMLElement): () => void {
  let live = true;
  const page = el("div", "td");

  // ---- the head: the date, and three numbers ----
  const head = el("div", "td-head");
  const titles = el("div", "td-titles");
  titles.append(el("p", "td-kicker", "Today"));
  const date = el("h1", "td-date");
  titles.append(date);
  const hudBox = el("div", "td-hud");
  hudBox.setAttribute("role", "group");
  hudBox.setAttribute("aria-label", "Agents");
  const stats = [0, 1, 2].map(() => {
    const a = el("a", "td-stat");
    a.href = "#/agents";
    const num = el("span", "td-num");
    const label = el("span", "td-label");
    a.append(num, label);
    hudBox.append(a);
    return { a, num, label };
  });
  head.append(titles, hudBox);

  // ---- capture ----
  const capture = el("form", "td-capture");
  capture.setAttribute("aria-label", "Capture");
  const field = el("div", "td-field");
  const input = el("textarea", "td-input");
  input.rows = 1;
  input.enterKeyHint = "done";
  input.autocomplete = "off";
  input.maxLength = 10000;
  input.value = pref(DRAFT_KEY) ?? "";
  // Thought: tap to talk, as on Thoughts (the recording is kept on the device until its text is saved). Task and Note: hold to talk,
  // and the words land in the box to read first.
  const tapMic = el("button", "td-mic");
  tapMic.type = "button";
  tapMic.append(bigIcon("mic"));
  const holdMic = el("button", "td-mic");
  holdMic.type = "button";
  holdMic.setAttribute("aria-label", "Hold to talk");
  holdMic.append(bigIcon("mic"));
  const send = el("button", "td-send");
  send.type = "submit";
  send.append(bigIcon("send"));
  field.append(input, tapMic, holdMic, send);
  const under = el("div", "td-under");
  const targets = el("div", "td-targets");
  targets.setAttribute("role", "radiogroup");
  targets.setAttribute("aria-label", "Save as");
  const said = el("p", "td-said");
  said.setAttribute("role", "status");
  under.append(targets, said);
  capture.append(field, under);

  // ---- what needs the owner ----
  const cols = el("div", "td-cols");
  const decide = el("div", "td-col td-decide");
  const side = el("div", "td-col td-side");
  const needs = section("td-needs", "Needs you");
  const needList = el("div", "group needs td-rows");
  const needRows = el("div", "group-rows");
  needRows.setAttribute("role", "list");
  needList.append(needRows);
  needs.root.append(needList);
  const forYouSlot = el("div", "td-fy");
  const clear = el("p", "td-clear");
  clear.hidden = true;
  const machines = section("td-machines", "Machines");
  const machineList = el("div", "td-lines");
  machines.root.append(machineList);
  const tasks = section("td-tasks", "Tasks");
  const allTasks = el("a", "td-h-link", "All tasks");
  allTasks.href = "#/tasks";
  tasks.head.append(allTasks);
  const taskList = el("div", "td-task-list");
  tasks.root.append(taskList);
  decide.append(clear, needs.root, forYouSlot);
  side.append(machines.root, tasks.root);
  cols.append(decide, side);
  page.append(head, capture, cols);
  root.replaceChildren(page);

  // ---- the head ----
  let everOnline = app.conn === "online";
  const paintDate = () => setText(date, dateLine(new Date()));
  function paintHud() {
    const n = summarize(terms.values());
    hud(n, everOnline).forEach((s, i) => {
      const x = stats[i];
      setText(x.num, s.value);
      setText(x.label, s.label);
      x.a.className = `td-stat${s.tone ? ` ${s.tone}` : ""}${s.zero ? " zero" : ""}`;
      x.a.setAttribute("aria-label", `${s.value} ${s.label.toLowerCase()}`);
    });
  }

  // ---- capture ----
  let target: Target = parseTarget(pref(TARGET_KEY));
  const chips = TARGETS.map((t) => {
    const b = el("button", "chip td-target", t.label);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.dataset.target = t.id;
    b.onclick = () => { setTarget(t.id); input.focus({ preventScroll: true }); };
    targets.append(b);
    return b;
  });
  function setTarget(t: Target) {
    target = t;
    setPref(TARGET_KEY, t === "thought" ? "" : t);
    const spec = TARGETS.find((x) => x.id === t)!;
    for (const c of chips) {
      const on = c.dataset.target === t;
      c.classList.toggle("on", on);
      c.setAttribute("aria-checked", String(on));
      c.tabIndex = on ? 0 : -1;
    }
    input.placeholder = spec.placeholder;
    input.setAttribute("aria-label", spec.placeholder.replace("…", ""));
    send.setAttribute("aria-label", spec.label === "Task" ? "Add task" : `Save ${spec.label.toLowerCase()}`);
    paintMic();
  }
  targets.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = TARGETS.findIndex((x) => x.id === target);
    const next = TARGETS[(i + (e.key === "ArrowRight" ? 1 : TARGETS.length - 1)) % TARGETS.length].id;
    setTarget(next);
    chips.find((c) => c.dataset.target === next)?.focus();
    e.preventDefault();
  });

  let saidTimer = 0;
  function say(text: string, tone: "" | "bad" | "live" = "", stay = false) {
    clearTimeout(saidTimer);
    said.textContent = text;
    said.className = `td-said${tone ? ` ${tone}` : ""}`;
    if (!stay && text) saidTimer = window.setTimeout(() => { said.textContent = ""; }, SAID_MS);
  }

  const grow = () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; };
  const paintSend = () => { capture.classList.toggle("has-text", !!input.value.trim()); };
  input.addEventListener("input", () => { setPref(DRAFT_KEY, input.value); grow(); paintSend(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); capture.requestSubmit(); }
    else if (e.key === "Escape") input.blur();
  });

  /** Thoughts saved by the queue that this screen sent, so "Saved" is said only once it's true. */
  const sentThoughts = new Set<string>();
  const offThoughts = onThoughts({
    saved: (t) => { if (sentThoughts.delete(t.id)) say(TARGETS[0].done); },
    nothingSaid: () => { if (sentThoughts.size) say("Nothing was heard in that recording."); },
  });

  async function save(text: string) {
    if (target === "thought") {
      const id = crypto.randomUUID();
      sentThoughts.add(id);
      await queue.addTyped(id, text, new Date().toISOString());
      // The queue says when the server has it; until then it's on the device.
      say("Saving…", "", true);
      setTimeout(() => { if (live && sentThoughts.has(id)) say("Kept on this device. It goes to Thoughts when the connection is back."); }, 3000);
      return true;
    }
    if (target === "task") {
      const { title, due_on } = parseCapture(text);
      const res = await captureTask(title, due_on);
      if ("rejected" in res) { say("That task couldn't be saved. It's back in the box.", "bad"); return false; }
      if ("kept" in res) say("Kept on this device. Tasks sends it when the connection is back.");
      else say(taskSaid(due_on));
      void loadTasks(true);
      return true;
    }
    const s = await captureNote(text);
    if (s.status === "rejected") { say("That note couldn't be saved. It's back in the box.", "bad"); s.stop(); return false; }
    say(s.status === "saved" ? TARGETS[2].done : "Kept on this device. Notes saves it when the connection is back.");
    return true;
  }

  capture.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    input.value = "";
    setPref(DRAFT_KEY, "");
    grow();
    paintSend();
    void save(text).then((ok) => {
      if (ok || input.value) return;
      input.value = text;
      setPref(DRAFT_KEY, text);
      grow();
      paintSend();
    });
  });

  // Tap to talk, for a thought: a Recording, exactly as Thoughts makes one.
  let rec: Recording | null = null;
  function paintMic(state: "idle" | "starting" | "on" = rec ? "on" : "idle") {
    const thought = target === "thought";
    setHidden(tapMic, !thought);
    setHidden(holdMic, thought);
    tapMic.classList.toggle("on", state !== "idle");
    tapMic.setAttribute("aria-pressed", String(state !== "idle"));
    tapMic.setAttribute("aria-label", state === "idle" ? "Tap to talk" : "Stop talking");
    capture.classList.toggle("recording", state !== "idle");
  }
  const clock = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  async function startRecording() {
    const ctx = unlockAudio(); // first, and synchronously: this is the gesture iOS needs
    navigator.vibrate?.(8);
    let began = false;
    paintMic("starting");
    say("Getting the mic", "live", true);
    let shown = -1;
    const r: Recording = new Recording(ctx, {
      frame: (_level, ms) => {
        if (rec !== r) return;
        if (!began) { began = true; paintMic("on"); }
        const sec = Math.floor(ms / 1000);
        if (sec !== shown) { shown = sec; say(`Listening ${clock(ms)}. Tap to stop.`, "live", true); }
      },
      ended: (why) => {
        if (rec !== r) return;
        rec = null;
        paintMic("idle");
        if (why === "mic_silent") say("The mic isn't sending any sound. Tap to try again.", "bad");
        else if (why === "too_short") say("Tap to talk, then tap again to stop.");
        else { sentThoughts.add(r.id); say("Saved. Thoughts has it once it's written out."); }
      },
    });
    rec = r;
    try {
      await r.start();
    } catch (failure) {
      if (rec !== r) return;
      rec = null;
      paintMic("idle");
      const kind = failure as MicError;
      say(kind === "insecure" ? "The mic needs a secure page" : kind === "missing" ? "No microphone found" : "The mic isn't allowed", "bad");
    }
  }
  tapMic.addEventListener("click", () => { if (rec) rec.stop(); else void startRecording(); });
  const stopHold = holdToSpeak(holdMic, {
    text: (words) => {
      input.value = input.value.trim() ? `${input.value.trimEnd()} ${words}` : words;
      setPref(DRAFT_KEY, input.value);
      grow();
      paintSend();
      say("Read it, then save.");
    },
    say: (m) => say(m),
  });

  // "/" from anywhere on a computer, unless the owner is typing somewhere already.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || page.offsetParent === null || typingIn(document.activeElement as HTMLElement | null)) return;
    e.preventDefault();
    input.focus();
  };
  document.addEventListener("keydown", onKey);

  // ---- Needs you: blocked and errored agents, as the Agents tab's own rows ----
  const rows = new Map<string, Row>();
  let order = "";
  let touching = false;
  needRows.addEventListener("pointerdown", () => { touching = true; });
  const untouch = () => { if (!touching) return; touching = false; setTimeout(paintNeeds, 300); };
  needRows.addEventListener("pointerup", untouch);
  needRows.addEventListener("pointercancel", untouch);
  function makeRow(address: string): Row {
    return createRow(address, {
      asks: true,
      cls: (t) => `row needs${statusWord(t) === "error" ? " error" : ""}`,
      meta: (t) => [machineName(machineOf(t)), showFolder(folderOf(t))].filter(Boolean).join(" · "),
      where: (t) => [machineName(machineOf(t)), folderOf(t)].filter(Boolean).join(", "),
      current: () => false,
      grew: () => paintNeeds(),
    });
  }
  function paintNeeds() {
    if (!live) return;
    const group = layoutInbox(terms.values(), { machine: null, byMachine: false }).find((g) => g.key === "needs");
    const list = group?.rows ?? [];
    const now = Date.now();
    for (const [a, r] of rows) if (!list.some((t) => t.address === a) && !touching) { r.root.remove(); rows.delete(a); }
    for (const t of list) {
      let r = rows.get(t.address);
      if (!r) { r = makeRow(t.address); rows.set(t.address, r); }
      r.patch(t, now);
    }
    // A row doesn't move under a finger. When it lifts, the order catches up.
    const next = list.map((t) => t.address).join(",");
    if (next !== order && !touching) { order = next; needRows.replaceChildren(...list.map((t) => rows.get(t.address)!.root)); }
    setText(needs.count, list.length ? String(list.length) : "");
    setHidden(needs.root, rows.size === 0);
    paintHud();
    paintClear();
  }

  // ---- For you: its own chunk, as it was on Tasks ----
  // The worker precaches it (public/sw.js, CHUNKS), so an offline start still finds it. If it can't be fetched (offline before it was
  // ever cached, or the fetch failed), it's tried again when the connection comes back.
  let forYou: { root: HTMLElement; stop: () => void } | null = null;
  let forYouAny = false, forYouKnown = false;
  let mounting = false;
  let tries = 0;
  // A browser remembers a dynamic import that failed and refuses the same one again until the page reloads, so a retry asks for the
  // built chunk by its own URL (index.html names it, web/vite.config.ts) with a query that makes it new.
  const fetchForYou = (): Promise<typeof import("./for-you")> => {
    const url = document.querySelector<HTMLMetaElement>('meta[name="lumbridge-for-you"]')?.content;
    return tries++ === 0 || !url ? import("./for-you") : import(/* @vite-ignore */ `${url}?retry=${tries}`);
  };
  const mountForYou = () => {
    if (!live || forYou || mounting) return;
    mounting = true;
    fetchForYou().then((m) => {
      if (!live || forYou) return;
      forYou = m.forYouSection({
        shown: (any) => { forYouAny = any; paintClear(); },
        loaded: () => { forYouKnown = true; paintClear(); },
      });
      forYouSlot.replaceChildren(forYou.root);
    }).catch(() => { forYouKnown = true; paintClear(); }).finally(() => { mounting = false; });
  };
  mountForYou();
  window.addEventListener("online", mountForYou);

  // ---- Machines: only what's critical ----
  let crit: Need[] = [];
  // Machines come from an instance's own screens (src/ext/); without them there is nothing to ask.
  let infraKnown = !HAS_EXT;
  let serverSkew = 0;
  function paintMachines() {
    const now = Date.now();
    const lines: HTMLElement[] = crit.map((n) => { const l = needLine(n, now + serverSkew); return lineLink("#/infra", "danger", l.title, l.meta); });
    machineList.replaceChildren(...lines);
    setText(machines.count, lines.length ? String(lines.length) : "");
    setHidden(machines.root, lines.length === 0);
    paintClear();
  }
  let infraBusy = false;
  async function loadInfra() {
    if (!HAS_EXT) return;
    if (!token() || infraBusy || document.visibilityState !== "visible") return;
    infraBusy = true;
    try {
      const d = await getJson<Infra>("/api/infra");
      if (!live) return;
      serverSkew = d.at_ms ? d.at_ms - Date.now() : 0;
      crit = criticalNeeds(d.needs ?? [], loadDismissed(store(DISMISSED_KEY)));
    } catch { /* no Prometheus, or none yet: no line, and Infra itself says why */ }
    finally { infraBusy = false; infraKnown = true; if (live) paintMachines(); }
  }

  // ---- Tasks: the first few open ones, tickable ----
  let taskData: Task[] = [];
  let tasksLoaded = false;
  const leaving = new Set<string>();
  function paintTasks() {
    const { shown, open } = todaysTasks(taskData, pendingTasks());
    taskList.replaceChildren(...shown.map(taskRow));
    setText(tasks.count, open ? String(open) : "");
    setHidden(tasks.root, !tasksLoaded || shown.length === 0);
  }
  function taskRow(t: Task): HTMLElement {
    const unsaved = t.version === 0;
    const done = leaving.has(t.id);
    const r = el("div", `td-task${done ? " done" : ""}${unsaved ? " unsaved" : ""}`);
    r.dataset.id = t.id;
    const check = el("button", "d-check");
    check.type = "button";
    check.setAttribute("role", "checkbox");
    check.setAttribute("aria-checked", String(done));
    check.setAttribute("aria-label", `Complete ${t.title}`);
    const ring = el("span", "d-ring");
    if (done) ring.append(icon("check"));
    check.append(ring);
    check.disabled = unsaved || done;
    check.onclick = () => void complete(t);
    const main = el("a", "td-task-main");
    main.href = "#/tasks";
    main.append(el("span", "td-task-title", t.title));
    if (t.due_on) { const d = dueLabel(t.due_on); main.append(el("span", `td-due ${d.kind}`, d.text)); }
    else if (unsaved) main.append(el("span", "td-due", "Not saved yet"));
    r.append(check, main);
    return r;
  }
  async function complete(t: Task) {
    leaving.add(t.id);
    paintTasks();
    navigator.vibrate?.(8);
    const after = await changeTask(t, { done: true });
    if (!live) return;
    if (!after) {
      leaving.delete(t.id);
      paintTasks();
      toast("You're offline or the server is down, so that wasn't completed.");
      return;
    }
    // A moment ticked, then it goes, the way a done task leaves Tasks.
    setTimeout(() => {
      if (!live) return;
      leaving.delete(t.id);
      taskData = taskData.map((x) => (x.id === after.id ? after : x));
      paintTasks();
    }, 600);
    toast(`Completed: ${after.title}`, {
      label: "Undo",
      run: () => void changeTask(after, { done: false }).then((back) => {
        if (!back || !live) { if (!back) toast("Couldn't undo that."); return; }
        taskData = taskData.map((x) => (x.id === back.id ? back : x));
        paintTasks();
      }),
    });
  }
  let taskSeq = 0;
  let tasksAsking = false;
  async function loadTasks(force = false) {
    if (!token() || (tasksAsking && !force)) return;
    const mine = ++taskSeq;
    tasksAsking = true;
    const res = await request<Task[]>("/api/tasks").finally(() => { if (mine === taskSeq) tasksAsking = false; });
    if (!live || mine !== taskSeq) return;
    if (res.ok) { taskData = res.ok; tasksLoaded = true; }
    // Offline before the first answer: what's kept on this device still shows.
    else if (pendingTasks().length) tasksLoaded = true;
    paintTasks();
  }

  // ---- "Nothing needs you" ----
  const started = Date.now();
  const settleTimer = window.setTimeout(() => paintClear(), SETTLE_MS);
  function paintClear() {
    if (!live) return;
    // Said only once the parts have answered (or had their chance), so it isn't followed a moment later by something needing the owner.
    const settled = everOnline && ((forYouKnown && infraKnown) || Date.now() - started >= SETTLE_MS);
    const empty = rows.size === 0 && !forYouAny && machines.root.hidden;
    const show = settled && empty;
    if (show) setText(clear, clearLine(summarize(terms.values()), everOnline));
    setHidden(clear, !show);
    page.classList.toggle("is-clear", show);
  }

  // ---- wiring ----
  const offTerms = onTerms(() => paintNeeds());
  const offConn = onConn((c) => {
    if (c !== "online") return;
    everOnline = true;
    paintNeeds();
    mountForYou();
    if (!tasksLoaded) void loadTasks();
    if (!infraKnown) void loadInfra();
  });
  const stopInfra = whenFresh(() => void loadInfra(), INFRA_MS);
  const stopTasks = whenFresh(() => { void loadTasks(); paintDate(); }, TASKS_MS);
  setTarget(target);
  paintDate();
  grow();
  paintSend();
  paintNeeds();
  paintMachines();
  paintTasks();
  void loadInfra();
  void loadTasks();

  return () => {
    live = false;
    clearTimeout(saidTimer);
    clearTimeout(settleTimer);
    offTerms();
    offConn();
    offThoughts();
    stopInfra();
    stopTasks();
    stopHold();
    // A recording carries on into Thoughts' queue, as it would if the owner left the Thoughts screen: stop it here so nothing records unseen.
    rec?.stop();
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("online", mountForYou);
    forYou?.stop();
  };
}
