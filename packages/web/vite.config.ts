import { defineConfig } from "vite";

// Relative base so the build works from any GitHub Pages path.
// ExcelJS (the mirror spreadsheet) is ~900 kB but loads only when the spreadsheet is built, so the size warning is expected.
export default defineConfig({ base: "./", build: { chunkSizeWarningLimit: 1000 } });
