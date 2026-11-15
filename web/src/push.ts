// Web Push from the browser's side. `turnOn` must run inside a tap: that's when a phone may ask permission.
import { getJson, isWeb, sendJson } from "./api";
import { isIOS, pushStateOf, type PushState } from "./push-state";

export interface PushConfig { publicKey: string | null; version: string; clock: string }
export interface Prefs { needsYou: boolean; finished: boolean; quiet: { enabled: boolean; start: string; end: string } }
export interface TestResult { sent: number; removed: number; failed: number; reason: string | null }

export { deviceName, isIOS, type PushState } from "./push-state";

export function isStandalone(): boolean {
  return matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

const hasPush = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** The active worker, or null if it isn't coming: `ready` alone never resolves without one. */
async function worker(): Promise<ServiceWorkerRegistration | null> {
  if (!hasPush()) return null;
  const late = new Promise<null>((r) => setTimeout(() => r(null), 4000));
  return Promise.race([navigator.serviceWorker.ready, late]);
}

async function current(): Promise<PushSubscription | null> {
  return (await (await worker())?.pushManager.getSubscription()) ?? null;
}

export async function pushState(): Promise<PushState> {
  const push = hasPush();
  return pushStateOf({
    native: !isWeb, ios: isIOS(), standalone: isStandalone(), hasPush: push,
    permission: push ? Notification.permission : null,
    subscribed: push ? !!(await current()) : false,
  });
}

const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const unb64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const getConfig = () => getJson<PushConfig>("/api/push/config");
export const getPrefs = () => getJson<Prefs>("/api/push/prefs");
export const putPrefs = (p: Prefs) => sendJson<Prefs>("/api/push/prefs", "PUT", p);

/** Tell the gateway. If the push service has declared this subscription dead (410), this browser drops it too. */
async function register(sub: PushSubscription): Promise<void> {
  try {
    await sendJson("/api/push/subscribe", "POST", sub.toJSON());
  } catch (e) {
    if ((e as Error).message.endsWith(": 410")) { await sub.unsubscribe().catch(() => {}); throw new Error("expired"); }
    throw e;
  }
}

/** Ask first, in the tap, before anything can use up the gesture. Then subscribe and tell the gateway. */
export async function turnOn(publicKey: string): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission);
  const reg = await worker();
  if (!reg) throw new Error("no-worker");
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key can't receive ours.
  const had = sub?.options.applicationServerKey;
  if (sub && had && unb64(had) !== publicKey) { await sub.unsubscribe(); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) });
  await register(sub);
}

export async function turnOff(): Promise<void> {
  const sub = await current();
  if (!sub) return;
  // Stop sending first: if the gateway can't be reached, this throws and stays on, which is what the screen says.
  await sendJson("/api/push/unsubscribe", "POST", { endpoint: sub.endpoint });
  await sub.unsubscribe();
}

export async function sendTest(): Promise<TestResult> {
  const sub = await current();
  if (!sub) throw new Error("not subscribed");
  await register(sub);
  const r = await sendJson<TestResult>("/api/push/test", "POST", { endpoint: sub.endpoint });
  // The push service says this subscription is dead: the gateway forgot it, so this browser should too.
  if (r.removed) await sub.unsubscribe().catch(() => {});
  return r;
}

/** A dead subscription found on start: quietly make a new one. Where that needs a tap, Settings now shows off. */
async function renew(e: Error) {
  if (e.message !== "expired") return;
  const { publicKey } = await getConfig();
  const reg = await worker();
  if (!publicKey || !reg) return;
  await register(await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) }));
}

/** On every start, with no prompt: report this browser's subscription and take taps from the worker. */
export function initPush() {
  if (!isWeb || !hasPush()) return;
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "lumbridge-open" && typeof e.data.hash === "string") location.hash = e.data.hash;
  });
  if (Notification.permission === "granted") current().then((s) => s && register(s)).catch(renew).catch(() => {});
}
