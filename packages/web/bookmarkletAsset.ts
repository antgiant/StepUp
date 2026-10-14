import type { Plugin } from "vite";
import { BOOKMARKLET_FILE, bookmarkletScript } from "./src/stepUpBridge.js";

/**
 * Serves the bookmarklet's script (src/stepUpBridge.ts is its only source) as `stepup-bookmarklet.js` next to the app, in
 * the build and in the dev server, so the small bookmark people keep can load the current version each time.
 */
export function bookmarkletAsset(): Plugin {
  return {
    name: "stepup-bookmarklet",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? "").split("?")[0]!.endsWith(`/${BOOKMARKLET_FILE}`)) {
          res.setHeader("content-type", "application/javascript; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.end(bookmarkletScript());
        } else next();
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: BOOKMARKLET_FILE, source: bookmarkletScript() });
    },
  };
}
