// Tasks: a capture box, the open list, and Completed tucked away. For you (what the assistant needs from you) is on Today. Captures are kept on the device until the server has
// them, each with an id chosen here, so a dead connection can neither lose one nor make two.
import "./data.css";
import { dueLabel, localDate, parseCapture } from "../data/dates";
import { afterLoad, notLoadedText, type FirstLoad } from "../data/first-load";
import { changedFields, rebase, reconcile, splitTasks, withPending, type Pending, type Task, type TaskFields } from "../data/tasks-logic";
import { onConn } from "../app";
import { onNeeds } from "../drafts-store";
import { el } from "../dom";
import { dismissToast, icon, iconButton, jsonInit, request, toast, watchKeyboard, whenFresh } from "./data-ui";
import { changeTask, pendingTasks, savePendingTasks } from "./tasks-io";
import { ASSISTANT_NAME, NS } from "../ns";

const EDIT_KEY = `${NS}.tasks.edit.`;
const SWIPE_DONE = 90;

function read(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function write(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* memory only this time */ } }
function forget(k: string) { try { localStorage.removeItem(k); } catch { /* nothing to lose */ } }

export function tasksView(root: HTMLElement) {
  const view = el("div", "d-view");
  const head = el("header", "d-head");
  const h1 = el("h1", "", "Tasks");
  const count = el("span", "d-count");
  head.append(h1, count);

  const form = el("form", "d-capture");
  const input = el("input");
  input.placeholder = "Add a task";
  input.setAttribute("aria-label", "Add a task");
  input.enterKeyHint = "done";
  input.autocomplete = "off";
  input.maxLength = 1000;
  const send = iconButton("plus", "Add task", () => {});
  send.type = "submit";
  form.append(input, send);
  const hint = el("button", "d-hint");
  hint.type = "button";
  hint.hidden = true;

  const notice = el("div", "d-notice");
  notice.hidden = true;
  const openList = el("div", "d-list");
  const doneBox = el("details", "d-section");
  const doneSummary = el("summary");
  const doneList = el("div", "d-list");
  doneBox.append(doneSummary, doneList);
  doneBox.hidden = true;
  // For you lives on Today now. One quiet line points there, with no poller of its own: the drafts count is the one the badge uses.
  const forYou = el("a", "d-foryou");
  forYou.href = "#/today";
  forYou.hidden = true;
  const offNeeds = onNeeds((n) => {
    const k = n.drafts.length;
    forYou.hidden = k === 0;
    forYou.textContent = k === 1 ? `1 draft from ${ASSISTANT_NAME} is waiting on Today` : `${k} drafts from ${ASSISTANT_NAME} are waiting on Today`;
  });
  view.append(head, forYou, form, hint, notice, openList, doneBox);
  root.replaceChildren(view);

  let tasks: Task[] = [];
  let state: FirstLoad = "loading";
  let seq = 0;
  let ignoreDate = false;
  let swiping = false;
  let sheetClose: (() => void) | null = null;
  const stopKeyboard = watchKeyboard();

  const pending = pendingTasks;
  const savePending = savePendingTasks;

  function captured(): { title: string; due_on: string | null } {
    const text = input.value;
    return ignoreDate ? { title: text.trim(), due_on: null } : parseCapture(text);
  }

  function paintHint() {
    const c = captured();
    const parsed = parseCapture(input.value);
    if (!parsed.due_on) { hint.hidden = true; ignoreDate = false; return; }
    hint.hidden = false;
    hint.textContent = c.due_on ? `Due ${dueLabel(c.due_on).text}. Tap to keep the words instead.` : `Keeping the words. Tap to set due ${dueLabel(parsed.due_on).text}.`;
  }

  function render() {
    const all = withPending(tasks.filter((t) => !t.deleted_at), pending());
    const { open, done } = splitTasks(all);
    // Until a GET has worked, only the captures kept on this device are known: no count, and never "Nothing to do yet".
    count.textContent = open.length && state === "loaded" ? `${open.length} open` : "";
    const rows: HTMLElement[] = open.map(taskRow);
    if (!rows.length && state === "loaded") {
      const empty = el("div", "d-empty");
      if (done.length) empty.append(el("p", "d-empty-title", "All done"));
      else empty.append(el("p", "d-empty-title", "Nothing to do yet"), el("p", "", 'Type above and press Enter. Ending with "tomorrow" or "Friday" sets the date.'));
      rows.push(empty);
    }
    if (state === "loading" && !rows.length) rows.push(el("div", "d-empty", "Loading"));
    openList.replaceChildren(...rows);
    doneBox.hidden = !done.length;
    doneSummary.textContent = `Completed (${done.length})`;
    doneList.replaceChildren(...done.map(taskRow));
  }

  function taskRow(t: Task): HTMLElement {
    const unsaved = t.version === 0;
    const r = el("div", `d-task${t.done_at ? " done" : ""}${unsaved ? " unsaved" : ""}`);
    r.dataset.id = t.id;
    const reveal = el("div", "d-swipe-bg");
    reveal.append(icon("check"));
    const front = el("div", "d-task-front");
    const check = el("button", "d-check");
    check.type = "button";
    check.setAttribute("role", "checkbox");
    check.setAttribute("aria-checked", String(Boolean(t.done_at)));
    check.setAttribute("aria-label", t.done_at ? `Reopen ${t.title}` : `Complete ${t.title}`);
    const ring = el("span", "d-ring");
    if (t.done_at) ring.append(icon("check"));
    check.append(ring);
    check.disabled = unsaved;
    check.addEventListener("click", () => void setDone(t, !t.done_at));

    const main = el("button", "d-task-main");
    main.type = "button";
    main.append(el("span", "d-task-title", t.title));
    const meta = el("span", "d-task-meta");
    if (t.pinned) { const p = el("span", "d-pin"); p.append(icon("pin")); meta.append(p); }
    if (t.due_on && !t.done_at) {
      const d = dueLabel(t.due_on);
      meta.append(el("span", `d-due ${d.kind}`, d.text));
    }
    if (t.notes.trim()) meta.append(el("span", "d-has-notes", t.notes.trim().split("\n")[0]));
    if (unsaved) meta.append(el("span", "d-flag quiet", "Not saved yet"));
    if (meta.childNodes.length) main.append(meta);
    main.addEventListener("click", () => { if (!unsaved && !didSwipe) openSheet(t.id); });
    front.append(check, main);
    r.append(reveal, front);
    if (!t.done_at && !unsaved) addSwipe(r, front, () => void setDone(t, true));
    return r;
  }

  // A swipe that moved must not also count as a tap on the row.
  let didSwipe = false;
  function addSwipe(row: HTMLElement, front: HTMLElement, complete: () => void) {
    let startX = 0, startY = 0, dx = 0, active = false, locked = false;
    front.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      startX = e.clientX; startY = e.clientY; dx = 0; active = true; locked = false; didSwipe = false;
    });
    front.addEventListener("pointermove", (e) => {
      if (!active) return;
      dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!locked) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { active = false; return; }
        if (dx < 10) return;
        locked = true;
        swiping = true;
        didSwipe = true;
        try { front.setPointerCapture(e.pointerId); } catch { /* the pointer already ended */ }
        row.classList.add("swiping");
      }
      const x = Math.max(0, dx);
      front.style.transform = `translateX(${x}px)`;
      row.classList.toggle("armed", x >= SWIPE_DONE);
    });
    const end = () => {
      if (!active) return;
      active = false;
      swiping = false;
      row.classList.remove("swiping", "armed");
      front.style.transform = "";
      if (locked && dx >= SWIPE_DONE) complete();
      // The click that follows pointerup still needs to see didSwipe.
      setTimeout(() => { didSwipe = false; }, 0);
    };
    front.addEventListener("pointerup", end);
    front.addEventListener("pointercancel", () => { dx = 0; end(); });
  }

  function replace(t: Task) {
    const i = tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) tasks[i] = t; else tasks.push(t);
  }

  /** A small change (done, pin). If it lost a race, it goes again on the newer version: these don't touch the owner's text. */
  async function change(t: Task, patch: Record<string, unknown>): Promise<Task | null> {
    const after = await changeTask(t, patch, replace);
    if (after) replace(after);
    return after;
  }

  async function setDone(t: Task, done: boolean) {
    const previous = { ...t };
    // Right away on screen; undone if the server says no.
    replace({ ...t, done_at: done ? new Date().toISOString() : null });
    render();
    const after = await change(t, { done });
    if (!after) {
      replace(previous);
      render();
      toast(`You're offline or the server is down, so that wasn't ${done ? "completed" : "reopened"}.`);
      return;
    }
    render();
    if (done) {
      toast(`Completed: ${after.title}`, {
        label: "Undo",
        run: () => {
          const now = tasks.find((x) => x.id === after.id) ?? after;
          void setDone(now, false);
        },
      });
    }
  }

  async function capture() {
    const { title, due_on } = captured();
    if (!title) return;
    const p: Pending = { id: crypto.randomUUID(), title, due_on, sort_key: Date.now() };
    savePending([...pending(), p]);
    input.value = "";
    ignoreDate = false;
    paintHint();
    render();
    await sendPending();
  }

  let sending = false;
  async function sendPending() {
    if (sending) return;
    sending = true;
    try {
      // Re-read each time round: the owner can capture another while this one is on its way.
      for (let p = pending()[0]; p; p = pending()[0]) {
        const res = await request<Task>("/api/tasks", jsonInit("POST", p));
        if (res.ok) {
          replace(res.ok);
          savePending(pending().filter((x) => x.id !== p.id));
          render();
        } else if (res.fail === "rejected") {
          // The server will never take it. Put the words back so the owner can fix them.
          savePending(pending().filter((x) => x.id !== p.id));
          if (!input.value) input.value = p.title;
          toast("That task couldn't be saved. It's back in the box.");
          render();
        } else {
          showNotice(failText(res.fail));
          return;
        }
      }
    } finally {
      sending = false;
    }
  }

  const failText = (fail: string | null) => notLoadedText(state) ?? (fail === "offline" ? "You're offline. New tasks are kept on this device." : "Your tasks database isn't reachable right now. New tasks are kept on this device.");

  function showNotice(text: string | null) {
    notice.hidden = !text;
    notice.replaceChildren();
    if (!text) return;
    notice.append(el("span", "", text));
    const b = el("button", "", "Try again");
    b.type = "button";
    b.addEventListener("click", () => void load());
    notice.append(b);
  }

  async function load() {
    const mine = ++seq;
    const res = await request<Task[]>("/api/tasks");
    if (mine !== seq) return;
    state = afterLoad(state, !!res.ok, navigator.onLine !== false);
    if (!res.ok) {
      showNotice(failText(res.fail));
      render();
      return;
    }
    showNotice(null);
    tasks = res.ok;
    // Don't pull a row out from under the owner's thumb; the next refresh will catch up.
    if (!swiping) render();
    void sendPending();
  }

  // --- Detail sheet -------------------------------------------------------------------------------------------------

  function openSheet(id: string) {
    if (sheetClose) return;
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    dismissToast();
    let base = t;
    const stored = read(EDIT_KEY + id);
    let draft: TaskFields = { title: t.title, notes: t.notes, due_on: t.due_on, pinned: t.pinned };
    if (stored) { try { draft = { ...draft, ...JSON.parse(stored) }; } catch { /* use the server's */ } }

    const scrim = el("div", "d-scrim");
    const sheet = el("div", "d-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "Task details");
    const bar = el("header", "d-bar");
    const status = el("span", "d-status");
    const pin = iconButton("pin", "Pin", () => { draft.pinned = !draft.pinned; keep(); paint(); });
    const del = iconButton("trash", "Delete", () => void remove());
    const doneBtn = el("button", "d-done", "Done");
    doneBtn.type = "button";
    doneBtn.addEventListener("click", () => void finish());
    bar.append(status, pin, del, doneBtn);
    const banner = el("div", "d-conflict");
    banner.hidden = true;
    const title = el("textarea", "d-sheet-title");
    title.rows = 1;
    title.setAttribute("aria-label", "Task");
    title.value = draft.title;
    const notes = el("textarea", "d-sheet-notes");
    notes.placeholder = "Notes";
    notes.setAttribute("aria-label", "Notes");
    notes.value = draft.notes;
    const dueRow = el("div", "d-due-row");
    const dueInput = el("input", "d-date");
    dueInput.type = "date";
    dueInput.setAttribute("aria-label", "Due date");
    dueInput.value = draft.due_on ?? "";
    const quick = (label: string, offset: number | null) => {
      const b = el("button", "d-chip", label);
      b.type = "button";
      b.addEventListener("click", () => {
        const now = new Date();
        draft.due_on = offset === null ? null : localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
        dueInput.value = draft.due_on ?? "";
        keep();
      });
      return b;
    };
    dueRow.append(dueInput, quick("Today", 0), quick("Tomorrow", 1), quick("No date", null));
    sheet.append(bar, banner, title, notes, dueRow);
    scrim.append(sheet);
    document.body.append(scrim);

    // Only what the owner changed, so what the owner didn't touch follows the server when this is opened again.
    const keep = () => write(EDIT_KEY + id, JSON.stringify(changedFields(base, draft)));
    const changed = () => Object.keys(changedFields(base, draft)).length > 0;
    const show = () => {
      if (title.value !== draft.title) title.value = draft.title;
      if (notes.value !== draft.notes) notes.value = draft.notes;
      dueInput.value = draft.due_on ?? "";
      paint();
    };
    /** Their newer row becomes the base, with the owner's changes on top. */
    const rebaseOn = (theirs: Task) => { draft = rebase(base, draft, theirs); base = theirs; keep(); show(); };
    const paint = () => { pin.classList.toggle("on", draft.pinned); pin.setAttribute("aria-pressed", String(draft.pinned)); };
    const grow = () => { title.style.height = "auto"; title.style.height = `${title.scrollHeight}px`; };
    title.addEventListener("input", () => { draft.title = title.value.replace(/\n/g, " "); keep(); grow(); });
    title.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); notes.focus(); } });
    notes.addEventListener("input", () => { draft.notes = notes.value; keep(); });
    dueInput.addEventListener("change", () => { draft.due_on = dueInput.value || null; keep(); });
    scrim.addEventListener("click", (e) => { if (e.target === scrim) void finish(); });
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); void finish(); } };
    document.addEventListener("keydown", onKey);

    const close = () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("keydown", onKey);
      scrim.remove();
      sheetClose = null;
      render();
    };
    const onPop = () => void finish(true);
    history.pushState({ task: id }, "", location.href);
    window.addEventListener("popstate", onPop);
    sheetClose = close;
    const leave = (fromHistory: boolean) => {
      close();
      if (!fromHistory && history.state?.task) history.back();
    };

    async function finish(fromHistory = false) {
      if (!draft.title.trim()) {
        // A task can't be blank; put back what it was instead of arguing.
        draft.title = base.title;
        title.value = base.title;
      }
      if (!changed()) { forget(EDIT_KEY + id); leave(fromHistory); return; }
      status.textContent = "Saving";
      const saved = await save();
      if (saved === "done") { forget(EDIT_KEY + id); leave(fromHistory); return; }
      if (saved === "offline") {
        status.textContent = "Offline. Kept on this device; it'll save next time you open it.";
        status.className = "d-status offline";
        // Back on the row with the draft kept, so nothing's lost.
        if (fromHistory) leave(true);
        else setTimeout(() => leave(false), 1200);
      }
    }

    async function save(tries = 3): Promise<"done" | "offline" | "held"> {
      const changes = changedFields(base, draft);
      if (!Object.keys(changes).length) return "done";
      const res = await request<Task>(`/api/tasks/${id}`, jsonInit("PATCH", { version: base.version, ...changes }));
      if (res.ok) { replace(res.ok); base = res.ok; return "done"; }
      if (res.fail === "conflict" && res.current) {
        const verdict = reconcile(base, draft, res.current);
        replace(res.current);
        if (verdict === "take" || verdict === "retry") {
          rebaseOn(res.current);
          return tries > 0 ? save(tries - 1) : "offline";
        }
        showConflict(res.current, verdict === "deleted");
        return "held";
      }
      if (res.fail === "gone") { toast("That task is gone."); forget(EDIT_KEY + id); return "done"; }
      if (res.fail === "rejected") { status.textContent = "Couldn't save this as it is."; return "held"; }
      return "offline";
    }

    function showConflict(theirs: Task, deleted: boolean) {
      status.textContent = deleted ? "Deleted on another device" : "Changed on another device";
      status.className = "d-status conflict";
      banner.hidden = false;
      banner.replaceChildren();
      const row = el("div", "d-conflict-actions");
      const button = (label: string, primary: boolean, run: () => void) => {
        const b = el("button", primary ? "primary" : "", label);
        b.type = "button";
        b.addEventListener("click", run);
        return b;
      };
      if (deleted) {
        banner.append(el("p", "", "This task was deleted on another device. Your edits are still here."));
        row.append(button("Restore with my edits", true, async () => {
          const back = await request<Task>(`/api/tasks/${id}/restore`, { method: "POST" });
          if (!back.ok) { toast("Couldn't restore it. Try again in a moment."); return; }
          replace(back.ok);
          rebaseOn(back.ok);
          banner.hidden = true;
          void finish();
        }), button("Discard my edits", false, () => { forget(EDIT_KEY + id); leave(false); }));
        banner.append(row);
        return;
      }
      banner.append(el("p", "", "This task also changed on another device. Choose which to keep; the other version is shown below."));
      row.append(button("Keep mine", true, () => { rebaseOn(theirs); banner.hidden = true; void finish(); }), button("Keep the other", false, () => {
        base = theirs;
        draft = { title: theirs.title, notes: theirs.notes, due_on: theirs.due_on, pinned: theirs.pinned };
        keep();
        show();
        banner.hidden = true;
        void finish();
      }));
      banner.append(row);
      banner.append(el("p", "d-other-title", theirs.title));
      if (theirs.notes) banner.append(el("pre", "d-other-body", theirs.notes));
    }

    async function remove() {
      const res = await request<Task>(`/api/tasks/${id}`, { method: "DELETE" });
      if (!res.ok && res.fail !== "gone") { toast("Couldn't delete this. Try again in a moment."); return; }
      forget(EDIT_KEY + id);
      tasks = tasks.filter((x) => x.id !== id);
      leave(false);
      toast("Task deleted", {
        label: "Undo",
        run: async () => {
          const back = await request<Task>(`/api/tasks/${id}/restore`, { method: "POST" });
          if (!back.ok) { toast("Couldn't undo that."); return; }
          replace(back.ok);
          render();
        },
      });
    }

    paint();
    grow();
  }

  // --- Wiring -------------------------------------------------------------------------------------------------------

  form.addEventListener("submit", (e) => { e.preventDefault(); void capture(); input.focus(); });
  input.addEventListener("input", paintHint);
  hint.addEventListener("click", () => { ignoreDate = !ignoreDate; paintHint(); input.focus(); });

  const stopFresh = whenFresh(() => void load());
  // Back online after a first load that failed: the list and the count come by themselves.
  const offConn = onConn((c) => {
    if (c !== "online") return;
    if (state !== "loaded") void load();
  });
  render();
  void load();

  return () => {
    offNeeds();
    stopFresh();
    offConn();
    stopKeyboard();
    sheetClose?.();
  };
}
