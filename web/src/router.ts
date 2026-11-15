import { NS } from "./ns";
// Hash routes: #/today, #/agents, #/t/<address>, #/panes, #/assistant, #/notes, #/thoughts, #/tasks, #/settings, and the routes of an instance's own screens (src/ext/).
export const go = (route: string) => { location.hash = `#/${route}`; };
/** A bare start, the brand mark and a fresh launch all land on Today. The Agents tab still remembers its own view (listView). */
export const START = "today";
export const route = () => location.hash.replace(/^#\/?/, "") || START;

// The Agents tab's two views have their own routes, and the one the owner was last on is where the tab and a bare start go.
export type ListView = "agents" | "panes";
const LIST_KEY = `${NS}.agents.list`;
export function listView(): ListView { try { return localStorage.getItem(LIST_KEY) === "panes" ? "panes" : "agents"; } catch { return "agents"; } }
export function setListView(v: ListView) { try { localStorage.setItem(LIST_KEY, v); } catch { /* only a convenience */ } }

// Which screen a terminal goes back to. It survives a reload: a new build reloads the page under an open terminal.
// Today too: a card there opens its terminal, and Back should land the owner where the owner was deciding.
export type Origin = ListView | "today";
const ORIGIN_KEY = `${NS}.term.origin`;
const stored = () => { try { return sessionStorage.getItem(ORIGIN_KEY); } catch { return null; } };
const asOrigin = (s: string | null): Origin => (s === "panes" || s === "today" ? s : "agents");
let origin: Origin = asOrigin(stored() ?? listView());

/** From `prev` (null when this page has only just loaded) to a terminal. Terminal to terminal keeps what it had. */
export const originAfter = (prev: string | null, current: Origin): Origin =>
  prev === null || prev.startsWith("t/") ? current : prev === "panes" || prev === "today" ? prev : "agents";

/** The list a terminal sits beside on a computer: Today isn't one, so it's the Agents tab's own. */
export const originList = (o: Origin): ListView => (o === "today" ? listView() : o);

export const terminalOrigin = () => origin;
export function setTerminalOrigin(o: Origin) {
  origin = o;
  try { sessionStorage.setItem(ORIGIN_KEY, o); } catch { /* only a convenience */ }
}
