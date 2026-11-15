// Answer a blocked agent from the list: its own numbered choices as buttons. A button presses a real key in a real program, and
// lists move under a thumb, so the first tap only arms it and says what it will do. The second presses it, if the screen
// still offers exactly that (`pressChoice`).
import { connected, onConn, pressChoice, type Choice } from "../app";
import { choiceFit, shortLabel } from "../choices-logic";
import { el, pressWord, setOff } from "../dom";

const ARM_MS = 3000;

// Offline, a press can't reach the program: every choice on the page is off, the banner says why, and they come back by themselves.
const syncAll = () => {
  const off = !connected();
  for (const b of document.querySelectorAll<HTMLButtonElement>(".row-choices .choice")) setOff(b, off || b.dataset.busy !== undefined);
};
onConn(syncAll);

export function choiceBar(address: string) {
  const root = el("div", "row-choices");
  root.hidden = true;
  let shown = "";
  let armed: { button: HTMLButtonElement; label: string; timer: number } | null = null;

  const disarm = () => {
    if (!armed) return;
    clearTimeout(armed.timer);
    armed.button.textContent = armed.label;
    armed.button.classList.remove("armed");
    armed = null;
  };

  // The button says it short; its title and aria-label keep the program's own words, and pressChoice checks those, not these.
  function button(c: Choice) {
    const short = shortLabel(c.label);
    const b = el("button", "choice", short);
    b.type = "button";
    b.dataset.key = c.key;
    b.title = c.label;
    b.setAttribute("aria-label", `Answer ${c.key}: ${c.label}`);
    setOff(b, !connected());
    b.onclick = async () => {
      if (armed?.button !== b) {
        disarm();
        b.textContent = `${pressWord()} again: ${short}`; // "Click again" with a mouse
        b.classList.add("armed");
        armed = { button: b, label: short, timer: window.setTimeout(disarm, ARM_MS) };
        return;
      }
      disarm();
      navigator.vibrate?.(8);
      for (const other of root.querySelectorAll("button")) { other.dataset.busy = ""; setOff(other, true); }
      let note = "";
      try {
        if (!(await pressChoice(address, c))) note = "The question has changed. Open it to see.";
      } catch (e) {
        note = (e as Error).message;
      }
      // On success the agent moves on and this row goes. Until then, or if it didn't work, the owner can still act.
      for (const other of root.querySelectorAll("button")) { delete other.dataset.busy; setOff(other, !connected()); }
      if (note) { shown = ""; root.replaceChildren(el("span", "choice-note", note)); }
    };
    return b;
  }

  return {
    root,
    show(choices: Choice[]) {
      const next = JSON.stringify(choices);
      if (next === shown) return;
      shown = next;
      disarm();
      root.hidden = !choices.length;
      root.dataset.fit = choiceFit(choices.map((c) => shortLabel(c.label)));
      root.replaceChildren(...choices.map(button));
    },
  };
}
