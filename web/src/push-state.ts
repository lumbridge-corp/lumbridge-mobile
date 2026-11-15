// What the settings screen shows, from plain facts. No browser state, so it can be tested.
export type PushState =
  | "native"      // the Android shell's webview: no Web Push there
  | "install-ios" // an iPhone in Safari: push exists only from the Home Screen
  | "unsupported" // this browser can't
  | "denied"      // blocked in the system's or browser's settings
  | "off"
  | "on";

export interface Facts {
  native: boolean; ios: boolean; standalone: boolean; hasPush: boolean;
  permission: NotificationPermission | null; subscribed: boolean;
}

/** Every state the screen can be in, decided from plain facts. */
export function pushStateOf(f: Facts): PushState {
  if (f.native) return "native";
  // iOS hides the Push API in a Safari tab, and also says "standalone" only from the Home Screen.
  if (f.ios && !f.standalone) return "install-ios";
  if (!f.hasPush) return "unsupported";
  if (f.permission === "denied") return "denied";
  return f.subscribed && f.permission === "granted" ? "on" : "off";
}

/** iPadOS asks to be treated as a Mac, so a Mac with a touch screen is an iPad. */
export function isIOS(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
}

export function deviceName(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (isIOS(ua, touchPoints)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows computer";
  if (/Linux/.test(ua)) return "Linux computer";
  return "This device";
}
