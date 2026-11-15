import { describe, expect, it } from "vitest";
import { deviceName, isIOS, pushStateOf, type Facts } from "./push-state";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
const PIXEL = "Mozilla/5.0 (Linux; Android 15; Pixel 6) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36";

const base: Facts = { native: false, ios: false, standalone: false, hasPush: true, permission: "default", subscribed: false };

describe("pushStateOf", () => {
  const cases: [string, Partial<Facts>, string][] = [
    ["a fresh browser is off", {}, "off"],
    ["subscribed and allowed is on", { permission: "granted", subscribed: true }, "on"],
    ["allowed but not subscribed is off", { permission: "granted" }, "off"],
    ["blocked says so", { permission: "denied" }, "denied"],
    ["blocked beats a leftover subscription", { permission: "denied", subscribed: true }, "denied"],
    ["a subscription with permission taken back isn't on", { permission: "default", subscribed: true }, "off"],
    ["an iPhone in Safari must install", { ios: true, hasPush: false, permission: null }, "install-ios"],
    ["an iPhone in Safari that has the API must still install", { ios: true }, "install-ios"],
    ["an iPhone on the Home Screen works", { ios: true, standalone: true }, "off"],
    ["a browser without push", { hasPush: false, permission: null }, "unsupported"],
    ["the Android shell", { native: true, hasPush: false, permission: null }, "native"],
  ];
  for (const [name, facts, want] of cases) it(name, () => expect(pushStateOf({ ...base, ...facts })).toBe(want));
});

describe("devices", () => {
  it("sees an iPad pretending to be a Mac", () => {
    expect(isIOS(IPAD_AS_MAC, 5)).toBe(true);
    expect(isIOS(IPAD_AS_MAC, 0)).toBe(false);
    expect(isIOS(IPHONE, 5)).toBe(true);
    expect(isIOS(PIXEL, 5)).toBe(false);
  });
  it("names them", () => {
    expect(deviceName(IPHONE, 5)).toBe("iPhone");
    expect(deviceName(IPAD_AS_MAC, 5)).toBe("iPad");
    expect(deviceName(IPAD_AS_MAC, 0)).toBe("Mac");
    expect(deviceName(PIXEL, 5)).toBe("Android phone");
  });
});
