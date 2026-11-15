// Renders web/brand/*.svg to the PNGs in web/public. Run after changing a master:
//   (cd tests && npm i) && node scripts/make-icons.mjs
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../tests/package.json", import.meta.url));
const { chromium } = require("playwright");
const brand = new URL("../web/brand/", import.meta.url);
const pub = new URL("../web/public/", import.meta.url);
const svg = (n) => readFileSync(new URL(n, brand), "utf8");

const OPAQUE = [
  ["icon.svg", "icon-512.png", 512], ["icon.svg", "icon-192.png", 192],
  ["icon.svg", "icon-apple-touch-180.png", 180],
  ["icon-maskable.svg", "icon-maskable-512.png", 512], ["icon-maskable.svg", "icon-maskable-192.png", 192],
];
const CLEAR = [
  ["mark-mono.svg", "icon-mono-512.png", 512], ["mark-mono.svg", "icon-badge-96.png", 96],
  ["favicon.svg", "icon-favicon-32.png", 32],
];
// iPhone 14 Pro size only: iOS shows these while the installed app launches. Same backgrounds as the page.
const SPLASH = [["icon-splash-dark.png", "#0A0A0A"], ["icon-splash-light.png", "#FFFFFF"]];

const browser = await chromium.launch({ channel: "chrome" });
const shot = async (markup, w, h, transparent, out) => {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:${transparent ? "transparent" : "#000"}">${markup}</body></html>`);
  const png = await page.screenshot({ omitBackground: transparent });
  writeFileSync(new URL(out, pub), png);
  await page.close();
};
const sized = (s, n) => s.replace("<svg ", `<svg width="${n}" height="${n}" style="display:block" `);
for (const [src, out, n] of OPAQUE) await shot(sized(svg(src), n), n, n, false, out);
for (const [src, out, n] of CLEAR) await shot(sized(svg(src), n), n, n, true, out);
// The splash draws the mark alone in the ink that fits its background: white on the dark page, black on the light one.
const mark = (ink) => svg("mark-mono.svg").replace('fill="#fff"', `fill="${ink}"`);
for (const [out, bg] of SPLASH) {
  const ink = bg === "#0A0A0A" ? "#FAFAFA" : "#0A0A0A";
  await shot(`<div style="width:1179px;height:2556px;background:${bg};display:grid;place-items:center">${sized(mark(ink), 330)}</div>`, 1179, 2556, false, out);
}
await browser.close();
copyFileSync(new URL("favicon.svg", brand), new URL("icon-favicon.svg", pub));
copyFileSync(new URL("mark-mono.svg", brand), new URL("icon-mark.svg", pub));
console.log("icons written");
