import { defineConfig } from "vite";
import { ocrAssets } from "./ocrAssets.js";
import { bookmarkletAsset } from "./bookmarkletAsset.js";

// Relative base so the build works from any GitHub Pages path.
// ExcelJS (the mirror spreadsheet), pdf.js and the OCR engine are large but load only when used, so the size warning is expected.
export default defineConfig({ base: "./", build: { chunkSizeWarningLimit: 1000 }, plugins: [ocrAssets(), bookmarkletAsset()] });
