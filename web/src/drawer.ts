// The Apps sheet: it rises from behind the tab bar, so the tabs and the agents badge stay in sight. Our own code, no dependency.
import "./drawer.css";
import { el } from "./dom";
import { axisLock, clamp, EASE, follow, FULL_MS, nextVelocity, quickFlick, releaseVelocity, settleMs, snapsOpen } from "./drawer-logic";
import { icon, type icons } from "./icons";
import { openPalette } from "./palette-key";
import { isIOS } from "./push-state";
import { GROUPS, type Group } from "./screens";

export interface DrawerApp { id: string; label: string; icon: keyof typeof icons; name?: string; group: Group }

export function createDrawer(host: HTMLElement, tab: HTMLElement, apps: DrawerApp[]) {
  const layer = el("div", "drawer-layer");
  layer.hidden = true;
  const scrim = el("div", "drawer-scrim");
  const sheet = el("div", `drawer ${isIOS() ? "drawer-ios" : "drawer-android"}`);
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "Apps");
  sheet.tabIndex = -1;
  const handle = el("button", "drawer-handle");
  handle.type = "button";
  handle.setAttribute("aria-label", "Close apps");
  // One section per group, in the order the apps come: a label, then its tiles.
  const grid = el("div", "drawer-grid");
  const tiles = new Map<string, HTMLAnchorElement>();
  let row: HTMLElement | null = null, group: Group | null = null;
  for (const a of apps) {
    if (a.group !== group || !row) {
      group = a.group;
      const sec = el("section", "drawer-sec");
      const label = el("h2", "drawer-label", GROUPS[a.group]);
      label.id = `drawer-${a.group}`;
      sec.setAttribute("aria-labelledby", label.id);
      row = el("div", "drawer-tiles");
      sec.append(label, row);
      grid.append(sec);
    }
    const tile = el("a", "app");
    tile.href = `#/${a.id}`;
    tile.draggable = false;
    if (a.name) { tile.setAttribute("aria-label", a.name); tile.title = a.name; }
    tile.append(icon(a.icon, "app-ic"), el("span", "app-label", a.label));
    tile.onclick = () => setOpen(false); // going to where it already is makes no hashchange
    tiles.set(a.id, tile);
    row.append(tile);
  }
  // Every screen and agent by name, for when the owner knows where the owner is going.
  const find = el("button", "drawer-find");
  find.type = "button";
  find.setAttribute("aria-label", "Jump to");
  find.title = "Jump to";
  find.append(icon("search"));
  find.addEventListener("click", () => { setOpen(false, 0); openPalette(); });
  const top = el("div", "drawer-top");
  top.append(el("div", "drawer-title", "Apps"), find);
  sheet.append(handle, top, grid);
  layer.append(scrim, sheet);
  host.append(layer);

  let open = false, y = 0, closedAt = 0, timer = 0, dragged = false;
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  function place(to: number, ms = 0) {
    y = to;
    sheet.style.transition = ms ? `transform ${ms}ms ${EASE}` : "none";
    scrim.style.transition = ms ? `opacity ${ms}ms ${EASE}` : "none";
    sheet.style.transform = `translate3d(0,${to}px,0)`;
    scrim.style.opacity = String(closedAt ? clamp(0, 1 - to / closedAt, 1) : 1);
  }

  /** Off screen, in the layout, ready to rise. */
  function appear() {
    if (layer.hidden) {
      layer.hidden = false;
      closedAt = sheet.offsetHeight;
      place(closedAt);
      void sheet.offsetHeight;
    }
    closedAt = sheet.offsetHeight;
  }

  /** Where it is right now, if it's part way through a settle. */
  function freeze() {
    clearTimeout(timer);
    const m = new DOMMatrixReadOnly(getComputedStyle(sheet).transform);
    place(m.m42);
  }

  function setOpen(want: boolean, ms: number = FULL_MS) {
    if (want) appear();
    if (want !== open) {
      open = want;
      tab.setAttribute("aria-expanded", String(want));
      for (const c of host.children) if (c !== layer) (c as HTMLElement).inert = want;
      if (want) {
        // More apps than fit on a short screen: the grid scrolls, and the handle still drags.
        grid.style.touchAction = grid.scrollHeight > grid.clientHeight ? "pan-y" : "";
        sheet.focus({ preventScroll: true });
      } else if (layer.contains(document.activeElement) || document.activeElement === document.body) tab.focus({ preventScroll: true });
    }
    if (layer.hidden) return;
    const time = still() ? 0 : ms;
    place(want ? 0 : closedAt, time);
    clearTimeout(timer);
    // On a timer, never transitionend: under reduced motion style.css forces `transition: none`, and it wouldn't fire.
    timer = window.setTimeout(() => { if (!open) layer.hidden = true; }, time);
  }

  /** One finger at a time. From the tab the sheet can only be pulled up, out of the bar. */
  function track(from: HTMLElement, upOnly: boolean) {
    let p: { id: number; sx: number; sy: number; y0: number; t0: number; base: number; ly: number; lt: number; v: number; on: boolean } | null = null;
    from.addEventListener("pointerdown", (e) => {
      dragged = false;
      if (e.button === 0 && !p) p = { id: e.pointerId, sx: e.clientX, sy: e.clientY, y0: e.clientY, t0: e.timeStamp, base: 0, ly: e.clientY, lt: e.timeStamp, v: 0, on: false };
    });
    from.addEventListener("pointermove", (e) => {
      if (!p || e.pointerId !== p.id) return;
      if (!p.on) {
        const axis = axisLock(e.clientX - p.sx, e.clientY - p.sy);
        if (!axis) return;
        // Sideways, or down out of the tab: not ours, for the rest of this touch.
        if (axis === "x" || (upOnly && e.clientY > p.sy)) { p = null; return; }
        appear();
        freeze();
        from.setPointerCapture(e.pointerId);
        p.on = dragged = true;
        Object.assign(p, { sy: e.clientY, base: y, ly: e.clientY, lt: e.timeStamp });
        sheet.classList.add("dragging");
        return;
      }
      p.v = nextVelocity(p.v, e.clientY - p.ly, e.timeStamp - p.lt);
      p.ly = e.clientY;
      p.lt = e.timeStamp;
      place(follow(p.base + e.clientY - p.sy));
    });
    const end = (e: PointerEvent) => {
      if (!p || e.pointerId !== p.id) return;
      const { on, lt, y0, t0 } = p;
      // The click that follows a drag lands in a moment, if at all.
      window.setTimeout(() => { dragged = false; }, 400);
      const v = e.type === "pointercancel" ? 0 : releaseVelocity(p.v, e.timeStamp - lt);
      p = null;
      if (!on) return;
      sheet.classList.remove("dragging");
      const flick = e.type === "pointercancel" ? 0 : quickFlick(e.clientY - y0, e.timeStamp - t0, e.timeStamp - lt);
      const stay = flick ? flick < 0 : snapsOpen(y, v, closedAt);
      setOpen(stay, settleMs(stay ? y : closedAt - y, v));
    };
    from.addEventListener("pointerup", end);
    from.addEventListener("pointercancel", end);
    // A drag that began on a tile, or on the tab, isn't a tap on it.
    from.addEventListener("click", (e) => { if (dragged) { dragged = false; e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  }
  track(sheet, false);
  track(tab, true);

  tab.addEventListener("click", () => setOpen(!open));
  scrim.addEventListener("click", () => setOpen(false));
  handle.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => {
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    if (e.key !== "Tab") return;
    const all = [...sheet.querySelectorAll<HTMLElement>("a, button")];
    const i = all.indexOf(document.activeElement as HTMLElement);
    all[e.shiftKey ? (i <= 0 ? all.length - 1 : i - 1) : (i + 1) % all.length]?.focus();
    e.preventDefault();
  }, true);
  // Wide enough for the rail, there's nothing to open it with.
  matchMedia("(min-width: 900px)").addEventListener("change", (e) => { if (e.matches) setOpen(false, 0); });

  return {
    close: () => setOpen(false),
    /** Which screen is showing, so its tile can say so. */
    mark(current: string) {
      for (const [id, tile] of tiles) {
        tile.classList.toggle("on", id === current);
        if (id === current) tile.setAttribute("aria-current", "page"); else tile.removeAttribute("aria-current");
      }
    },
  };
}
