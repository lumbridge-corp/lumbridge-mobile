// Notes: a list and a full-screen editor. The editor lives in history state rather than a route, so opening one never
// rebuilds the page: a new note can take focus inside the tap, which is the only way iOS raises the keyboard.
// A computer with a mouse keeps the list on the left and opens the note beside it, in place (the dock).
import "./data.css";
import { draftOf, isEmpty, newDraft, rowText, type Draft, type Note, type Status } from "../data/notes-sync";
import { relTime } from "../data/dates";
import { afterLoad, notLoadedText, type FirstLoad } from "../data/first-load";
import { parseMarkdown, plainLine, type Block, type Inline } from "../data/markdown";
import { onConn } from "../app";
import { el } from "../dom";
import { icon as appIcon } from "../icons";
import { dismissToast, icon, iconButton, request, toast, watchKeyboard, whenFresh } from "./data-ui";
import { drafts, flushAll, saverFor, savers } from "./notes-io";

interface Summary { id: string; title: string; preview: string; pinned: boolean; updated_at: string; deleted_at: string | null; version: number }

const PAGE = 100;

const STATUS_TEXT: Record<Status, string> = {
  saved: "Saved", pending: "Editing", saving: "Saving", offline: "Offline, kept on this device",
  conflict: "Changed on another device", deleted: "Deleted on another device", rejected: "Couldn't save",
};

const REASONS: Record<string, string> = { body_too_long: "This note is over the 1 MB limit.", title_too_long: "The title is too long.", invalid_text: "This text has a character that can't be saved." };

export function notesView(root: HTMLElement) {
  const view = el("div", "d-view");
  const head = el("header", "d-head");
  const h1 = el("h1", "", "Notes");
  const add = el("button", "d-add");
  add.type = "button";
  add.setAttribute("aria-label", "New note");
  add.append(icon("plus"), el("span", "", "New"));
  head.append(h1, add);

  const searchRow = el("label", "d-search");
  const search = el("input");
  search.type = "search";
  search.placeholder = "Search notes";
  search.setAttribute("aria-label", "Search notes");
  search.autocomplete = "off";
  searchRow.append(icon("search"), search);

  const notice = el("div", "d-notice");
  notice.hidden = true;
  const list = el("div", "d-list");
  const more = el("button", "d-more", "Show more");
  more.type = "button";
  more.hidden = true;
  const trash = el("details", "d-section");
  const trashSummary = el("summary", "", "Recently deleted");
  const trashList = el("div", "d-list");
  trash.append(trashSummary, trashList);
  view.append(head, searchRow, notice, list, more, trash);
  // The dock: where a note opens on a computer. Phones never show it; their editor covers the screen.
  const docked = matchMedia("(min-width: 900px) and (pointer: fine)");
  const dock = el("section", "n-dock");
  dock.setAttribute("aria-label", "Open note");
  const idle = el("div", "n-idle");
  idle.append(appIcon("notes", "n-idle-mark"), el("p", "", "Pick a note to read it here, or start a new one."));
  dock.append(idle);
  const split = el("div", "n-split");
  split.append(view, dock);
  root.replaceChildren(split);

  let items: Summary[] = [];
  let state: FirstLoad = "loading";
  let seq = 0;
  let editorClose: (() => void) | null = null;
  let openId: string | null = null;
  let openBox: HTMLElement | null = null;
  let switching = false;
  let leaving = false;

  const stopKeyboard = watchKeyboard();

  function row(s: Summary): HTMLButtonElement {
    const local = drafts.load(s.id);
    const shown = local ? rowText(local.title, local.body, plainLine) : rowText(s.title, s.preview, plainLine);
    const b = el("button", s.id === openId ? "d-note on" : "d-note");
    b.type = "button";
    b.dataset.id = s.id;
    if (s.id === openId) b.setAttribute("aria-current", "true");
    b.addEventListener("click", () => openEditor(s.id));
    const text = el("span", "d-note-text");
    const title = el("span", "d-note-title");
    if (s.pinned) { const p = el("span", "d-pin"); p.append(icon("pin")); title.append(p); }
    title.append(el("span", "", shown.title));
    text.append(title);
    if (shown.preview) text.append(el("span", "d-note-preview", shown.preview));
    const when = el("span", "d-note-when");
    if (local?.other) when.append(el("span", "d-flag", "Needs you"));
    else if (local) when.append(el("span", "d-flag quiet", "Not saved yet"));
    else when.textContent = relTime(s.updated_at);
    b.append(text, when);
    return b;
  }

  function draftRow(d: Draft): HTMLButtonElement {
    return row({ id: d.id, title: d.title, preview: d.body, pinned: d.pinned, updated_at: new Date(d.edited_at).toISOString(), deleted_at: null, version: d.version ?? 0 });
  }

  function render() {
    const q = search.value.trim();
    const known = new Set(items.map((i) => i.id));
    // Notes the server doesn't list yet, so nothing the owner typed ever looks lost.
    const orphans = q ? [] : drafts.all().filter((d) => !known.has(d.id));
    const rows: HTMLElement[] = [...orphans.map(draftRow), ...items.map(row)];
    // Not loaded yet, or the first GET failed: what's on the device still shows, but never "No notes yet".
    if (!rows.length && state === "loaded") {
      const empty = el("div", "d-empty");
      if (q) empty.append(el("p", "", `Nothing matches "${q}".`));
      else {
        empty.append(el("p", "d-empty-title", "No notes yet"), el("p", "", "Anything you write here is on your phone and your computers."));
        const start = el("button", "primary", "Write a note");
        start.type = "button";
        start.addEventListener("click", () => openEditor(null));
        empty.append(start);
      }
      rows.push(empty);
    }
    list.replaceChildren(...rows);
    if (state === "loading" && !rows.length) list.append(el("div", "d-empty", "Loading"));
  }

  function showNotice(text: string | null, retry = true) {
    notice.hidden = !text;
    notice.replaceChildren();
    if (!text) return;
    notice.append(el("span", "", text));
    if (retry) {
      const b = el("button", "", "Try again");
      b.type = "button";
      b.addEventListener("click", () => void load());
      notice.append(b);
    }
  }

  async function load(append = false) {
    const mine = ++seq;
    const q = search.value.trim();
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (q) params.set("q", q);
    if (append) params.set("offset", String(items.length));
    const res = await request<Summary[]>(`/api/notes?${params}`);
    if (mine !== seq) return; // A newer search overtook this one.
    state = afterLoad(state, !!res.ok, navigator.onLine !== false);
    if (!res.ok) {
      showNotice(notLoadedText(state) ?? (res.fail === "offline" ? "You're offline. What you write is kept on this device." : "Your notes database isn't reachable right now. What you write is kept on this device."));
      render();
      return;
    }
    showNotice(null);
    items = append ? [...items, ...res.ok] : res.ok;
    more.hidden = res.ok.length < PAGE;
    render();
    flushAll();
  }

  async function loadTrash() {
    const res = await request<Summary[]>("/api/notes?deleted=true&limit=50");
    if (!res.ok) { trashList.replaceChildren(el("div", "d-empty", "Couldn't load these. Try again in a moment.")); return; }
    if (!res.ok.length) { trashList.replaceChildren(el("div", "d-empty", "Nothing here.")); return; }
    trashList.replaceChildren(...res.ok.map((s) => {
      const r = el("div", "d-trash");
      const shown = rowText(s.title, s.preview, plainLine);
      r.append(el("span", "d-note-title", shown.title));
      const b = el("button", "", "Restore");
      b.type = "button";
      b.addEventListener("click", async () => {
        const back = await request<Note>(`/api/notes/${s.id}/restore`, { method: "POST" });
        if (!back.ok) { toast("Couldn't restore that. Try again in a moment."); return; }
        r.remove();
        void load();
      });
      r.append(b);
      return r;
    }));
  }

  // --- Editor -------------------------------------------------------------------------------------------------------

  /** Which row is open, on the list beside the dock. */
  function markOpen() {
    for (const b of list.querySelectorAll<HTMLElement>(".d-note")) {
      const on = b.dataset.id === openId;
      b.classList.toggle("on", on);
      if (on) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
    }
  }

  /** id null: a brand new note, from a tap. Otherwise from a row, or from history after a reload. */
  function openEditor(id: string | null, fromHistory = false) {
    let replace = false;
    if (editorClose) {
      // Docked, another row swaps the open note, and takes over its history entry. A phone's editor covers the list.
      if (!docked.matches || (id !== null && id === openId)) return;
      switching = true;
      editorClose();
      switching = false;
      replace = !fromHistory;
    }
    const noteId = id ?? crypto.randomUUID();
    const st = { note: noteId, wasNew: id === null };
    if (replace) history.replaceState(st, "", location.href);
    else if (!fromHistory) history.pushState(st, "", location.href);
    openId = noteId;
    markOpen();
    editorClose = buildEditor(noteId, id === null, () => {
      editorClose = null;
      openId = openBox = null;
      markOpen();
      if (leaving) return;
      if (!switching && history.state?.note) history.back();
      render();
      void load();
    });
  }

  function buildEditor(id: string, isNew: boolean, onClose: () => void): () => void {
    dismissToast();
    const box = el("div", "d-editor");
    const bar = el("header", "d-bar");
    const back = iconButton("back", "Back to notes", () => close());
    const status = el("span", "d-status");
    status.setAttribute("aria-live", "polite");
    const previewBtn = iconButton("eye", "Preview", () => setPreview(!previewing));
    const pinBtn = iconButton("pin", "Pin", () => { s.edit({ pinned: !s.draft.pinned }); paint(); });
    const delBtn = iconButton("trash", "Delete", () => void remove());
    bar.append(back, status, previewBtn, pinBtn, delBtn);

    const banner = el("div", "d-conflict");
    banner.hidden = true;
    const page = el("div", "d-page");
    const title = el("input", "d-title");
    title.placeholder = "Title";
    title.setAttribute("aria-label", "Title");
    title.maxLength = 1000;
    const body = el("textarea", "d-body");
    body.placeholder = "Write here";
    body.setAttribute("aria-label", "Note");
    const preview = el("div", "d-preview");
    preview.hidden = true;
    page.append(title, body, preview);
    box.append(bar, banner, page);
    openBox = box;
    (docked.matches ? dock : document.body).append(box);

    let previewing = false;
    let open = true;

    const local = drafts.load(id);
    // A saver that finished long ago may hold old text; only one with something unsent is worth resuming.
    const earlier = savers.get(id);
    if (earlier && !local && earlier.status === "saved") savers.delete(id);
    const resumed = savers.has(id);
    const s = resumed ? savers.get(id)! : saverFor(local ?? newDraft(id));
    s.changed = paint;
    s.replaced = fill;

    function fill() {
      if (title.value !== s.draft.title) title.value = s.draft.title;
      if (body.value !== s.draft.body) body.value = s.draft.body;
      if (previewing) renderPreview();
      paint();
    }

    function paint() {
      if (!open) return;
      const st = s.status;
      let text = STATUS_TEXT[st];
      if (st === "rejected") text = REASONS[s.why] ?? "Couldn't save this.";
      if (st === "saved" && isNew && isEmpty(s.draft)) text = "";
      if (!s.stored) text += ". Couldn't store it on this device";
      status.textContent = text;
      status.className = `d-status ${st}`;
      pinBtn.classList.toggle("on", s.draft.pinned);
      pinBtn.setAttribute("aria-pressed", String(s.draft.pinned));
      paintConflict();
    }

    function paintConflict() {
      const other = s.draft.other;
      banner.hidden = !other;
      if (!other) { banner.replaceChildren(); return; }
      banner.replaceChildren();
      const act = (label: string, run: () => Promise<boolean> | void, primary = false) => {
        const b = el("button", primary ? "primary" : "", label);
        b.type = "button";
        b.addEventListener("click", async () => {
          b.disabled = true;
          const done = await run();
          if (done === false) { toast("Couldn't save that. You're offline or the server is down; nothing was lost."); b.disabled = false; }
          paint();
        });
        return b;
      };
      if (other.deleted_at) {
        banner.append(el("p", "", "This note was deleted on another device, but you've made changes. Your text is safe here."));
        const row = el("div", "d-conflict-actions");
        row.append(act("Restore with my text", () => s.restoreMine(), true), act("Discard my changes", () => { s.discard(); savers.delete(id); close(); }));
        banner.append(row);
        return;
      }
      banner.append(el("p", "", "This note also changed on another device. Your text is in the editor; the other version is below. Whichever you choose, the other one is saved as a new note."));
      const row = el("div", "d-conflict-actions");
      row.append(act("Keep mine", () => s.keepMine(), true), act("Keep the other", () => s.keepTheirs()));
      banner.append(row);
      const d = el("details", "d-other");
      d.open = true;
      d.append(el("summary", "", `Other version, ${relTime(other.updated_at)}`));
      if (other.title) d.append(el("p", "d-other-title", other.title));
      const pre = el("pre", "d-other-body", other.body);
      d.append(pre);
      banner.append(d);
    }

    function setPreview(on: boolean) {
      previewing = on;
      body.hidden = on;
      preview.hidden = !on;
      previewBtn.replaceChildren(icon(on ? "edit" : "eye"));
      previewBtn.setAttribute("aria-label", on ? "Edit" : "Preview");
      previewBtn.title = on ? "Edit" : "Preview";
      if (on) renderPreview();
    }

    function renderPreview() {
      preview.replaceChildren(...renderBlocks(parseMarkdown(body.value)));
      if (!body.value.trim()) preview.append(el("p", "d-empty", "Nothing to preview yet."));
    }

    title.addEventListener("input", () => s.edit({ title: title.value }));
    body.addEventListener("input", () => s.edit({ body: body.value }));
    title.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); body.focus(); }
    });
    // On the document: an opened note has no focus yet, and must not take it, or a phone's keyboard pops up.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void s.flush(); }
    };
    document.addEventListener("keydown", onKey);

    const onHide = () => { if (document.visibilityState === "hidden") void s.flush(true); };
    const onPageHide = () => { void s.flush(true); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    const stopFresh = whenFresh(() => void refresh(), 30000);

    async function refresh() {
      if (s.status === "offline") { void s.flush(); return; }
      if (s.draft.version === null) return;
      const res = await request<Note>(`/api/notes/${id}`);
      if (res.ok && open) s.refresh(res.ok);
    }

    function close() {
      if (!open) return;
      open = false;
      void s.flush().finally(() => { if (!drafts.load(id)) savers.delete(id); });
      s.changed = () => {};
      s.replaced = () => {};
      document.removeEventListener("visibilitychange", onHide);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("pagehide", onPageHide);
      stopFresh();
      box.remove();
      onClose();
    }

    async function remove() {
      // Nothing there yet: just leave.
      if (s.draft.version === null && isEmpty(s.draft)) { s.discard(); savers.delete(id); close(); return; }
      await s.flush();
      if (s.draft.version === null || s.status === "offline") { toast("You're offline, so this can't be deleted yet."); return; }
      const res = await request<Note>(`/api/notes/${id}`, { method: "DELETE" });
      if (!res.ok) { toast("Couldn't delete this. Try again in a moment."); return; }
      s.discard();
      savers.delete(id);
      close();
      toast("Note deleted", {
        label: "Undo",
        run: async () => {
          const back = await request<Note>(`/api/notes/${id}/restore`, { method: "POST" });
          if (!back.ok) toast("Couldn't undo that. It's in Recently deleted.");
          void load();
        },
      });
    }

    fill();
    // A note we only have the id of: fetch it unless a draft is already holding the owner's text.
    if (!local && !resumed && !isNew) {
      status.textContent = "Opening";
      title.disabled = body.disabled = true;
      void request<Note>(`/api/notes/${id}`).then((res) => {
        if (!open) return;
        if (res.ok) {
          Object.assign(s.draft, draftOf(res.ok));
          title.disabled = body.disabled = false;
          fill();
          return;
        }
        if (res.fail === "gone" && history.state?.wasNew) {
          // Reloaded a new note before it had anything in it.
          title.disabled = body.disabled = false;
          fill();
          return;
        }
        if (res.fail === "gone") {
          s.discard();
          savers.delete(id);
          close();
          toast("That note is gone. It may have been deleted on another device.");
          return;
        }
        status.textContent = "Can't open this while offline.";
        status.className = "d-status offline";
      });
    } else if (local && !resumed) {
      // Reopened after a reload or a crash: send whatever is waiting.
      void s.flush();
    }
    // Inside the tap, so iOS raises the keyboard.
    if (isNew) title.focus();
    return close;
  }

  // --- Wiring -------------------------------------------------------------------------------------------------------

  add.addEventListener("click", () => openEditor(null));
  more.addEventListener("click", () => void load(true));
  trash.addEventListener("toggle", () => { if (trash.open) void loadTrash(); });
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  search.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void load(), 200);
  });

  const onPop = () => {
    const wanted = history.state?.note;
    if (!wanted && editorClose) { editorClose(); return; }
    if (wanted && !editorClose) openEditor(wanted, true);
  };
  window.addEventListener("popstate", onPop);
  // The window crossed the line: the open note moves to where this size shows it.
  const onDock = () => { if (openBox) (docked.matches ? dock : document.body).append(openBox); };
  docked.addEventListener("change", onDock);
  const stopFresh = whenFresh(() => { if (!editorClose) void load(); });
  // Back online after a first load that failed: the list comes by itself.
  const offConn = onConn((c) => { if (c === "online" && state !== "loaded" && !editorClose) void load(); });

  render();
  void load();
  // A reload inside the editor, or coming back to this tab.
  if (history.state?.note) openEditor(history.state.note, true);

  return () => {
    leaving = true;
    window.removeEventListener("popstate", onPop);
    docked.removeEventListener("change", onDock);
    stopFresh();
    offConn();
    stopKeyboard();
    if (searchTimer) clearTimeout(searchTimer);
    editorClose?.();
    flushAll();
  };
}

function renderInline(nodes: Inline[]): Node[] {
  return nodes.map((n) => {
    switch (n.t) {
      case "text": return document.createTextNode(n.v);
      case "code": return el("code", "", n.v);
      case "strong": { const e = el("strong"); e.append(...renderInline(n.c)); return e; }
      case "em": { const e = el("em"); e.append(...renderInline(n.c)); return e; }
      case "link": {
        const a = el("a");
        a.href = n.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.append(...renderInline(n.c));
        return a;
      }
    }
  });
}

function renderBlocks(blocks: Block[]): HTMLElement[] {
  return blocks.map((b) => {
    switch (b.t) {
      case "heading": { const e = el(`h${b.level}` as "h1"); e.append(...renderInline(b.c)); return e; }
      case "para": { const e = el("p"); e.append(...renderInline(b.c)); return e; }
      case "quote": { const e = el("blockquote"); e.append(...renderInline(b.c)); return e; }
      case "code": return el("pre", "", b.v);
      case "rule": return el("hr");
      case "list": {
        const e = el(b.ordered ? "ol" : "ul");
        for (const item of b.items) {
          const li = el("li");
          if (item.done !== null) {
            li.className = item.done ? "d-li-check done" : "d-li-check";
            li.append(el("span", "d-box", item.done ? "✓" : ""));
          }
          li.append(...renderInline(item.c));
          e.append(li);
        }
        return e;
      }
    }
  });
}
