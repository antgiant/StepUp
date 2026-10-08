// Serves/emits the OCR engine's files from this site (no CDN at runtime), so the strict Content-Security-Policy holds
// and the page works offline. Files come straight from node_modules and are not committed.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
const CORES = ["tesseract-core-lstm", "tesseract-core-simd-lstm", "tesseract-core-relaxedsimd-lstm"];

/** @returns {Record<string, string>} public path -> file on disk */
function sources() {
  const out = {
    "ocr/worker.min.js": path.join(pkgDir("tesseract.js"), "dist/worker.min.js"),
    "ocr/lang/eng.traineddata.gz": path.join(pkgDir("@tesseract.js-data/eng"), "4.0.0_best_int/eng.traineddata.gz"),
  };
  for (const core of CORES) out[`ocr/core/${core}.wasm.js`] = path.join(pkgDir("tesseract.js-core"), `${core}.wasm.js`);
  return out;
}

export function ocrAssets() {
  return {
    name: "ocr-assets",
    configureServer(server) {
      const files = sources();
      server.middlewares.use((req, res, next) => {
        const key = (req.url ?? "").split("?")[0].replace(/^\/+/, "");
        const file = files[key];
        if (!file) return next();
        res.setHeader("Content-Type", key.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const [fileName, file] of Object.entries(sources())) this.emitFile({ type: "asset", fileName, source: readFileSync(file) });
    },
  };
}
