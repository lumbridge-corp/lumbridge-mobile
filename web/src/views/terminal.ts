import { app, askOf, choicesFromScreen, choicesOf, connected, folderOf, labelOf, machineName, machineOf, onConn, onTerms, statusOf, terms, type Choice } from "../app";
import { statusWord, type Terminal } from "../core";
import { el, setOff } from "../dom";
import { icon } from "../icons";
import { fmtAge, kindWord, shortFolder, stateWord } from "../inbox";
import { terminalOrigin } from "../router";
import {
  FONT_MAX, FONT_MIN, NOT_CONFIRMED, SEND_LIMIT_MS, UNCONFIRMED_MS, clampFont, clearAfterSend, confirmer, fitFont, followTop, isFollowing,
  keyGaps, keyLayout, loadView, readFont, reflow, saveView, unconfirmed, viewportPlan, withinLimit,
  type Unconfirmed, type ViewMode,
} from "../termlogic";
import { holdToSpeak } from "./hold-to-speak";
import type { Xterm } from "../xterm";

type Key = { label: string; aria: string; cls?: string; confirm?: boolean };
const KEYS: Record<string, Key> = {
  1: { label: "1", aria: "Press 1", cls: "num" }, 2: { label: "2", aria: "Press 2", cls: "num" },
  3: { label: "3", aria: "Press 3", cls: "num" }, 4: { label: "4", aria: "Press 4", cls: "num" },
  5: { label: "5", aria: "Press 5", cls: "num" },
  esc: { label: "Esc", aria: "Escape" },
  up: { label: "↑", aria: "Up", cls: "glyph" }, down: { label: "↓", aria: "Down", cls: "glyph" },
  enter: { label: "Enter", aria: "Enter" },
  tab: { label: "Tab", aria: "Tab" }, "shift+tab": { label: "⇧Tab", aria: "Shift Tab" },
  left: { label: "←", aria: "Left", cls: "glyph" }, right: { label: "→", aria: "Right", cls: "glyph" },
  space: { label: "Space", aria: "Space" }, backspace: { label: "⌫", aria: "Backspace", cls: "glyph" },
  "ctrl+c": { label: "Ctrl-C", aria: "Control C", cls: "danger", confirm: true },
  "ctrl+d": { label: "Ctrl-D", aria: "Control D", cls: "danger", confirm: true },
  "ctrl+o": { label: "Ctrl-O", aria: "Control O" }, "ctrl+r": { label: "Ctrl-R", aria: "Control R" },
  "ctrl+l": { label: "Ctrl-L", aria: "Control L" },
};

// The terminal stays dark in both themes: what runs in it was drawn for a dark pane on the desktop.
const THEME = {
  background: "#0a0a0a", foreground: "#ededed", cursor: "#a1a1a1", cursorAccent: "#0a0a0a",
  selectionBackground: "#2b3a4f", black: "#262626", red: "#ff6166", green: "#3fcf6f", yellow: "#f5a524",
  blue: "#52a8ff", magenta: "#c792ea", cyan: "#4ec9c9", white: "#d4d4d4", brightBlack: "#8a8a8a",
  brightRed: "#ff8a8e", brightGreen: "#6fdc93", brightYellow: "#ffc461", brightBlue: "#7cbcff",
  brightMagenta: "#dbb0f2", brightCyan: "#7adada", brightWhite: "#ffffff",
};
const FONT = "ui-monospace, 'SF Mono', Menlo, 'Roboto Mono', 'Droid Sans Mono', 'DejaVu Sans Mono', monospace";
const READ_LINES = 1500, ARM_MS = 2200, CALM_MS = 160;
/**
 * xterm parses each write whole, and only yields between writes. A first paint with 2000 lines of history comes in chunks that
 * take 50-80 ms each to parse on a slow phone, so it goes in as slices that take a few ms each. The bytes are the same and xterm's
 * queue keeps them in order, ahead of anything that arrives after; the credit goes back once the last slice has been parsed.
 */
const SLICE = 8192;
function writeSliced(x: Xterm, b: Uint8Array, done: () => void) {
  let at = 0;
  for (; b.length - at > SLICE; at += SLICE) x.write(b.subarray(at, at + SLICE));
  x.write(at ? b.subarray(at) : b, done);
}

type SelectionRedraw = (start: unknown, end: unknown, columnSelectMode: boolean) => void;
/**
 * xterm 5.5 redraws its selection after every scroll, and its DOM renderer does that by drawing every row again, on top of the
 * frame's own render. With nothing selected before or after, that second pass changes nothing, and while a history goes in it
 * doubles each frame's work (two full renders, 55-70 ms on a phone at 4x). It's skipped then; any real selection draws as before.
 */
function skipEmptySelectionRedraws(x: Xterm) {
  const rs = (x as unknown as { _core?: { _renderService?: { handleSelectionChanged?: SelectionRedraw } } })._core?._renderService;
  const real = rs?.handleSelectionChanged;
  if (!rs || typeof real !== "function") return;
  let shown = false;
  rs.handleSelectionChanged = (start, end, columnSelectMode) => {
    const has = !!start && !!end;
    if (!has && !shown) return;
    shown = has;
    real.call(rs, start, end, columnSelectMode);
  };
}
/** A new key bar has to stay wanted this long, so a status that flips and flips back moves nothing. */
const KEYS_SETTLE_MS = 250;
/** And it waits this long after the owner's last touch on the bar: a thumb on its way to the next key. */
const KEYS_HOLD_MS = 700;
/** Right after opening the owner isn't aiming yet, and the menu's keys should simply be there. */
const KEYS_OPENING_MS = 1500;

export function terminalView(root: HTMLElement, address: string) {
  const coarse = matchMedia("(pointer: coarse)").matches;
  const state = loadView(address, coarse);
  let gone = false;

  // ---- The screen is built right away; xterm arrives a moment later. ----
  const page = el("div", "term");
  const head = el("header", "term-head");
  const back = el("a", "iconbtn back");
  back.href = `#/${terminalOrigin()}`;
  back.setAttribute("aria-label", `Back to ${terminalOrigin()}`);
  back.append(icon(coarse ? "back" : "close"));
  const title = el("div", "title");
  const name = el("span", "name");
  const meta = el("span", "meta");
  // What it's doing comes first: a long folder may run out of room, and this mustn't.
  const metaState = el("span", "meta-state");
  const metaRest = el("span");
  meta.append(metaState, metaRest);
  title.append(name, meta);
  const sizeBtn = el("button", "iconbtn");
  sizeBtn.type = "button";
  sizeBtn.setAttribute("aria-label", "View options");
  sizeBtn.setAttribute("aria-expanded", "false");
  sizeBtn.append(icon("size"));
  head.append(back, title, sizeBtn);

  const alert = el("div", "term-alert");
  alert.setAttribute("role", "alert");
  alert.hidden = true;
  const alertKind = el("strong");
  const alertText = el("span");
  alert.append(alertKind, alertText);
  const note = el("div", "term-note");
  note.setAttribute("role", "status");
  note.hidden = true;

  const body = el("div", "term-body");
  const scroller = el("div", "screen");
  scroller.tabIndex = 0;
  scroller.setAttribute("role", "region");
  scroller.setAttribute("aria-label", "Terminal output");
  const spacer = el("div", "spacer");
  const host = el("div", "xhost");
  spacer.append(host);
  scroller.append(spacer);
  const readPane = el("pre", "reflow");
  readPane.tabIndex = 0;
  readPane.setAttribute("aria-label", "Terminal output, reflowed");
  readPane.hidden = true;
  const jump = el("button", "jump");
  jump.type = "button";
  jump.setAttribute("aria-label", "Jump to the latest output");
  jump.hidden = true;
  jump.append(icon("down"), el("span", "jump-label", "Latest"));
  const toast = el("div", "term-toast");
  toast.setAttribute("role", "status");
  toast.hidden = true;
  const panel = buildPanel();
  body.append(scroller, readPane, jump, toast, panel.root);

  const keys = el("div", "keys");
  keys.setAttribute("role", "toolbar");
  keys.setAttribute("aria-label", "Keys to send");
  const composer = el("form", "composer");
  const box = el("textarea");
  box.rows = 1;
  box.placeholder = "Message";
  box.setAttribute("aria-label", "Message to this agent");
  box.value = state.draft;
  const send = el("button", "send");
  send.setAttribute("aria-label", "Send");
  send.append(icon("send"));
  const talk = el("button", "talk");
  talk.type = "button";
  talk.setAttribute("aria-label", "Hold to talk");
  talk.append(icon("mic"));
  composer.append(box, talk, send);
  page.append(head, alert, note, body, keys, composer);
  root.replaceChildren(page);

  let x: Xterm | null = null;
  let cellW = 7, cellH = 14;
  const pad = coarse ? 4 : 8; // a little air between the text and the glass
  host.style.left = `${pad}px`;
  let following = state.fromEnd === null;
  let restored = false;
  let lastUserScroll = 0;
  let touching = false;
  let pinching = false;
  let ownScroll = -1;     // the scrollTop we set ourselves, which must not count as the owner scrolling
  let framePending = false;
  let readDirty = true, readTimer = 0;

  // ---- text in the chrome ----
  let toastTimer = 0;
  const say = (msg: string) => {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2800);
  };

  // A send that went quiet may still land, so the same text can't go again until it's answered, edited or 60 s old.
  let pending: Unconfirmed | null = null;
  let sendBlocked = false;
  const updateSend = () => {
    const held = !sendBlocked && !!pending?.holds(box.value);
    setOff(send, sendBlocked || held);
    send.title = held ? NOT_CONFIRMED : "";
  };
  const blockSend = (off: boolean) => { sendBlocked = off; updateSend(); };

  function renderChrome() {
    const t = terms.get(address);
    if (!t) {
      name.textContent = address;
      // Until core answers, the address is all there is to show: the line under it says why.
      metaState.textContent = app.conn === "online" ? "Not found" : navigator.onLine === false ? "Offline, connecting…" : "Connecting…";
      metaRest.textContent = "";
      wantKeys([]);
      note.hidden = app.conn !== "online";
      note.textContent = "This terminal is gone.";
      box.disabled = app.conn === "online";
      blockSend(app.conn === "online" || !connected());
      keys.classList.toggle("off", app.conn === "online");
      return;
    }
    const label = labelOf(t);
    if (name.textContent !== label) name.textContent = label;
    const s = statusOf(t);
    const word = stateWord[s?.state ?? ""];
    const since = t.status_ms ? fmtAge(Date.now() - t.status_ms) : "";
    const doing = word ? (since && since !== "now" ? `${word} ${since}` : word) : "";
    const place = [machineName(machineOf(t)), shortFolder(folderOf(t), 44)].filter(Boolean).join(" · ");
    const rest = doing && place ? ` · ${place}` : place;
    if (metaState.textContent !== doing) metaState.textContent = doing;
    if (metaRest.textContent !== rest) metaRest.textContent = rest;

    const w = statusWord(t);
    title.dataset.state = w ?? "";
    const blocked = w === "blocked" || w === "error";
    page.classList.toggle("is-blocked", w === "blocked");
    page.classList.toggle("is-working", w === "working");
    alert.hidden = !blocked;
    if (blocked) {
      alert.classList.toggle("error", w === "error");
      alertKind.textContent = w === "error" ? "Error" : kindWord[s?.kind ?? ""] ?? "Waiting for you";
      alertText.textContent = askOf(t, renderChrome);
    }
    wantKeys(menuOf(t));
    const finished = t.state === "finished";
    const lost = !finished && !!t.reason && !t.foreground;
    note.hidden = !finished && !lost;
    if (finished) note.textContent = t.exit_code != null ? `Ended, exit code ${t.exit_code}. This is its last screen.` : "Ended. This is its last screen.";
    else if (lost) note.textContent = "Its program was lost. Waiting for a new shell.";
    box.disabled = finished;
    // Offline, the banner says why. The box stays, so the owner can go on typing.
    blockSend(finished || !connected());
    talk.disabled = finished;
    keys.classList.toggle("off", finished);
  }

  // ---- layout: native scrolling over a spacer the size of the whole buffer ----
  const measure = () => {
    const s = host.querySelector<HTMLElement>(".xterm-screen");
    if (!x || !s) return;
    const r = s.getBoundingClientRect();
    if (r.width && r.height && !pinching) { cellW = r.width / x.cols; cellH = r.height / x.rows; }
  };

  function lastUsedLine() {
    const b = x!.buffer.active;
    const cursor = b.baseY + b.cursorY;
    for (let i = b.baseY + x!.rows - 1; i > cursor; i--) {
      if (b.getLine(i)?.translateToString(true).trim()) return i;
    }
    return cursor;
  }

  const contentHeight = () => {
    const b = x!.buffer.active;
    return viewportPlan({ scrollTop: 0, viewH: scroller.clientHeight, cellH, rows: x!.rows, baseY: b.baseY }).height;
  };
  const followTarget = () =>
    followTop({ lastUsedLine: lastUsedLine(), cellH, viewH: scroller.clientHeight, contentH: contentHeight(), rows: x!.rows, baseY: x!.buffer.active.baseY });

  function setScroll(y: number) {
    const v = Math.round(y);
    if (Math.abs(scroller.scrollTop - v) < 1) return;
    ownScroll = v;
    scroller.scrollTop = v;
  }

  function sync() {
    if (!x || pinching || state.mode === "read") return;
    const b = x.buffer.active;
    const viewH = scroller.clientHeight;
    if (!viewH) return;
    let plan = viewportPlan({ scrollTop: scroller.scrollTop, viewH, cellH, rows: x.rows, baseY: b.baseY });
    const w = `${Math.ceil(x.cols * cellW) + pad * 2}px`, h = `${Math.ceil(plan.height)}px`;
    if (spacer.style.width !== w) spacer.style.width = w;
    // On a phone a scrollbar shows only during a scroll, so a wide pane's cut-off lines need their own cue.
    body.classList.toggle("more-right", Math.ceil(x.cols * cellW) + pad * 2 - scroller.scrollLeft - scroller.clientWidth > 4);
    if (spacer.style.height !== h) spacer.style.height = h;
    if (following && !touching && Date.now() - lastUserScroll > CALM_MS) {
      setScroll(followTarget());
      plan = viewportPlan({ scrollTop: scroller.scrollTop, viewH, cellH, rows: x.rows, baseY: b.baseY });
    }
    if (plan.line !== b.viewportY) x.scrollToLine(plan.line);
    host.style.top = `${plan.top}px`;
    updateJump();
  }

  const updateJump = () => { jump.hidden = following; };

  const frame = () => {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => { framePending = false; sync(); if (state.mode === "read") renderRead(); });
  };

  scroller.addEventListener("scroll", () => {
    if (ownScroll >= 0 && Math.abs(scroller.scrollTop - ownScroll) < 2) { ownScroll = -1; sync(); return; }
    ownScroll = -1;
    if (!x) return;
    lastUserScroll = Date.now();
    following = isFollowing(scroller.scrollTop, followTarget(), cellH);
    sync();
    saveSoon();
  }, { passive: true });

  function jumpToEnd() {
    following = true;
    lastUserScroll = 0;
    if (state.mode === "read") { readDirty = true; renderRead(); readPane.scrollTop = readPane.scrollHeight; }
    else sync();
    updateJump();
    saveSoon();
  }
  jump.onclick = jumpToEnd;

  // ---- size ----
  function setFont(f: number) {
    if (!x) return;
    x.options.fontSize = f;
    measure();
  }

  function applyMode(keepAnchor?: { col: number; line: number; px: number; py: number }) {
    const mode = state.mode;
    page.dataset.mode = mode;
    scroller.hidden = mode === "read";
    readPane.hidden = mode !== "read";
    panel.sync();
    if (!x) return;
    if (mode === "read") {
      body.classList.remove("more-right");
      readPane.style.fontSize = `${readFont(state.font)}px`;
      readDirty = true;
      renderRead();
      if (following) readPane.scrollTop = readPane.scrollHeight;
    } else {
      if (mode === "fit") {
        const ratio = cellW / (x.options.fontSize ?? 11);
        setFont(fitFont(scroller.clientWidth - pad * 2, x.cols, ratio));
        scroller.scrollLeft = 0;
      } else if (x.options.fontSize !== state.font) setFont(state.font);
      if (keepAnchor) {
        scroller.scrollLeft = keepAnchor.col * cellW + pad - keepAnchor.px;
        following = false;
        setScroll(keepAnchor.line * cellH - keepAnchor.py);
      }
      sync();
    }
    updateJump();
    saveSoon();
  }

  function setMode(m: ViewMode) { state.mode = m; applyMode(); }
  function stepFont(d: number) {
    state.font = clampFont((state.mode === "fit" ? Number(x?.options.fontSize ?? state.font) : state.font) + d);
    if (state.mode === "fit") state.mode = "pan";
    applyMode();
  }

  function buildPanel() {
    const p = el("div", "size-panel");
    p.hidden = true;
    const seg = el("div", "seg");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", "How to show a wide pane");
    const modes: [ViewMode, string, string][] = [
      ["pan", "Pan", "Actual layout, pan around"], ["fit", "Fit", "Shrink to the width"], ["read", "Read", "Wrap text for this screen"],
    ];
    const buttons = modes.map(([m, label, desc]) => {
      const b = el("button", "seg-btn", label);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.title = desc;
      b.setAttribute("aria-label", `${label}: ${desc}`);
      b.onclick = () => setMode(m);
      seg.append(b);
      return [m, b] as const;
    });
    const stepper = el("div", "stepper");
    const minus = el("button", "stepper-btn", "A−");
    minus.type = "button";
    minus.setAttribute("aria-label", "Smaller text");
    minus.onclick = () => stepFont(-1);
    const value = el("span", "stepper-value");
    const plus = el("button", "stepper-btn", "A+");
    plus.type = "button";
    plus.setAttribute("aria-label", "Larger text");
    plus.onclick = () => stepFont(1);
    stepper.append(minus, value, plus);
    const copy = el("button", "panel-btn", "Copy screen");
    copy.type = "button";
    copy.onclick = () => {
      const text = x?.getSelection() || screenText();
      navigator.clipboard?.writeText(text).then(() => say("Copied"), () => say("Couldn't copy"));
      close();
    };
    p.append(seg, stepper, copy);
    const close = () => { p.hidden = true; sizeBtn.setAttribute("aria-expanded", "false"); };
    return {
      root: p, close,
      toggle() { p.hidden = !p.hidden; sizeBtn.setAttribute("aria-expanded", String(!p.hidden)); },
      sync() {
        for (const [m, b] of buttons) {
          b.classList.toggle("on", m === state.mode);
          b.setAttribute("aria-checked", String(m === state.mode));
        }
        const f = state.mode === "fit" ? Number(x?.options.fontSize ?? 0) : state.font;
        value.textContent = f ? `${Math.round(f * 10) / 10}px` : "";
        minus.disabled = state.mode !== "fit" && state.font <= FONT_MIN;
        plus.disabled = state.font >= FONT_MAX;
      },
    };
  }
  sizeBtn.onclick = () => { panel.toggle(); panel.sync(); };

  // ---- pinch, ctrl-wheel ----
  let pinch: { d0: number; f0: number; col: number; line: number; px: number; py: number; s: number } | null = null;
  const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);

  function anchorAt(px: number, py: number) {
    return { col: (scroller.scrollLeft + px - pad) / cellW, line: (scroller.scrollTop + py) / cellH, px, py };
  }

  scroller.addEventListener("touchstart", (e) => {
    touching = true;
    if (e.touches.length === 2 && x) {
      const r = scroller.getBoundingClientRect();
      const px = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
      const py = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
      pinching = true;
      pinch = { d0: dist(e), f0: Number(x.options.fontSize), s: 1, ...anchorAt(px, py) };
      host.style.transformOrigin = `${scroller.scrollLeft + px - pad}px ${scroller.scrollTop + py - parseFloat(host.style.top || "0")}px`;
    }
  }, { passive: true });
  scroller.addEventListener("touchmove", (e) => {
    if (!pinch || e.touches.length !== 2) return;
    if (e.cancelable) e.preventDefault();
    const f = Math.min(FONT_MAX, Math.max(FONT_MIN, pinch.f0 * dist(e) / pinch.d0));
    pinch.s = f / pinch.f0;
    host.style.transform = `scale(${pinch.s})`;
  }, { passive: false });
  const touchDone = (e: TouchEvent) => {
    if (e.touches.length === 0) touching = false;
    if (!pinch || e.touches.length >= 2) return;
    const p = pinch;
    pinch = null;
    host.style.transform = "";
    host.style.transformOrigin = "";
    pinching = false;
    state.font = clampFont(p.f0 * p.s);
    state.mode = "pan";
    applyMode(p);
    panel.sync();
  };
  scroller.addEventListener("touchend", touchDone, { passive: true });
  scroller.addEventListener("touchcancel", touchDone, { passive: true });

  // xterm wants the wheel for itself. Keep it for the native scroller, and let ctrl-wheel (and a Mac trackpad's pinch) resize.
  scroller.addEventListener("wheel", (e) => {
    e.stopPropagation();
    if (!e.ctrlKey || !x) return;
    e.preventDefault();
    const r = scroller.getBoundingClientRect();
    const a = anchorAt(e.clientX - r.left, e.clientY - r.top);
    state.font = clampFont(Number(x.options.fontSize) * (e.deltaY < 0 ? 1.08 : 0.92));
    state.mode = "pan";
    applyMode(a);
  }, { capture: true, passive: false });

  const ro = new ResizeObserver(() => {
    if (!x) return;
    if (state.mode === "fit") applyMode(); else frame();
  });
  ro.observe(body);

  // ---- Read mode: the buffer as text a phone can wrap, and select natively ----
  function bufferLines(from: number, to: number) {
    const b = x!.buffer.active;
    const out: { text: string; wrapped: boolean }[] = [];
    // Core's first paint sends plain lines, so history has no wrap flags: a line that fills the width continued.
    let full = false;
    for (let i = from; i < to; i++) {
      const l = b.getLine(i);
      if (!l) continue;
      const text = l.translateToString(true);
      out.push({ text, wrapped: l.isWrapped || full });
      full = text.length >= x!.cols;
    }
    return out;
  }
  function renderRead() {
    if (!x || state.mode !== "read" || !readDirty) return;
    // Text under a finger or a selection stays put until the owner is done with it.
    const sel = document.getSelection();
    if (touching || (sel && !sel.isCollapsed && readPane.contains(sel.anchorNode))) return;
    if (readTimer) return;
    readTimer = window.setTimeout(() => { readTimer = 0; if (readDirty) renderRead(); }, 250);
    readDirty = false;
    const b = x.buffer.active;
    const end = b.baseY + x.rows;
    const text = reflow(bufferLines(Math.max(0, end - READ_LINES), end));
    if (readPane.textContent !== text) {
      const y = readPane.scrollTop;
      readPane.textContent = text;
      if (following) readPane.scrollTop = readPane.scrollHeight; else readPane.scrollTop = y;
    }
  }
  readPane.addEventListener("scroll", () => {
    following = readPane.scrollTop + readPane.clientHeight >= readPane.scrollHeight - 40;
    updateJump();
  }, { passive: true });
  readPane.addEventListener("touchstart", () => { touching = true; }, { passive: true });
  readPane.addEventListener("touchend", () => { touching = false; frame(); }, { passive: true });

  function screenText() {
    if (!x) return "";
    if (state.mode === "read") return readPane.textContent ?? "";
    const b = x.buffer.active;
    return bufferLines(b.viewportY, b.viewportY + x.rows).map((l) => l.text).join("\n").trimEnd();
  }

  // ---- remember ----
  let saveTimer = 0;
  function saveNow() {
    clearTimeout(saveTimer);
    if (x) {
      const b = x.buffer.active;
      state.fromEnd = following ? null : Math.max(0, b.baseY - b.viewportY);
      state.left = scroller.scrollLeft;
    }
    state.draft = box.value;
    saveView(address, state);
  }
  function saveSoon() { clearTimeout(saveTimer); saveTimer = window.setTimeout(saveNow, 400); }

  function restore() {
    if (restored || !x) return;
    restored = true;
    if (state.mode === "read") return;
    scroller.scrollLeft = state.left;
    if (state.fromEnd !== null) {
      following = false;
      sync();
      setScroll((x.buffer.active.baseY - state.fromEnd) * cellH);
    }
    sync();
  }

  // ---- the stream ----
  let channel = 0;
  let channelCore = app.core;
  let attachGen = 0;
  let retry = 1000, retryTimer = 0;
  let resizeNotified = false;

  function detach() {
    if (channel && channelCore === app.core) channelCore?.detach(channel);
    channel = 0;
  }

  // `observe` never takes the size: looking from a phone must not reflow the desktop's panes.
  async function attach() {
    const c = app.core, t = terms.get(address);
    if (!x || gone || !c || !t || t.state !== "live" || app.conn !== "online") return;
    clearTimeout(retryTimer);
    detach();
    const gen = ++attachGen;
    let r: any;
    try {
      r = await c.call("terminal.attach", { terminal: address, cols: t.cols, rows: t.rows, observe: true, resize_notifications: true, history: 2000 });
    } catch (e) {
      if (gen === attachGen && !gone) {
        retryLater();
        // A lost terminal refuses until its new shell is up. The note already says so.
        if (!terms.get(address)?.reason) say((e as Error).message);
      }
      return;
    }
    if (gone || gen !== attachGen || c !== app.core) { c.detach(r.channel); return; }
    channel = r.channel;
    channelCore = c;
    resizeNotified = r.resize_notifications === true;
    const size = r.terminal ?? t;
    if (size.cols && size.rows && (size.cols !== x.cols || size.rows !== x.rows)) x.resize(size.cols, size.rows);
    let fresh = true;
    c.listen(channel, {
      data: (b, done) => {
        // The first paint replaces what was there. It goes in with its own reset, so nothing blank ever shows.
        if (fresh) { fresh = false; x?.write("\x1bc"); retry = 1000; }
        // Credit only once xterm has parsed it: core then paces a screen that's behind, or sends it a fresh paint.
        if (x) writeSliced(x, b, done); else done();
      },
      resize: (cols, rows) => { x?.resize(cols, rows); measure(); if (state.mode === "fit") applyMode(); else frame(); },
      close: (why) => { channel = 0; onStreamClose(gen, why); },
    });
  }

  function retryLater() {
    clearTimeout(retryTimer);
    retryTimer = window.setTimeout(attach, retry);
    retry = Math.min(retry * 2, 15000);
  }

  function onStreamClose(gen: number, why: string) {
    if (gone || gen !== attachGen) return;
    let reason = "";
    try { reason = JSON.parse(why).reason ?? ""; } catch { /* an empty close answers our own detach */ }
    const t = terms.get(address);
    if (reason === "exited" || reason === "killed") { if (t && !t.keep) renderChrome(); }
    // A kept terminal comes back as `restarted`. Anything else closing a live stream gets another try.
    if (t?.state === "live" && app.conn === "online" && !(reason === "signaled")) retryLater();
  }

  // ---- seen (the `lumbridge.seen` label): raise it when the owner is really looking, once per turn ----
  let wroteTurn = -1;
  const markSeen = () => {
    const t = terms.get(address);
    const c = app.core;
    if (!t || !c || document.visibilityState !== "visible" || app.conn !== "online") return;
    const turn = t.turn ?? 0;
    const seen = t.labels?.["lumbridge.seen"];
    if (turn === wroteTurn) return;
    if (seen !== undefined && Number(seen) >= turn) { wroteTurn = turn; return; }
    wroteTurn = turn;
    c.call("terminal.label", { terminal: address, labels: { "lumbridge.seen": String(turn) } }).catch(() => { wroteTurn = -1; });
  };

  // ---- input ----
  const flash = (e: Error) => say(e.message);
  function pressKey(k: string) {
    const c = app.core;
    if (!c) { say("Not connected"); return; }
    navigator.vibrate?.(6);
    c.call("terminal.keys", { terminal: address, keys: [k] }).catch(flash);
  }
  const keyButtons = new Map<string, HTMLButtonElement>();
  function keyButton(id: string) {
    const k = KEYS[id];
    const b = el("button", `key ${k.cls ?? ""}`.trim(), k.label);
    b.type = "button";
    b.setAttribute("aria-label", k.aria);
    // Tapping a key must not take the focus, or the keyboard drops and the whole screen jumps. Mouse too: there, it's mousedown that moves it.
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("mousedown", (e) => e.preventDefault());
    if (k.confirm) {
      const gate = confirmer(ARM_MS);
      let disarm = 0;
      const unarm = () => { clearTimeout(disarm); disarm = 0; b.classList.remove("armed"); b.textContent = k.label; keysArmed--; settleKeys(); };
      b.onclick = () => {
        if (gate.tap() === "send") {
          unarm();
          pressKey(id);
          return;
        }
        navigator.vibrate?.(6);
        b.classList.add("armed");
        b.textContent = "Again?";
        keysArmed++;
        disarm = window.setTimeout(() => { gate.reset(); unarm(); }, ARM_MS);
      };
    } else b.onclick = () => pressKey(id);
    keyButtons.set(id, b);
    return b;
  }
  for (const id of Object.keys(KEYS)) keyButton(id);

  // ---- the key bar follows the terminal, but never under the owner's thumb ----
  const openedAt = Date.now();
  let keysShown = "", keysWanted = "", keysTouching = false, keysTouchedAt = 0, keysArmed = 0, keysTimer = 0;
  let menu: Choice[] = [];

  /** The menu the owner is looking at: what `askOf` read, or else the screen itself, since a menu can paint a moment after its status. */
  function menuOf(t: Terminal): Choice[] {
    if (statusWord(t) !== "blocked") return [];
    const known = choicesOf(t);
    if (known.length || !x) return known;
    const b = x.buffer.active;
    return choicesFromScreen(bufferLines(b.baseY, b.baseY + x.rows).map((l) => l.text).join("\n"));
  }

  // A soft edge on the right while more keys are further along, so it's plain the bar scrolls. Measured a moment after the bar
  // changes, not in the frame a terminal opens in: that read would force a layout into speed-verify's tap-to-text window.
  let edgeTimer = 0;
  function edgeKeys() { keys.classList.toggle("more", keys.scrollWidth - keys.scrollLeft - keys.clientWidth > 4); }

  function showKeys() {
    keysShown = keysWanted;
    const ids = keyLayout(menu.length), gaps = keyGaps(ids);
    keys.replaceChildren(...ids.flatMap((id, i) => {
      const b = keyButtons.get(id)!;
      return gaps.has(i) ? [Object.assign(el("span", "key-gap"), { ariaHidden: "true" }), b] : [b];
    }));
    keys.scrollLeft = 0;
    keys.classList.add("more");
    clearTimeout(edgeTimer);
    edgeTimer = window.setTimeout(edgeKeys, 600);
    for (const c of menu) keyButtons.get(c.key)?.setAttribute("aria-label", `Press ${c.key}: ${c.label}`);
  }

  function settleKeys() {
    clearTimeout(keysTimer);
    keysTimer = 0;
    if (keysWanted === keysShown) return;
    const wait = keysTouching || keysArmed ? KEYS_SETTLE_MS : keysTouchedAt + KEYS_HOLD_MS - Date.now();
    if (wait > 0) keysTimer = window.setTimeout(settleKeys, wait);
    else showKeys();
  }

  function wantKeys(choices: Choice[]) {
    const next = choices.map((c) => `${c.key}:${c.label}`).join("\n");
    if (next === keysWanted) return;
    keysWanted = next;
    menu = choices;
    clearTimeout(keysTimer);
    if (next === keysShown) { keysTimer = 0; return; }
    const opening = !keysTouchedAt && Date.now() - openedAt < KEYS_OPENING_MS;
    keysTimer = window.setTimeout(settleKeys, opening ? 0 : KEYS_SETTLE_MS);
  }

  const touchedKeys = () => { keysTouchedAt = Date.now(); };
  const leftKeys = () => { if (keysTouching) { keysTouching = false; touchedKeys(); } };
  keys.addEventListener("pointerdown", () => { keysTouching = true; touchedKeys(); });
  keys.addEventListener("scroll", touchedKeys, { passive: true });
  keys.addEventListener("scroll", edgeKeys, { passive: true });
  window.addEventListener("resize", edgeKeys);
  document.addEventListener("pointerup", leftKeys);
  document.addEventListener("pointercancel", leftKeys);
  showKeys();

  // Words land in the box for the owner to read and send: a misheard word typed straight into an agent can't be taken back.
  const stopTalk = holdToSpeak(talk, {
    text: (words) => {
      box.value = box.value.trim() ? `${box.value.trimEnd()} ${words}` : words;
      autosize(); saveSoon(); pending?.edited(box.value); updateSend();
    },
    say,
  });

  const autosize = () => {
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight + 2, 148)}px`;
    composer.classList.toggle("has-text", !!box.value.trim());
  };
  box.addEventListener("input", () => { autosize(); saveSoon(); pending?.edited(box.value); updateSend(); });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); box.blur(); return; }
    // On a phone Return is a new line and the button sends. With a real keyboard, Enter sends.
    if (e.key === "Enter" && !e.shiftKey && !coarse && !e.isComposing) { e.preventDefault(); composer.requestSubmit(); }
  });
  // The text stays in the box until core answers: a socket can die without closing, and then no answer ever comes.
  let sending = false;
  const sent = (text: string) => {
    if (gone || !clearAfterSend(box.value, text)) return false;
    box.value = "";
    autosize();
    saveSoon();
    updateSend();
    return true;
  };
  composer.onsubmit = (e) => {
    e.preventDefault();
    const text = box.value;
    if (!text.trim() || sending) return;
    if (pending?.holds(text)) { say(NOT_CONFIRMED); return; }
    const c = app.core;
    if (!c || !connected()) { say("Not connected. Your message is still here."); return; }
    const t = terms.get(address);
    // The owner is looking at the question, so typing at a blocked program is on purpose: force lets it through.
    const force = t ? statusWord(t) === "blocked" : false;
    navigator.vibrate?.(8);
    sending = true;
    page.classList.add("sending");
    following = true;
    lastUserScroll = 0;
    updateJump();
    const call = c.call("terminal.send", { terminal: address, text, timeout: 10, force });
    void withinLimit(call, SEND_LIMIT_MS).then((r) => {
      sending = false;
      page.classList.remove("sending");
      if (gone) return;
      if (r === "late") {
        say(NOT_CONFIRMED);
        const u = unconfirmed(text);
        pending = u;
        updateSend();
        const settle = (msg: string | null) => {
          if (pending === u) pending = null;
          if (gone) return;
          updateSend();
          if (msg) say(msg);
        };
        const end = window.setTimeout(() => settle(u.expired()), UNCONFIRMED_MS - SEND_LIMIT_MS);
        // Should it get there after all, the box mustn't keep it to be sent twice.
        call.then(() => true, () => false).then((ok) => {
          clearTimeout(end);
          const a = u.answered(ok, gone ? "" : box.value);
          if (a.clear) sent(text);
          settle(a.say);
        });
      } else if (r.ok) sent(text);
      else flash(r.error);
    });
  };

  const onDocKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const a = document.activeElement;
    if (a && !a.classList.contains("xterm-helper-textarea") && (a.tagName === "TEXTAREA" || a.tagName === "INPUT")) return;
    if (e.key === "i") { box.focus(); e.preventDefault(); }
    else if (e.key === "=" || e.key === "+") { stepFont(1); e.preventDefault(); }
    else if (e.key === "-") { stepFont(-1); e.preventDefault(); }
    else if (e.key === "f") { setMode(state.mode === "fit" ? "pan" : "fit"); e.preventDefault(); }
    else if (e.key === "G") { jumpToEnd(); e.preventDefault(); }
    else if (e.key === "Escape" && !panel.root.hidden) { panel.close(); e.stopPropagation(); }
  };
  document.addEventListener("keydown", onDocKey, true);

  // ---- bring xterm up, then wire it to everything above ----
  const onVisible = () => { if (document.hidden) saveNow(); else markSeen(); };
  document.addEventListener("visibilitychange", onVisible);

  function start(t: Terminal, Term: typeof Xterm) {
    if (gone || x) return;
    x = new Term({
      cols: t.cols, rows: t.rows, fontSize: state.font, lineHeight: 1.1, scrollback: 3000, disableStdin: true,
      cursorBlink: false, cursorInactiveStyle: "outline", fontFamily: FONT, theme: THEME, drawBoldTextInBrightColors: false,
    });
    x.open(host);
    skipEmptySelectionRedraws(x);
    const helper = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (helper) { helper.readOnly = true; helper.tabIndex = -1; helper.setAttribute("inputmode", "none"); helper.setAttribute("aria-hidden", "true"); }
    measure();
    x.onWriteParsed(() => {
      readDirty = true;
      if (!restored) restore();
      frame();
      const now = terms.get(address);
      if (now) wantKeys(menuOf(now));
    });
    x.onResize(() => { measure(); frame(); });
    x.buffer.onBufferChange(frame);
    applyMode();
    attach();
  }

  let Term: typeof Xterm | null = null;
  let startTimer = 0;
  const tryStart = () => {
    if (!Term || x || startTimer || !terms.get(address)) return;
    // A task of its own: building the screen above and opening xterm each take a few dozen ms on a slow phone, together a long task.
    startTimer = window.setTimeout(() => {
      startTimer = 0;
      const t = terms.get(address);
      if (Term && t && !x) start(t, Term);
    });
  };

  autosize();
  renderChrome();
  panel.sync();
  page.dataset.mode = state.mode;
  scroller.hidden = state.mode === "read";
  readPane.hidden = state.mode !== "read";

  import("../xterm").then((m) => { Term = m.Xterm; tryStart(); }).catch((e) => say(`Couldn't load the terminal: ${e.message}`));

  const offTerms = onTerms((c) => {
    if (!c.all && !c.addresses.has(address)) return;
    const t = terms.get(address);
    renderChrome();
    markSeen();
    tryStart();
    if (t && x && !resizeNotified && (t.cols !== x.cols || t.rows !== x.rows)) { x.resize(t.cols, t.rows); measure(); frame(); }
    if (c.restarted.has(address)) { retry = 1000; attach(); }
  });
  const offConn = onConn((s) => {
    renderChrome();
    if (s === "online") { retry = 1000; tryStart(); attach(); markSeen(); }
    else { channel = 0; attachGen++; clearTimeout(retryTimer); }
  });
  // The device's network can come and go while core stays unreached: the meta line says which.
  window.addEventListener("online", renderChrome);
  window.addEventListener("offline", renderChrome);
  markSeen();

  return () => {
    gone = true;
    stopTalk();
    saveNow();
    offTerms();
    offConn();
    window.removeEventListener("online", renderChrome);
    window.removeEventListener("offline", renderChrome);
    clearTimeout(retryTimer);
    clearTimeout(startTimer);
    clearTimeout(toastTimer);
    clearTimeout(readTimer);
    clearTimeout(keysTimer);
    clearTimeout(edgeTimer);
    window.removeEventListener("resize", edgeKeys);
    document.removeEventListener("pointerup", leftKeys);
    document.removeEventListener("pointercancel", leftKeys);
    ro.disconnect();
    document.removeEventListener("keydown", onDocKey, true);
    document.removeEventListener("visibilitychange", onVisible);
    detach();
    // xterm 5.5's viewport syncs on its own timers after dispose() has dropped the renderer it reads: left as it opens, that throws.
    const viewport = (x as unknown as { _core?: { viewport?: { syncScrollArea(): void } } } | null)?._core?.viewport;
    if (viewport) viewport.syncScrollArea = () => {};
    x?.dispose();
    x = null;
  };
}
