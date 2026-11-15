// Hold a button to talk, let go to get the words. Uses the same mic and the same private speech path as the assistant; nothing is
// kept: the audio is cleared as soon as it has been sent.
import { api, ApiError } from "../api";
import { Mic, unlockAudio, type MicError } from "./assistant-audio";
import { encodeWav, resample } from "./assistant-logic";

const ASR_RATE = 16000;
const TOO_SHORT_MS = 350;
/** The gateway takes 4 MB, about 60 s. */
const MAX_MS = 55000;

export function holdToSpeak(button: HTMLButtonElement, on: { text: (words: string) => void; say: (message: string) => void }) {
  let mic: Mic | null = null;
  let heldMs = 0;
  let began = 0;

  async function finish() {
    const m = mic;
    if (!m) return;
    mic = null;
    m.release();
    button.classList.remove("listening");
    if (performance.now() - began < TOO_SHORT_MS) { m.clear(); on.say("Hold to talk"); return; }
    const wav = encodeWav(resample(m.samples(), m.rate, ASR_RATE), ASR_RATE);
    m.clear();
    button.classList.add("working");
    try {
      const res = await api("/api/voice/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
      const words = ((await res.json()) as { text: string }).text.trim();
      if (words) on.text(words); else on.say("I didn't catch that");
    } catch (e) {
      on.say(e instanceof ApiError ? "Speech isn't available right now" : "Not connected");
    } finally {
      button.classList.remove("working");
    }
  }

  const down = async (e: PointerEvent) => {
    e.preventDefault();
    if (mic || button.disabled) return;
    try { button.setPointerCapture(e.pointerId); } catch { /* the pointer already ended */ }
    const ctx = unlockAudio(); // first, and synchronously: this is the gesture iOS needs
    heldMs = 0;
    began = performance.now();
    const m = new Mic(ctx, (_level, ms) => {
      heldMs += ms;
      if (mic === m && heldMs >= MAX_MS) void finish();
    });
    mic = m;
    button.classList.add("listening");
    navigator.vibrate?.(8);
    try {
      await m.start();
    } catch (failure) {
      if (mic === m) mic = null;
      m.release();
      button.classList.remove("listening");
      const kind = failure as MicError;
      on.say(kind === "insecure" ? "The mic needs a secure page" : kind === "missing" ? "No microphone found" : "The mic isn't allowed");
    }
  };
  const up = () => { void finish(); };
  const noMenu = (e: Event) => e.preventDefault();
  button.addEventListener("pointerdown", down);
  button.addEventListener("pointerup", up);
  button.addEventListener("pointercancel", up);
  button.addEventListener("contextmenu", noMenu);

  return () => {
    button.removeEventListener("pointerdown", down);
    button.removeEventListener("pointerup", up);
    button.removeEventListener("pointercancel", up);
    button.removeEventListener("contextmenu", noMenu);
    mic?.release();
    mic?.clear();
    mic = null;
  };
}
