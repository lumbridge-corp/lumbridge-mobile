// Writes `<file>.br` and `<file>.gz` beside every text file in the build, so the gateway can send them as they are
// (ServeDir's precompressed_br/precompressed_gzip in gateway/src/main.rs). `npm run build` runs this last, after the worker
// is stamped: the stamp hashes the plain files only. Node's own zlib, no dependency. A file under 1 KB, or one whose
// compressed form isn't smaller, is left plain.
//   node scripts/compress.mjs [dir]   default dist
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const TYPES = new Set([".js", ".css", ".html", ".svg", ".json", ".webmanifest"]);
const MIN = 1024;

/** Compresses every eligible file under `dir`. Returns the plain and brotli byte totals. */
export function compress(dir) {
  const total = { plain: 0, br: 0, gz: 0 };
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      // The gateway would still serve a variant whose file is gone.
      if (/\.(br|gz)$/.test(e.name)) { if (!existsSync(p.slice(0, -3))) rmSync(p); continue; }
      if (!TYPES.has(extname(e.name))) continue;
      // A stale variant from an earlier run must never outlive its file.
      rmSync(`${p}.br`, { force: true });
      rmSync(`${p}.gz`, { force: true });
      const data = readFileSync(p);
      if (data.length <= MIN) continue;
      total.plain += data.length;
      const br = brotliCompressSync(data, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
      });
      const gz = gzipSync(data, { level: 9 });
      if (br.length < data.length) { writeFileSync(`${p}.br`, br); total.br += br.length; } else total.br += data.length;
      if (gz.length < data.length) { writeFileSync(`${p}.gz`, gz); total.gz += gz.length; } else total.gz += data.length;
    }
  };
  walk(dir);
  return total;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const t = compress(process.argv[2] ?? "dist");
  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`compressed ${kb(t.plain)} of text: ${kb(t.br)} brotli, ${kb(t.gz)} gzip`);
}
