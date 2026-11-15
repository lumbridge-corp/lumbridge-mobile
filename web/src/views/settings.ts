import { el } from "../dom";
import {
  deviceName, getConfig, getPrefs, isIOS, isStandalone, pushState, putPrefs, sendTest, turnOff, turnOn,
  type Prefs, type PushConfig, type PushState,
} from "../push";
import { isWeb } from "../api";
import { getTheme, setTheme, THEMES } from "../theme";
import "./settings.css";

/** A row with a real checkbox, so it's tappable, labelled and works with a screen reader. */
function toggle(title: string, hint: string, on: boolean, change: (on: boolean) => void, disabled = false) {
  const row = el("label", "set-row");
  const text = el("span", "set-text");
  text.append(el("span", "set-title", title));
  if (hint) text.append(el("span", "set-hint", hint));
  const box = el("input", "set-switch");
  box.type = "checkbox";
  box.setAttribute("role", "switch");
  box.checked = on;
  box.disabled = disabled;
  box.onchange = () => change(box.checked);
  row.append(text, box);
  return row;
}

function fact(title: string, value: string) {
  const row = el("div", "set-row");
  row.append(el("span", "set-title", title), el("span", "set-value", value));
  return row;
}

function steps(...lines: string[]) {
  const list = el("ol", "set-steps");
  for (const l of lines) list.append(el("li", "", l));
  return list;
}

function blockedHelp() {
  if (isIOS()) return steps("Open the iPhone's Settings app.", "Go to Notifications, then Lumbridge.", "Turn on Allow Notifications, then come back here.");
  if (/Android/.test(navigator.userAgent)) return steps("Press and hold the Lumbridge icon, then tap App info.", "Tap Notifications and turn them on.", "Come back here.");
  return steps("Click the icon to the left of the address bar.", "Set Notifications to Allow.", "Reload this page.");
}

/** System, Dark or Light, for this device only. A real radio group, so arrows and a screen reader work. */
function appearance() {
  const card = el("section", "set-card");
  const seg = el("div", "seg set-theme");
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", "Theme");
  const paint = () => {
    const now = getTheme();
    for (const b of seg.children) {
      const on = (b as HTMLElement).dataset.theme === now;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
      (b as HTMLElement).tabIndex = on ? 0 : -1;
    }
  };
  for (const t of THEMES) {
    const b = el("button", "seg-btn", t.label);
    b.type = "button";
    b.dataset.theme = t.id;
    b.setAttribute("role", "radio");
    b.onclick = () => { setTheme(t.id); paint(); };
    b.onkeydown = (e) => {
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const i = (THEMES.findIndex((x) => x.id === getTheme()) + step + THEMES.length) % THEMES.length;
      setTheme(THEMES[i].id); paint();
      (seg.children[i] as HTMLElement).focus();
    };
    seg.append(b);
  }
  paint();
  card.append(seg, el("p", "set-hint", "System follows this device's light or dark setting. Remembered on this device only."));
  return card;
}

export function settingsView(root: HTMLElement) {
  let live = true;
  const page = el("div", "inbox settings");
  const header = el("header");
  header.append(el("h1", "", "Settings"));
  const notifications = el("section", "set-card");
  const prefsHome = el("div");
  const device = el("section", "set-card");
  page.append(header, el("h2", "", "Notifications"), notifications, prefsHome, el("h2", "", "Appearance"), appearance(), el("h2", "", "This device"), device);
  root.replaceChildren(page);

  let config: PushConfig | null = null;
  let prefs: Prefs | null = null;
  let note: { text: string; bad: boolean } | null = null;

  const message = () => {
    if (!note) return null;
    const m = el("p", note.bad ? "set-note err" : "set-note", note.text);
    m.setAttribute("role", "status");
    return m;
  };

  const button = (text: string, cls: string, run: (b: HTMLButtonElement) => Promise<void>) => {
    const b = el("button", cls, text);
    b.onclick = async () => {
      b.disabled = true;
      note = null;
      try { await run(b); } catch (e) { note = { text: explain(e as Error), bad: true }; }
      await paint();
    };
    return b;
  };

  const paintNotifications = (state: PushState) => {
    const parts: (HTMLElement | null)[] = [];
    if (state === "install-ios") {
      parts.push(el("p", "set-lead", "Add Lumbridge to your Home Screen first"),
        el("p", "set-body", "On iPhone, notifications only work from the Home Screen."),
        steps("In Safari, tap the Share button.", "Tap Add to Home Screen, then Add.", "Open Lumbridge from its new icon and come back to Settings."));
    } else if (state === "native") {
      parts.push(el("p", "set-lead", "Not in this app yet"),
        el("p", "set-body", "Notifications come through the browser version. Open Lumbridge in Chrome and add it to your Home Screen."));
    } else if (state === "unsupported") {
      parts.push(el("p", "set-lead", "This browser can't get notifications"),
        el("p", "set-body", "Try Chrome, Edge or Firefox, or Safari from the Home Screen on an iPhone."));
    } else if (state === "denied") {
      parts.push(el("p", "set-lead", "Notifications are blocked on this device"),
        el("p", "set-body", "Lumbridge can't ask again. To fix it:"), blockedHelp());
    } else if (!config?.publicKey) {
      parts.push(el("p", "set-lead", "Notifications aren't available"),
        el("p", "set-body", config ? "The gateway has no push key. Its log says why." : "Lumbridge can't reach the gateway right now."));
    } else if (state === "off") {
      const key = config.publicKey;
      parts.push(el("p", "set-lead", "Get told when an agent needs you"),
        el("p", "set-body", "Your phone buzzes when an agent is waiting or finishes. Tap it to go straight there."),
        button("Turn on notifications", "primary set-wide", () => turnOn(key)));
    } else {
      const actions = el("div", "set-actions");
      actions.append(
        button("Send a test", "set-button", async () => {
          const r = await sendTest();
          note = r.sent ? { text: "Sent. It should arrive in a few seconds.", bad: false }
            : r.removed ? { text: "This device's subscription had expired. Turn notifications on again.", bad: true }
            : { text: r.reason ? `That didn't go through: ${r.reason}` : "That didn't go through. Check your connection and try again.", bad: true };
        }),
        button("Turn off", "set-button", async () => {
          await turnOff();
          note = { text: "Notifications are off on this device.", bad: false };
        }));
      parts.push(el("p", "set-lead on", "Notifications are on"), el("p", "set-body", "On this device."), actions);
    }
    parts.push(message());
    notifications.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
  };

  const save = async (next: Prefs) => {
    const before = prefs;
    prefs = next;
    note = null;
    try { prefs = await putPrefs(next); } catch { prefs = before; note = { text: "That didn't save. Check your connection and try again.", bad: true }; await paint(); return; }
    paintPrefs();
  };

  const paintPrefs = () => {
    if (!prefs) { prefsHome.replaceChildren(); return; }
    const p = prefs;
    const card = el("section", "set-card");
    card.append(
      toggle("Needs you", "An agent is waiting for an answer or hit an error.", p.needsYou, (needsYou) => save({ ...p, needsYou })),
      toggle("Finished", "An agent is done with what you asked.", p.finished, (finished) => save({ ...p, finished })),
      toggle("Quiet hours", "Nothing buzzes during these hours, and what you missed doesn't come later.", p.quiet.enabled,
        (enabled) => save({ ...p, quiet: { ...p.quiet, enabled } })));
    if (p.quiet.enabled) {
      const times = el("div", "set-times");
      const time = (label: string, value: string, change: (v: string) => void) => {
        const l = el("label", "set-time", label);
        const i = el("input");
        i.type = "time";
        i.value = value;
        i.onchange = () => { if (i.value) change(i.value); };
        l.append(i);
        return l;
      };
      times.append(time("From", p.quiet.start, (start) => save({ ...p, quiet: { ...p.quiet, start } })),
        time("To", p.quiet.end, (end) => save({ ...p, quiet: { ...p.quiet, end } })));
      card.append(times);
      if (config?.clock) card.append(el("p", "set-hint set-clock", `Uses the server's clock, which says ${config.clock}.`));
    }
    prefsHome.replaceChildren(el("h2", "", "Tell me when"), card);
  };

  const paintDevice = () => {
    const how = !isWeb ? "Android app" : isStandalone() ? "Home Screen app" : "Browser";
    device.replaceChildren(fact("Device", deviceName()), fact("Running as", how), fact("Lumbridge version", config?.version ?? "…"));
  };

  async function paint() {
    const state = await pushState();
    if (!live) return;
    paintNotifications(state);
    if (state === "on" && !prefs) prefs = await getPrefs().catch(() => null);
    if (!live) return;
    if (state === "on") paintPrefs(); else prefsHome.replaceChildren();
    paintDevice();
  }

  notifications.append(el("p", "set-body", "Checking…"));
  paintDevice();
  getConfig().then((c) => { config = c; }, () => {}).finally(() => { if (live) paint(); });
  return () => { live = false; };
}

function explain(e: Error): string {
  if (e.message === "denied") return "Notifications were blocked. Allow them in your settings to turn this on.";
  if (e.message === "default") return "Notifications stay off. Tap again when you're ready, and choose Allow.";
  if (e.message === "expired") return "This device's subscription had expired. Turn notifications on again.";
  if (e.message === "no-worker") return "Lumbridge isn't fully loaded yet. Reload and try again.";
  if (e.name === "AbortError" || e.name === "NotAllowedError") return "This device's push service said no. Check your connection and try again.";
  return "That didn't work. Check your connection and try again.";
}
