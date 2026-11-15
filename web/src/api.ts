import { NS } from "./ns";
// HTTP to the gateway. Every /api call carries the device token.
const TOKEN_KEY = `${NS}.token`;
const HOST_KEY = `${NS}.host`;

export function store(k: string, v?: string): string | null {
  try { if (v !== undefined) localStorage.setItem(k, v); return localStorage.getItem(k); } catch { return null; }
}

export const token = (v?: string) => store(TOKEN_KEY, v);

// In Tauri the page is local, so the gateway's address is stored; in the PWA it's the page's own.
export const isWeb = !("__TAURI_INTERNALS__" in window);
export const host = (v?: string) => (isWeb ? location.host : store(HOST_KEY, v) ?? "");
export const wsUrl = () => (host() ? `${isWeb && location.protocol === "http:" ? "ws" : "wss"}://${host()}/ws` : null);
export const apiUrl = (path: string) => (isWeb ? path : `https://${host()}${path}`);

/** A non-2xx answer. The response is kept because some carry data: a 409 from /api/notes has the current row. */
export class ApiError extends Error {
  constructor(path: string, readonly status: number, readonly res: Response) {
    super(`${path}: ${status}`);
  }
}

// Set once the gateway has refused this device's token. From then on nothing is sent: retries would only use up the rate
// limit shared with every other client on this node. main.ts shows the pairing form; pairing again clears it.
let refusedToken: string | null = null;
export const UNPAIRED_EVENT = "lumbridge-unpaired";

export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const sent = token() ?? "";
  if (sent && sent === refusedToken) throw new TypeError("this device isn't paired");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${sent}`);
  const res = await fetch(apiUrl(path), { ...init, headers });
  if (res.status === 401 && sent && sent === token()) {
    refusedToken = sent;
    window.dispatchEvent(new Event(UNPAIRED_EVENT));
  }
  if (!res.ok) throw new ApiError(path, res.status, res);
  return res;
}

// Trades a one-time pairing code for this device's token, and keeps it. Throws "bad_code" for a code that's spent,
// expired or wrong, "refused" when this device isn't admitted, "too_many" after repeated failures.
export async function redeemPairCode(code: string): Promise<void> {
  const res = await fetch(apiUrl("/api/pair"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (res.status === 401) throw new Error("bad_code");
  if (res.status === 403) {
    // Admitted, but one of the devices the assistant can operate. Anything else refused never got as far as an answer.
    const why = await res.json().then((b: { error?: unknown }) => b.error, () => null);
    throw new Error(why === "not_from_here" ? "not_from_here" : "refused");
  }
  if (res.status === 429) throw new Error("too_many");
  if (!res.ok) throw new Error(`/api/pair: ${res.status}`);
  const body = (await res.json()) as { token: string };
  token(body.token);
}

export const getJson = async <T>(path: string): Promise<T> => (await api(path)).json();

export const sendJson = async <T>(path: string, method: string, body: unknown): Promise<T> =>
  (await api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
