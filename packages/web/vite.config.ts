import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { ocrAssets } from "./ocrAssets.js";
import { bookmarkletAsset } from "./bookmarkletAsset.js";

// Safari blocks a script from http://localhost on an https page (StepUp), so the dev server serves https when a
// mkcert certificate is in `.certs/` (see README, "Testing locally"). Without one it stays plain http.
const cert = (name: string): string => fileURLToPath(new URL(`./.certs/${name}`, import.meta.url));
const https = existsSync(cert("localhost.pem")) ? { cert: readFileSync(cert("localhost.pem")), key: readFileSync(cert("localhost-key.pem")) } : undefined;

// Relative base so the build works from any GitHub Pages path.
// ExcelJS (the mirror spreadsheet), pdf.js and the OCR engine are large but load only when used, so the size warning is expected.
export default defineConfig({ base: "./", server: { https }, build: { chunkSizeWarningLimit: 1000 }, plugins: [ocrAssets(), bookmarkletAsset()] });
