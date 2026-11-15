// Every screen, in one place. A phone gets the tabs and an Apps tab for the rest; the rail on a computer shows them all.
import type { icons } from "./icons";
import { filesView, settingsView } from "./lazy-screens";
import { notesView } from "./views/notes";
import { assistantView } from "./views/assistant";
import { ASSISTANT_NAME } from "./ns";
import { tasksView } from "./views/tasks";
import { thoughtsView } from "./views/thoughts";
import { todayView } from "./views/today";

/** The rail and the Apps sheet keep screens of a group together, in this order: hairlines between them on the rail, a labelled
 * section each in the sheet. A screen added to a group's run in SCREENS lands in its place with nothing else to change. */
export const GROUPS = { daily: "Daily", media: "Media", system: "System" } as const;
export type Group = keyof typeof GROUPS;

export interface Screen {
  id: string;
  label: string;
  /** What a screen reader and the tooltip say, where the short label leaves something out. */
  name?: string;
  group: Group;
  icon: keyof typeof icons;
  where: "tab" | "drawer";
  /** Null: the Agents tab, which main.ts keeps alive under everything. Its By place view is route #/panes. */
  view: ((root: HTMLElement) => () => void) | null;
  /** Sits at the far end of the rail. */
  end?: boolean;
  /** Its own routes under it, `#/<id>/<sub>`. The view reads the rest of the route itself. */
  subroutes?: boolean;
  /** For a screen from src/ext/: the screen it goes before. Without it, it goes at the end of its group. */
  before?: string;
}

const BASE: Screen[] = [
  { id: "today", label: "Today", group: "daily", icon: "today", where: "tab", view: todayView },
  { id: "agents", label: "Agents", group: "daily", icon: "agents", where: "tab", view: null },
  { id: "assistant", label: ASSISTANT_NAME, group: "daily", icon: "assistant", where: "tab", view: assistantView },
  { id: "tasks", label: "Tasks", group: "daily", icon: "tasks", where: "tab", view: tasksView },
  { id: "thoughts", label: "Thoughts", group: "daily", icon: "thoughts", where: "drawer", view: thoughtsView },
  { id: "notes", label: "Notes", group: "daily", icon: "notes", where: "drawer", view: notesView },
  { id: "files", label: "Files", group: "media", icon: "files", where: "drawer", view: filesView },
  { id: "settings", label: "Settings", group: "system", icon: "settings", where: "drawer", view: settingsView, end: true },
];

// An instance's own screens, from src/ext/screens.ts when that folder is there (it is not part of the public tree).
const ext = import.meta.glob<{ EXT_SCREENS: Screen[] }>("./ext/screens.ts", { eager: true });
for (const mod of Object.values(ext)) {
  for (const screen of mod.EXT_SCREENS) {
    let at = screen.before ? BASE.findIndex((s) => s.id === screen.before) : -1;
    if (at < 0) {
      const last = BASE.map((s) => s.group === screen.group && !s.end).lastIndexOf(true);
      at = last < 0 ? BASE.findIndex((s) => s.end) : last + 1;
      if (at < 0) at = BASE.length;
    }
    BASE.splice(at, 0, screen);
  }
}
export const SCREENS: Screen[] = BASE;
