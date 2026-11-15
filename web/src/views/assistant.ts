// The assistant's tab: talk or type, and hear the answer as it is written.

import { apiUrl, store, token } from "../api";
import { el, pressWord, setOff } from "../dom";
import { Mic, SpeechQueue, audioRunning, onAudioStateChange, outputLevel, resetAudio, tryResume, unlockAudio, type MicError } from "./assistant-audio";
import { Endpointer, STARTERS, SentenceSplitter, SseParser, TROUBLE_TEXT, TROUBLE_TONE, TvQueue, awayCard, encodeWav, parseBlocks, parseSpeakers, resample, speakerHint, splitSentence, storedSpeaker, troubleFor, type Away, type Speaker, type SpeakerId, type Trouble } from "./assistant-logic";
import { createOrb, type OrbState } from "./assistant-orb";
import { draftsSection } from "./assistant-drafts";
import { errorSlot, type ErrorOpts } from "./data-ui";
import "./data.css";
import "./assistant.css";
import { ASSISTANT_NAME, HAS_EXT, NS } from "../ns";

const MUTE_KEY = `${NS}.assistant.muted`;
/** What you've typed and not sent, kept on this device: while the assistant is away it waits here, and it survives leaving the tab. */
const TYPED_KEY = `${NS}.assistant.typed`;
/** Per device: where the assistant answers. `phone`, or this one is the remote and it answers on a TV or another speaker. */
const SPEAKER_KEY = `${NS}.assistant.speaker`;
/** Before the picker: "1" was the TV. Read once, so an old setting carries over. */
const TV_KEY = `${NS}.assistant.tv`;
const ASR_RATE = 16000;
/** Hearing exact zeros for this long means a broken route, not a quiet room. */
const SILENT_MIC_MS = 1500;

/** While the assistant can't be reached, every few seconds: `GET /api/assistant/status`, which never fails, so waiting logs nothing. */
const RECHECK_MS = 5000;
const UNREACHABLE = `${ASSISTANT_NAME} is unreachable`;

const STATE_LABEL: Record<OrbState, string> = {
  idle: "Tap to talk", // "Click to talk" with a mouse: see label()
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Tap to interrupt",
  error: "Tap to try again",
};

const label = (s: OrbState) => (s === "idle" ? `${pressWord()} to talk` : STATE_LABEL[s]);

interface ChatMessage { role: "user" | "assistant"; text: string }

class HttpError extends Error {
  constructor(public status: number, public code?: string) { super(`http ${status}`); }
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token() ?? ""}`);
  const res = await fetch(apiUrl(path), { ...init, headers });
  if (!res.ok) {
    let code: string | undefined;
    try { code = (await res.json()).error; } catch { /* no body */ }
    throw new HttpError(res.status, code);
  }
  return res;
}

const icon = (paths: string, cls = "") => {
  const box = el("span", `pp-icon ${cls}`);
  box.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  return box;
};
const SPEAKER = '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a8 8 0 0 1 0 11"/>';
const SPEAKER_OFF = '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z"/><path d="m16 9.5 5 5"/><path d="m21 9.5-5 5"/>';
const PLUS = '<path d="M12 5v14"/><path d="M5 12h14"/>';
const SEND = '<path d="M12 19V6"/><path d="m6 12 6-6 6 6"/>';

function renderInto(box: HTMLElement, text: string) {
  const out: Node[] = [];
  for (const b of parseBlocks(text)) {
    if (b.type === "code") {
      const pre = el("pre");
      pre.textContent = b.text;
      out.push(pre);
      continue;
    }
    const line = el(b.type === "li" ? "div" : "p", b.type === "li" ? "pp-li" : "");
    for (const s of b.spans) {
      if (s.style) line.append(el(s.style === "b" ? "strong" : "code", "", s.text));
      else line.append(document.createTextNode(s.text));
    }
    out.push(line);
  }
  box.replaceChildren(...out);
}

export function assistantView(root: HTMLElement) {
  // ---------------- the screen
  const view = el("div", "assistant empty");
  view.style.setProperty("--assistant-name", JSON.stringify(ASSISTANT_NAME));
  const head = el("header", "pp-head");
  const title = el("h1", "", ASSISTANT_NAME);
  // Where it answers: the phone, the TV, or another speaker the gateway offers. Hidden until the gateway offers something besides the phone.
  const speakerSel = el("select", "pp-speaker") as HTMLSelectElement;
  speakerSel.setAttribute("aria-label", "Where the answer is spoken");
  speakerSel.title = "Where the answer is spoken";
  speakerSel.hidden = true;
  const speakerHintLine = el("p", "pp-speaker-hint");
  speakerHintLine.hidden = true;
  const muteBtn = el("button", "pp-tool");
  const newBtn = el("button", "pp-tool");
  newBtn.type = muteBtn.type = "button";
  newBtn.setAttribute("aria-label", "New conversation");
  newBtn.title = "New conversation";
  const newLabel = el("span", "pp-tool-text");
  newBtn.append(icon(PLUS), newLabel);
  head.append(title, speakerSel, muteBtn, newBtn, speakerHintLine);

  const stage = el("section", "pp-stage");
  const orbBtn = el("button", "pp-orb");
  orbBtn.type = "button";
  const stateLine = el("div", "pp-state");
  stateLine.setAttribute("aria-live", "polite");
  // One place for trouble: the card when the assistant can't be reached, otherwise a line about this turn (the mic, its voice, the TV).
  const notice = errorSlot("pp-notice");
  stage.append(orbBtn, stateLine);

  // Nothing said yet: what it's for, and a few things to ask that its tools really answer.
  const intro = el("section", "pp-intro");
  intro.append(el("p", "pp-intro-line", "Ask about your agents, mail, calendar or machines. Anything it drafts waits for your OK."));
  const starters = el("div", "pp-starters");
  for (const s of STARTERS) {
    const b = el("button", "pp-starter", s.text);
    b.type = "button";
    b.dataset.tool = s.tool;
    b.addEventListener("click", () => { unlockAudio(); if (!unreachable) void send(s.text); });
    starters.append(b);
  }
  intro.append(starters);

  const talk = el("section", "pp-talk");
  const log = el("div", "pp-log");
  log.setAttribute("role", "log");
  const composer = el("form", "pp-composer");
  const input = el("textarea");
  input.rows = 1;
  input.placeholder = `Message ${ASSISTANT_NAME}`;
  input.setAttribute("aria-label", `Message ${ASSISTANT_NAME}`);
  input.setAttribute("enterkeyhint", "send");
  input.autocomplete = "off";
  const sendBtn = el("button", "pp-send");
  sendBtn.type = "submit";
  sendBtn.setAttribute("aria-label", "Send");
  sendBtn.append(icon(SEND));
  composer.append(input, sendBtn);
  talk.append(log, intro, notice.root, composer);
  input.value = store(TYPED_KEY) ?? "";

  const drafts = draftsSection(view);
  view.append(head, drafts.root, stage, talk);
  root.replaceChildren(view);
  const orb = createOrb(orbBtn);
  autosize();

  // ---------------- state
  let state: OrbState = "idle";
  let leaving = false;
  let muted = store(MUTE_KEY) === "1";
  let chosen: SpeakerId = storedSpeaker(store(SPEAKER_KEY), store(TV_KEY));
  /** What the gateway offers (`GET /api/voice/tv`). Until it answers, only the phone. */
  let speakers: Speaker[] = parseSpeakers({ speakers: [] });
  /** Where this turn's voice was meant to go, for the TvQueue's calls and its failure words. */
  let turnTo: SpeakerId = "phone";
  let mic: Mic | null = null;
  let micLevel = 0;
  let turn: AbortController | null = null;
  let turnOpen = false;
  /** A message that didn't get through, to offer again. */
  let lastFailed = "";
  let pendingBlocked = false;
  let historyLoaded = false;
  let unreachable = false;
  /** Why the assistant can't be reached, while it can't. */
  let awayWhy: Away = "assistant";
  /** The line under the card, when it isn't the card. */
  let note: { text: string; retry: boolean; tone: ErrorOpts["tone"] } | null = null;
  let reachTimer = 0;
  let newArmed = 0;
  let audioMarked = false;
  let heardSpeech: () => boolean = () => false;
  const trace: Record<string, number> = {};
  const mark = (name: string) => {
    trace[name] = Math.round(performance.now());
    view.dataset.trace = JSON.stringify(trace);
  };

  function setState(s: OrbState) {
    state = s;
    view.dataset.state = s;
    // Away, the orb is only its outline: there's no one to tap. The card says why, so the line under it stays quiet.
    orb.setState(unreachable ? "error" : s);
    orb.setLevelSource(s === "listening" ? () => micLevel : outputLevel);
    stateLine.textContent = unreachable ? "" : pendingBlocked ? "Tap to hear the answer" : label(s);
    orbBtn.setAttribute("aria-label", unreachable ? UNREACHABLE : pendingBlocked ? `Tap to hear ${ASSISTANT_NAME}` : label(s));
  }

  function paintNotice() {
    if (unreachable) {
      const c = awayCard(awayWhy);
      const retry = c.action === "settings" ? () => { location.hash = "#/settings"; } : tryAgain;
      notice.set(c.what, c.next, { tone: c.tone, retry, label: c.action === "settings" ? "Open Settings" : "Try again" });
    } else if (note) {
      const [what, next] = splitSentence(note.text);
      notice.set(what, next, { tone: note.tone, retry: note.retry ? tryAgain : undefined, label: lastFailed ? "Send again" : "Try again" });
    } else {
      notice.set(null);
    }
    notice.root.querySelector(".d-error-retry")?.classList.add("pp-retry");
    intro.hidden = unreachable;
  }

  function say(text: string, retry = false, tone: ErrorOpts["tone"] = "note") {
    note = text ? { text, retry, tone } : null;
    paintNotice();
  }
  const trouble = (t: Trouble, retry = false) => say(TROUBLE_TEXT[t], retry, TROUBLE_TONE[t]);

  // ---------------- when the assistant can't be reached
  /** A failure that means Hermes isn't there, rather than an answer from it: the orb waits for it instead of inviting a tap. */
  const away = (e: unknown) => !(e instanceof HttpError) || e.code === "assistant_unreachable";

  function setUnreachable(on: boolean, why: Away = "assistant") {
    const was = unreachable;
    unreachable = on;
    if (on) awayWhy = why;
    view.classList.toggle("unreachable", on);
    setOff(orbBtn, on);
    input.placeholder = on ? "Type now, send when it's back" : `Message ${ASSISTANT_NAME}`;
    // Back by itself: the card goes. A message that didn't reach it is offered again; any other line about it is old news.
    if (!on && was) {
      if (lastFailed) say(`${ASSISTANT_NAME} is back. Your last message didn't reach it.`, true, "warn");
      else if (note?.text === TROUBLE_TEXT.assistant) note = null;
    }
    paintNotice();
    if (!on && was && state === "error") setState("idle");
    else setState(state);
    clearTimeout(reachTimer);
    // A device that isn't paired won't become paired by asking again.
    reachTimer = on && why !== "unpaired" && !document.hidden && !leaving ? window.setTimeout(() => void reach(), RECHECK_MS) : 0;
  }

  /** The card's and the line's button: the message that didn't get through, if there is one, otherwise just look again. */
  function tryAgain() {
    unlockAudio();
    if (lastFailed && !unreachable) {
      const last = log.querySelectorAll(".pp-me");
      last[last.length - 1]?.remove();
      void send(lastFailed);
    } else {
      void reach();
    }
  }

  /** Whether it answers, then the conversation if it does. */
  async function reach() {
    clearTimeout(reachTimer);
    reachTimer = 0;
    let ok = false;
    let why: Away = "assistant";
    try {
      ok = ((await (await call("/api/assistant/status")).json()) as { reachable?: boolean }).reachable === true;
    } catch (e) {
      // The gateway answers this with 200 whatever Hermes does, so any other answer came from something in between.
      why = e instanceof HttpError && (e.status === 401 || e.status === 403) ? "unpaired" : "offline";
    }
    if (leaving) return;
    setUnreachable(!ok, why);
    if (ok) void loadHistory();
  }

  function setMuted(m: boolean) {
    muted = m;
    store(MUTE_KEY, m ? "1" : "0");
    muteBtn.replaceChildren(icon(m ? SPEAKER_OFF : SPEAKER));
    muteBtn.setAttribute("aria-label", m ? `Unmute ${ASSISTANT_NAME}` : `Mute ${ASSISTANT_NAME}`);
    muteBtn.setAttribute("aria-pressed", String(m));
    muteBtn.title = m ? "Unmute" : "Mute";
    if (m) {
      stopSpeaking();
      if (state === "speaking" && !turnOpen) setState("idle");
    }
  }

  function setSpeaker(id: SpeakerId) {
    // What it was saying stops; the next answer goes where this says.
    if (id !== chosen) stopSpeaking();
    chosen = id;
    store(SPEAKER_KEY, id);
    paintSpeakers();
    if (state === "speaking" && !turnOpen) setState("idle");
  }

  /** The picker shows what's offered, and keeps your choice even while it isn't, so a speaker that's off is still your pick. */
  function paintSpeakers() {
    const shown = speakers.filter((s) => s.available || s.id === chosen);
    speakerSel.replaceChildren(...shown.map((s) => {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.label + (s.available ? "" : " (not here)");
      return o;
    }));
    speakerSel.value = chosen;
    speakerSel.hidden = !speakers.some((s) => s.id !== "phone" && s.available);
    const hint = speakerSel.hidden ? "" : speakerHint(speakers.find((s) => s.id === chosen));
    speakerHintLine.textContent = hint;
    speakerHintLine.hidden = !hint;
  }

  // ---------------- the conversation on screen
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const toBottom = () => { log.scrollTop = log.scrollHeight; };

  function addMessage(m: ChatMessage): HTMLElement {
    view.classList.remove("empty");
    const row = el("div", `pp-msg ${m.role === "user" ? "pp-me" : "pp-her"}`);
    const body = el("div", "pp-body");
    if (m.role === "user") body.textContent = m.text;
    else renderInto(body, m.text);
    row.append(body);
    log.append(row);
    return row;
  }

  async function loadHistory() {
    if (turn || mic) return;
    try {
      const res = await call("/api/assistant/history");
      const { messages } = (await res.json()) as { messages: ChatMessage[] };
      // Something started while this was on its way; that screen is newer.
      if (turn || mic || leaving) return;
      const atEnd = atBottom();
      log.replaceChildren();
      view.classList.toggle("empty", messages.length === 0);
      for (const m of messages) addMessage({ role: m.role, text: m.text });
      if (!historyLoaded || atEnd) toBottom();
      historyLoaded = true;
    } catch (e) {
      if (leaving) return;
      if (away(e)) setUnreachable(true);
      else trouble(troubleFor((e as HttpError).status, (e as HttpError).code));
    }
  }

  // ---------------- speaking
  const queue = new SpeechQueue(
    async (text, signal) => {
      const res = await call("/api/voice/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal,
      });
      return res.arrayBuffer();
    },
    {
      started: () => {
        if (!audioMarked) { audioMarked = true; mark("firstAudio"); }
        if (state !== "listening") setState("speaking");
      },
      idle: () => {
        pendingBlocked = false;
        // Said all it has so far; with the turn still open it's back to working.
        if (state === "speaking") setState(turnOpen ? "thinking" : "idle");
      },
      failed: (status) => {
        // Voice being down never gets in the way of its words.
        trouble(status === 401 || status === 403 ? "unpaired" : "voice");
        if (!turnOpen && state === "speaking") setState("idle");
      },
      blocked: () => { pendingBlocked = true; setState(state); },
    },
  );

  const tvQueue = new TvQueue(
    async (text, signal) => {
      await call("/api/voice/tv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, to: turnTo }),
        signal,
      });
    },
    {
      started: () => {
        if (!audioMarked) { audioMarked = true; mark("firstAudio"); }
        if (state !== "listening") setState("speaking");
      },
      idle: () => {
        if (state === "speaking") setState(turnOpen ? "thinking" : "idle");
      },
      failed: (status, code, unsaid) => {
        // Not reaching the gateway at all is the TV or the speaker not answering, as far as you can tell.
        const t = troubleFor(status, code);
        trouble(t === "assistant" ? (turnTo === "tv" ? "tv" : "speaker") : t);
        if (t === "speaker_listen") void checkTv();
        // The rest of this answer, from what the TV didn't say, is spoken here.
        if (voice === tvQueue && !muted) {
          voice = queue;
          for (const s of unsaid) queue.say(s);
        }
        if (!turnOpen && state === "speaking" && !queue.busy) setState("idle");
      },
    },
  );
  /** Where its voice goes for a new turn: the phone unless you chose a speaker the gateway offers. */
  const offered = (id: SpeakerId) => id !== "phone" && speakers.some((s) => s.id === id && s.available);
  const speaker = () => (offered(chosen) ? tvQueue : queue);
  /** Where it goes for this one: the TV's turns move here if it fails. */
  let voice: SpeechQueue | TvQueue = queue;

  async function checkTv() {
    if (!HAS_EXT) { speakers = parseSpeakers({ speakers: [] }); if (!leaving) paintSpeakers(); return; }
    try {
      const res = await call("/api/voice/tv");
      speakers = parseSpeakers(await res.json());
    } catch {
      speakers = parseSpeakers({ speakers: [] });
    }
    if (leaving) return;
    paintSpeakers();
  }
  function stopSpeaking() {
    queue.cancel();
    tvQueue.cancel();
  }

  function interrupt() {
    turn?.abort();
    turn = null;
    turnOpen = false;
    stopSpeaking();
    pendingBlocked = false;
  }

  // ---------------- one turn
  async function send(text: string) {
    interrupt();
    lastFailed = "";
    say("");
    audioMarked = false;
    queue.reset();
    tvQueue.reset();
    voice = speaker();
    turnTo = voice === tvQueue ? chosen : "phone";
    if (turnTo !== "phone" && turnTo !== "tv") void checkTv(); // is that speaker still listening? The hint says if not
    addMessage({ role: "user", text });
    const row = addMessage({ role: "assistant", text: "" });
    row.classList.add("pp-live");
    const body = row.querySelector<HTMLElement>(".pp-body")!;
    const status = el("div", "pp-toolnote");
    status.hidden = true;
    row.append(status);
    toBottom();

    const controller = new AbortController();
    turn = controller;
    turnOpen = true;
    setState("thinking");
    mark("sent");

    const splitter = new SentenceSplitter();
    let reply = "";
    let painted = 0;
    const running = new Map<string, string>();
    let failure: Trouble | null = null;
    let finished = false;
    let spokeYet = false;

    const paint = () => {
      painted = 0;
      const stick = atBottom();
      renderInto(body, reply);
      if (stick) toBottom();
    };
    const speakAll = (sentences: string[]) => {
      if (muted) return;
      for (const s of sentences) {
        if (!spokeYet) { spokeYet = true; mark("firstSentence"); }
        voice.say(s);
      }
    };
    const showTools = () => {
      const names = [...running.values()];
      status.hidden = names.length === 0;
      status.textContent = names.length ? `Looking at ${names.join(", ")}` : "";
    };

    try {
      const res = await call("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (unreachable) setUnreachable(false);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
          const data = JSON.parse(ev.data || "{}");
          if (ev.event === "delta") {
            if (!reply) mark("firstDelta");
            reply += data.text;
            if (muted && state === "thinking") setState("speaking");
            speakAll(splitter.push(data.text));
            if (!painted) painted = requestAnimationFrame(paint);
          } else if (ev.event === "tool") {
            if (data.status === "running") running.set(String(data.id ?? data.tool), String(data.tool).replace(/_/g, " "));
            else running.delete(String(data.id ?? data.tool));
            showTools();
          } else if (ev.event === "notice" && data.code === "cut_short") {
            say(`${ASSISTANT_NAME}'s answer was cut short.`, false, "warn");
          } else if (ev.event === "done") {
            finished = true;
          } else if (ev.event === "error") {
            failure = "assistant";
          }
        }
      }
      if (controller.signal.aborted) return;
      if (!finished && !failure) failure = "assistant";
    } catch (e) {
      if (controller.signal.aborted) {
        // Interrupted by a tap: what it got out stays on screen, marked as cut off.
        if (painted) cancelAnimationFrame(painted);
        renderInto(body, reply);
        row.classList.remove("pp-live");
        row.classList.add("pp-cut");
        status.remove();
        if (!reply) row.remove();
        return;
      }
      failure = e instanceof HttpError ? troubleFor(e.status, e.code) : "assistant";
      if (away(e)) setUnreachable(true);
    }

    if (painted) cancelAnimationFrame(painted);
    status.remove();
    renderInto(body, reply);
    row.classList.remove("pp-live");
    if (!reply) row.remove();
    if (atBottom()) toBottom();
    if (turn === controller) { turn = null; turnOpen = false; }
    if (failure) {
      if (reply) row.classList.add("pp-cut");
      voice.cancel();
      if (failure === "assistant") lastFailed = text;
      trouble(failure, failure === "assistant");
      if (state !== "listening") setState("error");
      return;
    }
    speakAll(splitter.flush());
    if (state !== "listening" && !voice.busy) setState("idle");
    else if (state === "thinking") setState("speaking");
  }

  // ---------------- listening
  async function startListening() {
    const ctx = unlockAudio(); // first, and synchronously: this is the tap iOS needs.
    interrupt();
    say("");
    micLevel = 0;
    const endpoint = new Endpointer();
    heardSpeech = () => endpoint.started;
    let heardAnything = false;
    let listened = 0;
    let finishing = false;
    let lastVoiced = 0;
    const m = new Mic(ctx, (level, ms, peak) => {
      if (finishing || mic !== m) return;
      micLevel = level;
      listened += ms;
      if (peak > 0) heardAnything = true;
      if (level > endpoint.threshold) lastVoiced = performance.now();
      if (!heardAnything && listened >= SILENT_MIC_MS) {
        finishing = true;
        stopMic();
        resetAudio();
        trouble("mic_silent");
        setState("error");
        return;
      }
      const verdict = endpoint.feed(level, ms);
      if (verdict === "ended" || verdict === "max_length") {
        finishing = true;
        trace.speechEnd = Math.round(lastVoiced);
        void finishListening();
      } else if (verdict === "no_speech") {
        finishing = true;
        stopMic();
        setState("idle");
      }
    });
    mic = m;
    setState("listening");
    try {
      await m.start();
    } catch (e) {
      if (mic === m) mic = null;
      m.release();
      const kind = e as MicError;
      trouble(kind === "insecure" ? "mic_insecure" : kind === "missing" ? "mic_missing" : "mic_denied");
      setState("error");
    }
  }

  function stopMic() {
    mic?.release();
    mic?.clear();
    mic = null;
    micLevel = 0;
  }

  /** The mic goes off first, then the captured speech is sent and forgotten. */
  async function finishListening() {
    const m = mic;
    if (!m) return;
    mark("endpoint");
    m.release();
    mic = null;
    micLevel = 0;
    setState("thinking");
    const wav = encodeWav(resample(m.samples(), m.rate, ASR_RATE), ASR_RATE);
    m.clear();
    const controller = new AbortController();
    turn = controller;
    let text = "";
    try {
      const res = await call("/api/voice/transcribe", {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wav,
        signal: controller.signal,
      });
      text = ((await res.json()) as { text: string }).text.trim();
      mark("transcribed");
    } catch (e) {
      if (controller.signal.aborted) return;
      if (turn === controller) turn = null;
      if (e instanceof HttpError) trouble(troubleFor(e.status, e.code));
      else trouble("assistant");
      setState("error");
      return;
    }
    if (turn !== controller) return;
    turn = null;
    if (!text) {
      say("I didn't catch that.");
      setState("idle");
      return;
    }
    void send(text);
  }

  // ---------------- controls
  function onOrbTap() {
    if (pendingBlocked) {
      unlockAudio();
      pendingBlocked = false;
      queue.retryBlocked();
      setState(state);
      return;
    }
    if (state === "listening") {
      // Tapped before saying anything: that's a change of mind, not something to send.
      if (mic && heardSpeech()) void finishListening();
      else { stopMic(); setState("idle"); }
      return;
    }
    // Idle starts listening. While it's busy, a tap interrupts it and it's your turn.
    void startListening();
  }

  function sendTyped() {
    const text = input.value.trim();
    if (!text) return;
    unlockAudio(); // a key press or tap counts on iOS.
    // Away, the words stay in the box. Sending is a fresh look: if it's back, it goes.
    if (unreachable) { void reach().then(() => { if (!unreachable && input.value.trim()) sendTyped(); }); return; }
    if (mic) stopMic();
    input.value = "";
    store(TYPED_KEY, "");
    autosize();
    // On a phone the keyboard goes down so the orb is back, to tap and interrupt it.
    if (matchMedia("(max-width: 879px)").matches) input.blur();
    void send(text);
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }

  async function newConversation() {
    // Two taps, because a stray one would clear the screen mid-thought.
    if (!newArmed && log.childElementCount) {
      newLabel.textContent = "Start new?";
      newArmed = window.setTimeout(() => { newArmed = 0; newLabel.textContent = ""; }, 3000);
      return;
    }
    clearTimeout(newArmed);
    newArmed = 0;
    newLabel.textContent = "";
    interrupt();
    stopMic();
    try {
      await call("/api/assistant/new", { method: "POST" });
      log.replaceChildren();
      view.classList.add("empty");
      say("");
      setState("idle");
    } catch (e) {
      trouble(e instanceof HttpError ? troubleFor(e.status, e.code) : "assistant");
    }
  }

  orbBtn.addEventListener("click", onOrbTap);
  muteBtn.addEventListener("click", () => { unlockAudio(); setMuted(!muted); });
  speakerSel.addEventListener("change", () => { unlockAudio(); setSpeaker(speakerSel.value as SpeakerId); void checkTv(); });
  newBtn.addEventListener("click", () => void newConversation());
  composer.addEventListener("submit", (e) => { e.preventDefault(); sendTyped(); });
  input.addEventListener("input", () => { autosize(); store(TYPED_KEY, input.value); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendTyped(); }
  });
  input.addEventListener("focus", () => { view.classList.add("typing"); });
  input.addEventListener("blur", () => { view.classList.remove("typing"); });

  // ---------------- the keyboard (iOS overlays it instead of resizing the page)
  const vv = window.visualViewport;
  function fitKeyboard() {
    if (!vv) return;
    const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    const nav = document.querySelector("nav");
    const lift = covered > 80 ? Math.max(0, covered - (nav?.offsetHeight ?? 0)) : 0;
    view.style.setProperty("--pp-keyboard", `${lift}px`);
    if (lift) {
      window.scrollTo(0, 0);
      toBottom();
    }
  }
  vv?.addEventListener("resize", fitKeyboard);
  vv?.addEventListener("scroll", fitKeyboard);

  // ---------------- leaving the page, calls, the lock screen
  const anyTap = () => { if (!audioRunning()) void tryResume(); };
  function onHidden() {
    // The mic is never kept on in the background, and half-heard speech isn't sent. The TV goes on: the phone in a
    // pocket or locked is still the remote.
    if (mic) { stopMic(); setState("idle"); }
    queue.cancel();
    if (!turnOpen && state === "speaking" && !tvQueue.busy) setState("idle");
  }
  function onVisibility() {
    if (document.hidden) { onHidden(); return; }
    void tryResume();
    if (!turn && !mic) void reach();
    void checkTv();
  }
  const offState = onAudioStateChange(() => { if (!document.hidden && !audioRunning()) void tryResume(); });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onHidden);
  window.addEventListener("pointerdown", anyTap, { passive: true });

  setMuted(muted);
  paintSpeakers();
  setState("idle");
  void reach();
  void checkTv();

  return () => {
    leaving = true;
    clearTimeout(reachTimer);
    drafts.stop();
    interrupt();
    stopMic();
    clearTimeout(newArmed);
    offState();
    orb.destroy();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onHidden);
    window.removeEventListener("pointerdown", anyTap);
    vv?.removeEventListener("resize", fitKeyboard);
    vv?.removeEventListener("scroll", fitKeyboard);
  };
}
