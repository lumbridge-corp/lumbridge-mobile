import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { compress } from "./compress.mjs";

describe("the build's precompressed files", () => {
  it("writes .br and .gz beside text files over 1 KB, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "compress-"));
    mkdirSync(join(dir, "assets"));
    const js = "export const x = 1;\n".repeat(200);
    writeFileSync(join(dir, "assets", "a.js"), js);
    writeFileSync(join(dir, "small.css"), "a{b:c}");
    writeFileSync(join(dir, "icon.png"), Buffer.alloc(4096));
    // Random bytes don't shrink: those stay plain.
    writeFileSync(join(dir, "noise.json"), Buffer.from(Array.from({ length: 4096 }, () => Math.floor(Math.random() * 256))));
    writeFileSync(join(dir, "gone.html.br"), "stale");
    writeFileSync(join(dir, "gone.html"), "<p>tiny</p>");
    writeFileSync(join(dir, "assets", "dropped.js.br"), "orphan");
    writeFileSync(join(dir, "assets", "dropped.js.gz"), "orphan");
    compress(dir);
    expect(brotliDecompressSync(readFileSync(join(dir, "assets", "a.js.br"))).toString()).toBe(js);
    expect(gunzipSync(readFileSync(join(dir, "assets", "a.js.gz"))).toString()).toBe(js);
    for (const f of ["small.css.br", "small.css.gz", "icon.png.br", "icon.png.gz", "noise.json.br", "noise.json.gz", "gone.html.br", "assets/dropped.js.br", "assets/dropped.js.gz"]) {
      expect(existsSync(join(dir, f)), f).toBe(false);
    }
  });
});
