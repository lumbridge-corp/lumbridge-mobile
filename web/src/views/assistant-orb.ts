// The assistant's orb: a plain disc with a solid core, drawn from the theme's tokens in CSS (assistant.css), so it's crisp and right in
// both themes. Her state shows in its form, not in a glow: idle is a still core; listening shrinks the core and a hairline ring
// moves out with the owner's voice; thinking is an arc going round the rim; speaking makes the core move with her voice; error is the
// outline only, with nothing inside. This file only sets the state and, while she listens or speaks, the level (--lv).

export type OrbState = "idle" | "listening" | "thinking" | "speaking" | "error";

export interface Orb {
  setState(s: OrbState): void;
  /** Sound level now, roughly 0..1. Read every frame while listening or speaking. */
  setLevelSource(fn: () => number): void;
  destroy(): void;
}

/** From one frame's raw level to what the orb shows: quick to rise, slower to fall, so speech reads as movement, not flicker. */
export function smoothLevel(shown: number, raw: number, dt: number): number {
  // sqrt: speech at -30 dB should still move it visibly.
  const target = Math.min(1, Math.sqrt(Math.max(0, raw)) * 1.5);
  const rate = target > shown ? 18 : 6;
  return shown + (target - shown) * Math.min(1, dt * rate);
}

/** Builds the orb inside `host` (the button). */
export function createOrb(host: HTMLElement): Orb {
  const box = document.createElement("span");
  box.className = "po";
  box.setAttribute("aria-hidden", "true");
  for (const part of ["ring", "body", "arc", "core"]) {
    const s = document.createElement("span");
    s.className = `po-${part}`;
    box.append(s);
  }
  host.append(box);

  const still = matchMedia("(prefers-reduced-motion: reduce)");
  let state: OrbState = "idle";
  let levelSource: () => number = () => 0;
  let level = 0;
  let frame = 0;
  let last = 0;

  const live = () => state === "listening" || state === "speaking";
  const paint = () => box.style.setProperty("--lv", level.toFixed(3));

  function tick(now: number) {
    frame = 0;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    level = smoothLevel(level, live() ? levelSource() : 0, dt);
    paint();
    schedule();
  }

  /** Frames only while a level is moving it. With reduced motion there's no loop and the level stays at rest. */
  function schedule() {
    if (frame || still.matches || document.hidden) return;
    if (live() || level > 0.002) frame = requestAnimationFrame(tick);
    else if (level) { level = 0; paint(); }
  }

  function refresh() {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    if (still.matches || document.hidden) { level = 0; paint(); }
    last = performance.now();
    schedule();
  }

  document.addEventListener("visibilitychange", refresh);
  still.addEventListener("change", refresh);
  box.dataset.state = state;
  paint();

  return {
    setState(s) {
      state = s;
      box.dataset.state = s;
      last = performance.now();
      schedule();
    },
    setLevelSource(fn) { levelSource = fn; },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      document.removeEventListener("visibilitychange", refresh);
      still.removeEventListener("change", refresh);
      box.remove();
    },
  };
}
