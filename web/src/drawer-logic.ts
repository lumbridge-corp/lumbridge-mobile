// The drawer's arithmetic, kept apart so it can be tested. Constants from MIT sources, read and not imported:
// Ionic Framework core/src/utils/gesture/index.ts, components/modal/gestures/{sheet,swipe-to-close}.ts; Vaul src/helpers.ts.
export const AXIS_LOCK = 10, GAP_MS = 100, FLICK_MS = 350, FULL_MS = 200, EASE = "cubic-bezier(.32,.72,0,1)";
/** Vaul's VELOCITY_THRESHOLD, in pixels per millisecond: a flick this fast goes the way it was going, however tall the sheet. */
export const FLICK_V = 0.4;
/** The quickest a settle after a drag may be. */
export const SETTLE_MIN_MS = 150;
/** A whole touch this short and this long is a flick, however its speed was sampled: two or three moves are all it gives. */
export const QUICK_MS = 300, QUICK_PX = 20;

export const clamp = (lo: number, v: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Pixels per millisecond, smoothed. A gap of 100 ms or more says nothing about speed, so it changes nothing. */
export const nextVelocity = (v: number, dy: number, dt: number) => (dt > 0 && dt < GAP_MS ? (dy / dt) * 0.7 + v * 0.3 : v);

/** A finger that stopped before it lifted isn't flicking, however fast it was going. */
export const releaseVelocity = (v: number, sinceLastMove: number) => (sinceLastMove < GAP_MS ? v : 0);

/** `x`, `y`, or null while it could still be either. */
export function axisLock(dx: number, dy: number): "x" | "y" | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK) return null;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/** How far a sheet follows a finger past fully open: 8(ln(d+1)-2), and nothing until that turns positive. */
export const damp = (over: number) => Math.max(0, 8 * (Math.log(Math.max(0, over) + 1) - 2));

/** Offset of the sheet (0 is fully open, positive is lower) for a raw offset under the finger. */
export const follow = (raw: number) => (raw >= 0 ? raw : -damp(-raw));

/** Where the drag is heading. A flick faster than FLICK_V goes its own way; anything slower, its position 350 ms on, then the
 * nearer of open and closed. Without the first rule a taller sheet (another row of apps) would need a longer flick to close. */
export const snapsOpen = (y: number, v: number, closedAt: number) =>
  v > FLICK_V ? false : v < -FLICK_V ? true : y + v * FLICK_MS < closedAt / 2;

/** A quick flick's way, from the whole touch (down to up): 1 down, -1 up, 0 not a flick. One that stopped before it lifted isn't. */
export function quickFlick(dy: number, ms: number, sinceLastMove: number): -1 | 0 | 1 {
  if (ms >= QUICK_MS || sinceLastMove >= GAP_MS || Math.abs(dy) < QUICK_PX) return 0;
  return dy > 0 ? 1 : -1;
}

/** clamp(150, remaining/|v*1.1|, 200): DESIGN.md caps motion at 200 ms, and a fast flick may settle quicker. Standing still, or
 * nothing left to cover, takes the full time. */
export function settleMs(remaining: number, v: number) {
  const ms = Math.abs(remaining) / Math.abs(v * 1.1);
  return Number.isFinite(ms) ? clamp(SETTLE_MIN_MS, ms, FULL_MS) : FULL_MS;
}
