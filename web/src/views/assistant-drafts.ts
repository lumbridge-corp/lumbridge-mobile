// The top of the assistant's tab: what it has drafted and is waiting on you for. Nothing happens until you approve it, and you
// can see every word, and must have, for anything outward-facing. A card starts short: its heading, why, and the first few
// lines with how much more there is; Read all opens it in place. Approve sends something real on your behalf and lists move
// under a thumb, so it takes two taps, as in choices.ts, open or not; for what leaves your hands (OUTWARD_KINDS) the first tap
// on a card you haven't opened opens it instead. On a device the assistant can operate there's no Approve to press, only words saying
// where it can be: the gateway would refuse it there. Text from the file only ever goes in through textContent.
import { el } from "../dom";
import {
  ELSEWHERE_WORDS, OFFLINE_WORDS, UNREACHABLE_WORDS, approveLabel, armedLabel, draftTag, isOutward, moreWords, outcomeWords, previewOf, readFirstWords,
  refusalWords, startedWords, titleOf, visibleText, type Draft,
} from "../drafts-logic";
import { currentNeeds, decideDraft, draftState, onNeeds, refreshNeeds, refusalOf, setNeedsInView, type Needs } from "../drafts-store";
import { updateAppBadge } from "../notify";
import "./assistant-drafts.css";
import { ASSISTANT_NAME } from "../ns";

const ARM_MS = 3000;
const FOLLOW_EVERY_MS = 3000;
/** The approve command gives a send 210 s to find a pause, and a worker about as long to come up. */
const FOLLOW_FOR_MS = 300_000;
const DONE_STAYS_MS = 3500;

export interface DraftCard {
  draft: Draft;
  /** Built with an Approve button: this device isn't one the assistant can operate. */
  here: boolean;
  root: HTMLElement;
  /** Past asking: stays until it's said how it went, whatever the list says. */
  decided: boolean;
  stop: () => void;
}

export interface DraftCardHooks {
  /** Approve can work from this device (`approveHere`). */
  here: boolean;
  /** False once the screen holding it has gone. */
  live: () => boolean;
  /** It has said how it went and can leave. */
  gone: () => void;
  /** The words changed under it: the card that replaces it should carry this note. */
  changed: (note: string) => void;
  /** Without its own heading, for a list that already shows `titleOf`. */
  bare?: boolean;
  /** A note it starts with, carried over from the card it replaces. */
  note?: string;
  /** Which cards are open and which have been read in full, kept by the list while it's on screen. */
  memory?: DraftMemory;
}

/** Per draft id, the digest of the words that were open, and that were read in full: new words start again, closed and unread. */
export interface DraftMemory { open: Map<string, string>; read: Map<string, string> }
export const draftMemory = (): DraftMemory => ({ open: new Map(), read: new Map() });

let nextTextId = 0;

/** A text that starts as its first few lines and opens in place. Shared by every card that asks the owner to read before deciding. */
export function readAll(full: string, o: { className: string; scroll?: boolean; label?: string; open: boolean; opened: (open: boolean) => void }) {
  const preview = previewOf(full);
  const text = el("pre", o.className);
  text.id = `ppd-text-${++nextTextId}`;
  const more = el("div", "ppd-more");
  const toggle = el("button", "ppd-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-controls", text.id);
  const count = el("span", "ppd-count", moreWords(preview));
  more.append(toggle, count);
  let isOpen = false;
  const show = (open: boolean) => {
    isOpen = open || preview.whole;
    text.textContent = visibleText(isOpen ? full : preview.text);
    text.classList.toggle("ppd-cut", !isOpen);
    // A long text scrolls in its own box once open, every word still there, so the buttons stay in reach.
    text.classList.toggle("ppd-scroll", !!o.scroll && isOpen);
    if (o.scroll && isOpen) { text.tabIndex = 0; if (o.label) text.setAttribute("aria-label", o.label); }
    else { text.removeAttribute("tabindex"); text.removeAttribute("aria-label"); }
    toggle.textContent = isOpen ? "Show less" : "Read all";
    toggle.setAttribute("aria-expanded", String(isOpen));
    count.hidden = isOpen;
    o.opened(isOpen);
  };
  if (!preview.whole) {
    toggle.onclick = () => show(!isOpen);
    // The words are a big target too, but not one a screen reader needs: the button says the same. Selecting text isn't a tap.
    text.classList.add("ppd-tappable");
    text.onclick = () => { if (!window.getSelection()?.toString()) show(!isOpen); };
  }
  show(o.open);
  return {
    text, whole: preview.whole,
    /** Only when there's more to read; a short text has no control. */
    more: preview.whole ? null : more,
    isOpen: () => isOpen,
    show,
    /** The heading: a tap on it does what Read all does. */
    target: (node: HTMLElement) => { if (!preview.whole) { node.classList.add("ppd-tappable"); node.onclick = () => show(!isOpen); } },
  };
}

const closeNotification = async (d: Draft) => {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    for (const n of (await reg?.getNotifications?.({ tag: draftTag(d.id) })) ?? []) n.close();
  } catch { /* it closes on the next sweep */ }
};

/** One draft, its words and its two buttons. The only way the app approves or rejects anything: the assistant's tab and For you in
 * Tasks (for-you.ts) both use it. */
export function draftCard(d: Draft, on: DraftCardHooks): DraftCard {
  const live = on.live;
  const card = el("article", "ppd-card");
  card.dataset.id = d.id;
  const heading = on.bare ? null : el("h3", "ppd-to", visibleText(titleOf(d)));
  if (heading) card.append(heading);
  // An issue's title is filed as written, and a Story's card and hash are what gets posted, so they're read like the body:
  // in full, nothing hidden, and not dimmed.
  const plain = d.kind === "issue" || d.kind === "ig_post";
  card.append(el("p", plain ? "ppd-detail ppd-title" : "ppd-detail", visibleText(d.detail)));
  if (d.why) card.append(el("p", "ppd-why", `${ASSISTANT_NAME}: ${d.why}`));
  // A resume change can run to pages: open, it scrolls in its own box.
  const memory = on.memory ?? draftMemory();
  const words = readAll(d.text, {
    className: "ppd-text", scroll: d.kind === "resume", label: "Every change, in full",
    open: memory.open.get(d.id) === d.digest,
    opened: (open) => {
      if (open) { memory.open.set(d.id, d.digest); memory.read.set(d.id, d.digest); } else memory.open.delete(d.id);
    },
  });
  if (heading) words.target(heading);
  card.append(words.text);
  if (words.more) card.append(words.more);
  const note = el("p", "ppd-note");
  note.setAttribute("role", "status");
  note.hidden = true;
  const actions = el("div", "ppd-actions");
  const reject = el("button", "ppd-reject", "Reject");
  const approve = el("button", "ppd-approve", approveLabel(d));
  reject.type = approve.type = "button";
  if (on.here) actions.append(reject, approve);
  else actions.append(el("p", "ppd-elsewhere", ELSEWHERE_WORDS), reject);
  card.append(note, actions);

  let armTimer = 0;
  let followTimer = 0;
  const self: DraftCard = { draft: d, here: on.here, root: card, decided: false, stop: () => { clearTimeout(armTimer); clearTimeout(followTimer); } };

  const say = (words: string, bad = false) => {
    note.textContent = words;
    note.hidden = !words;
    note.classList.toggle("bad", bad);
  };
  const disarm = () => {
    clearTimeout(armTimer);
    armTimer = 0;
    approve.textContent = approveLabel(d);
    approve.classList.remove("armed");
  };
  const leave = (afterMs: number) => {
    followTimer = window.setTimeout(() => { self.decided = false; on.gone(); }, afterMs);
  };

  const finish = (words: string, bad: boolean) => {
    say(words, bad);
    void closeNotification(d);
    if (!bad) { actions.remove(); leave(DONE_STAYS_MS); return; }
    const ok = el("button", "ppd-reject", "OK");
    ok.type = "button";
    ok.onclick = () => leave(0);
    actions.replaceChildren(ok);
    card.append(actions);
  };

  /** After Approve: it started, but only the approve command's own file knows how it ended. */
  const follow = (until: number) => {
    followTimer = window.setTimeout(async () => {
      if (!live()) return;
      if (Date.now() > until) { finish("Still waiting to go. Look at the terminal for how it went.", true); return; }
      if (!document.hidden) {
        try {
          const outcome = outcomeWords(d, await draftState(d.id));
          if (!live()) return;
          if (outcome) { finish(outcome.text, outcome.bad); return; }
        } catch { /* a bad moment on the network: ask again */ }
      }
      follow(until);
    }, FOLLOW_EVERY_MS);
  };

  const press = async (verdict: "approve" | "reject") => {
    if (navigator.onLine === false) { say(OFFLINE_WORDS, true); return; }
    disarm();
    approve.disabled = reject.disabled = true;
    self.decided = true; // a refresh while this is on its way mustn't take the card from under it
    say(verdict === "approve" ? "Approving…" : "Dropping…");
    try {
      await decideDraft(d, verdict);
    } catch (e) {
      if (!live()) return;
      const code = await refusalOf(e);
      if (!live()) return;
      // It went some other way: say so for a moment, and the list has the last word.
      if (code === "already_handled" || code === "not_pending" || code === "bad_id") {
        finish(refusalWords(code), false);
        void refreshNeeds();
        return;
      }
      self.decided = false;
      approve.disabled = reject.disabled = false;
      if (code === null) { say(UNREACHABLE_WORDS, true); return; }
      // If the list has the new words too, this card is replaced by one with them, and this note moves over.
      if (code === "changed") on.changed(refusalWords(code));
      say(refusalWords(code), true);
      void refreshNeeds();
      return;
    }
    if (!live()) return;
    void refreshNeeds();
    updateAppBadge();
    if (verdict === "reject") { finish(outcomeWords(d, "rejected")!.text, false); return; }
    actions.remove();
    say(startedWords(d));
    follow(Date.now() + FOLLOW_FOR_MS);
  };

  approve.setAttribute("aria-label", d.kind === "send" ? `Approve: send this ${titleOf(d).toLowerCase()}`
    : d.kind === "issue" ? `Approve: file a factory issue on ${d.to}, titled ${visibleText(d.detail)}`
    : d.kind === "ig_post" ? `Approve: post a Story on ${d.to} publicly, card ${visibleText(d.detail)}`
    : d.kind === "resume" ? `Approve: ${visibleText(d.detail).toLowerCase()} in Reactive Resume`
    : d.kind === "service_record" ? `Approve: add this entry to the car service log, ${visibleText(d.to)}`
    : d.kind === "deploy" ? `Approve: ${d.detail === "rollback" ? "roll back" : "deploy"} ${d.to}, live`
    : d.kind === "mail_reply" ? `Send this email reply from ${visibleText(d.to.replace(/^Email reply · /, ""))}`
    : `Approve: ${visibleText(titleOf(d)).toLowerCase()}, ${d.detail}`);
  approve.onclick = () => {
    if (navigator.onLine === false) { say(OFFLINE_WORDS, true); return; }
    if (!armTimer) {
      // Outward-facing: every word on screen once before it can arm. Short ones were from the start.
      if (isOutward(d) && !words.whole && memory.read.get(d.id) !== d.digest) {
        words.show(true);
        say(readFirstWords(d));
        words.text.scrollIntoView({ block: "nearest" });
        return;
      }
      approve.textContent = armedLabel(d);
      approve.classList.add("armed");
      armTimer = window.setTimeout(disarm, ARM_MS);
      return;
    }
    void press("approve");
  };
  reject.setAttribute("aria-label", `Reject this draft: ${titleOf(d).toLowerCase()}`);
  reject.onclick = () => { disarm(); void press("reject"); };

  if (on.note) say(on.note, true);
  return self;
}

export function draftsSection(host: HTMLElement) {
  const root = el("section", "ppd");
  root.setAttribute("aria-label", "Drafts waiting for your OK");
  root.hidden = true;
  const heading = el("h2", "ppd-heading");
  const warn = el("p", "ppd-warn");
  warn.setAttribute("role", "status");
  warn.hidden = true;
  const list = el("div", "ppd-list");
  root.append(heading, warn, list);

  const cards = new Map<string, DraftCard>();
  let live = true;
  let carried: { id: string; note: string } | null = null;
  const memory = draftMemory();

  function build(d: Draft, here: boolean): DraftCard {
    const note = carried?.id === d.id ? carried.note : undefined;
    if (note) carried = null;
    return draftCard(d, {
      here,
      live: () => live,
      gone: () => { cards.get(d.id)?.root.remove(); cards.delete(d.id); paint(currentNeeds()); },
      changed: (text) => { carried = { id: d.id, note: text }; },
      note,
      memory,
    });
  }

  function paint(n: Needs) {
    if (!live) return;
    const waiting = new Map(n.drafts.map((d) => [d.id, d]));
    for (const m of [memory.open, memory.read]) for (const id of m.keys()) if (!waiting.has(id)) m.delete(id);
    for (const [id, card] of cards) {
      const now = waiting.get(id);
      if (card.decided) continue; // saying how it went
      if (!now || now.digest !== card.draft.digest || card.here !== n.approveHere) { card.stop(); card.root.remove(); cards.delete(id); }
    }
    for (const d of n.drafts) if (!cards.has(d.id)) { const c = build(d, n.approveHere); cards.set(d.id, c); list.append(c.root); }

    const count = n.drafts.length;
    heading.textContent = count === 1 ? "1 draft waiting for your OK" : count ? `${count} drafts waiting for your OK` : "Drafts";
    const trouble = n.unreachable && cards.size ? "Can't reach Lumbridge right now. This is the list from before."
      : n.stale ? `${ASSISTANT_NAME}'s watcher has gone quiet, so this list may be behind.` : "";
    warn.textContent = trouble;
    warn.hidden = !trouble;
    const show = cards.size > 0 || !!trouble;
    root.hidden = !show;
    host.classList.toggle("has-drafts", show);
  }

  const off = onNeeds(paint);
  setNeedsInView(true);

  return {
    root,
    stop() {
      live = false;
      off();
      setNeedsInView(false);
      for (const c of cards.values()) c.stop();
    },
  };
}
