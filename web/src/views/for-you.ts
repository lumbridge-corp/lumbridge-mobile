// For you, on Today: everything the assistant needs from you in one list, newest first. Its asks, which you accept, deny
// or reply to, and its drafts, which are the assistant tab's own cards (assistant-drafts.ts) with nothing changed about approving:
// short until opened, and an outward one opened before it arms.
// Made to be used one-handed and while driving: a closed card is one line, one tap opens it, Listen reads it out, and nothing
// plays by itself. An answer that didn't go stays on its card, and a reply is kept on the device until the server has it.
// An ask's words are the assistant's and only ever go in through textContent. An ask with options is answered by ticking some and Pick these,
// or None of these; an option's words can quote a stranger's job posting, so they're text too, and its link only ever https:.
// Under them, Mail: what in your inbox needs you, as the assistant's triage sorted it. Read-only rows of strangers' words, with Done and
// Wrong sort, which only teach the triage. A row's reply draft is shown under it and not again above. Listen isn't offered there.
// Note ideas: notes an agent proposed (data/proposals-logic.ts). Keep makes the note, Edit & keep opens an editor and makes it from
// your text, Drop throws it away. An agent wrote every word, so they're text only, and a link only an https: one, as with an ask.
import { api, ApiError, getJson, token } from "../api";
import {
  answerRefusal, answeredWords, askTag, forYouItems, headline, listenText, parseAsks, replyKey, sameAnswer, statusOf,
  type Ask, type ForYouItem, type Verdict,
} from "../data/asks-logic";
import { visibleText, type Draft } from "../drafts-logic";
import { currentNeeds, onNeeds, refusalOf, setNeedsInView, type Needs } from "../drafts-store";
import { decidedWords, decideRefusal, linkPieces, parseProposals, proposalTag, type DecideFail, type Proposal } from "../data/proposals-logic";
import {
  CATEGORIES, NO_MAIL, mailDraftIds, mailFooter, mailLine, mailRefusal, parseMail, type MailCategory, type MailListing, type MailRow,
} from "../data/mail-logic";
import { el, setOff } from "../dom";
import { icon } from "../icons";
import { iconButton, whenFresh } from "./data-ui";
import { holdToSpeak } from "./hold-to-speak";
import { SpeechQueue, unlockAudio } from "./assistant-audio";
import { draftCard, draftMemory, type DraftCard } from "./assistant-drafts";
import { SentenceSplitter } from "./assistant-logic";
import { ASSISTANT_NAME } from "../ns";

const ASK_EVERY_MS = 30_000;
const DONE_STAYS_MS = 3000;
const ANSWER_TIMEOUT_MS = 20_000;

interface Card {
  item: ForYouItem;
  root: HTMLElement;
  /** On its way or saying how it went: the list mustn't take it away. */
  busy: () => boolean;
  /** For a draft, whether it was built with Approve (`approveHere`). */
  here?: boolean;
  stop: () => void;
}

interface MailCard {
  row: MailRow;
  root: HTMLElement;
  /** What it was built from: the row, the draft under it, and whether Done works here. A change rebuilds it. */
  shape: string;
  busy: () => boolean;
  stop: () => void;
}

function read(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function write(k: string, v: string) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* memory only */ } }

type Sent = { ok: Ask } | { stands: Ask } | { fail: Parameters<typeof answerRefusal>[0] };

async function sendAnswer(id: string, verdict: Verdict, text: string, keys: string[]): Promise<Sent> {
  if (navigator.onLine === false) return { fail: "offline" };
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ANSWER_TIMEOUT_MS);
  try {
    const res = await api(`/api/asks/${encodeURIComponent(id)}/answer`, {
      method: "POST", signal: c.signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify(verdict === "reply" ? { verdict, text } : verdict === "pick" ? { verdict, keys } : { verdict }),
    });
    return { ok: (await res.json()) as Ask };
  } catch (e) {
    if (!(e instanceof ApiError)) return { fail: "unreachable" };
    const body = (await e.res.clone().json().catch(() => null)) as { error?: string; ask?: Ask } | null;
    if (e.status === 409 && body?.ask) return { stands: body.ask };
    if (e.status === 403 && body?.error === "not_from_here") return { fail: "not_from_here" };
    if (e.status === 404) return { fail: "gone" };
    if (e.status === 400 || e.status === 422) return { fail: "rejected" };
    if (e.status >= 500) return { fail: "server" };
    return { fail: "other" };
  } finally {
    clearTimeout(t);
  }
}

type Decided = { ok: { proposal: Proposal; note: { id: string } | null } } | { stands: Proposal } | { fail: DecideFail };

async function sendDecision(p: Proposal, decision: "accept" | "deny", edit?: { title: string; body: string }): Promise<Decided> {
  if (navigator.onLine === false) return { fail: "offline" };
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ANSWER_TIMEOUT_MS);
  try {
    const res = await api(`/api/note-proposals/${encodeURIComponent(p.id)}/decide`, {
      method: "POST", signal: c.signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, version: p.version, ...(edit ?? {}) }),
    });
    const body = (await res.json()) as { proposal: Proposal; note: { id: string } | null };
    return { ok: body };
  } catch (e) {
    if (!(e instanceof ApiError)) return { fail: "unreachable" };
    const body = (await e.res.clone().json().catch(() => null)) as { error?: string; proposal?: Proposal } | null;
    if (e.status === 409 && body?.proposal) return { stands: body.proposal };
    if (e.status === 403 && body?.error === "not_from_here") return { fail: "not_from_here" };
    if (e.status === 404) return { fail: "gone" };
    if (e.status === 400 || e.status === 422) return { fail: "rejected" };
    if (e.status >= 500) return { fail: "server" };
    return { fail: "other" };
  } finally {
    clearTimeout(t);
  }
}

/** An agent's words, as text, with its https: links as links and nothing else. */
function linked(text: string): Node[] {
  return linkPieces(visibleText(text)).map((piece) => {
    if (!("href" in piece)) return document.createTextNode(piece.text);
    const a = el("a", "fy-link", piece.text);
    a.href = piece.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  });
}

/** Opens the note in Notes: the editor there opens what history says, and Back comes here again. */
function openNote(id: string) {
  location.hash = "#/notes";
  history.replaceState({ note: id }, "", location.href);
}

async function closeNotification(tag: string) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    for (const n of (await reg?.getNotifications?.({ tag })) ?? []) n.close();
  } catch { /* the next sweep has it */ }
}

/** `shown`: after each paint, whether there's anything at all; `loaded`: the first ask has come back. So Today can say when nothing needs the owner. */
export function forYouSection(on: { shown?: (any: boolean) => void; loaded?: () => void } = {}) {
  const root = el("section", "fy");
  root.setAttribute("aria-label", `For you: what ${ASSISTANT_NAME} needs from you`);
  root.hidden = true;
  const head = el("h2", "fy-heading");
  const label = el("span", "", "For you");
  const count = el("span", "fy-count");
  head.append(label, count);
  const warn = el("p", "fy-warn");
  warn.setAttribute("role", "status");
  warn.hidden = true;
  const list = el("div", "fy-list");
  const mailBox = el("div", "fy-mail");
  mailBox.setAttribute("role", "group");
  mailBox.setAttribute("aria-label", "Mail that needs you");
  const mailHead = el("h3", "fy-mail-heading", "Mail");
  const mailWarn = el("p", "fy-warn");
  mailWarn.setAttribute("role", "status");
  const mailList = el("div", "fy-list");
  const mailFoot = el("p", "fy-mail-foot");
  mailBox.append(mailHead, mailWarn, mailList, mailFoot);
  root.append(head, warn, list, mailBox);

  let live = true;
  let asks: Ask[] = [];
  let asksTrouble = false;
  let proposals: Proposal[] = [];
  let proposalsTrouble = false;
  let needs: Needs = currentNeeds();
  const cards = new Map<string, Card>();
  let mail: MailListing = NO_MAIL;
  let mailTrouble = false;
  const mailCards = new Map<string, MailCard>();
  const opened = new Set<string>();
  /** Which drafts are read in full, open or not: kept while For you is on screen, so a rebuilt card is as the owner left it. */
  const draftMem = draftMemory();
  let carried: { id: string; note: string } | null = null;

  // ---- Listen: one voice at a time, and only when the owner asks ----

  let speaking: { key: string; queue: SpeechQueue; button: HTMLButtonElement } | null = null;
  const stopSpeaking = () => {
    if (!speaking) return;
    speaking.queue.cancel();
    speaking.button.textContent = "Listen";
    speaking.button.setAttribute("aria-pressed", "false");
    speaking.button.classList.remove("on");
    speaking = null;
  };
  function listen(key: string, text: string, button: HTMLButtonElement, say: (m: string, bad?: boolean) => void) {
    if (speaking?.key === key) { stopSpeaking(); return; }
    stopSpeaking();
    unlockAudio(); // in the tap itself: iOS plays nothing otherwise
    const splitter = new SentenceSplitter();
    const sentences = [...splitter.push(text), ...splitter.flush()];
    if (!sentences.length) { say("There's nothing here to read out."); return; }
    const queue = new SpeechQueue(
      async (sentence, signal) => (await api("/api/voice/speak", {
        method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: sentence }),
      })).arrayBuffer(),
      {
        started: () => {},
        idle: () => { if (speaking?.queue === queue) stopSpeaking(); },
        failed: (status) => {
          if (speaking?.queue === queue) stopSpeaking();
          say(status ? `${ASSISTANT_NAME}'s voice isn't available right now. The words are all here.` : "Couldn't reach Lumbridge to read this out.", true);
        },
        blocked: () => say("Tap Listen again to hear it."),
      },
    );
    speaking = { key, queue, button };
    button.textContent = "Stop";
    button.setAttribute("aria-pressed", "true");
    button.classList.add("on");
    for (const s of sentences) queue.say(s);
  }

  // ---- one card ----

  function shell(item: ForYouItem) {
    const card = el("article", `fy-card fy-${item.kind}`);
    card.dataset.key = item.key;
    card.dataset.id = item.kind === "ask" ? item.ask.id : item.kind === "proposal" ? item.proposal.id : item.draft.id;
    const top = el("button", "fy-head");
    top.type = "button";
    const { kind, title } = headline(item);
    const line = el("span", "fy-title", visibleText(title));
    top.append(el("span", "fy-kind", kind), line);
    const body = el("div", "fy-body");
    const note = el("p", "fy-note");
    note.setAttribute("role", "status");
    note.hidden = true;
    const say = (words: string, bad = false) => { note.textContent = words; note.hidden = !words; note.classList.toggle("bad", bad); };
    const tools = el("div", "fy-tools");
    const hear = el("button", "fy-listen", "Listen");
    hear.type = "button";
    hear.setAttribute("aria-pressed", "false");
    hear.setAttribute("aria-label", `Listen: ${title}`);
    hear.onclick = () => listen(item.key, listenText(item), hear, say);
    tools.append(hear);
    const show = (open: boolean) => {
      card.classList.toggle("open", open);
      top.setAttribute("aria-expanded", String(open));
      body.hidden = !open;
      if (open) opened.add(item.key); else opened.delete(item.key);
    };
    top.onclick = () => show(!card.classList.contains("open"));
    card.append(top, body);
    show(opened.has(item.key));
    return { card, body, note, say, tools, hear };
  }

  function askCard(item: Extract<ForYouItem, { kind: "ask" }>): Card {
    const a = item.ask;
    const { card, body, note, say, tools } = shell(item);
    const full = el("h3", "fy-full-title", visibleText(a.title));
    body.append(full);
    if (a.body.trim()) {
      const text = el("pre", "fy-text");
      text.textContent = visibleText(a.body);
      body.append(text);
    }
    const options = a.options;
    const ticks: HTMLInputElement[] = [];
    if (options) {
      const rows = el("ul", "fy-options");
      rows.setAttribute("aria-label", `Pick from: ${a.title}`);
      for (const o of options) {
        const row = el("li", "fy-option");
        row.dataset.key = o.key;
        const pick = el("label", "fy-option-pick");
        const tick = el("input", "fy-tick");
        tick.type = "checkbox";
        tick.value = o.key;
        const words = el("span", "fy-option-words");
        words.append(el("strong", "fy-option-label", visibleText(o.label)));
        if (o.detail.trim()) words.append(el("span", "fy-option-detail", visibleText(o.detail)));
        pick.append(tick, words);
        row.append(pick);
        if (o.link) {
          const open = el("a", "fy-option-link", "Open posting");
          open.href = o.link;
          open.target = "_blank";
          open.rel = "noopener noreferrer";
          open.setAttribute("aria-label", `Open posting: ${o.label}`);
          row.append(open);
        }
        ticks.push(tick);
        rows.append(row);
      }
      body.append(rows);
    }
    body.append(tools, note);

    const actions = el("div", "fy-actions");
    const deny = el("button", "fy-deny", options ? "None of these" : "Deny");
    const replyBtn = el("button", "fy-reply-open", "Reply");
    const accept = el("button", "fy-accept", options ? "Pick these" : "Accept");
    for (const b of [deny, replyBtn, accept]) b.type = "button";
    actions.append(deny, replyBtn, accept);
    const ticked = () => ticks.filter((t) => t.checked).map((t) => t.value);
    // Pick these says which, so it waits for one.
    const pickable = () => { if (options) setOff(accept, busy || ticked().length === 0); };
    for (const t of ticks) t.addEventListener("change", pickable);

    const replyBox = el("div", "fy-replybox");
    replyBox.hidden = true;
    const words = el("textarea", "fy-reply");
    words.rows = 3;
    words.placeholder = "Your reply. Hold the mic to say it.";
    words.setAttribute("aria-label", `Your reply to: ${a.title}`);
    words.value = read(replyKey(a.id)) ?? "";
    const talk = el("button", "fy-talk", "Hold to talk");
    talk.type = "button";
    talk.setAttribute("aria-label", "Hold to say your reply");
    const send = el("button", "fy-send", "Send reply");
    send.type = "button";
    const replyRow = el("div", "fy-reply-actions");
    replyRow.append(talk, send);
    replyBox.append(words, replyRow);
    body.append(replyBox, actions);
    if (words.value) { replyBox.hidden = false; replyBtn.classList.add("on"); }

    const keep = () => write(replyKey(a.id), words.value);
    words.addEventListener("input", keep);
    const stopTalk = holdToSpeak(talk, {
      text: (heard) => {
        const before = words.value.trimEnd();
        words.value = before ? `${before} ${heard}` : heard;
        keep();
        say("");
      },
      say: (m) => say(m),
    });

    let busy = false;
    pickable();
    // An answer that didn't go, or wasn't confirmed: the card stays with what the owner said until the owner tries again, even if a refresh says
    // it was answered meanwhile. Trying again then says how it stands.
    let held = false;
    let doneTimer = 0;
    const self: Card = {
      item, root: card,
      busy: () => busy || held,
      stop: () => { clearTimeout(doneTimer); stopTalk(); if (speaking?.key === item.key) stopSpeaking(); },
    };
    const leave = () => {
      doneTimer = window.setTimeout(() => {
        busy = false;
        asks = asks.filter((x) => x.id !== a.id);
        cards.delete(item.key);
        self.stop();
        card.remove();
        paint();
      }, DONE_STAYS_MS);
    };
    const buttons = [deny, replyBtn, accept, send, talk, ...ticks];
    const finish = (words: string, picked?: string[] | null) => {
      write(replyKey(a.id), "");
      say(words);
      actions.remove();
      replyBox.remove();
      // What the owner picked stays ticked and marked; the rest can't be changed now.
      for (const t of ticks) {
        t.checked = !!picked?.includes(t.value);
        t.disabled = true;
        t.closest(".fy-option")?.classList.toggle("picked", t.checked);
      }
      card.classList.add("answered");
      void closeNotification(askTag(a.id));
      leave();
    };

    async function answer(verdict: Verdict) {
      const text = verdict === "reply" ? words.value.trim() : "";
      if (verdict === "reply" && !text) { say("Say or type your reply first.", true); words.focus(); return; }
      const keys = verdict === "pick" ? ticked() : [];
      if (verdict === "pick" && !keys.length) { say("Tick the ones you want first.", true); return; }
      busy = true;
      for (const b of buttons) b.disabled = true;
      say(verdict === "accept" ? "Accepting…" : verdict === "pick" ? "Picking…" : verdict === "deny" ? "Denying…" : "Sending your reply…");
      const sent = await sendAnswer(a.id, verdict, text, keys);
      if (!live) return;
      const wordsOf = (x: Ask) => answeredWords(x.status, x.reply, { options, keys: x.picked ?? null });
      if ("ok" in sent) { finish(wordsOf(sent.ok), sent.ok.picked); return; }
      if ("stands" in sent) {
        // This device's own answer, retried after the first reply was lost, or one from somewhere else. Either way it stands.
        const stands = sent.stands;
        finish(sameAnswer(stands, verdict, text, keys) ? answeredWords(statusOf(verdict), text || null, { options, keys })
          : `Already answered elsewhere: ${wordsOf(stands)}`, stands.picked);
        return;
      }
      if (sent.fail === "gone") { finish(answerRefusal("gone")); return; }
      busy = false;
      held = true;
      for (const b of buttons) b.disabled = false;
      pickable();
      say(answerRefusal(sent.fail), true);
    }

    accept.onclick = () => void answer(options ? "pick" : "accept");
    deny.onclick = () => void answer("deny");
    replyBtn.onclick = () => {
      replyBox.hidden = !replyBox.hidden;
      replyBtn.classList.toggle("on", !replyBox.hidden);
      if (!replyBox.hidden) words.focus();
    };
    send.onclick = () => void answer("reply");
    return self;
  }

  function proposalCard(item: Extract<ForYouItem, { kind: "proposal" }>): Card {
    const p = item.proposal;
    const { card, body, note, say, tools } = shell(item);
    body.append(el("h3", "fy-full-title", visibleText(p.title)));
    const text = el("div", "fy-text");
    text.append(...linked(p.body));
    body.append(text);
    const meta = el("dl", "fy-idea-meta");
    const line = (label: string, words: Node[]) => {
      const dd = el("dd");
      dd.append(...words);
      meta.append(el("dt", "", label), dd);
    };
    if (p.why.trim()) line("Why", [document.createTextNode(visibleText(p.why))]);
    if (p.source.trim()) line("Source", linked(p.source));
    line("From", [document.createTextNode(visibleText(p.proposed_by))]);
    body.append(meta, tools, note);

    const actions = el("div", "fy-actions");
    const drop = el("button", "fy-deny fy-drop", "Drop");
    const edit = el("button", "fy-edit", "Edit & keep");
    const keep = el("button", "fy-accept fy-keep", "Keep");
    for (const b of [drop, edit, keep]) b.type = "button";
    drop.setAttribute("aria-label", `Drop: ${p.title}`);
    keep.setAttribute("aria-label", `Keep as a note: ${p.title}`);
    actions.append(drop, edit, keep);
    body.append(actions);

    let busy = false;
    let held = false;
    let doneTimer = 0;
    let closeEditor: (() => void) | null = null;
    const self: Card = {
      item, root: card,
      busy: () => busy || held || !!closeEditor,
      stop: () => { clearTimeout(doneTimer); closeEditor?.(); if (speaking?.key === item.key) stopSpeaking(); },
    };
    const buttons = [drop, edit, keep];
    const finish = (words: string, noteId: string | null) => {
      say(words);
      actions.remove();
      card.classList.add("answered");
      if (noteId) {
        const open = el("button", "fy-open-note", "Open note");
        open.type = "button";
        open.onclick = () => openNote(noteId);
        const row = el("div", "fy-actions");
        row.append(open);
        body.append(row);
      }
      doneTimer = window.setTimeout(() => {
        busy = false;
        proposals = proposals.filter((x) => x.id !== p.id);
        cards.delete(item.key);
        self.stop();
        card.remove();
        paint();
      }, DONE_STAYS_MS);
    };

    /** Sends it, and says how it went. True when it's decided, here or before. */
    async function decide(decision: "accept" | "deny", words: { title: string; body: string } | undefined, tell: (m: string, bad?: boolean) => void): Promise<{ note: string | null } | null> {
      busy = true;
      for (const b of buttons) b.disabled = true;
      const sent = await sendDecision(p, decision, words);
      if (!live) return null;
      if ("ok" in sent) {
        const noteId = sent.ok.note?.id ?? null;
        finish(noteId ? "Kept in Notes." : "Dropped.", noteId);
        return { note: noteId };
      }
      if ("stands" in sent) {
        // This device's own decision, retried after the first answer was lost, or one made somewhere else. Either way it stands.
        const s = sent.stands;
        const mine = (decision === "accept") === (s.status === "accepted");
        finish(mine ? (s.note_id ? "Kept in Notes." : "Dropped.") : decidedWords(s.status), s.note_id);
        return { note: s.note_id };
      }
      if (sent.fail === "gone") { finish(decideRefusal("gone"), null); return null; }
      busy = false;
      held = true;
      for (const b of buttons) b.disabled = false;
      tell(decideRefusal(sent.fail), true);
      return null;
    }

    keep.onclick = () => { say("Keeping…"); void decide("accept", undefined, say); };
    drop.onclick = () => { say("Dropping…"); void decide("deny", undefined, say); };
    edit.onclick = () => {
      if (closeEditor) return;
      closeEditor = noteEditor(p, async (words, tell) => {
        const done = await decide("accept", words, tell);
        if (done?.note) { closeEditor?.(); openNote(done.note); }
        return !!done;
      }, () => { closeEditor = null; });
    };
    return self;
  }

  /** The note editor, full screen, filled with the proposal. Keep there makes the note from what it holds; Back leaves it as it was. */
  function noteEditor(p: Proposal, save: (words: { title: string; body: string }, tell: (m: string, bad?: boolean) => void) => Promise<boolean>, closed: () => void): () => void {
    const box = el("div", "d-editor fy-idea-editor");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", `Edit and keep: ${p.title}`);
    const bar = el("header", "d-bar");
    const back = iconButton("back", "Back without keeping", () => close());
    const status = el("span", "d-status", "Edit, then Keep");
    status.setAttribute("aria-live", "polite");
    const keep = el("button", "fy-editor-keep", "Keep");
    keep.type = "button";
    bar.append(back, status, keep);
    const page = el("div", "d-page");
    const title = el("input", "d-title");
    title.setAttribute("aria-label", "Title");
    title.maxLength = 1000;
    title.value = p.title;
    const words = el("textarea", "d-body");
    words.setAttribute("aria-label", "Note");
    words.value = p.body;
    page.append(title, words);
    box.append(bar, page);
    document.body.append(box);
    const tell = (m: string, bad = false) => { status.textContent = m; status.classList.toggle("rejected", bad); };
    let open = true;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    // Leaving Tasks (Back, a link) takes the editor with it.
    const onHash = () => close();
    document.addEventListener("keydown", onKey);
    window.addEventListener("hashchange", onHash);
    function close() {
      if (!open) return;
      open = false;
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("hashchange", onHash);
      box.remove();
      closed();
    }
    keep.onclick = async () => {
      keep.disabled = true;
      tell("Keeping…");
      const done = await save({ title: title.value, body: words.value }, tell);
      if (!done && open) keep.disabled = false;
      if (done) close();
    };
    words.focus();
    return close;
  }

  function draftItemCard(item: Extract<ForYouItem, { kind: "draft" }>): Card {
    const d: Draft = item.draft;
    const { card, body, note, tools } = shell(item);
    const noteText = carried?.id === d.id ? carried.note : undefined;
    if (noteText) carried = null;
    const here = needs.approveHere;
    const inner: DraftCard = draftCard(d, {
      here,
      live: () => live,
      bare: true,
      note: noteText,
      memory: draftMem,
      gone: () => { if (cards.get(item.key)?.root === card) cards.delete(item.key); self.stop(); card.remove(); paint(); },
      changed: (text) => { carried = { id: d.id, note: text }; },
    });
    // Listen's own words go above the draft's, which keep their order: the words, then the buttons.
    body.append(tools, note, inner.root);
    const self: Card = {
      item, root: card, here,
      busy: () => inner.decided,
      stop: () => { inner.stop(); if (speaking?.key === item.key) stopSpeaking(); },
    };
    return self;
  }

  // ---- mail ----

  const mailDraft = (row: MailRow) => (row.draft ? needs.drafts.find((d) => d.id === row.draft) : undefined);
  const mailShape = (row: MailRow) => JSON.stringify([row, mailDraft(row)?.digest ?? null, needs.approveHere]);

  async function teach(key: string, path: "dismiss" | "sort", category?: MailCategory): Promise<string | true> {
    if (navigator.onLine === false) return "offline";
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ANSWER_TIMEOUT_MS);
    try {
      await api(`/api/mail/${encodeURIComponent(key)}/${path}`, {
        method: "POST", signal: c.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(category ? { category } : {}),
      });
      return true;
    } catch (e) {
      return (await refusalOf(e)) ?? "unreachable";
    } finally {
      clearTimeout(t);
    }
  }

  function mailCard(row: MailRow): MailCard {
    const here = needs.approveHere;
    const card = el("article", `fy-card fy-mail-row${row.suspicious ? " suspicious" : ""}`);
    card.dataset.key = row.key;
    const top = el("div", "fy-mail-top");
    top.append(el("span", "fy-kind", row.kind === "invite" ? "Invite" : "Mail"));
    if (row.sensitive) {
      const lock = icon("lock", "fy-lock");
      lock.setAttribute("role", "img");
      lock.setAttribute("aria-label", "Sensitive: only why is shown");
      top.append(lock);
    }
    if (row.suspicious) top.append(el("span", "fy-chip-suspicious", "suspicious"));
    card.append(top);
    const line = mailLine(row);
    if (line) card.append(el("p", "fy-mail-line", visibleText(line)));
    card.append(el("p", "fy-mail-why", visibleText(row.why)));
    const note = el("p", "fy-note");
    note.setAttribute("role", "status");
    note.hidden = true;
    const say = (words: string, bad = false) => { note.textContent = words; note.hidden = !words; note.classList.toggle("bad", bad); };

    let busy = false;
    let leaveTimer = 0;
    let inner: DraftCard | null = null;
    const self: MailCard = {
      row, root: card, shape: mailShape(row),
      busy: () => busy || !!inner?.decided,
      stop: () => { clearTimeout(leaveTimer); inner?.stop(); },
    };

    const actions = el("div", "fy-actions");
    const sortBox = el("div", "fy-actions fy-sort");
    sortBox.hidden = true;
    if (here) {
      const done = el("button", "fy-done", "Done");
      const wrong = el("button", "fy-wrong", "Wrong sort");
      done.type = wrong.type = "button";
      done.setAttribute("aria-label", "Done: stop showing this");
      wrong.setAttribute("aria-expanded", "false");
      actions.append(done, wrong);
      const sorts = CATEGORIES.map(({ value, label }) => {
        const b = el("button", "fy-sort-to", label);
        b.type = "button";
        b.dataset.category = value;
        // It's in Needs you now: that one is where it is, not a choice.
        if (value === "needs_you") { b.disabled = true; b.setAttribute("aria-current", "true"); }
        else b.setAttribute("aria-label", `Wrong sort: this is ${label}`);
        return b;
      });
      sortBox.append(...sorts);
      wrong.onclick = () => {
        sortBox.hidden = !sortBox.hidden;
        wrong.classList.toggle("on", !sortBox.hidden);
        wrong.setAttribute("aria-expanded", String(!sortBox.hidden));
      };
      const press = async (path: "dismiss" | "sort", category?: MailCategory) => {
        busy = true;
        const all = [done, wrong, ...sorts.filter((b) => !b.hasAttribute("aria-current"))];
        for (const b of all) b.disabled = true;
        say(path === "dismiss" ? "Marking it done…" : "Moving it…");
        const went = await teach(row.key, path, category);
        if (!live) return;
        if (went !== true) {
          busy = false;
          for (const b of all) b.disabled = false;
          say(mailRefusal(went === "unreachable" ? null : went), true);
          return;
        }
        actions.remove();
        sortBox.remove();
        say(path === "dismiss" ? "Done. It won't be shown again." : `Moved to ${CATEGORIES.find((c) => c.value === category)!.label}. ${ASSISTANT_NAME} will sort like that next time.`);
        leaveTimer = window.setTimeout(() => {
          busy = false;
          mail = { ...mail, rows: mail.rows.filter((r) => r.key !== row.key) };
          mailCards.delete(row.key);
          self.stop();
          card.remove();
          paint();
        }, DONE_STAYS_MS);
      };
      done.onclick = () => void press("dismiss");
      for (const b of sorts) b.onclick = () => void press("sort", b.dataset.category as MailCategory);
    } else {
      actions.append(el("p", "ppd-elsewhere", `${ASSISTANT_NAME} can operate this device, so Done and Wrong sort work from your other devices.`));
    }
    card.append(note, actions, sortBox);

    // The assistant's reply to it: the draft's own card, with Send, here and nowhere else in For you.
    const d = mailDraft(row);
    if (d) {
      const box = el("div", "fy-mail-draft");
      inner = draftCard(d, {
        here,
        live: () => live,
        gone: () => { box.remove(); inner = null; if (mailCards.get(row.key) === self) mailCards.delete(row.key); self.stop(); card.remove(); paint(); },
        changed: () => {},
        memory: draftMem,
      });
      box.append(inner.root);
      card.append(box);
    }
    return self;
  }

  function paintMail() {
    for (const [key, c] of mailCards) {
      if (c.busy()) continue;
      const now = mail.rows.find((r) => r.key === key);
      if (!now || mailShape(now) !== c.shape) { c.stop(); c.root.remove(); mailCards.delete(key); }
    }
    for (const row of mail.rows) if (!mailCards.has(row.key)) mailCards.set(row.key, mailCard(row));
    const order = [...mailCards.values()].sort((x, y) => y.row.sinceMs - x.row.sinceMs || x.row.key.localeCompare(y.row.key)).map((c) => c.root);
    if (order.some((node, i) => mailList.children[i] !== node) || mailList.children.length !== order.length) mailList.replaceChildren(...order);
    mailFoot.textContent = mail.present ? mailFooter(mail) : "";
    const trouble = mailCards.size && mailTrouble ? "Can't reach Lumbridge right now. This is the mail from before."
      : mailCards.size && mail.stale ? `${ASSISTANT_NAME}'s inbox sorting has stalled, so this may be behind.` : "";
    mailWarn.textContent = trouble;
    mailWarn.hidden = !trouble;
    mailBox.hidden = mailCards.size === 0;
  }

  // ---- the list ----

  function paint() {
    if (!live) return;
    // A row's reply draft is under its row: not here as well.
    const underMail = mailDraftIds(mail);
    const items = forYouItems(asks, needs.drafts.filter((d) => !underMail.has(d.id)), proposals);
    const wanted = new Map(items.map((i) => [i.key, i]));
    for (const [key, card] of cards) {
      if (card.busy()) continue;
      const now = wanted.get(key);
      const changed = now?.kind === "draft" && card.item.kind === "draft" && (now.draft.digest !== card.item.draft.digest || card.here !== needs.approveHere);
      if (!now || changed) { card.stop(); card.root.remove(); cards.delete(key); }
    }
    for (const item of items) {
      if (cards.has(item.key)) continue;
      cards.set(item.key, item.kind === "ask" ? askCard(item) : item.kind === "proposal" ? proposalCard(item) : draftItemCard(item));
    }
    // Newest first. What's leaving keeps its place until it goes.
    const order = [...cards.values()].sort((x, y) => y.item.at - x.item.at || x.item.key.localeCompare(y.item.key)).map((c) => c.root);
    if (order.some((node, i) => list.children[i] !== node)) list.replaceChildren(...order);

    paintMail();
    const waiting = items.length + mailCards.size;
    count.textContent = waiting ? String(waiting) : "";
    head.setAttribute("aria-label", waiting === 1 ? "For you: 1 thing waiting" : `For you: ${waiting} things waiting`);
    const trouble = cards.size && (asksTrouble || proposalsTrouble || needs.unreachable) ? "Can't reach Lumbridge right now. This is the list from before."
      : cards.size && needs.stale ? `${ASSISTANT_NAME}'s watcher has gone quiet, so its drafts here may be behind.` : "";
    warn.textContent = trouble;
    warn.hidden = !trouble;
    root.hidden = cards.size === 0 && mailCards.size === 0;
    on.shown?.(!root.hidden);
  }

  let seq = 0;
  async function load() {
    if (!token()) return;
    const mine = ++seq;
    try {
      const fresh = parseAsks(await getJson<unknown>("/api/asks"));
      if (mine !== seq || !live) return;
      asks = fresh;
      asksTrouble = false;
    } catch (e) {
      if (mine !== seq || !live) return;
      // A gateway from before asks has none to offer. Anything else: keep what the owner can see, and say so.
      if (e instanceof ApiError && e.status === 404) { asks = []; asksTrouble = false; } else asksTrouble = true;
    }
    try {
      const fresh = parseProposals(await getJson<unknown>("/api/note-proposals?status=pending"));
      if (mine !== seq || !live) return;
      proposals = fresh;
      proposalsTrouble = false;
      // None waiting: a "note ideas" notification still showing is out of date.
      if (!fresh.length) void closeNotification(proposalTag);
    } catch (e) {
      if (mine !== seq || !live) return;
      // A gateway or a database from before note proposals has none to offer.
      if (e instanceof ApiError && e.status === 404) { proposals = []; proposalsTrouble = false; } else proposalsTrouble = true;
    }
    try {
      const fresh = parseMail(await getJson<unknown>("/api/mail"));
      if (mine !== seq || !live) return;
      mail = fresh;
      mailTrouble = false;
    } catch (e) {
      if (mine !== seq || !live) return;
      if (e instanceof ApiError && e.status === 404) { mail = NO_MAIL; mailTrouble = false; } else mailTrouble = true;
    }
    paint();
    on.loaded?.();
  }

  const offNeeds = onNeeds((n) => { needs = n; paint(); });
  setNeedsInView(true);
  const stopFresh = whenFresh(() => void load(), ASK_EVERY_MS);
  // A push came in: it may be a new ask or note idea.
  const onPush = (e: MessageEvent) => { if (e.data?.type === "lumbridge-push") void load(); };
  navigator.serviceWorker?.addEventListener("message", onPush);
  void load();

  return {
    root,
    stop() {
      live = false;
      offNeeds();
      setNeedsInView(false);
      stopFresh();
      navigator.serviceWorker?.removeEventListener("message", onPush);
      stopSpeaking();
      for (const c of cards.values()) c.stop();
      for (const c of mailCards.values()) c.stop();
    },
  };
}
