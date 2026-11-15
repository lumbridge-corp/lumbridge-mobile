// Tasks' way to the server, shared by Tasks and Today's capture: one queue of captures kept on the device until the server has
// them (each with an id chosen here, so a retry can't make two), and the small changes that go again if they lost a race.
import { loadPending, type Pending, type Task } from "../data/tasks-logic";
import { jsonInit, request, type Failure } from "./data-ui";
import { NS } from "../ns";

const PENDING_KEY = `${NS}.tasks.pending`;

export function pendingTasks(): Pending[] {
  try { return loadPending(localStorage.getItem(PENDING_KEY)); } catch { return []; }
}
export function savePendingTasks(p: Pending[]) {
  try { if (p.length) localStorage.setItem(PENDING_KEY, JSON.stringify(p)); else localStorage.removeItem(PENDING_KEY); } catch { /* memory only this time */ }
}

/** Kept first, then sent. Offline or down, it stays in the queue and Tasks sends it next time it opens. */
export async function captureTask(title: string, due_on: string | null): Promise<{ ok: Task } | { kept: Failure } | { rejected: true }> {
  const p: Pending = { id: crypto.randomUUID(), title, due_on, sort_key: Date.now() };
  savePendingTasks([...pendingTasks(), p]);
  const res = await request<Task>("/api/tasks", jsonInit("POST", p));
  if (res.ok) { savePendingTasks(pendingTasks().filter((x) => x.id !== p.id)); return { ok: res.ok }; }
  if (res.fail === "rejected") { savePendingTasks(pendingTasks().filter((x) => x.id !== p.id)); return { rejected: true }; }
  return { kept: res.fail ?? "offline" };
}

/** A small change (done, pin). If it lost a race, it goes again on the newer version: these don't touch the owner's text. */
export async function changeTask(t: Task, patch: Record<string, unknown>, seen: (current: Task) => void = () => {}): Promise<Task | null> {
  const path = `/api/tasks/${t.id}`;
  let res = await request<Task>(path, jsonInit("PATCH", { version: t.version, ...patch }));
  if (res.fail === "conflict" && res.current && !res.current.deleted_at) {
    seen(res.current);
    res = await request<Task>(path, jsonInit("PATCH", { version: res.current.version, ...patch }));
  }
  return res.ok;
}
