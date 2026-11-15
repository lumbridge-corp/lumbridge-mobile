/** The prefix of every name this app keeps in the browser: localStorage keys, IndexedDB databases, locks. An install that used
 * another one builds with `VITE_STORAGE_NS=<prefix>`, so its devices keep their pairing, drafts and queues. */
export const NS: string = import.meta.env.VITE_STORAGE_NS || "lumbridge";

/** What the assistant is called on screen. An install that gave it a name builds with `VITE_ASSISTANT_NAME=<name>`. */
export const ASSISTANT_NAME: string = import.meta.env.VITE_ASSISTANT_NAME || "Assistant";

/** What the machine this server runs on is called in lists (its own terminals have no machine in their address). An install
 * that has a name for it builds with `VITE_SERVER_NAME=<name>`. */
export const SERVER_NAME: string = import.meta.env.VITE_SERVER_NAME || "Server";

/** Whether this build has an instance's own screens (src/ext/). Their server routes (the TV speaker, say) exist only then. */
export const HAS_EXT: boolean = Object.keys(import.meta.glob("./ext/screens.ts")).length > 0;
