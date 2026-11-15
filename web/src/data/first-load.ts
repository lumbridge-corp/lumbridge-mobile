// Where a list stands on this visit (Notes, Tasks). A first GET that failed is not an empty list: until one has worked, the
// screen shows neither its empty state nor a count, only why it isn't there yet. Nothing here is kept on the device.

export type FirstLoad = "loading" | "loaded" | "offline" | "unreachable";

/** After a GET: loaded for good once one has worked; before that, why not. `online`: the device has a network at all. */
export function afterLoad(prev: FirstLoad, ok: boolean, online: boolean): FirstLoad {
  if (ok || prev === "loaded") return "loaded";
  return online ? "unreachable" : "offline";
}

/** The one line shown in place of a list that hasn't loaded, or null when there's nothing to say. */
export function notLoadedText(s: FirstLoad): string | null {
  if (s === "offline") return "Not loaded: you're offline.";
  if (s === "unreachable") return "Can't reach Lumbridge right now.";
  return null;
}
