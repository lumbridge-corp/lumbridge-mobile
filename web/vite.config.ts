import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";

/** An instance's own screens (src/ext/screens.ts) that load as their own chunks: `lazy("Name", () => import("./views/<file>")…)`. */
const EXT_SCREENS = "src/ext/screens.ts";
const extLazy = existsSync(EXT_SCREENS)
  ? [...readFileSync(EXT_SCREENS, "utf8").matchAll(/lazy\("[^"]*",\s*\(\)\s*=>\s*import\("\.\/views\/([\w-]+)"\)/g)].map((m) => m[1])
  : [];
/** Built chunks the worker precaches: For you, every screen in src/lazy-screens.ts, and an instance's lazy screens. */
const LAZY = new RegExp(`^(${["for-you", "files", "settings", ...extLazy].join("|")})-[\\w-]+\\.(js|css)$`);

// Stamps the worker with a hash of the built app, and the list of its chunks. New build, new bytes, so the browser installs it, which is the only way
// an installed client drops the old build's cached files.
function stampWorker() {
  return {
    name: "stamp-worker",
    apply: "build" as const,
    closeBundle() {
      // index.html names For you's chunk, for the page to ask for it again by URL after a failed import (views/tasks.ts).
      const forYou = readdirSync(join("dist", "assets")).find((n) => /^for-you-[\w-]+\.js$/.test(n));
      if (!forYou) throw new Error("no for-you chunk in the build");
      const page = join("dist", "index.html");
      writeFileSync(page, readFileSync(page, "utf8").replace("</head>", `<meta name="lumbridge-for-you" content="/assets/${forYou}">\n</head>`));
      const hash = createHash("sha256");
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p);
          // .br/.gz come later (scripts/compress.mjs) and only repeat these bytes.
          else if (e.name !== "sw.js" && !/\.(br|gz)$/.test(e.name)) hash.update(e.name).update(readFileSync(p));
        }
      };
      walk("dist");
      // The chunks index.html doesn't name, for the worker to precache: For you, which Today fetches once it's up, and the screens that
      // load as their own (src/lazy-screens.ts), with their CSS. An offline start must find them all the same. Not xterm's, which the
      // page's own idle prefetch caches, nor TV's, which only works online.
      const chunks = readdirSync(join("dist", "assets")).filter((n) => LAZY.test(n)).map((n) => `/assets/${n}`);
      const file = join("dist", "sw.js");
      writeFileSync(file, readFileSync(file, "utf8").replaceAll("__BUILD__", hash.digest("hex").slice(0, 12)).replaceAll("__CHUNKS__", chunks.join(",")));
      // The theme is read before the app loads (public/theme-boot.js), under the same storage prefix as the app's (src/ns.ts).
      const boot = join("dist", "theme-boot.js");
      writeFileSync(boot, readFileSync(boot, "utf8").replaceAll("__STORAGE_NS__", process.env.VITE_STORAGE_NS || "lumbridge"));
    },
  };
}

export default defineConfig({ plugins: [stampWorker()], build: { outDir: "dist", target: "es2022" } });
