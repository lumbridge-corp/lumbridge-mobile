// Thoughts: the fast, raw way in. One button to talk, a box to type, and everything said so far, newest first. Notes is where it gets
// organised. Audio and typed text are on the device until the server has the text (thoughts-recorder.ts); this screen only shows it.
import "./data.css";
import "./thoughts.css";
import { clock, groupByDay } from "../data/thoughts-logic";
import type { PendingView } from "../data/thoughts-queue";
import { el } from "../dom";
import { icon as bigIcon } from "../icons";
import { dismissToast, icon, iconButton, jsonInit, request, toast, watchKeyboard, whenFresh } from "./data-ui";
import { unlockAudio, type MicError } from "./assistant-audio";
import { durable, onThoughts, queue, Recording, type RecordingEnd, type Thought } from "./thoughts-recorder";
import { NS } from "../ns";

interface Summary { id: string; preview: string; source: "voice" | "typed"; duration_ms: number | null; note_id: string | null; created_at: string; updated_at: string; deleted_at: string | null; version: number }

const PAGE = 100;
const DRAFT_KEY = `${NS}.thoughts.draft`;
const ARM_MS = 4000;
const IDLE_TEXT = "Tap to talk";

const readDraft = () => { try { return localStorage.getItem(DRAFT_KEY) ?? ""; } catch { return ""; } };
const writeDraft = (v: string) => { try { if (v) localStorage.setItem(DRAFT_KEY, v); else localStorage.removeItem(DRAFT_KEY); } catch { /* it's still in the box */ } };

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const summaryOf = (t: Thought): Summary => ({ ...t, preview: t.body.slice(0, 600) });

const STATE_TEXT: Record<PendingView["state"], string> = {
  recording: "Recording", working: "Transcribing", waiting_speech: "Waiting to transcribe", waiting_save: "Waiting to save", failed: "Couldn't finish this",
};

const END_TEXT: Record<Exclude<RecordingEnd, null>, string> = {
  mic_silent: "The mic isn't sending any sound. Tap to try again.",
  mic_lost: "The mic stopped. What you said is saved.",
  too_short: IDLE_TEXT,
};

/** Goes to a note in Notes' own editor, which opens from history state. Back comes back here. */
function openNote(id: string) {
  history.pushState({ note: id }, "", "#/notes");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function thoughtsView(root: HTMLElement) {
  const view = el("div", "d-view");
  const head = el("header", "d-head");
  head.append(el("h1", "", "Thoughts"));

  const hero = el("div", "th-hero");
  const mic = el("button", "th-mic");
  mic.type = "button";
  mic.setAttribute("aria-label", "Start talking");
  mic.setAttribute("aria-pressed", "false");
  const ring = el("span", "th-ring");
  mic.append(ring, bigIcon("mic"), el("span", "th-stop"));
  const status = el("div", "th-status");
  status.setAttribute("role", "status");
  const statusText = el("span", "", IDLE_TEXT);
  const elapsed = el("span", "th-clock");
  elapsed.hidden = true;
  status.append(statusText, elapsed);
  const meter = el("div", "th-meter");
  meter.setAttribute("aria-hidden", "true");
  const fill = el("i");
  meter.append(fill);
  meter.hidden = true;
  hero.append(mic, status, meter);

  const live = el("div", "th-live");
  live.hidden = true;
  live.setAttribute("aria-live", "polite");

  const compose = el("form", "d-capture th-compose");
  const input = el("textarea");
  input.rows = 1;
  input.placeholder = "Or type a thought";
  input.setAttribute("aria-label", "Type a thought");
  input.value = readDraft();
  const send = iconButton("check", "Save thought", () => {});
  send.type = "submit";
  compose.append(input, send);

  const notice = el("div", "d-notice th-notice");
  notice.hidden = true;
  // Built once and only updated: the queue repaints while something waits, and a button made afresh each time can't be pressed
  // (it's gone before the tap lands; thoughts-verify timed out on it).
  const noticeText = el("span", "");
  const noticeTry = el("button", "", "Try now");
  noticeTry.type = "button";
  noticeTry.addEventListener("click", () => { queue.kick(); void load(); });
  notice.append(noticeText, noticeTry);
  const searchRow = el("label", "d-search");
  const search = el("input");
  search.type = "search";
  search.placeholder = "Search thoughts";
  search.setAttribute("aria-label", "Search thoughts");
  search.autocomplete = "off";
  searchRow.append(icon("search"), search);

  const list = el("div", "d-list");
  const more = el("button", "d-more", "Show more");
  more.type = "button";
  more.hidden = true;
  const trash = el("details", "d-section");
  const trashList = el("div", "d-list");
  trash.append(el("summary", "", "Recently deleted"), trashList);
  view.append(head, hero, live, compose, notice, searchRow, list, more, trash);
  root.replaceChildren(view);

  let items: Summary[] = [];
  let loaded = false;
  let unreachable = false;
  let seq = 0;
  let rec: Recording | null = null;
  let armed: string | null = null;
  let armTimer = 0;
  let sheetClose: (() => void) | null = null;
  const stopKeyboard = watchKeyboard();

  // --- Recording ----------------------------------------------------------------------------------------------------

  let drawn = 0;
  let level = 0;
  let spent = 0;
  const paintLevel = () => {
    drawn = 0;
    if (!rec) return;
    // Speech sits low on a linear scale; the root spreads it out.
    const v = Math.min(1, Math.sqrt(level) * 2);
    ring.style.transform = `scale(${1 + v * 0.4})`;
    fill.style.transform = `scaleX(${v})`;
    elapsed.textContent = clock(spent);
  };

  function paintHero(state: "idle" | "starting" | "on", text = IDLE_TEXT) {
    hero.classList.toggle("on", state === "on");
    hero.classList.toggle("starting", state === "starting");
    mic.setAttribute("aria-pressed", String(state !== "idle"));
    mic.setAttribute("aria-label", state === "idle" ? "Start talking" : "Stop talking");
    statusText.textContent = text;
    elapsed.hidden = state !== "on";
    meter.hidden = state !== "on";
    if (state !== "on") { ring.style.transform = ""; fill.style.transform = ""; elapsed.textContent = ""; }
  }

  async function startRecording() {
    const ctx = unlockAudio(); // first, and synchronously: this is the gesture iOS needs
    navigator.vibrate?.(8);
    let began = false;
    // Not "listening" until the mic really is: the owner would start talking, and the first words wouldn't be there.
    paintHero("starting", "Getting the mic");
    const r: Recording = new Recording(ctx, {
      frame: (l, ms) => {
        if (rec !== r) return;
        if (!began) { began = true; paintHero("on", "Listening"); elapsed.textContent = clock(0); }
        level = l;
        spent = ms;
        drawn ||= requestAnimationFrame(paintLevel);
      },
      ended: (why) => {
        if (rec !== r) return;
        rec = null;
        live.hidden = true;
        paintHero("idle", why ? END_TEXT[why] : IDLE_TEXT);
      },
    });
    rec = r;
    try {
      await r.start();
    } catch (failure) {
      if (rec !== r) return;
      rec = null;
      const kind = failure as MicError;
      paintHero("idle", kind === "insecure" ? "The mic needs a secure page" : kind === "missing" ? "No microphone found" : "The mic isn't allowed");
    }
  }

  mic.addEventListener("click", () => {
    if (rec) rec.stop();
    else void startRecording();
  });

  // --- The list -----------------------------------------------------------------------------------------------------

  function arm(id: string) {
    armed = id;
    clearTimeout(armTimer);
    armTimer = window.setTimeout(() => { armed = null; render(); }, ARM_MS);
    render();
  }

  function pendingRow(p: PendingView): HTMLElement {
    const r = el("div", "th-row pending");
    r.dataset.id = p.id;
    r.append(el("div", p.text ? "th-text" : "th-text none", p.text || "Nothing transcribed yet"));
    const meta = el("div", "th-meta");
    meta.append(el("span", "", timeOf(p.created_at)));
    if (p.duration_ms !== null) meta.append(el("span", "", clock(p.duration_ms)));
    const waiting = p.state === "waiting_speech" || p.state === "waiting_save";
    const stateText = p.source === "typed" && p.state === "working" ? "Saving" : p.state === "working" && !p.untranscribed ? "Saving" : STATE_TEXT[p.state];
    meta.append(el("span", `th-state ${p.state}`, stateText));
    if (waiting || p.state === "failed") meta.append(el("span", "", durable() ? "Kept on this device" : "Only in memory for now"));
    r.append(meta);
    if (waiting || p.state === "failed") {
      const actions = el("div", "th-actions");
      const again = el("button", "", "Try now");
      again.type = "button";
      again.addEventListener("click", () => void queue.retry(p.id));
      const drop = el("button", armed === p.id ? "armed" : "", armed === p.id ? "Delete for good" : "Delete");
      drop.type = "button";
      drop.addEventListener("click", () => {
        if (armed !== p.id) { arm(p.id); return; }
        armed = null;
        void queue.discard(p.id);
      });
      actions.append(again, drop);
      r.append(actions);
    }
    return r;
  }

  function savedRow(s: Summary): HTMLElement {
    const b = el("button", "th-row");
    b.type = "button";
    b.dataset.id = s.id;
    b.addEventListener("click", () => openSheet(s));
    b.append(el("span", "th-text", s.preview));
    const meta = el("span", "th-meta");
    meta.append(el("span", "", timeOf(s.created_at)));
    if (s.duration_ms !== null) meta.append(el("span", "", clock(s.duration_ms)));
    if (s.note_id) meta.append(el("span", "th-in-notes", "In Notes"));
    b.append(meta);
    return b;
  }

  function render() {
    const q = search.value.trim();
    const pending = q ? [] : queue.pending.filter((p) => p.state !== "recording");
    const waiting = new Set(pending.map((p) => p.id));
    type Entry = { created_at: string; node: () => HTMLElement };
    const entries: Entry[] = [
      ...pending.map((p) => ({ created_at: p.created_at, node: () => pendingRow(p) })),
      ...items.filter((s) => !waiting.has(s.id)).map((s) => ({ created_at: s.created_at, node: () => savedRow(s) })),
    ];
    const rows: HTMLElement[] = [];
    for (const day of groupByDay(entries)) {
      rows.push(el("div", "th-day", day.label), ...day.items.map((e) => e.node()));
    }
    if (!rows.length && loaded) {
      const empty = el("div", "d-empty");
      if (q) empty.append(el("p", "", `Nothing matches "${q}".`));
      else if (!unreachable) empty.append(el("p", "d-empty-title", "Nothing yet"), el("p", "", "Tap the button and say what's on your mind."));
      rows.push(empty);
    }
    list.replaceChildren(...rows);
    if (!loaded && !rows.length) list.append(el("div", "d-empty", "Loading"));
    paintNotice();
  }

  function paintNotice() {
    const count = (s: PendingView["state"]) => queue.pending.filter((p) => p.state === s).length;
    const speech = count("waiting_speech"), save = count("waiting_save");
    const lines: string[] = [];
    const kept = durable() ? ", kept on this device" : "";
    if (!durable() && (queue.pending.length || rec)) lines.push("This device can't store audio right now, so it's only in memory. Keep this screen open until it's saved.");
    if (speech) lines.push(`Speech isn't reachable. ${speech === 1 ? "1 thought is" : `${speech} thoughts are`} waiting to transcribe${kept}.`);
    if (save) lines.push(`The server isn't reachable. ${save === 1 ? "1 thought is" : `${save} thoughts are`} waiting to save${kept}.`);
    if (unreachable && !save && !speech) lines.push("Your thoughts aren't reachable right now. Anything new is kept on this device.");
    notice.hidden = !lines.length;
    const text = lines.join(" ");
    if (noticeText.textContent !== text) noticeText.textContent = text;
    noticeTry.hidden = !(lines.length && (speech || save || unreachable));
  }

  async function load(append = false) {
    const mine = ++seq;
    const q = search.value.trim();
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (q) params.set("q", q);
    if (append) params.set("offset", String(items.length));
    const res = await request<Summary[]>(`/api/thoughts?${params}`);
    if (mine !== seq) return; // A newer search overtook this one.
    loaded = true;
    if (!res.ok) {
      unreachable = true;
      render();
      return;
    }
    unreachable = false;
    const seen = new Set(res.ok.map((s) => s.id));
    // Offset paging while new ones arrive can repeat a row.
    items = append ? [...items.filter((s) => !seen.has(s.id)), ...res.ok] : res.ok;
    more.hidden = res.ok.length < PAGE;
    render();
  }

  async function loadTrash() {
    const res = await request<Summary[]>("/api/thoughts?deleted=true&limit=50");
    if (!res.ok) { trashList.replaceChildren(el("div", "d-empty", "Couldn't load these. Try again in a moment.")); return; }
    if (!res.ok.length) { trashList.replaceChildren(el("div", "d-empty", "Nothing here.")); return; }
    trashList.replaceChildren(...res.ok.map((s) => {
      const r = el("div", "d-trash");
      r.append(el("span", "d-note-title", s.preview));
      const b = el("button", "", "Restore");
      b.type = "button";
      b.addEventListener("click", async () => {
        const back = await request<Thought>(`/api/thoughts/${s.id}/restore`, { method: "POST" });
        if (!back.ok) { toast("Couldn't restore that. Try again in a moment."); return; }
        r.remove();
        void load();
      });
      r.append(b);
      return r;
    }));
  }

  // --- A thought, opened --------------------------------------------------------------------------------------------

  function openSheet(s: Summary) {
    if (sheetClose) return;
    dismissToast();
    const scrim = el("div", "d-scrim");
    const sheet = el("div", "d-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Thought");
    const bar = el("header", "d-bar");
    const state = el("span", "d-status", "Opening");
    const del = iconButton("trash", "Delete", () => void remove());
    const done = el("button", "d-done", "Done");
    done.type = "button";
    done.addEventListener("click", () => void close());
    bar.append(state, del, done);
    const banner = el("div", "d-conflict");
    banner.hidden = true;
    const text = el("textarea", "d-sheet-notes th-sheet-text");
    text.value = s.preview;
    text.disabled = true;
    text.setAttribute("aria-label", "Thought");
    const meta = el("div", "th-sheet-meta");
    const when = new Date(s.created_at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    meta.textContent = [when, s.duration_ms !== null ? `spoken for ${clock(s.duration_ms)}` : "typed"].join(" · ");
    const actions = el("div", "th-sheet-actions");
    const noteBtn = el("button", "th-to-note", s.note_id ? "Open note" : "Make it a note");
    noteBtn.type = "button";
    noteBtn.addEventListener("click", () => void toNote());
    actions.append(noteBtn);
    sheet.append(bar, banner, text, meta, actions);
    scrim.append(sheet);
    document.body.append(scrim);

    let current: Thought | null = null;
    let open = true;

    const dirty = () => !!current && text.value !== current.body;
    const remember = (t: Thought) => {
      current = t;
      items = items.map((i) => (i.id === t.id ? summaryOf(t) : i));
    };

    void request<Thought>(`/api/thoughts/${s.id}`).then((res) => {
      if (!open) return;
      if (res.ok) {
        remember(res.ok);
        text.value = res.ok.body;
        text.disabled = false;
        state.textContent = "";
        noteBtn.textContent = res.ok.note_id ? "Open note" : "Make it a note";
        return;
      }
      if (res.fail === "gone") {
        items = items.filter((i) => i.id !== s.id);
        shut();
        render();
        toast("That thought is gone. It may have been deleted on another device.");
        return;
      }
      state.textContent = "Can't open all of this while offline.";
    });

    /** True when the server has what's in the box. A conflict never overwrites anything: the owner sees both and picks. */
    async function save(): Promise<boolean> {
      if (!current || !dirty()) return true;
      if (!text.value.trim()) { toast("A thought can't be empty. Delete it instead."); return false; }
      state.textContent = "Saving";
      const res = await request<Thought>(`/api/thoughts/${s.id}`, jsonInit("PATCH", { version: current.version, body: text.value }));
      if (res.ok) { remember(res.ok); state.textContent = "Saved"; banner.hidden = true; return true; }
      if (res.fail === "conflict" && res.current) {
        if (res.current.deleted_at) { state.textContent = "Deleted on another device"; toast("This was deleted on another device. Your text is still in the box."); return false; }
        if (res.current.body === text.value) { remember(res.current); state.textContent = ""; return true; }
        showConflict(res.current);
        return false;
      }
      state.textContent = "Couldn't save";
      toast(res.fail === "rejected" ? "This can't be saved as it is." : "Couldn't save that. Your text is still in the box.");
      return false;
    }

    function showConflict(other: Thought) {
      state.textContent = "Changed on another device";
      banner.hidden = false;
      banner.replaceChildren(el("p", "", "This also changed on another device. Your text is in the box; the other version is below."));
      const row = el("div", "d-conflict-actions");
      const mine = el("button", "primary", "Keep mine");
      mine.type = "button";
      mine.addEventListener("click", () => { current = other; banner.hidden = true; void save(); });
      const theirs = el("button", "", "Keep the other");
      theirs.type = "button";
      theirs.addEventListener("click", () => { remember(other); text.value = other.body; banner.hidden = true; state.textContent = ""; });
      row.append(mine, theirs);
      banner.append(row, el("pre", "d-other-body", other.body));
    }

    async function toNote() {
      if (current?.note_id) { const id = current.note_id; shut(); render(); openNote(id); return; }
      if (!(await save())) return;
      noteBtn.disabled = true;
      const res = await request<Thought>(`/api/thoughts/${s.id}/note`, { method: "POST" });
      noteBtn.disabled = false;
      if (!res.ok) { toast("Couldn't make that into a note. Try again in a moment."); return; }
      remember(res.ok);
      noteBtn.textContent = "Open note";
      state.textContent = "In Notes";
      render();
    }

    async function remove() {
      const res = await request<Thought>(`/api/thoughts/${s.id}`, { method: "DELETE" });
      if (!res.ok) { toast("Couldn't delete this. Try again in a moment."); return; }
      items = items.filter((i) => i.id !== s.id);
      shut();
      render();
      toast("Thought deleted", {
        label: "Undo",
        run: async () => {
          const back = await request<Thought>(`/api/thoughts/${s.id}/restore`, { method: "POST" });
          if (!back.ok) toast("Couldn't undo that. It's in Recently deleted.");
          void load();
        },
      });
    }

    function shut() {
      if (!open) return;
      open = false;
      document.removeEventListener("keydown", onKey);
      scrim.remove();
      sheetClose = null;
    }

    async function close() {
      if (!open) return;
      if (await save()) { shut(); render(); }
    }

    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); void close(); } };
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", (e) => { if (e.target === scrim) void close(); });
    sheetClose = () => { void save(); shut(); };
  }

  // --- Wiring -------------------------------------------------------------------------------------------------------

  function fitInput() {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }

  async function submitTyped() {
    const body = input.value.trim();
    if (!body) return;
    input.value = "";
    writeDraft("");
    fitInput();
    await queue.addTyped(crypto.randomUUID(), body, new Date().toISOString());
    input.focus();
  }

  compose.addEventListener("submit", (e) => { e.preventDefault(); void submitTyped(); });
  input.addEventListener("input", () => { writeDraft(input.value); fitInput(); });
  // A keyboard with a real Enter sends; on a phone Enter is a new line and the button sends.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) { e.preventDefault(); void submitTyped(); }
  });

  more.addEventListener("click", () => void load(true));
  trash.addEventListener("toggle", () => { if (trash.open) void loadTrash(); });
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  search.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void load(), 200);
  });

  const off = onThoughts({
    changed: () => {
      const mine = rec && queue.pending.find((p) => p.id === rec!.id);
      live.textContent = mine?.text ?? "";
      live.hidden = !mine?.text;
      render();
    },
    saved: (t) => {
      if (!search.value.trim() && !items.some((i) => i.id === t.id) && !t.deleted_at) items = [summaryOf(t), ...items];
      render();
    },
    nothingSaid: () => toast("I didn't catch anything in that recording."),
  });
  const stopFresh = whenFresh(() => { if (!sheetClose) void load(); });

  render();
  fitInput();
  void queue.refresh().catch(() => {});
  void load();
  queue.kick();

  return () => {
    off();
    stopFresh();
    stopKeyboard();
    clearTimeout(armTimer);
    if (drawn) cancelAnimationFrame(drawn);
    if (searchTimer) clearTimeout(searchTimer);
    sheetClose?.();
    // A hot mic with nothing on screen to say so isn't on offer. What the owner said is saved and carries on being sent.
    rec?.stop();
    rec = null;
  };
}
