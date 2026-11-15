// Files: take photos or add them from the library, and find them again. Each one is on this device until the server has it (files-uploader.ts),
// then the server's filing job reads and files it. Everything the server says about a file is shown through textContent only.
import "./data.css";
import "./files.css";
import { api } from "../api";
import { caption, categoryLabel, CATEGORIES, drawable, hasThumb, kindLabel, photoName, refusalText, sizeText, typeMark } from "../data/files-logic";
import { MAX_FILE_BYTES, type WaitingView } from "../data/files-queue";
import { el } from "../dom";
import { icon as bigIcon } from "../icons";
import { dismissToast, icon, iconButton, jsonInit, request, toast, watchKeyboard, whenFresh } from "./data-ui";
import { fileQueue, filesDurable, localBlob, onFiles, type FileRow } from "./files-uploader";
import { ASSISTANT_NAME } from "../ns";

const PAGE = 60;
const ARM_MS = 4000;
/** While something is being filed, the list looks again this often so "Filing" turns into what it is. */
const FILING_POLL_MS = 5000;

const whenText = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const dayText = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });

function picker(accept: string, capture: boolean): HTMLInputElement {
  const i = el("input");
  i.type = "file";
  if (accept) i.accept = accept;
  i.multiple = !capture;
  if (capture) i.setAttribute("capture", "environment");
  i.hidden = true;
  return i;
}

/** Thumbnails come through the API with the device token, so they're fetched and shown from blob URLs, a few at a time. */
class Thumbs {
  private urls = new Map<string, string>();
  private queue: { key: string; img: HTMLImageElement; load: () => Promise<Blob | null> }[] = [];
  private busy = 0;
  private dead = false;

  show(key: string, img: HTMLImageElement, load: () => Promise<Blob | null>) {
    const have = this.urls.get(key);
    if (have) { img.src = have; return; }
    this.queue.push({ key, img, load });
    this.pump();
  }

  private pump() {
    while (this.busy < 4 && this.queue.length) {
      const job = this.queue.shift()!;
      if (!job.img.isConnected && this.urls.has(job.key)) continue;
      this.busy++;
      void job.load().then((b) => {
        if (this.dead || !b) return;
        const url = this.urls.get(job.key) ?? URL.createObjectURL(b);
        this.urls.set(job.key, url);
        job.img.src = url;
      }).catch(() => {}).finally(() => { this.busy--; this.pump(); });
    }
  }

  drop(key: string) {
    const u = this.urls.get(key);
    if (u) URL.revokeObjectURL(u);
    this.urls.delete(key);
  }

  close() {
    this.dead = true;
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
    this.queue = [];
  }
}

const fetchBlob = async (id: string, size: "thumb" | "large" | "original") => {
  try { return await (await api(`/api/files/${id}/content?size=${size}`)).blob(); } catch { return null; }
};

export function filesView(root: HTMLElement) {
  const view = el("div", "d-view fi-view");
  const head = el("header", "d-head");
  head.append(el("h1", "", "Files"));

  const camera = picker("image/*", true);
  const library = picker("image/*", false);
  const anyFile = picker("", false);

  // One row. A phone gets the camera first, the library and any other file beside it; a computer with a mouse has no camera
  // worth the name, so it gets one Add files that takes pictures and anything else (files.css picks by pointer).
  const hero = el("div", "fi-hero");
  const take = el("button", "fi-big primary");
  take.type = "button";
  take.append(bigIcon("camera"), el("span", "", "Take photos"));
  const add = el("button", "fi-big");
  add.type = "button";
  add.append(bigIcon("image"), el("span", "", "Add from library"));
  const other = el("button", "fi-big fi-other");
  other.type = "button";
  other.setAttribute("aria-label", "Add a PDF or other file");
  other.append(bigIcon("notes"), el("span", "", "PDF or file"));
  const addFiles = el("button", "btn fi-add");
  addFiles.type = "button";
  addFiles.append(bigIcon("files"), el("span", "", "Add files"));
  hero.append(take, add, other, addFiles);

  // After a shot, the next one is one tap away, and Done is right beside it.
  const shooting = el("div", "fi-shooting");
  shooting.hidden = true;
  const shotCount = el("span", "fi-shot-count");
  const again = el("button", "fi-big primary fi-again");
  again.type = "button";
  again.append(bigIcon("camera"), el("span", "", "Take another"));
  const doneShooting = el("button", "fi-done", "Done");
  doneShooting.type = "button";
  shooting.append(shotCount, again, doneShooting);

  const notice = el("div", "d-notice fi-notice");
  notice.hidden = true;
  // Built once and only updated, as in Thoughts: a button made afresh at every repaint can be gone before the tap lands.
  const noticeText = el("span", "");
  const noticeTry = el("button", "", "Try now");
  noticeTry.type = "button";
  noticeTry.addEventListener("click", () => { fileQueue.kick(); void load(); });
  notice.append(noticeText, noticeTry);
  const searchRow = el("label", "d-search");
  const search = el("input");
  search.type = "search";
  search.placeholder = "Search files";
  search.setAttribute("aria-label", "Search files");
  search.autocomplete = "off";
  searchRow.append(icon("search"), search);
  const chips = el("div", "fi-chips");
  chips.setAttribute("role", "toolbar");
  chips.setAttribute("aria-label", "Category");
  // The row scrolls sideways on a phone; a fade at an edge says there's more that way, and only when there is.
  const chipsEdge = el("div", "fi-chips-edge");
  chipsEdge.append(chips);
  const paintEdges = () => {
    const left = chips.scrollLeft, rest = chips.scrollWidth - chips.clientWidth - left;
    chipsEdge.classList.toggle("more-left", left > 4);
    chipsEdge.classList.toggle("more-right", rest > 4);
  };
  chips.addEventListener("scroll", paintEdges, { passive: true });
  const edgeWatch = new ResizeObserver(paintEdges);
  edgeWatch.observe(chips);

  const waitingGrid = el("div", "fi-grid fi-waiting");
  const grid = el("div", "fi-grid");
  const empty = el("div", "d-empty");
  empty.hidden = true;
  const more = el("button", "d-more", "Show more");
  more.type = "button";
  more.hidden = true;
  const trash = el("details", "d-section");
  const trashList = el("div", "d-list");
  trash.append(el("summary", "", "Recently deleted"), trashList);
  // The categories and the files: one after the other on a phone, side by side on a computer (files.css).
  const main = el("div", "fi-main");
  main.append(waitingGrid, grid, empty, more, trash);
  const cols = el("div", "fi-cols");
  cols.append(chipsEdge, main);
  view.append(head, hero, shooting, camera, library, anyFile, notice, searchRow, cols);
  root.replaceChildren(view);

  const thumbs = new Thumbs();
  const stopKeyboard = watchKeyboard();
  let items: FileRow[] = [];
  let loaded = false;
  let unreachable = false;
  let seq = 0;
  let category: string | null = null;
  let shotsThisRound = 0;
  let sheetClose: (() => void) | null = null;
  let pollTimer = 0;

  // --- Adding -------------------------------------------------------------------------------------------------------

  async function keep(files: FileList | null, fromCamera: boolean) {
    if (!files?.length) return;
    const now = new Date();
    let tooBig = 0;
    for (const f of [...files]) {
      if (f.size > MAX_FILE_BYTES) tooBig++;
      // The camera names every shot image.jpg; a name with the time reads better and is what the owner would search for.
      const name = fromCamera || !f.name || /^image\.(jpe?g|png|heic)$/i.test(f.name) ? photoName(now, fromCamera ? shotsThisRound + 1 : 1, f.type) : f.name;
      try {
        await fileQueue.add(f, name);
        if (fromCamera) shotsThisRound++;
      } catch {
        toast("This device couldn't keep that file. Try again.");
      }
    }
    if (tooBig) toast(tooBig === 1 ? "That one's over 50 MB, so it can't be sent." : `${tooBig} are over 50 MB, so they can't be sent.`);
    navigator.vibrate?.(8);
  }

  function paintShooting() {
    shooting.hidden = shotsThisRound === 0;
    hero.hidden = shotsThisRound > 0;
    shotCount.textContent = shotsThisRound === 1 ? "1 photo taken" : `${shotsThisRound} photos taken`;
  }

  take.addEventListener("click", () => { shotsThisRound = 0; camera.click(); });
  again.addEventListener("click", () => camera.click());
  doneShooting.addEventListener("click", () => { shotsThisRound = 0; paintShooting(); });
  add.addEventListener("click", () => library.click());
  other.addEventListener("click", () => anyFile.click());
  addFiles.addEventListener("click", () => anyFile.click());
  camera.addEventListener("change", async () => {
    await keep(camera.files, true);
    camera.value = "";
    paintShooting();
  });
  for (const input of [library, anyFile]) {
    input.addEventListener("change", async () => {
      await keep(input.files, false);
      input.value = "";
    });
  }

  // --- The grid -----------------------------------------------------------------------------------------------------

  function tile(kind: "row" | "waiting", key: string, mime: string, name: string, text: string, badge: string | null, badgeClass = ""): { node: HTMLElement; img: HTMLImageElement } {
    const b = el(kind === "row" ? "button" : "div", "fi-tile");
    if (b instanceof HTMLButtonElement) b.type = "button";
    b.dataset.id = key;
    const frame = el("div", "fi-thumb");
    const img = el("img");
    img.alt = "";
    img.decoding = "async";
    img.addEventListener("error", () => { img.hidden = true; frame.classList.add("none"); });
    // Shown whenever there's no picture: a page and the file's extension.
    const glyph = el("span", "fi-glyph");
    glyph.append(bigIcon("notes"), el("span", "fi-ext", typeMark(name, mime)));
    frame.append(img, glyph);
    if (badge) frame.append(el("span", `fi-badge ${badgeClass}`, badge));
    b.append(frame, el("span", "fi-cap", text));
    return { node: b, img };
  }

  function waitingTile(w: WaitingView): HTMLElement {
    const label = w.state === "failed" ? refusalText(w.failed) : w.state === "uploading" ? "Uploading" : "Waiting to upload";
    const { node, img } = tile("waiting", w.id, w.mime, w.name, w.name, label, w.state === "failed" ? "bad" : "work");
    if (drawable(w.mime)) thumbs.show(`local:${w.id}`, img, () => localBlob(w.id));
    else img.hidden = true;
    if (w.state === "failed" || w.state === "waiting") {
      const actions = el("div", "fi-tile-actions");
      if (w.failed !== "too_large") {
        const again = el("button", "", "Try now");
        again.type = "button";
        again.addEventListener("click", () => void fileQueue.retry(w.id));
        actions.append(again);
      }
      const drop = el("button", "", "Delete");
      drop.type = "button";
      let armed = 0;
      drop.addEventListener("click", () => {
        if (!armed) {
          drop.textContent = "Delete for good";
          drop.classList.add("armed");
          armed = window.setTimeout(() => { armed = 0; drop.textContent = "Delete"; drop.classList.remove("armed"); }, ARM_MS);
          return;
        }
        clearTimeout(armed);
        thumbs.drop(`local:${w.id}`);
        void fileQueue.discard(w.id);
      });
      actions.append(drop);
      node.append(actions);
    }
    return node;
  }

  function rowTile(f: FileRow): HTMLElement {
    const badge = f.status === "new" ? "Filing" : f.status === "failed" ? "Couldn't file" : f.sensitive ? "Private" : null;
    const { node, img } = tile("row", f.id, f.mime, f.sensitive ? "" : f.name, caption(f), badge, f.status === "failed" ? "bad" : f.status === "new" ? "work" : "");
    if (f.sensitive || !hasThumb(f)) img.hidden = true;
    else thumbs.show(`thumb:${f.id}:${f.version}`, img, () => fetchBlob(f.id, "thumb"));
    node.addEventListener("click", () => openSheet(f));
    return node;
  }

  function renderWaiting() {
    const q = search.value.trim();
    const w = q || category ? [] : fileQueue.waiting;
    waitingGrid.replaceChildren(...w.map(waitingTile));
    waitingGrid.hidden = !w.length;
    paintNotice();
  }

  function render() {
    renderWaiting();
    const nodes: HTMLElement[] = [];
    let day = "";
    const q = search.value.trim();
    for (const f of items) {
      // By day when browsing; a search is best match first, so days would only scatter it.
      const d = dayText(f.created_at);
      if (!q && d !== day) { day = d; nodes.push(el("div", "fi-day", d)); }
      nodes.push(rowTile(f));
    }
    grid.replaceChildren(...nodes);
    empty.hidden = !(loaded && !items.length && !fileQueue.waiting.length) || (unreachable && !q);
    empty.replaceChildren();
    if (q) empty.append(el("p", "", `Nothing matches "${q}".`));
    else if (category) empty.append(el("p", "", `Nothing in ${categoryLabel(category, true)} yet.`));
    else empty.append(el("p", "d-empty-title", "Nothing yet"), el("p", "", "Take a photo or add one, and it gets read and filed for you."));
    renderChips();
    clearTimeout(pollTimer);
    if (items.some((f) => f.status === "new")) pollTimer = window.setTimeout(() => { if (!sheetClose) void load(); }, FILING_POLL_MS);
  }

  function renderChips() {
    const mk = (c: string | null, text: string) => {
      const b = el("button", c === category ? "fi-chip on" : "fi-chip", text);
      b.type = "button";
      b.setAttribute("aria-pressed", String(c === category));
      b.addEventListener("click", () => { category = c; void load(); });
      return b;
    };
    chips.replaceChildren(mk(null, "All"), ...CATEGORIES.map((c) => mk(c, categoryLabel(c, true))));
    paintEdges();
  }

  function paintNotice() {
    const w = fileQueue.waiting;
    const waiting = w.filter((x) => x.state === "waiting").length;
    const lines: string[] = [];
    if (w.length && !filesDurable()) lines.push("This device can't store files right now, so some are only in memory. Keep this screen open until they're sent.");
    if (waiting) lines.push(`The server isn't reachable. ${waiting === 1 ? "1 file is" : `${waiting} files are`} waiting to upload${filesDurable() ? ", kept on this device" : ""}.`);
    if (unreachable && !waiting) lines.push("Your files aren't reachable right now. Anything new is kept on this device.");
    notice.hidden = !lines.length;
    const text = lines.join(" ");
    if (noticeText.textContent !== text) noticeText.textContent = text;
  }

  async function load(append = false) {
    const mine = ++seq;
    const q = search.value.trim();
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (q) params.set("q", q);
    if (category) params.set("category", category);
    if (append) params.set("offset", String(items.length));
    const res = await request<FileRow[]>(`/api/files?${params}`);
    if (mine !== seq) return;
    loaded = true;
    if (!res.ok) { unreachable = true; render(); return; }
    unreachable = false;
    const seen = new Set(res.ok.map((f) => f.id));
    items = append ? [...items.filter((f) => !seen.has(f.id)), ...res.ok] : res.ok;
    more.hidden = res.ok.length < PAGE;
    render();
  }

  async function loadTrash() {
    const res = await request<FileRow[]>("/api/files?deleted=true&limit=50");
    if (!res.ok) { trashList.replaceChildren(el("div", "d-empty", "Couldn't load these. Try again in a moment.")); return; }
    if (!res.ok.length) { trashList.replaceChildren(el("div", "d-empty", "Nothing here.")); return; }
    trashList.replaceChildren(...res.ok.map((f) => {
      const r = el("div", "d-trash");
      r.append(el("span", "d-note-title", caption(f)));
      const b = el("button", "", "Restore");
      b.type = "button";
      b.addEventListener("click", async () => {
        const back = await request<FileRow>(`/api/files/${f.id}/restore`, { method: "POST" });
        if (!back.ok) { toast(back.why === "added_again" ? "The same file was added again since, so it's already here." : "Couldn't restore that. Try again in a moment."); return; }
        r.remove();
        void load();
      });
      r.append(b);
      return r;
    }));
  }

  // --- A file, opened -----------------------------------------------------------------------------------------------

  function openSheet(f: FileRow) {
    if (sheetClose) return;
    dismissToast();
    const scrim = el("div", "d-scrim");
    const sheet = el("div", "d-sheet fi-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "File");
    const bar = el("header", "d-bar");
    const state = el("span", "d-status", "");
    const del = iconButton("trash", "Delete", () => void remove());
    const done = el("button", "d-done", "Done");
    done.type = "button";
    done.addEventListener("click", () => shut());
    bar.append(state, del, done);

    const frame = el("div", "fi-large");
    const img = el("img");
    img.alt = "";
    frame.append(img);
    const body = el("div", "fi-body");
    sheet.append(bar, frame, body);
    scrim.append(sheet);
    document.body.append(scrim);

    let current = f;
    let open = true;
    let largeUrl: string | null = null;
    let fileUrl: string | null = null;

    const showImage = async () => {
      if (!current.mime.startsWith("image/") && current.mime !== "application/pdf") { frame.hidden = true; return; }
      const b = await fetchBlob(current.id, "large");
      if (!open) return;
      if (!b) { frame.hidden = true; return; }
      largeUrl = URL.createObjectURL(b);
      img.src = largeUrl;
    };

    function line(label: string, value: string, copy = false): HTMLElement {
      const r = el("div", "fi-line");
      r.append(el("span", "fi-label", label));
      const v = el("span", "fi-value", value);
      r.append(v);
      if (copy) {
        const c = el("button", "fi-copy", "Copy");
        c.type = "button";
        c.setAttribute("aria-label", `Copy ${label}`);
        c.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(value); c.textContent = "Copied"; } catch { c.textContent = "Couldn't copy"; }
          setTimeout(() => { c.textContent = "Copy"; }, 1500);
        });
        r.append(c);
      }
      return r;
    }

    function paint() {
      const f = current;
      body.replaceChildren();
      const title = el("div", "fi-title", f.name || "Untitled");
      body.append(title);
      if (f.status === "new") body.append(el("p", "fi-state work", "Filing: the server is reading this."));
      if (f.status === "failed") {
        const p = el("div", "fi-state bad");
        p.append(el("span", "", "Couldn't file this."));
        const again = el("button", "", "Try again");
        again.type = "button";
        again.addEventListener("click", async () => {
          const res = await request<FileRow>(`/api/files/${f.id}/retry`, { method: "POST" });
          if (!res.ok) { toast("Couldn't ask for that. Try again in a moment."); return; }
          remember(res.ok);
        });
        p.append(again);
        body.append(p);
      }
      if (f.description) body.append(el("p", "fi-desc", f.description));
      const ids = Array.isArray(f.identifiers) ? f.identifiers : [];
      for (const i of ids) {
        const label = `${kindLabel(String(i.kind))}${i.label ? ` · ${i.label}` : ""}`;
        const r = line(label, String(i.value), true);
        r.classList.add("fi-id");
        if (i.verified === false) r.append(el("span", "fi-unsure", "Might be misread: check the photo"));
        if (i.verified === true && i.kind === "vin") r.append(el("span", "fi-sure", "Check digit OK"));
        body.append(r);
      }

      // Category: one tap to change.
      const catRow = el("label", "fi-line");
      catRow.append(el("span", "fi-label", "Category"));
      const sel = el("select", "fi-select");
      if (!f.category) sel.append(new Option("Not filed yet", "", true, true));
      for (const c of CATEGORIES) sel.append(new Option(categoryLabel(c), c, false, c === f.category));
      sel.addEventListener("change", () => { if (sel.value) void change({ category: sel.value }); });
      catRow.append(sel);
      body.append(catRow);

      const priv = el("label", "fi-line fi-check");
      const box = el("input");
      box.type = "checkbox";
      box.checked = f.sensitive;
      box.addEventListener("change", () => void change({ sensitive: box.checked }));
      priv.append(box, el("span", "", `Private: ${ASSISTANT_NAME} sees only that it exists`));
      body.append(priv);

      const meta: string[] = [];
      if (f.taken_at) meta.push(`Taken ${whenText(f.taken_at)}`);
      meta.push(`Added ${whenText(f.created_at)}`, sizeText(f.bytes));
      body.append(el("p", "fi-meta", meta.join(" · ")));

      if (f.ocr_text?.trim()) {
        const t = el("details", "fi-text");
        t.open = f.category === "document" || f.category === "receipt";
        const s = el("summary", "", "Text read from it");
        const pre = el("pre", "", f.ocr_text);
        const c = el("button", "fi-copy", "Copy text");
        c.type = "button";
        c.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(f.ocr_text ?? ""); c.textContent = "Copied"; } catch { c.textContent = "Couldn't copy"; }
        });
        t.append(s, pre, c);
        body.append(t);
      }

      const actions = el("div", "fi-actions");
      const rename = el("button", "", "Rename");
      rename.type = "button";
      rename.addEventListener("click", () => startRename(title));
      const orig = el("button", "", "Original");
      orig.type = "button";
      orig.addEventListener("click", () => void openOriginal(orig));
      actions.append(rename, orig);
      body.append(actions);
    }

    function startRename(title: HTMLElement) {
      const input = el("input", "fi-rename");
      input.value = current.name;
      input.setAttribute("aria-label", "Name");
      const commit = () => {
        const v = input.value.trim();
        if (v && v !== current.name) void change({ name: v });
        else paint();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") { e.preventDefault(); paint(); } });
      input.addEventListener("blur", commit);
      title.replaceWith(input);
      input.focus();
      input.select();
    }

    async function openOriginal(b: HTMLButtonElement) {
      b.disabled = true;
      b.textContent = "Opening";
      const blob = await fetchBlob(current.id, "original");
      b.disabled = false;
      b.textContent = "Original";
      if (!blob || !open) { if (!blob) toast("Couldn't get the original. Try again in a moment."); return; }
      if (fileUrl) URL.revokeObjectURL(fileUrl);
      fileUrl = URL.createObjectURL(blob);
      const a = el("a");
      a.href = fileUrl;
      a.download = current.name || "file";
      a.rel = "noopener";
      document.body.append(a);
      a.click();
      a.remove();
    }

    function remember(r: FileRow) {
      current = r;
      items = items.map((i) => (i.id === r.id ? r : i));
      if (open) paint();
      render();
    }

    async function change(p: { name?: string; category?: string; sensitive?: boolean }) {
      state.textContent = "Saving";
      const res = await request<FileRow>(`/api/files/${current.id}`, jsonInit("PATCH", { version: current.version, ...p }));
      if (res.ok) { state.textContent = "Saved"; remember(res.ok); return; }
      if (res.fail === "conflict" && res.current) {
        // Only the filer or another device changed it meanwhile: take theirs, then put the owner's change on top.
        if (res.current.deleted_at) { state.textContent = "Deleted on another device"; return; }
        current = res.current;
        const again = await request<FileRow>(`/api/files/${current.id}`, jsonInit("PATCH", { version: current.version, ...p }));
        if (again.ok) { state.textContent = "Saved"; remember(again.ok); return; }
      }
      state.textContent = "Couldn't save";
      toast("Couldn't save that. Try again in a moment.");
      paint();
    }

    async function remove() {
      const res = await request<FileRow>(`/api/files/${current.id}`, { method: "DELETE" });
      if (!res.ok) { toast("Couldn't delete this. Try again in a moment."); return; }
      const id = current.id;
      items = items.filter((i) => i.id !== id);
      shut();
      render();
      toast("File deleted", {
        label: "Undo",
        run: async () => {
          const back = await request<FileRow>(`/api/files/${id}/restore`, { method: "POST" });
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
      if (largeUrl) URL.revokeObjectURL(largeUrl);
      if (fileUrl) URL.revokeObjectURL(fileUrl);
      sheetClose = null;
    }

    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); shut(); } };
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", (e) => { if (e.target === scrim) shut(); });
    sheetClose = shut;
    paint();
    if (!f.sensitive) void showImage();
    else {
      // A private one shows its picture only when the owner asks, so it isn't on screen just from opening it.
      const show = el("button", "fi-reveal", "Show the photo");
      show.type = "button";
      show.addEventListener("click", () => { show.remove(); void showImage(); });
      frame.append(show);
    }
    void request<FileRow>(`/api/files/${f.id}`).then((res) => {
      if (!open) return;
      if (res.ok) remember(res.ok);
      else if (res.fail === "gone") { shut(); items = items.filter((i) => i.id !== f.id); render(); toast("That file is gone. It may have been deleted on another device."); }
    });
  }

  // --- Wiring -------------------------------------------------------------------------------------------------------

  more.addEventListener("click", () => void load(true));
  trash.addEventListener("toggle", () => { if (trash.open) void loadTrash(); });
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  search.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void load(), 250);
  });

  const off = onFiles({
    changed: () => renderWaiting(),
    uploaded: (row, localId) => {
      thumbs.drop(`local:${localId}`);
      if (!search.value.trim() && !category && !items.some((i) => i.id === row.id) && !row.deleted_at) items = [row, ...items];
      render();
    },
  });
  const stopFresh = whenFresh(() => { if (!sheetClose) void load(); });

  render();
  paintShooting();
  void fileQueue.refresh().catch(() => {});
  void load();
  fileQueue.kick();

  return () => {
    off();
    edgeWatch.disconnect();
    stopFresh();
    stopKeyboard();
    clearTimeout(pollTimer);
    if (searchTimer) clearTimeout(searchTimer);
    sheetClose?.();
    thumbs.close();
  };
}
